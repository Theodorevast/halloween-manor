// 鬼魂贴近（第三人称改版，config/visitors.ts 的 GHOST）：发毛的速率、上限、习惯化，后颈一凉的时机和冷却，
// 没有鬼魂时什么都不变，逃跑的人不理会，走慢、回头张望。
// 数值类的测试直接调 feelGhost（不走状态机：人站着不动、恐惧值不回落），算得准；行为类的走完整的 World
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import { Grid } from '../src/sim/grid';
import { createNav, createNpc, feelGhost } from '../src/sim/npc';
import type { Npc, NpcCtx } from '../src/sim/npc';
import { FEAR, GHOST, PERSONALITIES, SPEED } from '../src/config/visitors';
import { PROPS } from '../src/config/house';
import { angleOf, wrapAngle } from '../src/lib/angle';
import { GHOST_SOURCE } from '../src/sim/types';
import type { NpcState, Personality, SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
/** 门厅中间：四周 2 米内没有墙，鬼魂放在 1.5 米内哪个方向都有视线 */
const FOYER = { x: 8, z: 9.5 };
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
/** 鬼魂在这个距离、正后方时的强度（GHOST.full 以内为 1，往外线性减到 radius 为 0） */
const closeness = (d: number) => Math.max(0, Math.min(1, (GHOST.radius - d) / (GHOST.radius - GHOST.full)));

/** 鬼魂相对访客身体朝向的位置：back > 0 在身后 back 米，< 0 在身前 */
const offset = (n: NpcState, back: number): Vec2 => ({ x: n.pos.x - Math.cos(n.heading) * back, z: n.pos.z - Math.sin(n.heading) * back });

// ——— 直接调 feelGhost 的小沙盒 ———

interface Bench {
  npc: Npc;
  ctx: NpcCtx;
  events: SimEvent[];
  /** 推进 seconds 秒，每步先按 ghostAt 摆好鬼魂（null = 没有鬼魂）；返回期间的事件和它们发生的时间 */
  run(seconds: number, ghostAt: (n: NpcState) => Vec2 | null): { ev: SimEvent[]; at: number[] };
}

function bench(personality: Personality = 'average', pos: Vec2 = FOYER, heading = 0): Bench {
  const events: SimEvent[] = [];
  const ctx: NpcCtx = {
    nav: createNav(new Grid()),
    rng: createRng(7),
    now: 0,
    dt: DT,
    events,
    onScream: () => {},
    onFlee: () => {},
    crowd: [],
    ghost: null,
  };
  const npc = createNpc({ id: 1, name: 'Ada', personality, pos, lookDir: heading, mode: 'wander', now: 0 }, ctx);
  return {
    npc,
    ctx,
    events,
    run(seconds, ghostAt) {
      const ev: SimEvent[] = [], at: number[] = [];
      const steps = Math.round(seconds / DT);
      for (let k = 0; k < steps; k++) {
        ctx.ghost = ghostAt(npc.s);
        const before = events.length;
        feelGhost(npc, ctx);
        for (let i = before; i < events.length; i++) {
          ev.push(events[i]);
          at.push(ctx.now);
        }
        ctx.now += DT;
      }
      return { ev, at };
    },
  };
}

/** 一直贴在身后 back 米 */
const behind = (back: number) => (n: NpcState) => offset(n, back);
const chills = (ev: SimEvent[], neck: boolean) => ofType(ev, 'chill').filter((e) => e.neck === neck);

describe('鬼魂：发毛（feelGhost）', () => {
  test('慢慢涨：每 chillEvery 秒结算一小步（chill，neck: false），每步的量 ≈ rate × 强度 × 性格倍率 × chillEvery，加起来就是涨的恐惧值', () => {
    const b = bench('average');
    const d = 1.0; // 在 neckRadius 外：只发毛，不会后颈一凉
    expect(d).toBeGreaterThan(GHOST.neckRadius);
    const { ev, at } = b.run(10, behind(d));
    const steps = chills(ev, false);
    const times = at.filter((_, k) => ev[k].type === 'chill');
    expect(chills(ev, true)).toEqual([]);
    expect(Math.abs(steps.length - 10 / GHOST.chillEvery)).toBeLessThanOrEqual(1);
    for (let k = 1; k < times.length; k++) expect(times[k] - times[k - 1]).toBeCloseTo(GHOST.chillEvery, 1);
    // 第一步：还几乎没有习惯，量在「一点没习惯」和「按这一步末尾的习惯程度」之间
    const u = closeness(d), mult = PERSONALITIES.average.fearMult;
    const full = GHOST.rate * u * mult * GHOST.chillEvery;
    expect(steps[0].amount).toBeLessThanOrEqual(full + 1e-9);
    expect(steps[0].amount).toBeGreaterThanOrEqual(full * FEAR.habituation ** ((u * GHOST.chillEvery) / GHOST.habitPer) - 1e-9);
    // 每一步都是被吓（≥ holdMin，回落不会开始），恐惧值 = 各步之和
    expect(b.npc.s.fear).toBeCloseTo(steps.reduce((a, e) => a + e.amount, 0), 9);
    // 10 秒涨的总量远小于一次惊吓物件：是「慢慢」涨
    expect(b.npc.s.fear).toBeLessThan(GHOST.rate * mult * 10);
  });

  test('背后比面前瘆人、越近越强、超出 radius 就没有', () => {
    const first = (back: number, personality: Personality = 'average') => chills(bench(personality).run(1, behind(back)).ev, false)[0]?.amount ?? 0;
    const back = first(1.0), front = first(-1.0);
    expect(front / back).toBeCloseTo(GHOST.front, 2);
    expect(first(1.2) / back).toBeCloseTo(closeness(1.2) / closeness(1.0), 2);
    expect(first(GHOST.radius + 0.1)).toBe(0);
    // 性格倍率照样乘
    expect(first(1.0, 'timid') / back).toBeCloseTo(PERSONALITIES.timid.fearMult / PERSONALITIES.average.fearMult, 6);
  });

  test('隔着墙（没有视线）按 wallFactor 倍的距离算：同样 1.2 米，隔墙就感觉不到', () => {
    // 走廊北侧，鬼魂在书房里（中间是第 9 行的墙）；对照：同样距离、在走廊里
    const p = { x: 6.25, z: 5.25 };
    const through = { x: 6.25, z: 4.05 }, open = { x: 7.45, z: 5.25 };
    expect(new Grid().lineOfSight(p, through)).toBe(false);
    expect(new Grid().lineOfSight(p, open)).toBe(true);
    expect(GHOST.radius * GHOST.wallFactor).toBeLessThan(1.2);
    expect(chills(bench('average', p).run(1, () => through).ev, false)).toEqual([]);
    expect(chills(bench('average', p).run(1, () => open).ev, false).length).toBe(1);
  });

  test('上限（发毛的习惯化）：一直贴着，每步越来越少，涨的总量不超过 rate × habitPer / ln 2 × 性格倍率', () => {
    const b = bench('timid');
    const { ev } = b.run(300, behind(0.9));
    const steps = chills(ev, false);
    for (let k = 1; k < steps.length; k++) expect(steps[k].amount).toBeLessThanOrEqual(steps[k - 1].amount + 1e-12);
    expect(steps[steps.length - 1].amount).toBeLessThan(steps[0].amount * 0.02);
    const total = steps.reduce((a, e) => a + e.amount, 0);
    const cap = (GHOST.rate * PERSONALITIES.timid.fearMult * GHOST.habitPer) / Math.log(1 / FEAR.habituation);
    expect(total).toBeLessThanOrEqual(cap);
    expect(total).toBeGreaterThan(cap * 0.8 * closeness(0.9)); // 强度 < 1 时更慢地趋近同一个上限
    // 习惯了以后的那一点点寒意不算被吓：低于 holdMin 的步不让回落重新计时
    expect(b.npc.lastScare).toBeLessThan(b.ctx.now - FEAR.decayDelay);
  });

  test('习惯化会恢复：离开 habitRecover 秒恢复一次减半；离开够久就和没贴过一样', () => {
    const fresh = chills(bench().run(1, behind(1.0)).ev, false)[0].amount;
    const b = bench();
    const before = chills(b.run(60, behind(1.0)).ev, false);
    const last = before[before.length - 1].amount;
    b.run(GHOST.habitRecover, () => null);
    const back = chills(b.run(1, behind(1.0)).ev, false)[0].amount;
    expect(back).toBeGreaterThan(last * 1.5); // 恢复了一次减半（还有这一步里的一点点新习惯）
    expect(back).toBeLessThan(fresh);
    b.run(60 * 10, () => null);
    expect(chills(b.run(1, behind(1.0)).ev, false)[0].amount).toBeCloseTo(fresh, 9);
  });

  test('后颈一凉：neckRadius 内停留 neckDwell 秒 → chill（neck）+ startle（object = GHOST_SOURCE，同一笔恐惧值）', () => {
    const b = bench('average');
    const { ev, at } = b.run(GHOST.neckDwell + 0.5, behind(0.4));
    const k = ev.findIndex((e) => e.type === 'chill' && e.neck);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(at[k]).toBeGreaterThanOrEqual(GHOST.neckDwell - DT - 1e-9);
    expect(at[k]).toBeLessThanOrEqual(GHOST.neckDwell + 1e-9);
    const amount = GHOST.neckFear * PERSONALITIES.average.fearMult;
    expect(ev[k]).toEqual({ type: 'chill', npc: 1, amount, neck: true });
    expect(ev[k + 1]).toEqual({ type: 'startle', npc: 1, object: GHOST_SOURCE, amount, scream: amount >= FEAR.screamAt });
    expect(b.npc.s.mode).toBe('startled');
    // 猛地照向身后（鬼魂那边），什么也没有
    expect(Math.abs(wrapAngle(b.npc.s.lookDir - (b.npc.s.heading + Math.PI)))).toBeLessThan(1e-6);
    // 只有这一次
    expect(ofType(ev, 'startle').length).toBe(1);
  });

  test('每人单独冷却：冷却 neckCooldown 秒里不累计，之后再停留 neckDwell 秒才有下一次（按习惯化减弱）；别人不受影响', () => {
    const b = bench('timid');
    const { ev, at } = b.run(30, behind(0.4));
    const necks = ev.map((e, k) => [e, at[k]] as const).filter(([e]) => e.type === 'chill' && e.neck);
    expect(necks.length).toBe(Math.floor((30 - GHOST.neckDwell) / (GHOST.neckCooldown + GHOST.neckDwell)) + 1);
    for (let k = 1; k < necks.length; k++) {
      expect(necks[k][1] - necks[k - 1][1]).toBeCloseTo(GHOST.neckCooldown + GHOST.neckDwell, 1);
    }
    const gap = necks[1][1] - necks[0][1];
    const second = (necks[1][0] as Extract<SimEvent, { type: 'chill' }>).amount;
    const base = GHOST.neckFear * PERSONALITIES.timid.fearMult;
    expect(second).toBeCloseTo(base * FEAR.habituation ** Math.max(0, 1 - gap / FEAR.habituationRecover), 9);

    // 另一个人：刚吹完 a，马上去贴 b，b 照样 neckDwell 秒后一凉
    const a = bench('average'), c = bench('average', { x: 9, z: 9.5 });
    a.run(GHOST.neckDwell, behind(0.4));
    expect(a.npc.neckReadyAt).toBeGreaterThan(a.ctx.now);
    c.ctx.now = a.ctx.now;
    const cr = c.run(GHOST.neckDwell + DT, behind(0.4));
    expect(chills(cr.ev, true).length).toBe(1);
  });

  test('短暂离开不清零：累计的停留按 neckDecay 回落，回来补够就一凉', () => {
    const b = bench();
    const stay = 1.5, away = 0.5;
    expect(stay).toBeLessThan(GHOST.neckDwell);
    b.run(stay, behind(0.4));
    b.run(away, behind(GHOST.radius + 0.5));
    const left = GHOST.neckDwell - (stay - away * GHOST.neckDecay);
    const { ev, at } = b.run(left + 0.2, behind(0.4));
    const k = ev.findIndex((e) => e.type === 'chill' && e.neck);
    expect(at[k] - (stay + away)).toBeCloseTo(left, 1);
  });

  test('没有鬼魂 / 逃跑中：不发毛、不一凉，发毛程度回落到 0', () => {
    const b = bench('timid');
    b.run(1, behind(0.4));
    expect(b.npc.s.uneasy).toBeGreaterThan(0.5);
    const fear = b.npc.s.fear;
    // 鬼魂走开时还没结算的那一点，最多 chillEvery 秒后结算掉（chill 的总和始终等于涨的恐惧值）；之后就没有了
    const tail = b.run(GHOST.chillEvery, () => null);
    expect(chills(tail.ev, false).length).toBeLessThanOrEqual(1);
    expect(b.npc.s.fear - fear).toBeCloseTo(chills(tail.ev, false).reduce((a, e) => a + e.amount, 0), 9);
    const none = b.run(3, () => null);
    expect(ofType(none.ev, 'chill')).toEqual([]);
    expect(b.npc.s.uneasy).toBe(0);

    const f = bench('timid');
    f.npc.s.mode = 'fleeing';
    const fl = f.run(5, behind(0.3));
    expect(fl.ev).toEqual([]);
    expect(f.npc.s.uneasy).toBe(0);
    expect(f.npc.s.fear).toBe(0);
  });

  test('单次后颈一凉不可能把恐惧值为 0 的人直接吓跑（和目标 4 一样）', () => {
    const maxMult = Math.max(...Object.values(PERSONALITIES).map((p) => p.fearMult));
    expect(GHOST.neckFear * maxMult).toBeLessThan(FEAR.max);
  });
});

// ——— 完整的 World ———

/** 按 chunk 秒一段推进，每步前 ghostAt 摆鬼魂 */
function drive(w: World, seconds: number, ghostAt: () => Vec2 | null, each?: () => void): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    w.setGhost(ghostAt());
    ev.push(...w.step(DT));
    each?.();
  }
  return ev;
}

