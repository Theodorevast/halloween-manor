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
//   暗两下、借 frost.ts 让脚下结霜；落下时灯暗一下，暗到最深的那一帧换上「实」的那份材质（普通混合、暗、挡光、写深度，被手电照着的那面亮一点），
//   停留时不飘、头慢慢抬起、只每秒更新 10 次，冷雾从下摆往下淌；收的时候再暗一下换回来。没有淡入淡出。
//   「实」的那份标了 deferCompile，开场按钮可用之后由 main.ts 预编译
// - 挡住访客时自己淡下去（2026-10-30，手感 FEEL-5，参数见 GHOST.occlude）：朝人飘过去时他就在鬼魂身后，贴近发毛、现身落下被吓的人、
//   吓跑的人都被鬼魂自己挡住。每帧把鬼魂和比它离镜头更远的访客投到屏幕上，访客被鬼魂的矩形盖住得多就把 u.fade 乘一个小于 1 的数
//   （平时 0.35、现身的实体 0.5、正被手电照出来 0.6），变淡快、回来慢；只是 uniform 的值，不加材质
// ?noghostfx：不画鬼魂（量开销的对照，和 house.ts 一致）
import * as THREE from 'three/webgpu';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  abs, acos, attribute, clamp, cos, dot, exp, float, floor, instancedDynamicBufferAttribute, length, max, min, mix, modelViewMatrix,
  mx_noise_float, mx_noise_vec3, normalView, normalWorld, positionLocal, positionViewDirection, positionWorld,
  pow, sin, smoothstep, uniform, uv, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { CHARACTER } from '../config/character';
