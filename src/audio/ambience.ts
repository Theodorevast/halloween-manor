// 环境层（unlock 之后一直在）：D1 / D2 正弦持续音 + 低通噪声的风，压得很低；平均恐惧值越高，持续音略微变响、
// 加进上方小二度 E♭；每 20–50 秒随机一声木头嘎吱（别的房间的地板、房梁）。
//
// 配方
//   持续音：D1 36.71 Hz + D2 两个正弦（73.42 / 73.72 Hz，差 0.3 Hz，慢慢「呼吸」）+ 很轻的 D3 146.83 Hz
//     （D1 / D2 在笔记本小喇叭上几乎放不出来，D3 让它隐约还在）；各自有 0.03–0.07 Hz 的慢速起伏，不做任何快速开关
//   风：两路白噪声（回放速率不同，听不出 4 秒一循环）→ 低通 380 Hz，截止频率和音量被几个很慢的正弦推着走（阵风）；
//     再加一丝带通 560 Hz（Q 7）的呜咽，中心频率也慢慢漂
//   恐惧 dread 0..1：持续音 +0..+2.5 dB，风 +0..+2 dB；上方小二度 E♭2 77.78 Hz（+ 三成的 E♭3）从 dread 0.3 起才进来，
//     和 D2 打出 4.4 Hz 的拍（「不对劲」的粗糙感），它自己还有 0.05 Hz 的呼吸，不会一直顶在最响
//   dread 怎么算（dreadTarget，engine.ts 每帧调）：恐惧回落改慢（0.75/秒）以后，平均恐惧值经常停在 60–80，直接用它
//     会让环境层常年最响。所以只有一部分来自平均恐惧（曲线压着：35 以下为 0，100 才到满，且只占 0.6），另一部分来自
//     「最近被吓」的紧张度（startle / heard / flee 时加一点，12 秒时间常数衰减）。玩家停手，环境层会自己退回去；
//     逃跑中的人不算进平均（吓跑之后是一次「释放」）
//   嘎吱：sfx.ts 的 creak，比摇椅低沉的地板声（330 / 820 / 1700 Hz 共鸣），0.5–1 秒，大部分进混响（听起来在别的房间）；
//     三成概率换成两下闷闷的木头轻响（房子在沉降）
//   第三人称（3D 启用后）：整层 +2 dB（用户要更多氛围；只抬一点，持续音和风不能盖住脚步声）；嘎吱改成每 14–38 秒一次，
//     放在听者周围 3–9 米的随机一点（屋里），六成在地板上、四成在头顶的房梁 —— 隔墙的会被遮挡闷住，真的像别的房间在响；
//     因为离得远、常常隔着墙，3D 的嘎吱比俯视时响 3 dB
//   一夜的收尾（2026-10-30）：整层电平（setLevel）在收夜的静、光收回那几秒里慢慢压到很低，Keep haunting 时回来；
//     压低的时候不再安排嘎吱（房子也静下来：嘎吱各自是一个声音，走的是 amb 总线和混响，不经过这一级）。不新加声音
import { HOUSE_D, HOUSE_W } from '../config/house';
import { Snd, bandNoise, creak, knock, rand, type Bus, type CreakSpec } from './sfx';
import type { Place, Vec3 } from './space';

export const AMB = {
  /** 总音量（dB） */
  level: 0,
  /** 淡入秒数（开场点击之后） */
  fadeIn: 6,
  d1: 0.016,
  d2: 0.008,
  d3: 0.0022,
  /** 上方小二度 E♭2 在 dread = 1 时的音量；E♭3 相对它的比例 */
  upper: 0.009,
  upperOct: 0.3,
  /** dread 1 时持续音、风各加多少 dB */
  droneBoost: 2.5,
  windBoost: 2,
  /** 风（低通噪声）和呜咽的音量（大致是 RMS） */
  wind: 0.004,
  howl: 0.0012,
  windLp: 380,
  /** 木头嘎吱：间隔范围（秒）、音量、送混响 */
  creakEvery: [20, 50] as [number, number],
  creak: 0.08,
  creakWet: 0.7,
  floor: { rate: [34, 30, 24], res: [[330, 6, 1], [820, 8, 0.75], [1700, 7, 0.35]], grit: 0.5 } as CreakSpec,
  /** 第三人称：整层抬多少 dB、嘎吱间隔、嘎吱多响多少 dB、放在离听者多远（米） */
  presence3d: 2,
  creakEvery3d: [14, 38] as [number, number],
  creak3d: 3,
  creakDist: [3, 9] as [number, number],
  /** 整层电平（setLevel）低于这个（线性增益）就不安排嘎吱 */
  hushBelow: 0.5,
};

