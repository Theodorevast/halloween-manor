// 声音沙盒：每个声音一个按钮（实时，走真正的 createAudio）；「Render all offline」把每个声音用 OfflineAudioContext
// 走完整条总线（限幅器、软削波、混响）渲染出来，量峰值、RMS、时长，结果 console.log 并写到 window.__audioReport。
// Playwright：
//   node scripts/shot.mjs http://127.0.0.1:5735/dev/audio.html shots/audio.png --wait 1000 \
//     --eval "window.renderAll()" --eval-wait 8000 --eval "JSON.stringify(window.__audioReport)"
//   window.__audio.bench() → 第一次 / 再次 unlock 的同步耗时、脚步样本现算的耗时（毫秒）
//   window.renderAll(seed?) → Promise<Row[]>；window.renderOne(name, seed?) 只渲染一个（seed 默认 12345，换种子看随机部分的离散）；window.__audio = { sys, state, fire(name) }
//   window.renderRaw(name, seed?) → 原始采样（左右声道 Float32Array），画频谱图、量包络用
// 指标口径：
//   peak    整段（含混响尾巴）的采样峰值，dBFS
//   rms     「声音窗」里的 RMS（两个声道合起来）：画面上这件事发生的那段时间（台灯 0–1.2、肖像 0–1.3……），不含混响尾巴
//   rmsMax  400 毫秒滑动窗的最大 RMS（最响的那一下有多响）
//   dur     从起点到最后一个超过 -60 dBFS 的采样（含混响尾巴）
//   lr      声音窗里左声道比右声道响多少 dB（3D 定位的左右检查：声源在左边应为正）
//   cent    声音窗的频谱质心（赫兹）：脚步声木地板 / 瓷砖 / 地毯的明暗对比
//   rmsA    声音窗的 A 计权 RMS（dBFS）：小声的、频谱差别大的声音（脚步、气声、低频涌起）比响度时看这个，比 rms 接近听感
// 第三人称（3D）的几组（calib3d、step、ghost、chill、3d、manifest、reveal、breath、bed）都先在总线的 space 上 setListener，再放声音：
//   听者站在走廊、客厅、厨房、卧室里（房屋米坐标，离地 1.8 米，大致是第三人称镜头的高度）
// 2026-10-28 新增的几组（现身 manifest、被照到 reveal、访客喘气呜咽 breath、床 bed、机关 trap、手电照到鬼魂时那口气 notice）：
//   有 events / timeline 的出实时按钮（走真正的 createAudio，timeline 是 [相对点击的秒数, 事件]，用 setTimeout 按时刻发出，和模拟的节拍一致）；
//   喘气、呜咽是恐惧值的函数，没有事件：第三人称区有演示按钮（访客站在鬼魂面前，恐惧值从低涨到高），离线版直接喂 breath.ts
import { FRONT_DOOR, HOUSE_W, PROPS, propCenter } from '../src/config/house';
import { createAmbience, dreadTarget, AMB } from '../src/audio/ambience';
import { createBreath } from '../src/audio/breath';
import { createAudio, createBus, createRouter, type MixBus, type Router } from '../src/audio/engine';
import { createCrowd, stepBanks } from '../src/audio/footsteps';
import { createGhostSound, wallWhoosh } from '../src/audio/ghost';
import { Snd, bandNoise, braam, lightClick, rng } from '../src/audio/sfx';
import type { Vec3 } from '../src/audio/space';
import { coldBreath, whimper } from '../src/audio/voices';
import type { GhostState } from '../src/engine/types';
import { idleManifest } from '../src/sim/manifest';
import type { NpcMode, NpcState, Personality, ScareType, SimEvent, Vec2, WorldState } from '../src/sim/types';

const SR = 48000;
/** 每个声音从 0.05 秒开始（前面留一点空，看得出起音） */
const T0 = 0.05;
const pan = (p: Vec2) => Math.max(-1, Math.min(1, (p.x / HOUSE_W) * 2 - 1)) * 0.8;

// ── 假的模拟状态：全部物件 + 三个访客（三种性格） ─────────────────────────────
const npc = (id: number, name: string, personality: Personality, pos: Vec2): NpcState => ({
  id, name, personality, pos, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
});
const HOME: Vec2[] = [{ x: 3.5, z: 2.5 }, { x: 8, z: 6 }, { x: 12.5, z: 9 }];
const state: WorldState = {
  time: 0,
  npcs: [npc(1, 'Mia', 'timid', { ...HOME[0] }), npc(2, 'Theo', 'average', { ...HOME[1] }), npc(3, 'Nora', 'brave', { ...HOME[2] })],
  objects: PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 })),
  scaredOff: 0,
  hitStop: 0,
  manifest: idleManifest(),
  avoid: [],
};
const objId = (type: ScareType) => state.objects.find((o) => o.type === type)!.id;
const trig = (type: ScareType): SimEvent => ({ type: 'trigger', object: objId(type), scareType: type });
const reset = (type: ScareType): SimEvent => ({ type: 'reset', object: objId(type) });
const startle = (id: number, scream: boolean, object: string | null = 'portrait', amount = 32): SimEvent => ({ type: 'startle', npc: id, object, amount, scream });
/** 和模拟一样：发毛约每 0.7 秒一个（amount 是这一下涨的恐惧值）；后颈一凉是 chill（neck）+ 同一步一个 object 为 'ghost' 的 startle */
const chill = (id: number, amount = 1): SimEvent => ({ type: 'chill', npc: id, amount, neck: false });
const neckScare = (id: number, amount: number): SimEvent[] => [
  { type: 'chill', npc: id, amount, neck: true },
  { type: 'startle', npc: id, object: 'ghost', amount, scream: amount >= 15 },
];
/** 现身的三个节拍（模拟：蓄力 0.6 秒、停留 1.5 秒，见 config/visitors.ts 的 MANIFEST）；pos 是鬼魂此刻的位置 */
const MAN_POS: Vec2 = { x: 4, z: 6 };
const man = (phase: 'windup' | 'drop' | 'end', scared: number[] = []): SimEvent => ({ type: 'manifest', phase, pos: MAN_POS, scared });
const MAN_LINE: [number, SimEvent][] = [[0, man('windup')], [0.6, man('drop', [2])], [2.1, man('end')]];
const reveal = (id: number, on: boolean): SimEvent => ({ type: 'reveal', npc: id, on });
const trap = (object: string, phase: 'armed' | 'sprung' | 'expired'): SimEvent => ({ type: 'trap', object, phase });

// ── 3D 场景：听者的站位、走路的路线 ────────────────────────────────────────
const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
const EAST = v3(1, 0, 0), WEST = v3(-1, 0, 0), NORTH = v3(0, 0, -1), SOUTH = v3(0, 0, 1);
/** 走廊西头，面朝东：正前方 2.5 米也在走廊里（没有墙） */
const HALL_W = v3(2, 1.6, 6);
/** 走廊中间，鬼魂站在 (8, 6.2)、镜头在它身后 1.4 米（面朝北）：喘气、呜咽的站位 */
const HALL_MID = v3(8, 1.9, 7.6);
const GHOST_AT: Vec2 = { x: 8, z: 6.2 };

