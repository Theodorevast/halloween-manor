// 手电照出鬼魂（设计文档 3.1）：访客的手电照到鬼魂只显形、不吓人——发 reveal（on / off）、愣一下（察觉 kind ghost），恐惧值不涨。
// 主动现身（设计文档 3.2，config/visitors.ts 的 MANIFEST）：蓄力 → 落下 → 停留 → 收回 → 冷却的时间轴；蓄力时附近的人察觉；
// 落下只吓看得见的人、吓多少；被吓的人后退、之后一段时间绕开那里
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { Grid } from '../src/sim/grid';
import { createNav, createNpc, walkTo } from '../src/sim/npc';
import type { NpcCtx } from '../src/sim/npc';
import { createRng } from '../src/sim/rng';
import { MANIFEST, PERSONALITIES, VISION } from '../src/config/visitors';
import { angleOf, wrapAngle } from '../src/lib/angle';
import { GHOST_SOURCE } from '../src/sim/types';
import type { NpcState, SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
/** 推进 seconds 秒，每步前 ghostAt 摆鬼魂、each 回调 */
function drive(w: World, seconds: number, ghostAt: () => Vec2 | null, each?: () => void): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    w.setGhost(ghostAt());
    ev.push(...w.step(DT));
    each?.();
  }
  return ev;
}
const bearingTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

describe('手电照到鬼魂（只显形、不吓人）', () => {
  /** 门厅西边，朝东：正前方 3 米是门厅东边（中间没墙） */
  const P = { x: 6.5, z: 9.5 };
  const FRONT = { x: P.x + 3, z: P.z };
  const BEHIND = { x: P.x - 3, z: P.z }; // 卧室里（隔着门厅西墙），反正在他身后

  test('鬼魂在正前方 3 米、有视线：reveal on 和一次察觉（kind ghost），恐惧值不变；移到身后：reveal off', () => {
    const w = createWorld({ seed: 90, autoSpawn: false });
    const n = w.spawn({ pos: P, personality: 'average', lookDir: 0 });
    expect(new Grid().lineOfSight(P, FRONT)).toBe(true);
    const ev = drive(w, 0.3, () => FRONT);
    expect(ofType(ev, 'reveal')).toEqual([{ type: 'reveal', npc: n.id, on: true }]);
    expect(ofType(ev, 'notice')).toEqual([{ type: 'notice', npc: n.id, kind: 'ghost', src: FRONT }]);
    expect(n.notice?.kind).toBe('ghost');
    expect(n.fear).toBe(0);
    const off = drive(w, 0.2, () => BEHIND);
    expect(ofType(off, 'reveal')).toEqual([{ type: 'reveal', npc: n.id, on: false }]);
    expect(n.fear).toBe(0);
  });

  test('一直照着时不重复发 on；愣完回到原来的事，不涨恐惧值、不去查看', () => {
    const w = createWorld({ seed: 91, autoSpawn: false });
    const n = w.spawn({ pos: P, personality: 'timid', lookDir: 0 });
    const ev: SimEvent[] = [];
    for (let k = 0; k < 60 * 2; k++) {
      n.lookDir = 0; // 一直照着正前方
      w.setGhost(FRONT);
      ev.push(...w.step(DT));
    }
    expect(ofType(ev, 'reveal')).toEqual([{ type: 'reveal', npc: n.id, on: true }]);
    expect(ofType(ev, 'notice').length).toBe(1);
    expect(n.notice ?? null).toBeNull(); // 愣完了（timid 最多 1.5 秒）
    expect(n.mode).toBe('wander');
    expect(n.fear).toBe(0);
  });

  test('隔着墙照不到：鬼魂在 3 米外的墙那边，不 reveal、不察觉', () => {
    const w = createWorld({ seed: 92, autoSpawn: false });
    const q = { x: 7.5, z: 9.5 };
    const n = w.spawn({ pos: q, personality: 'average', lookDir: Math.PI }); // 朝西，对着卧室和门厅之间的墙
    const g = { x: q.x - 3, z: q.z };
    expect(new Grid().lineOfSight(q, g)).toBe(false);
    const ev = drive(w, 0.5, () => g);
    expect(ofType(ev, 'reveal')).toEqual([]);
    expect(ofType(ev, 'notice').filter((e) => e.npc === n.id && e.kind === 'ghost')).toEqual([]);
  });

  test('照着的人开始逃跑、鬼魂没了（setGhost(null)）：都发 reveal off', () => {
    const w = createWorld({ seed: 93, autoSpawn: false });
    const a = w.spawn({ pos: P, personality: 'average', lookDir: 0 });
    const b = w.spawn({ pos: { x: P.x, z: P.z + 1 }, personality: 'average', lookDir: 0 });
    const g = { x: P.x + 3, z: P.z + 0.5 };
    expect(ofType(drive(w, 0.1, () => g), 'reveal').map((e) => [e.npc, e.on]).sort()).toEqual([[a.id, true], [b.id, true]]);
    a.fear = 100;
    const ev = drive(w, 0.1, () => g);
    expect(ofType(ev, 'reveal')).toEqual([{ type: 'reveal', npc: a.id, on: false }]);
    const gone = drive(w, 0.1, () => null);
    expect(ofType(gone, 'reveal')).toEqual([{ type: 'reveal', npc: b.id, on: false }]);
  });
});

