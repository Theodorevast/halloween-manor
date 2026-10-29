// 地上的范围霜线（2026-10-30，手感 FEEL-2、FEEL-11）：试玩时「不知道在什么范围内可以吓到他」。
// - 准星（触屏是手指）对上物件时，地上用极淡的一道霜画出这个物件的范围：被墙、门洞切开的真形状（惊吓类：看得见它、站在正面；
//   引诱类：听得见它）。移开就退掉；冷却中的物件也画，整体减半（告诉你范围，但不是出手的时候）
// - 现身蓄力时，霜线从鬼魂脚下往外跑到 5 米（蓄力时就转过来、落下时被吓到的那一圈），停到收回，再化掉；
//   冷却好了的那一刻（没瞄着物件时），脚下的霜往外轻轻呼一次，到 5 米为止，比蓄力时淡
// 「鬼的寒气到这里为止」：和墙上溶开的霜、现身脚下的霜（frost.ts）是同一种东西。受光、不发光，只带墙霜那一点点自发光
// （DISSOLVE.frostGlow，暗处隐约看得出），线上略提光泽（手电扫过有一点反光）。不是霓虹圈，不是界面
//
// 范围怎么算：和模拟结算同一套规则，直接调模拟的 canSee / canHear / facesToward（见 inRange），不另写一份。
// 地面按 0.125 米一格（128 × 96，盖满 16 × 12 米），每格的格心问一次「站在这里、看着它的访客会不会被这一下影响」，得到二值图；
// 再做精确的欧氏距离变换，得到「到范围边界的有符号距离」（里面为正，夹在 ±FIELD.clamp 米），存进一张 RGBA8 纹理的一个通道。
// 墙格、窗格不参与：量距离时既不算里面也不算外面，墙两边的地板都不会因为挨着墙出线；墙格自己的值跟最近的地板走
// （两格以内），里外翻号的地方落在墙身里（墙体居中画 0.2 米），看不见。于是只有三种地方出线：距离到头、视线被挡（门洞外那一楔）、
// 有正面的物件正面以外那一侧。视线是 0.5 米一格的 Bresenham，被挡的那一楔边上是台阶，画之前把有符号距离磨一下（smoothField），
// 线是斜的，不是蛇形的折线；二值图本身（和结算对账的那张）不磨
// 9 个物件的范围开场后趁空闲各算一次（几毫秒一个；第一次瞄准时还没算到就现算），之后一直缓存；现身那张在 windup 事件里现算
//
// 画法：一块贴地的方片（高过地毯和现身的霜），只盖住正在画的范围的外接框；不用的时候整个藏起来，一点都不画。
// 两张物件的范围（换着瞄时一张退、一张进）和现身那一张各占纹理的一个通道，片元里取一次纹理、算一两次噪声。
// 高档、低档各一份材质（低档不叠冰晶），切画质只换显示哪一份，不重编；两份都标 deferCompile，开场按钮可用之后由 main.ts 预编译，
// 第一次瞄准不现编。不加灯、不碰任何灯（没有明暗变化，和防光敏的「暗一下」无关）
import * as THREE from 'three/webgpu';
import { float, length, max, min, mix, mx_noise_float, positionWorld, smoothstep, texture, uniform, vec2, vec3 } from 'three/tsl';
import { CELL, GRID_H, GRID_W, HOUSE_D, HOUSE_W, PROPS, cellOf, propCenter } from '../config/house';
import { SCARES } from '../config/scares';
import { MANIFEST, VISION } from '../config/visitors';
import { isGhostRig, type CameraRig, type FrameCtx, type Module, type Quality, type RenderCore } from '../engine/types';
import { angleOf } from '../lib/angle';
import { Grid } from '../sim/grid';
import { canHear, canSee } from '../sim/perception';
import { facesToward } from '../sim/scares';
import type { ScareObjectState, SimEvent, Vec2, WorldState } from '../sim/types';
import { FROST } from './frost';
import { DISSOLVE, v3 } from './walls';

type F = THREE.Node<'float'>;