/** 沿折线走：每帧（1/60 秒）返回位置 */
function* walkPath(path: Vec2[], speed: number): Generator<Vec2> {
  let k = 0;
  let p = { ...path[0] };
  yield p;
  const step = speed / 60;
  while (k < path.length - 1) {
    let left = step;
    while (left > 0 && k < path.length - 1) {
      const q = path[k + 1];
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      if (d <= left) {
        p = { ...q };
        left -= d;
        k++;
      } else {
        p = { x: p.x + ((q.x - p.x) * left) / d, z: p.z + ((q.z - p.z) * left) / d };
        left = 0;
      }
    }
    yield p;
  }
}

/** 离线：一个访客沿 path 走，按 60 帧/秒喂给脚步模块（声道的移动按时刻排进参数时间线） */
function simulateWalk(bus: MixBus, t: number, who: NpcState, path: Vec2[], speed: number, mode: NpcMode, seconds: number) {
  const crowd = createCrowd(bus, true);
  const w: NpcState = { ...who, pos: { ...path[0] }, mode, speed };
  const it = walkPath(path, speed);
  for (let f = 0; f < seconds * 60; f++) {
    const n = it.next();
    if (!n.done) w.pos = n.value;
    else w.speed = 0;
    crowd.update([w], t + f / 60, 1 / 60);
  }
}

/** 离线：一个访客站在 pos，恐惧值 fear，耳朵（鬼魂）在 ear；按 60 帧/秒喂给喘气模块 */
function simulateBreath(bus: MixBus, t: number, who: NpcState, pos: Vec2, ear: Vec2, fear: number, seconds: number) {
  const crowd = createCrowd(bus, true);
  const breath = createBreath(bus, crowd);
  const w: NpcState = { ...who, pos: { ...pos }, mode: 'wander', speed: 0, fear, nervous: fear >= 60 };
  for (let f = 0; f < seconds * 60; f++) {
    crowd.update([w], t + f / 60, 1 / 60);
    breath.update([w], t + f / 60, 1 / 60, ear);
  }
}
/** 站在鬼魂正前方 d 米处的访客喘气（先摆好听者） */
const breathAt = (who: number, fear: number, d: number, seconds: number) => (bus: MixBus, _r: Router, t: number) => {
  listen(bus, HALL_MID, NORTH);
  simulateBreath(bus, t, state.npcs.find((x) => x.id === who)!, { x: GHOST_AT.x, z: GHOST_AT.z - d }, GHOST_AT, fear, seconds);
};

const LIVING_WALK: Vec2[] = [{ x: 6, z: 2 }, { x: 10, z: 2 }];
const KITCHEN_WALK: Vec2[] = [{ x: 11.6, z: 3.2 }, { x: 15, z: 3.2 }];
const RUG_WALK: Vec2[] = [{ x: 3, z: 6 }, { x: 7, z: 6 }];
const STUDY_WALK: Vec2[] = [{ x: 1.5, z: 2.6 }, { x: 4.6, z: 2.6 }];

// ── 声音清单（按钮和离线测量共用） ─────────────────────────────────────────
type Group = 'ambience' | 'scare' | 'lure' | 'voice' | 'other' | 'stress' | 'calib' | 'calib3d' | 'step' | 'ghost' | 'chill' | '3d' | 'manifest' | 'reveal' | 'breath' | 'bed' | 'trap';
interface Case {
  name: string;
  group: Group;
  /** 渲染总长（秒） */
  seconds: number;
  /** RMS 窗（相对起点，秒） */
  win: [number, number];
  /** 设计时长（画面上这件事持续多久，秒）；只用于报告 */
  nominal: number;
  /** 实时按钮发的事件（没有就不出按钮） */
  events?: SimEvent[];
  /** 实时按钮按时刻发的事件：[相对点击的秒数, 事件]；离线渲染时同样按这些时刻放（现身的三个节拍） */
  timeline?: [number, SimEvent][];
  /** 离线渲染：在 t 时刻放这个声音 */
  render(bus: MixBus, router: Router, t: number): void;
  /** 断言：rms 应该落在这个范围（dBFS） */
  rmsRange?: [number, number];
  /** 断言：左右差（dB）的符号：1 = 左边响、-1 = 右边响、0 = 差不多（±2 dB） */
  side?: -1 | 0 | 1;
}
const viaRouter = (events: SimEvent[]) => (_bus: MixBus, router: Router, t: number) => router.play(events, state, t);
const viaTimeline = (tl: [number, SimEvent][]) => (_bus: MixBus, router: Router, t: number) => {
  for (const [at, e] of tl) router.play([e], state, t + at);
};
const ambience = (d: number, presence = 0) => (bus: MixBus, _r: Router, t: number) => {
  const a = createAmbience(bus);
  a.start(t, 0.5);
  a.setDread(d, t);
  if (presence) a.setPresence(presence, 0);
};
/** 3D：先放好听者（和遮挡的耳朵） */
const listen = (bus: MixBus, pos: Vec3, fwd: Vec3) => {
  bus.space.setListener(pos, fwd);
  bus.space.setEar(null);
};
/** 粉红一点的噪声（-3 dB/倍频程附近）：校准 HRTF 和立体声的响度 */
const pinkAt = (at: number | Vec3) => (bus: MixBus, _r: Router, t: number) => {
  const s = new Snd(bus, { at });
  const g = s.gain(0.25);
  bandNoise(s, t, t + 2, 'lowpass', 6000, 0.5).connect(g);
  bandNoise(s, t, t + 2, 'lowpass', 900, 0.5).connect(s.gain(0.8)).connect(g);
  bandNoise(s, t, t + 2, 'lowpass', 150, 0.5).connect(s.gain(0.5)).connect(g);
  g.connect(s.out);
  s.end(t + 2.1);
};
/** 3D 下的访客：放到 pos，带上声道 */
const at3d = (bus: MixBus, router: Router, t: number, id: number, pos: Vec2, events: SimEvent[]) => {
  const n = state.npcs.find((x) => x.id === id)!;
  const keep = { ...n.pos };
  n.pos = { ...pos };
  router.play(events, state, t);
  n.pos = keep;
  void bus;
};

