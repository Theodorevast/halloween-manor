// 墙上多一个影子（The Other One，2026-10-30「一夜」的中段）：一晚最多 OTHER_SHADOW.max 次，某个访客的手电扫过一面墙，
// 墙上投出一个兜帽人形的影子，静止、头微低——那里什么也没有，也不是你；手电下一次扫过去，它就没了。
// 访客没反应，播报不提；不发光、不闪、不出声、不出脸。
//
// 做法（和鬼魂墙上的影子 L2 同一个办法，见 ghost.ts 的 createGhostShadowMaterial）：
// - 一份只进手电阴影图的网格（torches.ts 的 GHOST_SHADOW_LAYER）：主画面、月光都看不见它，某支手电照到它时，墙上多一个影子。
//   外形用玩家鬼魂同一个模型（opts.model，main.ts 的 ghostFx.model；没给就用程序化的人形），是同一种兜帽人形。
//   材质就是 createGhostShadowMaterial，给它自己一组 uniform（makeGhostUniforms）：uSolid = 1（现身时那个姿势：不飘、不拖，
//   只有边和下摆散开一点）、头低 OTHER_LOOK.bow、时间定住（侵蚀的噪声不动）。uShadow 0 / 1 就是在不在：0 时片元全丢，什么都不投
// - 着色器和鬼魂自己的影子一字不差（同一个函数、同样的常量，只是 uniform 是另一组）：three 按源码缓存着色程序、按程序缓存管线，
//   所以不多编 GPU 管线，只多一份节点（第一次画到它时在 JS 里生成一次源码）；?pipelog 量过，WebGPU、WebGL2 都没有它自己的管线。
//   娃娃屋俯视没有鬼魂的影子可以共用，就编它自己那一条。网格一开场就在场景里、一直可见、不剔除：
//   开场那一帧每支手电都画一次阴影图（flashlight.ts 的 needsUpdate），那时就编好、生成好，第一次出现不卡。
//   所以 main.ts 要在开场那次阻塞的预编译（characters.prewarm）之前建它（和 createGhostView 放在一起）
// - 什么时候、在哪：createOtherDirector（纯逻辑，tests/other-shadow.test.ts 直接测），规则见 OTHER_SHADOW（config/night.ts）
//   和 OTHER_LOOK，站位见 OTHER_SPOTS。放上去、撤掉都只在没有手电碰到这个人形的时候（光锥再放宽 pad）：没人看得见它怎么来、怎么走。
//   给了镜头（opts.rig）就只放在玩家看得见的那面墙上；玩家的鬼魂被照着、或者就在旁边时不放（两个影子不同时落在同一面墙上，
//   不会被当成自己的）。
//   一次出现最长 OTHER_SHADOW.maxShown 秒：到了就在 OTHER_LOOK.fade 秒里慢慢化掉（uShadow 往下降，侵蚀阈值抬高，影子一缕缕散掉），
//   不管有没有被照着——这是唯一一种在光里消失的情形，所以只能慢、只能单调（不抖，不算「暗一下」）
//
// ?noother：不建（看样对比、量开销）；?debug：window.__otherShadow（state() / place(id) / clear() / inView()），截图、手动看样用
import * as THREE from 'three/webgpu';
import { OTHER_SHADOW } from '../config/night';
import { ghostSees } from '../engine/ghostRig';
import { isGhostRig, type CameraRig, type FrameCtx, type Module, type RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { Vec2, WorldState } from '../sim/types';
import {
  GHOST, GHOST_BODY, buildGhostGeometry, createGhostShadowMaterial, ensureGhostAttributes, ghostRevealAmount, makeGhostUniforms,
  type GhostModel,
} from './ghost';
import { GHOST_SHADOW_LAYER, torches, type TorchSample } from './torches';

const deg = (d: number) => (d * Math.PI) / 180;

/** 墙上多一个影子的手感、节奏（出现的规则本身在 config/night.ts 的 OTHER_SHADOW：max、after、afterScared、litFor、near） */
export const OTHER_LOOK = {
  /** 人形浮在多高（ghost.y，米）：和玩家的鬼魂一样（engine/ghostRig.ts 的 GHOST.height），头顶 1.82、下摆 0.4 */
  y: 1.4,
  /**
   * 头低多少（弧度，正 = 低头；ghost.ts 的 headPose 绕脖子转）。鬼魂的模型本来就低着头约 12°（config/ghost.ts），再低一点；
   * 程序化的人形是抬着头的，要多低一些才看得出
   */
  bow: { model: deg(6), procedural: deg(14) },
  /** 侵蚀噪声定在第几秒（每次放上去换一个：边上散开的样子每次不一样；放着的时候一动不动） */
  noise: [3.1, 11.7, 23.3],
  /** 站位离背后的墙面多远（米，简报 0.3–0.6） */
  fromWall: 0.45,
  /**
   * 光锥放宽多少算「碰到」（弧度）：放上去、撤掉都只在谁都没碰到它的时候。访客转身最快约 5°/帧（BEHAVIOR.turnRate），
   * 放上去的下一帧光锥就扫过来，也只扫到外圈那盏灯最边上几乎不亮的一圈（penumbra 1，边上 2° 以内不到 4%）
   */
  pad: deg(6),
  /** 照到的程度（外圈那盏灯的聚光衰减 × 照程衰减 × 强度）到这么多才算「被照到」（墙上的影子看得清）：大约光轴 25° 以内 */
  litMin: 0.35,
  /** 照程衰减：离手电 range × far 起暗下去，到 range 为 0（range 是手电登记表里的，TORCH.distance） */
  far: 0.65,
  /**
   * 放的时候：clear 米内没有访客（和他的手电）；玩家的鬼魂离站位至少 ghostClear 米，也不挡在会扫过来的那支手电和站位之间
   * （离那条线 ghostLine 米以内）：不然光先照到鬼魂，两个影子落在同一面墙上
   */
  clear: 2.5,
  ghostClear: 2.5,
  ghostLine: 1,
  /** 访客（或他的手电）贴到这么近：照着也立刻撤（再近就要穿过它，手电甚至会伸进它身子里） */
  tooClose: 0.75,
  /** 放的时候要有一支亮着的手电（强度 ≥ litPower）在 promise 米内、看得见那里：有人会扫过去才放，不白放着 */
  promise: 8,
  litPower: 0.25,
  /** 放上去 wait 秒（模拟时间）还没人照到就撤（玩家多半已经不在看了），retry 秒以后可以再放 */
  wait: 12,
  retry: 3,
  /** 出现过一次以后，至少隔这么久（秒，模拟时间）才放下一次 */
  gap: 45,
  /**
   * 一次出现满 OTHER_SHADOW.maxShown 秒以后，用多少秒慢慢化掉（真实时间），化完撤掉（理由 faded）。level 从 1 线性降到 0，
   * 画面上 uShadow 从 1 线性降到 fadeFloor：材质的侵蚀阈值 mix(2, erode, uShadow) 跟着抬高，下摆、边上那几缕先散，兜帽最后
   */
  fade: 1.2,
  /**
   * 化到这个 uShadow 时一点不剩：阈值 mix(2, erode, 0.5) ≥ 1.02，比噪声的最大值（1）还高，所以最后撤掉（uShadow = 0）那一下墙上什么也不少。
   * 噪声多半落在 0.3–0.7（估的，没量），影子看得见地散开大约在 uShadow 0.92–0.68 这一段，也就是化掉的头三分之二；
   * 嫌最后那一截空着可以把它往上调到 0.6 左右（代价是最后撤掉时可能少几粒很小的碎点）
   */
  fadeFloor: 0.5,
  /** 玩家的鬼魂不再被照着以后，至少过这么久（秒，真实时间）才放：它自己的影子刚从墙上消失 */
  ghostCalm: 1.5,
  /** 没放着的时候，多久找一次站位（秒） */
  scan: 0.25,
  /**
   * 玩家看不看得见（给了镜头时，见 createOtherShadow 的 inView）：第三人称时离镜头 view 米以内、镜头在那面墙朝屋里的一侧至少 wallSide 米、
   * 在视锥里、鬼魂和站位之间没有墙；娃娃屋俯视时那面墙朝镜头的程度（法线 · viewDir）至少 faceMin（朝镜头这一侧的墙降低了，影子落不上去）。
   * view：走廊 15 米长，看样时镜头离西头 11.8 米，墙上的影子还看得清清楚楚
   */
  view: 12,
  wallSide: 0.5,
  faceMin: 0.2,
  /** ghostRevealAmount() 超过这么多算玩家的鬼魂被照着（它的影子在墙上，ghost.ts 的 GHOST.shadow） */
  ghostLit: 0.01,
};

/** 一个站位（房屋米坐标） */
export interface OtherSpot {
  id: string;
  x: number;
  z: number;
  /** 背后那面墙的法线（从墙面指向屋里，单位向量）：手电从屋里照过来，影子落在这面墙上 */
  nx: number;
  nz: number;
  /**
   * 人形面朝哪（方向角，见 lib/angle.ts）：侧对着屋里（顺着墙）。手电从屋里照过来，墙上是它的侧影：兜帽往前探、头低着，一眼是个人；
   * 正对着照只是一团兜帽的轮廓，看不出低头（2026-10-30 看样，同一帧转朝向对比过）
   */
  facing: number;
}

const N = -Math.PI / 2, S = Math.PI / 2, E = 0;

/**
 * 站位：背后那面墙的墙面往屋里 OTHER_LOOK.fromWall 米（墙体在墙格里居中，墙面 = 墙格中心 ± WALL_T / 2），
 * 不在访客走的路上（离门洞、前门、引诱物件都够远，见 tests/other-shadow.test.ts；访客的路线另外用模拟统计过，见 lane-OS 的报告：
 * 24 夜里有人走到 near 米内的时间都只占 1–2%）。同一处一晚只出现一次：第二次在别处
 */
export const OTHER_SPOTS: readonly OtherSpot[] = [
  // 走廊西头：西外墙（i = 0）墙面 x = 0.35，走廊（墙面 z 4.85–7.15）正中，面朝北。往西去书房、卧室的人，手电顺着走廊正对这面墙；
  // 他们在 x 2–3 的门洞拐进去，离它 1.5 米以上
  { id: 'hall-west', x: 0.8, z: 6.0, nx: 1, nz: 0, facing: N },
  // 走廊东头：东外墙（i = 31）墙面 x = 15.65，面朝南。去厨房、浴室的人在 x 12.5–13.5 的门洞拐进去
  { id: 'hall-east', x: 15.2, z: 6.0, nx: -1, nz: 0, facing: S },
  // 卧室衣柜旁的墙角：衣柜（x 3.5–5.0、z 7.5–8.0）南边、贴着卧室东墙（i = 10，墙面 x = 5.15），面朝衣柜。从卧室里往东照就是这里
  { id: 'bedroom-wardrobe', x: 4.7, z: 8.4, nx: -1, nz: 0, facing: N },
  // 客厅壁炉边：北墙（j = 0，墙面 z = 0.35）壁炉西边、窗（x 7.0–9.0）的西边，面朝壁炉。从客厅门（x 7.5–8.5）进来往西北照，影子落在实墙上
  { id: 'living-hearth', x: 6.6, z: 0.8, nx: 0, nz: 1, facing: E },
  // 浴室进门的墙角：东北角，东墙（i = 31）墙面 x = 15.65、北墙（j = 14）墙面 z = 7.35，面朝墙角。从门洞（x 12.5–13.5）进来往东照就是这里
  { id: 'bath-door', x: 15.2, z: 7.8, nx: -1, nz: 0, facing: N },
];

// ───────────────────────── 手电照到人形 ─────────────────────────

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 人形投影的那一段：离地高度（下摆 GHOST.shadow.hemCut 以下不投影，往上到头顶，取 4 点）、半径（长袍最宽处）、胸口的高度 */
const FIGURE = (() => {
  const span = GHOST_BODY.top - GHOST_BODY.bottom;
  const lo = OTHER_LOOK.y + GHOST_BODY.bottom + span * GHOST.shadow.hemCut, hi = OTHER_LOOK.y + GHOST_BODY.top;
  return { ys: [0, 1 / 3, 2 / 3, 1].map((k) => lo + (hi - lo) * k), r: 0.27, chest: OTHER_LOOK.y - 0.3 };
})();

/**
 * 一支手电照 (x, z) 处的人形：
 * - touch：光锥（半角放宽 pad，再按人形的半径放宽）在照程里碰没碰到它，不管多暗
 * - amount：照到的程度 0..1 = 外圈那盏灯的聚光衰减（penumbra 1：smoothstep(cos 半角, 1, cosθ)，和 flashlight.ts 一样）
 *   × 照程衰减（OTHER_LOOK.far）× 强度，人形上几点取最亮的
 * 不管墙（视线另查，见 lightOnSpot）。只看外圈那盏：亮芯不投影
 */
export function torchOnFigure(t: TorchSample, x: number, z: number, pad = OTHER_LOOK.pad): { touch: boolean; amount: number } {
  if (!(t.power > 0) || !(t.range > 0)) return { touch: false, amount: 0 };
  const cosA = Math.cos(t.angle);
  let touch = false, amount = 0;
  for (const y of FIGURE.ys) {
    const lx = x - t.x, ly = y - t.y, lz = z - t.z;
    const d = Math.hypot(lx, ly, lz);
    if (d > t.range + FIGURE.r) continue;
    // 手电伸进了人形里
    if (d <= FIGURE.r) {
      touch = true;
      amount = Math.max(amount, t.power);
      continue;
    }
    const cosT = Math.min(1, Math.max(-1, (lx * t.dx + ly * t.dy + lz * t.dz) / d));
    if (Math.acos(cosT) - Math.asin(FIGURE.r / d) <= t.angle + pad) touch = true;
    amount = Math.max(amount, smooth01(cosA, 1, cosT) * (1 - smooth01(t.range * OTHER_LOOK.far, t.range, d)) * t.power);
  }
  return { touch, amount: touch ? amount : 0 };
}

/** 一组手电照站位 s 上的人形：touch = 有没有哪支碰到它（中间没有墙，按看得见的墙体算：engine/ghostRig.ts 的 ghostSees）；lit = 最亮那支照到的程度 */
export function lightOnSpot(s: Vec2, ts: readonly TorchSample[], pad = OTHER_LOOK.pad): { touch: boolean; lit: number } {
  let touch = false, lit = 0;
  for (const t of ts) {
    const c = torchOnFigure(t, s.x, s.z, pad);
    if (!c.touch || !ghostSees(t, s)) continue;
    touch = true;
    lit = Math.max(lit, c.amount);
  }
  return { touch, lit };
}

/** 手电的光轴偏开人形胸口多少（弧度，0..π）：越小越快扫到 */
function angleOff(t: TorchSample, s: Vec2): number {
  const lx = s.x - t.x, ly = FIGURE.chest - t.y, lz = s.z - t.z;
  const d = Math.hypot(lx, ly, lz) || 1;
  return Math.acos(Math.min(1, Math.max(-1, (lx * t.dx + ly * t.dy + lz * t.dz) / d)));
}

// ───────────────────────── 出现的规则 ─────────────────────────

/**
 * 为什么撤：照够了（done）、访客走近（near）、玩家的鬼魂被照着或走近（ghost）、玩家看不见了（view）、等太久没人照（wait）、
 * 一次出现满 maxShown 秒、慢慢化完了（faded）
 */
export type OtherWhy = 'done' | 'near' | 'ghost' | 'view' | 'wait' | 'faded';

export type OtherEvent =
  /** 放上去了（还没人看见：uShadow = 1，等手电扫过来） */
  | { type: 'place'; spot: OtherSpot }
  /** 第一次被照到：出现了一次（今晚第 n 次） */
  | { type: 'appear'; spot: OtherSpot; n: number }
  /** 撤掉了（没被照着的时候；seen = 这一次出现过没有） */
  | { type: 'withdraw'; spot: OtherSpot; why: OtherWhy; seen: boolean };

/** 每帧交给 createOtherDirector 的输入 */
export interface OtherFrame {
  /** 模拟时间（秒）、今晚吓跑了几个：什么时候开始可能出现（OTHER_SHADOW.after / afterScared）、两次之间隔多久都按它 */
  time: number;
  scaredOff: number;
  /** 这一帧的真实时间间隔（秒）：被照了多久按它累计（hit-stop 时模拟停着，手电照样亮） */
  dt: number;
  /** 手电登记表（torches.ts） */
  torches: readonly TorchSample[];
  /** 访客的位置（屋里的，门外进出的也算） */
  visitors: readonly Vec2[];
  /** 玩家的鬼魂在哪（没有鬼魂：null）、此刻有没有被手电照着或正在现身（它自己的影子在墙上） */
  ghost: Vec2 | null;
  ghostLit: boolean;
  /** 玩家此刻看不看得见这个站位那面墙；没给 = 不管 */
  inView?: (s: OtherSpot) => boolean;
}

export interface OtherDirector {
  /** 今晚出现过几次 */
  readonly appeared: number;
  /** 此刻放在哪（null = 没放） */
  readonly spot: OtherSpot | null;
  /** 这一次放上去以后被照到过没有 */
  readonly shown: boolean;
  /** 还剩多少（1 = 全在；满 maxShown 秒以后在 OTHER_LOOK.fade 秒里线性降到 0，只降不升；没放着是 0） */
  readonly level: number;
  step(f: OtherFrame): OtherEvent[];
  /** 看样、截图用：下一帧没被手电碰到就放到 s（不管时间、次数、玩家看不看得见、附近有没有人）；放着别的就先不放 */
  force(s: OtherSpot): void;
  /** 调试用：马上撤掉（不管照没照着），不发事件 */
  clear(): void;
}

/**
 * 什么时候、在哪放上去，什么时候撤（纯逻辑：不碰画面，测试直接喂手电登记表和访客的位置）。
 * - 能放：今晚出现过的不到 max 次；模拟时间到了 after，或者吓跑了 afterScared 个（哪个先到）；离上一次出现结束过了 OTHER_LOOK.gap；
 *   玩家的鬼魂没被照着已经 ghostCalm 秒
 * - 放在哪（每 scan 秒找一次）：今晚还没在那里出现过；没有手电碰到它；clear 米内没有访客；玩家的鬼魂不在 ghostClear 米内、
 *   也不挡在会扫过来的手电和它之间；玩家看得见那面墙；有一支亮着的手电在 promise 米内看得见那里（有人会扫过去）。
 *   几处都行时挑光锥离它最近（最快扫到）的
 * - 被照到（照到的程度 ≥ litMin）：第一次算出现一次（appear）；累计照满 litFor 秒以后，在下一个没有手电碰到它的时刻撤
 * - 提前撤：访客走到 near 米内、玩家的鬼魂被照着或走近；还没出现过的，玩家看不见了、放了 wait 秒没人照到，也撤。
 *   都等没有手电碰到它的时刻；访客（或他的手电）贴到 tooClose 以内就不等了
 * - 一次出现最长 maxShown 秒（真实时间，从出现那一帧算起）：到了就在 look.fade 秒里慢慢化掉（level 线性降到 0），化完撤掉（faded），
 *   不管有没有被照着。化的时候上面那几条照样算：没人碰到它时有理由撤，就在那一刻撤（没人看得见）
 */
export function createOtherDirector(spots: readonly OtherSpot[] = OTHER_SPOTS, rule = OTHER_SHADOW, look = OTHER_LOOK): OtherDirector {
  let appeared = 0;
  let at: OtherSpot | null = null;
  /** 这一次被照了多久（真实秒，累计）、出现过没有、是不是看样时硬放的、什么时候放的（模拟时间） */
  let litTime = 0, shown = false, forcedHere = false, placedAt = 0;
  /** 出现以后过了多久（真实秒）；正在化掉：化了多久（真实秒，-1 = 没在化） */
  let shownFor = 0, fadeT = -1;
  /** 撤的理由里一旦有了就一直算的那几种（照够了、访客走近、玩家的鬼魂） */
  let sticky: OtherWhy | null = null;
  /** 模拟时间：这之前不放（两次之间隔 gap；没出现就撤的隔 retry） */
  let nextAt = -Infinity;
  /** 玩家的鬼魂多久没被照着了（真实秒） */
  let calm = Infinity;
  let scanIn = 0;
  let forced: OtherSpot | null = null;
  const used = new Set<string>();

  const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
  /** 离站位最近的访客（和亮着的手电）有多远（米，平面距离） */
  const nearestTo = (s: Vec2, f: OtherFrame) => {
    let d = Infinity;
    for (const v of f.visitors) d = Math.min(d, dist(v, s));
    for (const t of f.torches) if (t.power > 0) d = Math.min(d, dist(t, s));
    return d;
  };

  /** 点 p 到线段 ab 的平面距离 */
  const segDist = (p: Vec2, a: Vec2, b: Vec2) => {
    const ux = b.x - a.x, uz = b.z - a.z, l2 = ux * ux + uz * uz;
    const k = l2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * ux + (p.z - a.z) * uz) / l2)) : 0;
    return Math.hypot(p.x - a.x - ux * k, p.z - a.z - uz * k);
  };

  /** 挑一个站位（见上面「放在哪」）；没有合适的返回 null */
  const pick = (f: OtherFrame): OtherSpot | null => {
    let best: OtherSpot | null = null, bestSoon = -Infinity;
    for (const s of spots) {
      if (used.has(s.id)) continue;
      if (f.ghost && dist(f.ghost, s) < look.ghostClear) continue;
      if (nearestTo(s, f) < look.clear) continue;
      if (f.inView && !f.inView(s)) continue;
      let soon = -Infinity, blocked = false;
      for (const t of f.torches) {
        if (t.power < look.litPower || dist(t, s) > look.promise || !ghostSees(t, s)) continue;
        if (f.ghost && segDist(f.ghost, t, s) < look.ghostLine) blocked = true;
        soon = Math.max(soon, -angleOff(t, s));
      }
      if (blocked || soon === -Infinity || lightOnSpot(s, f.torches).touch) continue;
      if (soon > bestSoon) {
        best = s;
        bestSoon = soon;
      }
    }
    return best;
  };

  const place = (s: OtherSpot, f: OtherFrame, ev: OtherEvent[], isForced: boolean) => {
    at = s;
    litTime = 0;
    shown = false;
    shownFor = 0;
    fadeT = -1;
    sticky = null;
    forcedHere = isForced;
    placedAt = f.time;
    ev.push({ type: 'place', spot: s });
  };

  return {
    get appeared() { return appeared; },
    get spot() { return at; },
    get shown() { return shown; },
    get level() { return !at ? 0 : fadeT < 0 ? 1 : Math.max(0, 1 - fadeT / look.fade); },
    force(s) { forced = s; },
    clear() {
      at = null;
      forced = null;
    },
    step(f) {
      const ev: OtherEvent[] = [];
      calm = f.ghostLit ? 0 : calm + f.dt;
      if (at) {
        const s = at;
        const L = lightOnSpot(s, f.torches);
        const near = nearestTo(s, f);
        // 出现以后的时长：出现那一帧算 0，满 maxShown 那一帧起开始化，化满 fade 秒撤掉（不管照没照着：已经一点不剩了）
        if (shown) {
          if (fadeT >= 0) fadeT += f.dt;
          else if ((shownFor += f.dt) >= rule.maxShown - 1e-9) fadeT = 0;
          if (fadeT >= look.fade - 1e-9) {
            ev.push({ type: 'withdraw', spot: s, why: 'faded', seen: true });
            at = null;
            nextAt = f.time + look.gap;
            return ev;
          }
        }
        if (L.lit >= look.litMin) {
          litTime += f.dt;
          if (!shown) {
            shown = true;
            appeared++;
            used.add(s.id);
            ev.push({ type: 'appear', spot: s, n: appeared });
          }
        }
        // 照够了、访客走近、玩家的鬼魂被照着或走近：一旦有了就一直算，等没被照着就撤。
        // 玩家看不见了、等太久：只管还没出现过的（出现过的照够了自然会撤），每帧重新看
        sticky ??= shown && litTime >= rule.litFor ? 'done'
          : near < rule.near ? 'near'
          : f.ghostLit || (f.ghost !== null && dist(f.ghost, s) < look.ghostClear) ? 'ghost'
          : null;
        const soft: OtherWhy | null = shown || forcedHere ? null
          : f.inView && !f.inView(s) ? 'view'
          : f.time - placedAt > look.wait ? 'wait'
          : null;
        const why = sticky ?? soft;
        if (why !== null && (!L.touch || near < look.tooClose)) {
          ev.push({ type: 'withdraw', spot: s, why, seen: shown });
          at = null;
          nextAt = f.time + (shown ? look.gap : look.retry);
        }
        return ev;
      }
      if (forced) {
        if (!lightOnSpot(forced, f.torches).touch) {
          place(forced, f, ev, true);
          forced = null;
        }
        return ev;
      }
      if (appeared >= rule.max || (f.time < rule.after && f.scaredOff < rule.afterScared)) return ev;
      if (f.time < nextAt || calm < look.ghostCalm) return ev;
      scanIn -= f.dt;
      if (scanIn > 0) return ev;
      scanIn = look.scan;
      const s = pick(f);
      if (s) place(s, f, ev, false);
      return ev;
    },
  };
}

