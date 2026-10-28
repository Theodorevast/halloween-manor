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
//
// 现身（2026-10-28，manifest 事件；时刻和模拟、画面是同一套：windup 0 → drop 0.6 → end 2.1 秒，MANIFEST.windup / hold）
//   createManifestSound 管三个节拍，engine.ts 的路由把事件转给它：
//   windup：环境声让路 —— bus.ambHush 在 0.5 秒里压低 12 dB（A1；吓跑静音用的 ambDuck 另算，两个乘在一起）；一个小二度的低持续音淡入（A2）：
//     55 Hz 和 58.27 Hz 两个正弦（拍频 3.3 Hz），各带一点 Q 4 的带通噪声，再叠它们的二次、三次谐波（110 / 116.5、165 / 175 Hz，两对也都是小二度；
//     小喇叭放不出 55 Hz，靠它们听得出有东西在嗡），过 tanh 轻微失真（多出一点互调，粗糙感）、低通 450 Hz；
//     下面那个音默认不滑（MANIFEST_SFX.drone.slide = 0）：用户的工具库写了「避免滑音」，设计里现身也只写了「一个小二度的低持续音淡入」，
//     所以整个停留阶段两个音一直是小二度；要不要在蓄力里让它往下滑一点（拍频变快：越来越近，调研 A2）留给用户听过以后再定；0.5 秒淡入。
//     灯每暗一下一声很轻的咔哒（lightClick，3D 放在现身的位置）：默认 0.2、0.4 秒各一下 —— 对着 lightfx 蓄力节奏表
//     （"mmamam…"，每秒 10 个字母，a = 暗）里字母 a 的位置；画面那边的暗点改了，这两个数跟着改（MANIFEST_SFX.clicks）
//   drop：低频冲击（sfx.ts 的 manifestHit，吓跑 braam 最低一层）+ 很近的一口冷气（voices.ts 的 coldBreath，3D 放在现身的位置）。
//     同一帧有人被吓跑时（吓跑自己有 braam 和静音），冲击让给它，冷气挪到静音之后
//   end：持续音 0.8 秒淡出（指数，时间常数 0.27 秒）；灯再暗一下的咔哒（轻 30%）；环境声要等 1.5 秒才开始回来，回来用 1.2 秒（C4：多停两拍）
//   保险：没收到 end（暂停、事件丢了）的话，持续音和让路在 windup + hold + 3 秒后自己收（都预排在 AudioParam 时间线上，end 来得及时会把它们取消）
//
// 被手电照到（reveal 事件）：一层很低、很轻的压力声，给玩家的提示（调研 3.1）：约 −30 dB 的低通噪声（截止 220 Hz，噪声幅度被一个 0.21 Hz 的慢正弦推着
//   起伏 ±20%）+ 40 Hz 正弦（+ 一个 80 Hz 的二次谐波，小喇叭放不出 40 Hz 时靠它）；任何一支手电照着就淡入（0.4 秒），全部离开就淡出（0.8 秒），
//   中途又照到就从当前音量折回去（setTargetAtTime，没有跳变）；不定位，不是提示音，不「叮」。第一次用到才建节点，建好以后一直在（音量 0 时几乎不占 CPU）
import { MANIFEST } from '../config/visitors';
import type { GhostState } from '../engine/types';
import { Snd, bandNoise, creak, db, lightClick, manifestHit, playGrains, rand, type Bus, type CreakSpec, type Grain } from './sfx';
import type { Place, Port } from './space';
import { coldBreath } from './voices';

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

// ── 现身 ─────────────────────────────────────────────────────────────────────────

