// 声音系统入口：AudioContext、主总线、混响，把模拟事件分派给各个声音（设计文档 4. 声音）。
// 各声音的配方写在 sfx.ts（物件、冲击音、前门）、voices.ts（尖叫、吸气）、ambience.ts（环境层）的开头注释里。
//
// 总线
//   物件 / 冲击 → 声像 → sfx ┐
//   尖叫 / 吸气 → 声像 → voice ┼→ duck（吓跑前静音 hit-stop 那 0.15 秒）→ master（静音开关，0.1 秒渐变）→ 限幅器 → 软削波 → 输出
//   环境层 → amb → ambDuck ──┤
//   混响送入口 → 高通 90 Hz → Convolver（代码生成的 2.2 秒衰减噪声）→ 回送 ┘
// 限幅器是 DynamicsCompressorNode，阈值贴近天花板，平时几乎不动作，只在几个声音叠在一起时压一下；
// 它后面再接一个 WaveShaper 软削波：-4 dBFS 以下是直线，以上用 tanh 弯到 -1.2 dBFS，峰值保证不会超过 -1 dBFS。
// 注意：Web Audio 规范里压缩器自带 makeup 增益（这组参数实测 +1.9 dB），dev/audio.html 测的指标都是走完整条总线之后的。
//
// 时序
//   - onEvent 只把事件攒起来，同一帧的事件在 update（或一个微任务）里一起处理：同一帧里有人被吓跑时，
//     这一帧的尖叫要挪到静音之后，所以必须先看完整批事件
//   - 吓跑（flee）：立刻把 duck 拉到 0（8 毫秒），静音 HIT_STOP 秒，然后 braam 和逃跑的那声尖叫一起进来；
//     环境层多空一会儿（braam 之后 3 秒左右才慢慢回来）。0.8 秒内再有人被吓跑，不再重复静音和 braam
//   - 附身物件的声音不挪：画面（物件动画）在 hit-stop 期间照常走，声音跟画面对齐，最多前 0.15 秒被静音盖掉
//   - 同时最多 3 声尖叫，多了丢弃；每个声音结束后断开节点（sfx.ts 的 Snd.end）
//   - 声音里出任何异常只警告一次、绝不往外抛：主循环里一个异常就会让 three 的动画循环停掉；建总线失败（极老的浏览器）就安静地没有声音
//   - unlock 之前 update 什么都不做；unlock 之后再调只在 AudioContext 被挂起时 resume，几乎零开销
import { FRONT_DOOR } from '../config/house';
import { FEAR, HIT_STOP } from '../config/visitors';
import type { FrameCtx, Module } from '../engine/types';
import type { NpcState, SimEvent, Vec2, WorldState } from '../sim/types';
import { DREAD, createAmbience, dreadTarget, type Ambience } from './ambience';
import { RESET, TRIGGER, braam, exitDoor, spawnDoor, type Bus } from './sfx';
import { SCREAM, gasp, scream } from './voices';

export interface AudioSys extends Module {
  /** 必须在用户的点击里调用（开场遮罩的点击）；之后 AudioContext 被挂起时，下一次点击里再调用一次即可恢复 */
  unlock(): Promise<void>;
  setMuted(m: boolean): void;
  readonly muted: boolean;
  /** 标签页隐藏时暂停整个 AudioContext（静音的话混响、持续音、噪声还在算，挂几小时很耗电），回来时恢复 */
  setSuspended(s: boolean): void;
}

/** 主音量 */
export const MASTER = 1;
/** 限幅器（DynamicsCompressorNode）和后面的软削波 */
export const LIMIT = { threshold: -4, knee: 2, ratio: 20, attack: 0.002, release: 0.15, linearDb: -4, ceilingDb: -1.2 };
/** 混响：长度（秒）、预延迟、送入高通、回送音量 */
export const REVERB = { seconds: 2.2, predelay: 0.012, highpass: 90, ret: 0.55 };
/** 同时最多几声尖叫 */
export const MAX_SCREAMS = 3;
/** 事件到声音起点的提前量（秒）：比「立刻」稍晚一点，包络的开头不会被截掉 */
const LOOKAHEAD = 0.01;
/** 两次 braam 至少隔多久 */
const BRAAM_GAP = 0.8;

export interface MixBus extends Bus {
  duck: GainNode;
  ambDuck: GainNode;
  master: GainNode;
}

