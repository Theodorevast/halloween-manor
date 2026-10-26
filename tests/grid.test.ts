import { describe, expect, test } from 'vitest';
import { Grid } from '../src/sim/grid';
import { buildTiles, cellCenter, FRONT_DOOR, FURNITURE, GRID_H, GRID_W, idx, PROPS, roomAt, Tile } from '../src/config/house';

describe('Grid', () => {
  const g = new Grid();
  const cellOfProp = (id: string) => PROPS.find((p) => p.id === id)!.cell;

  test('墙、地板、门洞、物件格', () => {
    expect(g.isWalkable(0, 0)).toBe(false);
    expect(g.isWalkable(5, 5)).toBe(true);
    expect(g.isWalkable(4, 9)).toBe(true); // 书房门洞
    // 计划里写的是 (3, 4)：肖像后来挪到了书房北墙前，这里按 PROPS 取
    const [pi, pj] = cellOfProp('portrait');
    expect(g.isWalkable(pi, pj)).toBe(false); // 肖像所在格
    expect(g.isOpaque(pi, pj)).toBe(false); // 物件不挡视线
  });

  test('物件格都在房间里、不压在墙和家具上（门在门洞里，八音盒在床头柜上）', () => {
    const t = buildTiles();
    for (const p of PROPS) {
      const [i, j] = p.cell;
      if (p.type === 'door') {
        expect(t[idx(i, j)]).toBe(Tile.Floor);
        continue;
      }
      expect(t[idx(i, j)]).toBe(Tile.Prop);
      const under = FURNITURE.filter((f) => f.blocks && i >= f.rect.x0 && i < f.rect.x1 && j >= f.rect.z0 && j < f.rect.z1);
      if (p.type === 'musicBox') {
        expect(under.map((f) => [f.kind, f.rect.x1 - f.rect.x0, f.rect.z1 - f.rect.z0])).toEqual([['nightstand', 1, 1]]);
      } else expect(under).toEqual([]);
      expect(roomAt(i, j)).toBe(p.room);
      // 至少有一个相邻格能走（人能走到跟前）
      const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([di, dj]) => g.isWalkable(i + di, j + dj));
      expect(around).toBe(true);
    }
    // 每个房间最多 2 个物件
    const per = new Map<string, number>();
    for (const p of PROPS) per.set(p.room, (per.get(p.room) ?? 0) + 1);
    for (const n of per.values()) expect(n).toBeLessThanOrEqual(2);
  });

  test('有正面的物件（肖像、镜子）朝南或朝东，正面那一格能站人', () => {
    for (const p of PROPS.filter((q) => q.type === 'portrait' || q.type === 'mirror')) {
      expect([0, Math.PI / 2]).toContain(p.facing);
      const fi = p.cell[0] + Math.round(Math.cos(p.facing)), fj = p.cell[1] + Math.round(Math.sin(p.facing));
      expect(g.isWalkable(fi, fj)).toBe(true);
    }
  });

  test('家具挡路不挡视线，窗挡视线，前门能走', () => {
    expect(g.isWalkable(8, 5)).toBe(false); // 书桌
    expect(g.isOpaque(8, 5)).toBe(false);
    expect(g.isOpaque(3, 0)).toBe(true); // 北墙上的窗
    expect(g.isWalkable(3, 0)).toBe(false);
    for (const [i, j] of FRONT_DOOR.cells) expect(g.isWalkable(i, j)).toBe(true);
  });

  test('格子外：不能走，也不挡视线（屋外是空地）', () => {
    expect(g.isWalkable(-1, 5)).toBe(false);
    expect(g.isWalkable(GRID_W, 5)).toBe(false);
    expect(g.isOpaque(16, GRID_H + 2)).toBe(false);
  });

  test('可以传入自定义格子', () => {
    const t = new Uint8Array(GRID_W * GRID_H).fill(Tile.Floor);
    t[idx(2, 2)] = Tile.Wall;
    const g2 = new Grid(t);
    expect(g2.isWalkable(0, 0)).toBe(true);
    expect(g2.isOpaque(2, 2)).toBe(true);
    expect(g2.lineOfSight({ x: 0.25, z: 1.25 }, { x: 2.25, z: 1.25 })).toBe(false);
  });

  test('视线：走廊里通，隔墙不通', () => {
    expect(g.lineOfSight({ x: 1, z: 6 }, { x: 15, z: 6 })).toBe(true);
    expect(g.lineOfSight({ x: 2.5, z: 2.5 }, { x: 7.5, z: 2.5 })).toBe(false); // 书房 → 客厅隔着墙
  });

  test('视线：穿过门洞能看见，家具和物件不挡', () => {
    // 走廊 → 客厅，x = 8.0 正好在客厅门洞（第 15、16 列）上
    expect(g.lineOfSight({ x: 8, z: 6 }, { x: 8, z: 2 })).toBe(true);
    // 隔着书桌（家具）
    expect(g.lineOfSight({ x: 3.25, z: 2.75 }, { x: 4.75, z: 2.75 })).toBe(true);
    // 隔着肖像（物件）
    const [pi, pj] = cellOfProp('portrait');
    expect(g.lineOfSight(cellCenter(pi - 1, pj), cellCenter(pi + 1, pj))).toBe(true);
    // 走廊 → 客厅，但不在门洞的那一列：隔着第 9 行的墙
    expect(g.lineOfSight({ x: 6, z: 6 }, { x: 6, z: 2 })).toBe(false);
  });

  test('视线对称', () => {
    const pts = [
      { x: 1.3, z: 6.1 }, { x: 8.2, z: 2.4 }, { x: 13.4, z: 8.6 }, { x: 4.6, z: 10.2 },
      { x: 7.9, z: 11.6 }, { x: 12.8, z: 4.9 }, { x: 2.75, z: 3.75 }, { x: 15.25, z: 8.75 },
    ];
    for (const a of pts) for (const b of pts) expect(g.lineOfSight(a, b)).toBe(g.lineOfSight(b, a));
  });

  test('nearestWalkable：可走的点返回自己所在格；墙里的点返回最近的可走格', () => {
    expect(g.nearestWalkable({ x: 2.6, z: 2.6 })).toEqual([5, 5]);
    // (5.25, 4.75) 是第 10 列第 9 行的墙格；最近的可走格是正南方的 (10, 10)
    expect(g.nearestWalkable({ x: 5.25, z: 4.75 })).toEqual([10, 10]);
    // 物件格：返回相邻的可走格
    const p = PROPS.find((q) => q.id === 'portrait')!;
    const [i, j] = g.nearestWalkable(cellCenter(p.cell[0], p.cell[1]));
    expect(g.isWalkable(i, j)).toBe(true);
    expect(Math.max(Math.abs(i - p.cell[0]), Math.abs(j - p.cell[1]))).toBe(1);
  });

  test('nearestWalkable：距离相同时，按第二个参数挑离它近的', () => {
    const [ci, cj] = cellOfProp('rocking-chair'); // 四面都是可走格，一样近
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) expect(g.isWalkable(ci + di, cj + dj)).toBe(true);
    const c = cellCenter(ci, cj);
    expect(g.nearestWalkable(c, cellCenter(ci - 4, cj))).toEqual([ci - 1, cj]); // 从西边来
    expect(g.nearestWalkable(c, cellCenter(ci, cj + 4))).toEqual([ci, cj + 1]); // 从南边来
  });

  test('nearestWalkable：屋外的点（门外）返回前门格', () => {
    const [i, j] = g.nearestWalkable(FRONT_DOOR.outside);
    expect(FRONT_DOOR.cells.some(([a, b]) => a === i && b === j)).toBe(true);
  });

  test('默认格子就是 buildTiles()', () => {
    const t = buildTiles();
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        const v = t[idx(i, j)];
        expect(g.isWalkable(i, j)).toBe(v === Tile.Floor || v === Tile.Exit);
      }
    }
  });
});
