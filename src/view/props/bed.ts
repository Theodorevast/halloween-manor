// 床：被子下面有人（设计文档 4.1，调研 3.4）。被附身时，被子下面先后鼓起三个包（膝、躯干、头），像有人躺在下面，
// 起伏几下，头慢慢转向访客，然后一下子塌平，落下去扬起一点灰，被子上留着一个人形的凹陷，几秒里慢慢回平。
// 不露出身体部位、不出现脸：只有一块布在动。
//
// 做法：被子是一块细分的网格（顶面 + 垂下去的一圈边），鼓包全在顶点着色器里按高度函数顶出来，
// 法线用有限差分按位移重算，所以手电掠过时鼓包有明暗、有影子（影子用同一个位移，见 shadowSide）。
// 家具里的床（furniture.ts）不再画被子，这块被子既是静止时的被子，也是动画。
//
// 局部坐标（props.ts 摆放：根在 propCenter，转 yawFor(facing)，模型正面朝 +z）：床头在 -z（靠西墙），床尾在 +z；
// x 是床宽方向（+x 朝北，床头柜那边）。床是 2.0 米宽（x）× 1.5 米长（z），枕头并排放在床头，
// 所以人躺在床头到床尾（z）这条线上，睡在其中一个枕头上；物件格是床面当中的一格，不在床的正中心，
// 所以下面的范围都是从家具表换算出来的。
import * as THREE from 'three/webgpu';
import { attribute, exp, float, fract, positionGeometry, smoothstep, transformNormalToView, uniform, varying, vec3 } from 'three/tsl';
import { CELL, FURNITURE, PROPS, propCenter } from '../../config/house';
import { yawFor } from '../../lib/angle';
import { PALETTE } from '../palette';
import { FURNITURE_TOP } from '../furniture';
import { C, clamp01, inOutSine, inQuad, mesh, seg, type PropFrame, type PropRig } from './kit';

/** 时间线（秒，从 trigger 算起）。SCARES.bed.hitAt 要和 collapse 一致（惊吓在这一刻落下） */
export const BED_TIMELINE = {
  /** 三个鼓包依次升起：[开始, 结束] */
  rise: { knee: [0, 0.5], torso: [0.3, 0.9], head: [0.7, 1.2] } as const,
  /** 呼吸：从 breathFrom 起，周期 breathPeriod；到 breathTo 停（停在吸满的位置，像憋住了气） */
  breathFrom: 1.2,
  breathTo: 2.2,
  breathPeriod: 3,
  /** 头沿枕头横移、转向访客：[开始, 结束] */
  turn: [2.2, 2.6] as const,
  /** 塌平：collapse 时刻开始，collapseTime 秒落完 */
  collapse: 2.6,
  collapseTime: 0.12,
  /** 凹陷：塌平以后多久回平 */
  dent: 5,
};
const END = BED_TIMELINE.collapse + BED_TIMELINE.collapseTime + BED_TIMELINE.dent;

/** 被子的范围和形状（米） */
const QUILT = {
  /** 被子顶面比床面（FURNITURE_TOP.bed）高多少：床垫顶面在 0.45，原来家具里那块被子顶面正好 0.5，这块接着它 */
  lift: 0,
  /** 床头留给枕头的一截（从格子矩形的床头边算起；furniture.ts 里枕头占到离床头板 0.46 米，床头板靠墙多伸出 0.15 米） */
  pillow: 0.45,
  /** 床尾、两侧各缩进多少 */
  foot: 0.06,
  side: 0.04,
  /**
   * 细分：沿床宽（x）、沿床长（z）。被子 1.92 × 0.99 米，格子约 3 × 2.5 厘米：鼓包最窄的头也有 8 厘米多的标准差，
   * 够细；顶面约 5000 个三角形，加上边缘一圈约 7000（任务 1 的占位是 40 × 60：床宽方向太粗、床长方向太细）
   */
  segs: [64, 40] as [number, number],
  /** 边缘垂下去的一圈（离顶面边缘向外、向下，米）：先圆润地拐下去，再几乎垂直地垂到 0.26 米（原来家具里两侧垂下的那条到 0.24） */
  edge: [[0, 0], [0.008, 0.0005], [0.016, 0.006], [0.021, 0.02], [0.023, 0.06], [0.024, 0.24]] as [number, number][],
  /** 床头翻折下来的那条床单有多宽（原来是 14 厘米，一部分压在枕头边上） */
  fold: 0.12,
  /** 离被子边缘这么宽以内，鼓包和凹陷逐渐压回静止的位置（被子边是塞着的，不跟着动） */
  tuck: 0.09,
  /** 绗缝的菱形格：间距、线宽（米）、线的暗度（0..1） */
  stitch: { pitch: 0.16, width: 0.005, dark: 0.2 },
  /** 凹陷里被压扁的布面更暗一点（最深处暗多少，0..1）：2 厘米的坑只有擦着光才看得出，这一点让它在哪种光下都认得出 */
  dentShade: 0.22,
};
/** 拾取盒的高度范围：盖住被子和鼓起来的部分 */
const HIT_Y: [number, number] = [0.35, 0.85];