const CASES: Case[] = [
  { name: 'calibration -20 dBFS sine', group: 'calib', seconds: 1, win: [0.2, 0.9], nominal: 1, render: (bus, _r, t) => {
    const o = new OscillatorNode(bus.ac, { frequency: 1000 });
    o.connect(new GainNode(bus.ac, { gain: 0.1 * Math.SQRT2 })).connect(bus.sfx);
    o.start(t);
    o.stop(t + 0.9);
  } },
  { name: 'ambience fear 0', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(0) },
  { name: 'ambience avg fear 70', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(dreadTarget(70, 0)) },
  { name: 'ambience dread max', group: 'ambience', seconds: 14, win: [3, 13.9], nominal: 0, render: ambience(1) },
  { name: 'ambient creak', group: 'ambience', seconds: 4, win: [0, 1], nominal: 1, render: (bus, _r, t) => createAmbience(bus).creak(t, 0, false) },
  { name: 'ambient settle', group: 'ambience', seconds: 4, win: [0, 0.5], nominal: 0.5, render: (bus, _r, t) => createAmbience(bus).creak(t, 0, true) },
  { name: 'trigger lamp', group: 'scare', seconds: 2, win: [0, 1.2], nominal: 1.12, events: [trig('lamp')], render: viaRouter([trig('lamp')]) },
  { name: 'trigger rockingChair', group: 'scare', seconds: 7.5, win: [0, 5.6], nominal: 5.6, events: [trig('rockingChair')], render: viaRouter([trig('rockingChair')]) },
  { name: 'trigger portrait', group: 'scare', seconds: 4, win: [0, 1.3], nominal: 1.3, events: [trig('portrait')], render: viaRouter([trig('portrait')]) },
  { name: 'trigger mirror', group: 'scare', seconds: 4, win: [0, 1.0], nominal: 1.0, events: [trig('mirror')], render: viaRouter([trig('mirror')]) },
  { name: 'flee (braam + scream)', group: 'scare', seconds: 4.5, win: [0.15, 1.65], nominal: 1.65, events: [startle(2, true), { type: 'flee', npc: 2 }], render: viaRouter([startle(2, true), { type: 'flee', npc: 2 }]) },
  { name: 'braam alone', group: 'scare', seconds: 4, win: [0, 1.5], nominal: 1.5, render: (bus, _r, t) => void braam(bus, t, 0) },
  { name: 'trigger musicBox', group: 'lure', seconds: 6.5, win: [0, 4.12], nominal: 4.25, events: [trig('musicBox')], render: viaRouter([trig('musicBox')]) },
  { name: 'trigger door', group: 'lure', seconds: 7.5, win: [0, 0.6], nominal: 5.1, events: [trig('door')], render: viaRouter([trig('door')]) },
  { name: 'reset lamp', group: 'other', seconds: 3, win: [0, 1.2], nominal: 0.65, events: [reset('lamp')], render: viaRouter([reset('lamp')]) },
  { name: 'reset portrait', group: 'other', seconds: 4, win: [0, 1.1], nominal: 1.05, events: [reset('portrait')], render: viaRouter([reset('portrait')]) },
  { name: 'scream timid', group: 'voice', seconds: 1.6, win: [0.07, 0.97], nominal: 0.9, events: [startle(1, true)], render: viaRouter([startle(1, true)]) },
  { name: 'scream average', group: 'voice', seconds: 1.6, win: [0.07, 0.87], nominal: 0.8, events: [startle(2, true)], render: viaRouter([startle(2, true)]) },
  { name: 'scream brave', group: 'voice', seconds: 1.6, win: [0.07, 0.72], nominal: 0.65, events: [startle(3, true)], render: viaRouter([startle(3, true)]) },
  { name: 'gasp (heard a scream)', group: 'voice', seconds: 1, win: [0.03, 0.24], nominal: 0.21, events: [startle(2, false, null, 5)], render: viaRouter([startle(2, false, null, 5)]) },
  { name: 'gasp (startled, no scream)', group: 'voice', seconds: 1, win: [0.03, 0.27], nominal: 0.24, events: [startle(3, false, 'lamp-living', 10)], render: viaRouter([startle(3, false, 'lamp-living', 10)]) },
  { name: 'exit', group: 'other', seconds: 3.5, win: [0, 0.4], nominal: 0.4, events: [{ type: 'exit', npc: 9, name: 'Leo', total: 1 }], render: viaRouter([{ type: 'exit', npc: 9, name: 'Leo', total: 1 }]) },
  { name: 'spawn', group: 'other', seconds: 4, win: [0, 1.6], nominal: 1.6, events: [{ type: 'spawn', npc: 1 }], render: viaRouter([{ type: 'spawn', npc: 1 }]) },
  {
    name: 'stress: mirror + 3 screams + flee + door + dread max',
    group: 'stress',
    seconds: 5,
    win: [0, 2],
    nominal: 2,
    render: (bus, router, t) => {
      ambience(1)(bus, router, t);
      router.play([trig('mirror'), trig('door'), trig('lamp'), startle(1, true), startle(2, true), startle(3, true), { type: 'flee', npc: 1 }], state, t);
    },
  },

  // ── 第三人称：校准、左右、距离、遮挡 ──
  // HRTF 和立体声居中的响度对比：两行的 rms 差就是 space.ts 的 SPACE.trim 该补的量
  { name: 'calib3d: pink noise, stereo center', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, render: pinkAt(0) },
  { name: 'calib3d: pink noise, HRTF front 2.5 m', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, side: 0, render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    pinkAt(v3(4.5, 1.6, 6))(bus, r, t);
  } },
  // 同一个声源（走廊里 x 4.5），听者转身：面朝南时它在左边，面朝北时在右边
  { name: 'calib3d: HRTF source on the left', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, side: 1, render: (bus, r, t) => {
    listen(bus, HALL_W, SOUTH);
    pinkAt(v3(4.5, 1.6, 6))(bus, r, t);
  } },
  { name: 'calib3d: HRTF source on the right', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, side: -1, render: (bus, r, t) => {
    listen(bus, HALL_W, NORTH);
    pinkAt(v3(4.5, 1.6, 6))(bus, r, t);
  } },
  { name: 'calib3d: HRTF front 5 m', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    pinkAt(v3(7, 1.6, 6))(bus, r, t);
  } },
  { name: 'calib3d: HRTF front 10 m', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    pinkAt(v3(12, 1.6, 6))(bus, r, t);
  } },
  // 隔墙：听者在走廊（4, 6），声源在书房里 3 米外（4, 3），中间是书房南墙；对照组同样 3 米但在走廊里
  { name: 'calib3d: 3 m, open hall', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, render: (bus, r, t) => {
    listen(bus, v3(4, 1.6, 6), EAST);
    pinkAt(v3(7, 1.0, 6))(bus, r, t);
  } },
  { name: 'calib3d: 3 m, behind the study wall', group: 'calib3d', seconds: 2.4, win: [0.2, 1.9], nominal: 0, render: (bus, r, t) => {
    listen(bus, v3(4, 1.6, 6), NORTH);
    pinkAt(v3(4, 1.0, 3))(bus, r, t);
  } },

  // ── 脚步声 ──
  { name: 'step: wood walk 1.3 m/s, 2–3 m (living room)', group: 'step', seconds: 4.5, win: [0, 3.1], nominal: 0, rmsRange: [-50, -30], render: (bus, _r, t) => {
    listen(bus, v3(8, 1.8, 4.2), NORTH);
    simulateWalk(bus, t, state.npcs[1], LIVING_WALK, 1.3, 'wander', 3.4);
  } },
  { name: 'step: tile walk 1.3 m/s, 1–2 m (kitchen)', group: 'step', seconds: 4.5, win: [0, 2.6], nominal: 0, rmsRange: [-50, -30], render: (bus, _r, t) => {
    listen(bus, v3(13.25, 1.8, 4.2), NORTH);
    simulateWalk(bus, t, state.npcs[1], KITCHEN_WALK, 1.3, 'wander', 2.9);
  } },
  { name: 'step: rug walk 1.3 m/s, 1–2 m (hall runner)', group: 'step', seconds: 4.5, win: [0, 3.1], nominal: 0, rmsRange: [-56, -34], render: (bus, _r, t) => {
    listen(bus, v3(5, 1.8, 6.8), NORTH);
    simulateWalk(bus, t, state.npcs[1], RUG_WALK, 1.3, 'wander', 3.4);
  } },
  { name: 'step: nervous walk 1.7 m/s (living room)', group: 'step', seconds: 3.5, win: [0, 2.35], nominal: 0, rmsRange: [-50, -30], render: (bus, _r, t) => {
    listen(bus, v3(8, 1.8, 4.2), NORTH);
    simulateWalk(bus, t, { ...state.npcs[1], nervous: true }, LIVING_WALK, 1.7, 'wander', 2.6);
  } },
  { name: 'step: run (fleeing) 3.2 m/s (living room)', group: 'step', seconds: 2.5, win: [0, 1.25], nominal: 0, rmsRange: [-46, -26], render: (bus, _r, t) => {
    listen(bus, v3(8, 1.8, 4.2), NORTH);
    simulateWalk(bus, t, state.npcs[1], LIVING_WALK, 3.2, 'fleeing', 1.4);
  } },
  { name: 'step: wood walk through a wall, 4–6 m (study, heard from living room)', group: 'step', seconds: 4, win: [0, 2.4], nominal: 0, rmsRange: [-62, -38], render: (bus, _r, t) => {
    listen(bus, v3(8, 1.8, 2.6), WEST);
    simulateWalk(bus, t, state.npcs[1], STUDY_WALK, 1.3, 'wander', 2.6);
  } },

  // ── 鬼魂 ──
  { name: 'ghost: wall whoosh, 2 m ahead', group: 'ghost', seconds: 3.5, win: [0, 1.1], nominal: 1.1, rmsRange: [-40, -22], render: (bus, _r, t) => {
    listen(bus, HALL_W, EAST);
    const port = bus.space.port(v3(4, 1.4, 6), bus.sfx);
    wallWhoosh(bus, t, port);
  } },
  { name: 'ghost: cold air bed at full speed', group: 'ghost', seconds: 4, win: [1.5, 3.9], nominal: 0, rmsRange: [-60, -44], render: (bus, _r, t) => {
    listen(bus, HALL_W, EAST);
    const gs = createGhostSound(bus);
    const g: GhostState = { x: 4, y: 1.4, z: 6, heading: 0, speed: 2.5, inWall: false };
    gs.set(g, t);
  } },

  // ── chill ──
  { name: 'chill: shiver, amount 1.0 (2.5 m ahead)', group: 'chill', seconds: 2.5, win: [0, 0.6], nominal: 0.42, rmsRange: [-50, -30], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    at3d(bus, r, t, 2, { x: 4.5, z: 6 }, [chill(2, 1)]);
  } },
  { name: 'chill: shiver, amount 0.4 (weak, 2.5 m ahead)', group: 'chill', seconds: 2.5, win: [0, 0.6], nominal: 0.42, rmsRange: [-54, -32], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    at3d(bus, r, t, 2, { x: 4.5, z: 6 }, [chill(2, 0.4)]);
  } },
  { name: 'chill: neck (sharp gasp + low swell)', group: 'chill', seconds: 5, win: [0, 1.0], nominal: 1, rmsRange: [-40, -18], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    at3d(bus, r, t, 2, { x: 4.5, z: 6 }, neckScare(2, 12));
  } },
  { name: 'chill: neck swell alone (non-positional)', group: 'chill', seconds: 5, win: [0, 1.2], nominal: 1, render: (bus, r, t) => {
    // 后颈一凉，但访客声道在 30 米外（吸气几乎没有）：只量涌起
    listen(bus, HALL_W, EAST);
    at3d(bus, r, t, 2, { x: 15.5, z: 11.5 }, neckScare(2, 12));
  } },
  { name: 'chill: neck + scream (amount 20, same frame)', group: 'chill', seconds: 5, win: [0, 1.3], nominal: 1.2, render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    at3d(bus, r, t, 2, { x: 4.5, z: 6 }, neckScare(2, 20));
  } },

  // ── 第三人称：环境层、整体 ──
  { name: '3d: ambience fear 0 (+2 dB presence)', group: '3d', seconds: 14, win: [6, 13.9], nominal: 0, rmsRange: [-60, -30], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    ambience(0, AMB.presence3d)(bus, r, t);
  } },
  { name: '3d: ambient creak, 6 m, next room', group: '3d', seconds: 4, win: [0, 1], nominal: 1, render: (bus, _r, t) => {
    listen(bus, v3(8, 1.8, 6), NORTH);
    const a = createAmbience(bus);
    a.setPresence(AMB.presence3d, t);
    a.creak(t, v3(3, 0.05, 2.5), false);
  } },
  // ── 现身（manifest）：蓄力 0.6 秒 → 落下 → 停留 1.5 秒 → 收回；鬼魂在听者正前方 2 米 ──
  { name: 'manifest: full (windup → drop 0.6 s → end 2.1 s) over ambience', group: 'manifest', seconds: 10, win: [2, 4.1], nominal: 0, timeline: MAN_LINE, render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    ambience(0, AMB.presence3d)(bus, r, t);
    viaTimeline(MAN_LINE)(bus, r, t + 2);
  } },
  { name: 'manifest: windup only (drone + 2 light clicks + ambience hush)', group: 'manifest', seconds: 6, win: [0, 2], nominal: 0, rmsRange: [-42, -28], events: [man('windup')], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    r.play([man('windup')], state, t);
  } },
  { name: 'manifest: drop only (low hit + cold breath)', group: 'manifest', seconds: 4, win: [0, 1], nominal: 0, rmsRange: [-30, -18], events: [man('drop', [2])], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    r.play([man('drop', [2])], state, t);
  } },
  { name: 'manifest: drop with a flee in the same frame (hit yields to braam)', group: 'manifest', seconds: 5, win: [0, 1.7], nominal: 0, rmsRange: [-20, -9], events: [man('drop', [2]), startle(2, true), { type: 'flee', npc: 2 }], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    r.play([man('drop', [2]), startle(2, true), { type: 'flee', npc: 2 }], state, t);
  } },
  { name: 'manifest: light click alone', group: 'manifest', seconds: 1.5, win: [0, 0.3], nominal: 0, render: (bus, _r, t) => {
    listen(bus, HALL_W, EAST);
    lightClick(bus, t, v3(4, 1.4, 6));
  } },
  { name: 'manifest: cold breath alone', group: 'manifest', seconds: 2.5, win: [0, 0.5], nominal: 0, rmsRange: [-40, -27], render: (bus, _r, t) => {
    listen(bus, HALL_W, EAST);
    coldBreath(bus, t, v3(4, 1.4, 6));
  } },

  // ── 被手电照到（reveal）：压力声 ──
  { name: 'reveal: on (steady pressure layer)', group: 'reveal', seconds: 4, win: [1, 3.5], nominal: 0, rmsRange: [-39, -27], events: [reveal(2, true)], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    r.play([reveal(2, true)], state, t);
  } },
  { name: 'reveal: on → off 2.5 s later (fade in 0.4 s, out 0.8 s)', group: 'reveal', seconds: 5, win: [0.2, 3.5], nominal: 0, rmsRange: [-40, -27], timeline: [[0, reveal(2, true)], [2.5, reveal(2, false)]], render: (bus, r, t) => {
    listen(bus, HALL_W, EAST);
    viaTimeline([[0.2, reveal(2, true)], [2.7, reveal(2, false)]])(bus, r, t);
  } },
  { name: 'notice: flashlight finds the ghost (soft gasp, Theo 2.5 m ahead)', group: 'voice', seconds: 1.5, win: [0.03, 0.4], nominal: 0, rmsRange: [-60, -34],
    events: [{ type: 'notice', npc: 2, kind: 'ghost', src: GHOST_AT }], render: (bus, r, t) => {
      listen(bus, HALL_W, EAST);
      at3d(bus, r, t, 2, { x: 4.5, z: 6 }, [{ type: 'notice', npc: 2, kind: 'ghost', src: GHOST_AT }]);
    } },

  // ── 访客喘气、呜咽（恐惧值的函数）：鬼魂在 (8, 6.2)，访客站在它正前方 d 米，镜头在鬼魂身后 1.4 米 ──
  { name: 'breath: fear 60 (period 2.2 s), 0.8 m', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-49, -36], render: breathAt(2, 60, 0.8, 7.6) },
  { name: 'breath: fear 80 (period 1.75 s), 0.8 m', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-47, -34], render: breathAt(2, 80, 0.8, 7.6) },
  { name: 'breath: fear 100 (period 1.3 s), 0.8 m', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-45, -32], render: breathAt(2, 100, 0.8, 7.6) },
  { name: 'breath: fear 80, 1.5 m', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-56, -43], render: breathAt(2, 80, 1.5, 7.6) },
  { name: 'breath: fear 80, 2.0 m (edge of hearing)', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-68, -53], render: breathAt(2, 80, 2.0, 7.6) },
  { name: 'breath: fear 80, 3.0 m (beyond reach, silent)', group: 'breath', seconds: 8, win: [0.9, 7.4], nominal: 0, rmsRange: [-Infinity, -90], render: breathAt(2, 80, 3.0, 7.6) },
  { name: 'breath: fear 59 (below nervous, silent)', group: 'breath', seconds: 5, win: [0.5, 4.5], nominal: 0, rmsRange: [-Infinity, -90], render: breathAt(2, 59, 0.8, 4.6) },
  { name: 'whimper: timid (Mia), 0.8 m', group: 'breath', seconds: 2, win: [0, 0.6], nominal: 0, rmsRange: [-43, -30], render: (bus, _r, t) => {
    listen(bus, HALL_MID, NORTH);
    whimper(bus, t, { id: 1, personality: 'timid', at: bus.space.port(v3(8, 0.6, 5.4), bus.voice) });
  } },
  { name: 'whimper: average (Theo), 0.8 m', group: 'breath', seconds: 2, win: [0, 0.6], nominal: 0, rmsRange: [-43, -30], render: (bus, _r, t) => {
    listen(bus, HALL_MID, NORTH);
    whimper(bus, t, { id: 2, personality: 'average', at: bus.space.port(v3(8, 0.6, 5.4), bus.voice) });
  } },
  { name: 'whimper: brave (Nora), 0.8 m', group: 'breath', seconds: 2, win: [0, 0.6], nominal: 0, rmsRange: [-43, -30], render: (bus, _r, t) => {
    listen(bus, HALL_MID, NORTH);
    whimper(bus, t, { id: 3, personality: 'brave', at: bus.space.port(v3(8, 0.6, 5.4), bus.voice) });
  } },
  { name: 'breath + whimper schedule: fear 90, 0.8 m, 14 s', group: 'breath', seconds: 15, win: [1, 14.5], nominal: 0, rmsRange: [-46, -33], render: breathAt(2, 90, 0.8, 14.5) },

  // ── 床（trigger bed）和机关（trap armed）──
  { name: 'trigger bed (cloth 0–1.3, muffled breath 1.25–1.95, silence, drop 2.6)', group: 'bed', seconds: 8, win: [0, 3.2], nominal: 0, rmsRange: [-38, -26], events: [trig('bed')], render: viaRouter([trig('bed')]) },
  { name: '3d: trigger bed, listener 2.5 m east of the pillow', group: 'bed', seconds: 8, win: [0, 3.2], nominal: 0, rmsRange: [-42, -30], render: (bus, r, t) => {
    listen(bus, v3(3.4, 1.8, 10), WEST);
    r.play([trig('bed')], state, t);
  } },
  { name: 'trap: armed (very light ice crack, not positional)', group: 'trap', seconds: 2, win: [0, 0.5], nominal: 0, rmsRange: [-68, -52], events: [trap('bed', 'armed')], render: viaRouter([trap('bed', 'armed')]) },

  { name: '3d: object sounds 3 m ahead (portrait)', group: '3d', seconds: 4, win: [0, 1.3], nominal: 1.3, rmsRange: [-24, -10], render: (bus, r, t) => {
    // 书房里，肖像在 (3.75, 0.75)，听者在它南边 3 米（第三人称：鬼魂 1 米、镜头再往后 2 米）
    listen(bus, v3(3.75, 1.8, 3.75), NORTH);
    r.play([trig('portrait')], state, t);
  } },
  { name: '3d: mirror 2 m + scream 3 m + whoosh + 2 walkers', group: 'stress', seconds: 5, win: [0, 2], nominal: 2, render: (bus, r, t) => {
    // 浴室：镜子在 (11.25, 8.75)，听者在它东边
    listen(bus, v3(13.25, 1.8, 8.75), WEST);
    ambience(1, AMB.presence3d)(bus, r, t);
    r.play([trig('mirror')], state, t);
    at3d(bus, r, t + 0.6, 3, { x: 12.5, z: 10.5 }, [startle(3, true), { type: 'flee', npc: 3 }]);
    wallWhoosh(bus, t + 0.2, bus.space.port(v3(12.25, 1.4, 8.75), bus.sfx));
    simulateWalk(bus, t, state.npcs[0], [{ x: 14.5, z: 8 }, { x: 14.5, z: 11 }], 3.2, 'fleeing', 1);
    simulateWalk(bus, t, state.npcs[1], [{ x: 11.6, z: 10.8 }, { x: 14, z: 10.8 }], 1.3, 'wander', 2);
  } },
];

