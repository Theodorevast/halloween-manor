// 鬼魂的外形：模糊、半透明的苍白人形轮廓，边缘像烟一样消散，身后拖一缕冷雾（2026-10-28 改版）。
// 基调：维多利亚时代「灵魂照片」里那种双重曝光的人影——一个裹着长袍、罩着兜帽的人，不是卡通床单鬼。
//
// 做法：
// - 外形（buildGhostGeometry，唯一建网格的地方）：程序化的旋转体，兜帽、肩、垂到下摆的长袍，椭圆截面、下摆有褶。
//   以后换成 Tripo 生成的模型时只换这个函数，材质（createGhostMaterial）不依赖 uv 或特定属性，任何网格都能用：
//   只要模型局部坐标 y 向上、正面朝 +z，按包围盒给 GhostLook 的 bottom / top
// - 材质：不受光照、加法混合（双重曝光就是加法），两层：
//   身体（双面：背面叠在正面后面，中间厚、边上薄，像一团有体积的雾）+ 外面一层放大一点、更淡更散的「雾晕」，看着发虚。
//   不透明度 = 朝向镜头的程度（轮廓边缘自然变淡，看着模糊）× 往上飘的噪声侵蚀（越往下摆、越靠轮廓侵蚀越多，散成一缕一缕）
//   × 下摆淡出 × 镜头太近时淡出（不挡视线）。顶点上有很慢的飘动，走动时下摆往后拖
// - 冷雾（实例化精灵，一次绘制）：走动时从下摆不断飘出、往后落、慢慢沉、散开；穿墙那一刻（rig.ghost.inWall 变成 true）
//   在墙面两侧喷一团（同一个缓冲、同一个材质，运行时不建任何新东西）
// - 墙、家具在鬼魂周围溶开由 house.ts / walls.ts 负责（DISSOLVE），这里只管鬼魂自己
// - 手电照出（2026-10-28，调研 G1）：着色器里逐片元算自己在不在四支手电的光锥里（torches.ts 的登记表，CPU 每帧写成 uniform，
//   中间有墙的那支由 CPU 用格子视线判掉）。光锥里的部分变浓、轮廓收紧、带一点手电的暖色；光锥外还是原来的冷雾。
//   只显形、不发光、不描边
// - 主动现身（2026-10-28，调研 G2 / G3 / G4，参数见 GHOST.manifest / GHOST.solid）：听 manifest 事件。蓄力时借 lightfx.ts 让附近的灯
//   暗两下、借 frost.ts 让脚下结霜；落下时灯暗一下，暗到最深的那一帧换上「实」的那份材质（普通混合、暗、挡光，被手电照着的那面亮一点），
//   停留时不飘、头慢慢抬起、只每秒更新 10 次，冷雾从下摆往下淌；收的时候再暗一下换回来。没有淡入淡出。
//   「实」的那份标了 deferCompile，开场按钮可用之后由 main.ts 预编译
// ?noghostfx：不画鬼魂（量开销的对照，和 house.ts 一致）
import * as THREE from 'three/webgpu';
import {
  abs, clamp, cos, dot, exp, float, floor, instancedDynamicBufferAttribute, length, max, min, mix, modelViewMatrix,
  mx_noise_float, mx_noise_vec3, normalLocal, normalView, normalWorld, positionLocal, positionViewDirection, positionWorld,
  pow, sin, smoothstep, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { CELL, Tile, buildTiles, cellOf, idx, inGrid } from '../config/house';
import { MANIFEST } from '../config/visitors';
import { ghostSees } from '../engine/ghostRig';
import type { FrameCtx, GhostRig, Module, Quality, RenderCore } from '../engine/types';
import { wrapAngle, yawFor } from '../lib/angle';
import type { SimEvent, WorldState } from '../sim/types';
import type { Frost } from './frost';
import { thermal, type LightFx } from './lightfx';
import { ge, lt, makeSprite, rnd } from './particles/common';
import { TORCH_COUNT, torches, type TorchSample } from './torches';

type F = THREE.Node<'float'>;
type V3n = THREE.Node<'vec3'>;

// ───────────────────────── 参数 ─────────────────────────

/**
 * 身形（模型局部坐标，米；y = 0 在 ghost.y，正面朝 +z）。ghost.y = 1.4 时：头顶 1.82、肩 1.45、下摆 0.4。
 * profile：自上而下 [y, 半径, x 方向缩放, z 方向缩放]（截面是椭圆：肩宽而薄，头和下摆接近圆）。
 * 裹尸布从头顶罩下来、直接搭到肩上，不贴着脖子：颈部只有很浅的一道凹（凹得深的话，外扩的雾晕在这里自己折叠，出一圈亮线）
 */
export const GHOST_BODY = {
  top: 0.42,
  bottom: -1.0,
  profile: [
    [0.42, 0.004, 1, 1],
    [0.405, 0.05, 1, 1.05],
    [0.37, 0.083, 1, 1.08],
    [0.31, 0.104, 1, 1.1],
    [0.24, 0.106, 1, 1.06],
    [0.19, 0.108, 1, 0.98],
    [0.14, 0.128, 1, 0.84],
    [0.095, 0.166, 1, 0.68],
    [0.05, 0.2, 1, 0.6],
    [-0.02, 0.212, 1, 0.6],
    [-0.14, 0.2, 1, 0.64],
    [-0.3, 0.19, 1, 0.7],
    [-0.5, 0.205, 1, 0.76],
    [-0.72, 0.232, 1, 0.82],
    [-1.0, 0.27, 1, 0.88],
  ] as [number, number, number, number][],
  /** 兜帽：头部后侧鼓出这么多（比例），头微微前探（米） */
  hood: 0.14,
  headForward: 0.025,
  /** 长袍的褶：几道、下摆处的深度（米） */
  folds: 9,
  foldDepth: 0.02,
  /** 网格密度：一圈几段、从头到下摆几圈 */
  segments: 40,
  rings: 44,
};

/** 外观：颜色（线性）、两层的浓淡与噪声。ghost.y 处的身体约 2.4 米外看过去，要认得出是个人，又不抢画面 */
export const GHOST = {
  /** 芯（正对镜头的地方）和边（轮廓附近）的颜色：月光一样的冷白，边上更蓝更暗 */
  core: new THREE.Color(0.62, 0.7, 0.82).multiplyScalar(0.44),
  edge: new THREE.Color(0.36, 0.48, 0.66).multiplyScalar(0.44),
  /**
   * 身体一层（双面）+ 外面一层雾晕（同一个网格沿法线外扩）。inflate 外扩（米）、density 最浓处的不透明度、noise 每米几个起伏、
   * rise 烟往上飘的速度（米/秒）、erode 侵蚀阈值 [头部, 下摆]（越大散得越多）、
   * soft：朝向镜头的程度在这两个值之间淡入（轮廓边缘一圈渐隐；几层叠起来，轮廓就是糊的）
   */
  body: { inflate: 0, density: 0.22, noise: 3.4, rise: 0.2, erode: [0.24, 0.86], soft: [0.12, 1.0] } as GhostLayer,
  haze: [
    { inflate: 0.065, density: 0.1, noise: 1.9, rise: 0.14, erode: [0.27, 0.77], soft: [0.0, 1.0], octaves: 1 },
  ] as GhostLayer[],
  /** 身体里浓淡不匀（像一团雾而不是一块磨砂玻璃）：噪声低处只剩这个比例 */
  cloud: 0.55,
  /** 下摆淡出：从最底下到身高的这个比例之间淡入 */
  hemFade: 0.4,
  /** 头和肩略浓一点（身高比例 [起, 满]、多浓） */
  head: { from: 0.62, to: 0.86, boost: 0.3 },
  /** 很慢的整体明暗起伏（像呼吸）：周期秒、幅度 */
  breathe: { period: 4.6, amount: 0.08 },
  /**
   * 镜头离鬼魂身体中部 near[0] 米以内只剩 minAlpha，near[1] 米以外完整。滚轮拉到最近（身后 1 米）时离身体中部约 1.2 米，
   * 仍然完整；只有镜头被挤进鬼魂身子里时才淡掉，不挡视线
   */
  near: [0.35, 0.95] as [number, number],
  minAlpha: 0.08,
  /** 顶点飘动：幅度（米，头部 base、下摆 base + low）、噪声频率、飘动速度 */
  sway: { base: 0.006, low: 0.05, freq: 1.3, speed: 0.3 },
  /** 走动时下摆往后拖：每 (米/秒) 拖多少米、最多多少 */
  lean: { perSpeed: 0.07, max: 0.2 },
  /** 朝向平滑（秒）：身子比镜头晚一点点转过去 */
  turnTau: 0.09,
  /** 速度平滑（秒） */
  velTau: 0.15,
  /** 画在雾（1.5）、手电光锥（2）之后；冷雾在它前面一点 */
  renderOrder: 2.7,
  /**
   * 被手电照出（G1）。片元在第 i 支手电的光锥里的程度 =
   * smoothstep(cos 半角, mix(cos 半角, 1, edge), cosθ) × (1 − smoothstep(照多远 × far, 照多远, 距离)) × 强度 × 中间没有墙；
   * 四支取最亮的 = reveal。身体的不透明度 × mix(1, density, reveal)（雾晕不乘：照着时外面那圈糊的不跟着变浓，轮廓才清楚）；
   * soft 区间的下限往 soft 收（轮廓收紧）；颜色往手电的暖色（warmColor）偏 reveal × warm。
   * losTau：中间有没有墙是 CPU 每帧按格子判的 0 / 1，平滑这么久（秒），走过门框边时不跳
   */
  reveal: {
    density: 3, soft: 0.55, warm: 0.35, edge: 0.35,
    far: 0.7,
    warmColor: new THREE.Color(0.95, 0.8, 0.6).multiplyScalar(0.5),
    losTau: 0.08,
  },
  /**
   * 主动现身的画面（调研 G2 / G3 / G4、L1、S1，时间轴见设计文档 3.2；几段的时长用 config/visitors.ts 的 MANIFEST）。
   * - 蓄力：radius 米内的灯按 windup 的节奏暗两下（lightfx.pulse，每秒 10 个字母，只放 MANIFEST.windup 秒），脚下的霜往外长到 frost 米；
   * - 落下：附近的灯和手电一起暗 drop.ms 毫秒、暗到 drop.depth（dipAll），这一下过了 swapAt 成、暗到最深的那一帧换上「实」的那份
   *   材质（不淡入）；之后灯压在 hold 这一档（'c' ≈ 42%，设计文档：40% 左右），收的时候放开，holdSlack 秒是兜底；
   * - 停留：不飘，头慢慢抬起（solid.headPitch），连同位置、朝向只每秒更新 stepRate 次（G3）；冷雾从下摆往下淌（GHOST_MIST.pour）；
   * - 收：再暗 end.ms 毫秒，暗下那一帧换回原来的雾。
   * 平时的鬼魂（加法、自己发光）跟着附近灯的明暗一起暗（follow，1 = 完全跟着），借暗下去的那一下出入，不会在暗下去时反而更显眼。
   * 节奏表加上落下那一下，任意 1 秒内最多暗 3 下（tests/lightfx.test.ts 查）
   */
  manifest: {
    radius: 5,
    windup: 'mmamammmmammamamm',
    frost: 1.2,
    drop: { depth: 0.15, ms: 100 },
    end: { depth: 0.2, ms: 80 },
    hold: 'c',
    holdSlack: 1,
    swapAt: 0.5,
    follow: 1,
    stepRate: 10,
  },
  /**
   * 「实」的那份（G2）：普通混合、不透明度 opacity、颜色压暗到原来的 dark 倍，挡住后面的光；被手电照着的那一面按朝向手电的程度
   * 亮一点（lit × GHOST.reveal.warmColor，看得出长袍的褶）；边上仍然用原来的侵蚀噪声散开（erode 比平时小：身子是实的，只有边和下摆散）。
   * soft：朝向镜头的程度在这之间淡入（轮廓不是一刀切）；hemFade 下摆淡出。
   * 头：身高 neck 以上的顶点（neckBlend 内渐变，脖子不折）绕 x 轴转，停留的 MANIFEST.hold 秒里从低着头 headPitch[0] 抬到 headPitch[1]
   * （弧度，正 = 低头）：在灯暗下去的那一下换成低着头的样子，再慢慢抬起来看人
   */
  solid: {
    opacity: 0.85,
    dark: 0.1,
    lit: 0.6,
    soft: [0.0, 0.3] as [number, number],
    erode: [0.04, 0.6] as [number, number],
    hemFade: 0.3,
    neck: 0.75,
    neckBlend: 0.07,
    headPitch: [(8 * Math.PI) / 180, 0] as [number, number],
  },
};

/**
 * 冷雾：一个实例化精灵 + 环形缓冲。每团：出生位置、时刻、初速、大小、寿命、浓淡由 CPU 写一次，之后的轨迹全在着色器里按年龄算。
 * 尾迹：rate = idle + perSpeed × 速度（每秒几团），从下摆附近出生，带一点鬼魂的速度（carry），被空气拖慢（tau），慢慢下沉
 */
export const GHOST_MIST = {
  pool: 192,
  trail: {
    idle: 4,
    perSpeed: 13,
    /** 出生高度（相对 ghost.y）、离身体中轴的半径 */
    y: [-0.98, -0.5] as [number, number],
    r: [0.1, 0.24] as [number, number],
    carry: 0.28,
    jitter: 0.07,
    sink: 0.05,
    tau: 0.8,
    size0: [0.1, 0.16] as [number, number],
    size1: [0.32, 0.56] as [number, number],
    life: [1.6, 2.6] as [number, number],
    alpha: [0.08, 0.13] as [number, number],
    /** 站着不动时浓淡只有这个比例（走到 fullSpeed 米/秒时满） */
    idleAlpha: 0.5,
    fullSpeed: 1.5,
  },
  /** 穿墙那一下：几团、贴着墙面往四周散开（radial 米/秒），分到墙两边（offset 米、normal 米/秒） */
  puff: {
    count: { high: 18, low: 10 } as Record<Quality, number>,
    radial: [0.3, 0.75] as [number, number],
    offset: [0.05, 0.2] as [number, number],
    normal: [0.08, 0.3] as [number, number],
    /** 竖直方向的散开压扁一点（冷气贴着墙往两边铺，不往上冲） */
    flatY: 0.6,
    /** 中心相对 ghost.y 的高度 */
    dy: -0.3,
    tau: 0.45,
    size0: [0.16, 0.26] as [number, number],
    size1: [0.5, 0.8] as [number, number],
    life: [1.2, 2.0] as [number, number],
    alpha: [0.05, 0.085] as [number, number],
    /** 两次喷之间至少隔这么久（秒）：墙角、门框边上 inWall 可能来回跳 */
    cooldown: 0.35,
  },
  /**
   * 现身停留时：冷雾从下摆往下淌（调研 P2，物理反了就是不对劲），落到地上铺开。rate 每秒几团；出生高度（相对 ghost.y）、半径；
   * 往下的初速、往外的散开（米/秒）
   */
  pour: {
    rate: 10,
    y: [-1.0, -0.82] as [number, number],
    r: [0.12, 0.26] as [number, number],
    vy: [-0.42, -0.25] as [number, number],
    spread: 0.12,
    tau: 0.9,
    size0: [0.1, 0.16] as [number, number],
    size1: [0.34, 0.6] as [number, number],
    life: [2.0, 3.0] as [number, number],
    alpha: [0.07, 0.11] as [number, number],
  },
  /** 低档：尾迹的出生率乘这个 */
  lowRate: 0.5,
  /** 噪声扰动：幅度（米）、频率、随年龄出现的时间常数 */
  turb: 0.1,
  turbFreq: 2.2,
  turbTau: 0.6,
  /** 长大的时间常数（秒）；从 fadeFrom 比例处开始淡出；长大后按 (size0/size)^thin 变稀 */
  growTau: 0.7,
  fadeFrom: 0.3,
  thin: 0.35,
  /** 颜色（线性）：和鬼魂同一种冷白 */
  color: new THREE.Color(0.5, 0.6, 0.74).multiplyScalar(0.7),
  /** 离镜头 near[0] 米以内看不见、near[1] 米以外完整（尾迹往后飘，正好飘向镜头） */
  near: [0.35, 1.1] as [number, number],
};

/** 换模型时告诉材质：模型局部 y 的范围（下摆完全散掉的地方、头顶） */
export interface GhostLook { bottom: number; top: number }
/** 一层的参数（见 GHOST.body / GHOST.haze） */
export interface GhostLayer {
  inflate: number;
  density: number;
  noise: number;
  rise: number;
  erode: [number, number];
  soft: [number, number];
  /** 噪声几层（雾晕本来就糊，一层就够，省一半噪声） */
  octaves?: 1 | 2;
}

// ───────────────────────── 外形 ─────────────────────────

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 按 y 在 profile 里插值（相邻两点之间平滑过渡） */
function profileAt(y: number): [number, number, number] {
  const P = GHOST_BODY.profile;
  for (let k = 0; k < P.length - 1; k++) {
    const [ya, ra, xa, za] = P[k];
    const [yb, rb, xb, zb] = P[k + 1];
    if (y <= ya && y >= yb) {
      const t = (ya - y) / (ya - yb);
      const s = t * t * (3 - 2 * t);
      return [lerp(ra, rb, s), lerp(xa, xb, s), lerp(za, zb, s)];
    }
  }
  const last = P[y > P[0][0] ? 0 : P.length - 1];
  return [last[1], last[2], last[3]];
}

/**
 * 鬼魂的网格（唯一建形状的地方，换模型时换这里）：头顶到下摆的旋转体，下摆敞口。
 * 圈按弧长均匀分布（头部弯得急的地方圈更密），法线平滑
 */
export function buildGhostGeometry(): THREE.BufferGeometry {
  const B = GHOST_BODY;
  // 先密采样 profile，按（r, y）平面里的弧长取 rings + 1 个 y
  const dense: { y: number; s: number }[] = [];
  let s = 0;
  let prev: [number, number] | null = null;
  for (let k = 0; k <= 400; k++) {
    const y = lerp(B.top, B.bottom, k / 400);
    const r = profileAt(y)[0];
    if (prev) s += Math.hypot(r - prev[0], y - prev[1]);
    dense.push({ y, s });
    prev = [r, y];
  }
  const ys: number[] = [];
  for (let i = 0; i <= B.rings; i++) {
    const target = (s * i) / B.rings;
    const k = dense.findIndex((d) => d.s >= target);
    ys.push(k <= 0 ? dense[0].y : dense[k].y);
  }
  ys[B.rings] = B.bottom;

  const seg = B.segments;
  const pos: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= B.rings; i++) {
    const y = ys[i];
    const [r, sx, sz] = profileAt(y);
    const headK = smooth01(0.1, 0.2, y); // 1 = 头部
    const robeK = smooth01(-0.2, -1.0, y); // 1 = 下摆
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      // 兜帽：头的后侧鼓出来；长袍：往下越来越深的竖褶，带一点不对称
      const hood = 1 + B.hood * headK * Math.max(0, -c) ** 1.5;
      const fold = B.foldDepth * robeK * (Math.sin(th * B.folds + y * 3.1) * 0.7 + Math.sin(th * 4 + 1.3) * 0.3);
      const rr = r * hood + fold;
      pos.push(sn * rr * sx, y, c * rr * sz + B.headForward * headK);
    }
  }
  for (let i = 0; i < B.rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + 1, cc = a + seg + 1, d = cc + 1;
      // 从外面看逆时针（法线朝外）
      index.push(a, cc, b, b, cc, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  // 首尾两列在同一条接缝上：法线取平均，接缝处不出现一道折痕
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i <= B.rings; i++) {
    const a = i * (seg + 1), b = a + seg;
    const nx = n.getX(a) + n.getX(b), ny = n.getY(a) + n.getY(b), nz = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(nx, ny, nz) || 1;
    n.setXYZ(a, nx / l, ny / l, nz / l);
    n.setXYZ(b, nx / l, ny / l, nz / l);
  }
  // 头顶那一圈几乎缩成一个点，三角形是退化的，算出来的法线乱指：直接朝上（不然头顶有个暗点）
  for (let j = 0; j <= seg; j++) n.setXYZ(j, 0, 1, 0);
  g.computeBoundingSphere();
  return g;
}