export const MANIFEST_SFX = {
  /** A1 环境声让路：压低多少 dB、多快压下去（秒）；收回（end）以后过多久环境声才开始回来、回来用多久（秒） */
  hush: { db: -12, down: 0.5, back: 1.5, up: 1.2 },
  /** A2 小二度低持续音 */
  drone: {
    /** 两个正弦的频率（赫兹）：小二度，拍频 3.3 Hz */
    hz: [55, 58.27] as const,
    /**
     * 下面那个音在蓄力这段时间里往下滑多少赫兹（拍频变快：越来越近，调研 A2 的菜单条款）；**默认 0 = 不滑**。
     * 用户的工具库写了「避免滑音」，设计文档和简报里现身只写了「一个小二度的低持续音淡入」，没有下滑；滑了以后，停留阶段的音程就不再是小二度了
     * （−1.7 Hz 时基音和两个谐波同比例下移 54 音分，保持阶段的音程是 154 音分）。参数留着，等用户听过以后再决定要不要试；
     * 要试的话把它改成负数，tests/audio.test.ts 里「默认不滑音」那几条会跟着变红，提醒这是在改一条用户定过的规则
     */
    slide: 0,
    /**
     * 基音、二次谐波（八度）、三次谐波的相对音量。55 / 58.27 Hz 在笔记本小喇叭上放不出来，所以把一部分能量放到 110 / 116.5 和 165 / 175 Hz
     * （两对也都是小二度），小喇叭上也听得出有东西在嗡；基音压低一点，免得整体 RMS 全压在 55 Hz 一带
     */
    partials: [0.2, 0.45, 0.25] as readonly number[],
    /** 每根正弦带的带通噪声（Q 4）相对 */
    noise: 0.3,
    /** tanh 失真的驱动、低通截止（赫兹） */
    drive: 1.2,
    lp: 450,
    /** 包络峰值（线性）、淡入秒数、淡出的时间常数 = out / 3（0.8 秒后只剩 5%） */
    amp: 0.06,
    in: 0.5,
    out: 0.8,
  },
  /** 蓄力里灯每暗一下的咔哒：相对蓄力开始的时刻（秒）；收回时灯再暗一下的咔哒强度（0 = 不要） */
  clicks: [0.2, 0.4] as readonly number[],
  endClick: 0.7,
  /** 保险：这么久（秒）还没收到 end 就自己收 */
  maxLife: MANIFEST.windup + MANIFEST.hold + 3,
};

/** 持续音的一根正弦：音量（相对）、蓄力开始时的频率 from、停留阶段（下滑走完以后）的频率 to；from = to 就是没有滑音 */
export interface DroneTone {
  amp: number;
  from: number;
  to: number;
}

/**
 * 持续音每一根正弦的频率：lo = 下面那个音的基音、二次谐波、三次谐波，hi = 上面那个音的三个分音。
 * 下面那个音的第 k 个分音在蓄力里滑 slide × k 赫兹（同比例，谐波跟着基音走），上面那个音不动。
 * 声音（buildDrone）和测试都从这里取频率，所以测试量到的「停留阶段的音程」就是真正响出来的音程
 */
export function droneTones(D: typeof MANIFEST_SFX.drone = MANIFEST_SFX.drone): { lo: DroneTone[]; hi: DroneTone[] } {
  const [lo, hi] = D.hz;
  return {
    lo: D.partials.map((amp, i) => ({ amp, from: lo * (i + 1), to: (lo + D.slide) * (i + 1) })),
    hi: D.partials.map((amp, i) => ({ amp, from: hi * (i + 1), to: hi * (i + 1) })),
  };
}

export interface ManifestSound {
  /** 蓄力开始：环境声让路、持续音淡入、灯的咔哒。at = 现身的位置（3D 或声像） */
  windup(t: number, at: Place): void;
  /** 落下：低频冲击 + 冷气。hit = false 时不放冲击（同一帧有人被吓跑，braam 已经在了）；breathDelay = 冷气晚多少秒（避开吓跑的静音） */
  drop(t: number, at: Place, o?: { hit?: boolean; breathDelay?: number }): void;
  /** 收回：持续音淡出、灯再暗一下的咔哒，环境声过 MANIFEST_SFX.hush.back 秒才回来 */
  end(t: number, at: Place): void;
}

