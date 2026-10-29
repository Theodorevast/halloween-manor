// 上手（2026-10-30 试玩报告 P1-1、P1-2、P1-3、P1-4 b、P1-6）：开场不收输入、开场按钮的字、只出现一次的情境提示、
// 附身落空的判断、做不到时的回应（同一种短时间内不重复）、够不着的判断，还有天亮自己走的那一行播报（不跳计数）。
// node 里没有 DOM：提示的判断（createHintCore、createMissWatch）、播报和按钮的文字（hudLines、beginLabel）都是纯函数，直接测；
// 鬼魂镜头的 hold、拾取器的「够不着」用 EventTarget 做的假画布 / 假 window / 假 document 接上真的 createGhostRig、createPicker
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W, PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { STRINGS } from '../src/config/strings';
import { createGhostRig, ghostRigDebug, ghostSees, setGhostUi, watchGhostUi } from '../src/engine/ghostRig';
import { createPicker } from '../src/engine/picking';
import type { GhostRig } from '../src/engine/types';
import { angleOf } from '../src/lib/angle';
import { createWorld } from '../src/sim/world';
import type { ManifestState, ScareObjectState, SimEvent, Vec2, World, WorldState } from '../src/sim/types';
import { HINT, bottomLine, createHintCore, createMissWatch, type HintEnv } from '../src/ui/hints';
import { KEYS, beginLabel, hudLines } from '../src/ui/hud';

const DT = 1 / 60;
const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
const angleTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
const H = STRINGS.onboarding.hints;

/** 模拟推进 seconds 秒，每一步的事件先交给 feed，再调 after（像主循环：先分发事件、再 update） */
function run(w: World, seconds: number, feed: (e: SimEvent) => void, after: () => void = () => {}) {
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    for (const e of w.step(DT)) feed(e);
    after();
  }
}

afterEach(() => {
  bottomLine.release('keys');
  bottomLine.release('hint');
  setGhostUi({ active: false, engaged: false, locked: false, pending: false, aim: null, held: false });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 附身落空 ───────────────────────────────────────────────

describe('附身落空的判断（createMissWatch：惊吓类物件被附身以后，到生效窗口结束都没吓到人）', () => {
  it('没人在场时附身卧室台灯：生效窗口（SCARES.lamp.active）结束的那一帧判定落空，之前不判', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const watch = createMissWatch();
    expect(w.trigger('lamp-bedroom')).toBe(true);
    const at: number[] = [];
    run(w, SCARES.lamp.active + 0.5, (e) => watch.onEvent(e), () => {
      if (watch.settle(w.state.objects).length > 0) at.push(w.state.time);
    });
    expect(at).toHaveLength(1);
    expect(at[0]).toBeGreaterThan(SCARES.lamp.active - DT - 1e-6);
    expect(at[0]).toBeLessThan(SCARES.lamp.active + 2 * DT);
  });

  it('落空报的是哪个物件、哪一种（播报写 "No one saw the lamp."）', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const watch = createMissWatch();
    w.trigger('lamp-bedroom');
    const misses: unknown[] = [];
    run(w, SCARES.lamp.active + 0.2, (e) => watch.onEvent(e), () => misses.push(...watch.settle(w.state.objects)));
    expect(misses).toEqual([{ object: 'lamp-bedroom', type: 'lamp' }]);
    expect(STRINGS.onboarding.missed(STRINGS.propName.lamp)).toBe('No one saw the lamp.');
  });

  it('看着肖像的人被吓到了（有这个物件的 startle）：不算落空', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const watch = createMissWatch();
    const study = { x: 2.75, z: 3.75 };
    const n = w.spawn({ pos: study, personality: 'average', lookDir: angleTo(study, prop('portrait')) });
    w.trigger('portrait');
    const startles: SimEvent[] = [];
    const misses: unknown[] = [];
    run(w, SCARES.portrait.active + 0.5, (e) => {
      watch.onEvent(e);
      if (e.type === 'startle') startles.push(e);
    }, () => {
      n.lookDir = angleTo(n.pos, prop('portrait')); // 一直盯着它
      misses.push(...watch.settle(w.state.objects));
    });
    expect(startles.some((e) => e.type === 'startle' && e.object === 'portrait')).toBe(true);
    expect(misses).toEqual([]);
  });

  it('引诱类（八音盒）不判落空：它本来就不靠被看见', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const watch = createMissWatch();
    w.trigger('music-box');
    const misses: unknown[] = [];
    run(w, SCARES.musicBox.active + 0.5, (e) => watch.onEvent(e), () => misses.push(...watch.settle(w.state.objects)));
    expect(misses).toEqual([]);
  });

  it('机关发作的那一下（trap sprung 紧跟着的 trigger）不算玩家附身落空', () => {
    const watch = createMissWatch();
    watch.onEvent({ type: 'trap', object: 'bed', phase: 'sprung' });
    watch.onEvent({ type: 'trigger', object: 'bed', scareType: 'bed' });
    const done = [{ id: 'bed', type: 'bed', active: 0 }] as unknown as ScareObjectState[];
    expect(watch.settle(done)).toEqual([]);
    // 之后玩家自己附身同一个物件、没吓到人：照常算
    watch.onEvent({ type: 'trigger', object: 'bed', scareType: 'bed' });
    expect(watch.settle([{ id: 'bed', type: 'bed', active: 1 }] as unknown as ScareObjectState[])).toEqual([]);
    expect(watch.settle(done)).toEqual([{ object: 'bed', type: 'bed' }]);
  });
});

