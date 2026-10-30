// 可附身物件的画面：肖像、两盏落地灯、摇椅、厨房门、八音盒、落地镜、床、衣柜。
// 每个物件挂在 houseRoot 下（位置 propCenter、朝向 yawFor(facing)，模型正面朝局部 +z），
// 自己的模型和惊吓动画在 src/view/props/*.ts；这里统一管：事件分发、幽光（可附身时呼吸、悬停变亮放大）、拾取盒。
// trigger 事件原样交给物件（rig.trigger(state, e)）：有变体的物件（衣柜的手指）按 e.variant 挑，和声音挑的是同一个
// 第三人称（dissolve）：鬼魂穿过物件时，物件和家具一样在它周围溶开、洞口一圈冷光（walls.ts 的 DISSOLVE），
// 不然飘进摇椅里就是直接穿模（2026-10-28 第二次试玩）
// 机关（2026-10-28）：设下了的物件（armed > 0）表面结一层很薄的霜，只有玩家看得见的提示（见 FROST）
// 第三人称的幽光（2026-10-30 美术分析 ART-5）：平时压淡、变细、降饱和，轮廓外缘淡到 0，不再是一圈亮绿细线（GLOW_GHOST）
// 2026-10-30 严格玩家（eye S-5：被瞄准的物件被涂成一整块薄荷绿 / 描一圈薄荷绿，像游戏界面；按住设机关看不出在蓄力）：
// - 外壳的颜色换成冷白灰（第三人称、娃娃屋都是）；第三人称的外壳按屏幕像素算粗细（一两个像素的细线，远近一样细，kit.ts 的 createGlow）
// - 镜头钻进物件里（吊臂穿过椅子、门框）时不画外壳：从里面看，外壳的背面铺满一片，就是那块平涂（insideBox）
// - 按住左键设机关的那 0.5 秒（TRAP.holdToArm）：物件表面那层机关的霜从下往上长，长满就是设下了（stepCharge、canArm）。
//   按没按着由鬼魂镜头发布（GhostUi.pressing），按住手势本身（够不够时间、准星移开就作废）还是拾取器管，这里照它的规则画
import * as THREE from 'three/webgpu';
import { abs, add, and, bool, dot, float, materialEmissive, mx_noise_float, normalLocal, normalView, normalWorld, positionGeometry, positionViewDirection, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { PROPS, propCenter, type PropPlacement } from '../config/house';
import { TRAP } from '../config/visitors';
import { ghostCamera, watchGhostUi } from '../engine/ghostRig';
import { AIM_RANGE } from '../engine/picking';
import type { FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { ScareObjectState, ScareType, SimEvent, WorldState } from '../sim/types';
import { createBed } from './props/bed';
import { createWardrobe } from './props/wardrobe';
import { createDoor } from './props/door';
import { approach, attachShell, createGlow, hitBox, type Glow, type PropRig } from './props/kit';
import { createLamp } from './props/lamp';
import { createMirror } from './props/mirror';
import { createMusicBox } from './props/musicBox';
import { createPortrait } from './props/portrait';
import { createRockingChair } from './props/rockingChair';
import { DISSOLVE, dissolveAt, ghostDissolve, v3 } from './walls';

export type PropsView = Module & {
  /** 给拾取器用：每个物件一个不可见的碰撞盒，userData.propId = 物件 id */
  pickTargets(): THREE.Object3D[];
  setHover(id: string | null): void;
};

/** 幽光的参数：平时呼吸（周期、强弱），悬停时更亮、整体放大。娃娃屋（俯视）用这一组 */
export const GLOW = {
  period: 3.2,
  base: 0.2,
  breath: 0.14,
  hover: 0.6,
  /** 附身瞬间的一下闪光（鬼「钻进去」），0.3 秒内退掉，之后冷却期间没有幽光 */
  flash: 1.5,
  flashTime: 0.3,
  thickness: 0.02,
  hoverThickness: 0.032,
  hoverScale: 1.04,
  /** 外壳颜色：冷白灰（2026-10-30 eye S-5：原来是薄荷绿 PALETTE.possess，像游戏界面的选中框） */
  tint: 0xc9d1d8 as number,
  /** 0 = 娃娃屋的软光（留 25% 的亮边），1 = 第三人称的细线（见 kit.ts 的 createGlow） */
  soft: 0,
  /** 按屏幕像素算的粗细（CSS 像素：平时、悬停、附身那一下另加）；0 = 不用，按上面的米（娃娃屋：正交相机，米和像素是固定比例） */
  px: 0,
  hoverPx: 0,
  flashPx: 0,
};

/**
 * 第三人称（2026-10-30 美术分析 ART-5）：透视镜头下外壳是 1–2 像素宽的亮薄荷绿细线（厨房门侧着看是一根竖线，台灯杆、画架一圈绿边），
 * 正是用户不要的「发光描边」。平时压淡、变细，颜色降饱和（同色相），轮廓外缘淡到 0。
 * 只压淡还不够（量过：走廊里侧看 6 米外的厨房门，还是两根比背景亮 30–50 的细竖线；薄板、细杆的外壳露出来的就是一条线）：
 * 平时的那点幽光只给够得着的物件（离鬼魂 AIM_RANGE 米内，再远 REACH_FADE 米淡没）——够不着的本来就点不了（FEEL-7 的
 * Too far away.），亮着反而像在招手；镜头跟前的那一截也不画（kit.ts 的 GLOW_NEAR）。
 * 悬停的物件仍然一眼看得出（和瞄准的反馈一起定）：亮到 hover、外壳加厚、整体放大 1.04，加上悬停标签和准星外圈。
 * 2026-10-30 eye S-5：颜色冷白灰（原来降饱和的薄荷绿 0x9fdcc0）；粗细按屏幕像素算（原来 1.2 / 2 厘米：镜头擦着厨房门时门框边上
 * 二十几像素宽的一条，细杆被描得和杆一样粗），平时 1.25 像素、悬停 2 像素（再细，大物件扁平的边会断成一串点）；
 * 悬停亮到 0.32（原来 0.5：细线是白的，再亮就像界面的选中框）
 * 娃娃屋保持原来的亮度、粗细（触屏玩家靠它找物件，40 米外线本来就细），只换颜色
 */
export const GLOW_GHOST: typeof GLOW = {
  ...GLOW,
  base: 0.06,
  breath: 0.05,
  hover: 0.32,
  thickness: 0,
  hoverThickness: 0,
  tint: 0xcbd3db,
  soft: 1,
  px: 1.25,
  hoverPx: 2,
  flashPx: 1,
};
/** 镜头离物件的拾取盒（往外扩这么多米）以内就算钻进去了：不画外壳（从里面看外壳背面是一整片） */
const INSIDE_PAD = 0.25;

/** 局部坐标的点 p 在不在拾取盒（size、center，局部坐标）往外扩 pad 米的盒子里 */
export function insideBox(p: THREE.Vector3, size: readonly [number, number, number], center: readonly [number, number, number], pad: number): boolean {
  return Math.abs(p.x - center[0]) <= size[0] / 2 + pad && Math.abs(p.y - center[1]) <= size[1] / 2 + pad && Math.abs(p.z - center[2]) <= size[2] / 2 + pad;
}

/** 这个物件此刻设得了机关吗（和 sim/traps.ts 的 armTrap 同一个判断：不在冷却、自己没设着、同时设下的没满） */
export function canArm(objects: readonly ScareObjectState[], id: string): boolean {
  const o = objects.find((x) => x.id === id);
  if (!o || o.cooldown > 0 || o.armed > 0) return false;
  return objects.filter((x) => x.armed > 0).length < TRAP.max;
}

/**
 * 按住设机关的蓄力（id：在给哪个物件蓄、t：蓄了几秒；void：这一下按住已经作废，松手之前不再蓄）。
 * 规则照拾取器的按住手势（picking.ts 的 createHoldGesture）：按下时准星对着一个设得了的物件才开始；按住期间准星对着的变了就作废，
 * 移回来也不再蓄；松手清零。蓄满 TRAP.holdToArm 秒就是设下了（那一刻拾取器发 onArm）
 */
export interface Charge {
  id: string | null;
  t: number;
  void: boolean;
}
const NO_CHARGE: Charge = { id: null, t: 0, void: false };

/** 蓄力往前走一帧：pressing 左键按着没有，hovered 准星对着的物件，can 这个物件设不设得了 */
export function stepCharge(c: Charge, pressing: boolean, hovered: string | null, can: (id: string) => boolean, dt: number): Charge {
  if (!pressing) return NO_CHARGE;
  if (c.void) return c;
  if (c.id === null) return hovered && can(hovered) ? { id: hovered, t: dt, void: false } : { id: null, t: 0, void: true };
  if (hovered !== c.id) return { id: null, t: 0, void: true };
  return { id: c.id, t: c.t + dt, void: false };
}

/** 蓄力的画法：前沿这么宽（米）的一条亮一点；蓄力时霜比设下以后浓 boost 倍（不然 0.2 的不透明度看不出在长）；松手没设下时多快化掉（每秒） */
const CHARGE = { front: 0.06, boost: 2.2, melt: 9 };
/** 第三人称：平时的幽光从离鬼魂 AIM_RANGE 米处开始淡，再远这么多米（水平距离）淡没 */
const REACH_FADE = 1;

/**
 * 机关的提示：设下了的物件表面一层很薄的霜。用的是物件幽光外壳的一个冷色变体，不是 frost.ts 的 frost.small（物件脚下地上的一小圈霜）：
 * 机关提示特意留在物件表面的这层霜上——床头柜上的八音盒这种，地上一圈霜看不出是哪个物件；frost.small 留着，看样时想试地上那一圈再接上。
 * 做法：同一份外壳几何（贴着表面鼓出 lift 米），不发光、不是一圈光边——冷白偏蓝的底色（和墙上溶开时结的霜同一个颜色，见 FROST.albedo），
 * 受灯光照（手电照上去才亮，不照就只有一点点自发光），颗粒状、一片一片的，轮廓边上厚一点。
 * 材质全页共用一个，每个外壳的浓度、霜长到多高逐物体给（onObjectUpdate 从 mesh.userData 读：frostAmount、frostTop、frostFront）。
 * 按住设机关的那 0.5 秒（2026-10-30 eye S-5「按住设机关时没有可见的蓄力进度」）：霜从物件最低处往上长（frostTop 是前沿的高度，世界坐标 y），
 * 前沿那一条亮一点、整层比设下以后浓（CHARGE），长满就是设下了；没设下（松手、准星移开）就很快化掉
 */
const FROST = {
  /** 贴着表面鼓出多少（米） */
  lift: 0.004,
  /** 最浓时的不透明度：很淡，是提示不是特效 */
  alpha: 0.2,
  /** 冰晶颗粒每米几颗（两层，细的、更细的）；大片疏密每米几个起伏 */
  crystal: [70, 150] as [number, number],
  patch: 5,
  /** 浓度追上目标的快慢（每秒）：设下时慢慢结出来，解除 / 触发时很快退掉（被子鼓起来会顶穿这层壳，不能久留） */
  grow: 1.6,
  melt: 7,
  /**
   * 颜色（线性）：冷白偏蓝的底色、没灯时的一点自发光。数值和墙上溶开时结的霜一样（walls.ts 的 DISSOLVE.frostAlbedo / frostGlow），
   * 这里自己留一份：画面那一路在收洞边的光，物件上的霜不跟着变
   */
  albedo: new THREE.Color(0.56, 0.63, 0.72),
  glow: new THREE.Color(0.32, 0.45, 0.6).multiplyScalar(0.04),
};

function createFrostHint() {
  const per = (key: string, fallback: number) => uniform(fallback).onObjectUpdate(({ object }: { object: THREE.Object3D | null }) => (object?.userData[key] as number | undefined) ?? fallback);
  /** 这一层多浓（设下了是 0..1；蓄力时到 CHARGE.boost） */
  const amount = per('frostAmount', 0);
  /** 霜长到多高（世界坐标 y，米）：前沿以下有霜。设下了、在化的时候给很大的数（整层都有） */
  const top = per('frostTop', 1e3);
  /** 前沿那一条亮不亮（蓄力时 1） */
  const front = per('frostFront', 0);
  const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.6, metalness: 0 });
  material.positionNode = positionGeometry.add(normalLocal.mul(FROST.lift));
  const grain = smoothstep(-0.3, 0.8, mx_noise_float(positionGeometry.mul(FROST.crystal[0])).add(mx_noise_float(positionGeometry.mul(FROST.crystal[1])).mul(0.5)));
  const patch = smoothstep(-0.7, 0.6, mx_noise_float(positionGeometry.mul(FROST.patch)));
  const rim = float(1).sub(abs(dot(normalView, positionViewDirection)));
  // 前沿不是一条直线：按世界坐标的噪声上下错开两三厘米，像霜一簇一簇往上爬
  const y = positionWorld.y.add(mx_noise_float(positionWorld.mul(11)).mul(0.025));
  const below = float(1).sub(smoothstep(top.sub(0.015), top.add(0.015), y));
  const edge = float(1).sub(smoothstep(0, CHARGE.front, abs(y.sub(top)))).mul(front);
  const c = FROST.albedo, g = FROST.glow;
  material.colorNode = vec3(c.r, c.g, c.b);
  material.emissiveNode = vec3(g.r, g.g, g.b).mul(amount).mul(edge.mul(4).add(1));
  material.opacityNode = amount.mul(FROST.alpha).mul(grain.mul(0.65).add(0.35)).mul(patch.mul(0.6).add(0.4)).mul(rim.mul(0.6).add(0.7))
    .mul(below).mul(edge.mul(2.5).add(1));
  return { material };
}

