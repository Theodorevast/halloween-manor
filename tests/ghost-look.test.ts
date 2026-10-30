// 鬼魂看得清、朝向一眼看出（2026-10-30 用户试玩，路 GH；view/ghost.ts 的 GHOST、config/ghost.ts 的 GHOST_MODEL）。
// 用户：「太透明」「我老以为它朝着我」（看样报告 eye.md 的 G-2：背对镜头时兜帽背面那块暗色椭圆像脸孔的开口）。
// 原因：身体是双面、加法混合的，从背后看，兜帽正面那个深洞（烘的遮蔽 _OCCL 是 0，暗）透过来，背影和正脸一模一样。
// 这里测不依赖 GPU 的部分：材质的混合方式和画哪一面、几个淡入淡出的倍数、前倾、眼睛的位置（拿 GLB 本身的三角形和遮蔽查）、
// 程序化人形的脸洞。着色器里的式子和 CPU 这份是同一组常量（和 torchRevealAt 一样）
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { GHOST_MODEL } from '../src/config/ghost';
import { yawFor } from '../src/lib/angle';
import {
  GHOST, GHOST_BODY, buildGhostGeometry, createGhostMaterial, ensureGhostAttributes, eyeGate, hazeFade, hollowGate, makeGhostUniforms,
  nearFade, procGhostEyes, tiltFor, trailWeight, type GhostLook,
} from '../src/view/ghost';

const DEG = Math.PI / 180;
const look: GhostLook = { bottom: GHOST_BODY.bottom, top: GHOST_BODY.top };

// ───────────────────────── GLB：读三角形、遮蔽，换到鬼魂的局部坐标（和 loadGhostModel 一样按包围盒缩放、摆放） ─────────────────────────

interface Mesh { pos: Float32Array; occl: Float32Array; index: Uint16Array | Uint32Array }

// tsconfig 的 types 里没有 node 的类型：同 overlays.test.ts，用变量当模块名取 node:fs
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL): Uint8Array };

function readGhostGlb(): Mesh {
  const b = readFileSync(new URL('../public/assets/ghost/ghost.glb', import.meta.url));
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const jsonLen = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + jsonLen)));
  const bin = 20 + jsonLen + 8;
  const prim = json.meshes[0].primitives[0];
  const read = (i: number) => {
    const a = json.accessors[i];
    const v = json.bufferViews[a.bufferView];
    const n = a.type === 'VEC3' ? 3 : 1;
    const size = a.componentType === 5123 ? 2 : 4;
    const off = b.byteOffset + bin + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const buf = b.buffer.slice(off, off + a.count * n * size) as ArrayBuffer;
    return a.componentType === 5126 ? new Float32Array(buf) : a.componentType === 5125 ? new Uint32Array(buf) : new Uint16Array(buf);
  };
  const raw = read(prim.attributes.POSITION) as Float32Array;
  const occl = read(prim.attributes._OCCL) as Float32Array;
  const index = read(prim.indices) as Uint16Array;
  // loadGhostModel：高度缩放到 GHOST_BODY，x / z 按包围盒居中，底对齐 GHOST_BODY.bottom
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], raw[i + k]); max[k] = Math.max(max[k], raw[i + k]); }
  const k = (GHOST_BODY.top - GHOST_BODY.bottom) / (max[1] - min[1]);
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
  const pos = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i += 3) {
    pos[i] = (raw[i] - cx) * k;
    pos[i + 1] = GHOST_BODY.bottom + (raw[i + 1] - min[1]) * k;
    pos[i + 2] = (raw[i + 2] - cz) * k;
  }
  return { pos, occl, index };
}

function meshOf(g: THREE.BufferGeometry): Mesh {
  return {
    pos: g.getAttribute('position').array as Float32Array,
    occl: g.getAttribute('occl').array as Float32Array,
    index: g.getIndex()!.array as Uint16Array,
  };
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vert = (m: Mesh, i: number): V3 => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];

