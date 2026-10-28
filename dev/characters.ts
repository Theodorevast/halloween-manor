// 角色与手电的开发页（harness 里两个假访客）。
// 参数（URL 查询串）：
//   ambient=1.2      环境光强度（默认 0.25 看氛围；1.2 看模型）
//   zoom=1.6         harness 镜头缩放
//   focus=0&fzoom=4  镜头跟着第 0 个访客、放大 fzoom 倍（看朝向和身高）
//   missing          把模型地址指向一个不存在的文件，验证备用小人（只在这一页覆盖，不改 config）
//   url=…&facing=…   临时换一个模型 / facingOffset 试看（换吉祥物时先在这里试）
//   visitors=4       再加两个假访客（性能测试：4 个访客、8 盏聚光、4 盏投影）
//   house=real       用任务 3 的 createHouseView（默认是这一页自带的简易房子：地板 + 墙 + 只投影的全高墙）
//   arrows           每个访客脚下画一个指向 heading 的箭头（检查模型正面是否朝前）
//   quality=low
//   probe=x,z,朝向[,手电方向]  放一个不动的访客（focus=2 跟拍它）；still 暂停两个假访客；only 去掉两个假访客（这时 focus=0 是探针）
//   torch=外圈,亮芯,衰减  bias=bias,normalBias  nobeam  noshadowwalls  shadowside=front   手电 / 阴影调参
//   fear=20,85       依次设各访客的恐惧值（只给一个数就全部设成它）：≥ 60 缩着身子走、不时回头张望，越接近 100 越明显
//   slow=0.25        角色表现层慢放（只慢角色的动画和程序化动作，假访客照常走）；0 = 定格
//   clips=待机,走,跑,受惊[,张望,害怕,逃跑,受惊2]  临时换片段名（空着的写 -）
// 按键（harness 自带的：F 让 0 号逃跑 → flee 代替 run，1 2 3 6 7 8 吓 0 号 → scared / scared2 轮流；这一页加的：4 5 0）：
//   4  察觉：0 号访客站住不动（暂停两个假访客），NpcState.notice 不为空 → look 代替 idle
//   5  紧张站着：0 号站住不动，恐惧值在紧张线以上 → afraid 代替 idle
//   0  恢复（再按一次 4 / 5 也行）。4、5 在 harness 里本来是引诱类物件（门、八音盒），这一页看不出效果，拦下来换成上面的
// 控制台：window.__chars.inspect()（含每个片段此刻的权重） / .calibrate() / .perf(秒) / .info() / .scene / .pose('notice' | 'nervous' | null)
//   .loopWindow(片段名, 最短, 最长, 从, 到)  给不是循环的片段（flee_01）找循环区间，结果写进 config 的 loops
//   .sheet(片段名, 份数, 'front' | 'side' | 'back', [起, 止]?)  把角色排成一排，各停在片段的不同时刻，看关键姿势（配合 ?only&ambient=9&house=none：这一页的半球光 1.2 看模型还是很暗，9 才看得清）
//   .startle(序号, amount, 物件id?)  按指定的恐惧增量吓一下（amount 约 5–72，决定跳多高；给物件就在空中扭向它）
//   .fear(序号, 值)  设恐惧值；.slow(倍率)  慢放 / 定格；.freezeAfter(秒)  过这么多秒（角色表现层的时间）后定格，截跳到最高点用
//   .screenOf(序号)  访客在画布上的像素位置（focus 跟拍时不准）
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER, VISITOR_SPECS } from '../src/config/character';
import { FEAR } from '../src/config/visitors';
import { CELL, GRID_H, GRID_W, HOUSE_D, HOUSE_W, Tile, WALL_CUT_H, WALL_H, buildTiles, cellCenter, idx } from '../src/config/house';
import type { Module, RenderCore, CameraRig } from '../src/engine/types';
import type { NpcState } from '../src/sim/types';
import { angleOf } from '../src/lib/angle';
import { createCharactersView, loadCharacterAsset } from '../src/view/characters';
import { TORCH } from '../src/view/flashlight';
import { PALETTE } from '../src/view/palette';
import { createHarness } from './harness';