// ───────────────────────── 画面 ─────────────────────────

export interface OtherShadow extends Module {
  /** 这一夜出现过几次（登记簿页脚那一句要不要写） */
  readonly appeared: number;
  /** 出现了一次时回调（登记簿记一笔） */
  onAppear(cb: () => void): void;
}

export interface OtherShadowOptions {
  /** 玩家鬼魂的模型（main.ts 的 ghostFx.model，loadGhostModel 的结果）：同一种兜帽人形。不给（或模型只有蒙皮网格）就用程序化的人形 */
  model?: GhostModel | null;
  /** 镜头（main.ts 的 r）：给了才只放在玩家看得见的墙上、躲开玩家的鬼魂（第三人称）；不给就不管这两条 */
  rig?: CameraRig | null;
}

export function createOtherShadow(core: RenderCore, opts: OtherShadowOptions = {}): OtherShadow {
  const search = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  const listeners: (() => void)[] = [];
  if (search?.has('noother')) return { appeared: 0, onAppear: (cb) => void listeners.push(cb) };

  const model = opts.model ?? null;
  // 外形：鬼魂模型里不动的那个合成几何体（和鬼魂自己的影子共用同一份，不多占显存）；没有就自己建一个程序化的人形
  const own = model?.geometry ? null : buildGhostGeometry();
  const geometry = ensureGhostAttributes(model?.geometry ?? own!);
  const look = model?.look ?? { bottom: GHOST_BODY.bottom, top: GHOST_BODY.top };
  // 自己的一组 uniform：现身时那个姿势（不飘、不拖）、侵蚀的时间取整并定住（一动不动）、头微低；影子平时关着
  const u = makeGhostUniforms();
  u.solid.value = 1;
  u.step.value = 1;
  u.head.value = model?.geometry ? OTHER_LOOK.bow.model : OTHER_LOOK.bow.procedural;
  u.time.value = OTHER_LOOK.noise[0];
  u.shadow.value = 0;
  const mat = createGhostShadowMaterial(u, look);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = 'other-shadow';
  // 只进手电外圈那盏灯的阴影图（主相机、月光都不看这一层）；一直可见、不剔除：开场那一帧每支手电的阴影图都画到它，那时就编好
  mesh.layers.set(GHOST_SHADOW_LAYER);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.userData.uniforms = u;
  const s0 = OTHER_SPOTS[0];
  mesh.position.set(s0.x, OTHER_LOOK.y, s0.z);
  mesh.rotation.y = yawFor(s0.facing);
  core.houseRoot.add(mesh);

  const director = createOtherDirector();
  const rig = opts.rig ?? null;
  const ghostRig = rig && isGhostRig(rig) ? rig : null;

  // —— 玩家看不看得见（给了镜头时）——
  const cam = new THREE.Vector3();
  const pw = new THREE.Vector3();
  const pv = new THREE.Matrix4();
  const frustum = new THREE.Frustum();
  const sphere = new THREE.Sphere();
  /** 每帧一次：镜头位置（换到房屋坐标）、视锥 */
  const prepareView = (r: CameraRig) => {
    const c = r.camera;
    c.updateMatrixWorld();
    core.houseRoot.updateWorldMatrix(true, false);
    pv.copy(c.matrixWorld).invert().premultiply(c.projectionMatrix);
    frustum.setFromProjectionMatrix(pv, c.coordinateSystem, c.reversedDepth);
    core.houseRoot.worldToLocal(cam.setFromMatrixPosition(c.matrixWorld));
  };
  const inView = (s: OtherSpot) => {
    if (!rig) return true;
    core.houseRoot.localToWorld(pw.set(s.x, FIGURE.chest, s.z));
    if (!frustum.intersectsSphere(sphere.set(pw, 0.8))) return false;
    if (ghostRig) {
      if (Math.hypot(cam.x - s.x, cam.z - s.z) > OTHER_LOOK.view) return false;
      // 镜头要在那面墙朝屋里的一侧（墙面 = 站位往墙那边退 fromWall），鬼魂和站位之间没有墙
      if ((cam.x - s.x) * s.nx + (cam.z - s.z) * s.nz + OTHER_LOOK.fromWall < OTHER_LOOK.wallSide) return false;
      return ghostSees(ghostRig.ghost, s);
    }
    return s.nx * rig.viewDir.x + s.nz * rig.viewDir.z >= OTHER_LOOK.faceMin;
  };

  const visitors: Vec2[] = [];
  const frame: OtherFrame = { time: 0, scaredOff: 0, dt: 0, torches, visitors, ghost: null, ghostLit: false };
  if (rig) frame.inView = inView;
  let placements = 0;
  /** 调试：最近几次撤掉的是哪个站位、为什么、出现过没有（「站位:理由+seen」） */
  const withdrawals: string[] = [];
  const apply = (e: OtherEvent) => {
    if (e.type === 'place') {
      mesh.position.set(e.spot.x, OTHER_LOOK.y, e.spot.z);
      mesh.rotation.y = yawFor(e.spot.facing);
      u.time.value = OTHER_LOOK.noise[placements++ % OTHER_LOOK.noise.length];
      u.shadow.value = 1;
    } else if (e.type === 'withdraw') {
      u.shadow.value = 0;
      withdrawals.push(`${e.spot.id}:${e.why}${e.seen ? '+seen' : ''}`);
      if (withdrawals.length > 8) withdrawals.shift();
    } else {
      for (const cb of listeners) cb();
    }
  };

  if (search?.has('debug')) {
    (window as unknown as { __otherShadow: unknown }).__otherShadow = {
      /** 放在哪（null = 没放）、今晚出现过几次、这一次被照到过没有、还剩多少（化掉时往 0 走）、uShadow、最近几次撤掉的理由 */
      state: () => ({
        spot: director.spot?.id ?? null, appeared: director.appeared, shown: director.shown, level: director.level, shadow: u.shadow.value,
        withdrawals: [...withdrawals],
      }),
      /** 下一帧没被手电碰到就放到这个站位（不管时间、次数、看不看得见）；返回站位 id，不认识的 id 返回 null */
      place(id: string = OTHER_SPOTS[0].id) {
        const s = OTHER_SPOTS.find((x) => x.id === id);
        if (s) director.force(s);
        return s?.id ?? null;
      },
      /** 马上撤（不管照没照着） */
      clear() {
        director.clear();
        u.shadow.value = 0;
      },
      /** 每个站位此刻玩家看不看得见（没给镜头时全是 true） */
      inView: () => Object.fromEntries(OTHER_SPOTS.map((s) => [s.id, inView(s)])),
      spots: OTHER_SPOTS,
      mesh,
      uniforms: u,
    };
  }

  return {
    get appeared() { return director.appeared; },
    onAppear(cb) { listeners.push(cb); },
    update(ctx: FrameCtx) {
      const st = ctx.state as Partial<WorldState>;
      visitors.length = 0;
      for (const n of st.npcs ?? []) if (n.mode !== 'gone') visitors.push(n.pos);
      const phase = st.manifest?.phase;
      frame.time = st.time ?? 0;
      frame.scaredOff = st.scaredOff ?? 0;
      frame.dt = ctx.dt;
      frame.ghost = ghostRig ? ghostRig.ghost : null;
      frame.ghostLit = ghostRevealAmount() > OTHER_LOOK.ghostLit || phase === 'windup' || phase === 'hold';
      if (rig) prepareView(rig);
      for (const e of director.step(frame)) apply(e);
      // 满 maxShown 秒以后慢慢化掉：uShadow 跟着 level 从 1 线性降到 fadeFloor（化完撤掉时 apply 已经设成 0）
      if (director.spot && director.level < 1) u.shadow.value = OTHER_LOOK.fadeFloor + (1 - OTHER_LOOK.fadeFloor) * director.level;
    },
    dispose() {
      core.houseRoot.remove(mesh);
      mat.dispose();
      own?.dispose();
      listeners.length = 0;
    },
  };
}
