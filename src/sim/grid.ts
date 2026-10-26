// 格子地图：哪里能走、哪里挡视线。数据来自 config/house.ts 的 buildTiles()。
// 格子外（屋外）当作「不能走、但也不挡视线」的空地：门外的访客能透过前门看进来。
import { blocksSight, buildTiles, cellCenter, cellOf, GRID_H, GRID_W, idx, walkable } from '../config/house';
import type { Tile } from '../config/house';
import type { Vec2 } from './types';

/** 距离比较用的容差（平方米），用来判断「一样近」 */
const TIE_EPS = 1e-9;

export class Grid {
  readonly tiles: Uint8Array;
  /** 预先算好的查表：1 = 能走 / 挡视线 */
  private readonly walk: Uint8Array;
  private readonly opaque: Uint8Array;

  constructor(tiles: Uint8Array = buildTiles()) {
    this.tiles = tiles;
    this.walk = new Uint8Array(tiles.length);
    this.opaque = new Uint8Array(tiles.length);
    for (let k = 0; k < tiles.length; k++) {
      this.walk[k] = walkable(tiles[k] as Tile) ? 1 : 0;
      this.opaque[k] = blocksSight(tiles[k] as Tile) ? 1 : 0;
    }
  }

  isWalkable(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < GRID_W && j < GRID_H && this.walk[idx(i, j)] === 1;
  }

  isOpaque(i: number, j: number): boolean {
    return i >= 0 && j >= 0 && i < GRID_W && j < GRID_H && this.opaque[idx(i, j)] === 1;
  }

  /** 米坐标所在的格子能不能走 */
  walkableAt(p: Vec2): boolean {
    const [i, j] = cellOf(p.x, p.z);
    return this.isWalkable(i, j);
  }

  /**
   * 两点之间按格子做 Bresenham，经过挡视线的格子（墙、窗）就看不见。
   * 总是从「较小」的那个格子画到另一个，保证 a→b 和 b→a 结果一样（Bresenham 本身不对称）。
   */
  lineOfSight(a: Vec2, b: Vec2): boolean {
    let [i0, j0] = cellOf(a.x, a.z);
    let [i1, j1] = cellOf(b.x, b.z);
    if (i0 > i1 || (i0 === i1 && j0 > j1)) [i0, j0, i1, j1] = [i1, j1, i0, j0];
    const dx = Math.abs(i1 - i0), sx = i0 < i1 ? 1 : -1;
    const dy = -Math.abs(j1 - j0), sy = j0 < j1 ? 1 : -1;
    let err = dx + dy;
    let i = i0, j = j0;
    for (;;) {
      if (this.isOpaque(i, j)) return false;
      if (i === i1 && j === j1) return true;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; i += sx; }
      if (e2 <= dx) { err += dx; j += sy; }
    }
  }

  /**
   * 离 p 最近的可走格（按格子中心算距离）。p 所在格能走就直接返回它。
   * 一样近时挑离 near 近的（比如「物件旁最近的可走格」挑访客这一侧的）；再一样就按扫描顺序。
   * 整张图只有 768 格，直接全扫，简单可靠。
   */
  nearestWalkable(p: Vec2, near?: Vec2): [number, number] {
    const [ci, cj] = cellOf(p.x, p.z);
    if (this.isWalkable(ci, cj)) return [ci, cj];
    let best: [number, number] = [ci, cj];
    let bestD = Infinity, bestN = Infinity;
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        if (this.walk[idx(i, j)] !== 1) continue;
        const c = cellCenter(i, j);
        const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
        if (d > bestD + TIE_EPS) continue;
        const n = near ? (c.x - near.x) ** 2 + (c.z - near.z) ** 2 : 0;
        if (d < bestD - TIE_EPS || n < bestN - TIE_EPS) {
          best = [i, j];
          bestD = d;
          bestN = n;
        }
      }
    }
    return best;
  }
}
