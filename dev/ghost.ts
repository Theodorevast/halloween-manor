// 鬼魂外形和穿墙溶解的开发页：真正的 createRenderCore（含后处理）+ 房子（第三人称模式）+ 物件 + 四支摆好姿势的手电 + 鬼魂。
// 镜头是这一页自带的简易第三人称透视镜头（正式的在 engine/ghostRig.ts，由另一个任务做），鬼魂的位置、朝向由下面的接口直接摆。
// 网址参数：
//   ?at=8,10,-1.57   鬼魂的 x, z, 朝向（方向角，弧度；-π/2 朝北）
//   ?y=1.4           鬼魂离地高度
//   ?dist=2.4&up=0.5 镜头在鬼魂身后多远、比鬼魂高多少（米）；?shoulder=0.32 过肩；?fov=55
//   ?cam=x,y,z       镜头放在这里（看向鬼魂），覆盖 dist / up；?look=x,y,z 看向这一点而不是鬼魂
//   ?low             画质 low；?webgl 强制 WebGL2；?gputime 量 GPU 时间
//   ?notorch         不放手电；?fog 加地面薄雾（雾按正交相机算深度，透视下不准，只看个大概）
//   ?torch=x,z,dir   只放这一支假手电（离地 0.8 米，dir 为照向的方向角），看手电照出鬼魂（G1）；
//                    ?noreveal 照样打光、但不让鬼魂知道自己被照着（登记表强度记 0），对比用
//   ?fx              保留后处理里的 AO 和景深（它们按正交相机写的，透视下会出错，默认关）
//   ?noghostfx / ?noceiling   和正式页面一样：关掉溶解 + 鬼魂 / 不要天花板（量开销的对照）
// Playwright：window.__ghostdev
//   .set(x, z, heading?, y?)        摆鬼魂（同时算 inWall）
//   .cam(dist, up) / .camAt(x, y, z) / .lookAt(x, y, z) / .camFree()   镜头
//   .walk(x0, z0, x1, z1, seconds)  沿直线匀速飘过去（尾迹、穿墙那一团雾都按正常节奏出）
//   .gpu(reset)                     上次 reset 以来平均每帧 GPU 毫秒（要 ?gputime）
//   .holeCheck(n, seed, shoulder)   抽 n 个随机姿势检查「不挖洞的那份」会不会漏掉洞或霜（见函数说明）
//   .setQuality('low') / .stats()
import * as THREE from 'three/webgpu';
import { CELL, HOUSE_D, HOUSE_W, Tile, buildTiles, cellOf, idx, inGrid } from '../src/config/house';
import { createRenderCore } from '../src/engine/renderer';
import type { FrameCtx, GhostRig, GhostState, Module, Quality } from '../src/engine/types';
import type { WorldState } from '../src/sim/types';
import { createFlashlight } from '../src/view/flashlight';
import { createGhostView, ghostRevealAmount } from '../src/view/ghost';
import { torches as torchRegistry } from '../src/view/torches';
import { createHouseView } from '../src/view/house';
import { ghostDissolve } from '../src/view/walls';
import { createPropsView } from '../src/view/props';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const host = document.getElementById('stage') ?? document.body;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
host.appendChild(canvas);

const core = await createRenderCore(canvas, { forceWebGL: q.has('webgl') });
if (!q.has('fx')) core.post?.setFlags({ ao: false, dof: false } as never);

const tiles = buildTiles();
const wallish = (x: number, z: number) => {
  const [i, j] = cellOf(x, z);
  return inGrid(i, j) && (tiles[idx(i, j)] === Tile.Wall || tiles[idx(i, j)] === Tile.Window);
};

/** 这一页的简易第三人称镜头：鬼魂身后 dist 米、高 up 米，看向鬼魂头部稍下 */
function makeRig(): GhostRig {
  const [ax, az, ah] = (q.get('at') ?? '8,10,-1.5708').split(',').map(Number);
  const ghost: GhostState = { x: ax, y: num('y', 1.4), z: az, heading: ah, speed: 0, inWall: false };
  const camera = new THREE.PerspectiveCamera(num('fov', 55), 1, 0.05, 60);
  // shoulder：镜头往鬼魂右边挪多少（正式镜头 ghostRig.ts 是过肩的 0.32 米）
  const opt = { dist: num('dist', 2.4), up: num('up', 0.5), look: 0.05, shoulder: num('shoulder', 0) };
  let fixed: THREE.Vector3 | null = q.has('cam') ? new THREE.Vector3(...(q.get('cam')!.split(',').map(Number) as [number, number, number])) : null;
  let aim: THREE.Vector3 | null = q.has('look') ? new THREE.Vector3(...(q.get('look')!.split(',').map(Number) as [number, number, number])) : null;
  const off = new THREE.Vector3(-HOUSE_W / 2, 0, -HOUSE_D / 2);
  const look = new THREE.Vector3();
  const v = new THREE.Vector3();
  const place = () => {
    if (aim) look.copy(aim).add(off);
    else look.set(ghost.x, ghost.y + opt.look, ghost.z).add(off);
    if (fixed) camera.position.copy(fixed).add(off);
    else {
      const c = Math.cos(ghost.heading), sn = Math.sin(ghost.heading);
      camera.position.set(
        ghost.x - c * opt.dist - sn * opt.shoulder, ghost.y + opt.up, ghost.z - sn * opt.dist + c * opt.shoulder,
      ).add(off);
    }
    camera.lookAt(look);
    camera.updateMatrixWorld();
  };
  place();
  return {
    camera,
    ghost,
    quarter: 0,
    viewDir: { x: Math.SQRT1_2, z: Math.SQRT1_2 },
    lockPointer() {},
    rotate() {},
    zoom(f) { opt.dist = Math.min(4, Math.max(1, opt.dist / f)); },
    shake() {},
    intro() {},
    onRotate() {},
    update() { place(); },
    resize(w, h) {
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    },
    toScreen(p, y = 0) {
      v.set(p.x, y, p.z).add(off).project(camera);
      return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight };
    },
    // 调试用的口子（不在接口里）
    ...({ opt, setFixed: (p: THREE.Vector3 | null) => { fixed = p; }, setAim: (p: THREE.Vector3 | null) => { aim = p; } } as object),
  } as GhostRig;
}