/**
 * 被子下面的人（鼓包的位置、大小）。z 是离被子床头边多远；sx、sz 是高斯鼓包两个方向的标准差，h 是升到顶的高度。
 * 三个包连成一个侧躺的人形：头最小，躯干最宽最高，膝盖在被子靠床尾的地方。
 * 只有三个光滑的包，没有手脚、没有脸
 */
const BODY = {
  /**
   * 睡在哪个枕头上：离床中线多远（两个枕头的中心离中线 ±0.48 米，+ 是北边、床头柜那边）。
   * 睡南边那个：离门远一点，默认的娃娃屋镜头在东南，这一侧离镜头近、不被床尾板挡，看得最清楚
   */
  side: -0.48,
  knee: { z: 0.78, sx: 0.16, sz: 0.12, h: 0.105 },
  torso: { z: 0.45, sx: 0.19, sz: 0.16, h: 0.16 },
  head: { z: 0.14, sx: 0.085, sz: 0.09, h: 0.12 },
  /** 呼吸起伏的幅度（躯干；膝、头按比例） */
  breath: 0.015,
  /** 头沿枕头横移多远（朝北，访客从北边的门进来；睡在南边的枕头上，就是往床中间转） */
  headShift: 0.1,
  /**
   * 凹陷（负的鼓包，塌平以后留着）：[深度, 床宽方向的半宽, 床长方向的半宽]（米）。
   * 形状是 exp(-r⁴)：底比较平、坑壁比高斯陡（同样的 2 厘米，坡度大近一倍，才擦着光就看得出）；
   * 三块互相连起来成一道人形的浅沟；躯干那块最深（2 厘米）
   */
  dent: { torso: [0.02, 0.25, 0.22], knee: [0.011, 0.2, 0.16], head: [0.012, 0.11, 0.12] } as Record<'torso' | 'knee' | 'head', readonly [number, number, number]>,
};

/** 家具表里床的矩形：{ x0, z0, x1, z1 }（米，物件局部坐标） */
interface Box2 { x0: number; z0: number; x1: number; z1: number }

/** 房屋米坐标 → 物件局部坐标（物件根在 propCenter，绕 y 转 yaw）；取到微米，免得 cos(π/2) 留下 1e-17 的尾巴 */
const toLocal = (x: number, z: number, c: { x: number; z: number }, yaw: number): [number, number] => {
  const dx = x - c.x, dz = z - c.z;
  const snap = (v: number) => Math.round(v * 1e6) / 1e6;
  return [snap(dx * Math.cos(yaw) - dz * Math.sin(yaw)), snap(dx * Math.sin(yaw) + dz * Math.cos(yaw))];
};

export interface BedLayout {
  /** 床面（格子矩形）和被子的范围、被子顶面高度 */
  bed: Box2;
  quilt: Box2;
  y: number;
  /** 躺着的人在被子上的位置：床宽方向（x）和三个包的床长方向位置（z） */
  bodyX: number;
  knee: number;
  torso: number;
  head: number;
}

