// 地面薄雾的开发页：真正的 createRenderCore（含后处理）+ 相机 + 房子 + 物件 + 四支摆好姿势的手电 + 雾。
// 不放访客（不用等模拟），手电位置固定，方便同一个角度反复对比。
// 网址参数：
//   ?q=2        开局先转几次镜头
//   ?low        画质 low
//   ?nofog      不加雾（对照）
//   ?sweep      手电左右慢慢扫
//   ?webgl      强制 WebGL2
//   ?t=12       雾的时间从这里开始（截图时让噪声停在同一个样子：配合 ?freeze）
//   ?freeze     时间不走
//   ?focus=8,6  把镜头平移到房屋坐标 (x, z)；?mag=3 再放大（看局部细节）
//   ?fog=density:2,scatter:0.05  临时改 FOG 里的数值；?amb=0.03,0.032,0.04 改雾的底色（线性）
// Playwright：window.__fogdev.rotate(1) / .setQuality('low')
import * as THREE from 'three/webgpu';
import { createCameraRig } from '../src/engine/camera';
import { createRenderCore } from '../src/engine/renderer';
import type { FrameCtx, Module, Quality } from '../src/engine/types';
import type { WorldState } from '../src/sim/types';
import { createFlashlight } from '../src/view/flashlight';
import { FOG, createFogView } from '../src/view/fog';
import { createHouseView } from '../src/view/house';
import { createPropsView } from '../src/view/props';

const q = new URLSearchParams(location.search);
const host = document.getElementById('stage') ?? document.body;
const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block';
host.appendChild(canvas);

const core = await createRenderCore(canvas, { forceWebGL: q.has('webgl') });
const rig = createCameraRig(canvas);
const fit = () => {
  core.resize(canvas.clientWidth, canvas.clientHeight);
  rig.resize(canvas.clientWidth, canvas.clientHeight);
};
new ResizeObserver(fit).observe(canvas);
fit();

// 调参：?fog=density:2,scatter:0.05（FOG 里的数值字段）、?amb=0.03,0.032,0.04（雾的底色，线性）
for (const kv of (q.get('fog') ?? '').split(',').filter(Boolean)) {
  const [k, v] = kv.split(':');
  if (typeof (FOG as Record<string, unknown>)[k] === 'number') (FOG as Record<string, unknown>)[k] = Number(v);
}
if (q.has('amb')) FOG.ambient.setRGB(...(q.get('amb')!.split(',').map(Number) as [number, number, number]));

const modules: Module[] = [createHouseView(core, rig)];
if (!q.has('nofog')) modules.push(createFogView(core, rig));
modules.push(createPropsView(core));

// 四支手电：书房照东墙（墙后客厅的雾不该亮）、走廊往东、门厅往北穿过门洞、厨房照西墙
const poses = [
  { x: 1.6, z: 2.6, dir: 0.15 },
  { x: 2.2, z: 6.0, dir: 0.05 },
  { x: 8.0, z: 10.4, dir: -Math.PI / 2 },
  { x: 14.2, z: 3.4, dir: Math.PI - 0.2 },
];
const torches = poses.map(() => createFlashlight(core.houseRoot, core.quality));

const state: WorldState = { time: 0, npcs: [], objects: [], scaredOff: 0, hitStop: 0 };
let quality: Quality = q.has('low') ? 'low' : 'high';
const setQuality = (v: Quality) => {
  quality = v;
  core.setQuality(v);
  for (const m of modules) m.setQuality?.(v);
  for (const t of torches) t.setQuality(v);
};
if (quality === 'low') setQuality('low');
for (let i = 0; i < Number(q.get('q') ?? 0); i++) rig.rotate(1);

let time = Number(q.get('t') ?? 0);
let last = performance.now();
core.renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!q.has('freeze')) time += dt;
  rig.update(dt);
  if (q.has('focus') || q.has('mag')) {
    // 看局部：rig 每帧重摆相机，这里每帧在它之后平移 / 放大（超出 rig 的缩放上限，只用来看细节）
    const [fx, fz] = (q.get('focus') ?? '8,6').split(',').map(Number);
    rig.camera.position.add(new THREE.Vector3(fx - 8, 0, fz - 6));
    rig.camera.zoom = Number(q.get('mag') ?? 1);
    rig.camera.updateProjectionMatrix();
    rig.camera.updateMatrixWorld();
  }
  poses.forEach((p, k) => {
    const dir = p.dir + (q.has('sweep') ? Math.sin(time * 0.6 + k) * 0.5 : 0);
    torches[k].update({ x: p.x, y: 0.8, z: p.z, dir, power: 1, nervous: false }, dt, time);
  });
  const ctx: FrameCtx = { dt, time, state };
  for (const m of modules) m.update?.(ctx);
  core.render(rig.camera);
});

(window as unknown as { __fogdev: unknown }).__fogdev = {
  rotate: (d: 1 | -1) => rig.rotate(d),
  setQuality,
  get quality() { return quality; },
  backend: core.backend,
  scene: core.scene,
  THREE,
};
console.log('backend', core.backend);
