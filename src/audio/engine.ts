// 声音系统入口：AudioContext、主总线、混响，把模拟事件分派给各个声音（设计文档 4. 声音）。
// 各声音的配方写在 sfx.ts（物件、冲击音、前门、后颈一凉的涌起）、voices.ts（尖叫、吸气、发毛）、ambience.ts（环境层）、
// footsteps.ts（脚步）、ghost.ts（鬼魂）的开头注释里；3D 声像和隔墙遮挡在 space.ts。
//
// 总线
//   物件 / 冲击 → 声像 → sfx ┐
//   尖叫 / 吸气 → 声像 → voice ┼→ duck（吓跑前静音 hit-stop 那 0.15 秒）→ master（静音开关，0.1 秒渐变）→ 限幅器 → 软削波 → 输出
//   环境层 → amb → ambHush → ambDuck ──┤
//   混响送入口 → 高通 90 Hz → Convolver（代码生成的 2.2 秒衰减噪声）→ 回送 ┘
//   声像：俯视（娃娃屋）模式是 StereoPanner，按物体在屏幕上的横坐标（createAudio 的 pan）；第三人称调过 setListener 之后
//     是 HRTF 的 PannerNode，听者在镜头处（space.ts）。braam、后颈一凉的涌起、环境层的持续音和风、鬼魂的冷风不定位
//   ambHush 是现身时环境声的「让路」（压低 12 dB，ghost.ts），ambDuck 是吓跑前的静音（silence），两个各管各的、乘在一起
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
//   - chill（第三人称：鬼魂贴在访客身后）：neck 为假是发毛（模拟约每 0.7 秒结算一次）：这一下涨了 0.3 以上才出声
//     （和模拟的 GHOST.holdMin 一样：再小的寒意不算被吓），同一个人 2.8–5 秒最多一声发抖的吸气，同时最多 2 声；
//     neck 为真是「后颈一凉」：倒吸一口气（从他身上出来）+ 低沉的不协和涌起（不定位，2.5 秒内不重复涌起），同一个人 1.5 秒内不重复。
//     模拟在同一步紧跟着给这个人一个 startle（object = 'ghost'）：不再放 gasp（已经倒吸过了），尖叫照放，但挪到这口气之后；
//     紧张度也只由那个 startle 加（不重复加）。同一帧里他被吓跑了：只留 braam 和逃跑的尖叫（这口气会被 hit-stop 的静音吞掉）
//   - 现身（2026-10-28，manifest 事件，配方在 ghost.ts 开头）：windup / drop / end 三个节拍转给 createManifestSound；drop 同一批里真的放了 braam 时
//     （有人被吓跑、而且离上一声 braam 超过 BRAAM_GAP）冲击让给它，冷气挪到静音之后；有人被吓跑但这一批没放 braam（0.8 秒内上一声还没响完）冲击照放
//     （现身的冲击不算 braamAt：否则现身后 0.8 秒内吓跑的人就没有 braam 了）
//   - 被手电照到（reveal 事件）：lit 集合里有人就淡入压力声（ghost.ts 的 createRevealLayer），空了就淡出。lit 不能只靠 on / off 事件：
//     模拟那边走了的人（mode = gone，下一步就从 npcs 里删掉）不会再有 off，逃跑中的人又不理会鬼魂（canBeScared），所以 tick 每帧最先调 sync，
//     把 lit 里「已经不在 state.npcs 里 / gone / fleeing」的人清掉，没人了压力声就淡出，不会一直响下去（tests/audio.test.ts 守着）。
//     AudioContext 没在 running（挂起、Safari 的 interrupted、resume 还没完成）时不攒声音，但 reveal 的 on / off 是模拟的状态不是声音，
//     照样用 note 记进 lit，恢复后第一帧的 sync 把压力声对上（不然这几帧的 on / off 丢了，压力声要等下一次照到 / 移开才对得上；tests/audio-engine.test.ts 守着）
//   - 察觉（notice 事件）：只有手电照到鬼魂（kind = ghost）时那个人倒吸一口很轻的气（调研 3.1），同一个人 NOTICE_GAP 秒内最多一次；其余种类没有声音
//   - 机关（trap 事件）：armed 一声极轻的冰裂声（不定位，只有玩家听得见）；sprung 走物件本来的 trigger 声；expired 无声
//   - 喘气、呜咽：不是事件，是恐惧值的函数，每帧由 breath.ts 排程（凑近才听得见，耳朵是鬼魂）
//   - 声音里出任何异常只警告一次、绝不往外抛：主循环里一个异常就会让 three 的动画循环停掉；建总线失败（极老的浏览器）就安静地没有声音。
//     每帧 3D 的几步（脚步、喘气、space.update）各用各的 guard：一步坏了别的步骤照样跑（喘气坏了，隔墙遮挡也不该跟着停）
//   - unlock 之前 update 什么都不做；unlock 之后再调只在 AudioContext 被挂起时 resume，几乎零开销
import { FRONT_DOOR } from '../config/house';
import { FEAR, HIT_STOP } from '../config/visitors';
import type { FrameCtx, GhostState, Module } from '../engine/types';
import type { NpcState, ScareType, SimEvent, Vec2, WorldState } from '../sim/types';
import { AMB, DREAD, createAmbience, dreadTarget, type Ambience } from './ambience';
import { createBreath, type Breath } from './breath';
import { createCrowd, type Crowd } from './footsteps';
import { createGhostSound, createManifestSound, createRevealLayer, type GhostSound } from './ghost';
import { RESET, TRIGGER, braam, chillSwell, exitDoor, rand, spawnDoor, trapArm, type Bus } from './sfx';
import { createSpace, type Place, type Space, type Vec3 } from './space';
import { NECK, SCREAM, gasp, neckGasp, scream, shiver } from './voices';

