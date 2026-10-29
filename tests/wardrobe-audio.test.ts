// 衣柜的声音（设计文档 4.3、调研 3.3 的 A 版「被从里面拉上」）：几个声音的时刻和 config/scares.ts 的 WARDROBE 对齐。
// WebAudio 在 node 里没有，音色和响度靠 dev/audio.html 的离线渲染量（数字写在报告里）；这里守的是「时刻」，分四层：
//   1. 时刻表 wardrobeCues()（合成函数就是照它排的）对得上 WARDROBE：锁舌在 latch 里、吱呀覆盖 open、hold 和门关上的那 slamTime 秒里
//      没有新声音、闷响（门板、锁舌、低频冲击）只响一次、落在门撞上门框的那一刻（slamAt + slamTime）± 0.02 秒、落灰在撞上之后
//      （门从 slamAt 起关，slamAt 那一刻门还开着；撞击声放在 slamAt 会比画面早 slamTime 秒，所以基准是接触，不是 slamAt）
//   2. 真的把 wardrobe 这个 SfxFn 跑一遍：WebAudio 的替身记下每个声源什么时候起、什么时候停、颗粒轨里每一颗什么时候响，
//      再对账——不是只信时刻表
//   3. 时间轴改了，声音跟着走：把 WARDROBE 拉长、整体后移再量一遍（证明没有把数抄一份）；只改 slamTime，撞击声也要跟着后移
//   4. 低频冲击和床的 BED_HIT 一个分量、比现身落下的轻；衣柜有自己的声音，不再借厨房门的
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCARES, WARDROBE, WARDROBE_SHUT } from '../src/config/scares';
import { BED_HIT, LEVEL, MANIFEST_HIT, TRIGGER, WARDROBE_HIT, WARDROBE_SFX, door, rng, wardrobe, wardrobeCues, type Bus, type WardrobeCues } from '../src/audio/sfx';

/** 声音从这一刻起播（和 dev 页面一样前面留一点空）；下面的时刻都换算成相对它的秒数 */
const T0 = 0.05;
const SR = 48000;
const EPS = 1e-6;

// ── WebAudio 的替身：只够 Snd / bandNoise / creak / thud / braam 建图，顺手记下每个声源的起止 ──────────────────────

/** 一个声源（振荡器或缓冲区播放）的记录 */
interface Src {
  kind: 'osc' | 'buf';
  /** 振荡器的波形（sine / sawtooth …）；用窄脉冲波形（吱呀的摩擦脉冲）的记成 'periodic'；缓冲区记成 'buffer' */
  type: string;
  /** 起始频率（赫兹） */
  freq: number;
  /** 循环播放的（噪声源）；颗粒轨不循环 */
  loop: boolean;
  start: number;
  stop: number | null;
  /** 颗粒轨的采样（不循环的缓冲区才有） */
  data: Float32Array | null;
}
let recs: Src[] = [];

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
  setTargetAtTime() {
    return this;
  }
  setValueCurveAtTime() {
    return this;
  }
  cancelScheduledValues() {
    return this;
  }
}
interface NodeOpts {
  gain?: number;
  frequency?: number;
  detune?: number;
  Q?: number;
  pan?: number;
  offset?: number;
  type?: string;
  periodicWave?: unknown;
  buffer?: unknown;
  loop?: boolean;
}
/** GainNode、StereoPannerNode、BiquadFilterNode、WaveShaperNode、ConstantSourceNode 共用这一个 */
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
  connect<T>(dest: T): T {
    return dest;
  }
  disconnect() {}
  start(_t?: number, _offset?: number) {}
  stop(_t?: number) {}
}
class FakeOsc extends FakeNode {
  private readonly rec: Src;
  constructor(ac?: unknown, o: NodeOpts = {}) {
    super(ac, o);
    this.rec = { kind: 'osc', type: o.periodicWave ? 'periodic' : (o.type ?? 'sine'), freq: o.frequency ?? 440, loop: false, start: NaN, stop: null, data: null };
    recs.push(this.rec);
  }
  override start(t = 0) {
    this.rec.start = t;
  }
  override stop(t = 0) {
    this.rec.stop = t;
  }
}
class FakeBuffer {
  readonly duration: number;
  private readonly d: Float32Array;
  constructor(o: { length: number; sampleRate: number }) {
    this.d = new Float32Array(o.length);
    this.duration = o.length / o.sampleRate;
  }
  getChannelData() {
    return this.d;
  }
}
class FakeBufSrc extends FakeNode {
  private readonly rec: Src;
  constructor(ac?: unknown, o: NodeOpts = {}) {
    super(ac, o);
    const grains = !o.loop && o.buffer instanceof FakeBuffer;
    this.rec = { kind: 'buf', type: 'buffer', freq: 0, loop: !!o.loop, start: NaN, stop: null, data: grains ? (o.buffer as FakeBuffer).getChannelData() : null };
    recs.push(this.rec);
  }
  override start(t = 0) {
    this.rec.start = t;
  }
  override stop(t = 0) {
    this.rec.stop = t;
  }
}
class FakePeriodicWave {}