describe('鬼魂：World', () => {
  test('setGhost(null) 和从来不设一样（触屏的俯视模式什么都不变）；鬼魂在屋外远处也一样', () => {
    const play = (ghost: 'never' | 'null' | 'far') => {
      const w = createWorld({ seed: 77 });
      const ids = PROPS.map((p) => p.id);
      const log: SimEvent[] = [];
      for (let k = 0; k < 60 * 120; k++) {
        if (k % 90 === 0) w.trigger(ids[(k / 90) % ids.length]);
        if (ghost === 'null') w.setGhost(null);
        if (ghost === 'far') w.setGhost({ x: -10, z: -10 });
        log.push(...w.step(DT));
      }
      return { log, state: JSON.stringify(w.state) };
    };
    const never = play('never');
    expect(ofType(never.log, 'flee').length).toBeGreaterThan(0); // 这一局确实有事发生
    expect(ofType(never.log, 'chill')).toEqual([]);
    expect(play('null')).toEqual(never);
    expect(play('far')).toEqual(never);
    expect(JSON.parse(never.state).npcs.every((n: NpcState) => n.uneasy === 0)).toBe(true);
  });

  test('GHOST_SOURCE 不是物件 id（画面 / 声音按 id 找物件时会找不到，要判空）', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    expect(w.state.objects.some((o) => o.id === GHOST_SOURCE)).toBe(false);
  });

  test('一直贴在身后：发毛、后颈一凉、受惊僵住后照常恢复；中途 setGhost(null) 以后不再有 chill', () => {
    const w = createWorld({ seed: 78, autoSpawn: false });
    const n = w.spawn({ pos: FOYER, personality: 'average' });
    // 第一次一凉在 neckDwell 秒，下一次要等冷却完再停留 neckDwell 秒：取两次之间的时长
    const seconds = GHOST.neckDwell + GHOST.neckCooldown + GHOST.neckDwell / 2;
    const ev = drive(w, seconds, () => offset(n, 0.4));
    expect(chills(ev, false).length).toBeGreaterThan(5);
    const necks = chills(ev, true);
    expect(necks.length).toBe(1);
    expect(ofType(ev, 'startle').filter((e) => e.object === GHOST_SOURCE).map((e) => e.amount)).toEqual(necks.map((e) => e.amount));
    expect(n.mode).not.toBe('startled'); // 僵住 FEAR.startleTime 秒后照常恢复
    drive(w, GHOST.chillEvery, () => null); // 还没结算的那一点在这段时间里结算掉
    const quiet = drive(w, 3, () => null);
    expect(ofType(quiet, 'chill')).toEqual([]);
    expect(n.uneasy).toBe(0);
  });

  test('发毛的人走得慢（巡航速度 × (1 − slow × 发毛程度)）；逃跑的人不理会鬼魂', () => {
    const goal = { x: 2.5, z: 2.5 }; // 书房：从门厅过去要穿过走廊，路够长
    const walker = (ghost: boolean) => {
      const w = createWorld({ seed: 79, autoSpawn: false });
      const n = w.spawn({ pos: FOYER, personality: 'average', goal });
      let max = 0, uneasyMin = 1;
      drive(w, 8, () => (ghost ? offset(n, 1.0) : null), () => {
        if (w.state.time > 1.5) {
          max = Math.max(max, n.speed);
          uneasyMin = Math.min(uneasyMin, n.uneasy ?? 0);
        }
      });
      return { max, uneasyMin };
    };
    const calm = walker(false), uneasy = walker(true);
    expect(calm.max).toBeCloseTo(SPEED.wander, 5);
    expect(uneasy.uneasyMin).toBeGreaterThan(0.1);
    expect(uneasy.max).toBeLessThanOrEqual(SPEED.wander * (1 - GHOST.slow * uneasy.uneasyMin) + 1e-9);

    const w = createWorld({ seed: 80, autoSpawn: false });
    const n = w.spawn({ pos: FOYER, personality: 'timid' });
    n.fear = FEAR.max;
    let max = 0;
    const ev = drive(w, 4, () => offset(n, 0.3), () => (max = Math.max(max, n.speed)));
    expect(n.mode === 'fleeing' || w.state.npcs.length === 0).toBe(true);
    expect(ofType(ev, 'chill')).toEqual([]);
    expect(max).toBeCloseTo(SPEED.flee, 5);
  });

  test('偶尔回头张望：手电（和身体）转向鬼魂所在的方向，什么也看不见；不是一直回头', () => {
    const w = createWorld({ seed: 81, autoSpawn: false });
    const n = w.spawn({ pos: FOYER, personality: 'average', goal: { x: 13.5, z: 2.5 } });
    let looking = 0, glances = 0, was = false, lastStart = -Infinity, minGap = Infinity, ghost = offset(n, 1.0);
    drive(w, 40, () => (ghost = offset(n, 1.0)), () => {
      if (n.mode === 'startled' || n.mode === 'fleeing') return;
      const toGhost = angleOf(ghost.x - n.pos.x, ghost.z - n.pos.z);
      const now = Math.abs(wrapAngle(n.lookDir - toGhost)) < 0.3;
      if (now && !was) {
        glances++;
        minGap = Math.min(minGap, w.state.time - lastStart);
        lastStart = w.state.time;
      }
      if (now) looking++;
      was = now;
    });
    expect(glances).toBeGreaterThanOrEqual(3);
    expect(minGap).toBeGreaterThanOrEqual(GHOST.glanceGap);
    expect(looking * DT).toBeLessThan(40 * 0.4);
  });
});
