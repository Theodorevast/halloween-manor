// 访客互相避让（config/visitors.ts 的 CROWD）和走路的加减速（MOTION）：第三人称改版的「穿模」「动画生硬」。
// - 迎面、门洞里交错时不重叠（中心距离不小于 CROWD.minDist），也不会卡在门洞里
// - 长时间跑（很多人、不停附身）：没人卡住，没人站到墙里
// - 速度连续：一个人走时每步的变化不超过加 / 减速度 × dt；人多时绝大多数步也是，急刹也不是一下子停住
// - speed 是真的：每步实际挪动的距离 / dt
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { Grid } from '../src/sim/grid';
import { cellCenter, cellOf, DOORWAYS, FRONT_DOOR, inGrid, PROPS } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { BEHAVIOR, CROWD, MOTION, SPEED } from '../src/config/visitors';
import type { NpcState, ScareObjectState, SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
const grid = new Grid();
const minDistOf = (ns: readonly NpcState[]) => {
  let m = Infinity;
  for (let a = 0; a < ns.length; a++) for (let b = a + 1; b < ns.length; b++) m = Math.min(m, Math.hypot(ns[a].pos.x - ns[b].pos.x, ns[a].pos.z - ns[b].pos.z));
  return m;
};
/** 门洞格（屋里的六个门洞 + 前门） */
const DOOR_CELLS = new Set([...DOORWAYS.flatMap((d) => d.cells), ...FRONT_DOOR.cells].map(([i, j]) => `${i},${j}`));
const inDoorway = (p: Vec2) => {
  const [i, j] = cellOf(p.x, p.z);
  return DOOR_CELLS.has(`${i},${j}`);
};
/** 能站的地方：可走格，或者前门外那一段（和 world.test.ts「长时间跑」一样的规矩） */
const standable = (p: Vec2) => {
  const [i, j] = cellOf(p.x, p.z);
  return grid.isWalkable(i, j) || (!inGrid(i, j) && Math.abs(p.x - FRONT_DOOR.outside.x) <= 0.5 && p.z >= 11.5);
};
/** 想走（有路、没吓呆、没在察觉那一拍：那时是自己停下来盯着来源）却几乎没动 */
const blocked = (n: NpcState) => n.path.length > 0 && n.mode !== 'startled' && n.mode !== 'gone' && !n.notice && n.speed < 0.05;
/** 惊吓类物件还在蓄势（触发了、还没到 hitAt）：和 sim/scares.ts 的 windingUp 一样 */
const windingUp = (o: ScareObjectState) => {
  const s = SCARES[o.type];
  return s.kind === 'sight' && o.active > 0 && s.active - o.active < s.hitAt - 1e-9;
};
/**
 * 被蓄势的惊吓物件定住（自己停下来盯着它，不是被别人挡住；床要蓄势 2.6 秒）：
 * NpcState 里看不出来，按「有物件在蓄势、他正看着它（在 seenBy 里）」算
 */
const transfixed = (w: World, n: NpcState) => w.state.objects.some((o) => windingUp(o) && o.seenBy.includes(n.id));
/** 一个人走时每步速度变化的上限：加 / 减速度 × dt；落地那一步不足一整步，多给四分之一 */
const WALK_JUMP = Math.max(MOTION.accel, MOTION.decel) * DT * 1.25;
/** 人多时被别人逼着急刹 + 侧身减速同时发生的上限 */
const CROWD_JUMP = (MOTION.hardDecel + CROWD.sideAccel) * DT;

/** 两个人对着走（各自的终点是对方的起点），返回过程里的最近距离、各自走完用了多久、最长被挡住多久（门洞里的单算） */
function cross(a: Vec2, b: Vec2, seconds: number) {
  const w = createWorld({ seed: 5, autoSpawn: false });
  const A = w.spawn({ pos: a, personality: 'average', goal: b });
  const B = w.spawn({ pos: b, personality: 'average', goal: a });
  let minD = Infinity, doneA = -1, doneB = -1, stuck = 0, stuckMax = 0, doorStuck = 0, doorStuckMax = 0;
  for (let k = 0; k < seconds / DT; k++) {
    w.step(DT);
    minD = Math.min(minD, Math.hypot(A.pos.x - B.pos.x, A.pos.z - B.pos.z));
    if (doneA < 0 && A.path.length === 0) doneA = w.state.time;
    if (doneB < 0 && B.path.length === 0) doneB = w.state.time;
    const anyBlocked = blocked(A) || blocked(B);
    stuck = anyBlocked ? stuck + DT : 0;
    stuckMax = Math.max(stuckMax, stuck);
    doorStuck = (blocked(A) && inDoorway(A.pos)) || (blocked(B) && inDoorway(B.pos)) ? doorStuck + DT : 0;
    doorStuckMax = Math.max(doorStuckMax, doorStuck);
    for (const n of [A, B]) expect(standable(n.pos)).toBe(true);
  }
  return { minD, doneA, doneB, stuckMax, doorStuckMax, A, B };
}

describe('避让：两个人对着走', () => {
  test('走廊里迎面走过：始终不重叠（≥ minDist），各自靠右错开，按时走到', () => {
    const a = { x: 1.25, z: 6 }, b = { x: 14.75, z: 6 };
    const r = cross(a, b, 20);
    expect(r.minD).toBeGreaterThanOrEqual(CROWD.minDist - 1e-6);
    // 13.5 米、1.3 米/秒约 10.4 秒，错身让一让也不该多花太久
    const budget = Math.hypot(b.x - a.x, b.z - a.z) / SPEED.wander + 4;
    expect(r.doneA).toBeGreaterThan(0);
    expect(r.doneB).toBeGreaterThan(0);
    expect(r.doneA).toBeLessThan(budget);
    expect(r.doneB).toBeLessThan(budget);
    expect(r.stuckMax).toBeLessThan(CROWD.stuckShort);
  });

  // 每个门洞两边各放一个人（沿穿过门洞的方向离门洞中心 2 米，落在家具上就挪到最近的可走格），终点互换
  for (const d of DOORWAYS) {
    test(`门洞 ${d.rooms.join(' ↔ ')}：两边同时过门，不重叠、不卡在门洞里`, () => {
      const cs = d.cells.map(([i, j]) => cellCenter(i, j));
      const c = { x: cs.reduce((s, p) => s + p.x, 0) / cs.length, z: cs.reduce((s, p) => s + p.z, 0) / cs.length };
      const alongZ = d.cells.every(([, j]) => j === d.cells[0][1]); // 门洞在东西向的墙上：穿过它是南北向
      const side = (k: number) => {
        const p = alongZ ? { x: c.x, z: c.z + 2 * k } : { x: c.x + 2 * k, z: c.z };
        const [i, j] = grid.nearestWalkable(p, c);
        return grid.walkableAt(p) ? p : cellCenter(i, j);
      };
      const r = cross(side(-1), side(1), 15);
      expect(r.minD).toBeGreaterThanOrEqual(CROWD.minDist - 1e-6);
      expect(r.doneA).toBeGreaterThan(0);
      expect(r.doneB).toBeGreaterThan(0);
      expect(Math.max(r.doneA, r.doneB)).toBeLessThan(10);
      expect(r.doorStuckMax).toBeLessThan(CROWD.stuckLong);
    });
  }

  test('同一点生成的两个人：兜底推开，几步之内就不再重叠，推开时也不会比挤开的速度快', () => {
    const w = createWorld({ seed: 6, autoSpawn: false });
    const p = { x: 8, z: 9.5 };
    const a = w.spawn({ pos: p }), b = w.spawn({ pos: p });
    let maxSpeed = 0;
    for (let k = 0; k < 60; k++) {
      w.step(DT);
      maxSpeed = Math.max(maxSpeed, a.speed, b.speed);
    }
    expect(Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z)).toBeGreaterThanOrEqual(CROWD.minDist - 1e-6);
    expect(maxSpeed).toBeLessThanOrEqual(CROWD.pushSpeed + 1e-9);
  });
});

