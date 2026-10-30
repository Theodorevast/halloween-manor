// 访客手里的手电。做法沿用 工具 证据板的 TORCH：两盏叠在一起的聚光——
// 外圈宽而软（penumbra 1）、投影，亮芯窄、不投影，叠出「中间亮、四周柔和地暗下去」的光斑。
// 不用 light.map 画光斑：three.js 的投影路径会在光锥里多出一块方形的亮区。
// 再加一个很淡的加法混合光锥网格，假装空气里有一点灰（体积光），low 档关掉。
//
// 灯由 characters.ts 在模块创建时一次建好（对象池），之后只改参数、不增删：
// three.js 的灯数量或 castShadow 一变，场景里每个材质都要重新编译，访客进出门时会卡一下。
//
// 手电登记表（2026-10-28 手电照出鬼魂，见 torches.ts）：每支手电建的时候按模块级计数分一个槽，
// 每帧把位置、光轴、光锥、强度写进 torches[槽]（鬼魂的着色器按它算谁照着自己）；强度再乘 torchDim[槽]
// （lightfx.ts 写：现身时附近的手电跟着暗），暗下去时颜色往暖红偏（钨丝灯越暗越红）；手上那个镜片也跟着一起暗、一起偏色
import * as THREE from 'three/webgpu';
import {
  Fn, abs, color, dot, length, lightPosition, mix, mx_noise_float, normalView, normalize, positionView, positionWorld, pow, smoothstep, time,
  uniform, uv, vec3,
} from 'three/tsl';
import { CELL, GRID_H, GRID_W, blocksSight, buildTiles, type Tile } from '../config/house';
import { VISION } from '../config/visitors';
import type { Quality } from '../engine/types';
import { PALETTE } from './palette';
import { GHOST_SHADOW_LAYER, TORCH_COUNT, torchDim, torches } from './torches';

/**
 * 地址带 ?oldflicker 时两处灯闪（props/lamp.ts 的台灯、这里的紧张手电）都用旧的，看样时对比新旧；用户定了以后连这个开关和旧的一起删。
 * 载入时读一次（地址在页面生命周期里不会变）；node 里跑测试没有 location
 */
const OLD_FLICKER = typeof location !== 'undefined' && new URLSearchParams(location.search).has('oldflicker');

/**
 * 紧张时手电亮度闪烁的深度（强度最多掉这么多）：
 * - old = 0.22（旧值）：100 个种子 × 30 秒（tests/flicker.test.ts）里任意 1 秒最多暗 4–5 下（85 个种子 4 下、15 个种子 5 下），
 *   超了 WCAG 2.3.1 的每秒 3 下；叠上现身蓄力的灯闪（lightfx 写的 torchDim）还会把现身自己那 3 下叠成 4 下
 * - safe = 0.08：比 countDips 的门槛（亮度掉 0.1 才算暗一下）还小，一次「暗一下」都数不出来，叠上现身那一串也不多出一下；
 *   手在抖主要靠光束的抖动（TORCH.nervous.jitter）表现，亮度只留一点点不稳
 */
export const NERVOUS_FLICKER = { old: 0.22, safe: 0.08 };

