// 访客角色：加载吉祥物 GLB（失败时换备用小人），每个访客一份克隆，按状态播放动画，
// 再叠一层程序化动作（受惊跳起并在空中扭向吓人的东西、紧张发抖、害怕时缩着身子走并不时回头张望、逃跑前倾；
// 没有走路片段时用挤压回弹代替），手里拿着手电。
//
// 换模型只改 config/character.ts。这里负责把任何来路的模型「摆正」：
//   量包围盒（Box3.setFromObject：量化 / meshopt 压缩过的模型，accessor 里的范围不是真实尺寸）→
//   缩放到 targetHeight、x / z 居中、脚底贴 y = 0 → 抵消 facingOffset，让正面朝 +z
//
// 节点层级：root（模拟给的位置、朝向）→ body（跳起高度、扭身 / 前倾 / 摇晃、挤压拉伸）→ pose（缩身、前探的剪切）→ 模型。
// 全部是表现层的偏移，不回写模拟状态；手电的方向始终是模拟的 lookDir（光锥就是视野），只有握手电的位置跟着身体走
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER, FLASHLIGHT_HEIGHT, type CharacterSpec } from '../config/character';
import { FEAR, SPAWN } from '../config/visitors';
import type { FrameCtx, Module, RenderCore } from '../engine/types';
import { angleOf, wrapAngle, yawFor } from '../lib/angle';
import type { NpcMode, NpcState, Personality, SimEvent, Vec2, WorldState } from '../sim/types';
import { createFallbackCharacter } from './fallbackCharacter';
import { createFlashlight, type Flashlight } from './flashlight';

/** 淡入（进门）/ 淡出（出门）的秒数 */
const FADE = { in: 0.6, out: 0.6 };
/** 动画片段之间交叉淡入淡出的秒数 */
const CROSSFADE = 0.2;
/** 朝向、手电方向的平滑速率（1/秒）：模拟层已经限速转向，这里只抹掉逐帧的台阶 */
const SMOOTH = { heading: 14, look: 22 };
/**
 * 受惊强度：startle 事件的 amount（这一下涨了多少恐惧，约 5–72）→ 0..1。
 * 先线性映射 min..max，再开 curve 次方（< 1：中等的惊吓也跳得明显，最大的那几下才顶到头）。
 * 没有事件、只看到状态切到 startled 时（兜底）用 fallback
 */
const STARTLE = { min: 6, max: 70, curve: 0.6, fallback: 24 };
/**
 * 受惊跳起：先压扁蓄力，再跳起（上升 sine.out、下落 power3.in），落地压扁、过冲回弹。
 * 写成 [最小, 最大] 的，按受惊强度插值（单位：秒 / 米 / 比例）。最长 0.78 秒，在僵住的 0.8 秒（FEAR.startleTime）之内。
 * recoil：在空中往后仰（剪切：每米高度往后挪多少米），离地时仰起、落地前收回——吓得往后一缩
 */
const JUMP = {
  crouch: 0.08,
  rise: [0.2, 0.28],
  fall: [0.17, 0.22],
  land: 0.05,
  settle: 0.15,
  height: [0.3, 0.8],
  squash: [0.24, 0.38],
  stretch: [0.14, 0.3],
  overshoot: [0.06, 0.1],
  recoil: [0.1, 0.32],
} as const;
/**
 * 空中扭身：离地那一刻起，身体（不是手电）像弹簧一样猛地扭向吓到它的物件，带一点过冲；
 * 僵住期间一直对着它，僵住结束后再慢慢转回模拟给的朝向。freq：赫兹，damping：阻尼比（< 1 才有过冲）
 */
const TURN = { freq: 3, damping: 0.42, releaseFreq: 1.1, releaseDamping: 1 };
/**
 * 害怕时缩着身子（恐惧值 ≥ FEAR.nervous 开始，越接近 100 越明显）：
 * 强度 = atNervous（刚到紧张线）→ 1（恐惧值 100），逃跑时为 0（逃跑有自己的前倾）。强度 1 时：
 *   hunch   上身往前探（剪切：每米高度往前挪多少米，脚底不动；对长身子的四足模型也不会把头插进地板）
 *   shrink  身高缩短的比例；narrow  宽度、长度缩小的比例
 *   cadence 走路片段的步频加快的比例（速度由模拟定，步频快了步子就小）
 *   stride / hop  没有走路片段时：每步步长、弹起高度缩小的比例
 *   rate    强度平滑的速率（1/秒）
 */