const q = new URLSearchParams(location.search);
if (q.has('missing')) CHARACTER.url = `${import.meta.env.BASE_URL}assets/mascot/__missing__.glb`;
// 这一页只看一套造型：默认是 CHARACTER（占位狐狸）；?visitor=<id> 用 VISITOR_SPECS 里那一套（连同它的朝向、速率），
// ?url= 换成任意 GLB（其余参数照 CHARACTER）。游戏里 VISITOR_SPECS 有几套就轮流出场，这里不轮
const picked = q.get('visitor') ? VISITOR_SPECS.find((v) => v.url.includes(`/${q.get('visitor')}.glb`)) : undefined;
if (picked) Object.assign(CHARACTER, picked);
VISITOR_SPECS.length = 0;
if (q.get('url')) CHARACTER.url = q.get('url')!;
if (q.get('facing')) CHARACTER.facingOffset = Number(q.get('facing'));
// clips=待机,走,跑,受惊[,张望,害怕,逃跑,受惊2]（片段名照 GLB 里的原样写，空着的写 -）：试新模型时不用先改 config/character.ts
if (q.get('clips')) {
  const [idle, walk, run, scared, look, afraid, flee, scared2] = q.get('clips')!.split(',').map((s) => (s && s !== '-' ? s : null));
  CHARACTER.clips = { idle: idle ?? null, walk: walk ?? null, run: run ?? null, scared: scared ?? null, look: look ?? null, afraid: afraid ?? null, flee: flee ?? null, scared2: scared2 ?? null };
}

// 手电调参：torch=外圈亮度,亮芯亮度,衰减指数  bias=bias,normalBias(high)
if (q.get('torch')) {
  const [hi, ci, dc] = q.get('torch')!.split(',').map(Number);
  TORCH.halo.intensity = hi;
  if (ci) TORCH.core.intensity = ci;
  if (dc !== undefined && !Number.isNaN(dc)) TORCH.decay = dc;
}
if (q.get('bias')) {
  const [b, nb] = q.get('bias')!.split(',').map(Number);
  TORCH.shadow.bias = b;
  if (nb !== undefined) TORCH.shadow.normalBias.high = nb;
}
if (q.has('nobeam')) TORCH.beam.opacity = 0;

const h = await createHarness({ ambient: Number(q.get('ambient') ?? 0.25) });
if (q.get('zoom')) h.rig.zoom(Number(q.get('zoom')));
if (q.get('quality') === 'low') h.core.setQuality('low');

