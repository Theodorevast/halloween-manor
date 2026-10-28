// 物件音效、吓跑冲击音、前门（设计文档 4. 声音；计划任务 6 的声音表）。全部用 Web Audio 现场合成，不用音频文件。
// 用户试听后来这里调：整体音量先看 LEVEL（dB），细节看各声音自己的常量块。
//
// 规则（沿用 工具/04-程序化合成.md：v1 因大调、舞曲律动、上行音阶、滑音被否，v2 的做法被采用）
//   - 不用大调、和弦进行、上行音阶、滑音、「叮」类奖励音。全游戏只用一组「恐惧音高」：D 和它上方小二度的 E♭（镜子再加 C♯）
//   - 惊吓靠突然性和不协和，不靠音量：起音 1–3 毫秒；冲击前先留空（镜子黑屏那 0.3 秒只有反向渐强，吓跑前静音 0.15 秒）
//   - 电流噼啪「高、干、短」：只留 1.8 kHz 以上、不进混响、不带低频
//   - 低频持续音不做快速开关（每次切断都是一声低频冲击，连起来像打雷）：要跟着闪烁断开的只断高频那一层
//   - 时间点直接读 src/view/props/*.ts 导出的动画时间线：动画改了，声音跟着走
//
// 配方（时刻从事件算起，单位秒；[ ] 里是它卡住的画面时刻）
//   台灯 lamp（1.25 秒）：闪烁表里每次「亮起」（从暗跳到 ≥ 0.6，或猛冲高一截）放一簇噼啪 —— 2–7 个 0.3–2.5 毫秒的噪声颗粒，
//     一半是采样保持的「数字块」，四阶高通 1.8 kHz，干声 [0, 0.10, 0.26, 0.36, 0.55, 0.64, 0.73, 0.95, 1.05]；
//     变暗的瞬间各一下很小的；熄灭那下最响 [1.12]。
//     + 50 Hz 嗡声：锯齿波 50 Hz 带通 140–1200 Hz 的蜂鸣跟着闪烁表亮灭（中频，断开不会「打雷」）+ 50 Hz 正弦基音平滑跟随，
//     最后猛亮时涌一下 [1.05]，熄灭时 30 毫秒收掉 [1.12]
//   台灯复原 reset（约 1.6 秒）：两簇小噼啪 [0.08, 0.30 两下闪]；嗡声从 0.5 秒线性涌起、0.65 秒到顶 [渐亮到满]，然后约 1 秒退掉
//   摇椅 rockingChair（5.9 秒）：按 ROCK 参数用和画面同一个公式积分出每次摆到头的时刻和振幅 [0.24, 0.66 … 4.30，之后
//     4.62 / 4.98 / 5.42 几乎听不见]；每到头一次一声嘎吱 —— 窄脉冲（粘滑摩擦，往后仰 46→36 Hz、往前 31→25 Hz）
//     + 被它调制的噪声，过三只高 Q 带通（木头共鸣），音量 ∝ 振幅^0.8；往前到头时摇腿前端磕一下地；
//     摇腿在地上滚的低沉摩擦（低通 240 Hz 噪声，音量跟着角速度）；0 秒一下被猛推的闷响 [第一下往后仰]
//   肖像 portrait（1.3 秒 + 混响尾巴）：0 秒一个极短的「嗒」[眼睛甩过去 0–0.07]；D2 + E♭2 锯齿波低通的低沉拉长音，
//     渐强，0.38 秒起加越来越快的颤音 + 越来越密的木框碰撞声 [画框越抖越厉害 0.38–0.60]，0.6 秒收掉 [往前扑]；
//     下落的风声渐强 [0.6–0.94]；0.94 闷响（72→40 Hz 正弦 + 低通噪声）+ 木框碎裂（7 个 2–10 毫秒的宽带颗粒）
//     + 碎玻璃（4.5 kHz 以上的稀疏颗粒，没有音高，不会像「叮」）[砸地 0.94]；小一号的闷响 [弹一下 1.10]、更小的 [1.20 停住]
//   肖像复原 reset（1.05 秒）：两下极轻的木头抽动 [0–0.12]，0.32–0.92 一阵低通噪声的「气」托起来 [飘回画架]，1.05 轻轻一磕 [落定]
//   镜子 mirror（1.0 秒 + 混响尾巴）：每次脸闪出来一声很轻的高频气声 [0, 0.14, 0.26]；0–0.6 反向渐强（同一组音簇 + 噪声，
//     指数渐强、低通越开越亮，0.6 秒硬切）[0.31–0.6 全黑时还在涨]；0.6 小二度音簇冲击：上层 C♯4 D4 E♭4（两个小二度叠在一起）
//     锯齿波 + 下层 D2 D3 E♭3 + 冲击噪声 + 58→34 Hz 的下沉 [脸扑出来、镜子震]；上层带 13 Hz 颤音、0.28 秒内退掉 [镜子抖]，
//     镜框里玻璃抖动的颗粒声；0.84 起上层跟着脸的闪烁表断开 [0.84–1.0 闪着消失]，下层平滑收掉，留混响尾巴
//   门 door（5.1 秒）：0–0.12 越来越急的风声 [甩上]；0.12 撞上门框 —— 宽带噪声爆发 + 68→44 Hz 闷响 + 180 / 480 Hz 门板共鸣
//     + 门框哗啦，混响尾巴 [0.12]；两下小回弹 [0.26, 0.33]；1.62 门闩「咔」：两个 1.5–2.5 毫秒的颗粒相隔 13 毫秒 [松开一条缝]；
//     2.1–5.1 合页慢慢吱呀（摩擦频率 17→24→13 Hz 不规则，750 / 1500 / 3100 Hz 共鸣，很轻）[自己慢慢打开]
//   八音盒 musicBox（4.3 秒）：0 秒盒子一跳、盖子弹开的木头轻响 [0]；旋律 D 小调（带 E♭ 的弗里吉亚色彩），三个乐句一句比一句低，
//     整体下行：D6 A5 B♭5 A5 F5 E5 | C6 A5 G5 F5 E5 D5 | F5 E5 B♭4 A4，乐句开头一个低音 D4 / D4 / E♭4（持续音，不是和弦进行）；
//     音符按「人偶转过的角度」排（和画面同一条转速公式），所以忽快忽慢 [转得不均匀]，3.3 秒起越来越慢、整体音高往下沉 70 音分 [发条松了]；
//     每个音是音叉式的金属音色：基音 + 偏 3.5 音分的第二根簧片（拍频的颤）+ 5.95 倍、3.01 倍的非谐泛音（很快衰减）+ 拨片的「嗒」；
//     每个音随机走调 ±15 音分，再整体叠 0.55 Hz 的 wow（±14 音分）和 7.3 Hz 的 flutter（±5 音分）；
//     4.12 盖子砸上：一声闷的木头「啪」，同时把还在响的音按死 [砸上 4.12]，再弹一下 [4.2]
//   吓跑 braam（hit-stop 0.15 秒静音之后，1.5 秒）：D1 D2 E♭2 D3 E♭3 锯齿波（每个音两根、±7 音分）→ tanh 失真 → 低通
//     3500 → 700 → 280 Hz 收拢（共振 Q 2.2，这是 braam 的「张嘴闭嘴」，不是音高滑动）+ 噪声爆发 + 52→30 Hz 下沉；大量送混响
//   离开 exit（0.4 秒 + 尾巴）：远处闷闷的关门声 —— 60→42 Hz 闷响 + 低通噪声，全部过 320 Hz 低通，九成是混响；不是「叮」
//   进门 spawn（1.6 秒）：两下敲门（210 / 640 Hz 门板共鸣 + 一点「嗒」，过 2.2 kHz 低通显得在门外）[0, 0.24]，
//     然后前门吱呀一声（0.55–1.55，20→28→18 Hz 摩擦，520 / 1180 / 2350 Hz 共鸣）
//   后颈一凉 chillSwell（chill 事件 neck 为真；不定位，是配乐的一层；约 1 秒涌起 + 3 秒退掉）：低沉的小二度 D2 + E♭2
//     锯齿波（各两根 ±5 音分，4.4 Hz 的拍，二次谐波 D3 / E♭3 再打 8.7 Hz 的拍）+ 一点 D1 正弦，过低通 160 → 520 Hz
//     （跟着音量开、跟着音量收）；指数渐强 0.7 秒（越到后面涨得越快，像反向的音头）、撑 0.25 秒、0.55 秒时间常数退掉。
//     倒吸一口气（voices.ts 的 neckGasp）同时从那个访客身上出来；2.5 秒内不重复涌起
import type { ScareType } from '../sim/types';
import { isPort, type Place, type Port, type Space } from './space';
import { DOOR_T_LINE } from '../view/props/door';
import { LAMP_FLICKER, LAMP_RELIGHT } from '../view/props/lamp';
import { MIRROR_FLASH } from '../view/props/mirror';
import { MUSIC_BOX_T } from '../view/props/musicBox';
import { PORTRAIT_TIMELINE } from '../view/props/portrait';
import { ROCK } from '../view/props/rockingChair';

