// 访客的声音：尖叫、倒吸一口气（设计文档 4. 声音 /「尖叫」）。共振峰合成，不用录音。
//
// 配方
//   尖叫（startle 且 scream 为真；吓跑时那一声更长）：卡通式的短促「啊——！」，约 0.8 秒
//     声源：锯齿波 f0。音高 = 性格基准（timid 620 / average 470 / brave 360 Hz）× 按 npc id 散开的 ±2 个半音（不按音阶取，
//       就是「每个人嗓子不一样」）。音高轮廓：50 毫秒内从 0.9·f0 冲到 f0（起声，不是滑音）→ 微微抬到 1.03·f0 → 结尾掉到 0.8·f0
//     颤音：0.18 秒内长出来（timid 更深更快：75 音分 / 7.2 Hz），再叠一点低通 16 Hz 噪声的随机抖动
//     粗糙感：f0/2 的调幅（次谐波），brave 最粗（像吼），timid 最干净（像尖叫）
//     共振峰：/a/ 元音的四个带通（1000 / 1500 / 2900 / 3900 Hz），开头偏「诶」（F1 低、F2 高），结尾滑向「噢」（F2 降）；
//       timid 整组 × 1.13（声道短 → 更尖），brave × 0.9；加一点经过同一组共振峰的气声，结尾变多（嗓子破了）
//     包络：25 毫秒起音，结尾 30% 指数收掉；送一点混响（在屋里）
//     起声比事件晚 SCREAM.delay：角色先压扁 0.1 秒再跳，尖叫落在跳起那一下
//   吸气（startle 但没有尖叫）：带通噪声（1300 / 2700 Hz，共振峰微微上移）指数渐强 0.2 秒后突然停住 —— 吸气的形状；
//     被别人的尖叫吓到（object 为 null）的最轻，被物件吓到但不够尖叫（brave、习惯化）的稍重
import type { Personality } from '../sim/types';
import { Snd, bandNoise, type Bus } from './sfx';

export const SCREAM = {
  /** 总音量（dB） */
  level: 0,
  f0: { timid: 620, average: 470, brave: 360 } as Record<Personality, number>,
  /** 按 id 散开的范围（半音） */
  spread: 2,
  dur: { timid: 0.9, average: 0.8, brave: 0.65 } as Record<Personality, number>,
  /** 共振峰整体缩放：timid 声道短（更尖），brave 声道长 */
  formant: { timid: 1.13, average: 1.0, brave: 0.9 } as Record<Personality, number>,
  vibrato: { timid: 75, average: 50, brave: 35 } as Record<Personality, number>,
  vibRate: { timid: 7.2, average: 6.4, brave: 5.8 } as Record<Personality, number>,
  rough: { timid: 0.12, average: 0.2, brave: 0.32 } as Record<Personality, number>,
  /** 随机音高抖动（音分） */
  jitter: 1500,
  amp: 1.1,
  wet: 0.22,
  /** 起声比 startle 事件晚多少秒（对上角色跳起） */
  delay: 0.07,
};

/** [频率, Q, 音量]：/a/ 元音尖叫 */
const FORMANTS: [number, number, number][] = [
  [1000, 5, 1.0],
  [1500, 7, 0.65],
  [2900, 9, 0.4],
  [3900, 11, 0.22],
];

export const GASP = {
  soft: 0.07,
  strong: 0.14,
  dur: 0.21,
  formant: { timid: 1.15, average: 1.0, brave: 0.88 } as Record<Personality, number>,
};

/** 按 id 散开的音高偏移（半音，-spread..spread） */
function idOffset(id: number): number {
  const h = (Math.imul(id + 1, 2654435761) >>> 0) % 1000;
  return (h / 999) * 2 * SCREAM.spread - SCREAM.spread;
}

export interface VoiceOpts {
  id: number;
  personality: Personality;
  pan: number;
}

