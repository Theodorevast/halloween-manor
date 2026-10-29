// 看得见的前门（src/view/frontDoor.ts，时刻在 src/config/frontDoor.ts）：
//   1. 时刻对齐：真的把 spawnDoor / exitDoor 跑一遍（WebAudio 的替身记下每个声源的起止），敲门、吱呀、关门的闷响都落在 config 的时刻上；
//      改了 config，声音和画面的曲线一起走（证明没有各抄一份）
//   2. 开合曲线：进门推开（吱呀那一秒里先快后慢）、撞开、自己推开、慢慢合上、甩上，每一条的起点、终点、单调、速度
//   3. 访客走到门口之前门已经开到 70° 以上：用真模拟量访客从门外走到门口要多久
//   4. spawn / exit 的状态：只看 openness 读数，按访客的位置和模式推（进门、逃跑、天亮自己走），含真模拟里吓跑一个人
//   5. 门板本身：嵌在门洞里、开到 100° 让出进门那条路、不加灯、不发光、一开场就在场景里；俯视模式南墙降低时跟着沉下去
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { FRONT_DOOR_TIMELINE as TL } from '../src/config/frontDoor';
import { CELL, FRONT_DOOR, PROPS, buildTiles, propCenter } from '../src/config/house';
import { exitDoor, rng, spawnDoor, type Bus, type SfxFn } from '../src/audio/sfx';
import type { FrameCtx, GhostRig, RenderCore } from '../src/engine/types';
import { createWorld } from '../src/sim/world';
import type { NpcMode, SimEvent, WorldState } from '../src/sim/types';
import * as FD from '../src/view/frontDoor';
import { Side, createWalls, wallFullness } from '../src/view/walls';

const DT = 1 / 60;
const EPS = 1e-6;
/** 门洞中心（房屋米坐标）：前门两格的中点 */
const DOOR = {
  x: FRONT_DOOR.cells.reduce((s, [i]) => s + (i + 0.5) * CELL, 0) / FRONT_DOOR.cells.length,
  z: (FRONT_DOOR.cells[0][1] + 0.5) * CELL,
};

// ── WebAudio 的替身：只够 Snd / knock / creak / thud 建图，顺手记下每个声源的起止（和 wardrobe-audio.test.ts 同一个办法，只留用得着的） ──

interface Src {
  kind: 'osc' | 'buf';
  /** 振荡器的波形；用窄脉冲波形（吱呀的摩擦脉冲）的记成 'periodic' */
  type: string;
  freq: number;
  loop: boolean;
  start: number;
  stop: number | null;
}
let recs: Src[] = [];

