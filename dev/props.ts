// 物件沙盒：harness + 全部可附身物件 + 示意用的房子轮廓（降低的墙、家具方块，只为看清物件在屋里的位置）
// URL 参数：
//   ?ambient=0.25      环境光（默认 1.2 看结构；0.25 看氛围）
//   ?zoom=1.6          镜头缩放（harness 限制 0.75–1.6）
//   ?focus=<物件 id>&size=1.2   镜头对准一个物件看细节（size = 半个画面高，米）
//   ?house             用任务 3 的真房子（src/view/house.ts）代替示意轮廓（还没写好时自动退回轮廓）
//   ?q=low             low 画质档
//   ?torch             一只手电（外圈 + 亮芯两盏聚光，参数同 flashlight.ts）从卧室门口照向床：看鼓包的明暗和影子
//   ?torch=x,z,tx,tz   手电的位置和照向的点（房屋米坐标）；再给第五个数 ty 是照向的点有多高（默认 0.45 米）
//   ?overlay           加上物件上方的标记层（眼睛、冷却圆环、悬停标签；用游戏的 styles.css），看机关设下后的空心眼睛
//   ?fingers           衣柜每次都出手指那个变体（?fingers=0：每次都不出）；不给就和正式游戏一样随机，三次里大约一次
//   ?webgl             走 WebGL2（假装浏览器没有 WebGPU，three 自动退回 WebGL2 后端；harness 不管这个参数）
// 按键：1–9 附身（harness 提供；床是 8，衣柜是 9）；鼠标悬停 = setHover，点击 = 附身
// Playwright：window.__props = { ids(), targets(), hover(id), pause(), play(), advance(s), focus(id, size), look(x, y, z, size), drawCalls(), pick(x, y),
//   arm(id, 秒) 假装设下机关（armed = 秒数，0 = 解除；sandbox 里不倒数）, shells(id) 这个物件的幽光 / 霜外壳此刻显不显示,
//   trigger(id, variant?) 附身，variant 给了就用它（衣柜：小于 WARDROBE.fingersChance 出手指） }
import * as THREE from 'three/webgpu';
import { buildTiles, CELL, FURNITURE, GRID_H, GRID_W, HOUSE_D, HOUSE_W, idx, PROPS, propCenter, Tile, WALL_CUT_H } from '../src/config/house';
import type { FrameCtx, RenderCore, CameraRig, Module } from '../src/engine/types';
import type { ScareType } from '../src/sim/types';
import { VISION } from '../src/config/visitors';
import { PALETTE } from '../src/view/palette';
import { createOverlays } from '../src/view/overlays';
import { createPropsView } from '../src/view/props';
import { createHarness } from './harness';

const qs = new URLSearchParams(location.search);
// ?webgl：harness 自己不支持强制 WebGL2，这里让 WebGPU 拿不到适配器，WebGPURenderer 初始化失败时自动退回 WebGL2（只在开发页）
if (qs.has('webgl')) Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => null }, configurable: true });
const h = await createHarness({ ambient: Number(qs.get('ambient') ?? 1.2) });
const { core, rig } = h;

// ── 房子：真房子或示意轮廓 ───────────────────────────────────────────────
async function tryHouse(): Promise<boolean> {
  if (!qs.has('house')) return false;
  try {
    const path = '../src/view/house.ts';
    const mod = (await import(/* @vite-ignore */ path)) as { createHouseView(core: RenderCore, rig: CameraRig): Module };
    h.add(mod.createHouseView(core, rig));
    return true;
  } catch (err) {
    console.warn('house view not available, using outline', err);
    return false;
  }
}

