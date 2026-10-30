// 第三人称鬼魂镜头与操控（2026-10-28 改版，设计文档第 9 节「第二次试玩：改成第三人称鬼魂」）。
// - 鬼魂：离地约 1.4 米、轻轻浮动；WASD（或方向键）相对朝向飘，起步、停下都是平滑的；穿墙穿家具，不做碰撞，
//   只限制在房子加外面一圈边距以内。身体和墙体（墙、窗）有重叠时 inWall = true，给穿墙效果用
// - 鼠标：开场点击时请求指针锁定，锁定后左右转朝向、上下调俯仰。Esc 或切走窗口会丢锁定：
//   界面显示「Click to resume」，在画布上点一下重新锁定（这一下不算附身，见 picking.ts）
// - 镜头：透视，在鬼魂右后上方一点（过肩：准星的视线擦着鬼魂右肩过去，不被身体挡住）。
//   跟随用临界阻尼弹簧（不过冲、不来回晃），转向只做很短的一阶平滑；滚轮调远近（1–4 米）；
//   吊臂碰到天花板或地板时（2026-10-30 eye S-3）：高度夹住、水平方向照原样往后，不再沿吊臂缩短——
//   原来往下看 30° 时镜头被压到鬼魂背后 1.1 米，鬼魂糊住三分之一屏幕。镜头和鬼魂之间隔着的墙由墙体自己溶开，这里不做镜头碰撞
// - 不做：呼吸、冲镜（设计文档「做减法」）；只留吓跑时很轻的一抖（juice.ts 调 shake）
// - 吓跑那一刻（2026-10-30 严格玩家：三位都要「看得见回报」）：镜头轻轻偏向逃跑的人，偏航最多 10°、约 0.6 秒偏过去就停，
//   之后照常归玩家（不回摆）；只在偏了能把他带进画面时才偏；玩家一动鼠标（或方向键）立刻停；减少动态、hold、没在操控时不偏。
//   见 LEAN、planLean、requestLean（flee 事件由范围霜线模块转过来，见 view/rangeFrost.ts）
// - hold（2026-10-30 试玩报告 P1-1）：点了开始、开场遮罩还挂着时，指针已经锁上，但鼠标转向、按键、F / 右键、滚轮都不算，
//   界面状态 held 告诉拾取器也别悬停、附身；放开时视角回到 hold 开始那一刻（开场时就是开场的朝向）
// 坐标：鬼魂状态用房屋米坐标；three 的世界坐标 = 房屋坐标 − 房子中心（houseRoot 的偏移，和 camera.ts 一样）
import * as THREE from 'three/webgpu';
import { CELL, GRID_H, GRID_W, HOUSE_D, HOUSE_W, Tile, WALL_H, WALL_T, buildTiles, cellOf, idx, inGrid } from '../config/house';
import { angleOf, wrapAngle } from '../lib/angle';
import type { Vec2 } from '../sim/types';
import type { CameraRig, GhostRig, GhostState } from './types';

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/**
 * 开场时鬼魂在哪、朝哪：门厅里、前门东北边约 1.5 米，面朝前门。开场的光从前门铺开（cinematic.ts），
 * 两秒后第一个访客推门进来，从鬼魂右手边约 1.3 米处走过；镜头在门厅北半边，和鬼魂之间没有墙
 */
const START = { x: 9.3, z: 10.1, heading: Math.PI / 2 };

/** 鬼魂本身 */
const GHOST = {
  /** 浮在离地多高（米）：浮动的中心 */
  height: 1.4,
  /** 浮动的幅度（米）和周期（秒）。减少动态效果时不浮动 */
  bob: 0.035,
  bobPeriod: 3.6,
  /** 最快飘多快（米/秒） */
  speed: 2.2,
  /**
   * 速度按指数逼近按键给的目标速度，这是时间常数（秒）：起步 0.22 秒（约 0.65 秒到全速的 95%），
   * 松手 0.3 秒（全速时松手再滑约 0.65 米停下）。停得比起得慢一点，读起来是「飘」，不是「走」
   */
  accel: 0.22,
  decel: 0.3,
  /** 方向键左右转的速度（弧度/秒），给没有鼠标锁定时用 */
  turnRate: 1.9,
  /** 身体的水平半径（米）：和墙体有重叠就算在墙里 */
  radius: 0.16,
  /** 能飘出房子外多远（米） */
  margin: 0.6,
};

/** 鼠标视角 */
const LOOK = {
  /** 每像素转多少弧度（约 0.13°） */
  sens: 0.0022,
  /** 单次鼠标事件最多算多少像素：有的浏览器刚锁定时第一下会报一个很大的位移 */
  maxStep: 250,
  /** 俯仰（向下为正）的范围和默认值：默认略微朝下看 */
  pitchMin: -30 * DEG,
  pitchMax: 50 * DEG,
  pitch: 4 * DEG,
  /** 转向的一阶平滑（时间常数，秒）：只滤掉鼠标事件不均匀带来的抖，几乎觉不出延迟。减少动态效果时长一点 */
  smooth: 0.045,
  smoothReduced: 0.09,
};