class FakeParam {
  constructor(public value = 0) {}
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  setValueCurveAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
interface NodeOpts { gain?: number; frequency?: number; detune?: number; Q?: number; pan?: number; offset?: number; type?: string; periodicWave?: unknown; buffer?: unknown; loop?: boolean }
class FakeNode {
  gain: FakeParam;
  frequency: FakeParam;
  detune: FakeParam;
  Q: FakeParam;
  pan: FakeParam;
  offset: FakeParam;
  onended: (() => void) | null = null;
  constructor(_ac?: unknown, o: NodeOpts = {}) {
    this.gain = new FakeParam(o.gain ?? 1);
    this.frequency = new FakeParam(o.frequency ?? 440);
    this.detune = new FakeParam(o.detune ?? 0);
    this.Q = new FakeParam(o.Q ?? 1);
    this.pan = new FakeParam(o.pan ?? 0);
    this.offset = new FakeParam(o.offset ?? 1);
  }
  connect<T>(dest: T): T { return dest; }
  disconnect() {}
  start(_t?: number, _offset?: number) {}
  stop(_t?: number) {}
}
class FakeOsc extends FakeNode {
  private readonly rec: Src;
  constructor(ac?: unknown, o: NodeOpts = {}) {
    super(ac, o);
    this.rec = { kind: 'osc', type: o.periodicWave ? 'periodic' : (o.type ?? 'sine'), freq: o.frequency ?? 440, loop: false, start: NaN, stop: null };
    recs.push(this.rec);
  }
  override start(t = 0) { this.rec.start = t; }
  override stop(t = 0) { this.rec.stop = t; }
}
class FakeBufSrc extends FakeNode {
  private readonly rec: Src;
  constructor(ac?: unknown, o: NodeOpts = {}) {
    super(ac, o);
    this.rec = { kind: 'buf', type: 'buffer', freq: 0, loop: !!o.loop, start: NaN, stop: null };
    recs.push(this.rec);
  }
  override start(t = 0) { this.rec.start = t; }
  override stop(t = 0) { this.rec.stop = t; }
}
class FakePeriodicWave {}

const newBus = () =>
  ({ ac: { sampleRate: 48000, currentTime: 0 }, sfx: new FakeNode(), voice: new FakeNode(), amb: new FakeNode(), reverb: new FakeNode(), noise: { duration: 4 }, pulse: new FakePeriodicWave() }) as unknown as Bus;

/** 带种子的随机数：同一份代码每次跑出来一样 */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 声音从这一刻起播；下面的时刻都换算成相对它的秒数 */
const T0 = 0.05;
/** 跑一遍声音函数（立体声居中），返回它报的结束时刻和每个声源的记录 */
function play(fn: SfxFn, seed = 3): { end: number; srcs: Src[] } {
  const prev = rng.next;
  rng.next = seeded(seed);
  recs = [];
  try {
    return { end: fn(newBus(), T0, 0), srcs: recs };
  } finally {
    rng.next = prev;
  }
}
/** 某个频率的正弦振荡器开始响的时刻（相对 T0）。敲门 = body × 1.25 的正弦，关门的闷响 = f0 的正弦，锁舌 = 敲门 */
const sineStarts = (srcs: Src[], hz: number) => srcs.filter((s) => s.kind === 'osc' && s.type === 'sine' && Math.abs(s.freq - hz) < EPS).map((s) => s.start - T0);

beforeEach(() => {
  for (const name of ['GainNode', 'StereoPannerNode', 'BiquadFilterNode', 'WaveShaperNode', 'ConstantSourceNode']) vi.stubGlobal(name, FakeNode);
  vi.stubGlobal('OscillatorNode', FakeOsc);
  vi.stubGlobal('AudioBufferSourceNode', FakeBufSrc);
  vi.stubGlobal('PeriodicWave', FakePeriodicWave);
});
afterEach(() => vi.unstubAllGlobals());

/** 声音的每一声都在 config 的时刻上（读的是此刻的 TL：改了 config，这里跟着变） */
function expectSoundsOnTimeline() {
  // 进门：两下敲门（低的 210 Hz 和高的 640 Hz 一对，各一个 body × 1.25 的正弦）、一根吱呀的摩擦脉冲
  const spawn = play(spawnDoor);
  for (const hz of [210 * 1.25, 640 * 1.25]) {
    const at = sineStarts(spawn.srcs, hz);
    expect(at).toHaveLength(TL.knocks.length);
    TL.knocks.forEach((k, i) => expect(Math.abs(at[i] - k)).toBeLessThan(EPS));
  }
  const pulse = spawn.srcs.filter((s) => s.kind === 'osc' && s.type === 'periodic');
  expect(pulse).toHaveLength(1);
  expect(Math.abs(pulse[0].start - T0 - TL.creak[0])).toBeLessThan(EPS);
  // creakExcite 在 end 之后多留 0.02 秒收尾，包络那时已经是 0
  expect(Math.abs((pulse[0].stop ?? Infinity) - T0 - TL.creak[1] - 0.02)).toBeLessThan(EPS);
  // 报的结束时刻在吱呀和混响尾巴都收完之后
  expect(spawn.end - T0).toBeGreaterThan(TL.creak[1] + 2);

  // 离开：关门的闷响（60 Hz 下沉的正弦）在门撞上门框那一刻，不在 exit 事件那一刻；锁舌（300 Hz 敲门）在撞上之后 latch 秒
  const exit = play(exitDoor);
  const thud = sineStarts(exit.srcs, 60);
  expect(thud).toHaveLength(1);
  expect(Math.abs(thud[0] - TL.exit.contact)).toBeLessThan(EPS);
  const latch = sineStarts(exit.srcs, 300 * 1.25);
  expect(latch).toHaveLength(1);
  expect(Math.abs(latch[0] - TL.exit.contact - TL.exit.latch)).toBeLessThan(EPS);
  expect(exit.end - T0).toBeGreaterThan(TL.exit.contact + TL.exit.latch + 2);
}

describe('前门：声音的时刻读 config/frontDoor.ts', () => {
  it('config 本身依先后排：两下敲门在吱呀之前，吱呀有长度，撞上门框在事件之后', () => {
    expect(TL.knocks).toHaveLength(2);
    expect(TL.knocks[0]).toBeLessThan(TL.knocks[1]);
    expect(TL.knocks[1]).toBeLessThan(TL.creak[0]);
    expect(TL.creak[0]).toBeLessThan(TL.creak[1]);
    expect(TL.exit.contact).toBeGreaterThan(0);
    expect(TL.exit.latch).toBeGreaterThan(0);
    // 内容分析里量过的：吱呀在 0.55–1.55 秒
    expect(TL.creak).toEqual([0.55, 1.55]);
    expect(TL.openDeg).toBe(100);
    expect(TL.clearDeg).toBe(70);
  });

  it('真的把 spawnDoor / exitDoor 跑一遍：敲门、吱呀、关门的闷响、锁舌都落在 config 的时刻上', () => {
    expectSoundsOnTimeline();
  });

  it('换几个随机种子都一样（噪声的起点是随机的，时刻不是）', () => {
    for (const seed of [1, 7, 99]) {
      const { srcs } = play(spawnDoor, seed);
      const pulse = srcs.filter((s) => s.kind === 'osc' && s.type === 'periodic');
      expect(Math.abs(pulse[0].start - T0 - TL.creak[0])).toBeLessThan(EPS);
    }
  });

  it('改了 config，声音跟着走（证明声音没有自己抄一份）；画面的曲线也一起走', () => {
    const saved = structuredClone(TL);
    try {
      Object.assign(TL, { knocks: [0.1, 0.5], creak: [0.9, 2.1], exit: { contact: 0.3, latch: 0.2 } });
      expectSoundsOnTimeline();
      // 画面：吱呀开始之前还关着，吱呀结束那一刻正好开到头
      expect(FD.spawnOpenDeg(0.89)).toBe(0);
      expect(FD.spawnOpenDeg(2.1)).toBe(TL.openDeg);
      expect(FD.slamDeg(0.3, 100)).toBe(0);
      expect(FD.slamDeg(0.29, 100)).toBeGreaterThan(0);
    } finally {
      Object.assign(TL, saved);
    }
  });
});

// ── 开合曲线（纯函数，t 是这一下动作开始以后的秒数） ─────────────────────────────────────────────────

const samples = (a: number, b: number, step = 0.001) => {
  const out: number[] = [];
  for (let k = 0; a + k * step <= b + 1e-9; k++) out.push(a + k * step);
  return out;
};
const monotone = (xs: number[], dir: 1 | -1) => xs.every((x, i) => i === 0 || (x - xs[i - 1]) * dir >= -1e-9);

describe('前门：开合曲线', () => {
  it('进门推开：敲门时一直关着，吱呀开始那一刻起单调开，到吱呀结束正好开到 openDeg 并停住，不过头', () => {
    const [a, b] = TL.creak;
    for (const t of samples(0, a)) expect(FD.spawnOpenDeg(t)).toBe(0);
    const open = samples(a, b).map((t) => FD.spawnOpenDeg(t));
    expect(monotone(open, 1)).toBe(true);
    expect(FD.spawnOpenDeg(b)).toBe(TL.openDeg);
    for (const t of samples(b, b + 3, 0.01)) expect(FD.spawnOpenDeg(t)).toBe(TL.openDeg);
    expect(Math.max(...samples(0, b + 1).map((t) => FD.spawnOpenDeg(t)))).toBeLessThanOrEqual(TL.openDeg);
  });

  it('进门推开先快后慢：前一半时间开了大半，到头那一帧几乎不动（轻轻停住，不是砸到头）', () => {
    const [a, b] = TL.creak;
    expect(FD.spawnOpenDeg((a + b) / 2)).toBeGreaterThan(TL.openDeg * 0.75);
    expect(FD.spawnOpenDeg(b) - FD.spawnOpenDeg(b - DT)).toBeLessThan(0.1);
    // 吱呀响的这一秒里门一直在动（到头之前最后 0.1 秒还在动，和还没到头的吱呀对上）
    expect(FD.spawnOpenDeg(b - 0.1)).toBeLessThan(TL.openDeg);
  });

  it('从半开的位置接着推开（上一次还没合完就有人敲门）：从当前角度出发，同样在吱呀结束时到头', () => {
    const [a, b] = TL.creak;
    expect(FD.spawnOpenDeg(a, 30)).toBe(30);
    expect(FD.spawnOpenDeg(b, 30)).toBe(TL.openDeg);
    expect(monotone(samples(a, b).map((t) => FD.spawnOpenDeg(t, 30)), 1)).toBe(true);
  });

  it('撞开（被吓跑的人）：flee.open 秒内开到头，开始很快', () => {
    const { open } = FD.FRONT_DOOR_MOTION.flee;
    expect(open).toBeLessThanOrEqual(0.3);
    expect(FD.bangOpenDeg(0)).toBe(0);
    expect(FD.bangOpenDeg(open)).toBe(TL.openDeg);
    expect(monotone(samples(0, open).map((t) => FD.bangOpenDeg(t)), 1)).toBe(true);
    expect(FD.bangOpenDeg(open / 2)).toBeGreaterThan(TL.openDeg * 0.75);
  });

  it('自己推开（天亮自己走的人）：慢，calm.open 秒，缓起缓停', () => {
    const { open } = FD.FRONT_DOOR_MOTION.calm;
    expect(open).toBeGreaterThanOrEqual(0.6);
    expect(FD.calmOpenDeg(0)).toBe(0);
    expect(FD.calmOpenDeg(open)).toBe(TL.openDeg);
    const xs = samples(0, open).map((t) => FD.calmOpenDeg(t));
    expect(monotone(xs, 1)).toBe(true);
    expect(FD.calmOpenDeg(DT)).toBeLessThan(0.5); // 起步是缓的
    expect(FD.calmOpenDeg(open) - FD.calmOpenDeg(open - DT)).toBeLessThan(0.5); // 停得也是缓的
  });

  it('慢慢自己合上：至少两秒、单调、不过头、最后一帧几乎不动（没有声音，所以不能「砰」一下），最后正好是 0', () => {
    const { close } = FD.FRONT_DOOR_MOTION;
    expect(close).toBeGreaterThanOrEqual(2);
    const xs = samples(0, close).map((t) => FD.slowCloseDeg(t, TL.openDeg));
    expect(monotone(xs, -1)).toBe(true);
    expect(xs[0]).toBe(TL.openDeg);
    expect(FD.slowCloseDeg(close, TL.openDeg)).toBe(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(FD.slowCloseDeg(close - DT, TL.openDeg)).toBeLessThan(0.1);
    // 最快的一帧每秒不到 60°（甩上是 600°/秒 以上）
    const fastest = Math.max(...xs.slice(1).map((x, i) => (xs[i] - x) / 0.001));
    expect(fastest).toBeLessThan(60);
  });

  it('甩上（有人跑出去）：exit.contact 秒内合完，越关越快，撞上的那一刻正好是 0，不弹回', () => {
    const c = TL.exit.contact;
    const xs = samples(0, c).map((t) => FD.slamDeg(t, TL.openDeg));
    expect(monotone(xs, -1)).toBe(true);
    expect(FD.slamDeg(c, TL.openDeg)).toBe(0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    // 越关越快：后一半走的比前一半多
    expect(TL.openDeg - FD.slamDeg(c / 2, TL.openDeg)).toBeLessThan(FD.slamDeg(c / 2, TL.openDeg));
    for (const t of samples(c, c + 1, 0.01)) expect(FD.slamDeg(t, TL.openDeg)).toBe(0);
  });
});

// ── 访客走到门口之前，门已经开到 70° 以上 ───────────────────────────────────────────────────────────────

describe('前门：进门那一下赶在访客前面', () => {
  /** 真模拟里：门外放一个访客（entering），逐步推进，返回他第一次走到 z ≤ zLimit 的时刻（spawn 事件那一刻算 0） */
  function arrival(zLimit: number): number {
    const w = createWorld({ seed: 7, autoSpawn: false });
    const n = w.spawn();
    expect(n.mode).toBe('entering');
    expect(n.pos).toEqual(FRONT_DOOR.outside);
    for (let k = 1; k <= 600; k++) {
      w.step(DT);
      if (n.pos.z <= zLimit) return k * DT;
    }
    throw new Error('访客没走到门口');
  }
  /** 南墙的外沿（门洞格子的南边界）：走到这里就算「到门口」 */
  const DOORSTEP = (FRONT_DOOR.cells[0][1] + 1) * CELL;

  it('量一下：访客从门外走到门口（南墙外沿）约 1.2 秒', () => {
    const t = arrival(DOORSTEP);
    expect(t).toBeGreaterThan(1.0);
    expect(t).toBeLessThan(1.5);
  });

  it('访客到门口的时候，门已经开到 clearDeg 以上，并且比他早到至少 0.15 秒', () => {
    const t = arrival(DOORSTEP);
    expect(FD.spawnOpenDeg(t)).toBeGreaterThanOrEqual(TL.clearDeg);
    const reaches = samples(0, 3, 0.001).find((x) => FD.spawnOpenDeg(x) >= TL.clearDeg)!;
    expect(reaches).toBeLessThanOrEqual(t - 0.15);
    // 内容分析里写的：约 1.0 秒前要开到 70° 以上
    expect(reaches).toBeLessThanOrEqual(1.0);
  });

  it('从半开接着推开也一样（上一次还没合完就有人敲门，起点 30°）', () => {
    const t = arrival(DOORSTEP);
    expect(FD.spawnOpenDeg(t, 30)).toBeGreaterThanOrEqual(TL.clearDeg);
  });
});

// ── 状态：openness 读数，按访客的位置和模式推 ──────────────────────────────────────────────────────────

const npc = (id: number, mode: NpcMode, x: number, z: number): FD.DoorNpc => ({ id, mode, pos: { x, z } });

/** 推 seconds 秒，每帧问 npcs(t) 要此刻的访客；t 从 start 算起（动作控制器自己的钟也从它被建出来算起，spawn 在 0） */
function drive(m: FD.DoorMotion, from: number, seconds: number, npcs: (t: number) => FD.DoorNpc[] = () => []) {
  const out: { t: number; deg: number }[] = [];
  const n = Math.round(seconds / DT);
  for (let k = 1; k <= n; k++) {
    const t = from + k * DT;
    m.update(DT, npcs(t));
    out.push({ t, deg: m.deg });
  }
  return out;
}
const degAt = (xs: { t: number; deg: number }[], t: number) => xs.reduce((best, x) => (Math.abs(x.t - t) < Math.abs(best.t - t) ? x : best)).deg;

describe('前门：spawn 事件', () => {
  it('没有人、没有事件，门一直关着，openness 是 0', () => {
    const m = FD.createDoorMotion();
    const xs = drive(m, 0, 10);
    expect(xs.every((x) => x.deg === 0)).toBe(true);
    expect(m.openness).toBe(0);
  });

  it('spawn：先敲门（还关着），吱呀那一秒里推开，访客到门口之前已经开到 70° 以上，开到头 openness = 1', () => {
    const m = FD.createDoorMotion();
    m.spawn();
    const outside = npc(1, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z);
    const xs = drive(m, 0, 2, () => [outside]);
    expect(degAt(xs, TL.knocks[1] + 0.1)).toBe(0);
    expect(degAt(xs, TL.creak[0] - 0.05)).toBe(0);
    expect(degAt(xs, 1.0)).toBeGreaterThanOrEqual(TL.clearDeg);
    expect(degAt(xs, TL.creak[1] + 0.05)).toBe(TL.openDeg);
    expect(m.openness).toBe(1);
    // 曲线就是 spawnOpenDeg（控制器没有另排一条）
    for (const x of xs) expect(Math.abs(x.deg - FD.spawnOpenDeg(x.t))).toBeLessThan(0.5);
  });

  it('进门的人走进来：一直开着；走到门厅站定（wander）以后停一会儿，慢慢自己合上，没有突然的一下，最后 openness = 0', () => {
    const m = FD.createDoorMotion();
    m.spawn();
    // 访客：1.2 米/秒从门外走到 inside（z 10.6），到了换成 wander
    const walk = (t: number) => {
      const z = Math.max(FRONT_DOOR.inside.z, FRONT_DOOR.outside.z - 1.2 * Math.max(0, t - 0.4));
      return [npc(1, z > FRONT_DOOR.inside.z ? 'entering' : 'wander', FRONT_DOOR.outside.x, z)];
    };
    const settledAt = 0.4 + (FRONT_DOOR.outside.z - FRONT_DOOR.inside.z) / 1.2;
    const xs = drive(m, 0, settledAt + FD.FRONT_DOOR_MOTION.settle + FD.FRONT_DOOR_MOTION.close + 2, walk);
    // 走进来的过程中一直是全开
    for (const x of xs.filter((y) => y.t > TL.creak[1] && y.t < settledAt)) expect(x.deg).toBe(TL.openDeg);
    // 站定以后 settle 秒内还没动
    expect(degAt(xs, settledAt + FD.FRONT_DOOR_MOTION.settle * 0.8)).toBe(TL.openDeg);
    // 然后慢慢合上：单调、没有一帧动超过 1.5°（慢慢来，不是砰）
    const closing = xs.filter((y) => y.t > settledAt + FD.FRONT_DOOR_MOTION.settle);
    expect(monotone(closing.map((y) => y.deg), -1)).toBe(true);
    for (let k = 1; k < closing.length; k++) expect(closing[k - 1].deg - closing[k].deg).toBeLessThan(1.5);
    expect(m.deg).toBe(0);
    expect(m.openness).toBe(0);
  });

  it('门正在慢慢合着的时候又有人敲门：停住，敲完从当前角度接着推开', () => {
    const m = FD.createDoorMotion();
    m.spawn();
    drive(m, 0, 2);
    // 没有人了：settle 之后开始合；合到一半又有人来
    const half = drive(m, 2, FD.FRONT_DOOR_MOTION.settle + FD.FRONT_DOOR_MOTION.close * 0.5);
    const mid = m.deg;
    expect(mid).toBeGreaterThan(5);
    expect(mid).toBeLessThan(TL.openDeg - 5);
    expect(half.length).toBeGreaterThan(0);
    m.spawn();
    const t0 = 2 + half.length * DT;
    const xs = drive(m, t0, 2, () => [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)]);
    // 敲门的那 0.55 秒里停在原处
    expect(Math.abs(degAt(xs, t0 + TL.creak[0] - 0.05) - mid)).toBeLessThan(0.5);
    expect(degAt(xs, t0 + TL.creak[1] + 0.05)).toBe(TL.openDeg);
  });
});

describe('前门：逃跑和 exit 事件', () => {
  /** 逃跑的人沿 x = 8.0 从 z0 往南跑，速度 3.2 米/秒（SPEED.flee）；到 z ≥ 13.2（门外）就是该 exit 的时候 */
  const run = (z0: number, startAt = 0) => (t: number) => [npc(5, 'fleeing', DOOR.x, Math.min(FRONT_DOOR.outside.z, z0 + 3.2 * Math.max(0, t - startAt)))];

  it('他还远的时候门不动；离门洞中心 reach 米时被撞开，他到门口（南墙内沿）之前已经开到 70° 以上', () => {
    const m = FD.createDoorMotion();
    const z0 = 5;
    const who = run(z0);
    const xs = drive(m, 0, 4, who);
    const reachAt = (DOOR.z - FD.FRONT_DOOR_MOTION.flee.reach - z0) / 3.2;
    expect(degAt(xs, reachAt - 0.05)).toBe(0);
    for (const x of xs.filter((y) => y.t < reachAt - 0.02)) expect(x.deg).toBe(0);
    // 他走到门洞北边 1.2 米的时候（门扫过的那一片之前）已经开到 clearDeg 以上
    const t12 = (DOOR.z - 1.2 - z0) / 3.2;
    expect(degAt(xs, t12)).toBeGreaterThanOrEqual(TL.clearDeg);
    expect(monotone(xs.filter((y) => y.t < t12 + 0.5).map((y) => y.deg), 1)).toBe(true);
  });

  it('exit：事件那一刻起甩上，contact 秒后正好合上（关门的闷响也落在那一刻），之后一直关着', () => {
    const m = FD.createDoorMotion();
    const who = run(5);
    const tExit = (FRONT_DOOR.outside.z - 5) / 3.2;
    const xs = drive(m, 0, tExit, who);
    expect(m.deg).toBe(TL.openDeg);
    // exit 事件：此刻他在门外；state.npcs 里可能还留着这一步的他（mode gone）
    m.exit(5, [npc(5, 'gone', DOOR.x, FRONT_DOOR.outside.z)]);
    const after = drive(m, tExit, TL.exit.contact + 1, () => []);
    expect(xs.length).toBeGreaterThan(0);
    // 事件那一帧还开着，contact 秒后（差半帧以内）合上
    expect(degAt(after, tExit + DT)).toBeGreaterThan(TL.openDeg * 0.5);
    expect(degAt(after, tExit + TL.exit.contact + DT)).toBe(0);
    expect(monotone(after.map((y) => y.deg), -1)).toBe(true);
    expect(m.openness).toBe(0);
    // 撞上那一帧（contact 之后的第一帧）正好是 0，不早也不晚超过一帧
    const firstClosed = after.find((y) => y.deg === 0)!;
    expect(Math.abs(firstClosed.t - tExit - TL.exit.contact)).toBeLessThanOrEqual(DT + EPS);
  });

  it('后面还有人在跑（离门洞中心 hold 米以内的逃跑、进门、自己走的人）：这一声 exit 不甩门，等最后一个人', () => {
    for (const mode of ['fleeing', 'leaving', 'entering'] as const) {
      const m = FD.createDoorMotion();
      drive(m, 0, 0.5, () => [npc(5, 'fleeing', DOOR.x, DOOR.z - 1.0)]);
      expect(m.deg).toBe(TL.openDeg);
      m.exit(4, [npc(4, 'gone', DOOR.x, FRONT_DOOR.outside.z), npc(5, mode, DOOR.x, DOOR.z - 1.0)]);
      drive(m, 0.5, 1, () => [npc(5, mode, DOOR.x, DOOR.z - 1.0)]);
      expect(m.deg).toBe(TL.openDeg);
    }
    // 他在 hold 以外（还在走廊里）就不用等
    const far = FD.createDoorMotion();
    drive(far, 0, 0.5, () => [npc(5, 'fleeing', DOOR.x, DOOR.z - 1.0)]);
    far.exit(4, [npc(5, 'fleeing', DOOR.x, DOOR.z - FD.FRONT_DOOR_MOTION.hold - 0.5)]);
    drive(far, 0.5, TL.exit.contact + 0.1, () => []);
    expect(far.deg).toBe(0);
  });

  it('门本来就关着、或者正有人敲门（吱呀还没开始）：exit 不动它', () => {
    const closed = FD.createDoorMotion();
    closed.exit(1, []);
    expect(drive(closed, 0, 1).every((x) => x.deg === 0)).toBe(true);
    const knocking = FD.createDoorMotion();
    knocking.spawn();
    drive(knocking, 0, 0.2, () => [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)]);
    knocking.exit(1, [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)]);
    const xs = drive(knocking, 0.2, 1.8, () => [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)]);
    expect(degAt(xs, TL.creak[1] + 0.1)).toBe(TL.openDeg);
  });

