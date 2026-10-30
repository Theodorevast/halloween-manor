// 地面薄雾：贴着地板、齐膝高的一层冷灰色薄雾，慢慢飘，墙根墙角和屋外更浓；手电、台灯照到的地方雾会亮起来。
//
// 做法：只画一层。一张覆盖房子 + 屋外一圈的水平网格放在雾顶（FOG.top，低于降低后的墙顶 0.5 米），不受光照。
// 片元里读场景深度，算出视线从雾顶进来、到碰上地板 / 墙面 / 家具 / 人为止在雾里走了多远，
// 按「密度随高度指数衰减」解析积分出不透明度。这样：
// - 墙脚、家具脚、人的腿和雾的交界连续地变淡，没有横切的硬边（几张叠起来的雾片会像卡片插在墙里）；
// - 雾顶低于所有墙顶，墙顶永远露在雾上面，平面图看得清；深度跟着镜头走，四个方向一样。
// - 娃娃屋的正交相机和第三人称的透视相机都要对：视线方向（正交处处相同，透视逐顶点从相机发散）、深度换算、
//   沿视线的距离都按 persp 这个 uniform 在两种算法之间选，每次画之前按这一次的相机设（同一份着色器，不重编）。
//   第三人称从齐眼高度斜着看，远处的地面视线贴着雾走得很长，雾自然变浓；镜头近处的雾按距离变薄，脚下的地板看得清（FOG.near）
// 性能（场景是填充率瓶颈：约 14 盏灯，每个像素都要算一遍）：
// - 噪声、密度、光照全在顶点着色器里算（high 0.15 米一格，约 3 万个顶点），片元只读一次深度、做几次乘加；
// - 光不走 three 的灯光系统：每帧从场景里读出最多 4 支手电（每支两层光锥）和 4 盏点光（台灯、门廊灯、镜子的闪光），
//   当 uniform 传进来，在顶点上按 three 同样的衰减公式算散射；
// - 手电在雾里不能穿墙：每支手电每帧在格子地图上打 8 条射线，量出光锥里每个方向离最近的墙多远，顶点按这个截断。
// 扰动（附身带起的冷风、厨房门的气浪、八音盒的回旋、现身落下的气浪）：最多 DRAFT.slots 个，每个是几个 uniform，
// 在同一个顶点着色器里改噪声的取样点和密度，不加 draw call（见 DRAFT 和 draftField）。
// 娃娃屋（俯视）里屋外那圈雾压淡（FOG.topDown）：每个顶点存一个「屋外程度」，着色器按相机是正交还是透视选压不压。
import * as THREE from 'three/webgpu';
import {
  abs, attribute, cameraFar, cameraNear, clamp, cos, dot, exp, float, floor, length, max, min, mix, mx_noise_float,
  normalize, orthographicDepthToViewZ, perspectiveDepthToViewZ, positionLocal, positionView, sin, smoothstep, sqrt,
  uniform, varying, vec3, viewportDepthTexture,
} from 'three/tsl';
import {
  CELL, DOORWAYS, FRONT_DOOR, GRID_H, GRID_W, HOUSE_D, HOUSE_W, PROPS, ROOMS, Tile, WALL_CUT_H, WALL_T, buildTiles, idx, inGrid,
  propCenter, roomAt, type RoomId,
} from '../config/house';
import type { CameraRig, FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import type { SimEvent, Vec2 } from '../sim/types';
import { PALETTE } from './palette';
import { DOOR_T_LINE } from './props/door';
import { inOutSine, outCubic, outQuad, seg } from './props/kit';
import { MUSIC_BOX_T } from './props/musicBox';

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
  /**
   * 娃娃屋（俯视、正交相机）里屋外那圈雾压淡（第二波 ART-10）：屋外是一大片深蓝斑驳的云纹，是俯视画面里最花的东西，抢房子
   * （手机就是这个画面；关掉雾它就没了）。每个顶点存一个 outsideMix = smooth(0, ramp, 离房子外沿的米数)：0 屋里、1 屋外。
   * dim：俯视时屋外的密度乘这个；detail：俯视时屋外第二层细噪声的权重（原来 noise[1].weight）。
   * 第三人称（透视相机）不变：门外的雾照旧，天亮的晨雾也照旧；屋里的雾和光（台灯、手电光斑）不变。
   * 天亮时（雾的环境色 u.ambient 比夜里亮 lift 倍，见 topDownDim）屋外那一项照样成立：密度再除以 lift，屋外的雾「贴上去的亮度」
   * （密度 × 环境色）和夜里一样，不会因为晨雾被天光照亮、屋外那圈云纹在俯视里反而更显眼（屋外的底色天亮时也变亮，反差只会更小）
   */
  topDown: { dim: 0.55, detail: 0.2, ramp: 1 },
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
   * 视线俯角的正弦最小按这个算：贴着地面的视线在雾里走得无限长，不夹的话远处一片死白；
   * 也限制了「雾顶的顶点 → 取样点」的距离（(top − sampleY) / minSin）。娃娃屋镜头俯角 35°（0.57），碰不到
   */
  minSin: 0.2,
  /**
   * 第三人称（透视相机）时的调整。镜头离地约 2 米、几乎平视（ghostRig.ts：俯 4°、竖直视角 60°），
   * 看到的地面大多是 0.1–0.4 的掠射角，同样的雾按俯视调的密度会在 5 米外连成一片发白的雾板，地板、访客的脚都看不见。
   * 所以：密度乘 density，最浓不超过 maxAlpha，掠射角最小按 minSin 算（光程最多是俯视时的 1.9 倍）。
   * 娃娃屋（正交相机）照旧用上面的值
   */
  eye: { density: 0.7, maxAlpha: 0.45, minSin: 0.3 },
  /**
   * 离镜头近的雾变薄：雾顶上的点离镜头 from 米以内只剩 thin 倍的密度，到 to 米恢复。
   * 第三人称鬼魂脚下、身边的地板要看得清；娃娃屋镜头在 40 米外，不受影响
   */
  near: { from: 1.2, to: 4.5, thin: 0.35 },
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

/** 气浪（DRAFT.slam / DRAFT.manifest）的参数：字段的意思见 DRAFT.slam */
export interface WaveParams {
  reach: number; time: number; width: number; spread: number; compress: number; trough: number; push: number; start: number; stir: number;
}

/**
 * 雾里的扰动。每个扰动占一个槽（满了顶掉最老的），CPU 每帧按年龄算出各项强度，顶点着色器只按距离套形状：
 * - 旋（swirl，弧度）：以物件为中心把噪声的取样点转一个角度，中心转得多、边上不转，雾团被拧成旋涡；
 * - 推（push）：取样点往中心收，雾的花纹往外扩，像被一股气推开；推的量退回去时雾跟着流回来；
 * - 薄（thin）：密度降下来；回填时变薄的半径从外往里收（雾从四周流回来）；
 * - 气浪（ring）：一圈往外走的波前，波前上的雾被挤浓、往外推，波前后面变薄。
 * 扰动只作用在物件所在的房间（厨房门：厨房 + 走廊），不会穿墙影响隔壁。
 * 半径、宽度都不小于低档网格（0.4 米一格）能采出来的尺度。时间都从附身那一刻（trigger 事件）算起；
 * 现身落下的那一圈（manifest）不按物件、按鬼魂的位置，作用在它所在的房间（门洞里是两边），从 manifest drop 事件那一刻算起
 */
export const DRAFT = {
  slots: 4,
  /**
   * 附身（台灯、摇椅、肖像、镜子）：鬼钻进物件带起一股冷风。attack 秒内雾被推开、变薄，
   * 旋涡在 twistAt 秒拧到最紧；停 hold 秒后 refill 秒里慢慢流回来、旋涡松开
   */
  possess: { radius: 1.7, thin: 0.72, swirl: 1.25, push: 0.32, attack: 0.25, twistAt: 0.7, hold: 0.3, refill: 2.4 },
  /**
   * 厨房门撞上门框（DOOR_T_LINE.slam）：一圈气浪在 time 秒里推到 reach 米外（先快后慢）。
   * width 是波前的半宽（走得越远越宽，见 spread）；compress 是波前上雾变浓的比例，trough 是波前后面变薄的比例；
   * push 是雾被推走的距离（米），气浪过去后慢慢退回；stir 是波前上把雾撕成缕的程度；start 是波前的起始半径（半个门洞）
   */
  slam: { reach: 4.2, time: 1.8, width: 0.45, spread: 1.3, compress: 1.6, trough: 0.6, push: 0.45, start: 0.35, stir: 0.8 } as WaveParams,
  /**
   * 现身落下（ghost.ts 的 manifest drop 事件，第二波 ART-6）：玩家最重的一下，齐膝的雾不能纹丝不动（厨房门都能推开一圈）。
   * 和 slam 同一种气浪，更小更快：一圈波前从鬼魂脚下（start 是身宽的一半）在 time 秒里推到 reach 米外（先快后慢，落下后 0.4 秒约 2 米），
   * 波前上的雾被挤浓 compress（trough / compress 的比例、stir 都是这一种自己的，见 draftField 的 wave 槽）。
   *
   * 这一圈不能让任何一点的亮度多暗一下（修复第 1 轮，主会话定的）：全局约束是任意 1 秒最多暗 3 下，叠加、前后接上都算，
   * 而现身这一串灯（蓄力 2 下 + 落下 1 下）已经把额度用满，雾再暗一下就是第 4 下。最严的口径是灯的亮度 × 雾的亮度逐点相乘
   * （lightfx 的 countDips：从高点掉 0.1 以上算一下）。美术总监原定的数是 { width 0.35, compress 1.35, trough 0.5, push 0.3, stir 0.6 }：
   * 波前过去以后雾变薄（trough）、挤浓的波前退回原样（compress），逐点落差有 0.3–0.8，在波前扫过的 0.6–2.3 米那一圈最坏 4 下。现在的值：
   * - trough 0：不变薄。波前过去以后「薄一下」就是那一点亮度的一次落差；
   * - compress 0.25：波前上浓一点，浓是升、不算暗，但波前走远以后它退回原样是一次落差，落差 × 灯压着的 42% 要小于 0.08（countDips 的 0.1 留一点余量），
   *   也就是雾的亮度最多掉 0.08 / 0.42 ≈ 0.19 左右（幅度还随 (1 − u)^1.5 衰减，早到的点落在灯自己暗下去、回升的那 0.15 秒里，落差被它吃掉一部分）；
   *   把噪声场、取样点位移都算进去（tests/fogField.ts）逐点数：0.3 在 0.07 的门槛上就有曲线多出一下，0.25 在 0.07 和 0.08 两个门槛上都是 0；
   * - push 0.06 米：气浪把噪声的取样点往外推，雾的花纹跟着挪，花纹的边挪过一个点时那一点的亮度也会落（算在逐点相乘里）。
   *   0.1 米是极限（0.15 米就有云边上的点多出一下），留余量取 0.06；
   * - width 0.7：幅度被压小以后，波前宽一点才看得见（面积大），也让波前上亮度的变化更平缓；stir 0.3：缕的撕开量跟着幅度走，小一点。
   * 圈只靠「波前上雾浓一点 + 花纹被推着走一点」读出来，很淡；宁可淡也不能多暗一下（tests/fog-ring.test.ts 用真的灯闪序列逐点数，门槛 0.08）。
   * 没有「滞后」：事件到的那一刻就出发（slam 要等门撞上门框 DOOR_T_LINE.slam）
   */
  manifest: { reach: 2.6, time: 1.1, width: 0.7, spread: 1.0, compress: 0.25, trough: 0, push: 0.06, start: 0.25, stir: 0.3 } as WaveParams,
  /** 八音盒：音乐响着（MUSIC_BOX_T.end 秒）的时候，雾在它周围慢慢打转，停了以后 release 秒里松开 */
  musicBox: { radius: 1.5, swirl: 0.85, thin: 0.12, push: 0.08, release: 2.2 },
  /** 被搅动的雾撕成缕：缕之间的空隙 / 缕上的密度倍数（按细节噪声在两者之间过渡） */
  wisp: [0.2, 1.7] as [number, number],
  /** 低档网格粗：波前半宽、半径至少是格距的这么多倍，否则顶点采不出来、成了锯齿 */
  minSteps: 2,
};

/**
 * 天亮的程度（0 夜里、1 天亮）：house.ts 的天亮跟着写（DAWN.fog）。雾的环境色往 FOG_DAWN 走（晨雾被天光照亮），update 里变了才写 uniform
 */
export const fogSky = { k: 0 };
/** 雾的 uniform 上一次按哪个 k 写的 */
let fogSkyK = 0;
/** 天亮时雾的环境色：FOG.ambient ×1.8，再往它自己亮度的灰偏 0.4 */
const FOG_DAWN = (() => {
  const c = FOG.ambient.clone().multiplyScalar(1.8);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return c.lerp(new THREE.Color(l, l, l), 0.4);
})();

const TORCHES = 4;
const POINTS = 4;
/** 房间编号（顶点属性 room）：按 ROOMS 的顺序；墙外、屋外是 NO_ROOM */
const ROOM_IDS = Object.keys(ROOMS) as RoomId[];
const NO_ROOM = 15;
/** 一个扰动作用的两个房间打包成一个数：a + ROOM_PACK × b */
const ROOM_PACK = 16;
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
  const out = outsideDist(x, z);
  return FOG.outside * (1 + 0.4 * pool) * (1 - smooth(fade[0], fade[1], out));
}

