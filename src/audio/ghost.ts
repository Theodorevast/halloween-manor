// 第三人称的鬼魂（2026-10-28 改版）：穿墙那一下的「呼」，飘动时几乎听不见的冷风。engine.ts 每帧用 setGhost 喂进来。
//
// 配方
//   穿墙 wallWhoosh（inWall 从假变真的那一刻；进鬼魂的常驻声道，跟着鬼魂穿过去；约 1.1 秒 + 混响尾巴）
//     低沉的气流：两路不相关的低通噪声，截止 260 → 620 Hz 跟着音量涌起、再落回 240 Hz（起落和音量绑在一起，
//       听起来是「气」，不是往上扫的「嗖」）；0.18 秒涌起、之后约 0.3 秒的时间常数落下
//     + 气声：带通 1.1 kHz（Q 0.8）的噪声，晚 40 毫秒、轻 10 dB，像从牙缝里呼出来的
//     + 压感：D1 36.7 Hz + 半量的 D2 正弦，平滑起落（不做快速开关）；耳机里是「压」一下，小喇叭上没有
//     + 墙里轻轻一声：比地板硬的短嘎吱（600 / 1400 / 2900 Hz 共鸣，摩擦 52 → 40 Hz，0.24 秒，很轻）
//       + 8 个 2–5 kHz 的灰泥碎屑颗粒，0.45 秒内越来越稀、越来越轻
//     0.9 秒内不重复：贴着墙飘、在墙边进进出出时不会连着「呼」。开场前（setGhost 还是 null）或第一次就在墙里，都不出声
//   冷风 air：鬼魂动起来才有，水平速度 0.3 → 2.2 米/秒从无到满（0.4 秒平滑）；满的时候每个声道也只有 RMS 约 -56 dBFS，
//     比环境层的风还低 6 dB（几乎听不见：耳机里只听得出「一动起来身边多了一点风」，停下就没了）。左右两路不相关的带通噪声（650 Hz，Q 0.6，中心频率慢慢漂），
//     不定位：风是包在身边的，定位到鬼魂身上反而像前面有个东西在嘶嘶响。决定保留它，但压得很低；嫌多余就把 GHOST.air 设 0
import type { GhostState } from '../engine/types';
import { Snd, bandNoise, creak, playGrains, rand, type Bus, type CreakSpec, type Grain } from './sfx';
import type { Place, Port } from './space';

export const WHOOSH = {
  /** 总音量（dB） */
  level: 0,
  /** 气流：峰值、低通起点 / 最高 / 落点（赫兹）、涌起秒数、落下的时间常数 */
  air: 0.065,
  lp: [260, 620, 240] as const,
  rise: 0.18,
  fall: 0.3,
  /** 气声（相对气流）、压感正弦 */
  breath: 0.32,
  press: 0.035,
  /** 墙里的嘎吱和灰泥 */
  creak: 0.05,
  creakSpec: { rate: [52, 46, 40], res: [[600, 7, 1], [1400, 8, 0.6], [2900, 7, 0.3]], grit: 0.6 } as CreakSpec,
  dust: 0.12,
  wet: 0.3,
  /** 多久之内不重复（秒） */
  gap: 0.9,
};

export const GHOST = {
  /** 冷风满速时每个声道的 RMS（线性）；0 = 不要冷风 */
  air: 0.00095,
  /** 速度从多少开始有、多少到满（米/秒）、平滑时间常数（秒） */
  airFrom: 0.3,
  airFull: 2.2,
  airTau: 0.4,
  airHz: 650,
};

