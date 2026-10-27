// 房子：地板、墙（walls.ts）、家具（furniture.ts）、月光、屋外。全部挂在 core.houseRoot 下，局部坐标 = config/house.ts 的米坐标。
// 主相机画的网格：地板 2（木 / 砖）+ 墙 1 + 玻璃 1 + 月光光斑 1 + 家具 1 + 屋外地面 1 + 屋外石头和灯柱 1 + 灯罩 1 = 9；
// 每个投影灯的阴影 pass 再画 2 个（layer 1 的全高墙和屋顶、家具）。
// 只投影的全高墙在 layer 1：任何要被墙挡住的投影灯都要 shadow.camera.layers.enable(1)（不能用 set(1)，那样会丢掉 layer 0）。
//
// 第三人称模式（rig 是 GhostRig，2026-10-28 改版）：墙全高、不降；多一块天花板（+1 个网格）；月光方向固定；
// 墙、玻璃、家具、天花板在鬼魂周围和「镜头 → 鬼魂」视线上溶开、洞边结霜，鬼魂附近的表面带一点冷光（walls.ts 的 DISSOLVE）。
// 每帧把鬼魂和镜头的位置写进 uniform，不重建材质。墙和家具各有挖洞 / 不挖洞两份网格（同一份几何体），
// 每帧按 HOLE_TEST 只显示一份：附近不会有洞时不带 discard，开销和没有溶解时一样。
// ?noghostfx 关掉溶解和冷光（量开销的对照），?noceiling 不要天花板。
// 开销（2026-10-28，RTX 5070 Ti，WebGPU，High，1280×800，4 个访客冻结在原地；和「没有鬼魂效果、没有天花板」比）：
// 走廊中间 +4.1%，鬼魂在墙里（整片墙挖洞）+7.0%，天花板本身约 +1%（见 .logs/ghost-perf.mjs）
import * as THREE from 'three/webgpu';
import {
  abs, attribute, float, floor, fract, fwidth, hash, length, max, min, mix, mod, mx_noise_float, positionLocal,
  select, sin, smoothstep, uniform, uv, vec2, vec3,
} from 'three/tsl';
import {
  CELL, DOORWAYS, FRONT_DOOR, HOUSE_D, HOUSE_W, ROOMS, WALL_H, WALL_T, buildTiles, roomAt, type Rect, type RoomId,
} from '../config/house';
import { isGhostRig, type CameraRig, type FrameCtx, type Module, type Quality, type RenderCore } from '../engine/types';
import type { Vec2 } from '../sim/types';
import { createFurniture } from './furniture';
import { PALETTE } from './palette';
import {
  GeoBuilder, HEAD_H, OUTWARD, SILL_H, Side, TRANSOM_Y, applyDissolve, createWalls, ghostDissolve, ghostGlowAt, holeBoxes, holesNear, v3,
  writeDissolve, type DissolveUniforms, type V3, type WindowRun,
} from './walls';

/** 墙体之外、墙格之内的那一条（地板伸进墙格这么多，正好接到墙面） */
const M = (CELL - WALL_T) / 2;

/** 月光：仰角、相对「从远墙照向镜头」偏转的方位角、强度 */
const MOON = {
  elevation: (38 * Math.PI) / 180,
  yawOffset: (12 * Math.PI) / 180,
  intensity: 2.6,
  /** low 档没有阴影，整屋都被照到，强度要压低 */
  intensityLow: 0.9,
  hemi: 0.55,
  /** 窗下光斑的亮度（high 档有真阴影，光斑淡一些） */
  patch: 0.4,
  patchLow: 0.7,
};

/**
 * 门廊灯：前门东侧的灯柱。不投影，所以光会穿过南墙照到门厅里一点点；
 * 作用距离压短（2.4 米），漏进屋的只有墙根一小片，台阶和门口的小路照得到
 */
const PORCH = { pos: { x: 9.55, y: 1.35, z: 12.6 }, intensity: 1.8, distance: 2.4 };