// ── 离线测量 ─────────────────────────────────────────────────────────────
interface Row {
  name: string;
  group: Group;
  nominal: number;
  dur: number;
  peak: number;
  rms: number;
  rmsMax: number;
  /** 峰值出现的时刻（秒，相对起点） */
  peakAt: number;
  /** 声音窗里左声道比右声道响多少 dB */
  lr: number;
  /** 声音窗的频谱质心（赫兹） */
  cent: number;
  /** 声音窗的 A 计权 RMS（dBFS） */
  rmsA: number;
  /** 重击时刻：10 毫秒包络的局部最大值，不低于峰值 15 dB、比前 80 毫秒的最小值高 6 dB 以上（相隔至少 60 毫秒）。环境层不算 */
  hits: number[];
  ok: boolean;
  notes: string;
}
const dB = (x: number) => (x > 0 ? Math.round(200 * Math.log10(x)) / 10 : -Infinity);

/** 原地 FFT（基 2），re / im 长度为 2 的幂 */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k);
        const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k + len / 2] = re[i + k] - xr;
        im[i + k + len / 2] = im[i + k] - xi;
        re[i + k] += xr;
        im[i + k] += xi;
      }
    }
  }
}

/** A 计权（dB） */
const aWeight = (f: number) => {
  const f2 = f * f;
  const ra = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2));
  return 20 * Math.log10(ra) + 2.0;
};

