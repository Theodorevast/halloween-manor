// 粒子共用的灯光：每帧从场景里读出手电（每支两层光锥）和点光（台灯、门廊灯），写进 uniform；
// 着色器里按和 fog.ts 一样的办法算某一点受到多少光——three 的光锥 smoothstep、距离衰减公式，
// 手电在格子地图上打一扇射线量出离墙多远，墙后面的点不亮（墙降低了也不亮：全高的只投影副本挡着光）。
// 不走 three 的灯光系统：粒子材质不受光照（lights = false），灯的数量变了也不用重新编译。
//
// 和 fog.ts 的不同：雾的光是在 0.15 米一格的网格顶点上采样的，所以把光锥放宽、把近处压平；
// 粒子是一个个点，直接用手电真实的光锥角度。
import * as THREE from 'three/webgpu';
import { abs, clamp, dot, float, length, max, mix, normalize, smoothstep, sqrt, uniform, vec3 } from 'three/tsl';
import { CELL, GRID_H, GRID_W, blocksSight, buildTiles, idx, type Tile } from '../../config/house';
import type { RenderCore } from '../../engine/types';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** 同时算几支手电、几盏点光（和 fog.ts 一样：屋里最多 4 个访客，台灯 + 门廊灯 + 镜子闪光） */
export const TORCH_SLOTS = 4;
export const POINT_SLOTS = 4;

export const LIGHT = {
  /** 手电光锥里铺开几条射线量墙 */
  fanRays: 8,
  /** 离手电这么近（米）以内按这个距离算衰减：贴着镜片的粒子不至于亮成一个白点 */
  nearDist: 0.55,
  /** 离手电水平距离在这两个值（米）之间慢慢亮起来（镜片正前方那一小段不亮） */
  nearFade: [0.08, 0.45] as [number, number],
  /** 射线碰到墙格之后再走多远淡到 0（米）：墙体在 0.5 米的墙格里居中、0.2 米厚，0.35 正好过了墙的背面 */
  wallFade: [0.05, 0.35] as [number, number],
  /** 溢光的距离软化（米²）：溢光 ∝ 1 / (spillSoft + d²) */
  spillSoft: 1,
  /** 点光离得太近时按这个距离算（米） */
  pointNear: 0.3,
  /** 几秒重新扫一次场景（手电是对象池、不增删，扫描只是兜底） */
  rescan: 2,
};

const v3u = () => uniform(new THREE.Vector3());
const v4u = () => uniform(new THREE.Vector4());
const colU = () => uniform(new THREE.Color(0, 0, 0));

export function makeLightUniforms() {
  return {
    torches: Array.from({ length: TORCH_SLOTS }, () => ({
      pos: v3u(),
      dir: uniform(new THREE.Vector3(1, 0, 0)),
      /** 外圈 / 亮芯：颜色 × 强度（灯灭时为 0） */
      colA: colU(),
      colB: colU(),
      /** cos(外沿), cos(内沿), 截止距离, 衰减指数 */
      coneA: uniform(new THREE.Vector4(1, 1, 1, 2)),
      coneB: uniform(new THREE.Vector4(1, 1, 1, 2)),
      /** 光锥水平中轴 (x, z)、1 / tan(射线铺开的半角) */
      fan: uniform(new THREE.Vector4(1, 0, 1, 0)),
      /** 8 条射线各自离墙的水平距离（米） */
      wallA: v4u(),
      wallB: v4u(),
    })),
    points: Array.from({ length: POINT_SLOTS }, () => ({
      pos: v3u(),
      col: colU(),
      /** 截止距离、衰减指数 */
      range: uniform(new THREE.Vector2(1, 2)),
    })),
    /** 视线反方向（房屋坐标，单位向量，指向镜头）：正交相机的前向散射用 */
    toCam: uniform(new THREE.Vector3(0.57, 0.57, 0.57)),
    /** 镜头位置（房屋坐标）：透视相机的视线从这里发散，每颗粒子自己算指向镜头的方向 */
    camPos: uniform(new THREE.Vector3(0, 20, 0)),
    /** 1 = 透视相机，0 = 正交相机 */
    persp: uniform(0),
  };
}
export type LightUniforms = ReturnType<typeof makeLightUniforms>;

// ───────────────────────── 着色器 ─────────────────────────

/** three 的距离衰减（LightUtils.getDistanceAttenuation）：1 / d^decay，再在截止距离处平滑归零 */
const distanceAtt = (d: F, cutoff: F, decay: F) => {
  const q = d.div(cutoff);
  const q2 = q.mul(q);
  const w = clamp(float(1).sub(q2.mul(q2)), 0, 1);
  return d.pow(decay).max(0.01).reciprocal().mul(w.mul(w));
};

/** Henyey–Greenstein 相函数（去掉 1/4π，各向同性时为 1）：c = 光的前进方向和「指向镜头」的夹角余弦 */
const phase = (c: F, g: number) => {
  const x = float(1 + g * g).sub(c.mul(2 * g));
  return float(1 - g * g).div(x.mul(sqrt(x)));
};