/** 软削波曲线：|x| ≤ linear 时原样通过，以上用 tanh 弯到 ceiling（输入超出 ±1 时 WaveShaper 取端点，仍在 ceiling 以内） */
function softClip(n = 2049): Float32Array<ArrayBuffer> {
  const K = 10 ** (LIMIT.linearDb / 20);
  const C = 10 ** (LIMIT.ceilingDb / 20);
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = Math.sign(x) * (a <= K ? a : K + (C - K) * Math.tanh((a - K) / (C - K)));
  }
  return c;
}

/** 混响的冲激响应：双声道去相关的噪声，指数衰减到 -60 dB，越往后越暗（一阶低通的截止频率随时间降），前 40 毫秒几个早期反射 */
function impulse(ac: BaseAudioContext): AudioBuffer {
  const sr = ac.sampleRate;
  const n = Math.floor(sr * REVERB.seconds);
  const b = new AudioBuffer({ numberOfChannels: 2, length: n, sampleRate: sr });
  const pre = Math.floor(REVERB.predelay * sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    let lp = 0;
    let a = 1;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      if ((i & 63) === 0) a = 1 - Math.exp((-2 * Math.PI * (7000 * Math.exp(-t * 1.6) + 900)) / sr);
      lp += a * (Math.random() * 2 - 1 - lp);
      d[i] = lp * Math.exp((-6.9 * t) / REVERB.seconds) * Math.min(1, t / 0.004);
    }
    for (const [ms, g] of [[7, 0.5], [13, -0.4], [19, 0.3], [29, -0.25], [37, 0.2]]) {
      const i = pre + Math.floor(((ms + ch * 1.7) / 1000) * sr);
      if (i < n) d[i] += g * 0.3;
    }
  }
  return b;
}

/** 4 秒白噪声 */
function noiseBuffer(ac: BaseAudioContext): AudioBuffer {
  const b = new AudioBuffer({ numberOfChannels: 1, length: Math.floor(ac.sampleRate * 4), sampleRate: ac.sampleRate });
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** 窄脉冲：128 个余弦谐波，前 60% 等幅、后面余弦渐弱（浏览器会按奈奎斯特频率自动截掉过高的） */
function pulseWave(ac: BaseAudioContext): PeriodicWave {
  const N = 128;
  const real = new Float32Array(N + 1);
  const imag = new Float32Array(N + 1);
  for (let k = 1; k <= N; k++) {
    const u = k / N;
    real[k] = u < 0.6 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (u - 0.6)) / 0.4);
  }
  return new PeriodicWave(ac, { real, imag });
}

/** 建一整套总线（实时的 AudioContext 和 dev 页面测量用的 OfflineAudioContext 共用） */
export function createBus(ac: BaseAudioContext): MixBus {
  const master = new GainNode(ac, { gain: MASTER });
  const comp = new DynamicsCompressorNode(ac, {
    threshold: LIMIT.threshold,
    knee: LIMIT.knee,
    ratio: LIMIT.ratio,
    attack: LIMIT.attack,
    release: LIMIT.release,
  });
  // 不过采样：过采样的重建滤波会让峰值略微冲过曲线的上限
  const clip = new WaveShaperNode(ac, { curve: softClip(), oversample: 'none' });
  master.connect(comp).connect(clip).connect(ac.destination);
  const duck = new GainNode(ac, { gain: 1 });
  duck.connect(master);
  const ambDuck = new GainNode(ac, { gain: 1 });
  ambDuck.connect(duck);
  const amb = new GainNode(ac);
  amb.connect(ambDuck);
  const sfx = new GainNode(ac);
  sfx.connect(duck);
  const voice = new GainNode(ac);
  voice.connect(duck);
  const reverb = new GainNode(ac);
  const conv = new ConvolverNode(ac, { buffer: impulse(ac) });
  reverb
    .connect(new BiquadFilterNode(ac, { type: 'highpass', frequency: REVERB.highpass }))
    .connect(conv)
    .connect(new GainNode(ac, { gain: REVERB.ret }))
    .connect(duck);
  return { ac, sfx, voice, amb, reverb, noise: noiseBuffer(ac), pulse: pulseWave(ac), duck, ambDuck, master };
}