/** 长时间跑：自动生成 + 再放几个人，按 every 步附身一次（0 = 不附身）；每步回调 */
function soak(seed: number, seconds: number, extra: number, every: number, each: (w: World, ev: SimEvent[]) => void) {
  const w = createWorld({ seed });
  const spots = [{ x: 2.75, z: 3.75 }, { x: 8, z: 6 }, { x: 13.25, z: 8.75 }, { x: 4, z: 10 }];
  for (let k = 0; k < extra; k++) w.spawn({ pos: spots[k % spots.length] });
  const ids = PROPS.map((p) => p.id);
  for (let k = 0; k < seconds / DT; k++) {
    if (every > 0 && k % every === 0) w.trigger(ids[(k / every) % ids.length]);
    each(w, w.step(DT));
  }
}

describe('避让：长时间跑', () => {
  test('很多人、不停附身：几乎从不重叠（只有慌不择路的逃跑者挤过去时差一点点），没人卡住、没人卡在门洞里、没人站到墙里', () => {
    let minD = Infinity, stuckMax = 0, doorStuckMax = 0, exits = 0;
    for (const seed of [11, 12, 13]) {
      const stuck = new Map<number, number>(), door = new Map<number, number>();
      soak(seed, 240, 3, 97, (w, ev) => {
        exits += ev.filter((e) => e.type === 'exit').length;
        minD = Math.min(minD, minDistOf(w.state.npcs));
        for (const n of w.state.npcs) {
          if (!standable(n.pos)) throw new Error(`npc ${n.id} (${n.mode}) 在墙里：${n.pos.x}, ${n.pos.z}`);
          const b = blocked(n) && !transfixed(w, n);
          const s = b ? (stuck.get(n.id) ?? 0) + DT : 0;
          stuck.set(n.id, s);
          stuckMax = Math.max(stuckMax, s);
          const dd = b && inDoorway(n.pos) ? (door.get(n.id) ?? 0) + DT : 0;
          door.set(n.id, dd);
          doorStuckMax = Math.max(doorStuckMax, dd);
        }
      });
    }
    expect(exits).toBeGreaterThan(5); // 确实有人逃跑、在人群里挤出门
    expect(minD).toBeGreaterThanOrEqual(CROWD.minDist * 0.97);
    // 被挡住最多等 stuckLong 秒就绕路 / 换打算
    expect(stuckMax).toBeLessThan(CROWD.stuckLong + 0.5);
    expect(doorStuckMax).toBeLessThan(CROWD.stuckLong);
  });
});

