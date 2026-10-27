// 开发沙盒：给各画面模块单独调试用的最小渲染器 + 相机 + 假状态。不进正式构建。
// 用法（dev/xxx.ts）：
//   const h = await createHarness();
//   h.add(createSomethingView(h.core, h.rig));
//   h.start();
// 按键：1–7 依次附身 PROPS 里的物件；F 让 0 号访客逃跑；Q / E 旋转镜头；空格暂停假访客
// Playwright 里可以用 window.__harness.trigger('portrait') / .flee(0) / .rotate(1) 驱动
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W, PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import type { CameraRig, FrameCtx, Module, RenderCore } from '../src/engine/types';
import { angleOf } from '../src/lib/angle';
import type { NpcState, SimEvent, Vec2, WorldState } from '../src/sim/types';

const ELEV = (35 * Math.PI) / 180;

function makeRig(canvas: HTMLCanvasElement): CameraRig {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  let quarter = 0;
  let zoom = 1;
  const cbs: ((q: number) => void)[] = [];
  const viewDir: Vec2 = { x: 0, z: 0 };
  const place = () => {
    const az = Math.PI / 4 + (quarter * Math.PI) / 2;
    viewDir.x = Math.cos(az);
    viewDir.z = Math.sin(az);
    const r = 30;
    camera.position.set(viewDir.x * r * Math.cos(ELEV), r * Math.sin(ELEV), viewDir.z * r * Math.cos(ELEV));
    camera.lookAt(0, 0, 0);
  };
  const resize = (w: number, h: number) => {
    const half = 7.2 / zoom;
    const aspect = w / h;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    camera.updateProjectionMatrix();
  };
  place();
  const v = new THREE.Vector3();
  return {
    camera,
    get quarter() { return quarter; },
    get viewDir() { return viewDir; },
    rotate(dir) {
      quarter = (quarter + dir + 4) % 4;
      place();
      cbs.forEach((cb) => cb(quarter));
    },
    zoom(f) {
      zoom = Math.min(1.6, Math.max(0.75, zoom * f));
      resize(canvas.clientWidth, canvas.clientHeight);
    },
    shake() {},
    punch() {},
    intro() {},
    onRotate(cb) { cbs.push(cb); },
    update() {},
    resize,
    toScreen(p, y = 0) {
      v.set(p.x - HOUSE_W / 2, y, p.z - HOUSE_D / 2).project(camera);
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    },
  };
}

/** 两个假访客：一个在走廊里来回走，一个在客厅里绕圈 */
function fakeNpc(id: number, name: string, personality: NpcState['personality']): NpcState {
  return { id, name, personality, pos: { x: 4, z: 6 }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 20, nervous: false, speed: 1.3, screaming: 0, path: [] };
}

export interface Harness {
  core: RenderCore;
  rig: CameraRig;
  state: WorldState;
  add(m: Module): void;
  emit(e: SimEvent): void;
  start(): void;
}

