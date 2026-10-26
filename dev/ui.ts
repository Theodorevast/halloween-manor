// 界面沙盒：harness + 场景叠层 + HUD。场景只放替身几何体（地板、访客方块、物件柱子），不依赖其他任务的画面模块。
// Playwright 里：
//   document.querySelector('[data-start]').click()   关掉开场遮罩
//   window.__ui.demo()                                 塞 4 条播报、让两个物件进入冷却、悬停一个物件
//   window.__ui.hover('portrait') / .error() / .exit('Priya')
import * as THREE from 'three/webgpu';
import '../src/styles.css';
import { HOUSE_D, HOUSE_W } from '../src/config/house';
import { STRINGS } from '../src/config/strings';
import { SCARES } from '../src/config/scares';
import type { Quality } from '../src/engine/types';
import { createHud } from '../src/ui/hud';
import { createOverlays } from '../src/view/overlays';
import { PALETTE } from '../src/view/palette';
import { createHarness } from './harness';

// ?title=... 只在沙盒里临时替换标题，用来检查不同长度的标题排版（不改 config）
const titleOverride = new URLSearchParams(location.search).get('title');
if (titleOverride) STRINGS.title = titleOverride;

const h = await createHarness({ ambient: 0.9 });
const root = h.core.houseRoot;

// 替身场景：地板 + 房间格线，访客是暖色方块，物件是暗绿柱子
const floor = new THREE.Mesh(new THREE.PlaneGeometry(HOUSE_W, HOUSE_D), new THREE.MeshStandardMaterial({ color: PALETTE.woodDark }));
floor.rotation.x = -Math.PI / 2;
floor.position.set(HOUSE_W / 2, 0, HOUSE_D / 2);
root.add(floor);
const grid = new THREE.GridHelper(HOUSE_W, 32, 0x2a2420, 0x1a1512);
grid.scale.z = HOUSE_D / HOUSE_W;
grid.position.set(HOUSE_W / 2, 0.01, HOUSE_D / 2);
root.add(grid);
const npcMeshes = h.state.npcs.map(() => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(0.45, 1.1, 0.45), new THREE.MeshStandardMaterial({ color: 0x8a6a3a }));
  root.add(m);
  return m;
});
for (const o of h.state.objects) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.9), new THREE.MeshStandardMaterial({ color: 0x2f5a44 }));
  m.position.set(o.pos.x, 0.45, o.pos.z);
  root.add(m);
}
h.add({
  update({ state }) {
    state.npcs.forEach((n, i) => npcMeshes[i]?.position.set(n.pos.x, 0.55, n.pos.z));
  },
});

// harness 自己也监听 Q / E 转镜头；键盘触发时 HUD 的 onRotate 就不要再转一次
let keyRotate = false;
addEventListener('keydown', (e) => {
  keyRotate = e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E';
  // 用 setTimeout 而不是微任务：微任务在每个监听器之间就会跑掉，等不到 HUD 的监听器
  setTimeout(() => { keyRotate = false; }, 0);
}, { capture: true });

let muted = false;
let quality: Quality = 'high';
const overlays = createOverlays(document.getElementById('overlay')!, h.rig);
const hud = createHud(document.getElementById('hud')!, {
  onBegin: () => console.log('[ui] onBegin'),
  onRotate: (d) => { if (!keyRotate) h.rig.rotate(d); },
  onToggleMute: () => (muted = !muted),
  onToggleQuality: () => (quality = quality === 'high' ? 'low' : 'high'),
});
h.add(overlays);
h.add(hud);
hud.showStart();

// 没有正式的拾取器：指针离哪个物件的屏幕位置最近（40 px 内）就算悬停
const canvas = document.querySelector<HTMLCanvasElement>('#stage canvas')!;
canvas.addEventListener('pointermove', (e) => {
  let best: string | null = null;
  let bestD = 40;
  for (const o of h.state.objects) {
    const s = h.rig.toScreen(o.pos, 0.5);
    const d = Math.hypot(s.x - e.clientX, s.y - e.clientY);
    if (d < bestD) { bestD = d; best = o.id; }
  }
  overlays.setHover(best);
});

const obj = (id: string) => h.state.objects.find((o) => o.id === id)!;
const api = {
  hud,
  overlays,
  state: h.state,
  rig: h.rig,
  emit: h.emit,
  hover: (id: string | null) => overlays.setHover(id),
  error: () => hud.showError(STRINGS.noWebGL),
  exit(name = 'Priya') {
    h.state.scaredOff += 1;
    h.emit({ type: 'exit', npc: 99, name, total: h.state.scaredOff });
  },
  /** 一次性摆出「游戏中」的样子：4 条播报、一个血红恐惧条、两个冷却圆环、一个悬停标签 */
  demo() {
    const [mia, theo] = h.state.npcs;
    theo.fear = 86;
    mia.fear = 46;
    h.emit({ type: 'spawn', npc: theo.id });
    h.emit({ type: 'heard', npc: mia.id, object: 'music-box' });
    h.emit({ type: 'startle', npc: mia.id, object: 'portrait', amount: 32, scream: true });
    h.emit({ type: 'flee', npc: theo.id });
    api.exit('Priya');
    const chair = obj('rocking-chair');
    chair.cooldown = SCARES.rockingChair.cooldown * 0.62;
    const door = obj('kitchen-door');
    door.cooldown = SCARES.door.cooldown * 0.35;
    overlays.setHover('rocking-chair');
  },
};
(window as unknown as { __ui: typeof api }).__ui = api;

h.start();
