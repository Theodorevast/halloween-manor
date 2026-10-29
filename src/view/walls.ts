// 墙：由 buildTiles() 的 Wall / Window 格生成，并按镜头朝向降低前方的墙。
// 做法：
// - 每个墙格画一根中心柱（WALL_T 见方），向相邻墙格方向各伸一段臂到格子边界，转角、T 形接头天然严丝合缝；
//   一段墙的尽头（门洞两侧）也伸到格子边界，这样看得见的门洞宽度 = 能走的门洞格子
// - 全部可见墙合成一个网格（1 次 draw call）。每个顶点带「属于哪面墙」（wg：两个组号，转角取两面里较高的）
//   和「这一块的底边高度」（y0）；顶点着色器里 y = min(y, 该组当前高度)，降墙不用重建几何体。
//   墙降到某块的底边以下时（窗框、门楣），整块收到地板下面
// - 窗格是带窗洞的墙：窗台以下一段、窗顶以上一段，中间是窗棂和一块发淡淡月光的玻璃
// - 「只投影」的全高版本另做一份闭合几何体，放在 layer 1：主相机看不见，灯的阴影相机 layers.enable(1) 后能看见，
//   这样降低的墙照样挡月光和手电，光不会从矮墙上方漏到隔壁房间（r186 的 ShadowNode 尊重 shadow.camera.layers）
// - 第三人称模式（2026-10-28 改版）：墙全高、不降；鬼魂附近和「镜头 → 鬼魂」视线上的墙面溶开，见下面的 DISSOLVE
import * as THREE from 'three/webgpu';
import {
  Fn, If, abs, attribute, bool, clamp, dot, float, floor, fract, hash, length, max, min, mix, mx_noise_float,
  normalLocal, positionLocal, select, smoothstep, uniform, uv, varying, vec3,
} from 'three/tsl';
import {
  CELL, FRONT_DOOR, GRID_H, GRID_W, HOUSE_D, HOUSE_W, Tile, WALL_CUT_H, WALL_H, WALL_T, WINDOWS, idx, inGrid,
} from '../config/house';
import type { Vec2 } from '../sim/types';
import { PALETTE } from './palette';

/** 窗台、窗顶高度（米）。计划里定的数，config 里没有，放在这里 */
export const SILL_H = 0.9;
export const HEAD_H = 2.0;
/** 窗棂横档的高度 */
export const TRANSOM_Y = 1.5;
/** 前门门楣下沿 */
const DOOR_HEAD = 2.1;
/** 降墙过渡时长（秒） */
const LOWER_TIME = 0.3;

