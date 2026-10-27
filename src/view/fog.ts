// 地面薄雾：贴着地板、齐膝高的一层冷灰色薄雾，慢慢飘，墙根墙角和屋外更浓；手电、台灯照到的地方雾会亮起来。
//
// 做法：只画一层。一张覆盖房子 + 屋外一圈的水平网格放在雾顶（FOG.top，低于降低后的墙顶 0.5 米），不受光照。
// 片元里读场景深度，算出视线从雾顶进来、到碰上地板 / 墙面 / 家具 / 人为止在雾里走了多远，
// 按「密度随高度指数衰减」解析积分出不透明度。这样：
// - 墙脚、家具脚、人的腿和雾的交界连续地变淡，没有横切的硬边（几张叠起来的雾片会像卡片插在墙里）；
// - 雾顶低于所有墙顶，墙顶永远露在雾上面，平面图看得清；深度跟着镜头走，四个方向一样。
// 性能（场景是填充率瓶颈：约 14 盏灯，每个像素都要算一遍）：
// - 噪声、密度、光照全在顶点着色器里算（high 0.15 米一格，约 3 万个顶点），片元只读一次深度、做几次乘加；
// - 光不走 three 的灯光系统：每帧从场景里读出最多 4 支手电（每支两层光锥）和 4 盏点光（台灯、门廊灯、镜子的闪光），
//   当 uniform 传进来，在顶点上按 three 同样的衰减公式算散射；
// - 手电在雾里不能穿墙：每支手电每帧在格子地图上打 8 条射线，量出光锥里每个方向离最近的墙多远，顶点按这个截断。
import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraFar, cameraNear, clamp, dot, exp, float, length, max, min, mx_noise_float,
  orthographicDepthToViewZ, positionLocal, positionView, smoothstep, sqrt, uniform, varying, vec3,
  viewportDepthTexture,
} from 'three/tsl';
import {
  CELL, FRONT_DOOR, GRID_H, GRID_W, HOUSE_D, HOUSE_W, Tile, WALL_CUT_H, WALL_T, buildTiles, idx,
} from '../config/house';
import type { CameraRig, FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { PALETTE } from './palette';

/** 雾的全部参数（导出给 dev/fog.ts 看；正式代码不要在运行时改它） */
export const FOG = {
  /** 雾顶（网格所在高度）：比降低后的墙顶低，墙顶的剖面线永远露在雾上 */
  top: Math.min(0.42, WALL_CUT_H - 0.08),
  /** 密度随高度按 exp(−y / h) 变淡，h 的基准（米）；噪声让它在 0.65–1.25 倍之间起伏，雾面高低不平 */
  scaleH: 0.11,
  /** 室内的基础消光系数（每米）。俯视 35° 时，空地上一眼看下去的不透明度约 1 − exp(−density · h / sin35°) */
  density: 3.0,
  /** 墙根、墙角额外的堆积（按附近墙格的覆盖率） */
  wallPool: 1.3,
  /** 前门里面：屋外的雾从门口漫进来一点（半径，米） */
  doorSeep: { amount: 0.9, radius: 1.8 },
  /** 屋外比屋里浓多少倍（离外墙多远开始变淡、多远完全没有，见 layout） */
  outside: 1.45,
  /** 再浓也不超过这个不透明度：地板和物件永远看得见 */
  maxAlpha: 0.66,
  /**
   * 两层噪声（low 档只用第一层）：freq 每米几个起伏，wind 漂移速度（米/秒），evolve 自身翻滚的速度，
   * stretch 顺着风向拉长的倍数。第二层更细、顺风拉成一缕一缕，往另一个方向飘
   */
  noise: [
    { freq: 0.42, wind: [0.07, 0.025], evolve: 0.045, stretch: 1, weight: 0.64 },
    { freq: 1.1, wind: [-0.035, 0.065], evolve: 0.07, stretch: 2.1, weight: 0.36 },
  ],
  /** 没有灯照时雾的颜色（线性）：月光下的冷灰，比地板的暗部稍亮一点，才看得出是雾 */
  ambient: new THREE.Color(PALETTE.moonSky).lerp(new THREE.Color(PALETTE.tile), 0.5).multiplyScalar(0.185),
  /** 光在雾里的散射强度：手电光斑里的雾要比被照亮的地板还亮一点，才看得出「光照在雾上」 */
  scatter: 0.04,
  /**
   * 手电的亮芯在雾里放宽成一团柔光：真实的亮芯只有 ±12°，离手 1 米处才 0.4 米宽，顶点采不出来，
   * 光斑边缘会变成锯齿。放宽 widen 倍、亮度乘 gain，总光量差不多
   */
  core: { widen: 1.8, gain: 0.5 },
  /** 外圈在雾里也略放宽一点：光锥边缘再软一些，顶点插值不出台阶 */
  haloWiden: 1.12,
  /**
   * 离手近的那一段：光锥贴地的近端边缘在 0.7 米左右，角度变得极快、又极亮，顶点采样会把它采成锯齿。
   * 距离衰减按至少 dist 米算，雾里的光从水平距离 fade[0] 到 fade[1] 米慢慢淡入
   */
  torchNear: { dist: 0.9, fade: [0.5, 1.8] },
  /** 点光（台灯、门廊灯）在雾里的额外增益：它们比手电弱一个数量级，不加的话雾里几乎看不出 */
  pointGain: 2.5,
  /** 前向散射（Henyey–Greenstein 的 g）：顺着光看过去更亮 */
  phaseG: 0.3,
  /** 雾里的光按这个高度取样（指数分布的雾，平均高度约等于 scaleH） */
  sampleY: 0.1,
  /**
   * 每档的网格：顶点间距（米）；屋外的雾离外墙 fade[0] 米开始变淡、fade[1] 米完全没有（屋外地面那圈 7.5 米左右融进黑夜）。
   * low 档在纯 CPU 软件渲染下，开销主要是雾盖住的像素数和三角形数：网格放粗、屋外收窄
   */
  layout: {
    high: { step: 0.15, fade: [2.0, 6.2] },
    low: { step: 0.4, fade: [1.0, 3.6] },
  } as Record<Quality, { step: number; fade: [number, number] }>,
  /** 手电：在格子地图上量墙用的射线数（光锥里均匀铺开） */
  fanRays: 8,
};

const TORCHES = 4;
const POINTS = 4;
/** 墙体之外、墙格之内的那一条：外墙的墙面在房子外沿往里这么多 */
const M = (CELL - WALL_T) / 2;

/** 前门门洞中点的 x（屋外的雾从这里漫进门厅） */
const DOOR_X = (Math.min(...FRONT_DOOR.cells.map(([i]) => i)) + 1) * CELL;

const isWallish = (t: number) => t === Tile.Wall || t === Tile.Window;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// ───────────────────────── 静态密度（CPU 上算一次，存进顶点属性） ─────────────────────────

function staticDensity(x: number, z: number, tiles: Uint8Array, fade: readonly [number, number]): number {
  // 墙根堆积：半径 R 内墙格的加权覆盖率。空地 0，直墙根约 0.4，墙角约 0.6
  const R = 1.25;
  let cov = 0, tot = 0;
  const i0 = Math.floor((x - R) / CELL), i1 = Math.floor((x + R) / CELL);
  const j0 = Math.floor((z - R) / CELL), j1 = Math.floor((z + R) / CELL);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const ex = (i + 0.5) * CELL - x, ez = (j + 0.5) * CELL - z;
      const d = Math.sqrt(ex * ex + ez * ez);
      if (d > R) continue;
      const w = (1 - d / R) ** 2;
      tot += w;
      if (i >= 0 && j >= 0 && i < GRID_W && j < GRID_H && isWallish(tiles[idx(i, j)])) cov += w;
    }
  }
  const pool = smooth(0.06, 0.55, tot > 0 ? cov / tot : 0);
  // 屋里屋外以外墙的墙面为界（不是房子外沿：外沿和墙面之间那 0.15 米是屋外的墙基）
  const inside = x > M && x < HOUSE_W - M && z > M && z < HOUSE_D - M;
  if (inside) {
    const seep = Math.max(0, 1 - Math.hypot(x - DOOR_X, z - (HOUSE_D - M)) / FOG.doorSeep.radius);
    return 1 + FOG.wallPool * pool + FOG.doorSeep.amount * seep * seep;
  }
  const dx = Math.max(0, -x, x - HOUSE_W), dz = Math.max(0, -z, z - HOUSE_D);
  const out = Math.hypot(dx, dz);
  return FOG.outside * (1 + 0.4 * pool) * (1 - smooth(fade[0], fade[1], out));
}