const C = (hex: number) => new THREE.Color(hex);
const mixC = (a: number, b: number, t: number) => C(a).lerp(C(b), t);

// ───────────────────────── 地板 ─────────────────────────

type FloorStyle =
  | { kind: 'wood'; tint: THREE.Color; dir: 0 | 1; plank: number }
  | { kind: 'tile'; tint: THREE.Color; size: number; checker: boolean };

const FLOOR: Record<RoomId, FloorStyle> = {
  study: { kind: 'wood', tint: mixC(PALETTE.wood, PALETTE.woodDark, 0.35), dir: 0, plank: 0.16 },
  living: { kind: 'wood', tint: C(PALETTE.wood), dir: 1, plank: 0.2 },
  kitchen: { kind: 'tile', tint: C(PALETTE.tile).multiplyScalar(0.85), size: 0.3, checker: true },
  hall: { kind: 'wood', tint: mixC(PALETTE.wood, PALETTE.woodDark, 0.15), dir: 0, plank: 0.18 },
  bedroom: { kind: 'wood', tint: mixC(PALETTE.wood, PALETTE.fabric, 0.2), dir: 1, plank: 0.16 },
  foyer: { kind: 'wood', tint: mixC(PALETTE.woodDark, PALETTE.wood, 0.55), dir: 1, plank: 0.24 },
  bathroom: { kind: 'tile', tint: mixC(PALETTE.tile, PALETTE.moon, 0.25).multiplyScalar(0.75), size: 0.2, checker: false },
};

/** 房间地板的米坐标范围：向四周伸进墙格 M，正好接到墙面 */
const floorRect = (r: Rect) => ({ x0: r.x0 * CELL - M, z0: r.z0 * CELL - M, x1: r.x1 * CELL + M, z1: r.z1 * CELL + M });

