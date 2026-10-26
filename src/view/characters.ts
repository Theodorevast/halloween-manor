// 访客角色：加载吉祥物 GLB（失败时换备用小人），每个访客一份克隆，按状态播放动画，
// 再叠一层程序化动作（受惊跳起、紧张发抖、逃跑前倾；没有走路片段时用挤压回弹代替），手里拿着手电。
//
// 换模型只改 config/character.ts。这里负责把任何来路的模型「摆正」：
//   量包围盒（Box3.setFromObject：量化 / meshopt 压缩过的模型，accessor 里的范围不是真实尺寸）→
//   缩放到 targetHeight、x / z 居中、脚底贴 y = 0 → 抵消 facingOffset，让正面朝 +z
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER, FLASHLIGHT_HEIGHT, type CharacterSpec } from '../config/character';
import { SPAWN } from '../config/visitors';
import type { FrameCtx, Module, RenderCore } from '../engine/types';
import { wrapAngle, yawFor } from '../lib/angle';
import type { NpcMode, NpcState, Personality, SimEvent } from '../sim/types';
import { createFallbackCharacter } from './fallbackCharacter';
import { createFlashlight, type Flashlight } from './flashlight';

/** 淡入（进门）/ 淡出（出门）的秒数 */
const FADE = { in: 0.6, out: 0.6 };
/** 动画片段之间交叉淡入淡出的秒数 */
const CROSSFADE = 0.2;
/** 朝向、手电方向的平滑速率（1/秒）：模拟层已经限速转向，这里只抹掉逐帧的台阶 */
const SMOOTH = { heading: 14, look: 22 };
/** 受惊：先压扁，再跳起（上升 sine.out、下落 power3.in），落地过冲回弹。总长 0.71 秒，在僵住的 0.8 秒之内 */
const JUMP = { crouch: 0.1, rise: 0.22, fall: 0.2, land: 0.05, settle: 0.14, height: 0.35, squash: 0.22, stretch: 0.12, overshoot: 0.06 };
const JUMP_END = JUMP.crouch + JUMP.rise + JUMP.fall + JUMP.land + JUMP.settle;
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

interface Visual {
  id: number;
  root: THREE.Group;
  body: THREE.Group;
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
  // 表现层自己的状态
  alpha: number;
  leaving: boolean;
  jumpT: number;
  lastJump: number;
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
  scaleY: number;
  lean: number;
  /** 紧张发抖的强度 0..1 */
  shake: number;
  alpha: number;
  yaw: number;
  torch: boolean;
}

export interface CharactersView extends Module {
  /** 调试：每个角色此刻的表现状态 */
  inspect(): CharacterDebug[];
  /** 加载到的是 GLB 还是备用小人 */
  readonly source: 'glb' | 'fallback';
}