// —— 房子：默认用简易版（不依赖任务 3 的进度），house=real 时用正式的 ——
function simpleHouse(core: RenderCore) {
  const root = core.houseRoot;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(HOUSE_W, HOUSE_D), new THREE.MeshStandardMaterial({ color: PALETTE.wood, roughness: 0.8 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(HOUSE_W / 2, 0, HOUSE_D / 2);
  floor.receiveShadow = true;
  root.add(floor);
  const tiles = buildTiles();
  const cells: [number, number][] = [];
  for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) {
    const t = tiles[idx(i, j)];
    if (t === Tile.Wall || t === Tile.Window) cells.push([i, j]);
  }
  const box = new THREE.BoxGeometry(CELL, 1, CELL);
  const wallMat = new THREE.MeshStandardMaterial({ color: PALETTE.wallpaper, roughness: 0.9 });
  const m = new THREE.Matrix4();
  const put = (mesh: THREE.InstancedMesh, k: number, i: number, j: number, hgt: number) => {
    const c = cellCenter(i, j);
    m.makeScale(1, hgt, 1).setPosition(c.x, hgt / 2, c.z);
    mesh.setMatrixAt(k, m);
  };
  // 看得见的墙：镜头在东南（quarter 0），北墙和西墙全高，其余降到 WALL_CUT_H
  const vis = new THREE.InstancedMesh(box, wallMat, cells.length);
  cells.forEach(([i, j], k) => put(vis, k, i, j, i === 0 || j === 0 ? WALL_H : WALL_CUT_H));
  vis.receiveShadow = true;
  // 只投影的全高墙：layer 1，主相机看不见，手电的阴影相机看得见（flashlight.ts 里 layers.enable(1)）
  // shadowside=front：只投影的墙用正面写阴影图（three.js 默认用背面；逐格的盒子之间有内侧面，掠射时会出锯齿）
  const shadowMat = wallMat.clone();
  if (q.get('shadowside') === 'front') shadowMat.shadowSide = THREE.FrontSide;
  const shadowOnly = new THREE.InstancedMesh(box, shadowMat, cells.length);
  cells.forEach(([i, j], k) => put(shadowOnly, k, i, j, WALL_H));
  shadowOnly.castShadow = true;
  shadowOnly.layers.set(1);
  shadowOnly.visible = !q.has('noshadowwalls');
  // 走廊里两个箱子，看手电投下的影子
  const crateMat = new THREE.MeshStandardMaterial({ color: PALETTE.woodDark, roughness: 0.8 });
  for (const [x, z, s] of [[10.6, 5.4, 0.5], [5.2, 6.6, 0.4]] as const) {
    const c = new THREE.Mesh(new THREE.BoxGeometry(s, s * 1.6, s), crateMat);
    c.position.set(x, s * 0.8, z);
    c.castShadow = c.receiveShadow = true;
    root.add(c);
  }
  root.add(vis, shadowOnly);
}
if (q.get('house') === 'real') {
  try {
    const path = '/src/view/house.ts'; // 用变量：任务 3 没写完时这一页照样能编译
    const mod = (await import(/* @vite-ignore */ path)) as { createHouseView(core: RenderCore, rig: CameraRig): Module };
    h.add(mod.createHouseView(h.core, h.rig));
    // shadowside=front：只在这一页把任务 3 的只投影墙改成正面写阴影图，验证锯齿是不是内侧面造成的
    if (q.get('shadowside') === 'front') {
      h.core.houseRoot.traverse((o) => {
        if (o.name === 'walls-shadow-only') ((o as THREE.Mesh).material as THREE.Material).shadowSide = THREE.FrontSide;
      });
    }
  } catch (e) {
    console.warn('house=real：任务 3 的 house.ts 还用不了，换回简易房子', e);
    simpleHouse(h.core);
  }
} else if (q.get('house') !== 'none') simpleHouse(h.core);

// —— 再加两个假访客（性能测试）：一个在卧室绕圈，一个在厨房绕圈 ——
if (Number(q.get('visitors') ?? 2) >= 4) {
  const extra = (id: number, name: string, cx: number, cz: number, r: number): NpcState => ({
    id, name, personality: 'average', pos: { x: cx + r, z: cz }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 10, nervous: false, speed: 1.2, screaming: 0, path: [],
  });
  const loops = [{ n: extra(3, 'June', 2.8, 9.6, 1.3), cx: 2.8, cz: 9.6, r: 1.3, w: 0.8 }, { n: extra(4, 'Leo', 13.2, 2.6, 1.2), cx: 13.2, cz: 2.6, r: 1.2, w: -0.9 }];
  for (const l of loops) h.state.npcs.push(l.n);
  h.add({
    update({ state }) {
      for (const l of loops) {
        const a = state.time * l.w;
        const prev = { ...l.n.pos };
        l.n.pos = { x: l.cx + Math.cos(a) * l.r, z: l.cz + Math.sin(a) * l.r };
        l.n.heading = angleOf(l.n.pos.x - prev.x, l.n.pos.z - prev.z);
        l.n.lookDir = l.n.heading;
        l.n.speed = Math.abs(l.w) * l.r;
      }
    },
  });
}

// —— 静止的探针访客：probe=x,z,方向角（看手电打在墙上、地上的样子；focus 用它的序号）——
if (q.get('probe')) {
  const [x, z, d, look] = q.get('probe')!.split(',').map(Number);
  h.state.npcs.push({ id: 9, name: 'Probe', personality: 'average', pos: { x, z }, heading: d, lookDir: look ?? d, mode: 'wander', modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [] });
}
if (q.has('only')) h.state.npcs.splice(0, 2); // 只留探针（和 visitors=4 加的人）
if (q.has('still')) dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })); // harness：空格暂停假访客