/** glow 不为空（第三人称模式）：鬼魂身上的冷光照到地板上（walls.ts 的 GHOST_GLOW） */
function buildFloors(glow?: DissolveUniforms) {
  const wood = new GeoBuilder({ plank: 3 });
  const tile = new GeoBuilder({ tile: 2 });
  const up: V3 = [0, 1, 0];
  const quad = (b: GeoBuilder, x0: number, z0: number, x1: number, z1: number) =>
    b.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], up);

  (Object.keys(ROOMS) as RoomId[]).forEach((id, n) => {
    const r = floorRect(ROOMS[id]);
    const s = FLOOR[id];
    if (s.kind === 'wood') {
      wood.color(s.tint).set('plank', s.dir, s.plank, n + 1);
      quad(wood, r.x0, r.z0, r.x1, r.z1);
    } else {
      tile.color(s.tint).set('tile', s.size, s.checker ? 1 : 0);
      quad(tile, r.x0, r.z0, r.x1, r.z1);
    }
  });

  // 门洞的门槛：填上墙体那一段（墙两侧的地板已经各伸进来 M）；木纹顺着通行方向
  const sills: [number, number][] = [...DOORWAYS.flatMap((d) => d.cells)];
  for (const [i, j] of sills) {
    const horizWall = roomAt(i, j - 1) !== null || roomAt(i, j + 1) !== null;
    wood.color(C(PALETTE.woodDark)).set('plank', horizWall ? 1 : 0, 0.12, 50);
    if (horizWall) quad(wood, i * CELL, j * CELL + M, (i + 1) * CELL, (j + 1) * CELL - M);
    else quad(wood, i * CELL + M, j * CELL, (i + 1) * CELL - M, (j + 1) * CELL);
  }
  // 前门门槛：一直铺到房子外沿
  for (const [i, j] of FRONT_DOOR.cells) {
    wood.color(C(PALETTE.woodDark)).set('plank', 1, 0.12, 51);
    quad(wood, i * CELL, j * CELL + M, (i + 1) * CELL, (j + 1) * CELL);
  }

  // 木地板：一条条错缝的木板，板缝略暗，每块板深浅略有不同
  const woodMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.62, metalness: 0 });
  {
    const p = positionLocal;
    const pl = attribute('plank', 'vec3');
    const alongX = pl.x.lessThan(0.5);
    const along = select(alongX, p.x, p.z);
    const across = select(alongX, p.z, p.x);
    const w = pl.y;
    const L = float(1.35);
    const rowF = across.div(w);
    const row = floor(rowF);
    const segF = along.add(hash(row.add(pl.z.mul(97)).add(300)).mul(L)).div(L);
    const seg = floor(segF);
    const tone = hash(row.mul(13).add(seg.mul(7)).add(pl.z.mul(1009)).add(5000)).mul(0.24).add(0.86);
    const da = min(fract(rowF), fract(rowF).oneMinus()).mul(w);
    const ds = min(fract(segF), fract(segF).oneMinus()).mul(L);
    const aa = fwidth(across).add(0.004);
    const seam = smoothstep(0, aa, min(da, ds)).mul(0.4).add(0.6);
    const grain = sin(along.mul(17).add(hash(row.add(77)).mul(6.28)).add(sin(along.mul(3.1)).mul(2))).mul(0.035).add(1);
    woodMat.colorNode = vec3(tone.mul(seam).mul(grain));
  }

  // 地砖：厨房黑白相间（这里是深浅两种灰），浴室小方砖；砖缝略暗
  const tileMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.38, metalness: 0 });
  {
    const p = positionLocal;
    const tl = attribute('tile', 'vec2');
    const s = tl.x;
    const gx = p.x.div(s), gz = p.z.div(s);
    const ix = floor(gx), iz = floor(gz);
    const checker = mod(ix.add(iz), 2);
    const jitter = hash(ix.mul(31).add(iz.mul(17)).add(800)).mul(0.12).add(0.94);
    const tone = select(tl.y.greaterThan(0.5), mix(float(1.05), float(0.42), checker), float(1)).mul(jitter);
    const de = min(min(fract(gx), fract(gx).oneMinus()), min(fract(gz), fract(gz).oneMinus())).mul(s);
    const grout = smoothstep(0, fwidth(p.x).add(0.006), de).mul(0.5).add(0.5);
    tileMat.colorNode = vec3(tone.mul(grout));
  }

  if (glow) {
    // 底色 = colorNode × 顶点色（材质开着 vertexColors，three 会自己乘；自发光要的底色这里再乘一遍）
    const upN = vec3(0, 1, 0);
    for (const m of [woodMat, tileMat]) {
      const albedo = (m.colorNode as THREE.Node<'vec3'>).mul(attribute('color', 'vec3'));
      m.emissiveNode = albedo.mul(ghostGlowAt(glow, positionLocal, upN));
    }
  }

  const woodMesh = new THREE.Mesh(wood.build(), woodMat);
  woodMesh.name = 'floor-wood';
  const tileMesh = new THREE.Mesh(tile.build(), tileMat);
  tileMesh.name = 'floor-tile';
  for (const m of [woodMesh, tileMesh]) m.receiveShadow = true;
  return [woodMesh, tileMesh];
}

// ───────────────────────── 屋外 ─────────────────────────