const rig = makeRig();
const rigX = rig as unknown as { opt: { dist: number; up: number; shoulder: number }; setFixed(p: THREE.Vector3 | null): void; setAim(p: THREE.Vector3 | null): void };
const fit = () => {
  core.resize(canvas.clientWidth, canvas.clientHeight);
  rig.resize(canvas.clientWidth, canvas.clientHeight);
};
new ResizeObserver(fit).observe(canvas);
fit();

const modules: Module[] = [createHouseView(core, rig)];
if (q.has('fog')) modules.push((await import('../src/view/fog')).createFogView(core, rig));
modules.push(createPropsView(core));
modules.push(createGhostView(core, rig));

// 四支手电（模拟 4 个访客）：书房、走廊、门厅、厨房，和 dev/fog.ts 一样的姿势；?torch=x,z,dir 时只放那一支
const oneTorch = q.get('torch')?.split(',').map(Number);
const poses = q.has('notorch') ? [] : oneTorch ? [{ x: oneTorch[0], z: oneTorch[1], dir: oneTorch[2] ?? 0 }] : [
  { x: 1.6, z: 2.6, dir: 0.15 },
  { x: 2.2, z: 6.0, dir: 0.05 },
  { x: 8.0, z: 10.4, dir: -Math.PI / 2 },
  { x: 14.2, z: 3.4, dir: Math.PI - 0.2 },
];
const torches = poses.map(() => createFlashlight(core.houseRoot, core.quality));

const state: WorldState = { time: 0, npcs: [], objects: [], scaredOff: 0, hitStop: 0, manifest: { phase: 'idle', t: 0, cooldown: 0, pos: null }, avoid: [] };
let quality: Quality = q.has('low') ? 'low' : 'high';
const setQuality = (v: Quality) => {
  quality = v;
  core.setQuality(v);
  for (const m of modules) m.setQuality?.(v);
  for (const t of torches) t.setQuality(v);
};
if (quality === 'low') setQuality('low');

let walk: { x0: number; z0: number; x1: number; z1: number; t: number; dur: number } | null = null;
const g = rig.ghost as GhostState;
const setGhost = (x: number, z: number, heading = g.heading, y = g.y) => {
  g.x = x; g.z = z; g.heading = heading; g.y = y;
  g.inWall = wallish(x, z);
};

let time = 0;
let last = performance.now();
const loop = () => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  time += dt;
  if (walk) {
    walk.t += dt;
    const u = Math.min(1, walk.t / walk.dur);
    const x = walk.x0 + (walk.x1 - walk.x0) * u, z = walk.z0 + (walk.z1 - walk.z0) * u;
    g.speed = u < 1 ? Math.hypot(walk.x1 - walk.x0, walk.z1 - walk.z0) / walk.dur : 0;
    setGhost(x, z, Math.atan2(walk.z1 - walk.z0, walk.x1 - walk.x0));
    if (u >= 1) walk = null;
  }
  rig.update(dt);
  poses.forEach((p, k) => torches[k].update({ x: p.x, y: 0.8, z: p.z, dir: p.dir, power: 1, nervous: false }, dt, time));
  // ?noreveal：灯照样亮，鬼魂的着色器当作没被照着（A/B 对比）
  if (q.has('noreveal')) for (const t of torchRegistry) t.power = 0;
  const ctx: FrameCtx = { dt, time, state };
  for (const m of modules) m.update?.(ctx);
  core.render(rig.camera);
};
core.renderer.setAnimationLoop(loop);

