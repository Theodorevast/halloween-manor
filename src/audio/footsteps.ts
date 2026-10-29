// 访客的脚步声（第三人称改版：黑暗里靠声音找人），以及「每个访客一个跟着走的声道」。只在 3D 启用后（setListener）才有。
//
// 声道：每个访客一个常驻的 Port（space.ts：HRTF + 隔墙遮挡），每帧挪到他的位置（离地 0.6 米）。他的脚步、尖叫、吸气、
//   发毛都从这里出来，所以逃跑时的尖叫跟着人跑，不会留在原地。最多 FOOT.voices 个（屋里通常 3 个人）：多出来的人没有
//   脚步声，尖叫照旧在他开始叫的地方定位。人离开 2.5 秒后（尾巴放完）声道收回，给下一个进门的人用
// 步点：按访客这一帧实际走过的距离累加，满一步长就落一步。步长随速度变长：stride = 0.45 + 0.19 × 速度（米），
//   走 1.3 米/秒 ≈ 1.9 步/秒、紧张 1.7 → 2.2、警觉 1.1 → 1.7、逃跑 3.2 → 3.0 步/秒（成年人慢慢走的步频，不是小碎步：
//   小碎步一听就卡通）。站定后再起步，第一步来得快一点。每步先脚跟、再脚掌，间隔 0.11 − 0.024 × 速度（逃跑时几乎连在一起）
// 地面（config/house.ts 的房间和地毯）：厨房、浴室是瓷砖；门厅的地毯、走廊的长地毯上是闷的；门外门廊是石头；其余木地板。
//   木地板（包括地毯下面）有固定的几块「响板」（按格子哈希，约 12% 的格子），踩上去吱一声，每块板的声音也固定 ——
//   和真的老房子一样，总是那几个地方响；同一个人在同一块板上 1.5 秒内不重复，同时最多 2 声
// 样本：3D 启用后在下一个宏任务里现算（JS 里直接算采样，约 6 毫秒），每种地面 4 个脚跟 + 4 个脚掌；每一步随机挑一个、
//   回放速率 ±4%、音量 ±1 dB，听不出重复。每步只建 2 个 BufferSource + 3 个 Gain，PannerNode 一直复用
//   各成分按能量配比（dB），样本按能量归一化（50 毫秒 RMS = 1），音量只由 FOOT.heel 和各地面的 dB 决定
//   木地板 脚跟：半正弦「压下去」（6–9 毫秒）过 95–130 Hz 共鸣（地板和龙骨的闷「咚」）+ 一点它本身的低通（踩的「推」）
//     + 撞击噪声（3–5 毫秒衰减）过 280–380 Hz、700–950 Hz 两个低 Q 共鸣（板子）+ 一点 3 kHz 以下的鞋底「嗒」
//   木地板 脚掌：同一套更轻、更短，加一点 1.2–2.5 kHz 的鞋底摩擦
//   瓷砖 脚跟：更硬更干：撞击噪声 1.2–2 毫秒衰减，过 2.1–2.9 kHz（Q 2.5，Q 低就不会像「叮」）+ 700 Hz 以上的宽带
//     + 一点 4–5 kHz + 170–230 Hz 的闷底（瓷砖下面是实心的，没有木地板那种「咚」）；脚掌：轻一点的「嗒」+ 3 kHz 以上的砂砾
//   地毯：木地板样本过两次 800 Hz 低通、-4 dB（走廊整条都铺着长地毯，是访客来回走得最多的地方，不能闷到听不见）；
//     地毯下面的木地板照样会吱（轻 4 dB）。门廊石头：瓷砖样本放慢到 0.85 倍（更闷）、-5 dB
//   逃跑：脚跟 +4 dB、脚掌轻一点；紧张（恐惧 ≥ 60，缩着走）：-2.5 dB
// 音量：在 PannerNode 的距离模型之外，脚步自己再加一层距离衰减 (2.5 / d)^0.5（10 米再少 6 dB）：近处的人听得清楚，
//   远处的若有若无；隔墙的交给遮挡。离听者 18 米以外不出声。混响送：木地板 0.2、瓷砖 0.35（瓷砖房间更「响」）、地毯 0.1
import { CELL, FURNITURE, HOUSE_D, HOUSE_W, roomAt, type Rect } from '../config/house';
import type { NpcState } from '../sim/types';
import { Snd, creak, db, rand, rng, type Bus, type CreakSpec } from './sfx';
import type { Port } from './space';