/** 外墙四面 + 内墙。数值同时用作顶点属性里的组号 */
export const Side = { N: 0, E: 1, S: 2, W: 3, In: 4 } as const;
export type Side = (typeof Side)[keyof typeof Side];
/** 外墙的外法线（x, z），按 Side 编号 */
export const OUTWARD: readonly (readonly [number, number])[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** 墙面类型（顶点属性 kind）：决定颜色 */
const Kind = { Inner: 0, Outer: 1, Cap: 2, Trim: 3 } as const;

export type V3 = [number, number, number];

// ───────────────────────── 几何体拼装工具（家具、地板、屋外也用） ─────────────────────────

/**
 * 把一堆四边形 / 盒子 / 任意几何体拼成一个 BufferGeometry：每个面独立顶点（平直着色），
 * 带顶点色和任意自定义属性。transform 不为空时，加进来的东西都先经过它（家具用它从模型坐标摆到房屋坐标）
 */
export class GeoBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private index: number[] = [];
  private extras = new Map<string, { size: number; data: number[]; cur: number[] }>();
  private c = new THREE.Color(1, 1, 1);
  transform: THREE.Matrix4 | null = null;
  private nm = new THREE.Matrix3();
  private v = new THREE.Vector3();
  private n = new THREE.Vector3();

  constructor(extras: Record<string, number> = {}) {
    for (const [name, size] of Object.entries(extras)) {
      this.extras.set(name, { size, data: [], cur: new Array(size).fill(0) });
    }
  }

  get vertexCount() { return this.pos.length / 3; }

  color(c: number | THREE.Color) {
    if (typeof c === 'number') this.c.setHex(c);
    else this.c.copy(c);
    return this;
  }

  set(name: string, ...v: number[]) {
    const e = this.extras.get(name);
    if (!e) throw new Error(`GeoBuilder: 没有属性 ${name}`);
    for (let i = 0; i < e.size; i++) e.cur[i] = v[i] ?? 0;
    return this;
  }

  private vert(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
    this.v.set(x, y, z);
    this.n.set(nx, ny, nz);
    if (this.transform) {
      this.v.applyMatrix4(this.transform);
      this.n.applyMatrix3(this.nm.getNormalMatrix(this.transform)).normalize();
    }
    this.pos.push(this.v.x, this.v.y, this.v.z);
    this.nor.push(this.n.x, this.n.y, this.n.z);
    this.col.push(this.c.r, this.c.g, this.c.b);
    for (const e of this.extras.values()) e.data.push(...e.cur);
  }

  /**
   * 四边形：四个角按环绕顺序给出；n 是期望的正面法线，顶点顺序反了会自动翻转。
   * per 给逐顶点的属性值（比如 uv），每个属性 4 组
   */
  quad(a: V3, b: V3, c: V3, d: V3, n: V3, per?: Record<string, number[][]>) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = c[0] - a[0], wy = c[1] - a[1], wz = c[2] - a[2];
    const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
    const flip = cx * n[0] + cy * n[1] + cz * n[2] < 0;
    const s = this.vertexCount;
    [a, b, c, d].forEach((p, k) => {
      if (per) for (const [name, vals] of Object.entries(per)) this.set(name, ...vals[k]);
      this.vert(p[0], p[1], p[2], n[0], n[1], n[2]);
    });
    if (flip) this.index.push(s, s + 2, s + 1, s, s + 3, s + 2);
    else this.index.push(s, s + 1, s + 2, s, s + 2, s + 3);
    return this;
  }

  /** 轴对齐盒子。faces 是要画的面：'px nx py ny pz nz' 的子集，默认全部 */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, faces = 'px nx py ny pz nz') {
    const f = faces.split(' ');
    if (f.includes('px')) this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], [1, 0, 0]);
    if (f.includes('nx')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]);
    if (f.includes('py')) this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], [0, 1, 0]);
    if (f.includes('ny')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
    if (f.includes('pz')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
    if (f.includes('nz')) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [0, 0, -1]);
    return this;
  }

  /** 把任意几何体（CylinderGeometry 等）按 m 变换后加进来，每个三角形用面法线；用完会 dispose 传入的几何体 */
  geometry(g: THREE.BufferGeometry, m?: THREE.Matrix4) {
    const src = g.index ? g.toNonIndexed() : g;
    const p = src.getAttribute('position');
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
    for (let i = 0; i < p.count; i += 3) {
      a.fromBufferAttribute(p, i);
      b.fromBufferAttribute(p, i + 1);
      c.fromBufferAttribute(p, i + 2);
      if (m) { a.applyMatrix4(m); b.applyMatrix4(m); c.applyMatrix4(m); }
      e1.subVectors(b, a);
      e2.subVectors(c, a);
      const n = e1.cross(e2);
      if (n.lengthSq() < 1e-14) continue; // 退化三角形（圆锥尖）
      n.normalize();
      const s = this.vertexCount;
      for (const q of [a, b, c]) this.vert(q.x, q.y, q.z, n.x, n.y, n.z);
      this.index.push(s, s + 1, s + 2);
    }
    if (src !== g) src.dispose();
    g.dispose();
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    for (const [name, e] of this.extras) g.setAttribute(name, new THREE.Float32BufferAttribute(e.data, e.size));
    g.setIndex(this.index);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// ───────────────────────── 墙格分类 ─────────────────────────

const isWallish = (t: number) => t === Tile.Wall || t === Tile.Window;

/** 一个墙格属于哪几面外墙（转角两面）；内墙返回 [] */
function sidesOf(i: number, j: number): Side[] {
  const s: Side[] = [];
  if (j === 0) s.push(Side.N);
  if (i === GRID_W - 1) s.push(Side.E);
  if (j === GRID_H - 1) s.push(Side.S);
  if (i === 0) s.push(Side.W);
  return s;
}

/** 顶点属性 wg：两个组号，高度取两者较高（只有转角两个不同） */
function groupPair(i: number, j: number): [number, number] {
  const s = sidesOf(i, j);
  if (s.length === 0) return [Side.In, Side.In];
  return [s[0], s[s.length - 1]];
}

/** 一根臂（从格子 c 伸向邻格 n）跟哪面墙一起升降：碰到内墙跟内墙走；转角伸出去的臂跟邻格那面墙走 */
function armGroup(ci: number, cj: number, ni: number, nj: number): [number, number] {
  const c = groupPair(ci, cj), n = groupPair(ni, nj);
  if (c[0] === Side.In || n[0] === Side.In) return [Side.In, Side.In];
  if (c[0] !== c[1] && n[0] === n[1]) return n;
  return c;
}

type Face = 'px' | 'nx' | 'pz' | 'nz';
/** 顺序：东、南、西、北（相邻两个互相垂直，k 和 k+2 相对） */
const DIRS: { dx: number; dz: number; name: Face }[] = [
  { dx: 1, dz: 0, name: 'px' },
  { dx: 0, dz: 1, name: 'pz' },
  { dx: -1, dz: 0, name: 'nx' },
  { dx: 0, dz: -1, name: 'nz' },
];

/** 一段窗（同一面墙上连续的窗格） */
export interface WindowRun {
  side: Side;
  /** 沿墙方向的起止（米）；南北墙沿 x，东西墙沿 z */
  s0: number;
  s1: number;
  /** 墙中线在法线方向上的坐标（南北墙是 z，东西墙是 x） */
  c: number;
  /** 窗格数 = 玻璃块数 */
  panes: number;
}

export function windowRuns(): WindowRun[] {
  const bySide = new Map<Side, [number, number][]>();
  for (const [i, j] of WINDOWS) {
    const side = sidesOf(i, j)[0];
    if (side === undefined) continue;
    const list = bySide.get(side) ?? [];
    list.push([i, j]);
    bySide.set(side, list);
  }
  const runs: WindowRun[] = [];
  for (const [side, cells] of bySide) {
    const horiz = side === Side.N || side === Side.S;
    const ks = cells.map(([i, j]) => (horiz ? i : j)).sort((a, b) => a - b);
    const c = horiz ? (cells[0][1] + 0.5) * CELL : (cells[0][0] + 0.5) * CELL;
    let start = ks[0];
    for (let k = 1; k <= ks.length; k++) {
      if (k === ks.length || ks[k] !== ks[k - 1] + 1) {
        const end = ks[k - 1];
        runs.push({ side, s0: start * CELL, s1: (end + 1) * CELL, c, panes: end - start + 1 });
        start = ks[k];
      }
    }
  }
  return runs;
}

// ───────────────────────── 几何体生成 ─────────────────────────

interface Piece {
  x0: number; z0: number; x1: number; z1: number;
  /** 竖直分段：[底, 顶, y0]（窗格分成两段） */
  ranges: [number, number, number][];
  g: [number, number];
  /** 要画的侧面和它的类型（没列出的侧面被相邻块盖住，不画） */
  faces: Partial<Record<Face, number>>;
}

/** 收集所有墙块：柱、臂、窗棂、门楣 */
function collectPieces(tiles: Uint8Array): Piece[] {
  const t = WALL_T / 2;
  const pieces: Piece[] = [];
  const at = (i: number, j: number) => (inGrid(i, j) ? tiles[idx(i, j)] : -1);

  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const tile = at(i, j);
      if (!isWallish(tile)) continue;
      const cx = (i + 0.5) * CELL, cz = (j + 0.5) * CELL;
      const outward = sidesOf(i, j).map((s) => OUTWARD[s]);
      const ranges: [number, number, number][] = tile === Tile.Window
        ? [[0, SILL_H, 0], [HEAD_H, WALL_H, HEAD_H]]
        : [[0, WALL_H, 0]];
      const post = groupPair(i, j);
      const has = DIRS.map((d) => isWallish(at(i + d.dx, j + d.dz)));
      const isOuter = (d: (typeof DIRS)[number]) => outward.some(([ox, oz]) => ox === d.dx && oz === d.dz);
      const lateral = (d: (typeof DIRS)[number]) => (isOuter(d) ? Kind.Outer : Kind.Inner);
      /** 一段直墙的尽头：这个方向没墙、反方向有墙、两侧都没墙，并且这个方向是格子里的地板（门洞、前门） */
      const isEnd = (k: number) => {
        const d = DIRS[k];
        return !has[k] && has[(k + 2) % 4] && !has[(k + 1) % 4] && !has[(k + 3) % 4] && at(i + d.dx, j + d.dz) >= 0;
      };

      // 柱
      const postFaces: Piece['faces'] = {};
      DIRS.forEach((d, k) => {
        if (isEnd(k)) return; // 由下面的「尽头臂」盖住
        if (!has[k]) { postFaces[d.name] = lateral(d); return; }
        const ag = armGroup(i, j, i + d.dx, j + d.dz);
        if (ag[0] !== post[0] || ag[1] !== post[1]) postFaces[d.name] = lateral(d); // 臂可能比柱矮
      });
      pieces.push({ x0: cx - t, z0: cz - t, x1: cx + t, z1: cz + t, ranges, g: post, faces: postFaces });

      // 臂（含尽头臂）
      DIRS.forEach((d, k) => {
        const end = isEnd(k);
        if (!has[k] && !end) return;
        const g = end ? post : armGroup(i, j, i + d.dx, j + d.dz);
        const faces: Piece['faces'] = {};
        for (const o of DIRS) if (o.dx !== d.dx && o.dz !== d.dz) faces[o.name] = lateral(o);
        // 末端：门洞两侧画成门框；实墙伸向窗格的末端在窗洞那一段露出来，画成窗框
        if (end || (tile === Tile.Wall && at(i + d.dx, j + d.dz) === Tile.Window)) faces[d.name] = Kind.Trim;
        const x0 = d.dx > 0 ? cx + t : d.dx < 0 ? i * CELL : cx - t;
        const x1 = d.dx > 0 ? (i + 1) * CELL : d.dx < 0 ? cx - t : cx + t;
        const z0 = d.dz > 0 ? cz + t : d.dz < 0 ? j * CELL : cz - t;
        const z1 = d.dz > 0 ? (j + 1) * CELL : d.dz < 0 ? cz - t : cz + t;
        pieces.push({ x0, z0, x1, z1, ranges, g, faces });
      });
    }
  }

  // 窗棂：每两块玻璃之间一根竖棂，窗洞中部一根横档（y0 = 各自底边：墙降到它下面时整根收起）
  const trimAll = { px: Kind.Trim, nx: Kind.Trim, pz: Kind.Trim, nz: Kind.Trim };
  for (const r of windowRuns()) {
    const horiz = r.side === Side.N || r.side === Side.S;
    const g: [number, number] = [r.side, r.side];
    const depth = 0.035;
    const mk = (s0: number, s1: number, y0: number, y1: number): Piece => (horiz
      ? { x0: s0, x1: s1, z0: r.c - depth, z1: r.c + depth, ranges: [[y0, y1, y0]], g, faces: trimAll }
      : { x0: r.c - depth, x1: r.c + depth, z0: s0, z1: s1, ranges: [[y0, y1, y0]], g, faces: trimAll });
    for (let k = 1; k < r.panes; k++) {
      const s = r.s0 + k * CELL;
      pieces.push(mk(s - 0.025, s + 0.025, SILL_H, HEAD_H));
    }
    pieces.push(mk(r.s0, r.s1, TRANSOM_Y, TRANSOM_Y + 0.05));
  }

  // 前门门楣（南墙全高时才看得见）
  const fx0 = Math.min(...FRONT_DOOR.cells.map(([i]) => i)) * CELL;
  const fx1 = (Math.max(...FRONT_DOOR.cells.map(([i]) => i)) + 1) * CELL;
  const fz = (FRONT_DOOR.cells[0][1] + 0.5) * CELL;
  pieces.push({
    x0: fx0, x1: fx1, z0: fz - t, z1: fz + t, ranges: [[DOOR_HEAD, WALL_H, DOOR_HEAD]], g: [Side.S, Side.S],
    faces: { pz: Kind.Outer, nz: Kind.Inner },
  });
  return pieces;
}

