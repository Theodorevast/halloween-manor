// 粒子：手电光束里的浮尘、物件「落下」时扬起的粉尘（肖像、床、衣柜）、受惊访客呼出的白气（2026-10-27 电影感升级）。
// 三样都是「哈希 + 时间」驱动的实例化精灵（SpriteNodeMaterial），每样一次绘制：
// - 浮尘（particles/motes.ts）：两千颗，只在手电光锥里、墙这一侧亮；
// - 粉尘（particles/plaster.ts）：肖像砸地那一刻从画框四周喷出一团灰褐色的灰 + 几粒碎屑；
//   床（被子下面的人塌下去那一刻，2026-10-28）从被子面中间扬起一小团灰，没有碎屑，同一套粒子换一套形状；
//   衣柜（门被从里面拉上、撞上的那一下，2026-10-29）柜顶积的灰从边上翻下去，几秒里慢慢落到门前的地上（plaster 的 fall）。
//   三处都在 DUST_BURSTS 一张表里；
// - 白气（particles/breath.ts）：恐惧值过了紧张线的人隔一会儿呼一小口，越怕喘得越急。
// 灯光不走 three 的灯光系统（particles/light.ts，和雾同一套光锥和挡墙算法），材质都不受光照：灯的数量变了不重新编译。
//
// 材质、几何体开局一次建好，之后只改 uniform 和一小段实例缓冲；三个物体都标了 deferCompile（全部粒子缩成 0），
// main.ts 在开场按钮可用之后把它们显示出来真画一帧编好管线，第一次 update 起再按需要藏起来（没有粒子时不画；
// 粉尘的软粒子要每帧拷一次深度，只在扬灰的那几秒里拷：按这一次最长的一颗算，床约 2 秒、肖像 3.6 秒（碎屑）、衣柜 5 秒）。
// 粒子着色器里不用 select()（见 particles/common.ts 的 ge / lt）。
// 娃娃屋（正交相机）和第三人称（透视相机）都要对：尺寸、软粒子、前向散射在每次画之前按这一次的相机换算（common.ts、light.ts）。
// 性能（2026-10-27，本机 WebGPU，4 个访客，High，DPR 2，不锁帧率，同页轮流开关 16 轮）：常态（浮尘 + 呼气）±1% 以内，测不出；
// 三样同时满载（每 0.25 秒全员呼气 + 连续扬灰）约 +3%。
// 都是透明、不写深度；后处理以后要是加了 MRT（法线 / 速度），粒子不覆盖那些附件（common.ts 的 protectMRT）。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { PROPS, propCenter } from '../config/house';
import { WARDROBE } from '../config/scares';
import type { FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { ScareType, SimEvent, WorldState } from '../sim/types';
import { createBreath } from './particles/breath';
import { makeScreenUniforms, updateScreenUniforms } from './particles/common';
import { createLightReader } from './particles/light';
import { MOTES, createMotes } from './particles/motes';
import { PLASTER, createPlaster, type BurstShape } from './particles/plaster';
import { BED_TIMELINE, bedDustSpot } from './props/bed';
import { PORTRAIT_TIMELINE } from './props/portrait';
import { WARDROBE_SHUT, wardrobeDustSpot, wardrobeLayout } from './props/wardrobe';

export { BREATH } from './particles/breath';
export { MOTES } from './particles/motes';
export { PLASTER } from './particles/plaster';

/** 一处扬灰 */
export interface DustBurst {
  /** 附身之后多久扬（秒，和物件自己的时间线一致；那边用的也是真实时间 dt） */
  at: number;
  /** 从哪里扬：落点中心（物件局部坐标，米；props.ts 摆放：根在 propCenter、rotation.y = yawFor(facing)，正面朝局部 +z） */
  spot: () => { x: number; y: number; z: number };
  /**
   * 扬成什么样（particles/plaster.ts 的 BurstShape）；不给就是肖像砸地那一套。
   * 要按布局算的（衣柜）写成函数，扬灰那一刻才算：导入期不调布局函数（它在家具表改错时会抛错，导入期抛错整页白屏）
   */
  shape?: BurstShape | (() => BurstShape);
}

/** 这一行此刻的形状（函数就调一次） */
export const dustShape = (d: DustBurst): BurstShape | undefined => (typeof d.shape === 'function' ? d.shape() : d.shape);

/**
 * 物件「落下」时扬的灰，一张表（最终审查 P-6：原来肖像、床各抄一份同样的换算，加衣柜时并起来）。
 * 粉尘只有一套粒子：前一处的灰还没落完又扬一处，前一处直接没了（和原来一样）
 */
export const DUST_BURSTS: Partial<Record<ScareType, DustBurst>> = {
  // 肖像：画框脸朝下砸到地上，灰从倒地的画框四周喷出去（画框中心在转轴前面，见 PLASTER.slab）
  portrait: { at: PORTRAIT_TIMELINE.impact, spot: () => ({ x: 0, y: 0, z: (PLASTER.slab.z0 + PLASTER.slab.z1) / 2 }) },
  // 床：被子下面的人塌平，灰从躯干那个包正上方的被子面起来；落点比画框小（半宽、半长，米）、一半以上从中间震起、
  // 灰少一点、小一点、慢一点、没有碎屑
  bed: {
    at: BED_TIMELINE.collapse,
    spot: bedDustSpot,
    shape: { halfW: 0.22, halfL: 0.26, edgeShare: 0.4, count: 0.5, size: 0.75, speed: 0.6, chips: false },
  },
  // 衣柜：门被从里面拉上、撞上门框的那一下（WARDROBE_SHUT = slamAt + slamTime；slamAt 那一刻门才开始关）。
  // 落点是整个柜顶（到顶檐外沿）；大半从四边翻出去（前沿最多，见 PLASTER.dust.far），在 WARDROBE.settle 秒里慢慢落到
  // 门前、柜子两边的地上（fall；靠墙那条边的、顶面上震起来的照旧悬一会儿就淡掉）；灰细、不崩碎屑
  wardrobe: {
    at: WARDROBE_SHUT,
    spot: wardrobeDustSpot,
    shape: () => {
      const L = wardrobeLayout();
      return {
        halfW: L.w / 2, halfL: (L.zf - L.zb) / 2,
        edgeShare: 0.85, count: 0.7, size: 0.5, speed: 0.5, chips: false, fall: WARDROBE.settle,
      };
    },
  },
};

export function createParticlesView(core: RenderCore): Module {
  const search = new URLSearchParams(location.search);
  const reducedMq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => reducedMq?.matches === true;

  const root = new THREE.Group();
  root.name = 'particles';
  core.houseRoot.add(root);

  const light = createLightReader(core);
  const screen = makeScreenUniforms();
  const time = uniform(0);
  const motes = createMotes(light.uniforms, screen);
  const plaster = createPlaster(light.uniforms, time);
  const breath = createBreath(light.uniforms, time);
  const objects = [motes.object, plaster.object, breath.object];
  root.add(...objects);
  // 不进开场那次阻塞的预编译：main.ts 在开场按钮可用之后再把它们编好（冷启动省约 0.5 秒）
  for (const o of objects) o.userData.deferCompile = true;
  // 画之前用这一次渲染的相机：屏幕像素换算成米、视线方向、相机类型（娃娃屋的旋转、第三人称镜头的移动中都对得上）
  let lastCamera: THREE.Camera | null = null;
  for (const o of objects) {
    o.onBeforeRender = (renderer, _scene, camera) => {
      updateScreenUniforms(screen, renderer as unknown as THREE.WebGPURenderer, camera);
      light.setCamera(camera);
      lastCamera = camera;
    };
  }

  let quality: Quality = core.quality;
  let enabled = !search.has('noparticles');
  const on = { motes: true, plaster: true, breath: true };
  let driftT = Math.random() * 1000; // 浮尘的漂移时间：从随机处开始，每次开局灰的位置不一样
  /** 等着扬灰的物件（id → 哪种物件、附身之后过了多久，秒）；同一个物件再被附身就从头等 */
  const pending = new Map<string, { type: ScareType; t: number }>();
  let plasterUntil = -1;
  let wasReduced: boolean | null = null;

  const applyQuality = () => {
    plaster.setQuality(quality);
    breath.setQuality(quality);
  };
  applyQuality();

  /**
   * 在 t0（ctx.time 的时间轴）扬一次灰：按 DUST_BURSTS 里这种物件的那一行，落点从物件局部坐标换算到房屋坐标
   * （props.ts：根节点在 propCenter、rotation.y = yawFor(facing)，模型正面朝局部 +z）
   */
  const center = new THREE.Vector3(), axisW = new THREE.Vector3(), axisL = new THREE.Vector3();
  const burstAt = (objectId: string, t0: number) => {
    const p = PROPS.find((x) => x.id === objectId);
    const d = p && DUST_BURSTS[p.type];
    if (!p || !d) return false;
    const c = propCenter(p), yaw = yawFor(p.facing), s = d.spot();
    axisW.set(Math.cos(yaw), 0, -Math.sin(yaw));
    axisL.set(Math.sin(yaw), 0, Math.cos(yaw));
    center.set(c.x, s.y, c.z).addScaledVector(axisW, s.x).addScaledVector(axisL, s.z);
    // 这一次最长的一颗活多久按这一行的形状算（没有碎屑的床不再白画 1.5 秒空的；衣柜的落灰要 5 秒）
    plasterUntil = t0 + plaster.burst(t0, center, axisW, axisL, dustShape(d));
    return true;
  };

  let now = 0;
  let lastState: WorldState | null = null;
  if (search.has('debug')) {
    (window as unknown as { __particles: unknown }).__particles = {
      get enabled() { return enabled; },
      set enabled(v: boolean) { enabled = v; },
      /** 单独开关某一样：__particles.on.motes = false */
      on,
      /** 立刻在肖像那里扬一次灰（不等附身），dt 秒之后砸地 */
      burst(dt = 0) { return burstAt('portrait', now + dt); },
      puff(id: number, scream = false) { return lastState ? breath.debugPuff(id, lastState, core.houseRoot, now, scream) : false; },
      mouths: () => breath.debugMouths(core.houseRoot),
      stats: () => ({
        torches: light.activeTorches,
        visible: objects.map((o) => `${o.name}:${o.visible}`),
        quality,
        reduced: reduced(),
        motes: MOTES.count,
        breath: breath.debugStats(),
        time: +now.toFixed(2),
      }),
      light: light.uniforms,
      /** 排查用：跳过后处理直接画场景（后处理在某个后端坏了时，单独验证粒子在这个后端上对不对） */
      bypassPost() { core.render = (camera) => core.renderer.render(core.scene, camera); },
      /** 房屋坐标 → 画布 CSS 像素（截图裁切用） */
      screen(x: number, y: number, z: number) {
        if (!lastCamera) return null;
        const v = new THREE.Vector3(x, y, z).applyMatrix4(core.houseRoot.matrixWorld).project(lastCamera);
        const el = core.renderer.domElement;
        return { x: (v.x * 0.5 + 0.5) * el.clientWidth, y: (0.5 - v.y * 0.5) * el.clientHeight };
      },
    };
  }

  return {
    update(ctx: FrameCtx) {
      now = ctx.time;
      lastState = ctx.state;
      const red = reduced();
      if (red !== wasReduced) {
        wasReduced = red;
        plaster.setReduced(red);
        breath.setReduced(red);
      }
      time.value = ctx.time;
      driftT += ctx.dt * (red ? MOTES.reducedMotion : 1);
      motes.time.value = driftT;

      if (!enabled) {
        root.visible = false;
        return;
      }
      root.visible = true;
      // 访客模块的 update 在这之前（main.ts 的模块顺序），手电已经摆到这一帧的位置
      light.update(ctx.dt);

      for (const [id, w] of pending) {
        w.t += ctx.dt;
        const at = DUST_BURSTS[w.type]?.at ?? 0;
        if (w.t < at) continue;
        // 按真正越过落下时刻的那一点算起（这一帧可能晚了几毫秒）
        burstAt(id, ctx.time - (w.t - at));
        pending.delete(id);
      }
      breath.update(ctx, core.houseRoot);

      motes.object.visible = on.motes && quality === 'high' && light.activeTorches > 0;
      plaster.object.visible = on.plaster && ctx.time < plasterUntil;
      breath.object.visible = on.breath && breath.alive(ctx.time);
    },
    onEvent(e: SimEvent, state: WorldState) {
      if (e.type === 'trigger' && DUST_BURSTS[e.scareType]) pending.set(e.object, { type: e.scareType, t: 0 });
      breath.onEvent(e, state);
    },
    setQuality(q) {
      quality = q;
      applyQuality();
    },
    dispose() {
      core.houseRoot.remove(root);
      motes.dispose();
      plaster.dispose();
      breath.dispose();
    },
  };
}