// —— 恐惧值：fear=20,85（harness 不会回落恐惧值，设了就一直是这个数）——
const setFear = (i: number, f: number) => {
  const n = h.state.npcs[i];
  if (!n) return;
  n.fear = Math.max(0, Math.min(FEAR.max, f));
  n.nervous = n.fear >= FEAR.nervous;
};
if (q.get('fear')) {
  const fs = q.get('fear')!.split(',').map(Number);
  h.state.npcs.forEach((_, i) => setFear(i, fs[Math.min(i, fs.length - 1)]));
}

const view = await createCharactersView(h.core);
if (h.core.quality === 'low') view.setQuality?.('low');

// —— 角色表现层套一层时间缩放：slow 慢放、0 定格（假访客的移动不受影响）——
let slow = Number(q.get('slow') ?? 1);
let viewTime = 0;
let realTime = 0;
let freezeIn = -1;
/** startle() 吓的人：到点（真实时间）把受惊状态改回闲逛（harness 只管 0 号，而且暂停时也不管） */
const startledUntil = new Map<number, number>();
h.add({
  update(ctx) {
    realTime = ctx.time;
    let dt = ctx.dt * slow;
    if (freezeIn >= 0 && (freezeIn -= dt) <= 0) {
      dt += freezeIn; // 正好停在 freezeAfter 的那一刻
      freezeIn = -1;
      slow = 0;
    }
    viewTime += dt;
    for (const n of ctx.state.npcs) {
      const until = startledUntil.get(n.id);
      if (until === undefined || ctx.time < until) continue;
      startledUntil.delete(n.id);
      if (n.mode === 'startled') n.mode = 'wander';
    }
    view.update?.({ ...ctx, dt, time: viewTime });
  },
  onEvent: (e, state) => view.onEvent?.(e, state),
  setQuality: (ql) => view.setQuality?.(ql),
});

/** 按指定的恐惧增量吓第 i 个访客（不经过 harness 的 trigger：那个只吓 0 号、amount 固定是物件的基础值） */
function startle(i: number, amount: number, objectId: string | null = null) {
  const n = h.state.npcs[i];
  if (!n) return false;
  setFear(i, n.fear + amount);
  n.mode = 'startled';
  n.modeTime = 0;
  const o = objectId ? h.state.objects.find((x) => x.id === objectId) : undefined;
  if (o) n.lookDir = angleOf(o.pos.x - n.pos.x, o.pos.z - n.pos.z); // 和模拟一样：手电一下子定在吓到它的东西上
  h.emit({ type: 'startle', npc: n.id, object: o ? o.id : null, amount, scream: amount >= FEAR.screamAt });
  // object 为 null 时表现层不跳（模拟里那是被别人的尖叫吓到），这里也就不进受惊状态
  if (!o) n.mode = 'wander';
  else startledUntil.set(n.id, realTime + FEAR.startleTime / Math.max(0.05, slow));
  return true;
}

// —— 键 4 / 5 / 0：0 号访客站住不动，摆出「察觉」或「紧张站着」，看 look / afraid 代替 idle ——
// 站住靠暂停两个假访客（harness 的空格键是翻转开关，所以自己记着现在暂停了没有）。
// 是不是进了 look / afraid 看 __chars.inspect() 的 weights
type Forced = 'notice' | 'nervous' | null;
let forced: Forced = null;
let fakesPaused = q.has('still');
let pausedByPose = false;
const toggleFakes = () => dispatchEvent(new KeyboardEvent('keydown', { key: ' ' })); // 下面的捕获监听会把 fakesPaused 翻过来
addEventListener('keydown', (e) => { if (e.key === ' ') fakesPaused = !fakesPaused; }, true);
function pose(kind: Forced) {
  const n = h.state.npcs[0];
  if (!n) return;
  if (kind && !fakesPaused) {
    toggleFakes();
    pausedByPose = true;
  } else if (!kind && pausedByPose && fakesPaused) {
    toggleFakes();
    pausedByPose = false;
  }
  forced = kind;
  n.mode = 'wander';
  n.modeTime = 0;
  n.screaming = 0;
  n.lookDir = n.heading;
  if (kind) n.speed = 0;
  // 察觉：来源在身体前方 2 米；盯着看的时间写得很长（这里不推进察觉的计时）
  n.notice = kind === 'notice' ? { kind: 'sound', src: { x: n.pos.x + Math.cos(n.heading) * 2, z: n.pos.z + Math.sin(n.heading) * 2 }, t: 0.3, hold: 99 } : null;
  setFear(0, kind === 'nervous' ? 85 : 20);
}
addEventListener('keydown', (e) => {
  const kind = e.key === '4' ? 'notice' : e.key === '5' ? 'nervous' : null;
  if (kind) {
    e.stopImmediatePropagation(); // harness 的 4 / 5 是引诱类物件（门、八音盒），这一页看不出效果
    pose(forced === kind ? null : kind);
  } else if (e.key === '0') pose(null);
}, true);