/** 床和被子在物件局部坐标里的布局（从家具表换算，不建任何东西） */
export function bedLayout(): BedLayout {
  const placement = PROPS.find((p) => p.type === 'bed');
  const bed = FURNITURE.find((f) => f.id === 'bedroom-bed');
  if (!placement || !bed) throw new Error('bed: PROPS 里没有 bed，或者家具表里没有 bedroom-bed');
  const c = propCenter(placement), yaw = yawFor(placement.facing);
  const { x0, z0, x1, z1 } = bed.rect;
  const corners = [[x0, z0], [x1, z0], [x0, z1], [x1, z1]].map(([i, j]) => toLocal(i * CELL, j * CELL, c, yaw));
  const bx0 = Math.min(...corners.map((p) => p[0])), bx1 = Math.max(...corners.map((p) => p[0]));
  const bz0 = Math.min(...corners.map((p) => p[1])), bz1 = Math.max(...corners.map((p) => p[1]));
  // 被子：床宽方向两侧各缩 side，床头让出枕头，床尾缩 foot
  const quilt = { x0: bx0 + QUILT.side, x1: bx1 - QUILT.side, z0: bz0 + QUILT.pillow, z1: bz1 - QUILT.foot };
  return {
    bed: { x0: bx0, z0: bz0, x1: bx1, z1: bz1 },
    quilt,
    y: FURNITURE_TOP.bed + QUILT.lift,
    bodyX: (bx0 + bx1) / 2 + BODY.side,
    knee: quilt.z0 + BODY.knee.z,
    torso: quilt.z0 + BODY.torso.z,
    head: quilt.z0 + BODY.head.z,
  };
}

/** 落下时扬灰的位置：躯干那个包正上方的被子面（物件局部坐标）。particles.ts 按物件的摆放换算成房屋坐标 */
export function bedDustSpot(): { x: number; y: number; z: number } {
  const L = bedLayout();
  return { x: L.bodyX, y: L.y, z: L.torso };
}

// ───────────────────────── 被子的网格 ─────────────────────────

export interface QuiltMesh {
  position: Float32Array;
  normal: Float32Array;
  color: Float32Array;
  index: Uint32Array;
}

/**
 * 顶面（nx × nz 格）+ 边缘垂下去的一圈（QUILT.edge）。顶面法线朝上，边缘按剖面曲线算平滑法线；
 * 边缘的第一排顶点和顶面边缘共用，所以没有缝。床头那条边靠枕头的一段 QUILT.fold 宽，颜色换成床单（顶点色）。
 * 三角形的绕向按顶点法线自动对正（法线说朝哪边，正面就朝哪边）。
 * 顶面边缘的点不会被位移（着色器里压回 0），所以边缘这一圈是静止的
 */
