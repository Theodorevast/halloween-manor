// 界面沙盒：harness + 场景叠层 + HUD。场景只放替身几何体（地板、访客方块、物件柱子），不依赖其他任务的画面模块。
// Playwright 里：
//   document.querySelector('[data-start]').click()   关掉开场遮罩
//   window.__ui.demo()                                 塞 4 条播报、让两个物件进入冷却、悬停一个物件
//   window.__ui.hover('portrait') / .error() / .exit('Priya')
// 访客登记簿（2026-10-30「一夜」）：假的一夜，十二个访客、各种走法、一套联名（地址带 ?collab 才写得出联名的名字）：
//   window.__ui.register()                               收夜时翻开（Keep haunting · Another night）
//   window.__ui.register({ closing: false, until: 180 }) 半夜翻开（还有人在屋里；Back to the manor）
//   window.__ui.register({ other: true })                墙上多一个影子出现过（页脚最后一句）
//   window.__ui.register({ crowd: true })                二十个人：只写前十二个，剩下的 and eight others
//   右下角的本子：点开始以后和按钮栏一起出来（第三人称要先 Esc 才点得到，这里没有指针锁定）
import * as THREE from 'three/webgpu';
import '../src/styles.css';
import { HOUSE_D, HOUSE_W } from '../src/config/house';
import { STRINGS } from '../src/config/strings';
import { SCARES } from '../src/config/scares';
import type { Quality } from '../src/engine/types';
import { idleManifest } from '../src/sim/manifest';
import { GHOST_SOURCE } from '../src/sim/types';
import type { Personality, SimEvent, WorldState } from '../src/sim/types';
import { createHud } from '../src/ui/hud';
import { createRegisterView, type RegisterView } from '../src/ui/registerView';
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
// ── 访客登记簿：假的一夜 ─────────────────────────────────
// 钟点：0 秒是晚 9 点，NIGHT.dawn（270 秒）是早 6 点，一秒两分钟。造型 id 照 view/characters.ts 的 outfitOf（地址的文件名）
const fakeOutfits = new Map<number, string>();
/** 登记簿用的假模拟状态（名字、性格从这里取；物件就是沙盒里那几件） */
let nightState: WorldState = { time: 0, npcs: [], objects: h.state.objects, scaredOff: 0, hitStop: 0, manifest: idleManifest(), avoid: [] };
const makeRegister = () => {
  const v = createRegisterView(document.getElementById('hud')!, { outfitOf: (id) => fakeOutfits.get(id) });
  v.onKeepHaunting(() => console.log('[ui] register: Keep haunting'));
  v.onAnotherNight(() => console.log('[ui] register: Another night'));
  v.onToggle((open) => console.log(`[ui] register: ${open ? 'open' : 'closed'}`));
  return v;
};
let registerView: RegisterView = makeRegister();
// 本子跟着「模拟开始走了」露出来：沙盒的时间一直在走；转给登记簿时换成假的这一夜的状态
h.add({ update: (ctx) => registerView.update({ ...ctx, state: { ...nightState, time: Math.max(nightState.time, ctx.state.time) } }) });