import { GHOST_MODEL } from '../config/ghost';
import { CELL, Tile, buildTiles, cellOf, idx, inGrid } from '../config/house';
import { MANIFEST, VISION } from '../config/visitors';
import { ghostSees } from '../engine/ghostRig';
import type { FrameCtx, GhostRig, Module, Quality, RenderCore } from '../engine/types';
import { wrapAngle, yawFor } from '../lib/angle';
import type { SimEvent, Vec2, WorldState } from '../sim/types';
import { TORCH } from './flashlight';
import type { Frost } from './frost';
import { MANIFEST_WINDUP_PATTERN, thermal, type LightFx } from './lightfx';
import { PALETTE } from './palette';
import { ge, lt, makeSprite, rnd } from './particles/common';
import { GHOST_SHADOW_LAYER, TORCH_COUNT, torches, type TorchSample } from './torches';

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
   * smoothstep(cos 半角, mix(cos 半角, 1, edge), cosθ) × (1 − smoothstep(照多远 × far, 照多远, 距离)) × 强度 × 中间没有墙（半角、照多远用模拟的 VISION，见 SEE_COS）；
   * 四支取最亮的 = reveal。身体的不透明度 × mix(1, density, reveal)（雾晕不乘：照着时外面那圈糊的不跟着变浓，轮廓才清楚）；
   * soft 区间的下限往 soft 收（轮廓收紧）；颜色往手电的暖色（warmColor）偏 reveal × warm。
   * losTau：中间有没有墙是 CPU 每帧按格子判的 0 / 1，平滑这么久（秒），走过门框边时不跳。
   * near：离手电 near[0] 米以内照不出、near[1] 米以外照满，中间 smoothstep（第二波 ART-3）。「贴近」是核心吓法，鬼魂常在访客 1 米内，
   * 手电的光锥尖端落在身上时，照出的程度不再一下拉满：近处的照出是淡的，身上不截出一圈边缘清楚的亮盘。
   * （美术总监分析里客厅沙发那几张（f03、b33）的粉紫圆盘，实测是手电的两盏聚光（外圈为主）近距离打在深红的沙发靠背上、过曝成粉的光斑：
   * 把鬼魂藏掉（?noghostfx）、关掉雾（?nofog）它都原样还在，把外圈聚光的强度改成 0 它缩成一小块、两盏都改成 0 就没了，
   * 不是鬼魂造成的，见第二波 GF 路报告；这一项管的是鬼魂自己身上的照出。）
   * 暖色：被照着的地方是「被照亮的白雾」，不是粉色，所以暖色收成近中性（(0.9, 0.86, 0.8)）、混进去的量也少（原来 (0.95, 0.8, 0.6) 混 35%，
   * 混进冷蓝的身体里偏粉）
   */
  reveal: {
    density: 3, soft: 0.55, warm: 0.22, edge: 0.35,
    far: 0.7,
    near: [0.5, 1.4] as [number, number],
    warmColor: new THREE.Color(0.9, 0.86, 0.8).multiplyScalar(0.5),
    losTau: 0.08,
  },
  /**
   * 主动现身的画面（调研 G2 / G3 / G4、L1、S1，时间轴见设计文档 3.2；几段的时长用 config/visitors.ts 的 MANIFEST）。
   * - 蓄力：radius 米内的灯按 windup 的节奏暗两下（lightfx.pulse，每秒 10 个字母，只放 MANIFEST.windup 秒），脚下的霜往外长到 frost 米；
   *   windup 这张节奏表在 lightfx.ts（MANIFEST_WINDUP_PATTERN）：声音那边灯每暗一下的咔哒（audio/ghost.ts 的 MANIFEST_SFX.clicks）是从同一张表推出的，
   *   要改节奏改那里，咔哒自己跟着走；
   * - 落下：附近的灯和手电一起暗 drop.ms 毫秒、暗到 drop.depth（dipAll），这一下过了 swapAt 成、暗到最深的那一帧换上「实」的那份
   *   材质（不淡入）；之后灯压在 hold 这一档（'c' ≈ 42%，设计文档：40% 左右），收的时候放开，holdSlack 秒是兜底；
   * - 停留：不飘，头慢慢抬起（solid.headPitch），连同位置、朝向只每秒更新 stepRate 次（G3）；冷雾从下摆往下淌（GHOST_MIST.pour）；
   * - 收：再暗 end.ms 毫秒，暗下那一帧换回原来的雾。
   * 台灯不跟着蓄力、收这两下（只吃落下、停留）：它自己的附身、复原和现身前后脚接上时会超过每秒 3 下，见 manifestLights。
   * 平时的鬼魂（加法、自己发光）跟着附近灯的明暗一起暗（follow，1 = 完全跟着），借暗下去的那一下出入，不会在暗下去时反而更显眼。
   * 节奏表加上落下那一下，任意 1 秒内最多暗 3 下（tests/lightfx.test.ts 查；和台灯前后接上的情况 tests/flicker.test.ts 查）
   */
  manifest: {
    radius: 5,
    windup: MANIFEST_WINDUP_PATTERN,
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
   * 「实」的那份（G2）：普通混合、不透明度 opacity，挡住后面的光。
   * - dark：没被照着时的颜色 = 原来的冷白 × dark。0.03 ≈ 线性 0.009，比停留时压暗的房间（0.005–0.02）还暗或差不多，是一个暗色剪影。
   *   简报原定 0.1（≈ 线性 0.03）：在暗房间里比周围亮，看着像一团自己发光的实雾（2026-10-29 评审 I1）；
   *   要对比就开 dev/ghost.html?manifest&solid=0.1
   * - albedo：被手电照到的那一面当作一件这么暗的长袍，按真的手电算漫反射（外圈、亮芯两盏灯的光锥、TORCH.decay 的距离衰减、强度、颜色都和
   *   flashlight.ts 一样，见 torchIrradiance）：离得近、正对着才亮，离远了按距离暗下去；看得出褶，不发光。
   *   0.11（第二波 ART-6，原来 0.06）：暗走廊里停留时的长袍和背景差不多亮，只靠挡住后面一点光读出来；亮一点以后，被手电照着的那面
   *   读得出是一件深色的布，背光面（dark）不动、仍然是暗的剪影
   * 边上仍然用原来的侵蚀噪声散开（erode 比平时小：身子是实的，只有边和下摆散）。
   * soft：朝向镜头的程度在这之间淡入（轮廓不是一刀切）；hemFade 下摆淡出。
   * 头：身高 neck 以上的顶点（neckBlend 内渐变，脖子不折）绕 x 轴转，停留的 MANIFEST.hold 秒里从低着头 headPitch[0] 抬到 headPitch[1]
   * （弧度，正 = 低头）：在灯暗下去的那一下换成低着头的样子，再慢慢抬起来看人
   * - depthCut：写深度（2026-10-29，最终审查 V-M1）。它画在冷雾前面，不写深度时身后的冷雾整团加在它上面，看着发虚；
   *   换成网格模型以后，前后叠着的几层（袖子、兜帽里面）也要靠深度挡住。形状（soft × 侵蚀 × 下摆淡出，不算 opacity 和
   *   镜头太近时的淡出）不到 depthCut 的片元整个丢掉、不写深度：侵蚀掉的缝、轮廓最外面几乎看不见的一圈不挡雾，丢掉的颜色本来就看不见。
   *   0.05 是对比过的（dev/ghost.html?manifest&depthcut=…）：门槛越高，雾被挡住的那条硬边越往身体里走，看着像身上挖出的暗块；
   *   0.05 时这条边就在轮廓上（地上的雾在下摆处齐齐断开，像长袍下沿挡在雾前面）。写了深度，停留时 AO（engine/postfx.ts）
   *   也把它当实物算：贴墙站、镜头放低看地板，都看不出黑晕
   */
  solid: {
    opacity: 0.85,
    dark: 0.03,
    albedo: 0.11,
    soft: [0.0, 0.3] as [number, number],
    erode: [0.04, 0.6] as [number, number],
    hemFade: 0.3,
    depthCut: 0.05,
    neck: 0.75,
    neckBlend: 0.07,
    headPitch: [(8 * Math.PI) / 180, 0] as [number, number],
  },
  /**
   * 墙上的影子（调研 L2）：一份只进手电阴影图的网格（torches.ts 的 GHOST_SHADOW_LAYER：主画面、月光都看不见它），
   * 形状跟着画面上那份（平时飘、拖，现身时不飘、头转）。uReveal 在 on 区间里由少到多地出现（从噪声最浓的地方开始），现身时整个都在；
   * 边用和身体一样的侵蚀噪声蚀成一缕一缕，hemCut 以下的下摆不投影。
   * 只挡手电外圈那盏（亮芯不投影），所以影子里还有一点亮芯的光，不是死黑。
   * 不做半透明的灰影：shadowMap.transmitted 要开场就开、所有材质跟着变；逐像素抖动丢片元的办法试过，PCF 糊不匀，近看是一格一格的点
   */
  shadow: { on: [0.15, 0.3] as [number, number], hemCut: 0.12 },
  /**
   * 遮蔽（2026-10-29，换成网格模型）：几何体每个顶点带一个 occl（0..1，1 = 敞开；scripts/blender/ghost_cleanup.py 打射线烘的，
   * GLB 里叫 _OCCL）。平时的鬼魂不透明度 × mix(1, occl, body)，「实」的那份颜色（含手电照的那一面）× mix(1, occl, solid)：
   * 兜帽里那个洞、褶子深处暗下去，洞读成一团黑，不是一张脸。程序化的人形和没带 occl 的模型全是 1，和原来一样
   */
  occlusion: { body: 1, solid: 1 },
  /**
   * 挡住访客时自己淡下去（手感 FEEL-5）。朝人飘过去时他就在鬼魂身后（鬼魂离镜头近、他远，过肩只偏 0.32 米，2 米外的人正好落在鬼魂身宽的投影里），
   * 贴近发毛、现身落下被吓的人、吓跑的人都被鬼魂自己挡住，画面里约四成的人看不见。做法：每帧用 GhostRig.toScreen 投出鬼魂的屏幕矩形
   * （ghostBox：脚下 y[0] 米到头顶上 y[1] 米，左右各 half 米，左右按镜头的右方向）和每个比鬼魂离镜头更远、range 米以内的访客的矩形
   * （visitorBox：脚到 CHARACTER.targetHeight + top 米，左右各 half 米；没走的都算，吓跑的也算——吓跑那一下正是要看清他的时候），
   * 算访客的矩形被鬼魂的矩形盖住的比例（重叠面积 ÷ 访客的面积），取最大的（每帧只看离镜头最近的 people 个）：overlap。
   * cover = smoothstep(from, to, overlap)，再平滑：cover 往上走（挡住了，鬼魂要淡）用 in 秒，往下走（让开了）用 out 秒，指数逼近。
   * u.fade 再乘 lerp(1, k, cover)：k 平时 alpha，现身的实体 solid（吓人的那一下，留一半），正被手电照着（revealNow > lit）revealed
   * （「被照出来」的显形要看得见）；k 自己的切换也按 out 秒平滑，不跳。只改 uniform 的值：墙上的影子那份网格只进手电阴影图，不受影响
   */
  occlude: {
    alpha: 0.35, solid: 0.5, revealed: 0.6, from: 0.15, to: 0.5, in: 0.12, out: 0.35,
    ghostBox: { y: [0.55, 2.05] as [number, number], half: 0.32 },
    visitorBox: { top: 0.15, half: 0.25 },
    range: 8,
    people: 3,
    lit: 0.3,
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

/**
 * 鬼魂材质共用的 uniform（每帧由 createGhostView 写）。
 * 导出给墙上多一个影子（otherShadow.ts）：它用 createGhostShadowMaterial 再做一份影子，给自己一组（不飘、不跟玩家）
 */
export function makeGhostUniforms() {
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
    /** 墙上的影子有多少（0 = 整个丢掉，1 = 全在；见 GHOST.shadow） */
    shadow: uniform(0),
  };
}

/** 顶点：很慢的飘动（下摆飘得多）+ 走动时下摆往后拖（模型局部坐标）。画面上的身体、雾晕和影子共用 */
function swayAndLean(u: GhostUniforms, P0: V3n, low2: F): V3n {
  const S = GHOST.sway;
  const swayN = mx_noise_vec3(vec3(P0.x.mul(S.freq), P0.y.mul(S.freq).sub(u.time.mul(S.speed)), P0.z.mul(S.freq)));
  const sway = swayN.mul(low2.mul(S.low).add(S.base));
  const lean = vec3(u.lean.x, 0, u.lean.y).mul(low2);
  return sway.add(lean) as V3n;
}

/** 顶点：现身时头那一段绕脖子（身高 GHOST.solid.neck 处、过身体中轴）的 x 轴转 u.head，往下 neckBlend 内渐变。「实」的那份和影子共用 */
function headPose(u: GhostUniforms, look: GhostLook, P0: V3n, h: F): V3n {
  const S = GHOST.solid;
  const pivot = look.bottom + (look.top - look.bottom) * S.neck;
  const ang = u.head.mul(smoothstep(S.neck, S.neck + S.neckBlend, h));
  const c = cos(ang), s = sin(ang);
  const y0 = P0.y.sub(pivot);
  return vec3(P0.x, y0.mul(c).sub(P0.z.mul(s)).add(pivot), y0.mul(s).add(P0.z.mul(c)));
}

/** 侵蚀用的噪声（模型局部坐标，往上飘；u.step = 1 时时间按 1 / stepRate 秒取整）：0..1 */
function smokeNoise(u: GhostUniforms, P: V3n, layer: GhostLayer, stepped: boolean): F {
  const rate = GHOST.manifest.stepRate;
  const t = stepped ? mix(u.time, floor(u.time.mul(rate)).div(rate), u.step) : u.time;
  const q = vec3(P.x.mul(layer.noise), P.y.mul(layer.noise * 0.8).sub(t.mul(layer.rise * layer.noise)), P.z.mul(layer.noise));
  const n1 = mx_noise_float(q);
  return (layer.octaves === 1 ? n1 : n1.mul(0.62).add(mx_noise_float(q.mul(2.3).add(5.3)).mul(0.38))).mul(0.5).add(0.5) as F;
}
export type GhostUniforms = ReturnType<typeof makeGhostUniforms>;

/** 顶点的遮蔽（GHOST.occlusion）：鬼魂的几何体都由 ensureGhostAttributes 补上了 occl 属性 */
const occlusion = (): F => attribute('occl', 'float') as unknown as F;
/** 雾晕外扩的方向（ensureGhostAttributes）：模型带的平滑过的方向，没有就是法线 */
const inflateDir = (): V3n => attribute('inflate', 'vec3') as unknown as V3n;

/**
 * 保证几何体有鬼魂材质要读的两个属性（程序化的人形、换上的模型、蒙皮网格都要先过一遍，createGhostView 里做）：
 * - occl（GHOST.occlusion）：GLB 里的 _OCCL（three 读成 _occl），没有就用顶点色的 r，再没有就全是 1（和原来一样）
 * - inflate：雾晕沿它外扩。GLB 里的 _INFLATE（scripts/blender/ghost_cleanup.py 把法线反复平均过：模型的褶子、帽檐折角多，
 *   沿法线外扩的雾晕会自己折叠出一道道亮条），没有就是法线（和原来一样）
 */
export function ensureGhostAttributes(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  if (!g.getAttribute('occl')) {
    const src = (g.getAttribute('_occl') ?? g.getAttribute('color')) as THREE.BufferAttribute | undefined;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = src ? src.getX(i) : 1;
    g.setAttribute('occl', new THREE.BufferAttribute(a, 1));
  }
  if (!g.getAttribute('inflate')) {
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    g.setAttribute('inflate', (g.getAttribute('_inflate') ?? g.getAttribute('normal')).clone());
  }
  return g;
}

/**
 * 照出鬼魂用的光锥半角和照程：用访客看得见的范围（模拟的 VISION，30°、7 米），不用灯本身的（外圈半角 ×1.1、照程 ×1.3）。
 * 这样画面上照得出鬼魂的地方，就是访客察觉得到的地方（2026-10-29 整合：原来 7–9 米处照得很清楚，访客却没反应）
 */
const SEE_COS = Math.cos(VISION.halfAngle);
const SEE_RANGE = VISION.range;

/**
 * 片元 P（世界坐标）被手电照着的程度 0..1：四支里最亮的那支（公式见 GHOST.reveal，光锥和照程见 SEE_COS）。
 * 近处淡出（GHOST.reveal.near）：离手电不到 near[0] 米照不出，near[1] 米以外照满。CPU 那份是 torchRevealAt，要一起改
 */
function torchReveal(u: GhostUniforms, P: V3n): F {
  const R = GHOST.reveal;
  let reveal: F = float(0);
  for (let i = 0; i < TORCH_COUNT; i++) {
    const tp = u.torchPos[i], td = u.torchDir[i];
    const L = P.sub(tp.xyz);
    const d = length(L);
    const cosT = dot(L.div(max(d, 0.001)), td.xyz);
    const cone = smoothstep(SEE_COS, SEE_COS + (1 - SEE_COS) * R.edge, cosT);
    const reach = float(1).sub(smoothstep(SEE_RANGE * R.far, SEE_RANGE, d));
    const nearK = smoothstep(R.near[0], R.near[1], d);
    reveal = max(reveal, cone.mul(reach).mul(nearK).mul(u.torchPow[i]));
  }
  return reveal;
}

/** three 的距离衰减（LightUtils.getDistanceAttenuation，和 particles/light.ts 同一个式子）：1 / d^decay，在截止距离处平滑归零 */
const distanceAtt = (d: F, cutoff: F, decay: number): F => {
  const q = d.div(max(cutoff, 0.01));
  const q2 = q.mul(q);
  const w = clamp(float(1).sub(q2.mul(q2)), 0, 1);
  return pow(d, decay).max(0.01).reciprocal().mul(w.mul(w)) as F;
};

/**
 * 片元 P（世界坐标、世界法线 N）从四支手电受到的照度（线性 RGB，和 three 的灯同一量纲：乘 albedo / π 就是漫反射）。
 * 照 three 的聚光灯算，参数都是 flashlight.ts 那两盏灯的：外圈、亮芯各自的光锥 smoothstep(cos 半角, cos(半角 × (1 − penumbra)))，
 * 外圈的半角用登记表里的；距离衰减按 TORCH.decay，截止在登记表的 range；强度 TORCH.*.intensity × 登记表的强度
 * （含紧张闪烁、torchDim）× 中间没有墙；颜色 PALETTE.torchHalo / torchCore；再乘朝向这支手电的程度。
 * 不算阴影（中间有墙的整支记 0，见 writeTorches）
 */
function torchIrradiance(u: GhostUniforms, P: V3n, N: V3n): V3n {
  const H = TORCH.halo, C = TORCH.core;
  const ch = new THREE.Color(PALETTE.torchHalo).multiplyScalar(H.intensity);
  const cc = new THREE.Color(PALETTE.torchCore).multiplyScalar(C.intensity);
  const coreOuter = Math.cos(C.angle), coreInner = Math.cos(C.angle * (1 - C.penumbra));
  let E: V3n = vec3(0, 0, 0);
  for (let i = 0; i < TORCH_COUNT; i++) {
    const tp = u.torchPos[i], td = u.torchDir[i];
    const L = P.sub(tp.xyz);
    const d = length(L);
    const Ld = L.div(max(d, 0.001));
    const cosT = dot(Ld, td.xyz);
    // 没用过的槽 cos 半角是 1：两端不能相等（smoothstep 的两端相等时结果不确定）
    const haloOuter = min(td.w, 0.9999);
    const ah = smoothstep(haloOuter, cos(acos(haloOuter).mul(1 - H.penumbra)), cosT);
    const ac = smoothstep(coreOuter, coreInner, cosT);
    const k = distanceAtt(d, tp.w, TORCH.decay).mul(max(dot(N, Ld.negate()), 0)).mul(u.torchPow[i]);
    E = E.add(vec3(ch.r, ch.g, ch.b).mul(ah).add(vec3(cc.r, cc.g, cc.b).mul(ac)).mul(k)) as V3n;
  }
  return E;
}

/**
 * 同一个公式在 CPU 上算一点（房屋坐标）：给 uReveal 估值用（墙上的影子、墙上多一个影子的判断跟着它走，要和画面一致，
 * 所以近处淡出 GHOST.reveal.near 也乘在这里）。t 是登记表里的一支，los 是平滑过的「中间没有墙」
 */
export function torchRevealAt(t: TorchSample, los: number, x: number, y: number, z: number): number {
  if (t.power <= 0 || los <= 0) return 0;
  const R = GHOST.reveal;
  const lx = x - t.x, ly = y - t.y, lz = z - t.z;
  const d = Math.hypot(lx, ly, lz);
  const cosT = (lx * t.dx + ly * t.dy + lz * t.dz) / Math.max(d, 0.001);
  return smooth01(SEE_COS, lerp(SEE_COS, 1, R.edge), cosT) * (1 - smooth01(SEE_RANGE * R.far, SEE_RANGE, d))
    * smooth01(R.near[0], R.near[1], d) * t.power * los;
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
  m.positionNode = P0.add(inflateDir().mul(layer.inflate)).add(swayAndLean(u, P0, low2));

  // —— 片元 ——
  // 被手电照着的程度（G1）：变浓、轮廓收紧、偏暖
  const R = GHOST.reveal;
  const reveal = torchReveal(u, positionWorld);
  // 朝向镜头的程度：正对镜头 1、轮廓边缘 0（背面也按绝对值算）
  const facing = clamp(abs(dot(normalView, positionViewDirection)), 0, 1);
  const soft = smoothstep(mix(float(layer.soft[0]), float(Math.max(layer.soft[0], R.soft)), reveal), layer.soft[1], facing);
  // 往上飘的烟：模型局部坐标里取噪声，跟着鬼魂走、跟着它转
  const n = smokeNoise(u, positionLocal, layer, false);
  // 侵蚀阈值：越往下摆越高，轮廓附近再高一点（边缘先散成缕）
  const erode = mix(float(layer.erode[0]), float(layer.erode[1]), pow(low, 1.6)).add(float(1).sub(facing).mul(0.22));
  const wisp = smoothstep(erode.sub(0.1), erode.add(0.24), n);
  const hem = smoothstep(0, GHOST.hemFade, h);
  const head = smoothstep(GHOST.head.from, GHOST.head.to, h).mul(GHOST.head.boost).add(1);
  // 浓淡不匀：同一个噪声再调一次身体里的密度
  const cloud = mix(float(GHOST.cloud), float(1), smoothstep(0.25, 0.75, n));
  const dense = role === 'body' ? mix(float(1), float(R.density), reveal) : float(1);
  // 遮蔽（GHOST.occlusion）：兜帽里、褶子深处淡下去（加法混合，淡 = 暗）
  const shade = mix(float(1), occlusion(), GHOST.occlusion.body);
  const alpha = soft.mul(wisp).mul(cloud).mul(hem).mul(head).mul(layer.density).mul(dense).mul(u.fade).mul(shade);
  const c0 = GHOST.edge, c1 = GHOST.core, cw = R.warmColor;
  m.colorNode = mix(mix(vec3(c0.r, c0.g, c0.b), vec3(c1.r, c1.g, c1.b), soft), vec3(cw.r, cw.g, cw.b), reveal.mul(R.warm));
  m.opacityNode = alpha;
  // 不用 particles/common.ts 的 protectMRT：现在场景 pass 没有 MRT，它保护不了什么；后处理建不起来、直接画到画布时
  // 它会让管线编不过（输出结构体是空的），鬼魂整个不见
  return m;
}

/**
 * 现身停留时「实」的那份（G2，参数见 GHOST.solid）：普通混合、暗、挡光、写深度，只画正面；不飘、不拖，头绕脖子转 u.head；
 * 侵蚀噪声的时间降到每秒 stepRate 次（u.step = 1 时，G3）。和身体同一个网格、同一套 uniform，任何网格都能用。
 * 不受光照：被手电照到的那一面是按登记表和手电的参数自己算的漫反射（torchIrradiance；灯的数量变了也不重编）
 */
export function createGhostSolidMaterial(u: GhostUniforms, look: GhostLook): THREE.MeshBasicNodeMaterial {
  const S = GHOST.solid, L = GHOST.body;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: true, depthTest: true, blending: THREE.NormalBlending, side: THREE.FrontSide, fog: false,
  });
  m.lights = false;
  const span = look.top - look.bottom;
  const P0 = positionLocal;
  const h = clamp(P0.y.sub(look.bottom).div(span), 0, 1);
  const low = float(1).sub(h);

  // —— 顶点：不飘、不拖；头那一段绕脖子转 ——
  m.positionNode = headPose(u, look, P0, h);

  // —— 片元 ——
  const facing = clamp(abs(dot(normalView, positionViewDirection)), 0, 1);
  const soft = smoothstep(S.soft[0], S.soft[1], facing);
  const n = smokeNoise(u, positionLocal, L, true);
  const erode = mix(float(S.erode[0]), float(S.erode[1]), pow(low, 1.6)).add(float(1).sub(facing).mul(0.22));
  const wisp = smoothstep(erode.sub(0.1), erode.add(0.24), n);
  const hem = smoothstep(0, S.hemFade, h);
  m.opacityNode = soft.mul(wisp).mul(hem).mul(S.opacity).mul(u.fade).mul(u.solid);
  // 写深度（V-M1，见 GHOST.solid.depthCut）：不透明度不到门槛的片元丢掉（alpha ≤ 门槛就丢），不写深度。门槛和不透明度乘同样的
  // opacity × fade × solid，丢不丢只看形状；uSolid = 0（平时藏着，main.ts 暖机那几帧显示出来编管线）时门槛、不透明度都是 0，
  // 整个丢掉，什么深度都不留，不挡身体、雾晕和冷雾
  m.alphaTestNode = u.solid.mul(u.fade).mul(S.opacity * S.depthCut);
  // 颜色：原来的冷白压暗（没被照着时是暗色剪影）；被手电照到的那一面按真的手电算漫反射（一件 albedo 这么暗的长袍）
  const c0 = GHOST.edge, c1 = GHOST.core;
  const base = mix(vec3(c0.r, c0.g, c0.b), vec3(c1.r, c1.g, c1.b), soft).mul(u.solidDark);
  // 遮蔽（GHOST.occlusion）连手电照的那一面一起压：兜帽洞里照不进去（没有自阴影，靠它近似）
  const shade = mix(float(1), occlusion(), GHOST.occlusion.solid);
  m.colorNode = base.add(torchIrradiance(u, positionWorld, normalWorld).mul(S.albedo / Math.PI)).mul(shade);
  return m;
}