describe('主动现身（吓人、赶人）', () => {
  /** 门厅正中：现身的地方 */
  const G = { x: 8, z: 9.5 };
  /** 推进到这一次现身的 phase 那一步（含）；返回期间的事件和那一步开始时的模拟时间。each：每步之前（比如按住某人的手电） */
  function until(w: World, phase: 'windup' | 'drop' | 'end', each?: () => void) {
    const ev: SimEvent[] = [];
    for (let k = 0; k < 60 * 5; k++) {
      each?.();
      const t = w.state.time;
      const e = w.step(DT);
      ev.push(...e);
      if (e.some((x) => x.type === 'manifest' && x.phase === phase)) return { ev, at: t };
    }
    throw new Error(`没等到 ${phase}`);
  }

  test('时间轴：没有鬼魂不能现身；蓄力 MANIFEST.windup 秒落下，再 MANIFEST.hold 秒收回、冷却 MANIFEST.cooldown 秒；正在现身、冷却中不能再现身', () => {
    const w = createWorld({ seed: 100, autoSpawn: false });
    expect(w.manifest()).toBe(false);
    w.setGhost(G);
    expect(w.manifest()).toBe(true);
    expect(w.manifest()).toBe(false); // 正在现身
    const first = w.step(DT);
    expect(ofType(first, 'manifest')).toEqual([{ type: 'manifest', phase: 'windup', pos: G, scared: [] }]);
    expect(w.state.manifest).toMatchObject({ phase: 'windup', pos: G });
    const t0 = 0;
    const drop = until(w, 'drop');
    expect(drop.at - t0).toBeCloseTo(MANIFEST.windup, 6);
    expect(w.state.manifest.phase).toBe('hold');
    expect(w.manifest()).toBe(false);
    const end = until(w, 'end');
    expect(end.at - drop.at).toBeCloseTo(MANIFEST.hold, 6);
    expect(ofType(end.ev, 'manifest').at(-1)).toEqual({ type: 'manifest', phase: 'end', pos: G, scared: [] });
    expect(w.state.manifest.phase).toBe('cooldown');
    expect(w.state.manifest.cooldown).toBeCloseTo(MANIFEST.cooldown, 6);
    expect(w.manifest()).toBe(false); // 冷却中
    for (let k = 0; k < Math.round((MANIFEST.cooldown - 0.1) / DT); k++) w.step(DT);
    expect(w.manifest()).toBe(false);
    for (let k = 0; k < Math.round(0.2 / DT); k++) w.step(DT);
    expect(w.state.manifest).toEqual({ phase: 'idle', t: 0, cooldown: 0, pos: null });
    expect(w.manifest()).toBe(true);
  });

  test('蓄力：MANIFEST.noticeRadius 米内的人察觉（kind manifest），手电很快对着那里，一直盯到落下；更远的不察觉', () => {
    const w = createWorld({ seed: 101, autoSpawn: false });
    const near = w.spawn({ pos: { x: G.x + 2, z: G.z }, personality: 'average', lookDir: 0 }); // 2 米，背对着
    const far = w.spawn({ pos: { x: G.x, z: G.z - 6.5 }, personality: 'average', lookDir: -Math.PI / 2 }); // 客厅里，6.5 米
    w.setGhost(G);
    w.manifest();
    const ev = w.step(DT);
    expect(ofType(ev, 'notice')).toEqual([{ type: 'notice', npc: near.id, kind: 'manifest', src: G }]);
    expect(far.notice ?? null).toBeNull();
    for (let k = 0; k < Math.round(0.35 / DT); k++) w.step(DT);
    expect(Math.abs(wrapAngle(near.lookDir - bearingTo(near.pos, G)))).toBeLessThan(0.1);
    expect(near.speed).toBeLessThan(0.05);
    // 落下前一步还在察觉
    for (let k = 0; k < Math.round((MANIFEST.windup - 0.35) / DT) - 2; k++) w.step(DT);
    expect(near.notice?.kind).toBe('manifest');
  });

  /** 把这些人的手电按住（每步之前）：dir 返回要照的方向 */
  const hold = (pins: [NpcState, () => number][]) => () => {
    for (const [n, dir] of pins) n.lookDir = dir();
  };

  test('落下：只吓看得见那里的人（光锥 + 视线 + MANIFEST.range）：scared 里有他、他有一个 object = GHOST_SOURCE 的 startle；背对着的、隔着墙的不算', () => {
    const w = createWorld({ seed: 102, autoSpawn: false });
    const a = w.spawn({ pos: { x: G.x - 2, z: G.z }, personality: 'average', lookDir: 0 }); // 2 米，看着那里
    const b = w.spawn({ pos: { x: G.x, z: G.z - 5.5 }, personality: 'average', lookDir: -Math.PI / 2 }); // 5.5 米（察觉范围外），背对着
    const c = w.spawn({ pos: { x: G.x - 3.5, z: G.z }, personality: 'average', lookDir: 0 }); // 卧室里，隔着门厅西墙
    expect(new Grid().lineOfSight(b.pos, G)).toBe(true);
    expect(new Grid().lineOfSight(c.pos, G)).toBe(false);
    w.setGhost(G);
    w.manifest();
    const { ev } = until(w, 'drop', hold([[b, () => -Math.PI / 2]]));
    const drop = ofType(ev, 'manifest').find((e) => e.phase === 'drop')!;
    expect(drop.scared).toEqual([a.id]);
    expect(ofType(ev, 'startle').filter((e) => e.object === GHOST_SOURCE).map((e) => e.npc)).toEqual([a.id]);
    expect(a.mode).toBe('startled');
    expect(b.mode).not.toBe('startled');
    expect(c.mode).not.toBe('startled');

    // 对照：同一个位置（5.5 米、察觉范围外）看着那里的人，落下时照样被吓到
    const w2 = createWorld({ seed: 102, autoSpawn: false });
    const d = w2.spawn({ pos: { x: G.x, z: G.z - 5.5 }, personality: 'average', lookDir: Math.PI / 2 });
    w2.setGhost(G);
    w2.manifest();
    const r2 = until(w2, 'drop', hold([[d, () => bearingTo(d.pos, G)]]));
    expect(ofType(r2.ev, 'manifest').find((e) => e.phase === 'drop')!.scared).toEqual([d.id]);
  });

  test('吓多少：1 米、光锥正中、在他的手电光里的 average = fear × 1.3 × 1.2 × 1.25；6 米、光锥边上（只是隐约看见）= fear × 0.6 × 0.9', () => {
    const amount = (pos: Vec2, dir: (n: NpcState) => number) => {
      const w = createWorld({ seed: 103, autoSpawn: false });
      const n = w.spawn({ pos, personality: 'average', lookDir: bearingTo(pos, G) });
      w.setGhost(G);
      w.manifest();
      const { ev } = until(w, 'drop', hold([[n, () => dir(n)]]));
      const st = ofType(ev, 'startle').filter((e) => e.npc === n.id && e.object === GHOST_SOURCE);
      expect(st.length).toBe(1);
      return st[0].amount;
    };
    expect(PERSONALITIES.average.fearMult).toBe(1);
    const close = amount({ x: G.x - 1, z: G.z }, (n) => bearingTo(n.pos, G));
    expect(Math.abs(close - MANIFEST.fear * 1.3 * 1.2 * 1.25)).toBeLessThanOrEqual(0.5);
    const far = { x: G.x, z: G.z - 5.99 };
    const edge = amount(far, (n) => bearingTo(n.pos, G) + VISION.halfAngle - 0.002);
    expect(Math.abs(edge - MANIFEST.fear * 0.6 * 0.9)).toBeLessThanOrEqual(0.5);
  });

  test('被吓到的人僵住完转身后退：落下 2 秒后离那里至少 backOff 米、手电照着那边；加了一个绕开圈，到期去掉；之后闲逛不挑圈里的目标，路线不往圈里钻', () => {
    const w = createWorld({ seed: 104, autoSpawn: false });
    const a = w.spawn({ pos: { x: G.x - 1, z: G.z }, personality: 'average', lookDir: 0 });
    w.setGhost(G);
    w.manifest();
    const drop = until(w, 'drop');
    expect(ofType(drop.ev, 'manifest').find((e) => e.phase === 'drop')!.scared).toEqual([a.id]);
    expect(w.state.avoid).toEqual([{ pos: G, r: MANIFEST.avoidRadius, until: expect.closeTo(drop.at + MANIFEST.avoidTime, 6), who: [a.id] }]);
    let moved = false;
    for (let k = 0; k < Math.round(2 / DT); k++) {
      w.step(DT);
      if (a.mode !== 'startled' && a.speed > 0.05) {
        moved = true;
        // 往远离那里的方向走（身体背对着它），手电照着身后的那里
        expect(Math.abs(wrapAngle(a.heading - bearingTo(G, a.pos)))).toBeLessThan(Math.PI / 2);
        expect(Math.abs(wrapAngle(a.lookDir - bearingTo(a.pos, G)))).toBeLessThan(0.6);
      }
    }
    expect(moved).toBe(true);
    expect(dist(a.pos, G)).toBeGreaterThanOrEqual(MANIFEST.backOff - 1e-6);
    expect(Math.abs(wrapAngle(a.lookDir - bearingTo(a.pos, G)))).toBeLessThan(0.5);
    // 之后照常闲逛：挑的目标不在圈里，路线不比出发的地方更靠近圈心
    const start = dist(a.pos, G);
    let checked = 0;
    let last = '';
    for (let k = 0; k < Math.round((MANIFEST.avoidTime - 4) / DT); k++) {
      w.step(DT);
      const key = JSON.stringify(a.path);
      if (a.mode === 'wander' && a.path.length > 0 && key !== last && w.state.avoid.length > 0) {
        const goal = a.path[a.path.length - 1];
        expect(dist(goal, G)).toBeGreaterThanOrEqual(MANIFEST.avoidRadius);
        let p = { ...a.pos };
        for (const q of a.path) {
          for (let t = 0; t <= 1; t += 0.05) expect(dist({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t }, G)).toBeGreaterThanOrEqual(Math.min(start, dist(a.pos, G)) - 0.3);
          p = q;
        }
        checked++;
      }
      last = key;
    }
    expect(checked).toBeGreaterThan(0);
    for (let k = 0; k < Math.round(4.5 / DT); k++) w.step(DT);
    expect(w.state.avoid).toEqual([]);
  });

  test('没人看见就不加绕开圈；被吓的人逃跑了也不会再后退', () => {
    const w = createWorld({ seed: 105, autoSpawn: false });
    w.spawn({ pos: { x: G.x, z: G.z - 5.5 }, personality: 'average', lookDir: -Math.PI / 2 }); // 背对着、察觉范围外
    w.setGhost(G);
    w.manifest();
    until(w, 'drop');
    expect(w.state.avoid).toEqual([]);

    const w2 = createWorld({ seed: 105, autoSpawn: false });
    const t = w2.spawn({ pos: { x: G.x - 1, z: G.z }, personality: 'timid', lookDir: 0 });
    t.fear = 80;
    w2.setGhost(G);
    w2.manifest();
    until(w2, 'drop');
    expect(t.mode).toBe('fleeing');
  });
});

