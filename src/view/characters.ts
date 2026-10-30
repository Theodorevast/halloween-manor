// 访客角色：加载吉祥物 GLB（失败时换备用小人），每个访客一份克隆，按速度和状态混合动画片段，
// 再叠一层克制的程序化动作（受惊时小跳一下、落地后快速转向吓人的东西，紧张时轻微发抖、缩着点身子，逃跑时略前倾；
// 没有走路片段时用挤压回弹代替），手里拿着手电。
// 2026-10-28 第二次试玩（「动作太夸张、生硬、穿模」）之后收敛：跳得低、不在空中扭身、不再不停回头张望，
// 转身和起步停步都平滑（朝向用临界阻尼弹簧，动画按平滑后的速度混合）。
// 2026-10-28 访客反馈：再加 4 个动作，都是在原来的片段上「代替」，淡入淡出不硬切——察觉（NpcState.notice）且停着时 look 代替 idle，
// 紧张（nervous）且停着时 afraid 代替 idle，逃跑（mode === 'fleeing'）时 flee 代替 run，受惊在 scared / scared2 之间轮流。
//
// 换模型只改 config/character.ts（VISITOR_SPECS 有几套就轮流分给进门的人；一套都加载不到时用 CHARACTER）。
// 2026-10-29 起边玩边加载：开场按钮只等第一套（loadFirstOutfit），其余几套开场按钮可用之后在后台一套一套下载、
// 异步编好管线再加进轮换（streamOutfits / compileOutfit）。
// 这里负责把任何来路的模型「摆正」：
//   量包围盒（Box3.setFromObject：量化 / meshopt 压缩过的模型，accessor 里的范围不是真实尺寸）→
//   缩放到 targetHeight（身长超过 maxLength 时再缩）、x / z 居中、脚底贴 y = 0 → 抵消 facingOffset，让正面朝 +z
//
// 节点层级：root（模拟给的位置、平滑后的朝向）→ body（跳起高度、转身 / 前倾 / 发抖、挤压拉伸）→ pose（缩身、前探的剪切）→ 模型。
// 全部是表现层的偏移，不回写模拟状态；手电的方向始终是模拟的 lookDir（光锥就是视野），只有握手电的位置跟着身体走
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { materialOpacity, uniform, vec4 } from 'three/tsl';
import { CHARACTER, FLASHLIGHT_HEIGHT, VISITOR_SPECS, type CharacterSpec } from '../config/character';
import { FEAR, SPAWN } from '../config/visitors';
import type { FrameCtx, Module, RenderCore } from '../engine/types';
import { angleOf, wrapAngle, yawFor } from '../lib/angle';
import type { NpcMode, NpcState, Personality, SimEvent, Vec2, WorldState } from '../sim/types';
import { createFallbackCharacter } from './fallbackCharacter';
import { createFlashlight, type Flashlight } from './flashlight';

/** 淡入（进门）/ 淡出（出门）的秒数 */
const FADE = { in: 0.6, out: 0.6 };
/**
 * 朝向的平滑（临界阻尼弹簧的 smoothTime，秒）：模拟层限速转向（5 弧度/秒），转身的开始和结束是硬的；
 * 二阶弹簧让角速度连续，转身有起有收、不过冲。手电跟得快一些（受惊时模拟让手电一下子对准吓人的东西）
 */
const SMOOTH = { heading: 0.14, look: 0.07 };
/**
 * 起步、停步：模拟层的速度本身有加减速（config/visitors.ts 的 MOTION），这里再按平滑后的速度（speed 秒的临界阻尼弹簧，
 * 只抹掉受惊僵住那种一下子停住）混合片段，不按速度阈值一刀切。待机 / 走 / 跑三个片段一直在播，权重连续变：
 * walk 区间里从待机过渡到走，run 区间里从走过渡到跑（米/秒）。走、跑的播放速率按模拟速度算，步子和移动对得上、脚不打滑。
 * 受惊片段（有的话）按 scaredRate（1/秒）淡入淡出
 */
const GAIT = { speed: 0.12, walk: [0.05, 0.55] as const, run: [2.0, 2.8] as const, scaredRate: 10 };
/**
 * 新动作的「代替」（淡入淡出的速率，1/秒；片段缺了就不代替，见 CharacterClips）：
 *   look    察觉（NpcState.notice 不为空）且停着时代替 idle。察觉一开始从头播，头第 1 秒就开始转
 *   afraid  紧张（nervous）且停着时代替 idle。察觉和紧张同时，先看（look 优先）
 *   flee    逃跑（mode === 'fleeing'）时代替 run；走 → 跑的过渡还是按速度，只是跑的那一档换成 flee
 * 受惊的 scared / scared2 按 GAIT.scaredRate 淡入淡出，每个访客自己轮流，相邻进门的两个人先用的不是同一个
 */
const MIX = { look: 8, afraid: 4, flee: 6 };
/**
 * 受惊强度：startle 事件的 amount（这一下涨了多少恐惧，约 5–72）→ 0..1。
 * 先线性映射 min..max，再开 curve 次方（< 1：中等的惊吓也看得出，最大的那几下才顶到头）。
 * 没有事件、只看到状态切到 startled 时（兜底）用 fallback
 */
const STARTLE = { min: 6, max: 70, curve: 0.6, fallback: 24 };
/**
 * 受惊跳起：一下短促的蹲、离地、落地，像被吓得一缩一弹，不是卡通的弹簧。
 * 写成 [最小, 最大] 的按受惊强度插值（单位：秒 / 米 / 比例）。离地 0.25–0.35 米，上升、下落时长大致按重力算；
 * 挤压拉伸只留一点点（蹲下压 5–8%，落地回弹 1.5–2.5%）。最长 0.74 秒，在僵住的 0.8 秒（FEAR.startleTime）之内。
 * recoil：在空中往后一缩（剪切：每米高度往后挪多少米），离地时到位、落地前收回
 */
const JUMP = {
  crouch: 0.07,
  rise: [0.22, 0.26],
  fall: [0.19, 0.22],
  land: 0.05,
  settle: 0.14,
  height: [0.25, 0.35],
  squash: [0.05, 0.08],
  stretch: [0.03, 0.05],
  overshoot: [0.015, 0.025],
  recoil: [0.04, 0.08],
} as const;
/**
 * 受惊转身：空中不转。落地以后、僵住期间，身体（不是手电）快速转向吓到它的物件（临界阻尼，不过冲，hold 秒的弹簧，
 * 90° 大约 0.25 秒转完）；僵住结束后用 release 秒的弹簧转回模拟给的朝向
 */
const TURN = { hold: 0.09, release: 0.3 };
/**
 * 害怕时缩着身子（恐惧值 ≥ FEAR.nervous 开始，越接近 100 越明显）：
 * 强度 = atNervous（刚到紧张线）→ 1（恐惧值 100），逃跑时为 0（逃跑有自己的前倾）。强度 1 时：
 *   hunch   上身往前探（剪切：每米高度往前挪多少米，脚底不动）
 *   shrink  身高缩短的比例；narrow  宽度、长度缩小的比例
 *   cadence 走路片段的步频加快的比例（速度由模拟定，步频快了步子就小）
 *   stride / hop  没有走路片段时：每步步长、弹起高度缩小的比例
 *   rate    强度平滑的速率（1/秒）
 * 2026-10-28 收敛到原来的三分之一左右：远看是「有点佝偻、步子碎」，不是蜷成一团
 */
const COWER = { atNervous: 0.4, hunch: 0.12, shrink: 0.06, narrow: 0.02, cadence: 0.18, stride: 0.15, hop: 0.2, rate: 2 };
/** 逃跑时身体前倾（弧度）；平时随速度略微前倾 */
const LEAN = { flee: 0.14, perSpeed: 0.02, rate: 5 };
/**
 * 发抖：恐惧值过了紧张线，或者鬼魂贴在身边发毛（NpcState.uneasy，按程度）时。
 * 转角（弧度）和位移（米）的幅度，频率在生理性颤抖的 8–12 Hz 附近（以前 31–53 Hz，60 帧下会混叠成乱跳），
 * rate 是开始 / 停止发抖的平滑速率（1/秒）
 */
const SHAKE = { rot: 0.012, pos: 0.003, hz: [9.5, 6.2, 8.3], rate: 4 };
/** 没有走路片段时的上下弹跳：每步步长、弹起高度、触地压扁、左右摇摆（都按身高比例） */
const BOUNCE = { step: 0.28, height: 0.045, squash: 0.07, roll: 0.06 };
/** 没有待机片段时的呼吸 */
const BREATHE = { amp: 0.012, rate: 2.4 };
/**
 * 角色材质自发光一点点，相当于手电打在身前地上反弹回来的光：
 * 屋里很暗、手电又是朝前照的，不加这一点访客自己是一团黑影，玩家看不清人在哪。
 * 0.1 → 0.16（试玩 S1 的一般项：访客背面全黑，深色衣服的背影是一团黑）：比墙的底光（walls.ts 的 ROOM_FILL）还是低一档，人仍然是亮一点的墙前面的剪影
 */
const BOUNCE_LIGHT = 0.16;
/**
 * 手电放在「身体轮廓之外」：照向哪边，就放在包围盒那一侧的边缘再往外 ahead 米，往右手边偏 side 米。
 * 光源不能在自己身体里，也不能在身后往前照，否则自己的身体会挡住整束光（外圈是投影的）
 */
const HAND = { ahead: 0.06, side: 0.1 };
/** 手电池子的大小：屋里常驻 SPAWN.target 人，再留一个给正在逃跑的人（灯的数量固定，避免材质重编译） */
const TORCH_SLOTS = SPAWN.target + 1;

