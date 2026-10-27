// 引擎自检页：真正的 createRenderCore + createCameraRig + createPicker + createJuice。
// 一块 16 × 12 米的地板（每米一条格线）、四角 2.4 米高的柱子（检查取景装得下墙高）、
// 四个可拾取方块（userData.propId）、房屋 (8, 6) 处一块亮青色方片（对 toScreen）、一盏手电 + 一盏台灯 + 发光块（看泛光）。
// 按键：Q / E 旋转；Z / X 缩小 / 放大；S 小震；F 模拟吓跑（juice：小震 + 暗角脉冲）；V 只放暗角脉冲；B 切画质；I 开场镜头；T 换色调映射；
// R 开场显影（2.5 秒从 0 到 1，从前门外铺开）
// URL 参数：?tm=agx|neutral|aces|reinhard|none  ?ambient=0.35  ?webgl（强制 WebGL2）  ?quality=low  ?marker（在 toScreen(8, 6) 画红圈）
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W, WALL_H } from '../src/config/house';
import { createCameraRig } from '../src/engine/camera';
import { createJuice } from '../src/engine/juice';
import { createPicker } from '../src/engine/picking';
import { createRenderCore, watchFrameTime } from '../src/engine/renderer';
import type { Quality } from '../src/engine/types';
import type { SimEvent, WorldState } from '../src/sim/types';
import { PALETTE } from '../src/view/palette';

const params = new URLSearchParams(location.search);
const TM: Record<string, THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping,
  neutral: THREE.NeutralToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  none: THREE.NoToneMapping,
};

const host = document.getElementById('stage')!;
const canvas = document.createElement('canvas');
host.appendChild(canvas);
const info = document.getElementById('info')!;
const marker = document.getElementById('marker')!;

const core = await createRenderCore(canvas, { forceWebGL: params.has('webgl') });
const rig = createCameraRig(canvas);
const { scene, houseRoot } = core;
let tmName = params.get('tm') ?? Object.keys(TM).find((k) => TM[k] === core.renderer.toneMapping) ?? '?';
if (params.has('tm') && TM[tmName] !== undefined) core.renderer.toneMapping = TM[tmName];

// —— 场景 ——
scene.add(new THREE.HemisphereLight(PALETTE.moonSky, PALETTE.moonGround, Number(params.get('ambient') ?? 0.35)));
const moon = new THREE.DirectionalLight(PALETTE.moon, 1.2);
moon.position.set(-6, 9, -4);
moon.castShadow = true;
moon.shadow.mapSize.set(1024, 1024);
Object.assign(moon.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 30 });
scene.add(moon);

// 地板：深色木头 + 每米一条格线、外框一圈亮线，截图里一眼能看出 16 × 12 米有没有装全
const floorTex = (() => {
  const px = 64;
  const c = document.createElement('canvas');
  c.width = HOUSE_W * px;
  c.height = HOUSE_D * px;
  const g = c.getContext('2d')!;
  g.fillStyle = '#4a3222';
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#6b5040';
  g.lineWidth = 2;
  for (let i = 1; i < HOUSE_W; i++) { g.beginPath(); g.moveTo(i * px, 0); g.lineTo(i * px, c.height); g.stroke(); }
  for (let j = 1; j < HOUSE_D; j++) { g.beginPath(); g.moveTo(0, j * px); g.lineTo(c.width, j * px); g.stroke(); }
  g.strokeStyle = '#c8b48a';
  g.lineWidth = 8;
  g.strokeRect(4, 4, c.width - 8, c.height - 8);
  // 北边标个 N，判断方位
  g.fillStyle = '#c8b48a';
  g.font = 'bold 48px sans-serif';
  g.textAlign = 'center';
  g.fillText('N', c.width / 2, 60);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
})();
const floor = new THREE.Mesh(new THREE.PlaneGeometry(HOUSE_W, HOUSE_D), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(HOUSE_W / 2, 0, HOUSE_D / 2);
floor.receiveShadow = true;
houseRoot.add(floor);

// 四角柱子：墙的全高
const postMat = new THREE.MeshStandardMaterial({ color: PALETTE.wallpaper, roughness: 0.8 });
for (const [x, z] of [[0, 0], [HOUSE_W, 0], [0, HOUSE_D], [HOUSE_W, HOUSE_D]]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.2, WALL_H, 0.2), postMat);
  m.position.set(x, WALL_H / 2, z);
  m.castShadow = m.receiveShadow = true;
  houseRoot.add(m);
}
// 北面一段全高的墙，看暗部层次和投影
const wall = new THREE.Mesh(new THREE.BoxGeometry(6, WALL_H, 0.2), postMat);
wall.position.set(5, WALL_H / 2, 0.1);
wall.castShadow = wall.receiveShadow = true;
houseRoot.add(wall);