/** 尖叫。dur 不给就按性格；返回节点全部断开的时刻 */
export function scream(bus: Bus, t: number, o: VoiceOpts & { dur?: number }): number {
  const P = o.personality;
  const f0 = SCREAM.f0[P] * 2 ** (idOffset(o.id) / 12);
  const dur = o.dur ?? SCREAM.dur[P];
  const end = t + dur;
  const s = new Snd(bus, { pan: o.pan, to: 'voice', level: SCREAM.level, wet: SCREAM.wet });

  // 音高轮廓（声源和次谐波调幅共用）
  const contour = (p: AudioParam, k: number) => {
    p.setValueAtTime(f0 * 0.9 * k, t);
    p.exponentialRampToValueAtTime(f0 * k, t + 0.05);
    p.linearRampToValueAtTime(f0 * 1.03 * k, t + dur * 0.45);
    p.exponentialRampToValueAtTime(f0 * 0.8 * k, end);
  };
  const src = s.osc('sawtooth', f0, t, end + 0.05);
  contour(src.frequency, 1);
  const sub = s.osc('sine', f0 / 2, t, end + 0.05);
  contour(sub.frequency, 0.5);

  // 颤音（慢慢长出来）+ 随机抖动，两个振荡器都吃
  const vib = s.osc('sine', SCREAM.vibRate[P], t, end + 0.05);
  const vibG = s.gain(0);
  vib.connect(vibG);
  vibG.gain.setValueAtTime(0, t);
  vibG.gain.linearRampToValueAtTime(SCREAM.vibrato[P], t + 0.18);
  const jit = s.gain(SCREAM.jitter);
  s.noise(t, end + 0.05).connect(s.bq('lowpass', 16)).connect(jit);
  for (const n of [vibG, jit]) {
    n.connect(src.detune);
    n.connect(sub.detune);
  }

  // 次谐波调幅：粗糙感
  const am = s.gain(1 - SCREAM.rough[P]);
  src.connect(am);
  sub.connect(s.gain(SCREAM.rough[P])).connect(am.gain);

  // 气声：结尾变多
  const breath = s.gain(0);
  bandNoise(s, t, end + 0.05, 'highpass', 1200).connect(breath);
  breath.gain.setValueAtTime(0.05, t);
  breath.gain.linearRampToValueAtTime(0.14, end);

  // 共振峰：开头偏「诶」，结尾偏「噢」
  const env = s.gain(0);
  const k = SCREAM.formant[P];
  FORMANTS.forEach(([f, q, g], i) => {
    const bp = s.bq('bandpass', f * k, q);
    if (i === 0) {
      bp.frequency.setValueAtTime(f * k * 0.72, t);
      bp.frequency.linearRampToValueAtTime(f * k, t + 0.07);
      bp.frequency.linearRampToValueAtTime(f * k * 0.88, end);
    } else if (i === 1) {
      bp.frequency.setValueAtTime(f * k * 1.3, t);
      bp.frequency.linearRampToValueAtTime(f * k, t + 0.09);
      bp.frequency.linearRampToValueAtTime(f * k * 0.78, end);
    }
    am.connect(bp);
    breath.connect(bp);
    bp.connect(s.gain(g)).connect(env);
  });
  env.connect(s.out);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(SCREAM.amp, t + 0.025);
  env.gain.linearRampToValueAtTime(SCREAM.amp * 0.85, t + dur * 0.6);
  env.gain.setTargetAtTime(0, t + dur * 0.7, dur * 0.08);
  return s.end(end + 0.3);
}

/** 倒吸一口气。strong = 被物件吓到但没够尖叫；否则是被别人的尖叫吓到 */
export function gasp(bus: Bus, t: number, o: VoiceOpts & { strong: boolean }): number {
  const k = GASP.formant[o.personality];
  const amp = o.strong ? GASP.strong : GASP.soft;
  const dur = GASP.dur * (o.strong ? 1.15 : 1);
  const s = new Snd(bus, { pan: o.pan, to: 'voice', wet: 0.15 });
  const g = s.gain(0);
  const rise = (b: BiquadFilterNode, f: number) => {
    b.frequency.setValueAtTime(f * 0.85, t);
    b.frequency.linearRampToValueAtTime(f * 1.1, t + dur);
  };
  bandNoise(s, t, t + dur + 0.05, 'bandpass', 1300 * k, 1.6, (b) => rise(b, 1300 * k)).connect(g);
  bandNoise(s, t, t + dur + 0.05, 'bandpass', 2700 * k, 2.5, (b) => rise(b, 2700 * k)).connect(s.gain(0.5)).connect(g);
  g.connect(s.out);
  g.gain.setValueAtTime(0.0003, t);
  g.gain.exponentialRampToValueAtTime(amp, t + dur * 0.85);
  g.gain.linearRampToValueAtTime(0, t + dur);
  return s.end(t + dur + 0.4);
}