// ───────────────────────── 材质 ─────────────────────────

/** 鬼魂材质共用的 uniform（每帧由 createGhostView 写） */
function makeGhostUniforms() {
  return {
    time: uniform(0),
    /** 总不透明度倍数：镜头太近时变小、呼吸起伏 */
    fade: uniform(1),
    /** 下摆往后拖的量（模型局部 x, z，米） */
    lean: uniform(new THREE.Vector2(0, 0)),
    /** 手电（G1，TORCH_COUNT 支）：xyz 位置（世界坐标）、w 照多远（米）；光轴（单位向量）、w = cos(半角)；强度 × 中间没有墙 */
    torchPos: Array.from({ length: TORCH_COUNT }, () => uniform(new THREE.Vector4(0, -1000, 0, 1))),
    torchDir: Array.from({ length: TORCH_COUNT }, () => uniform(new THREE.Vector4(0, 0, 1, 1))),
    torchPow: Array.from({ length: TORCH_COUNT }, () => uniform(0)),
    /** uReveal：CPU 在身体上取几点估的「最亮那支手电照着鬼魂的程度」0..1（声音、调试用；着色器里逐片元另算） */
    reveal: uniform(0),
    /** uSolid：1 = 现身停留中，显示「实」的那份（G2；落下、收那一帧直接跳，不淡） */
    solid: uniform(0),
    /** uStep：1 = 降帧（G3）：「实」的那份的时间按 1 / stepRate 秒取整 */
    step: uniform(0),
    /** 头绕 x 轴转多少（弧度，正 = 低头；CPU 按停留了多久、取整后的时间算） */
    head: uniform(0),
    /** 「实」的那份颜色压暗到原来的几倍（GHOST.solid.dark；做成 uniform 是为了看样时能直接对比几档，不重编） */
    solidDark: uniform(GHOST.solid.dark),
  };
}
export type GhostUniforms = ReturnType<typeof makeGhostUniforms>;