  it('exit() 返回这一下门真的甩上了没有（声音按它决定响不响关门声）：甩的时候 true；后面还有人、门本来就关着、正有人敲门时 false', () => {
    const m = FD.createDoorMotion();
    drive(m, 0, 0.5, () => [npc(5, 'fleeing', DOOR.x, DOOR.z - 1.0)]);
    expect(m.exit(5, [npc(5, 'gone', DOOR.x, FRONT_DOOR.outside.z)])).toBe(true);
    for (const mode of ['fleeing', 'leaving', 'entering'] as const) {
      const g = FD.createDoorMotion();
      drive(g, 0, 0.5, () => [npc(5, 'fleeing', DOOR.x, DOOR.z - 1.0)]);
      expect(g.exit(4, [npc(4, 'gone', DOOR.x, FRONT_DOOR.outside.z), npc(5, mode, DOOR.x, DOOR.z - 1.0)])).toBe(false);
      // 最后那一个出去：甩
      expect(g.exit(5, [npc(5, 'gone', DOOR.x, FRONT_DOOR.outside.z)])).toBe(true);
    }
    expect(FD.createDoorMotion().exit(1, [])).toBe(false);
    const knocking = FD.createDoorMotion();
    knocking.spawn();
    drive(knocking, 0, 0.2, () => [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)]);
    expect(knocking.exit(1, [npc(2, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)])).toBe(false);
  });

  it('甩上以后门洞里没人，门一直关着，不会自己弹开', () => {
    const m = FD.createDoorMotion();
    drive(m, 0, 0.5, () => [npc(5, 'fleeing', DOOR.x, DOOR.z - 1.0)]);
    m.exit(5, [npc(5, 'gone', DOOR.x, FRONT_DOOR.outside.z)]);
    const xs = drive(m, 0.5, 6, () => []);
    expect(xs.at(-1)!.deg).toBe(0);
    expect(xs.filter((x) => x.t > 0.5 + TL.exit.contact + DT).every((x) => x.deg === 0)).toBe(true);
  });
});