export type Surface = 'wood' | 'tile' | 'rug' | 'stone';

export const FOOT = {
  /** 总音量（dB）。用户觉得脚步太响、太轻先改这里 */
  level: 0,
  /** 各种地面相对的音量（dB） */
  surface: { wood: 0, tile: -4, rug: -4, stone: -5 } as Record<Surface, number>,
  /** 混响送 */
  wet: { wood: 0.2, tile: 0.35, rug: 0.1, stone: 0.25 } as Record<Surface, number>,
  /** 一步脚跟在 50 毫秒里的 RMS（线性，样本按能量归一化过）；脚掌相对脚跟 */
  heel: 0.025,
  toe: 0.5,
  /** 步长 = stride[0] + stride[1] × 速度（米）；脚跟到脚掌的间隔 = gap[0] − gap[1] × 速度（秒），夹在 gapMin..gapMax */
  stride: [0.45, 0.19] as [number, number],
  gap: [0.11, 0.024] as [number, number],
  gapMin: 0.03,
  gapMax: 0.1,
  /** 速度超过这个（米/秒）或者在逃跑，就是跑 */
  runFrom: 2.4,
  runDb: 4,
  nervousDb: -2.5,
  /** 额外的距离衰减：(near / d)^law */
  near: 2.5,
  law: 0.5,
  /** 多远以外不出声（米） */
  maxDist: 18,
  /** 常驻声道最多几个；人离开多久后收回（秒）；声道离地高度（米） */
  voices: 4,
  release: 2.5,
  voiceY: 0.6,
  /** 响板：千分之几的木地板格子；嘎吱的音量（线性）、送混响、同一块板多久不重复（秒）、同时最多几声 */
  creaky: 120,
  creak: 0.07,
  creakWet: 0.3,
  creakGap: 1.5,
  creakMax: 2,
  /** 地板嘎吱的基本音色（每块板再按哈希偏一点） */
  board: { rate: [36, 31, 26], res: [[300, 6, 1], [760, 8, 0.7], [1650, 7, 0.3]], grit: 0.55 } as CreakSpec,
};

// ── 样本 ──────────────────────────────────────────────────────────────────

type Kind = 'lp' | 'hp' | 'bp';