const newBus = () =>
  ({ ac: { sampleRate: SR, currentTime: 0 }, sfx: new FakeNode(), voice: new FakeNode(), amb: new FakeNode(), reverb: new FakeNode(), noise: { duration: 4 }, pulse: new FakePeriodicWave() }) as unknown as Bus;

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

/** 跑一遍 wardrobe（立体声居中），返回它报的结束时刻和每个声源的记录 */
function run(seed = 12345): { end: number; srcs: Src[] } {
  const prev = rng.next;
  rng.next = seeded(seed);
  recs = [];
  try {
    const end = wardrobe(newBus(), T0, 0);
    return { end, srcs: recs };
  } finally {
    rng.next = prev;
  }
}

/** 颗粒轨里每一颗开始响的时刻（相对 T0）：缓冲区里连续的非零采样是一颗 */
function grainOnsets(s: Src): number[] {
  if (!s.data) return [];
  const out: number[] = [];
  let inRun = false;
  for (let i = 0; i < s.data.length; i++) {
    const on = s.data[i] !== 0;
    if (on && !inRun) out.push(s.start - T0 + i / SR);
    inRun = on;
  }
  return out;
}
/** 一个声源「开始响」的时刻们（相对 T0）：颗粒轨按颗算，其余按声源的起点 */
const onsetsOf = (s: Src) => (s.data ? grainOnsets(s) : [s.start - T0]);
const isGrains = (s: Src) => s.kind === 'buf' && !!s.data;

beforeEach(() => {
  for (const name of ['GainNode', 'StereoPannerNode', 'BiquadFilterNode', 'WaveShaperNode', 'ConstantSourceNode']) vi.stubGlobal(name, FakeNode);
  vi.stubGlobal('OscillatorNode', FakeOsc);
  vi.stubGlobal('AudioBufferSourceNode', FakeBufSrc);
  vi.stubGlobal('AudioBuffer', FakeBuffer);
  vi.stubGlobal('PeriodicWave', FakePeriodicWave);
});
afterEach(() => vi.unstubAllGlobals());

// ── 对账：时刻表、真正排下去的声源，都要和 WARDROBE 对得上 ─────────────────────────────────────────────

/** 撞击声（闷响、锁舌、低频冲击）离接触那一刻最多差多少秒 */
const SLAM_TOL = 0.02;
/** 吱呀的摩擦脉冲在 end 之后多留 0.02 秒（creakExcite 的收尾），包络那时已经是 0；hold 开头这点时间不算有声 */
const TAIL = 0.03;
/**
 * 门撞上门框的那一刻：门从 slamAt 起关，slamTime 秒后撞上（config/scares.ts 的 WARDROBE_SHUT），撞击声落在这里。
 * 读的是此刻的 WARDROBE（时间轴被改过，这里跟着变），自己算一遍，不拿时刻表、也不拿 config 里的那个函数当基准
 */
const shutAt = () => WARDROBE.slamAt + WARDROBE.slamTime;