/**
 * 墙上的影子（L2，参数见 GHOST.shadow）：只在阴影 pass 里用到它的 positionNode 和 maskShadowNode（网格放在 GHOST_SHADOW_LAYER，
 * 主画面不画）。形状：平时的飘动、下摆拖，现身时换成头转的那个姿势（u.solid）；丢掉的：侵蚀噪声蚀掉的边、下摆、没被照着时整个
 */
export function createGhostShadowMaterial(u: GhostUniforms, look: GhostLook): THREE.MeshBasicNodeMaterial {
  const B = GHOST.body, S = GHOST.solid, Sh = GHOST.shadow;
  const m = new THREE.MeshBasicNodeMaterial({ colorWrite: false, depthWrite: false });
  m.lights = false;
  const span = look.top - look.bottom;
  const P0 = positionLocal;
  const h = clamp(P0.y.sub(look.bottom).div(span), 0, 1);
  const low = float(1).sub(h);
  m.positionNode = mix(P0.add(swayAndLean(u, P0, low.mul(low))), headPose(u, look, P0, h), u.solid);
  const n = smokeNoise(u, positionLocal, B, true);
  const lowK = pow(low, 1.6);
  const erode = mix(mix(float(B.erode[0]), float(B.erode[1]), lowK), mix(float(S.erode[0]), float(S.erode[1]), lowK), u.solid);
  // u.shadow = 0 时阈值 2（噪声最大 1）：整个丢掉；往 1 走时从噪声最浓的地方开始出现
  m.maskShadowNode = n.greaterThan(mix(float(2), erode, u.shadow)).and(h.greaterThan(Sh.hemCut));
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

// ───────────────────────── 换模型（config/ghost.ts 的 GHOST_MODEL） ─────────────────────────

/**
 * 加载好的鬼魂模型，交给 createGhostView（fx.model）换掉程序化的外形。坐标都已经是鬼魂的局部坐标
 * （y 向上、正面 +z、米，头顶 GHOST_BODY.top、下摆 GHOST_BODY.bottom），所以材质、GhostLook 和程序化的那个一样
 */
export interface GhostModel {
  /** 不动的网格合成的一个几何体（只留 position、normal、occl、inflate）；没有就是 null */
  geometry: THREE.BufferGeometry | null;
  /** 带骨骼的（GHOST_MODEL.animated）：摆好的模型（骨骼在里面，挂到鬼魂身上跟着走）、要换材质的蒙皮网格、现身时播的片段 */
  root: THREE.Object3D | null;
  skinned: THREE.SkinnedMesh[];
  clip: THREE.AnimationClip | null;
  look: GhostLook;
  /** 现身停留时头从哪抬到哪（GHOST_MODEL.headPitch；null = 用 GHOST.solid.headPitch） */
  headPitch: [number, number] | null;
}

/**
 * 按 GHOST_MODEL 加载鬼魂模型；url 为 null 时直接返回 null（用程序化的）。main.ts 在 createGhostView 之前 await 它。
 * 按包围盒缩放到 GHOST_BODY 的高度、x / z 居中（有片段时先摆成片段的第一帧再量：绑骨的 T 字姿势两臂会把包围盒撑宽）。
 * 原来的网格藏起来，只留骨骼；不动的网格烘进鬼魂的局部坐标合成一个，蒙皮网格交给 createGhostView 重新绑在鬼魂身上
 */
export async function loadGhostModel(spec: typeof GHOST_MODEL = GHOST_MODEL): Promise<GhostModel | null> {
  if (!spec.url) return null;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(spec.url);
  const scene = gltf.scene;
  const clip = spec.animated && spec.clip ? THREE.AnimationClip.findByName(gltf.animations, spec.clip) : null;
  if (spec.animated && spec.clip && !clip) {
    console.warn(`[ghost] GHOST_MODEL.clip = '${spec.clip}'，GLB 里没有这个片段。现有：${gltf.animations.map((c) => c.name).join(', ') || '（无）'}`);
  }
  const poser = clip ? new THREE.AnimationMixer(scene) : null;
  if (poser && clip) {
    poser.clipAction(clip).play();
    poser.update(0);
  }
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, poser !== null);
  poser?.stopAllAction();
  if (poser) poser.uncacheRoot(scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const k = size.y > 1e-6 ? (GHOST_BODY.top - GHOST_BODY.bottom) / size.y : 1;
  const root = new THREE.Group();
  root.name = 'ghost-model';
  root.add(scene);
  root.scale.setScalar(k);
  root.position.set(-center.x * k, GHOST_BODY.bottom - box.min.y * k, -center.z * k);
  root.updateMatrixWorld(true);

  const statics: THREE.Mesh[] = [];
  const skinned: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if ((m as THREE.SkinnedMesh).isSkinnedMesh && spec.animated) skinned.push(m as THREE.SkinnedMesh);
    else statics.push(m);
    m.visible = false;
    m.castShadow = false;
  });
  // 不动的网格：位置、法线烘进鬼魂的局部坐标（root 就是鬼魂的局部坐标系，挂在 figure 下面时 root 自己的变换已经算进来了）
  let geometry: THREE.BufferGeometry | null = null;
  if (statics.length) {
    const parts = statics.map((m) => {
      const src = m.geometry;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position').clone());
      if (src.getAttribute('normal')) g.setAttribute('normal', src.getAttribute('normal').clone());
      g.setIndex(src.index ? src.index.clone() : Array.from({ length: src.getAttribute('position').count }, (_, i) => i));
      g.applyMatrix4(m.matrixWorld);
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      // 遮蔽、雾晕外扩方向（ensureGhostAttributes）：几个网格合并时属性要一样，没带的补上；外扩方向和法线一样跟着转
      const inflate = src.getAttribute('_inflate') as THREE.BufferAttribute | undefined;
      if (inflate) g.setAttribute('_inflate', inflate.clone().applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(m.matrixWorld)));
      const occl = src.getAttribute('_occl') ?? src.getAttribute('color');
      if (occl) g.setAttribute('_occl', occl.clone());
      ensureGhostAttributes(g);
      g.deleteAttribute('_inflate');
      g.deleteAttribute('_occl');
      return g;
    });
    geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    if (parts.length > 1) for (const g of parts) g.dispose();
    geometry?.computeBoundingSphere();
  }
  console.log(`[ghost] ${spec.url}：缩放 ${k.toPrecision(3)}，不动的网格 ${statics.length} 个，蒙皮网格 ${skinned.length} 个${clip ? `，片段 ${clip.name}` : ''}`);
  return {
    geometry, root: skinned.length ? root : null, skinned, clip: skinned.length ? clip : null,
    look: { bottom: GHOST_BODY.bottom, top: GHOST_BODY.top },
    headPitch: spec.headPitch ?? null,
  };
}