// ── 音量（dB，每个声音的总增益）。用户觉得某个声音太响或太轻，先改这里 ─────────────────────
export const LEVEL = {
  lamp: 0,
  lampReset: -9,
  rockingChair: 4,
  portrait: 0,
  portraitReset: -12,
  mirror: 0,
  musicBox: -7,
  door: 0,
  braam: 0,
  exit: -11,
  spawn: -10,
  chill: 0,
};

// ── 共用：总线、随机数、节点工厂、包络 ─────────────────────────────────────────────

/** 一个声音能接到的总线（engine.ts 的 createBus 产出；实时和离线渲染共用同一套） */
export interface Bus {
  ac: BaseAudioContext;
  /** 物件音效、冲击音、门 */
  sfx: AudioNode;
  /** 尖叫、吸气 */
  voice: AudioNode;
  /** 环境层 */
  amb: AudioNode;
  /** 混响的送入口 */
  reverb: AudioNode;
  /** 4 秒单声道白噪声（循环播放，随机起点） */
  noise: AudioBuffer;
  /** 窄脉冲波形：木头摩擦「粘一下、滑一下」的激励 */
  pulse: PeriodicWave;
  /** 第三人称的 3D 声像（space.ts）；active 之前所有声音都走立体声声像 */
  space?: Space;
}

/** 随机数：默认 Math.random；dev 页面测量时换成带种子的，结果可复现 */
export const rng = { next: Math.random };
export const rand = (a: number, b: number) => a + (b - a) * rng.next();
export const db = (x: number) => 10 ** (x / 20);
export const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export interface SndOpts {
  /**
   * 放在哪：数字 = 立体声声像 -1..1（俯视模式，或 braam 这类不定位的声音）；Vec3 = 房屋米坐标里的 3D 位置；
   * Port = 跟着人走的常驻声道（访客、鬼魂）。3D 还没启用（没调过 setListener）时一律按立体声居中
   */
  at?: Place;
  to?: 'sfx' | 'voice' | 'amb';
  /** 总音量（dB） */
  level?: number;
  /** out 送混响的比例 0..1（dry 输出不送） */
  wet?: number;
}

/**
 * 一个声音的全部节点。out → 声像 → 总线（并按 wet 送混响）；dry → 声像 → 总线（不送混响）。
 * 声像：立体声是一个 StereoPanner；3D 是 space.ts 的 Port（HRTF + 隔墙遮挡，混响也跟着遮挡和距离走）。
 * end(t) 之后由一个静音的 ConstantSource 的 onended 断开全部节点，防止泄漏（自己建的 Port 一起释放）
 */
export class Snd {
  readonly ac: BaseAudioContext;
  readonly out: GainNode;
  private readonly nodes: AudioNode[] = [];
  /** 直达声的入口：StereoPanner，或 Port.in */
  private readonly direct: AudioNode;
  /** 自己建的 Port（结束时释放）；借用的常驻声道不归它管 */
  private readonly port: Port | null = null;
  private readonly lvl: number;
  private dryOut: GainNode | null = null;

  constructor(readonly bus: Bus, o: SndOpts = {}) {
    this.ac = bus.ac;
    this.lvl = db(o.level ?? 0);
    const at = o.at ?? 0;
    const dest = bus[o.to ?? 'sfx'];
    let wetIn: AudioNode = bus.reverb;
    if (typeof at !== 'number' && bus.space?.active) {
      if (isPort(at)) {
        this.direct = at.in;
        wetIn = at.wet;
      } else {
        const port = (this.port = bus.space.port(at, dest));
        this.direct = port.in;
        wetIn = port.wet;
      }
    } else {
      const p = typeof at === 'number' && Number.isFinite(at) ? clamp(at, -1, 1) : 0;
      this.direct = this.add(new StereoPannerNode(this.ac, { pan: p }));
      this.direct.connect(dest);
    }
    this.out = this.gain(this.lvl);
    this.out.connect(this.direct);
    if (o.wet) this.out.connect(this.gain(o.wet)).connect(wetIn);
  }

  /** 不送混响的干声输出（电流噼啪这类要「干」的声音） */
  get dry(): GainNode {
    if (!this.dryOut) {
      this.dryOut = this.gain(this.lvl);
      this.dryOut.connect(this.direct);
    }
    return this.dryOut;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  gain(v = 1): GainNode {
    return this.add(new GainNode(this.ac, { gain: v }));
  }
  bq(type: BiquadFilterType, frequency: number, Q = Math.SQRT1_2, gain = 0): BiquadFilterNode {
    return this.add(new BiquadFilterNode(this.ac, { type, frequency, Q, gain }));
  }
  /** 振荡器；t1 不给就一直响（环境层用） */
  osc(wave: OscillatorType | PeriodicWave, frequency: number, t0: number, t1?: number, detune = 0): OscillatorNode {
    const o =
      wave instanceof PeriodicWave
        ? new OscillatorNode(this.ac, { periodicWave: wave, frequency, detune })
        : new OscillatorNode(this.ac, { type: wave, frequency, detune });
    o.start(t0);
    if (t1 !== undefined) o.stop(Math.max(t0 + 0.001, t1));
    return this.add(o);
  }
  /** 循环白噪声，随机起点；t1 不给就一直响 */
  noise(t0: number, t1?: number, rate = 1): AudioBufferSourceNode {
    const b = this.bus.noise;
    const s = new AudioBufferSourceNode(this.ac, { buffer: b, loop: true, playbackRate: rate });
    s.start(t0, rng.next() * b.duration * 0.9);
    if (t1 !== undefined) s.stop(Math.max(t0 + 0.001, t1));
    return this.add(s);
  }
  /** 播放一段现算的 AudioBuffer（颗粒声轨） */
  play(buffer: AudioBuffer, t0: number): AudioBufferSourceNode {
    const s = new AudioBufferSourceNode(this.ac, { buffer });
    s.start(t0);
    return this.add(s);
  }
  /** 声音结束：t1 之后断开全部节点。返回 t1 */
  end(t1: number): number {
    const s = new ConstantSourceNode(this.ac, { offset: 0 });
    s.connect(this.out);
    s.onended = () => {
      for (const n of this.nodes) n.disconnect();
      s.disconnect();
      this.port?.release();
    };
    s.start();
    s.stop(Math.max(this.ac.currentTime + 0.01, t1));
    return t1;
  }
}

/** 打击包络：t 起 attack 秒线性升到 peak，再按时间常数 tau 指数衰减（7·tau 后约 -60 dB） */
export function perc(p: AudioParam, t: number, peak: number, attack: number, tau: number) {
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + attack);
  p.setTargetAtTime(0, t + attack, tau);
}