/** 镜头 */
const CAM = {
  /** 竖直视角（度） */
  fov: 60,
  near: 0.05,
  far: 60,
  /** 镜头绕着转的点离地多高（米）：鬼魂头部附近。不跟着浮动，镜头不会上下晃 */
  pivotY: 1.65,
  /** 离转动中心的距离（米）：默认、最近、最远，滚轮调 */
  dist: 2.4,
  distMin: 1,
  distMax: 4,
  /** 滚轮：每像素把距离乘 e^(k·px) */
  wheel: 0.0015,
  /** 距离向滚轮目标逼近的速率（每秒），一阶，不过冲 */
  distRate: 9,
  /** 构图：吊臂比视线多仰这么多，鬼魂落在准星下方一点 */
  frameDown: 4 * DEG,
  /** 过肩：镜头往鬼魂右边挪这么多（米，比身体半宽多一点），准星的视线擦着右肩过去 */
  shoulder: 0.32,
  /** 跟随的平滑时间（秒）：临界阻尼弹簧，不过冲；飘动时镜头落后约「速度 × 这个时间」（全速约 0.3 米） */
  follow: 0.14,
  /** 减少动态效果：跟得更柔，起停的加速度更小 */
  followReduced: 0.24,
  /** 镜头离天花板（= 墙高）、地板至少这么远（米） */
  ceiling: WALL_H - 0.15,
  floor: 0.3,
  /**
   * 吊臂碰到天花板、地板（2026-10-30 eye S-3）：镜头高度夹住，水平方向照吊臂原来的位置往后（不再沿吊臂压近），
   * 而且离转动中心不近于吊臂长的这个比例（往下看得很陡时水平方向本来就收得很近，再往后让一点）。
   * 原来沿吊臂缩短：默认吊臂往下看 30° 时镜头离转动中心只剩 1.1 米、48° 时 0.8 米，鬼魂糊住画面左边三分之一
   */
  keep: 0.85,
};

/**
 * 吊臂短（滚轮拉近）时镜头抬高一点（2026-10-30 eye S-3）：鬼魂往画面下方让开，不挡准星一带。
 * 吊臂 ≤ near 米时抬 y 米，到 far 米时收到 0（默认 2.4 米的吊臂不抬）；贴着天花板时照样被夹住
 */
export const LIFT = { y: 0.22, near: 1.2, far: 2 };

/**
 * 吓跑那一刻镜头轻轻偏向逃跑的人（2026-10-30 严格玩家报告：eye G-6、critic S-2、newbie S2；用户以前定过「镜头不自动转向」，
 * 这次三位都要求看得见回报，主会话定的方案：只在吓跑时、幅度宁小勿大）。
 * - max：偏航最多多少；time：偏过去用多久（秒，smootherstep，起停都是零速度），偏完就停，不回摆：之后照常归玩家
 * - comfort：人离画面中线在半个水平视角的这个比例以内，就算已经看得见，不偏；在外面就偏到他进来为止（最多 max）
 * - slack：偏满了也进不了舒服区时，偏满后他离画面边不超过这么多才偏（偏了也看不见就不白转）
 * - gap：偏过一次，从开始算这么久（秒）以内不再偏（几个人接连跑，镜头不会一路被拽着走）
 * - calm：玩家刚动过鼠标 / 方向键（这么多秒以内）不偏：他正在自己转，偏一下马上又被打断，只是一抖
 * 玩家一动鼠标（或方向键）、按下左键立刻停；减少动态、hold、没在操控（没锁定）、按着左键（正在设机关：准星一挪开手势就作废）时不偏
 */
export const LEAN = { max: 10 * DEG, time: 0.6, comfort: 0.6, slack: 3 * DEG, gap: 2.5, calm: 0.25 };

/** 规划偏多少要的镜头几何：转动中心（房屋坐标）、吊臂的水平长度、过肩、此刻的朝向、半个水平视角（弧度） */
export interface LeanView {
  pivot: Vec2;
  back: number;
  shoulder: number;
  yaw: number;
  halfH: number;
}

/** 朝向为 yaw 时镜头在哪（吊臂绕转动中心转）、看 t 在视线的哪一边：右正左负（弧度） */
function bearingFrom(v: LeanView, t: Vec2, yaw: number): number {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cx = v.pivot.x - cy * v.back - sy * v.shoulder;
  const cz = v.pivot.z - sy * v.back + cy * v.shoulder;
  return wrapAngle(angleOf(t.x - cx, t.z - cz) - yaw);
}

/** planLean 粗找的步数（之后在找到的那一格里二分） */
const LEAN_STEPS = 20;

/**
 * 吓跑的人在 targets（房屋坐标；鬼魂看得见的那些，调用方先筛）时，镜头该偏多少（弧度，右正左负，0 = 不偏）。
 * 镜头绕着鬼魂转：偏航时镜头的位置也跟着绕，贴在鬼魂身边的人在画面里挪得比偏航少，所以按真的吊臂几何算，不按「偏多少挪多少」。
 * 有一个已经在舒服区里就不偏；都在外面：每个人找最小的偏角让他进舒服区（偏满了也进不去，就看偏满时他在不在画面里），取偏得最少的那个
 */