/**
 * 带动画的鬼魂模型的片段：时间自己管，pose(t) 把姿势摆到片段的第 t 秒（小于 0 当 0，超过片段长度停在最后一帧）。
 * action 一直开着、暂停着，每次直接写 action.time 再 mixer.update(0)（暂停时只按 action.time 求值、不往前走）。
 * 不用 LoopOnce + clampWhenFinished：播到头 three 会把 action 暂停，mixer.setTime 只把时间清零、不清暂停，
 * 之后每一帧都在第 0 秒求值——当场弹回第一帧，以后每次现身都不再动（2026-10-29 评审 I2，见 tests/ghost-clip.test.ts）
 */
export function createGhostClip(root: THREE.Object3D, clip: THREE.AnimationClip) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  action.paused = true;
  const pose = (t: number) => {
    action.time = Math.min(Math.max(t, 0), clip.duration);
    mixer.update(0);
  };
  pose(0);
  return {
    pose,
    /** 此刻摆在片段的第几秒（调试用） */
    get time() { return action.time; },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}

// ───────────────────────── 挡住访客时淡下去（FEEL-5，参数见 GHOST.occlude） ─────────────────────────
// 下面几个都是不依赖渲染的纯函数（tests/ghost-occlude.test.ts）：投影矩形、重叠比例、平滑、挑哪些访客