/** 可见墙：只画看得见的面（不画底面，不画被相邻块盖住的面） */
function buildVisible(pieces: Piece[]): THREE.BufferGeometry {
  const b = new GeoBuilder({ wg: 2, y0: 1, kind: 1 });
  for (const p of pieces) {
    b.set('wg', p.g[0], p.g[1]);
    for (const [ya, yb, y0] of p.ranges) {
      b.set('y0', y0);
      // 所有顶面都是同一种（墙顶），降到同一高度时重合的顶面颜色一致，不会闪
      b.set('kind', Kind.Cap).box(p.x0, ya, p.z0, p.x1, yb, p.z1, 'py');
      for (const [name, kind] of Object.entries(p.faces)) {
        if (kind === undefined) continue;
        b.set('kind', kind).box(p.x0, ya, p.z0, p.x1, yb, p.z1, name);
      }
    }
  }
  return b.build();
}

/** 只投影的屋顶底面高度：比墙高一点点，墙顶伸进屋顶里，中间不留缝 */
const ROOF_Y = WALL_H + 0.05;

/**
 * 只投影的全高墙 + 一块屋顶：每块都是闭合盒子，阴影画正面（见 createWalls 里的 shadowSide）。
 * 没有屋顶的话，38° 仰角的月光会越过 2.4 米的墙照进每个房间离墙 3 米以外的地方；
 * 有了屋顶，月光只能从窗洞进来
 */
function buildShadowOnly(pieces: Piece[]): THREE.BufferGeometry {
  const b = new GeoBuilder();
  for (const p of pieces) {
    for (const [ya, yb] of p.ranges) b.box(p.x0, ya, p.z0, p.x1, yb >= WALL_H ? ROOF_Y : yb, p.z1);
  }
  b.box(0, ROOF_Y, 0, HOUSE_W, ROOF_Y + 0.1, HOUSE_D);
  return b.build();
}

/** 窗洞里的玻璃：每段窗一块竖直面片，uv.x 沿墙、uv.y 从窗台到窗顶 */
function buildGlass(runs: WindowRun[]): THREE.BufferGeometry {
  const b = new GeoBuilder({ wg: 2, y0: 1, uv: 2, panes: 1 });
  for (const r of runs) {
    const horiz = r.side === Side.N || r.side === Side.S;
    const [ox, oz] = OUTWARD[r.side];
    const c = r.c + (horiz ? oz : ox) * 0.05; // 稍微靠外，窗棂在玻璃前面
    const P = (s: number, y: number): V3 => (horiz ? [s, y, c] : [c, y, s]);
    b.set('wg', r.side, r.side).set('y0', SILL_H).set('panes', r.panes);
    b.quad(P(r.s0, SILL_H), P(r.s1, SILL_H), P(r.s1, HEAD_H), P(r.s0, HEAD_H), [-ox, 0, -oz], {
      uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
    });
  }
  return b.build();
}

// ───────────────────────── 材质 ─────────────────────────

type FloatU = THREE.UniformNode<'float', number>;
/** 调色板颜色 → TSL 的 vec3 常量（线性空间） */
export const v3 = (c: number | THREE.Color) => {
  const k = typeof c === 'number' ? new THREE.Color(c) : c;
  return vec3(k.r, k.g, k.b);
};
const mixHex = (a: number, b: number, t: number) => new THREE.Color(a).lerp(new THREE.Color(b), t);

// ───────────────────────── 第三人称：鬼魂穿墙（溶解） ─────────────────────────