const sineOut = (u: number) => Math.sin((u * Math.PI) / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const approach = (rate: number, dt: number) => 1 - Math.exp(-rate * dt);

/** 受惊跳起的时间线：返回离地高度和 y 方向缩放（xz 按体积守恒反算） */
function jumpPose(t: number): { y: number; sy: number } {
  const J = JUMP;
  const c = J.crouch, r = c + J.rise, f = r + J.fall, l = f + J.land;
  if (t < c) return { y: 0, sy: 1 - J.squash * sineOut(t / c) };
  if (t < r) {
    const u = (t - c) / J.rise;
    // 离地瞬间从压扁弹成拉长，越接近顶点越恢复原状
    return { y: J.height * sineOut(u), sy: lerp(1 - J.squash, 1 + J.stretch * (1 - u), sineOut(Math.min(1, u / 0.2))) };
  }
  if (t < f) {
    const u = (t - r) / J.fall;
    const k = u * u * u; // power3.in
    return { y: J.height * (1 - k), sy: 1 + J.stretch * 0.8 * k };
  }
  if (t < l) return { y: 0, sy: lerp(1 - J.squash * 0.8, 1 + J.overshoot, sineOut((t - f) / J.land)) };
  const u = Math.min(1, (t - l) / J.settle);
  return { y: 0, sy: 1 + J.overshoot * Math.cos(u * Math.PI * 1.5) * (1 - u) };
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
  const pendingJump = new Set<number>();
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
        if (s.isMeshStandardMaterial) {
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
    body.add(model);
    root.add(body);
    parent.add(root);

    const torch = torches.find((t) => !owner.has(t)) ?? null;
    if (torch) owner.set(torch, npc.id);
    const v: Visual = {
      id: npc.id, root, body, materials, mixer, actions, action: null, front, halfWidth, torch,
      x: npc.pos.x, z: npc.pos.z, heading: npc.heading, look: npc.lookDir, speed: npc.speed, mode: npc.mode, nervous: npc.nervous,
      alpha: 0, leaving: false, jumpT: -1, lastJump: -10, lean: 0, shake: 0, bounce: 0, phase: 0,
      seed: (npc.id * 7.31) % 10, headingS: npc.heading, lookS: npc.lookDir,
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

  const startJump = (v: Visual, time: number) => {
    if (time - v.lastJump < 0.5) return; // 事件和状态切换可能同时到，只跳一次
    v.lastJump = time;
    v.jumpT = 0;
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

    // —— 动画片段 ——
    const pick = pickAction(v);
    play(v, pick.action, v.mixer !== null && v.action === null && !v.leaving && v.alpha < 0.05);
    if (pick.action) {
      if (pick.pose === 'walk' || pick.pose === 'run') {
        const rate = pick.action === v.actions.run ? spec.runRateAt1ms : spec.walkRateAt1ms;
        pick.action.timeScale = v.speed * rate;
      } else pick.action.timeScale = 1;
    }
    v.mixer?.update(dt);

    // —— 程序化层（有没有片段都叠加）——
    let y = 0, sy = 1, roll = 0, side = 0;
    // 没有走路片段：上下弹跳 + 触地压扁 + 左右摇摆
    const wantBounce = pick.moving && !pick.action ? 1 : 0;
    v.bounce += (wantBounce - v.bounce) * approach(10, dt);
    if (v.bounce > 1e-3) {
      const k = spec.targetHeight;
      v.phase += (dt * v.speed * Math.PI) / (BOUNCE.step * k);
      const b = Math.abs(Math.sin(v.phase));
      y += BOUNCE.height * k * b * v.bounce;
      sy *= 1 - BOUNCE.squash * (1 - b) ** 4 * v.bounce;
      roll += BOUNCE.roll * Math.cos(v.phase) * v.bounce;
    }
    // 没有待机片段：微微呼吸
    if (!pick.moving && !pick.action) sy *= 1 + BREATHE.amp * Math.sin(time * BREATHE.rate + v.seed);
    // 受惊跳起
    if (v.jumpT >= 0) {
      v.jumpT += dt;
      const j = jumpPose(v.jumpT);
      y += j.y;
      sy *= j.sy;
      if (v.jumpT >= JUMP_END) v.jumpT = -1;
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

    v.body.position.set(side, y, 0);
    v.body.rotation.set(v.lean, 0, roll);
    const sxz = 1 / Math.sqrt(sy);
    v.body.scale.set(sxz, sy, sxz);

    // —— 手电：在照向那一侧的身体轮廓之外（包围盒在这个方向上的支撑距离）、右手边，高度跟着跳 ——
    if (v.torch) {
      const rel = look - heading;
      const reach = Math.abs(Math.cos(rel)) * v.front + Math.abs(Math.sin(rel)) * v.halfWidth + HAND.ahead;
      const lx = Math.cos(look), lz = Math.sin(look);
      v.torch.update({
        x: v.x + lx * reach - lz * HAND.side,
        y: FLASHLIGHT_HEIGHT + y,
        z: v.z + lz * reach + lx * HAND.side,
        dir: look,
        power: v.alpha,
        nervous: v.nervous,
      }, dt, time);
    }
  };

  const view: CharactersView = {
    get source() { return asset ? 'glb' : 'fallback'; },
    onEvent(e: SimEvent) {
      if (e.type === 'startle' && e.object !== null) {
        const v = visuals.get(e.npc);
        if (v) startJump(v, now);
        else pendingJump.add(e.npc);
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
        if (npc.mode === 'startled' && v.mode !== 'startled') startJump(v, time);
        v.x = npc.pos.x;
        v.z = npc.pos.z;
        v.heading = npc.heading;
        v.look = npc.lookDir;
        v.speed = npc.speed;
        v.mode = npc.mode;
        v.nervous = npc.nervous;
      }
      for (const v of [...visuals.values()]) {
        if (pendingJump.delete(v.id)) startJump(v, time);
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
        scaleY: +v.body.scale.y.toFixed(3),
        lean: +v.lean.toFixed(3),
        shake: +v.shake.toFixed(2),
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