export const RANGE_FROST = {
  /** 离地高度（米）：地毯、走廊长毯 0.016，现身的霜 FROST.y 0.02，高过它们 */
  y: 0.021,
  /** 画在现身的霜（FROST.renderOrder 1.2）之后、地面薄雾（1.5）之前 */
  renderOrder: 1.25,
  /**
   * 线宽（米）：第三人称固定 ghost；娃娃屋按屏幕上约 px 像素宽换算（每米像素数 = 画布宽 ÷ 正交相机左右宽），夹在 [min, max]：
   * 桌面娃娃屋约 56 像素 / 米，手机横屏 27、竖屏 18
   */
  width: { ghost: 0.16, px: 6, min: 0.12, max: 0.35 },
  /** 线、片的浓度（不透明度的系数）：第三人称；娃娃屋远看要浓一点 */
  weights: { ghost: { line: 0.3, film: 0.045 }, doll: { line: 0.38, film: 0.06 } },
  /**
   * 线的边：两层噪声（freq 每米几个起伏，amp 米）把边推得不齐。粗的一层同墙上溶洞边的 DISSOLVE.noise[0]；
   * 幅度比溶洞边小得多：线只有十几厘米宽，推 6 厘米时远看是一条蛇形的细线，像画上去的，不像霜。细的一层是霜边上的毛刺
   */
  noise: [{ freq: DISSOLVE.noise[0].freq, amp: 0.03 }, { freq: 7.3, amp: 0.018 }] as const,
  /**
   * 高档再叠一层冰晶（频率同 FROST.crystal）：边界上是连着的霜，往里渐渐碎成冰晶（浓淡在 [lo, hi] 之间）——
   * 像 frost.ts 长到的那条边，寒气在边上堆得最厚
   */
  crystal: { lo: 0.35, hi: 1 },
  /** 有符号距离的高斯平滑：σ（米）、窗口半径（格），见 smoothField */
  smooth: 0.2,
  smoothR: 4,
  /** 线：从边界往里 0..soft 米渐浓，线宽的 0.6 倍到 1 倍之间渐淡；片：从边界往里 film 米渐到满 */
  soft: 0.03,
  film: 0.3,
  /** 自发光 = DISSOLVE.frostGlow × (线 × line + 片 × film) */
  glow: { line: 2, film: 0.5 },
  /** 粗糙度：片上 rough，线上降到 FROST.roughness（略提光泽，手电扫过有一点反光；不发光） */
  rough: 0.85,
  /**
   * 对准：fadeIn 秒 ease-out 浮现，同一段时间里边界从里面 push 米处推到实际位置（读起来是寒气往外漫到边上停住）；
   * 移开、换了物件：fadeOut 秒线性退掉
   */
  aim: { fadeIn: 0.25, push: 0.4, fadeOut: 0.35 },
  /** 冷却中的物件整体乘这个；进出冷却时 coolTime 秒线性过渡 */
  cooling: 0.5,
  coolTime: 0.2,
  /**
   * 现身：蓄力 MANIFEST.windup 秒里前沿从 0 长到 MANIFEST.noticeRadius（1 − (1 − t)²，和 frost.ts 的霜同一条曲线，正好跟蓄力时
   * 附近的灯暗那两下同步），停到收回（end 事件；没收到就 fallback 秒后），再 melt 秒化掉
   */
  manifest: { melt: 1.2, fallback: 1 },
  /** 冷却好了往外呼一次（FEEL-11）：grow 秒长到 MANIFEST.noticeRadius（ease-out），线、片乘 line、film（比蓄力时淡），再 melt 秒化掉 */
  exhale: { grow: 0.9, line: 0.22, film: 0.03, melt: 1.2 },
  /**
   * 空闲预算（9 个物件的范围趁空闲先算好，一次一个）：这一段空闲剩不到 need 毫秒就等下一段（等了 timeout 毫秒还没空就照算一个，
   * 一直忙的页面也算得完）；没有 requestIdleCallback（Safari / iOS）时退成 setTimeout，隔 gap 毫秒算一个
   */
  idle: { need: 3, timeout: 3000, gap: 200 },
};

/**
 * 范围场的格子：每格 CELL / 4 = 0.125 米，盖满整栋房子（128 × 96）。clamp：有符号距离夹在 ±clamp 米；
 * fill：墙格里离地板几格以内（切比雪夫距离）跟最近的地板走，再远的当作外面（外墙的外半边）
 */
export const FIELD = { w: GRID_W * 4, h: GRID_H * 4, cell: CELL / 4, clamp: 1, fill: 2 };
const N = FIELD.w * FIELD.h;

/** 要画的范围：物件（按类型查 SCARES）、或者在某处现身 */
export type RangeAct =
  | { kind: 'object'; object: Pick<ScareObjectState, 'type' | 'pos' | 'facing'> }
  | { kind: 'manifest'; at: Vec2 };

/** 第 k 格（k = 行 × FIELD.w + 列）的格心（房屋米坐标） */
export const texelCenter = (k: number): Vec2 => ({ x: ((k % FIELD.w) + 0.5) * FIELD.cell, z: (Math.floor(k / FIELD.w) + 0.5) * FIELD.cell });

/**
 * 站在 p、转过来看着它的访客，会不会被这一下影响。规则就是结算用的那几个函数：
 * - 惊吓类（world.ts 的惊吓结算、seenBy）：facesToward（肖像、镜子只算正面）+ canSee（光锥对着它、距离 ≤ min(range, VISION.range)、格子视线）
 * - 引诱类（world.ts 的引诱结算）：canHear（有视线 ≤ range，隔墙 ≤ range × WALL_HEARING_FACTOR）
 * - 现身（world.ts 的 stepManifest）：察觉半径内的人蓄力时就转过来了，落下时看得见就被吓到：canSee（距离 ≤ min(noticeRadius, range)、视线）
 * 访客的手电朝哪儿是站位以外的事，这里按「看着它」算：范围线回答的是「站在哪里会被吓到」
 */
export function inRange(grid: Grid, act: RangeAct, p: Vec2): boolean {
  const t = act.kind === 'object' ? act.object.pos : act.at;
  const look = { pos: p, lookDir: angleOf(t.x - p.x, t.z - p.z) };
  if (act.kind === 'manifest') return canSee(grid, look, t, Math.min(MANIFEST.noticeRadius, MANIFEST.range));
  const spec = SCARES[act.object.type];
  if (spec.kind === 'lure') return canHear(grid, p, t, spec.range);
  return facesToward(act.object, p) && canSee(grid, look, t, Math.min(spec.range, VISION.range));
}

