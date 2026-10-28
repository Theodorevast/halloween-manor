// 声音的纯数值部分（WebAudio 节点在 node 里没有，合成本身靠 dev/audio.html 的离线渲染量；这里只守几个不该悄悄变掉的约定，
// 包括和画面对齐的几个时刻：现身蓄力的灯暗一下一声咔哒、床的布料声和呼吸——看样时调画面那边的数，声音要么自己跟着走，要么这里变红），
// 外加一组用 WebAudio 最小替身跑真的 Router 的测试：被手电照着的访客走了以后，压力声一定淡出
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CELL, FURNITURE } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { FEAR, MANIFEST } from '../src/config/visitors';
import { BREATH, breathPeriod, breathStrength, closeGain } from '../src/audio/breath';
import { createRouter, type MixBus } from '../src/audio/engine';
import { MANIFEST_SFX, REVEAL, droneTones } from '../src/audio/ghost';
import { BED, TRIGGER, pillowSpot } from '../src/audio/sfx';
import type { NpcMode, NpcState, SimEvent, WorldState } from '../src/sim/types';
import { GHOST } from '../src/view/ghost';
import { LIGHTFX, MANIFEST_WINDUP_PATTERN, letterLevel, patternDips } from '../src/view/lightfx';
import { BED_TIMELINE } from '../src/view/props/bed';

const db = (x: number) => 20 * Math.log10(x);

