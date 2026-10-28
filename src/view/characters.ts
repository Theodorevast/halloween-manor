// 访客角色：加载吉祥物 GLB（失败时换备用小人），每个访客一份克隆，按速度和状态混合动画片段，
// 再叠一层克制的程序化动作（受惊时小跳一下、落地后快速转向吓人的东西，紧张时轻微发抖、缩着点身子，逃跑时略前倾；
// 没有走路片段时用挤压回弹代替），手里拿着手电。
// 2026-10-28 第二次试玩（「动作太夸张、生硬、穿模」）之后收敛：跳得低、不在空中扭身、不再不停回头张望，
// 转身和起步停步都平滑（朝向用临界阻尼弹簧，动画按平滑后的速度混合）。
//
// 换模型只改 config/character.ts（VISITOR_SPECS 有几套就轮流分给进门的人；一套都加载不到时用 CHARACTER）。
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
 */
const BOUNCE_LIGHT = 0.1;
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
export function normalizeModel(model: THREE.Object3D, height: number, facingOffset: number, maxLength = Infinity) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
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
  const after = new THREE.Box3().setFromObject(face);
  const front = Math.max(0.05, after.max.z, -after.min.z);
  const halfWidth = Math.max(0.05, after.max.x, -after.min.x);
  return { template: face, front, halfWidth, height: size.y * scale, rawSize: size, scale };
}

export async function loadCharacterAsset(spec: CharacterSpec = CHARACTER): Promise<CharacterAsset> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder); // 吉祥物可能是 gltfpack / meshopt 压缩导出的
  const gltf = await loader.loadAsync(spec.url);
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
  const n = normalizeModel(gltf.scene, spec.targetHeight, spec.facingOffset, spec.maxLength);
  console.log(`[characters] 原始尺寸 ${n.rawSize.toArray().map((v) => v.toFixed(2)).join(' × ')}，缩放 ${n.scale.toPrecision(3)}，身高 ${n.height.toFixed(2)} 米，${triangles} 个三角形`);
  return { template: n.template, clips, front: n.front, halfWidth: n.halfWidth, height: n.height, rawSize: n.rawSize, scale: n.scale, triangles };
}

type Pose = 'idle' | 'walk' | 'run' | 'scared';
const POSES: Pose[] = ['idle', 'walk', 'run', 'scared'];

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
interface Outfit {
  spec: CharacterSpec;
  asset: CharacterAsset | null;
}