// ── 情境提示 ───────────────────────────────────────────────

/** 一个干净的模拟状态（没有访客、现身就绪），提示的判断只读它的 objects、manifest、npcs */
const calmState = (manifest: Partial<ManifestState> = {}): WorldState => {
  const s = createWorld({ seed: 3, autoSpawn: false }).state;
  return { ...s, manifest: { ...s.manifest, ...manifest } };
};
const ghostEnv = (patch: Partial<HintEnv> = {}): HintEnv => ({ ghost: true, aiming: true, paused: false, ...patch });

describe('情境提示：每种只出现一次（createHintCore）', () => {
  it('第一次准星对准物件：firstAim 出来、停 HINT.hold 秒左右后淡出；之后再对准也不再出', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv();
    core.aimed(1, env);
    expect(core.tick(1, s, env)).toBe('firstAim');
    expect(core.tick(1 + HINT.hold - 0.1, s, env)).toBe('firstAim');
    expect(core.tick(1 + HINT.hold + 0.1, s, env)).toBeNull();
    core.aimed(30, env);
    expect(core.tick(30, s, env)).toBeNull();
    expect(core.tick(31, s, env)).toBeNull();
    expect([...core.shown]).toEqual(['firstAim']);
    expect(H.firstAim).toBe('Click to possess · Hold to set a trap');
  });

  it('第一次有人听见引诱（heard）：firstLure，只一次', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv({ aiming: false });
    core.onEvent({ type: 'heard', npc: 1, object: 'music-box' }, s, 2);
    expect(core.tick(2, s, env)).toBe('firstLure');
    core.onEvent({ type: 'heard', npc: 2, object: 'kitchen-door' }, s, 40);
    expect(core.tick(40, s, env)).toBeNull();
    expect([...core.shown]).toEqual(['firstLure']);
  });

  it('第一次附身落空：firstMiss（触屏的娃娃屋里也出：落空、眼睛两边都有）', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const core = createHintCore();
    const env = ghostEnv({ ghost: false, aiming: false });
    w.trigger('lamp-bedroom');
    const keys: (string | null)[] = [];
    let now = 0;
    run(w, SCARES.lamp.active + 1, (e) => core.onEvent(e, w.state, now), () => {
      now += DT;
      keys.push(core.tick(now, w.state, env));
    });
    expect(keys.filter(Boolean)[0]).toBe('firstMiss');
    expect(keys.slice(0, Math.floor((SCARES.lamp.active - 0.1) / DT)).every((k) => k === null)).toBe(true);
  });

  it('第一次被手电照到、而且现身已就绪：firstRevealed；冷却中被照到不出，照着的时候冷却好了才出', () => {
    const core = createHintCore();
    const env = ghostEnv({ aiming: false });
    const cooling = calmState({ phase: 'cooldown', cooldown: 5 });
    core.onEvent({ type: 'reveal', npc: 1, on: true }, cooling, 3);
    expect(core.tick(3, cooling, env)).toBeNull();
    expect(core.tick(5, cooling, env)).toBeNull();
    const ready = calmState();
    expect(core.tick(8, ready, env)).toBe('firstRevealed');
  });

  it('不再被照着（reveal off、照着的人出门了）就不算：现身就绪也不出', () => {
    const core = createHintCore();
    const env = ghostEnv({ aiming: false });
    const s = calmState();
    core.onEvent({ type: 'reveal', npc: 1, on: true }, calmState({ phase: 'cooldown', cooldown: 1 }), 0);
    core.onEvent({ type: 'reveal', npc: 1, on: false }, s, 0.5);
    expect(core.tick(2, s, env)).toBeNull();
    core.onEvent({ type: 'reveal', npc: 2, on: true }, calmState({ phase: 'cooldown', cooldown: 1 }), 3);
    core.onEvent({ type: 'exit', npc: 2, name: 'Mia', total: 0, calm: true }, s, 3.5);
    expect(core.tick(4, s, env)).toBeNull();
    expect(core.shown.size).toBe(0);
  });

  it('娃娃屋（没有准星、没有鬼魂）：准星类的提示不出', () => {
    const core = createHintCore();
    const env = ghostEnv({ ghost: false });
    core.aimed(1, env);
    expect(core.tick(1, calmState(), env)).toBeNull();
    expect(core.shown.size).toBe(0);
  });

  it('提示上来以后做了那件事（附身了、现身了）：不等满时间，过了 HINT.minHold 就先淡出', () => {
    const core = createHintCore();
    const env = ghostEnv();
    const s = calmState();
    core.aimed(0, env);
    expect(core.tick(0, s, env)).toBe('firstAim');
    core.onEvent({ type: 'trigger', object: 'lamp-living', scareType: 'lamp' }, s, 1);
    expect(core.tick(1, s, env)).toBe('firstAim');
    expect(core.tick(HINT.minHold + 0.05, s, env)).toBeNull();
  });

  it('那一行同一时刻只放一句：开场的操作说明（keys）占着时提示先等；等到时已经不算数（准星移开了）就不出，留到下一次', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv();
    expect(bottomLine.claim('keys')).toBe(true);
    core.aimed(5, env);
    expect(core.tick(5, s, env)).toBeNull();
    env.aiming = false;
    expect(core.tick(6, s, env)).toBeNull();
    bottomLine.release('keys');
    expect(core.tick(7, s, env)).toBeNull();
    expect(core.shown.has('firstAim')).toBe(false);
    env.aiming = true;
    core.aimed(9, env);
    expect(core.tick(9, s, env)).toBe('firstAim');
    expect(bottomLine.owner).toBe('hint');
  });

  it('提示占着那一行时操作说明拿不到；提示淡完（HINT.fade 秒）才还回来', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv();
    core.aimed(0, env);
    expect(core.tick(0, s, env)).toBe('firstAim');
    expect(bottomLine.claim('keys')).toBe(false);
    expect(core.tick(HINT.hold + 0.1, s, env)).toBeNull(); // 开始淡出：还占着
    expect(bottomLine.claim('keys')).toBe(false);
    expect(core.tick(HINT.hold + HINT.fade + 0.2, s, env)).toBeNull();
    expect(bottomLine.claim('keys')).toBe(true);
  });

  it('等着的提示过了新鲜期（落空 HINT.fresh.firstMiss 秒）就作废', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv({ aiming: false });
    bottomLine.claim('keys');
    core.onEvent({ type: 'heard', npc: 1, object: 'music-box' }, s, 0);
    expect(core.tick(0.1, s, env)).toBeNull();
    expect(core.tick(HINT.fresh.firstLure + 0.5, s, env)).toBeNull();
    bottomLine.release('keys');
    expect(core.tick(HINT.fresh.firstLure + 1, s, env)).toBeNull();
    expect(core.shown.size).toBe(0);
  });

  it('暂停中（Click to resume 挂着）不出新的提示，回来以后照出', () => {
    const core = createHintCore();
    const s = calmState();
    const env = ghostEnv({ aiming: false, paused: true });
    core.onEvent({ type: 'heard', npc: 1, object: 'music-box' }, s, 0);
    expect(core.tick(0.5, s, env)).toBeNull();
    env.paused = false;
    expect(core.tick(1, s, env)).toBe('firstLure');
  });
});