/** 吓跑前的静音：t 起 8 毫秒内拉到 0，hold 秒后回到 1；环境层多空一会儿再慢慢回来 */
export function silence(bus: MixBus, t: number, hold: number) {
  const g = bus.duck.gain;
  g.cancelScheduledValues(t);
  g.setTargetAtTime(0, t, 0.0025);
  g.setValueAtTime(0, t + hold - 0.003);
  g.linearRampToValueAtTime(1, t + hold);
  const a = bus.ambDuck.gain;
  a.cancelScheduledValues(t);
  a.setTargetAtTime(0, t, 0.003);
  a.setValueAtTime(0, t + hold + 1);
  a.setTargetAtTime(1, t + hold + 1, 1.2);
}

/** 把一批模拟事件变成声音（实时和离线测量共用） */
export interface Router {
  play(batch: readonly SimEvent[], state: WorldState, t: number): void;
  /** 最近被吓的紧张度（环境层用；由调用方按 DREAD.tensionTau 衰减） */
  tension: number;
}

export function createRouter(bus: MixBus, pan: (p: Vec2) => number): Router {
  /** 正在响的尖叫的结束时刻 */
  let screamEnds: number[] = [];
  /** 每个访客上一声尖叫的结束时刻 */
  const screamUntil = new Map<number, number>();
  let braamAt = -1e9;
  const P = (p: Vec2 | undefined) => {
    if (!p) return 0;
    try {
      const v = pan(p);
      return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    } catch {
      return 0;
    }
  };
  const tryScream = (n: NpcState, at: number, dur?: number) => {
    screamEnds = screamEnds.filter((e) => e > bus.ac.currentTime);
    if (screamEnds.length >= MAX_SCREAMS) return;
    const end = scream(bus, at, { id: n.id, personality: n.personality, pan: P(n.pos), dur });
    screamEnds.push(end - 0.3);
    screamUntil.set(n.id, end - 0.3);
  };

  const r: Router = {
    tension: 0,
    play(batch, state, t) {
      const fleeing = new Set<number>();
      for (const e of batch) if (e.type === 'flee') fleeing.add(e.npc);
      // 同一帧里有人被吓跑：先静音，再 braam；这一帧的尖叫都挪到静音之后
      let voiceAt = t + SCREAM.delay;
      if (fleeing.size) {
        voiceAt = t + HIT_STOP + 0.02;
        if (t - braamAt > BRAAM_GAP) {
          silence(bus, t, HIT_STOP);
          braam(bus, t + HIT_STOP, 0);
          braamAt = t;
        }
      }
      const npc = (id: number) => state.npcs.find((n) => n.id === id);
      const obj = (id: string) => state.objects.find((o) => o.id === id);
      const screamed = new Set<number>();
      const bump = (x: number) => (r.tension = Math.min(DREAD.tensionMax, r.tension + x));

      for (const e of batch) {
        switch (e.type) {
          case 'trigger':
            TRIGGER[e.scareType](bus, t, P(obj(e.object)?.pos));
            break;
          case 'reset': {
            const o = obj(e.object);
            if (o) RESET[o.type]?.(bus, t, P(o.pos));
            break;
          }
          case 'startle': {
            const n = npc(e.npc);
            bump(DREAD.bump.startle * Math.min(1, e.amount / 30) + (e.scream ? DREAD.bump.scream : 0));
            if (!n) break;
            if (e.scream || fleeing.has(e.npc)) {
              if (!screamed.has(n.id)) tryScream(n, voiceAt, fleeing.has(n.id) ? FEAR.screamTime : undefined);
              screamed.add(n.id);
            } else gasp(bus, t + 0.03, { id: n.id, personality: n.personality, pan: P(n.pos), strong: e.object !== null });
            break;
          }
          case 'heard':
            bump(DREAD.bump.heard);
            break;
          case 'flee': {
            bump(DREAD.bump.flee);
            const n = npc(e.npc);
            // 逃跑的那个人：这一帧没叫过、也不在叫，就补一声长的
            if (n && !screamed.has(n.id) && (screamUntil.get(n.id) ?? 0) < t + 0.3) tryScream(n, voiceAt, FEAR.screamTime);
            if (n) screamed.add(n.id);
            break;
          }
          case 'exit':
            screamUntil.delete(e.npc);
            exitDoor(bus, t, P(FRONT_DOOR.outside));
            break;
          case 'spawn':
            spawnDoor(bus, t, P(FRONT_DOOR.outside));
            break;
        }
      }
    },
  };
  return r;
}

type Ctor = typeof AudioContext;

