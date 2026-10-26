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
import * as THREE from 'three/webgpu';
import {
  abs, attribute, float, floor, fract, hash, max, min, normalLocal, positionLocal, select,
  smoothstep, uniform, uv, varying, vec3,
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

function wallMaterial(hU: FloatU[]) {
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
  m.colorNode = select(kind.lessThan(0.5), inner, select(kind.lessThan(1.5), outer, select(kind.lessThan(2.5), cap, trim)));
  return m;
}

function glassMaterial(hU: FloatU[]) {
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  m.positionNode = loweredPosition(hU);
  const t = uv();
  const panes = attribute('panes', 'float');
  const pane = floor(t.x.mul(panes)).add(floor(t.y.mul(2)).mul(7));
  // 上亮下暗，每块玻璃亮度略有不同（旧玻璃不平）
  const glow = t.y.mul(0.6).add(0.4).mul(hash(pane.add(91)).mul(0.35).add(0.65));
  m.colorNode = v3(PALETTE.moonSky).mul(glow).mul(0.12);
  return m;
}

// ───────────────────────── 对外接口 ─────────────────────────

export interface Walls {
  /** 可见墙 + 玻璃（挂到 houseRoot） */
  group: THREE.Group;
  /** 只投影的全高墙（layer 1，castShadow；挂到 houseRoot） */
  shadowCaster: THREE.Mesh;
  runs: WindowRun[];
  /** 每面外墙「全高」的程度 0..1（按 Side 编号，0 = 降低、1 = 全高），月光光斑用 */
  fullness: readonly number[];
  /** 每帧调：按 viewDir 算哪两面是远墙，0.3 秒平滑升降 */
  update(dt: number, viewDir: Vec2): void;
  dispose(): void;
}

/** 远墙：外法线和「从房子指向相机」的方向点积 < 0 */
export const isFar = (side: Side, viewDir: Vec2) => OUTWARD[side][0] * viewDir.x + OUTWARD[side][1] * viewDir.z < 0;

const smooth = (t: number) => t * t * (3 - 2 * t);

export function createWalls(tiles: Uint8Array, viewDir: Vec2): Walls {
  const pieces = collectPieces(tiles);
  const runs = windowRuns();
  const fullness: number[] = [0, 1, 2, 3].map((s) => (isFar(s as Side, viewDir) ? 1 : 0));
  const hU: FloatU[] = [0, 1, 2, 3].map((s) => uniform(WALL_CUT_H + (WALL_H - WALL_CUT_H) * fullness[s]));
  hU.push(uniform(WALL_CUT_H));

  const group = new THREE.Group();
  group.name = 'walls';
  const visible = new THREE.Mesh(buildVisible(pieces), wallMaterial(hU));
  visible.name = 'walls-visible';
  visible.receiveShadow = true;
  visible.castShadow = false; // 投影交给 layer 1 的全高副本
  // 顶点着色器会改高度，包围球按全高算就够了；不让它被错误地视锥剔除
  visible.frustumCulled = false;
  group.add(visible);

  const glass = new THREE.Mesh(buildGlass(runs), glassMaterial(hU));
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
    update(dt, dir) {
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
      visible.geometry.dispose();
      (visible.material as THREE.Material).dispose();
      glass.geometry.dispose();
      (glass.material as THREE.Material).dispose();
      shadowCaster.geometry.dispose();
      (shadowCaster.material as THREE.Material).dispose();
    },
  };
}