describe('前门：天亮自己走的人（leaving）', () => {
  it('他走到离门洞中心 calm.reach 米才推开（慢慢地），他走到门洞北边 1.2 米之前已经全开；之后一直开着，exit 时甩上', () => {
    const m = FD.createDoorMotion();
    const z0 = 6;
    const who = (t: number) => [npc(7, 'leaving', DOOR.x, Math.min(FRONT_DOOR.outside.z, z0 + 1.2 * t))];
    const reachAt = (DOOR.z - FD.FRONT_DOOR_MOTION.calm.reach - z0) / 1.2;
    const xs = drive(m, 0, (FRONT_DOOR.outside.z - z0) / 1.2, who);
    for (const x of xs.filter((y) => y.t < reachAt - 0.02)) expect(x.deg).toBe(0);
    expect(degAt(xs, (DOOR.z - 1.2 - z0) / 1.2)).toBe(TL.openDeg);
    // 推开是缓的：开始那半秒里不到 10°
    expect(degAt(xs, reachAt + 0.3)).toBeLessThan(30);
    expect(m.deg).toBe(TL.openDeg);
    m.exit(7, [npc(7, 'gone', DOOR.x, FRONT_DOOR.outside.z)]);
    expect(drive(m, 0, TL.exit.contact + 0.05).at(-1)!.deg).toBe(0);
  });
});