export function planLean(v: LeanView, targets: readonly Vec2[]): number {
  const comfort = LEAN.comfort * v.halfH;
  let best = 0;
  for (const t of targets) {
    const th = bearingFrom(v, t, v.yaw);
    if (Math.abs(th) <= comfort) return 0;
    const s = Math.sign(th);
    const inside = (d: number) => Math.abs(bearingFrom(v, t, v.yaw + s * d)) <= comfort;
    let d: number | null = null;
    for (let k = 1; k <= LEAN_STEPS && d === null; k++) {
      let hi = (LEAN.max * k) / LEAN_STEPS;
      if (!inside(hi)) continue;
      let lo = (LEAN.max * (k - 1)) / LEAN_STEPS;
      for (let i = 0; i < 30; i++) {
        const m = (lo + hi) / 2;
        if (inside(m)) hi = m;
        else lo = m;
      }
      d = hi;
    }
    if (d === null) {
      if (Math.abs(bearingFrom(v, t, v.yaw + s * LEAN.max)) > v.halfH + LEAN.slack) continue;
      d = LEAN.max;
    }
    if (best === 0 || d < Math.abs(best)) best = s * d;
  }
  return best;
}

/** 每个鬼魂镜头收「有人吓跑了，在这里」的口子（requestLean 用） */
const leanHandles = new WeakMap<CameraRig, (at: Vec2) => void>();

/**
 * 有人吓跑了，他在 at（房屋坐标）：让鬼魂镜头考虑偏过去（同一帧的几个一起算，见 LEAN、planLean）。
 * 不是鬼魂镜头（娃娃屋）时什么都不做
 */
export function requestLean(rig: CameraRig, at: Vec2): void {
  leanHandles.get(rig)?.(at);
}

/**
 * 镜头此刻在哪（房屋米坐标）、每米像素数（离镜头 1 米处，CSS 像素；更远的地方除以距离）。鬼魂镜头每帧写，一页只有一个镜头；
 * 物件的外壳（view/props.ts）拿它判断镜头是不是钻进了物件里、把外壳的粗细换成屏幕像素。没建过鬼魂镜头时 active = false
 */
export const ghostCamera = { active: false, x: 0, y: 0, z: 0, pxPerM: 1 };

/** 开场：镜头从远 0.9 米处缓缓推到正常位置（只推近，没有大幅下降），时长由 intro(seconds) 给 */
const INTRO = { extra: 0.9 };

/**
 * 震动（只有吓跑会调，juice.ts）：创伤值模型，转角 = 最大角 × 创伤值² × 平滑噪声，创伤值每秒减 1。
 * 比娃娃屋镜头更轻、更慢：镜头就在鬼魂身后，同样的角度在近处更显眼
 */
const SHAKE = { roll: 0.4 * DEG, yaw: 0.15 * DEG, pitch: 0.12 * DEG, hz: [5.3, 6.1, 4.7], decay: 1 };

/** 请求指针锁定后最多等多久（毫秒）没有回音就当没锁上 */
const LOCK_WAIT_MS = 1500;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const smootherstep = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
/** 夹到 0..1 再做一次 smoothstep */
const smoothstep01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * 临界阻尼弹簧（Game Programming Gems 4「Critically Damped Ease-In/Ease-Out Smoothing」，和 Unity 的 SmoothDamp 同一个式子）：
 * 任意 dt 都稳定，不过冲；目标匀速移动时落后「速度 × time」。vel[k] 是这一维的速度，原地更新
 */
function smoothDamp(cur: number, target: number, vel: number[], k: number, time: number, dt: number) {
  const omega = 2 / time;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel[k] + omega * change) * dt;
  vel[k] = (vel[k] - omega * temp) * e;
  return target + (change + temp) * e;
}

/** 两条不成整数比的正弦叠起来的平滑噪声（−1..1），震动用 */
const sway = (t: number, hz: number, phase: number) =>
  0.62 * Math.sin(TAU * hz * t + phase) + 0.38 * Math.sin(TAU * hz * 1.73 * t + phase * 2.3);

// ── 墙体占地：判断「在墙里」和鬼魂的视线 ───────────────────────────────────

interface Box2 { x0: number; z0: number; x1: number; z1: number }
const wallish = (t: number) => t === Tile.Wall || t === Tile.Window;
/** 4 个方向按顺时针排：k + 2 是反方向，k ± 1 是两侧（和 view/walls.ts 一样） */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

/**
 * 墙体在平面上的占地，按格子存：每个墙格（含窗格）一根 WALL_T 见方的柱，向相邻的墙格各伸一条臂到格子边界；
 * 一段直墙的尽头（门洞两侧）也伸到格子边界。和 view/walls.ts 画墙的规则一样，「在墙里」和看到的墙对得上
 */
function wallFootprint(tiles: Uint8Array): (Box2[] | null)[] {
  const at = (i: number, j: number) => (inGrid(i, j) ? tiles[idx(i, j)] : -1);
  const out: (Box2[] | null)[] = new Array(tiles.length).fill(null);
  const t = WALL_T / 2;
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      if (!wallish(at(i, j))) continue;
      const cx = (i + 0.5) * CELL, cz = (j + 0.5) * CELL;
      const has = DIRS.map(([dx, dz]) => wallish(at(i + dx, j + dz)));
      const boxes: Box2[] = [{ x0: cx - t, z0: cz - t, x1: cx + t, z1: cz + t }];
      DIRS.forEach(([dx, dz], k) => {
        const end = !has[k] && has[(k + 2) % 4] && !has[(k + 1) % 4] && !has[(k + 3) % 4] && at(i + dx, j + dz) >= 0;
        if (!has[k] && !end) return;
        boxes.push({
          x0: dx > 0 ? cx : dx < 0 ? i * CELL : cx - t,
          x1: dx > 0 ? (i + 1) * CELL : dx < 0 ? cx : cx + t,
          z0: dz > 0 ? cz : dz < 0 ? j * CELL : cz - t,
          z1: dz > 0 ? (j + 1) * CELL : dz < 0 ? cz : cz + t,
        });
      });
      out[idx(i, j)] = boxes;
    }
  }
  return out;
}

