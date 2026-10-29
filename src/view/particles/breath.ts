// 受惊访客呼出的白气：恐惧值过了紧张线（FEAR.nervous）的人隔一会儿从嘴边呼出一小团淡淡的白气，
// 往前、往上飘一点，一秒多散掉；越接近 100 喘得越急，人跑起来白气留在身后；尖叫时呼出一大口。平静的人没有。
// 要读出来的是「这屋子很冷」和「他们在喘」，不是卡通的蒸汽：很淡、很小、只有被手电（或手电打在地上的反光）照着才看得清。
// 2026-10-28 做减法：每口气的团数、不透明度、尖叫那一大口都收了一些，第三人称离得近时也只是若有若无的一缕。
// 2026-10-30（ART-8）加回一档：减过头了——访客面朝镜头、2.6 米外被另一支手电从侧面照着，连呼三口，整幅前后只差 0.35/255，嘴前那一缕又小又淡、散得也快。
// 不透明度、受光、溢光、长大以后的大小各往上提一点（只改数，粒子数不变）；maxLit、ambient 不动：还是只有被光照着才看得清，没灯的地方仍然只是一点点暗影，也不会亮成发光的球。
// 2026-10-30（FEEL-8）贴近发毛时也呼：鬼魂贴在身边（NpcState.uneasy ≥ BREATH.chillFrom）的人，恐惧值还没到紧张线也会呼白气，
// 贴得越近越勤（breathLevel）。冷点让人呼出白气，是现实里「闹鬼」的征兆；样子用现有的，只改「什么时候呼」。
//
// 做法：一个实例化精灵 + 环形缓冲。每呼一口气，CPU 往缓冲里写 3–6 个槽位（起点、出生时刻、初速、强度），
// 只上传这一点数据；之后的轨迹（指数减速的喷出 + 暖气上浮 + 随年龄出现的噪声扰动）、长大、淡出全在顶点着色器里按年龄算。
// 嘴的位置：每个访客第一次呼气时找一次它的头骨骼（找不到就按包围盒的前上方），之后每次按骨骼此刻的位置 + 身体朝向，
// 跳起、缩身、回头张望时都跟着头走。
import * as THREE from 'three/webgpu';
import {
  exp, float, instancedDynamicBufferAttribute, length, max, min, mix, mx_noise_float, mx_noise_vec3, pow, smoothstep,
  uv, varying, vec2, vec3,
} from 'three/tsl';
import { FEAR } from '../../config/visitors';
import type { FrameCtx, Quality } from '../../engine/types';
import type { SimEvent, WorldState } from '../../sim/types';
import { FOG } from '../fog';
import { lightAt, type LightUniforms } from './light';
import { ge, lt, makeSprite, protectMRT, rnd } from './common';

type F = THREE.Node<'float'>;