/** 离房子外沿多远（米；在房子的占地里 = 0）：屋外的雾离外墙多远变淡（staticDensity）、俯视时压淡多少（outsideMix）都按它 */
function outsideDist(x: number, z: number): number {
  const dx = Math.max(0, -x, x - HOUSE_W), dz = Math.max(0, -z, z - HOUSE_D);
  return Math.hypot(dx, dz);
}

/**
 * 屋外那圈雾在这一刻的密度倍数（着色器里 fogMaterial 逐顶点算的就是它，这里是 CPU 镜像，给测试用）：
 * outsideMix 是顶点的屋外程度（0 屋里、1 屋外），persp 是这一次画雾的相机（true = 第三人称的透视，false = 娃娃屋的正交），
 * lift 是雾的环境色此刻比夜里亮多少倍（天亮时 FOG_DAWN 是 ×1.8；夜里 1，小于 1 按 1 算）。
 * 屋里、第三人称都是 1；娃娃屋的屋外是 FOG.topDown.dim ÷ lift
 */
export function topDownDim(outsideMix: number, persp: boolean, lift = 1): number {
  const top = FOG.topDown.dim / Math.max(lift, 1);
  return 1 + ((persp ? 1 : top) - 1) * outsideMix;
}

/**
 * 顶点属于哪个房间（扰动只作用在自己的房间）。墙格、门洞里的顶点按它偏向格子哪一侧，归到那一侧的房间：
 * 墙体两边露出来的那一条雾各跟各的房间，墙体本身挡住了中间的过渡。外墙外侧那一条算屋外
 */