export const DREAD = {
  /** 平均恐惧值映射：fearLo 以下为 0，fearHi 才到满；占 dread 的 fearWeight */
  fearLo: 35,
  fearHi: 100,
  fearWeight: 0.6,
  /** 紧张度占的比例、衰减时间常数（秒）、上限 */
  tensionWeight: 0.5,
  tensionTau: 12,
  tensionMax: 1.2,
  /** 各事件给紧张度加多少（chill = 真的放出了一声发毛；后颈一凉不另外加，跟着它的 startle 已经加过） */
  bump: { startle: 0.22, scream: 0.12, heard: 0.06, flee: 0.45, chill: 0.03 },
  /** dread 自己的平滑：涨得快、退得慢（秒） */
  up: 2.5,
  down: 9,
  /** 上方小二度从多少 dread 开始进来 */
  upperFrom: 0.3,
};

const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};

/** 平均恐惧值（0–100）+ 紧张度 → 环境层的 dread 目标值 0..1 */
export function dreadTarget(avgFear: number, tension: number): number {
  return Math.min(1, DREAD.fearWeight * smooth(DREAD.fearLo, DREAD.fearHi, avgFear) + DREAD.tensionWeight * Math.min(tension, DREAD.tensionMax));
}

export interface Ambience {
  /** 从 t 开始淡入（AudioContext 时间） */
  start(t: number, fadeIn?: number): void;
  /** dread 0..1（已经平滑过；这里再用 0.4 秒时间常数抹平参数跳变） */
  setDread(d: number, t: number): void;
  /** 每帧调：到点就安排下一声嘎吱 */
  update(now: number): void;
  /** 立刻安排一声嘎吱（测量用）。at 不给就随机：3D 时是听者周围的一点，否则是随机声像 */
  creak(t: number, at?: Place, settle?: boolean): void;
  /** 第三人称的整层增益（dB）和嘎吱节奏：engine.ts 在 3D 启用时调一次 */
  setPresence(db: number, t: number): void;
  /**
   * 整层电平（2026-10-30「一夜」：收夜时慢慢压下去，Keep haunting 时回来）：level 是线性增益（1 = 原样），从 t 开始按
   * tau 秒的时间常数走过去（约 3 tau 走完；tau ≤ 0 立刻）。低于 AMB.hushBelow 时不再安排嘎吱
   */
  setLevel(level: number, t: number, tau: number): void;
  stop(t: number): void;
}