/** 手电的全部手感参数（导出给 dev/characters.ts 调参用；正式代码不要在运行时改它） */
export const TORCH = {
  /** 外圈：比视野半角宽一点，光斑边缘正好是「看得见」的边界 */
  halo: { angle: VISION.halfAngle * 1.1, penumbra: 1, intensity: 40 },
  /**
   * 亮芯：窄，偏白，不投影。不投影就会穿墙：每帧沿光束在格子地图上找最近的墙，
   * 把它的照射距离截在墙后 wallMargin 米（墙体在格子里居中，这样刚好够到墙的背面）
   */
  core: { angle: VISION.halfAngle * 0.42, penumbra: 0.8, intensity: 30, wallMargin: CELL },
  /** 衰减指数比物理的 2 小得多：手电离地只有 0.8 米，照远处地面是掠射，按平方衰减的话光斑一离开脚边就看不见了 */
  decay: 1.1,
  /** 光到这么远完全衰减为 0，也是阴影相机的远平面（比视野远一点） */
  distance: VISION.range * 1.3,
  /** 照向：lookDir 方向这么远的地面 */
  aim: 3.5,
  /**
   * 停下来看画像、镜子、挂画时（TorchPose.lift = 1）光轴抬起来，对着 aim 米外这么高（米）的地方：手在 0.8 米高、站在 1.5–2.5 米外时，
   * 光轴正好落在画布上（平时照地面，光锥上沿只擦到画框底下，playtest.md S2）。tests/browse.test.ts 按 PAINTINGS 核对
   */
  gazeY: 1.85,
  shadow: {
    size: { high: 1024, low: 512 } as Record<Quality, number>,
    near: 0.1,
    // 墙面和光几乎平行时最容易出条纹（阴影痤疮）：bias 往负、再沿法线推一点
    bias: -0.0008,
    normalBias: { high: 0.03, low: 0.05 } as Record<Quality, number>,
    /**
     * 影子里留一点光（2026-10-30 第二波 VX，eye G-4「手电打出来的影子纯黑、边缘破碎，第一眼以为墙破了个洞」）：
     * intensity 是影子挡掉多少（1 = 全挡），留下的那点算是屋里别处弹回来的光；radius 是 PCF 取样的半径（阴影图的像素），
     * 边缘软一点、不再是一格一格的锯齿。都是 uniform（three 的 reference），改值不重编
     */
    intensity: 0.85,
    radius: 3.5,
  },
  /**
   * 手电贴近时压暗（2026-10-30 第二波 VX：深红沙发上一块发粉的光斑、eye G-9 侧面一大块橙色光斑）：照度按 d^−decay 衰减，
   * 离手电不到 1 米的面亮得冲过头，色调映射把它压成一团发白、发粉的光斑（深红的布被照得太亮，AgX 把高光往白里收，红就成了粉）。
   * 两盏灯的颜色再乘 torchNearK(d, near)（见下），照度变成 (d⁶ + near⁶)^(−decay/6)：远处和原来一样，近处停在 near 米处的水平，不再往上冲。
   * 那团光斑主要是亮芯（窄、强）：亮芯的 near 大一些。贴着照时总照度约 28（原来半米处 150、0.3 米处 265），和光斑落地的地方（aim 3.5 米，约 17）是一个量级，
   * 所以贴近的东西还是最亮的，但颜色还在；光斑落地的地方差不到 4%
   */
  near: { halo: 2, core: 3 },
  /** 紧张：亮度闪烁的深度（见 NERVOUS_FLICKER）、光束抖动的幅度（弧度） */
  nervous: { flicker: OLD_FLICKER ? NERVOUS_FLICKER.old : NERVOUS_FLICKER.safe, jitter: 0.035 },
  /** 假体积光：最长多少米、最亮时的不透明度 */
  beam: { length: 3.4, opacity: 0.085, radius: Math.tan(VISION.halfAngle * 0.8) },
  /** 被 torchDim 压暗时颜色往这个暖红偏：偏多少 = (1 − 压暗系数) × dimWarmK（和 lightfx.ts 的 LIGHTFX 一样） */
  dimWarm: 0xff6a3a,
  dimWarmK: 0.5,
};

/** 每帧传给手电的位姿（房屋坐标） */
export interface TorchPose {
  x: number;
  /** 光源高度（米） */
  y: number;
  z: number;
  /** 照向（方向角，见 lib/angle.ts） */
  dir: number;
  /** 0..1：访客淡入淡出时跟着变 */
  power: number;
  nervous: boolean;
  /** 0..1：抬手照墙上的东西（见 TORCH.gazeY），不给就是 0（照地面） */
  lift?: number;
}

export interface Flashlight {
  update(p: TorchPose, dt: number, time: number): void;
  /** 空闲：灯灭、不再渲染阴影图（灯还在场景里，避免材质重编译） */
  park(): void;
  readonly parked: boolean;
  setQuality(q: Quality): void;
  /** 手上那支手电的模型（手柄、灯头、光锥）：预编译时临时关掉它们的视锥剔除用 */
  readonly hand: THREE.Object3D;
  dispose(): void;
}

