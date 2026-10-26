// 物件共用的小工具：把基础几何体拼成「一个刚体部件 = 一个网格」、幽光外壳、拾取盒、缓动。
// 每个会单独动的部件合并成一个带顶点色的几何体，整套物件只有三十来个 draw call（手电阴影每盏还要再画一遍）。
import * as THREE from 'three/webgpu';
import { abs, color, normalLocal, normalViewGeometry, positionLocal, uniform } from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quality } from '../../engine/types';
import type { ScareObjectState, WorldState } from '../../sim/types';
import { PALETTE } from '../palette';

// ── 缓动（自己写，不引库） ──────────────────────────────────────────────
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** t 在 [a, b] 里的进度，夹到 0..1 */
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
export const inQuad = (t: number) => t * t;
export const inCubic = (t: number) => t * t * t;
export const outQuad = (t: number) => 1 - (1 - t) * (1 - t);
export const outCubic = (t: number) => 1 - (1 - t) ** 3;
export const outExpo = (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
export const inOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
export const inOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const outBack = (t: number, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;
/** 0 → 1 → 0 的单峰（sine），用于回弹 */
export const bump = (t: number) => (t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t));
/** 按帧率无关的方式把 cur 拉向 target（rate 越大越快） */
export const approach = (cur: number, target: number, rate: number, dt: number) =>
  target + (cur - target) * Math.exp(-rate * dt);

/** 平滑的伪随机抖动（几个不成整数比的正弦叠加），-1..1，用来做颤动、闪烁 */
export const wobble = (t: number, seed = 0) =>
  (Math.sin(t * 13.1 + seed) * 0.5 + Math.sin(t * 29.7 + seed * 2.3) * 0.3 + Math.sin(t * 53.3 + seed * 4.1) * 0.2);

// ── 颜色：调色板以外、只在物件上用的几种（都从调色板的色相推出来，压暗、去饱和） ──
export const C = {
  woodDark: PALETTE.woodDark,
  wood: PALETTE.wood,
  fabric: PALETTE.fabric,
  brass: PALETTE.brass,
  trim: PALETTE.wallTrim,
  /** 旧象牙（灯罩、人偶的瓷） */
  ivory: 0x9c8f78,
  /** 门板的油漆：发灰的深绿 */
  doorPaint: 0x2c3530,
  iron: 0x1c1a1a,
  velvet: 0x5a1820,
} as const;

// ── 部件拼装 ───────────────────────────────────────────────────────────
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

/**
 * 把一堆基础几何体（各自上色、摆好位置）合并成一个几何体。
 * 只保留 position / normal / color（平直着色不需要 uv），统一转成非索引，合并时属性才对得上。
 */
export class Parts {
  private list: THREE.BufferGeometry[] = [];

  add(geo: THREE.BufferGeometry, col: number, pos: [number, number, number] = [0, 0, 0], rot: [number, number, number] = [0, 0, 0], scale: [number, number, number] = [1, 1, 1]) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    geo.dispose();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    _m.compose(_p.set(...pos), _q.setFromEuler(_e.set(...rot)), _s.set(...scale));
    g.applyMatrix4(_m);
    g.computeVertexNormals();
    _c.set(col); // ColorManagement 打开时 set(hex) 已经换算成线性值，顶点色直接用
    const n = g.attributes.position.count;
    const cols = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) cols.set([_c.r, _c.g, _c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.list.push(g);
    return this;
  }

  box(w: number, h: number, d: number, col: number, pos: [number, number, number], rot?: [number, number, number]) {
    return this.add(new THREE.BoxGeometry(w, h, d), col, pos, rot);
  }

  /** 竖直圆柱（rTop / rBottom），segs 少一点更「低多边形」 */
  cyl(rTop: number, rBottom: number, h: number, segs: number, col: number, pos: [number, number, number], rot?: [number, number, number]) {
    return this.add(new THREE.CylinderGeometry(rTop, rBottom, h, segs), col, pos, rot);
  }

  /** 从 a 到 b 的一根细杆（方截面），画腿、横档用 */
  rod(a: [number, number, number], b: [number, number, number], t: number, col: number, segs = 4) {
    const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
    const len = va.distanceTo(vb);
    const g = new THREE.CylinderGeometry(t, t, len, segs);
    const dir = vb.clone().sub(va).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const e = new THREE.Euler().setFromQuaternion(q);
    const mid = va.add(vb).multiplyScalar(0.5);
    return this.add(g, col, [mid.x, mid.y, mid.z], [e.x, e.y, e.z]);
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.list, false);
    if (!g) throw new Error('props: mergeGeometries failed');
    for (const x of this.list) x.dispose();
    this.list = [];
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/** 物件的主材质：顶点色 + 平直着色。同一种「表面」共用一个材质 */
export function bodyMaterial(roughness = 0.78, metalness = 0.04) {
  return new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness, metalness });
}