/** 墙体占地只和布局有关，整页共用一份，第一次用到时才算 */
let footprintCache: (Box2[] | null)[] | null = null;
const footprint = () => (footprintCache ??= wallFootprint(buildTiles()));

/** 平面上这一点在不在墙体（墙、窗）里；r > 0 时是半径 r 的圆和墙体有没有重叠 */
function inWallAt(x: number, z: number, r = 0): boolean {
  const fp = footprint();
  const [i0, j0] = cellOf(x - r, z - r), [i1, j1] = cellOf(x + r, z + r);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const boxes = inGrid(i, j) ? fp[idx(i, j)] : null;
      if (!boxes) continue;
      for (const b of boxes) {
        const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1);
        if (r > 0 ? dx * dx + dz * dz < r * r : dx === 0 && dz === 0) return true;
      }
    }
  }
  return false;
}

/** 视线检查的步长（米）：比墙厚（WALL_T）的一半还小，跳不过一面墙；两端各留这么长不查 */
const SIGHT_STEP = 0.08;
const SIGHT_SKIP = 0.2;

/**
 * 鬼魂从 a 看 b（房屋米坐标，平面上）中间有没有墙。按看得见的墙体算，不按 0.5 米的格子：
 * 斜着穿过 1 米宽的门洞也算看得见（格子的 Bresenham 会擦到门边的墙格）。窗也挡（玻璃后面的东西碰不到）。
 * 两端各留 SIGHT_SKIP 不查：鬼魂穿墙时半个身子在墙里，墙两边都算看得见；物件、访客贴着墙也不受影响。
 * 拾取（够不够得着）和叠层（名牌、眼睛显不显示）共用
 */
export function ghostSees(a: Vec2, b: Vec2): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len <= 2 * SIGHT_SKIP) return true;
  const n = Math.ceil((len - 2 * SIGHT_SKIP) / SIGHT_STEP);
  for (let k = 0; k <= n; k++) {
    const t = (SIGHT_SKIP + ((len - 2 * SIGHT_SKIP) * k) / n) / len;
    if (inWallAt(a.x + dx * t, a.z + dz * t)) return false;
  }
  return true;
}

// ── 给界面和拾取的状态 ───────────────────────────────────────────
// main.ts 先建界面、后建镜头，界面拿不到 rig；拾取（picking.ts）也要知道「现在点一下是附身还是重新锁定」。
// 一页只有一个镜头，所以用模块级的状态 + 订阅，不用改 main.ts 的接线

export interface GhostUi {
  /** 用的是第三人称鬼魂镜头（建过 createGhostRig） */
  active: boolean;
  /** 已经开场（调过 lockPointer）：之后没锁定就提示「点一下继续」 */
  engaged: boolean;
  /** 鼠标此刻在操控鬼魂：指针锁定中，或调试接口假装锁定 */
  locked: boolean;
  /** 刚请求了锁定、还没有结果（一般不到 0.1 秒）：这段时间不提示，免得「点一下继续」闪一下 */
  pending: boolean;
  /** 准星此刻对着哪个够得着的物件（picking.ts 写） */
  aim: string | null;
  /**
   * 准星此刻对着哪个看得见、但够不着（离鬼魂 4–10 米）的物件（picking.ts 每帧写；对着够得着的时为 null）：
   * 标签写 Too far away.、准星外圈变虚线（2026-10-30 手感分析 FEEL-7）
   */
  aimFar: string | null;
  /** 现身的冷却还剩多少（0..1，1 = 刚用、0 = 可以再用；main.ts 每帧按模拟写）：准星外面那圈很淡的环 */
  manifestCooldown: number;
  /**
   * 不收输入（GhostRig.hold，2026-10-30 试玩报告 P1-1）：点了开始、开场遮罩还挂着。指针已经锁上，但鼠标、按键都不算；
   * 拾取器这时也不悬停、不附身（准星还没出来）
   */
  held: boolean;
  /**
   * 左键此刻按着（操控中按下的才算，hold 时不算；松开、丢了锁定、切走窗口、hold 时清掉）。
   * 物件（view/props.ts）拿它画「按住设机关」的蓄力：物件上的霜从下往上长（2026-10-30 eye S-5）。
   * 按住手势本身（够不够 TRAP.holdToArm 秒、准星移开就作废）还是拾取器管（picking.ts），这里只说按没按着
   */
  pressing: boolean;
}

const ui: GhostUi = { active: false, engaged: false, locked: false, pending: false, aim: null, aimFar: null, manifestCooldown: 0, held: false, pressing: false };
const uiCbs = new Set<(s: Readonly<GhostUi>) => void>();

/** 订阅第三人称的界面状态：注册时先按当前值回调一次，之后每次变化回调；返回取消订阅的函数 */
export function watchGhostUi(cb: (s: Readonly<GhostUi>) => void): () => void {
  uiCbs.add(cb);
  cb(ui);
  return () => { uiCbs.delete(cb); };
}

/** 改界面状态，有变化才通知 */
export function setGhostUi(patch: Partial<GhostUi>): void {
  if (!(Object.keys(patch) as (keyof GhostUi)[]).some((k) => patch[k] !== ui[k])) return;
  Object.assign(ui, patch);
  for (const cb of uiCbs) cb(ui);
}

