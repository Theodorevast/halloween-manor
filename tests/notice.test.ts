// 察觉那一拍（设计文档 2.1，config/visitors.ts 的 NOTICE、TRAITS）：听到声音、照到鬼魂、开始发毛、现身蓄力时，
// 访客先停下、手电先转向来源、身体跟上，盯一会儿再决定下一步；受惊、逃跑中不察觉；优先级高的或一样高的来源接管
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createNav, createNpc, notice } from '../src/sim/npc';
import type { NpcCtx } from '../src/sim/npc';
import { Grid } from '../src/sim/grid';
import { createRng } from '../src/sim/rng';
import { NOTICE, TRAITS } from '../src/config/visitors';
import type { SimEvent } from '../src/sim/types';
const DT = 1 / 60;
const run = (w: ReturnType<typeof createWorld>, s: number) => { const ev: SimEvent[] = []; for (let t = 0; t < s; t += DT) ev.push(...w.step(DT)); return ev; };
/**
 * 卧室门外的走廊，朝北（背对卧室）：听得见卧室里的八音盒（2.85 米、有视线）。
 * 计划原写 { x: 13, z: 9 }，那一点在浴室中间，离八音盒 12 米，听不见（超出 7 米），这几条就测不了
 */
const HALL = { x: 2.5, z: 6.5 };
const NORTH = -Math.PI / 2;

describe('察觉那一拍', () => {
  test('听到引诱声：先停下、手电先转过去，盯 0.5–1 秒后才开始走', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: HALL, lookDir: NORTH, personality: 'average' });
    w.trigger('music-box');
    const ev = run(w, 0.2);
    expect(ev.some((e) => e.type === 'notice' && e.npc === n.id && e.kind === 'sound')).toBe(true);
    expect(n.notice?.kind).toBe('sound');
    expect(n.speed).toBeLessThan(0.3);
    run(w, NOTICE.hold[1] * TRAITS.average.noticeHold + 0.3);
    expect(n.notice ?? null).toBeNull();
    expect(n.mode).toBe('alert');
  });
  test('手电先转、身体后转：察觉开始 0.15 秒时手电已经比身体更接近来源', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: HALL, lookDir: NORTH, personality: 'average' });
    w.trigger('music-box');
    run(w, 0.15);
    const box = w.state.objects.find((o) => o.id === 'music-box')!.pos;
    const want = Math.atan2(box.z - n.pos.z, box.x - n.pos.x);
    const off = (a: number) => Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want)));
    expect(off(n.lookDir)).toBeLessThan(off(n.heading));
  });
  test('受惊、逃跑中不察觉', () => {
    const w = createWorld({ seed: 2, autoSpawn: false });
    const a = w.spawn({ pos: HALL, lookDir: NORTH });
    w.trigger('mirror'); // 让 a 先被别的东西吓到不容易摆，直接改状态
    a.mode = 'fleeing';
    w.trigger('music-box');
    const ev = run(w, 0.3);
    expect(ev.some((e) => e.type === 'notice' && e.npc === a.id)).toBe(false);
  });
  test('优先级：察觉发毛时来了声音，声音接管；察觉声音时开始发毛，不接管', () => {
    const nav = createNav(new Grid());
    const npc = createNpc({ id: 1, name: 'A', personality: 'average', pos: { x: 8, z: 9.5 }, lookDir: 0, mode: 'wander', now: 0 }, { rng: createRng(1), nav });
    const events: SimEvent[] = [];
    const ctx = { nav, rng: createRng(1), now: 0, dt: DT, events, onScream: () => {}, onFlee: () => {}, crowd: [npc], ghost: null } as NpcCtx;
    expect(notice(npc, ctx, 'chill', { x: 7, z: 9.5 })).toBe(true);
    expect(notice(npc, ctx, 'sound', { x: 9, z: 9.5 })).toBe(true);
    expect(npc.s.notice?.kind).toBe('sound');
    expect(notice(npc, ctx, 'chill', { x: 7, z: 9.5 })).toBe(false);
    expect(npc.s.notice?.kind).toBe('sound');
  });
  test('胆小的盯得久：noticeHold 1.5 倍', () => {
    const end = (personality: 'timid' | 'average') => {
      const w = createWorld({ seed: 3, autoSpawn: false });
      const n = w.spawn({ pos: HALL, lookDir: NORTH, personality });
      w.trigger('music-box');
      let t = 0;
      while (t < 5) { w.step(DT); t += DT; if (t > 0.1 && !n.notice) break; }
      return t;
    };
    const r = end('timid') / end('average');
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThan(1.8);
  });
});