/** 时刻表 vs WARDROBE（读的是此刻的 WARDROBE：时间轴改了，这里跟着变） */
function expectCuesAligned(c: WardrobeCues) {
  const W = WARDROBE;
  // 锁舌「咔哒」在 latch 里，接着门板被推的闷响，也在 latch 里，在锁舌之后
  expect(c.latch).toBeGreaterThanOrEqual(W.latch[0] - EPS);
  expect(c.latch).toBeLessThan(W.latch[1]);
  expect(c.push).toBeGreaterThan(c.latch);
  expect(c.push).toBeLessThan(W.latch[1]);
  // 吱呀覆盖 open：从 open 开头起，到 open 结尾止，不越过 hold 的开头
  expect(c.creak[0]).toBeLessThanOrEqual(W.open[0] + EPS);
  expect(c.creak[0]).toBeGreaterThanOrEqual(W.latch[1] - EPS);
  expect(c.creak[1]).toBeGreaterThanOrEqual(W.open[1] - EPS);
  expect(c.creak[1]).toBeLessThanOrEqual(W.hold[0] + EPS);
  // hold 里没有新声音，门关上的那 slamTime 秒里也没有：从 hold 开头到接触之前，没有任何一声起（撞击声不在门刚开始动的时候响）
  const shut = shutAt();
  const onsets = [c.latch, c.push, c.creak[0], c.thud, c.slamLatch, c.hit, c.rattle[0], c.dust[0]];
  for (const t of onsets) expect(t > W.hold[0] + EPS && t < shut - SLAM_TOL - EPS).toBe(false);
  // 闷响、锁舌、低频冲击都落在门撞上门框的那一刻（slamAt + slamTime）± 0.02 秒
  for (const t of [c.thud, c.slamLatch, c.hit]) expect(Math.abs(t - shut)).toBeLessThanOrEqual(SLAM_TOL + EPS);
  // 木头的抖动、落灰在撞上之后；灰在撞上之后 settle 秒之内落完（和画面的落灰同一个起点：撞上那一刻）
  expect(c.rattle[0]).toBeGreaterThanOrEqual(c.thud);
  expect(c.dust[0]).toBeGreaterThanOrEqual(c.thud);
  expect(c.dust[1]).toBeGreaterThan(c.dust[0]);
  expect(c.dust[1]).toBeLessThanOrEqual(shut + W.settle + EPS);
}