/** 折线包络：[[时刻, 值], …]（时刻相对 t0）；第一个点 setValue，之后线性 */
export function line(p: AudioParam, t0: number, pts: readonly (readonly [number, number])[]) {
  pts.forEach(([at, v], i) => (i === 0 ? p.setValueAtTime(v, t0 + at) : p.linearRampToValueAtTime(v, t0 + at)));
}

/**
 * 滤波噪声：按通带宽度补偿了增益，输出大致是 RMS 0.5，配方里的音量参数因此和频率、Q 基本无关。
 * 返回的是滤波后的增益节点；要动滤波器参数就传 onFilter
 */
export function bandNoise(
  s: Snd,
  t0: number,
  t1: number | undefined,
  type: 'lowpass' | 'bandpass' | 'highpass',
  f: number,
  q = Math.SQRT1_2,
  onFilter?: (b: BiquadFilterNode) => void,
): GainNode {
  const nyq = s.ac.sampleRate / 2;
  const bw = type === 'bandpass' ? f / q : type === 'lowpass' ? f : nyq - f;
  const flt = s.bq(type, f, q);
  const g = s.gain(clamp(0.87 * Math.sqrt(nyq / Math.max(10, bw)), 0.5, 60));
  s.noise(t0, t1).connect(flt).connect(g);
  onFilter?.(flt);
  return g;
}

/** 一个很短的噪声颗粒：t 时刻、长 len 秒、幅度 amp；block = 采样保持（数字感的「块」） */
export interface Grain {
  t: number;
  len: number;
  amp: number;
  block?: boolean;
}

/** 把一串颗粒写进一个单声道 AudioBuffer：电流噼啪、木头裂、碎玻璃、拨片声都用它 */
export function grainBuffer(ac: BaseAudioContext, grains: Grain[]): AudioBuffer {
  const sr = ac.sampleRate;
  const dur = grains.reduce((m, g) => Math.max(m, g.t + g.len), 0) + 0.01;
  const buf = new AudioBuffer({ length: Math.max(1, Math.ceil(dur * sr)), numberOfChannels: 1, sampleRate: sr });
  const d = buf.getChannelData(0);
  const att = Math.max(1, Math.round(0.00015 * sr));
  for (const g of grains) {
    const i0 = Math.max(0, Math.floor(g.t * sr));
    const n = Math.max(2, Math.floor(g.len * sr));
    let v = 0;
    let hold = 0;
    for (let k = 0; k < n && i0 + k < d.length; k++) {
      if (!g.block) v = rng.next() * 2 - 1;
      else if (hold-- <= 0) {
        v = rng.next() < 0.5 ? -1 : 1;
        hold = 3 + Math.floor(rng.next() * 18);
      }
      d[i0 + k] += v * g.amp * Math.min(1, k / att) * Math.exp((-4 * k) / n);
    }
  }
  return buf;
}

/** 一簇电流噼啪：几毫秒到几十毫秒内 2–7 个极短的颗粒，一半是采样保持的「数字块」。k = 强度（约 0..1.4） */
export function crackle(out: Grain[], t: number, k: number) {
  const n = 2 + Math.round(5 * Math.min(1, k));
  let at = t;
  for (let i = 0; i < n; i++) {
    out.push({ t: at, len: rand(0.0003, 0.0025), amp: k * rand(0.35, 1), block: rng.next() < 0.5 });
    at += rand(0.0015, 0.008);
  }
}

/** 颗粒声轨 → 滤波链 → dest */
export function playGrains(s: Snd, t: number, grains: Grain[], dest: AudioNode, gain: number, ...filters: BiquadFilterNode[]) {
  if (!grains.length) return;
  let node: AudioNode = s.play(grainBuffer(s.ac, grains), t);
  for (const f of filters) node = node.connect(f);
  node.connect(s.gain(gain)).connect(dest);
}

/**
 * 闷响：正弦从 f0 在 0.1 秒内落到 f1（撞击本身的音高包络，不是滑音）+ 一点 1.6 倍的「木头」泛音 + 低通噪声
 */
export function thud(s: Snd, dest: AudioNode, t: number, amp: number, f0: number, f1: number, tau: number, noiseLp = 700, noiseAmp = 0.5) {
  const o = s.osc('sine', f0, t, t + tau * 7 + 0.05);
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + 0.1);
  const g = s.gain(0);
  perc(g.gain, t, amp, 0.002, tau);
  o.connect(g).connect(dest);
  const o2 = s.osc('sine', f0 * 1.6, t, t + tau * 4 + 0.05);
  o2.frequency.setValueAtTime(f0 * 1.6, t);
  o2.frequency.exponentialRampToValueAtTime(f1 * 1.6, t + 0.08);
  const g2 = s.gain(0);
  perc(g2.gain, t, amp * 0.3, 0.002, tau * 0.45);
  o2.connect(g2).connect(dest);
  if (noiseAmp > 0) {
    const gn = s.gain(0);
    perc(gn.gain, t, amp * noiseAmp, 0.001, 0.04);
    bandNoise(s, t, t + 0.4, 'lowpass', noiseLp).connect(gn).connect(dest);
  }
}

/** 敲在木头上：带通噪声（body 赫兹）+ 同频的短正弦 + 一点高频「嗒」 */
export function knock(s: Snd, dest: AudioNode, t: number, amp: number, body: number, tau: number, click = 0.3) {
  const g = s.gain(0);
  perc(g.gain, t, amp, 0.0008, tau);
  bandNoise(s, t, t + tau * 8 + 0.02, 'bandpass', body, 2.5).connect(g).connect(dest);
  const o = s.osc('sine', body * 1.25, t, t + tau * 8 + 0.02);
  o.frequency.setValueAtTime(body * 1.25, t);
  o.frequency.exponentialRampToValueAtTime(body, t + 0.015);
  const go = s.gain(0);
  perc(go.gain, t, amp * 0.6, 0.001, tau * 0.8);
  o.connect(go).connect(dest);
  if (click > 0) {
    const gc = s.gain(0);
    perc(gc.gain, t, amp * click, 0.0003, 0.003);
    bandNoise(s, t, t + 0.03, 'highpass', 2500).connect(gc).connect(dest);
  }
}

/** 木头嘎吱的参数 */
export interface CreakSpec {
  /** 摩擦脉冲的频率（赫兹）：起点、中点、终点。听感上是嘎吱的「粗细」，变化要小，别做成滑音 */
  rate: readonly [number, number, number];
  /** 木头共鸣：[频率, Q, 音量] */
  res: readonly (readonly [number, number, number])[];
  /** 噪声颗粒感 0..1（0 = 纯脉冲的「嗯——」，1 = 沙沙的摩擦） */
  grit: number;
}

/** 窄脉冲经过一组高 Q 带通的增益补偿（脉冲每个谐波只有约 1/100 的幅度） */
const CREAK_GAIN = 14;

/** 共鸣滤波组：返回输入节点；多声嘎吱可以共用一组 */
export function creakBank(s: Snd, c: CreakSpec, dest: AudioNode): GainNode {
  const input = s.gain(1);
  for (const [f, q, g] of c.res) input.connect(s.bq('bandpass', f, q)).connect(s.gain(g * CREAK_GAIN)).connect(dest);
  return input;
}

/** 一声嘎吱的激励（脉冲 + 被脉冲调制的噪声），接到 creakBank 的输入 */
export function creakExcite(s: Snd, bank: AudioNode, t: number, dur: number, amp: number, c: CreakSpec, att = 0.04) {
  const end = t + dur;
  const p = s.osc(s.bus.pulse, c.rate[0], t, end + 0.02);
  p.frequency.setValueAtTime(c.rate[0], t);
  p.frequency.linearRampToValueAtTime(c.rate[1], t + dur * 0.45);
  p.frequency.linearRampToValueAtTime(c.rate[2], end);
  const env = s.gain(0);
  p.connect(s.gain(1 - c.grit)).connect(env);
  // 噪声 × 脉冲：每「滑」一下放出一小簇摩擦噪声
  const am = s.gain(0);
  s.noise(t, end + 0.02).connect(am);
  p.connect(am.gain);
  am.connect(s.gain(c.grit * 0.5)).connect(env);
  const a = Math.min(att, dur * 0.4);
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(amp, t + a);
  env.gain.setValueAtTime(amp, Math.max(t + a, end - dur * 0.4));
  env.gain.linearRampToValueAtTime(0, end);
  env.connect(bank);
}