/**
 * 墙面溶解（只在第三人称模式）。墙、家具、天花板、窗玻璃上的片元落在下面两个区域里就丢掉（maskNode）：
 * - 鬼魂周围、贴着这个面的扁椭球：鬼魂穿墙、穿家具时看得见它整个身子从墙里过去，而不是一半插在墙里；
 * - 镜头 → 鬼魂身体中部那条视线上的锥形胶囊（镜头这头细、鬼魂那头粗）：隔着墙也看得见鬼魂，
 *   镜头贴着墙、穿过墙、升到天花板底下时也不会切进去。
 * 洞边用两层噪声扰成不规则的形状、花纹慢慢往上飘；洞外 frost.band 米内结霜（底色变冷白、冰晶颗粒），
 * 紧贴洞口一圈极淡的冷光。只投影的全高墙（layer 1）不溶：光照、阴影都不变，洞只是「看穿」。距离都是米
 */
export const DISSOLVE = {
  /**
   * 鬼魂周围的洞：贴着片元所在的面摆的扁椭球，中心在 ghost.y + centerDy（身体中部）。面内水平半径 radius、
   * 竖直半径 radius × tall（盖住头顶到下摆）；沿面的法线只有 depth：身子（半宽约 0.3 米，含雾晕）真的贴上这个面才开始溶，
   * 一开就是一个够整个人过去的洞；飘在离墙半米的地方，背后的墙上不会出现一块黑斑
   */
  ghost: { radius: 0.62, tall: 1.3, depth: 0.34, centerDy: -0.25 },
  /** 家具上的洞按这个比例缩小：只在鬼魂真的碰到时溶开，飘过旁边不会把沙发啃掉一块 */
  furniture: 0.85,
  /**
   * 视线胶囊：镜头这头、鬼魂这头的水平半径（正交相机的视线是平行的，两头都用 ghostR），竖直方向在鬼魂那头乘 tall（横截面是竖着的椭圆：
   * 盖住鬼魂从头顶到下摆，左右只比身子宽一点，在 2 米宽的走廊正中飘时两边的墙不会跟着结霜）；
   * 鬼魂那头是平的，过了身体中部 capPad 米截断
   */
  sight: { camR: 0.3, ghostR: 0.5, tall: 1.6, capPad: 0.12 },
  /** 洞边的噪声：两层（freq 每米几个起伏，amp 米）；creep：花纹每秒往上飘多少米（像烟，不是静止的破洞） */
  noise: [{ freq: 2.3, amp: 0.17 }, { freq: 6.1, amp: 0.06 }] as const,
  creep: 0.06,
  /** 墙脚 [0] 米以下不溶、到 [1] 米恢复：墙体下面没有地板，溶到底会露出一条黑缝；留着踢脚线也更像「穿过去」 */
  keepBelow: [0.1, 0.26] as [number, number],
  /**
   * 霜：洞外 band 米内，越靠近洞口越厚；rim：紧贴洞口这么宽的一圈冷光；crystal：冰晶每米几颗；cover：霜最多盖住底色的比例；
   * 离镜头 near[0]..near[1] 米之间的洞，band、rim 按距离收窄（最窄 nearMin 倍），霜和冷光变淡（最淡到 nearFade 倍）
   */
  frost: {
    band: 0.16, rim: 0.03, crystal: 30, cover: 0.7,
    near: [0.2, 1.6] as [number, number], nearMin: 0.25, nearFade: [0.3, 0.4] as [number, number],
  },
  /** 霜的底色（线性，冷白偏蓝）；紧贴洞口那圈的自发光；霜自己的一点自发光（没有灯照着也看得出洞边） */
  frostAlbedo: new THREE.Color(0.56, 0.63, 0.72),
  rimGlow: new THREE.Color(0.32, 0.45, 0.6).multiplyScalar(0.17),
  frostGlow: new THREE.Color(0.32, 0.45, 0.6).multiplyScalar(0.04),
};

/**
 * 鬼魂身上那点冷光照到附近的表面。不是真灯：真灯会让每个受光材质每个像素多算一盏灯；这里只在墙、家具、天花板、
 * 地板的材质里按距离和朝向加一点自发光（乘底色）。intensity：贴着鬼魂时的倍数；d0 米处衰减到一半，reach 米外没有
 * （短，免得隔着墙照亮隔壁的地板）；wrap：侧对鬼魂的面也亮一点
 */
export const GHOST_GLOW = { color: new THREE.Color(0.55, 0.68, 0.86), intensity: 3.0, d0: 0.75, reach: 1.9, wrap: 0.35 };

/** 关掉时鬼魂、镜头放到地板下很远：任何片元都够不着 */
const FAR_Y = -1000;

/** 溶解用的 uniform（房屋坐标）。house.ts 每帧用 writeDissolve 写 */
export function makeDissolveUniforms() {
  return {
    /** 鬼魂身体中部 */
    ghost: uniform(new THREE.Vector3(0, FAR_Y, 0)),
    /** 鬼魂周围的洞的水平半径（0 = 没有洞） */
    ghostR: uniform(0),
    /** 镜头 */
    cam: uniform(new THREE.Vector3(0, FAR_Y, 0)),
    /** 镜头 → 鬼魂：xyz = ghost − cam，w = 1 / |ghost − cam|²（两点重合时 0） */
    seg: uniform(new THREE.Vector4(0, 0, 0, 0)),
    /** |ghost − cam| */
    segLen: uniform(0),
    /** 视线胶囊两头的半径（镜头、鬼魂） */
    sightR: uniform(new THREE.Vector2(0, 0)),
    /** 鬼魂微光的强度（0 = 没有） */
    glow: uniform(0),
    time: uniform(0),
  };
}
export type DissolveUniforms = ReturnType<typeof makeDissolveUniforms>;

/**
 * 全页共用的一份：第三人称模式下 house.ts 每帧写（娃娃屋模式下一直是关着的）。别的模块想让自己的物体也在鬼魂周围
 * 溶开（比如物件），把 dissolveAt(ghostDissolve, 房屋坐标的位置, 房屋坐标的法线).keep 接到自己材质的 maskNode 上即可。
 * 法线用 attribute('normal') 之类的 varying，别用 normalLocal（理由见 wallMaterial）；
 * maskNode 带 discard，大面积、互相遮挡多的物体要像墙一样备一份不挖洞的（见 HOLE_TEST）
 */
export const ghostDissolve = makeDissolveUniforms();

const _seg = new THREE.Vector3();
/**
 * 每帧写一次。ghost：鬼魂（房屋坐标，y 为离地高度，即 GhostState）；cam：镜头位置（房屋坐标）；
 * ortho：正交相机（视线平行，胶囊两头一样粗）。ghost = null 时整个关掉
 */