/** 频谱质心和 A 计权后的功率比：4096 点、汉宁窗、半重叠，按功率加权 */
function spectrum(L: Float32Array, R: Float32Array, i0: number, i1: number): { cent: number; aRatio: number } {
  const N = 4096;
  let num = 0, den = 0, denA = 0;
  for (let s = i0; s + N <= i1; s += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = ((L[s + i] + R[s + i]) / 2) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    fft(re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      num += p * ((k * SR) / N);
      den += p;
      denA += p * 10 ** (aWeight((k * SR) / N) / 10);
    }
  }
  return den > 0 ? { cent: Math.round(num / den), aRatio: denA / den } : { cent: 0, aRatio: 1 };
}

function measure(buf: AudioBuffer, c: Case): Row {
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);
  const n = L.length;
  let peak = 0;
  let peakI = 0;
  let last = 0;
  const floor = 10 ** (-60 / 20);
  for (let i = 0; i < n; i++) {
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) {
      peak = a;
      peakI = i;
    }
    if (a > floor) last = i;
  }
  // 重击检测（10 毫秒包络）
  const B = Math.floor(0.01 * SR);
  const env: number[] = [];
  for (let s = 0; s + B <= n; s += B) {
    let a = 0;
    for (let i = s; i < s + B; i++) a += (L[i] * L[i] + R[i] * R[i]) / 2;
    env.push(10 * Math.log10(a / B + 1e-12));
  }
  const top = Math.max(...env);
  const hits: number[] = [];
  for (let k = 8; c.group !== 'ambience' && k < env.length - 3; k++) {
    const at = k * 0.01 + 0.005 - T0;
    const localMax = env.slice(k - 3, k + 4).every((v) => v <= env[k]);
    const rise = env[k] - Math.min(...env.slice(k - 8, k));
    if (localMax && env[k] > top - 15 && rise > 6 && (!hits.length || at - hits[hits.length - 1] > 0.06)) hits.push(Math.round(at * 100) / 100);
  }
  const i0 = Math.floor((T0 + c.win[0]) * SR);
  const i1 = Math.min(n, Math.floor((T0 + c.win[1]) * SR));
  let ss = 0, sl = 0, sr = 0;
  for (let i = i0; i < i1; i++) {
    ss += (L[i] * L[i] + R[i] * R[i]) / 2;
    sl += L[i] * L[i];
    sr += R[i] * R[i];
  }
  const rms = Math.sqrt(ss / Math.max(1, i1 - i0));
  const spec = spectrum(L, R, i0, i1);
  // 400 毫秒滑动窗，步长 50 毫秒
  const W = Math.floor(0.4 * SR);
  const hop = Math.floor(0.05 * SR);
  let rmsMax = 0;
  for (let s = 0; s + W <= n; s += hop) {
    let a = 0;
    for (let i = s; i < s + W; i++) a += (L[i] * L[i] + R[i] * R[i]) / 2;
    rmsMax = Math.max(rmsMax, Math.sqrt(a / W));
  }
  const row: Row = {
    name: c.name, group: c.group, nominal: c.nominal,
    dur: Math.round((last / SR - T0) * 100) / 100,
    peak: dB(peak), rms: dB(rms), rmsMax: dB(rmsMax), peakAt: Math.round((peakI / SR - T0) * 100) / 100,
    lr: sl > 0 && sr > 0 ? Math.round(100 * Math.log10(sl / sr)) / 10 : 0,
    cent: spec.cent,
    rmsA: dB(rms * Math.sqrt(spec.aRatio)),
    hits, ok: true, notes: '',
  };
  const fail = (why: string) => {
    row.ok = false;
    row.notes += (row.notes ? '; ' : '') + why;
  };
  if (c.group !== 'calib' && row.peak > -1) fail('peak > -1 dBFS');
  if (c.group === 'ambience' && row.rms > -30) fail('ambience rms > -30');
  if (c.group === 'scare' && (row.rms < -20 || row.rms > -10)) fail('scare rms outside -20..-10');
  if (c.rmsRange && (row.rms < c.rmsRange[0] || row.rms > c.rmsRange[1])) fail(`rms outside ${c.rmsRange[0]}..${c.rmsRange[1]}`);
  if (c.side === 0 && Math.abs(row.lr) > 2) fail('front source not centred');
  if (c.side && Math.sign(row.lr) !== c.side) fail(`expected ${c.side > 0 ? 'left' : 'right'} louder`);
  const timed = c.group !== 'stress' && c.group !== 'calib' && c.group !== 'calib3d';
  if (c.nominal > 0 && timed && row.dur < c.nominal - 0.02) fail(`shorter than ${c.nominal}s`);
  return row;
}