/** 一声完整的嘎吱（自带一组共鸣） */
export function creak(s: Snd, dest: AudioNode, t: number, dur: number, amp: number, c: CreakSpec, att = 0.04) {
  creakExcite(s, creakBank(s, c, dest), t, dur, amp, c, att);
}

/** 闪烁表里「亮起」的时刻：亮度从暗（< 0.6）跳到 ≥ 0.6，或比上一段猛冲高 0.4 以上（电压冲高）。prev0 = 表开始前的亮度 */
function flashes(tab: readonly (readonly [number, number])[], prev0: number): [number, number][] {
  const out: [number, number][] = [];
  let prev = prev0;
  for (const [at, b] of tab) {
    if (b >= 0.6 && (prev < 0.6 || b > prev + 0.4)) out.push([at, b]);
    prev = b;
  }
  return out;
}
/** 闪烁表里「变暗」的时刻（从 ≥ 0.6 掉到 < 0.3） */
function darks(tab: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  let prev = 1;
  for (const [at, b] of tab) {
    if (b < 0.3 && prev >= 0.6) out.push(at);
    prev = b;
  }
  return out;
}

/** 一个声音：t 起播，at 是放在哪（见 SndOpts.at）；返回节点全部断开的时刻 */
export type SfxFn = (bus: Bus, t: number, at: Place) => number;

// ── 台灯 ────────────────────────────────────────────────────────────────────

export const LAMP = {
  /** 噼啪音量；高通截止（两级，四阶） */
  crackle: 0.55,
  hp: 1800,
  /** 变暗瞬间的小噼啪、熄灭那一下的强度 */
  tick: 0.22,
  pop: 1.4,
  /** 嗡声：蜂鸣层（跟着闪烁亮灭）和 50 Hz 基音（平滑） */
  buzz: 0.5,
  fund: 0.17,
  /** 蜂鸣跟着亮度走，但亮度超过这个值（电压冲高）就不再加：冲高靠噼啪和基音表现，蜂鸣再响会顶到限幅器 */
  buzzCap: 1.25,
  band: [140, 1200] as const,
  /** 最后猛亮时基音涌起的倍数 */
  surge: 1.5,
};

export const lamp: SfxFn = (bus, t, at) => {
  const s = new Snd(bus, { at, level: LEVEL.lamp, wet: 0.06 });
  const tab = LAMP_FLICKER;
  const off = tab[tab.length - 1][0];
  const peakAt = tab.reduce((m, e) => (e[1] > m[1] ? e : m), tab[0])[0];

  const gr: Grain[] = [];
  for (const [at, b] of flashes(tab, 1)) crackle(gr, at + 0.001, Math.min(1.3, b) / 1.3);
  for (const at of darks(tab)) if (at < off) crackle(gr, at, LAMP.tick);
  crackle(gr, off, LAMP.pop);
  playGrains(s, t, gr, s.dry, LAMP.crackle, s.bq('highpass', LAMP.hp), s.bq('highpass', LAMP.hp));

  // 蜂鸣：跟着闪烁表亮灭（中频，断开不会有低频冲击）
  const buzz = s.gain(0);
  s.osc('sawtooth', 50, t, t + off + 0.1)
    .connect(s.bq('highpass', LAMP.band[0]))
    .connect(s.bq('lowpass', LAMP.band[1]))
    .connect(buzz)
    .connect(s.out);
  buzz.gain.setValueAtTime(0, t);
  for (const [at, b] of tab) buzz.gain.setTargetAtTime(Math.min(b, LAMP.buzzCap) * LAMP.buzz, t + at, 0.003);

  // 50 Hz 基音：平滑跟随，只在最后猛亮时涌一下，熄灭时 30 毫秒收掉
  const fund = s.gain(0);
  s.osc('sine', 50, t, t + off + 0.3).connect(fund).connect(s.out);
  fund.gain.setValueAtTime(0, t);
  fund.gain.setTargetAtTime(LAMP.fund, t, 0.03);
  fund.gain.setTargetAtTime(LAMP.fund * LAMP.surge, t + peakAt, 0.02);
  fund.gain.setTargetAtTime(0, t + off, 0.03);
  return s.end(t + off + 0.35);
};

export const lampReset: SfxFn = (bus, t, at) => {
  const s = new Snd(bus, { at, level: LEVEL.lampReset, wet: 0.1 });
  const tab = LAMP_RELIGHT;
  const warm = tab[tab.length - 1][0]; // 从这里开始预热
  const full = warm + 0.15; // 满亮（view/props/lamp.ts：0.15 秒内爬到满）

  const gr: Grain[] = [];
  for (const [at, b] of flashes(tab, 0)) if (at < warm) crackle(gr, at + 0.001, Math.min(1.2, b) * 0.6);
  playGrains(s, t, gr, s.dry, LAMP.crackle, s.bq('highpass', LAMP.hp), s.bq('highpass', LAMP.hp));

  const buzz = s.gain(0);
  s.osc('sawtooth', 50, t, t + full + 1.6)
    .connect(s.bq('highpass', LAMP.band[0]))
    .connect(s.bq('lowpass', LAMP.band[1]))
    .connect(buzz)
    .connect(s.out);
  buzz.gain.setValueAtTime(0, t);
  for (const [at, b] of tab) if (at < warm) buzz.gain.setTargetAtTime(b * LAMP.buzz * 0.6, t + at, 0.003);
  buzz.gain.setValueAtTime(0, t + warm);
  buzz.gain.linearRampToValueAtTime(LAMP.buzz * 1.3, t + full);
  buzz.gain.setTargetAtTime(0, t + full + 0.05, 0.25);

  const fund = s.gain(0);
  s.osc('sine', 50, t, t + full + 1.6).connect(fund).connect(s.out);
  fund.gain.setValueAtTime(0, t + warm);
  fund.gain.linearRampToValueAtTime(LAMP.fund, t + full);
  fund.gain.setTargetAtTime(0, t + full + 0.05, 0.3);
  return s.end(t + full + 1.7);
};

// ── 摇椅 ────────────────────────────────────────────────────────────────────

export const CHAIR = {
  creak: 1.0,
  /** 往后仰到头：细一点的「吱」 */
  back: { rate: [46, 41, 36], res: [[560, 7, 1], [1350, 9, 0.7], [2700, 8, 0.4]], grit: 0.4 } as CreakSpec,
  /** 往前到头：粗一点的「嘎」 */
  fwd: { rate: [31, 29, 25], res: [[420, 7, 1], [1050, 8, 0.8], [2150, 7, 0.35]], grit: 0.5 } as CreakSpec,
  /** 振幅越小的摆动嘎吱越轻：音量 ∝ (振幅 / 最大振幅)^curve */
  curve: 0.8,
  /** 往前到头时摇腿磕地、0 秒被猛推的那一下 */
  thunk: 0.35,
  push: 0.45,
  /** 摇腿在地上滚的低沉摩擦（跟着角速度） */
  roll: 0.45,
  wet: 0.25,
};

interface ChairMotion {
  /** 每次摆到头：时刻、角度（负 = 往后仰） */
  ext: { t: number; th: number }[];
  /** 每 20 毫秒的 |角速度| / 最大值 */
  speed: Float32Array;
  total: number;
}
let chairCache: ChairMotion | null = null;