export function createAmbience(bus: Bus): Ambience {
  const s = new Snd(bus, { to: 'amb', level: AMB.level });
  // 整层电平（一夜的收尾）在第三人称抬升之后、出口之前
  const level = s.gain(1);
  level.connect(s.out);
  const presence = s.gain(1);
  presence.connect(level);
  const master = s.gain(0);
  master.connect(presence);
  let hushed = false;
  let started = false;
  let nextCreak = Infinity;
  let every = AMB.creakEvery;
  let creakDb = 0;
  const lfo = (hz: number, depth: number, target: AudioParam) => s.osc('sine', hz, 0).connect(s.gain(depth)).connect(target);

  // 持续音
  const drone = s.gain(1);
  drone.connect(master);
  const tone = (hz: number, amp: number, breathHz: number, into: AudioNode) => {
    const g = s.gain(amp);
    s.osc('sine', hz, 0).connect(g).connect(into);
    lfo(breathHz, amp * 0.25, g.gain);
  };
  tone(36.71, AMB.d1, 0.043, drone);
  tone(73.42, AMB.d2, 0.061, drone);
  tone(73.72, AMB.d2, 0.029, drone);
  tone(146.83, AMB.d3, 0.071, drone);

  // 上方小二度：dread 控制音量，自己再呼吸
  const upper = s.gain(0);
  upper.connect(master);
  const upperBreath = s.gain(0.75);
  upperBreath.connect(upper);
  lfo(0.05, 0.25, upperBreath.gain);
  s.osc('sine', 77.78, 0).connect(upperBreath);
  s.osc('sine', 155.56, 0).connect(s.gain(AMB.upperOct)).connect(upperBreath);

  // 风
  const windDread = s.gain(1);
  windDread.connect(master);
  const gust = s.gain(1);
  gust.connect(windDread);
  lfo(0.09, 0.35, gust.gain);
  lfo(0.037, 0.25, gust.gain);
  const windLp = s.bq('lowpass', AMB.windLp, 0.6);
  lfo(0.07, 110, windLp.frequency);
  lfo(0.023, 70, windLp.frequency);
  // 两路噪声按低通带宽补偿，合起来大致是 RMS AMB.wind
  const windG = s.gain(AMB.wind * 1.2 * Math.sqrt(bus.ac.sampleRate / 2 / AMB.windLp));
  for (const rate of [1, 0.83]) s.noise(0, undefined, rate).connect(windLp);
  windLp.connect(windG).connect(gust);
  const howl = bandNoise(s, 0, undefined, 'bandpass', 560, 7, (b) => lfo(0.031, 80, b.frequency));
  howl.connect(s.gain(AMB.howl / 0.5)).connect(gust);

  /** 3D：听者周围 3–9 米的随机一点（夹在屋里），六成在地板上、四成在房梁上 */
  const spot = (): Vec3 => {
    const l = bus.space!.listener;
    const a = rand(-Math.PI, Math.PI);
    const r = rand(AMB.creakDist[0], AMB.creakDist[1]);
    const clampTo = (v: number, hi: number) => Math.min(hi - 0.4, Math.max(0.4, v));
    return { x: clampTo(l.x + Math.cos(a) * r, HOUSE_W), y: rand(0, 1) < 0.6 ? 0.05 : 2.35, z: clampTo(l.z + Math.sin(a) * r, HOUSE_D) };
  };
  const placeCreak = (t: number, at?: Place, settle = rand(0, 1) < 0.3) => {
    const where = at ?? (bus.space?.active ? spot() : rand(-0.7, 0.7));
    const c = new Snd(bus, { to: 'amb', at: where, level: AMB.level + creakDb, wet: AMB.creakWet });
    if (settle) {
      knock(c, c.out, t, AMB.creak * 1.2, 160, 0.04, 0.1);
      knock(c, c.out, t + rand(0.12, 0.4), AMB.creak * 0.8, 190, 0.035, 0.1);
      c.end(t + 3);
    } else {
      const j = rand(0.85, 1.15);
      const dur = rand(0.5, 1);
      creak(c, c.out, t, dur, AMB.creak, { ...AMB.floor, rate: [AMB.floor.rate[0] * j, AMB.floor.rate[1] * j, AMB.floor.rate[2] * j] }, 0.15);
      c.end(t + dur + 2.6);
    }
  };

  return {
    start(t, fadeIn = AMB.fadeIn) {
      if (started) return;
      started = true;
      master.gain.setValueAtTime(0, t);
      master.gain.linearRampToValueAtTime(1, t + fadeIn);
      nextCreak = t + rand(every[0], every[1]);
    },
    setPresence(d, t) {
      presence.gain.setTargetAtTime(10 ** (d / 20), t, 1.5);
      every = AMB.creakEvery3d;
      creakDb = AMB.creak3d;
      // 下一声别等俯视模式那么久
      nextCreak = Math.min(nextCreak, t + rand(every[0], every[1]));
    },
    setDread(d, t) {
      const x = Math.min(1, Math.max(0, d));
      drone.gain.setTargetAtTime(10 ** ((AMB.droneBoost * x) / 20), t, 0.4);
      windDread.gain.setTargetAtTime(10 ** ((AMB.windBoost * x) / 20), t, 0.4);
      upper.gain.setTargetAtTime(AMB.upper * smooth(DREAD.upperFrom, 1, x), t, 0.4);
    },
    setLevel(v, t, tau) {
      const x = Math.max(0, v);
      const g = level.gain;
      g.cancelScheduledValues(t);
      if (tau > 0) g.setTargetAtTime(x, t, tau);
      else g.setValueAtTime(x, t);
      hushed = x < AMB.hushBelow;
    },
    update(now) {
      if (!started || now < nextCreak - 0.1) return;
      // 压低了（收夜）：这一声不放，照常排下一声
      if (!hushed) placeCreak(Math.max(now + 0.05, nextCreak));
      nextCreak = Math.max(now, nextCreak) + rand(every[0], every[1]);
    },
    creak(t, at, settle) {
      placeCreak(t, at, settle);
    },
    stop(t) {
      master.gain.setTargetAtTime(0, t, 0.3);
      started = false;
      nextCreak = Infinity;
      s.end(t + 2);
    },
  };
}
