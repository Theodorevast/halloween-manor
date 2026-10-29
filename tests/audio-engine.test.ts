// createAudio 这一层（src/audio/engine.ts）的接线：AudioContext 不在 running 时事件怎么记账。
// node 里没有 WebAudio：这里搭一个刚好够 createAudio 跑起来的假 AudioContext（建节点的构造函数全换成同一个替身；
// 环境层、脚步、喘气、3D 声像、鬼魂的声音各换成只记账的替身），真的 createBus、createRouter、createRevealLayer 照跑。
// 声音本身的合成靠 dev/audio.html 的离线测量；这里守的是「接线」：事件进来时 AudioContext 是什么状态
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudio } from '../src/audio/engine';
import { REVEAL } from '../src/audio/ghost';
import type { NpcMode, NpcState, SimEvent, WorldState } from '../src/sim/types';

/** 几个替身被调了多少次、要不要让它们抛异常（vi.mock 的工厂在导入时就跑，所以放进 hoisted） */
const h = vi.hoisted(() => ({
  calls: { crowd: 0, breath: 0, space: 0, braam: 0 },
  fail: { crowd: false, breath: false },
}));
vi.mock('../src/audio/ambience', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/ambience')>()),
  createAmbience: () => ({ start() {}, setDread() {}, update() {}, creak() {}, setPresence() {}, stop() {} }),
}));
vi.mock('../src/audio/footsteps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/footsteps')>()),
  createCrowd: () => ({
    voice: () => null,
    update() {
      h.calls.crowd++;
      if (h.fail.crowd) throw new Error('crowd boom');
    },
  }),
}));
vi.mock('../src/audio/breath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/breath')>()),
  createBreath: () => ({
    update() {
      h.calls.breath++;
      if (h.fail.breath) throw new Error('breath boom');
    },
  }),
}));
vi.mock('../src/audio/ghost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/ghost')>()),
  createGhostSound: () => ({ set() {} }),
}));
vi.mock('../src/audio/space', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/space')>()),
  // 调过 setListener 才算 3D 启用（和真的一样）；update 是「每帧重算遮挡」
  createSpace: () => {
    const sp = {
      active: false,
      listener: { x: 0, y: 0, z: 0 },
      setListener(pos: { x: number; y: number; z: number }) {
        sp.active = true;
        Object.assign(sp.listener, pos);
      },
      setEar() {},
      port() {
        throw new Error('这一组测试里没有定位声源');
      },
      update() {
        h.calls.space++;
      },
      refresh() {},
      distance: () => 0,
      occlusion: () => [1, 20000],
    };
    return sp;
  },
}));
vi.mock('../src/audio/sfx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audio/sfx')>()),
  // 挂起时的吓跑不该攒着、恢复后补放：数一数 braam
  braam: (_bus: unknown, t: number) => (h.calls.braam++, t),
}));

// ── 假的 AudioContext 和节点 ──────────────────────────────────────────────────────────────

