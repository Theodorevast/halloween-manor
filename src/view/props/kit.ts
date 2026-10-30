// 物件共用的小工具：把基础几何体拼成「一个刚体部件 = 一个网格」、幽光外壳、拾取盒、缓动。
// 每个会单独动的部件合并成一个带顶点色的几何体，整套物件只有三十来个 draw call（手电阴影每盏还要再画一遍）。
import * as THREE from 'three/webgpu';
import { abs, dot, mix, modelViewMatrix, normalLocal, normalView, positionLocal, positionView, positionViewDirection, smoothstep, uniform, vec4 } from 'three/tsl';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quality } from '../../engine/types';
import type { ScareObjectState, SimEvent, WorldState } from '../../sim/types';
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
/** 第三人称、没对准时：离镜头这么近（米）的外壳淡掉（从前一个数到后一个数由无到有），见 createGlow 的 focus */
export const GLOW_NEAR: [number, number] = [0.9, 1.8];
/** 第三人称、对准（悬停、附身那一下）时也一样淡掉，只是近得多：镜头擦着物件时，贴着镜头那一截不画成一大块（2026-10-30 eye S-5） */
export const GLOW_NEAR_FOCUS: [number, number] = [0.25, 0.6];

/**
 * 每个物件一份外壳材质：背面、加法混合、沿法线鼓出一点。外壳只在物体轮廓外一圈露出来（物体本身挡住了中间）。
 * 鼓出多少：thickness 米 + px × pxM × 这个顶点离镜头多远（米）。pxM 是离镜头 1 米处一个 CSS 像素多少米（第三人称按 ghostCamera.pxPerM 设，
 * 娃娃屋给 0）：第三人称的外壳按屏幕像素算粗细，远近一样细（2026-10-30 eye S-5：原来 1.2–2 厘米，镜头擦着厨房门时门框边上一条二十几像素宽的
 * 薄荷绿，细的台灯杆被描得和杆一样粗，看着像整块平涂）。
 * 朝向按每个片元自己的视线算（2026-10-30 美术分析 ART-5）：原来按正交相机算（|观察空间法线的 z|），第三人称的透视镜头下
 * 不对，画面偏边上的物件轮廓上会留一圈亮边。正交相机下 positionViewDirection 就是 (0, 0, 1)，和原来一模一样。
 * tint：外壳的颜色；soft：0 = 娃娃屋原来的软光（朝向 × 0.75 + 0.25，轮廓最外那一圈还留 25%），
 * 1 = 第三人称的细线：只有一两个像素宽，不再按朝向分浓淡（细到这样，按朝向淡出只会把大物件扁平的边淡没），整条一样亮。
 * focus（只在 soft 时起作用）：0 = 平时，离镜头 GLOW_NEAR 米以内的那一截不画——镜头擦着一个物件时（走廊里镜头贴着厨房门），
 * 外壳在画面边上是一条贯穿画面的亮带（美术分析的 d50 机位）；1 = 悬停、附身那一下，只有 GLOW_NEAR_FOCUS 米以内的不画。
 * 镜头整个钻进物件里时（从里面看，外壳背面铺满一片，就是那块平涂）由 props.ts 直接不画外壳
 */
export function createGlow() {
  const amount = uniform(0);
  const thickness = uniform(0.022);
  const px = uniform(0);
  const pxM = uniform(0);
  const tint = uniform(new THREE.Color(PALETTE.possess));
  const soft = uniform(0);
  const focus = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  // 这个顶点离镜头多远（观察空间的深度，米）：鼓出的米数按它换算成屏幕上的像素
  const depth = modelViewMatrix.mul(vec4(positionLocal, 1)).z.negate().max(0);
  material.positionNode = positionLocal.add(normalLocal.mul(thickness.add(px.mul(pxM).mul(depth))));
  // |n·v| 越大越靠近物体轮廓内侧 → 越亮；外缘 → 0（娃娃屋的软光）
  const facing = abs(dot(normalView, positionViewDirection));
  const dist = positionView.length();
  const near = mix(smoothstep(GLOW_NEAR[0], GLOW_NEAR[1], dist), smoothstep(GLOW_NEAR_FOCUS[0], GLOW_NEAR_FOCUS[1], dist), focus);
  material.colorNode = tint.mul(amount).mul(mix(facing.mul(0.75).add(0.25), near, soft));
  return { material, amount, thickness, px, pxM, tint, soft, focus };
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

/** 附身事件（模拟发的 trigger）：带 variant，画面和声音按它挑同一个变体 */
export type TriggerEvent = Extract<SimEvent, { type: 'trigger' }>;

export interface PropRig {
  /** 模型根（局部坐标：正面朝 +z，原点在 propCenter 的地面上） */
  model: THREE.Object3D;
  /** 拾取盒（局部坐标） */
  hit: { size: [number, number, number]; center: [number, number, number] };
  /** 需要幽光外壳的部件：外壳挂在 parent 下，用 geometry 生成 */
  shells: { parent: THREE.Object3D; geometry: THREE.BufferGeometry }[];
  /**
   * trigger 事件：开始被附身的表演（时间从 0 开始，由 update 的 dt 推进）。
   * e 是那个事件本身：有变体的物件（衣柜：要不要手指）按 e.variant 挑，别的物件用不着，实现里可以不写这个参数
   */
  trigger(state: WorldState, e: TriggerEvent): void;
  /** reset 事件：从「被破坏」复原 */
  reset(): void;
  update(f: PropFrame): void;
  setQuality?(q: Quality): void;
  dispose?(): void;
}