function buildOutdoors() {
  const out: THREE.Object3D[] = [];
  const ring = 9;

  // 一圈深色地面：越往外越透明，融进背景
  const groundGeo = new THREE.PlaneGeometry(HOUSE_W + ring * 2, HOUSE_D + ring * 2, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  groundGeo.translate(HOUSE_W / 2, -0.02, HOUSE_D / 2);
  const groundMat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 1, metalness: 0 });
  {
    const p = positionLocal;
    const dx = max(abs(p.x.sub(HOUSE_W / 2)).sub(HOUSE_W / 2), 0);
    const dz = max(abs(p.z.sub(HOUSE_D / 2)).sub(HOUSE_D / 2), 0);
    const d = length(vec2(dx, dz));
    const n = mx_noise_float(p.xz.mul(0.45)).mul(0.5).add(0.5);
    const speck = hash(floor(p.x.mul(9).add(400)).mul(57).add(floor(p.z.mul(9).add(400)))).mul(0.25).add(0.85);
    const base = mix(v3(mixC(PALETTE.moonGround, PALETTE.night, 0.6)), v3(mixC(PALETTE.moonGround, PALETTE.moon, 0.2).multiplyScalar(0.7)), n);
    groundMat.colorNode = base.mul(speck);
    groundMat.opacityNode = smoothstep(0.6, ring - 1.5, d).oneMinus();
  }
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.name = 'ground';
  ground.receiveShadow = true;
  ground.renderOrder = -1;
  out.push(ground);

  // 石头：墙根一圈矮石台、前门台阶、通往门外的一条石板小路；门廊灯的灯柱
  const b = new GeoBuilder();
  const stone = mixC(PALETTE.tile, PALETTE.wallTrim, 0.6);
  const H = 0.1;
  const fx0 = Math.min(...FRONT_DOOR.cells.map(([i]) => i)) * CELL;
  const fx1 = (Math.max(...FRONT_DOOR.cells.map(([i]) => i)) + 1) * CELL;
  b.color(stone);
  b.box(-0.05, -0.02, -0.05, HOUSE_W + 0.05, H, M, 'px nx py pz nz');
  b.box(-0.05, -0.02, HOUSE_D - M, fx0, H, HOUSE_D + 0.05, 'px nx py pz nz');
  b.box(fx1, -0.02, HOUSE_D - M, HOUSE_W + 0.05, H, HOUSE_D + 0.05, 'px nx py pz nz');
  b.box(-0.05, -0.02, M, M, H, HOUSE_D - M, 'px nx py pz nz');
  b.box(HOUSE_W - M, -0.02, M, HOUSE_W + 0.05, H, HOUSE_D - M, 'px nx py pz nz');
  // 台阶
  b.color(mixC(PALETTE.tile, PALETTE.wallTrim, 0.45));
  b.box(fx0 - 0.25, -0.02, HOUSE_D, fx1 + 0.25, 0.03, HOUSE_D + 0.45, 'px nx py pz nz');
  // 石板小路：一路铺到访客出现的地方再往外一点，块块大小、位置略有不同
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const cx = FRONT_DOOR.outside.x;
  for (let z = HOUSE_D + 0.55; z < FRONT_DOOR.outside.z + 2.4; z += 0.46) {
    const odd = Math.round((z - HOUSE_D) / 0.46) % 2 === 1;
    const xs = odd ? [cx - 0.3, cx + 0.3] : [cx - 0.42, cx + 0.12, cx + 0.5];
    for (const x of xs) {
      const w = (odd ? 0.5 : 0.36) + rand() * 0.08;
      const d = 0.36 + rand() * 0.06;
      const ox = (rand() - 0.5) * 0.06, oz = (rand() - 0.5) * 0.06;
      b.color(stone.clone().multiplyScalar(0.75 + rand() * 0.35));
      b.box(x - w / 2 + ox, -0.02, z - d / 2 + oz, x + w / 2 + ox, 0.02, z + d / 2 + oz, 'px nx py pz nz');
    }
  }
  // 灯柱：铸铁柱子 + 小灯笼的框
  const iron = new THREE.Color(PALETTE.wallTrim).multiplyScalar(0.6);
  const P = PORCH.pos;
  b.color(iron);
  b.box(P.x - 0.09, -0.02, P.z - 0.09, P.x + 0.09, 0.12, P.z + 0.09);
  b.geometry(new THREE.CylinderGeometry(0.03, 0.04, P.y - 0.2, 6), new THREE.Matrix4().makeTranslation(P.x, 0.12 + (P.y - 0.2) / 2, P.z));
  b.box(P.x - 0.1, P.y - 0.14, P.z - 0.1, P.x + 0.1, P.y - 0.11, P.z + 0.1);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    b.box(P.x + sx * 0.085 - 0.012, P.y - 0.11, P.z + sz * 0.085 - 0.012, P.x + sx * 0.085 + 0.012, P.y + 0.11, P.z + sz * 0.085 + 0.012);
  }
  b.geometry(new THREE.ConeGeometry(0.15, 0.14, 4).rotateY(Math.PI / 4), new THREE.Matrix4().makeTranslation(P.x, P.y + 0.18, P.z));
  b.box(P.x - 0.02, P.y + 0.24, P.z - 0.02, P.x + 0.02, P.y + 0.29, P.z + 0.02);
  const stonesMat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0.1 });
  const stones = new THREE.Mesh(b.build(), stonesMat);
  stones.name = 'outdoor-stones';
  stones.receiveShadow = true;
  stones.castShadow = false; // 都是贴地的薄片和一根细柱，投影看不出来；每盏投影灯（含四支手电）都能省一次 draw call
  out.push(stones);

  // 灯罩里的暖光（不受光照，自己亮）
  const glowMat = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(PALETTE.lamp).multiplyScalar(0.55) });
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.2, 0.15), glowMat);
  glow.position.set(P.x, P.y, P.z);
  glow.name = 'porch-lantern';
  out.push(glow);

  const porch = new THREE.PointLight(PALETTE.lamp, PORCH.intensity, PORCH.distance, 2);
  porch.position.set(P.x, P.y, P.z);
  porch.castShadow = false;
  porch.name = 'porch-light';
  out.push(porch);

  return { objects: out, porch, dispose: () => {
    for (const o of out) if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); }
  } };
}