// ── 调试口（debug.ts 用，正式游戏不用） ─────────────────────────────

export interface GhostRigDebug {
  /**
   * 视角的内部量：yaw / pitch（弧度，pitch 向下为正）、镜头距离（米，滚轮目标）、镜头位置（房屋米坐标）、
   * back（吊臂此刻的水平长度，米）、leaning（吓跑时正在偏过去）
   */
  view(): { yaw: number; pitch: number; dist: number; cam: { x: number; y: number; z: number }; back: number; leaning: boolean };
  /** 此刻规划「偏多少」用的镜头几何（planLean 的第一个参数） */
  leanView(): LeanView;
  /** 把鬼魂放到房屋坐标 (x, z)（限制在边界内），可选朝向、俯仰；速度清零，镜头立刻就位 */
  place(x: number, z: number, heading?: number, pitch?: number): void;
  /** 转向，让准星（画面正中）对准房屋坐标 (x, y, z)；镜头立刻就位 */
  aim(x: number, y: number, z: number): void;
  /** 镜头距离（米），立刻就位 */
  setDist(d: number): void;
  /** 假装指针锁定（无头浏览器里锁不上）：鼠标转向、准星、点击附身都照锁定时一样 */
  fakeLock(on: boolean): void;
}

const debugHandles = new WeakMap<GhostRig, GhostRigDebug>();
export const ghostRigDebug = (rig: GhostRig): GhostRigDebug | null => debugHandles.get(rig) ?? null;

// ── 镜头 ────────────────────────────────────────────────────