/**
 * 片元 P（世界坐标）和手电：reveal = 被照着的程度 0..1，四支里最亮的那支（公式见 GHOST.reveal）；
 * N（世界法线）给了时另算 lit = 每支的照着程度 × 朝向这支手电的程度，加起来（「实」的那份被照亮的那一面）
 */
function torchTerms(u: GhostUniforms, P: V3n, N?: V3n): { reveal: F; lit: F } {
  const R = GHOST.reveal;
  let reveal: F = float(0);
  let lit: F = float(0);
  for (let i = 0; i < TORCH_COUNT; i++) {
    const tp = u.torchPos[i], td = u.torchDir[i];
    const L = P.sub(tp.xyz);
    const d = length(L);
    const Ld = L.div(max(d, 0.001));
    const cosT = dot(Ld, td.xyz);
    const cone = smoothstep(td.w, mix(td.w, float(1), R.edge), cosT);
    const reach = float(1).sub(smoothstep(tp.w.mul(R.far), tp.w, d));
    const k = cone.mul(reach).mul(u.torchPow[i]);
    reveal = max(reveal, k);
    if (N) lit = lit.add(k.mul(max(dot(N, Ld.negate()), 0)));
  }
  return { reveal, lit };
}

/**
 * 同一个公式在 CPU 上算一点（房屋坐标）：给 uReveal 估值用。t 是登记表里的一支，los 是平滑过的「中间没有墙」
 */