// —— 脚下的朝向箭头 ——
if (q.has('arrows')) {
  const geo = new THREE.ConeGeometry(0.08, 0.5, 3);
  geo.rotateX(Math.PI / 2); // 尖朝 +z
  geo.translate(0, 0.03, 0.55);
  const mat = new THREE.MeshBasicMaterial({ color: 0x66ff99 });
  const arrows = new Map<number, THREE.Mesh>();
  h.add({
    update({ state }) {
      for (const n of state.npcs) {
        let a = arrows.get(n.id);
        if (!a) h.core.houseRoot.add((a = new THREE.Mesh(geo, mat)));
        arrows.set(n.id, a);
        a.position.set(n.pos.x, 0, n.pos.z);
        a.rotation.y = Math.PI / 2 - n.heading; // yawFor
      }
    },
  });
}

// —— 镜头跟拍某个访客 ——
const focus = q.get('focus');
if (focus !== null) {
  const fz = Number(q.get('fzoom') ?? 4);
  const cam = h.rig.camera;
  const E = (35 * Math.PI) / 180;
  h.add({
    update({ state }) {
      const n = state.npcs[Number(focus)];
      if (!n) return;
      const t = new THREE.Vector3(n.pos.x - HOUSE_W / 2, 0.55, n.pos.z - HOUSE_D / 2);
      const vd = h.rig.viewDir;
      cam.position.set(t.x + vd.x * 30 * Math.cos(E), t.y + 30 * Math.sin(E), t.z + vd.z * 30 * Math.cos(E));
      cam.lookAt(t);
      const half = 7.2 / fz, aspect = innerWidth / innerHeight;
      cam.left = -half * aspect;
      cam.right = half * aspect;
      cam.top = half;
      cam.bottom = -half;
      cam.updateProjectionMatrix();
    },
  });
}

// —— 每帧的 draw call / 三角形（含阴影图）——
const renderer = h.core.renderer;
renderer.info.autoReset = false;
let lastInfo = { drawCalls: 0, triangles: 0 };
h.add({
  update() {
    lastInfo = { drawCalls: renderer.info.render.drawCalls, triangles: renderer.info.render.triangles };
    renderer.info.reset();
  },
});