/** 下一支手电分到登记表的哪个槽（characters.ts 一次建 TORCH_COUNT 支，调用处不用改；开发页多建的按余数轮回） */
let nextSlot = 0;
/** 手电多于登记表的槽数、槽位回绕时已经提醒过了（只提醒一次，最终审查 V-M5） */
let warnedWrap = false;

/**
 * 紧张时亮度的起伏（0..1，1 = 最深）：两个不成倍数的正弦相乘，偶尔叠出一次深一点的暗闪（dip）。
 * 乘上 TORCH.nervous.flicker 才是强度掉多少。拆出来是为了测试按种子、按时间直接数（tests/flicker.test.ts）
 */
export function nervousWave(time: number, seed: number): number {
  const n = Math.max(0, Math.sin(time * 17.3 + seed) * Math.sin(time * 6.1 + seed * 2.3));
  const dip = Math.sin(time * 1.9 + seed) > 0.94 ? 0.5 : 0;
  return Math.min(1, n + dip);
}

/**
 * 手电贴近时的压暗系数（CPU 版，测试用；着色器里 nearFalloff 是同一个式子）：k(d) = (d / d′)^decay，d′ = (d⁶ + near⁶)^(1/6)。
 * 乘上原来的 d^−decay，照度就是 d′^−decay：d ≫ near 时 d′ ≈ d（不变），d ≪ near 时 d′ ≈ near（停在 near 米处的水平）
 */
export function torchNearK(d: number, n: number): number {
  return Math.pow(d / Math.pow(d ** 6 + n ** 6, 1 / 6), TORCH.decay);
}

/**
 * 两盏聚光灯的颜色上再乘的那一项（three r186 的 SpotLightNode：灯带 colorNode 时，光锥投影范围里的光乘上 colorNode(投影坐标)）。
 * 要用 TSL 的 Fn 包起来：LightsNode 拿它算着色器缓存键（getCacheKey），SpotLightNode 把它当函数调；SpotLightNode 自己的颜色还是灯的 color。
 * 按片元到这盏灯的距离算 torchNearK，投影坐标用不上。投影范围按灯的阴影相机算，离灯比阴影相机的近平面还近的点不乘：
 * 外圈的近平面 TORCH.shadow.near（0.1 米），亮芯不投影，把它的近平面设得很小（见 createFlashlight）
 */
function nearFalloff(light: THREE.SpotLight, near: number) {
  return Fn(() => {
    const d = length(positionWorld.sub(lightPosition(light)));
    const d2 = d.mul(d);
    return pow(d.div(pow(d2.mul(d2).mul(d2).add(near ** 6), 1 / 6)), TORCH.decay);
  });
}

/**
 * 这一次画光锥的相机：1 = 透视（第三人称），0 = 正交（娃娃屋）。所有手电共用，光锥画之前按相机设。
 * 光锥「正对镜头的程度」要用指向镜头的方向算：正交相机处处是观察空间 +z，透视相机逐片元从这一点指向镜头
 */
const beamPersp = uniform(0);

// 光锥网格要在墙那里截断：沿格子地图走一遍，找到第一个挡视线的格子（反弹光 bounce.ts 量落点也用它）
let tiles: Uint8Array | null = null;
export function wallDistance(x: number, z: number, dir: number, max: number): number {
  tiles ??= buildTiles();
  const dx = Math.cos(dir), dz = Math.sin(dir);
  const step = CELL / 5;
  for (let d = step; d < max; d += step) {
    const i = Math.floor((x + dx * d) / CELL), j = Math.floor((z + dz * d) / CELL);
    if (i < 0 || j < 0 || i >= GRID_W || j >= GRID_H) return max; // 屋外（前门外）不挡
    if (blocksSight(tiles[j * GRID_W + i] as Tile)) return d;
  }
  return max;
}