/** RBJ 双二阶滤波（带通是峰值 0 dB 的那种）；q 是普通的 Q（不是 Web Audio 低通那种分贝） */
function biquad(x: Float32Array, kind: Kind, f: number, q: number, sr: number): Float32Array {
  const w = (2 * Math.PI * Math.min(f, sr * 0.45)) / sr;
  const c = Math.cos(w);
  const a = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (kind === 'lp') [b0, b1, b2] = [(1 - c) / 2, 1 - c, (1 - c) / 2];
  else if (kind === 'hp') [b0, b1, b2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  else [b0, b1, b2] = [a, 0, -a];
  const a0 = 1 + a;
  const a1 = -2 * c;
  const a2 = 1 - a;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

/** 半正弦「压下去」：长 len 秒 */
function press(n: number, sr: number, len: number): Float32Array {
  const x = new Float32Array(n);
  const m = Math.max(2, Math.round(len * sr));
  for (let i = 0; i < m && i < n; i++) x[i] = Math.sin((Math.PI * i) / m);
  return x;
}

/** 撞击噪声：attack 秒线性起、tau 秒指数衰减 */
function burst(n: number, sr: number, attack: number, tau: number, amp = 1): Float32Array {
  const x = new Float32Array(n);
  const a = Math.max(1, attack * sr);
  for (let i = 0; i < n; i++) x[i] = (rng.next() * 2 - 1) * amp * Math.min(1, i / a) * Math.exp(-i / (tau * sr));
  return x;
}

/** 摩擦 / 砂砾：带包络的噪声，grainy = 每毫秒随机开关一次（砂砾的颗粒感） */
function scuff(n: number, sr: number, at: number, attack: number, tau: number, grainy = false): Float32Array {
  const x = new Float32Array(n);
  const i0 = Math.round(at * sr);
  const blk = Math.max(1, Math.round(0.001 * sr));
  let on = 1;
  for (let i = i0; i < n; i++) {
    const k = i - i0;
    if (grainy && k % blk === 0) on = rng.next() < 0.45 ? rng.next() : 0;
    x[i] = (rng.next() * 2 - 1) * on * Math.min(1, k / (attack * sr)) * Math.exp(-k / (tau * sr));
  }
  return x;
}

/** 按能量混：x 先归一化到单位能量，再乘 10^(dB/20)。各成分的「占比」因此直接就是 dB，和滤波器的带宽无关 */
function mix(out: Float32Array, x: Float32Array, dB: number) {
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  if (!(e > 0)) return;
  const g = 10 ** (dB / 20) / Math.sqrt(e);
  for (let i = 0; i < out.length; i++) out[i] += x[i] * g;
}

/** 收尾淡出；按能量归一化：50 毫秒窗里的 RMS = 1（所以 FOOT.heel 就是一步脚跟在 50 毫秒里的 RMS） */
function finish(x: Float32Array, sr: number): Float32Array {
  const f = Math.round(0.01 * sr);
  for (let i = 0; i < f; i++) x[x.length - 1 - i] *= i / f;
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i] * x[i];
  if (e > 0) {
    const g = Math.sqrt((0.05 * sr) / e);
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
  return x;
}

// 各成分后面的数字是能量占比（dB）：木地板以板子的中频（300 Hz、800 Hz）为主，脚跟的闷「咚」只占一小份；
// 瓷砖以 2–3 kHz 的「嗒」为主。目标质心：木地板脚跟约 400–700 Hz，瓷砖约 2–3 kHz（dev 页面的 step 几行量 cent）
function woodHeel(sr: number): Float32Array {
  const n = Math.round(0.15 * sr);
  const p = press(n, sr, rand(0.006, 0.009));
  const h = burst(n, sr, 0.0004, rand(0.003, 0.005));
  const out = new Float32Array(n);
  mix(out, biquad(p, 'bp', rand(95, 130), 2, sr), -9);
  mix(out, biquad(p, 'lp', 400, 0.7, sr), -15);
  mix(out, biquad(h, 'bp', rand(280, 380), 6, sr), -3);
  mix(out, biquad(h, 'bp', rand(700, 950), 4, sr), -6);
  mix(out, biquad(h, 'bp', rand(1800, 2600), 1.2, sr), -14);
  mix(out, biquad(h, 'hp', 3500, 0.7, sr), -24);
  return finish(out, sr);
}

function woodToe(sr: number): Float32Array {
  const n = Math.round(0.12 * sr);
  const p = press(n, sr, rand(0.004, 0.006));
  const h = burst(n, sr, 0.0008, rand(0.002, 0.0035));
  const out = new Float32Array(n);
  mix(out, biquad(p, 'bp', rand(120, 160), 2, sr), -13);
  mix(out, biquad(h, 'bp', rand(380, 470), 5, sr), -3);
  mix(out, biquad(h, 'bp', rand(950, 1250), 3, sr), -7);
  mix(out, biquad(scuff(n, sr, 0.004, 0.004, 0.022), 'bp', rand(1200, 2500), 1.2, sr), -8);
  return finish(out, sr);
}

function tileHeel(sr: number): Float32Array {
  const n = Math.round(0.1 * sr);
  const p = press(n, sr, rand(0.003, 0.005));
  const h = burst(n, sr, 0.0005, rand(0.0016, 0.0024));
  const out = new Float32Array(n);
  mix(out, biquad(h, 'bp', rand(2100, 2900), 2.5, sr), -2);
  mix(out, biquad(biquad(h, 'hp', 700, 0.7, sr), 'lp', 6000, 0.7, sr), -5);
  mix(out, biquad(h, 'bp', rand(800, 1000), 1.5, sr), -6);
  mix(out, biquad(h, 'bp', rand(4000, 5000), 2, sr), -13);
  mix(out, biquad(p, 'bp', rand(170, 230), 2, sr), -10);
  return finish(biquad(out, 'lp', 7000, 0.7, sr), sr);
}

function tileToe(sr: number): Float32Array {
  const n = Math.round(0.1 * sr);
  const h = burst(n, sr, 0.0004, rand(0.0018, 0.0028));
  const out = new Float32Array(n);
  mix(out, biquad(h, 'bp', rand(2300, 3100), 2.5, sr), -3);
  mix(out, biquad(biquad(h, 'hp', 900, 0.7, sr), 'lp', 5000, 0.7, sr), -7);
  mix(out, biquad(scuff(n, sr, 0.003, 0.002, 0.02, true), 'bp', 3500, 1.2, sr), -8);
  return finish(out, sr);
}

/** 地毯：木地板的样本过两次 800 Hz 低通（24 dB/倍频程），重新归一化 */
const muffle = (x: Float32Array, sr: number) => finish(biquad(biquad(x, 'lp', 800, 0.7, sr), 'lp', 800, 0.7, sr), sr);

interface Bank {
  heel: AudioBuffer[];
  toe: AudioBuffer[];
}

const VARIANTS = 4;

/** 全部地面的样本（同一个 AudioContext 只算一次） */
export function stepBanks(ac: BaseAudioContext): Record<Surface, Bank> {
  const sr = ac.sampleRate;
  const buf = (x: Float32Array) => {
    const b = new AudioBuffer({ numberOfChannels: 1, length: x.length, sampleRate: sr });
    b.getChannelData(0).set(x);
    return b;
  };
  const wood: Bank = { heel: [], toe: [] };
  const tile: Bank = { heel: [], toe: [] };
  const rug: Bank = { heel: [], toe: [] };
  for (let k = 0; k < VARIANTS; k++) {
    const wh = woodHeel(sr);
    const wt = woodToe(sr);
    wood.heel.push(buf(wh));
    wood.toe.push(buf(wt));
    rug.heel.push(buf(muffle(wh, sr)));
    rug.toe.push(buf(muffle(wt, sr)));
    tile.heel.push(buf(tileHeel(sr)));
    tile.toe.push(buf(tileToe(sr)));
  }
  return { wood, tile, rug, stone: tile };
}

// ── 地面、响板 ─────────────────────────────────────────────────────────────

const RUGS: Rect[] = FURNITURE.filter((f) => f.kind === 'rug' || f.kind === 'runner').map((f) => f.rect);

/** 某点脚下是什么地面 */
export function surfaceAt(x: number, z: number): Surface {
  if (x < 0 || z < 0 || x >= HOUSE_W || z >= HOUSE_D) return 'stone';
  const i = Math.floor(x / CELL);
  const j = Math.floor(z / CELL);
  for (const r of RUGS) if (i >= r.x0 && i < r.x1 && j >= r.z0 && j < r.z1) return 'rug';
  const room = roomAt(i, j);
  return room === 'kitchen' || room === 'bathroom' ? 'tile' : 'wood';
}

const hashCell = (i: number, j: number) => (Math.imul(i + 31, 73856093) ^ Math.imul(j + 17, 19349663)) >>> 0;
/** 这一格是不是响板（只看木地板） */
export const creakyAt = (i: number, j: number) => hashCell(i, j) % 1000 < FOOT.creaky;

/** 一块响板固定的声音：摩擦频率、共鸣都按哈希偏一点 */
function boardSpec(i: number, j: number): CreakSpec {
  const h = hashCell(j, i);
  const r = 0.85 + ((h % 1000) / 1000) * 0.35;
  const f = 0.9 + (((h >>> 10) % 1000) / 1000) * 0.22;
  const B = FOOT.board;
  return { rate: [B.rate[0] * r, B.rate[1] * r, B.rate[2] * r], res: B.res.map(([hz, q, g]) => [hz * f, q, g] as const), grit: B.grit };
}

// ── 播放 ──────────────────────────────────────────────────────────────────

export interface StepOpts {
  surface: Surface;
  /** 速度（米/秒） */
  speed: number;
  run: boolean;
  nervous: boolean;
  /** 到听者的距离（米），额外的距离衰减用 */
  dist: number;
}

/** 落一步：脚跟 t、脚掌 t + gap，都进 port。banks 是 stepBanks 的结果 */
export function playStep(ac: BaseAudioContext, banks: Record<Surface, Bank>, port: Port, t: number, o: StepOpts) {
  const bank = banks[o.surface];
  const rate = rand(0.96, 1.04) * (o.surface === 'stone' ? 0.85 : 1);
  let k = db(FOOT.level + FOOT.surface[o.surface]) * FOOT.heel * rand(0.89, 1.12);
  if (o.run) k *= db(FOOT.runDb);
  else if (o.nervous) k *= db(FOOT.nervousDb);
  k *= Math.min(1, (FOOT.near / Math.max(o.dist, FOOT.near)) ** FOOT.law);
  const gap = Math.min(FOOT.gapMax, Math.max(FOOT.gapMin, FOOT.gap[0] - FOOT.gap[1] * o.speed));
  const wet = new GainNode(ac, { gain: FOOT.wet[o.surface] });
  wet.connect(port.wet);
  const part = (buffer: AudioBuffer, at: number, amp: number, last: boolean) => {
    const src = new AudioBufferSourceNode(ac, { buffer, playbackRate: rate });
    const g = new GainNode(ac, { gain: amp });
    src.connect(g);
    g.connect(port.in);
    g.connect(wet);
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      if (last) wet.disconnect();
    };
    src.start(at);
  };
  const pick = (a: AudioBuffer[]) => a[Math.floor(rng.next() * a.length) % a.length];
  part(pick(bank.heel), t, k, false);
  part(pick(bank.toe), t + gap * rand(0.9, 1.1), k * FOOT.toe * (o.run ? 0.7 : 1), true);
}

/** 响板吱一声（进访客的声道） */
export function playBoard(bus: Bus, port: Port, t: number, i: number, j: number, heavy: number): number {
  const c = new Snd(bus, { at: port, to: 'voice', wet: FOOT.creakWet });
  const dur = (0.25 + ((hashCell(i, j) >>> 20) % 100) / 500) * (heavy > 1 ? 0.6 : 1);
  creak(c, c.out, t + 0.02, dur, FOOT.creak * Math.min(1.6, heavy), boardSpec(i, j), 0.03);
  return c.end(t + dur + 1.2);
}

// ── 每个访客：声道 + 脚步 ──────────────────────────────────────────────────

export interface Crowd {
  /** 这个访客的声道（没有就分一个，分完了返回 null）。3D 没启用时返回 null */
  voice(n: NpcState): Port | null;
  /** 每帧：挪声道、落脚步、收回离开的人的声道。now = 这一帧的声音安排在哪个时刻 */
  update(npcs: readonly NpcState[], now: number, dt: number): void;
}

interface Voice {
  port: Port;
  owner: number | null;
  /** 主人离开的时刻（还没离开为 null） */
  goneAt: number | null;
}

interface Walker {
  x: number;
  z: number;
  acc: number;
  still: number;
  creakCell: number;
  creakAt: number;
}

const WALKING = new Set(['entering', 'wander', 'alert', 'fleeing', 'leaving']);

/** timed：声道的移动按 now 安排进参数时间线（离线测量：渲染开始前就要把整段走路排好）；实时用不着 */
export function createCrowd(bus: Bus, timed = false): Crowd {
  const ac = bus.ac;
  let clock: number | undefined;
  const voices: Voice[] = [];
  const walkers = new Map<number, Walker>();
  let banks: Record<Surface, Bank> | null = null;
  let baking = false;
  let creakEnds: number[] = [];
  /** 样本约 6 毫秒：3D 一启用就排到下一个宏任务里算，不挤在某一帧里；离线测量（timed）直接算 */
  const bake = () => {
    if (banks || baking) return;
    if (timed) {
      banks = stepBanks(ac);
      return;
    }
    baking = true;
    setTimeout(() => {
      banks ??= stepBanks(ac);
    }, 0);
  };

  const voiceOf = (n: NpcState): Port | null => {
    const space = bus.space;
    if (!space?.active) return null;
    let v = voices.find((x) => x.owner === n.id);
    if (!v) {
      v = voices.find((x) => x.owner === null);
      if (!v && voices.length < FOOT.voices) {
        v = { port: space.port({ x: n.pos.x, y: FOOT.voiceY, z: n.pos.z }, bus.voice), owner: null, goneAt: null };
        voices.push(v);
      }
      if (!v) return null;
      v.owner = n.id;
      v.goneAt = null;
    }
    v.port.move(n.pos.x, FOOT.voiceY, n.pos.z, clock);
    return v.port;
  };

  return {
    voice: voiceOf,

    update(npcs, now, dt) {
      const space = bus.space;
      if (!space?.active) return;
      if (timed) clock = now;
      bake();
      // 收回离开的人的声道
      for (const v of voices) {
        if (v.owner === null) continue;
        if (npcs.some((n) => n.id === v.owner && n.mode !== 'gone')) continue;
        v.goneAt ??= now;
        if (now - v.goneAt > FOOT.release) v.owner = v.goneAt = null;
      }
      for (const v of voices) {
        const n = v.owner === null ? undefined : npcs.find((x) => x.id === v.owner);
        if (n) v.port.move(n.pos.x, FOOT.voiceY, n.pos.z, clock);
      }
      for (const id of walkers.keys()) if (!npcs.some((n) => n.id === id)) walkers.delete(id);

      for (const n of npcs) {
        let w = walkers.get(n.id);
        if (!w) {
          walkers.set(n.id, (w = { x: n.pos.x, z: n.pos.z, acc: 0, still: 1, creakCell: -1, creakAt: -1e9 }));
          continue;
        }
        const d = Math.hypot(n.pos.x - w.x, n.pos.z - w.z);
        w.x = n.pos.x;
        w.z = n.pos.z;
        // 瞬移（调试放人、换声道）不算走路
        if (d > 1 || !WALKING.has(n.mode)) {
          w.still = 1;
          continue;
        }
        const speed = n.speed > 0.05 ? n.speed : dt > 0 ? d / dt : 0;
        const stride = FOOT.stride[0] + FOOT.stride[1] * speed;
        if (d < 1e-4) {
          w.still += dt;
          continue;
        }
        // 站定之后再起步：第一步来得快一点
        if (w.still > 0.35) w.acc = Math.max(w.acc, stride * 0.6);
        w.still = 0;
        w.acc += d;
        if (w.acc < stride) continue;
        w.acc = Math.min(w.acc - stride, stride * 0.5);

        const dist = space.distance(n.pos.x, 0, n.pos.z);
        if (dist > FOOT.maxDist) continue;
        const port = voiceOf(n);
        if (!port || !banks) continue;
        const surface = surfaceAt(n.pos.x, n.pos.z);
        const run = n.mode === 'fleeing' || speed > FOOT.runFrom;
        playStep(ac, banks, port, now, { surface, speed, run, nervous: n.nervous, dist });

        // 响板（地毯下面也有，轻一点）
        if (surface !== 'wood' && surface !== 'rug') continue;
        const i = Math.floor(n.pos.x / CELL);
        const j = Math.floor(n.pos.z / CELL);
        if (!creakyAt(i, j)) continue;
        const cell = j * 1000 + i;
        if (cell === w.creakCell && now - w.creakAt < FOOT.creakGap) continue;
        creakEnds = creakEnds.filter((e) => e > now);
        if (creakEnds.length >= FOOT.creakMax) continue;
        w.creakCell = cell;
        w.creakAt = now;
        creakEnds.push(playBoard(bus, port, now, i, j, (run ? 1.5 : 1) * (surface === 'rug' ? 0.63 : 1)) - 1);
      }
    },
  };
}