/** 穿墙的「呼」。at 通常是鬼魂的常驻声道。返回节点全部断开的时刻 */
export function wallWhoosh(bus: Bus, t: number, at: Place): number {
  const W = WHOOSH;
  const s = new Snd(bus, { at, level: W.level, wet: W.wet });
  const dur = W.rise + W.fall * 6;

  // 低沉的气流：截止频率跟着音量起落
  const air = s.gain(0);
  // 两路随机起点的噪声（不相关），合起来不会听出 4 秒一循环
  for (let k = 0; k < 2; k++) {
    bandNoise(s, t, t + dur, 'lowpass', W.lp[1], 0.7, (b) => {
      b.frequency.setValueAtTime(W.lp[0], t);
      b.frequency.linearRampToValueAtTime(W.lp[1], t + W.rise);
      b.frequency.setTargetAtTime(W.lp[2], t + W.rise, W.fall);
    }).connect(s.gain(Math.SQRT1_2)).connect(air);
  }
  air.connect(s.out);
  air.gain.setValueAtTime(0, t);
  air.gain.linearRampToValueAtTime(W.air, t + W.rise);
  air.gain.setTargetAtTime(0, t + W.rise, W.fall);

  // 气声：晚一点、轻一点
  const br = s.gain(0);
  bandNoise(s, t, t + dur, 'bandpass', 1100, 0.8).connect(br).connect(s.out);
  br.gain.setValueAtTime(0, t + 0.04);
  br.gain.linearRampToValueAtTime(W.air * W.breath, t + 0.04 + W.rise);
  br.gain.setTargetAtTime(0, t + 0.04 + W.rise, W.fall * 0.8);

  // 压感：很低的正弦，平滑起落
  const pr = s.gain(0);
  for (const [f, a] of [[36.71, 1], [73.42, 0.5]] as const) s.osc('sine', f, t, t + dur).connect(s.gain(a)).connect(pr);
  pr.connect(s.out);
  pr.gain.setValueAtTime(0, t);
  pr.gain.linearRampToValueAtTime(W.press, t + W.rise + 0.06);
  pr.gain.setTargetAtTime(0, t + W.rise + 0.06, W.fall * 0.9);

  // 墙里：短嘎吱 + 灰泥碎屑
  creak(s, s.out, t + 0.05, 0.24, W.creak, W.creakSpec, 0.03);
  const dust: Grain[] = [];
  for (let i = 0, at2 = 0.06; i < 8; i++) {
    dust.push({ t: at2, len: rand(0.0008, 0.003), amp: W.dust * Math.exp(-at2 / 0.2) * rand(0.5, 1) });
    at2 += rand(0.02, 0.06) * (1 + i * 0.15);
  }
  playGrains(s, t, dust, s.out, 1, s.bq('bandpass', 3200, 0.9));
  return s.end(t + dur + 2.2);
}

export interface GhostSound {
  /** 每帧喂鬼魂的状态（null = 没有鬼魂）；now = 声音安排在哪个时刻 */
  set(g: GhostState | null, now: number): void;
}

export function createGhostSound(bus: Bus): GhostSound {
  const ac = bus.ac;
  let port: Port | null = null;
  let prevIn: boolean | null = null;
  let lastWhoosh = -1e9;
  let air: GainNode | null = null;
  let airTarget = 0;

  /** 冷风：左右两路不相关的带通噪声，第一次有鬼魂时才建 */
  const buildAir = () => {
    const g = new GainNode(ac, { gain: 0 });
    const merge = new ChannelMergerNode(ac, { numberOfInputs: 2 });
    for (let ch = 0; ch < 2; ch++) {
      const src = new AudioBufferSourceNode(ac, { buffer: bus.noise, loop: true, playbackRate: ch ? 0.93 : 1 });
      const bp = new BiquadFilterNode(ac, { type: 'bandpass', frequency: GHOST.airHz, Q: 0.6 });
      const lfo = new OscillatorNode(ac, { frequency: ch ? 0.13 : 0.11 });
      lfo.connect(new GainNode(ac, { gain: 150 })).connect(bp.frequency);
      // 和 sfx.ts 的 bandNoise 一样按带宽补偿：滤完大致是 RMS 0.5
      const comp = 0.87 * Math.sqrt(ac.sampleRate / 2 / (GHOST.airHz / 0.6));
      src.connect(bp).connect(new GainNode(ac, { gain: comp })).connect(merge, 0, ch);
      src.start(ac.currentTime, rand(0, bus.noise.duration * 0.9));
      lfo.start();
    }
    merge.connect(g).connect(bus.sfx);
    return g;
  };

  return {
    set(g, now) {
      if (!g || !Number.isFinite(g.x) || !Number.isFinite(g.z)) {
        prevIn = null;
        if (air && airTarget !== 0) air.gain.setTargetAtTime((airTarget = 0), now, GHOST.airTau);
        return;
      }
      const space = bus.space;
      if (space?.active) {
        port ??= space.port({ x: g.x, y: g.y, z: g.z }, bus.sfx);
        port.move(g.x, g.y, g.z);
      }
      // 穿墙：从不在墙里变成在墙里的那一刻
      if (g.inWall && prevIn === false && now - lastWhoosh > WHOOSH.gap) {
        lastWhoosh = now;
        wallWhoosh(bus, now, port && space?.active ? port : 0);
      }
      prevIn = g.inWall;
      // 冷风：跟着速度，变化够大才写参数
      if (GHOST.air > 0) {
        air ??= buildAir();
        const u = Math.min(1, Math.max(0, (g.speed - GHOST.airFrom) / (GHOST.airFull - GHOST.airFrom)));
        const target = (GHOST.air / 0.5) * u * u * (3 - 2 * u);
        const moved = Math.abs(target - airTarget) > 0.05 * (GHOST.air / 0.5) || (target === 0 && airTarget !== 0);
        if (moved) air.gain.setTargetAtTime((airTarget = target), now, GHOST.airTau);
      }
    },
  };
}