/** 从走路 / 跑步片段反推「脚不打滑」的播放速率和模型的正面朝向 */
async function calibrate() {
  const asset = await loadCharacterAsset(CHARACTER);
  const H = asset.height; // 归一化后的实际身高（身长超过 maxLength 时比 targetHeight 矮）
  const out: Record<string, unknown> = {
    url: CHARACTER.url, triangles: asset.triangles, rawSize: asset.rawSize.toArray().map((v) => +v.toFixed(2)), scale: +asset.scale.toPrecision(3),
    front: +asset.front.toFixed(3), clips: asset.clips.map((c) => `${c.name} ${c.duration.toFixed(2)}s`), facingOffset: CHARACTER.facingOffset,
  };
  // walk / run / flee：脚不打滑的播放速率（flee 是逃跑时代替 run 的片段，步频和 run 不一样，要单独量）
  for (const role of ['walk', 'run', 'flee'] as const) {
    const name = CHARACTER.clips[role];
    const clip = name ? THREE.AnimationClip.findByName(asset.clips, name) : null;
    if (!clip) {
      out[role] = '没有这个片段';
      continue;
    }
    const model = SkeletonUtils.clone(asset.template);
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(clip).play();
    const bones: THREE.Object3D[] = [];
    model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o); });
    // 有循环区间的片段（config 的 loops）只量这一段：整段里站着的部分会把脚「着地」的判断搅乱
    const [t0, t1] = CHARACTER.loops?.[role] ?? [0, clip.duration];
    const N = 240, dt = (t1 - t0) / N;
    const tracks = bones.map(() => [] as THREE.Vector3[]);
    for (let i = 0; i <= N; i++) {
      mixer.setTime(t0 + i * dt);
      model.updateMatrixWorld(true);
      bones.forEach((b, k) => tracks[k].push(b.getWorldPosition(new THREE.Vector3())));
    }
    // 着地的脚：整段里最低点贴近地面的骨骼；它贴地的那些帧里，相对身体往后滑的速度 = 身体应有的前进速度。
    // 先找最低点在身高 12% 以下的骨骼；找不到再放宽到 25%（Tripo 给骷髅绑骨时踝骨放在鞋子中间，离地约 20%，2026-10-28）
    const vel: THREE.Vector2[] = [];
    const feet: string[] = [];
    for (const limit of [0.12, 0.25]) {
      tracks.forEach((tr, k) => {
        const minY = Math.min(...tr.map((p) => p.y));
        if (minY > limit * H) return;
        // 根骨骼之类贴地但不动的骨骼不算脚
        const xs = tr.map((p) => p.x), zs = tr.map((p) => p.z);
        if (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) < 0.05 * H) return;
        feet.push(bones[k].name);
        for (let i = 0; i < N; i++) {
          if (tr[i].y > minY + 0.03 * H) continue;
          vel.push(new THREE.Vector2((tr[i + 1].x - tr[i].x) / dt, (tr[i + 1].z - tr[i].z) / dt));
        }
      });
      if (vel.length) break;
    }
    if (!vel.length) {
      out[role] = '找不到贴地的骨骼（片段可能不是原地走）';
      continue;
    }
    const mean = vel.reduce((a, b) => a.add(b), new THREE.Vector2()).divideScalar(vel.length);
    const dir = mean.clone().normalize();
    const along = vel.map((v) => v.dot(dir)).sort((a, b) => a - b); // 脚往后滑的速度（正数）
    const median = along[Math.floor(along.length / 2)];
    // 模型（已经按 facingOffset 转过）的前进方向 = 脚往后滑的反方向；不朝 +z 就说明 facingOffset 要改
    const fwd = { x: -dir.x, z: -dir.y };
    const err = Math.atan2(fwd.x, fwd.z);
    const root = tracks[0];
    const drift = Math.hypot(root[N].x - root[0].x, root[N].z - root[0].z);
    out[role] = {
      clip: clip.name, duration: +clip.duration.toFixed(3), window: [+t0.toFixed(3), +t1.toFixed(3)], feet: feet.slice(0, 6), stanceSamples: vel.length,
      speedAtRate1: +median.toFixed(3), suggestedRateAt1ms: +(1 / median).toFixed(3),
      forwardInTemplate: { x: +fwd.x.toFixed(2), z: +fwd.z.toFixed(2) }, suggestedFacingOffset: +(CHARACTER.facingOffset + err).toFixed(3),
      rootDrift: +drift.toFixed(3), rootMotion: drift > 0.05 * H,
    };
  }
  // 全部片段的根漂移（原地检查，在游戏的坐标里量）：胯骨首尾帧的水平位移，超过身高的 5% 就是带位移。
  // 流水线的 --inspect 也粗查过一遍；这里是在角色摆正、缩放之后真的量一次
  const drift: Record<string, number> = {};
  for (const clip of asset.clips) {
    const model = SkeletonUtils.clone(asset.template);
    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(clip).play();
    const bones: THREE.Object3D[] = [];
    model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o); });
    const hips = bones.find((b) => /hips/i.test(b.name)) ?? bones[0];
    if (!hips) continue;
    const at = (t: number) => {
      mixer.setTime(t);
      model.updateMatrixWorld(true);
      return hips.getWorldPosition(new THREE.Vector3());
    };
    const a = at(0), b = at(clip.duration);
    drift[clip.name] = +Math.hypot(b.x - a.x, b.z - a.z).toFixed(3);
  }
  out.clipDrift = drift;
  out.clipsWithRootMotion = Object.entries(drift).filter(([, d]) => d > 0.05 * H).map(([n]) => n);
  console.log('[calibrate]', JSON.stringify(out, null, 1));
  return out;
}

