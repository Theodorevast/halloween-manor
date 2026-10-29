// 可附身物件的画面：肖像、两盏落地灯、摇椅、厨房门、八音盒、落地镜、床、衣柜。
// 每个物件挂在 houseRoot 下（位置 propCenter、朝向 yawFor(facing)，模型正面朝局部 +z），
// 自己的模型和惊吓动画在 src/view/props/*.ts；这里统一管：事件分发、幽光（可附身时呼吸、悬停变亮放大）、拾取盒。
// trigger 事件原样交给物件（rig.trigger(state, e)）：有变体的物件（衣柜的手指）按 e.variant 挑，和声音挑的是同一个
// 第三人称（dissolve）：鬼魂穿过物件时，物件和家具一样在它周围溶开、洞口一圈冷光（walls.ts 的 DISSOLVE），
// 不然飘进摇椅里就是直接穿模（2026-10-28 第二次试玩）
// 机关（2026-10-28）：设下了的物件（armed > 0）表面结一层很薄的霜，只有玩家看得见的提示（见 FROST）
// 第三人称的幽光（2026-10-30 美术分析 ART-5）：平时压淡、变细、降饱和，轮廓外缘淡到 0，不再是一圈亮绿细线（GLOW_GHOST）；娃娃屋不变
import * as THREE from 'three/webgpu';
import { abs, add, and, bool, dot, float, materialEmissive, mx_noise_float, normalLocal, normalView, normalWorld, positionGeometry, positionViewDirection, positionWorld, smoothstep, uniform, vec3 } from 'three/tsl';
import { PROPS, propCenter, type PropPlacement } from '../config/house';
import { watchGhostUi } from '../engine/ghostRig';
import { AIM_RANGE } from '../engine/picking';
import type { FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { ScareObjectState, ScareType, SimEvent, WorldState } from '../sim/types';
import { PALETTE } from './palette';
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
const GLOW = {
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
  /** 外壳颜色（PALETTE.possess） */
  tint: PALETTE.possess as number,
  /** 轮廓外缘：0 = 留 25% 的亮边（原来的曲线），1 = 淡到 0（见 kit.ts 的 createGlow） */
  soft: 0,
};

/**
 * 第三人称（2026-10-30 美术分析 ART-5）：透视镜头下外壳是 1–2 像素宽的亮薄荷绿细线（厨房门侧着看是一根竖线，台灯杆、画架一圈绿边），
 * 正是用户不要的「发光描边」。平时压淡、变细，颜色降饱和（同色相），轮廓外缘淡到 0。
 * 只压淡还不够（量过：走廊里侧看 6 米外的厨房门，还是两根比背景亮 30–50 的细竖线；薄板、细杆的外壳露出来的就是一条线）：
 * 平时的那点幽光只给够得着的物件（离鬼魂 AIM_RANGE 米内，再远 REACH_FADE 米淡没）——够不着的本来就点不了（FEEL-7 的
 * Too far away.），亮着反而像在招手；镜头跟前的那一截也不画（kit.ts 的 GLOW_NEAR）。
 * 悬停的物件仍然一眼看得出（和瞄准的反馈一起定）：亮到 hover、外壳加厚、整体放大 1.04，加上悬停标签和准星外圈。
 * 娃娃屋保持原值（触屏玩家靠它，40 米外线本来就细）
 */
const GLOW_GHOST: typeof GLOW = {
  ...GLOW,
  base: 0.06,
  breath: 0.05,
  hover: 0.5,
  thickness: 0.012,
  hoverThickness: 0.02,
  tint: 0x9fdcc0,
  soft: 1,
};
/** 第三人称：平时的幽光从离鬼魂 AIM_RANGE 米处开始淡，再远这么多米（水平距离）淡没 */
const REACH_FADE = 1;

/**
 * 机关的提示：设下了的物件表面一层很薄的霜。用的是物件幽光外壳的一个冷色变体，不是 frost.ts 的 frost.small（物件脚下地上的一小圈霜）：
 * 机关提示特意留在物件表面的这层霜上——床头柜上的八音盒这种，地上一圈霜看不出是哪个物件；frost.small 留着，看样时想试地上那一圈再接上。
 * 做法：同一份外壳几何（贴着表面鼓出 lift 米），不发光、不是一圈光边——冷白偏蓝的底色（和墙上溶开时结的霜同一个颜色，walls.ts 的 DISSOLVE.frostAlbedo），
 * 受灯光照（手电照上去才亮，不照就只有一点点自发光），颗粒状、一片一片的，轮廓边上厚一点。
 * 材质全页共用一个，每个外壳画之前把自己的浓度写进去（onBeforeRender）
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
};

function createFrostHint() {
  const amount = uniform(0);
  const material = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.6, metalness: 0 });
  material.positionNode = positionGeometry.add(normalLocal.mul(FROST.lift));
  const grain = smoothstep(-0.3, 0.8, mx_noise_float(positionGeometry.mul(FROST.crystal[0])).add(mx_noise_float(positionGeometry.mul(FROST.crystal[1])).mul(0.5)));
  const patch = smoothstep(-0.7, 0.6, mx_noise_float(positionGeometry.mul(FROST.patch)));
  const rim = float(1).sub(abs(dot(normalView, positionViewDirection)));
  const c = DISSOLVE.frostAlbedo, g = DISSOLVE.frostGlow;
  material.colorNode = vec3(c.r, c.g, c.b);
  material.emissiveNode = vec3(g.r, g.g, g.b).mul(amount);
  material.opacityNode = amount.mul(FROST.alpha).mul(grain.mul(0.65).add(0.35)).mul(patch.mul(0.6).add(0.4)).mul(rim.mul(0.6).add(0.7));
  return { material, amount };
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
    const entry: Entry = { p, root, rig, glow, shells, frostShells, hit, ready: 1, hover: 0, flash: 0, frost: 0, phase: i * 1.7, c };
    for (const f of frostShells) f.onBeforeRender = () => { frost.amount.value = entry.frost; };
    return entry;
  });
  const byId = new Map(entries.map((e) => [e.p.id, e]));
  const targets = entries.map((e) => e.hit);
  let hovered: string | null = null;
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
        e.glow.thickness.value = glow.thickness + (glow.hoverThickness - glow.thickness) * e.hover * e.ready + 0.018 * e.flash;
        // 悬停、附身那一下：外壳整圈都亮；平时（第三人称）镜头跟前的那一截不画（见 kit.ts 的 createGlow、GLOW_NEAR）
        e.glow.focus.value = Math.max(e.hover, e.flash);
        // 画不画照「不按远近淡」时的量算（够不着的外壳照样画，只是量是 0，加法混合什么也不加）：外壳还是和原来一样一直在场景里，
        // 开场的预编译、切画质时照样编到它们，走近了第一次亮起来不会现编管线卡一下
        const show = e.ready * (glow.base + glow.hover * e.hover) + glow.flash * e.flash * e.flash > 0.004;
        for (const s of e.shells) s.visible = show;
        // 机关：设下了（armed > 0）就慢慢结霜，解除、触发了就很快化掉
        const set = obj.armed > 0 ? 1 : 0;
        e.frost = approach(e.frost, set, set ? FROST.grow : FROST.melt, dt);
        if (e.frost < 0.004 && !set) e.frost = 0;
        const frosted = e.frost > 0;
        for (const f of e.frostShells) f.visible = frosted;
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