const COWER = { atNervous: 0.4, hunch: 0.36, shrink: 0.18, narrow: 0.05, cadence: 0.4, stride: 0.35, hop: 0.4, rate: 3 };
/**
 * 缩着身子时不时回头张望：身体快速扭过去（sine.out）、停一下、再转回来。
 * angle：扭身角度（弧度），乘以 (0.6 + 0.4 × 缩身强度)；every：两次张望的间隔（秒），[缩身强度 0 时, 1 时]，
 * 再乘 1 ± jitter 的随机数；minCower：缩身强度低于它不张望
 */
const GLANCE = { angle: 1.25, in: 0.12, hold: 0.22, out: 0.26, every: [4.5, 1.8], jitter: 0.35, minCower: 0.15 } as const;
const GLANCE_END = GLANCE.in + GLANCE.hold + GLANCE.out;
/** 逃跑时身体前倾（弧度）；平时随速度略微前倾 */
const LEAN = { flee: 0.3, perSpeed: 0.03, rate: 8 };
/** 紧张发抖：转角（弧度）和位移（米）的幅度 */
const SHAKE = { rot: 0.035, pos: 0.007, rate: 5 };
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
  /** 归一化好的模板：身高 targetHeight、x / z 居中、脚底 y = 0、正面朝 +z（已抵消 facingOffset） */
  template: THREE.Object3D;
  clips: THREE.AnimationClip[];
  /** 包围盒的半长（前后，米）和半宽（左右，米）：摆正后 x / z 已居中 */
  front: number;
  halfWidth: number;
  /** 调试信息：原始尺寸（模型单位）、缩放倍数、三角形数 */
  rawSize: THREE.Vector3;
  scale: number;
  triangles: number;
}

/** 把任意模型摆正：缩放到 height、x / z 居中、脚底贴地、正面转到 +z。返回包了两层的新节点 */
export function normalizeModel(model: THREE.Object3D, height: number, facingOffset: number) {
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = size.y > 1e-6 ? height / size.y : 1;
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
  return { template: face, front, halfWidth, rawSize: size, scale };
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
  const n = normalizeModel(gltf.scene, spec.targetHeight, spec.facingOffset);
  console.log(`[characters] 原始尺寸 ${n.rawSize.toArray().map((v) => v.toFixed(2)).join(' × ')}，缩放 ${n.scale.toPrecision(3)}，${triangles} 个三角形`);
  return { template: n.template, clips, front: n.front, halfWidth: n.halfWidth, rawSize: n.rawSize, scale: n.scale, triangles };
}

type Pose = 'idle' | 'walk' | 'run' | 'scared';