/**
 * 悬停时不整体放大的物件：床的被子盖在不动的床架上，放大 4% 会让被子比床架多漂出几厘米、边缘悬空；衣柜的门板同理（柜体是家具）
 */
const NO_HOVER_SCALE: ReadonlySet<ScareType> = new Set(['bed', 'wardrobe']);

const builders: Record<ScareType, (i: number) => PropRig> = {
  portrait: () => createPortrait(),
  lamp: (i) => createLamp(i + 1),
  rockingChair: () => createRockingChair(),
  door: () => createDoor(),
  musicBox: () => createMusicBox(),
  mirror: () => createMirror(),
  bed: () => createBed(),
  wardrobe: () => createWardrobe(),
};

interface Entry {
  p: PropPlacement;
  root: THREE.Group;
  rig: PropRig;
  glow: Glow;
  shells: THREE.Mesh[];
  /** 机关的霜：和幽光外壳一一对应，共用它们的几何 */
  frostShells: THREE.Mesh[];
  hit: THREE.Mesh;
  /** 0..1 的平滑量 */
  ready: number;
  hover: number;
  flash: number;
  /** 霜的浓度 0..1（平滑量） */
  frost: number;
  /** 按住设机关的蓄力：霜长到物件高度的几成（0..1）、这一层多浓（松手没设下时很快化掉） */
  reveal: number;
  charge: number;
  /** 模型的最低、最高处（世界坐标 y，米）：蓄力时霜从 y0 往 y1 长 */
  y0: number;
  y1: number;
  /** 呼吸相位错开，几个物件不同步 */
  phase: number;
  /** 物件中心（房屋坐标）：第三人称按它离鬼魂多远决定平时亮不亮 */
  c: { x: number; z: number };
}