// 共用几何体：单位长度的光锥（尖在原点、沿 +z 张开）、手电筒身、镜片
let shared: { cone: THREE.BufferGeometry; body: THREE.BufferGeometry; lens: THREE.BufferGeometry; bodyMat: THREE.Material; lensMat: THREE.Material } | null = null;
function sharedParts() {
  if (shared) return shared;
  const cone = new THREE.ConeGeometry(TORCH.beam.radius, 1, 24, 1, true);
  cone.translate(0, -0.5, 0); // 尖移到原点（ConeGeometry 的尖在 +y）
  cone.rotateX(-Math.PI / 2); // 张开方向转到 +z
  const body = new THREE.CylinderGeometry(0.028, 0.022, 0.15, 10);
  body.rotateX(Math.PI / 2);
  body.translate(0, 0, -0.06);
  const lens = new THREE.CircleGeometry(0.026, 12);
  lens.translate(0, 0, 0.0155);
  const bodyMat = new THREE.MeshStandardNodeMaterial({ color: PALETTE.wallTrim, roughness: 0.45, metalness: 0.6 });
  // 镜片不受光照，直接是亮芯的颜色（泛光会把它晕开一点）；跟着 torchDim 一起暗（最终审查 V-M4）：颜色按物体传
  // （每支手电写自己镜片的 userData.lensColor），材质所有手电共用这一份——每支一份材质的话 three.js 会各编一份着色器
  // （characters.ts 的访客材质吃过这个亏）
  const lensMat = new THREE.MeshBasicNodeMaterial();
  lensMat.colorNode = uniform(new THREE.Color(PALETTE.torchCore)).onObjectUpdate(({ object }) => object?.userData.lensColor as THREE.Color | undefined);
  shared = { cone, body, lens, bodyMat, lensMat };
  return shared;
}