// toScreen 对照：房屋 (8, 6) 地面上一块不受光照的亮青色方片
const target = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0x00ffff }));
target.rotation.x = -Math.PI / 2;
target.position.set(8, 0.01, 6);
houseRoot.add(target);
// 偏离中心的第二块（亮品红，房屋 (2, 10.5)）：旋转、缩放后也能对 toScreen
const target2 = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xff00ff }));
target2.rotation.x = -Math.PI / 2;
target2.position.set(2, 0.01, 10.5);
houseRoot.add(target2);

// 可拾取方块
const BOXES = [
  { id: 'box-nw', x: 3, z: 3, color: 0x8a6a3a },
  { id: 'box-ne', x: 13, z: 3, color: 0x5a5e60 },
  { id: 'box-sw', x: 3.5, z: 9.5, color: 0x4a2430 },
  { id: 'box-se', x: 12.5, z: 9, color: 0x3a3338 },
];
const BOX = 0.6;
const boxes = BOXES.map((b) => {
  const mat = new THREE.MeshStandardMaterial({ color: b.color, roughness: 0.7, emissive: PALETTE.possess, emissiveIntensity: 0 });
  const m = new THREE.Mesh(new THREE.BoxGeometry(BOX, BOX, BOX), mat);
  m.position.set(b.x, BOX / 2, b.z);
  m.castShadow = m.receiveShadow = true;
  m.userData.propId = b.id;
  houseRoot.add(m);
  return { ...b, mesh: m, mat, bump: 0 };
});

// 手电：外圈投影 + 亮芯，照向 (8, 6) 附近；亮芯中心应该超过泛光阈值
const torchPos = new THREE.Vector3(9.5, 1.0, 8.5);
const torchAim = new THREE.Vector3(7.2, 0, 5.6);
const halo = new THREE.SpotLight(PALETTE.torchHalo, 18, 9, 0.58, 1, 1.4);
const coreSpot = new THREE.SpotLight(PALETTE.torchCore, 26, 8, 0.2, 0.6, 1.4);
halo.castShadow = true;
halo.shadow.mapSize.set(1024, 1024);
halo.shadow.bias = -0.0004;
halo.shadow.normalBias = 0.02;
for (const s of [halo, coreSpot]) {
  s.position.copy(torchPos);
  s.target.position.copy(torchAim);
  houseRoot.add(s, s.target);
}
// 台灯：暖色点光 + 发光灯泡（HDR 亮处，泛光应在它周围起一圈光晕）
const lamp = new THREE.PointLight(PALETTE.lamp, 6, 5, 1.6);
lamp.position.set(12, 1.35, 4);
houseRoot.add(lamp);
const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: PALETTE.lamp, emissiveIntensity: 6 }));
bulb.position.copy(lamp.position);
houseRoot.add(bulb);
const lampPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.3, 8), new THREE.MeshStandardMaterial({ color: PALETTE.brass, roughness: 0.5, metalness: 0.6 }));
lampPole.position.set(12, 0.65, 4);
lampPole.castShadow = true;
houseRoot.add(lampPole);
// 幽绿发光块：亮度低于阈值，不该起光晕（对照）
const ghost = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: PALETTE.possess, emissiveIntensity: 0.5 }));
ghost.position.set(5, 0.2, 6);
houseRoot.add(ghost);
// 一块很亮的发光条：泛光对照（亮度 ≫ 阈值）
const hot = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, 1.2), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xfff1dc, emissiveIntensity: 5 }));
hot.position.set(10.5, 0.1, 2.5);
houseRoot.add(hot);

// —— 拾取 ——
let hover: string | null = null;
const picks: string[] = [];
const picker = createPicker(canvas, rig, () => boxes.map((b) => b.mesh));
picker.onHover((id) => {
  hover = id;
  for (const b of boxes) b.mat.emissiveIntensity = b.id === id ? 0.6 : 0;
});
picker.onPick((id) => {
  picks.push(id);
  const b = boxes.find((x) => x.id === id);
  if (b) b.bump = 1;
});

// —— juice：用假事件驱动 ——
const fakeState: WorldState = { time: 0, npcs: [], objects: [], scaredOff: 0, hitStop: 0 };
const juice = createJuice(rig, core);
const emit = (e: SimEvent) => juice.onEvent?.(e, fakeState);

// —— 输入 ——
/** 开场显影的进度计时（秒）；null = 不在播 */
let revealT: number | null = null;
const REVEAL_TIME = 2.5;
const toggleQuality = () => core.setQuality(core.quality === 'high' ? 'low' : 'high');
addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'q') rig.rotate(-1);
  else if (k === 'e') rig.rotate(1);
  else if (k === 'z') rig.zoom(1 / 1.15);
  else if (k === 'x') rig.zoom(1.15);
  else if (k === 's') rig.shake(0.4);
  else if (k === 'f') emit({ type: 'flee', npc: 1 });
  else if (k === 'v') core.fx.vignettePulse(1);
  else if (k === 'b') toggleQuality();
  else if (k === 'i') rig.intro(2.5);
  else if (k === 'r') revealT = 0;
  else if (k === 't') {
    const names = Object.keys(TM);
    tmName = names[(names.indexOf(tmName) + 1) % names.length];
    core.renderer.toneMapping = TM[tmName];
  }
});
let rotations = 0;
rig.onRotate(() => rotations++);