/** 屏幕上的矩形（像素，y 向下） */
export interface Rect { x0: number; y0: number; x1: number; y1: number }
/** 房屋坐标 (x, z)、离地高度 y → 屏幕像素；点在镜头背后时是 NaN（GhostRig.toScreen 的样子，参数拆开了） */
export type CoverProject = (x: number, z: number, y: number) => { x: number; y: number };
/** 挡人只看访客的位置和模式（NpcState 的子集） */
export interface CoverNpc { pos: Vec2; mode: string }

/** 把投影点包成矩形；没有点、或有一个点在镜头背后（NaN）就没有矩形 */
export function rectOf(pts: readonly { x: number; y: number }[]): Rect | null {
  if (!pts.length) return null;
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    r.x0 = Math.min(r.x0, p.x);
    r.y0 = Math.min(r.y0, p.y);
    r.x1 = Math.max(r.x1, p.x);
    r.y1 = Math.max(r.y1, p.y);
  }
  return r;
}

/** 访客的矩形 b 被鬼魂的矩形 a 盖住多少：重叠面积 ÷ b 的面积，0..1（b 没有面积 = 0） */
export function rectOverlap(a: Rect, b: Rect): number {
  const area = (b.x1 - b.x0) * (b.y1 - b.y0);
  if (!(area > 0)) return 0;
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? Math.min(1, (w * h) / area) : 0;
}

