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
// 控制台：window.__chars.inspect() / .calibrate() / .perf(秒) / .info() / .scene
//   .startle(序号, amount, 物件id?)  按指定的恐惧增量吓一下（amount 约 5–72，决定跳多高；给物件就在空中扭向它）
//   .fear(序号, 值)  设恐惧值；.slow(倍率)  慢放 / 定格；.freezeAfter(秒)  过这么多秒（角色表现层的时间）后定格，截跳到最高点用
//   .screenOf(序号)  访客在画布上的像素位置（focus 跟拍时不准）
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CHARACTER } from '../src/config/character';
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
if (q.get('url')) CHARACTER.url = q.get('url')!;
if (q.get('facing')) CHARACTER.facingOffset = Number(q.get('facing'));

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
  for (const role of ['walk', 'run'] as const) {
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
    const N = 240, dt = clip.duration / N;
    const tracks = bones.map(() => [] as THREE.Vector3[]);
    for (let i = 0; i <= N; i++) {
      mixer.setTime(i * dt);
      model.updateMatrixWorld(true);
      bones.forEach((b, k) => tracks[k].push(b.getWorldPosition(new THREE.Vector3())));
    }
    // 着地的脚：整段里最低点贴近地面的骨骼；它贴地的那些帧里，相对身体往后滑的速度 = 身体应有的前进速度
    const vel: THREE.Vector2[] = [];
    const feet: string[] = [];
    tracks.forEach((tr, k) => {
      const minY = Math.min(...tr.map((p) => p.y));
      if (minY > 0.12 * H) return;
      // 根骨骼之类贴地但不动的骨骼不算脚
      const xs = tr.map((p) => p.x), zs = tr.map((p) => p.z);
      if (Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) < 0.05 * H) return;
      feet.push(bones[k].name);
      for (let i = 0; i < N; i++) {
        if (tr[i].y > minY + 0.03 * H) continue;
        vel.push(new THREE.Vector2((tr[i + 1].x - tr[i].x) / dt, (tr[i + 1].z - tr[i].z) / dt));
      }
    });
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
      clip: clip.name, duration: +clip.duration.toFixed(3), feet: feet.slice(0, 6), stanceSamples: vel.length,
      speedAtRate1: +median.toFixed(3), suggestedRateAt1ms: +(1 / median).toFixed(3),
      forwardInTemplate: { x: +fwd.x.toFixed(2), z: +fwd.z.toFixed(2) }, suggestedFacingOffset: +(CHARACTER.facingOffset + err).toFixed(3),
      rootDrift: +drift.toFixed(3), rootMotion: drift > 0.05 * H,
    };
  }
  console.log('[calibrate]', JSON.stringify(out, null, 1));
  return out;
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
  startle, fear: setFear,
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