export type { Vec3 } from './space';

export interface AudioSys extends Module {
  /** 必须在用户的点击里调用（开场遮罩的点击）；之后 AudioContext 被挂起时，下一次点击里再调用一次即可恢复 */
  unlock(): Promise<void>;
  setMuted(m: boolean): void;
  readonly muted: boolean;
  /** 标签页隐藏时暂停整个 AudioContext（静音的话混响、持续音、噪声还在算，挂几小时很耗电），回来时恢复 */
  setSuspended(s: boolean): void;
  /**
   * 第三人称：听者（镜头）的位置和朝向，房屋米坐标（x 向东、z 向南、y 离地高度）；forward 不必归一化，只取水平方向。
   * 每帧调。调过一次之后新起的声音都按 3D 定位（HRTF + 隔墙遮挡），访客有脚步声，环境层略微抬起；
   * 从来没调过就一直是俯视模式：按 createAudio 的 pan 做立体声声像，没有脚步声。unlock 之前调也可以（先记着）
   */
  setListener(pos: Vec3, forward: Vec3): void;
  /** 第三人称的鬼魂，每帧调；null = 没有鬼魂（开场前、俯视模式）。穿墙时「呼」一声，飘动时有极轻的冷风；隔墙遮挡也从鬼魂的位置算 */
  setGhost(g: GhostState | null): void;
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
/** 3D 时物件的声音从多高出来（米）：灯罩、画框、镜面中间…… */
export const SOURCE_Y: Record<ScareType, number> = { musicBox: 0.62, door: 1.0, lamp: 1.36, rockingChair: 0.5, portrait: 1.05, mirror: 1.1, bed: 0.55, wardrobe: 1.1 };
/** 3D 时访客没有常驻声道（超过 footsteps.ts 的 FOOT.voices 个人）时，他的声音从多高出来；前门的声音多高 */
const VOICE_Y = 0.9;
const DOOR_Y = 1.0;
/** 现身时鬼魂身上的声音（冷气、灯暗一下的咔哒）从多高出来（米） */
const GHOST_Y = 1.4;
/** 手电照到鬼魂时那个人倒吸一口气：同一个人多久之内最多一次（秒）；0 = 不要这口气 */
export const NOTICE_GAP = 4;
/**
 * chill：发毛的间隔范围（秒，每人）、同时最多几声、这一下至少涨多少恐惧值才出声、涨多少算满（发毛的音量按它在 0.55–1 之间）；
 * 后颈一凉每人多久不重复、涌起多久不重复、startle 多久之内算同一下
 */
export const CHILL_GAP = { shiver: [2.8, 5] as [number, number], maxShivers: 2, minAmount: 0.3, fullAmount: 1.2, neck: 1.5, swell: 2.5, startle: 0.6 };

export interface MixBus extends Bus {
  duck: GainNode;
  ambDuck: GainNode;
  ambHush: GainNode;
  master: GainNode;
  space: Space;
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
  const ambHush = new GainNode(ac, { gain: 1 });
  ambHush.connect(ambDuck);
  const amb = new GainNode(ac);
  amb.connect(ambHush);
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
  const space = createSpace(ac, reverb);
  return { ac, sfx, voice, amb, reverb, noise: noiseBuffer(ac), pulse: pulseWave(ac), duck, ambDuck, ambHush, master, space };
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
  /**
   * AudioContext 没在跑（挂起、Safari 的 interrupted、resume 还没完成）时收到的事件：不出声（恢复之后一下子放出一串过时的声音更糟），
   * 只有「谁在照鬼魂」（reveal 的 on / off）照样记进名单——那是模拟的状态，不是声音；压力声在恢复后第一次 sync 里对到名单上。别的事件什么也不做
   */
  note(e: SimEvent): void;
  /**
   * 每帧：把 lit（手电照着鬼魂的人）对齐到模拟。不在 state.npcs 里的（走了、被删掉）、mode 是 gone 或 fleeing 的人一律清掉
   * （他们不会再有 reveal off，或者根本不再理会鬼魂），清完没人了压力声就淡出。离线测量里没有「每帧」，不用调
   */
  sync(state: WorldState, t: number): void;
  /** 最近被吓的紧张度（环境层用；由调用方按 DREAD.tensionTau 衰减） */
  tension: number;
}

/** crowd：每个访客跟着走的声道（3D 时用；不给就在事件发生的位置定位） */
export function createRouter(bus: MixBus, pan: (p: Vec2) => number, crowd?: Crowd): Router {
  /** 正在响的尖叫的结束时刻 */
  let screamEnds: number[] = [];
  /** 每个访客上一声尖叫的结束时刻 */
  const screamUntil = new Map<number, number>();
  let braamAt = -1e9;
  /** chill：每个访客下一次可以发毛的时刻、上一次后颈一凉的时刻和那口气结束的时刻；正在响的发毛的结束时刻；上一次涌起 */
  const shiverNext = new Map<number, number>();
  const neckAt = new Map<number, number>();
  const neckEnd = new Map<number, number>();
  let shiverEnds: number[] = [];
  let swellAt = -1e9;
  /** 现身的声音、被照到的压力声、此刻手电照着鬼魂的人、每个人上一次「照到鬼魂时倒吸气」的时刻 */
  const manifest = createManifestSound(bus);
  const reveal = createRevealLayer(bus);
  const lit = new Set<number>();
  /** 名单在没出声的时候变过（note）：下一次 sync 要把压力声对一遍 */
  let litDirty = false;
  const noticeAt = new Map<number, number>();
  const P = (p: Vec2 | undefined) => {
    if (!p) return 0;
    try {
      const v = pan(p);
      return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    } catch {
      return 0;
    }
  };
  const is3d = () => bus.space.active;
  /** 访客发声的位置：3D 时是他的常驻声道（跟着走），没有就是他此刻的位置；俯视时是声像 */
  const placeNpc = (n: NpcState): Place => (is3d() ? (crowd?.voice(n) ?? { x: n.pos.x, y: VOICE_Y, z: n.pos.z }) : P(n.pos));
  const placeAt = (p: Vec2 | undefined, y: number): Place => (!p ? 0 : is3d() ? { x: p.x, y, z: p.z } : P(p));
  const tryScream = (n: NpcState, at: number, dur?: number) => {
    screamEnds = screamEnds.filter((e) => e > bus.ac.currentTime);
    if (screamEnds.length >= MAX_SCREAMS) return;
    const end = scream(bus, at, { id: n.id, personality: n.personality, at: placeNpc(n), dur });
    screamEnds.push(end - 0.3);
    screamUntil.set(n.id, end - 0.3);
  };

  const r: Router = {
    tension: 0,
    note(e) {
      if (e.type !== 'reveal') return;
      if (e.on) lit.add(e.npc);
      else lit.delete(e.npc);
      litDirty = true;
    },
    sync(state, t) {
      let changed = litDirty;
      litDirty = false;
      for (const id of lit) {
        const n = state.npcs.find((x) => x.id === id);
        // 还在屋里、没在逃跑的人才可能还照着鬼魂（sim/npc.ts 的 canBeScared：逃跑中和已离开的不算）
        if (n && n.mode !== 'gone' && n.mode !== 'fleeing') continue;
        lit.delete(id);
        changed = true;
      }
      if (changed) reveal.set(lit.size > 0, t);
    },
    play(batch, state, t) {
      const fleeing = new Set<number>();
      const necks = new Set<number>();
      for (const e of batch) {
        if (e.type === 'flee') fleeing.add(e.npc);
        if (e.type === 'chill' && e.neck) necks.add(e.npc);
      }
      // 同一帧里有人被吓跑：先静音，再 braam；这一帧的尖叫都挪到静音之后
      let voiceAt = t + SCREAM.delay;
      /** 这一批真的放了 braam（BRAAM_GAP 之内的吓跑不放：上一声还没响完）：现身落下的冲击要不要让路，看的是它，不是「有人被吓跑」 */
      let braamed = false;
      if (fleeing.size) {
        voiceAt = t + HIT_STOP + 0.02;
        if (t - braamAt > BRAAM_GAP) {
          silence(bus, t, HIT_STOP);
          braam(bus, t + HIT_STOP, 0);
          braamAt = t;
          braamed = true;
        }
      }
      const npc = (id: number) => state.npcs.find((n) => n.id === id);
      const obj = (id: string) => state.objects.find((o) => o.id === id);
      const screamed = new Set<number>();
      const bump = (x: number) => (r.tension = Math.min(DREAD.tensionMax, r.tension + x));
      /** 这个人刚刚（这一批里，或 0.6 秒内）后颈一凉过：返回那口气结束的时刻 */
      const neckBreath = (id: number) =>
        necks.has(id) ? t + NECK.dur + 0.03 : t - (neckAt.get(id) ?? -1e9) < CHILL_GAP.startle ? (neckEnd.get(id) ?? t) + 0.03 : null;

      for (const e of batch) {
        switch (e.type) {
          case 'trigger': {
            const o = obj(e.object);
            TRIGGER[e.scareType](bus, t, placeAt(o?.pos, SOURCE_Y[e.scareType]));
            break;
          }
          case 'reset': {
            const o = obj(e.object);
            if (o) RESET[o.type]?.(bus, t, placeAt(o.pos, SOURCE_Y[o.type]));
            break;
          }
          case 'startle': {
            const n = npc(e.npc);
            bump(DREAD.bump.startle * Math.min(1, e.amount / 30) + (e.scream ? DREAD.bump.scream : 0));
            if (!n) break;
            const neck = neckBreath(n.id);
            if (e.scream || fleeing.has(e.npc)) {
              if (!screamed.has(n.id)) tryScream(n, neck === null ? voiceAt : Math.max(voiceAt, neck), fleeing.has(n.id) ? FEAR.screamTime : undefined);
              screamed.add(n.id);
            } else if (neck === null) gasp(bus, t + 0.03, { id: n.id, personality: n.personality, at: placeNpc(n), strong: e.object !== null });
            break;
          }
          case 'chill': {
            const n = npc(e.npc);
            if (!n) break;
            if (e.neck) {
              // 紧跟着的 startle 会加紧张度；同一帧被吓跑的话 braam 盖过一切
              if (fleeing.has(n.id) || t - (neckAt.get(n.id) ?? -1e9) < CHILL_GAP.neck) break;
              const who = { id: n.id, personality: n.personality, at: placeNpc(n) };
              neckAt.set(n.id, t);
              neckEnd.set(n.id, neckGasp(bus, t, who));
              if (t - swellAt > CHILL_GAP.swell) {
                chillSwell(bus, t + 0.02, 0);
                swellAt = t;
              }
              break;
            }
            // 发毛：这一批里他已经被吓到 / 后颈一凉了就不再发抖
            if (necks.has(n.id) || batch.some((x) => x.type === 'startle' && x.npc === n.id)) break;
            if (e.amount < CHILL_GAP.minAmount || t < (shiverNext.get(n.id) ?? -1e9)) break;
            shiverEnds = shiverEnds.filter((x) => x > bus.ac.currentTime);
            if (shiverEnds.length >= CHILL_GAP.maxShivers) break;
            shiverNext.set(n.id, t + rand(CHILL_GAP.shiver[0], CHILL_GAP.shiver[1]));
            bump(DREAD.bump.chill);
            const k = Math.min(1, Math.max(0.55, e.amount / CHILL_GAP.fullAmount));
            shiverEnds.push(shiver(bus, t, { id: n.id, personality: n.personality, at: placeNpc(n), strength: k }) - 0.4);
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
            shiverNext.delete(e.npc);
            neckAt.delete(e.npc);
            neckEnd.delete(e.npc);
            noticeAt.delete(e.npc);
            if (lit.delete(e.npc)) reveal.set(lit.size > 0, t);
            exitDoor(bus, t, placeAt(FRONT_DOOR.outside, DOOR_Y));
            break;
          case 'spawn':
            spawnDoor(bus, t, placeAt(FRONT_DOOR.outside, DOOR_Y));
            break;
          case 'manifest': {
            const at = placeAt(e.pos, GHOST_Y);
            if (e.phase === 'windup') manifest.windup(t, at);
            else if (e.phase === 'drop') {
              // 这一批放了 braam（吓跑自己有 braam 和静音）：冲击让给它，冷气挪到静音之后。有人被吓跑但这一批没放 braam
              // （0.8 秒内上一声还没响完）：现身自己的冲击照放，不然落下的那一下几乎没声音
              manifest.drop(t, at, braamed ? { hit: false, breathDelay: HIT_STOP + 0.05 } : {});
            } else manifest.end(t, at);
            break;
          }
          case 'reveal':
            if (e.on) lit.add(e.npc);
            else lit.delete(e.npc);
            reveal.set(lit.size > 0, t);
            break;
          case 'notice': {
            // 手电照到鬼魂：那个人倒吸一口很轻的气。其余的察觉（声音、发毛、现身蓄力）没有声音：声源自己已经响过了
            if (e.kind !== 'ghost' || !(NOTICE_GAP > 0)) break;
            const n = npc(e.npc);
            if (!n || t - (noticeAt.get(n.id) ?? -1e9) < NOTICE_GAP) break;
            noticeAt.set(n.id, t);
            gasp(bus, t + 0.05, { id: n.id, personality: n.personality, at: placeNpc(n), strong: false });
            break;
          }
          case 'trap':
            // 设下：一声极轻的冰裂声，只有玩家听得见（不定位）。sprung 走物件的 trigger 声，expired 无声
            if (e.phase === 'armed') trapArm(bus, t, 0);
            break;
        }
      }
    },
  };
  return r;
}

type Ctor = typeof AudioContext;

/** pan：把房屋坐标转换成 -1..1 的声像（主会话用相机的 toScreen 实现；第三人称调过 setListener 之后不再用它） */
export function createAudio(pan: (p: Vec2) => number): AudioSys {
  let ac: AudioContext | null = null;
  let bus: MixBus | null = null;
  let amb: Ambience | null = null;
  let router: Router | null = null;
  let crowd: Crowd | null = null;
  let breath: Breath | null = null;
  let ghostSnd: GhostSound | null = null;
  let muted = false;
  let queue: SimEvent[] = [];
  let queueState: WorldState | null = null;
  let pending = false;
  let dread = 0;
  let dreadClock = 0;
  /** unlock 之前就调了 setListener：先记着，建好总线时补上 */
  let listener: { pos: Vec3; fwd: Vec3 } | null = null;
  let ghost: GhostState | null = null;
  /** 环境层的第三人称抬升做过没有 */
  let presence = false;
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
    if (!batch.length || !state || !ac || !router) return;
    const r = router;
    if (ac.state !== 'running') {
      // 排队时还在跑、放出去之前被挂起了：不放声音，被照到的名单照样记账
      for (const e of batch) r.note(e);
      return;
    }
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
          crowd = createCrowd(b);
          breath = createBreath(b, crowd);
          ghostSnd = createGhostSound(b);
          router = createRouter(b, pan, crowd);
          if (listener) b.space.setListener(listener.pos, listener.fwd);
        } catch (err) {
          console.warn('audio unavailable', err);
          failed = true;
          void ac?.close().catch(() => {});
          ac = bus = amb = router = crowd = breath = ghostSnd = null;
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

    setListener(pos, forward) {
      if (!pos || !forward) return;
      const l = (listener ??= { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: -1 } });
      l.pos.x = pos.x;
      l.pos.y = pos.y;
      l.pos.z = pos.z;
      l.fwd.x = forward.x;
      l.fwd.y = forward.y;
      l.fwd.z = forward.z;
      const b = bus;
      if (b) guard(() => b.space.setListener(l.pos, l.fwd));
    },

    setGhost(g) {
      ghost = g;
      const b = bus;
      const gs = ghostSnd;
      if (!b || !gs || !ac || ac.state !== 'running') return;
      const now = ac.currentTime + LOOKAHEAD;
      guard(() => {
        b.space.setEar(g ? { x: g.x, z: g.z } : null);
        gs.set(g, now);
      });
    },

    onEvent(e, state) {
      // 还没解锁：没有 router，没地方记账
      if (!ac || !router) return;
      // 被挂起 / 恢复中不攒事件：恢复之后一下子放出一串过时的声音更糟。但「谁在照鬼魂」是模拟的状态不是声音，照样记账，
      // 恢复后第一帧的 sync 把压力声对上（不然这几帧里的 on / off 丢了，压力声和模拟对不上）
      if (ac.state !== 'running') {
        router.note(e);
        return;
      }
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
      crowd = null;
      breath = null;
      ghostSnd = null;
    },
  };