export const BREATH = {
  /** 缓冲槽位数：4 个人 × 每口最多 6 团 × 一口气活 1.4 秒、最快 0.7 秒一口，够用还有富余 */
  pool: 96,
  /** 两次呼气的间隔（秒）：恐惧值刚到紧张线时 every[0]，100 时 every[1]（喘），再乘 1 ± jitter */
  every: [2.5, 0.72] as const,
  jitter: 0.25,
  /** 刚害怕起来，第一口气在这么久之内出来（秒） */
  first: [0.3, 0.9] as const,
  /**
   * 贴近发毛（FEEL-8）：发毛程度（NpcState.uneasy，0–1）从 chillFrom 起，恐惧值没到紧张线的人也呼白气；
   * 强度从 chillFrom 处的 0 线性涨到发毛 1 时的 chillMax（比吓破胆的 1 淡得多：间隔约 1.4 秒一口，吓破胆是 0.72 秒）。
   * 发毛只在鬼魂的发毛范围里才大于 0（GHOST.radius 1.5 米，胆小 1.8 米），所以白气出现的地方正好是范围：一靠近就开始，离开约 1–2 秒后停
   */
  chillFrom: 0.25,
  chillMax: 0.6,
  /** 每口气几团：[最少, 最多]，恐惧越高越多 */
  puffs: { high: [3, 5], low: [2, 3] } as Record<Quality, [number, number]>,
  /** 一口气呼出的时长（秒）：几团在这段时间里依次出来，连成一缕（不是一团） */
  exhale: 0.38,
  /** 呼出的初速（米/秒）：沿头朝向；向上；左右、上下的随机散开 */
  speed: [0.5, 0.8] as const,
  up: [0.0, 0.05] as const,
  spread: 0.06,
  /**
   * 人在走 / 跑：呼出的气一开始带着嘴的速度（这个比例），和喷出的速度一起被空气拖慢（时间常数 tau），
   * 所以刚呼出时跟在脸前，随后落到身后。太小的话人会立刻追上自己的白气，白气落在背上被身体挡住
   */
  carry: 0.9,
  /** 喷出减速的时间常数（秒）；之后暖气上浮（米/秒） */
  tau: 0.5,
  buoyancy: 0.045,
  /** 噪声扰动：幅度（米）、频率（每米）、随年龄出现的时间常数（秒） */
  turb: 0.03,
  turbFreq: 6,
  turbTau: 0.5,
  /** 大小（米）：出口时 size0，长到 size1（时间常数 growTau 秒） */
  size0: [0.04, 0.06] as const,
  size1: [0.16, 0.26] as const,
  growTau: 0.45,
  /** 寿命（秒），从 fadeFrom 比例处开始淡出 */
  life: [1.1, 1.5] as const,
  fadeFrom: 0.22,
  /** 不透明度峰值；长大以后按 (size0 / size)^thin 变稀 */
  alpha: [0.42, 0.55] as const,
  thin: 0.4,
  /** 尖叫：一口大的——团数、速度、大小、不透明度的倍数 */
  scream: { puffs: 5, speed: 1.5, size: 1.2, alpha: 1.05 },
  /** 底色（线性）：凝结的小水滴，淡白偏冷 */
  albedo: new THREE.Color(0.74, 0.78, 0.84),
  /** 受到的光 × gain；光锥外的溢光（手电打在身前地上反弹回来，见 light.ts）；月光底色的倍数（× FOG.ambient） */
  gain: 0.05,
  spill: 0.55,
  ambient: 2.4,
  /** 前向散射：顺着手电光看过去白气更亮 */
  phaseG: 0.35,
  /** 受到的光最多算到这么亮（线性）：飘进光锥、贴着镜片时也只是一缕淡白，不会亮成一个发光的球 */
  maxLit: 0.6,
  /**
   * 嘴的位置：有头骨骼时 = 骨骼位置 + 沿身体朝向 snout（包围盒最前沿离骨骼的距离，再往回收 inset）+ ahead，再往下 dy；
   * 没有骨骼时 = 包围盒最前沿往前 ahead、高度 = 包围盒顶 × height。snout 最多 maxSnout 米
   */
  mouth: { ahead: 0.04, inset: 0.06, dy: -0.04, height: 0.85, maxSnout: 0.5 },
  /** prefers-reduced-motion：间隔乘 every、速度乘 speed（更平静，但还在） */
  reducedMotion: { every: 1.35, speed: 0.6 },
};

/** 访客的头在哪：缓存每个访客的节点和测量结果 */
interface MouthRig {
  root: THREE.Object3D;
  pose: THREE.Object3D;
  head: THREE.Object3D | null;
  /** 有骨骼：骨骼往前多少米到嘴；没骨骼：嘴在 pose 局部坐标里的位置 */
  snout: number;
  local: THREE.Vector3;
  last: THREE.Vector3;
  vel: THREE.Vector3;
}

interface Emitter {
  /** 下一口气的时刻（ctx.time）；-1 = 现在不紧张 */
  next: number;
  scream: boolean;
}

export interface Breath {
  object: THREE.Sprite;
  update(ctx: FrameCtx, houseRoot: THREE.Object3D): void;
  onEvent(e: SimEvent, state: WorldState): void;
  /** 有没有还活着的白气（没有就把整个物体藏起来） */
  alive(time: number): boolean;
  setQuality(q: Quality): void;
  setReduced(on: boolean): void;
  /** 调试：立刻让某个访客呼一口气；所有访客嘴的位置 */
  debugPuff(id: number, state: WorldState, houseRoot: THREE.Object3D, time: number, scream?: boolean): boolean;
  debugMouths(houseRoot: THREE.Object3D): { id: number; mouth: number[]; dir: number[]; bone: string | null }[];
  /** 调试：一共呼了几口、每个人下一口的时刻 */
  debugStats(): { exhales: number; next: Record<number, number> };
  dispose(): void;
}