function roomOfPoint(x: number, z: number): number {
  const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
  if (!inGrid(i, j)) return NO_ROOM;
  const own = roomAt(i, j);
  if (own) return ROOM_IDS.indexOf(own);
  const fx = x / CELL - i - 0.5, fz = z / CELL - j - 0.5;
  const sx = fx >= 0 ? 1 : -1, sz = fz >= 0 ? 1 : -1;
  const order: [number, number][] = Math.abs(fx) >= Math.abs(fz) ? [[sx, 0], [0, sz]] : [[0, sz], [sx, 0]];
  for (const [di, dj] of order) {
    const r = inGrid(i + di, j + dj) ? roomAt(i + di, j + dj) : null;
    if (r) return ROOM_IDS.indexOf(r);
  }
  return NO_ROOM;
}

/** 雾顶的网格：位置在房屋坐标，y = FOG.top；dens 是静态密度，room 是房间编号，outside 是屋外程度（0 屋里、1 屋外，见 FOG.topDown）。四角都没有雾的格子不画 */
function buildGrid(q: Quality, tiles: Uint8Array): THREE.BufferGeometry {
  const { step, fade } = FOG.layout[q];
  const reach = fade[1] + step;
  const x0 = -reach, x1 = HOUSE_W + reach, z0 = -reach, z1 = HOUSE_D + reach;
  const nx = Math.ceil((x1 - x0) / step), nz = Math.ceil((z1 - z0) / step);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  const dens = new Float32Array((nx + 1) * (nz + 1));
  const room = new Float32Array((nx + 1) * (nz + 1));
  const outside = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      const k = j * (nx + 1) + i;
      const x = x0 + ((x1 - x0) * i) / nx, z = z0 + ((z1 - z0) * j) / nz;
      pos.set([x, FOG.top, z], k * 3);
      dens[k] = staticDensity(x, z, tiles, fade);
      room[k] = roomOfPoint(x, z);
      outside[k] = smooth(0, FOG.topDown.ramp, outsideDist(x, z));
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
  g.setAttribute('room', new THREE.BufferAttribute(room, 1));
  g.setAttribute('outside', new THREE.BufferAttribute(outside, 1));
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
    /** 相机视线方向（房屋坐标，单位向量，y < 0）：正交相机的视线处处是它 */
    fwd: uniform(new THREE.Vector3(0, -0.57, -0.82)),
    /** 相机位置（房屋坐标）：透视相机的视线从这里发散 */
    camPos: uniform(new THREE.Vector3(0, 20, 0)),
    /** 这一次画雾的相机：1 = 透视，0 = 正交 */
    persp: uniform(0),
    /** 第三人称时的调整（FOG.eye：密度倍数、最浓、最小掠射角正弦），做成 uniform 是为了 ?debug 下能现调 */
    eye: uniform(new THREE.Vector3(FOG.eye.density, FOG.eye.maxAlpha, FOG.eye.minSin)),
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
    /** 扰动槽（见 DRAFT）。强度全为 0 时不起作用 */
    drafts: Array.from({ length: DRAFT.slots }, () => ({
      /** 中心 x, z；旋 / 推的半径；变薄的半径 */
      geo: v4u(),
      /** 变薄的比例、旋的角度（弧度，带方向）、推的比例、气浪波前变浓的比例 */
      amt: v4u(),
      /** 气浪波前的半径、半宽、推走的距离（米）；作用的两个房间（打包，见 ROOM_PACK） */
      ring: uniform(new THREE.Vector4(0, 1, 0, NO_ROOM * (1 + ROOM_PACK))),
      /** 气浪的两个形状系数（slam 和 manifest 各用自己的）：波前后面变薄的量 / 波前变浓的量（trough / compress）、波前上撕成缕的程度（stir） */
      wave: uniform(new THREE.Vector2(DRAFT.slam.trough / DRAFT.slam.compress, DRAFT.slam.stir)),
    })),
  };
}
type Uniforms = ReturnType<typeof makeUniforms>;
type DraftSlot = Uniforms['drafts'][number];

