// 粒子：手电光束里的浮尘、肖像砸地扬起的粉尘、受惊访客呼出的白气（2026-10-27 电影感升级）。
// 三样都是「哈希 + 时间」驱动的实例化精灵（SpriteNodeMaterial），每样一次绘制：
// - 浮尘（particles/motes.ts）：几千颗，只在手电光锥里、墙这一侧亮；
// - 粉尘（particles/plaster.ts）：肖像砸地那一刻从画框四周喷出一团灰褐色的灰 + 几粒碎屑；
// - 白气（particles/breath.ts）：恐惧值过了紧张线的人隔一会儿呼一小口，越怕喘得越急。
// 灯光不走 three 的灯光系统（particles/light.ts，和雾同一套光锥和挡墙算法），材质都不受光照：灯的数量变了不重新编译。
//
// 材质、几何体开局一次建好，之后只改 uniform 和一小段实例缓冲；三个物体都标了 deferCompile（全部粒子缩成 0），
// main.ts 在开场按钮可用之后把它们显示出来真画一帧编好管线，第一次 update 起再按需要藏起来（没有粒子时不画；
// 粉尘的软粒子要每帧拷一次深度，只在扬灰的两秒里拷）。
// 粒子着色器里不用 select()（见 particles/common.ts 的 ge / lt）。
// 性能（2026-10-27，本机 WebGPU，4 个访客，High，DPR 2，不锁帧率，同页轮流开关 16 轮）：常态（浮尘 + 呼气）±1% 以内，测不出；
// 三样同时满载（每 0.25 秒全员呼气 + 连续扬灰）约 +3%。
// 都是透明、不写深度；后处理以后要是加了 MRT（法线 / 速度），粒子不覆盖那些附件（common.ts 的 protectMRT）。
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { PROPS, propCenter } from '../config/house';
import type { FrameCtx, Module, Quality, RenderCore } from '../engine/types';
import { yawFor } from '../lib/angle';
import type { SimEvent, WorldState } from '../sim/types';
import { createBreath } from './particles/breath';
import { makeScreenUniforms, updateScreenUniforms } from './particles/common';
import { createLightReader } from './particles/light';
import { MOTES, createMotes } from './particles/motes';
import { PLASTER, createPlaster } from './particles/plaster';
import { PORTRAIT_TIMELINE } from './props/portrait';

export { BREATH } from './particles/breath';
export { MOTES } from './particles/motes';
export { PLASTER } from './particles/plaster';

/** 附身之后多久画框砸到地上（秒，和 props/portrait.ts 的时间线一致；那边用的也是真实时间 dt） */
const PORTRAIT_IMPACT = PORTRAIT_TIMELINE.impact;

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
  // 画之前用这一次渲染的相机：屏幕像素换算成米、视线方向（开场下降、旋转、冲镜中都对得上）
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
  let pendingImpact = -1; // 附身之后过了多久（秒）；-1 = 没有在等砸地
  let pendingObject = 'portrait';
  let plasterUntil = -1;
  let wasReduced: boolean | null = null;

  const applyQuality = () => {
    plaster.setQuality(quality);
    breath.setQuality(quality);
  };
  applyQuality();

  /** 物件局部 → 房屋坐标（props.ts：根节点在 propCenter、rotation.y = yawFor(facing)，模型正面朝局部 +z） */
  const center = new THREE.Vector3(), axisW = new THREE.Vector3(), axisL = new THREE.Vector3();
  const burstAt = (objectId: string, t0: number) => {
    const p = PROPS.find((x) => x.id === objectId);
    if (!p) return false;
    const c = propCenter(p), yaw = yawFor(p.facing);
    axisW.set(Math.cos(yaw), 0, -Math.sin(yaw));
    axisL.set(Math.sin(yaw), 0, Math.cos(yaw));
    const mid = (PLASTER.slab.z0 + PLASTER.slab.z1) / 2;
    center.set(c.x, 0, c.z).addScaledVector(axisL, mid);
    plaster.burst(t0, center, axisW, axisL);
    plasterUntil = t0 + plaster.maxLife;
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

      if (pendingImpact >= 0) {
        pendingImpact += ctx.dt;
        if (pendingImpact >= PORTRAIT_IMPACT) {
          // 按真正越过砸地时刻的那一点算起（这一帧可能晚了几毫秒）
          burstAt(pendingObject, ctx.time - (pendingImpact - PORTRAIT_IMPACT));
          pendingImpact = -1;
        }
      }
      breath.update(ctx, core.houseRoot);

      motes.object.visible = on.motes && quality === 'high' && light.activeTorches > 0;
      plaster.object.visible = on.plaster && ctx.time < plasterUntil;
      breath.object.visible = on.breath && breath.alive(ctx.time);
    },
    onEvent(e: SimEvent, state: WorldState) {
      if (e.type === 'trigger' && e.scareType === 'portrait') {
        pendingImpact = 0;
        pendingObject = e.object;
      }
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