/**
 * 给不是循环的片段找循环区间（config 的 CharacterSpec.loops）：在 [from, to] 秒里找「起点和止点姿势最接近、前后 0.1 秒的变化也一致」的一段，
 * 长度在 [minLen, maxLen] 秒，返回最好的 5 段。姿势差 = 每根骨头局部旋转差的平均（弧度）+ 胯位移差（模型单位）× 2；
 * 首尾直接差（direct）比相邻两帧的平均差（step）小，接缝处就不会跳。按 30 帧/秒取样，起止点写成「帧 / 30」
 */
async function loopWindow(name: string, minLen = 0.5, maxLen = 1.4, from = 0, to?: number) {
  const asset = await loadCharacterAsset(CHARACTER);
  const clip = THREE.AnimationClip.findByName(asset.clips, name);
  if (!clip) return `没有片段 ${name}（有：${asset.clips.map((c) => c.name).join('、')}）`;
  const model = SkeletonUtils.clone(asset.template);
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const bones: THREE.Bone[] = [];
  model.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone); });
  const hips = bones.find((b) => /hips/i.test(b.name)) ?? bones[0];
  const FPS = 30, N = Math.round(clip.duration * FPS);
  const poses: { q: THREE.Quaternion[]; p: THREE.Vector3 }[] = [];
  for (let i = 0; i <= N; i++) {
    mixer.setTime(i / FPS);
    poses.push({ q: bones.map((b) => b.quaternion.clone()), p: hips.position.clone() });
  }
  const diff = (a: number, b: number) => {
    let sum = 0;
    for (let k = 0; k < bones.length; k++) sum += poses[a].q[k].angleTo(poses[b].q[k]);
    return sum / bones.length + poses[a].p.distanceTo(poses[b].p) * 2;
  };
  let step = 0;
  for (let i = 1; i <= N; i++) step += diff(i - 1, i) / N;
  const near = 3; // 前后各 3 帧（0.1 秒）一起对
  const f0min = Math.max(near, Math.round(from * FPS)), f1max = Math.min(N - near, Math.round((to ?? clip.duration) * FPS));
  const found: { f0: number; f1: number; cost: number }[] = [];
  for (let f0 = f0min; f0 < f1max; f0++) {
    for (let f1 = f0 + Math.round(minLen * FPS); f1 <= Math.min(f1max, f0 + Math.round(maxLen * FPS)); f1++) {
      found.push({ f0, f1, cost: diff(f0, f1) + 0.5 * (diff(f0 - near, f1 - near) + diff(f0 + near, f1 + near)) });
    }
  }
  found.sort((a, b) => a.cost - b.cost);
  const best: typeof found = [];
  for (const r of found) {
    if (best.some((b) => Math.abs(b.f0 - r.f0) < 4 && Math.abs(b.f1 - r.f1) < 4)) continue; // 挨得很近的算同一个
    best.push(r);
    if (best.length >= 5) break;
  }
  return {
    clip: clip.name, duration: +clip.duration.toFixed(3), step: +step.toFixed(4),
    windows: best.map((r) => ({ frames: [r.f0, r.f1], seconds: [+(r.f0 / FPS).toFixed(3), +(r.f1 / FPS).toFixed(3)], len: +((r.f1 - r.f0) / FPS).toFixed(2), cost: +r.cost.toFixed(3), direct: +diff(r.f0, r.f1).toFixed(4) })),
  };
}

/**
 * 看一个片段的关键姿势：把角色复制 count 份排成一排（和镜头的左右方向平行），各自停在片段的不同时刻（从头到尾均匀分开，不含终点），
 * 镜头对准这一排，脚下铺一块浅灰的地。view：front 正面朝镜头 / side 侧面 / back 背面；range：只看 [起, 止] 秒这一段。再调一次 sheet() 不带参数收起来。
 * 配合 ?only&ambient=9&house=none 用（去掉假访客和房子，半球光开到 9 才看得清）。例：await __chars.sheet('flee_01', 8, 'side', [1.033, 1.733])
 */