/** 摇椅的运动：和 view/props/rockingChair.ts 同一个公式（同一份 ROCK 参数），1 毫秒步长积分 */
function chairMotion(): ChairMotion {
  if (chairCache) return chairCache;
  const total = ROCK.spin + ROCK.decay + 0.6;
  const dt = 0.001;
  const ext: { t: number; th: number }[] = [];
  const sp: number[] = [];
  let phase = 0, decayFrom = 0, prev = 0, prevD = 0, t = 0, acc = 0, vmax = 0;
  while (t < total) {
    t += dt;
    let th: number;
    if (t < ROCK.spin) {
      const u = t / ROCK.spin;
      phase += Math.PI * 2 * (ROCK.f0 + (ROCK.f1 - ROCK.f0) * u) * dt;
      const amp = ROCK.a0 + (ROCK.a1 - ROCK.a0) * u;
      th = -amp * Math.sin(phase);
      decayFrom = amp;
    } else {
      const td = t - ROCK.spin;
      phase += Math.PI * 2 * (ROCK.f1 + (ROCK.fEnd - ROCK.f1) * Math.min(1, td / ROCK.decay)) * dt;
      const fade = 1 - clamp((td - ROCK.decay) / 0.6, 0, 1);
      th = -decayFrom * Math.exp(-ROCK.k * td) * fade * Math.sin(phase);
    }
    const d = th - prev;
    if (prevD * d < 0) ext.push({ t, th });
    prevD = d;
    prev = th;
    acc += dt;
    if (acc >= 0.02) {
      acc = 0;
      const v = Math.abs(d / dt);
      vmax = Math.max(vmax, v);
      sp.push(v);
    }
  }
  const speed = new Float32Array(sp.length);
  sp.forEach((v, i) => (speed[i] = v / (vmax || 1)));
  return (chairCache = { ext, speed, total });
}

export const rockingChair: SfxFn = (bus, t, at) => {
  const s = new Snd(bus, { at, level: LEVEL.rockingChair, wet: CHAIR.wet });
  const m = chairMotion();
  const thMax = m.ext.reduce((a, e) => Math.max(a, Math.abs(e.th)), 1e-6);
  const backBank = creakBank(s, CHAIR.back, s.out);
  const fwdBank = creakBank(s, CHAIR.fwd, s.out);

  // 0 秒：被谁猛推了一把
  knock(s, s.out, t, CHAIR.push, 170, 0.05, 0.15);
  for (const e of m.ext) {
    const a = Math.abs(e.th) / thMax;
    const back = e.th < 0;
    const spec = back ? CHAIR.back : CHAIR.fwd;
    const dur = 0.15 + 0.22 * a;
    const j = rand(0.92, 1.08);
    const c: CreakSpec = { ...spec, rate: [spec.rate[0] * j, spec.rate[1] * j, spec.rate[2] * j] };
    // 嘎吱的最响处落在到头的那一刻
    creakExcite(s, back ? backBank : fwdBank, t + e.t - dur * 0.45, dur, CHAIR.creak * a ** CHAIR.curve, c);
    if (!back) knock(s, s.out, t + e.t, CHAIR.thunk * a ** CHAIR.curve, 140, 0.035, 0.05);
  }
  // 摇腿滚动：低通噪声，音量跟着角速度
  const roll = s.gain(0);
  bandNoise(s, t, t + m.total + 0.05, 'lowpass', 240).connect(roll).connect(s.out);
  const curve = new Float32Array(m.speed.length);
  m.speed.forEach((v, i) => (curve[i] = v * CHAIR.roll));
  roll.gain.setValueCurveAtTime(curve, t, m.speed.length * 0.02);
  return s.end(t + m.total + 1.5);
};

// ── 肖像 ────────────────────────────────────────────────────────────────────

export const PORTRAIT = {
  /** 眼睛甩过去的「嗒」 */
  snap: 0.5,
  /** 低沉拉长音：D2 + E♭2 锯齿波，低通从 lp[0] 开到 lp[1] */
  groan: 0.2,
  groanHz: [73.42, 77.78] as const,
  lp: [260, 620] as const,
  /** 画框抖动的木头碰撞（越来越密） */
  tremble: 0.45,
  /** 往下扑的风声 */
  whoosh: 0.1,
  /** 砸地：闷响、木框碎裂、碎玻璃 */
  thud: 0.95,
  crack: 0.9,
  glass: 0.45,
  wet: 0.35,
};

export const portrait: SfxFn = (bus, t, at) => {
  const T = PORTRAIT_TIMELINE;
  const P = PORTRAIT;
  const s = new Snd(bus, { at, level: LEVEL.portrait, wet: P.wet });
  const wood: Grain[] = [];
  const glass: Grain[] = [];

  // 眼睛甩过去：一个极短的「嗒」
  wood.push({ t: 0.004, len: 0.0015, amp: P.snap });

  // 低沉拉长音：起音跟着眼睛（0.07 秒），渐强，扑倒时收掉
  const lp = s.bq('lowpass', P.lp[0], 2.5);
  for (const f of P.groanHz) for (const d of [-6, 6]) s.osc('sawtooth', f, t, t + T.fall + 0.2, d).connect(lp);
  lp.frequency.setValueAtTime(P.lp[0], t);
  lp.frequency.linearRampToValueAtTime(P.lp[1], t + T.fall);
  const trem = s.gain(1);
  const env = s.gain(0);
  lp.connect(trem).connect(env).connect(s.out);
  line(env.gain, t, [[0, 0], [T.snap, P.groan * 0.6], [T.trembleFrom, P.groan * 0.75], [T.fall - 0.02, P.groan], [T.fall + 0.08, 0]]);
  // 抖：颤音越来越快、越来越深
  const lfo = s.osc('sine', 9, t, t + T.fall + 0.2);
  lfo.frequency.setValueAtTime(9, t + T.trembleFrom);
  lfo.frequency.linearRampToValueAtTime(22, t + T.fall);
  const depth = s.gain(0);
  lfo.connect(depth).connect(trem.gain);
  depth.gain.setValueAtTime(0, t + T.trembleFrom);
  depth.gain.linearRampToValueAtTime(0.5, t + T.fall);
  // 画框磕画架：越来越密、越来越响
  for (let at = T.trembleFrom; at < T.fall; ) {
    const u = (at - T.trembleFrom) / (T.fall - T.trembleFrom);
    wood.push({ t: at, len: rand(0.003, 0.007), amp: P.tremble * (0.3 + 0.7 * u) * rand(0.7, 1) });
    at += lerp(0.085, 0.03, u) * rand(0.8, 1.2);
  }

  // 往下扑的风声
  const wg = s.gain(0);
  bandNoise(s, t + T.fall, t + T.impact + 0.03, 'lowpass', 650).connect(wg).connect(s.out);
  wg.gain.setValueAtTime(0.0001, t + T.fall);
  wg.gain.exponentialRampToValueAtTime(P.whoosh, t + T.impact - 0.005);
  wg.gain.linearRampToValueAtTime(0, t + T.impact + 0.01);

  // 砸地：闷响 + 木框碎裂 + 碎玻璃
  thud(s, s.out, t + T.impact, P.thud, 72, 40, 0.13, 900, 0.6);
  for (let i = 0, at = T.impact; i < 7; i++) {
    wood.push({ t: at, len: rand(0.002, 0.01), amp: P.crack * rand(0.5, 1) });
    at += rand(0.006, 0.02);
  }
  for (let i = 0, at = T.impact + 0.004; i < 28; i++) {
    glass.push({ t: at, len: rand(0.0006, 0.003), amp: P.glass * Math.exp(-(at - T.impact) / 0.15) * rand(0.4, 1) });
    at += rand(0.004, 0.03) * (1 + i * 0.08);
  }
  // 弹一下、停住
  thud(s, s.out, t + T.bounce1, P.thud * 0.3, 90, 55, 0.07, 1200, 0.5);
  wood.push({ t: T.bounce1, len: 0.004, amp: P.crack * 0.35 }, { t: T.bounce1 + 0.012, len: 0.003, amp: P.crack * 0.2 });
  thud(s, s.out, t + T.bounce2, P.thud * 0.1, 100, 70, 0.05, 1200, 0.5);
  wood.push({ t: T.bounce2, len: 0.003, amp: P.crack * 0.12 });

  playGrains(s, t, wood, s.out, 1, s.bq('bandpass', 1400, 0.8));
  playGrains(s, t, glass, s.out, 1, s.bq('highpass', 4500), s.bq('highpass', 4500));
  return s.end(t + T.end + 2.6);
};