/**
 * 范围的二值图（1 = 在范围里），长 FIELD.w × FIELD.h，按 k = 行 × FIELD.w + 列。
 * 离中心比 reach 还远的格子 inRange 一定是 false（canSee、canHear 先比距离），直接跳过，省掉大半的视线检查
 */
export function rangeMask(grid: Grid, act: RangeAct, out = new Uint8Array(N)): Uint8Array {
  const c = act.kind === 'object' ? act.object.pos : act.at;
  const reach = (act.kind === 'object' ? SCARES[act.object.type].range : MANIFEST.noticeRadius) + FIELD.cell;
  for (let k = 0; k < N; k++) {
    const p = texelCenter(k);
    out[k] = (p.x - c.x) ** 2 + (p.z - c.z) ** 2 <= reach * reach && inRange(grid, act, p) ? 1 : 0;
  }
  return out;
}

/** 墙格、窗格（挡视线的格子，Grid.isOpaque）上的格心记 1。门洞、家具、物件格不挡视线，不算 */
export function solidTexels(grid: Grid): Uint8Array {
  const out = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const p = texelCenter(k);
    out[k] = grid.isOpaque(...cellOf(p.x, p.z)) ? 1 : 0;
  }
  return out;
}

/** 距离变换里的「无穷远」（平方格数）：比整张图的对角线平方大得多，又不会在加减里丢精度 */
const FAR = 1e9;

/**
 * 一维的平方距离变换（Felzenszwalb & Huttenlocher 的抛物线下包络）：out[q] = min_p ((q − p)² + f[p])。
 * f 里 ≥ FAR 的当作没有（不进包络），全都没有时 out 全是 FAR。v、z 是工作区（长 n、n + 1）
 */
function edt1d(f: Float64Array, n: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] >= FAR) continue;
    if (k < 0) {
      k = 0;
      v[0] = q;
      z[0] = -Infinity;
      z[1] = Infinity;
      continue;
    }
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * (q - v[k]));
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) {
    out.fill(FAR, 0, n);
    return;
  }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    out[q] = (q - v[j]) * (q - v[j]) + f[v[j]];
  }
}

/** 二维精确欧氏距离变换：seed[k] 为 true 的格子距离 0，返回每格到最近 seed 的距离（米，没有 seed 时是很大的数） */
function distanceTo(seed: (k: number) => boolean): Float64Array {
  const { w, h } = FIELD;
  const g = new Float64Array(N);
  const col = new Float64Array(h), colOut = new Float64Array(h);
  const row = new Float64Array(w), rowOut = new Float64Array(w);
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  for (let u = 0; u < w; u++) {
    for (let r = 0; r < h; r++) col[r] = seed(r * w + u) ? 0 : FAR;
    edt1d(col, h, colOut, v, z);
    for (let r = 0; r < h; r++) g[r * w + u] = colOut[r];
  }
  for (let r = 0; r < h; r++) {
    for (let u = 0; u < w; u++) row[u] = g[r * w + u];
    edt1d(row, w, rowOut, v, z);
    for (let u = 0; u < w; u++) g[r * w + u] = Math.sqrt(rowOut[u]) * FIELD.cell;
  }
  return g;
}

/**
 * 到范围边界的有符号距离（米，里面为正，夹在 ±FIELD.clamp）。
 * 地板格（不是墙、窗）：在范围里 = 到最近的「范围外的地板格」的距离 − 半格；在外面 = −(到最近的「范围里的地板格」的距离 − 半格)。
 * 相邻两格一里一外时各离边界半格，线性插值正好在两格中间过零。墙格、窗格不当 seed：墙两边的地板都不会因为挨着墙出线。
 * 墙格自己：取 FIELD.fill 格以内最近的地板格的值（墙两边各管一半，翻号落在墙身里）；再远的（外墙的外半边）当作外面
 */
export function rangeField(mask: Uint8Array, solid: Uint8Array, out = new Float32Array(N)): Float32Array {
  const C = FIELD.clamp, half = FIELD.cell / 2;
  const toOut = distanceTo((k) => solid[k] === 0 && mask[k] === 0);
  const toIn = distanceTo((k) => solid[k] === 0 && mask[k] === 1);
  for (let k = 0; k < N; k++) {
    if (solid[k]) continue;
    out[k] = mask[k] ? Math.min(C, toOut[k] - half) : -Math.min(C, toIn[k] - half);
  }
  fillSolid(out, solid);
  return out;
}

/**
 * 有符号距离在地板格上做一次高斯平滑（只用地板格，按权重归一；墙格不参与，平完再按最近的地板重填）。
 * 视线是按 0.5 米的格子做 Bresenham 的，被挡住的那一楔边上是 0.5 米一级的台阶：不磨的话霜线是一条蛇形的折线。
 * σ = RANGE_FROST.smooth 米磨成斜线，偏离真边界最多十来厘米（台阶的拐角处），远小于一个人的身宽；圆弧、正面那条直线几乎不动。
 * 窗口半径 smoothR 格（小于墙厚 4 格 + 1）：平滑够不到墙另一边的地板，墙两边不会互相染
 */