describe('喘气：周期、强度、距离', () => {
  it('周期从 FEAR.nervous 的 2.2 秒线性缩到 FEAR.max 的 1.3 秒，范围外夹住', () => {
    expect(breathPeriod(FEAR.nervous)).toBeCloseTo(2.2, 6);
    expect(breathPeriod(FEAR.max)).toBeCloseTo(1.3, 6);
    expect(breathPeriod((FEAR.nervous + FEAR.max) / 2)).toBeCloseTo(1.75, 6);
    expect(breathPeriod(0)).toBe(breathPeriod(FEAR.nervous));
    expect(breathPeriod(500)).toBe(breathPeriod(FEAR.max));
    let prev = Infinity;
    for (let f = FEAR.nervous; f <= FEAR.max; f += 5) {
      const p = breathPeriod(f);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it('强度随恐惧值涨，在 strength 范围内', () => {
    expect(breathStrength(FEAR.nervous)).toBeCloseTo(BREATH.strength[0], 6);
    expect(breathStrength(FEAR.max)).toBeCloseTo(BREATH.strength[1], 6);
    expect(breathStrength(80)).toBeGreaterThan(breathStrength(65));
  });

  it('凑近才听得见：full 米以内满音量、far 米以外没有、2 米处至少轻 15 dB、单调不增', () => {
    expect(closeGain(0)).toBe(1);
    expect(closeGain(BREATH.full)).toBe(1);
    expect(closeGain(BREATH.far)).toBe(0);
    expect(closeGain(10)).toBe(0);
    expect(closeGain(Number.NaN)).toBe(0);
    expect(db(closeGain(2))).toBeLessThan(-15);
    expect(closeGain(2)).toBeGreaterThan(BREATH.minGain / 4);
    let prev = 1;
    for (let d = 0; d <= 3; d += 0.1) {
      const g = closeGain(d);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
  });

  it('呜咽的恐惧值门槛（FEAR.dread）在喘气（FEAR.nervous）之上', () => {
    expect(FEAR.dread).toBeGreaterThan(FEAR.nervous);
    expect(FEAR.nervous - BREATH.hyst).toBeGreaterThan(0);
  });
});

describe('床：声音的时间线', () => {
  it('每种物件都有声音（TRIGGER 的键和 SCARES 的键一样）', () => {
    expect(Object.keys(TRIGGER).sort()).toEqual(Object.keys(SCARES).sort());
  });

  it('呼吸在落下前 0.6 秒以上就屏住（调研原则 11：先抽空再落下，前脉冲抑制）', () => {
    expect(SCARES.bed.hitAt - (BED.breathAt + BED.breathDur)).toBeGreaterThanOrEqual(0.6);
  });

  it('布料摩擦三段依次开始，都在落下之前收尾；呼吸在最后一段摩擦收尾前后开始', () => {
    const starts = BED.rise.map((r) => r[0]);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    for (const [a, peak, b] of BED.rise) {
      expect(a).toBeLessThan(peak);
      expect(peak).toBeLessThan(b);
      expect(b).toBeLessThan(SCARES.bed.hitAt - 0.6);
    }
    expect(BED.breathAt).toBeGreaterThanOrEqual(BED.rise[BED.rise.length - 1][1]);
  });

  it('布料摩擦三段对得上被子鼓包的三段（BED_TIMELINE.rise 的膝、躯干、头）：起点差不超过 0.05 秒，止点不早于动画升完的时刻', () => {
    const anim = [BED_TIMELINE.rise.knee, BED_TIMELINE.rise.torso, BED_TIMELINE.rise.head];
    expect(BED.rise).toHaveLength(anim.length);
    BED.rise.forEach(([from, , to], i) => {
      expect(Math.abs(from - anim[i][0])).toBeLessThanOrEqual(0.05 + 1e-9);
      expect(to).toBeGreaterThanOrEqual(anim[i][1] - 1e-9);
    });
  });

  it('吸气在头升完（BED_TIMELINE.breathFrom）以后 0.1 秒以内开始，吸完比被子塌平（BED_TIMELINE.collapse）至少早 0.6 秒（前脉冲抑制）', () => {
    expect(BED.breathAt).toBeGreaterThanOrEqual(BED_TIMELINE.breathFrom - 1e-9);
    expect(BED.breathAt).toBeLessThanOrEqual(BED_TIMELINE.breathFrom + 0.1 + 1e-9);
    expect(BED_TIMELINE.collapse - (BED.breathAt + BED.breathDur)).toBeGreaterThanOrEqual(0.6 - 1e-9);
  });

  it('枕头在床的矩形里，并且比床的中心更靠西墙（床头朝西）', () => {
    const bed = FURNITURE.find((f) => f.id === 'bedroom-bed')!;
    const p = pillowSpot()!;
    const { x0, z0, x1, z1 } = bed.rect;
    expect(p.x).toBeGreaterThan(x0 * CELL);
    expect(p.x).toBeLessThan(x1 * CELL);
    expect(p.z).toBeGreaterThan(z0 * CELL);
    expect(p.z).toBeLessThan(z1 * CELL);
    expect(p.x).toBeLessThan(((x0 + x1) / 2) * CELL);
  });
});

describe('现身：声音的时间线', () => {
  it('灯暗的咔哒都落在蓄力那段里、按先后排', () => {
    const c = MANIFEST_SFX.clicks;
    expect([...c].sort((a, b) => a - b)).toEqual([...c]);
    for (const t of c) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(MANIFEST.windup);
    }
  });

  it('咔哒的时刻就是画面蓄力节奏表里灯暗下去的时刻（单一来源：改 view/lightfx.ts 的 MANIFEST_WINDUP_PATTERN，咔哒自己跟着走）', () => {
    const table = GHOST.manifest.windup;
    expect(table).toBe(MANIFEST_WINDUP_PATTERN); // 画面放的就是共用的这一张，没人另写一份
    const dips = patternDips(table, MANIFEST.windup);
    expect(dips.length).toBeGreaterThan(0);
    expect(MANIFEST_SFX.clicks).toEqual(dips);
    // 咔哒响的那一刻，灯正暗着
    for (const t of MANIFEST_SFX.clicks) expect(letterLevel(table[Math.round(t * LIGHTFX.rate)])).toBeLessThan(1);
  });

  it('保险时间比蓄力 + 停留长，环境声回来的参数是正数', () => {
    expect(MANIFEST_SFX.maxLife).toBeGreaterThan(MANIFEST.windup + MANIFEST.hold);
    const h = MANIFEST_SFX.hush;
    expect(h.db).toBeLessThan(0);
    for (const v of [h.down, h.back, h.up]) expect(v).toBeGreaterThan(0);
  });

  it('持续音是小二度：两个频率差约 1 个半音', () => {
    const [lo, hi] = MANIFEST_SFX.drone.hz;
    expect(12 * Math.log2(hi / lo)).toBeCloseTo(1, 1);
  });
});

describe('现身持续音：默认不滑音，停留阶段一直是小二度', () => {
  /** 两根正弦之间的音程（音分） */
  const cents = (hi: number, lo: number) => 1200 * Math.log2(hi / lo);

  it('slide 默认是 0：每一根正弦的起头频率和停留阶段的频率一样，没有任何滑音', () => {
    expect(MANIFEST_SFX.drone.slide).toBe(0);
    const { lo, hi } = droneTones();
    expect(lo.length).toBeGreaterThan(0);
    for (const t of [...lo, ...hi]) expect(t.to).toBe(t.from);
  });

  it('停留阶段（下滑走完以后，也就是真正响着的那 1.5 秒 + 淡出）两个音的每个分音之间都是小二度：约 100 音分', () => {
    const { lo, hi } = droneTones();
    expect(lo).toHaveLength(MANIFEST_SFX.drone.partials.length);
    lo.forEach((l, i) => {
      expect(Math.abs(cents(hi[i].to, l.to) - 100)).toBeLessThan(1);
      expect(Math.abs(cents(hi[i].from, l.from) - 100)).toBeLessThan(1);
    });
  });

  it('对照：要是还滑 −1.7 Hz（原来的默认），停留阶段的音程会变成约 154 音分，不再是小二度', () => {
    const { lo, hi } = droneTones({ ...MANIFEST_SFX.drone, slide: -1.7 });
    lo.forEach((l, i) => expect(Math.abs(cents(hi[i].to, l.to) - 154)).toBeLessThan(1));
  });
});

// ── 被照到的压力声：用 WebAudio 的最小替身跑真的 createRouter ──────────────────────────────

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
/** 只够 Snd / bandNoise 建图用：GainNode、StereoPannerNode、BiquadFilterNode、OscillatorNode、AudioBufferSourceNode 共用这一个 */
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
class FakePeriodicWave {}

const npc = (id: number, mode: NpcMode = 'wander'): NpcState => ({
  id, name: `N${id}`, personality: 'average', pos: { x: 8, z: 6 }, heading: 0, lookDir: 0, mode, modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
});
const world = (...npcs: NpcState[]): WorldState => ({
  time: 0, npcs, objects: [], scaredOff: 0, hitStop: 0, manifest: { phase: 'idle', t: 0, cooldown: 0, pos: null }, avoid: [],
});
const reveal = (npc: number, on: boolean): SimEvent => ({ type: 'reveal', npc, on });
/** 一个只够处理 reveal 事件的 Router：总线是假的，节点是替身 */
const newRouter = () =>
  createRouter({ ac: { sampleRate: 48000 }, sfx: {}, voice: {}, amb: {}, reverb: {}, noise: { duration: 4 }, pulse: {}, ambHush: new FakeNode(), space: { active: false } } as unknown as MixBus, () => 0);

describe('被照到的压力声：照着鬼魂的访客走了，它不会一直响下去', () => {
  beforeEach(() => {
    fades.length = 0;
    for (const name of ['GainNode', 'StereoPannerNode', 'BiquadFilterNode', 'OscillatorNode', 'AudioBufferSourceNode']) vi.stubGlobal(name, FakeNode);
    vi.stubGlobal('PeriodicWave', FakePeriodicWave);
  });
  afterEach(() => vi.unstubAllGlobals());

  const IN = { target: 1, at: 1, tau: REVEAL.in / 3 };

  it('手电照到鬼魂：压力声淡入（0.4 秒）；手电移开（off 事件）：淡出（0.8 秒）', () => {
    const r = newRouter();
    r.play([reveal(1, true)], world(npc(1)), 1);
    expect(fades).toEqual([IN]);
    r.play([reveal(1, false)], world(npc(1)), 2);
    expect(fades).toEqual([IN, { target: 0, at: 2, tau: REVEAL.out / 3 }]);
  });

  it.each([
    ['从 state.npcs 里消失了（走出前门、被删掉，不会再有 off 事件）', () => world()],
    ['mode 变成 gone（下一步才从 npcs 里删）', () => world(npc(1, 'gone'))],
    ['开始逃跑（逃跑中的人不理会鬼魂）', () => world(npc(1, 'fleeing'))],
  ])('照着鬼魂的访客%s：下一次 sync 压力声淡出，之后不重复淡出', (_why, after) => {
    const r = newRouter();
    r.play([reveal(1, true)], world(npc(1)), 1);
    r.sync(after(), 2);
    expect(fades).toEqual([IN, { target: 0, at: 2, tau: REVEAL.out / 3 }]);
    r.sync(after(), 3);
    expect(fades).toHaveLength(2);
  });

  it('还在屋里、没逃跑的人不会被 sync 清掉：没有多余的淡出', () => {
    const r = newRouter();
    r.play([reveal(1, true)], world(npc(1)), 1);
    r.sync(world(npc(1, 'startled'), npc(2)), 2);
    expect(fades).toEqual([IN]);
  });

  it('两个人照着：走了一个还亮着，第二个也走了才淡出', () => {
    const r = newRouter();
    r.play([reveal(1, true)], world(npc(1), npc(2)), 1);
    r.play([reveal(2, true)], world(npc(1), npc(2)), 1.2);
    expect(fades).toEqual([IN]);
    r.sync(world(npc(2)), 2);
    expect(fades).toEqual([IN]);
    r.sync(world(), 3);
    expect(fades).toEqual([IN, { target: 0, at: 3, tau: REVEAL.out / 3 }]);
  });
});