/** 带种子的随机数：同一份代码每次测出来一样 */
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

async function renderBuffer(c: Case, seed = 12345): Promise<AudioBuffer> {
  const prev = rng.next;
  rng.next = seeded(seed);
  try {
    const ac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(c.seconds * SR), sampleRate: SR });
    const bus = createBus(ac);
    c.render(bus, createRouter(bus, pan, createCrowd(bus, true)), T0);
    return await ac.startRendering();
  } finally {
    rng.next = prev;
  }
}
async function renderCase(c: Case, seed = 12345): Promise<Row> {
  return measure(await renderBuffer(c, seed), c);
}

const w = window as unknown as {
  renderAll(seed?: number, only?: string): Promise<Row[]>;
  renderOne(name: string, seed?: number): Promise<Row | null>;
  /** 渲染一个用例，返回原始采样（起点 = 0，声音从 T0 秒开始）：画频谱图、量包络用 */
  renderRaw(name: string, seed?: number): Promise<{ sampleRate: number; t0: number; left: Float32Array; right: Float32Array } | null>;
  __audioReport?: Row[];
  __audio?: unknown;
};

function show(rows: Row[]) {
  const el = document.getElementById('report')!;
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '-inf');
  el.innerHTML =
    '<table><tr><th>sound</th><th>group</th><th>nominal s</th><th>dur s</th><th>peak dBFS</th><th>rms dBFS</th><th>rmsMax400</th><th>rmsA dBFS</th><th>L−R dB</th><th>centroid Hz</th><th></th></tr>' +
    rows
      .map((r) => `<tr><td>${r.name}</td><td>${r.group}</td><td>${r.nominal || ''}</td><td>${r.dur}</td><td>${f(r.peak)}</td><td>${f(r.rms)}</td><td>${f(r.rmsMax)}</td><td>${f(r.rmsA)}</td><td>${r.lr}</td><td>${r.cent}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'ok' : r.notes}</td></tr>`)
      .join('') +
    '</table>';
}