// ── 做不到时的回应 ───────────────────────────────────────────

describe('做不到时的回应（refused）：每次都有一句，同一种短时间内不重复', () => {
  it('同一种 HINT.refuseGap 秒内只回应一次，过了再回应', () => {
    const core = createHintCore();
    expect(core.refused('manifestCooldown', 10)).toBe('Not yet.');
    expect(core.refused('manifestCooldown', 10.5)).toBeNull();
    expect(core.refused('manifestCooldown', 10 + HINT.refuseGap - 0.1)).toBeNull();
    expect(core.refused('manifestCooldown', 10 + HINT.refuseGap + 0.1)).toBe('Not yet.');
  });

  it('不同的几种互不影响；文案就是 STRINGS.onboarding.refused', () => {
    const core = createHintCore();
    expect(core.refused('tooFar', 1)).toBe(STRINGS.onboarding.refused.tooFar);
    expect(core.refused('trapsFull', 1.2)).toBe(STRINGS.onboarding.refused.trapsFull);
    expect(core.refused('manifestWall', 1.3)).toBe(STRINGS.onboarding.refused.manifestWall);
    expect(core.refused('tooFar', 1.4)).toBeNull();
  });
});

// ── 开场按钮、操作说明的时刻、播报 ─────────────────────────────

describe('开场按钮的字（试玩报告 P1-1 b、P1-6 a）', () => {
  it('能点之前：Lighting the candles…；能点：Click to begin；点了开始、遮罩还挂着：The candles are almost lit…（不退回加载中）', () => {
    expect(beginLabel({ ready: false, begun: false, touch: false })).toBe(STRINGS.start.loading);
    expect(beginLabel({ ready: true, begun: false, touch: false })).toBe(STRINGS.start.begin);
    expect(beginLabel({ ready: false, begun: true, touch: false })).toBe('The candles are almost lit…');
  });

  it('触屏：Tap to begin the haunting.', () => {
    expect(beginLabel({ ready: true, begun: false, touch: true })).toBe('Tap to begin the haunting.');
    expect(beginLabel({ ready: false, begun: true, touch: true })).toBe(STRINGS.onboarding.almostLit);
  });

  it('开场的操作说明推迟到开场后 4–5 秒（第一个访客走过以后），停留约 10 秒（P1-3 c）', () => {
    expect(KEYS.delay).toBeGreaterThanOrEqual(4);
    expect(KEYS.delay).toBeLessThanOrEqual(5);
    expect(KEYS.hold).toBeGreaterThanOrEqual(9);
    expect(KEYS.hold).toBeLessThanOrEqual(11);
  });
});