/** 普通网格：投影、接收阴影 */
export function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string) {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// ── 幽光外壳 ──────────────────────────────────────────────────────────
/**
 * 每个物件一份外壳材质：背面、加法混合、沿法线鼓出 thickness 米。
 * 外壳只在物体轮廓外一圈露出来（物体本身挡住了中间），朝向镜头越正的地方越亮、轮廓外缘渐隐，像一圈软光。
 */
export function createGlow() {
  const amount = uniform(0);
  const thickness = uniform(0.022);
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  material.positionNode = positionLocal.add(normalLocal.mul(thickness));
  // 正交相机：视线就是观察空间的 z，|n.z| 越大越靠近物体轮廓内侧 → 越亮；外缘 → 0
  const facing = abs(normalViewGeometry.z);
  material.colorNode = color(PALETTE.possess).mul(amount).mul(facing.mul(0.75).add(0.25));
  return { material, amount, thickness };
}
export type Glow = ReturnType<typeof createGlow>;

/** 由部件几何体生成外壳几何体：去掉颜色、焊接重合顶点、重算平滑法线（鼓出时才不会裂开） */
export function shellGeometry(src: THREE.BufferGeometry) {
  // 带索引的几何体（BoxGeometry 等）先展开，只拷 position 会丢掉索引、三角形全乱
  const flat = src.index ? src.toNonIndexed() : src;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', flat.attributes.position.clone());
  if (flat !== src) flat.dispose();
  const merged = mergeVertices(g, 1e-4);
  g.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** 给网格挂一层外壳（作为子物体，跟着网格一起动）。geometry 不给就用网格自己的 */
export function attachShell(parent: THREE.Object3D, glow: Glow, geometry: THREE.BufferGeometry) {
  const s = new THREE.Mesh(shellGeometry(geometry), glow.material);
  s.name = 'glow-shell';
  s.castShadow = false;
  s.receiveShadow = false;
  s.renderOrder = 2;
  parent.add(s);
  return s;
}

// ── 拾取盒 ────────────────────────────────────────────────────────────
const hitMaterial = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
/**
 * 不可见的碰撞盒（局部坐标）。r186 的 Raycaster 只看 layers、不看 visible（见 Raycaster.js 的 intersect()），
 * 所以 visible = false 照样能被射线打中，又不进渲染和阴影 pass；材质仍然给一个不写颜色 / 深度的，以防有人把它设回可见。
 */
export function hitBox(id: string, size: [number, number, number], center: [number, number, number]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(...size), hitMaterial);
  m.position.set(...center);
  m.visible = false;
  m.name = `hit:${id}`;
  m.userData.propId = id;
  return m;
}

// ── 每个物件的统一形状 ──────────────────────────────────────────────────
export interface PropFrame {
  dt: number;
  /** 真实时间（秒） */
  time: number;
  obj: ScareObjectState;
  state: WorldState;
}

export interface PropRig {
  /** 模型根（局部坐标：正面朝 +z，原点在 propCenter 的地面上） */
  model: THREE.Object3D;
  /** 拾取盒（局部坐标） */
  hit: { size: [number, number, number]; center: [number, number, number] };
  /** 需要幽光外壳的部件：外壳挂在 parent 下，用 geometry 生成 */
  shells: { parent: THREE.Object3D; geometry: THREE.BufferGeometry }[];
  /** trigger 事件：开始被附身的表演（时间从 0 开始，由 update 的 dt 推进） */
  trigger(state: WorldState): void;
  /** reset 事件：从「被破坏」复原 */
  reset(): void;
  update(f: PropFrame): void;
  setQuality?(q: Quality): void;
  dispose?(): void;
}