function outlineHouse() {
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HOUSE_W, HOUSE_D), new THREE.MeshStandardNodeMaterial({ color: 0x3a2e26, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(HOUSE_W / 2, 0, HOUSE_D / 2);
  floor.receiveShadow = true;
  core.houseRoot.add(floor);

  // 墙格：按左右 / 上下邻格判断走向，画成 0.2 厚、降到 WALL_CUT_H 的矮墙
  const tiles = buildTiles();
  const isWall = (i: number, j: number) => i >= 0 && j >= 0 && i < GRID_W && j < GRID_H && (tiles[idx(i, j)] === Tile.Wall || tiles[idx(i, j)] === Tile.Window);
  const walls: THREE.Matrix4[] = [];
  for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) {
    if (!isWall(i, j)) continue;
    const hz = isWall(i - 1, j) || isWall(i + 1, j);
    const vt = isWall(i, j - 1) || isWall(i, j + 1);
    const sx = hz ? CELL : 0.2, sz = vt ? CELL : 0.2;
    walls.push(new THREE.Matrix4().compose(new THREE.Vector3((i + 0.5) * CELL, WALL_CUT_H / 2, (j + 0.5) * CELL), new THREE.Quaternion(), new THREE.Vector3(sx, WALL_CUT_H, sz)));
  }
  const wm = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardNodeMaterial({ color: PALETTE.wallpaper, roughness: 0.9 }), walls.length);
  walls.forEach((m, k) => wm.setMatrixAt(k, m));
  wm.castShadow = wm.receiveShadow = true;
  core.houseRoot.add(wm);

  // 家具：灰方块，高度大致按真实（床头柜 0.55 —— 八音盒就放在它上面）。
  // 衣柜不画方块：门和门里的东西是物件自己画的，方块会把门洞堵死、和门板抢深度；看柜体用 ?house
  const HEIGHT: Record<string, number> = { bookshelf: 2, desk: 0.75, sofa: 0.8, fireplace: 1.2, counter: 0.9, table: 0.75, bed: 0.5, nightstand: 0.55, coatRack: 1.7, bathtub: 0.6, sink: 0.85 };
  const fm = new THREE.MeshStandardNodeMaterial({ color: 0x4b4540, roughness: 0.9 });
  for (const f of FURNITURE) {
    const hh = HEIGHT[f.kind];
    if (!hh) continue;
    const w = (f.rect.x1 - f.rect.x0) * CELL, d = (f.rect.z1 - f.rect.z0) * CELL;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w - 0.04, hh, d - 0.04), fm);
    m.position.set(f.rect.x0 * CELL + w / 2, hh / 2, f.rect.z0 * CELL + d / 2);
    m.castShadow = m.receiveShadow = true;
    core.houseRoot.add(m);
  }
}
if (!(await tryHouse())) outlineHouse();

// ── 假访客：橙色胶囊（看肖像的眼睛往哪看） ─────────────────────────────────
const npcMeshes = h.state.npcs.map(() => {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.7, 4, 8), new THREE.MeshStandardNodeMaterial({ color: 0xffaa33 }));
  m.castShadow = true;
  core.houseRoot.add(m);
  return m;
});
h.add({
  update({ state }: FrameCtx) {
    state.npcs.forEach((n, i) => npcMeshes[i]?.position.set(n.pos.x, 0.55, n.pos.z));
  },
});

// ── 手电：和 flashlight.ts 同一套参数（外圈宽而软、投影；亮芯窄、不投影），从卧室门口往床上照，看鼓包的明暗和影子 ──
if (qs.has('torch')) {
  const [x, z, tx, tz, ty = 0.45] = (qs.get('torch') || '2.6,7.9,1.4,9.9').split(',').map(Number);
  const target = new THREE.Object3D();
  target.position.set(tx, ty, tz);
  const halo = new THREE.SpotLight(PALETTE.torchHalo, 40, VISION.range * 1.3, VISION.halfAngle * 1.1, 1, 1.1);
  const core2 = new THREE.SpotLight(PALETTE.torchCore, 30, VISION.range * 1.3, VISION.halfAngle * 0.42, 0.8, 1.1);
  halo.castShadow = true;
  halo.shadow.mapSize.set(1024, 1024);
  halo.shadow.camera.near = 0.1;
  halo.shadow.bias = -0.0008;
  halo.shadow.normalBias = 0.03;
  for (const l of [halo, core2]) {
    l.position.set(x, 0.8, z);
    l.target = target;
    core.houseRoot.add(l);
  }
  core.houseRoot.add(target);
}