const fit = () => {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  core.resize(w, h);
  rig.resize(w, h);
};
addEventListener('resize', fit);
fit();
if (params.get('quality') === 'low') core.setQuality('low');

let slow = false;
const watch = watchFrameTime(() => {
  slow = true;
  console.log('watchFrameTime: slow');
});

// —— 主循环 ——
const clock = new THREE.Timer();
let frames = 0;
let fpsAcc = 0, fps = 0;
const frame = () => {
  clock.update();
  const dt = Math.min(0.1, clock.getDelta());
  frames++;
  fpsAcc += dt;
  if (fpsAcc > 0.5) { fps = Math.round(frames / fpsAcc); frames = 0; fpsAcc = 0; }
  watch(dt);
  for (const b of boxes) {
    b.bump = Math.max(0, b.bump - dt * 3);
    b.mesh.position.y = BOX / 2 + Math.sin(b.bump * Math.PI) * 0.4;
  }
  if (revealT !== null) {
    revealT += dt;
    core.fx.setReveal(Math.min(1, revealT / REVEAL_TIME));
    if (revealT >= REVEAL_TIME) revealT = null;
  }
  rig.update(dt);
  core.render(rig.camera);
  if (params.has('marker')) {
    const p = rig.toScreen({ x: 8, z: 6 }, 0);
    marker.style.display = 'block';
    marker.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }
  info.textContent =
    `${core.backend} · ${core.quality} · tm ${tmName} · ${fps} fps${slow ? ' · SLOW' : ''}\n` +
    `quarter ${rig.quarter} · viewDir (${rig.viewDir.x.toFixed(2)}, ${rig.viewDir.z.toFixed(2)})\n` +
    `hover ${hover ?? '-'} · picks ${picks.join(',') || '-'}`;
};
core.renderer.setAnimationLoop(frame);

/** 派发一次指针事件到画布（clientX/Y 是相对视口的坐标） */
const dispatch = (type: string, x: number, y: number, pointerType = 'mouse') => {
  const r = canvas.getBoundingClientRect();
  canvas.dispatchEvent(new PointerEvent(type, { clientX: r.left + x, clientY: r.top + y, pointerType, pointerId: pointerType === 'touch' ? 2 : 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, isPrimary: true }));
};

(window as unknown as { __engine: unknown }).__engine = {
  core, rig, picker, backend: core.backend,
  get hover() { return hover; },
  get picks() { return picks.slice(); },
  get rotations() { return rotations; },
  get quality(): Quality { return core.quality; },
  boxes: BOXES,
  toScreen: (x: number, z: number, y = 0) => rig.toScreen({ x, z }, y),
  emit,
  dispatch,
  /** 放慢暗角脉冲 factor 倍再触发，方便截到中间态 */
  slowPulse(factor = 20) {
    if (core.post) core.post.timeScale = 1 / factor;
    core.fx.vignettePulse(1);
  },
  /** 依次对每个方块做：悬停 → 点击；再做一次拖动（不该触发）和一次长按（不该触发）。返回每一步看到的 id */
  pickTest(pointerType = 'mouse') {
    const out: Record<string, unknown> = {};
    for (const b of BOXES) {
      const p = rig.toScreen({ x: b.x, z: b.z }, BOX / 2);
      dispatch('pointermove', p.x, p.y, pointerType);
      const hov = hover;
      const before = picks.length;
      dispatch('pointerdown', p.x, p.y, pointerType);
      dispatch('pointerup', p.x + 2, p.y + 1, pointerType);
      out[b.id] = { screen: [Math.round(p.x), Math.round(p.y)], hover: hov, picked: picks.slice(before) };
    }
    const p = rig.toScreen({ x: BOXES[0].x, z: BOXES[0].z }, BOX / 2);
    let before = picks.length;
    dispatch('pointerdown', p.x, p.y, pointerType);
    dispatch('pointerup', p.x + 20, p.y, pointerType);
    out.drag = picks.slice(before);
    // 空地上悬停应回到 null
    const empty = rig.toScreen({ x: 8, z: 1 }, 0);
    dispatch('pointermove', empty.x, empty.y, pointerType);
    out.emptyHover = hover;
    out.cursor = canvas.style.cursor;
    return out;
  },
  /** 按住 500 ms 再抬起：不该算点击 */
  async longPressTest(pointerType = 'mouse') {
    const p = rig.toScreen({ x: BOXES[1].x, z: BOXES[1].z }, BOX / 2);
    const before = picks.length;
    dispatch('pointerdown', p.x, p.y, pointerType);
    await new Promise((r) => setTimeout(r, 500));
    dispatch('pointerup', p.x, p.y, pointerType);
    return picks.slice(before);
  },
};
console.log('engine backend', core.backend);