/** 真的把 wardrobe 跑一遍，对账每个声源 */
function expectGraphAligned(srcs: Src[], end: number) {
  const W = WARDROBE;
  const rel = (s: Src) => s.start - T0;
  // 每个声源都有起点（没有忘了 start 的）
  for (const s of srcs) expect(Number.isFinite(s.start)).toBe(true);

  // 锁舌「咔哒」：颗粒轨里有颗粒落在 latch 里
  const clicks = srcs.filter(isGrains).flatMap(grainOnsets);
  expect(clicks.some((t) => t >= W.latch[0] - EPS && t < W.latch[1])).toBe(true);

  // 吱呀：摩擦脉冲（窄脉冲波形）只有一根，从 open 开头起到 open 结尾，不越过 hold 的开头
  const pulse = srcs.filter((s) => s.kind === 'osc' && s.type === 'periodic');
  expect(pulse).toHaveLength(1);
  expect(rel(pulse[0])).toBeLessThanOrEqual(W.open[0] + EPS);
  expect(rel(pulse[0])).toBeGreaterThanOrEqual(W.latch[1] - EPS);
  expect((pulse[0].stop ?? Infinity) - T0).toBeGreaterThanOrEqual(W.open[1] - EPS);
  expect((pulse[0].stop ?? Infinity) - T0).toBeLessThanOrEqual(W.hold[0] + TAIL);

  // hold 里没有声音，门关上的那 slamTime 秒里也没有：没有声源（颗粒轨按颗算）从 hold 开头到接触之前开始；hold 之前开始的声源，也不会一直响进 hold
  const shut = shutAt();
  const cues = wardrobeCues();
  for (const s of srcs) {
    for (const t of onsetsOf(s)) expect(t > W.hold[0] + EPS && t < shut - SLAM_TOL - EPS).toBe(false);
    if (rel(s) < W.hold[0] && !s.loop) {
      const stop = s.stop ?? (isGrains(s) ? s.start + (s.data as Float32Array).length / SR : Infinity);
      expect(stop - T0).toBeLessThanOrEqual(W.hold[0] + TAIL);
    }
    if (rel(s) < W.hold[0] && s.loop) expect((s.stop ?? Infinity) - T0).toBeLessThanOrEqual(W.hold[0] + TAIL);
  }

  // 低频冲击（braam，只有它用锯齿波）：全都在门撞上的那一刻 ± 0.02 秒起；门板的闷响（低频正弦下沉）也在
  const saws = srcs.filter((s) => s.kind === 'osc' && s.type === 'sawtooth');
  expect(saws.length).toBeGreaterThanOrEqual(4);
  for (const s of saws) expect(Math.abs(rel(s) - shut)).toBeLessThanOrEqual(SLAM_TOL + EPS);
  const inSlam = (s: Src) => Math.abs(rel(s) - shut) <= SLAM_TOL + EPS;
  // 门板的闷响：那根下沉的正弦（起始频率就是 thudHz[0]）一根，也在接触那一刻 ± 0.02 秒；再加 braam 的下沉和泛音，低频正弦不少于 3 根
  const board = srcs.filter((s) => s.kind === 'osc' && s.type === 'sine' && s.freq === WARDROBE_SFX.slam.thudHz[0]);
  expect(board).toHaveLength(1);
  expect(inSlam(board[0])).toBe(true);
  expect(srcs.filter((s) => s.kind === 'osc' && s.type === 'sine' && s.freq <= 100 && inSlam(s)).length).toBeGreaterThanOrEqual(3);
  // 木头的「啪」、门板和柜体的共鸣、闷响里的噪声、braam 的噪声：接触那一刻一起起，噪声源不少于 4 个
  expect(srcs.filter((s) => s.loop && inSlam(s)).length).toBeGreaterThanOrEqual(4);
  // 落灰的「嘶」：一根从 cues.dust[0] 起、响满 cues.dust 那一段的噪声源。起点要对准落灰自己的时刻，不能拿 braam 自己的 1.2 秒噪声凑数
  // （它从接触那一刻起，比落灰早 dust.from 秒；dust.from 要大于撞击的容差，两个才分得开）
  expect(cues.dust[0] - cues.hit).toBeGreaterThan(SLAM_TOL);
  const hiss = srcs.filter((s) => s.loop && Math.abs(rel(s) - cues.dust[0]) <= EPS);
  expect(hiss.length).toBeGreaterThanOrEqual(1);
  expect(hiss.some((s) => (s.stop ?? 0) - s.start >= cues.dust[1] - cues.dust[0] - EPS)).toBe(true);

  // 撞上之后：颗粒轨里还有颗粒落在接触那一刻之后（木头的抖动、锁舌、落灰的颗粒）
  const late = srcs.filter(isGrains).flatMap(grainOnsets).filter((t) => t >= shut - EPS);
  expect(late.length).toBeGreaterThan(0);

  // 报的结束时刻在落灰和低频冲击都收完之后，不会把尾巴截掉
  expect(end - T0).toBeGreaterThan(shut + 1);
}