function torchRevealAt(t: TorchSample, los: number, x: number, y: number, z: number): number {
  if (t.power <= 0 || los <= 0) return 0;
  const R = GHOST.reveal;
  const lx = x - t.x, ly = y - t.y, lz = z - t.z;
  const d = Math.hypot(lx, ly, lz);
  const cosT = (lx * t.dx + ly * t.dy + lz * t.dz) / Math.max(d, 0.001);
  const c0 = Math.cos(t.angle);
  return smooth01(c0, lerp(c0, 1, R.edge), cosT) * (1 - smooth01(t.range * R.far, t.range, d)) * t.power * los;
}

/** 鬼魂这一层是什么：身体（被照着时变浓）、雾晕（不变浓） */
export type GhostRole = 'body' | 'haze';

/**
 * 鬼魂的材质（任何网格都能用，见文件头）：不受光照、加法混合、不写深度。layer 决定这一层的浓淡和噪声（GHOST.body / GHOST.haze），
 * role 决定被手电照着时变不变浓（见 GHOST.reveal）
 */
export function createGhostMaterial(
  u: GhostUniforms, look: GhostLook, layer: GhostLayer, side: THREE.Side, role: GhostRole = 'body',
): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, side, fog: false,
  });
  // 不受光照：灯的数量变了也不重编（和 fog.ts 一样）
  m.lights = false;
  const span = look.top - look.bottom;
  const P0 = positionLocal;
  const h = clamp(P0.y.sub(look.bottom).div(span), 0, 1);
  const low = float(1).sub(h);
  const low2 = low.mul(low);

  // —— 顶点：很慢的飘动（下摆飘得多）+ 走动时下摆往后拖 + 这一层的外扩 ——
  const S = GHOST.sway;
  const swayN = mx_noise_vec3(vec3(P0.x.mul(S.freq), P0.y.mul(S.freq).sub(u.time.mul(S.speed)), P0.z.mul(S.freq)));
  const sway = swayN.mul(low2.mul(S.low).add(S.base));
  const lean = vec3(u.lean.x, 0, u.lean.y).mul(low2);
  m.positionNode = P0.add(normalLocal.mul(layer.inflate)).add(sway).add(lean);

  // —— 片元 ——
  // 被手电照着的程度（G1）：变浓、轮廓收紧、偏暖
  const R = GHOST.reveal;
  const { reveal } = torchTerms(u, positionWorld);
  // 朝向镜头的程度：正对镜头 1、轮廓边缘 0（背面也按绝对值算）
  const facing = clamp(abs(dot(normalView, positionViewDirection)), 0, 1);
  const soft = smoothstep(mix(float(layer.soft[0]), float(Math.max(layer.soft[0], R.soft)), reveal), layer.soft[1], facing);
  // 往上飘的烟：模型局部坐标里取噪声，跟着鬼魂走、跟着它转
  const P = positionLocal;
  const q = vec3(P.x.mul(layer.noise), P.y.mul(layer.noise * 0.8).sub(u.time.mul(layer.rise * layer.noise)), P.z.mul(layer.noise));
  const n1 = mx_noise_float(q);
  const n = (layer.octaves === 1 ? n1 : n1.mul(0.62).add(mx_noise_float(q.mul(2.3).add(5.3)).mul(0.38))).mul(0.5).add(0.5);
  // 侵蚀阈值：越往下摆越高，轮廓附近再高一点（边缘先散成缕）
  const erode = mix(float(layer.erode[0]), float(layer.erode[1]), pow(low, 1.6)).add(float(1).sub(facing).mul(0.22));
  const wisp = smoothstep(erode.sub(0.1), erode.add(0.24), n);
  const hem = smoothstep(0, GHOST.hemFade, h);
  const head = smoothstep(GHOST.head.from, GHOST.head.to, h).mul(GHOST.head.boost).add(1);
  // 浓淡不匀：同一个噪声再调一次身体里的密度
  const cloud = mix(float(GHOST.cloud), float(1), smoothstep(0.25, 0.75, n));
  const dense = role === 'body' ? mix(float(1), float(R.density), reveal) : float(1);
  const alpha = soft.mul(wisp).mul(cloud).mul(hem).mul(head).mul(layer.density).mul(dense).mul(u.fade);
  const c0 = GHOST.edge, c1 = GHOST.core, cw = R.warmColor;
  m.colorNode = mix(mix(vec3(c0.r, c0.g, c0.b), vec3(c1.r, c1.g, c1.b), soft), vec3(cw.r, cw.g, cw.b), reveal.mul(R.warm));
  m.opacityNode = alpha;
  // 不用 particles/common.ts 的 protectMRT：现在场景 pass 没有 MRT，它保护不了什么；后处理建不起来、直接画到画布时
  // 它会让管线编不过（输出结构体是空的），鬼魂整个不见
  return m;
}