describe('绕开圈只管被吓到的人（用户 2026-10-29）', () => {
  const G = { x: 8, z: 9.5 };
  const bearingTo2 = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);

  test('落下时一个看着、一个背对着：圈里只记被吓到的那个（和 drop 的 scared 一样）', () => {
    const w = createWorld({ seed: 120, autoSpawn: false });
    const a = w.spawn({ pos: { x: G.x - 2, z: G.z }, personality: 'average', lookDir: 0 });
    const b = w.spawn({ pos: { x: G.x, z: G.z - 5.5 }, personality: 'average', lookDir: -Math.PI / 2 });
    w.setGhost(G);
    w.manifest();
    let drop: Extract<SimEvent, { type: 'manifest' }> | undefined;
    for (let k = 0; k < 60 && !drop; k++) {
      b.lookDir = -Math.PI / 2; // 一直背对着
      drop = ofType(w.step(DT), 'manifest').find((e) => e.phase === 'drop');
    }
    expect(drop!.scared).toEqual([a.id]);
    expect(w.state.avoid.map((z) => z.who)).toEqual([[a.id]]);
    expect(bearingTo2(a.pos, G)).toBeCloseTo(0, 6);
  });

  test('同一个地方、同一个目的地：被吓到的人绕开圈走，没看见的人照常直着走过去', () => {
    // 门厅：圈心 (8, 9.5)、半径 1 米，圈上下各剩 1 米能走；两个人都从圈西边走到圈东边
    const nav = createNav(new Grid());
    const from = { x: 6, z: 9.5 }, to = { x: 10, z: 9.5 };
    const zone = { pos: G, r: 1, until: 10, who: [1] };
    const ctx = { nav, rng: createRng(1), now: 5, avoid: [zone] } as unknown as NpcCtx;
    const scared = createNpc({ id: 1, name: 'A', personality: 'average', pos: from, lookDir: 0, mode: 'wander', now: 0 }, { rng: createRng(1), nav });
    const other = createNpc({ id: 2, name: 'B', personality: 'average', pos: from, lookDir: 0, mode: 'wander', now: 0 }, { rng: createRng(1), nav });
    expect(walkTo(scared, ctx, to)).toBe(true);
    expect(walkTo(other, ctx, to)).toBe(true);
    const closest = (path: Vec2[]) => {
      let m = Infinity, a = from;
      for (const q of path) {
        for (let t = 0; t <= 1; t += 0.02) m = Math.min(m, dist({ x: a.x + (q.x - a.x) * t, z: a.z + (q.z - a.z) * t }, G));
        a = q;
      }
      return m;
    };
    expect(closest(scared.s.path)).toBeGreaterThanOrEqual(zone.r - 1e-6);
    expect(closest(other.s.path)).toBeLessThan(0.1);
  });
});