/** 从 o 沿 d 打一条射线，最近的交点距离（Möller–Trumbore，两面都算）；没碰到 = Infinity。skip 米以内的不算（起点就在表面上） */
function rayHit(m: Mesh, o: V3, d: V3, skip = 0.004): number {
  let best = Infinity;
  for (let t = 0; t < m.index.length; t += 3) {
    const a = vert(m, m.index[t]), b = vert(m, m.index[t + 1]), c = vert(m, m.index[t + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    const p = cross(d, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const s = sub(o, a);
    const uu = dot(s, p) / det;
    if (uu < 0 || uu > 1) continue;
    const q = cross(s, e1);
    const vv = dot(d, q) / det;
    if (vv < 0 || uu + vv > 1) continue;
    const dist = dot(e2, q) / det;
    if (dist > skip && dist < best) best = dist;
  }
  return best;
}

/** 离 p 最近的几个顶点：距离、遮蔽 */
function nearest(m: Mesh, p: V3, n = 6) {
  const all: { d: number; occl: number }[] = [];
  for (let i = 0; i < m.occl.length; i++) all.push({ d: Math.hypot(...sub(vert(m, i), p)), occl: m.occl[i] });
  return all.sort((a, b) => a.d - b.d).slice(0, n);
}

/** 程序化人形没推脸洞之前，头在高度 y 处正前方的 z（GHOST_BODY.profile 按 smoothstep 插值：半径 × z 方向缩放，不含头前探） */
function profileFrontZ(y: number): number {
  const P = GHOST_BODY.profile;
  for (let k = 0; k < P.length - 1; k++) {
    const [ya, ra, , za] = P[k];
    const [yb, rb, , zb] = P[k + 1];
    if (y <= ya && y >= yb) {
      const t = (ya - y) / (ya - yb);
      const s = t * t * (3 - 2 * t);
      return (ra + (rb - ra) * s) * (za + (zb - za) * s);
    }
  }
  return NaN;
}

/** 眼睛在模型上对不对：贴着兜帽里的表面、在暗的洞里，从正前方看得到（往 +z 打出去碰不到东西），从背后看被头挡住（往 −z 碰到兜帽） */
function checkEyes(m: Mesh, eyes: readonly (readonly [number, number, number])[]) {
  expect(eyes.length).toBe(2);
  // 一左一右
  expect(Math.sign(eyes[0][0]) * Math.sign(eyes[1][0])).toBe(-1);
  for (const e of eyes) {
    const p: V3 = [e[0], e[1], e[2]];
    const near = nearest(m, p);
    expect(near[0].d, `眼睛 ${p} 离表面`).toBeLessThan(0.02);
    expect(Math.max(...near.map((v) => v.occl)), `眼睛 ${p} 周围的遮蔽（洞里是暗的）`).toBeLessThan(0.45);
    // 从正前方（和斜 20° 内）看得到：往前打出去不碰到自己
    for (const a of [0, 20 * DEG, -20 * DEG]) {
      expect(rayHit(m, p, [Math.sin(a), 0, Math.cos(a)]), `往前 ${(a / DEG).toFixed(0)}°`).toBe(Infinity);
    }
    // 从背后、正侧面看都被头挡住
    expect(rayHit(m, p, [0, 0, -1]), '往后').toBeLessThan(0.4);
    expect(rayHit(m, p, [Math.sign(p[0]), 0, 0]), '往外侧').toBeLessThan(0.4);
  }
}

// ───────────────────────── 不透明度 ─────────────────────────

describe('不透明度：身体只画朝镜头的那一面，并且真的挡住身后（用户：「太透明」）', () => {
  const u = makeGhostUniforms();
  it('身体：只画正面（不再透出背面那层：兜帽正面的洞不会从背后透过来），预乘的普通混合（发光 + 挡住身后 cover 这么多）', () => {
    const m = createGhostMaterial(u, look, GHOST.body, 'body');
    expect(m.side).toBe(THREE.FrontSide);
    expect(m.blending).toBe(THREE.CustomBlending);
    expect(m.blendSrc).toBe(THREE.OneFactor);
    expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(m.depthWrite).toBe(false);
    expect(m.transparent).toBe(true);
    // 正对镜头、没被侵蚀的地方，雾最薄处也挡掉身后七成（窗户、台灯照亮的地方不再一块块透出来）；被手电照着时挡得更多，但不是实心的
    expect(GHOST.body.cover! * GHOST.coverCloud).toBeGreaterThanOrEqual(0.7);
    expect(GHOST.reveal.cover).toBeGreaterThan(GHOST.body.cover!);
    expect(GHOST.reveal.cover).toBeLessThanOrEqual(0.95);
    // 兜帽洞是完全挡住的（一团黑，看不见身后的窗）
    expect(GHOST.hollow.alpha).toBe(1);
  });
  it('雾晕：还是加法、只画正面（外面那圈发虚的光）', () => {
    for (const layer of GHOST.haze) {
      const m = createGhostMaterial(u, look, layer, 'haze');
      expect(m.blending).toBe(THREE.AdditiveBlending);
      expect(m.side).toBe(THREE.FrontSide);
      expect(layer.cover ?? 0).toBe(0);
    }
  });
  it('镜头贴近时最淡也留 minAlpha ≥ 0.3（原来 0.08）；默认吊臂（约 2.5 米）、滚轮拉到最近（约 1.2 米）都是完整的；一路单调', () => {
    expect(GHOST.minAlpha).toBeGreaterThanOrEqual(0.3);
    expect(nearFade(0)).toBeCloseTo(GHOST.minAlpha, 9);
    expect(nearFade(0.1)).toBeCloseTo(GHOST.minAlpha, 9);
    expect(nearFade(1.2)).toBe(1);
    expect(nearFade(2.5)).toBe(1);
    let prev = 0;
    for (let d = 0; d <= 3; d += 0.01) {
      const v = nearFade(d);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
  it('雾晕近处淡掉（看样报告 S-3：贴近时一团带重影的糊）：0.9 米以内没有，默认吊臂处完整，单调', () => {
    expect(hazeFade(0)).toBe(0);
    expect(hazeFade(0.9)).toBe(0);
    expect(hazeFade(2.5)).toBe(1);
    expect(hazeFade(1.25)).toBeGreaterThan(0);
    expect(hazeFade(1.25)).toBeLessThan(1);
    let prev = 0;
    for (let d = 0; d <= 3; d += 0.01) {
      const v = hazeFade(d);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});

// ───────────────────────── 前倾、下摆和袖口往后拖 ─────────────────────────

describe('飘动时前倾（GHOST.tilt）：按速度，最多 8°，往运动方向倾', () => {
  const tiltDeg = (t: { x: number; z: number }) => Math.atan(Math.hypot(t.x, t.z)) / DEG;
  it('停着不倾', () => {
    const t = tiltFor(0, 0, 0.3);
    expect(t.x).toBe(0);
    expect(t.z).toBe(0);
  });
  it('朝着脸的方向全速飘（2.2 米/秒）：在模型局部坐标里往 +z（正面）倾满 8°，不往两边歪；各个朝向都一样', () => {
    for (const heading of [0, 0.7, Math.PI / 2, -2.4, Math.PI]) {
      const v = 2.2;
      const t = tiltFor(Math.cos(heading) * v, Math.sin(heading) * v, yawFor(heading));
      expect(tiltDeg(t), `heading ${heading}`).toBeCloseTo(8, 6);
      expect(t.z).toBeGreaterThan(0);
      expect(Math.abs(t.x)).toBeLessThan(1e-9);
    }
  });
  it('倒着飘往后倾、横着飘往旁边倾（倾向运动的方向）', () => {
    const heading = 0.4, rot = yawFor(heading);
    const back = tiltFor(-Math.cos(heading) * 1.5, -Math.sin(heading) * 1.5, rot);
    expect(back.z).toBeLessThan(0);
    expect(Math.abs(back.x)).toBeLessThan(1e-9);
    // 右手边：方向角 heading + π/2
    const side = tiltFor(Math.cos(heading + Math.PI / 2), Math.sin(heading + Math.PI / 2), rot);
    expect(Math.abs(side.x)).toBeGreaterThan(0.01);
    expect(Math.abs(side.z)).toBeLessThan(1e-9);
  });
  it('慢的时候倾得少（按速度），任何速度都不超过 8°，一路单调', () => {
    let prev = 0;
    for (let v = 0; v <= 10; v += 0.05) {
      const d = tiltDeg(tiltFor(v, 0, yawFor(0)));
      expect(d).toBeLessThanOrEqual(GHOST.tilt.max / DEG + 1e-9);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
    expect(GHOST.tilt.max / DEG).toBeCloseTo(8, 9);
    const slow = tiltDeg(tiltFor(0.5, 0, yawFor(0)));
    expect(slow).toBeGreaterThan(1);
    expect(slow).toBeLessThan(4);
  });
  it('往后拖的权重（trailWeight）：下摆最多（1），袖口（离中轴远、半身高）拖一点，身体中轴上半身几乎不拖', () => {
    expect(trailWeight(0, 0)).toBeCloseTo(1, 9);
    // 袖口：离中轴 0.25 米、身高一半
    const cuff = trailWeight(0.25, 0.5);
    expect(cuff).toBeGreaterThan(0.4);
    expect(cuff).toBeLessThan(1);
    // 同一高度、贴着中轴的身子：只有下摆那份 (1 − h)²
    expect(trailWeight(0, 0.5)).toBeCloseTo(0.25, 9);
    // 头（身高 0.9）不拖
    expect(trailWeight(0.1, 0.9)).toBeLessThan(0.02);
  });
});

// ───────────────────────── 眼睛：只有正面看得到 ─────────────────────────

describe('眼睛（GHOST.eyes）：兜帽洞里两点很淡的冷光，只有从正面看得到', () => {
  it('看得见的程度按「眼睛 → 镜头」和鬼魂正面的夹角：正面、偏 30° 以内满，45° 还剩一多半，65° 以外、侧面、背后为 0；单调', () => {
    expect(eyeGate(1)).toBe(1);
    expect(eyeGate(Math.cos(30 * DEG))).toBeGreaterThan(0.95);
    expect(eyeGate(Math.cos(45 * DEG))).toBeGreaterThan(0.5);
    expect(eyeGate(Math.cos(65 * DEG))).toBe(0);
    expect(eyeGate(0)).toBe(0);
    expect(eyeGate(-1)).toBe(0);
    let prev = 0;
    for (let c = -1; c <= 1.0001; c += 0.01) {
      const v = eyeGate(c);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
  it('很淡、冷色、很小：亮度不到 0.6（线性），蓝 ≥ 绿 ≥ 红，半径不到 2 厘米', () => {
    const c = GHOST.eyes.color;
    expect(c.b).toBeGreaterThanOrEqual(c.g);
    expect(c.g).toBeGreaterThanOrEqual(c.r);
    expect(Math.max(c.r, c.g, c.b) * GHOST.eyes.glow).toBeLessThan(0.6);
    expect(GHOST.eyes.radius).toBeLessThan(0.02);
  });
  it('GLB（config/ghost.ts 的 GHOST_MODEL.eyes）：贴着兜帽洞里的表面、在暗处，正前方看得到，背后和侧面被头挡住', () => {
    expect(GHOST_MODEL.eyes).toBeTruthy();
    checkEyes(readGhostGlb(), GHOST_MODEL.eyes!);
  });
  it('程序化的人形（?procghost）：一样', () => {
    checkEyes(meshOf(buildGhostGeometry()), procGhostEyes());
  });
});

// ───────────────────────── 背影不像正脸 ─────────────────────────

describe('背影不像正脸：兜帽背面是浅的，暗的只有正面的洞', () => {
  /** 头部（兜帽）那一段：身高 0.8 以上 */
  const headOf = (m: Mesh) => {
    const out: { z: number; occl: number }[] = [];
    const yHead = GHOST_BODY.bottom + (GHOST_BODY.top - GHOST_BODY.bottom) * 0.8;
    for (let i = 0; i < m.occl.length; i++) if (m.pos[i * 3 + 1] > yHead) out.push({ z: m.pos[i * 3 + 2], occl: m.occl[i] });
    return out;
  };
  it('GLB：兜帽后半边（z < 0）的遮蔽没有暗的（≥ 0.5，中位数 ≥ 0.9）；暗的（< 0.2）都在前半边', () => {
    const head = headOf(readGhostGlb());
    const back = head.filter((v) => v.z < -0.01).map((v) => v.occl).sort((a, b) => a - b);
    expect(back.length).toBeGreaterThan(20);
    expect(back[0]).toBeGreaterThanOrEqual(0.5);
    expect(back[Math.floor(back.length / 2)]).toBeGreaterThanOrEqual(0.9);
    for (const v of head) if (v.occl < 0.2) expect(v.z).toBeGreaterThan(0);
  });
  it('程序化的人形：脸那里推进去一个洞，洞里暗（遮蔽 < 0.3）；兜帽后半边全是 1', () => {
    const g = buildGhostGeometry();
    const m = meshOf(g);
    const head = headOf(m);
    const back = head.filter((v) => v.z < 0);
    expect(back.length).toBeGreaterThan(20);
    for (const v of back) expect(v.occl).toBe(1);
    expect(Math.min(...head.map((v) => v.occl))).toBeLessThan(0.3);
    // 洞是真的凹进去：脸中间那一点比没推之前的头的正面（按 profile 插值：半径 × z 方向缩放 + 头前探）往后至少 4 厘米
    const F = GHOST_BODY.face;
    let front = -Infinity, at = NaN;
    for (let i = 0; i < m.occl.length; i++) {
      if (Math.abs(m.pos[i * 3 + 1] - F.y) < 0.015 && Math.abs(m.pos[i * 3]) < 0.004 && m.pos[i * 3 + 2] > front) {
        front = m.pos[i * 3 + 2];
        at = m.pos[i * 3 + 1];
      }
    }
    expect(front).toBeGreaterThan(0);
    expect(front).toBeLessThan(profileFrontZ(at) + GHOST_BODY.headForward - 0.04);
  });
});

// ───────────────────────── 自己挡自己：不写深度，靠画的顺序 ─────────────────────────

/** 把读出来的 GLB 包成几何体（和 loadGhostModel 一样带 _occl，交给 ensureGhostAttributes） */
function glbGeometry(): THREE.BufferGeometry {
  const m = readGhostGlb();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
  g.setAttribute('_occl', new THREE.BufferAttribute(m.occl, 1));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  return g;
}

/** 三角形的平均遮蔽（Mesh 上第 t 个，t 按画的顺序） */
const triOccl = (m: Mesh, t: number) => (m.occl[m.index[t * 3]] + m.occl[m.index[t * 3 + 1]] + m.occl[m.index[t * 3 + 2]]) / 3;

/**
 * 正交地沿 dir 看过去（只画正面：三角形朝着来的方向才算），一条射线穿过的所有朝着镜头的三角形里，**最后画的**那一层（普通混合下盖在最上面的）。
 * 射线的起点 o、方向 dir；没碰到 = −1
 */
function lastDrawn(m: Mesh, o: V3, dir: V3): number {
  let last = -1;
  for (let t = 0; t < m.index.length / 3; t++) {
    const a = vert(m, m.index[t * 3]), b = vert(m, m.index[t * 3 + 1]), c = vert(m, m.index[t * 3 + 2]);
    const e1 = sub(b, a), e2 = sub(c, a);
    if (dot(cross(e1, e2), dir) >= 0) continue; // 背对镜头的不画
    const p = cross(dir, e2);
    const det = dot(e1, p);
    if (Math.abs(det) < 1e-12) continue;
    const q0 = sub(o, a);
    const uu = dot(q0, p) / det;
    if (uu < 0 || uu > 1) continue;
    const q = cross(q0, e1);
    const vv = dot(dir, q) / det;
    if (vv < 0 || uu + vv > 1) continue;
    if (dot(e2, q) / det > 0) last = t;
  }
  return last;
}

/** 从背后（−z 看向 +z）穿过兜帽的一片射线，最后画的那一层里有多少是暗的（平均遮蔽 < limit） */
function darkFromBehind(m: Mesh, limit: number) {
  let hits = 0, dark = 0;
  for (let y = 0.13; y <= 0.41; y += 0.02) {
    for (let x = -0.12; x <= 0.1201; x += 0.02) {
      const t = lastDrawn(m, [x, y, -2], [0, 0, 1]);
      if (t < 0) continue;
      hits++;
      if (triOccl(m, t) < limit) dark++;
    }
  }
  return { hits, dark, share: dark / Math.max(hits, 1) };
}

describe('自己挡自己（身体不写深度、普通混合）：里面的先画、外面的后画', () => {
  it('ensureGhostAttributes 把三角形按平均遮蔽从小到大排：暗的、被包在里面的在前（GLB、程序化的人形）', () => {
    for (const g of [ensureGhostAttributes(glbGeometry()), ensureGhostAttributes(buildGhostGeometry())]) {
      const m = meshOf(g);
      for (let t = 1; t < m.index.length / 3; t++) expect(triOccl(m, t)).toBeGreaterThanOrEqual(triOccl(m, t - 1) - 1e-6);
    }
  });
  it('只是换顺序：还是原来那些三角形，一个不多一个不少；再过一遍结果不变（鬼魂和墙上多的那个影子共用一份几何体）', () => {
    const tris = (a: ArrayLike<number>) => {
      const out: string[] = [];
      for (let i = 0; i < a.length; i += 3) out.push(`${a[i]},${a[i + 1]},${a[i + 2]}`);
      return out.sort();
    };
    const before = tris(readGhostGlb().index);
    const g = ensureGhostAttributes(glbGeometry());
    const once = Array.from(g.getIndex()!.array);
    expect(tris(once)).toEqual(before);
    const attr = g.getIndex();
    ensureGhostAttributes(g);
    expect(Array.from(g.getIndex()!.array)).toEqual(once);
    // 原地排：不换 BufferAttribute（已经传给 GPU 的那份不会留成垃圾）
    expect(g.getIndex()).toBe(attr);
  });
  it('GLB 从背后看兜帽：盖在最上面的那一层不是洞里的暗面（G-2：背影不能透出正面的洞）', () => {
    const m = meshOf(ensureGhostAttributes(glbGeometry()));
    const r = darkFromBehind(m, 0.35);
    expect(r.hits).toBeGreaterThan(50);
    expect(r.dark, `${r.dark} / ${r.hits}`).toBe(0);
  });
  it('程序化的人形从背后看：一样', () => {
    const m = meshOf(ensureGhostAttributes(buildGhostGeometry()));
    const r = darkFromBehind(m, 0.35);
    expect(r.hits).toBeGreaterThan(50);
    expect(r.dark, `${r.dark} / ${r.hits}`).toBe(0);
  });
});

describe('兜帽洞的加厚和压暗（GHOST.hollow）只在从正面看时（hollowGate）', () => {
  it('正面、偏 60° 以内满；正侧面、背后为 0（洞里的面从旁边、后面看不是洞）；单调', () => {
    expect(hollowGate(1)).toBe(1);
    expect(hollowGate(Math.cos(60 * DEG))).toBe(1);
    expect(hollowGate(0)).toBe(0);
    expect(hollowGate(-1)).toBe(0);
    let prev = 0;
    for (let c = -1; c <= 1.0001; c += 0.01) {
      const v = hollowGate(c);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
  it('比眼睛的范围宽：看得到眼睛的角度，洞一定是黑的（眼睛不会浮在透明的洞里）', () => {
    for (let c = -1; c <= 1.0001; c += 0.01) if (eyeGate(c) > 0) expect(hollowGate(c)).toBeGreaterThan(0.5);
  });
});