export interface CharacterAsset {
  /** 归一化好的模板：身高 height、x / z 居中、脚底 y = 0、正面朝 +z（已抵消 facingOffset） */
  template: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** 包围盒的半长（前后，米）和半宽（左右，米）：摆正后 x / z 已居中 */
  front: number;
  halfWidth: number;
  /** 归一化后的身高（米）：一般是 targetHeight，身长超过 maxLength 时更矮 */
  height: number;
  /** 调试信息：原始尺寸（模型单位）、缩放倍数、三角形数 */
  rawSize: THREE.Vector3;
  scale: number;
  triangles: number;
}

/**
 * 把任意模型摆正：缩放到 height（身长超过 maxLength 时按身长缩）、x / z 居中、脚底贴地、正面转到 +z。
 * 返回包了两层的新节点
 */
export function normalizeModel(model: THREE.Object3D, height: number, facingOffset: number, maxLength = Infinity, precise = false) {
  model.updateMatrixWorld(true);
  // precise：逐个顶点量（蒙皮网格按骨骼此刻的姿势算），摆了待机姿势之后用
  const box = new THREE.Box3().setFromObject(model, precise);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const long = Math.max(size.x, size.z);
  const byHeight = size.y > 1e-6 ? height / size.y : 1;
  const scale = long > 1e-6 ? Math.min(byHeight, maxLength / long) : byHeight;
  const norm = new THREE.Group();
  norm.name = 'normalize';
  norm.add(model);
  norm.scale.setScalar(scale);
  norm.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  // facingOffset：模型正面相对 +z 的偏转（朝 +x 时为 π/2）。反着转回去，正面就朝 +z
  const face = new THREE.Group();
  face.name = 'facing';
  face.rotation.y = -facingOffset;
  face.add(norm);
  face.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(face, precise);
  const front = Math.max(0.05, after.max.z, -after.min.z);
  const halfWidth = Math.max(0.05, after.max.x, -after.min.x);
  return { template: face, front, halfWidth, height: size.y * scale, rawSize: size, scale };
}

/**
 * signal：给了就自己 fetch 整个文件（可以在下载途中 abort），下载完再交给 GLTFLoader 解析。streamOutfits 用它在等了
 * main.ts 的 OUTFIT_WAIT 秒还没加完（WebGL2 上点了开始以后）和 dispose 时，把还在下载的那一套停掉。不用 LoadingManager.abort：它连解析时内嵌贴图的 blob 读取也一起停掉，GLTFLoader 会打
 * 「Couldn't load texture」的报错（2026-10-29 实测）；这样 abort 只会落在下载上，解析一开始就停不了了
 */