/** 气浪这一刻写进 uniform 的几个数（见 waveAt） */
export interface WaveState {
  /** 波前半径、半宽（米） */
  radius: number;
  halfWidth: number;
  /** 气浪过去之后雾被推走的距离（米） */
  shove: number;
  /** 波前上雾变浓的比例（带着 (1 − u)^1.5 的衰减，波前后面变薄的量是它乘 trough / compress） */
  compress: number;
}

/**
 * 气浪（厨房门撞上、现身落下）在波前出发 ts 秒后的样子，writeDraft 照它写 uniform，测试也用它：
 * 波前按 outCubic 先快后慢地从 start 推到 reach；半宽随走远变宽（spread），不窄于 minW（低档网格 0.4 米一格，采不出更窄的）；
 * 气浪过去后雾被推走的距离按 inOutSine 退回；变浓 / 变薄的幅度随 (1 − u)^1.5 衰减，出发时 0.06 秒内淡入，不是一下子出现。
 * ts < 0 = 还没出发（半径停在 start、不起作用）
 */
export function waveAt(L: WaveParams, ts: number, minW: number): WaveState {
  const u = seg(ts, 0, L.time);
  const on = ts >= 0 ? 1 : 0;
  return {
    radius: L.start + (L.reach - L.start) * outCubic(u),
    halfWidth: Math.max(L.width * (1 + L.spread * u), minW),
    shove: on * L.push * (1 - inOutSine(u)),
    compress: on * L.compress * (1 - u) ** 1.5 * seg(ts, 0, 0.06),
  };
}