describe('衣柜声音的时刻表对得上 WARDROBE', () => {
  it('锁舌在 latch 里；吱呀覆盖 open；hold 和门关上的 slamTime 秒里没有新声音；闷响、锁舌、低频冲击在门撞上门框那一刻（slamAt + slamTime）± 0.02 秒；落灰在撞上之后', () => {
    expectCuesAligned(wardrobeCues());
  });

  it('撞击声在接触那一刻，不在门刚开始关的 slamAt：门在 slamAt 那一刻还开着，声音放在那里会比画面早 slamTime 秒', () => {
    const c = wardrobeCues();
    expect(c.hit - WARDROBE.slamAt).toBeGreaterThanOrEqual(WARDROBE.slamTime - SLAM_TOL - EPS);
    expect(c.thud - WARDROBE.slamAt).toBeGreaterThanOrEqual(WARDROBE.slamTime - SLAM_TOL - EPS);
    expect(c.slamLatch - WARDROBE.slamAt).toBeGreaterThanOrEqual(WARDROBE.slamTime - SLAM_TOL - EPS);
  });

  it('模拟里「落下」的那一刻（SCARES.wardrobe.hitAt）、撞击声（闷响、低频冲击）、画面撞上门框都是同一个数 WARDROBE_SHUT（config/scares.ts，只算一处）', () => {
    expect(WARDROBE_SHUT).toBe(shutAt());
    expect(SCARES.wardrobe.hitAt).toBe(WARDROBE_SHUT);
    const c = wardrobeCues();
    expect(c.hit).toBe(WARDROBE_SHUT);
    expect(c.thud).toBe(WARDROBE_SHUT);
  });

  it('撞上之前至少 0.6 秒的空白（调研原则 11：先抽空再落下）：hold 本身够长，吱呀结束到撞击也隔得够久', () => {
    const c = wardrobeCues();
    expect(WARDROBE.hold[1] - WARDROBE.hold[0]).toBeGreaterThanOrEqual(0.6 - EPS);
    expect(c.thud - c.creak[1]).toBeGreaterThanOrEqual(0.6 - EPS);
  });

  it('时刻表各项依先后排：锁舌 < 推一下 < 吱呀 < 撞上', () => {
    const c = wardrobeCues();
    expect(c.latch).toBeLessThan(c.push);
    expect(c.push).toBeLessThan(c.creak[0]);
    expect(c.creak[0]).toBeLessThan(c.creak[1]);
    expect(c.creak[1]).toBeLessThan(c.thud);
  });
});

describe('真的跑一遍 wardrobe：每个声源的起止都对得上 WARDROBE', () => {
  it('锁舌的颗粒在 latch 里、吱呀的摩擦脉冲覆盖 open、hold 和门关上的 slamTime 秒里没有新声音也没有拖进来的声音、撞击声（低频冲击、门板闷响）在接触那一刻 ± 0.02 秒、落灰的嘶从自己的时刻起', () => {
    const { srcs, end } = run();
    expect(srcs.length).toBeGreaterThan(20);
    expectGraphAligned(srcs, end);
  });

  it('换几个随机种子都一样（颗粒的位置、嘎吱的抖动是随机的，时刻不是）', () => {
    for (const seed of [1, 7, 99, 4242]) {
      const { srcs, end } = run(seed);
      expectGraphAligned(srcs, end);
    }
  });

  it('锁舌咔哒只有噪声颗粒：latch 开头的 0.05 秒里没有任何振荡器起声（没有振荡器就没有音高，不会像「叮」），颗粒轨至少两颗（咔——哒）', () => {
    const { srcs } = run();
    const early = srcs.filter((s) => s.kind === 'osc' && s.start - T0 < WARDROBE.latch[0] + 0.05);
    expect(early).toHaveLength(0);
    const clicks = srcs.filter(isGrains).flatMap(grainOnsets).filter((t) => t < WARDROBE.latch[0] + 0.05);
    expect(clicks.length).toBeGreaterThanOrEqual(2);
  });
});

describe('吱呀跟着开门：先快后慢，停得死', () => {
  it('摩擦脉冲的频率一路往下（开头最快、结束最慢），音量过了最响的地方以后也一路往下，结束时还没降到听不见', () => {
    const [a, b, c] = WARDROBE_SFX.creakSpec.rate;
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
    const shape = WARDROBE_SFX.creakShape;
    expect(shape[0][1]).toBe(0);
    const peak = shape.reduce((m, p) => (p[1] > m[1] ? p : m), shape[0]);
    const after = shape.filter((p) => p[0] > peak[0]);
    expect(after.length).toBeGreaterThan(0);
    for (let i = 1; i < after.length; i++) expect(after[i][1]).toBeLessThan(after[i - 1][1]);
    expect(after[after.length - 1][1]).toBeGreaterThan(0.2);
    // 曲线从头走到 open 时段的最后一刻，不多不少
    expect(shape[shape.length - 1][0]).toBe(1);
  });

  it('收尾那一小段很短（不超过 open 时段的 5%）：门停死的时候吱呀也跟着停死，不是慢慢淡出去（调研：停得不该这么死）', () => {
    expect(WARDROBE_SFX.creakFade).toBeLessThanOrEqual(0.05);
    expect(WARDROBE_SFX.creakFade).toBeGreaterThan(0);
  });
});