/** 肖像复原的时刻（view/props/portrait.ts 的 reset 段里写死的：抽动 0–0.12、飘回 0.32–0.92、落定 1.05） */
const PORTRAIT_RESET = { twitch: 0.12, liftFrom: 0.32, liftTo: 0.92, settle: 1.05 };

export const portraitReset: SfxFn = (bus, t, at) => {
  const R = PORTRAIT_RESET;
  const s = new Snd(bus, { at, level: LEVEL.portraitReset, wet: 0.4 });
  playGrains(
    s,
    t,
    [{ t: 0.005, len: 0.004, amp: 0.4 }, { t: R.twitch * 0.5, len: 0.003, amp: 0.25 }],
    s.out,
    1,
    s.bq('bandpass', 1200, 0.9),
  );
  // 一阵「气」把它托回去：低通噪声 + 极轻的 D2 / E♭2
  const g = s.gain(0);
  bandNoise(s, t + R.liftFrom, t + R.liftTo + 0.05, 'lowpass', 500).connect(g).connect(s.out);
  for (const f of PORTRAIT.groanHz) s.osc('sine', f, t + R.liftFrom, t + R.liftTo + 0.05).connect(s.gain(0.25)).connect(g);
  line(g.gain, t, [[R.liftFrom, 0], [(R.liftFrom + R.liftTo) / 2, 0.22], [R.liftTo, 0]]);
  knock(s, s.out, t + R.settle, 0.4, 240, 0.03, 0.2);
  return s.end(t + R.settle + 2.4);
};

// ── 镜子 ────────────────────────────────────────────────────────────────────

export const MIRROR = {
  /** 脸闪出来时的高频气声 */
  hiss: 0.16,
  /** 反向渐强的峰值 */
  swell: 0.32,
  /** 上层音簇 C♯4 D4 E♭4（跟着脸的闪烁断开）、下层 D2 D3 E♭3（平滑，不闪断） */
  upperHz: [277.18, 293.66, 311.13] as const,
  lowerHz: [73.42, 146.83, 155.56] as const,
  stab: 0.11,
  low: 0.12,
  /** 冲击噪声、下沉的低音 */
  hitNoise: 0.45,
  sub: 0.75,
  /** 镜框里玻璃的抖动 */
  rattle: 0.28,
  /** 镜子抖的颤音：频率、深度、多久退掉 */
  shakeHz: 13,
  shakeDepth: 0.4,
  shakeFor: 0.28,
  wet: 0.5,
};

export const mirror: SfxFn = (bus, t, at) => {
  const M = MIRROR;
  const tab = MIRROR_FLASH;
  const hit = (tab.find((e) => e[1] > 1) ?? [0.6, 1])[0];
  const fin = tab[tab.length - 1][0];
  const s = new Snd(bus, { at, level: LEVEL.mirror, wet: M.wet });

  // 脸每闪出来一次：一声很轻的高频气声
  for (const [at, b] of flashes(tab, 0)) {
    if (at >= hit) continue;
    const g = s.gain(0);
    perc(g.gain, t + at, M.hiss * b, 0.004, 0.05);
    bandNoise(s, t + at, t + at + 0.4, 'highpass', 2500).connect(g).connect(s.out);
  }

  // 反向渐强：同一组音簇 + 噪声，指数渐强、越来越亮，冲击点硬切
  const swellLp = s.bq('lowpass', 400, 1);
  swellLp.frequency.setValueAtTime(400, t);
  swellLp.frequency.exponentialRampToValueAtTime(5000, t + hit);
  for (const f of [...M.upperHz, ...M.lowerHz.slice(1)]) s.osc('sawtooth', f, t, t + hit + 0.01, rand(-8, 8)).connect(s.gain(0.25)).connect(swellLp);
  bandNoise(s, t, t + hit + 0.01, 'bandpass', 1800, 0.6).connect(s.gain(0.6)).connect(swellLp);
  const sg = s.gain(0);
  swellLp.connect(sg).connect(s.out);
  sg.gain.setValueAtTime(0.0003, t);
  sg.gain.exponentialRampToValueAtTime(M.swell, t + hit - 0.003);
  sg.gain.linearRampToValueAtTime(0, t + hit + 0.002);

  const th = t + hit;
  // 上层音簇：锯齿波 → 低通收拢 → 颤音（镜子抖）→ 跟着脸的闪烁断开
  const upLp = s.bq('lowpass', 6000, 1);
  upLp.frequency.setValueAtTime(6000, th);
  upLp.frequency.exponentialRampToValueAtTime(1500, th + 0.3);
  upLp.frequency.exponentialRampToValueAtTime(900, t + fin);
  for (const f of M.upperHz) for (const d of [-10, 10]) s.osc('sawtooth', f, th, t + fin + 0.2, d).connect(upLp);
  const shake = s.gain(1);
  const lfo = s.osc('sine', M.shakeHz, th, th + M.shakeFor + 0.05);
  const depth = s.gain(0);
  lfo.connect(depth).connect(shake.gain);
  depth.gain.setValueAtTime(M.shakeDepth, th);
  depth.gain.linearRampToValueAtTime(0, th + M.shakeFor);
  const upEnv = s.gain(0);
  upEnv.gain.setValueAtTime(0, th);
  upEnv.gain.linearRampToValueAtTime(M.stab, th + 0.003);
  upEnv.gain.setTargetAtTime(M.stab * 0.55, th + 0.003, 0.08);
  const flick = s.gain(1);
  for (const [at, b] of tab) if (at > hit) flick.gain.setTargetAtTime(Math.min(1, b / 0.75), t + at, at >= fin ? 0.02 : 0.005);
  upLp.connect(shake).connect(upEnv).connect(flick).connect(s.out);

  // 下层：平滑起落，不跟着闪断
  const loLp = s.bq('lowpass', 1200, 0.8);
  for (const f of M.lowerHz) for (const d of [-7, 7]) s.osc('sawtooth', f, th, t + fin + 0.6, d).connect(loLp);
  const loEnv = s.gain(0);
  perc(loEnv.gain, th, M.low, 0.004, 0.4);
  loEnv.gain.setTargetAtTime(0, t + fin, 0.08);
  loLp.connect(loEnv).connect(s.out);

  // 冲击噪声 + 下沉的低音
  const hn = s.gain(0);
  perc(hn.gain, th, M.hitNoise, 0.001, 0.07);
  bandNoise(s, th, th + 0.6, 'lowpass', 5000).connect(hn).connect(s.out);
  thud(s, s.out, th, M.sub, 58, 34, 0.22, 700, 0);

  // 镜框里的玻璃跟着抖
  const rattle: Grain[] = [];
  for (let at = 0; at < M.shakeFor; at += 1 / 18) rattle.push({ t: at + rand(0, 0.01), len: rand(0.002, 0.005), amp: M.rattle * (1 - at / M.shakeFor) });
  playGrains(s, th, rattle, s.out, 1, s.bq('bandpass', 3200, 1.5));
  return s.end(t + fin + 2.6);
};

// ── 厨房门 ───────────────────────────────────────────────────────────────────

export const DOOR = {
  /** 甩过来带起的风 */
  whoosh: 0.35,
  /** 撞上门框：宽带噪声、闷响、门板共鸣、门框哗啦 */
  crack: 0.75,
  thud: 0.85,
  body: 0.6,
  rattle: 0.35,
  /** 两下回弹（相对撞击） */
  bounce: [0.32, 0.16] as const,
  /** 门闩「咔」 */
  latch: 0.55,
  /** 合页慢慢吱呀 */
  creep: 0.16,
  creepSpec: { rate: [17, 24, 13], res: [[750, 10, 1], [1500, 12, 0.7], [3100, 9, 0.35]], grit: 0.35 } as CreakSpec,
  wet: 0.55,
};

