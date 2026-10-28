// 寻路：格子上的 8 方向 A*（斜走不切墙角，斜步代价 √2），再把格子路径拉直成少量路点。
// 2026-10-28（设计文档 3.2）：访客看见现身以后暂时绕开的圆（WorldState.avoid）里的格子代价乘 AVOID_COST，
// 能绕就绕、绕不开（起点、终点在圈里）照样走得通；拉直时不会抄近路穿过圈子
import { cellCenter, cellOf, GRID_H, GRID_W, idx, inGrid } from '../config/house';
import type { Grid } from './grid';
import type { AvoidZone, Vec2 } from './types';

/** 平滑时沿线段采样的间隔（米） */
const SAMPLE_STEP = 0.1;
/** 平滑后的线段离墙至少这么远（米）：采样点垂直方向 ±这么远都要在可走格里，访客才不会贴着墙角蹭过去 */
const CLEARANCE = 0.2;

const SQRT2 = Math.SQRT2;
// 8 个方向：前 4 个正交，后 4 个斜向
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

/** 绕开的圆里的格子：走进去的一步代价乘这么多（不是完全不能走） */
export const AVOID_COST = 20;

/** 还没过期（until > now）的圆 */
export const activeZones = (avoid: readonly AvoidZone[], now: number): AvoidZone[] => avoid.filter((z) => z.until > now);

/** 这一点在不在某个圆里 */
export const inZones = (zones: readonly AvoidZone[], p: Vec2): boolean =>
  zones.some((z) => (p.x - z.pos.x) ** 2 + (p.z - z.pos.z) ** 2 < z.r * z.r);

/** 每格的代价系数：格子中心在某个圆里为 AVOID_COST，其余 1；没有圆返回 null（全是 1） */
function zoneCost(zones: readonly AvoidZone[]): Float32Array | null {
  if (zones.length === 0) return null;
  const cost = new Float32Array(GRID_W * GRID_H).fill(1);
  for (const z of zones) {
    const [i0, j0] = cellOf(z.pos.x - z.r, z.pos.z - z.r), [i1, j1] = cellOf(z.pos.x + z.r, z.pos.z + z.r);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!inGrid(i, j)) continue;
        const c = cellCenter(i, j);
        if ((c.x - z.pos.x) ** 2 + (c.z - z.pos.z) ** 2 < z.r * z.r) cost[idx(i, j)] = AVOID_COST;
      }
    }
  }
  return cost;
}

/** 八方向距离：在只能横竖斜走、斜步 √2 的格子上，这是可采纳且一致的启发值（代价系数都 ≥ 1，加了绕开的圆也一样） */
const octile = (di: number, dj: number) => {
  const a = Math.abs(di), b = Math.abs(dj);
  return a + b + (SQRT2 - 2) * Math.min(a, b);
};

/**
 * 格子上的 A*。起点、终点都要是可走格；返回含起点和终点的格子序列，到不了返回 null。
 * 同 f 值时优先展开 g 大的（离终点近的），路径更直、展开的格子更少。
 * cost：每格的代价系数（走进那一格的一步乘它，见 zoneCost）；不给就全是 1
 */
export function findCellPath(grid: Grid, start: [number, number], end: [number, number], cost: Float32Array | null = null): [number, number][] | null {
  const [si, sj] = start, [ei, ej] = end;
  if (!grid.isWalkable(si, sj) || !grid.isWalkable(ei, ej)) return null;
  const n = GRID_W * GRID_H;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const s = idx(si, sj), e = idx(ei, ej);
  g[s] = 0;
  heap.push(s, octile(ei - si, ej - sj), 0);
  while (heap.size > 0) {
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (cur === e) break;
    const ci = cur % GRID_W, cj = (cur - ci) / GRID_W;
    for (let d = 0; d < 8; d++) {
      const ni = ci + DI[d], nj = cj + DJ[d];
      if (!grid.isWalkable(ni, nj)) continue;
      // 斜走时两个正交邻格都要能走，不切墙角
      if (d >= 4 && (!grid.isWalkable(ci + DI[d], cj) || !grid.isWalkable(ci, cj + DJ[d]))) continue;
      const k = idx(ni, nj);
      if (closed[k]) continue;
      const ng = g[cur] + (d >= 4 ? SQRT2 : 1) * (cost ? cost[k] : 1);
      if (ng < g[k] - 1e-12) {
        g[k] = ng;
        came[k] = cur;
        heap.push(k, ng + octile(ei - ni, ej - nj), ng);
      }
    }
  }
  if (!closed[e]) return null;
  const out: [number, number][] = [];
  for (let k = e; k !== -1; k = came[k]) out.push([k % GRID_W, Math.floor(k / GRID_W)]);
  return out.reverse();
}

/**
 * 从 from 到 to 的路点（米坐标，不含起点）。到不了返回 null。
 * - 起点或终点不能走时，改用离它最近的可走格（终点那一格挑靠近起点的一侧）
 * - 中间路点是格子中心；终点能走时最后一个路点就是 to 本身，否则是最近可走格的中心
 * - 起点不能走（比如站在家具上、在门外）时，先走到最近可走格的中心
 * - 最后做平滑：两个路点之间的线段离墙足够远（也不比两头更深地穿进要绕开的圆），就删掉中间的路点
 * - avoid / now：要绕开的圆（看见现身以后，WorldState.avoid）和此刻的模拟时间，过期的不算；圆里的格子代价 × AVOID_COST
 */