export function buildQuiltMesh(q: Box2, y: number, nx: number, nz: number, fabric: THREE.Color, linen: THREE.Color): QuiltMesh {
  const W = nx + 1;
  const topN = W * (nz + 1);
  const ring: [number, number, number, number][] = []; // 边缘一圈的点：(i, j, 向外的 x 分量、z 分量)
  for (let i = 0; i < nx; i++) ring.push([i, 0, i === 0 ? -1 : 0, -1]);
  for (let j = 0; j < nz; j++) ring.push([nx, j, 1, j === 0 ? -1 : 0]);
  for (let i = nx; i > 0; i--) ring.push([i, nz, i === nx ? 1 : 0, 1]);
  for (let j = nz; j > 0; j--) ring.push([0, j, -1, j === nz ? 1 : 0]);
  const rows = QUILT.edge.length - 1; // 第 0 排就是顶面边缘，不新建
  const total = topN + ring.length * rows;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const color = new Float32Array(total * 3);
  const xAt = (i: number) => q.x0 + ((q.x1 - q.x0) * i) / nx;
  const zAt = (j: number) => q.z0 + ((q.z1 - q.z0) * j) / nz;

  // 顶面
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * W + i;
      position.set([xAt(i), y, zAt(j)], k * 3);
      normal.set([0, 1, 0], k * 3);
      const c = zAt(j) - q.z0 < QUILT.fold ? linen : fabric;
      color.set([c.r, c.g, c.b], k * 3);
    }
  }

  // 边缘的剖面法线：(向外分量, 向上分量)，按相邻两排的连线算，两端取单侧
  const prof = QUILT.edge;
  const profN = prof.map((_, k) => {
    const a = prof[Math.max(0, k - 1)], b = prof[Math.min(rows, k + 1)];
    const to = b[0] - a[0], td = -(b[1] - a[1]); // 向外、向上（d 是向下的距离，取负）
    const len = Math.hypot(to, td) || 1;
    return [-td / len, to / len] as [number, number]; // 切线 (to, td) 转 90°：(-td, to)
  });

  const rowIndex = (p: number, r: number) => (r === 0 ? ring[p][1] * W + ring[p][0] : topN + p * rows + (r - 1));
  ring.forEach(([i, j, sx, sz], p) => {
    const l = Math.hypot(sx, sz);
    for (let r = 1; r <= rows; r++) {
      const [o, d] = prof[r];
      const k = rowIndex(p, r);
      // 拐角处向外的偏移取斜角（x、z 两个方向各 o），两侧才不会在角上错开
      position.set([xAt(i) + sx * o, y - d, zAt(j) + sz * o], k * 3);
      normal.set([(sx / l) * profN[r][0], profN[r][1], (sz / l) * profN[r][0]], k * 3);
      color.set([fabric.r, fabric.g, fabric.b], k * 3);
    }
  });

  const idx: number[] = [];
  const quad = (a: number, b: number, c: number, d: number) => idx.push(a, b, c, a, c, d);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) quad(j * W + i, (j + 1) * W + i, (j + 1) * W + i + 1, j * W + i + 1);
  for (let p = 0; p < ring.length; p++) {
    const n = (p + 1) % ring.length;
    for (let r = 0; r < rows; r++) quad(rowIndex(p, r), rowIndex(n, r), rowIndex(n, r + 1), rowIndex(p, r + 1));
  }
  // 绕向对正：三角形的几何法线要和三个顶点的法线之和同向
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3];
    const e1 = [position[b] - position[a], position[b + 1] - position[a + 1], position[b + 2] - position[a + 2]];
    const e2 = [position[c] - position[a], position[c + 1] - position[a + 1], position[c + 2] - position[a + 2]];
    const fx = e1[1] * e2[2] - e1[2] * e2[1], fy = e1[2] * e2[0] - e1[0] * e2[2], fz = e1[0] * e2[1] - e1[1] * e2[0];
    const dot = fx * (normal[a] + normal[b] + normal[c]) + fy * (normal[a + 1] + normal[b + 1] + normal[c + 1]) + fz * (normal[a + 2] + normal[b + 2] + normal[c + 2]);
    if (dot < 0) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
  }
  return { position, normal, color, index: new Uint32Array(idx) };
}

// ───────────────────────── 被子的材质（鼓包在顶点着色器里） ─────────────────────────

type F = THREE.Node<'float'>;

/** 驱动鼓包的几个量（每帧由 update 写） */
const makeUniforms = () => ({
  /** 三个包升起的进度 0..1 */
  knee: uniform(0),
  torso: uniform(0),
  head: uniform(0),
  /** 呼吸：躯干多抬了多少（米，有正负） */
  breath: uniform(0),
  /** 头沿枕头横移了多少（米） */
  headShift: uniform(0),
  /** 塌平的进度 0..1（鼓包乘 1 - collapse） */
  collapse: uniform(0),
  /** 凹陷的深浅 0..1（塌平以后从 1 退到 0） */
  dent: uniform(0),
});
type QuiltU = ReturnType<typeof makeUniforms>;

