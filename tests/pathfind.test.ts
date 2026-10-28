import { describe, expect, test } from 'vitest';
import { Grid } from '../src/sim/grid';
import { findCellPath, findPath } from '../src/sim/pathfind';
import { cellCenter, cellOf, GRID_H, GRID_W, idx, Tile } from '../src/config/house';
import type { Vec2 } from '../src/sim/types';

const g = new Grid();

/** 沿折线每 step 米采样（含起点和每个路点） */
function samples(from: Vec2, path: Vec2[], step = 0.1): Vec2[] {
  const out: Vec2[] = [];
  let a = from;
  for (const b of path) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
    a = b;
  }
  return out;
}

const passes = (pts: Vec2[], row: number, cols: number[]) =>
  pts.some((p) => {
    const [i, j] = cellOf(p.x, p.z);
    return j === row && cols.includes(i);
  });

describe('findPath', () => {
  // 计划里写的是 (2.25, 6.25)，但那个点在走廊（第 12 行）；这里用书房里的 (2.25, 2.25)，才会经过书房门洞
  const study = { x: 2.25, z: 2.25 };
  const bathroom = { x: 13.5, z: 9.0 };

  test('书房 → 浴室：有路径，路点都可走，相邻路点之间的直线不穿墙', () => {
    const path = findPath(g, study, bathroom);
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(0);
    for (const p of path!) expect(g.walkableAt(p)).toBe(true);
    for (const p of samples(study, path!)) expect(g.walkableAt(p)).toBe(true);
    // 终点就是给定的点（它能走）
    expect(path![path!.length - 1]).toEqual(bathroom);
  });

  test('书房 → 浴室：经过书房门洞（第 9 行、第 4–5 列）和浴室门洞（第 14 行、第 25–26 列）', () => {
    const pts = samples(study, findPath(g, study, bathroom)!);
    expect(passes(pts, 9, [4, 5])).toBe(true);
    expect(passes(pts, 14, [25, 26])).toBe(true);
  });

  test('计划里的起点 (2.25, 6.25)（走廊）也能走到浴室，且不穿墙', () => {
    const from = { x: 2.25, z: 6.25 };
    const path = findPath(g, from, bathroom)!;
    expect(path).not.toBeNull();
    for (const p of samples(from, path)) expect(g.walkableAt(p)).toBe(true);
    expect(passes(samples(from, path), 14, [25, 26])).toBe(true);
  });

  test('终点在墙里 (5.25, 4.75)：返回走到最近可走格的路径，不返回 null', () => {
    const from = { x: 2.25, z: 2.25 };
    const path = findPath(g, from, { x: 5.25, z: 4.75 });
    expect(path).not.toBeNull();
    const last = path![path!.length - 1];
    expect(cellOf(last.x, last.z)).toEqual(g.nearestWalkable({ x: 5.25, z: 4.75 }));
    expect(last).toEqual(cellCenter(10, 10));
    for (const p of samples(from, path!)) expect(g.walkableAt(p)).toBe(true);
  });

  test('起点不能走（站在家具上）：先走到最近的可走格，之后不穿墙', () => {
    const from = { x: 13, z: 2.5 }; // 厨房餐桌（第 26 列第 5 行）
    expect(g.walkableAt(from)).toBe(false);
    const path = findPath(g, from, { x: 2.25, z: 10.25 })!;
    expect(path).not.toBeNull();
    expect(g.walkableAt(path[0])).toBe(true);
    for (const p of samples(path[0], path.slice(1))) expect(g.walkableAt(p)).toBe(true);
  });

  test('不含起点；同一格里直接返回终点', () => {
    const from = { x: 6.1, z: 6.1 };
    const to = { x: 6.4, z: 6.4 };
    expect(findPath(g, from, to)).toEqual([to]);
  });

  test('路径平滑：走廊里一条直线只剩一个路点', () => {
    const path = findPath(g, { x: 1.25, z: 6.25 }, { x: 15.25, z: 6.25 })!;
    expect(path).toEqual([{ x: 15.25, z: 6.25 }]);
  });

  test('路径平滑：中间每段都离墙至少 0.2 米（采样点垂直方向 ±0.2 米都可走）', () => {
    const cases: [Vec2, Vec2][] = [
      [study, bathroom],
      [{ x: 14.25, z: 2.75 }, { x: 2.75, z: 10.5 }],
      [{ x: 8, z: 10.6 }, { x: 8.25, z: 2.75 }],
    ];
    for (const [from, to] of cases) {
      const path = findPath(g, from, to)!;
      // 第一段（从起点出发）和最后一段（到给定终点）可能贴墙，只检查中间的段
      for (let k = 0; k + 1 < path.length - 1; k++) {
        const a = path[k], b = path[k + 1];
        const len = Math.hypot(b.x - a.x, b.z - a.z);
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        for (const p of samples(a, [b])) {
          expect(g.walkableAt({ x: p.x + nx * 0.2, z: p.z + nz * 0.2 })).toBe(true);
          expect(g.walkableAt({ x: p.x - nx * 0.2, z: p.z - nz * 0.2 })).toBe(true);
        }
      }
    }
  });

  test('平滑后的路径比格子路径短得多：书房 → 浴室不超过 12 个路点', () => {
    expect(findPath(g, study, bathroom)!.length).toBeLessThanOrEqual(12);
  });

  test('斜走不切墙角：两个正交邻格都是墙时走不过去', () => {
    const t = new Uint8Array(GRID_W * GRID_H).fill(Tile.Floor);
    t[idx(1, 0)] = Tile.Wall;
    t[idx(0, 1)] = Tile.Wall;
    const g2 = new Grid(t);
    expect(findPath(g2, cellCenter(0, 0), cellCenter(1, 1))).toBeNull();
    // 只挡一边也不能斜着切过去：路径要绕开墙角
    t[idx(0, 1)] = Tile.Floor;
    const g3 = new Grid(t);
    const path = findPath(g3, cellCenter(0, 0), cellCenter(1, 1))!;
    expect(path).not.toBeNull();
    for (const p of samples(cellCenter(0, 0), path, 0.02)) expect(g3.walkableAt(p)).toBe(true);
  });

  test('到不了的地方返回 null', () => {
    const t = new Uint8Array(GRID_W * GRID_H).fill(Tile.Floor);
    for (let j = 0; j < GRID_H; j++) t[idx(10, j)] = Tile.Wall;
    const g2 = new Grid(t);
    expect(findPath(g2, cellCenter(2, 2), cellCenter(20, 2))).toBeNull();
  });

  test('斜步代价 √2：空地上横着走是直线，斜着走是对角线', () => {
    const g2 = new Grid(new Uint8Array(GRID_W * GRID_H).fill(Tile.Floor));
    // 斜步代价若是 1，横走时会出现之字形（代价相同）；√2 时直线最便宜
    const straight = findCellPath(g2, [2, 2], [12, 2])!;
    expect(straight.length).toBe(11);
    expect(straight.every(([, j]) => j === 2)).toBe(true);
    // 斜步代价若是 2（不许斜走），要走 21 格
    expect(findCellPath(g2, [2, 2], [12, 12])!.length).toBe(11);
    expect(findCellPath(g2, [2, 2], [12, 7])!.length).toBe(11);
  });

  test('能走到每个房间（从门厅出发）', () => {
    const from = { x: 8, z: 10.6 };
    const targets = [
      { x: 2.75, z: 2.75 }, { x: 8.25, z: 2.75 }, { x: 13.25, z: 3.25 }, { x: 13.25, z: 6.25 },
      { x: 2.75, z: 9.25 }, { x: 13.25, z: 9.25 }, { x: 8, z: 11.75 },
    ];
    for (const to of targets) {
      const path = findPath(g, from, to);
      expect(path).not.toBeNull();
      for (const p of samples(from, path!)) expect(g.walkableAt(p)).toBe(true);
    }
  });
});