/** 水平方向左右各 half 米（right 是镜头右方向的水平单位向量）、竖直方向 y0..y1 米的一个方框，四个角投到屏幕上取包围矩形 */
function boxRect(project: CoverProject, at: { x: number; z: number }, right: Vec2, half: number, y0: number, y1: number): Rect | null {
  const pts: { x: number; y: number }[] = [];
  for (const sx of [-1, 1]) for (const y of [y0, y1]) pts.push(project(at.x + right.x * half * sx, at.z + right.z * half * sx, y));
  return rectOf(pts);
}

/** 鬼魂的屏幕矩形（GHOST.occlude.ghostBox） */
export function ghostCoverRect(project: CoverProject, g: { x: number; z: number }, right: Vec2): Rect | null {
  const B = GHOST.occlude.ghostBox;
  return boxRect(project, g, right, B.half, B.y[0], B.y[1]);
}

/** 访客的屏幕矩形（GHOST.occlude.visitorBox）：脚到 CHARACTER.targetHeight + top 米 */
export function visitorCoverRect(project: CoverProject, pos: Vec2, right: Vec2): Rect | null {
  const B = GHOST.occlude.visitorBox;
  return boxRect(project, pos, right, B.half, 0, CHARACTER.targetHeight + B.top);
}

/** 重叠比例 → 挡住的程度 0..1：from 以下算没挡（只擦到一点），to 以上算全挡，中间 smoothstep */
export function coverOf(overlap: number): number {
  const O = GHOST.occlude;
  return smooth01(O.from, O.to, overlap);
}