let sheetRoot: THREE.Group | null = null;
async function sheet(name?: string, count = 8, view: 'front' | 'side' | 'back' = 'front', range?: [number, number]) {
  if (sheetRoot) {
    h.core.scene.remove(sheetRoot);
    sheetRoot = null;
  }
  if (!name) return 'closed';
  const asset = await loadCharacterAsset(CHARACTER);
  const clip = THREE.AnimationClip.findByName(asset.clips, name);
  if (!clip) return `没有片段 ${name}（有：${asset.clips.map((c) => c.name).join('、')}）`;
  const gap = 1.1;
  const [t0, t1] = range ?? [0, clip.duration]; // range：只看片段里的一段（比如循环区间）
  // 镜头的右手方向（水平）：排成一排的方向；朝镜头 = 反着镜头看的方向
  const vd = h.rig.viewDir;
  const right = new THREE.Vector3(vd.z, 0, -vd.x).normalize();
  const yaw = Math.atan2(vd.x, vd.z) + (view === 'front' ? 0 : view === 'back' ? Math.PI : Math.PI / 2); // side：脸朝屏幕右边
  const root = new THREE.Group();
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  root.add(ground);
  for (let i = 0; i < count; i++) {
    const m = SkeletonUtils.clone(asset.template);
    const mixer = new THREE.AnimationMixer(m);
    mixer.clipAction(clip).play();
    mixer.setTime(t0 + ((t1 - t0) * i) / count);
    const w = new THREE.Group();
    w.add(m);
    w.rotation.y = yaw;
    w.position.copy(right).multiplyScalar((i - (count - 1) / 2) * gap);
    root.add(w);
  }
  h.core.scene.add(root);
  sheetRoot = root;
  const cam = h.rig.camera;
  const E = (35 * Math.PI) / 180;
  const t = new THREE.Vector3(0, 0.5, 0);
  cam.position.set(t.x + vd.x * 30 * Math.cos(E), t.y + 30 * Math.sin(E), t.z + vd.z * 30 * Math.cos(E));
  cam.lookAt(t);
  const aspect = innerWidth / innerHeight;
  const half = Math.max(0.95, (count * gap * 0.5 + 0.3) / aspect);
  cam.left = -half * aspect;
  cam.right = half * aspect;
  cam.top = half;
  cam.bottom = -half;
  cam.updateProjectionMatrix();
  return `${clip.name} ${t0.toFixed(2)}–${t1.toFixed(2)}s（片段共 ${clip.duration.toFixed(2)}s）：${count} 份，每份间隔 ${((t1 - t0) / count).toFixed(2)}s`;
}

async function perf(seconds = 3) {
  const dts: number[] = [];
  let last = performance.now();
  await new Promise<void>((res) => {
    const f = () => {
      const t = performance.now();
      dts.push(t - last);
      last = t;
      if (dts.reduce((a, b) => a + b, 0) < seconds * 1000) requestAnimationFrame(f);
      else res();
    };
    requestAnimationFrame(f);
  });
  dts.shift();
  const sorted = [...dts].sort((a, b) => a - b);
  return {
    backend: h.core.backend, quality: h.core.quality, visitors: h.state.npcs.length, frames: dts.length,
    avgMs: +(dts.reduce((a, b) => a + b, 0) / dts.length).toFixed(2), p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), ...lastInfo,
  };
}

(window as unknown as { __chars: unknown }).__chars = {
  view, inspect: () => view.inspect(), calibrate, perf, info: () => lastInfo, source: view.source, scene: h.core.scene,
  startle, fear: setFear, pose, sheet, loopWindow,
  /** 第 i 个访客腰部（离地 0.5 米）在画布上的像素位置：截图时裁剪跟着人走 */
  screenOf(i: number) {
    const n = h.state.npcs[i];
    return n ? h.rig.toScreen(n.pos, 0.5) : null;
  },
  slow(n: number) {
    slow = Math.max(0, n);
    freezeIn = -1;
  },
  freezeAfter(sec: number) {
    if (slow === 0) slow = 1;
    freezeIn = Math.max(1e-4, sec);
  },
};
h.start();
console.log('backend', h.core.backend, '· 角色来源', view.source);