/** only：只渲染组名或名字里含这个字符串的 */
w.renderAll = async (seed?: number, only?: string) => {
  const rows: Row[] = [];
  for (const c of CASES) if (!only || c.group === only || c.name.includes(only)) rows.push(await renderCase(c, seed));
  w.__audioReport = rows;
  console.log('audio report\n' + rows.map((r) => `${r.name.padEnd(64)} dur ${String(r.dur).padStart(5)}  peak ${r.peak} @${r.peakAt}  rms ${r.rms}  rmsMax ${r.rmsMax}  rmsA ${r.rmsA}  lr ${r.lr}  cent ${r.cent}  ${r.ok ? 'ok' : r.notes}${r.hits.length ? '\n    hits ' + r.hits.join(' ') : ''}`).join('\n'));
  show(rows);
  return rows;
};
w.renderOne = async (name, seed) => {
  const c = CASES.find((x) => x.name === name);
  return c ? renderCase(c, seed) : null;
};
w.renderRaw = async (name, seed) => {
  const c = CASES.find((x) => x.name === name);
  if (!c) return null;
  const b = await renderBuffer(c, seed);
  return { sampleRate: b.sampleRate, t0: T0, left: b.getChannelData(0), right: b.getChannelData(1) };
};

// ── 实时按钮 ──────────────────────────────────────────────────────────────
const sys = createAudio(pan);
const fire = async (name: string) => {
  await sys.unlock();
  const c = CASES.find((x) => x.name === name);
  if (!c?.events && !c?.timeline) return;
  // flee 的那个人要已经在逃跑；其他人复位
  for (const v of state.npcs) v.mode = 'wander';
  const send = (e: SimEvent) => {
    if (e.type === 'flee') state.npcs.find((v) => v.id === e.npc)!.mode = 'fleeing';
    sys.onEvent?.(e, state);
  };
  for (const e of c.events ?? []) send(e);
  // 按模拟的节拍发：reveal 的 on / off、现身的 windup / drop / end
  for (const [at, e] of c.timeline ?? []) {
    if (at <= 0) send(e);
    else setTimeout(() => send(e), at * 1000);
  }
};
/** 第一次 unlock（建 AudioContext、总线、混响冲激响应、环境层）在点击里同步花多久；第二次（已在运行）花多久；脚步样本现算多久 */
const bench = () => {
  const s = createAudio(pan);
  const a = performance.now();
  void s.unlock();
  const b = performance.now();
  void s.unlock();
  const c = performance.now();
  s.dispose?.();
  const off = new OfflineAudioContext({ numberOfChannels: 1, length: 128, sampleRate: 48000 });
  const d = performance.now();
  stepBanks(off);
  const e = performance.now();
  return { firstMs: Math.round((b - a) * 10) / 10, againMs: Math.round((c - b) * 100) / 100, stepBanksMs: Math.round((e - d) * 10) / 10 };
};

// ── 第三人称试听：听者放在走廊中间（面朝北，对着客厅门洞），或者跟在演示用的鬼魂后面 ──────────
interface Demo {
  /** 每帧推进，返回 false 表示演示结束 */
  step(dt: number): boolean;
}
let demo: Demo | null = null;
let third = false;
let spin = false;
let spinA = -Math.PI / 2;
const listenerPos = v3(8, 1.8, 6.2);
const ghost: GhostState = { x: 8, y: 1.4, z: 7, heading: -Math.PI / 2, speed: 0, inWall: false };
let ghostOn = false;

/** 一个访客沿路线走（mode / 速度可选），走完回到原位 */
const walkDemo = (id: number, path: Vec2[], speed: number, mode: NpcMode): Demo => {
  const n = state.npcs.find((x) => x.id === id)!;
  const it = walkPath(path, speed);
  let acc = 0;
  n.mode = mode;
  n.speed = speed;
  return {
    step(dt) {
      // 路线是按 60 帧/秒切好的：高刷新率的屏幕上不是每帧都前进
      acc += dt * 60;
      while (acc >= 1) {
        acc -= 1;
        const r = it.next();
        if (r.done) {
          n.mode = 'wander';
          n.speed = 0;
          n.pos = { ...HOME[id - 1] };
          return false;
        }
        n.pos = r.value;
      }
      return true;
    },
  };
};
/**
 * 鬼魂在 x 6.2 从走廊往北飘（1.2 米/秒），穿过客厅南墙（z 4.5–5.0，这里没有门洞），在客厅里停半秒，再穿回来；
 * 镜头跟在它身后 2.5 米、高 0.5 米（往北飘时镜头在南边的走廊里 —— 正是「镜头在隔壁、耳朵在鬼魂身上」的情况）
 */
const ghostDemo = (): Demo => {
  let t = 0;
  ghostOn = true;
  return {
    step(dt) {
      t += dt;
      const north = t < 3.25;
      const z = t < 3 ? 6.5 - 1.2 * t : t < 3.5 ? 2.9 : 2.9 + 1.2 * Math.min(3, t - 3.5);
      ghost.x = 6.2;
      ghost.z = z;
      ghost.speed = (t < 3 || (t > 3.5 && t < 6.5)) ? 1.2 : 0;
      ghost.inWall = z > 4.5 && z < 5.0;
      ghost.heading = north ? -Math.PI / 2 : Math.PI / 2;
      listenerPos.x = 6.2;
      listenerPos.y = 1.9;
      listenerPos.z = z + (north ? 2.5 : -2.5);
      if (t > 7) {
        ghostOn = false;
        listenerPos.x = 8;
        listenerPos.y = 1.8;
        listenerPos.z = 6.2;
        return false;
      }
      return true;
    },
  };
};

/**
 * 访客 id 站在鬼魂（8, 6.2）正前方 dist 米，恐惧值在 seconds 秒里从 from 线性涨到 to，再撑 1 秒；鬼魂不动，镜头在它身后 1.4 米。
 * 听喘气（60 起，周期 2.2 → 1.3 秒）和呜咽（80 起，每 6–10 秒一声）。结束时把访客放回原处
 */