export function createManifestSound(bus: Bus): ManifestSound {
  const M = MANIFEST_SFX;
  const D = M.drone;
  const hush = bus.ambHush?.gain;
  /** 正在响的持续音的包络（没有 = 没有在现身） */
  let env: GainNode | null = null;

  const buildDrone = (t0: number): GainNode => {
    const stop = t0 + M.maxLife;
    const s = new Snd(bus, { at: 0, wet: 0.2 });
    // 所有正弦的幅度加起来 ≤ 1：进失真之前不会被 WaveShaper 硬削
    const sum = s.gain(1 / (2 * D.partials.reduce((a, b) => a + b, 0)));
    // 频率从 droneTones 取；from ≠ to（slide 不为 0）时才在蓄力里排一段线性的频率渐变，默认没有
    const tone = ({ amp, from, to }: DroneTone) => {
      const o = s.osc('sine', from, t0, stop);
      if (to !== from) {
        o.frequency.setValueAtTime(from, t0);
        o.frequency.linearRampToValueAtTime(to, t0 + MANIFEST.windup);
      }
      o.connect(s.gain(amp)).connect(sum);
    };
    const tones = droneTones(D);
    tones.lo.forEach((lo, i) => {
      tone(lo);
      tone(tones.hi[i]);
    });
    // 各带一点带通噪声（窄，像低频的毛边）
    for (const f of D.hz) bandNoise(s, t0, stop, 'bandpass', f, 4).connect(s.gain(D.noise * D.partials[0])).connect(sum);
    // 轻微失真：多出一点谐波和互调（粗糙感），小喇叭上更听得出
    const curve = new Float32Array(1025);
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh(D.drive * ((i / (curve.length - 1)) * 2 - 1)) / Math.tanh(D.drive);
    const e = s.gain(0);
    sum.connect(s.add(new WaveShaperNode(s.ac, { curve, oversample: '2x' }))).connect(s.bq('lowpass', D.lp, 0.7)).connect(e).connect(s.out);
    e.gain.setValueAtTime(0.0003, t0);
    e.gain.exponentialRampToValueAtTime(D.amp, t0 + D.in);
    // 保险：end 来得及时，它会把后面这两个点取消
    e.gain.setValueAtTime(D.amp, stop - 1);
    e.gain.linearRampToValueAtTime(0, stop);
    s.end(stop + 0.5);
    return e;
  };

  return {
    windup(t, at) {
      env = buildDrone(t);
      for (const c of M.clicks) lightClick(bus, t + c, at);
      if (hush) {
        hush.cancelScheduledValues(t);
        hush.setTargetAtTime(db(M.hush.db), t, M.hush.down / 3);
        hush.setTargetAtTime(1, t + M.maxLife + M.hush.back, M.hush.up / 3);
      }
    },
    drop(t, at, o = {}) {
      if (o.hit !== false) manifestHit(bus, t, 0);
      coldBreath(bus, t + (o.breathDelay ?? 0), at);
    },
    end(t, at) {
      if (env) {
        env.gain.cancelScheduledValues(t);
        env.gain.setTargetAtTime(0, t, D.out / 3);
        env = null;
      }
      if (hush) {
        hush.cancelScheduledValues(t + M.hush.back);
        hush.setTargetAtTime(1, t + M.hush.back, M.hush.up / 3);
      }
      if (M.endClick > 0) lightClick(bus, t + 0.02, at, M.endClick);
    },
  };
}

// ── 被手电照到 ──────────────────────────────────────────────────────────────────────

export const REVEAL = {
  /** 低通噪声（线性 0.03 = −30 dB）、截止（赫兹）；40 Hz 正弦、它的二次谐波（80 Hz）相对 */
  noise: 0.03,
  lp: 220,
  hz: 40,
  sine: 0.02,
  octave: 0.35,
  /** 噪声音量被一个很慢的正弦推着起伏（赫兹、深度），免得一直照着时像一块死的墙 */
  swell: [0.21, 0.2] as [number, number],
  /** 淡入、淡出秒数 */
  in: 0.4,
  out: 0.8,
};

export interface RevealLayer {
  /** 有没有人的手电照着鬼魂：true 淡入、false 淡出。t = AudioContext 时间 */
  set(on: boolean, t: number): void;
}

export function createRevealLayer(bus: Bus): RevealLayer {
  const R = REVEAL;
  let env: GainNode | null = null;
  let on = false;
  const build = (): GainNode => {
    const s = new Snd(bus, { at: 0 });
    const g = s.gain(0);
    const noise = s.gain(R.noise);
    bandNoise(s, 0, undefined, 'lowpass', R.lp, 0.7).connect(noise).connect(g);
    s.osc('sine', R.swell[0], 0).connect(s.gain(R.noise * R.swell[1])).connect(noise.gain);
    s.osc('sine', R.hz, 0).connect(s.gain(R.sine)).connect(g);
    s.osc('sine', R.hz * 2, 0).connect(s.gain(R.sine * R.octave)).connect(g);
    g.connect(s.out);
    return g;
  };
  return {
    set(next, t) {
      if (next === on) return;
      on = next;
      env ??= build();
      env.gain.cancelScheduledValues(t);
      env.gain.setTargetAtTime(on ? 1 : 0, t, (on ? R.in : R.out) / 3);
    },
  };
}