export function smoothField(field: Float32Array, solid: Uint8Array, out = new Float32Array(N)): Float32Array {
  const { w, h } = FIELD;
  const r = RANGE_FROST.smoothR;
  const sig = RANGE_FROST.smooth / FIELD.cell;
  const wt = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sig * sig)));
  const numH = new Float32Array(N), denH = new Float32Array(N);
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      let num = 0, den = 0;
      for (let d = -r; d <= r; d++) {
        const uu = u + d;
        if (uu < 0 || uu >= w) continue;
        const q = v * w + uu;
        if (solid[q]) continue;
        num += wt[d + r] * field[q];
        den += wt[d + r];
      }
      numH[v * w + u] = num;
      denH[v * w + u] = den;
    }
  }
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const k = v * w + u;
      if (solid[k]) continue;
      let num = 0, den = 0;
      for (let d = -r; d <= r; d++) {
        const vv = v + d;
        if (vv < 0 || vv >= h) continue;
        num += wt[d + r] * numH[vv * w + u];
        den += wt[d + r] * denH[vv * w + u];
      }
      out[k] = den > 0 ? num / den : field[k];
    }
  }
  fillSolid(out, solid);
  return out;
}

/** 墙格：取 FIELD.fill 格以内最近的地板格的值（墙两边各管一半，翻号落在墙身里）；再远的（外墙的外半边）当作外面 */
function fillSolid(out: Float32Array, solid: Uint8Array): void {
  const { w, h, fill } = FIELD;
  for (let k = 0; k < N; k++) {
    if (!solid[k]) continue;
    const u = k % w, r = Math.floor(k / w);
    let best = Infinity, val = -FIELD.clamp;
    for (let dv = -fill; dv <= fill; dv++) {
      const rr = r + dv;
      if (rr < 0 || rr >= h) continue;
      for (let du = -fill; du <= fill; du++) {
        const uu = u + du;
        if (uu < 0 || uu >= w) continue;
        const q = rr * w + uu;
        if (solid[q]) continue;
        const d = du * du + dv * dv;
        if (d < best) {
          best = d;
          val = out[q];
        }
      }
    }
    out[k] = val;
  }
}

/** 房屋米坐标的矩形 */
interface Box { x0: number; z0: number; x1: number; z1: number }

/** 编进纹理的一张范围：每格一个字节（s / clamp × 0.5 + 0.5），和会画到东西的外接框（null = 什么都不画） */
interface Encoded { bytes: Uint8Array; box: Box | null }

function encode(field: Float32Array): Encoded {
  const bytes = new Uint8Array(N);
  let u0 = FIELD.w, v0 = FIELD.h, u1 = -1, v1 = -1;
  // 线画在 s + 噪声 > 0 的地方：s 比 −噪声幅度再往外一点的格子都可能画到
  const reach = -(RANGE_FROST.noise[0].amp + RANGE_FROST.noise[1].amp + 0.01);
  for (let k = 0; k < N; k++) {
    const s = field[k];
    bytes[k] = Math.round((Math.max(-1, Math.min(1, s / FIELD.clamp)) * 0.5 + 0.5) * 255);
    if (s <= reach) continue;
    const u = k % FIELD.w, v = Math.floor(k / FIELD.w);
    if (u < u0) u0 = u;
    if (u > u1) u1 = u;
    if (v < v0) v0 = v;
    if (v > v1) v1 = v;
  }
  if (u1 < 0) return { bytes, box: null };
  // 纹理线性过滤，外面再多留一格
  const c = FIELD.cell;
  return { bytes, box: { x0: Math.max(0, (u0 - 1) * c), z0: Math.max(0, (v0 - 1) * c), x1: Math.min(HOUSE_W, (u1 + 2) * c), z1: Math.min(HOUSE_D, (v1 + 2) * c) } };
}

const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

/** 一张物件的范围（纹理的 R 或 G 通道） */
interface ObjSlot {
  channel: 0 | 1;
  id: string | null;
  /** 浓度 0..1（不含冷却的减半） */
  level: number;
  /** 1 = 正在浮现 / 亮着，0 = 正在退 */
  target: 0 | 1;
  /** 浮现的进度（0..1），level = easeOut(e) */
  e: number;
  /** 边界往里推了多少（米） */
  shift: number;
  /** 冷却中减半：1 或 RANGE_FROST.cooling，线性过渡 */
  cool: number;
  box: Box | null;
}

/** 现身那一张（B 通道）：蓄力（manifest）或冷却好了呼一次（exhale） */
interface ManSlot {
  kind: 'manifest' | 'exhale' | null;
  center: Vec2;
  /** 从开始长算起的秒数；pending：事件在两帧之间到，下一帧才定起点 */
  t: number;
  pending: boolean;
  /** 前沿长满要几秒 */
  grow: number;
  /** 正在化：化了几秒（null = 还没开始化）；meltPending：收到 end，下一帧开始化 */
  melt: number | null;
  meltPending: boolean;
  meltTime: number;
  level: number;
  front: number;
  line: number;
  film: number;
  box: Box | null;
}

export interface RangeFrostDebug {
  /** 这一帧有没有在画（高档、低档那份哪个显示着） */
  visible: boolean;
  slots: { id: string | null; level: number; target: number; shift: number; cool: number }[];
  manifest: { kind: 'manifest' | 'exhale' | null; level: number; front: number; center: Vec2 | null; line: number; film: number };
  /** 线宽（米） */
  width: number;
  /** 正在画的外接框（房屋米坐标） */
  box: Box | null;
  /** 最近一次现算一张范围花了多少毫秒 */
  lastComputeMs: number;
  /** 物件的范围已经缓存了几张（空闲预算算到哪了） */
  cached: number;
}