export function findPath(grid: Grid, from: Vec2, to: Vec2, avoid: readonly AvoidZone[] = [], now = 0): Vec2[] | null {
  const start = grid.nearestWalkable(from);
  const end = grid.nearestWalkable(to, from);
  const goal = grid.walkableAt(to) ? { x: to.x, z: to.z } : cellCenter(end[0], end[1]);
  if (start[0] === end[0] && start[1] === end[1]) return [goal];
  const zones = avoid.length > 0 ? activeZones(avoid, now) : [];
  const cells = findCellPath(grid, start, end, zoneCost(zones));
  if (!cells) return null;
  const pts: Vec2[] = [{ x: from.x, z: from.z }];
  if (!grid.walkableAt(from)) pts.push(cellCenter(start[0], start[1]));
  for (let k = 1; k < cells.length - 1; k++) pts.push(cellCenter(cells[k][0], cells[k][1]));
  pts.push(goal);
  return smoothPath(grid, pts, zones).slice(1);
}

/**
 * 拉直路径（含起点）：从当前锚点出发，能直接走到下一个的下一个路点就删掉中间那个，否则把它定为新锚点。
 * 判断「能直接走」：线段上每 SAMPLE_STEP 米采样，采样点和它垂直方向 ±CLEARANCE 处都在可走格里；
 * 还要不比两头更深地穿进 zones 里的圆（见 segmentAvoids）
 */
export function smoothPath(grid: Grid, pts: Vec2[], zones: readonly AvoidZone[] = []): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let anchor = pts[0];
  for (let k = 1; k < pts.length - 1; k++) {
    if (segmentClear(grid, anchor, pts[k + 1]) && segmentAvoids(anchor, pts[k + 1], zones)) continue; // pts[k] 可以删
    out.push(pts[k]);
    anchor = pts[k];
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** 线段 a→b 离墙够不够远（见 smoothPath） */
export function segmentClear(grid: Grid, a: Vec2, b: Vec2): boolean {
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) return grid.walkableAt(a);
  const nx = (-dz / len) * CLEARANCE, nz = (dx / len) * CLEARANCE;
  const steps = Math.max(1, Math.ceil(len / SAMPLE_STEP));
  const p = { x: 0, z: 0 };
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + dx * t, z = a.z + dz * t;
    p.x = x; p.z = z;
    if (!grid.walkableAt(p)) return false;
    p.x = x + nx; p.z = z + nz;
    if (!grid.walkableAt(p)) return false;
    p.x = x - nx; p.z = z - nz;
    if (!grid.walkableAt(p)) return false;
  }
  return true;
}

/**
 * 线段 a→b 不比两头更深地穿进任何一个圆：离圆心最近处不小于 min(半径, a 离圆心, b 离圆心)。
 * 两头都在圈外时就是不穿过圈子；起点在圈里时可以往外走，但不能抄近路穿过圆心那一边
 */
function segmentAvoids(a: Vec2, b: Vec2, zones: readonly AvoidZone[]): boolean {
  for (const z of zones) {
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 1e-12 ? Math.max(0, Math.min(1, ((z.pos.x - a.x) * dx + (z.pos.z - a.z) * dz) / l2)) : 0;
    const near = Math.hypot(a.x + dx * t - z.pos.x, a.z + dz * t - z.pos.z);
    const ends = Math.min(z.r, Math.hypot(a.x - z.pos.x, a.z - z.pos.z), Math.hypot(b.x - z.pos.x, b.z - z.pos.z));
    if (near < ends - 1e-6) return false;
  }
  return true;
}

/** A* 用的二叉最小堆：按 f 排，f 相同时 g 大的先出；允许重复压入，出堆时跳过已关闭的 */
class MinHeap {
  private items: number[] = [];
  private f: number[] = [];
  private g: number[] = [];
  get size() { return this.items.length; }

  push(item: number, f: number, g: number) {
    const a = this.items, fs = this.f, gs = this.g;
    let i = a.length;
    a.push(item); fs.push(f); gs.push(g);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const a = this.items, fs = this.f, gs = this.g;
    const top = a[0];
    const last = a.length - 1;
    a[0] = a[last]; fs[0] = fs[last]; gs[0] = gs[last];
    a.pop(); fs.pop(); gs.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < a.length && this.less(l, m)) m = l;
      if (r < a.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }

  private less(i: number, j: number) {
    const df = this.f[i] - this.f[j];
    if (Math.abs(df) > 1e-9) return df < 0;
    return this.g[i] > this.g[j];
  }

  private swap(i: number, j: number) {
    const a = this.items, fs = this.f, gs = this.g;
    [a[i], a[j]] = [a[j], a[i]];
    [fs[i], fs[j]] = [fs[j], fs[i]];
    [gs[i], gs[j]] = [gs[j], gs[i]];
  }
}