/** pan：把房屋坐标转换成 -1..1 的声像（主会话用相机的 toScreen 实现） */
export function createAudio(pan: (p: Vec2) => number): AudioSys {
  let ac: AudioContext | null = null;
  let bus: MixBus | null = null;
  let amb: Ambience | null = null;
  let router: Router | null = null;
  let muted = false;
  let queue: SimEvent[] = [];
  let queueState: WorldState | null = null;
  let pending = false;
  let dread = 0;
  let dreadClock = 0;
  /** 建总线失败过（极老的浏览器没有节点构造函数）：不再每次点击都重试 */
  let failed = false;
  let warned = false;
  /** 声音出错只警告一次，绝不往外抛：主循环里一个异常就会让 three 的动画循环停掉 */
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (!warned) console.warn('audio error (sound keeps going, game unaffected)', err);
      warned = true;
    }
  };

  const flush = () => {
    pending = false;
    const batch = queue;
    const state = queueState;
    queue = [];
    queueState = null;
    if (!batch.length || !state || !ac || !router || ac.state !== 'running') return;
    const r = router;
    const t = ac.currentTime + LOOKAHEAD;
    guard(() => r.play(batch, state, t));
  };

  const sys: AudioSys = {
    get muted() {
      return muted;
    },

    unlock() {
      if (failed) return Promise.resolve();
      if (!ac) {
        const C: Ctor | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext;
        if (!C) return Promise.resolve();
        try {
          const c = (ac = new C({ latencyHint: 'interactive' }));
          // iOS：手势里同步放一个静音的单样本，音频会话才算真正解锁
          const blip = new AudioBufferSourceNode(c, { buffer: new AudioBuffer({ length: 1, sampleRate: c.sampleRate }) });
          blip.connect(c.destination);
          blip.start();
          const b = (bus = createBus(c));
          b.master.gain.value = muted ? 0 : MASTER;
          amb = createAmbience(b);
          amb.start(c.currentTime + 0.05);
          router = createRouter(b, pan);
        } catch (err) {
          console.warn('audio unavailable', err);
          failed = true;
          void ac?.close().catch(() => {});
          ac = bus = amb = router = null;
          return Promise.resolve();
        }
      }
      // 'suspended'，或 Safari 的 'interrupted'（来电、切到别的 App）
      if (ac.state !== 'running' && ac.state !== 'closed') return ac.resume().catch(() => {});
      return Promise.resolve();
    },

    setSuspended(s) {
      if (!ac || ac.state === 'closed') return;
      // 恢复不需要手势：这个 AudioContext 当初是在点击里启动的。Safari 不让的话，下一次点击 / 按键里的 unlock 会补上
      void (s ? ac.suspend() : ac.resume()).catch(() => {});
    },

    setMuted(m) {
      muted = m;
      if (!ac || !bus) return;
      const g = bus.master.gain;
      const now = ac.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(m ? 0 : MASTER, now + 0.1);
    },

    onEvent(e, state) {
      // 还没解锁、或被挂起时不攒事件：恢复之后一下子放出一串过时的声音更糟
      if (!ac || ac.state !== 'running') return;
      queue.push(e);
      queueState = state;
      if (!pending) {
        pending = true;
        queueMicrotask(flush);
      }
    },

    update(ctx: FrameCtx) {
      if (!ac || !amb || !router) return;
      flush();
      if (ac.state !== 'running') return;
      guard(() => tick(ctx));
    },

    dispose() {
      queue = [];
      void ac?.close().catch(() => {});
      ac = null;
      bus = null;
      amb = null;
      router = null;
    },
  };

  /** 每帧：紧张度衰减、按平均恐惧值推 dread（每 0.25 秒写一次参数）、安排环境层的嘎吱 */
  function tick(ctx: FrameCtx) {
    if (!ac || !amb || !router) return;
    router.tension *= Math.exp(-ctx.dt / DREAD.tensionTau);
    // 逃跑中的人不算：吓跑之后环境层跟着松下来，是一次「释放」
    let sum = 0;
    let n = 0;
    for (const v of ctx.state.npcs) {
      if (v.mode === 'fleeing' || v.mode === 'gone') continue;
      sum += v.fear;
      n++;
    }
    const target = dreadTarget(n ? sum / n : 0, router.tension);
    dread += (target - dread) * (1 - Math.exp(-ctx.dt / (target > dread ? DREAD.up : DREAD.down)));
    dreadClock -= ctx.dt;
    if (dreadClock <= 0) {
      dreadClock = 0.25;
      amb.setDread(dread, ac.currentTime);
    }
    amb.update(ac.currentTime);
  }

  return sys;
}