/**
 * 现身停留时「实」的那份（G2，参数见 GHOST.solid）：普通混合、暗、挡光，只画正面；不飘、不拖，头绕脖子转 u.head；
 * 侵蚀噪声的时间降到每秒 stepRate 次（u.step = 1 时，G3）。和身体同一个网格、同一套 uniform，任何网格都能用。
 * 不受光照：被照亮的那一面是按手电登记表自己算的（灯的数量变了也不重编）
 */
export function createGhostSolidMaterial(u: GhostUniforms, look: GhostLook): THREE.MeshBasicNodeMaterial {
  const S = GHOST.solid, L = GHOST.body, R = GHOST.reveal;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, side: THREE.FrontSide, fog: false,
  });
  m.lights = false;
  const span = look.top - look.bottom;
  const P0 = positionLocal;
  const h = clamp(P0.y.sub(look.bottom).div(span), 0, 1);
  const low = float(1).sub(h);

  // —— 顶点：头那一段绕脖子（身高 neck 处、过身体中轴）的 x 轴转，往下 neckBlend 内渐变 ——
  const pivot = look.bottom + span * S.neck;
  const ang = u.head.mul(smoothstep(S.neck, S.neck + S.neckBlend, h));
  const c = cos(ang), s = sin(ang);
  const y0 = P0.y.sub(pivot);
  m.positionNode = vec3(P0.x, y0.mul(c).sub(P0.z.mul(s)).add(pivot), y0.mul(s).add(P0.z.mul(c)));

  // —— 片元 ——
  const rate = GHOST.manifest.stepRate;
  const tq = mix(u.time, floor(u.time.mul(rate)).div(rate), u.step);
  const facing = clamp(abs(dot(normalView, positionViewDirection)), 0, 1);
  const soft = smoothstep(S.soft[0], S.soft[1], facing);
  const P = positionLocal;
  const q = vec3(P.x.mul(L.noise), P.y.mul(L.noise * 0.8).sub(tq.mul(L.rise * L.noise)), P.z.mul(L.noise));
  const n = mx_noise_float(q).mul(0.62).add(mx_noise_float(q.mul(2.3).add(5.3)).mul(0.38)).mul(0.5).add(0.5);
  const erode = mix(float(S.erode[0]), float(S.erode[1]), pow(low, 1.6)).add(float(1).sub(facing).mul(0.22));
  const wisp = smoothstep(erode.sub(0.1), erode.add(0.24), n);
  const hem = smoothstep(0, S.hemFade, h);
  m.opacityNode = soft.mul(wisp).mul(hem).mul(S.opacity).mul(u.fade).mul(u.solid);
  // 颜色：原来的冷白压暗；朝着手电、在光锥里的那一面亮一点（手电的暖色）
  const { lit } = torchTerms(u, positionWorld, normalWorld);
  const c0 = GHOST.edge, c1 = GHOST.core, cw = R.warmColor;
  const base = mix(vec3(c0.r, c0.g, c0.b), vec3(c1.r, c1.g, c1.b), soft).mul(u.solidDark);
  m.colorNode = base.add(vec3(cw.r, cw.g, cw.b).mul(min(lit, 1).mul(S.lit)));
  return m;
}

// ───────────────────────── 冷雾 ─────────────────────────

function createMist(time: THREE.UniformNode<'float', number>) {
  const M = GHOST_MIST;
  const N = M.pool;
  const mk = () => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  /** a0：出生位置 xyz、出生时刻；a1：初速 xyz、拖慢的时间常数；a2：起始大小、长大后的大小、寿命、不透明度 */
  const a0 = mk(), a1 = mk(), a2 = mk();
  for (let i = 0; i < N; i++) {
    a0.array[i * 4 + 3] = -1000; // 很久以前出生 = 空槽
    a1.array[i * 4 + 3] = 1;
    a2.array.set([0.1, 0.1, 1, 0], i * 4);
  }
  const A0 = instancedDynamicBufferAttribute(a0) as unknown as THREE.Node<'vec4'>;
  const A1 = instancedDynamicBufferAttribute(a1) as unknown as THREE.Node<'vec4'>;
  const A2 = instancedDynamicBufferAttribute(a2) as unknown as THREE.Node<'vec4'>;

  const ease = (t: F, tau: number | F) => float(1).sub(exp(t.negate().div(tau)));
  const origin = A0.xyz;
  const age = time.sub(A0.w);
  const ageC = max(age, 0);
  const tau = A1.w;
  const life = A2.z;
  const size = mix(A2.x, A2.y, ease(ageC, M.growTau));
  const turb = mx_noise_vec3(origin.mul(M.turbFreq).add(vec3(rnd(2).mul(50), ageC.mul(0.45), ageC.mul(-0.3))))
    .mul(M.turb).mul(ease(ageC, M.turbTau));
  const drift = A1.xyz.mul(tau).mul(ease(ageC, tau));
  const p0 = origin.add(drift).add(vec3(0, ageC.mul(-M.trail.sink), 0)).add(turb);
  // 不钻到地板下面：中心至少比地板高半个身位
  const p = vec3(p0.x, max(p0.y, size.mul(0.35).add(0.03)), p0.z);
  const fade = smoothstep(0, 0.15, age).mul(float(1).sub(smoothstep(life.mul(M.fadeFrom), life, age)));
  const alive = ge(age, 0).mul(lt(age, life)); // 不用 select（见 particles/common.ts）
  // 离镜头太近的淡掉：尾迹往后飘，正好飘到镜头跟前（正交相机离得很远，不受影响）
  const mv = modelViewMatrix.mul(vec4(p, 1)) as unknown as THREE.Node<'vec4'>;
  const nearK = smoothstep(M.near[0], M.near[1], length(mv.xyz));
  const alpha = A2.w.mul(fade).mul(pow(A2.x.div(size), M.thin)).mul(nearK);

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.positionNode = p;
  mat.scaleNode = vec2(size.mul(alive), size.mul(alive));
  mat.rotationNode = rnd(7).mul(Math.PI * 2).add(rnd(8).sub(0.5).mul(ageC).mul(0.6));
  const vAlpha = varying(alpha, 'vGhostMistA');
  const vSeed = varying(rnd(6), 'vGhostMistSeed');
  // 片元：高斯软斑，被噪声搅得不匀，几团叠在一起像一缕雾
  const qd = uv().sub(0.5).mul(2);
  const d = length(qd);
  const wob = mx_noise_float(vec3(qd.mul(1.7).add(vSeed.mul(29)), vSeed.mul(13))).mul(0.5).add(0.5);
  const shape = exp(d.mul(d).mul(-3.0)).mul(pow(wob, 1.5).mul(1.3).add(0.12)).mul(float(1).sub(smoothstep(0.8, 1.0, d)));
  const c = M.color;
  mat.colorNode = vec3(c.r, c.g, c.b);
  mat.opacityNode = vAlpha.mul(shape);
  mat.alphaTest = 0.002;

  const object = makeSprite(mat, N, 'ghost-mist', GHOST.renderOrder - 0.05);
  let head = 0;
  let lastBirth = -1000;
  const emit = (x: number, y: number, z: number, t0: number, vx: number, vy: number, vz: number, tauS: number,
    s0: number, s1: number, lifeS: number, a: number) => {
    const k = head;
    head = (head + 1) % N;
    a0.array.set([x, y, z, t0], k * 4);
    a1.array.set([vx, vy, vz, tauS], k * 4);
    a2.array.set([s0, s1, lifeS, a], k * 4);
    lastBirth = Math.max(lastBirth, t0);
  };
  const flush = () => {
    a0.needsUpdate = true;
    a1.needsUpdate = true;
    a2.needsUpdate = true;
  };
  return { object, mat, emit, flush, alive: (t: number) => t < lastBirth + 3 };
}