/** 按时间顺序把一夜的事件喂给登记簿，过了 until 秒就停（半夜翻开看「还在屋里」） */
function playNight(view: RegisterView, until: number, crowd: boolean) {
  const state: WorldState = { time: 0, npcs: [], objects: h.state.objects, scaredOff: 0, hitStop: 0, manifest: idleManifest(), avoid: [] };
  nightState = state;
  fakeOutfits.clear();
  let nextId = 1;
  const at = (t: number, ...evs: SimEvent[]) => {
    if (t > until) return;
    state.time = t;
    for (const e of evs) view.onEvent(e, state);
  };
  const come = (t: number, name: string, personality: Personality, outfit: string) => {
    const id = nextId++;
    if (t > until) return id;
    fakeOutfits.set(id, outfit);
    state.npcs.push({ id, name, personality, pos: { x: 8, z: 13 }, heading: 0, lookDir: 0, mode: 'entering', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [] });
    at(t, { type: 'spawn', npc: id });
    return id;
  };
  /** 出门（同一步从 state 里拿掉，和模拟一样）；calm = 天亮自己走的 */
  const out = (t: number, id: number, calm = false) => {
    const k = state.npcs.findIndex((n) => n.id === id);
    if (t > until || k < 0) return;
    const [n] = state.npcs.splice(k, 1);
    if (!calm) state.scaredOff += 1;
    at(t, { type: 'exit', npc: id, name: n.name, total: state.scaredOff, ...(calm ? { calm: true } : {}) });
  };
  /** 附身一件物件（trap：是机关发作的），他被吓破胆逃跑 */
  const scare = (t: number, id: number, object: string, trap = false) => {
    const type = h.state.objects.find((o) => o.id === object)!.type;
    const evs: SimEvent[] = trap ? [{ type: 'trap', object, phase: 'sprung' }] : [];
    evs.push({ type: 'trigger', object, scareType: type }, { type: 'startle', npc: id, object, amount: 40, scream: true }, { type: 'flee', npc: id });
    at(t, ...evs);
  };
  const ghost = (id: number): SimEvent => ({ type: 'startle', npc: id, object: GHOST_SOURCE, amount: 30, scream: true });
  const drop = (scared: number[]): SimEvent => ({ type: 'manifest', phase: 'drop', pos: { x: 8, z: 9.5 }, scared });

  if (crowd) {
    // 二十个人：只写前十二个，剩下的一句带过
    const names = ['Mia', 'Theo', 'Priya', 'Ollie', 'June', 'Sam', 'Nora', 'Leo', 'Ada', 'Felix', 'Iris', 'Hugo', 'Maya', 'Ezra', 'Lena', 'Otis', 'Ruth', 'Silas', 'Vera', 'Jonah'];
    const looks = ['vampire', 'lantern-explorer', 'witch', 'skeleton'];
    const props = ['wardrobe', 'bed', 'portrait', 'mirror', 'rocking-chair', 'lamp-living'];
    const kinds: Personality[] = ['timid', 'average', 'brave'];
    const ids = names.map((n, i) => come(2 + i * 9, n, kinds[i % 3], looks[i % 4]));
    ids.forEach((id, i) => {
      if (i >= 17) return;
      scare(17 + i * 9, id, props[i % props.length]);
      out(20 + i * 9, id);
    });
    ids.slice(17).forEach((id, i) => out(272 + i * 3, id, true));
    return;
  }

  const mia = come(2, 'Mia', 'timid', 'vampire');
  const theo = come(22, 'Theo', 'brave', 'jotaro');
  scare(30, mia, 'wardrobe');
  out(34, mia);
  const priya = come(42, 'Priya', 'average', 'lantern-explorer');
  const ollie = come(56, 'Ollie', 'timid', 'witch');
  at(58, drop([theo]), ghost(theo));
  // 后颈一凉吓跑了 Priya，她的尖叫又吓跑了 Ollie
  at(61, { type: 'chill', npc: priya, amount: 12, neck: true }, ghost(priya), { type: 'flee', npc: priya },
    { type: 'startle', npc: ollie, object: null, amount: 9, scream: false }, { type: 'flee', npc: ollie });
  out(65, priya);
  out(66, ollie);
  const june = come(70, 'June', 'average', 'skeleton');
  at(74, drop([theo, june]), ghost(theo), { type: 'flee', npc: theo }, ghost(june));
  out(78, theo);
  const sam = come(84, 'Sam', 'brave', 'vampire');
  const nora = come(98, 'Nora', 'timid', 'witch');
  scare(101, june, 'wardrobe', true);
  out(105, june);
  const leo = come(112, 'Leo', 'average', 'skeleton');
  at(118, { type: 'trigger', object: 'music-box', scareType: 'musicBox' }, { type: 'heard', npc: nora, object: 'music-box' }, { type: 'flee', npc: nora });
  out(122, nora);
  const ada = come(130, 'Ada', 'brave', 'lantern-explorer');
  scare(140, sam, 'wardrobe');
  out(144, sam);
  const felix = come(160, 'Felix', 'average', 'vampire');
  scare(163, leo, 'wardrobe');
  out(167, leo);
  const mia2 = come(175, 'Mia', 'timid', 'witch');
  scare(186, felix, 'portrait');
  out(190, felix);
  const iris = come(196, 'Iris', 'brave', 'skeleton');
  scare(230, mia2, 'wardrobe');
  out(234, mia2);
  // 天亮（270 秒）：还在屋里的人自己出门
  out(276, ada, true);
  out(279, iris, true);
}

const registerApi = {
  /** 翻开登记簿：closing = 收夜时（默认），until = 只演到第几秒，other = 墙上多一个影子出现过，crowd = 二十个人 */
  register(o: { closing?: boolean; until?: number; other?: boolean; crowd?: boolean } = {}) {
    registerView.dispose?.();
    registerView = makeRegister();
    playNight(registerView, o.until ?? Infinity, o.crowd ?? false);
    if (o.other) registerView.noteOtherOne();
    registerView.open({ closing: o.closing ?? true });
    return registerView.isOpen;
  },
  closeRegister: () => registerView.close(),
  registerOpen: () => registerView.isOpen,
  /** 不重放事件，直接翻开现在这一本（比如中途翻开着，main.ts 收夜时再调 open({ closing: true })） */
  openRegister: (closing = true) => registerView.open({ closing }),
};
(window as unknown as { __ui: typeof api & typeof registerApi }).__ui = Object.assign(api, registerApi);

h.start();