describe('播报：天亮自己走的人（exit 带 calm）', () => {
  const s = calmState();
  it('写 leftCalm、安静的灰字，不跳计数', () => {
    expect(hudLines({ type: 'exit', npc: 4, name: 'Theo', total: 2, calm: true }, s)).toEqual({
      lines: [{ text: 'Theo walked out into the morning', tone: 'quiet' }],
      count: null,
    });
  });
  it('收夜时最后再来的那一位（spawn 带 last）：不播「let themselves in」（收夜的控制器自己播 lastArrival，两行会重复）；平常进门照播', () => {
    const withAda = { ...s, npcs: [{ ...createWorld({ seed: 5, autoSpawn: false }).spawn({ name: 'Ada' }) }] };
    const id = withAda.npcs[0].id;
    expect(hudLines({ type: 'spawn', npc: id, last: true }, withAda)).toEqual({ lines: [], count: null });
    expect(hudLines({ type: 'spawn', npc: id }, withAda)).toEqual({ lines: [{ text: STRINGS.ticker.spawn('Ada'), tone: 'quiet' }], count: null });
  });
  it('被吓跑的照旧：讣告那一行，计数跳到 total', () => {
    expect(hudLines({ type: 'exit', npc: 4, name: 'Theo', total: 3 }, s)).toEqual({
      lines: [{ text: STRINGS.ticker.exit('Theo'), tone: 'exit' }],
      count: 3,
    });
  });
});

// ── 鬼魂镜头的 hold（开场遮罩挂着时不收输入） ───────────────────────

