// 第三人称鬼魂镜头与操控（2026-10-28 改版，设计文档第 9 节「第二次试玩：改成第三人称鬼魂」）。
// - 鬼魂：离地约 1.4 米、轻轻浮动；WASD（或方向键）相对朝向飘，起步、停下都是平滑的；穿墙穿家具，不做碰撞，
//   只限制在房子加外面一圈边距以内。身体和墙体（墙、窗）有重叠时 inWall = true，给穿墙效果用
// - 鼠标：开场点击时请求指针锁定，锁定后左右转朝向、上下调俯仰。Esc 或切走窗口会丢锁定：
//   界面显示「Click to resume」，在画布上点一下重新锁定（这一下不算附身，见 picking.ts）
// - 镜头：透视，在鬼魂右后上方一点（过肩：准星的视线擦着鬼魂右肩过去，不被身体挡住）。
//   跟随用临界阻尼弹簧（不过冲、不来回晃），转向只做很短的一阶平滑；滚轮调远近（1–4 米）；
//   吊臂碰到天花板或地板时沿吊臂缩短。镜头和鬼魂之间隔着的墙由墙体自己溶开，这里不做镜头碰撞
// - 不做：呼吸、冲镜（设计文档「做减法」）；只留吓跑时很轻的一抖（juice.ts 调 shake）
// 坐标：鬼魂状态用房屋米坐标；three 的世界坐标 = 房屋坐标 − 房子中心（houseRoot 的偏移，和 camera.ts 一样）
import * as THREE from 'three/webgpu';
import { CELL, GRID_H, GRID_W, HOUSE_D, HOUSE_W, Tile, WALL_H, WALL_T, buildTiles, cellOf, idx, inGrid } from '../config/house';
import { wrapAngle } from '../lib/angle';
import type { Vec2 } from '../sim/types';
import type { GhostRig, GhostState } from './types';

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
  /** 吊臂被天花板、地板压短时最短多少（米） */
  minLen: 0.3,
};

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
  /** 现身的冷却还剩多少（0..1，1 = 刚用、0 = 可以再用；main.ts 每帧按模拟写）：准星外面那圈很淡的环 */
  manifestCooldown: number;
}

const ui: GhostUi = { active: false, engaged: false, locked: false, pending: false, aim: null, manifestCooldown: 0 };
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
  /** 视角的内部量：yaw / pitch（弧度，pitch 向下为正）、镜头距离（米，滚轮目标）、镜头位置（房屋米坐标） */
  view(): { yaw: number; pitch: number; dist: number; cam: { x: number; y: number; z: number } };
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
  let trauma = 0;
  let intro: { t: number; dur: number } | null = null;
  /** 镜头位置（房屋米坐标），调试口和 viewDir 用 */
  const camAt = { x: 0, y: 0, z: 0 };
  const viewDir: Vec2 = { x: -Math.cos(yaw), z: -Math.sin(yaw) };
  const look = new THREE.Vector3();
  const v = new THREE.Vector3();

  /** 按此刻的跟随点、朝向、俯仰摆镜头。len0 = 想要的吊臂长度 */
  const placeCamera = (len0: number) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    // 吊臂：从转动中心往后、往上，仰角 = 俯仰 + 构图角；碰到天花板或地板就沿吊臂缩短
    const phi = pitch + CAM.frameDown;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    let len = len0;
    if (CAM.pivotY + len * sp > CAM.ceiling) len = (CAM.ceiling - CAM.pivotY) / sp;
    else if (CAM.pivotY + len * sp < CAM.floor) len = (CAM.floor - CAM.pivotY) / sp;
    len = Math.max(CAM.minLen, len);
    // 前 = (cos, sin)，右 = (−sin, cos)
    camAt.x = followX - cy * cp * len - sy * CAM.shoulder;
    camAt.z = followZ - sy * cp * len + cy * CAM.shoulder;
    camAt.y = CAM.pivotY + sp * len;
    camera.position.set(camAt.x - HOUSE_W / 2, camAt.y, camAt.z - HOUSE_D / 2);

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
    if (e.code === 'KeyF' && !e.repeat && controlling()) manifest();
  });
  addEventListener('keyup', (e) => { held.delete(e.code); });
  // 切走窗口时 keyup 收不到：全部松开，鬼魂不会自己一直飘
  addEventListener('blur', () => held.clear());
  document.addEventListener('visibilitychange', () => { if (document.hidden) held.clear(); });

  // 指针锁定：开场点击时请求；丢了（Esc、切走窗口）之后，开场过的话在画布上点一下重新请求
  let engaged = false;
  let fake = false;
  let pending = false;
  let pendingTimer = 0;
  const realLocked = () => document.pointerLockElement === canvas;
  const controlling = () => realLocked() || fake;
  const publish = () => setGhostUi({ engaged, locked: controlling(), pending });
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
      manifest();
      return;
    }
    if (e.button !== 0 || !engaged || controlling()) return;
    requestLock();
  });
  // 右键是现身：画布上不弹浏览器菜单（没锁定时也不弹，免得点一下继续时误开）
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('mousemove', (e) => {
    if (!controlling()) return;
    const mx = Number.isFinite(e.movementX) ? clamp(e.movementX, -LOOK.maxStep, LOOK.maxStep) : 0;
    const my = Number.isFinite(e.movementY) ? clamp(e.movementY, -LOOK.maxStep, LOOK.maxStep) : 0;
    yawT += mx * LOOK.sens;
    pitchT = clamp(pitchT + my * LOOK.sens, LOOK.pitchMin, LOOK.pitchMax);
  });

  // 滚轮调远近；preventDefault 挡住触控板双指缩放把整页放大
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
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

      // 按键：开场之前不动（开场遮罩后面的鬼魂停在起点）；现身期间定住，只能转视角
      let fwd = 0, side = 0, turn = 0;
      if (engaged) {
        for (const code of held) {
          const m = MOVE.get(code);
          if (m && !pinned) { fwd += m[0]; side += m[1]; }
          turn += TURN.get(code) ?? 0;
        }
      }
      yawT += clamp(turn, -1, 1) * GHOST.turnRate * dt;

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
  debugHandles.set(rig, {
    view: () => ({ yaw, pitch, dist: distT, cam: { ...camAt } }),
    place(x, z, heading, p) {
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

  setGhostUi({ active: true });
  publish();
  placeCamera(dist);
  return rig;
}