describe('前门：真模拟里吓跑一个人', () => {
  const MIRROR = PROPS.find((p) => p.id === 'mirror')!;
  const mirrorAt = propCenter(MIRROR);
  const BATH = { x: mirrorAt.x + Math.cos(MIRROR.facing) * 2, z: mirrorAt.z + Math.sin(MIRROR.facing) * 2 };

  it('从浴室跑向前门：门一直关着，他到门洞北边 1.2 米时已开到 70° 以上；exit 事件后 contact 秒合上，openness 回到 0', () => {
    const w = createWorld({ seed: 5, autoSpawn: false });
    const n = w.spawn({ pos: BATH, personality: 'timid', name: 'Theo', lookDir: Math.atan2(mirrorAt.z - BATH.z, mirrorAt.x - BATH.x) });
    n.fear = 40;
    w.trigger('mirror');
    const m = FD.createDoorMotion();
    let t = 0;
    let exitAt = -1;
    let at12: number | null = null;
    let sawOpenBeforeFlee = false;
    const log: SimEvent['type'][] = [];
    for (let k = 0; k < 40 * 60 && !(exitAt >= 0 && t > exitAt + TL.exit.contact + 0.5); k++) {
      const ev = w.step(DT);
      t += DT;
      // 浴室里放进去的那个人也会有一个 spawn 事件，那是测试摆的，不是有人在门外敲门，不转给门
      for (const e of ev) {
        log.push(e.type);
        if (e.type === 'exit') {
          exitAt = t;
          m.exit(e.npc, w.state.npcs);
        }
      }
      m.update(DT, w.state.npcs);
      const me = w.state.npcs.find((x) => x.id === n.id);
      if (me && me.mode !== 'fleeing') sawOpenBeforeFlee ||= m.deg > 0;
      if (me && me.mode === 'fleeing' && at12 === null && me.pos.z >= DOOR.z - 1.2 && me.pos.x < 9) at12 = m.deg;
      // 他还在浴室里、没逃的时候，门不动
      if (me && me.mode !== 'fleeing') expect(m.deg).toBe(0);
    }
    expect(log).toContain('flee');
    expect(exitAt).toBeGreaterThan(0);
    expect(sawOpenBeforeFlee).toBe(false);
    expect(at12).not.toBeNull();
    expect(at12!).toBeGreaterThanOrEqual(TL.clearDeg);
    expect(m.deg).toBe(0);
    expect(m.openness).toBe(0);
  });
});