// ───────────────────────── 月光 ─────────────────────────

/** 窗下地板上的月光光斑：每段窗一块平行四边形（窗洞沿光线方向投到地板上），加法混合，只在所在房间里显示 */
function buildMoonPatches(runs: WindowRun[]) {
  const n = runs.length;
  const pos = new Float32Array(n * 4 * 3);
  const uvs = new Float32Array(n * 4 * 2);
  const fade = new Float32Array(n * 4);
  const room = new Float32Array(n * 4 * 4);
  const panes = new Float32Array(n * 4);
  const index: number[] = [];
  runs.forEach((r, k) => {
    // 窗里侧那一格属于哪个房间：光斑只画在这个房间的地板范围里（隔墙会挡住真正的月光）
    const mid = (r.s0 + r.s1) / 2;
    const horiz = r.side === Side.N || r.side === Side.S;
    const [ox, oz] = OUTWARD[r.side];
    const px = horiz ? mid : r.c - ox * CELL, pz = horiz ? r.c - oz * CELL : mid;
    const id = roomAt(Math.floor(px / CELL), Math.floor(pz / CELL));
    const fr = id ? floorRect(ROOMS[id]) : { x0: 0, z0: 0, x1: HOUSE_W, z1: HOUSE_D };
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
    corners.forEach(([u, v], c) => {
      const vi = k * 4 + c;
      uvs.set([u, v], vi * 2);
      room.set([fr.x0, fr.z0, fr.x1, fr.z1], vi * 4);
      panes[vi] = r.panes;
    });
    // 投到地板上的四边形从上往下看要逆时针（正面）：北墙、东墙的窗投下来正好反过来
    const s = k * 4;
    const flip = horiz ? oz < 0 : ox > 0;
    if (flip) index.push(s, s + 2, s + 1, s, s + 3, s + 2);
    else index.push(s, s + 1, s + 2, s, s + 2, s + 3);
  });
  const g = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
  const fadeAttr = new THREE.BufferAttribute(fade, 1).setUsage(THREE.DynamicDrawUsage);
  g.setAttribute('position', posAttr);
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('fade', fadeAttr);
  g.setAttribute('room', new THREE.BufferAttribute(room, 4));
  g.setAttribute('panes', new THREE.BufferAttribute(panes, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(HOUSE_W / 2, 0, HOUSE_D / 2), Math.hypot(HOUSE_W, HOUSE_D));

  const strength = uniform(MOON.patch);
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  {
    const t = uv();
    const p = positionLocal;
    const rm = attribute('room', 'vec4');
    const np = attribute('panes', 'float');
    const soft = (x: THREE.Node<'float'>, a: number) => smoothstep(0, a, x);
    const edge = soft(t.x, 0.05).mul(soft(t.x.oneMinus(), 0.05)).mul(soft(t.y, 0.06)).mul(soft(t.y.oneMinus(), 0.06));
    // 窗棂的影子：竖棂在每两块玻璃之间，横档在 TRANSOM_Y
    // 到最近一根竖棂的距离（米）：竖棂在 u = k / panes 处，宽 0.05 米
    const toMullion = abs(fract(t.x.mul(np).add(0.5)).sub(0.5)).mul(CELL);
    const mullion = smoothstep(0.018, 0.04, toMullion).mul(0.7).add(0.3);
    const tv = (TRANSOM_Y + 0.025 - SILL_H) / (HEAD_H - SILL_H);
    const transom = smoothstep(0.018, 0.04, abs(t.y.sub(tv)).mul(HEAD_H - SILL_H)).mul(0.7).add(0.3);
    const inRoom = soft(p.x.sub(rm.x), 0.04).mul(soft(rm.z.sub(p.x), 0.04)).mul(soft(p.z.sub(rm.y), 0.04)).mul(soft(rm.w.sub(p.z), 0.04));
    const f = attribute('fade', 'float');
    mat.colorNode = v3(mixC(PALETTE.moonSky, PALETTE.moon, 0.35)).mul(edge.mul(mullion).mul(transom).mul(inRoom).mul(f).mul(strength).mul(0.35));
  }
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'moon-patches';
  mesh.position.y = 0.004;
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;

  const P = new THREE.Vector3();
  /** L：光线前进方向（单位向量，y < 0）；fullness：每面外墙全高的程度 */
  const update = (L: THREE.Vector3, fullness: readonly number[]) => {
    runs.forEach((r, k) => {
      const horiz = r.side === Side.N || r.side === Side.S;
      const [ox, oz] = OUTWARD[r.side];
      // 光从屋外往里照才有光斑
      const inward = -(ox * L.x + oz * L.z);
      const f = inward > 0.05 ? fullness[r.side] * Math.min(1, inward * 3) : 0;
      const corners: [number, number][] = [[r.s0, SILL_H], [r.s1, SILL_H], [r.s1, HEAD_H], [r.s0, HEAD_H]];
      corners.forEach(([s, y], c) => {
        P.set(horiz ? s : r.c, y, horiz ? r.c : s);
        const tt = y / -L.y;
        P.addScaledVector(L, tt);
        pos.set([P.x, 0, P.z], (k * 4 + c) * 3);
        fade[k * 4 + c] = f;
      });
    });
    posAttr.needsUpdate = true;
    fadeAttr.needsUpdate = true;
  };
  return { mesh, update, strength };
}

// ───────────────────────── 天花板（第三人称模式） ─────────────────────────

/**
 * 天花板：整栋房子一块，高 WALL_H（和墙顶齐平），法线朝下、只从下面看得见。暗色旧灰泥，带水渍似的大块深浅。
 * 不投影（挡月光的是 walls.ts 那块只投影的屋顶，月光只从窗进来）。
 * 不受光照：朝下的面只拿得到半球光的地面色（几乎是黑的），月光照不到，手电往下照、几乎照不到它；受光的话它占画面上方
 * 一大片，每个像素都要算一遍十几盏灯和阴影（2026-10-28 实测 GPU +16%）。所以这里直接按「环境光下的亮度」画底色，
 * 再加鬼魂的冷光和溶解的霜（ambient：底色乘这个 ≈ 半球光地面色照在朝下的面上的亮度）。
 * 墙顶的顶面和它在同一高度，但朝上、从下面看是背面，被剔掉，不会互相闪
 */
const CEILING = {
  color: mixC(PALETTE.wallpaper, PALETTE.wallTrim, 0.45),
  /** 深浅：每米几个起伏、最多暗多少 */
  stainFreq: 0.55,
  stain: 0.3,
  ambient: 0.003,
};

function buildCeiling(dissolve?: DissolveUniforms) {
  const b = new GeoBuilder();
  b.quad([0, WALL_H, 0], [HOUSE_W, WALL_H, 0], [HOUSE_W, WALL_H, HOUSE_D], [0, WALL_H, HOUSE_D], [0, -1, 0]);
  // 不写深度：天花板上面什么也没有，深度测试照做（墙挡得住它），但深度图里这些像素还是「背景」，
  // 后处理里按深度算的那几遍（SSAO 背景像素直接跳过）不会因为多了一块天花板而多算三分之一个画面（2026-10-28 实测）
  const mat = new THREE.MeshBasicNodeMaterial({ fog: false, depthWrite: false });
  mat.lights = false;
  const p = positionLocal;
  const n = mx_noise_float(vec3(p.x.mul(CEILING.stainFreq), p.z.mul(CEILING.stainFreq), 3.1)).mul(0.5).add(0.5);
  const albedo = v3(CEILING.color).mul(n.mul(CEILING.stain).add(1 - CEILING.stain));
  // 不写深度，挖洞（discard）也就不影响深度剔除：一直用挖洞的那份（镜头升到天花板底下时它也溶开）
  if (dissolve) applyDissolve(mat, dissolve, p, vec3(0, -1, 0), albedo, { unlitAmbient: CEILING.ambient });
  else mat.colorNode = albedo.mul(CEILING.ambient);
  const mesh = new THREE.Mesh(b.build(), mat);
  mesh.name = 'ceiling';
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  return mesh;
}

// ───────────────────────── 组装 ─────────────────────────

/**
 * 第三人称模式的月光方向（「从房子指向镜头」的水平方向，同娃娃屋 quarter = 0）：月亮在西北，光从北墙、西墙的窗进来。
 * 第三人称的镜头跟着鬼魂到处转，月光不能跟着转
 */
const GHOST_MOON_VIEW: Vec2 = { x: Math.SQRT1_2, z: Math.SQRT1_2 };

export function createHouseView(core: RenderCore, rig: CameraRig): Module {
  const search = new URLSearchParams(location.search);
  // 第三人称模式：rig 带着鬼魂（GhostRig）。墙全高、有天花板；溶解和冷光可以用 ?noghostfx 关掉
  const ghostMode = isGhostRig(rig);
  const dissolve = ghostMode && !search.has('noghostfx') ? ghostDissolve : undefined;
  const tiles = buildTiles();
  const root = new THREE.Group();
  root.name = 'house';
  core.houseRoot.add(root);

  const floors = buildFloors(dissolve);
  root.add(...floors);

  const walls = createWalls(tiles, rig.viewDir, { fullHeight: ghostMode, dissolve });
  root.add(walls.group, walls.shadowCaster);

  const furniture = createFurniture(tiles, dissolve);
  root.add(furniture.mesh);
  if (furniture.solid) root.add(furniture.solid);

  const ceiling = ghostMode && !search.has('noceiling') ? buildCeiling(dissolve) : null;
  if (ceiling) root.add(ceiling);

  const outdoors = buildOutdoors();
  root.add(...outdoors.objects);

  // 月光：冷蓝色平行光从远墙那一侧斜着照进窗户；阴影相机要看见 layer 1 的全高墙
  const moon = new THREE.DirectionalLight(PALETTE.moon, MOON.intensity);
  moon.name = 'moon';
  moon.shadow.mapSize.set(2048, 2048);
  const sc = moon.shadow.camera;
  sc.left = -11.5; sc.right = 11.5; sc.top = 11.5; sc.bottom = -11.5;
  sc.near = 5; sc.far = 60;
  sc.layers.enable(1); // 关键：mask 里除了 layer 0 还有别的位，ShadowNode 就不会拿主相机的 layers 覆盖它
  moon.shadow.bias = -0.0004;
  moon.shadow.normalBias = 0.02;
  moon.target.position.set(HOUSE_W / 2, 0, HOUSE_D / 2);
  root.add(moon, moon.target);

  const hemi = new THREE.HemisphereLight(PALETTE.moonSky, PALETTE.moonGround, MOON.hemi);
  hemi.name = 'moon-sky';
  core.scene.add(hemi);

  const patches = buildMoonPatches(walls.runs);
  root.add(patches.mesh);

  const L = new THREE.Vector3();
  const aimMoon = () => {
    // 光线的水平方向 = 从远墙指向镜头（viewDir）再偏一点，这样永远从远墙的窗照进来；第三人称模式固定不动
    const vd = ghostMode ? GHOST_MOON_VIEW : rig.viewDir;
    const a = Math.atan2(vd.z, vd.x) + MOON.yawOffset;
    const ce = Math.cos(MOON.elevation);
    L.set(Math.cos(a) * ce, -Math.sin(MOON.elevation), Math.sin(a) * ce);
    const R = 30;
    moon.position.set(HOUSE_W / 2 - L.x * R, -L.y * R, HOUSE_D / 2 - L.z * R);
    patches.update(L, walls.fullness);
  };

  const applyQuality = (q: Quality) => {
    const high = q === 'high';
    // 月光阴影两档都开：关掉它会改变每一个受光材质的着色器，第一次切到 Low 时全部重编，页面卡 2 秒以上
    // （2026-10-27 实测）。一张 2048 的方向光阴影图只画深度，开销远小于那次卡顿
    moon.castShadow = true;
    moon.intensity = high ? MOON.intensity : MOON.intensityLow;
    patches.strength.value = high ? MOON.patch : MOON.patchLow;
  };
  applyQuality(core.quality);
  aimMoon();

  // 第三人称：镜头位置换到房屋坐标（houseRoot 只有平移，挂在场景根上）；
  // 墙、家具附近会不会有洞（HOLE_TEST），不会就换上不挖洞的那份材质（省掉 discard 的开销）
  const camPos = new THREE.Vector3();
  const boxes = holeBoxes(tiles);
  const writeGhost = (ctx: FrameCtx) => {
    if (!dissolve || !isGhostRig(rig)) return;
    rig.camera.getWorldPosition(camPos);
    core.houseRoot.updateWorldMatrix(true, false);
    core.houseRoot.worldToLocal(camPos);
    const ortho = (rig.camera as { isOrthographicCamera?: boolean }).isOrthographicCamera === true;
    writeDissolve(dissolve, rig.ghost, camPos, ortho, ctx.time);
    const near = holesNear(boxes, rig.ghost, camPos, ortho);
    walls.setHoles(near.walls);
    furniture.setHoles(near.furniture);
  };

  let flicker = 0;
  return {
    update(ctx: FrameCtx) {
      if (ghostMode) writeGhost(ctx);
      else {
        walls.update(ctx.dt, rig.viewDir);
        aimMoon();
      }
      // 门廊灯：极轻的油灯式摇曳
      flicker += ctx.dt;
      outdoors.porch.intensity = PORCH.intensity * (0.93 + 0.05 * Math.sin(flicker * 7.3) + 0.03 * Math.sin(flicker * 17.9 + 1.3));
    },
    setQuality: applyQuality,
    dispose() {
      core.houseRoot.remove(root);
      core.scene.remove(hemi);
      walls.dispose();
      furniture.dispose();
      outdoors.dispose();
      if (dissolve) writeDissolve(dissolve, null, camPos, false, 0);
      for (const f of [...floors, ...(ceiling ? [ceiling] : [])]) { f.geometry.dispose(); (f.material as THREE.Material).dispose(); }
      patches.mesh.geometry.dispose();
      (patches.mesh.material as THREE.Material).dispose();
      moon.dispose();
      hemi.dispose();
    },
  };
}