// ── 物件（带一层时间控制：可以暂停、精确快进，截图拿到确定的中间态） ─────────────
// 粒子（床塌下去、衣柜柜顶震下来的灰）在这里看不了：粒子材质要画进后处理的场景 pass（MRT），harness 直接画到画布上，会报着色器错。
// 看灰用真页面：http://127.0.0.1:端口/?debug，__haunt.trigger('bed') / __haunt.trigger('wardrobe') + __haunt.step(ms)
const props = createPropsView(core);
if (qs.get('q') === 'low') props.setQuality?.('low');
let timeScale = 1;
/** 受 timeScale 控制的时间轴：暂停时不走，advance 才走 */
let simTime = 0;
let lastCtx: FrameCtx | null = null;
const stepSim = (ctx: FrameCtx, dt: number) => {
  simTime += dt;
  props.update?.({ ...ctx, dt, time: simTime });
};
// harness 发的 trigger 事件不带 variant（模拟每次都给）：这里补上。__props.trigger(id, v) 给的优先，
// 其次是 ?fingers（有值且不是 0：强制出手指；=0：强制不出），都没有就和正式游戏一样随机
const fingersParam = qs.get('fingers');
let nextVariant: number | null = null;
const variantFor = () => {
  if (nextVariant !== null) {
    const v = nextVariant;
    nextVariant = null;
    return v;
  }
  if (fingersParam === null) return Math.random();
  return fingersParam === '0' ? 0.99 : 0;
};
h.add({
  onEvent: (e, s) => props.onEvent?.(e.type === 'trigger' && e.variant === undefined ? { ...e, variant: variantFor() } : e, s),
  update(ctx: FrameCtx) {
    lastCtx = ctx;
    stepSim(ctx, ctx.dt * timeScale);
  },
});

// ── 标记层：?overlay ─────────────────────────────────────────────────────
let overlays: ReturnType<typeof createOverlays> | null = null;
if (qs.has('overlay')) {
  await import('../src/styles.css');
  const root = document.createElement('div');
  root.id = 'overlay';
  document.body.appendChild(root);
  overlays = createOverlays(root, rig);
  h.add(overlays);
}

// ── 悬停 / 点击（简化版拾取，和任务 2 的 picker 用同一个约定：沿 parent 找 userData.propId） ──
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const canvas = core.renderer.domElement;
const pickAt = (x: number, y: number): string | null => {
  const r = canvas.getBoundingClientRect();
  ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, rig.camera);
  for (const hit of ray.intersectObjects(props.pickTargets(), true)) {
    let o: THREE.Object3D | null = hit.object;
    while (o && o.userData.propId === undefined) o = o.parent;
    if (o) return o.userData.propId as string;
  }
  return null;
};
canvas.addEventListener('pointermove', (e) => {
  const id = pickAt(e.clientX, e.clientY);
  props.setHover(id);
  overlays?.setHover(id);
  canvas.style.cursor = id ? 'pointer' : '';
});
canvas.addEventListener('click', (e) => {
  const id = pickAt(e.clientX, e.clientY);
  if (id) (window as unknown as { __harness: { trigger(id: string): boolean } }).__harness.trigger(id);
});