describe('时间轴改了，声音跟着走（没有把 WARDROBE 的数抄一份）', () => {
  /** 把整条时间轴拉长 1.5 倍、整体后移 0.25 秒，跑完再还原 */
  function withStretchedTimeline<T>(f: () => T): T {
    const keep = { ...WARDROBE };
    const m = (x: number) => 0.25 + x * 1.5;
    const win = (w: readonly [number, number]) => [m(w[0]), m(w[1])];
    Object.assign(WARDROBE, {
      latch: win(keep.latch),
      open: win(keep.open),
      hold: win(keep.hold),
      fingers: win(keep.fingers),
      slamAt: m(keep.slamAt),
      slamTime: keep.slamTime * 1.5,
      settle: keep.settle * 1.5,
    });
    try {
      return f();
    } finally {
      Object.assign(WARDROBE, keep);
    }
  }

  it('时刻表跟着 WARDROBE 变：拉长、后移以后，各项还是对得上；低频冲击跟着接触那一刻（slamAt + slamTime）走', () => {
    const before = wardrobeCues();
    const after = withStretchedTimeline(() => {
      expectCuesAligned(wardrobeCues());
      return wardrobeCues();
    });
    expect(after.hit).toBeGreaterThan(before.hit + 0.5);
    expect(after.creak[0]).toBeGreaterThan(before.creak[0]);
    expect(after.creak[1] - after.creak[0]).toBeGreaterThan((before.creak[1] - before.creak[0]) * 1.4);
    // 还原之后回到原样
    expect(wardrobeCues()).toEqual(before);
  });

  it('真的跑一遍也跟着变：声源的起止对得上拉长后的 WARDROBE', () => {
    withStretchedTimeline(() => {
      const { srcs, end } = run();
      expectGraphAligned(srcs, end);
    });
  });
});

describe('门关上要多久（slamTime）：撞击声跟着它走，别的时刻不动', () => {
  /** 只改 slamTime，别的时间点都不动，跑完再还原 */
  function withSlamTime<T>(slamTime: number, f: () => T): T {
    const keep = WARDROBE.slamTime;
    WARDROBE.slamTime = slamTime;
    try {
      return f();
    } finally {
      WARDROBE.slamTime = keep;
    }
  }
  const D = 0.28;

  it('时刻表：slamTime 拉长 0.28 秒，闷响、锁舌、低频冲击、抖动、落灰一起后移 0.28 秒；锁舌、推一下、吱呀一动不动', () => {
    const before = wardrobeCues();
    const after = withSlamTime(WARDROBE.slamTime + D, () => {
      const c = wardrobeCues();
      // 最要紧的先看：撞击声（闷响、锁舌、低频冲击）整整后移了 D。音频不读 slamTime 的话，这里就是 0
      for (const k of ['thud', 'slamLatch', 'hit'] as const) expect(c[k] - before[k]).toBeCloseTo(D, 9);
      expectCuesAligned(c);
      return c;
    });
    expect(after.rattle[0] - before.rattle[0]).toBeCloseTo(D, 9);
    expect(after.rattle[1] - before.rattle[1]).toBeCloseTo(D, 9);
    expect(after.dust[0] - before.dust[0]).toBeCloseTo(D, 9);
    expect(after.latch).toBe(before.latch);
    expect(after.push).toBe(before.push);
    expect(after.creak).toEqual(before.creak);
    // 还原之后回到原样
    expect(wardrobeCues()).toEqual(before);
  });

  it('真的跑一遍也跟着后移：braam 的锯齿波、门板那根 92 Hz 正弦都比原来晚 0.28 秒起', () => {
    const start = (srcs: Src[]) => ({
      saw: Math.min(...srcs.filter((s) => s.kind === 'osc' && s.type === 'sawtooth').map((s) => s.start)),
      board: srcs.filter((s) => s.kind === 'osc' && s.type === 'sine' && s.freq === WARDROBE_SFX.slam.thudHz[0])[0].start,
    });
    const before = start(run().srcs);
    withSlamTime(WARDROBE.slamTime + D, () => {
      const r = run();
      const after = start(r.srcs);
      expect(after.saw - before.saw).toBeCloseTo(D, 9);
      expect(after.board - before.board).toBeCloseTo(D, 9);
      expectGraphAligned(r.srcs, r.end);
    });
  });

  it('slamTime 缩到 0（门一下子合上）：撞击声回到 slamAt', () => {
    const c = withSlamTime(0, () => wardrobeCues());
    expect(c.hit).toBeCloseTo(WARDROBE.slamAt, 9);
    expect(c.thud).toBeCloseTo(WARDROBE.slamAt, 9);
  });
});