/** 手电射线扇面：点 q 在水平面上落在哪两条射线之间，按那两条射线离墙的距离截断（和 fog.ts 同一套算法） */
function fanVisibility(t: LightUniforms['torches'][number], q: V3): F {
  const hx = q.x.sub(t.pos.x), hz = q.z.sub(t.pos.z);
  const r = sqrt(hx.mul(hx).add(hz.mul(hz)));
  const along = hx.mul(t.fan.x).add(hz.mul(t.fan.y));
  const across = hz.mul(t.fan.x).sub(hx.mul(t.fan.y));
  const n = LIGHT.fanRays - 1;
  const f = clamp(across.div(max(along, 0.02)).mul(t.fan.z).mul(0.5).add(0.5), 0, 1).mul(n);
  const walls = [t.wallA.x, t.wallA.y, t.wallA.z, t.wallA.w, t.wallB.x, t.wallB.y, t.wallB.z, t.wallB.w];
  let vis: F = float(0);
  walls.forEach((d, k) => {
    const w = max(float(1).sub(abs(f.sub(k))), 0);
    vis = vis.add(w.mul(float(1).sub(smoothstep(d.add(LIGHT.wallFade[0]), d.add(LIGHT.wallFade[1]), r))));
  });
  return vis;
}

export interface LightOpts {
  /** 前向散射的 g（0 = 各向同性）。浮尘明显前向散射：顺着光看过去更亮 */
  phaseG?: number;
  /**
   * 光锥外的溢光（手电打在身前地上反弹回来的光），按 colA × spill / (LIGHT.spillSoft + d²) 加：
   * 呼出的白气就在手电旁边、却在光锥上方，只靠光锥的话一团黑。分母里的常数够大，贴着镜片也不会亮成一个白点
   * （溢光是地上反弹的漫射光，不是镜片直射）。0 = 不加
   */
  spill?: number;
  /** 是否加点光（台灯、门廊灯） */
  points?: boolean;
}

/** p 点（房屋坐标）受到的光（线性颜色 × 强度，和 three 的辐照度同一量纲） */
export function lightAt(u: LightUniforms, p: V3, o: LightOpts = {}): V3 {
  let light: V3 = vec3(0, 0, 0);
  const toCam = o.phaseG ? normalize(mix(u.toCam, u.camPos.sub(p), u.persp)) : null;
  for (const t of u.torches) {
    const v = p.sub(t.pos);
    const dist = length(v);
    const d = max(dist, LIGHT.nearDist);
    const L = v.div(max(dist, 1e-3));
    const c = dot(L, t.dir);
    const a = smoothstep(t.coneA.x, t.coneA.y, c).mul(distanceAtt(d, t.coneA.z, t.coneA.w));
    const b = smoothstep(t.coneB.x, t.coneB.y, c).mul(distanceAtt(d, t.coneB.z, t.coneB.w));
    const near = smoothstep(LIGHT.nearFade[0], LIGHT.nearFade[1], sqrt(v.x.mul(v.x).add(v.z.mul(v.z))));
    let beam: V3 = t.colA.mul(a).add(t.colB.mul(b)).mul(near);
    if (o.phaseG && toCam) beam = beam.mul(phase(dot(L, toCam), o.phaseG));
    if (o.spill) beam = beam.add(t.colA.mul(float(o.spill).div(dist.mul(dist).add(LIGHT.spillSoft))));
    light = light.add(beam.mul(fanVisibility(t, p)));
  }
  if (o.points) {
    for (const pl of u.points) {
      const d = max(length(p.sub(pl.pos)), LIGHT.pointNear);
      light = light.add(pl.col.mul(distanceAtt(d, pl.range.x, pl.range.y)));
    }
  }
  return light;
}

// ───────────────────────── CPU：从场景里读灯 ─────────────────────────

/** 手电射线：从 (x, z) 沿 a 方向在格子地图上走，碰到墙 / 窗格的水平距离。格子外面（屋外）不挡，接着走 */
function wallDistance(tiles: Uint8Array, x: number, z: number, a: number, maxD: number) {
  const dx = Math.cos(a), dz = Math.sin(a);
  const step = CELL / 5;
  for (let d = step; d < maxD; d += step) {
    const i = Math.floor((x + dx * d) / CELL), j = Math.floor((z + dz * d) / CELL);
    if (i < 0 || j < 0 || i >= GRID_W || j >= GRID_H) continue;
    if (blocksSight(tiles[idx(i, j)] as Tile)) return d;
  }
  return maxD;
}

const visibleInScene = (o: THREE.Object3D) => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

export interface LightReader {
  readonly uniforms: LightUniforms;
  /** 此刻有几支亮着的手电（0 时浮尘整个不画） */
  readonly activeTorches: number;
  /** 每帧在访客模块 update 之后调（手电位置已经是这一帧的） */
  update(dt: number): void;
  /** 渲染前用这一次的相机更新视线方向、镜头位置 */
  setCamera(camera: THREE.Camera): void;
}