export async function createHarness(opts: { ambient?: number } = {}): Promise<Harness> {
  const host = document.getElementById('stage') ?? document.body;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
  host.appendChild(canvas);

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050608);
  const houseRoot = new THREE.Group();
  houseRoot.position.set(-HOUSE_W / 2, 0, -HOUSE_D / 2);
  scene.add(houseRoot);
  scene.add(new THREE.HemisphereLight(0x8090b0, 0x201810, opts.ambient ?? 0.25));
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

  const core: RenderCore = {
    renderer, scene, houseRoot, backend, quality: 'high',
    setQuality(q) { core.quality = q; },
    resize(w, h) { renderer.setSize(w, h, false); },
    render(camera) { renderer.render(scene, camera); },
    fx: { vignettePulse() {}, focus() {}, setReveal() {} },
  };
  const rig = makeRig(canvas);

  const state: WorldState = {
    time: 0,
    npcs: [fakeNpc(1, 'Mia', 'timid'), fakeNpc(2, 'Theo', 'brave')],
    objects: PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing, cooldown: 0, active: 0, broken: 0, seenBy: [] })),
    scaredOff: 0,
    hitStop: 0,
  };
  const modules: Module[] = [];
  const pending: SimEvent[] = [];
  let paused = false;

  const trigger = (id: string) => {
    const o = state.objects.find((x) => x.id === id);
    if (!o || o.cooldown > 0) return false;
    const s = SCARES[o.type];
    o.cooldown = s.cooldown;
    o.active = s.active;
    pending.push({ type: 'trigger', object: id, scareType: o.type });
    if (s.kind === 'sight') {
      o.broken = s.broken;
      const n = state.npcs[0];
      if (n) {
        n.fear = Math.min(100, n.fear + s.fear);
        n.mode = 'startled';
        n.modeTime = 0;
        n.screaming = 1.1;
        pending.push({ type: 'startle', npc: n.id, object: id, amount: s.fear, scream: true });
      }
    } else {
      for (const n of state.npcs) pending.push({ type: 'heard', npc: n.id, object: id });
    }
    return true;
  };
  const flee = (i: number) => {
    const n = state.npcs[i];
    if (!n) return;
    n.fear = 100;
    n.mode = 'fleeing';
    n.modeTime = 0;
    n.screaming = 1.1;
    state.hitStop = 0.15;
    pending.push({ type: 'flee', npc: n.id });
  };

  addEventListener('keydown', (e) => {
    const k = Number(e.key);
    if (k >= 1 && k <= PROPS.length) trigger(PROPS[k - 1].id);
    if (e.key === 'f' || e.key === 'F') flee(0);
    if (e.key === 'q' || e.key === 'Q') rig.rotate(-1);
    if (e.key === 'e' || e.key === 'E') rig.rotate(1);
    if (e.key === ' ') paused = !paused;
  });
  canvas.addEventListener('wheel', (e) => rig.zoom(e.deltaY > 0 ? 0.9 : 1.1), { passive: true });

  const fit = () => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    core.resize(w, h);
    rig.resize(w, h);
  };
  addEventListener('resize', fit);
  fit();

  // 假访客的运动：0 号在走廊里东西来回，1 号在客厅里绕圈；手电跟着走向，带一点左右扫
  const moveFake = (dt: number) => {
    state.time += dt;
    const t = state.time;
    const a = state.npcs[0];
    if (a && a.mode !== 'gone') {
      const x = 8 + Math.sin(t * 0.25) * 6;
      const prev = { ...a.pos };
      a.pos = { x, z: 6 };
      if (a.mode === 'startled' && (a.modeTime += dt) > 0.8) a.mode = 'wander';
      if (a.mode === 'fleeing') a.pos = { x: 8, z: Math.min(13, prev.z + dt * 3) };
      a.heading = angleOf(a.pos.x - prev.x, a.pos.z - prev.z);
      a.lookDir = a.heading + Math.sin(t * 2.4) * 0.5;
      a.speed = a.mode === 'fleeing' ? 3.2 : 1.3;
    }
    const b = state.npcs[1];
    if (b) {
      const ang = t * 0.35;
      const prev = { ...b.pos };
      b.pos = { x: 8 + Math.cos(ang) * 2.2, z: 2.6 + Math.sin(ang) * 1.2 };
      b.heading = angleOf(b.pos.x - prev.x, b.pos.z - prev.z);
      b.lookDir = b.heading + 0.3;
      b.speed = 1.3;
      b.nervous = true;
    }
    for (const n of state.npcs) {
      n.screaming = Math.max(0, n.screaming - dt);
      n.nervous = n.fear >= 60;
    }
    for (const o of state.objects) {
      o.cooldown = Math.max(0, o.cooldown - dt);
      o.active = Math.max(0, o.active - dt);
      if (o.broken > 0 && (o.broken -= dt) <= 0) {
        o.broken = 0;
        pending.push({ type: 'reset', object: o.id });
      }
      o.seenBy = SCARES[o.type].kind === 'sight' && a && Math.hypot(a.pos.x - o.pos.x, a.pos.z - o.pos.z) < 4 ? [a.id] : [];
    }
  };

  const clock = new THREE.Timer();
  let time = 0;
  const frame = () => {
    clock.update();
    const dt = Math.min(0.1, clock.getDelta());
    time += dt;
    if (state.hitStop > 0) state.hitStop = Math.max(0, state.hitStop - dt);
    else if (!paused) moveFake(dt);
    const evs = pending.splice(0);
    for (const e of evs) for (const m of modules) m.onEvent?.(e, state);
    const ctx: FrameCtx = { dt, time, state };
    rig.update(dt);
    for (const m of modules) m.update?.(ctx);
    core.render(rig.camera);
  };

  (window as unknown as { __harness: unknown }).__harness = {
    state, trigger, flee, rotate: (d: 1 | -1) => rig.rotate(d), backend,
  };

  return {
    core, rig, state,
    add(m) { modules.push(m); },
    emit(e) { pending.push(e); },
    start() { renderer.setAnimationLoop(frame); },
  };
}