describe('前门：一群人出门时，关门声只跟着画面上真的甩门的那一下（集成，FD 审查 Minor 1）', () => {
  /**
   * 一串 openness 里「甩上」的那几下（返回开始动的那一帧）：从 ≥ 0.5 一路往下、exit.contact 秒（多两帧以内）合到 0。
   * 慢慢自己合上要 0.6 秒以上，不算
   */
  const slamStarts = (o: number[]) => {
    const out: number[] = [];
    for (let k = 1; k < o.length; k++) {
      if (!(o[k] === 0 && o[k - 1] > 0)) continue;
      let s = k - 1;
      while (s > 0 && o[s - 1] > o[s]) s--;
      if (o[s] >= 0.5 && (k - s) * DT <= TL.exit.contact + 2 * DT) out.push(s + 1);
    }
    return out;
  };

  it('天亮时门厅里四个人一个接一个走出去（真模拟）：门等最后一个才甩；slammed 为 true 的那几个 exit 正好对上画面上甩门的那几下', () => {
    const w = createWorld({ seed: 7, autoSpawn: false });
    const spots = [{ x: 7.2, z: 9.6 }, { x: 8.8, z: 9.4 }, { x: 7.6, z: 8.4 }, { x: 8.6, z: 8.2 }];
    spots.forEach((pos, i) => w.spawn({ pos, name: `V${i + 1}`, personality: 'brave' }));
    w.step(DT); // 测试摆进来的人也有 spawn 事件：不是有人在门外敲门，不转给门
    const door = createFrontDoorFor(fakeCore());
    w.dawn();
    const open: number[] = [];
    const exits: { id: number; at: number; slammed: boolean; calm: boolean }[] = [];
    for (let k = 0; k < 60 * 60 && (w.state.npcs.length > 0 || open.length < (exits.at(-1)?.at ?? 0) + 4 * 60); k++) {
      for (const e of w.step(DT)) {
        if (e.type !== 'exit') continue;
        door.onEvent?.(e, w.state);
        exits.push({ id: e.npc, at: open.length, slammed: door.slammed(e.npc), calm: e.calm === true });
      }
      door.update?.(ctxOf(DT, w.state));
      open.push(door.openness);
    }
    expect(w.state.npcs).toEqual([]);
    expect(exits).toHaveLength(spots.length);
    expect(exits.every((x) => x.calm)).toBe(true);
    const slams = slamStarts(open);
    const slammed = exits.filter((x) => x.slammed);
    // 有人挨着出门：门没有每个人都甩（声音也就不是每个人都响）
    expect(slammed.length).toBeGreaterThanOrEqual(1);
    expect(slammed.length).toBeLessThan(exits.length);
    // 每一下甩门都有一个 slammed 的 exit 在同一帧起头；反过来也一样（一一对上，不多不少）
    expect(slams).toEqual(slammed.map((x) => x.at));
    expect(exits.at(-1)!.slammed).toBe(true);
    expect(door.openness).toBe(0);
  });

  it('没见过的编号、没甩门的 exit：slammed 是 false', () => {
    const door = createFrontDoorFor(fakeCore());
    expect(door.slammed(42)).toBe(false);
    door.onEvent?.({ type: 'exit', npc: 3, name: 'X', total: 1 }, emptyState());
    expect(door.slammed(3)).toBe(false); // 门本来就关着
  });
});

