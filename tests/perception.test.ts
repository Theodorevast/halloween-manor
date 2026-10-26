import { describe, expect, test } from 'vitest';
import { Grid } from '../src/sim/grid';
import { canHear, canSee } from '../src/sim/perception';
import { VISION } from '../src/config/visitors';
import { WALL_HEARING_FACTOR } from '../src/config/scares';

const g = new Grid();
const EAST = 0, NORTH = -Math.PI / 2;

describe('canSee', () => {
  test('访客在 (8, 6) 朝东：前方 (11, 6) 看得见，身后 (5, 6) 看不见', () => {
    const npc = { pos: { x: 8, z: 6 }, lookDir: EAST };
    expect(canSee(g, npc, { x: 11, z: 6 }, VISION.range)).toBe(true);
    expect(canSee(g, npc, { x: 5, z: 6 }, VISION.range)).toBe(false);
  });

  test('朝北看客厅：隔着第 9 行的墙看不见', () => {
    // 计划里写的是 (8, 6) → (8, 2)，但 x = 8 正好穿过客厅门洞（第 15、16 列），实际看得见；
    // 这里换成 x = 6（第 12 列，第 9 行是墙），并把门洞的情形单独测
    expect(canSee(g, { pos: { x: 6, z: 6 }, lookDir: NORTH }, { x: 6, z: 2 }, VISION.range)).toBe(false);
  });

  test('朝北穿过客厅门洞：看得见', () => {
    expect(canSee(g, { pos: { x: 8, z: 6 }, lookDir: NORTH }, { x: 8, z: 2 }, VISION.range)).toBe(true);
  });

  test('光锥边界：半角以内看得见，以外看不见', () => {
    const pos = { x: 8, z: 6 };
    const a = VISION.halfAngle;
    const at = (ang: number, d: number) => ({ x: pos.x + Math.cos(ang) * d, z: pos.z + Math.sin(ang) * d });
    expect(canSee(g, { pos, lookDir: EAST }, at(a - 0.01, 1.5), VISION.range)).toBe(true);
    expect(canSee(g, { pos, lookDir: EAST }, at(-(a - 0.01), 1.5), VISION.range)).toBe(true);
    expect(canSee(g, { pos, lookDir: EAST }, at(a + 0.01, 1.5), VISION.range)).toBe(false);
  });

  test('距离：超过 range 看不见', () => {
    const npc = { pos: { x: 2, z: 6 }, lookDir: EAST };
    expect(canSee(g, npc, { x: 8.9, z: 6 }, VISION.range)).toBe(true);
    expect(canSee(g, npc, { x: 9.1, z: 6 }, VISION.range)).toBe(false);
    expect(canSee(g, npc, { x: 4.4, z: 6 }, 2.5)).toBe(true);
    expect(canSee(g, npc, { x: 4.6, z: 6 }, 2.5)).toBe(false);
  });

  test('角度跨过 ±π 也算对（朝西看）', () => {
    const npc = { pos: { x: 12, z: 6 }, lookDir: Math.PI };
    expect(canSee(g, npc, { x: 9, z: 6.3 }, VISION.range)).toBe(true);
    expect(canSee(g, npc, { x: 9, z: 5.7 }, VISION.range)).toBe(true);
  });

  test('家具和物件不挡视线', () => {
    // 书房里隔着书桌看
    expect(canSee(g, { pos: { x: 3.25, z: 2.75 }, lookDir: EAST }, { x: 4.75, z: 2.75 }, VISION.range)).toBe(true);
  });
});

describe('canHear', () => {
  test('同房间 6 米、range 7：听得见', () => {
    expect(canHear(g, { x: 1, z: 6 }, { x: 7, z: 6 }, 7)).toBe(true);
  });

  test(`隔墙 6 米、range 7（7 × ${WALL_HEARING_FACTOR} = 4.2）：听不见`, () => {
    // 书房 → 客厅，中间是第 10 列的墙
    expect(canHear(g, { x: 2, z: 2.5 }, { x: 8, z: 2.5 }, 7)).toBe(false);
  });

  test('隔墙按 range × WALL_HEARING_FACTOR 算：4 米听得见，4.4 米听不见', () => {
    expect(canHear(g, { x: 4, z: 2.5 }, { x: 8, z: 2.5 }, 7)).toBe(true);
    expect(canHear(g, { x: 3.6, z: 2.5 }, { x: 8, z: 2.5 }, 7)).toBe(false);
  });

  test('有视线时按完整距离：6.9 米听得见，7.1 米听不见', () => {
    expect(canHear(g, { x: 1, z: 6 }, { x: 7.9, z: 6 }, 7)).toBe(true);
    expect(canHear(g, { x: 1, z: 6 }, { x: 8.1, z: 6 }, 7)).toBe(false);
  });

  test('听觉不看朝向（声音从背后来也听得见）', () => {
    expect(canHear(g, { x: 8, z: 6 }, { x: 3, z: 6 }, 7)).toBe(true);
  });
});