interface Visual {
  id: number;
  /** 这个人穿的是哪一套：动画片段名、步频速率、手电高度都按它的配置 */
  outfit: Outfit;
  root: THREE.Group;
  body: THREE.Group;
  /** body 和模型之间：缩身、前探（剪切），矩阵手动设置 */
  pose: THREE.Group;
  materials: THREE.Material[];
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<Pose, THREE.AnimationAction>>;
  /** 各片段此刻的权重（受惊片段单独平滑，其余按平滑速度算） */
  weights: Record<Pose, number>;
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

export async function createCharactersView(core: RenderCore): Promise<CharactersView> {
  const parent = core.houseRoot;
  // 换装吉祥物几套一起加载，加载失败的跳过；一套都没有就用 CHARACTER，它也失败就用备用小人
  const load = async (specs: CharacterSpec[]) => {
    const got = await Promise.allSettled(specs.map((s) => loadCharacterAsset(s)));
    return got.flatMap((r, i): Outfit[] => {
      if (r.status === 'fulfilled') return [{ spec: specs[i], asset: r.value }];
      console.warn(`[characters] 角色模型 ${specs[i].url} 加载失败，跳过。`, r.reason);
      return [];
    });
  };
  let outfits = VISITOR_SPECS.length ? await load(VISITOR_SPECS) : [];
  if (!outfits.length) outfits = await load([CHARACTER]);
  if (!outfits.length) {
    console.warn('[characters] 没有可用的角色模型，改用备用小人。');
    outfits = [{ spec: CHARACTER, asset: null }];
  }
  /** 进门的人按编号轮流分一套：相邻两个人穿得不一样 */
  const outfitFor = (id: number) => outfits[((id % outfits.length) + outfits.length) % outfits.length];

  const torches: Flashlight[] = Array.from({ length: TORCH_SLOTS }, () => createFlashlight(parent, core.quality));
  const owner = new Map<Flashlight, number>();
  const visuals = new Map<number, Visual>();
  /** 受惊事件到的时候这个人的角色还没建好（同一帧刚进门）：先记下，建好后再跳 */
  const pendingJump = new Map<number, { amount: number; src: Vec2 | null }>();
  let now = 0;

  const makeModel = ({ spec, asset }: Outfit, personality: Personality) => {
    if (asset) return { model: SkeletonUtils.clone(asset.template), front: asset.front, halfWidth: asset.halfWidth, height: asset.height };
    // 备用小人自己的正面就是 +z，不用 facingOffset
    const n = normalizeModel(createFallbackCharacter(personality), spec.targetHeight, 0, spec.maxLength);
    return { model: n.template, front: n.front, halfWidth: n.halfWidth, height: n.height };
  };

  const create = (npc: NpcState, outfit = outfitFor(npc.id)): Visual => {
    const { spec, asset } = outfit;
    const { model, front, halfWidth, height } = makeModel(outfit, npc.personality);
    const materials: THREE.Material[] = [];
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // 每个访客自己一份材质：淡入淡出要单独改透明度
      const own = (m: THREE.Material) => {
        const c = m.clone();
        c.userData.baseTransparent = c.transparent;
        const s = c as THREE.MeshStandardMaterial;
        // 模型本身没有自发光时才补这层光；吉祥物自带的发光（比如会亮的眼睛）原样保留
        if (s.isMeshStandardMaterial && !s.emissiveMap && s.emissive.getHex() === 0) {
          // 自发光 = 底色 × BOUNCE_LIGHT（有贴图就用贴图，保住花纹）
          s.emissive.copy(s.color).multiplyScalar(BOUNCE_LIGHT);
          if (s.map) {
            s.emissive.setScalar(BOUNCE_LIGHT);
            s.emissiveMap = s.map;
          }
        }
        materials.push(c);
        return c;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
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
        if (pose === 'scared') {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = true;
        }
        // 片段一直在播，只改权重（权重为 0 的片段 three 不做插值）
        a.setEffectiveWeight(pose === 'idle' ? 1 : 0);
        a.play();
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
      id: npc.id, outfit, root, body, pose, materials, mixer, actions, weights: { idle: 1, walk: 0, run: 0, scared: 0 },
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
    for (const m of v.materials) {
      m.opacity = a;
      // 完全不透明时回到不透明队列（排序、阴影都正常）；换 transparent 时 three.js 会自动换渲染管线
      const tr = a < 0.999 || m.userData.baseTransparent === true;
      if (m.transparent !== tr) m.transparent = tr;
    }
  };

  const destroy = (v: Visual) => {
    parent.remove(v.root);
    v.mixer?.stopAllAction();
    v.mixer?.uncacheRoot(v.mixer.getRoot());
    for (const m of v.materials) m.dispose();
    if (!v.outfit.asset) {
      // 备用小人的几何体是每人一份的
      v.root.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
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
    // 只播一次的受惊片段：从头重播
    v.actions.scared?.reset().play();
  };

  /**
   * 动画片段的权重和播放速率。受惊片段（有的话）在僵住期间淡入；其余按平滑速度在待机 / 走 / 跑之间连续过渡，播放速率跟模拟速度。
   * 返回此刻「在走」的程度（0..1）：没有走路片段时用它驱动程序化弹跳
   */
  const blendClips = (v: Visual, dt: number, cw: number): number => {
    const A = v.actions;
    const s = Math.max(0, v.speedS.x);
    const moving = smoothstep(GAIT.walk[0], GAIT.walk[1], s);
    const running = A.run ? smoothstep(GAIT.run[0], GAIT.run[1], s) : 0;
    const scaredWant = A.scared && v.mode === 'startled' ? 1 : 0;
    v.weights.scared += (scaredWant - v.weights.scared) * approach(GAIT.scaredRate, dt);
    const rest = 1 - v.weights.scared;
    v.weights.idle = (1 - moving) * rest;
    v.weights.walk = moving * (1 - running) * rest;
    v.weights.run = moving * running * rest;
    // 片段缺了的那一份并到能代替它的片段上：没有跑就走得快一点，没有待机就停在绑定姿势上（呼吸由程序化层补）
    if (!A.run) v.weights.walk += v.weights.run;
    for (const p of POSES) A[p]?.setEffectiveWeight(v.weights[p]);
    const sim = Math.max(0, v.speed);
    const { spec } = v.outfit;
    if (A.walk) A.walk.timeScale = sim * spec.walkRateAt1ms * (1 + COWER.cadence * cw);
    if (A.run) A.run.timeScale = sim * spec.runRateAt1ms;
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
      const hand = FLASHLIGHT_HEIGHT * Math.min(1, v.height / v.outfit.spec.targetHeight) * shrinkY;
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

  const view: CharactersView = {
    get source() { return outfits.some((o) => o.asset) ? 'glb' : 'fallback'; },
    async prewarm(compile) {
      // 每套造型各放一个（贴图组合不同的材质可能各要一条管线），并排站着
      const vs = outfits.map((outfit, i) => create({
        id: -1 - i, name: '', personality: 'average', pos: { x: 8 + i * 0.9, z: 6 }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0,
        fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
      }, outfit));
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
        // 试过只移出场景、不 dispose 材质（怕 three 回收刚编好的管线），实测第一个访客进门的卡顿没有变化（都是约 150 ms），
        // 所以照常释放（2026-10-27）
        for (const v of vs) {
          v.leaving = true;
          destroy(v);
        }
      }
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
      for (const v of [...visuals.values()]) destroy(v);
      for (const t of torches) t.dispose();
    },
  };
  return view;
}