describe('落灰的上限：不晚于撞上之后 settle 秒（和画面的落灰同一个起点）', () => {
  it('settle 缩短（比落灰自己的长度还短）以后，落灰跟着提前收，时刻表照样对得上', () => {
    const keep = WARDROBE.settle;
    WARDROBE.settle = 1.5;
    try {
      const c = wardrobeCues();
      expect(c.dust[1]).toBeCloseTo(shutAt() + 1.5, 9);
      expect(c.dust[1]).toBeGreaterThan(c.dust[0]);
      expectCuesAligned(c);
    } finally {
      WARDROBE.settle = keep;
    }
  });
});

describe('衣柜的低频冲击和音量档', () => {
  it('衣柜有自己的声音，不再借厨房门的：TRIGGER.wardrobe 就是 wardrobe', () => {
    expect(TRIGGER.wardrobe).toBe(wardrobe);
    expect(TRIGGER.wardrobe).not.toBe(door);
  });

  it('低频冲击和床的 BED_HIT 一个分量：峰值、时长、各层的量都在 BED_HIT 的 ±25% 以内，音量档同样是 −9 dB', () => {
    const near = (a: number, b: number) => Math.abs(a / b - 1) <= 0.25;
    expect(near(WARDROBE_HIT.amp, BED_HIT.amp)).toBe(true);
    expect(near(WARDROBE_HIT.dur, BED_HIT.dur)).toBe(true);
    expect(near(WARDROBE_HIT.sub, BED_HIT.sub)).toBe(true);
    expect(near(WARDROBE_HIT.rumble, BED_HIT.rumble)).toBe(true);
    expect(LEVEL.wardrobeHit).toBe(LEVEL.bedHit);
  });

  it('比现身落下的低频冲击轻（现身 −8 dB、包络 0.6 倍）：总量不超过 MANIFEST_HIT', () => {
    const weight = (b: { amp: number; sub: number; voices: [number, number][] }) => b.amp * Math.sqrt(b.voices.reduce((a, [, g]) => a + g * g, 0)) + b.sub;
    expect(LEVEL.wardrobeHit).toBeLessThanOrEqual(LEVEL.manifestHit);
    expect(weight(WARDROBE_HIT)).toBeLessThanOrEqual(weight(MANIFEST_HIT) + EPS);
  });

  it('低频冲击是 D 一带的锯齿波：最低一层是 D1，上面有 D2；要是加了 E♭2，和 D2 差一个半音（小二度），不是别的音程', () => {
    const hz = WARDROBE_HIT.voices.map(([f]) => f).sort((a, b) => a - b);
    expect(hz[0]).toBeCloseTo(36.71, 2);
    expect(hz).toContain(73.42);
    for (const f of hz) {
      const semis = 12 * Math.log2(f / 36.71);
      // D 的八度（0、12 个半音）或比 D 高一个半音再高八度（13）
      expect([0, 12, 13].some((s) => Math.abs(semis - s) < 0.05)).toBe(true);
    }
  });

  it('锁舌咔哒不会像「叮」：低通截止在 2.5 kHz 以下、Q 不高（没有共鸣，没有音高）', () => {
    const K = WARDROBE_SFX.click;
    expect(Math.max(...K.lp)).toBeLessThanOrEqual(2500);
    expect(K.q).toBeLessThanOrEqual(1);
  });
});
