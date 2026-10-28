// 手电照出鬼魂（设计文档 3.1）：访客的手电照到鬼魂只显形、不吓人——发 reveal（on / off）、愣一下（察觉 kind ghost），恐惧值不涨。
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { Grid } from '../src/sim/grid';
import type { SimEvent, Vec2, World } from '../src/sim/types';

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