/** seed：手抖的相位（默认随机；测试里固定，好按种子数） */
export function createFlashlight(parent: THREE.Object3D, quality: Quality, seed = Math.random() * 100): Flashlight {
  const parts = sharedParts();
  const n = nextSlot++;
  if (n >= TORCH_COUNT && !warnedWrap) {
    warnedWrap = true;
    console.warn(`[flashlight] 建了第 ${n + 1} 支手电，登记表只有 ${TORCH_COUNT} 个槽（torches.ts 的 TORCH_COUNT）：多出来的和前面的共用槽位、互相覆盖，鬼魂只看得见其中一支的光锥。调大 TORCH_COUNT，或者少建几支`);
  }
  const slot = n % TORCH_COUNT;
  const reg = torches[slot];
  const halo = new THREE.SpotLight(PALETTE.torchHalo, 0, TORCH.distance, TORCH.halo.angle, TORCH.halo.penumbra, TORCH.decay);
  const core = new THREE.SpotLight(PALETTE.torchCore, 0, TORCH.distance, TORCH.core.angle, TORCH.core.penumbra, TORCH.decay);
  halo.castShadow = true;
  halo.shadow.camera.near = TORCH.shadow.near;
  halo.shadow.bias = TORCH.shadow.bias;
  halo.shadow.intensity = TORCH.shadow.intensity;
  halo.shadow.radius = TORCH.shadow.radius;
  // 贴近时压暗（TORCH.near）：两盏灯都乘。亮芯不投影，它的阴影相机只用来算「在不在光锥投影范围里」，近平面放到 2 厘米
  core.shadow.camera.near = 0.02;
  (halo as unknown as { colorNode: unknown }).colorNode = nearFalloff(halo, TORCH.near.halo);
  (core as unknown as { colorNode: unknown }).colorNode = nearFalloff(core, TORCH.near.core);
  // 房子任务把「只投影的全高墙」放在 layer 1：让外圈的阴影相机也看见它们，光就不会从降低的墙上方漏到隔壁
  halo.shadow.camera.layers.enable(1);
  // 鬼魂只进手电阴影图的那份影子（ghost.ts，被照出、现身时才不丢）
  halo.shadow.camera.layers.enable(GHOST_SHADOW_LAYER);
  const target = new THREE.Object3D();
  halo.target = target;
  core.target = target;

  // 手里的手电筒 + 假体积光，都挂在 hand 下面，hand 的 +z 指向照的方向
  const hand = new THREE.Group();
  const body = new THREE.Mesh(parts.body, parts.bodyMat);
  const lens = new THREE.Mesh(parts.lens, parts.lensMat);
  lens.name = 'torch-lens';
  // 镜片此刻的颜色（共用材质每画这一个镜片前读它）：和亮芯那盏灯同一个颜色 × torchDim，见下面 update
  // ×2.5（2026-10-30 试玩 P2-8：×3 时访客正对镜头、约 2 米处镜片的泛光是一团约 70 像素的橙色软球）：亮度约 2.23，
  // 刚过泛光阈值（BLOOM.threshold 2.2，软过渡到 3.4 才全量）和 AO 保护上限（2.0），镜片本身不被压暗，泛光只剩很淡的一点
  // （×3 时过阈值的那份约 35%，×2.5 约 0.2%）。简报写的是 ×2，但 ×2 的亮度约 1.79，掉到泛光阈值和 AO 保护区间下面，
  // tests/postfx-ao.test.ts（ART-7 配 ART-4）钉着这条，所以取 ×2.5；update 里同
  const lensColor = new THREE.Color(PALETTE.torchCore).multiplyScalar(2.5);
  lens.userData.lensColor = lensColor;
  const strength = uniform(0);
  const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });
  beamMat.colorNode = color(PALETTE.torchHalo);
  // 越靠近手越浓；侧面（光锥轮廓）几乎透明，正对镜头的中间浓一点，看起来像一团光而不是一个锥壳
  // 光束里的灰尘：世界坐标上缓慢飘的噪声（灰尘飘在空气里，不跟着手电走），光锥不再是一块均匀的亮片，
  // 也盖住 24 个面拼出来的条纹。贴地那一段交给雾（雾自己会被手电照亮），光锥在这里渐隐，免得两层加法叠得过亮
  const dust = mx_noise_float(positionWorld.mul(vec3(2.2, 3, 2.2)).add(vec3(time.mul(0.12), time.mul(0.05), time.mul(-0.08)))).mul(0.5).add(0.5);
  const aboveFog = smoothstep(0.2, 0.6, positionWorld.y);
  const toCam = normalize(mix(vec3(0, 0, 1), positionView.negate(), beamPersp));
  beamMat.opacityNode = pow(uv().y, 1.8).mul(pow(abs(dot(normalView, toCam)), 1.4)).mul(strength).mul(dust.mul(0.7).add(0.3)).mul(aboveFog);
  const beam = new THREE.Mesh(parts.cone, beamMat);
  beam.onBeforeRender = (_r, _s, camera) => {
    beamPersp.value = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
  };
  beam.renderOrder = 2;
  for (const m of [body, lens, beam]) {
    m.castShadow = false; // 手电自己不能挡住自己的光
    m.receiveShadow = false;
    hand.add(m);
  }
  parent.add(halo, core, target, hand);

  let q = quality;
  let parked = false;
  let nerv = 0; // 紧张程度的平滑值
  const dirV = new THREE.Vector3();
  const fwd = new THREE.Vector3(0, 0, 1);
  // 压暗时的偏色：两盏灯原来的颜色、往哪个颜色偏；压暗系数没变就不重算颜色
  const haloColor = halo.color.clone(), coreColor = core.color.clone();
  const warm = halo.color.clone().setHex(TORCH.dimWarm);
  let lastDim = 1;

  const applyQuality = () => {
    const s = TORCH.shadow.size[q];
    halo.shadow.mapSize.set(s, s);
    halo.shadow.normalBias = TORCH.shadow.normalBias[q];
    beam.visible = q === 'high';
  };
  applyQuality();

  const park = () => {
    parked = true;
    halo.intensity = 0;
    core.intensity = 0;
    halo.shadow.autoUpdate = false; // 不再每帧画这盏灯的阴影图
    hand.visible = false;
    strength.value = 0;
    reg.power = 0;
  };
  park();
  // 闲置的手电也要先画一次阴影图：否则材质绑定时 three 会把还没渲染过的深度贴图当普通贴图建出来，
  // 等访客进门、阴影图第一次渲染时，渲染目标初始化会把它销毁重建，而材质的绑定组还指着旧贴图，
  // WebGPU 会每帧报「Destroyed texture "ShadowDepthTexture" used in a submit」（2026-10-27 集成时发现）
  halo.shadow.needsUpdate = true;

  return {
    get parked() { return parked; },
    hand,
    update(p, dt, time) {
      if (parked) {
        parked = false;
        halo.shadow.autoUpdate = true;
        hand.visible = true;
      }
      nerv += ((p.nervous ? 1 : 0) - nerv) * (1 - Math.exp(-4 * dt));
      // 紧张：手在抖，光也不稳（亮度的起伏见 nervousWave，深度小到任意 1 秒都数不出「暗一下」）
      const flick = 1 - nerv * TORCH.nervous.flicker * nervousWave(time, seed);
      const dir = p.dir + nerv * TORCH.nervous.jitter * Math.sin(time * 21 + seed * 3);

      // 灯闪（lightfx.ts 写的压暗系数）：强度直接乘；颜色往暖红偏，越暗越红；手上的镜片跟着一起暗、一起偏色
      const dim = torchDim[slot];
      if (dim !== lastDim) {
        lastDim = dim;
        const w = Math.max(0, 1 - dim) * TORCH.dimWarmK;
        halo.color.copy(haloColor).lerp(warm, w);
        core.color.copy(coreColor).lerp(warm, w);
        lensColor.copy(core.color).multiplyScalar(dim * 2.5);
      }
      halo.intensity = TORCH.halo.intensity * p.power * flick * dim;
      core.intensity = TORCH.core.intensity * p.power * flick * dim;
      // 亮芯在最近的墙后面截断（光轴和亮芯两侧边缘各量一次，取最近的）
      const a = TORCH.core.angle, far = TORCH.distance;
      const wall = Math.min(wallDistance(p.x, p.z, dir, far), wallDistance(p.x, p.z, dir - a, far), wallDistance(p.x, p.z, dir + a, far));
      core.distance = Math.min(far, wall + TORCH.core.wallMargin);
      halo.position.set(p.x, p.y, p.z);
      core.position.copy(halo.position);
      const tx = p.x + Math.cos(dir) * TORCH.aim, tz = p.z + Math.sin(dir) * TORCH.aim;
      const ty = TORCH.gazeY * (p.lift ?? 0);
      target.position.set(tx, ty, tz);
      target.updateMatrixWorld();

      hand.position.copy(halo.position);
      dirV.set(tx - p.x, ty - p.y, tz - p.z).normalize();
      hand.quaternion.setFromUnitVectors(fwd, dirV);
      // 光锥在墙那里截断（按水平距离算，再折回到沿光轴的长度）
      const horiz = Math.hypot(dirV.x, dirV.z) || 1;
      const len = Math.min(TORCH.beam.length, wallDistance(p.x, p.z, dir, TORCH.beam.length) / horiz);
      beam.scale.setScalar(Math.max(0.05, len));
      strength.value = TORCH.beam.opacity * p.power * flick * dim;

      // 登记表：鬼魂的着色器按它判断自己在不在这支手电的光锥里（房屋坐标；光轴就是上面指向照射点的 dirV）
      reg.x = p.x; reg.y = p.y; reg.z = p.z;
      reg.dx = dirV.x; reg.dy = dirV.y; reg.dz = dirV.z;
      reg.angle = TORCH.halo.angle;
      reg.range = TORCH.distance;
      reg.power = p.power * flick * dim;
    },
    park,
    setQuality(nq) {
      q = nq;
      applyQuality();
    },
    dispose() {
      reg.power = 0;
      parent.remove(halo, core, target, hand);
      halo.dispose();
      core.dispose();
      beamMat.dispose();
    },
  };
}