export function writeDissolve(
  u: DissolveUniforms, ghost: { x: number; y: number; z: number } | null, cam: THREE.Vector3, ortho: boolean, time: number,
) {
  u.time.value = time;
  if (!ghost) {
    u.ghost.value.set(0, FAR_Y, 0);
    u.cam.value.set(0, FAR_Y, 0);
    u.seg.value.set(0, 0, 0, 0);
    u.segLen.value = 0;
    u.ghostR.value = 0;
    u.sightR.value.set(0, 0);
    u.glow.value = 0;
    return;
  }
  const g = u.ghost.value.set(ghost.x, ghost.y + DISSOLVE.ghost.centerDy, ghost.z);
  u.cam.value.copy(cam);
  _seg.subVectors(g, cam);
  const l2 = _seg.lengthSq();
  u.seg.value.set(_seg.x, _seg.y, _seg.z, l2 > 1e-8 ? 1 / l2 : 0);
  u.segLen.value = Math.sqrt(l2);
  u.ghostR.value = DISSOLVE.ghost.radius;
  u.sightR.value.set(ortho ? DISSOLVE.sight.ghostR : DISSOLVE.sight.camR, DISSOLVE.sight.ghostR);
  u.glow.value = GHOST_GLOW.intensity;
}

type F = THREE.Node<'float'>;
type V3n = THREE.Node<'vec3'>;

/**
 * 片元 P（房屋坐标，N 是它所在面的法线）的溶解：keep = 不在洞里（给 maskNode），frost 0..1 霜的厚度，rim 0..1 紧贴洞口的那一圈。
 * holeScale 只缩放鬼魂周围的洞（家具用 DISSOLVE.furniture）；视线胶囊不缩，隔着衣柜也要看得见鬼魂。
 * 噪声只在离洞 reach 米以内的片元上算（If 分支），离洞远的整片墙只多两次距离计算。
 * 分支外先把要用的量存进变量，分支里只赋值：避开「共享节点第一次在分支里生成，另一边读到 0」的坑（调研文档）
 */
export function dissolveAt(u: DissolveUniforms, P: V3n, N: V3n, holeScale = 1): { keep: THREE.Node<'bool'>; frost: F; rim: F } {
  const D = DISSOLVE;
  const [n0, n1] = D.noise;
  const reach = n0.amp + n1.amp + D.frost.band + 0.02;
  const r = Fn(() => {
    // 鬼魂周围的扁椭球：沿法线的距离按 radius / depth 放大，面内的竖直距离按 tall 缩小
    const g = P.sub(u.ghost);
    const dn = dot(g, N);
    const gp = g.sub(N.mul(dn));
    const dGhost = length(vec3(gp.x, gp.y.div(D.ghost.tall), gp.z).add(N.mul(dn.mul(D.ghost.radius / D.ghost.depth))))
      .sub(u.ghostR.mul(holeScale));
    const a = P.sub(u.cam);
    const tr = dot(a, u.seg.xyz).mul(u.seg.w);
    const t = clamp(tr, 0, 1);
    // 鬼魂那头是平的（过了鬼魂身体中部 capPad 米就截断）：鬼魂背后的墙不归视线胶囊管，只有鬼魂贴上去才溶
    const beyond = tr.sub(1).mul(u.segLen).sub(D.sight.capPad);
    const rad = a.sub(u.seg.xyz.mul(t));
    // 竖直方向的拉长只在鬼魂那头需要（盖住头顶到下摆）；镜头那头是圆的，镜头附近不会白白多出一大块要算的区域
    const tall = mix(float(1), float(D.sight.tall), t);
    const dSight = max(length(vec3(rad.x, rad.y.div(tall), rad.z)).sub(mix(u.sightR.x, u.sightR.y, t)), beyond);
    const sd = min(dGhost, dSight).toVar();
    const field = sd.toVar();
    const frost = float(0).toVar();
    const rim = float(0).toVar();
    If(sd.lessThan(reach), () => {
      const q = P.sub(vec3(0, u.time.mul(D.creep), 0));
      const n = mx_noise_float(q.mul(n0.freq)).mul(n0.amp).add(mx_noise_float(q.mul(n1.freq).add(31.7)).mul(n1.amp));
      const low = float(1).sub(smoothstep(D.keepBelow[0], D.keepBelow[1], P.y));
      field.assign(sd.add(n).add(low.mul(0.8)));
      // 贴着镜头的洞（镜头跟着鬼魂穿墙时）霜圈收窄、变淡：同样宽的霜离镜头越近在画面上越大，会糊成一圈霜框
      const kk = smoothstep(D.frost.near[0], D.frost.near[1], length(a));
      const k = max(kk, D.frost.nearMin);
      const e = float(1).sub(smoothstep(0, k.mul(D.frost.band), field));
      const c = smoothstep(0.1, 0.65, mx_noise_float(P.mul(D.frost.crystal)));
      frost.assign(e.mul(e).mul(c.mul(0.65).add(0.35)).mul(mix(float(D.frost.nearFade[0]), float(1), kk)));
      rim.assign(float(1).sub(smoothstep(0, k.mul(D.frost.rim), field)).mul(mix(float(D.frost.nearFade[1]), float(1), kk)));
    });
    return vec3(field, frost, rim);
  })() as unknown as V3n;
  return { keep: r.x.greaterThan(0), frost: r.y, rim: r.z };
}

/** 鬼魂的冷光照到 P 点（法线 N，房屋坐标）的量：乘上底色就是要加的自发光（见 GHOST_GLOW） */
export function ghostGlowAt(u: DissolveUniforms, P: V3n, N: V3n): V3n {
  const G = GHOST_GLOW;
  const L = u.ghost.sub(P);
  const d = length(L);
  const nl = clamp(dot(N, L.div(max(d, 0.001))).add(G.wrap).div(1 + G.wrap), 0, 1);
  const k = d.div(G.d0);
  const fall = float(1).div(k.mul(k).add(1)).mul(float(1).sub(smoothstep(G.reach * 0.45, G.reach, d)));
  return v3(G.color).mul(u.glow.mul(fall).mul(nl));
}

export interface DissolveOptions {
  /** 鬼魂周围的洞的大小倍数（家具用 DISSOLVE.furniture）；视线胶囊不缩 */
  holeScale?: number;
  /**
   * false：不挖洞、不结霜，只有鬼魂的微光（不带 discard）。墙和家具各备一份，附近不会有洞的帧换上它：
   * 着色器里有 discard 时深度只能在着色之后写，整片墙的提前深度剔除变差（2026-10-28 实测：墙和家具一直挖洞 GPU +10%）
   */
  masked?: boolean;
  /** 不受光照的材质（MeshBasic，天花板）：底色乘这个当作环境光下的亮度，再加自发光那几项 */
  unlitAmbient?: number;
}

/**
 * 材质（墙、家具、天花板）接上溶解：maskNode 挖洞，底色上霜，再加洞口冷光和鬼魂微光（受光材质放在 emissiveNode）。
 * albedo：材质原来的底色（顶点色要自己乘进去，材质别再开 vertexColors）；P、N：房屋坐标的位置和法线。
 * maskShadowNode 恒为 true：阴影图里不挖洞（溶开的只是「看穿」，影子照旧）
 */