export const door: SfxFn = (bus, t, at) => {
  const L = DOOR_T_LINE;
  const D = DOOR;
  const s = new Snd(bus, { at, level: LEVEL.door, wet: D.wet });

  // 0 → 撞上：越来越急的风
  const wg = s.gain(0);
  bandNoise(s, t, t + L.slam + 0.02, 'bandpass', 450, 0.7).connect(wg).connect(s.out);
  wg.gain.setValueAtTime(0.0005, t);
  wg.gain.exponentialRampToValueAtTime(D.whoosh, t + L.slam - 0.002);
  wg.gain.linearRampToValueAtTime(0, t + L.slam + 0.006);

  const slam = (at: number, k: number) => {
    const ta = t + at;
    const cg = s.gain(0);
    perc(cg.gain, ta, D.crack * k, 0.0008, 0.025);
    bandNoise(s, ta, ta + 0.3, 'lowpass', 4000).connect(cg).connect(s.out);
    thud(s, s.out, ta, D.thud * k, k > 0.5 ? 68 : 85, k > 0.5 ? 44 : 58, k > 0.5 ? 0.16 : 0.07, 700, 0);
    for (const [f, q, a, tau] of [[180, 3, 1, 0.09], [480, 4, 0.75, 0.06]] as const) {
      const g = s.gain(0);
      perc(g.gain, ta, D.body * a * k, 0.001, tau);
      bandNoise(s, ta, ta + tau * 8, 'bandpass', f, q).connect(g).connect(s.out);
    }
  };
  slam(L.slam, 1);
  slam(L.bounce1, D.bounce[0]);
  slam(L.bounce2, D.bounce[1]);

  // 门框、门闩哗啦一下 + 1.62 秒的「咔」
  const gr: Grain[] = [];
  for (let i = 0, at = L.slam + 0.012; i < 5; i++) {
    gr.push({ t: at, len: rand(0.002, 0.004), amp: D.rattle * rand(0.4, 1) * (1 - i * 0.15) });
    at += rand(0.01, 0.025);
  }
  gr.push({ t: L.unlatch, len: 0.0015, amp: D.latch }, { t: L.unlatch + 0.013, len: 0.0025, amp: D.latch * 0.7 });
  playGrains(s, t, gr, s.out, 1, s.bq('bandpass', 2600, 1.6));
  knock(s, s.out, t + L.unlatch, D.latch * 0.25, 900, 0.012, 0);

  // 自己慢慢打开：合页长长地吱呀
  const dur = L.creepTo - L.creepFrom;
  const bank = creakBank(s, D.creepSpec, s.out);
  creakExcite(s, bank, t + L.creepFrom, dur * 0.55, D.creep, D.creepSpec, 0.35);
  const c2: CreakSpec = { ...D.creepSpec, rate: [21, 15, 12] };
  creakExcite(s, bank, t + L.creepFrom + dur * 0.5, dur * 0.5, D.creep * 0.7, c2, 0.2);
  return s.end(t + L.creepTo + 2.4);
};

// ── 八音盒 ───────────────────────────────────────────────────────────────────

export const MUSIC_BOX = {
  /** 每个音的峰值、走调范围（音分）、wow / flutter（赫兹，音分） */
  note: 0.2,
  detune: 15,
  wow: [0.55, 14] as const,
  flutter: [7.3, 5] as const,
  /** 发条松了以后整体往下沉多少音分 */
  sag: -70,
  /** 旋律：[拍, MIDI 音高]。D 小调 + 一个 E♭ 低音，三个乐句一句比一句低，整体下行；没有上行音阶 */
  melody: [
    [0, 86], [1, 81], [2, 82], [3, 81], [4, 77], [5, 76],
    [7, 84], [8, 81], [9, 79], [10, 77], [11, 76], [12, 74],
    [14, 77], [15, 76], [16, 70], [17.5, 69],
  ] as [number, number][],
  /** 乐句开头的低音（单音持续，不是和弦进行） */
  pedal: [[0, 62], [7, 62], [14, 63]] as [number, number][],
  pedalGain: 0.55,
  /** 一拍 = 人偶转过多少弧度 */
  beat: 0.85,
  /** 盖子：弹开、砸上 */
  lid: 0.3,
  shut: 0.55,
  wet: 0.4,
};

/** 人偶转过的角度（弧度）：和 view/props/musicBox.ts 里人偶转速的公式一致（约 0.7 圈/秒，忽快忽慢，windDown 起 0.8 秒内松到 15%） */
function musicBoxPhase(): (phase: number) => number {
  const T = MUSIC_BOX_T;
  const dt = 0.001;
  const tab: number[] = [];
  let ph = 0;
  for (let t = 0; t < T.shut; t += dt) {
    const wind = t < T.windDown ? 1 : Math.max(0.15, 1 - (t - T.windDown) / 0.8);
    ph += 4.4 * wind * (1 + 0.28 * Math.sin(t * 7.3) + 0.12 * Math.sin(t * 17.9)) * dt;
    tab.push(ph);
  }
  // 反查：转到某个角度是几秒（到不了返回 Infinity）
  return (p) => {
    let lo = 0, hi = tab.length - 1;
    if (p > tab[hi]) return Infinity;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tab[mid] < p) lo = mid + 1;
      else hi = mid;
    }
    return lo * dt;
  };
}
let mbCache: ((p: number) => number) | null = null;

export const musicBox: SfxFn = (bus, t, at) => {
  const T = MUSIC_BOX_T;
  const B = MUSIC_BOX;
  const s = new Snd(bus, { at, level: LEVEL.musicBox, wet: B.wet });
  const timeAt = (mbCache ??= musicBoxPhase());

  // 盒子的音色：小木盒没有低频，1.8 kHz 一带稍微亮一点；盖子砸上时把还在响的音按死
  const damp = s.gain(1);
  damp.gain.setValueAtTime(1, t + T.shut);
  damp.gain.setTargetAtTime(0, t + T.shut, 0.012);
  const box = s.bq('highpass', 220, 0.7);
  box.connect(s.bq('peaking', 1800, 1, 3)).connect(damp).connect(s.out);

  // 走调：wow + flutter，发条松了以后整体往下沉
  const pitch = s.gain(1);
  const wow = s.osc('sine', B.wow[0], t, t + T.end + 0.1);
  wow.connect(s.gain(B.wow[1])).connect(pitch);
  const flut = s.osc('sine', B.flutter[0], t, t + T.end + 0.1);
  flut.connect(s.gain(B.flutter[1])).connect(pitch);
  const sag = s.add(new ConstantSourceNode(s.ac, { offset: 0 }));
  sag.offset.setValueAtTime(0, t + T.windDown);
  sag.offset.linearRampToValueAtTime(B.sag, t + T.sink);
  sag.start(t);
  sag.stop(t + T.end + 0.1);
  sag.connect(pitch);

  const plucks: Grain[] = [];
  const tine = (at: number, midi: number, vel: number) => {
    const ta = t + at;
    const f = midiHz(midi);
    const tau = 0.9 * (587 / f) ** 0.6;
    const cents = rand(-B.detune, B.detune);
    const stop = Math.min(ta + tau * 6, t + T.shut + 0.1);
    const partial = (ratio: number, amp: number, decay: number, extra = 0) => {
      const o = s.osc('sine', f * ratio, ta, stop, cents + extra);
      pitch.connect(o.detune);
      const g = s.gain(0);
      perc(g.gain, ta, amp * vel * B.note, 0.002, decay);
      o.connect(g).connect(box);
    };
    partial(1, 1, tau);
    partial(1, 0.5, tau, 3.5); // 第二根簧片：差 3.5 音分，拍频的颤
    partial(5.95, 0.25, 0.06);
    partial(3.01, 0.08, 0.15);
    plucks.push({ t: at, len: 0.001, amp: 0.25 * vel });
  };
  const p0 = 0.98; // 盖子开到位（lidOpen）时人偶大约转过的角度
  for (const [beat, midi] of B.melody) {
    const at = timeAt(p0 + beat * B.beat);
    if (at < T.sink) tine(at + rand(-0.008, 0.008), midi, rand(0.85, 1));
  }
  for (const [beat, midi] of B.pedal) {
    const at = timeAt(p0 + beat * B.beat);
    if (at < T.sink) tine(at, midi, B.pedalGain);
  }
  playGrains(s, t, plucks, box, 1, s.bq('highpass', 3000));

  // 盖子：0 秒弹开（盒子一跳），4.12 砸上，再弹一下
  knock(s, s.out, t, B.lid, 520, 0.02, 0.4);
  knock(s, s.out, t + T.shut, B.shut, 380, 0.03, 0.35);
  knock(s, s.out, t + T.shut, B.shut * 0.6, 170, 0.04, 0);
  knock(s, s.out, t + (T.shut + T.end) / 2, B.shut * 0.18, 420, 0.02, 0.2);
  return s.end(t + T.end + 2.4);
};