const breathDemo = (id: number, from: number, to: number, seconds: number, dist: number): Demo => {
  const n = state.npcs.find((x) => x.id === id)!;
  const keep = { pos: { ...n.pos }, fear: n.fear, mode: n.mode, speed: n.speed };
  let t = 0;
  ghostOn = true;
  Object.assign(ghost, { x: GHOST_AT.x, z: GHOST_AT.z, speed: 0, inWall: false });
  Object.assign(listenerPos, { x: HALL_MID.x, y: HALL_MID.y, z: HALL_MID.z });
  Object.assign(n, { pos: { x: GHOST_AT.x, z: GHOST_AT.z - dist }, mode: 'wander', speed: 0 });
  return {
    step(dt) {
      t += dt;
      n.fear = from + (to - from) * Math.min(1, t / seconds);
      if (t < seconds + 1) return true;
      Object.assign(n, keep);
      ghostOn = false;
      Object.assign(listenerPos, { x: 8, y: 1.8, z: 6.2 });
      return false;
    },
  };
};

const LIVE3D: { name: string; run(): void }[] = [
  { name: 'breath: Theo fear 60 → 100 over 12 s, 1 m in front of the ghost (period 2.2 → 1.3 s)', run: () => (demo = breathDemo(2, 60, 100, 12, 1)) },
  { name: 'breath: Theo fear 100, 3 m away (should be silent)', run: () => (demo = breathDemo(2, 100, 100, 6, 3)) },
  { name: 'breath + whimper: Mia (timid) fear 90, 1 m, 20 s', run: () => (demo = breathDemo(1, 90, 90, 20, 1)) },
  { name: 'breath + whimper: Nora (brave) fear 90, 1 m, 20 s', run: () => (demo = breathDemo(3, 90, 90, 20, 1)) },
  { name: 'visitor walks: living (wood) → hall (rug) → kitchen (tile)', run: () => (demo = walkDemo(2, [{ x: 6, z: 2.5 }, { x: 8, z: 3.5 }, { x: 8, z: 4.75 }, { x: 8.5, z: 6 }, { x: 12.5, z: 6 }, { x: 13, z: 4.75 }, { x: 13.5, z: 2.5 }, { x: 14.5, z: 2 }], 1.3, 'wander')) },
  { name: 'visitor flees: kitchen → front door', run: () => (demo = walkDemo(2, [{ x: 13.5, z: 2.5 }, { x: 13, z: 4.75 }, { x: 8.5, z: 6 }, { x: 8, z: 7.25 }, { x: 8, z: 11.75 }, { x: 8, z: 13.2 }], 3.2, 'fleeing')) },
  { name: 'visitor walks in the study (behind a wall)', run: () => (demo = walkDemo(1, [{ x: 1.5, z: 2.6 }, { x: 4.6, z: 2.6 }, { x: 4.6, z: 1.5 }, { x: 1.5, z: 1.5 }], 1.3, 'wander')) },
  { name: 'ghost passes through a wall (camera follows)', run: () => (demo = ghostDemo()) },
  { name: 'chill: shiver (Theo, hall)', run: () => sys.onEvent?.(chill(2, 1), state) },
  { name: 'chill: neck', run: () => { for (const e of neckScare(2, 12)) sys.onEvent?.(e, state); } },
  { name: 'chill: neck + scream', run: () => { for (const e of neckScare(2, 20)) sys.onEvent?.(e, state); } },
];

const box = document.getElementById('buttons')!;
for (const g of ['scare', 'lure', 'voice', 'other', 'manifest', 'reveal', 'bed', 'trap'] as Group[]) {
  const sec = document.createElement('div');
  sec.innerHTML = `<h2>${g}</h2>`;
  for (const c of CASES.filter((x) => x.group === g && (x.events || x.timeline))) {
    const b = document.createElement('button');
    b.textContent = c.name;
    b.onclick = () => void fire(c.name);
    sec.appendChild(b);
  }
  if (g === 'reveal') {
    // 「on」那个按钮会一直照着：这个把手电从鬼魂身上移开（单独听淡出）
    const off = document.createElement('button');
    off.textContent = 'reveal: off (the flashlight leaves the ghost)';
    off.onclick = async () => {
      await sys.unlock();
      sys.onEvent?.(reveal(2, false), state);
    };
    sec.appendChild(off);
  }
  box.appendChild(sec);
}
{
  const sec = document.createElement('div');
  sec.innerHTML = '<h2>third person (3D, headphones)</h2>';
  const lab = document.createElement('label');
  lab.innerHTML = '<input type="checkbox" id="third" /> 3D listener in the hall, facing north';
  const lab2 = document.createElement('label');
  lab2.innerHTML = '<input type="checkbox" id="spin" /> turn slowly (12 s per turn)';
  sec.append(lab, lab2, document.createElement('br'));
  for (const d of LIVE3D) {
    const b = document.createElement('button');
    b.textContent = d.name;
    b.onclick = async () => {
      await sys.unlock();
      third = true;
      (document.getElementById('third') as HTMLInputElement).checked = true;
      d.run();
    };
    sec.appendChild(b);
  }
  box.appendChild(sec);
}
const amb = document.createElement('button');
amb.textContent = 'start ambience';
amb.onclick = () => void sys.unlock();
box.prepend(amb);
(document.getElementById('third') as HTMLInputElement).onchange = (e) => {
  third = (e.target as HTMLInputElement).checked;
  void sys.unlock();
};
(document.getElementById('spin') as HTMLInputElement).onchange = (e) => (spin = (e.target as HTMLInputElement).checked);

const fear = document.getElementById('fear') as HTMLInputElement;
const fearv = document.getElementById('fearv')!;
fear.oninput = () => {
  fearv.textContent = fear.value;
  for (const v of state.npcs) v.fear = Number(fear.value);
};
(document.getElementById('mute') as HTMLInputElement).onchange = (e) => sys.setMuted((e.target as HTMLInputElement).checked);
document.getElementById('render')!.onclick = () => void w.renderAll();

w.__audio = { sys, state, fire, bench, ghost };

// 主循环：和 main.ts 一样每帧调 update（没解锁时什么都不做）；第三人称时先喂听者和鬼魂
const status = document.getElementById('status')!;
let last = performance.now();
let time = 0;
const loop = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  if (demo && !demo.step(dt)) demo = null;
  if (third) {
    if (spin) spinA += (dt * Math.PI * 2) / 12;
    const fwd = ghostOn ? v3(ghost.x - listenerPos.x, ghost.y - listenerPos.y, ghost.z - listenerPos.z) : v3(Math.cos(spinA), 0, Math.sin(spinA));
    sys.setListener(listenerPos, fwd);
    sys.setGhost(ghostOn ? ghost : null);
  }
  sys.update?.({ dt, time, state });
  status.textContent = third ? `3D listener (${listenerPos.x.toFixed(1)}, ${listenerPos.z.toFixed(1)})` : `front door pan ${pan(FRONT_DOOR.outside).toFixed(2)}`;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