export function applyDissolve(
  m: THREE.MeshStandardNodeMaterial | THREE.MeshBasicNodeMaterial, u: DissolveUniforms, P: V3n, N: V3n, albedo: V3n,
  o: DissolveOptions = {},
) {
  const D = DISSOLVE;
  const glow = ghostGlowAt(u, P, N);
  const lit = m instanceof THREE.MeshStandardNodeMaterial;
  const amb = o.unlitAmbient ?? 1;
  if (o.masked === false) {
    if (lit) {
      m.colorNode = albedo;
      m.emissiveNode = albedo.mul(glow);
    } else m.colorNode = albedo.mul(glow.add(amb));
    return;
  }
  const d = dissolveAt(u, P, N, o.holeScale ?? 1);
  m.maskNode = d.keep;
  m.maskShadowNode = bool(true);
  const cover = d.frost.mul(D.frost.cover);
  const col = mix(albedo, v3(D.frostAlbedo), cover);
  // 鬼魂的微光只照没结霜的部分：霜的底色很亮，被贴得这么近的光一照会亮成一片白；霜的亮度只由 frostGlow 控制
  const emissive = v3(D.rimGlow).mul(d.rim).add(v3(D.frostGlow).mul(d.frost)).add(albedo.mul(float(1).sub(cover)).mul(glow));
  if (lit) {
    m.colorNode = col;
    m.emissiveNode = emissive;
  } else m.colorNode = col.mul(amb).add(emissive);
}

/**
 * 这一帧墙上、家具上会不会有洞或霜（保守估计，CPU 上按格子算，忽略高度）。不会的话 house.ts 换上不挖洞的那份材质。
 * pad = 噪声最大幅度 + 霜带 + 一点余量：场减去 pad 还大于 0 的地方肯定没有洞也没有霜。
 * - 鬼魂周围的扁椭球：按 DISSOLVE.ghost 的度量（面内水平距离、法线方向距离 × radius / depth）量到墙体 < radius + pad。
 *   一段连续的墙只露出两个长面（法线沿墙的厚度方向）；墙的尽头、转角、家具算不清朝向，按普通的水平距离量（更保守）
 * - 视线胶囊：水平面上「镜头 → 鬼魂」那一段到墙体 / 家具格的距离 < 最近那一点的胶囊水平半径 + pad
 */
export const HOLE_TEST = {
  pad: DISSOLVE.noise[0].amp + DISSOLVE.noise[1].amp + DISSOLVE.frost.band + 0.03,
};

/**
 * 一个会被溶开的东西在水平面上占的矩形（米）。axis：一段连续的墙的走向（0 = 东西、1 = 南北），
 * 墙的尽头、转角、T 形接头、家具为 -1（朝向算不清，按普通距离量）
 */
interface HoleBox { x0: number; z0: number; x1: number; z1: number; furniture: boolean; axis: -1 | 0 | 1 }

/**
 * 每个格子里会被溶开的东西，在水平面上按矩形列出（和 collectPieces 搭墙的方式一致）：
 * 墙格 = 中心柱 + 伸向相邻墙格（和一段墙尽头伸向门洞）的臂，拼成最多两条：东西向一条（柱 + 东西两臂）、南北向一条（柱 + 南北两臂）。
 * 一条两头都接着墙时只露出两个长面，按长面的朝向量（axis）；否则（墙的尽头、转角）端面也露着，按普通距离量。家具格算整格
 */
export function holeBoxes(tiles: Uint8Array): HoleBox[][] {
  const at = (i: number, j: number) => (inGrid(i, j) ? tiles[idx(i, j)] : -1);
  const wallish = (i: number, j: number) => at(i, j) === Tile.Wall || at(i, j) === Tile.Window;
  const out: HoleBox[][] = Array.from({ length: tiles.length }, () => []);
  const h = WALL_T / 2;
  for (let j = 0; j < GRID_H; j++) {
    for (let i = 0; i < GRID_W; i++) {
      const t = tiles[idx(i, j)];
      const x0 = i * CELL, z0 = j * CELL, x1 = x0 + CELL, z1 = z0 + CELL, cx = x0 + CELL / 2, cz = z0 + CELL / 2;
      const list = out[idx(i, j)];
      if (t === Tile.Furniture) { list.push({ x0, z0, x1, z1, furniture: true, axis: -1 }); continue; }
      if (t !== Tile.Wall && t !== Tile.Window) continue;
      const e = wallish(i + 1, j), w = wallish(i - 1, j), n = wallish(i, j - 1), sth = wallish(i, j + 1);
      // 一段直墙的尽头往门洞那边伸一条臂到格子边上（见 collectPieces 的 isEnd）
      const endE = !e && w && !n && !sth && at(i + 1, j) >= 0, endW = !w && e && !n && !sth && at(i - 1, j) >= 0;
      const endS = !sth && n && !e && !w && at(i, j + 1) >= 0, endN = !n && sth && !e && !w && at(i, j - 1) >= 0;
      if (e || w || endE || endW) {
        list.push({ x0: w || endW ? x0 : cx - h, x1: e || endE ? x1 : cx + h, z0: cz - h, z1: cz + h, furniture: false, axis: e && w ? 0 : -1 });
      }
      if (n || sth || endN || endS) {
        list.push({ x0: cx - h, x1: cx + h, z0: n || endN ? z0 : cz - h, z1: sth || endS ? z1 : cz + h, furniture: false, axis: n && sth ? 1 : -1 });
      }
      if (!list.length) list.push({ x0: cx - h, x1: cx + h, z0: cz - h, z1: cz + h, furniture: false, axis: -1 });
    }
  }
  return out;
}

/** 水平面上点到矩形的距离 */
const boxDist = (px: number, pz: number, b: HoleBox) => Math.hypot(Math.max(b.x0 - px, 0, px - b.x1), Math.max(b.z0 - pz, 0, pz - b.z1));

/** 鬼魂身体中部到矩形的扁椭球度量（见 HOLE_TEST）：连续的墙沿厚度方向的距离乘 radius / depth */
const ghostMetric = (px: number, pz: number, b: HoleBox) => {
  const dx = Math.max(b.x0 - px, 0, px - b.x1), dz = Math.max(b.z0 - pz, 0, pz - b.z1);
  const k = DISSOLVE.ghost.radius / DISSOLVE.ghost.depth;
  if (b.axis === 0) return Math.hypot(dx, dz * k);
  if (b.axis === 1) return Math.hypot(dx * k, dz);
  return Math.hypot(dx, dz);
};

/**
 * 水平面上线段 a → a + s 到矩形的最近距离和最近处的参数 t（0..1）。
 * 不相交时最近点对一定落在线段端点或矩形的角上；相交时距离为 0，t 取进入矩形的地方（Liang–Barsky）
 */