function quiltMaterial(L: BedLayout, u: QuiltU) {
  const q = L.quilt;
  // 三个包的中心（头那个加上横移）
  const sq = (n: F): F => n.mul(n);
  const hump = (z: number, s: { sx: number; sz: number }, dx: F | number = 0) => (x: F, zz: F): F =>
    exp(sq(x.sub(L.bodyX).sub(dx).div(s.sx)).add(sq(zz.sub(z).div(s.sz))).negate());
  const gKnee = hump(L.knee, BODY.knee);
  const gTorso = hump(L.torso, BODY.torso);
  const gHead = hump(L.head, BODY.head, u.headShift);
  const D = BODY.dent;
  const pit = (z: number, d: readonly [number, number, number], dx: F | number = 0) => (x: F, zz: F): F => {
    const r2 = sq(x.sub(L.bodyX).sub(dx).div(d[1])).add(sq(zz.sub(z).div(d[2])));
    return exp(sq(r2).negate()).mul(d[0]);
  };
  const pitKnee = pit(L.knee, D.knee);
  const pitTorso = pit(L.torso, D.torso);
  const pitHead = pit(L.head, D.head, u.headShift);
  /** 凹陷此刻有多深（米，正 = 往下）：三个坑加起来；还没乘 u.dent、边缘还没压回 */
  const pits = (x: F, z: F): F => pitTorso(x, z).add(pitKnee(x, z)).add(pitHead(x, z));

  // 被子边缘塞着：离边缘 tuck 米以内，位移逐渐压回 0（范围外也是 0，边缘垂下去的那一圈不动）
  const tuck = (x: F, z: F): F =>
    smoothstep(0, QUILT.tuck, x.sub(q.x0)).mul(smoothstep(0, QUILT.tuck, float(q.x1).sub(x)))
      .mul(smoothstep(0, QUILT.tuck, z.sub(q.z0))).mul(smoothstep(0, QUILT.tuck, float(q.z1).sub(z)));

  /** 高度函数：被子上 (x, z) 这一点比静止时高多少（米） */
  const height = (x: F, z: F): F => {
    const k = gKnee(x, z), t = gTorso(x, z), h = gHead(x, z);
    const up = u.knee.mul(BODY.knee.h).mul(k)
      .add(u.torso.mul(BODY.torso.h).mul(t))
      .add(u.head.mul(BODY.head.h).mul(h))
      // 呼吸：胸口起伏最明显，膝盖、头只跟着动一点
      .add(u.breath.mul(t.add(k.mul(0.5)).add(h.mul(0.3))));
    // 凹陷：和鼓包一个轮廓，塌平以后留着
    return up.mul(float(1).sub(u.collapse)).sub(u.dent.mul(pits(x, z))).mul(tuck(x, z));
  };

  // 位移：只改 y。读的是顶点自己的原始位置（positionGeometry），不是 positionLocal（那是位移以后的值）
  const px = positionGeometry.x, pz = positionGeometry.z;
  const material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  material.positionNode = vec3(px, positionGeometry.y.add(height(px, pz)), pz);

  // 法线：高度场的有限差分（前后各 2 厘米），再叠到顶点自己的法线上（顶面朝上，所以等于差分的法线；
  // 边缘垂下去的那圈高度恒为 0，差分是平的，保留它自己的法线）。在顶点里算好、插值，片元里只做一次变换
  const E = 0.02;
  const hx = height(px.add(E), pz).sub(height(px.sub(E), pz));
  const hz = height(px, pz.add(E)).sub(height(px, pz.sub(E)));
  const bent = vec3(hx.negate(), 2 * E, hz.negate()).normalize().sub(vec3(0, 1, 0));
  const nLocal = attribute('normal', 'vec3').add(bent).normalize();
  material.normalNode = varying(transformNormalToView(nLocal), 'vQuiltNormal').normalize();

  // 一个单片的网格：顶面从光源这边看是正面，阴影这一趟默认画背面，被子就不投影了
  material.shadowSide = THREE.DoubleSide;

  // 绗缝：菱形的暗线（只在顶面和刚拐下去的那一圈、床头翻折的床单以外；用静止时的位置算，所以跟着布走）
  const s = QUILT.stitch;
  const dia = (a: F) => smoothstep(0, s.width, fract(a.div(s.pitch).add(0.5)).sub(0.5).abs().mul(s.pitch));
  const a = px.add(pz).mul(Math.SQRT1_2), b = px.sub(pz).mul(Math.SQRT1_2);
  const line = float(1).sub(dia(a).min(dia(b)));
  const onTop = smoothstep(L.y - 0.012, L.y - 0.004, positionGeometry.y);
  const quiltPart = smoothstep(q.z0 + QUILT.fold - 0.012, q.z0 + QUILT.fold + 0.012, pz);
  // 凹陷里的布面更暗：在顶点里算好（0..1，最深的躯干那里 = 1）、插值
  const dentAmt = varying(u.dent.mul(pits(px, pz)).mul(tuck(px, pz)).div(D.torso[0]).min(1), 'vQuiltDent');
  material.colorNode = vec3(float(1).sub(line.mul(onTop).mul(quiltPart).mul(s.dark)).mul(float(1).sub(dentAmt.mul(QUILT.dentShade))));
  return material;
}