export interface RangeFrost extends Module {
  /** 准星（触屏是手指）此刻对着的物件，main.ts 的 picker.onHover 接过来；null = 没对着 */
  show(id: string | null): void;
  /**
   * 冷却好了往外呼一次（FEEL-11）：update 里看到 state.manifest 从 cooldown 变成 idle、没瞄着物件时自己调。
   * at 默认鬼魂此刻的位置；娃娃屋（没有鬼魂）、减少动态、鬼魂在墙格里（这里不能现身）时不呼，返回 false
   */
  exhale(at?: Vec2): boolean;
  debug(): RangeFrostDebug;
  update(ctx: FrameCtx): void;
  onEvent(e: SimEvent, state: WorldState): void;
  setQuality(q: Quality): void;
  dispose(): void;
}

export interface RangeFrostOptions {
  /** 减少动态（prefers-reduced-motion）：不呼气；对准时不从里面往外推，现身时不往外跑，只淡入 */
  reduced(): boolean;
  /**
   * 此刻要安静（审查 I-1；main.ts 给：一夜不在 night / closed——收夜的静、光收回、登记簿那一页——或者登记簿翻着）：
   * 收尾那几秒是整局刻意做静的，模拟又不停，现身的冷却可能正好在这时候结束。安静时不浮现、不画现身那一圈、不呼气，
   * 正在画的照平常的退法退掉（对准的 fadeOut 秒线性退，现身 / 呼气那张 melt 秒化掉）；安静结束时准星还对着物件就自己回来。
   * 不给 = 从不安静
   */
  quiet?(): boolean;
}