function segBox(ax: number, az: number, sx: number, sz: number, b: HoleBox): { d: number; t: number } {
  let t0 = 0, t1 = 1;
  const clip = (pp: number, qq: number) => {
    if (pp === 0) return qq >= 0;
    const r = qq / pp;
    if (pp < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (clip(-sx, ax - b.x0) && clip(sx, b.x1 - ax) && clip(-sz, az - b.z0) && clip(sz, b.z1 - az)) return { d: 0, t: t0 };
  const l2 = sx * sx + sz * sz;
  let best = boxDist(ax, az, b), bt = 0;
  const d1 = boxDist(ax + sx, az + sz, b);
  if (d1 < best) { best = d1; bt = 1; }
  for (const [px, pz] of [[b.x0, b.z0], [b.x1, b.z0], [b.x1, b.z1], [b.x0, b.z1]]) {
    const t = l2 > 1e-8 ? Math.min(1, Math.max(0, ((px - ax) * sx + (pz - az) * sz) / l2)) : 0;
    const d = Math.hypot(ax + sx * t - px, az + sz * t - pz);
    if (d < best) { best = d; bt = t; }
  }
  return { d: best, t: bt };
}

/**
 * boxes：holeBoxes 的结果；ghost：鬼魂（房屋坐标，GhostState）；cam：镜头（房屋坐标）；ortho：正交相机（胶囊两头一样粗）。
 * 返回墙、家具这一帧要不要用挖洞的那份
 */
export function holesNear(boxes: readonly HoleBox[][], ghost: { x: number; z: number }, cam: { x: number; z: number }, ortho: boolean) {
  const S = DISSOLVE.sight;
  const r0 = (ortho ? S.ghostR : S.camR) + HOLE_TEST.pad, r1 = S.ghostR + HOLE_TEST.pad;
  const gReach = DISSOLVE.ghost.radius + HOLE_TEST.pad;
  const gReachF = DISSOLVE.ghost.radius * DISSOLVE.furniture + HOLE_TEST.pad;
  const reach = Math.max(r1, gReach) + CELL;
  const sx = ghost.x - cam.x, sz = ghost.z - cam.z;
  const i0 = Math.max(0, Math.floor((Math.min(ghost.x, cam.x) - reach) / CELL));
  const i1 = Math.min(GRID_W - 1, Math.floor((Math.max(ghost.x, cam.x) + reach) / CELL));
  const j0 = Math.max(0, Math.floor((Math.min(ghost.z, cam.z) - reach) / CELL));
  const j1 = Math.min(GRID_H - 1, Math.floor((Math.max(ghost.z, cam.z) + reach) / CELL));
  const out = { walls: false, furniture: false };
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      for (const b of boxes[idx(i, j)]) {
        if (b.furniture ? out.furniture : out.walls) continue;
        let hit = ghostMetric(ghost.x, ghost.z, b) < (b.furniture ? gReachF : gReach);
        if (!hit) {
          const c = segBox(cam.x, cam.z, sx, sz, b);
          hit = c.d < r0 + (r1 - r0) * c.t;
        }
        if (hit) {
          if (b.furniture) out.furniture = true;
          else out.walls = true;
          if (out.walls && out.furniture) return out;
        }
      }
    }
  }
  return out;
}

/** 墙的高度：每面外墙一个 uniform，内墙固定降低 */
function heightNode(hU: FloatU[]) {
  const hOf = (g: THREE.Node<'float'>) => select(g.lessThan(0.5), hU[0],
    select(g.lessThan(1.5), hU[1], select(g.lessThan(2.5), hU[2], select(g.lessThan(3.5), hU[3], hU[4]))));
  const wg = attribute('wg', 'vec2');
  return max(hOf(wg.x), hOf(wg.y));
}

/** 按当前高度压低顶点：底边在当前高度以上的块整块收到地板下 */
function loweredPosition(hU: FloatU[]) {
  const h = heightNode(hU);
  const y0 = attribute('y0', 'float');
  const p = positionLocal;
  const y = select(h.greaterThan(y0.add(0.001)), min(p.y, h), float(-0.05));
  return vec3(p.x, y, p.z);
}

/** dissolve 不为空：第三人称模式，墙面在鬼魂周围和视线上溶开（见 DISSOLVE）；masked = false 是不挖洞的那份（见 HOLE_TEST） */
function wallMaterial(hU: FloatU[], dissolve?: DissolveUniforms, masked = true) {
  const m = new THREE.MeshStandardNodeMaterial({ flatShading: true, roughness: 0.92, metalness: 0 });
  const pos = loweredPosition(hU);
  m.positionNode = pos;
  const p = varying(pos);
  const kind = attribute('kind', 'float');
  // 沿墙方向的坐标：法线朝 x 的面用 z，朝 z 的面用 x
  const along = select(abs(normalLocal.x).greaterThan(0.5), p.z, p.x);
  const y = p.y;

  // 室内：踢脚线、护墙板（降低后能看到的就是这一段）、腰线、竖条纹墙纸、顶线
  const panel = smoothstep(0.0, 0.02, abs(fract(along.div(0.5)).sub(0.5)).mul(0.5)).mul(0.12).add(0.88);
  const stripe = select(fract(along.div(0.16)).lessThan(0.5), float(1.0), float(0.86));
  const wainscot = v3(mixHex(PALETTE.woodDark, PALETTE.wood, 0.35)).mul(panel);
  const paper = v3(PALETTE.wallpaper).mul(stripe);
  const inner = select(y.lessThan(0.1), v3(PALETTE.wallTrim),
    select(y.lessThan(0.82), wainscot,
      select(y.lessThan(0.9), v3(PALETTE.wood),
        select(y.greaterThan(WALL_H - 0.12), v3(PALETTE.wallTrim), paper))));

  // 屋外：错缝的深色石块，灰缝略暗
  const row = floor(y.div(0.3));
  const shift = fract(row.mul(0.5)).mul(0.6);
  const blockX = along.add(shift).div(0.6);
  const block = floor(blockX);
  const tone = hash(row.mul(37).add(block).add(500)).mul(0.25).add(0.85);
  const mortar = smoothstep(0.0, 0.03, min(fract(blockX).mul(0.6), fract(y.div(0.3)).mul(0.3))).mul(0.35).add(0.65);
  const outer = v3(mixHex(PALETTE.tile, PALETTE.wallTrim, 0.55)).mul(tone).mul(mortar);

  const cap = v3(mixHex(PALETTE.wallpaper, PALETTE.moonSky, 0.18));
  const trim = v3(PALETTE.woodDark);
  const base = select(kind.lessThan(0.5), inner, select(kind.lessThan(1.5), outer, select(kind.lessThan(2.5), cap, trim)));
  // 法线用新的 attribute('normal')（片元里是 varying 输入，哪里读都有值），不用 normalLocal：normalLocal 是私有变量，
  // 只在上面 select 的某几个分支里赋值（算 along 的那几支），分支外读到的可能是 0（踢脚线、腰线、顶线、窗框那几种面）
  if (dissolve) applyDissolve(m, dissolve, p, attribute('normal', 'vec3'), base, { masked });
  else m.colorNode = base;
  return m;
}