/** 一次跳起的形状（按受惊强度从 JUMP 插值出来，跳起时算一次） */
interface JumpShape {
  /** 各阶段结束的时刻（秒）：压扁、上升、下落、落地、回弹 */
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

interface Visual {
  id: number;
  root: THREE.Group;
  body: THREE.Group;
  /** body 和模型之间：缩身、前探（剪切），矩阵手动设置 */
  pose: THREE.Group;
  materials: THREE.Material[];
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<Pose, THREE.AnimationAction>>;
  action: THREE.AnimationAction | null;
  front: number;
  halfWidth: number;
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
  // 表现层自己的状态
  alpha: number;
  leaving: boolean;
  jumpT: number;
  lastJump: number;
  jump: JumpShape;
  /** 这次受惊是被哪个物件吓到的（房屋坐标）；null = 不扭身 */
  turnSrc: Vec2 | null;
  /** 空中扭身：身体相对模拟朝向的偏转（方向角，弧度）和它的角速度 */
  turn: number;
  turnVel: number;
  /** 缩身强度 0..1（平滑后） */
  cower: number;
  /** 回头张望：进行中的时刻（-1 = 没在张望）、方向（±1）、这次的幅度、距下一次还有几秒、整体权重（受惊 / 逃跑时收掉） */
  glanceT: number;
  glanceDir: number;
  glanceAmp: number;
  glanceIn: number;
  glanceW: number;
  rng: number;
  lean: number;
  shake: number;
  bounce: number;
  phase: number;
  seed: number;
  /** 平滑后的身体朝向、手电方向（方向角） */
  headingS: number;
  lookS: number;
}

export interface CharacterDebug {
  id: number;
  pose: string | null;
  procedural: boolean;
  jumpY: number;
  /** 这次（或上一次）跳起的最高点（米） */
  jumpPeak: number;
  scaleY: number;
  lean: number;
  /** 紧张发抖的强度 0..1 */
  shake: number;
  /** 缩身强度 0..1 */
  cower: number;
  /** 上身前探（正）/ 后仰（负）的剪切量：每米高度挪多少米 */
  hunch: number;
  /** 身体相对模拟朝向扭过去的角度（弧度）：空中扭身 + 回头张望 */
  twist: number;
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
const smooth = (u: number) => u * u * (3 - 2 * u);
const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);
const span = (r: readonly [number, number], t: number) => lerp(r[0], r[1], t);

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

/** 受惊跳起的时间线：返回离地高度、y 方向缩放（xz 按体积守恒反算）、后仰的剪切量 */
function jumpPose(t: number, J: JumpShape): { y: number; sy: number; recoil: number } {
  if (t < J.c) return { y: 0, sy: 1 - J.squash * sineOut(t / J.c), recoil: 0 };
  if (t < J.r) {
    const u = (t - J.c) / (J.r - J.c);
    // 离地瞬间从压扁弹成拉长，越接近顶点越恢复原状；往后仰随上升一起到位
    return {
      y: J.height * sineOut(u),
      sy: lerp(1 - J.squash, 1 + J.stretch * (1 - u), sineOut(Math.min(1, u / 0.2))),
      recoil: J.recoil * sineOut(u),
    };
  }
  if (t < J.f) {
    const u = (t - J.r) / (J.f - J.r);
    const k = u * u * u; // power3.in
    return { y: J.height * (1 - k), sy: 1 + J.stretch * 0.8 * k, recoil: J.recoil * (1 - 0.7 * u) };
  }
  if (t < J.l) {
    const u = (t - J.f) / (J.l - J.f);
    return { y: 0, sy: lerp(1 - J.squash * 0.8, 1 + J.overshoot, sineOut(u)), recoil: J.recoil * 0.3 * (1 - u) };
  }
  const u = Math.min(1, (t - J.l) / (J.end - J.l));
  return { y: 0, sy: 1 + J.overshoot * Math.cos(u * Math.PI * 1.5) * (1 - u), recoil: 0 };
}

/** 回头张望的时间线：0 → 1（扭过去）→ 停住 → 0（转回来） */
function glanceCurve(t: number): number {
  if (t < GLANCE.in) return sineOut(t / GLANCE.in);
  if (t < GLANCE.in + GLANCE.hold) return 1;
  return 1 - smooth(clamp01((t - GLANCE.in - GLANCE.hold) / GLANCE.out));
}

/** 恐惧值 → 缩身强度目标：没到紧张线为 0，到线是 atNervous，恐惧值 100 时为 1 */
function cowerTarget(nervous: boolean, fear: number): number {
  if (!nervous) return 0;
  return lerp(COWER.atNervous, 1, clamp01((fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));
}

export async function createCharactersView(core: RenderCore): Promise<CharactersView> {
  const parent = core.houseRoot;
  const spec = CHARACTER;
  let asset: CharacterAsset | null = null;
  try {
    asset = await loadCharacterAsset(spec);
  } catch (err) {
    console.warn(`[characters] 角色模型 ${spec.url} 加载失败，改用备用小人。`, err);
  }

  const torches: Flashlight[] = Array.from({ length: TORCH_SLOTS }, () => createFlashlight(parent, core.quality));
  const owner = new Map<Flashlight, number>();
  const visuals = new Map<number, Visual>();
  /** 受惊事件到的时候这个人的角色还没建好（同一帧刚进门）：先记下，建好后再跳 */
  const pendingJump = new Map<number, { amount: number; src: Vec2 | null }>();
  let now = 0;

  const makeModel = (personality: Personality) => {
    if (asset) return { model: SkeletonUtils.clone(asset.template), front: asset.front, halfWidth: asset.halfWidth };
    // 备用小人自己的正面就是 +z，不用 facingOffset
    const n = normalizeModel(createFallbackCharacter(personality), spec.targetHeight, 0);
    return { model: n.template, front: n.front, halfWidth: n.halfWidth };
  };

  const create = (npc: NpcState): Visual => {
    const { model, front, halfWidth } = makeModel(npc.personality);
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
      for (const pose of ['idle', 'walk', 'run', 'scared'] as const) {
        const name = spec.clips[pose];
        const clip = name ? THREE.AnimationClip.findByName(asset.clips, name) : null;
        if (!clip) continue;
        const a = mixer.clipAction(clip);
        if (pose === 'scared') {
          a.setLoop(THREE.LoopOnce, 1);
          a.clampWhenFinished = true;
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
    const rng = 1 + ((npc.id * 48271) % 2147483646);
    const v: Visual = {
      id: npc.id, root, body, pose, materials, mixer, actions, action: null, front, halfWidth, torch,
      x: npc.pos.x, z: npc.pos.z, heading: npc.heading, look: npc.lookDir, speed: npc.speed, mode: npc.mode, nervous: npc.nervous, fear: npc.fear,
      alpha: 0, leaving: false, jumpT: -1, lastJump: -10, jump: jumpShape(0), turnSrc: null, turn: 0, turnVel: 0,
      cower: 0, glanceT: -1, glanceDir: 1, glanceAmp: 0, glanceIn: 0, glanceW: 0, rng,
      lean: 0, shake: 0, bounce: 0, phase: 0,
      seed: (npc.id * 7.31) % 10, headingS: npc.heading, lookS: npc.lookDir,
    };
    v.glanceIn = 0.8 + random(v) * 1.5; // 刚害怕起来时，第一次回头来得快一点
    setAlpha(v, 0);
    return v;
  };

  /** 每个角色自己的随机数（Park–Miller），只影响回头张望的节奏和方向 */
  const random = (v: Visual) => {
    v.rng = (v.rng * 16807) % 2147483647;
    return (v.rng - 1) / 2147483646;
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
    if (!asset) {
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
   * 受惊跳起。amount：这一下涨的恐惧值（决定跳多高），src：吓到它的物件位置（空中扭向它；null 不扭）。
   * 还在空中时又被吓：不从头跳（会从半空一下掉回地面），只改扭身的目标
   */
  const startJump = (v: Visual, time: number, amount: number, src: Vec2 | null) => {
    if (src) v.turnSrc = src;
    if (time - v.lastJump < 0.5) return; // 事件和状态切换可能同时到，只跳一次
    if (v.jumpT >= v.jump.c && v.jumpT < v.jump.l) return;
    v.lastJump = time;
    v.jumpT = 0;
    v.jump = jumpShape(startleStrength(amount));
    // 只播一次的受惊片段：还在受惊时又被吓，状态没变、play() 会当成同一个动作直接返回，这里让它从头重播
    if (v.action && v.action === v.actions.scared) v.action.reset().play();
  };

  /** 按状态挑动画片段；没有对应片段时返回 null（走路改用程序化弹跳，待机就停在绑定姿势上呼吸） */
  const pickAction = (v: Visual): { action: THREE.AnimationAction | null; pose: Pose; moving: boolean } => {
    const A = v.actions;
    if (v.mode === 'startled' && A.scared) return { action: A.scared, pose: 'scared', moving: false };
    if (v.speed < 0.1) return { action: A.idle ?? null, pose: 'idle', moving: false };
    if (v.mode === 'fleeing' || v.speed > 2) return { action: A.run ?? A.walk ?? null, pose: 'run', moving: true };
    return { action: A.walk ?? null, pose: 'walk', moving: true };
  };

  const play = (v: Visual, next: THREE.AnimationAction | null, instant: boolean) => {
    if (next === v.action) return;
    const prev = v.action;
    if (next) {
      next.reset();
      next.setEffectiveWeight(1);
      if (instant) next.play();
      else next.fadeIn(CROSSFADE).play();
    }
    if (prev) {
      if (instant) prev.stop();
      else prev.fadeOut(CROSSFADE);
    }
    v.action = next;
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

    // —— 位置、朝向：朝向和手电方向都平滑插值（按最短的那一边转）——
    v.root.position.set(v.x, 0, v.z);
    v.headingS += wrapAngle(v.heading - v.headingS) * approach(SMOOTH.heading, dt);
    v.lookS += wrapAngle(v.look - v.lookS) * approach(SMOOTH.look, dt);
    const heading = v.headingS, look = v.lookS;
    v.root.rotation.y = yawFor(heading);

    // —— 缩身强度：恐惧值过了紧张线开始，越接近 100 越缩；逃跑时收掉 ——
    const cowerWant = v.mode === 'fleeing' ? 0 : cowerTarget(v.nervous, v.fear);
    v.cower += (cowerWant - v.cower) * approach(COWER.rate, dt);
    const cw = v.cower;

    // —— 动画片段 ——
    const pick = pickAction(v);
    play(v, pick.action, v.mixer !== null && v.action === null && !v.leaving && v.alpha < 0.05);
    if (pick.action) {
      if (pick.pose === 'walk' || pick.pose === 'run') {
        const isRun = pick.action === v.actions.run;
        const rate = isRun ? spec.runRateAt1ms : spec.walkRateAt1ms;
        // 缩着身子走：步频加快（速度不变，步子就小了）
        pick.action.timeScale = v.speed * rate * (isRun ? 1 : 1 + COWER.cadence * cw);
      } else pick.action.timeScale = 1;
    }
    v.mixer?.update(dt);

    // —— 程序化层（有没有片段都叠加）——
    let y = 0, sy = 1, roll = 0, side = 0, shear = 0;
    // 没有走路片段：上下弹跳 + 触地压扁 + 左右摇摆（缩着身子时步子小、跳得低、更碎）
    const wantBounce = pick.moving && !pick.action ? 1 : 0;
    v.bounce += (wantBounce - v.bounce) * approach(10, dt);
    if (v.bounce > 1e-3) {
      const k = spec.targetHeight;
      v.phase += (dt * v.speed * Math.PI) / (BOUNCE.step * k * (1 - COWER.stride * cw));
      const b = Math.abs(Math.sin(v.phase));
      y += BOUNCE.height * k * b * v.bounce * (1 - COWER.hop * cw);
      sy *= 1 - BOUNCE.squash * (1 - b) ** 4 * v.bounce;
      roll += BOUNCE.roll * Math.cos(v.phase) * v.bounce;
    }
    // 没有待机片段：微微呼吸
    if (!pick.moving && !pick.action) sy *= 1 + BREATHE.amp * Math.sin(time * BREATHE.rate + v.seed);
    // 受惊跳起（高度、挤压拉伸、后仰按这一下的受惊强度定）
    if (v.jumpT >= 0) {
      v.jumpT += dt;
      const j = jumpPose(v.jumpT, v.jump);
      y += j.y;
      sy *= j.sy;
      shear -= j.recoil;
      if (v.jumpT >= v.jump.end) v.jumpT = -1;
    }
    // 紧张发抖
    v.shake += ((v.nervous && v.mode !== 'fleeing' ? 1 : 0) - v.shake) * approach(SHAKE.rate, dt);
    if (v.shake > 1e-3) {
      const s = v.seed;
      roll += SHAKE.rot * v.shake * (Math.sin(time * 47 + s) * 0.6 + Math.sin(time * 31 + s * 2) * 0.4);
      side += SHAKE.pos * v.shake * Math.sin(time * 53 + s * 3);
    }
    // 逃跑前倾
    const leanTarget = v.mode === 'fleeing' ? LEAN.flee : Math.min(v.speed, 2) * LEAN.perSpeed;
    v.lean += (leanTarget - v.lean) * approach(LEAN.rate, dt);
    // 缩着身子：上身前探、整个人矮一截
    shear += COWER.hunch * cw;
    const shrinkY = 1 - COWER.shrink * cw, shrinkXZ = 1 - COWER.narrow * cw;

    // —— 空中扭身：离地后像弹簧一样扭向吓到它的物件，僵住期间保持，之后转回模拟的朝向 ——
    const airborne = v.jumpT >= v.jump.c;
    const hold = v.turnSrc !== null && (airborne || (v.jumpT < 0 && v.mode === 'startled'));
    const turnRaw = hold && v.turnSrc ? angleOf(v.turnSrc.x - v.x, v.turnSrc.z - v.z) - heading : 0;
    // 目标取离当前扭角最近的那一圈：模拟朝向在跳的过程中转了半圈（吓到就逃跑）时，目标会在 ±π 处跳变，不能绕远路转一整圈
    const turnWant = v.turn + wrapAngle(turnRaw - v.turn);
    const w = 2 * Math.PI * (hold ? TURN.freq : TURN.releaseFreq), zeta = hold ? TURN.damping : TURN.releaseDamping;
    // 半隐式欧拉，切成小步（dt 最大 0.1 秒，弹簧很硬）
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(1 / 120, left);
      v.turnVel += (-w * w * (v.turn - turnWant) - 2 * zeta * w * v.turnVel) * h;
      v.turn += v.turnVel * h;
    }
    v.turn = wrapAngle(v.turn); // 差整圈的角度看起来一样，规整回 (-π, π]，免得越积越大
    if (!hold && v.jumpT < 0 && v.mode !== 'startled') v.turnSrc = null;

    // —— 回头张望：缩着身子、没在受惊 / 逃跑时，隔一会儿快速扭身往后看一眼 ——
    const glanceOk = v.mode !== 'startled' && v.mode !== 'fleeing' && v.jumpT < 0 && cw >= GLANCE.minCower;
    v.glanceW += ((glanceOk ? 1 : 0) - v.glanceW) * approach(10, dt);
    if (v.glanceT >= 0) {
      v.glanceT += dt;
      if (v.glanceT >= GLANCE_END) v.glanceT = -1;
    } else if (glanceOk && (v.glanceIn -= dt) <= 0) {
      v.glanceT = 0;
      v.glanceDir = random(v) < 0.5 ? -1 : 1;
      v.glanceAmp = GLANCE.angle * (0.6 + 0.4 * cw);
      v.glanceIn = span(GLANCE.every, cw) * (1 + GLANCE.jitter * (2 * random(v) - 1));
    }
    const glance = v.glanceT >= 0 ? v.glanceDir * v.glanceAmp * glanceCurve(v.glanceT) * v.glanceW : 0;
    const twist = v.turn + glance;

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
    // 包围盒按身体此刻的朝向（加上扭身）和缩放算；握手电的手跟着上身走：前探 / 后仰、逃跑前倾都会把手带过去。
    // 照的方向始终是模拟的 lookDir（光锥就是视野），回头张望只扭身体，不扭手电
    if (v.torch) {
      const facing = heading + twist;
      const rel = look - facing;
      const k = sxz * shrinkXZ;
      const reach = (Math.abs(Math.cos(rel)) * v.front + Math.abs(Math.sin(rel)) * v.halfWidth) * k + HAND.ahead;
      const lx = Math.cos(look), lz = Math.sin(look);
      const hand = FLASHLIGHT_HEIGHT * shrinkY;
      const lean = hand * Math.sin(v.lean), hunch = hand * shear; // 逃跑前倾沿 heading，前探 / 后仰沿身体朝向
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
    get source() { return asset ? 'glb' : 'fallback'; },
    async prewarm(compile) {
      const fake: NpcState = {
        id: -1, name: '', personality: 'average', pos: { x: 8, z: 6 }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0,
        fear: 0, nervous: false, speed: 0, screaming: 0, path: [],
      };
      const v = create(fake);
      try {
        setAlpha(v, 1);
        step(v, 0, 0); // 摆好位置、点亮手电（手电的光锥材质也要编）
        await compile();
        setAlpha(v, 0.5);
        step(v, 0, 0);
        await compile();
      } finally {
        // 试过只移出场景、不 dispose 材质（怕 three 回收刚编好的管线），实测第一个访客进门的卡顿没有变化（都是约 150 ms），
        // 所以照常释放（2026-10-27）
        v.leaving = true;
        destroy(v);
      }
    },
    onEvent(e: SimEvent, state: WorldState) {
      // object 为 null 是被别人的尖叫吓到（模拟里不僵住），不跳
      if (e.type === 'startle' && e.object !== null) {
        const o = state.objects.find((x) => x.id === e.object);
        const src = o ? { x: o.pos.x, z: o.pos.z } : null;
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
        // 兜底：没收到受惊事件（比如事件分发给模块之前就建了角色）也要跳，按中等强度、不扭身
        if (npc.mode === 'startled' && v.mode !== 'startled') startJump(v, time, STARTLE.fallback, null);
        v.x = npc.pos.x;
        v.z = npc.pos.z;
        v.heading = npc.heading;
        v.look = npc.lookDir;
        v.speed = npc.speed;
        v.mode = npc.mode;
        v.nervous = npc.nervous;
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
      return [...visuals.values()].map((v) => ({
        id: v.id,
        pose: v.action ? v.action.getClip().name : null,
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
        alpha: +v.alpha.toFixed(2),
        yaw: +v.root.rotation.y.toFixed(3),
        torch: v.torch !== null,
      }));
    },
    dispose() {
      for (const v of [...visuals.values()]) destroy(v);
      for (const t of torches) t.dispose();
    },
  };
  return view;
}