/**
 * 抽 n 个随机姿势（镜头过肩 shoulder 米，和正式镜头一样），检查「不挖洞的那份」（walls.ts 的 HOLE_TEST）有没有漏掉洞或霜：
 * 选中不挖洞的那份时，同一帧里分别画选中的和强制挖洞的，逐像素比较（不走后处理，AO 有上一帧的状态）。
 * bad 里是有差别的姿势（应该没有）
 */
async function holeCheck(n = 60, seed = 7, shoulder = 0.32, keep = 0, noGlow = false) {
  core.renderer.setAnimationLoop(null);
  rigX.opt.shoulder = shoulder;
  let sd = seed;
  const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
  const W = 640, H = 400;
  const rt = new THREE.RenderTarget(W, H, { samples: 0 });
  const get = (name: string) => core.scene.getObjectByName(name)!;
  const wv = get('walls-visible'), ws = get('walls-visible-solid'), fv = get('furniture'), fs = get('furniture-solid');
  const grab = async () => {
    core.renderer.setRenderTarget(rt);
    core.renderer.render(core.scene, rig.camera);
    const px = (await core.renderer.readRenderTargetPixelsAsync(rt, 0, 0, W, H)) as Uint8Array;
    core.renderer.setRenderTarget(null);
    return px;
  };
  const res = { poses: 0, bothMasked: 0, solidWalls: 0, solidFurniture: 0, bad: [] as unknown[], images: [] as string[] };
  // 第一次画进这个渲染目标时要现编管线，结果不可靠：先空画两遍
  for (const m of [wv, ws, fv, fs]) m.visible = true;
  await grab();
  await grab();
  const toUrl = (px: Uint8Array) => {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const id = new ImageData(W, H);
    // 渲染目标的第 0 行在底下
    for (let y = 0; y < H; y++) id.data.set(px.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    c.getContext('2d')!.putImageData(id, 0, 0);
    return c.toDataURL('image/png');
  };
  for (let k = 0; k < n; k++) {
    setGhost(0.6 + rnd() * 14.8, 0.6 + rnd() * 10.8, rnd() * Math.PI * 2);
    rig.update(0);
    for (const m of modules) m.update?.({ dt: 0, time, state });
    if (noGlow) ghostDissolve.glow.value = 0;
    res.poses++;
    const a = { walls: wv.visible, furniture: fv.visible };
    if (a.walls && a.furniture) { res.bothMasked++; continue; }
    if (!a.walls) res.solidWalls++;
    if (!a.furniture) res.solidFurniture++;
    const p0 = await grab();
    wv.visible = true; ws.visible = false; fv.visible = true; fs.visible = false;
    const p1 = await grab();
    let diff = 0;
    for (let i = 0; i < p0.length; i += 4) {
      if (Math.abs(p0[i] - p1[i]) + Math.abs(p0[i + 1] - p1[i + 1]) + Math.abs(p0[i + 2] - p1[i + 2]) > 6) diff++;
    }
    if (diff > 0) {
      res.bad.push({ x: +g.x.toFixed(2), z: +g.z.toFixed(2), heading: +g.heading.toFixed(3), diff, ...a });
      if (res.images.length < keep * 3) {
        const dd = new Uint8Array(p0.length);
        for (let i = 0; i < p0.length; i++) dd[i] = (i & 3) === 3 ? 255 : Math.min(255, Math.abs(p0[i] - p1[i]) * 20);
        res.images.push(toUrl(p0), toUrl(p1), toUrl(dd));
      }
    }
  }
  rt.dispose();
  last = performance.now();
  core.renderer.setAnimationLoop(loop);
  return res;
}

setGhost(g.x, g.z);
(window as unknown as { __ghostdev: unknown }).__ghostdev = {
  set: (x: number, z: number, heading?: number, y?: number) => { walk = null; g.speed = 0; setGhost(x, z, heading, y); },
  cam: (dist: number, up: number) => { rigX.setFixed(null); rigX.opt.dist = dist; rigX.opt.up = up; },
  camAt: (x: number, y: number, z: number) => rigX.setFixed(new THREE.Vector3(x, y, z)),
  camFree: () => { rigX.setFixed(null); rigX.setAim(null); },
  /** 镜头看向这一点（房屋坐标），不再看鬼魂；lookAt(null) 恢复 */
  lookAt: (x: number | null, y = 0, z = 0) => rigX.setAim(x === null ? null : new THREE.Vector3(x, y, z)),
  walk: (x0: number, z0: number, x1: number, z1: number, seconds: number) => {
    setGhost(x0, z0, Math.atan2(z1 - z0, x1 - x0));
    walk = { x0, z0, x1, z1, t: 0, dur: seconds };
  },
  gpu: (reset = false) => core.gpuTime(reset),
  holeCheck,
  setQuality,
  stats: () => ({
    backend: core.backend, quality, ghost: { ...g }, cell: cellOf(g.x, g.z), cellSize: CELL,
    drawCalls: core.renderer.info.render.drawCalls, post: Boolean(core.post),
    reveal: +ghostRevealAmount().toFixed(3),
  }),
  core,
  THREE,
};
console.log('backend', core.backend);