/** 雾顶的网格：位置在房屋坐标，y = FOG.top；dens 是静态密度。四角都没有雾的格子不画 */
function buildGrid(q: Quality, tiles: Uint8Array): THREE.BufferGeometry {
  const { step, fade } = FOG.layout[q];
  const reach = fade[1] + step;
  const x0 = -reach, x1 = HOUSE_W + reach, z0 = -reach, z1 = HOUSE_D + reach;
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const dens = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
      pos.set([x, FOG.top, z], k * 3);
      dens[k] = staticDensity(x, z, tiles, fade);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, b = a + 1, c = a + nx + 1, d = c + 1;
      if (dens[a] + dens[b] + dens[c] + dens[d] <= 0) continue;
      // 从上往下看逆时针：法线朝 +y
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('dens', new THREE.BufferAttribute(dens, 1));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}

// ───────────────────────── 着色器 ─────────────────────────

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

const v3u = () => uniform(new THREE.Vector3());
const v4u = () => uniform(new THREE.Vector4());
const colU = () => uniform(new THREE.Color(0, 0, 0));

function makeUniforms() {
  return {
    time: uniform(0),
    /** 相机视线方向（房屋坐标，单位向量，y < 0）和它的俯角正弦 */
    fwd: uniform(new THREE.Vector3(0, -0.57, -0.82)),
    sinE: uniform(0.57),
    ambient: uniform(FOG.ambient.clone()),
    scatter: uniform(FOG.scatter),
    torches: Array.from({ length: TORCHES }, () => ({
      pos: v3u(),
      dir: uniform(new THREE.Vector3(1, 0, 0)),
      /** 外圈 / 亮芯：颜色 × 强度 */
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
    points: Array.from({ length: POINTS }, () => ({
      pos: v3u(),
      col: colU(),
      /** 截止距离、衰减指数 */
      range: uniform(new THREE.Vector2(1, 2)),
    })),
  };
}
type Uniforms = ReturnType<typeof makeUniforms>;

/** three 的距离衰减（LightUtils.getDistanceAttenuation）：1 / d^decay，再在截止距离处平滑归零 */
const distanceAtt = (d: F, cutoff: F, decay: F) => {
  const q = d.div(cutoff);
  const q2 = q.mul(q);
  const w = clamp(float(1).sub(q2.mul(q2)), 0, 1);
  return d.pow(decay).max(0.01).reciprocal().mul(w.mul(w));
};

/** Henyey–Greenstein 相函数（去掉 1/4π，各向同性时为 1）：c = 光的前进方向和「指向镜头」的夹角余弦 */
const phase = (c: F) => {
  const g = FOG.phaseG;
  const x = float(1 + g * g).sub(c.mul(2 * g));
  return float(1 - g * g).div(x.mul(sqrt(x)));
};

/** 手电射线扇面：点 q 在水平面上落在哪两条射线之间，按离墙距离截断（墙后 0.05–0.35 米内淡到 0） */
function fanVisibility(t: Uniforms['torches'][number], q: V3): F {
  const hx = q.x.sub(t.pos.x), hz = q.z.sub(t.pos.z);
  const r = sqrt(hx.mul(hx).add(hz.mul(hz)));
  const along = hx.mul(t.fan.x).add(hz.mul(t.fan.y));
  const across = hz.mul(t.fan.x).sub(hx.mul(t.fan.y));
  const n = FOG.fanRays - 1;
  const f = clamp(across.div(max(along, 0.02)).mul(t.fan.z).mul(0.5).add(0.5), 0, 1).mul(n);
  const walls = [t.wallA.x, t.wallA.y, t.wallA.z, t.wallA.w, t.wallB.x, t.wallB.y, t.wallB.z, t.wallB.w];
  let vis: F = float(0);
  walls.forEach((d, k) => {
    const w = max(float(1).sub(abs(f.sub(k))), 0);
    vis = vis.add(w.mul(float(1).sub(smoothstep(d.add(0.05), d.add(0.35), r))));
  });
  return vis;
}

function fogMaterial(u: Uniforms, octaves: number) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  // 不受光照：不让它跟着场景灯的数量重新编译
  mat.lights = false;

  // —— 顶点：噪声、密度、雾里的光 ——
  const P = positionLocal;
  // 视线从雾顶往下走到 sampleY 高度的那一点：雾主要在这附近，噪声和光都在这里取样，旋转镜头时雾不会相对地板滑动
  const S = P.add(u.fwd.mul(float(FOG.top - FOG.sampleY).div(u.sinE)));
  const Q = P.add(S).mul(0.5);
  const t = u.time;
  let fbm: F = float(0);
  let wsum = 0;
  let detail: F = float(0);
  FOG.noise.slice(0, octaves).forEach((o, k) => {
    // 换到风向坐标系：顺风方向频率除以 stretch、横向乘以 √stretch（拉成一缕一缕），再顺风平移
    const speed = Math.hypot(o.wind[0], o.wind[1]);
    const wx = o.wind[0] / speed, wz = o.wind[1] / speed;
    const down = S.x.mul(wx).add(S.z.mul(wz)).sub(t.mul(speed));
    const side = S.z.mul(wx).sub(S.x.mul(wz));
    const n = mx_noise_float(vec3(
      down.mul(o.freq / o.stretch),
      side.mul(o.freq * Math.sqrt(o.stretch)),
      t.mul(o.evolve).add(k * 17.3),
    ));
    fbm = fbm.add(n.mul(o.weight));
    wsum += o.weight;
    if (k === octaves - 1) detail = n;
  });
  fbm = fbm.div(wsum);
  // 成片：大部分地方是很薄的一层，噪声高的地方聚成一团团
  const patch = smoothstep(-0.35, 0.7, fbm);
  const rho = attribute('dens', 'float').mul(FOG.density).mul(patch.mul(patch).mul(1.15).add(0.22));
  // 浓的地方也更高，雾面起伏
  const hs = float(FOG.scaleH).mul(patch.mul(0.4).add(0.75).add(detail.mul(0.12)));

  const toCam = u.fwd.negate();
  let light: V3 = vec3(0, 0, 0);
  for (const tc of u.torches) {
    const v = S.sub(tc.pos);
    const d = max(length(v), FOG.torchNear.dist);
    const near = smoothstep(FOG.torchNear.fade[0], FOG.torchNear.fade[1], sqrt(v.x.mul(v.x).add(v.z.mul(v.z))));
    const L = v.div(length(v).max(0.01));
    const c = dot(L, tc.dir);
    const a = smoothstep(tc.coneA.x, tc.coneA.y, c).mul(distanceAtt(d, tc.coneA.z, tc.coneA.w));
    const b = smoothstep(tc.coneB.x, tc.coneB.y, c).mul(distanceAtt(d, tc.coneB.z, tc.coneB.w));
    // 挡墙按入射点和取样点的中点量：只按取样点量的话，雾贴着这一侧墙面时取样点会越过墙，被墙那边的手电照亮
    const vis = fanVisibility(tc, Q).mul(near);
    light = light.add(tc.colA.mul(a).add(tc.colB.mul(b)).mul(phase(dot(L, toCam))).mul(vis));
  }
  for (const pl of u.points) {
    const v = S.sub(pl.pos);
    const d = max(length(v), 0.25);
    light = light.add(pl.col.mul(distanceAtt(d, pl.range.x, pl.range.y)).mul(phase(dot(v.div(d), toCam))).mul(FOG.pointGain));
  }
  const vRho = varying(rho, 'vFogRho');
  const vHs = varying(hs, 'vFogH');
  const vLight = varying(min(light.mul(u.scatter), vec3(8, 8, 8)), 'vFogLight');

  // —— 片元：视线在雾里走过的那一段，解析积分 ——
  const sceneZ = orthographicDepthToViewZ(viewportDepthTexture().x, cameraNear, cameraFar);
  const along = max(positionView.z.sub(sceneZ), 0); // 正交相机：深度差就是沿视线的距离
  const yEnd = max(float(FOG.top).sub(along.mul(u.sinE)), 0); // 视线碰到东西（或地面）时的高度
  const tau = vRho.mul(vHs).div(u.sinE).mul(exp(yEnd.div(vHs).negate()).sub(exp(float(FOG.top).div(vHs).negate())));
  mat.colorNode = vLight.add(u.ambient);
  mat.opacityNode = min(float(1).sub(exp(tau.negate())), FOG.maxAlpha);
  return mat;
}

// ───────────────────────── 从场景里读灯 ─────────────────────────

/** 手电射线：从 (x, z) 沿 a 方向在格子地图上走，碰到墙 / 窗格的水平距离。格子外面（屋外）不挡，接着走 */
function wallDistance(tiles: Uint8Array, x: number, z: number, a: number, maxD: number) {
  const dx = Math.cos(a), dz = Math.sin(a);
  const step = CELL / 5;
  for (let d = step; d < maxD; d += step) {
    const i = Math.floor((x + dx * d) / CELL), j = Math.floor((z + dz * d) / CELL);
    if (i < 0 || j < 0 || i >= GRID_W || j >= GRID_H) continue;
    if (isWallish(tiles[idx(i, j)])) return d;
  }
  return maxD;
}

const visibleInScene = (o: THREE.Object3D) => {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

// ───────────────────────── 组装 ─────────────────────────

// 镜头方向不从 rig 取，而是在 onBeforeRender 里直接用这一次渲染的相机（开场下降、旋转过渡中都对得上）
export function createFogView(core: RenderCore, _rig: CameraRig): Module {
  const search = new URLSearchParams(location.search);
  const tiles = buildTiles();
  const u = makeUniforms();
  const root = new THREE.Group();
  root.name = 'fog';
  core.houseRoot.add(root);

  const meshes: Record<Quality, THREE.Mesh> = {
    high: new THREE.Mesh(buildGrid('high', tiles), fogMaterial(u, 2)),
    low: new THREE.Mesh(buildGrid('low', tiles), fogMaterial(u, 1)),
  };
  for (const [q, m] of Object.entries(meshes)) {
    m.name = `ground-fog-${q}`;
    // 在月光光斑（1）之后、幽光外壳和手电光锥（2）之前：幽光和光锥是加法混合，画在雾上面不会被雾盖住
    m.renderOrder = 1.5;
    m.castShadow = false;
    m.receiveShadow = false;
    root.add(m);
  }

  let quality: Quality = core.quality;
  let enabled = !search.has('nofog');
  // 两档的材质都先留着可见，让开场预编译（compileAsync）一起编好；第一次 update 时再按画质藏起一个，切档时不卡
  let primed = false;
  const applyVisibility = () => {
    meshes.high.visible = enabled && quality === 'high';
    meshes.low.visible = enabled && quality === 'low';
  };
  if (!enabled) applyVisibility();

  // —— 灯：几秒重新扫一次场景（手电是对象池，不增删；扫描只是兜底），每帧读位置、方向、强度 ——
  type Torch = { lights: THREE.SpotLight[] };
  let torches: Torch[] = [];
  let points: THREE.PointLight[] = [];
  let scanIn = 0;
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
  const strength = (l: THREE.Light) => (visibleInScene(l) ? l.intensity : 0);
  const coneOf = (l: THREE.SpotLight, out: THREE.Vector4) =>
    out.set(Math.cos(l.angle), Math.cos(l.angle * (1 - l.penumbra)), l.distance > 0 ? l.distance : 1e4, l.decay);

  const setTorch = (slot: Uniforms['torches'][number], t: Torch | undefined) => {
    const a = t?.lights[0], b = t?.lights[1];
    const ia = a ? strength(a) : 0, ib = b ? strength(b) : 0;
    slot.colA.value.copy(a ? tmp.copy(a.color).multiplyScalar(ia) : tmp.setRGB(0, 0, 0));
    slot.colB.value.copy(b ? tmp.copy(b.color).multiplyScalar(ib) : tmp.setRGB(0, 0, 0));
    if (!a || ia + ib <= 0) return;
    a.getWorldPosition(wp).applyMatrix4(inv);
    a.target.getWorldPosition(wt).applyMatrix4(inv);
    slot.pos.value.copy(wp);
    const dir = slot.dir.value.subVectors(wt, wp).normalize();
    coneOf(a, slot.coneA.value);
    slot.coneA.value.x = Math.cos(Math.min(a.angle * FOG.haloWiden, 1.5));
    if (b) {
      // 亮芯放宽成从光轴到放宽后边缘的一整段柔和过渡（见 FOG.core）
      const w = Math.min(a.angle, b.angle * FOG.core.widen);
      slot.coneB.value.set(Math.cos(w), 1, b.distance > 0 ? b.distance : 1e4, b.decay);
      slot.colB.value.multiplyScalar(FOG.core.gain);
    }
    // 射线扇面：光锥的水平张角（光轴越往下压，地上的光斑越宽），夹在 80° 以内
    const h = Math.hypot(dir.x, dir.z);
    const axis = h > 1e-4 ? Math.atan2(dir.z, dir.x) : 0;
    const spread = Math.min(1.4, Math.atan(Math.tan(a.angle) / Math.max(h, 0.25)) * 1.1);
    const tanS = Math.tan(spread);
    slot.fan.value.set(Math.cos(axis), Math.sin(axis), 1 / tanS, 0);
    const maxD = a.distance > 0 ? a.distance : 12;
    const n = FOG.fanRays - 1;
    for (let k = 0; k <= n; k++) {
      const d = wallDistance(tiles, wp.x, wp.z, axis + Math.atan(((2 * k) / n - 1) * tanS), maxD);
      (k < 4 ? slot.wallA.value : slot.wallB.value).setComponent(k % 4, d);
    }
  };

  const setPoint = (slot: Uniforms['points'][number], l: THREE.PointLight | undefined) => {
    const i = l ? strength(l) : 0;
    if (!l || i <= 0) { slot.col.value.setRGB(0, 0, 0); return; }
    slot.col.value.copy(l.color).multiplyScalar(i);
    l.getWorldPosition(wp).applyMatrix4(inv);
    slot.pos.value.copy(wp);
    slot.range.value.set(l.distance > 0 ? l.distance : 1e4, l.decay);
  };

  const fwd = new THREE.Vector3();
  // 在真正画雾之前读：这时矩阵已经按这一帧更新过（访客模块的 update 在雾之后跑，在 update 里读会慢一帧）
  meshes.high.onBeforeRender = meshes.low.onBeforeRender = (_r, _s, camera) => {
    if (scanIn <= 0) { scan(); scanIn = 2; }
    inv.copy(core.houseRoot.matrixWorld).invert();
    camera.getWorldDirection(fwd).transformDirection(inv);
    u.fwd.value.copy(fwd);
    u.sinE.value = Math.max(0.2, -fwd.y);
    const ts = torches.length > TORCHES
      ? [...torches].sort((x, y) => y.lights.reduce((s, l) => s + strength(l), 0) - x.lights.reduce((s, l) => s + strength(l), 0))
      : torches;
    u.torches.forEach((slot, k) => setTorch(slot, ts[k]));
    const ps = points.length > POINTS ? [...points].sort((x, y) => strength(y) - strength(x)) : points;
    u.points.forEach((slot, k) => setPoint(slot, ps[k]));
  };

  if (search.has('debug')) {
    (window as unknown as { __fog: unknown }).__fog = {
      get enabled() { return enabled; },
      set enabled(v: boolean) { enabled = v; applyVisibility(); },
      uniforms: u,
    };
  }

  return {
    update(ctx: FrameCtx) {
      if (!primed) { primed = true; applyVisibility(); }
      u.time.value = ctx.time;
      scanIn -= ctx.dt;
    },
    setQuality(q) {
      quality = q;
      if (primed) applyVisibility();
    },
    dispose() {
      core.houseRoot.remove(root);
      for (const m of Object.values(meshes)) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    },
  };
}