// ── 门板本身 ───────────────────────────────────────────────────────────────────────────────────────

const fakeCore = () => ({ houseRoot: new THREE.Group() }) as unknown as RenderCore;
const emptyState = () => ({ time: 0, npcs: [], objects: [], scaredOff: 0, hitStop: 0, manifest: { phase: 'idle', t: 0, cooldown: 0, pos: null }, avoid: [] }) as unknown as WorldState;
const ctxOf = (dt = DT, state = emptyState()): FrameCtx => ({ dt, time: 0, state });
const ghostRig = () => ({}) as unknown as GhostRig;
const find = (core: RenderCore, name: string) => core.houseRoot.getObjectByName(name) as THREE.Object3D;
const meshesOf = (o: THREE.Object3D) => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
};

describe('前门：门板', () => {
  it('嵌在门洞里：关上时全在门洞的 1 米宽里（门框线脚多出 3 厘米以内）、高不过前门门楣的下沿 2.1 米、厚不出墙格；在门厅一侧', () => {
    const core = fakeCore();
    createFrontDoorFor(core);
    const root = find(core, 'front-door');
    expect(root).toBeTruthy();
    const box = new THREE.Box3().setFromObject(root);
    expect(box.min.x).toBeGreaterThanOrEqual(DOOR.x - 0.5 - 0.03);
    expect(box.max.x).toBeLessThanOrEqual(DOOR.x + 0.5 + 0.03);
    expect(box.min.y).toBeGreaterThanOrEqual(-1e-6);
    expect(box.max.y).toBeLessThan(2.1);
    // 门厅一侧的门把手凸出门板 3.5 厘米（和厨房门一样），所以 z 方向放宽到 ±0.2；墙格是 0.5 米厚
    expect(box.min.z).toBeGreaterThanOrEqual(DOOR.z - 0.2);
    expect(box.max.z).toBeLessThanOrEqual(DOOR.z + 0.2);
    // 门板（不含门框）关着时在屋里一侧：南墙外沿以内
    const leaf = new THREE.Box3().setFromObject(find(core, 'front-door-leaf'));
    expect(leaf.max.z).toBeLessThan(DOOR.z);
  });

  it('绕西侧合页往屋里开：合页在门洞西边，开到 100° 时门板整个在门洞西边那一侧，让出 x = 8.0 那条进门的路（身子半宽 0.3 米）', () => {
    const core = fakeCore();
    const door = createFrontDoorFor(core);
    const hinge = find(core, 'front-door-hinge');
    expect(hinge.position.x).toBeLessThan(0);
    // 用 spawn 把门推开到头（访客一直在门外，门不会自己合）
    door.onEvent?.({ type: 'spawn', npc: 1 }, emptyState());
    for (let k = 0; k < 2 * 60; k++) door.update?.(ctxOf(DT, stateWith([npc(1, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)])));
    expect(door.openness).toBe(1);
    core.houseRoot.updateMatrixWorld(true);
    const leaf = new THREE.Box3().setFromObject(find(core, 'front-door-leaf'));
    expect(leaf.max.x).toBeLessThan(DOOR.x - 0.3);
    // 往屋里（北）开：门板的 z 范围在南墙内沿以北
    expect(leaf.max.z).toBeLessThan(DOOR.z);
    expect(leaf.min.z).toBeLessThan(DOOR.z - 0.7);
    // 转角：openDeg 度
    expect(hinge.rotation.y).toBeCloseTo((TL.openDeg * Math.PI) / 180, 9);
  });

  it('不新加灯、不发光、不描边：没有光源，没有幽光外壳，材质不透明也不是加法混合，和厨房门一样的顶点色材质，投影、接收阴影', () => {
    const core = fakeCore();
    createFrontDoorFor(core);
    const root = find(core, 'front-door');
    root.traverse((o) => expect((o as THREE.Light).isLight).toBeFalsy());
    const ms = meshesOf(root);
    expect(ms.length).toBeLessThanOrEqual(3);
    for (const m of ms) {
      expect(m.name).not.toBe('glow-shell');
      const mat = m.material as THREE.MeshStandardNodeMaterial;
      expect(mat.isMeshStandardNodeMaterial).toBe(true);
      expect(mat.transparent).toBe(false);
      expect(mat.blending).toBe(THREE.NormalBlending);
      expect(mat.vertexColors).toBe(true);
      expect(m.castShadow).toBe(true);
      expect(m.receiveShadow).toBe(true);
    }
  });

  it('一开场就在场景里（开场的预编译就编好了）：可见、没有标 deferCompile；摆在 houseRoot 下的门洞位置', () => {
    const core = fakeCore();
    createFrontDoorFor(core);
    const root = find(core, 'front-door');
    expect(root.parent).toBe(core.houseRoot);
    expect(root.position.x).toBeCloseTo(DOOR.x, 9);
    expect(root.position.z).toBeCloseTo(DOOR.z, 9);
    root.traverse((o) => {
      expect(o.visible).toBe(true);
      expect(o.userData.deferCompile).toBeUndefined();
    });
  });

  it('第三人称：材质带溶解（鬼魂和镜头穿过时溶开，影子照旧）；娃娃屋、?noghostfx 不溶', () => {
    const maskOf = (core: RenderCore) => (meshesOf(find(core, 'front-door'))[0].material as THREE.MeshStandardNodeMaterial);
    const ghost = fakeCore();
    FD.createFrontDoor(ghost, ghostRig());
    expect(maskOf(ghost).maskNode).toBeTruthy();
    expect(maskOf(ghost).maskShadowNode).toBeTruthy();
    const doll = fakeCore();
    FD.createFrontDoor(doll, null);
    expect(maskOf(doll).maskNode).toBeFalsy();
    vi.stubGlobal('location', { search: '?noghostfx' });
    const off = fakeCore();
    FD.createFrontDoor(off, ghostRig());
    expect(maskOf(off).maskNode).toBeFalsy();
  });

  it('openness 读数：0 = 关上，1 = 全开，随门的角度走', () => {
    const core = fakeCore();
    const door = createFrontDoorFor(core);
    expect(door.openness).toBe(0);
    door.onEvent?.({ type: 'spawn', npc: 1 }, emptyState());
    let prev = 0;
    for (let k = 0; k < 2 * 60; k++) {
      door.update?.(ctxOf(DT, stateWith([npc(1, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)])));
      expect(door.openness).toBeGreaterThanOrEqual(prev);
      expect(door.openness).toBeLessThanOrEqual(1);
      prev = door.openness;
    }
    expect(door.openness).toBe(1);
    const hinge = find(core, 'front-door-hinge');
    expect(hinge.rotation.y).toBeCloseTo(door.openness * (TL.openDeg * Math.PI) / 180, 9);
  });

  it('dispose：从 houseRoot 摘掉', () => {
    const core = fakeCore();
    const door = createFrontDoorFor(core);
    door.dispose?.();
    expect(find(core, 'front-door')).toBeUndefined();
  });
});