/** 假的 window / document / 画布：EventTarget 加上 createGhostRig、createPicker 会读的几个字段 */
class FakeTarget extends EventTarget {
  style: Record<string, string> = {};
  clientWidth = 800;
  clientHeight = 600;
  pointerLockElement: unknown = null;
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}
/** Node 的 Event 没有键盘、鼠标的字段：用 defineProperty 盖在实例上 */
const domEvent = (type: string, init: Record<string, unknown> = {}) => {
  const e = new Event(type, { cancelable: true });
  for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v });
  return e;
};

function stubDom() {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  vi.stubGlobal('addEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.addEventListener(t, cb));
  vi.stubGlobal('removeEventListener', (t: string, cb: EventListenerOrEventListenerObject) => win.removeEventListener(t, cb));
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { setTimeout: () => 0 });
  return { win, doc };
}

function rigEnv() {
  const { win, doc } = stubDom();
  const canvas = new FakeTarget();
  const rig = createGhostRig(canvas as unknown as HTMLCanvasElement);
  const dbg = ghostRigDebug(rig)!;
  let manifests = 0;
  rig.onManifest(() => manifests++);
  const key = (code: string, type = 'keydown') =>
    win.dispatchEvent(domEvent(type, { code, repeat: false, ctrlKey: false, metaKey: false, altKey: false }));
  return {
    rig, dbg, canvas,
    get manifests() { return manifests; },
    key,
    mouse: (dx: number, dy: number) => doc.dispatchEvent(domEvent('mousemove', { movementX: dx, movementY: dy })),
    right: () => canvas.dispatchEvent(domEvent('pointerdown', { button: 2 })),
    wheel: (dy: number) => canvas.dispatchEvent(domEvent('wheel', { deltaY: dy, deltaMode: 0 })),
    frames: (n: number) => { for (let i = 0; i < n; i++) rig.update(DT); },
  };
}

describe('开场不收输入（GhostRig.hold，试玩报告 P1-1 a）', () => {
  it('hold 期间：鼠标转向、WASD、方向键、F、右键、滚轮都不算；鬼魂停在原地', () => {
    const e = rigEnv();
    e.rig.lockPointer();
    e.dbg.fakeLock(true); // 无头环境锁不上指针：假装锁定，走同一条路
    e.rig.hold(true);
    const v0 = e.dbg.view();
    const p0 = { x: e.rig.ghost.x, z: e.rig.ghost.z };
    e.mouse(240, 120);
    e.key('KeyW');
    e.key('ArrowLeft');
    e.frames(60);
    e.key('KeyF');
    e.right();
    e.wheel(-400);
    e.frames(10);
    const v1 = e.dbg.view();
    expect(v1.yaw).toBeCloseTo(v0.yaw, 9);
    expect(v1.pitch).toBeCloseTo(v0.pitch, 9);
    expect(v1.dist).toBe(v0.dist);
    expect(e.rig.ghost.x).toBeCloseTo(p0.x, 9);
    expect(e.rig.ghost.z).toBeCloseTo(p0.z, 9);
    expect(e.manifests).toBe(0);
  });

  it('放开以后一切照常：鼠标转向、F 现身', () => {
    const e = rigEnv();
    e.rig.lockPointer();
    e.dbg.fakeLock(true);
    e.rig.hold(true);
    e.rig.hold(false);
    const v0 = e.dbg.view();
    e.mouse(200, 0);
    e.frames(30);
    expect(e.dbg.view().yaw).toBeGreaterThan(v0.yaw + 0.3);
    e.key('KeyF');
    expect(e.manifests).toBe(1);
  });

  it('放开时视角回到 hold 开始那一刻（开场时就是开场的朝向），实际值也一起就位，镜头不会从别处扫回来', () => {
    const e = rigEnv();
    const start = e.dbg.view();
    e.rig.lockPointer();
    e.rig.hold(true);
    e.dbg.place(e.rig.ghost.x, e.rig.ghost.z, start.yaw + 1.2, 0.3); // 遮罩后面视角被别的东西改过
    e.frames(5);
    e.rig.hold(false);
    const v = e.dbg.view();
    expect(v.yaw).toBeCloseTo(start.yaw, 9);
    expect(v.pitch).toBeCloseTo(start.pitch, 9);
    expect(e.rig.ghost.heading).toBeCloseTo(start.yaw, 9);
  });

  it('没 hold 过就放开：什么都不改', () => {
    const e = rigEnv();
    e.rig.lockPointer();
    e.dbg.fakeLock(true);
    e.mouse(150, 0);
    e.frames(30);
    const v0 = e.dbg.view();
    e.rig.hold(false);
    expect(e.dbg.view().yaw).toBeCloseTo(v0.yaw, 9);
  });

  it('hold 的状态发布给界面（watchGhostUi 的 held）：拾取器据此不悬停、不附身', () => {
    const e = rigEnv();
    let held: boolean | undefined;
    const off = watchGhostUi((s) => { held = s.held; });
    e.rig.hold(true);
    expect(held).toBe(true);
    e.rig.hold(false);
    expect(held).toBe(false);
    off();
  });
});