// ── 镜头：缩放 / 对准某个物件 ───────────────────────────────────────────
rig.zoom(Number(qs.get('zoom') ?? 1.6));
let focus: { x: number; z: number; y: number; size: number } | null = null;
/** 镜头对准物件的哪个高度（米）：八音盒在床头柜面上；衣柜 2.1 米高，对准门的中间；别的 0.8 */
const FOCUS_Y: Partial<Record<ScareType, number>> = { musicBox: 0.55, wardrobe: 1.1 };
const setFocus = (id: string | null, size = 1.2) => {
  const p = PROPS.find((x) => x.id === id);
  if (!p) { focus = null; rig.zoom(1); rig.resize(canvas.clientWidth, canvas.clientHeight); return; }
  const c = propCenter(p);
  focus = { x: c.x - HOUSE_W / 2, z: c.z - HOUSE_D / 2, y: FOCUS_Y[p.type] ?? 0.8, size };
};
if (qs.get('focus')) setFocus(qs.get('focus'), Number(qs.get('size') ?? 1.2));
const ELEV = (35 * Math.PI) / 180;
h.add({
  update() {
    if (!focus) return;
    const cam = rig.camera;
    const v = rig.viewDir;
    cam.position.set(focus.x + v.x * 30 * Math.cos(ELEV), focus.y + 30 * Math.sin(ELEV), focus.z + v.z * 30 * Math.cos(ELEV));
    cam.lookAt(focus.x, focus.y, focus.z);
    const a = canvas.clientWidth / canvas.clientHeight;
    cam.left = -focus.size * a;
    cam.right = focus.size * a;
    cam.top = focus.size;
    cam.bottom = -focus.size;
    cam.updateProjectionMatrix();
  },
});

h.start();

const advance = (s: number) => {
  // 用固定的小步长推进物件动画（不推进 harness 的假状态），截图拿到精确的时刻
  const ctx = lastCtx;
  if (!ctx) return;
  const n = Math.round(s * 120);
  for (let i = 0; i < n; i++) stepSim(ctx, 1 / 120);
};
(window as unknown as { __props: unknown }).__props = {
  view: props,
  scene: core.scene,
  state: h.state,
  ids: () => props.pickTargets().map((o) => o.userData.propId as string),
  targets: () => props.pickTargets().map((o) => ({ id: o.userData.propId, visible: o.visible, type: (o as THREE.Mesh).isMesh ? 'Mesh' : o.type })),
  hover: (id: string | null) => props.setHover(id),
  pause: () => { timeScale = 0; },
  play: () => { timeScale = 1; },
  advance,
  focus: setFocus,
  /** 镜头对准房屋坐标里任意一点看小细节（比如衣柜门边的手指）：size = 半个画面高（米） */
  look: (x: number, y: number, z: number, size = 0.4) => { focus = { x: x - HOUSE_W / 2, z: z - HOUSE_D / 2, y, size }; },
  drawCalls: () => core.renderer.info.render.drawCalls,
  /** 屏幕坐标（像素）→ 拾取到的物件 id */
  pick: pickAt,
  /** 假装设下机关：armed = 秒数（0 = 解除）；sandbox 里不会自己倒数 */
  arm: (id: string, secs = 60) => {
    const o = h.state.objects.find((x) => x.id === id);
    if (o) o.armed = secs;
    return !!o;
  },
  /** 这个物件的幽光外壳、霜外壳此刻显不显示（每个外壳一项） */
  shells: (id: string) => {
    const root = core.scene.getObjectByName(`prop:${id}`);
    const out = { glow: [] as boolean[], frost: [] as boolean[] };
    root?.traverse((o) => {
      if (o.name === 'glow-shell') out.glow.push(o.visible);
      if (o.name === 'frost-shell') out.frost.push(o.visible);
    });
    return out;
  },
  /** 房屋坐标 → 屏幕坐标（像素） */
  toScreen: (x: number, z: number, y = 0) => rig.toScreen({ x, z }, y),
  /** 附身（和按数字键一样走 harness，冷却中不会触发）；variant 给了就用它，不给按 ?fingers / 随机 */
  trigger: (id: string, variant?: number) => {
    nextVariant = variant ?? null;
    const ok = (window as unknown as { __harness: { trigger(id: string): boolean } }).__harness.trigger(id);
    if (!ok) nextVariant = null;
    return ok;
  },
};
console.log('props sandbox', core.backend);