function createFrontDoorFor(core: RenderCore) {
  return FD.createFrontDoor(core, null);
}
const stateWith = (npcs: FD.DoorNpc[]) => ({ ...emptyState(), npcs }) as unknown as WorldState;

// ── 俯视（触屏）模式：南墙降低时门板跟着藏起来 ─────────────────────────────────────────────────────────

describe('前门：俯视模式南墙降低时跟着藏起来（walls.ts 的 wallFullness）', () => {
  /** 相机在东南（quarter 0）：南墙、东墙是近墙，降低；西北是远墙，全高 */
  const SE = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
  const NW = { x: -Math.SQRT1_2, z: -Math.SQRT1_2 };

  it('walls.ts 的只读导出就是最近建好的那一份墙的 fullness（按 Side 编号）', () => {
    const walls = createWalls(buildTiles(), SE, {});
    expect(wallFullness).toBe(walls.fullness);
    expect(wallFullness[Side.S]).toBe(0);
    expect(wallFullness[Side.N]).toBe(1);
    walls.update(1, NW);
    expect(wallFullness[Side.S]).toBe(1);
    // 第三人称：墙一直全高
    createWalls(buildTiles(), SE, { fullHeight: true });
    expect(wallFullness.every((f) => f === 1)).toBe(true);
  });

  it('南墙降低：门板沉到地板下（还在场景里、还可见，开场的预编译才编得到）；南墙升起来，门板升回来；中间跟着墙一起走', () => {
    const walls = createWalls(buildTiles(), SE, {});
    const core = fakeCore();
    const door = FD.createFrontDoor(core, null);
    const root = find(core, 'front-door');
    const top = new THREE.Box3().setFromObject(root).max.y;
    door.update?.(ctxOf());
    expect(root.position.y).toBeLessThan(-top); // 整个门都在地板下面
    expect(root.visible).toBe(true);
    const ys: number[] = [root.position.y];
    for (let k = 0; k < 20; k++) {
      walls.update(0.02, NW);
      door.update?.(ctxOf());
      ys.push(root.position.y);
    }
    expect(monotone(ys, 1)).toBe(true);
    expect(ys.at(-1)).toBe(0);
    // 中间：墙升到一半的时候，门也升到一半左右
    const half = createWalls(buildTiles(), SE, {});
    half.update(0.15, NW);
    const f = wallFullness[Side.S];
    expect(f).toBeGreaterThan(0.3);
    expect(f).toBeLessThan(0.7);
    door.update?.(ctxOf());
    expect(root.position.y).toBeLessThan(0);
    expect(root.position.y).toBeGreaterThan(-top * 1.2);
    // 再降下去
    half.update(1, SE);
    door.update?.(ctxOf());
    expect(root.position.y).toBeLessThan(-top);
  });

  it('第三人称（墙一直全高）：门板一直在原位', () => {
    createWalls(buildTiles(), SE, { fullHeight: true });
    const core = fakeCore();
    const door = FD.createFrontDoor(core, ghostRig());
    for (let k = 0; k < 10; k++) door.update?.(ctxOf());
    expect(find(core, 'front-door').position.y).toBe(0);
  });

  it('开合的动作在门板藏起来的时候照常走（openness 不受影响：收夜检测读它）', () => {
    createWalls(buildTiles(), SE, {});
    const core = fakeCore();
    const door = FD.createFrontDoor(core, null);
    door.onEvent?.({ type: 'spawn', npc: 1 }, emptyState());
    for (let k = 0; k < 2 * 60; k++) door.update?.(ctxOf(DT, stateWith([npc(1, 'entering', FRONT_DOOR.outside.x, FRONT_DOOR.outside.z)])));
    expect(door.openness).toBe(1);
  });
});