function glassMaterial(hU: FloatU[], dissolve?: DissolveUniforms) {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pos = loweredPosition(hU);
  m.positionNode = pos;
  const t = uv();
  const panes = attribute('panes', 'float');
  const pane = floor(t.x.mul(panes)).add(floor(t.y.mul(2)).mul(7));
  // 上亮下暗，每块玻璃亮度略有不同（旧玻璃不平）
  const glow = t.y.mul(0.6).add(0.4).mul(hash(pane.add(91)).mul(0.35).add(0.65));
  const base = v3(PALETTE.moonSky).mul(glow).mul(0.12);
  if (dissolve) {
    // 鬼魂贴近窗户：玻璃跟着墙溶开，洞边的玻璃上一层霜（加法混合，霜就是玻璃上多出来的一点冷光）
    const d = dissolveAt(dissolve, varying(pos), attribute('normal', 'vec3'));
    m.maskNode = d.keep;
    m.colorNode = base.add(v3(DISSOLVE.frostGlow).mul(d.frost.mul(2.5))).add(v3(DISSOLVE.rimGlow).mul(d.rim));
  } else m.colorNode = base;
  return m;
}

// ───────────────────────── 对外接口 ─────────────────────────

/**
 * 每面外墙「全高」的程度 0..1（按 Side 编号，0 = 降低、1 = 全高）：最近建好的那一份墙的读数（createWalls 里指到它的 fullness，house.ts 每帧推进）。
 * 只读：前门的门板（view/frontDoor.ts）在娃娃屋模式南墙降低时跟着藏起来，读它；第三人称模式墙一直全高，读到的一直是 1
 */
export let wallFullness: readonly number[] = [1, 1, 1, 1];

export interface Walls {
  /** 可见墙 + 玻璃（挂到 houseRoot） */
  group: THREE.Group;
  /** 只投影的全高墙（layer 1，castShadow；挂到 houseRoot） */
  shadowCaster: THREE.Mesh;
  runs: WindowRun[];
  /** 每面外墙「全高」的程度 0..1（按 Side 编号，0 = 降低、1 = 全高），月光光斑用 */
  fullness: readonly number[];
  /** 每帧调：按 viewDir 算哪两面是远墙，0.3 秒平滑升降（第三人称模式下墙一直全高，什么也不做） */
  update(dt: number, viewDir: Vec2): void;
  /**
   * 第三人称模式：这一帧用挖洞的那份墙（true）还是不挖洞的那份（false，没有 discard，见 HOLE_TEST）。
   * 两份开局都显示着（一起预编译），第一次调用之后只显示一份
   */
  setHoles(on: boolean): void;
  dispose(): void;
}

export interface WallsOptions {
  /** 第三人称模式：所有墙（含内墙）一直全高，不按镜头降低 */
  fullHeight?: boolean;
  /** 第三人称模式：墙面、玻璃在鬼魂周围和视线上溶开（见 DISSOLVE） */
  dissolve?: DissolveUniforms;
}

/** 远墙：外法线和「从房子指向相机」的方向点积 < 0 */
export const isFar = (side: Side, viewDir: Vec2) => OUTWARD[side][0] * viewDir.x + OUTWARD[side][1] * viewDir.z < 0;

const smooth = (t: number) => t * t * (3 - 2 * t);

export function createWalls(tiles: Uint8Array, viewDir: Vec2, opts: WallsOptions = {}): Walls {
  const pieces = collectPieces(tiles);
  const runs = windowRuns();
  const full = opts.fullHeight === true;
  const fullness: number[] = [0, 1, 2, 3].map((s) => (full || isFar(s as Side, viewDir) ? 1 : 0));
  wallFullness = fullness; // 同一个数组：update 推进它，上面的只读导出就跟着走
  const hU: FloatU[] = [0, 1, 2, 3].map((s) => uniform(WALL_CUT_H + (WALL_H - WALL_CUT_H) * fullness[s]));
  hU.push(uniform(full ? WALL_H : WALL_CUT_H));

  const group = new THREE.Group();
  group.name = 'walls';
  const geometry = buildVisible(pieces);
  const visible = new THREE.Mesh(geometry, wallMaterial(hU, opts.dissolve));
  visible.name = 'walls-visible';
  // 第三人称：同一份几何体再配一份不挖洞的材质，附近没有洞的帧用它
  const solid = opts.dissolve ? new THREE.Mesh(geometry, wallMaterial(hU, opts.dissolve, false)) : null;
  if (solid) solid.name = 'walls-visible-solid';
  for (const m of solid ? [visible, solid] : [visible]) {
    m.receiveShadow = true;
    m.castShadow = false; // 投影交给 layer 1 的全高副本
    // 顶点着色器会改高度，包围球按全高算就够了；不让它被错误地视锥剔除
    m.frustumCulled = false;
    group.add(m);
  }

  const glass = new THREE.Mesh(buildGlass(runs), glassMaterial(hU, opts.dissolve));
  glass.name = 'window-glass';
  glass.renderOrder = 2;
  glass.frustumCulled = false;
  group.add(glass);

  // 阴影画正面（r186 默认画背面）：降低的墙顶面在这个全高实体的「里面」，画背面时光线在实体里穿过的
  // 柱、臂之间的内侧面会先被记下，墙顶出现锯齿；画正面时记下的总是光进入实体的那个面，内侧面不起作用。
  // 代价：墙顶不再被手电照亮（保持暗色的剖面线），照亮的墙面靠灯的 bias 防自阴影
  const shadowMat = new THREE.MeshBasicNodeMaterial();
  shadowMat.shadowSide = THREE.FrontSide;
  const shadowCaster = new THREE.Mesh(buildShadowOnly(pieces), shadowMat);
  shadowCaster.name = 'walls-shadow-only';
  shadowCaster.layers.set(1);
  shadowCaster.castShadow = true;
  shadowCaster.receiveShadow = false;

  return {
    group, shadowCaster, runs, fullness,
    setHoles(on) {
      if (!solid) return;
      visible.visible = on;
      solid.visible = !on;
    },
    update(dt, dir) {
      if (full) return;
      for (let s = 0; s < 4; s++) {
        const target = isFar(s as Side, dir) ? 1 : 0;
        const f = fullness[s];
        if (f === target) continue;
        const step = dt / LOWER_TIME;
        fullness[s] = target > f ? Math.min(target, f + step) : Math.max(target, f - step);
        hU[s].value = WALL_CUT_H + (WALL_H - WALL_CUT_H) * smooth(fullness[s]);
      }
    },
    dispose() {
      geometry.dispose();
      (visible.material as THREE.Material).dispose();
      (solid?.material as THREE.Material | undefined)?.dispose();
      glass.geometry.dispose();
      (glass.material as THREE.Material).dispose();
      shadowCaster.geometry.dispose();
      (shadowCaster.material as THREE.Material).dispose();
    },
  };
}