/** 挡住的程度往目标走一步（指数逼近）：往上走（挡住了，鬼魂要淡）用 in 秒的时间常数，往下走（让开了）用 out 秒；dt ≤ 0 不动，不过冲 */
export function approachCover(cur: number, target: number, dt: number): number {
  if (!(dt > 0)) return cur;
  const tau = target > cur ? GHOST.occlude.in : GHOST.occlude.out;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/** 挡住时鬼魂留下多少：平时 alpha，现身的实体 solid，正被手电照着 revealed；又是实体又被照着取大的 */
export function occludeK(solid: boolean, lit: boolean): number {
  const O = GHOST.occlude;
  return Math.max(solid ? O.solid : O.alpha, lit ? O.revealed : 0);
}

export interface CoverInput {
  project: CoverProject;
  /** 镜头的位置（房屋坐标，只用水平的） */
  cam: { x: number; z: number };
  /** 镜头的右方向（房屋坐标里的水平单位向量） */
  right: Vec2;
  ghost: { x: number; z: number };
  npcs: readonly CoverNpc[];
}

/**
 * 鬼魂挡住访客的程度 overlap（0..1）：比鬼魂离镜头更远、range 米以内、没走（gone）的访客里，离镜头最近的 people 个，
 * 各自被鬼魂的矩形盖住的比例，取最大的。吓跑的人照样算（吓跑那一下正是要看清他的时候）。鬼魂在镜头背后没有矩形 = 0
 */
export function overlapOfGhost(c: CoverInput): number {
  const O = GHOST.occlude;
  const gr = ghostCoverRect(c.project, c.ghost, c.right);
  if (!gr) return 0;
  const dGhost = Math.hypot(c.ghost.x - c.cam.x, c.ghost.z - c.cam.z);
  const cands: { n: CoverNpc; d: number }[] = [];
  for (const n of c.npcs) {
    if (n.mode === 'gone') continue;
    const d = Math.hypot(n.pos.x - c.cam.x, n.pos.z - c.cam.z);
    if (d > dGhost && d <= O.range) cands.push({ n, d });
  }
  cands.sort((a, b) => a.d - b.d);
  let best = 0;
  for (const { n } of cands.slice(0, O.people)) {
    const vr = visitorCoverRect(c.project, n.pos, c.right);
    if (vr) best = Math.max(best, rectOverlap(gr, vr));
  }
  return best;
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

/** lightfx 的选项：会自己演闪烁的灯（台灯）不跟着这一下（见 manifestLights） */
const SKIP_OWNED = { skipOwned: true } as const;

/**
 * 现身的每个阶段让附近的灯做什么（GHOST.manifest）。onManifest 照它调，tests 的灯闪检查也走它，调用的顺序和选项不另抄一份：
 * - windup：按 windup 的节奏闪 MANIFEST.windup 秒；
 * - drop：暗一下（drop），接着压在 hold 这一档；返回放开它的函数（收的时候调，holdSlack 秒是兜底）；
 * - end：再暗一下（end）。
 * 蓄力、收这两下带 skipOwned：台灯（会自己演附身、复原的闪）不跟着暗，收的时候直接放开。不然台灯的附身、复原和附近的现身前后脚接上时
 * （附身之前刚跟着蓄力暗了两下；复原刚闪完两下就接上蓄力），任意 1 秒会暗到 4–5 下（2026-10-29 最终审查 I1）。
 * 落下、停留照旧压台灯（换材质那一下整片暗下去）。代价：蓄力那 0.6 秒里台灯不再跟着暗两下，门廊灯、手电照旧
 */
export function manifestLights(lights: LightFx, phase: Extract<SimEvent, { type: 'manifest' }>['phase'], pos: Vec2): (() => void) | null {
  const M = GHOST.manifest;
  if (phase === 'windup') {
    lights.pulse(pos, M.radius, M.windup, MANIFEST.windup, SKIP_OWNED);
    return null;
  }
  if (phase === 'drop') {
    lights.dipAll(pos, M.radius, M.drop.depth, M.drop.ms);
    return lights.pulse(pos, M.radius, M.hold, MANIFEST.hold + M.holdSlack);
  }
  lights.dipAll(pos, M.radius, M.end.depth, M.end.ms, SKIP_OWNED);
  return null;
}

/**
 * 现身时要借的另外两个模块（main.ts 建好、放进 modules，再传进来）：灯闪（lightfx.ts）、地上的霜（frost.ts）。
 * 没给的那个就不做：没有灯闪时落下、收不等暗下去，事件一到就换材质
 */
export interface GhostFx {
  lights?: LightFx | null;
  frost?: Frost | null;
  /** 换掉程序化外形的模型（loadGhostModel 的结果；null = 用程序化的） */
  model?: GhostModel | null;
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
  // 外形：没换模型就是程序化的人形；换了模型（loadGhostModel）就是它合成的那个不动的几何体，加上每个蒙皮网格。
  // 坐标都是鬼魂的局部坐标，GhostLook 一样，材质大家共用
  const model = fx.model ?? null;
  const look: GhostLook = model?.look ?? { bottom: GHOST_BODY.bottom, top: GHOST_BODY.top };
  const ownGeometry = model ? null : buildGhostGeometry();
  const parts: { geometry: THREE.BufferGeometry; skin: THREE.SkinnedMesh | null }[] = [
    ...(ownGeometry ? [{ geometry: ownGeometry, skin: null }] : []),
    ...(model?.geometry ? [{ geometry: model.geometry, skin: null }] : []),
    ...(model?.skinned ?? []).map((s) => ({ geometry: s.geometry, skin: s })),
  ];
  // 材质都读 occl、inflate（ensureGhostAttributes）：程序化的人形、蒙皮网格没有就补上
  for (const p of parts) ensureGhostAttributes(p.geometry);
  // 身体双面（背面叠在正面后面：中间厚、边上薄）；雾晕只画正面
  const bodyMat = createGhostMaterial(u, look, GHOST.body, THREE.DoubleSide);
  const hazeMats = GHOST.haze.map((l) => createGhostMaterial(u, look, l, THREE.FrontSide, 'haze'));
  const solidMat = createGhostSolidMaterial(u, look);
  const shadowMat = createGhostShadowMaterial(u, look);
  const figure = new THREE.Group();
  figure.name = 'ghost-figure';
  // 带骨骼的模型：骨骼挂在鬼魂身上跟着走（原来的网格已经藏起来了）
  if (model?.root) figure.add(model.root);
  /**
   * 一份网格。蒙皮网格重新绑在原来的骨骼上、直接挂在 figure 下面（attached 模式下位置只看骨骼）：
   * 着色器里的局部坐标就是鬼魂的局部坐标，和程序化的一样
   */
  const make = (p: (typeof parts)[number], mat: THREE.Material, name: string) => {
    let m: THREE.Mesh;
    if (p.skin) {
      const s = new THREE.SkinnedMesh(p.geometry, mat);
      s.bind(p.skin.skeleton, p.skin.bindMatrix);
      m = s;
    } else m = new THREE.Mesh(p.geometry, mat);
    m.name = name;
    m.castShadow = false;
    m.receiveShadow = false;
    // 顶点着色器会飘、会拖，包围球按静止的算不准；只有一个人影，不剔除也不费事
    m.frustumCulled = false;
    figure.add(m);
    return m;
  };
  const bodies: THREE.Mesh[] = [];
  const hazes: THREE.Mesh[] = [];
  const solids: THREE.Mesh[] = [];
  const shadows: THREE.Mesh[] = [];
  parts.forEach((p, i) => {
    const sfx = parts.length > 1 ? `-${i}` : '';
    const body = make(p, bodyMat, `ghost-body${sfx}`);
    body.renderOrder = GHOST.renderOrder;
    bodies.push(body);
    hazeMats.forEach((mat, k) => {
      const h = make(p, mat, `ghost-haze-${k}${sfx}`);
      h.renderOrder = GHOST.renderOrder + (k + 1) * 0.01;
      hazes.push(h);
    });
    // 现身停留时换上的「实」的那份（G2）：同一个网格。平时藏着；不进开场那次阻塞的预编译，
    // main.ts 在开场按钮可用之后再编（那几帧里 uSolid = 0，片元全丢，不画也不写深度），第一次现身时不卡。
    // 普通混合、写深度，画在冷雾（renderOrder − 0.05）之前：往下淌的雾落在它前面时盖得住，身后的雾被深度挡住（V-M1）
    const sm = make(p, solidMat, `ghost-solid${sfx}`);
    sm.visible = false;
    sm.userData.deferCompile = true;
    sm.renderOrder = GHOST.renderOrder - 0.1;
    solids.push(sm);
    // 墙上的影子（L2）：只进手电的阴影图（GHOST_SHADOW_LAYER），没被照着时着色器里整个丢掉。一直可见、不剔除：
    // 开场第一帧每支手电都画一次阴影图（flashlight.ts 的 needsUpdate），它的阴影管线在那时就编好，第一次被照到时不卡
    const sh = make(p, shadowMat, `ghost-shadow${sfx}`);
    sh.layers.set(GHOST_SHADOW_LAYER);
    sh.castShadow = true;
    shadows.push(sh);
  });
  root.add(figure);
  // 带动画的模型：现身停留时播 clip（时间按 1 / stepRate 秒取整，片段比停留短时停在最后一帧），平时和每次现身开始时都在第一帧
  const clipPose = model?.root && model.clip ? createGhostClip(model.root, model.clip) : null;

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

  // —— 挡住访客时淡下去（FEEL-5，GHOST.occlude）：这一帧鬼魂挡住访客的重叠比例、平滑后的挡住程度、平滑后「挡住时留下多少」——
  const project: CoverProject = (x, z, y) => rig.toScreen({ x, z }, y);
  const camRight = new THREE.Vector3();
  const rightH: Vec2 = { x: 1, z: 0 };
  let overlapNow = 0;
  let coverS = 0;
  let kS: number = GHOST.occlude.alpha;

  const setSolid = (on: boolean, t: number, byState = false) => {
    solid = on;
    solidByState = on && byState;
    if (on) solidSince = t;
    u.solid.value = on ? 1 : 0;
    u.step.value = on ? 1 : 0;
    for (const m of bodies) m.visible = !on;
    for (const m of hazes) m.visible = !on;
    for (const m of solids) m.visible = on;
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

  /** 现身事件：蓄力时灯闪、霜往外长；落下、收的时候灯暗一下，暗到最深的那一帧换材质（见 GHOST.manifest；灯怎么闪见 manifestLights） */
  const onManifest = (e: Extract<SimEvent, { type: 'manifest' }>) => {
    const M = GHOST.manifest;
    const lights = fx.lights ?? null;
    if (e.phase === 'windup') {
      if (lights) manifestLights(lights, 'windup', e.pos);
      fx.frost?.grow(e.pos, M.frost, MANIFEST.windup);
    } else if (e.phase === 'drop') {
      holdRelease?.();
      holdRelease = lights ? manifestLights(lights, 'drop', e.pos) : null;
      swap = { to: true, delay: lights ? (M.drop.ms / 1000) * M.swapAt : 0, at: NaN };
    } else {
      holdRelease?.();
      holdRelease = null;
      if (lights) manifestLights(lights, 'end', e.pos);
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
        overlap: +overlapNow.toFixed(3), cover: +coverS.toFixed(3), occK: +kS.toFixed(3),
        clipTime: clipPose ? +clipPose.time.toFixed(3) : null, clipDuration: model?.clip ? +model.clip.duration.toFixed(3) : null,
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
      // 模型自己低着头时（GHOST_MODEL.headPitch）抬到它自己的姿势之上，才看得出在抬头看人
      const HP = model?.headPitch ?? GHOST.solid.headPitch;
      // 带动画的模型：抬头交给它自己的片段（同样按取整后的时间播），着色器里不再转头
      u.head.value = solid && !clipPose ? lerp(HP[0], HP[1], smooth01(0, MANIFEST.hold, heldQ)) : 0;
      clipPose?.pose(solid ? heldQ : 0);
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
      // 挡住访客时自己淡下去（FEEL-5）：鬼魂的屏幕矩形盖住了比它离镜头更远的访客多少，盖得多就乘一个小于 1 的数；
      // 现身的实体留一半、正被手电照着（上一帧的 revealNow）留多一点，k 自己的切换也平滑，不跳
      const npcs = (ctx.state as Partial<WorldState>).npcs;
      if (npcs && npcs.length) {
        camRight.setFromMatrixColumn(rig.camera.matrixWorld, 0);
        const rl = Math.hypot(camRight.x, camRight.z) || 1;
        rightH.x = camRight.x / rl;
        rightH.z = camRight.z / rl;
        overlapNow = overlapOfGhost({ project, cam: camPos, right: rightH, ghost: g, npcs });
      } else overlapNow = 0;
      coverS = approachCover(coverS, coverOf(overlapNow), dt);
      if (dt > 0) kS += (occludeK(solid, revealNow > GHOST.occlude.lit) - kS) * (1 - Math.exp(-dt / GHOST.occlude.out));
      u.fade.value = lerp(GHOST.minAlpha, 1, near) * lerp(1, kS, coverS) * (solid ? 1 : breathe * lerp(1, follow, M.follow));

      // 手电照出（houseRoot 的世界矩阵上面已经更新过）；墙上的影子跟着被照出的程度出现，现身时整个都在
      writeTorches(dt);
      u.shadow.value = solid ? 1 : smooth01(GHOST.shadow.on[0], GHOST.shadow.on[1], revealNow);

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
      for (const p of parts) p.geometry.dispose();
      for (const m of [bodyMat, ...hazeMats, solidMat, shadowMat]) m.dispose();
      clipPose?.dispose();
      mist.mat.dispose();
    },
  };
}