// ── 拾取器：够不着（refused tooFar） ──────────────────────────────

describe('够不着（picking 判断：准星对着一个物件，但够不着）', () => {
  let queued: (() => void)[] = [];
  const runFrame = () => {
    const q = queued;
    queued = [];
    for (const cb of q) cb();
  };
  const live: { dispose(): void }[] = [];
  beforeEach(() => {
    queued = [];
    stubDom();
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => queued.push(cb));
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
  });
  afterEach(() => {
    for (const p of live.splice(0)) p.dispose();
  });

  /** 走廊（z = 6 米，没有墙）：鬼魂和镜头在 x = 4 米，物件（1 米的方块）在正前方 gap 米处 */
  function corridor(gap: number) {
    const ghostAt = { x: 4, z: 6 };
    const at = { x: 4 + gap, z: 6 };
    expect(ghostSees(ghostAt, at)).toBe(true); // 前提：中间没有墙
    const canvas = new FakeTarget();
    const camera = new THREE.PerspectiveCamera(60, 4 / 3, 0.1, 100);
    camera.position.set(ghostAt.x - HOUSE_W / 2, 1.5, ghostAt.z - HOUSE_D / 2);
    camera.lookAt(at.x - HOUSE_W / 2, 1.5, at.z - HOUSE_D / 2);
    camera.updateMatrixWorld(true);
    const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    box.userData.propId = 'lamp-living';
    box.position.set(at.x - HOUSE_W / 2, 1.5, at.z - HOUSE_D / 2);
    box.updateMatrixWorld(true);
    const rig = { camera, ghost: { x: ghostAt.x, y: 1.4, z: ghostAt.z, heading: 0, speed: 0, inWall: false } } as unknown as GhostRig;
    const picker = createPicker(canvas as unknown as HTMLCanvasElement, rig, () => [box]);
    live.push(picker);
    const far: string[] = [];
    const picks: string[] = [];
    const hovers: (string | null)[] = [];
    picker.onTooFar((id) => far.push(id));
    picker.onPick((id) => picks.push(id));
    picker.onHover((id) => hovers.push(id));
    setGhostUi({ locked: true, held: false });
    const press = () => {
      canvas.dispatchEvent(domEvent('pointerdown', { button: 0, buttons: 1, timeStamp: 1000 }));
      canvas.dispatchEvent(domEvent('pointerup', { button: 0, buttons: 0, timeStamp: 1050 }));
    };
    return { far, picks, hovers, press };
  }

  it('6 米外、看得见的物件：按下左键回应一次 tooFar，不悬停、不附身', () => {
    const e = corridor(6);
    runFrame();
    expect(e.hovers).toEqual([]);
    e.press();
    expect(e.far).toEqual(['lamp-living']);
    expect(e.picks).toEqual([]);
  });

  it('够得着的（2.5 米）照常悬停、附身，不算够不着', () => {
    const e = corridor(2.5);
    runFrame();
    expect(e.hovers).toEqual(['lamp-living']);
    e.press();
    expect(e.picks).toEqual(['lamp-living']);
    expect(e.far).toEqual([]);
  });

  it('开场遮罩挂着（held）：不悬停、不附身，也不回应够不着', () => {
    const near = corridor(2.5);
    setGhostUi({ held: true });
    runFrame();
    near.press();
    expect(near.hovers).toEqual([]);
    expect(near.picks).toEqual([]);
    const far = corridor(6);
    setGhostUi({ held: true });
    far.press();
    expect(far.far).toEqual([]);
  });
});