/**
 * 这个访客此刻呼气的强度（0..1，给 interval 和每口气几团用）；null = 不呼。纯函数，没有随机、不碰渲染。
 * - 恐惧值过了紧张线（FEAR.nervous）：按它到 FEAR.max 之间的位置，线性 0 → 1（以前就是这样）；
 * - 鬼魂贴着（uneasy ≥ BREATH.chillFrom）：从 chillFrom 处的 0 线性涨到 uneasy = 1 时的 BREATH.chillMax；
 * - 两样都有取大的，不相加；两样都没有（不怕、鬼魂也没贴近）不呼。uneasy 缺省（娃娃屋没有鬼魂）按 0。
 */
export function breathLevel(fear: number, uneasy: number = 0): number | null {
  if (fear < FEAR.nervous && uneasy < BREATH.chillFrom) return null;
  const fearLevel = Math.min(1, Math.max(0, (fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));
  const chill = Math.min(1, Math.max(0, (uneasy - BREATH.chillFrom) / (1 - BREATH.chillFrom))) * BREATH.chillMax;
  return Math.max(fearLevel, chill);
}

export function createBreath(light: LightUniforms, time: THREE.UniformNode<'float', number>): Breath {
  const B = BREATH;
  const N = B.pool;
  const a0 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  const a1 = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
  a0.setUsage(THREE.DynamicDrawUsage);
  a1.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < N; i++) a0.array[i * 4 + 3] = -1000; // 出生时刻：很久以前 = 空槽
  const A0 = instancedDynamicBufferAttribute(a0) as unknown as THREE.Node<'vec4'>;
  const A1 = instancedDynamicBufferAttribute(a1) as unknown as THREE.Node<'vec4'>;

  const r = (k: number) => rnd(k);
  const lerp = (a: number, b: number, t: F) => float(a).add(t.mul(b - a));
  const rng = (v: readonly [number, number], k: number) => lerp(v[0], v[1], r(k));
  const ease = (t: F, tau: number) => float(1).sub(exp(t.negate().div(tau)));

  // —— 顶点：按年龄算位置、大小、不透明度 ——
  const origin = A0.xyz;
  const age = time.sub(A0.w);
  const ageC = max(age, 0);
  const vel = A1.xyz;
  const k = A1.w; // 强度（尖叫 > 1）
  const life = rng(B.life, 1);
  const turb = mx_noise_vec3(origin.mul(B.turbFreq).add(vec3(r(2).mul(50), ageC.mul(0.8), ageC.mul(-0.5))))
    .mul(B.turb).mul(ease(ageC, B.turbTau));
  const p = origin.add(vel.mul(B.tau).mul(ease(ageC, B.tau))).add(vec3(0, ageC.mul(B.buoyancy), 0)).add(turb);
  const s0 = rng(B.size0, 3), s1 = rng(B.size1, 4);
  const grown = s0.add(s1.sub(s0).mul(ease(ageC, B.growTau)));
  const sizeK = mix(float(1), float(B.scream.size), ge(k, 1.01));
  const fade = smoothstep(0, 0.07, age).mul(float(1).sub(smoothstep(life.mul(B.fadeFrom), life, age)));
  const alpha = rng(B.alpha, 5).mul(k).mul(fade).mul(pow(s0.div(grown), B.thin));
  const size = grown.mul(sizeK).mul(ge(age, 0)).mul(lt(age, life)); // 不用 select（见 common.ts 的 ge / lt）

  const L = lightAt(light, p, { spill: B.spill, points: true, phaseG: B.phaseG });
  const amb = FOG.ambient.clone().multiplyScalar(B.ambient);
  const lit = min(L.mul(B.gain), vec3(B.maxLit, B.maxLit, B.maxLit)).add(vec3(amb.r, amb.g, amb.b));
  const vCol = varying(vec3(B.albedo.r, B.albedo.g, B.albedo.b).mul(lit), 'vBreathCol');
  const vAlpha = varying(alpha, 'vBreathA');
  const vSeed = varying(r(6), 'vBreathSeed');

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending, fog: false,
  });
  mat.positionNode = p;
  mat.scaleNode = vec2(size, size);
  mat.rotationNode = r(7).mul(Math.PI * 2).add(r(8).sub(0.5).mul(ageC));
  // 片元：高斯软斑，浓淡被噪声搅得不均匀，几团叠在一起像一缕气，不是一个个圆
  const q = uv().sub(0.5).mul(2);
  const d = length(q);
  const wob = mx_noise_float(vec3(q.mul(1.6).add(vSeed.mul(29)), vSeed.mul(13))).mul(0.5).add(0.5);
  const shape = exp(d.mul(d).mul(-3.5)).mul(wob.mul(0.95).add(0.25)).mul(float(1).sub(smoothstep(0.8, 1.0, d)));
  mat.colorNode = vCol;
  // 不做软粒子：白气悬在离地 0.6–1 米的空中，几乎碰不到别的东西；省掉每帧拷一次深度（只在扬灰的两秒里拷）
  mat.opacityNode = vAlpha.mul(shape);
  mat.alphaTest = 0.002;
  protectMRT(mat);

  const object = makeSprite(mat, N, 'visitor-breath', 2.6);

  // —— CPU：谁该呼气、嘴在哪 ——
  let quality: Quality = 'high';
  let reduced = false;
  let head = 0;
  let lastBirth = -1000;
  let exhales = 0;
  const emitters = new Map<number, Emitter>();
  const rigs = new Map<number, MouthRig>();
  const rand = (a: number, b: number) => a + Math.random() * (b - a);
  const tmpM = new THREE.Matrix4();
  const tmpV = new THREE.Vector3();
  const tmpD = new THREE.Vector3();
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();

  /** 找到访客的节点（characters.ts：houseRoot 下的 `visitor-<id>` → body → pose → 模型），量一次头和包围盒 */
  const rigOf = (id: number, houseRoot: THREE.Object3D): MouthRig | null => {
    const cached = rigs.get(id);
    if (cached && cached.root.parent) return cached;
    const root = houseRoot.children.find((o) => o.name === `visitor-${id}`);
    if (!root) return null;
    const pose = root.getObjectByName('pose') ?? root;
    root.updateWorldMatrix(true, true);
    const found: { bone: THREE.Object3D | null } = { bone: null };
    pose.traverse((o) => {
      if (found.bone || !(o as THREE.Bone).isBone) return;
      if (/head/i.test(o.name) && !/(top|end|nub|tip)/i.test(o.name)) found.bone = o;
    });
    const headBone = found.bone;
    // 包围盒（pose 局部坐标）：模型摆正后正面朝 +z，最大的 z 就是最前沿（鼻尖 / 脸）
    const poseInv = tmpM.copy(pose.matrixWorld).invert();
    box.makeEmpty();
    pose.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      meshBox.copy(m.geometry.boundingBox!).applyMatrix4(new THREE.Matrix4().multiplyMatrices(poseInv, m.matrixWorld));
      box.union(meshBox);
    });
    const front = box.isEmpty() ? 0.15 : box.max.z;
    const top = box.isEmpty() ? 1.1 : box.max.y;
    const rig: MouthRig = {
      root, pose, head: headBone, snout: 0,
      local: new THREE.Vector3(0, top * B.mouth.height, front + B.mouth.ahead),
      last: new THREE.Vector3().copy(root.position), vel: new THREE.Vector3(),
    };
    if (headBone) {
      const hl = pose.worldToLocal(headBone.getWorldPosition(tmpV));
      rig.snout = Math.min(B.mouth.maxSnout, Math.max(0, front - B.mouth.inset - hl.z));
    }
    rigs.set(id, rig);
    return rig;
  };

  /** 嘴（房屋坐标）和头朝向（水平单位向量）。房屋根节点只有平移，世界方向 = 房屋方向 */
  const mouthOf = (rig: MouthRig, houseRoot: THREE.Object3D, outPos: THREE.Vector3, outDir: THREE.Vector3) => {
    rig.root.updateWorldMatrix(true, true);
    outDir.set(0, 0, 1).transformDirection(rig.pose.matrixWorld);
    outDir.y = 0;
    if (outDir.lengthSq() < 1e-6) outDir.set(0, 0, 1);
    outDir.normalize();
    if (rig.head) {
      rig.head.getWorldPosition(outPos).addScaledVector(outDir, rig.snout + B.mouth.ahead);
      outPos.y += B.mouth.dy;
    } else outPos.copy(rig.local).applyMatrix4(rig.pose.matrixWorld);
    houseRoot.worldToLocal(outPos);
  };

  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  /** 呼一口气：fear01 = 恐惧值在紧张线到 100 之间的位置 */
  const exhale = (rig: MouthRig, houseRoot: THREE.Object3D, now: number, fear01: number, scream: boolean) => {
    mouthOf(rig, houseRoot, pos, dir);
    exhales++;
    const [lo, hi] = B.puffs[quality];
    const n = scream ? Math.min(B.scream.puffs, hi) : Math.round(lo + (hi - lo) * Math.min(1, fear01 * 0.7 + Math.random() * 0.4));
    const speedK = (scream ? B.scream.speed : 1) * (reduced ? B.reducedMotion.speed : 1);
    const k = scream ? B.scream.alpha : 1;
    const side = tmpD.set(-dir.z, 0, dir.x);
    for (let i = 0; i < n; i++) {
      const slot = head;
      head = (head + 1) % N;
      const t0 = now + (i / Math.max(1, n - 1)) * B.exhale * (scream ? 1.6 : 1);
      const sp = rand(B.speed[0], B.speed[1]) * speedK;
      const lat = rand(-B.spread, B.spread) * speedK;
      const vx = dir.x * sp + side.x * lat + rig.vel.x * B.carry;
      const vz = dir.z * sp + side.z * lat + rig.vel.z * B.carry;
      const vy = rand(B.up[0], B.up[1]) * speedK + rand(-0.5, 0.5) * B.spread * speedK;
      a0.array.set([pos.x, pos.y, pos.z, t0], slot * 4);
      a1.array.set([vx, vy, vz, k], slot * 4);
      lastBirth = Math.max(lastBirth, t0);
    }
    a0.needsUpdate = true;
    a1.needsUpdate = true;
  };

  const interval = (fear01: number) =>
    (B.every[0] + (B.every[1] - B.every[0]) * fear01) * (1 + B.jitter * (2 * Math.random() - 1)) * (reduced ? B.reducedMotion.every : 1);

  return {
    object,
    update(ctx, houseRoot) {
      const now = ctx.time;
      const seen = new Set<number>();
      for (const npc of ctx.state.npcs) {
        if (npc.mode === 'gone') continue;
        seen.add(npc.id);
        let em = emitters.get(npc.id);
        if (!em) emitters.set(npc.id, (em = { next: -1, scream: false }));
        const rig = rigOf(npc.id, houseRoot);
        if (rig && ctx.dt > 0) {
          // 人的速度（画面上的根节点），白气带走一部分
          rig.vel.subVectors(rig.root.position, rig.last).divideScalar(ctx.dt);
          if (rig.vel.lengthSq() > 25) rig.vel.set(0, 0, 0); // 瞬移（刚建好、调试放人）不算
          rig.last.copy(rig.root.position);
        }
        const f = breathLevel(npc.fear, npc.uneasy ?? 0);
        if (f === null) { em.next = -1; em.scream = false; continue; }
        if (!rig) continue;
        if (em.scream) {
          em.scream = false;
          exhale(rig, houseRoot, now, f, true);
          em.next = now + interval(f);
          continue;
        }
        if (em.next < 0) em.next = now + rand(B.first[0], B.first[1]);
        if (now >= em.next) {
          exhale(rig, houseRoot, now, f, false);
          em.next = now + interval(f);
        }
      }
      for (const id of emitters.keys()) if (!seen.has(id)) { emitters.delete(id); rigs.delete(id); }
    },
    onEvent(e) {
      // 尖叫：一大口（恐惧值够高时；下一帧 update 里放，那时 state 已经是吓过之后的）
      if (e.type === 'startle' && e.scream) {
        const em = emitters.get(e.npc);
        if (em) em.scream = true;
        else emitters.set(e.npc, { next: -1, scream: true });
      }
    },
    alive(t) {
      return t < lastBirth + B.life[1] + 0.05;
    },
    setQuality(q) { quality = q; },
    setReduced(on) { reduced = on; },
    debugPuff(id, state, houseRoot, now, scream = false) {
      const npc = state.npcs.find((n) => n.id === id);
      const rig = rigOf(id, houseRoot);
      if (!npc || !rig) return false;
      exhale(rig, houseRoot, now, breathLevel(npc.fear, npc.uneasy ?? 0) ?? 0, scream);
      return true;
    },
    debugMouths(houseRoot) {
      return [...rigs.entries()].map(([id, rig]) => {
        mouthOf(rig, houseRoot, pos, dir);
        return { id, mouth: pos.toArray().map((v) => +v.toFixed(3)), dir: dir.toArray().map((v) => +v.toFixed(2)), bone: rig.head?.name ?? null };
      });
    },
    debugStats() {
      return { exhales, next: Object.fromEntries([...emitters.entries()].map(([id, e]) => [id, +e.next.toFixed(2)])) };
    },
    dispose() { mat.dispose(); },
  };
}