// ── 吓跑：braam 冲击 ────────────────────────────────────────────────────────────

export const BRAAM = {
  /** [赫兹, 音量]：D1 D2 E♭2 D3 E♭3，每个音两根锯齿波 ±detune 音分 */
  voices: [[36.71, 1], [73.42, 0.9], [77.78, 0.8], [146.83, 0.35], [155.56, 0.3]] as [number, number][],
  detune: 7,
  osc: 0.13,
  /** tanh 失真的驱动 */
  drive: 2.5,
  /** 低通收拢：起点、0.35 秒、1.4 秒（赫兹），共振 Q */
  lp: [3500, 700, 280] as const,
  q: 2.2,
  amp: 0.85,
  dur: 1.5,
  noise: 0.45,
  rumble: 0.35,
  sub: 0.8,
  wet: 0.4,
};

/** t = 冲击时刻（engine.ts 已经在它前面静音了 hit-stop 那 0.15 秒） */
export const braam: SfxFn = (bus, t, at) => {
  const B = BRAAM;
  const s = new Snd(bus, { at, level: LEVEL.braam, wet: B.wet });
  const end = t + B.dur;
  const sum = s.gain(1);
  for (const [f, a] of B.voices) for (const d of [-B.detune, B.detune]) s.osc('sawtooth', f, t, end + 0.1, d).connect(s.gain(B.osc * a)).connect(sum);
  const curve = new Float32Array(1025);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(B.drive * x) / Math.tanh(B.drive);
  }
  const lp = s.bq('lowpass', B.lp[0], B.q);
  lp.frequency.setValueAtTime(B.lp[0], t);
  lp.frequency.exponentialRampToValueAtTime(B.lp[1], t + 0.35);
  lp.frequency.exponentialRampToValueAtTime(B.lp[2], t + 1.4);
  const env = s.gain(0);
  sum.connect(s.add(new WaveShaperNode(s.ac, { curve, oversample: '2x' }))).connect(lp).connect(env).connect(s.out);
  line(env.gain, t, [[0, 0], [0.006, B.amp], [0.25, B.amp * 0.7], [0.8, B.amp * 0.5], [B.dur, 0]]);

  const ng = s.gain(0);
  perc(ng.gain, t, B.noise, 0.001, 0.15);
  bandNoise(s, t, t + 1.2, 'lowpass', 2500).connect(ng).connect(s.out);
  const rg = s.gain(0);
  perc(rg.gain, t, B.rumble, 0.01, 0.5);
  bandNoise(s, t, end, 'lowpass', 350).connect(rg).connect(s.out);
  thud(s, s.out, t, B.sub, 52, 30, 0.35, 700, 0);
  return s.end(end + 2.4);
};

// ── 前门：离开、进门 ─────────────────────────────────────────────────────────────

export const FRONT = {
  /** 离开：远处闷闷的关门声（全部过 320 Hz 低通，大量混响） */
  exitThud: 0.5,
  exitNoise: 0.35,
  exitLp: 320,
  exitWet: 0.9,
  /** 进门：两下敲门 + 前门吱呀 */
  knock: 0.4,
  knockGap: 0.24,
  creak: 0.18,
  creakSpec: { rate: [20, 28, 18], res: [[520, 8, 1], [1180, 10, 0.7], [2350, 8, 0.35]], grit: 0.4 } as CreakSpec,
};

export const exitDoor: SfxFn = (bus, t, at) => {
  const s = new Snd(bus, { at, level: LEVEL.exit, wet: FRONT.exitWet });
  const far = s.bq('lowpass', FRONT.exitLp, 0.7);
  far.connect(s.out);
  thud(s, far, t, FRONT.exitThud, 60, 42, 0.12, 500, FRONT.exitNoise);
  knock(s, far, t + 0.14, 0.12, 300, 0.02, 0);
  return s.end(t + 0.4 + 2.4);
};

export const spawnDoor: SfxFn = (bus, t, at) => {
  const s = new Snd(bus, { at, level: LEVEL.spawn, wet: 0.35 });
  const outside = s.bq('lowpass', 2200, 0.7);
  outside.connect(s.out);
  for (const at of [0, FRONT.knockGap]) {
    knock(s, outside, t + at, FRONT.knock, 210, 0.05, 0.25);
    knock(s, outside, t + at, FRONT.knock * 0.4, 640, 0.03, 0);
  }
  creak(s, s.out, t + 0.55, 1.0, FRONT.creak, FRONT.creakSpec, 0.25);
  return s.end(t + 1.6 + 2.4);
};

/** 附身物件 → 声音（床的声音还没做，所以是 Partial；声音那一路补上） */
export const TRIGGER: Partial<Record<ScareType, SfxFn>> = { musicBox, door, lamp, rockingChair, portrait, mirror };
/** 物件复原 → 声音（只有台灯和肖像有「被破坏」状态） */
export const RESET: Partial<Record<ScareType, SfxFn>> = { lamp: lampReset, portrait: portraitReset };

// ── 后颈一凉：低沉的不协和涌起（不定位）──────────────────────────────────────────

export const CHILL = {
  /** [赫兹, 音量]：D2、E♭2，每个音两根锯齿波 ±detune 音分；再加 D1 正弦 */
  voices: [[73.42, 1], [77.78, 0.9]] as [number, number][],
  detune: 5,
  osc: 0.5,
  sub: 0.55,
  /** 低通：起点、最亮（赫兹） */
  lp: [160, 520] as const,
  /** 涌起秒数、撑住秒数、退掉的时间常数（秒） */
  rise: 0.7,
  hold: 0.25,
  fall: 0.55,
  amp: 0.19,
  wet: 0.35,
};

export const chillSwell: SfxFn = (bus, t, at) => {
  const C = CHILL;
  const s = new Snd(bus, { at, level: LEVEL.chill, wet: C.wet });
  const top = t + C.rise;
  const off = top + C.hold;
  const end = off + C.fall * 7;
  const lp = s.bq('lowpass', C.lp[0], 0.7);
  for (const [f, a] of C.voices) for (const d of [-C.detune, C.detune]) s.osc('sawtooth', f, t, end, d).connect(s.gain(C.osc * a)).connect(lp);
  s.osc('sine', 36.71, t, end).connect(s.gain(C.sub)).connect(lp);
  lp.frequency.setValueAtTime(C.lp[0], t);
  lp.frequency.exponentialRampToValueAtTime(C.lp[1], top);
  lp.frequency.setTargetAtTime(C.lp[0], off, C.fall);
  const env = s.gain(0);
  lp.connect(env).connect(s.out);
  env.gain.setValueAtTime(0.0003, t);
  env.gain.exponentialRampToValueAtTime(C.amp, top);
  env.gain.setValueAtTime(C.amp, off);
  env.gain.setTargetAtTime(0, off, C.fall);
  return s.end(end + 2.2);
};