describe('走路的加减速', () => {
  test('一个人闲逛 10 分钟：起步、拐弯、停下，每步速度变化都不超过加 / 减速度 × dt；speed 就是实际挪动的距离 / dt', () => {
    for (const seed of [21, 22, 23]) {
      const w = createWorld({ seed, autoSpawn: false });
      const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average' });
      let prev = { x: n.pos.x, z: n.pos.z, speed: n.speed }, max = 0, top = 0;
      for (let k = 0; k < 600 / DT; k++) {
        w.step(DT);
        expect(n.speed).toBeCloseTo(Math.hypot(n.pos.x - prev.x, n.pos.z - prev.z) / DT, 9);
        max = Math.max(max, Math.abs(n.speed - prev.speed));
        top = Math.max(top, n.speed);
        prev = { x: n.pos.x, z: n.pos.z, speed: n.speed };
      }
      expect(max).toBeLessThanOrEqual(WALK_JUMP);
      expect(top).toBeCloseTo(SPEED.wander, 5); // 直路上照样走到全速
    }
  });

  test('拐弯不停下：从走廊拐进书房门洞，全速以后到快到终点之前，速度不掉到拐角限速以下', () => {
    const w = createWorld({ seed: 24, autoSpawn: false });
    const goal = { x: 2.5, z: 2.5 };
    const n = w.spawn({ pos: { x: 7, z: 6 }, personality: 'average', goal });
    const corner = n.path.length;
    expect(corner).toBeGreaterThan(1); // 路上确实有拐角
    let full = false, low = Infinity;
    for (let k = 0; k < 15 / DT && n.path.length > 0; k++) {
      w.step(DT);
      if (n.speed >= SPEED.wander - 1e-9) full = true;
      const left = Math.hypot(goal.x - n.pos.x, goal.z - n.pos.z);
      // 终点前要刹车：刹车距离 v² / (2 × decel) 以外才算
      if (full && n.path.length > 0 && left > SPEED.wander ** 2 / (2 * MOTION.decel) + BEHAVIOR.arrive) low = Math.min(low, n.speed);
    }
    expect(full).toBe(true);
    expect(n.path.length).toBe(0);
    expect(low).toBeGreaterThanOrEqual(SPEED.wander * MOTION.cornerMin);
  });

  test('人多的时候：绝大多数步的变化不超过加 / 减速度 × dt，被逼急刹也是几步内慢慢停（没有一步就停住的）', () => {
    let n = 0, overWalk = 0, overCrowd = 0, max = 0;
    for (const seed of [31, 32, 33, 34]) {
      const prev = new Map<number, { x: number; z: number; speed: number }>();
      soak(seed, 300, 3, 0, (w) => {
        for (const m of w.state.npcs) {
          const p = prev.get(m.id);
          prev.set(m.id, { x: m.pos.x, z: m.pos.z, speed: m.speed });
          if (!p) continue;
          expect(m.speed).toBeCloseTo(Math.hypot(m.pos.x - p.x, m.pos.z - p.z) / DT, 9);
          const j = Math.abs(m.speed - p.speed);
          n++;
          if (j > WALK_JUMP) overWalk++;
          if (j > CROWD_JUMP) overCrowd++;
          max = Math.max(max, j);
        }
      });
    }
    expect(overWalk / n).toBeLessThan(0.01);
    expect(overCrowd / n).toBeLessThan(0.0005);
    // 最坏的一步也不到走路速度的四成（原来拐角、起步、停下都是一步从 1.3 跳到 0）
    expect(max).toBeLessThan(SPEED.wander * 0.4);
  });
});