// ───────────────────────── 组装 ─────────────────────────

const isWallish = (t: number) => t === Tile.Wall || t === Tile.Window;

/** 这一帧最亮那支手电照着鬼魂的程度（uReveal，0..1）：声音（被照到时的低压声）、调试读。没有鬼魂画面时恒为 0 */
let revealNow = 0;
export function ghostRevealAmount(): number {
  return revealNow;
}

/** uReveal 在身体上取这几点估（模型局部 y：头、胸口、下摆上面一点）：手电只照到头或只照到下摆也算 */
const REVEAL_PROBES = [0.25, -0.15, -0.65];

/**
 * 现身时要借的另外两个模块（main.ts 建好、放进 modules，再传进来）：灯闪（lightfx.ts）、地上的霜（frost.ts）。
 * 没给的那个就不做：没有灯闪时落下、收不等暗下去，事件一到就换材质
 */
export interface GhostFx {
  lights?: LightFx | null;
  frost?: Frost | null;
}

export function createGhostView(core: RenderCore, rig: GhostRig, fx: GhostFx = {}): Module {
  const search = new URLSearchParams(location.search);
  if (search.has('noghostfx')) return {};
  const tiles = buildTiles();
  const wallAt = (i: number, j: number) => inGrid(i, j) && isWallish(tiles[idx(i, j)]);

  const root = new THREE.Group();
  root.name = 'ghost';
  core.houseRoot.add(root);

  const u = makeGhostUniforms();
  const look: GhostLook = { bottom: GHOST_BODY.bottom, top: GHOST_BODY.top };
  const geometry = buildGhostGeometry();
  // 身体双面（背面叠在正面后面：中间厚、边上薄）；雾晕只画正面
  const body = new THREE.Mesh(geometry, createGhostMaterial(u, look, GHOST.body, THREE.DoubleSide));
  body.name = 'ghost-body';
  const hazes = GHOST.haze.map((l, k) => {
    const m = new THREE.Mesh(geometry, createGhostMaterial(u, look, l, THREE.FrontSide, 'haze'));
    m.name = `ghost-haze-${k}`;
    return m;
  });
  const figure = new THREE.Group();
  figure.name = 'ghost-figure';
  // 现身停留时换上的「实」的那份（G2）：同一个网格。平时藏着；不进开场那次阻塞的预编译，
  // main.ts 在开场按钮可用之后再编（那几帧里 uSolid = 0，完全透明），第一次现身时不卡
  const solidMesh = new THREE.Mesh(geometry, createGhostSolidMaterial(u, look));
  solidMesh.name = 'ghost-solid';
  solidMesh.visible = false;
  solidMesh.userData.deferCompile = true;
  for (const [k, m] of [body, ...hazes].entries()) {
    m.castShadow = false;
    m.receiveShadow = false;
    // 顶点着色器会飘、会拖，包围球按静止的算不准；只有一个人影，不剔除也不费事
    m.frustumCulled = false;
    m.renderOrder = GHOST.renderOrder + k * 0.01;
    figure.add(m);
  }
  solidMesh.castShadow = false;
  solidMesh.receiveShadow = false;
  solidMesh.frustumCulled = false;
  // 普通混合：画在冷雾（renderOrder − 0.05）之前，往下淌的雾落在它前面时盖得住
  solidMesh.renderOrder = GHOST.renderOrder - 0.1;
  figure.add(solidMesh);
  root.add(figure);

  const mist = createMist(u.time);
  root.add(mist.object);

  let quality: Quality = core.quality;
  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

  // —— 状态：平滑后的朝向、速度；穿墙检测 ——
  const g = rig.ghost;
  let yaw = g.heading;
  const last = new THREE.Vector3(g.x, g.y, g.z);
  const vel = new THREE.Vector3();
  let wasInWall = g.inWall;
  let puffReadyAt = 0;
  let emitAcc = 0;
  let puffs = 0;
  const camPos = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const rand = (r: readonly [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
  /** 每支手电「中间没有墙」的平滑值（0..1） */
  const losS: number[] = Array.from({ length: TORCH_COUNT }, () => 0);
  const twp = new THREE.Vector3();
  const tdir = new THREE.Vector3();

  // —— 现身（G2 / G3 / G4）——
  /** 此刻显示的是「实」的那份 */
  let solid = false;
  /** 是 state 兜底换上的（错过了 drop 事件）：state 一离开 hold 就换回 */
  let solidByState = false;
  /** 换成「实」的那一刻（真实时间）：state 里没有停留时间时（只发事件的调试页）按它算头抬到哪 */
  let solidSince = 0;
  /** 等着换材质：to = 换成实的 / 换回雾；从下一次 update 起再过 delay 秒（at 由 update 填，和 lightfx 的效果同一帧起算） */
  let swap: { to: boolean; delay: number; at: number } | null = null;
  /** 停留时压着附近的灯（lightfx.pulse 的返回值），收的时候放开 */
  let holdRelease: (() => void) | null = null;
  /** 降帧：上一次更新位置、朝向是第几个 1 / stepRate 秒 */
  let stepTick = -1;
  /** 平时的鬼魂跟着附近灯的明暗（过了热惯性的） */
  let follow = 1;
  let pours = 0;

  const setSolid = (on: boolean, t: number, byState = false) => {
    solid = on;
    solidByState = on && byState;
    if (on) solidSince = t;
    u.solid.value = on ? 1 : 0;
    u.step.value = on ? 1 : 0;
    body.visible = !on;
    for (const m of hazes) m.visible = !on;
    solidMesh.visible = on;
    stepTick = -1;
  };

  /** 停留时：冷雾从下摆往下淌，落到地上铺开 */
  const emitPour = (t: number) => {
    const Pr = GHOST_MIST.pour;
    const a = Math.random() * Math.PI * 2;
    const r = rand(Pr.r);
    const ca = Math.cos(a), sa = Math.sin(a);
    mist.emit(
      g.x + ca * r, g.y + rand(Pr.y), g.z + sa * r, t,
      ca * Pr.spread * Math.random(), rand(Pr.vy), sa * Pr.spread * Math.random(), Pr.tau,
      rand(Pr.size0), rand(Pr.size1), rand(Pr.life), rand(Pr.alpha),
    );
    pours++;
  };

  /** 现身事件：蓄力时灯闪、霜往外长；落下、收的时候灯暗一下，暗到最深的那一帧换材质（见 GHOST.manifest） */
  const onManifest = (e: Extract<SimEvent, { type: 'manifest' }>) => {
    const M = GHOST.manifest;
    const lights = fx.lights ?? null;
    if (e.phase === 'windup') {
      lights?.pulse(e.pos, M.radius, M.windup, MANIFEST.windup);
      fx.frost?.grow(e.pos, M.frost, MANIFEST.windup);
    } else if (e.phase === 'drop') {
      lights?.dipAll(e.pos, M.radius, M.drop.depth, M.drop.ms);
      holdRelease?.();
      holdRelease = lights ? lights.pulse(e.pos, M.radius, M.hold, MANIFEST.hold + M.holdSlack) : null;
      swap = { to: true, delay: lights ? (M.drop.ms / 1000) * M.swapAt : 0, at: NaN };
    } else {
      holdRelease?.();
      holdRelease = null;
      lights?.dipAll(e.pos, M.radius, M.end.depth, M.end.ms);
      swap = { to: false, delay: lights ? (M.end.ms / 1000) * M.swapAt : 0, at: NaN };
    }
  };

  /** 手电照出（G1）：登记表 → uniform（世界坐标），中间有墙的那支强度记 0；顺便估 uReveal */
  const writeTorches = (dt: number) => {
    const k = dt > 0 ? 1 - Math.exp(-dt / GHOST.reveal.losTau) : 0;
    let best = 0;
    for (let i = 0; i < TORCH_COUNT; i++) {
      const t = torches[i];
      // 远到照不着（光锥最远 range，再加半个身宽）就不查视线
      const near = t.power > 0 && Math.hypot(t.x - g.x, t.z - g.z) < t.range + 0.5;
      const los = near && ghostSees(t, g) ? 1 : 0;
      losS[i] = near ? losS[i] + (los - losS[i]) * k : 0;
      twp.set(t.x, t.y, t.z);
      core.houseRoot.localToWorld(twp);
      tdir.set(t.dx, t.dy, t.dz).transformDirection(core.houseRoot.matrixWorld);
      u.torchPos[i].value.set(twp.x, twp.y, twp.z, Math.max(t.range, 0.01));
      u.torchDir[i].value.set(tdir.x, tdir.y, tdir.z, Math.cos(t.angle));
      u.torchPow[i].value = near ? t.power * losS[i] : 0;
      if (near) for (const py of REVEAL_PROBES) best = Math.max(best, torchRevealAt(t, losS[i], g.x, g.y + py, g.z));
    }
    revealNow = Math.min(1, best);
    u.reveal.value = revealNow;
  };

  /** 尾迹：从下摆附近出生，偏向身后（和走动方向相反的那半圈） */
  const emitTrail = (t: number, speed: number) => {
    const T = GHOST_MIST.trail;
    const back = speed > 0.05 ? Math.atan2(-vel.z, -vel.x) : Math.random() * Math.PI * 2;
    const a = back + (Math.random() - 0.5) * (speed > 0.05 ? 2.2 : Math.PI * 2);
    const r = rand(T.r);
    const y = g.y + lerp(T.y[0], T.y[1], Math.random() ** 1.6);
    mist.emit(
      g.x + Math.cos(a) * r, y, g.z + Math.sin(a) * r, t,
      vel.x * T.carry + (Math.random() - 0.5) * T.jitter, -0.03 + (Math.random() - 0.5) * T.jitter * 0.5,
      vel.z * T.carry + (Math.random() - 0.5) * T.jitter, T.tau,
      rand(T.size0), rand(T.size1), rand(T.life), rand(T.alpha) * lerp(T.idleAlpha, 1, Math.min(1, speed / T.fullSpeed)),
    );
  };

  /** 穿墙：在墙面上喷一团，贴着墙往四周散开，分到墙两边 */
  const puff = (t: number) => {
    const Pf = GHOST_MIST.puff;
    // 墙的朝向按格子地图：鬼魂所在的墙格左右是墙 → 东西走向的墙（法线朝 z），上下是墙 → 南北走向（法线朝 x）；
    // 认不出来（转角、不在墙格里）就用走动方向当法线
    const [i, j] = cellOf(g.x, g.z);
    let nx = 0, nz = 0, cx = g.x, cz = g.z;
    const along = wallAt(i - 1, j) || wallAt(i + 1, j);
    const across = wallAt(i, j - 1) || wallAt(i, j + 1);
    if (wallAt(i, j) && along !== across) {
      if (along) { nz = 1; cz = (j + 0.5) * CELL; } else { nx = 1; cx = (i + 0.5) * CELL; }
    } else {
      const l = Math.hypot(vel.x, vel.z);
      const hd = l > 0.05 ? Math.atan2(vel.z, vel.x) : yaw;
      nx = Math.cos(hd);
      nz = Math.sin(hd);
    }
    // 墙面内的两个方向：水平（沿墙）和竖直
    const ax = -nz, az = nx;
    const cy = g.y + Pf.dy;
    const n = Pf.count[quality];
    for (let k = 0; k < n; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const th = Math.random() * Math.PI * 2;
      const hx = Math.cos(th), hy = Math.sin(th) * Pf.flatY;
      const sp = rand(Pf.radial);
      const off = rand(Pf.offset) * side;
      const start = 0.05 + Math.random() * 0.2;
      mist.emit(
        cx + ax * hx * start + nx * off, cy + hy * start, cz + az * hx * start + nz * off, t + Math.random() * 0.06,
        ax * hx * sp + nx * side * rand(Pf.normal), hy * sp - 0.05, az * hx * sp + nz * side * rand(Pf.normal), Pf.tau,
        rand(Pf.size0), rand(Pf.size1), rand(Pf.life), rand(Pf.alpha),
      );
    }
    puffs++;
  };

  if (search.has('debug')) {
    (window as unknown as { __ghostView: unknown }).__ghostView = {
      /** 立刻在鬼魂所在处喷一团（不等穿墙） */
      puff: () => { puff(u.time.value); mist.flush(); },
      stats: () => ({
        puffs, quality, fade: +u.fade.value.toFixed(3), lean: u.lean.value.toArray().map((v) => +v.toFixed(3)),
        vel: vel.toArray().map((v) => +v.toFixed(2)), mistAlive: mist.alive(u.time.value),
        reveal: +revealNow.toFixed(3), torchPow: u.torchPow.map((p) => +p.value.toFixed(3)),
        solid, swapPending: swap !== null, head: +((u.head.value * 180) / Math.PI).toFixed(2), follow: +follow.toFixed(3), pours,
      }),
      uniforms: u,
      /** 鬼魂的根节点（量开销时整个藏起来：__ghostView.root.visible = false） */
      root,
    };
  }

  return {
    onEvent(e: SimEvent) {
      if (e.type === 'manifest') onManifest(e);
    },
    update(ctx: FrameCtx) {
      const dt = ctx.dt;
      const t = ctx.time;
      u.time.value = t;
      const reduced = reducedMq?.matches === true;
      const M = GHOST.manifest;

      // —— 现身：在灯暗到最深的那一帧换材质（G4）；错过事件时按 state 对齐 ——
      if (swap) {
        if (Number.isNaN(swap.at)) swap.at = t + swap.delay;
        if (t >= swap.at) {
          setSolid(swap.to, t);
          swap = null;
        }
      }
      const man = (ctx.state as Partial<WorldState>).manifest;
      const holding = man?.phase === 'hold';
      if (!swap) {
        if (holding && !solid) setSolid(true, t, true);
        // 只收到事件、state 不动的调试页：收的事件丢了也在停留时长加上兜底之后换回
        else if (solid && !holding && (solidByState || t - solidSince > MANIFEST.hold + M.holdSlack)) setSolid(false, t);
      }

      // 位置跟着 rig（不平滑，镜头也跟着它）；朝向、速度平滑一点。现身停留时位置、朝向只每秒更新 stepRate 次（G3）
      yaw += wrapAngle(g.heading - yaw) * (1 - Math.exp(-dt / GHOST.turnTau));
      const tick = Math.floor(t * M.stepRate);
      if (!solid || tick !== stepTick) {
        stepTick = tick;
        figure.position.set(g.x, g.y, g.z);
        figure.rotation.y = yawFor(yaw);
      }
      // 头：停留了多久（按 1 / stepRate 秒取整）→ 从低着头慢慢抬起来
      const held = holding && man ? man.t : t - solidSince;
      const heldQ = Math.floor(held * M.stepRate) / M.stepRate;
      const HP = GHOST.solid.headPitch;
      u.head.value = solid ? lerp(HP[0], HP[1], smooth01(0, MANIFEST.hold, heldQ)) : 0;
      if (dt > 0) {
        tmp.set(g.x - last.x, g.y - last.y, g.z - last.z).divideScalar(dt);
        if (tmp.lengthSq() > 64) tmp.set(0, 0, 0); // 瞬移（调试放置、换场）不算
        vel.lerp(tmp, 1 - Math.exp(-dt / GHOST.velTau));
      }
      last.set(g.x, g.y, g.z);
      const speed = Math.hypot(vel.x, vel.z);

      // 下摆往后拖：速度换到模型局部坐标（模型正面朝 +z，rotation.y = yawFor(yaw)）
      const L = GHOST.lean;
      const k = Math.min(L.max, speed * L.perSpeed) / Math.max(speed, 1e-4);
      const ry = figure.rotation.y, cr = Math.cos(ry), sr = Math.sin(ry);
      // 世界 → 局部：绕 y 轴转 −ry
      const lx = vel.x * cr - vel.z * sr, lz = vel.x * sr + vel.z * cr;
      u.lean.value.set(-lx * k, -lz * k);

      // 镜头太近时淡出；整体很慢地明暗起伏
      rig.camera.getWorldPosition(camPos);
      core.houseRoot.updateWorldMatrix(true, false);
      core.houseRoot.worldToLocal(camPos);
      const dCam = camPos.distanceTo(tmp.set(g.x, g.y - 0.27, g.z));
      const near = smooth01(GHOST.near[0], GHOST.near[1], dCam);
      const B = GHOST.breathe;
      const breathe = 1 - B.amount * (0.5 + 0.5 * Math.sin((t * Math.PI * 2) / B.period));
      // 平时的鬼魂自己发光，跟着附近灯的明暗一起暗（借暗下去的那一下出入）；「实」的那份不呼吸、不跟（它本来就暗，挡光）
      follow = thermal(follow, fx.lights ? fx.lights.level(g) : 1, dt);
      u.fade.value = lerp(GHOST.minAlpha, 1, near) * (solid ? 1 : breathe * lerp(1, follow, M.follow));

      // 手电照出（houseRoot 的世界矩阵上面已经更新过）
      writeTorches(dt);

      // 冷雾：尾迹按速度连续出（现身停留时改成从下摆往下淌）；穿墙那一刻喷一团
      let dirty = false;
      const mistK = (quality === 'low' ? GHOST_MIST.lowRate : 1) * (reduced ? 0.6 : 1);
      const rate = (solid ? GHOST_MIST.pour.rate : GHOST_MIST.trail.idle + GHOST_MIST.trail.perSpeed * speed) * mistK;
      emitAcc = Math.min(emitAcc + rate * dt, 6);
      while (emitAcc >= 1) {
        emitAcc -= 1;
        if (solid) emitPour(t - Math.random() * dt);
        else emitTrail(t - Math.random() * dt, speed);
        dirty = true;
      }
      if (g.inWall && !wasInWall && t >= puffReadyAt) {
        puff(t);
        puffReadyAt = t + GHOST_MIST.puff.cooldown;
        dirty = true;
      }
      wasInWall = g.inWall;
      if (dirty) mist.flush();
    },
    setQuality(q) { quality = q; },
    dispose() {
      revealNow = 0;
      holdRelease?.();
      core.houseRoot.remove(root);
      geometry.dispose();
      for (const m of [body, ...hazes, solidMesh]) (m.material as THREE.Material).dispose();
      mist.mat.dispose();
    },
  };
}