export function createRangeFrost(core: RenderCore, rig: CameraRig, opts: RangeFrostOptions): RangeFrost {
  const grid = new Grid();
  const solid = solidTexels(grid);
  const ghostMode = isGhostRig(rig);
  /** 物件的范围：趁空闲先算好（见文件末尾），第一次瞄准时还没算到就现算；之后一直用（物件、墙都不会动） */
  const cache = new Map<string, Encoded>();
  let lastComputeMs = 0;
  const compute = (act: RangeAct): Encoded => {
    const t0 = performance.now();
    const enc = encode(smoothField(rangeField(rangeMask(grid, act), solid), solid));
    lastComputeMs = performance.now() - t0;
    return enc;
  };

  // ── 纹理：RGBA8，R、G 两张物件的范围，B 现身那张（A 不用）。全 0 = 处处 s = −clamp（外面） ──
  const data = new Uint8Array(N * 4);
  const tex = new THREE.DataTexture(data, FIELD.w, FIELD.h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const writeChannel = (c: number, bytes: Uint8Array) => {
    for (let k = 0; k < N; k++) data[k * 4 + c] = bytes[k];
    tex.needsUpdate = true;
  };

  // ── 材质 ──
  /** houseRoot 的世界坐标（x、z）：片元的房屋米坐标 = 世界坐标 − 它 */
  const uOrigin = uniform(new THREE.Vector2());
  /** R、G 两张：浓度（含冷却减半）x、y；边界往里推的距离 z、w */
  const uObj = uniform(new THREE.Vector4());
  /** 现身那张：中心 x、z（房屋米坐标）、前沿半径、浓度 */
  const uMan = uniform(new THREE.Vector4());
  /** 物件的线、片系数 x、y；现身那张的线、片系数 z、w */
  const uK = uniform(new THREE.Vector4());
  /** 线宽（米） */
  const uW = uniform(RANGE_FROST.width.ghost);

  const makeMaterial = (crystal: boolean) => {
    const R = RANGE_FROST;
    const mat = new THREE.MeshStandardNodeMaterial({
      transparent: true, depthWrite: false, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
    });
    mat.name = crystal ? 'range-frost-high' : 'range-frost-low';
    const P = positionWorld;
    const h = vec2(P.x.sub(uOrigin.x), P.z.sub(uOrigin.y));
    const t = texture(tex, h.div(vec2(HOUSE_W, HOUSE_D)));
    const s = (c: F) => c.mul(2).sub(1).mul(FIELD.clamp);
    const sR = s(t.r).sub(uObj.z);
    const sG = s(t.g).sub(uObj.w);
    // 现身那张再和前沿的圆取交（前沿还没长到的地方算外面）
    const sB = min(s(t.b), uMan.z.sub(length(h.sub(uMan.xy))));
    // 边上的噪声（米）：线不是一条整齐的带子，是长到这里为止的一道霜边。低档只用粗的那一层
    const [n0, n1] = R.noise;
    const coarse = mx_noise_float(vec3(P.x, P.z, 0.37).mul(n0.freq)).mul(n0.amp);
    const n = crystal ? coarse.add(mx_noise_float(vec3(P.x, P.z, 4.1).mul(n1.freq)).mul(n1.amp)) : coarse;
    // 高档：冰晶（同 frost.ts 的颗粒）。边界上连成一片，往里（线宽的 0.25 到 1 倍）渐渐碎开
    const ice = crystal ? smoothstep(0.15, 0.7, mx_noise_float(vec3(P.x, P.z, 1.7).mul(FROST.crystal)).mul(0.5).add(0.5)) : null;
    const lineOf = (v: F) => {
      const e = v.add(n);
      const band = smoothstep(0, R.soft, e).mul(float(1).sub(smoothstep(uW.mul(0.6), uW, e)));
      return ice ? band.mul(mix(float(1), mix(float(R.crystal.lo), float(R.crystal.hi), ice), smoothstep(uW.mul(0.25), uW, e))) : band;
    };
    const filmOf = (v: F) => smoothstep(0, R.film, v);
    const lR = lineOf(sR).mul(uObj.x), lG = lineOf(sG).mul(uObj.y), lB = lineOf(sB).mul(uMan.w);
    const fR = filmOf(sR).mul(uObj.x), fG = filmOf(sG).mul(uObj.y), fB = filmOf(sB).mul(uMan.w);
    const line = max(max(lR, lG).mul(uK.x), lB.mul(uK.z));
    const film = max(max(fR, fG).mul(uK.y), fB.mul(uK.w));
    const lineN = max(max(lR, lG), lB);
    const filmN = max(max(fR, fG), fB);
    mat.colorNode = ice ? v3(DISSOLVE.frostAlbedo).mul(ice.mul(0.25).add(0.75)) : v3(DISSOLVE.frostAlbedo);
    mat.roughnessNode = mix(float(R.rough), float(FROST.roughness), lineN);
    mat.emissiveNode = v3(DISSOLVE.frostGlow).mul(lineN.mul(R.glow.line).add(filmN.mul(R.glow.film)));
    mat.opacityNode = line.add(film);
    return mat;
  };

  const root = new THREE.Group();
  root.name = 'range-frost';
  core.houseRoot.add(root);
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const meshes: Record<Quality, THREE.Mesh> = { high: new THREE.Mesh(geometry, makeMaterial(true)), low: new THREE.Mesh(geometry, makeMaterial(false)) };
  for (const [q, mesh] of Object.entries(meshes)) {
    mesh.name = `range-frost-${q}`;
    mesh.renderOrder = RANGE_FROST.renderOrder;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // 外接框每次都变（包围球跟着缩放走），平时藏着、不费事；关掉剔除，开场后台预编译时也一定编得到
    mesh.frustumCulled = false;
    mesh.visible = false;
    // 不进开场那次阻塞的预编译：main.ts 在开场按钮可用之后再编（那几帧里它是完全透明的），第一次瞄准不现编
    mesh.userData.deferCompile = true;
    root.add(mesh);
  }
  /** 方片盖住的矩形（房屋米坐标）：先盖满整栋房子（预编译那几帧画的就是它） */
  const place = (b: Box) => {
    for (const mesh of Object.values(meshes)) {
      mesh.position.set((b.x0 + b.x1) / 2, RANGE_FROST.y, (b.z0 + b.z1) / 2);
      mesh.scale.set(Math.max(0.01, b.x1 - b.x0), 1, Math.max(0.01, b.z1 - b.z0));
    }
  };
  place({ x0: 0, z0: 0, x1: HOUSE_W, z1: HOUSE_D });
  let quality: Quality = core.quality ?? 'high';

  // ── 状态 ──
  const objSlots: ObjSlot[] = [0, 1].map((c) => ({ channel: c as 0 | 1, id: null, level: 0, target: 0, e: 0, shift: 0, cool: 1, box: null }));
  const man: ManSlot = {
    kind: null, center: { x: 0, z: 0 }, t: 0, pending: false, grow: 1, melt: null, meltPending: false, meltTime: 1,
    level: 0, front: 0, line: 0, film: 0, box: null,
  };
  let hover: string | null = null;
  let state: WorldState | null = null;
  let prevPhase: string | null = null;
  let visible = false;
  let drawBox: Box | null = null;
  const weights = () => (ghostMode ? RANGE_FROST.weights.ghost : RANGE_FROST.weights.doll);
  const cooling = (id: string | null) => {
    const o = id && state ? state.objects.find((x) => x.id === id) : undefined;
    return o && o.cooldown > 0 ? RANGE_FROST.cooling : 1;
  };

  /** 物件 id 的范围（PROPS 里的摆放，和模拟 createScareObjects 同一份数据）：现算或者取缓存；没有这个物件是 null */
  const objectRange = (id: string): Encoded | null => {
    let enc = cache.get(id);
    if (!enc) {
      const p = PROPS.find((x) => x.id === id);
      if (!p) return null;
      enc = compute({ kind: 'object', object: { type: p.type, pos: propCenter(p), facing: p.facing } });
      cache.set(id, enc);
    }
    return enc;
  };

  /** 把物件 id 的范围写进 slot 的通道（第一次现算，之后用缓存）。物件不存在、范围是空的返回 false */
  const load = (slot: ObjSlot, id: string): boolean => {
    const enc = objectRange(id);
    if (!enc) return false;
    if (!enc.box) return false;
    writeChannel(slot.channel, enc.bytes);
    slot.box = enc.box;
    return true;
  };

  /** 现身那张：以 center 为中心算范围、写进 B 通道，从 0 开始长 */
  const startMan = (kind: 'manifest' | 'exhale', center: Vec2): boolean => {
    const enc = compute({ kind: 'manifest', at: center });
    if (!enc.box) return false;
    writeChannel(2, enc.bytes);
    const R = MANIFEST.noticeRadius;
    const circle = { x0: center.x - R - 0.2, z0: center.z - R - 0.2, x1: center.x + R + 0.2, z1: center.z + R + 0.2 };
    man.box = { x0: Math.max(enc.box.x0, circle.x0), z0: Math.max(enc.box.z0, circle.z0), x1: Math.min(enc.box.x1, circle.x1), z1: Math.min(enc.box.z1, circle.z1) };
    man.kind = kind;
    man.center = { x: center.x, z: center.z };
    man.t = 0;
    man.pending = true;
    man.melt = null;
    man.meltPending = false;
    if (kind === 'manifest') {
      const w = weights();
      man.grow = MANIFEST.windup;
      man.meltTime = RANGE_FROST.manifest.melt;
      man.line = w.line;
      man.film = w.film;
    } else {
      man.grow = RANGE_FROST.exhale.grow;
      man.meltTime = RANGE_FROST.exhale.melt;
      man.line = RANGE_FROST.exhale.line;
      man.film = RANGE_FROST.exhale.film;
    }
    man.level = 0;
    man.front = 0;
    return true;
  };

  const ghostAt = (): Vec2 | null => (isGhostRig(rig) ? { x: rig.ghost.x, z: rig.ghost.z } : null);

  const quiet = () => opts.quiet?.() ?? false;

  /**
   * 物件那两张此刻该画哪个：准星对着的；现身蓄力、停留时不画（这一下要看的是 5 米那一圈），收回、开始化的时候再回来；
   * 安静时不画（见 RangeFrostOptions.quiet），安静结束再回来
   */
  let showing: string | null = null;
  const sync = () => {
    const want = quiet() || (man.kind === 'manifest' && man.melt === null) ? null : hover;
    if (want === showing) return;
    showing = want;
    for (const s of objSlots) if (s.id !== null && s.id !== want) s.target = 0;
    if (!want) return;
    let slot = objSlots.find((s) => s.id === want);
    if (!slot) {
      // 空着的通道；都在用（一张正在退）就换掉浓度低的那张
      const next = objSlots.find((s) => s.id === null) ?? objSlots.reduce((a, b) => (b.level < a.level ? b : a));
      if (!load(next, want)) return;
      slot = next;
      slot.id = want;
      slot.level = 0;
      slot.cool = cooling(want);
    }
    slot.target = 1;
    // 从此刻的浓度接着浮现（退到一半又对回来时不从 0 重来）
    slot.e = 1 - Math.sqrt(Math.max(0, 1 - slot.level));
  };

  // ── 空闲预算：物件的范围趁空闲先算好（一次一个，一个几毫秒），第一次瞄准时就只剩写纹理（参数见 RANGE_FROST.idle）。
  // 没有 requestIdleCallback（Safari / iOS）时退成 setTimeout：没有 deadline，当它「剩一点、够算一个」。dispose 取消还在排的那一个 ──
  const hasIdle = typeof requestIdleCallback === 'function';
  const todo = PROPS.map((p) => p.id);
  let idleHandle: number | null = null;
  let idleStopped = false;
  const runIdle = (deadline?: IdleDeadline) => {
    idleHandle = null;
    if (idleStopped) return;
    const left = deadline ? deadline.timeRemaining() : RANGE_FROST.idle.need;
    if (left >= RANGE_FROST.idle.need || deadline?.didTimeout) objectRange(todo.shift()!);
    scheduleIdle();
  };
  const scheduleIdle = () => {
    if (idleStopped || todo.length === 0) return;
    idleHandle = hasIdle ? requestIdleCallback(runIdle, { timeout: RANGE_FROST.idle.timeout }) : setTimeout(runIdle, RANGE_FROST.idle.gap);
  };
  const stopIdle = () => {
    idleStopped = true;
    if (idleHandle === null) return;
    if (hasIdle) cancelIdleCallback(idleHandle);
    else clearTimeout(idleHandle);
    idleHandle = null;
  };
  scheduleIdle();

  const api: RangeFrost = {
    show(id) {
      hover = id;
      sync();
    },
    exhale(at) {
      const c = at ?? ghostAt();
      if (!c || !ghostMode || opts.reduced() || quiet()) return false;
      // 鬼魂在墙格里不能现身（world.manifest 同一个判断），这时呼一下是在说谎
      if (grid.isOpaque(...cellOf(c.x, c.z))) return false;
      return startMan('exhale', c);
    },
    debug: () => ({
      visible,
      slots: objSlots.map((s) => ({ id: s.id, level: s.level, target: s.target, shift: s.shift, cool: s.cool })),
      manifest: { kind: man.kind, level: man.level, front: man.front, center: man.kind ? { ...man.center } : null, line: man.line, film: man.film },
      width: uW.value,
      box: drawBox ? { ...drawBox } : null,
      lastComputeMs,
      cached: cache.size,
    }),
    onEvent(e) {
      if (e.type !== 'manifest') return;
      if (e.phase === 'windup') {
        // 安静时不画这一圈（也不白算一张距离场）
        if (quiet()) return;
        startMan('manifest', e.pos);
        sync();
      } else if (e.phase === 'end' && man.kind === 'manifest') {
        man.meltPending = true;
      }
    },
    update(ctx) {
      state = ctx.state;
      const dt = ctx.dt;
      const reduced = opts.reduced();
      const A = RANGE_FROST.aim;

      // 冷却好了（cooldown → idle 的那一帧）、没瞄着物件：脚下的霜往外呼一次。
      // 上一次现身的霜还在化（正常玩的时候早化完了，快进时会撞上）就接过 B 通道；正在蓄力、停留时不呼
      const phase = ctx.state.manifest?.phase ?? null;
      const busy = man.kind === 'manifest' && man.melt === null;
      if (prevPhase === 'cooldown' && phase === 'idle' && hover === null && !busy) api.exhale();
      prevPhase = phase;

      if (man.kind) {
        if (man.pending) {
          man.pending = false;
          man.t = 0;
        } else {
          man.t += dt;
        }
        // 变安静了：正在长、正停着的这一圈照平常的化法化掉，不等收回
        if (man.melt === null && quiet()) man.meltPending = true;
        const g = Math.min(1, man.t / man.grow);
        const R = MANIFEST.noticeRadius;
        // 减少动态：不往外跑，整圈一起淡入
        man.front = reduced ? R : R * easeOut(g);
        let level = reduced ? g : 1;
        // 蓄力的那张停到收回（end 事件）；兜底：蓄力 + 停留之后再过 fallback 秒还没收到就自己化
        if (man.kind === 'manifest' && man.melt === null && man.t >= MANIFEST.windup + MANIFEST.hold + RANGE_FROST.manifest.fallback) man.meltPending = true;
        // 呼气长满就化
        if (man.kind === 'exhale' && man.melt === null && g >= 1) man.meltPending = true;
        if (man.meltPending) {
          man.meltPending = false;
          man.melt = 0;
        } else if (man.melt !== null) {
          man.melt += dt;
        }
        if (man.melt !== null) level *= Math.max(0, 1 - man.melt / man.meltTime);
        man.level = level;
        if (man.melt !== null && man.melt >= man.meltTime) {
          man.kind = null;
          man.level = 0;
          man.front = 0;
          man.box = null;
        }
      }

      sync();

      for (const s of objSlots) {
        if (s.id === null) continue;
        if (s.target === 1) {
          s.e = Math.min(1, s.e + dt / A.fadeIn);
          s.level = easeOut(s.e);
          s.shift = reduced ? 0 : A.push * (1 - s.level);
        } else {
          s.level = Math.max(0, s.level - dt / A.fadeOut);
          if (s.level === 0) {
            s.id = null;
            s.shift = 0;
            s.box = null;
            continue;
          }
        }
        const want = cooling(s.id);
        const step = (dt * (1 - RANGE_FROST.cooling)) / RANGE_FROST.coolTime;
        s.cool = s.cool < want ? Math.min(want, s.cool + step) : Math.max(want, s.cool - step);
      }

      // 画不画、画多大
      let box: Box | null = null;
      const grow = (b: Box | null) => {
        if (!b) return;
        box = box ? { x0: Math.min(box.x0, b.x0), z0: Math.min(box.z0, b.z0), x1: Math.max(box.x1, b.x1), z1: Math.max(box.z1, b.z1) } : { ...b };
      };
      for (const s of objSlots) if (s.id !== null && s.level > 0) grow(s.box);
      if (man.kind && man.level > 0 && man.front > 0) grow(man.box);
      drawBox = box;
      visible = box !== null;
      meshes.high.visible = visible && quality === 'high';
      meshes.low.visible = visible && quality === 'low';
      if (!visible || !box) return;
      place(box);

      const w = weights();
      const [a, b] = objSlots;
      uObj.value.set(a.id ? a.level * a.cool : 0, b.id ? b.level * b.cool : 0, a.shift, b.shift);
      uMan.value.set(man.center.x, man.center.z, man.kind ? man.front : 0, man.kind ? man.level : 0);
      uK.value.set(w.line, w.film, man.line, man.film);
      // houseRoot 只平移不旋转（main.ts、debug.ts 都这么用）：片元的房屋坐标 = 世界坐标 − 它的世界位置
      core.houseRoot.updateWorldMatrix(true, false);
      const m = core.houseRoot.matrixWorld.elements;
      uOrigin.value.set(m[12], m[14]);
      // 线宽：第三人称固定；娃娃屋按屏幕像素换算
      const cam = rig.camera;
      const canvasW = core.renderer?.domElement?.clientWidth ?? 0;
      if (!ghostMode && (cam as THREE.OrthographicCamera).isOrthographicCamera && canvasW > 0) {
        const o = cam as THREE.OrthographicCamera;
        const pxPerM = canvasW / Math.max(1e-6, (o.right - o.left) / o.zoom);
        const W = RANGE_FROST.width;
        uW.value = Math.min(W.max, Math.max(W.min, W.px / pxPerM));
      } else {
        uW.value = RANGE_FROST.width.ghost;
      }
    },
    setQuality(q) {
      quality = q;
      meshes.high.visible = visible && quality === 'high';
      meshes.low.visible = visible && quality === 'low';
    },
    dispose() {
      stopIdle();
      core.houseRoot.remove(root);
      geometry.dispose();
      for (const mesh of Object.values(meshes)) (mesh.material as THREE.Material).dispose();
      tex.dispose();
    },
  };

  // ?debug：看样、量性能时从页面里直接调（window.__rangeFrost.show('mirror') / .exhale() / .debug()）
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { __rangeFrost: RangeFrost }).__rangeFrost = api;
  }
  return api;
}