export function createGhostRig(canvas: HTMLCanvasElement): GhostRig {
  let width = Math.max(1, canvas.clientWidth);
  let height = Math.max(1, canvas.clientHeight);
  const camera = new THREE.PerspectiveCamera(CAM.fov, width / height, CAM.near, CAM.far);
  /** 离镜头 1 米处每米多少 CSS 像素（竖直视角按画布高度铺开），给 ghostCamera */
  const pxPerM = () => height / (2 * Math.tan((CAM.fov / 2) * DEG));
  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => reducedMq?.matches === true;

  const ghost: GhostState = { x: START.x, y: GHOST.height, z: START.z, heading: START.heading, speed: 0, inWall: false };
  ghost.inWall = inWallAt(ghost.x, ghost.z, GHOST.radius);
  let vx = 0, vz = 0;
  /** 朝向、俯仰、距离：输入改目标值（T），实际值平滑追过去。朝向不取模，一直累加，平滑时不会绕远路 */
  let yawT = START.heading, yaw = yawT;
  let pitchT = LOOK.pitch, pitch = pitchT;
  let distT = CAM.dist, dist = distT;
  /** 镜头跟随的点（房屋坐标 x、z，不含浮动）和它的速度 */
  let followX = ghost.x, followZ = ghost.z;
  const followV = [0, 0];
  let clock = 0;
  /** 浮动的相位（秒）：定住时不走，浮动停在那一刻的高度 */
  let bobClock = 0;
  /** 现身的蓄力和停留期间定住（pin） */
  let pinned = false;
  /** 不收输入（hold）：开场遮罩还挂着。held 是按住的键，这个是整个操控停着 */
  let holding = false;
  /** hold 开始那一刻的视角（目标值）：放开时回到这里。开场时就是开场的朝向（这之前鬼魂没动过：没开场不收输入） */
  let heldView = { yaw: yawT, pitch: pitchT };
  let trauma = 0;
  let intro: { t: number; dur: number } | null = null;
  /** 镜头位置（房屋米坐标），调试口和 viewDir 用 */
  const camAt = { x: 0, y: 0, z: 0 };
  /** 吊臂此刻的水平长度（米，碰到天花板时也是实际的），规划吓跑时偏多少用 */
  let boomBack = CAM.dist;
  const viewDir: Vec2 = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
  const look = new THREE.Vector3();
  const v = new THREE.Vector3();

  // 吓跑时偏过去（LEAN）：这一帧收到的逃跑的人（下一次 update 一起算）、正在偏的这一下、上一次开始偏的时刻、玩家上一次自己转视角的时刻（clock 秒）
  const leanQueue: Vec2[] = [];
  let lean: { delta: number; t: number; done: number } | null = null;
  let leanAt = -Infinity;
  let lastLook = -Infinity;
  /** 玩家自己转了视角（鼠标、方向键）：正在偏的立刻停（偏到哪算哪，不跳回去），记下时刻 */
  const steer = () => {
    lean = null;
    lastLook = clock;
  };
  const leanView = (): LeanView => ({
    pivot: { x: followX, z: followZ },
    back: boomBack,
    shoulder: CAM.shoulder,
    yaw: yawT,
    halfH: Math.atan(Math.tan((CAM.fov / 2) * DEG) * camera.aspect),
  });

  /** 按此刻的跟随点、朝向、俯仰摆镜头。len0 = 想要的吊臂长度 */
  const placeCamera = (len0: number) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // 吊臂：从转动中心往后、往上，仰角 = 俯仰 + 构图角。碰到天花板或地板：高度夹住，水平方向照原样往后，
    // 离转动中心不近于 keep × 吊臂长（CAM.keep；原来沿吊臂缩短，往下看时镜头被压到鬼魂背上）
    const phi = pitch + CAM.frameDown;
    // 吊臂短时抬高一点（LIFT）
    const lift = LIFT.y * (1 - smoothstep01((len0 - LIFT.near) / (LIFT.far - LIFT.near)));
    let up = len0 * Math.sin(phi) + lift;
    let back = len0 * Math.cos(phi);
    const top = CAM.ceiling - CAM.pivotY, bottom = CAM.floor - CAM.pivotY;
    if (up > top || up < bottom) {
      up = clamp(up, bottom, top);
      const keep = CAM.keep * len0;
      if (back * back + up * up < keep * keep) back = Math.sqrt(keep * keep - up * up);
    }
    boomBack = back;
    // 前 = (cos, sin)，右 = (−sin, cos)
    camAt.x = followX - cy * back - sy * CAM.shoulder;
    camAt.z = followZ - sy * back + cy * CAM.shoulder;
    camAt.y = CAM.pivotY + up;
    camera.position.set(camAt.x - HOUSE_W / 2, camAt.y, camAt.z - HOUSE_D / 2);
    ghostCamera.active = true;
    ghostCamera.x = camAt.x;
    ghostCamera.y = camAt.y;
    ghostCamera.z = camAt.z;

    // 视线：朝向 + 俯仰，再叠上震动（只转不移）
    let a = yaw, e = pitch, roll = 0;
    if (trauma > 0) {
      const s = trauma * trauma;
      roll = s * SHAKE.roll * sway(clock, SHAKE.hz[0], 0.3);
      a += s * SHAKE.yaw * sway(clock, SHAKE.hz[1], 1.9);
      e += s * SHAKE.pitch * sway(clock, SHAKE.hz[2], 4.1);
    }
    const ce = Math.cos(e);
    look.set(camera.position.x + Math.cos(a) * ce, camera.position.y - Math.sin(e), camera.position.z + Math.sin(a) * ce);
    camera.up.set(0, 1, 0);
    camera.lookAt(look);
    if (roll !== 0) camera.rotateZ(roll);
    camera.updateMatrixWorld();

    // viewDir：水平面上从鬼魂指向镜头
    const dx = camAt.x - ghost.x, dz = camAt.z - ghost.z, dl = Math.hypot(dx, dz);
    if (dl > 1e-4) {
      viewDir.x = dx / dl;
      viewDir.z = dz / dl;
    } else {
      viewDir.x = -cy;
      viewDir.z = -sy;
    }
  };

  // ── 输入 ──────────────────────────────────────────────
  /** 按住的键（KeyboardEvent.code：按物理位置，AZERTY 键盘上同样是左手那四个键） */
  const held = new Set<string>();
  const MOVE = new Map<string, [number, number]>([
    ['KeyW', [1, 0]], ['ArrowUp', [1, 0]], ['KeyS', [-1, 0]], ['ArrowDown', [-1, 0]], ['KeyA', [0, -1]], ['KeyD', [0, 1]],
  ]);
  const TURN = new Map<string, number>([['ArrowLeft', -1], ['ArrowRight', 1]]);
  /** 现身（右键或 F）：只在操控鬼魂时算，没锁定时那一下是「点一下继续」 */
  const manifestCbs: (() => void)[] = [];
  const manifest = () => { for (const cb of manifestCbs) cb(); };
  addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return; // 浏览器快捷键，松开时可能收不到 keyup
    if (MOVE.has(e.code) || TURN.has(e.code)) held.add(e.code);
    if (e.code === 'KeyF' && !e.repeat && controlling() && !holding) manifest();
  });
  addEventListener('keyup', (e) => { held.delete(e.code); });
  // 切走窗口时 keyup 收不到：全部松开，鬼魂不会自己一直飘；左键也当松开了
  addEventListener('blur', () => {
    held.clear();
    setGhostUi({ pressing: false });
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) held.clear(); });

  // 指针锁定：开场点击时请求；丢了（Esc、切走窗口）之后，开场过的话在画布上点一下重新请求
  let engaged = false;
  let fake = false;
  let pending = false;
  let pendingTimer = 0;
  const realLocked = () => document.pointerLockElement === canvas;
  const controlling = () => realLocked() || fake;
  // 不在操控（丢了锁定）、hold 着时左键不算按着
  const publish = () => setGhostUi({ engaged, locked: controlling(), pending, held: holding, ...(controlling() && !holding ? {} : { pressing: false }) });
  const settle = () => {
    pending = false;
    clearTimeout(pendingTimer);
    publish();
  };
  const requestLock = () => {
    if (realLocked() || typeof canvas.requestPointerLock !== 'function') return;
    pending = true;
    publish();
    clearTimeout(pendingTimer);
    pendingTimer = window.setTimeout(settle, LOCK_WAIT_MS);
    try {
      // 新浏览器返回 Promise：被拒（刚按过 Esc 马上又点、无头浏览器）只当没锁上，不报错
      const r: unknown = canvas.requestPointerLock();
      if (r instanceof Promise) r.catch(settle);
    } catch {
      settle();
    }
  };
  document.addEventListener('pointerlockchange', settle);
  document.addEventListener('pointerlockerror', settle);
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2 && controlling()) {
      if (!holding) manifest();
      return;
    }
    // 左键按着（GhostUi.pressing）：物件画「按住设机关」的蓄力
    // 按下左键也算玩家接手：吓跑时正在偏的那一下立刻停（LEAN）
    if (e.button === 0 && controlling() && !holding) {
      setGhostUi({ pressing: true });
      steer();
    }
    if (e.button !== 0 || !engaged || controlling()) return;
    requestLock();
  });
  // 左键松开：pointerup，或者叠加按键时松开的那个 pointermove（buttons 的左键位没了，见 picking.ts 的 createHoldInput）
  const release = (e: PointerEvent) => {
    if ((e.buttons & 1) === 0) setGhostUi({ pressing: false });
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointermove', release);
  canvas.addEventListener('pointercancel', () => setGhostUi({ pressing: false }));
  // 右键是现身：画布上不弹浏览器菜单（没锁定时也不弹，免得点一下继续时误开）
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('mousemove', (e) => {
    if (!controlling() || holding) return;
    const mx = Number.isFinite(e.movementX) ? clamp(e.movementX, -LOOK.maxStep, LOOK.maxStep) : 0;
    const my = Number.isFinite(e.movementY) ? clamp(e.movementY, -LOOK.maxStep, LOOK.maxStep) : 0;
    // 玩家一动鼠标，吓跑时正在偏的那一下立刻停（LEAN）
    if (mx !== 0 || my !== 0) steer();
    yawT += mx * LOOK.sens;
    pitchT = clamp(pitchT + my * LOOK.sens, LOOK.pitchMin, LOOK.pitchMax);
  });

  // 滚轮调远近；preventDefault 挡住触控板双指缩放把整页放大。hold 期间也不算（开场的构图连远近一起留着）
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (holding) return;
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    rig.zoom(Math.exp(-clamp(px, -200, 200) * CAM.wheel));
  }, { passive: false });

  const clampToHouse = () => {
    const m = GHOST.margin;
    if (ghost.x < -m) { ghost.x = -m; vx = Math.max(0, vx); } else if (ghost.x > HOUSE_W + m) { ghost.x = HOUSE_W + m; vx = Math.min(0, vx); }
    if (ghost.z < -m) { ghost.z = -m; vz = Math.max(0, vz); } else if (ghost.z > HOUSE_D + m) { ghost.z = HOUSE_D + m; vz = Math.min(0, vz); }
  };

  const rig: GhostRig = {
    camera,
    ghost,
    get quarter() { return 0; },
    get viewDir() { return viewDir; },
    // 第三人称没有 90° 旋转（Q / E 在界面里也不接）
    rotate() {},
    zoom(factor) {
      if (factor > 0) distT = clamp(distT / factor, CAM.distMin, CAM.distMax);
    },
    shake(amount) {
      if (amount > 0) trauma = Math.min(1, trauma + amount);
    },
    intro(seconds) {
      intro = { t: 0, dur: Math.max(0.01, seconds) };
      placeCamera(dist + INTRO.extra);
    },
    onRotate() {},
    update(dt) {
      clock += dt;
      const calm = reduced();

      // 按键：开场之前、hold 期间不动（开场遮罩后面的鬼魂停在起点）；现身期间定住，只能转视角
      let fwd = 0, side = 0, turn = 0;
      if (engaged && !holding) {
        for (const code of held) {
          const m = MOVE.get(code);
          if (m && !pinned) { fwd += m[0]; side += m[1]; }
          turn += TURN.get(code) ?? 0;
        }
      }
      yawT += clamp(turn, -1, 1) * GHOST.turnRate * dt;
      if (turn !== 0) steer();

      // 吓跑的人（requestLean，上一帧和这一帧之间收到的一起算）：鬼魂看得见的那些里，能偏进画面就开始偏（LEAN、planLean）
      if (leanQueue.length > 0) {
        const fled = leanQueue.splice(0);
        if (!lean && !calm && !holding && !ui.pressing && controlling() && clock - leanAt >= LEAN.gap && clock - lastLook >= LEAN.calm) {
          const seen = fled.filter((p) => ghostSees(ghost, p));
          const d = seen.length > 0 ? planLean(leanView(), seen) : 0;
          if (d !== 0) {
            lean = { delta: d, t: 0, done: 0 };
            leanAt = clock;
          }
        }
      }
      // 正在偏：把这一帧该转的那一截加到朝向的目标上（和鼠标转向走同一条平滑），偏完就停，不回摆
      if (lean) {
        lean.t += dt;
        const u = Math.min(1, lean.t / LEAN.time);
        const k = smootherstep(u);
        yawT += lean.delta * (k - lean.done);
        lean.done = k;
        if (u >= 1) lean = null;
      }

      // 视角：一阶平滑追目标（不过冲）
      const kLook = 1 - Math.exp(-dt / (calm ? LOOK.smoothReduced : LOOK.smooth));
      yaw += (yawT - yaw) * kLook;
      pitch += (pitchT - pitch) * kLook;
      dist += (distT - dist) * (1 - Math.exp(-dt * CAM.distRate));

      // 移动：相对朝向，斜着走不更快；速度按指数逼近目标
      fwd = clamp(fwd, -1, 1);
      side = clamp(side, -1, 1);
      const n = Math.hypot(fwd, side);
      const s = n > 1 ? GHOST.speed / n : GHOST.speed;
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const tx = (fwd * cy - side * sy) * s, tz = (fwd * sy + side * cy) * s;
      const kMove = 1 - Math.exp(-dt / (n > 0 ? GHOST.accel : GHOST.decel));
      vx += (tx - vx) * kMove;
      vz += (tz - vz) * kMove;
      // 定住：立刻停（不滑）。模拟按蓄力开始那一刻的位置结算现身，鬼魂再滑出半米，画面上现身的地方就对不上了
      if ((n === 0 && Math.hypot(vx, vz) < 1e-3) || pinned) vx = vz = 0;
      ghost.x += vx * dt;
      ghost.z += vz * dt;
      clampToHouse();
      ghost.speed = Math.hypot(vx, vz);
      // 定住时身体朝向也停住（现身时鬼魂不动），视角照常转，镜头绕着它看；放开后身体再转回视角的方向
      if (!pinned) {
        ghost.heading = wrapAngle(yaw);
        bobClock += dt;
      }
      ghost.y = GHOST.height + (calm ? 0 : GHOST.bob * Math.sin((bobClock / GHOST.bobPeriod) * TAU));
      ghost.inWall = inWallAt(ghost.x, ghost.z, GHOST.radius);

      // 镜头：跟随点用临界阻尼弹簧追鬼魂（不含浮动），开场时吊臂先长一截再缓缓收回
      const follow = calm ? CAM.followReduced : CAM.follow;
      followX = smoothDamp(followX, ghost.x, followV, 0, follow, dt);
      followZ = smoothDamp(followZ, ghost.z, followV, 1, follow, dt);
      let extra = 0;
      if (intro) {
        intro.t += dt;
        const u = Math.min(1, intro.t / intro.dur);
        extra = INTRO.extra * (1 - smootherstep(u));
        if (u >= 1) intro = null;
      }
      trauma = Math.max(0, trauma - dt * SHAKE.decay);
      placeCamera(dist + extra);
    },
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      ghostCamera.pxPerM = pxPerM();
    },
    toScreen(p, y = 0) {
      v.set(p.x - HOUSE_W / 2, y, p.z - HOUSE_D / 2).applyMatrix4(camera.matrixWorldInverse);
      // 在镜头背后（或贴着镜头）：投影出来的位置是镜像的，没有意义
      if (v.z > -CAM.near) return { x: NaN, y: NaN };
      v.applyMatrix4(camera.projectionMatrix);
      const w = canvas.clientWidth || width, h = canvas.clientHeight || height;
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    },
    lockPointer() {
      engaged = true;
      // 必须同步调：浏览器只认用户手势调用栈里的请求
      requestLock();
      publish();
    },
    onManifest(cb) {
      manifestCbs.push(cb);
    },
    pin(on) {
      pinned = on;
    },
    hold(on) {
      if (on === holding) return;
      holding = on;
      if (on) {
        heldView = { yaw: yawT, pitch: pitchT };
        // 正在偏的、排着的吓跑都不要了（放开时视角回到这一刻）
        lean = null;
        leanQueue.length = 0;
      } else {
        // 视角回到 hold 开始那一刻（开场时就是开场的朝向）。实际值一起就位：平滑不会把镜头从别处扫回来
        yawT = yaw = heldView.yaw;
        pitchT = pitch = heldView.pitch;
        ghost.heading = wrapAngle(yaw);
      }
      publish();
    },
  };

  // ── 调试口 ──────────────────────────────────────────────
  /** 实际值直接等于目标值、跟随点直接放到鬼魂身上：镜头立刻就位 */
  const snap = () => {
    yaw = yawT;
    pitch = pitchT;
    dist = distT;
    followX = ghost.x;
    followZ = ghost.z;
    followV[0] = followV[1] = 0;
    placeCamera(dist);
  };
  /** 调试口挪鬼魂、对准：是「换了一个场面」，正在偏的、排着的、偏过一次的间隔都清掉 */
  const resetLean = () => {
    lean = null;
    leanQueue.length = 0;
    leanAt = -Infinity;
  };
  debugHandles.set(rig, {
    view: () => ({ yaw, pitch, dist: distT, cam: { ...camAt }, back: boomBack, leaning: lean !== null }),
    leanView,
    place(x, z, heading, p) {
      resetLean();
      ghost.x = x;
      ghost.z = z;
      vx = vz = 0;
      clampToHouse();
      ghost.speed = 0;
      if (heading !== undefined) yawT = yaw + wrapAngle(heading - yaw);
      if (p !== undefined) pitchT = clamp(p, LOOK.pitchMin, LOOK.pitchMax);
      ghost.heading = wrapAngle(yawT);
      ghost.inWall = inWallAt(ghost.x, ghost.z, GHOST.radius);
      snap();
    },
    aim(x, y, z) {
      resetLean();
      // 镜头位置跟着朝向变（过肩、吊臂），迭代几次就收敛
      for (let k = 0; k < 8; k++) {
        snap();
        const dx = x - camAt.x, dz = z - camAt.z;
        yawT = yaw + wrapAngle(Math.atan2(dz, dx) - yaw);
        pitchT = clamp(Math.atan2(camAt.y - y, Math.hypot(dx, dz)), LOOK.pitchMin, LOOK.pitchMax);
      }
      ghost.heading = wrapAngle(yawT);
      snap();
    },
    setDist(d) {
      distT = clamp(d, CAM.distMin, CAM.distMax);
      snap();
    },
    fakeLock(on) {
      fake = on;
      publish();
    },
  });

  leanHandles.set(rig, (at) => { leanQueue.push({ x: at.x, z: at.z }); });
  ghostCamera.pxPerM = pxPerM();
  setGhostUi({ active: true });
  publish();
  placeCamera(dist);
  return rig;
}