// ───────────────────────── 物件 ─────────────────────────

export function createBed(): PropRig {
  const L = bedLayout();
  const q = L.quilt;
  const fabric = new THREE.Color(C.fabric);
  // 床单：和家具里床垫、枕头同一个颜色（furniture.ts 的 linen）
  const linen = new THREE.Color(PALETTE.wallpaper).lerp(new THREE.Color(PALETTE.moonSky), 0.5).multiplyScalar(1.45);
  const m = buildQuiltMesh(q, L.y, QUILT.segs[0], QUILT.segs[1], fabric, linen);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(m.color, 3));
  geo.setIndex(new THREE.BufferAttribute(m.index, 1));

  const u = makeUniforms();
  const model = new THREE.Group();
  model.name = 'bed';
  const quilt = mesh(geo, quiltMaterial(L, u), 'bed-quilt');
  model.add(quilt);

  // 幽光外壳：幽光外壳是背面、沿法线鼓出的，单片的被子顶面从上往下看背面朝下、被剔除，看不见（任务 1 评审 M-1），
  // 所以给一个把被子（连垂下去的那圈）包起来的闭合薄盒，外壳只用它生成；盒子顶面就是被子静止时的顶面。
  // 被子鼓起来的时候外壳不跟着动（鼓包把它顶穿，被挡住的部分本来就看不见），幽光那时已经熄了（冷却中）
  const edge = QUILT.edge[QUILT.edge.length - 1];
  const bottom = L.y - edge[1];
  const shellBox = new THREE.BoxGeometry(q.x1 - q.x0 + edge[0] * 2, L.y - bottom, q.z1 - q.z0 + edge[0] * 2)
    .translate((q.x0 + q.x1) / 2, (L.y + bottom) / 2, (q.z0 + q.z1) / 2);

  let t = -1;
  const idle = () => { for (const k of Object.keys(u) as (keyof QuiltU)[]) u[k].value = 0; };
  const T = BED_TIMELINE;
  const pose = (s: number) => {
    u.knee.value = inOutSine(seg(s, ...T.rise.knee));
    u.torso.value = inOutSine(seg(s, ...T.rise.torso));
    u.head.value = inOutSine(seg(s, ...T.rise.head));
    // 呼吸：正弦；到 breathTo 就冻在那里（吸满、憋住），不是慢慢停下
    const bp = clamp01((s - T.breathFrom) / (T.breathTo - T.breathFrom)) * (T.breathTo - T.breathFrom);
    u.breath.value = BODY.breath * Math.sin((Math.PI * 2 * bp) / T.breathPeriod);
    u.headShift.value = BODY.headShift * inOutSine(seg(s, ...T.turn));
    // 塌平：越落越快（先 inQuad），落到底就是平的；凹陷在塌平的同时出现，之后 5 秒退回去：按 1 - u² 退，
    // 先慢后快，头几秒凹陷还很明显（刚才那里真有人），最后一两秒才合拢
    const c = inQuad(seg(s, T.collapse, T.collapse + T.collapseTime));
    u.collapse.value = c;
    u.dent.value = c * (1 - inQuad(seg(s, T.collapse + T.collapseTime, END)));
  };

  return {
    model,
    // 拾取盒盖住整个床面
    hit: {
      size: [L.bed.x1 - L.bed.x0, HIT_Y[1] - HIT_Y[0], L.bed.z1 - L.bed.z0],
      center: [(L.bed.x0 + L.bed.x1) / 2, (HIT_Y[0] + HIT_Y[1]) / 2, (L.bed.z0 + L.bed.z1) / 2],
    },
    shells: [{ parent: quilt, geometry: shellBox }],
    trigger() {
      t = 0;
    },
    reset() {
      t = -1;
      idle();
    },
    update(f: PropFrame) {
      if (t < 0) return;
      t += f.dt;
      if (t >= END) {
        t = -1;
        idle();
        return;
      }
      pose(t);
    },
  };
}