export function createLightReader(core: RenderCore): LightReader {
  const u = makeLightUniforms();
  const tiles = buildTiles();

  type Torch = { lights: THREE.SpotLight[] };
  let torches: Torch[] = [];
  let points: THREE.PointLight[] = [];
  let scanIn = 0;
  let active = 0;
  const scan = () => {
    const byTarget = new Map<THREE.Object3D, THREE.SpotLight[]>();
    const pts: THREE.PointLight[] = [];
    core.scene.traverse((o) => {
      if ((o as THREE.SpotLight).isSpotLight) {
        const s = o as THREE.SpotLight;
        const list = byTarget.get(s.target) ?? [];
        list.push(s);
        byTarget.set(s.target, list);
      } else if ((o as THREE.PointLight).isPointLight) pts.push(o as THREE.PointLight);
    });
    // 同一个照向目标的几盏聚光是同一支手电：宽的当外圈，窄的当亮芯
    torches = [...byTarget.values()].map((l) => ({ lights: l.sort((a, b) => b.angle - a.angle).slice(0, 2) }));
    points = pts;
  };

  const inv = new THREE.Matrix4();
  const wp = new THREE.Vector3();
  const wt = new THREE.Vector3();
  const tmp = new THREE.Color();
  const fwd = new THREE.Vector3();
  const strength = (l: THREE.Light) => (visibleInScene(l) ? l.intensity : 0);
  const torchStrength = (t: Torch) => t.lights.reduce((s, l) => s + strength(l), 0);
  const coneOf = (l: THREE.SpotLight, out: THREE.Vector4) =>
    out.set(Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)), l.distance > 0 ? l.distance : 1e4, l.decay);

  const setTorch = (slot: LightUniforms['torches'][number], t: Torch | undefined) => {
    const a = t?.lights[0], b = t?.lights[1];
    const ia = a ? strength(a) : 0, ib = b ? strength(b) : 0;
    slot.colA.value.copy(a ? tmp.copy(a.color).multiplyScalar(ia) : tmp.setRGB(0, 0, 0));
    slot.colB.value.copy(b ? tmp.copy(b.color).multiplyScalar(ib) : tmp.setRGB(0, 0, 0));
    if (!a || ia + ib <= 0) return false;
    a.getWorldPosition(wp).applyMatrix4(inv);
    a.target.getWorldPosition(wt).applyMatrix4(inv);
    slot.pos.value.copy(wp);
    const dir = slot.dir.value.subVectors(wt, wp).normalize();
    coneOf(a, slot.coneA.value);
    if (b) coneOf(b, slot.coneB.value);
    else slot.coneB.value.set(1, 1, 1, 2);
    // 射线扇面：光锥的水平张角（光轴越往下压，地上的光斑越宽），夹在 80° 以内
    const h = Math.hypot(dir.x, dir.z);
    const axis = h > 1e-4 ? Math.atan2(dir.z, dir.x) : 0;
    const spread = Math.min(1.4, Math.atan(Math.tan(a.angle) / Math.max(h, 0.25)) * 1.1);
    const tanS = Math.tan(spread);
    slot.fan.value.set(Math.cos(axis), Math.sin(axis), 1 / tanS, 0);
    const maxD = a.distance > 0 ? a.distance : 12;
    const n = LIGHT.fanRays - 1;
    for (let k = 0; k <= n; k++) {
      const d = wallDistance(tiles, wp.x, wp.z, axis + Math.atan(((2 * k) / n - 1) * tanS), maxD);
      (k < 4 ? slot.wallA.value : slot.wallB.value).setComponent(k % 4, d);
    }
    return true;
  };

  const setPoint = (slot: LightUniforms['points'][number], l: THREE.PointLight | undefined) => {
    const i = l ? strength(l) : 0;
    if (!l || i <= 0) { slot.col.value.setRGB(0, 0, 0); return; }
    slot.col.value.copy(l.color).multiplyScalar(i);
    l.getWorldPosition(wp).applyMatrix4(inv);
    slot.pos.value.copy(wp);
    slot.range.value.set(l.distance > 0 ? l.distance : 1e4, l.decay);
  };

  return {
    uniforms: u,
    get activeTorches() { return active; },
    update(dt) {
      scanIn -= dt;
      if (scanIn <= 0) { scan(); scanIn = LIGHT.rescan; }
      core.houseRoot.updateWorldMatrix(true, false);
      inv.copy(core.houseRoot.matrixWorld).invert();
      const ts = torches.length > TORCH_SLOTS ? [...torches].sort((x, y) => torchStrength(y) - torchStrength(x)) : torches;
      active = 0;
      u.torches.forEach((slot, k) => { if (setTorch(slot, ts[k])) active++; });
      const ps = points.length > POINT_SLOTS ? [...points].sort((x, y) => strength(y) - strength(x)) : points;
      u.points.forEach((slot, k) => setPoint(slot, ps[k]));
    },
    setCamera(camera) {
      camera.getWorldDirection(fwd).transformDirection(inv);
      u.toCam.value.copy(fwd).negate();
      u.camPos.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
      u.persp.value = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
    },
  };
}