export async function loadCharacterAsset(spec: CharacterSpec = CHARACTER, signal?: AbortSignal): Promise<CharacterAsset> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder); // 吉祥物可能是 gltfpack / meshopt 压缩导出的
  let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>;
  if (signal) {
    // 和 FileLoader 一样：同源带凭据，状态码不对就算失败
    const res = await fetch(spec.url, { credentials: 'same-origin', signal });
    if (!res.ok) throw new Error(`${spec.url}：HTTP ${res.status}`);
    gltf = await loader.parseAsync(await res.arrayBuffer(), THREE.LoaderUtils.extractUrlBase(spec.url));
  } else {
    gltf = await loader.loadAsync(spec.url);
  }
  const clips = gltf.animations;
  console.log(`[characters] ${spec.url}：动画片段 ${clips.length} 个`, clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s)`));
  for (const [role, name] of Object.entries(spec.clips)) {
    if (name && !THREE.AnimationClip.findByName(clips, name)) {
      console.warn(`[characters] config/character.ts 的 clips.${role} = '${name}'，GLB 里没有这个片段。现有：${clips.map((c) => c.name).join(', ') || '（无）'}`);
    }
  }
  let triangles = 0;
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  // measureIdle：先摆成待机片段的第一帧再量（T 字绑定姿势的两臂会把包围盒撑宽，见 CharacterSpec）。
  // 量完骨骼就停在这个姿势上，克隆出来的每个访客有自己的 mixer，第一帧就会接管
  const idleClip = spec.measureIdle && spec.clips.idle ? THREE.AnimationClip.findByName(clips, spec.clips.idle) : null;
  const poser = idleClip ? new THREE.AnimationMixer(gltf.scene) : null;
  if (poser && idleClip) {
    poser.clipAction(idleClip).play();
    poser.update(0);
  }
  const n = normalizeModel(gltf.scene, spec.targetHeight, spec.facingOffset, spec.maxLength, !!poser);
  if (poser) {
    poser.stopAllAction();
    poser.uncacheRoot(gltf.scene);
  }
  console.log(`[characters] 原始尺寸 ${n.rawSize.toArray().map((v) => v.toFixed(2)).join(' × ')}，缩放 ${n.scale.toPrecision(3)}，身高 ${n.height.toFixed(2)} 米，${triangles} 个三角形`);
  return { template: n.template, clips, front: n.front, halfWidth: n.halfWidth, height: n.height, rawSize: n.rawSize, scale: n.scale, triangles };
}

type Pose = 'idle' | 'walk' | 'run' | 'scared' | 'look' | 'afraid' | 'flee' | 'scared2';
const POSES: Pose[] = ['idle', 'walk', 'run', 'scared', 'look', 'afraid', 'flee', 'scared2'];
/** 只播一次的受惊片段，每次受惊轮流用其中一个 */
const SCARED = ['scared', 'scared2'] as const;
type Scared = (typeof SCARED)[number];

/** 一次跳起的形状（按受惊强度从 JUMP 插值出来，跳起时算一次） */
interface JumpShape {
  /** 各阶段结束的时刻（秒）：蹲、上升、下落、落地、回弹 */
  c: number;
  r: number;
  f: number;
  l: number;
  end: number;
  height: number;
  squash: number;
  stretch: number;
  overshoot: number;
  recoil: number;
}

/** 临界阻尼弹簧的状态：值和速度 */
interface Spring { x: number; v: number }

/** 一套加载好的访客造型：配置 + 摆正好的模型（asset 为 null = 备用小人） */
export interface Outfit {
  spec: CharacterSpec;
  asset: CharacterAsset | null;
}

/** 每个访客穿的是哪一套（访客编号 → 造型 id），见 outfitOf。人走了也留着：登记簿收夜时才翻；一夜几十个人，不清 */
const outfitIds = new Map<number, string>();

/**
 * 访客登记簿（ui/register.ts）用：这个访客穿的是哪一套。造型 id 是地址的文件名（vampire、lantern-explorer、witch、skeleton，
 * 联名的 jotaro、dio）；占位狐狸（placeholder-fox.glb）记作 fox。进门以后第一帧建角色时记下；还没建好的、穿备用小人的：undefined
 */
export function outfitOf(npcId: number): string | undefined {
  return outfitIds.get(npcId);
}

/** loadFirstOutfit 的结果：第一个访客穿的那套，和之后在后台下载的其余几套（排在它前面、加载失败的那几套不再试） */
export interface FirstOutfit {
  outfit: Outfit;
  rest: CharacterSpec[];
}

/**
 * 第一个访客穿的那套造型（开场按钮只等它，其余几套开场按钮可用之后在后台下载，见 CharactersView.streamOutfits）。
 * main.ts 在建渲染器之前就调：下载和建渲染器、搭房子同时进行（模型的解析、摆正都不用渲染器）。
 * 按 VISITOR_SPECS 的顺序，第一套加载不到就试下一套；一套都没有就用 CHARACTER（?fox 时直接用它），它也失败就用备用小人。不会 reject
 */
export async function loadFirstOutfit(): Promise<FirstOutfit> {
  // ?fox：不加载换装吉祥物，只用占位狐狸（对比性能、排查模型问题时用）
  const specs = typeof location !== 'undefined' && new URLSearchParams(location.search).has('fox') ? [] : VISITOR_SPECS;
  for (const [i, spec] of specs.entries()) {
    try {
      return { outfit: { spec, asset: await loadCharacterAsset(spec) }, rest: specs.slice(i + 1) };
    } catch (err) {
      console.warn(`[characters] 角色模型 ${spec.url} 加载失败，跳过。`, err);
    }
  }
  try {
    return { outfit: { spec: CHARACTER, asset: await loadCharacterAsset(CHARACTER) }, rest: [] };
  } catch (err) {
    console.warn('[characters] 没有可用的角色模型，改用备用小人。', err);
    return { outfit: { spec: CHARACTER, asset: null }, rest: [] };
  }
}

/** streamOutfits 编管线用的：场景 pass 的镜头和渲染目标（main.ts 给，见 compileOutfit） */
export interface OutfitCompileTarget {
  camera: THREE.Camera;
  /** 后处理的场景 pass 的渲染目标；后处理建不起来、直接画到画布时为 null */
  sceneTarget(): THREE.RenderTarget | null;
  /** 此刻在主线程上卡一下玩家也看不见（开场遮罩还挡着）。加新造型的重活没法放在后台做时（WebGL2），开局之后不再加，见 join */
  hidden(): boolean;
}

/**
 * compileOutfit 照着核对过的 three 版本（THREE.REVISION）。换了版本，内部接口的名字可能还在、行为却变了（比如 RenderContexts.get 的
 * 第三个参数、renderObject 给阴影材质赋值的顺序），编出来的就会悄悄对不上：第一次编的时候打一条警告，要重跑 scripts/stall-outfits.mjs 核对
 */
const THREE_VERIFIED = '186';

/** compileOutfit 要用到的 three r186 内部接口（换版本以后没有了，就退回普通的 compileAsync，见 compileOutfit） */
interface RendererInternals {
  _renderContexts?: { get(target: THREE.RenderTarget | null, mrt: unknown, callDepth?: number): unknown };
  _getShadowNodes?(material: THREE.Material): { colorNode: THREE.Node | null; depthNode: THREE.Node | null; positionNode: THREE.Node | null };
}

/** 真画阴影图时 renderObject 给共用阴影材质套的正反面（three r186 Renderer.js 的 _shadowSide） */
const SHADOW_SIDE: Record<number, THREE.Side> = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };
/** 后台编好管线以后，临时访客在地板下面真画几帧再收走、放进轮换（见 streamOutfits） */
const JOIN_FRAMES = 3;

interface Visual {
  id: number;
  /** 这个人穿的是哪一套：动画片段名、步频速率、手电高度都按它的配置 */
  outfit: Outfit;
  root: THREE.Group;
  body: THREE.Group;
  /** body 和模型之间：缩身、前探（剪切），矩阵手动设置 */
  pose: THREE.Group;
  /** 每个网格的两份共用材质（不透明 / 淡入淡出）和来源材质；setAlpha 在两份之间换 */
  parts: { mesh: THREE.Mesh; opaque: THREE.Material | THREE.Material[]; fade: THREE.Material | THREE.Material[]; sources: THREE.Material[] }[];
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<Pose, THREE.AnimationAction>>;
  /** 各片段此刻的权重（受惊片段单独平滑，其余按平滑速度算，look / afraid / flee 的「代替」按 mix 分） */
  weights: Record<Pose, number>;
  /** look / afraid / flee 代替 idle / idle / run 的程度 0..1（平滑后） */
  mix: { look: number; afraid: number; flee: number };
  /** 正在察觉（NpcState.notice 不为空）；从无到有的那一刻 look 从头播 */
  noticing: boolean;
  /** 受惊轮流用 scared / scared2：已经轮到第几次（从 id 起，相邻访客错开），和这次用的那个 */
  scaredCount: number;
  scaredPick: Scared | null;
  /** 有循环区间的片段（spec.loops）自己走的时间：在区间里的位置（秒） */
  loopT: number;
  front: number;
  halfWidth: number;
  /** 模型身高（米），程序化弹跳按它的比例 */
  height: number;
  torch: Flashlight | null;
  // 最近一次的模拟状态（出门后 state 里没有了，靠它把淡出演完）
  x: number;
  z: number;
  heading: number;
  look: number;
  speed: number;
  mode: NpcMode;
  nervous: boolean;
  fear: number;
  /** 鬼魂贴近带来的发毛程度 0..1（模拟层已平滑） */
  uneasy: number;
  // 表现层自己的状态
  alpha: number;
  leaving: boolean;
  jumpT: number;
  lastJump: number;
  jump: JumpShape;
  /** 这次受惊是被哪个物件吓到的（房屋坐标）；null = 不转身 */
  turnSrc: Vec2 | null;
  /** 受惊转身：身体相对模拟朝向的偏转（方向角，弧度） */
  turn: Spring;
  /** 缩身强度 0..1（平滑后） */
  cower: number;
  lean: number;
  shake: number;
  bounce: number;
  phase: number;
  seed: number;
  /** 平滑后的身体朝向、手电方向（方向角）、移动速度（米/秒） */
  headingS: Spring;
  lookS: Spring;
  speedS: Spring;
}

export interface CharacterDebug {
  id: number;
  /** 权重最大的动画片段 */
  pose: string | null;
  /** 各动画片段此刻的权重（角色有的片段才列；键是 CharacterClips 的角色名） */
  weights: Record<string, number>;
  procedural: boolean;
  jumpY: number;
  /** 这次（或上一次）跳起的最高点（米） */
  jumpPeak: number;
  scaleY: number;
  lean: number;
  /** 发抖的强度 0..1（紧张或发毛） */
  shake: number;
  /** 缩身强度 0..1 */
  cower: number;
  /** 上身前探（正）/ 后仰（负）的剪切量：每米高度挪多少米 */
  hunch: number;
  /** 身体相对模拟朝向转过去的角度（弧度）：受惊转身 */
  twist: number;
  /** 平滑后的速度（米/秒），动画按它混合 */
  speed: number;
  alpha: number;
  yaw: number;
  torch: boolean;
}

export interface CharactersView extends Module {
  /** 调试：每个角色此刻的表现状态 */
  inspect(): CharacterDebug[];
  /** 加载到的是 GLB 还是备用小人 */
  readonly source: 'glb' | 'fallback';
  /**
   * 预热渲染管线：临时放一个点亮手电的访客，不透明、半透明各调一次 compile（主会话传入 renderer.compileAsync），再移除。
   * 不预热的话第一个访客进门时会卡一下：淡入用半透明管线，淡入完成切回不透明，两批都是当场同步编译的
   */
  prewarm(compile: () => Promise<void>): Promise<void>;
  /**
   * 已经加载的造型（开场时只有第一套）的临时访客（不透明、半透明各一个，第一套多拿一支点亮的手电）站到地板下面（玩家看不见），
   * 不做视锥剔除，一直留到 main.ts 在标题页后面把整栋房子真画一帧，那一帧把阴影图、手电这些开场前没编到的一起编好。
   * 返回 done()：那一帧画完（或者玩家先开始了）调，收走临时访客。试过只在那一帧前一刻才放进来：一能点就点开始的话，
   * 标题收起后反而卡 1.3 秒（2026-10-28 实测），所以后台预编译一开始就放好。
   * 为什么不放进开场前那次阻塞的预编译：第一套连同手电不剔除地编要多 1.6 秒
   */
  stageOutfits(): () => void;
  /**
   * 其余几套造型（loadFirstOutfit 的 rest）：一套一套在后台下载（不分带宽，第二套最早到），下载好一套就上传贴图、
   * 异步编好它的管线（compileOutfit：编出来的就是真画时用的那批，不卡），临时访客在地板下面真画几帧，才放进轮换。
   * 在那之前进门的人只穿已经能用的几套。after：等它结束再开始编（main.ts 传后台预编译整栋房子的那一次：点了开始要等它编完，
   * 不跟它抢）；下载不等。WebGL2 上贴图上传是同步的，只能趁开场遮罩挡着时加：不等 after，main.ts 点了开始以后也留着遮罩，
   * 等这里都有了着落再开场（outfitsBeforeStart）。每一套都有了着落（加入轮换、加载失败、放弃）时 resolve，不会 reject
   */
  streamOutfits(target: OutfitCompileTarget, after?: Promise<unknown>): Promise<void>;
  /**
   * 其余几套要不要在开局之前加完：WebGL2 为真（贴图在主线程上同步传，开局以后加会卡；2026-10-29 用户定的「点了开始等它们加完」），
   * main.ts 点了开始要等 streamOutfits 结束才收起遮罩；WebGPU 为假，开局以后照样加
   */
  readonly outfitsBeforeStart: boolean;
  /**
   * 不等了（WebGL2 上点了开始等太久，见 main.ts 的 OUTFIT_WAIT）：没下载完的停掉，还没开始加的不加了，正在编的那一套编完照样加进去
   * （遮罩还挡着）。返回 streamOutfits 结束的 Promise
   */
  stopStreaming(): Promise<void>;
}

const sineOut = (u: number) => Math.sin((u * Math.PI) / 2);
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const span = (r: readonly [number, number], t: number) => lerp(r[0], r[1], t);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** 临界阻尼弹簧（Unity SmoothDamp 的写法）：与帧率无关，不过冲；dt = 0 时原样不动 */
function smoothDamp(s: Spring, target: number, smoothTime: number, dt: number) {
  const omega = 2 / Math.max(1e-4, smoothTime);
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = s.x - target;
  const temp = (s.v + omega * change) * dt;
  s.v = (s.v - omega * temp) * e;
  s.x = target + (change + temp) * e;
}
/** 角度版：目标取离当前值最近的那一圈（按最短的那一边转），之后规整回 (-π, π] */
function smoothDampAngle(s: Spring, target: number, smoothTime: number, dt: number) {
  smoothDamp(s, s.x + wrapAngle(target - s.x), smoothTime, dt);
  s.x = wrapAngle(s.x);
}

/** startle 事件的 amount → 受惊强度 0..1 */
const startleStrength = (amount: number) => clamp01((amount - STARTLE.min) / (STARTLE.max - STARTLE.min)) ** STARTLE.curve;

/** 按受惊强度 0..1 定出这一跳的形状 */
function jumpShape(s: number): JumpShape {
  const c = JUMP.crouch, r = c + span(JUMP.rise, s), f = r + span(JUMP.fall, s), l = f + JUMP.land;
  return {
    c, r, f, l, end: l + JUMP.settle,
    height: span(JUMP.height, s), squash: span(JUMP.squash, s), stretch: span(JUMP.stretch, s),
    overshoot: span(JUMP.overshoot, s), recoil: span(JUMP.recoil, s),
  };
}

/** 受惊跳起的时间线：返回离地高度、y 方向缩放（xz 按体积守恒反算）、后缩的剪切量 */
function jumpPose(t: number, J: JumpShape): { y: number; sy: number; recoil: number } {
  if (t < J.c) return { y: 0, sy: 1 - J.squash * sineOut(t / J.c), recoil: 0 };
  if (t < J.r) {
    const u = (t - J.c) / (J.r - J.c);
    // 离地瞬间从蹲着弹成略拉长，越接近顶点越恢复原状；往后一缩随上升一起到位
    return {
      y: J.height * sineOut(u),
      sy: lerp(1 - J.squash, 1 + J.stretch * (1 - u), sineOut(Math.min(1, u / 0.2))),
      recoil: J.recoil * sineOut(u),
    };
  }
  if (t < J.f) {
    const u = (t - J.r) / (J.f - J.r);
    const k = u * u; // 自由落体：高度按时间平方往下掉
    return { y: J.height * (1 - k), sy: 1 + J.stretch * 0.5 * k, recoil: J.recoil * (1 - 0.7 * u) };
  }
  if (t < J.l) {
    const u = (t - J.f) / (J.l - J.f);
    return { y: 0, sy: lerp(1 - J.squash * 0.6, 1 + J.overshoot, sineOut(u)), recoil: J.recoil * 0.3 * (1 - u) };
  }
  const u = Math.min(1, (t - J.l) / (J.end - J.l));
  return { y: 0, sy: 1 + J.overshoot * Math.cos(u * Math.PI * 1.5) * (1 - u), recoil: 0 };
}

/** 恐惧值 → 缩身强度目标：没到紧张线为 0，到线是 atNervous，恐惧值 100 时为 1 */
function cowerTarget(nervous: boolean, fear: number): number {
  if (!nervous) return 0;
  return lerp(COWER.atNervous, 1, clamp01((fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));
}

/**
 * first：第一套造型的加载（main.ts 在建渲染器之前就开始了，见 loadFirstOutfit）；不给就在这里加载。
 * 只等这一套：其余几套交给 streamOutfits 在后台下载（2026-10-29 之前是四套 7.39 MB 全部下载完才往下走）
 */
export async function createCharactersView(core: RenderCore, first: Promise<FirstOutfit> = loadFirstOutfit()): Promise<CharactersView> {
  const parent = core.houseRoot;
  const { outfit: firstOutfit, rest } = await first;
  /** 已经编好管线、可以分给进门的人的那几套（开场前只有第一套，其余几套在后台下载、编好再加进来，见 streamOutfits） */
  const usable: Outfit[] = [firstOutfit];
  /**
   * 进门的人按 usable 的顺序轮流穿，接着上一个人穿的那套往下数：第一个人穿第一套，相邻两个人穿得不一样（只有一套能用时除外）。
   * 不按访客编号取模：后台每加进来一套，取模的结果就整个错开，前后两个人可能撞上同一套
   */
  let lastGiven: Outfit | null = null;
  const outfitFor = () => (lastGiven = usable[(lastGiven ? usable.indexOf(lastGiven) + 1 : 0) % usable.length]);
  let disposed = false;
  /** 不等其余几套了（stopStreaming）。下载用的 AbortController 放在这一层：不等了、dispose 时都把正在下载的那一套停掉 */
  let givenUp = false;
  const streamAbort = new AbortController();
  /** streamOutfits 全部有了着落（stopStreaming 返回它） */
  let streamDone: Promise<void> = Promise.resolve();

  const torches: Flashlight[] = Array.from({ length: TORCH_SLOTS }, () => createFlashlight(parent, core.quality));
  const owner = new Map<Flashlight, number>();
  const visuals = new Map<number, Visual>();
  /** 受惊事件到的时候这个人的角色还没建好（同一帧刚进门）：先记下，建好后再跳 */
  const pendingJump = new Map<number, { amount: number; src: Vec2 | null }>();
  let now = 0;

  /**
   * 访客的材质：同一套造型的所有访客共用（来源材质 → 不透明、淡入淡出两份）。
   * 原来每人复制一份（为了各自改透明度），three.js 把每份复制都当成新材质，重新生成着色器、新建管线：
   * 开场预编译编过的用不上，第一个访客进门卡 0.4–0.5 秒（2026-10-28 用 __haunt.fx.pipelines() 查到，两份着色器只差内部编号）。
   * 现在透明度按物体传（fadeAlpha 读 mesh.userData.alpha），材质只有这两份，预编译时就编好了。
   * 淡入淡出那份的 opacityNode 是所有造型共用的同一个节点（fadeOpacity）：three 拿节点编号当节点的缓存键，
   * 每份材质各 new 一个的话，后来下载的每套造型都要新编一份淡入淡出的着色器（2026-10-29 实测女巫后加进来时多编 2 条、卡 167 ms）；
   * 共用以后，正反面设置相同的造型（吸血鬼和女巫都是双面）共用同一份着色器，贴图、颜色照样按各自的材质取
   */
  const fadeAlpha = uniform(1).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => (object?.userData.alpha as number | undefined) ?? 1);
  // 材质自己的不透明度（本来就半透明的部分）× 这个访客此刻的淡入淡出
  const fadeOpacity = materialOpacity.mul(fadeAlpha);
  const sharedMats = new Map<THREE.Material, { opaque: THREE.Material; fade: THREE.Material }>();
  const toNode = (m: THREE.Material): THREE.Material => {
    if ((m as THREE.NodeMaterial).isNodeMaterial) return m.clone();
    return core.renderer.library.fromMaterial(m.clone()) ?? m.clone();
  };
  const variantsOf = (m: THREE.Material) => {
    let e = sharedMats.get(m);
    if (e) return e;
    const base = m.clone();
    const s = base as THREE.MeshStandardMaterial;
    // 模型本身没有自发光时才补这层光；吉祥物自带的发光（比如会亮的眼睛）原样保留
    if (s.isMeshStandardMaterial && !s.emissiveMap && s.emissive.getHex() === 0) {
      // 自发光 = 底色 × BOUNCE_LIGHT（有贴图就用贴图，保住花纹）
      s.emissive.copy(s.color).multiplyScalar(BOUNCE_LIGHT);
      if (s.map) {
        s.emissive.setScalar(BOUNCE_LIGHT);
        s.emissiveMap = s.map;
      }
    }
    const opaque = toNode(base);
    const fade = toNode(base) as THREE.NodeMaterial;
    fade.transparent = true;
    fade.opacityNode = fadeOpacity;
    base.dispose();
    e = { opaque, fade };
    sharedMats.set(m, e);
    return e;
  };

  const makeModel = ({ spec, asset }: Outfit, personality: Personality) => {
    if (asset) return { model: SkeletonUtils.clone(asset.template), front: asset.front, halfWidth: asset.halfWidth, height: asset.height };
    // 备用小人自己的正面就是 +z，不用 facingOffset
    const n = normalizeModel(createFallbackCharacter(personality), spec.targetHeight, 0, spec.maxLength);
    return { model: n.template, front: n.front, halfWidth: n.halfWidth, height: n.height };
  };

  const create = (npc: NpcState, outfit = outfitFor()): Visual => {
    const { spec, asset } = outfit;
    // 登记簿用（outfitOf）：预编译的临时访客编号是负的，不记；备用小人不是哪一套衣服，不记
    if (npc.id > 0 && asset) outfitIds.set(npc.id, spec.url.slice(spec.url.lastIndexOf('/') + 1).replace(/\.glb$/, '').replace(/^placeholder-/, ''));
    const { model, front, halfWidth, height } = makeModel(outfit, npc.personality);
    const parts: Visual['parts'] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const src = mesh.material;
      const list = (Array.isArray(src) ? src : [src]).map(variantsOf);
      parts.push({
        mesh,
        opaque: Array.isArray(src) ? list.map((x) => x.opaque) : list[0].opaque,
        fade: Array.isArray(src) ? list.map((x) => x.fade) : list[0].fade,
        sources: Array.isArray(src) ? src : [src],
      });
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
        // 动画会把四肢甩出绑定姿势的包围球：放大一点，免得被视锥剔除时一闪一闪
        const sk = mesh as THREE.SkinnedMesh;
        sk.computeBoundingSphere();
        sk.boundingSphere!.radius *= 1.3;
      }
    });

    let mixer: THREE.AnimationMixer | null = null;
    const actions: Visual['actions'] = {};
    if (asset && asset.clips.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const pose of POSES) {
        const name = spec.clips[pose];
        const clip = name ? THREE.AnimationClip.findByName(asset.clips, name) : null;
        if (!clip) continue;
        const a = mixer.clipAction(clip);
        if (pose === 'scared' || pose === 'scared2') {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = true;
        }
        // 片段一直在播，只改权重（权重为 0 的片段 three 不做插值）
        a.setEffectiveWeight(pose === 'idle' ? 1 : 0);
        a.play();
        // 有循环区间的片段：时间由 blendClips 按区间自己推进，mixer 不动它（timeScale 一直是 0）
        const win = spec.loops?.[pose];
        if (win) {
          a.timeScale = 0;
          a.time = win[0];
        }
        actions[pose] = a;
      }
    }

    const root = new THREE.Group();
    root.name = `visitor-${npc.id}`;
    const body = new THREE.Group();
    // 剪切没法用 position / rotation / scale 表示，pose 的矩阵每帧手动写
    const pose = new THREE.Group();
    pose.name = 'pose';
    pose.matrixAutoUpdate = false;
    pose.add(model);
    body.add(pose);
    root.add(body);
    parent.add(root);

    const torch = torches.find((t) => !owner.has(t)) ?? null;
    if (torch) owner.set(torch, npc.id);
    const v: Visual = {
      id: npc.id, outfit, root, body, pose, parts, mixer, actions,
      weights: { idle: 1, walk: 0, run: 0, scared: 0, look: 0, afraid: 0, flee: 0, scared2: 0 },
      mix: { look: 0, afraid: 0, flee: 0 }, noticing: !!npc.notice, scaredCount: npc.id, scaredPick: null, loopT: 0,
      front, halfWidth, height, torch,
      x: npc.pos.x, z: npc.pos.z, heading: npc.heading, look: npc.lookDir, speed: npc.speed, mode: npc.mode, nervous: npc.nervous, fear: npc.fear, uneasy: npc.uneasy ?? 0,
      alpha: 0, leaving: false, jumpT: -1, lastJump: -10, jump: jumpShape(0), turnSrc: null, turn: { x: 0, v: 0 },
      cower: 0, lean: 0, shake: 0, bounce: 0, phase: 0,
      seed: (npc.id * 7.31) % 10,
      headingS: { x: npc.heading, v: 0 }, lookS: { x: npc.lookDir, v: 0 }, speedS: { x: npc.speed, v: 0 },
    };
    setAlpha(v, 0);
    return v;
  };

  const setAlpha = (v: Visual, a: number) => {
    v.alpha = a;
    for (const p of v.parts) {
      // 透明度按物体传给共用的半透明材质（fadeAlpha 读 userData.alpha）；完全不透明时换回不透明那份（排序、阴影、AO 都正常）
      p.mesh.userData.alpha = a;
      const want = a < 0.999 ? p.fade : p.opaque;
      if (p.mesh.material !== want) p.mesh.material = want;
    }
  };

  const destroy = (v: Visual) => {
    parent.remove(v.root);
    v.mixer?.stopAllAction();
    v.mixer?.uncacheRoot(v.mixer.getRoot());
    if (!v.outfit.asset) {
      // 备用小人的几何体、材质是每人一份的（共用材质表里它的那几项也一起删）
      v.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      for (const p of v.parts) {
        for (const m of p.sources) {
          const e = sharedMats.get(m);
          e?.opaque.dispose();
          e?.fade.dispose();
          sharedMats.delete(m);
          m.dispose();
        }
      }
    }
    if (v.torch) {
      v.torch.park();
      owner.delete(v.torch);
    }
    visuals.delete(v.id);
  };

  /**
   * 受惊跳起。amount：这一下涨的恐惧值（决定跳多高），src：吓到它的物件位置（落地后转向它；null 不转）。
   * 还在空中时又被吓：不从头跳（会从半空一下掉回地面），只改转身的目标
   */
  const startJump = (v: Visual, time: number, amount: number, src: Vec2 | null) => {
    if (src) v.turnSrc = src;
    if (time - v.lastJump < 0.5) return; // 事件和状态切换可能同时到，只跳一次
    if (v.jumpT >= v.jump.c && v.jumpT < v.jump.l) return;
    v.lastJump = time;
    v.jumpT = 0;
    v.jump = jumpShape(startleStrength(amount));
    // 只播一次的受惊片段：scared / scared2 轮流（只有一个就用那个），从头重播
    const have = SCARED.filter((p) => v.actions[p]);
    v.scaredPick = have.length ? have[((v.scaredCount++ % have.length) + have.length) % have.length] : null;
    if (v.scaredPick) v.actions[v.scaredPick]!.reset().play();
  };

  /**
   * 动画片段的权重和播放速率。受惊片段（有的话）在僵住期间淡入；其余按平滑速度在待机 / 走 / 跑之间连续过渡，播放速率跟模拟速度。
   * 待机那一档按 look（察觉）> afraid（紧张）> idle 分，跑的那一档逃跑时用 flee、平时用 run（缺的片段不代替），
   * 「代替」的程度各自平滑（mix），不会因为状态一下子翻转就硬切。
   * 返回此刻「在走」的程度（0..1）：没有走路片段时用它驱动程序化弹跳
   */
  const blendClips = (v: Visual, dt: number, cw: number): number => {
    const A = v.actions;
    const s = Math.max(0, v.speedS.x);
    const moving = smoothstep(GAIT.walk[0], GAIT.walk[1], s);
    const fast = A.run || A.flee ? smoothstep(GAIT.run[0], GAIT.run[1], s) : 0;
    const fleeing = v.mode === 'fleeing';
    // 受惊：这一次轮到的那个片段在僵住期间淡入，另一个淡出（两次受惊挨得近时交叉淡化，合起来不超过 1）
    for (const p of SCARED) {
      const want = A[p] && v.mode === 'startled' && v.scaredPick === p ? 1 : 0;
      v.weights[p] += (want - v.weights[p]) * approach(GAIT.scaredRate, dt);
    }
    const scared = v.weights.scared + v.weights.scared2;
    if (scared > 1) for (const p of SCARED) v.weights[p] /= scared;
    const rest = 1 - Math.min(1, scared);
    // 代替：目标 0 / 1，按各自的速率平滑（片段缺了目标就是 0）
    v.mix.look += ((A.look && v.noticing ? 1 : 0) - v.mix.look) * approach(MIX.look, dt);
    v.mix.afraid += ((A.afraid && v.nervous && !fleeing ? 1 : 0) - v.mix.afraid) * approach(MIX.afraid, dt);
    v.mix.flee += ((A.flee && fleeing ? 1 : 0) - v.mix.flee) * approach(MIX.flee, dt);
    // 停着的那一档：look 先占，剩下的 afraid 占，再剩下的才是 idle
    const still = (1 - moving) * rest;
    v.weights.look = still * v.mix.look;
    v.weights.afraid = still * (1 - v.mix.look) * v.mix.afraid;
    v.weights.idle = still - v.weights.look - v.weights.afraid;
    // 跑的那一档：flee 占 mix.flee，剩下的是 run；两个都没有的份额并到走路片段上（没有跑就走得快一点，没有待机就停在绑定姿势上，呼吸由程序化层补）
    const quick = moving * fast * rest;
    v.weights.flee = A.flee ? quick * v.mix.flee : 0;
    v.weights.run = A.run ? quick * (A.flee ? 1 - v.mix.flee : 1) : 0;
    v.weights.walk = moving * (1 - fast) * rest + (quick - v.weights.flee - v.weights.run);
    for (const p of POSES) A[p]?.setEffectiveWeight(v.weights[p]);
    const sim = Math.max(0, v.speed);
    const { spec } = v.outfit;
    if (A.walk) A.walk.timeScale = sim * spec.walkRateAt1ms * (1 + COWER.cadence * cw);
    if (A.run) A.run.timeScale = sim * spec.runRateAt1ms;
    if (A.flee) {
      const rate = sim * (spec.fleeRateAt1ms ?? spec.runRateAt1ms);
      const win = spec.loops?.flee;
      if (win) {
        // flee 只循环区间里的那一段（开头结尾是站着，见 CharacterSpec.loops）：时间自己推进、绕回区间起点，timeScale 保持 0
        v.loopT = (v.loopT + dt * rate) % (win[1] - win[0]);
        A.flee.time = win[0] + v.loopT;
      } else A.flee.timeScale = rate;
    }
    return A.walk ? 0 : moving;
  };

  const step = (v: Visual, dt: number, time: number) => {
    // —— 淡入淡出 ——
    const target = v.leaving ? 0 : 1;
    if (v.alpha !== target) setAlpha(v, Math.max(0, Math.min(1, v.alpha + (target ? dt / FADE.in : -dt / FADE.out))));
    if (v.leaving) {
      // 出门后 state 里已经没有这个人了：照最后的方向和速度再走几步，边走边淡出
      v.x += Math.cos(v.heading) * v.speed * dt;
      v.z += Math.sin(v.heading) * v.speed * dt;
    }

    // —— 位置、朝向：朝向和手电方向用临界阻尼弹簧平滑（按最短的那一边转），速度也平滑 ——
    v.root.position.set(v.x, 0, v.z);
    smoothDampAngle(v.headingS, v.heading, SMOOTH.heading, dt);
    smoothDampAngle(v.lookS, v.look, SMOOTH.look, dt);
    smoothDamp(v.speedS, v.speed, GAIT.speed, dt);
    const heading = v.headingS.x, look = v.lookS.x;
    v.root.rotation.y = yawFor(heading);

    // —— 缩身强度：恐惧值过了紧张线开始，越接近 100 越缩；逃跑时收掉 ——
    const cowerWant = v.mode === 'fleeing' ? 0 : cowerTarget(v.nervous, v.fear);
    v.cower += (cowerWant - v.cower) * approach(COWER.rate, dt);
    const cw = v.cower;

    // —— 动画片段 ——
    const procWalk = blendClips(v, dt, cw);
    v.mixer?.update(dt);

    // —— 程序化层（有没有片段都叠加）——
    let y = 0, sy = 1, roll = 0, side = 0, shear = 0;
    // 没有走路片段：上下弹跳 + 触地压扁 + 左右摇摆（缩着身子时步子小、跳得低、更碎）
    v.bounce += (procWalk - v.bounce) * approach(10, dt);
    if (v.bounce > 1e-3) {
      const k = v.height;
      v.phase += (dt * Math.max(0, v.speedS.x) * Math.PI) / (BOUNCE.step * k * (1 - COWER.stride * cw));
      const b = Math.abs(Math.sin(v.phase));
      y += BOUNCE.height * k * b * v.bounce * (1 - COWER.hop * cw);
      sy *= 1 - BOUNCE.squash * (1 - b) ** 4 * v.bounce;
      roll += BOUNCE.roll * Math.cos(v.phase) * v.bounce;
    }
    // 没有待机片段：站着时微微呼吸
    if (!v.actions.idle) sy *= 1 + BREATHE.amp * Math.sin(time * BREATHE.rate + v.seed) * (1 - smoothstep(GAIT.walk[0], GAIT.walk[1], v.speedS.x));
    // 受惊跳起（高度、挤压拉伸、后缩按这一下的受惊强度定）
    if (v.jumpT >= 0) {
      v.jumpT += dt;
      const j = jumpPose(v.jumpT, v.jump);
      y += j.y;
      sy *= j.sy;
      shear -= j.recoil;
      if (v.jumpT >= v.jump.end) v.jumpT = -1;
    }
    // 发抖：紧张，或者鬼魂贴在身边发毛
    const shakeWant = v.mode === 'fleeing' ? 0 : Math.max(v.nervous ? 1 : 0, v.uneasy);
    v.shake += (shakeWant - v.shake) * approach(SHAKE.rate, dt);
    if (v.shake > 1e-3) {
      const s = v.seed, TAU = Math.PI * 2;
      roll += SHAKE.rot * v.shake * (Math.sin(time * TAU * SHAKE.hz[0] + s) * 0.6 + Math.sin(time * TAU * SHAKE.hz[1] + s * 2) * 0.4);
      side += SHAKE.pos * v.shake * Math.sin(time * TAU * SHAKE.hz[2] + s * 3);
    }
    // 逃跑前倾
    const leanTarget = v.mode === 'fleeing' ? LEAN.flee : Math.min(Math.max(0, v.speedS.x), 2) * LEAN.perSpeed;
    v.lean += (leanTarget - v.lean) * approach(LEAN.rate, dt);
    // 缩着身子：上身前探、整个人矮一截
    shear += COWER.hunch * cw;
    const shrinkY = 1 - COWER.shrink * cw, shrinkXZ = 1 - COWER.narrow * cw;

    // —— 受惊转身：空中不转；落地以后、僵住期间快速转向吓到它的物件，之后转回模拟的朝向 ——
    const holding = v.turnSrc !== null && (v.mode === 'startled' || v.jumpT >= 0);
    const inJump = v.jumpT >= 0 && v.jumpT < v.jump.f; // 从蹲下到落地：身体不转
    if (inJump) v.turn.v = 0;
    else {
      const want = holding && v.turnSrc ? angleOf(v.turnSrc.x - v.x, v.turnSrc.z - v.z) - heading : 0;
      smoothDampAngle(v.turn, want, holding ? TURN.hold : TURN.release, dt);
    }
    if (!holding) v.turnSrc = null;
    const twist = v.turn.x;

    v.body.position.set(side, y, 0);
    // twist 用方向角表示，rotation.y 的符号和方向角相反（见 yawFor）
    v.body.rotation.set(v.lean, -twist, roll);
    const sxz = 1 / Math.sqrt(sy);
    v.body.scale.set(sxz, sy, sxz);
    // pose：缩身 + 剪切（z += shear × y：脚底不动，越高往前挪得越多）。
    // 行优先：x' = shrinkXZ·x，y' = shrinkY·y，z' = shear·shrinkY·y + shrinkXZ·z
    v.pose.matrix.set(
      shrinkXZ, 0, 0, 0,
      0, shrinkY, 0, 0,
      0, shear * shrinkY, shrinkXZ, 0,
      0, 0, 0, 1,
    );
    v.pose.matrixWorldNeedsUpdate = true;

    // —— 手电：在照向那一侧的身体轮廓之外（包围盒在这个方向上的支撑距离）、右手边，高度跟着跳 ——
    // 包围盒按身体此刻的朝向（加上转身）和缩放算；握手电的手跟着上身走：前探 / 后缩、逃跑前倾都会把手带过去。
    // 照的方向始终是模拟的 lookDir（光锥就是视野），转身只转身体，不转手电。
    // 手的高度按模型实际身高等比：按身长缩小的模型（占位狐狸 0.72 米高）手电不会悬在头顶上
    if (v.torch) {
      const facing = heading + twist;
      const rel = look - facing;
      const k = sxz * shrinkXZ;
      const reach = (Math.abs(Math.cos(rel)) * v.front + Math.abs(Math.sin(rel)) * v.halfWidth) * k + HAND.ahead;
      const lx = Math.cos(look), lz = Math.sin(look);
      const hand = (v.outfit.spec.flashlightHeight ?? FLASHLIGHT_HEIGHT) * Math.min(1, v.height / v.outfit.spec.targetHeight) * shrinkY;
      const lean = hand * Math.sin(v.lean), hunch = hand * shear; // 逃跑前倾沿 heading，前探 / 后缩沿身体朝向
      v.torch.update({
        x: v.x + lx * reach - lz * HAND.side + Math.cos(heading) * lean + Math.cos(facing) * hunch,
        y: hand + y,
        z: v.z + lz * reach + lx * HAND.side + Math.sin(heading) * lean + Math.sin(facing) * hunch,
        dir: look,
        power: v.alpha,
        nervous: v.nervous,
      }, dt, time);
    }
  };

  /** 预编译用的临时访客（屋子中间并排站着）。torch = false 时不分手电（手电只有 TORCH_SLOTS 支） */
  const stageFake = (outfit: Outfit, i: number, torch = true) => {
    const v = create({
      id: -1 - i, name: '', personality: 'average', pos: { x: 8 + i * 0.9, z: 6 }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0,
      fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
    }, outfit);
    if (!torch && v.torch) {
      v.torch.park();
      owner.delete(v.torch);
      v.torch = null;
    }
    return v;
  };
  /**
   * 临时访客不做视锥剔除：compileAsync 和那一帧真画都只管镜头（和阴影相机）视锥里的物体，第三人称开场镜头在门口，
   * 屋子中间的临时访客不在视锥里，等于没编（实测第一个访客进门卡 0.53 秒，新建的正是它的场景和阴影管线，2026-10-28）。
   * 手上的手电（手柄、灯头、光锥）也一样。返回被关掉的那些，用完开回来（手电是常驻的，会给真访客用）
   */
  const uncullAll = (vs: Visual[]) => {
    const out: THREE.Object3D[] = [];
    const uncull = (root: THREE.Object3D) => root.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        out.push(o);
      }
    });
    for (const v of vs) {
      uncull(v.root);
      if (v.torch) uncull(v.torch.hand);
    }
    return out;
  };
  /**
   * 一套造型的两个临时访客（不透明、半透明各一个，两份材质都要编；torch：前一个拿着点亮的手电，手电的管线也要编），
   * 站到地板下面、不做视锥剔除：它们照样画进场景和月光的阴影图（管线就编了），玩家又看不见。手电不挪（它照向前方的地板）。
   * 返回临时访客和 release()（收走，剔除开回来）
   */
  const stagePair = (outfit: Outfit, i: number, torch: boolean) => {
    const vs = [stageFake(outfit, i, torch), stageFake(outfit, i + 1, false)];
    setAlpha(vs[0], 1);
    setAlpha(vs[1], 0.5);
    for (const v of vs) {
      step(v, 0, 0);
      v.root.position.y = -3;
      v.root.updateMatrixWorld(true);
    }
    const unculled = uncullAll(vs);
    let staged = true;
    const release = () => {
      if (!staged) return;
      staged = false;
      for (const o of unculled) o.frustumCulled = true;
      for (const v of vs) {
        v.leaving = true;
        destroy(v);
      }
    };
    return { vs, release };
  };

  /** compileOutfit 核对过 three 的版本和内部接口了（只核对、只警告一次） */
  let checkedInternals = false;
  /**
   * 把临时访客要用的渲染管线异步编好（GPU 在后台编，不卡），而且编出来的正是之后真画时用的那一批：真画时一条管线都不用现编。
   * three r186 的 compileAsync 原样用有两处和真画对不上（2026-10-29 记下 GPUDevice.createRenderPipeline / createShaderModule 查到）：
   * 1. 渲染上下文按「套在第几层 render 调用里」分（RenderContexts.get 的 callDepth），compileAsync 总是第 0 层；
   *    真画时场景 pass 套在后处理里是第 1 层，阴影图又套在场景 pass 里是第 2 层。上下文的编号在节点缓存键里，对不上，真画时就重建节点；
   *    蒙皮网格每重建一次，骨骼矩阵的 uniform 名（NodeBuffer_<节点编号>）都是新的，着色器源码变了，GPU 只能从头同步编
   *    （之前「compileAsync 编出来的访客管线对不上、白编」就是这个）。这里在 compileAsync 同步取上下文的那一下，把层数换成真画时的。
   * 2. 阴影图根本不编（ShadowNode 在预编译时直接跳过）。真画阴影时 renderObject 把这盏灯共用的阴影材质临时改成这个网格要的状态
   *    （正反面、透明、按底色贴图透明度的 colorNode），画完改回去；compileAsync 排队时改、真正编的时候已经改回去了，编出来也对不上。
   *    这里照同样的状态做一份代理材质（连属性的先后都照抄：缓存键按 Object.keys 的顺序拼），用它在月光的阴影图上编。
   *    只编月光：每个访客走到哪儿都在它的阴影图里；手电的阴影管线和原来一样，第一次照到时才编（一次一两条，没有超过 50 ms 的帧）。
   * 半透明的双面材质真画时分背面、正面两遍（side 临时改成 BackSide / FrontSide），也是编的时候已经改回 DoubleSide，同样用两份代理（克隆，只改 side）。
   *
   * 对不上的时候（换了 three 版本、内部接口没了或者行为变了；材质没有底色贴图，见 shadowPasses）不会出错，只是退回现编：
   * 开局之前（开场遮罩挡着），兜底真画的那几帧会把场景 pass 和阴影一起现编，看不见。开局以后（只有 WebGPU 会在开局以后加）卡在两处：
   *   · 场景 pass 对不上（层数对不上、内部接口没了）：兜底真画的那几帧在游戏里同步现编，加入轮换的那一刻就卡；
   *   · 月光阴影对不上：开局以后临时访客不投影，兜底兜不住，要等第一个穿这套的真访客进门时才同步现编，进门时卡（2026-10-29 实测 83–167 ms）
   * ——正好是这里要消掉的两下。所以第一次编的时候核对一遍版本和接口，对不上就打一条警告（只打一次），要重跑 scripts/stall-outfits.mjs。
   *
   * 代理材质用完不 dispose：dispose 会把它们的渲染对象一起销毁，编好的节点和管线引用数归零，three 就从缓存里删掉，
   * 真访客进门时又得同步重编（2026-10-29 实测：缓存键完全一样，照样现编，就是这个原因）。不 dispose 的代理也不会被回收：
   * r186 的 RenderObjects 把每个渲染对象放在一个强引用的 Set 里（_renderObjects），不 dispose 就一直留着，
   * 临时访客的网格、骨骼和代理材质整局都在，缓存的节点和管线也就一直有人引用。占用有上限：每套造型 2 个临时访客、2–5 个代理
   */
  const compileOutfit = (roots: THREE.Object3D[], target: OutfitCompileTarget, label: string): Promise<void> => {
    const R = core.renderer;
    const internals = R as unknown as RendererInternals;
    const contexts = internals._renderContexts;
    const getContext = typeof contexts?.get === 'function' ? contexts.get : null;
    const shadowNodes = typeof internals._getShadowNodes === 'function' ? internals._getShadowNodes.bind(R) : null;
    if (!checkedInternals) {
      checkedInternals = true;
      const problems = [
        THREE.REVISION !== THREE_VERIFIED ? `three 是 r${THREE.REVISION}，核对过的是 r${THREE_VERIFIED}` : '',
        getContext ? '' : 'renderer._renderContexts.get 没有了',
        shadowNodes ? '' : 'renderer._getShadowNodes 没有了',
      ].filter(Boolean);
      if (problems.length) {
        console.warn(`[characters] 后加的访客造型预编译可能对不上（${problems.join('；')}）：会退回普通的 compileAsync。`
          + '开局以后加进来的造型，加入轮换的那一刻（兜底真画现编场景管线）和第一个穿它的访客进门时（现编月光阴影）都可能卡一下。'
          + '用 node scripts/stall-outfits.mjs 核对');
      }
    }
    let warnedColor = false;
    const meshes: THREE.Mesh[] = [];
    for (const r of roots) r.traverse((o) => { if ((o as THREE.Mesh).isMesh && !Array.isArray((o as THREE.Mesh).material)) meshes.push(o as THREE.Mesh); });
    const jobs: Promise<void>[] = [];
    /** 用 material 编 mesh 的一遍，渲染上下文当作套在第 depth 层（compileAsync 收集物体、取上下文都在调用的同步部分里） */
    const compileWith = (mesh: THREE.Mesh, material: THREE.Material, camera: THREE.Camera, depth: number) => {
      const own = mesh.material;
      mesh.material = material;
      if (contexts && getContext) contexts.get = (t, mrt) => getContext.call(contexts, t, mrt, depth);
      try {
        jobs.push(R.compileAsync(mesh, camera, core.scene));
      } finally {
        if (contexts && getContext) contexts.get = getContext;
        mesh.material = own;
      }
    };
    /** 半透明双面材质真画时的两遍（背面、正面）各一份代理，其余的就是它自己 */
    const scenePasses = (m: THREE.Material) => {
      if (!(m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass)) return [m];
      return [THREE.BackSide, THREE.FrontSide].map((side) => {
        const p = m.clone();
        p.side = side;
        return p;
      });
    };
    /** 照 three r186 的 _getShadowMaterial 和 renderObject 套在阴影材质上的状态做代理（一遍一份），属性的先后不能改 */
    const shadowPasses = (m: THREE.Material) => {
      if (!shadowNodes) return [];
      const src = m as THREE.Material & Record<string, unknown>;
      const nodes = shadowNodes(m);
      if (!nodes.colorNode && !warnedColor) {
        // 没有底色贴图（也没有 colorNode / castShadowNode / maskNode）的材质，three 真画阴影时用的是阴影材质自己的那个
        // vec4(0,0,0,1) 节点，代理里 new 的这个编号不同（节点的缓存键默认就是编号），对不上。只影响阴影，场景管线照样编得上
        warnedColor = true;
        console.warn(`[characters] ${label}：材质 ${m.name || m.type} 没有底色贴图，月光阴影的预编译对不上，`
          + '穿这套的访客第一次进门时会同步现编阴影管线、卡一下');
      }
      const side = R.shadowMap.type === THREE.VSMShadowMap ? (m.shadowSide ?? m.side) : (m.shadowSide ?? SHADOW_SIDE[m.side]);
      // 原式照抄：不透明的材质算出来是 null 不是 false，缓存键里两者不一样
      const transparent = m.transparent || (src.transmission as number) > 0 || (src.transmissionNode && (src.transmissionNode as THREE.Node).isNode) || (src.backdropNode && (src.backdropNode as THREE.Node).isNode);
      const sides = transparent === true && side === THREE.DoubleSide ? [THREE.BackSide, THREE.FrontSide] : [side];
      return sides.map((s) => {
        const p = new THREE.NodeMaterial();
        // 按名字逐个赋值（类型上不细分节点种类），先后就是赋值的先后
        const w = p as unknown as Record<string, unknown>;
        w.colorNode = vec4(0, 0, 0, 1);
        w.isShadowPassMaterial = true;
        w.name = 'ShadowMaterial';
        w.blending = THREE.NoBlending;
        w.fog = false;
        if ((src.positionNode as THREE.Node | null)?.isNode) w.positionNode = src.positionNode;
        w.alphaTest = m.alphaTest;
        w.alphaMap = src.alphaMap;
        w.displacementMap = src.displacementMap;
        w.displacementScale = src.displacementScale;
        w.displacementBias = src.displacementBias;
        w.transparent = transparent;
        w.side = s;
        if (nodes.colorNode) w.colorNode = nodes.colorNode;
        if (nodes.depthNode) w.depthNode = nodes.depthNode;
        if (nodes.positionNode) w.positionNode = nodes.positionNode;
        return p;
      });
    };
    const saved = { target: R.getRenderTarget(), mrt: R.getMRT(), toneMapping: R.toneMapping, colorSpace: R.outputColorSpace };
    try {
      const sceneTarget = target.sceneTarget();
      // 有后处理：场景 pass 套在 RenderPipeline.render() 里画（第 1 层），那时色调映射关掉、输出是线性的，照它的状态编；
      // 没有后处理：直接画到画布（第 0 层）
      const sceneDepth = sceneTarget ? 1 : 0;
      if (sceneTarget) {
        R.toneMapping = THREE.NoToneMapping;
        R.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      }
      R.setMRT(null);
      R.setRenderTarget(sceneTarget);
      for (const mesh of meshes) for (const m of scenePasses(mesh.material as THREE.Material)) compileWith(mesh, m, target.camera, sceneDepth);
      const suns: THREE.DirectionalLight[] = [];
      core.scene.traverse((o) => { if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.Light).castShadow) suns.push(o as THREE.DirectionalLight); });
      for (const sun of suns) {
        if (!sun.shadow.map) continue;
        R.setRenderTarget(sun.shadow.map as THREE.RenderTarget);
        for (const mesh of meshes) {
          if (!mesh.castShadow) continue;
          for (const m of shadowPasses(mesh.material as THREE.Material)) compileWith(mesh, m, sun.shadow.camera, sceneDepth + 1);
        }
      }
    } finally {
      R.setRenderTarget(saved.target);
      R.setMRT(saved.mrt);
      R.toneMapping = saved.toneMapping;
      R.outputColorSpace = saved.colorSpace;
    }
    return Promise.all(jobs).then(() => undefined);
  };
  /** 等 n 帧（标签页藏起来时 rAF 不跑，就一直等着，回来接着做） */
  const frames = (n: number) => new Promise<void>((resolve) => {
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
  /**
   * 一套造型的贴图先传上 GPU，每帧一张（2048 的底色贴图连同 mipmap 一起传，挤在第一次画的那一帧里会多卡一截）。
   * stop() 为真就不传了（返回 false）
   */
  const uploadTextures = async (asset: CharacterAsset, stop: () => boolean) => {
    const textures = new Set<THREE.Texture>();
    asset.template.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      for (const mat of Array.isArray(m) ? m : m ? [m] : []) {
        for (const v of Object.values(mat)) if ((v as THREE.Texture | null)?.isTexture) textures.add(v as THREE.Texture);
      }
    });
    for (const t of textures) {
      if (stop()) return false;
      core.renderer.initTexture(t);
      await frames(1);
    }
    return true;
  };
  /**
   * 加一套造型的重活能不能放在后台做（不占主线程）。WebGPU 能：贴图上传（copyExternalImageToTexture）、管线编译都是异步的。
   * WebGL2 不能：贴图上传 texSubImage2D 在主线程上同步做，2048 的底色贴图一张约 60 ms（2026-10-29 实测 58 ms）；
   * 没有 KHR_parallel_shader_compile 时着色器链接也是同步的。这时只在开场遮罩还挡着的时候加，开局以后就不加了
   */
  const inBackground = !(core.renderer.backend as unknown as { isWebGLBackend?: boolean }).isWebGLBackend;
  /** WebGL2 上已经开局了：这时再加新造型会在主线程上卡（main.ts 点了开始要等其余几套加完，正常碰不上，见 outfitsBeforeStart） */
  const startedBlocking = (target: OutfitCompileTarget) => !inBackground && !target.hidden();
  /** 后台下载好的一套：上传贴图 → 临时访客站到地板下面（先藏着）→ 异步编管线 → 露出来真画几帧 → 收走、放进轮换 */
  const join = async (outfit: Outfit, index: number, target: OutfitCompileTarget) => {
    const drop = (why: string) => console.warn(`[characters] ${outfit.spec.url}：${why}，不加进轮换`);
    /** 先别动手：不等了（stopStreaming），或者 WebGL2 上已经开局了 */
    const abandon = () => {
      if (!givenUp && !startedBlocking(target)) return false;
      drop(givenUp ? '其余造型等得太久，不等了' : '这个浏览器开局以后加新造型会卡（贴图同步上传）');
      return true;
    };
    if (abandon()) return;
    if (outfit.asset && !(await uploadTextures(outfit.asset, abandon))) return;
    if (disposed || abandon()) return;
    // 开场遮罩还挡着时照开场前那一套（stageOutfits）的做法：前一个临时访客拿一支点亮的手电、两个都投影，
    // 兜底真画那几帧把手电的阴影管线也编好（WebGL2 上第一次被手电照到时现编要卡 80 ms 左右，WebGPU 上很快）。开局以后不拿手电、不投影，见下
    const shadows = target.hidden();
    const { vs, release } = stagePair(outfit, 100 + 2 * index, shadows);
    const roots = vs.map((v) => v.root);
    try {
      // compileOutfit 在调用的同步部分就收集完物体了：调用时露着，一返回就藏起来，编完之前真画的帧不会碰到它们（碰到就是同步现编）
      const compiled = compileOutfit(roots, target, outfit.spec.url);
      for (const r of roots) r.visible = false;
      await compiled;
    } catch (err) {
      // 编不成也照样放进轮换：开局之前，下面露出来真画的那几帧现编（遮罩挡着，看不见）；开局以后（WebGPU）卡两下：
      // 场景管线在下面那几帧现编，加入轮换时卡；阴影管线等第一个穿这套的访客进门时现编，进门时卡
      console.warn(`[characters] 造型 ${outfit.spec.url} 的管线预编译失败，改为真画时现编`, err);
    }
    // 编的这段时间里 WebGL2 上开局了（main.ts 等这里加完，正常碰不上）：不露出来真画了，免得在游戏里现编。
    // 「不等了」但遮罩还挡着时照样往下加完：已经编好了，几帧就完，main.ts 等它收尾才开场
    if (startedBlocking(target)) {
      release();
      drop('编的时候开局了');
      return;
    }
    // 编完露出来真画几帧兜底：万一有没编到的，在这里现编，不等到有人穿着它进门。开局之前连阴影一起兜住（遮罩挡着）；
    // 已经开局了（只有 WebGPU）就只画场景 pass、不投影：临时访客不做视锥剔除，投影的话会画进每一支亮着的手电的阴影图，屋里人多时
    // 一帧里要现编好几条手电的阴影管线。所以开局以后：场景 pass 要是没编到（compileOutfit 对不上），在这几帧现编，加入轮换的那一刻卡；
    // 月光阴影要是没编到，这里兜不住，要等第一个穿这套的访客进门时才现编，进门时卡。
    // 手电的阴影和原来一样，等手电第一次照到穿这套的人时再编（WebGPU 上一次一两条，不卡）
    if (!target.hidden()) {
      for (const v of vs) {
        v.root.traverse((o) => { o.castShadow = false; });
        if (v.torch) {
          v.torch.park();
          owner.delete(v.torch);
          v.torch = null;
        }
      }
    }
    for (const r of roots) r.visible = true;
    await frames(JOIN_FRAMES);
    release();
    if (disposed) return;
    usable.push(outfit);
    console.log(`[characters] ${outfit.spec.url} 编好，加入轮换（第 ${usable.length} 套，页面打开后 ${Math.round(performance.now())} ms）`);
  };

  /**
   * 一套一套下载：下载好一套就接着下一套，同时把下载好的这套按顺序编好、放进轮换（见 streamOutfits）。
   * 编要等 after；只在开场遮罩挡着时才能加的（WebGL2，见 inBackground）不等：标题页上、点了开始遮罩还留着的那几秒正好用来加
   */
  const streamRest = async (target: OutfitCompileTarget, after?: Promise<unknown>) => {
    let joined: Promise<void> = Promise.resolve();
    const ready = (inBackground && after ? after : Promise.resolve()).catch(() => undefined);
    for (const [i, spec] of rest.entries()) {
      // 不等了，或者 WebGL2 上已经开局了（照理碰不上，见 outfitsBeforeStart）：剩下的不下载了，正在下载的那一套已经 abort 掉
      if (disposed || givenUp || startedBlocking(target)) break;
      let asset: CharacterAsset;
      try {
        // 只停下载、不停解析（见 loadCharacterAsset 的 signal）
        asset = await loadCharacterAsset(spec, streamAbort.signal);
      } catch (err) {
        if (givenUp || disposed) break; // 停掉的
        console.warn(`[characters] 角色模型 ${spec.url} 加载失败，跳过。`, err);
        continue;
      }
      const outfit: Outfit = { spec, asset };
      joined = joined.then(() => ready).then(() => join(outfit, i, target)).catch((err) => console.warn('[characters] 造型加入轮换失败', err));
    }
    await joined;
  };

  const view: CharactersView = {
    get source() { return usable.some((o) => o.asset) ? 'glb' : 'fallback'; },
    async prewarm(compile) {
      // 只编第一套、只编镜头看得见的部分（不关视锥剔除，见 stageOutfits）
      const vs = [stageFake(usable[0], 0)];
      try {
        for (const v of vs) {
          setAlpha(v, 1);
          step(v, 0, 0); // 摆好位置、点亮手电（手电的光锥材质也要编）
        }
        await compile();
        for (const v of vs) {
          setAlpha(v, 0.5);
          step(v, 0, 0);
        }
        await compile();
      } finally {
        // 材质是共用的（见 variantsOf），临时访客走了它们还在，真访客进门直接用编好的管线
        for (const v of vs) {
          v.leaving = true;
          destroy(v);
        }
      }
    },
    stageOutfits() {
      // 第一套的临时访客多拿一支点亮的手电（手电的管线也要编）
      const staged = usable.map((outfit, i) => stagePair(outfit, 1 + 2 * i, i === 0));
      return () => {
        for (const s of staged) s.release();
      };
    },
    streamOutfits(target, after) {
      streamDone = streamRest(target, after);
      return streamDone;
    },
    get outfitsBeforeStart() { return !inBackground; },
    stopStreaming() {
      if (!givenUp) {
        givenUp = true;
        streamAbort.abort();
        console.warn('[characters] 其余造型等得太久，不等了：没下载完的停掉，还没开始加的不加了（正在编的那一套编完照样加）');
      }
      return streamDone;
    },
    onEvent(e: SimEvent, state: WorldState) {
      // object 为 null 是被别人的尖叫吓到（模拟里不僵住），不跳。
      // 不是物件（鬼魂贴着后颈吹的那一口凉气，object = GHOST_SOURCE）：模拟在同一步把手电对准了来源，就朝手电的方向转
      if (e.type === 'startle' && e.object !== null) {
        const o = state.objects.find((x) => x.id === e.object);
        const n = o ? undefined : state.npcs.find((x) => x.id === e.npc);
        const src = o ? { x: o.pos.x, z: o.pos.z } : n ? { x: n.pos.x + Math.cos(n.lookDir), z: n.pos.z + Math.sin(n.lookDir) } : null;
        const v = visuals.get(e.npc);
        if (v) startJump(v, now, e.amount, src);
        else pendingJump.set(e.npc, { amount: e.amount, src });
      } else if (e.type === 'exit') {
        const v = visuals.get(e.npc);
        if (v) v.leaving = true;
      }
    },
    update({ dt, time, state }: FrameCtx) {
      now = time;
      const alive = new Set<number>();
      for (const npc of state.npcs) {
        if (npc.mode === 'gone') continue;
        alive.add(npc.id);
        let v = visuals.get(npc.id);
        if (!v) {
          v = create(npc);
          visuals.set(npc.id, v);
        }
        if (v.leaving) continue;
        // 兜底：没收到受惊事件（比如事件分发给模块之前就建了角色）也要跳，按中等强度、不转身
        if (npc.mode === 'startled' && v.mode !== 'startled') startJump(v, time, STARTLE.fallback, null);
        v.x = npc.pos.x;
        v.z = npc.pos.z;
        v.heading = npc.heading;
        v.look = npc.lookDir;
        v.speed = npc.speed;
        v.mode = npc.mode;
        v.nervous = npc.nervous;
        v.uneasy = npc.uneasy ?? 0;
        v.fear = npc.fear;
        // 察觉那一拍开始：look 从头播（察觉中换了新的来源不重播）
        const noticing = !!npc.notice;
        if (noticing && !v.noticing) v.actions.look?.reset().play();
        v.noticing = noticing;
      }
      for (const v of [...visuals.values()]) {
        const pj = pendingJump.get(v.id);
        if (pj) {
          pendingJump.delete(v.id);
          startJump(v, time, pj.amount, pj.src);
        }
        if (!alive.has(v.id)) v.leaving = true;
        step(v, dt, time);
        if (v.leaving && v.alpha <= 0) destroy(v);
      }
      // 池子里有空出来的手电，就分给还没拿到的人（同时在屋里的人超过池子大小时才会发生）
      for (const v of visuals.values()) {
        if (v.torch || v.leaving) continue;
        const free = torches.find((t) => !owner.has(t));
        if (!free) break;
        v.torch = free;
        owner.set(free, v.id);
      }
    },
    setQuality(q) {
      for (const t of torches) t.setQuality(q);
    },
    inspect() {
      return [...visuals.values()].map((v) => {
        const top = POSES.filter((p) => v.actions[p]).sort((a, b) => v.weights[b] - v.weights[a])[0];
        return {
          id: v.id,
          pose: top ? v.actions[top]!.getClip().name : null,
          weights: Object.fromEntries(POSES.filter((p) => v.actions[p]).map((p) => [p, +v.weights[p].toFixed(2)])),
          procedural: v.bounce > 0.5,
          jumpY: +v.body.position.y.toFixed(3),
          jumpPeak: +v.jump.height.toFixed(3),
          scaleY: +(v.body.scale.y * v.pose.matrix.elements[5]).toFixed(3),
          lean: +v.lean.toFixed(3),
          shake: +v.shake.toFixed(2),
          cower: +v.cower.toFixed(2),
          // 列优先：elements[5] = 缩身后的 y 缩放，elements[6] = 剪切 × y 缩放
          hunch: +(v.pose.matrix.elements[6] / Math.max(1e-6, v.pose.matrix.elements[5])).toFixed(3),
          twist: +(-v.body.rotation.y).toFixed(3),
          speed: +v.speedS.x.toFixed(2),
          alpha: +v.alpha.toFixed(2),
          yaw: +v.root.rotation.y.toFixed(3),
          torch: v.torch !== null,
        };
      });
    },
    dispose() {
      disposed = true;
      streamAbort.abort();
      for (const v of [...visuals.values()]) destroy(v);
      for (const t of torches) t.dispose();
    },
  };
  return view;
}
