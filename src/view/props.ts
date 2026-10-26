// 可附身物件的画面：肖像、两盏落地灯、摇椅、厨房门、八音盒、落地镜。
// 每个物件挂在 houseRoot 下（位置 propCenter、朝向 yawFor(facing)，模型正面朝局部 +z），
// 自己的模型和惊吓动画在 src/view/props/*.ts；这里统一管：事件分发、幽光（可附身时呼吸、悬停变亮放大）、拾取盒。
import * as THREE from 'three/webgpu';
import { PROPS, propCenter, type PropPlacement } from '../config/house';
import type { FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { ScareObjectState, ScareType, SimEvent, WorldState } from '../sim/types';
import { createDoor } from './props/door';
import { approach, attachShell, createGlow, hitBox, type Glow, type PropRig } from './props/kit';
import { createLamp } from './props/lamp';
import { createMirror } from './props/mirror';
import { createMusicBox } from './props/musicBox';
import { createPortrait } from './props/portrait';
import { createRockingChair } from './props/rockingChair';

export type PropsView = Module & {
  /** 给拾取器用：每个物件一个不可见的碰撞盒，userData.propId = 物件 id */
  pickTargets(): THREE.Object3D[];
  setHover(id: string | null): void;
};

/** 幽光的参数：平时呼吸（周期、强弱），悬停时更亮、整体放大 */
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
};

const builders: Record<ScareType, (i: number) => PropRig> = {
  portrait: () => createPortrait(),
  lamp: (i) => createLamp(i + 1),
  rockingChair: () => createRockingChair(),
  door: () => createDoor(),
  musicBox: () => createMusicBox(),
  mirror: () => createMirror(),
};

interface Entry {
  p: PropPlacement;
  root: THREE.Group;
  rig: PropRig;
  glow: Glow;
  shells: THREE.Mesh[];
  hit: THREE.Mesh;
  /** 0..1 的平滑量 */
  ready: number;
  hover: number;
  flash: number;
  /** 呼吸相位错开，几个物件不同步 */
  phase: number;
}

export function createPropsView(core: RenderCore): PropsView {
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
    const hit = hitBox(p.id, rig.hit.size, rig.hit.center);
    root.add(hit);
    core.houseRoot.add(root);
    return { p, root, rig, glow, shells, hit, ready: 1, hover: 0, flash: 0, phase: i * 1.7 };
  });
  const byId = new Map(entries.map((e) => [e.p.id, e]));
  const targets = entries.map((e) => e.hit);
  let hovered: string | null = null;

  // 找不到状态（state 里没有这个物件）时用的占位，保证物件照样能显示。
  // 每帧直接 find（7 × 7 次比较），不缓存索引：模拟层哪怕整个换掉对象也不会读到旧的
  const idle = new Map(entries.map((e): [string, ScareObjectState] => [e.p.id, { id: e.p.id, type: e.p.type, pos: propCenter(e.p), facing: e.p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [] }]));
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
        en.rig.trigger(state);
      } else if (e.type === 'reset') {
        byId.get(e.object)?.rig.reset();
      }
    },
    update(ctx: FrameCtx) {
      const { dt, time, state } = ctx;
      for (const e of entries) {
        const obj = objOf(state, e);
        e.rig.update({ dt, time, obj, state });

        // 幽光：cooldown 为 0 时呼吸；冷却开始时快速熄灭，冷却结束时慢慢亮起来
        const readyTarget = obj.cooldown <= 0 ? 1 : 0;
        e.ready = approach(e.ready, readyTarget, readyTarget ? 2.5 : 18, dt);
        e.hover = approach(e.hover, hovered === e.p.id ? 1 : 0, 16, dt);
        e.flash = Math.max(0, e.flash - dt / GLOW.flashTime);
        const breath = 0.5 + 0.5 * Math.sin((time / GLOW.period) * Math.PI * 2 + e.phase);
        const amount = e.ready * (GLOW.base + GLOW.breath * breath + GLOW.hover * e.hover) + GLOW.flash * e.flash * e.flash;
        e.glow.amount.value = amount;
        e.glow.thickness.value = GLOW.thickness + (GLOW.hoverThickness - GLOW.thickness) * e.hover * e.ready + 0.018 * e.flash;
        const show = amount > 0.004;
        for (const s of e.shells) s.visible = show;
        e.root.scale.setScalar(1 + (GLOW.hoverScale - 1) * e.hover);
      }
    },
    setQuality(q: Quality) {
      for (const e of entries) e.rig.setQuality?.(q);
    },
    dispose() {
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