/**
 * 离中心 r 米的一点上，气浪这一刻造成的密度倍数：波前上浓、后面薄，再乘「撕成缕」那一项。wisp 是那一点上细节噪声给的缕系数
 * （DRAFT.wisp 的 0.2–1.7：缕之间的空隙 / 缕上）。和 draftField 里 density 的 ring、stir 两项是同一个式子，只是着色器里逐顶点算、
 * 这里是它的 CPU 镜像，给测试数「雾的亮度曲线」用：雾的不透明度 = 1 − exp(−τ)，τ 正比于密度，亮度和密度单调相关
 */
export function waveDensity(w: WaveState, L: WaveParams, r: number, wisp = 1): number {
  const t = (r - w.radius) / w.halfWidth;
  const band = Math.exp(-t * t);
  const behind = 1 - smooth(w.radius - w.halfWidth, w.radius, r);
  const ring = w.compress * (band - behind * (L.trough / L.compress));
  const stir = Math.min(1, Math.max(0, band * w.compress * L.stir));
  return Math.max(ring + 1, 0) * (stir * (wisp - 1) + 1);
}

/**
 * 所有扰动叠加后：噪声的取样点往哪挪（dx, dz）、密度乘多少。
 * 取样点用 S（雾实际所在的高度），和噪声一致，旋转镜头时扰动钉在地板上不动；房间用顶点自己的 room 属性
 */
function draftField(u: Uniforms, S: V3, room: F) {
  let dx: F = float(0);
  let dz: F = float(0);
  const parts: { r: F; mask: F; d: DraftSlot; f: F }[] = [];
  for (const d of u.drafts) {
    const ox = S.x.sub(d.geo.x), oz = S.z.sub(d.geo.y);
    const r = sqrt(ox.mul(ox).add(oz.mul(oz)));
    const roomB = floor(d.ring.w.div(ROOM_PACK));
    const roomA = d.ring.w.sub(roomB.mul(ROOM_PACK));
    // 顶点的 room 是整数，逐顶点比较：1 = 同一个房间，0 = 不是
    const mask = max(
      clamp(float(1).sub(abs(room.sub(roomA))), 0, 1),
      clamp(float(1).sub(abs(room.sub(roomB))), 0, 1),
    );
    // 旋 + 推：紧支撑的平滑隆起 (1 − q²)²，中心 1、半径处 0
    const q = clamp(r.div(d.geo.z), 0, 1);
    const f = float(1).sub(q.mul(q)).pow(2).mul(mask);
    const th = d.amt.y.mul(f);
    const c = cos(th), s = sin(th);
    // 气浪：波前以内的雾被推走 ring.z 米（取样点往中心收），波前外面不动；中心处位移归零，免得除以 0
    const inside = smoothstep(d.ring.x.add(d.ring.y), d.ring.x.sub(d.ring.y), r);
    const shove = d.ring.z.mul(inside).mul(r.div(r.add(0.3))).mul(mask).div(max(r, 0.01));
    const k = float(1).sub(d.amt.z.mul(f)).sub(shove);
    dx = dx.add(ox.mul(c).sub(oz.mul(s)).mul(k).sub(ox));
    dz = dz.add(ox.mul(s).add(oz.mul(c)).mul(k).sub(oz));
    parts.push({ r, mask, d, f });
  }
  /**
   * 密度倍数。n：细节噪声（-1..1，已经按扰动后的取样点算过）：
   * 让变薄区的边缘不是正圆；被搅动的地方（拧得越紧、气浪波前上）雾撕成一缕一缕，
   * 缕随着取样点一起转，旋涡才看得出来（屋里的雾本来很匀，光转花纹几乎看不见）
   */
  const density = (n: F) => {
    let mul: F = float(1);
    const wisp = smoothstep(-0.25, 0.55, n).mul(DRAFT.wisp[1] - DRAFT.wisp[0]).add(DRAFT.wisp[0]);
    for (const { r, mask, d, f } of parts) {
      const re = r.add(n.mul(d.geo.w).mul(0.22));
      const thin = float(1).sub(smoothstep(d.geo.w.mul(0.3), d.geo.w, re)).mul(d.amt.x).mul(mask);
      const t = r.sub(d.ring.x).div(d.ring.y);
      const band = exp(t.mul(t).negate());
      const behind = float(1).sub(smoothstep(d.ring.x.sub(d.ring.y), d.ring.x, r));
      const ring = d.amt.w.mul(band.sub(behind.mul(d.wave.x))).mul(mask);
      // 搅动程度：这里被拧了多少弧度（f 已含房间遮罩）+ 波前
      const stir = clamp(abs(d.amt.y).mul(f).add(band.mul(d.amt.w).mul(mask).mul(d.wave.y)), 0, 1);
      mul = mul.mul(max(float(1).sub(thin), 0)).mul(max(ring.add(1), 0)).mul(stir.mul(wisp.sub(1)).add(1));
    }
    return mul;
  };
  return { dx, dz, density };
}

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