  /** 每帧：先对齐被照到的名单（sync）；紧张度衰减、按平均恐惧值推 dread（每 0.25 秒写一次参数）、安排环境层的嘎吱；3D 时挪声道、落脚步、排喘气、重算遮挡 */
  function tick(ctx: FrameCtx) {
    if (!ac || !amb || !router || !bus) return;
    // 最先对一次「谁在照鬼魂」：下面任何一步抛了异常（guard 兜着），也不会让走了的人留在 lit 里把压力声一直开着
    router.sync(ctx.state, ac.currentTime + LOOKAHEAD);
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
    const now = ac.currentTime;
    if (dreadClock <= 0) {
      dreadClock = 0.25;
      amb.setDread(dread, now);
    }
    amb.update(now);
    const space = bus.space;
    if (!space.active) return;
    if (!presence) {
      presence = true;
      amb.setPresence(AMB.presence3d, now);
    }
    // 鬼魂不在了（开场前、主会话没再调 setGhost）也要从听者算遮挡
    if (!ghost) space.setEar(null);
    // 下面三步各用各的 guard：一步抛了异常（照样只警告一次）不拖累后面的——喘气坏了，space.update（重算隔墙遮挡）也不该跟着停
    guard(() => crowd?.update(ctx.state.npcs, now + LOOKAHEAD, ctx.dt));
    // 喘气、呜咽：耳朵是鬼魂（玩家就是它），不是镜头
    guard(() => breath?.update(ctx.state.npcs, now + LOOKAHEAD, ctx.dt, ghost));
    guard(() => space.update(now));
  }

  return sys;
}