/** 0..1 夹住再做一次 smoothstep */
const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

export interface PropsOptions {
  /** 第三人称：物件在鬼魂周围溶开（用全页共用的 ghostDissolve，house.ts 每帧写） */
  dissolve?: boolean;
}

export function createPropsView(core: RenderCore, opts: PropsOptions = {}): PropsView {
  // 溶解按房屋坐标算：物件会动（摇椅、门），用片元的世界坐标减去 houseRoot 的偏移（houseRoot 只平移不旋转）
  const houseOffset = uniform(new THREE.Vector3());
  const dissolved = new Set<THREE.Material>();
  const dissolveMaterial = (m: THREE.Material) => {
    if (dissolved.has(m) || !(m as THREE.NodeMaterial).isNodeMaterial) return;
    dissolved.add(m);
    const nm = m as THREE.NodeMaterial;
    const d = dissolveAt(ghostDissolve, positionWorld.sub(houseOffset), normalWorld, DISSOLVE.furniture);
    nm.maskNode = nm.maskNode ? and(nm.maskNode as THREE.Node<'bool'>, d.keep) : d.keep;
    // 影子照旧：溶开的只是「看穿」
    nm.maskShadowNode = bool(true);
    // 洞口一圈冷光、附近一点霜光（受光材质才有自发光；不受光的灯泡、外壳只挖洞）
    if ((m as THREE.MeshStandardNodeMaterial).isMeshStandardNodeMaterial) {
      const sm = m as THREE.MeshStandardNodeMaterial;
      const edge = v3(DISSOLVE.rimGlow).mul(d.rim).add(v3(DISSOLVE.frostGlow).mul(d.frost));
      sm.emissiveNode = add((sm.emissiveNode as THREE.Node<'vec3'> | null) ?? materialEmissive, edge);
    }
    m.needsUpdate = true;
  };

  const frost = createFrostHint();
  const entries: Entry[] = PROPS.map((p, i) => {
    const root = new THREE.Group();
    root.name = `prop:${p.id}`;
    const c = propCenter(p);
    root.position.set(c.x, 0, c.z);
    root.rotation.y = yawFor(p.facing);
    const rig = builders[p.type](i);
    root.add(rig.model);
    const glow = createGlow();
    glow.thickness.value = GLOW.thickness;
    const shells = rig.shells.map((s) => {
      const m = attachShell(s.parent, glow, s.geometry);
      // 自定义外壳几何只用来生成外壳，用完就扔；部件自己的几何还在网格上用着
      if (!isMeshGeometry(s.parent, s.geometry)) s.geometry.dispose();
      m.visible = false;
      return m;
    });
    // 机关的霜：每个幽光外壳配一层，挂在同一个父物体下（跟着一起动）、用同一份几何
    const frostShells = shells.map((gs) => {
      const f = new THREE.Mesh(gs.geometry, frost.material);
      f.name = 'frost-shell';
      f.castShadow = false;
      f.receiveShadow = false;
      f.renderOrder = 1;
      f.visible = false;
      // 平时看不见（不进开场那次阻塞的预编译）；deferCompile 让 main.ts 在开场按钮可用之后临时画几帧把管线编好，
      // 第一次设机关时才不会卡一下
      f.userData.deferCompile = true;
      gs.parent!.add(f);
      return f;
    });
    const hit = hitBox(p.id, rig.hit.size, rig.hit.center);
    if (opts.dissolve) {
      // 模型和幽光外壳都挖洞（外壳不挖的话，物件溶开的地方会剩一圈发光的轮廓）；拾取盒不画，不用管
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) dissolveMaterial(m);
      });
    }
    root.add(hit);
    core.houseRoot.add(root);
    // 模型的高低（root 就在地上、houseRoot 不升降：局部的 y 就是世界坐标的 y）
    const yb = new THREE.Box3().setFromObject(rig.model);
    const y0 = Number.isFinite(yb.min.y) ? yb.min.y : 0, y1 = Number.isFinite(yb.max.y) ? yb.max.y : 1;
    return { p, root, rig, glow, shells, frostShells, hit, ready: 1, hover: 0, flash: 0, frost: 0, reveal: 0, charge: 0, y0, y1, phase: i * 1.7, c };
  });
  const byId = new Map(entries.map((e) => [e.p.id, e]));
  const targets = entries.map((e) => e.hit);
  let hovered: string | null = null;
  /** 左键按着（鬼魂镜头发布）、按住设机关的蓄力 */
  let pressing = false;
  let charge: Charge = NO_CHARGE;
  const camLocal = new THREE.Vector3();
  /** 幽光用哪一组参数：第三人称（建过鬼魂镜头，GhostUi.active）用 GLOW_GHOST，娃娃屋用 GLOW。颜色、轮廓外缘的曲线只在换的时候写 */
  let glow = GLOW;
  const useGlow = (g: typeof GLOW) => {
    glow = g;
    for (const e of entries) {
      e.glow.tint.value.setHex(g.tint);
      e.glow.soft.value = g.soft;
    }
  };
  useGlow(GLOW);
  const unwatch = watchGhostUi((s) => {
    if ((s.active ? GLOW_GHOST : GLOW) !== glow) useGlow(s.active ? GLOW_GHOST : GLOW);
    pressing = s.active && s.pressing;
  });

  // 找不到状态（state 里没有这个物件）时用的占位，保证物件照样能显示。
  // 每帧直接 find（8 × 8 次比较），不缓存索引：模拟层哪怕整个换掉对象也不会读到旧的
  const idle = new Map(entries.map((e): [string, ScareObjectState] => [e.p.id, { id: e.p.id, type: e.p.type, pos: propCenter(e.p), facing: e.p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 }]));
  const objOf = (state: WorldState, e: Entry) => state.objects.find((o) => o.id === e.p.id) ?? idle.get(e.p.id)!;

  return {
    pickTargets: () => targets,
    setHover(id) {
      hovered = id;
    },
    onEvent(e: SimEvent, state: WorldState) {
      if (e.type === 'trigger') {
        const en = byId.get(e.object);
        if (!en) return;
        en.flash = 1;
        en.rig.trigger(state, e);
      } else if (e.type === 'reset') {
        byId.get(e.object)?.rig.reset();
      }
    },
    update(ctx: FrameCtx) {
      const { dt, time, state } = ctx;
      houseOffset.value.copy(core.houseRoot.position);
      // 鬼魂在哪（房屋坐标）：house.ts 每帧先写进全页共用的溶开 uniform（第三人称才有；关掉时在地板下很远）
      const gv = ghostDissolve.ghost.value;
      const ghostAt = gv.y > -100 ? gv : null;
      // 按住设机关的蓄力（只有第三人称有：娃娃屋点一下就是附身）
      charge = stepCharge(charge, pressing, hovered, (id) => canArm(state.objects, id), dt);
      const chargeP = charge.id ? Math.min(1, charge.t / TRAP.holdToArm) : 0;
      // 第三人称：外壳按屏幕像素算粗细（离镜头 1 米处一个 CSS 像素多少米）
      const pxM = glow.px > 0 && ghostCamera.active ? 1 / Math.max(1e-6, ghostCamera.pxPerM) : 0;
      for (const e of entries) {
        const obj = objOf(state, e);
        e.rig.update({ dt, time, obj, state });

        // 幽光：cooldown 为 0 时呼吸；冷却开始时快速熄灭，冷却结束时慢慢亮起来
        const readyTarget = obj.cooldown <= 0 ? 1 : 0;
        e.ready = approach(e.ready, readyTarget, readyTarget ? 2.5 : 18, dt);
        e.hover = approach(e.hover, hovered === e.p.id ? 1 : 0, 16, dt);
        e.flash = Math.max(0, e.flash - dt / glow.flashTime);
        const breath = 0.5 + 0.5 * Math.sin((time / glow.period) * Math.PI * 2 + e.phase);
        // 第三人称：平时的那点幽光只给够得着的（离鬼魂 AIM_RANGE 米内）；悬停本来就只有够得着的才有
        const reach = glow.soft > 0 && ghostAt ? 1 - smooth01((Math.hypot(e.c.x - ghostAt.x, e.c.z - ghostAt.z) - AIM_RANGE) / REACH_FADE) : 1;
        const amount = e.ready * ((glow.base + glow.breath * breath) * reach + glow.hover * e.hover) + glow.flash * e.flash * e.flash;
        e.glow.amount.value = amount;
        // 粗细：娃娃屋按米；第三人称按屏幕像素（kit.ts 的 createGlow：thickness + px × pxM × 离镜头多远）
        e.glow.thickness.value = glow.px > 0 ? 0 : glow.thickness + (glow.hoverThickness - glow.thickness) * e.hover * e.ready + 0.018 * e.flash;
        e.glow.px.value = glow.px + (glow.hoverPx - glow.px) * e.hover * e.ready + glow.flashPx * e.flash;
        e.glow.pxM.value = pxM;
        // 悬停、附身那一下：外壳整圈都亮，只有贴着镜头那一点点不画；平时（第三人称）镜头跟前的那一截不画（见 kit.ts 的 createGlow）
        e.glow.focus.value = Math.max(e.hover, e.flash);
        // 第三人称：镜头钻进了这个物件（拾取盒外扩 INSIDE_PAD 米）里就不画外壳——从里面看，外壳的背面铺满一片，就是那块整块的平涂。
        // 镜头的位置换到物件的局部坐标（root 在地上、只绕 y 转、整体缩放）
        let inside = false;
        if (glow.px > 0 && ghostCamera.active) {
          const dx = ghostCamera.x - e.c.x, dz = ghostCamera.z - e.c.z, sc = e.root.scale.x || 1;
          const cr = Math.cos(e.root.rotation.y), sr = Math.sin(e.root.rotation.y);
          camLocal.set((cr * dx - sr * dz) / sc, ghostCamera.y / sc, (sr * dx + cr * dz) / sc);
          inside = insideBox(camLocal, e.rig.hit.size, e.rig.hit.center, INSIDE_PAD);
        }
        // 画不画照「不按远近淡」时的量算（够不着的外壳照样画，只是量是 0，加法混合什么也不加）：外壳还是和原来一样一直在场景里，
        // 开场的预编译、切画质时照样编到它们，走近了第一次亮起来不会现编管线卡一下
        const show = !inside && e.ready * (glow.base + glow.hover * e.hover) + glow.flash * e.flash * e.flash > 0.004;
        for (const s of e.shells) s.visible = show;
        // 机关：设下了（armed > 0）就慢慢结霜，解除、触发了就很快化掉
        const set = obj.armed > 0 ? 1 : 0;
        // 蓄力：这个物件正被按住设机关，霜从下往上长（reveal = 蓄了几成），整层比设下以后浓；
        // 蓄满、模拟设下了的那一刻霜整层就位（不再从 0 慢慢结出来，不闪一下），浓度很快退回设下的样子（还按着也一样）；松手没设下就很快化掉
        const charging = charge.id === e.p.id && !set;
        if (charge.id === e.p.id && set) {
          e.frost = 1;
          e.reveal = 1;
        }
        if (charging) {
          e.reveal = chargeP;
          e.charge = 1;
        } else {
          e.charge = approach(e.charge, 0, CHARGE.melt, dt);
          if (e.charge < 0.004) e.charge = 0;
        }
        e.frost = approach(e.frost, set, set ? FROST.grow : FROST.melt, dt);
        if (e.frost < 0.004 && !set) e.frost = 0;
        // 蓄力那层比设下的浓：按蓄力画（长到哪、前沿亮一条）；松手以后蓄力那层很快淡到设下的浓度（设下了）或者化掉（没设下），不跳
        const chargeAmt = e.charge * CHARGE.boost;
        const fromCharge = chargeAmt > e.frost;
        const frostAmount = fromCharge ? chargeAmt : e.frost;
        // 悬停时物件整体放大了一点（hoverScale）：前沿的高度跟着放大，长满时盖得到顶
        const frostTop = fromCharge ? (e.y0 - CHARGE.front + e.reveal * (e.y1 - e.y0 + 2 * CHARGE.front)) * e.root.scale.y : 1e3;
        const frostFront = fromCharge && charging && e.reveal < 1 ? 1 : 0;
        const frosted = frostAmount > 0;
        for (const f of e.frostShells) {
          f.visible = frosted;
          f.userData.frostAmount = frostAmount;
          f.userData.frostTop = frostTop;
          f.userData.frostFront = frostFront;
        }
        if (!NO_HOVER_SCALE.has(e.p.type)) e.root.scale.setScalar(1 + (glow.hoverScale - 1) * e.hover);
      }
    },
    setQuality(q: Quality) {
      for (const e of entries) e.rig.setQuality?.(q);
    },
    dispose() {
      unwatch();
      // 几何体、材质在这里统一收集去重后释放；贴图、灯由各物件自己的 dispose 释放
      const geos = new Set<THREE.BufferGeometry>();
      const mats = new Set<THREE.Material>();
      for (const e of entries) {
        e.rig.dispose?.();
        e.root.removeFromParent();
        e.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          geos.add(m.geometry);
          for (const x of Array.isArray(m.material) ? m.material : [m.material]) mats.add(x);
        });
      }
      geos.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
    },
  };
}

const isMeshGeometry = (o: THREE.Object3D, g: THREE.BufferGeometry) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry === g;