describe('findPath：绕开现身的地方（avoid，圆里的格子代价 × AVOID_COST）', () => {
  // 门厅：5 米 × 4 米，中间放一个半径 1 米的圈，圈上下各剩 1 米能走
  const from = { x: 6, z: 9.5 }, to = { x: 10, z: 9.5 };
  const zone = { pos: { x: 8, z: 9.5 }, r: 1, until: 10 };
  const closest = (pts: Vec2[]) => Math.min(...pts.map((p) => Math.hypot(p.x - zone.pos.x, p.z - zone.pos.z)));

  test('能绕就绕：没有圈时直线穿过圈心，有圈时一路都在圈外；过期的圈不算', () => {
    expect(closest(samples(from, findPath(g, from, to)!))).toBeLessThan(0.1);
    const around = findPath(g, from, to, [zone], 5)!;
    for (const p of samples(from, around)) expect(g.walkableAt(p)).toBe(true);
    expect(closest(samples(from, around))).toBeGreaterThanOrEqual(zone.r - 1e-6);
    expect(findPath(g, from, to, [zone], 10)).toEqual(findPath(g, from, to)); // until <= now：过期
  });

  test('绕不开也走得通：起点在圈里，先往外走，不抄近路穿过圈心那边', () => {
    const start = { x: 7.4, z: 9.5 }; // 圈里，离圈心 0.6 米
    const path = findPath(g, start, to, [zone], 5)!;
    expect(path).not.toBeNull();
    expect(closest(samples(start, path))).toBeGreaterThanOrEqual(0.6 - 0.1);
    expect(path[path.length - 1]).toEqual(to);
  });
});