/** drafts = false 只给调试对比开销用（window.__fog.drafts），正式画面总是带扰动 */
function fogMaterial(u: Uniforms, octaves: number, drafts = true) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  // 不受光照：不让它跟着场景灯的数量重新编译
  mat.lights = false;

  // —— 顶点：噪声、密度、雾里的光 ——
  const P = positionLocal;
  // 经过这个顶点的视线（房屋坐标，单位向量）：正交相机处处是相机朝向，透视相机从相机位置发散
  const ray = normalize(mix(u.fwd, P.sub(u.camPos), u.persp));
  const sinV = max(ray.y.negate(), mix(float(FOG.minSin), u.eye.z, u.persp));
  // 视线从雾顶往下走到 sampleY 高度的那一点：雾主要在这附近，噪声和光都在这里取样，镜头转动、移动时雾不会相对地板滑动
  const S = P.add(ray.mul(float(FOG.top - FOG.sampleY).div(sinV)));
  const Q = P.add(S).mul(0.5);
  const t = u.time;
  // 扰动只挪噪声的取样点（雾的花纹被拧、被推），光照仍按雾真正所在的位置 S 算
  const field = drafts ? draftField(u, S, attribute('room', 'float')) : null;
  const Sx = field ? S.x.add(field.dx) : S.x;
  const Sz = field ? S.z.add(field.dz) : S.z;
  // 屋外的程度（顶点属性：0 屋里、1 屋外）：俯视（persp = 0）时屋外压淡、第二层细噪声的权重减小（FOG.topDown）；
  // 第三人称（persp = 1）、屋里都不变
  const outsideMix = attribute('outside', 'float');
  const T = FOG.topDown;
  const lastOctave = FOG.noise.length - 1;
  // 天亮时环境色比夜里亮几倍（夜里 = 1）：屋外的密度跟着再除一下，贴上去的亮度（密度 × 环境色）不变
  const lift = max(u.ambient.r.mul(0.2126).add(u.ambient.g.mul(0.7152)).add(u.ambient.b.mul(0.0722))
    .div(0.2126 * FOG.ambient.r + 0.7152 * FOG.ambient.g + 0.0722 * FOG.ambient.b), 1);
  let fbm: F = float(0);
  let wsum = 0;
  let detail: F = float(0);
  FOG.noise.slice(0, octaves).forEach((o, k) => {
    // 换到风向坐标系：顺风方向频率除以 stretch、横向乘以 √stretch（拉成一缕一缕），再顺风平移
    const speed = Math.hypot(o.wind[0], o.wind[1]);
    const wx = o.wind[0] / speed, wz = o.wind[1] / speed;
    const down = Sx.mul(wx).add(Sz.mul(wz)).sub(t.mul(speed));
    const side = Sz.mul(wx).sub(Sx.mul(wz));
    const n = mx_noise_float(vec3(
      down.mul(o.freq / o.stretch),
      side.mul(o.freq * Math.sqrt(o.stretch)),
      t.mul(o.evolve).add(k * 17.3),
    ));
    // 最细的那一层：俯视时屋外权重降到 T.detail（总和不重新归一：屋外的花纹只是更淡，屋里、第三人称的 wsum 还是 1）
    const weight: F = k === lastOctave ? mix(float(o.weight), mix(float(T.detail), float(o.weight), u.persp), outsideMix) : float(o.weight);
    fbm = fbm.add(n.mul(weight));
    wsum += o.weight;
    if (k === octaves - 1) detail = n;
  });
  fbm = fbm.div(wsum);
  // 成片：大部分地方是很薄的一层，噪声高的地方聚成一团团
  const patch = smoothstep(-0.35, 0.7, fbm);
  let rho: F = attribute('dens', 'float').mul(FOG.density).mul(patch.mul(patch).mul(1.15).add(0.22))
    .mul(mix(float(1), mix(float(T.dim).div(lift), float(1), u.persp), outsideMix));
  if (field) rho = rho.mul(field.density(detail));
  // 浓的地方也更高，雾面起伏
  const hs = float(FOG.scaleH).mul(patch.mul(0.4).add(0.75).add(detail.mul(0.12)));

  const toCam = ray.negate();
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
  const vSin = varying(sinV, 'vFogSin');

  // —— 片元：视线在雾里走过的那一段，解析积分 ——
  const depth = viewportDepthTexture().x;
  const sceneZ = mix(orthographicDepthToViewZ(depth, cameraNear, cameraFar), perspectiveDepthToViewZ(depth, cameraNear, cameraFar), u.persp);
  // 沿视线的距离：正交相机深度差就是距离；透视相机的视线是斜的，再除以视线和视轴夹角的余弦
  const slant = mix(float(1), length(positionView).div(max(positionView.z.negate(), 1e-4)), u.persp);
  const along = max(positionView.z.sub(sceneZ), 0).mul(slant);
  const yEnd = max(float(FOG.top).sub(along.mul(vSin)), 0); // 视线碰到东西（或地面）时的高度
  const tau = vRho.mul(vHs).div(vSin).mul(exp(yEnd.div(vHs).negate()).sub(exp(float(FOG.top).div(vHs).negate())));
  const nearK = mix(float(FOG.near.thin), float(1), smoothstep(FOG.near.from, FOG.near.to, length(positionView)))
    .mul(mix(float(1), u.eye.x, u.persp));
  mat.colorNode = vLight.add(u.ambient);
  mat.opacityNode = min(float(1).sub(exp(tau.mul(nearK).negate())), mix(float(FOG.maxAlpha), u.eye.y, u.persp));
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

  // —— 扰动：trigger 事件开一个，update 里按年龄算强度写进 uniform ——
  type DraftKind = 'possess' | 'slam' | 'music' | 'manifest';
  interface Draft { kind: DraftKind; x: number; z: number; rooms: number; age: number; life: number; spin: number }
  const drafts: (Draft | null)[] = new Array(DRAFT.slots).fill(null);
  let spin = 1;
  const lifeOf = (k: DraftKind) => {
    const P = DRAFT.possess;
    if (k === 'possess') return P.attack + P.hold + P.refill;
    if (k === 'slam') return DOOR_T_LINE.slam + DRAFT.slam.time;
    if (k === 'manifest') return DRAFT.manifest.time;
    return MUSIC_BOX_T.end + DRAFT.musicBox.release;
  };
  /** 占一个槽：空槽，没有就顶掉进度最靠后的那个 */
  const claim = (kind: DraftKind, x: number, z: number, rooms: number) => {
    let k = drafts.indexOf(null);
    if (k < 0) {
      let most = -1;
      drafts.forEach((d, i) => { const v = d ? d.age / d.life : 0; if (v > most) { most = v; k = i; } });
    }
    spin = -spin; // 旋的方向轮流换，不总是同一个手性
    drafts[k] = { kind, x, z, rooms, age: 0, life: lifeOf(kind), spin };
  };
  const startDraft = (objectId: string, kind: DraftKind) => {
    const p = PROPS.find((x) => x.id === objectId);
    if (!p) return;
    const c = propCenter(p);
    // 门在门洞里：气浪往门两边的房间走
    const doorway = kind === 'slam' ? DOORWAYS.find((d) => d.cells.some(([i, j]) => i === p.cell[0] && j === p.cell[1])) : undefined;
    const [ra, rb] = doorway ? doorway.rooms : [p.room, p.room];
    claim(kind, c.x, c.z, ROOM_IDS.indexOf(ra) + ROOM_PACK * ROOM_IDS.indexOf(rb));
  };
  /**
   * 不按物件、按位置开一个扰动（现身落下：鬼魂在哪就从哪出发），和 startDraft 一样占槽。
   * 房间：这一点所在的格子的房间（roomAt）；站在门洞里是门两边的房间；站在墙里、屋外就按它偏向的那一侧（roomOfPoint），
   * 扰动不会穿墙推到隔壁
   */
  const startDraftAt = (pos: Vec2, kind: DraftKind) => {
    const i = Math.floor(pos.x / CELL), j = Math.floor(pos.z / CELL);
    const doorway = DOORWAYS.find((d) => d.cells.some(([ci, cj]) => ci === i && cj === j));
    const a = doorway ? ROOM_IDS.indexOf(doorway.rooms[0]) : roomOfPoint(pos.x, pos.z);
    const b = doorway ? ROOM_IDS.indexOf(doorway.rooms[1]) : a;
    claim(kind, pos.x, pos.z, a + ROOM_PACK * b);
  };
  const writeDraft = (slot: DraftSlot, d: Draft | null) => {
    const { geo, amt, ring, wave } = slot;
    if (!d) {
      amt.value.set(0, 0, 0, 0);
      ring.value.set(0, 1, 0, NO_ROOM * (1 + ROOM_PACK));
      return;
    }
    const t = d.age;
    const minW = FOG.layout[quality].step * DRAFT.minSteps;
    if (d.kind === 'possess') {
      const P = DRAFT.possess;
      const a = outQuad(seg(t, 0, P.attack));
      const back = inOutSine(seg(t, P.attack + P.hold, d.life));
      const twist = t < P.twistAt ? outCubic(seg(t, 0, P.twistAt)) : 1 - inOutSine(seg(t, P.twistAt, d.life));
      const R = Math.max(P.radius, minW * 2);
      geo.value.set(d.x, d.z, R, R * (t < P.attack ? 0.45 + 0.55 * a : 1 - 0.7 * back));
      amt.value.set(P.thin * a * (1 - back), d.spin * P.swirl * twist, P.push * a * (1 - back), 0);
      ring.value.set(0, 1, 0, d.rooms);
    } else if (d.kind === 'slam' || d.kind === 'manifest') {
      // 气浪：厨房门要先摆到撞上门框（DOOR_T_LINE.slam）才出发，现身是落下那一刻就出发
      const L = d.kind === 'slam' ? DRAFT.slam : DRAFT.manifest;
      const w = waveAt(L, t - (d.kind === 'slam' ? DOOR_T_LINE.slam : 0), minW);
      geo.value.set(d.x, d.z, 1, 1);
      amt.value.set(0, 0, 0, w.compress);
      ring.value.set(w.radius, w.halfWidth, w.shove, d.rooms);
      wave.value.set(L.trough / L.compress, L.stir);
    } else {
      const M = DRAFT.musicBox;
      const T = MUSIC_BOX_T.end;
      // 音乐响着时匀速慢慢转（开头 0.6 秒缓起），停了以后松开
      const turn = t < T ? Math.max(0, t - 0.3 * (1 - seg(t, 0, 0.6))) / T : 1;
      const rel = inOutSine(seg(t, T, d.life));
      const on = seg(t, 0, 0.8) * (1 - rel);
      const R = Math.max(M.radius, minW * 2);
      geo.value.set(d.x, d.z, R, R);
      amt.value.set(M.thin * on, d.spin * M.swirl * turn * (1 - rel), M.push * on, 0);
      ring.value.set(0, 1, 0, d.rooms);
    }
  };
  /** 调试截图用（?debug 的 __fog.hold / seek）：扰动的年龄定住，想截哪一刻就把年龄拨到哪一刻 */
  let holdDrafts = false;
  const stepDrafts = (dt: number) => {
    drafts.forEach((d, k) => {
      if (d) {
        if (!holdDrafts) d.age += dt;
        if (d.age >= d.life) drafts[k] = null;
      }
      writeDraft(u.drafts[k], drafts[k]);
    });
  };

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
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inv);
    u.persp.value = (camera as THREE.PerspectiveCamera).isPerspectiveCamera ? 1 : 0;
    const ts = torches.length > TORCHES
      ? [...torches].sort((x, y) => y.lights.reduce((s, l) => s + strength(l), 0) - x.lights.reduce((s, l) => s + strength(l), 0))
      : torches;
    u.torches.forEach((slot, k) => setTorch(slot, ts[k]));
    const ps = points.length > POINTS ? [...points].sort((x, y) => strength(y) - strength(x)) : points;
    u.points.forEach((slot, k) => setPoint(slot, ps[k]));
  };

  /** 调试时现编的材质（见下面 __fog.drafts），dispose 时一起释放 */
  const debugMats: THREE.Material[] = [];
  if (search.has('debug')) {
    // drafts = false：换成不带扰动的材质（只在调试时现编），同一页面上对比扰动的开销
    const full = { high: meshes.high.material as THREE.Material, low: meshes.low.material as THREE.Material };
    let bare: typeof full | null = null;
    let withDrafts = true;
    (window as unknown as { __fog: unknown }).__fog = {
      get enabled() { return enabled; },
      set enabled(v: boolean) { enabled = v; applyVisibility(); },
      get drafts() { return withDrafts; },
      set drafts(v: boolean) {
        withDrafts = v;
        if (!bare) {
          bare = { high: fogMaterial(u, 2, false), low: fogMaterial(u, 1, false) };
          debugMats.push(bare.high, bare.low, full.high, full.low);
        }
        const use = v ? full : bare;
        meshes.high.material = use.high;
        meshes.low.material = use.low;
      },
      /** 手动开一个扰动（调试）：kind = 'possess' | 'slam' | 'music' */
      disturb: (objectId: string, kind: DraftKind = 'possess') => startDraft(objectId, kind),
      /** 手动在一个位置（房屋米坐标）开一个扰动（调试）：现身落下的气浪，kind 默认 'manifest' */
      disturbAt: (x: number, z: number, kind: DraftKind = 'manifest') => startDraftAt({ x, z }, kind),
      /**
       * 定住所有扰动的时间，连同雾的噪声时间一起（截图截某一刻用，配合 seek：云纹不飘，和「没有扰动」那一张做差只剩扰动）；
       * 放开后接着往前走（下一次 update 会把噪声时间写回真的）
       */
      get hold() { return holdDrafts; },
      set hold(v: boolean) {
        holdDrafts = v;
        const t = u.time as unknown as { value: number };
        const now = t.value;
        if (v) Object.defineProperty(t, 'value', { configurable: true, enumerable: true, get: () => now, set: () => {} });
        else Object.defineProperty(t, 'value', { configurable: true, enumerable: true, writable: true, value: now });
      },
      /** 把所有在跑的扰动的年龄拨到 t 秒（从扰动开始算；不会拨过它的寿命） */
      seek: (t: number) => { for (const d of drafts) if (d) d.age = Math.min(t, d.life - 1e-6); },
      uniforms: u,
    };
  }

  return {
    onEvent(e: SimEvent) {
      // 现身落下（ghost.ts 的换材质、lightfx 的灯暗同一刻）：地面雾从鬼魂脚下被推开一圈。蓄力、停留、收不动雾
      if (e.type === 'manifest') {
        if (e.phase === 'drop') startDraftAt(e.pos, 'manifest');
        return;
      }
      if (e.type !== 'trigger') return;
      startDraft(e.object, e.scareType === 'door' ? 'slam' : e.scareType === 'musicBox' ? 'music' : 'possess');
    },
    update(ctx: FrameCtx) {
      if (!primed) { primed = true; applyVisibility(); }
      u.time.value = ctx.time;
      scanIn -= ctx.dt;
      stepDrafts(ctx.dt);
      // 天亮：雾的环境色跟着天光走（fogSky，house.ts 写；变了才写）
      if (fogSky.k !== fogSkyK) u.ambient.value.copy(FOG.ambient).lerp(FOG_DAWN, (fogSkyK = fogSky.k));
    },
    setQuality(q) {
      quality = q;
      if (primed) applyVisibility();
    },
    dispose() {
      core.houseRoot.remove(root);
      for (const m of Object.values(meshes)) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      for (const m of debugMats) m.dispose();
    },
  };
}
