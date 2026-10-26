// 寻路：格子上的 8 方向 A*（斜走不切墙角，斜步代价 √2），再把格子路径拉直成少量路点。
import { cellCenter, GRID_H, GRID_W, idx } from '../config/house';
import type { Grid } from './grid';
import type { Vec2 } from './types';

/** 平滑时沿线段采样的间隔（米） */
const SAMPLE_STEP = 0.1;
/** 平滑后的线段离墙至少这么远（米）：采样点垂直方向 ±这么远都要在可走格里，访客才不会贴着墙角蹭过去 */
const CLEARANCE = 0.2;

const SQRT2 = Math.SQRT2;
// 8 个方向：前 4 个正交，后 4 个斜向
const DI = [1, -1, 0, 0, 1, 1, -1, -1];
const DJ = [0, 0, 1, -1, 1, -1, 1, -1];

/** 八方向距离：在只能横竖斜走、斜步 √2 的格子上，这是可采纳且一致的启发值 */
const octile = (di: number, dj: number) => {
  const a = Math.abs(di), b = Math.abs(dj);
  return a + b + (SQRT2 - 2) * Math.min(a, b);
};

/**
 * 格子上的 A*。起点、终点都要是可走格；返回含起点和终点的格子序列，到不了返回 null。
 * 同 f 值时优先展开 g 大的（离终点近的），路径更直、展开的格子更少。
 */
export function findCellPath(grid: Grid, start: [number, number], end: [number, number]): [number, number][] | null {
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
      const ng = g[cur] + (d >= 4 ? SQRT2 : 1);
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
 * - 最后做平滑：两个路点之间的线段离墙足够远，就删掉中间的路点
 */
export function findPath(grid: Grid, from: Vec2, to: Vec2): Vec2[] | null {
  const start = grid.nearestWalkable(from);
  const end = grid.nearestWalkable(to, from);
  const goal = grid.walkableAt(to) ? { x: to.x, z: to.z } : cellCenter(end[0], end[1]);
  if (start[0] === end[0] && start[1] === end[1]) return [goal];
  const cells = findCellPath(grid, start, end);
  if (!cells) return null;
  const pts: Vec2[] = [{ x: from.x, z: from.z }];
  if (!grid.walkableAt(from)) pts.push(cellCenter(start[0], start[1]));
  for (let k = 1; k < cells.length - 1; k++) pts.push(cellCenter(cells[k][0], cells[k][1]));
  pts.push(goal);
  return smoothPath(grid, pts).slice(1);
}

/**
 * 拉直路径（含起点）：从当前锚点出发，能直接走到下一个的下一个路点就删掉中间那个，否则把它定为新锚点。
 * 判断「能直接走」：线段上每 SAMPLE_STEP 米采样，采样点和它垂直方向 ±CLEARANCE 处都在可走格里。
 */
export function smoothPath(grid: Grid, pts: Vec2[]): Vec2[] {
  if (pts.length <= 2) return pts.slice();
  const out: Vec2[] = [pts[0]];
  let anchor = pts[0];
  for (let k = 1; k < pts.length - 1; k++) {
    if (segmentClear(grid, anchor, pts[k + 1])) continue; // pts[k] 可以删
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