/** 所有 AudioParam 上的 setTargetAtTime（压力声的淡入淡出就是它）：这一组测试里只有压力声会调它 */
const fades: { target: number; at: number; tau: number }[] = [];
class FakeParam {
  constructor(public value = 0) {}
  setValueAtTime() {
    return this;
  }
  linearRampToValueAtTime() {
    return this;
  }
  exponentialRampToValueAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
  setTargetAtTime(target: number, at: number, tau: number) {
    fades.push({ target, at, tau });
    return this;
  }
}
/** GainNode、StereoPannerNode、BiquadFilterNode、OscillatorNode、AudioBufferSourceNode、WaveShaperNode…… 共用这一个 */
class FakeNode {
  gain: FakeParam;
  frequency: FakeParam;
  detune: FakeParam;
  Q: FakeParam;
  pan: FakeParam;
  constructor(_ac?: unknown, o: { gain?: number; frequency?: number; detune?: number; Q?: number; pan?: number } = {}) {
    this.gain = new FakeParam(o.gain ?? 1);
    this.frequency = new FakeParam(o.frequency ?? 440);
    this.detune = new FakeParam(o.detune ?? 0);
    this.Q = new FakeParam(o.Q ?? 1);
    this.pan = new FakeParam(o.pan ?? 0);
  }
  connect<T>(dest: T): T {
    return dest;
  }
  disconnect() {}
  start() {}
  stop() {}
}
class FakeBuffer {
  readonly duration: number;
  private readonly data: Float32Array[];
  constructor(o: { numberOfChannels?: number; length: number; sampleRate: number }) {
    this.duration = o.length / o.sampleRate;
    this.data = Array.from({ length: o.numberOfChannels ?? 1 }, () => new Float32Array(o.length));
  }
  getChannelData(ch: number) {
    return this.data[ch];
  }
}
class FakePeriodicWave {}
/** 状态由测试直接改：'suspended'、Safari 的 'interrupted'、resume 还没完成…… resume() 立刻变成 running */
let ac!: FakeAC;
class FakeAC {
  state: string = 'suspended';
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeNode();
  constructor(_o?: unknown) {
    ac = this;
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

const npc = (id: number, mode: NpcMode = 'wander'): NpcState => ({
  id, name: `N${id}`, personality: 'average', pos: { x: 8, z: 6 }, heading: 0, lookDir: 0, mode, modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
});
const world = (...npcs: NpcState[]): WorldState => ({
  time: 0, npcs, objects: [], scaredOff: 0, hitStop: 0, manifest: { phase: 'idle', t: 0, cooldown: 0, pos: null }, avoid: [],
});
const reveal = (n: number, on: boolean): SimEvent => ({ type: 'reveal', npc: n, on });
type Audio = ReturnType<typeof createAudio>;
/** onEvent / update 在 Module 接口里是可选的，createAudio 一定给了（没给就在这里抛） */
const send = (a: Audio, e: SimEvent, state: WorldState) => a.onEvent!(e, state);
const step = (a: Audio, state: WorldState = world()) => a.update!({ dt: 1 / 60, time: 0, state });

/** 建好、解锁（假 AudioContext 的 resume 立刻成功，之后是 running） */
async function boot() {
  const audio = createAudio(() => 0);
  await audio.unlock();
  expect(ac.state).toBe('running');
  return audio;
}
beforeEach(() => {
  fades.length = 0;
  h.calls.crowd = h.calls.breath = h.calls.space = h.calls.braam = 0;
  h.fail.crowd = h.fail.breath = false;
  vi.stubGlobal('window', { AudioContext: FakeAC });
  for (const name of ['GainNode', 'DynamicsCompressorNode', 'WaveShaperNode', 'ConvolverNode', 'BiquadFilterNode', 'StereoPannerNode', 'OscillatorNode', 'AudioBufferSourceNode', 'ConstantSourceNode']) {
    vi.stubGlobal(name, FakeNode);
  }
  vi.stubGlobal('AudioBuffer', FakeBuffer);
  vi.stubGlobal('PeriodicWave', FakePeriodicWave);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AudioContext 不在 running 时：「谁在照鬼魂」照样记账，只是不出声', () => {
  const IN = { target: 1, tau: REVEAL.in / 3 };
  const OUT = { target: 0, tau: REVEAL.out / 3 };
  /** 压力声的淡入淡出：只看目标和时间常数，不看排在哪个时刻（时刻 = 当前时间 + 一点提前量） */
  const shape = () => fades.map(({ target, tau }) => ({ target, tau }));

  it('挂起时手电照到鬼魂：事件不再丢，恢复后第一帧压力声淡入（以前要等下一次照到才响）', async () => {
    const audio = await boot();
    ac.state = 'suspended'; // 比如 Safari 的 interrupted：来电、切到别的 App
    send(audio, reveal(1, true), world(npc(1)));
    expect(fades).toEqual([]); // 没在跑：不出声
    ac.state = 'running';
    ac.currentTime = 7;
    step(audio, world(npc(1)));
    expect(shape()).toEqual([IN]);
    expect(fades[0].at).toBeGreaterThanOrEqual(7);
    expect(fades[0].at).toBeLessThan(7.1);
    step(audio, world(npc(1)));
    expect(fades).toHaveLength(1); // 之后每帧不重复
  });

  it('压力声响着、挂起时手电移开：恢复后第一帧淡出，不会一直响到那个人走掉', async () => {
    const audio = await boot();
    send(audio, reveal(1, true), world(npc(1)));
    await Promise.resolve(); // 微任务里把这一批放出去
    expect(shape()).toEqual([IN]);
    ac.state = 'suspended';
    send(audio, reveal(1, false), world(npc(1)));
    ac.state = 'running';
    step(audio, world(npc(1)));
    expect(shape()).toEqual([IN, OUT]);
  });

  it('事件排进队列时还在跑、微任务放出去之前被挂起：这一批的 reveal 也记账，不丢', async () => {
    const audio = await boot();
    send(audio, reveal(1, true), world(npc(1))); // 排队，微任务还没跑
    ac.state = 'suspended';
    await Promise.resolve(); // flush 跑了：这会儿没在跑
    expect(fades).toEqual([]);
    ac.state = 'running';
    step(audio, world(npc(1)));
    expect(shape()).toEqual([IN]);
  });

  it('挂起时的吓跑不攒着：恢复后不会补放一声过时的 braam（只有 reveal 记账）', async () => {
    const audio = await boot();
    ac.state = 'suspended';
    send(audio, { type: 'flee', npc: 1 }, world(npc(1)));
    send(audio, reveal(1, true), world(npc(1)));
    ac.state = 'running';
    await Promise.resolve();
    step(audio, world(npc(1), npc(2)));
    expect(h.calls.braam).toBe(0);
    expect(shape()).toEqual([IN]);
  });

  it('跑着的时候照常：事件在微任务里放出去，压力声淡入', async () => {
    const audio = await boot();
    send(audio, reveal(1, true), world(npc(1)));
    await Promise.resolve();
    expect(shape()).toEqual([IN]);
  });

  it('还没 unlock：事件和每帧都什么也不做、不抛', () => {
    const audio = createAudio(() => 0);
    expect(() => {
      send(audio, reveal(1, true), world(npc(1)));
      step(audio, world(npc(1)));
    }).not.toThrow();
    expect(fades).toEqual([]);
  });
});
