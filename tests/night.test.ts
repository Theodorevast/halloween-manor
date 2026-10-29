// 「一夜」的模拟（2026-10-30，路 NS）：开局间隔（WorldOptions.openingGaps）、收夜（World.close / reopen）、最后一位（spawn 事件的 last）、
// 天亮（World.dawn：屋里的人变 leaving，自己走出前门，exit 带 calm）、一夜里不重名（pickName 避开最近进来的 RECENT_NAMES 个）。
// 这些开关默认关着：不给 openingGaps、不调 close / dawn 时，模拟和原来逐步相同——Spawner 对着原来算法的一份拷贝逐步对比，
// 整个世界对着等价的另一种写法逐步对比；平衡数字由 tests/balance.test.ts 管（它不给这些开关，数字一个都不能变）
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { pickName, pickPersonality, RECENT_NAMES, Spawner } from '../src/sim/spawner';
import { Grid } from '../src/sim/grid';
import { cellCenter, FRONT_DOOR, PROPS, propCenter, ROOMS } from '../src/config/house';
import { NIGHT } from '../src/config/night';
import { FEAR, NAMES, SPAWN, SPEED } from '../src/config/visitors';
import type { NpcState, SimEvent, Vec2, World, WorldOptions } from '../src/sim/types';

const DT = 1 / 60;
/** 一夜里「最近进来过的」要避开的名字数（计划定的 24）。测试里用这个字面数，不用导出的常量，常量被改了测试才会发现 */
const WINDOW = 24;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** 带模拟时刻的事件（step 返回之后的 state.time） */
interface Stamped { t: number; e: SimEvent }
const events = (xs: Stamped[]) => xs.map((x) => x.e);

/** 一步一步推到模拟时间 t（hit-stop 里时间不走，所以按时间推，不按步数）；each 每步之前调一次 */
function runTo(w: World, t: number, each?: () => void): Stamped[] {
  const out: Stamped[] = [];
  while (w.state.time < t - 1e-9) {
    each?.();
    for (const e of w.step(DT)) out.push({ t: w.state.time, e });
  }
  return out;
}
/** 推进 seconds 秒 */
const runFor = (w: World, seconds: number, each?: () => void) => runTo(w, w.state.time + seconds, each);
/** 推到屋里一个人都没有（最多 maxSeconds 秒）；返回期间的事件 */
function runUntilEmpty(w: World, maxSeconds = 90): Stamped[] {
  const out: Stamped[] = [];
  const end = w.state.time + maxSeconds;
  while (w.state.npcs.length > 0 && w.state.time < end) out.push(...runFor(w, DT));
  return out;
}
/** 把 n 吓到涨满恐惧值：下一步起逃跑（状态机里「涨满就逃」的兜底，测试里常这么用） */
const scareAway = (n: NpcState) => void (n.fear = FEAR.max);
const spawnTimes = (xs: Stamped[]) => xs.filter((x) => x.e.type === 'spawn').map((x) => x.t);

const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
const bearing = (from: Vec2, to: Vec2) => Math.atan2(to.z - from.z, to.x - from.x);
/** 研究室里正对肖像的位置（和 tests/world.test.ts 一样） */
const STUDY = { x: 2.75, z: 3.75 };
/** 卧室里离前门最远的角落附近能站的格子（走出去要先出卧室门、穿过走廊、再下到门厅，十几米） */
const BEDROOM_FAR = cellCenter(ROOMS.bedroom.x0 + 6, ROOMS.bedroom.z1 - 2);
/** 门厅里挨着前门里面的位置 */
const NEAR_DOOR = { x: FRONT_DOOR.inside.x, z: FRONT_DOOR.inside.z - 1.5 };

// ——————————————————————————————————————————————————————————————————
// 开局间隔
// ——————————————————————————————————————————————————————————————————

describe('开局间隔（openingGaps）', () => {
  test('Spawner：第一个仍在 SPAWN.first，之后每个隔 openingGaps 里对应的秒数', () => {
    const sp = new Spawner(createRng(1), [25, 25]);
    expect(sp.update(SPAWN.first - 0.01, 0)).toBe(false);
    expect(sp.update(SPAWN.first, 0)).toBe(true);
    // 原来第二个在 SPAWN.stagger（6 秒）以后，现在要等满 25 秒
    expect(sp.update(SPAWN.first + SPAWN.stagger, 1)).toBe(false);
    expect(sp.update(SPAWN.first + 25 - 0.01, 1)).toBe(false);
    expect(sp.update(SPAWN.first + 25, 1)).toBe(true);
    expect(sp.update(SPAWN.first + 25 + SPAWN.stagger, 2)).toBe(false);
    expect(sp.update(SPAWN.first + 50 - 0.01, 2)).toBe(false);
    expect(sp.update(SPAWN.first + 50, 2)).toBe(true);
    // 满员了，开局结束，不再按节奏放人
    for (let t = SPAWN.first + 50, k = 0; k < 60 * 30; k++) expect(sp.update((t += DT), 3)).toBe(false);
  });

  test('Spawner：间隔用完了按 SPAWN.stagger；给的比需要的多，多出来的不用', () => {
    const short = new Spawner(createRng(1), [30]);
    expect(short.update(SPAWN.first, 0)).toBe(true);
    expect(short.update(SPAWN.first + 30 - 0.01, 1)).toBe(false);
    expect(short.update(SPAWN.first + 30, 1)).toBe(true);
    expect(short.update(SPAWN.first + 30 + SPAWN.stagger - 0.01, 2)).toBe(false);
    expect(short.update(SPAWN.first + 30 + SPAWN.stagger, 2)).toBe(true);

    const long = new Spawner(createRng(1), [10, 10, 10, 10, 10]);
    expect(long.update(SPAWN.first, 0)).toBe(true);
    expect(long.update(SPAWN.first + 10, 1)).toBe(true);
    expect(long.update(SPAWN.first + 20, 2)).toBe(true);
    // 满员，开局结束：后面的 10 不会再被用上
    expect(long.update(SPAWN.first + 30, 3)).toBe(false);
  });

  test('世界里：[25, 25] → 2、27、52 秒各进一个，第一个人独自待满 25 秒', () => {
    const w = createWorld({ seed: 7, openingGaps: [25, 25] });
    const ev = runTo(w, 26.9);
    expect(w.state.npcs.length).toBe(1);
    ev.push(...runTo(w, 27.1));
    expect(w.state.npcs.length).toBe(2);
    ev.push(...runTo(w, 51.9));
    expect(w.state.npcs.length).toBe(2);
    ev.push(...runTo(w, 52.1));
    expect(w.state.npcs.length).toBe(3);
    ev.push(...runTo(w, 90));
    expect(spawnTimes(ev).length).toBe(3);
    [SPAWN.first, SPAWN.first + 25, SPAWN.first + 50].forEach((t, k) => expect(spawnTimes(ev)[k]).toBeCloseTo(t, 1));
    // 一直没人被吓、没人走
    expect(ofType(events(ev), 'exit')).toEqual([]);
  });

  test('第一个人在第二个进门之前就走了：时刻表照旧，第二个、第三个照样按间隔来', () => {
    const w = createWorld({ seed: 8, openingGaps: [25, 25] });
    runTo(w, 8);
    scareAway(w.state.npcs[0]);
    const ev = runTo(w, 60);
    expect(ofType(events(ev), 'exit').length).toBe(1);
    const t = spawnTimes(ev);
    [SPAWN.first + 25, SPAWN.first + 50].forEach((at, k) => expect(t[k]).toBeCloseTo(at, 1));
  });

  test('正式游戏的开局（NIGHT.openingGaps）：第一个人独自待满第一个间隔，之后按各自的间隔进第二、第三个', () => {
    const [g0, g1] = NIGHT.openingGaps;
    const w = createWorld({ seed: 9, openingGaps: NIGHT.openingGaps });
    const ev = runTo(w, SPAWN.first + g0 - 0.2);
    expect(w.state.npcs.length).toBe(1);
    ev.push(...runTo(w, SPAWN.first + g0 + g1 + 1));
    expect(spawnTimes(ev).length).toBe(3);
    [SPAWN.first, SPAWN.first + g0, SPAWN.first + g0 + g1].forEach((t, k) => expect(spawnTimes(ev)[k]).toBeCloseTo(t, 1));
    // 第二个人比第一个人晚到的这一段，远远长过原来的 SPAWN.stagger
    expect(g0).toBeGreaterThan(SPAWN.stagger);
  });
});

// ——————————————————————————————————————————————————————————————————
// 不给就和原来一模一样
// ——————————————————————————————————————————————————————————————————

/** 原来的 Spawner（2026-10-30 之前的算法，一字不改搬过来）：不给 openingGaps、不 close 时，现在的 Spawner 要和它逐步一样 */
class LegacySpawner {
  private opening = true;
  private nextAt: number | null = SPAWN.first;
  private readonly rng: Rng;
  constructor(rng: Rng) {
    this.rng = rng;
  }
  update(time: number, inHouse: number): boolean {
    if (this.opening) {
      if (time + 1e-6 < this.nextAt!) return false;
      const go = inHouse < SPAWN.target;
      if (inHouse + (go ? 1 : 0) < SPAWN.target) this.nextAt! += SPAWN.stagger;
      else {
        this.opening = false;
        this.nextAt = null;
      }
      return go;
    }
    if (this.nextAt === null) {
      if (inHouse < SPAWN.target) this.nextAt = time + this.rng.range(SPAWN.delay[0], SPAWN.delay[1]);
      return false;
    }
    if (time + 1e-6 < this.nextAt) return false;
    this.nextAt = null;
    return inHouse < SPAWN.target;
  }
}

/** 两串很长的文本第一处不同在哪（一样返回 null）：失败时只报这一处，不让 vitest 去 diff 几 MB 的字符串 */
function firstDiff(a: string, b: string): string | null {
  if (a === b) return null;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return `第 ${i} 个字符起不同（共 ${a.length} / ${b.length}）：${a.slice(Math.max(0, i - 60), i + 80)} ≠ ${b.slice(Math.max(0, i - 60), i + 80)}`;
}

/** 一局的脚本（固定的操作顺序）：随机附身、设机关、现身、鬼魂贴着访客走；poke 在某一步额外做点什么 */
function scripted(opts: WorldOptions, seconds: number, poke?: (w: World, k: number) => void) {
  const w = createWorld(opts);
  const bot = createRng(opts.seed * 31 + 7);
  const ids = w.state.objects.map((o) => o.id);
  const all: SimEvent[] = [];
  for (let k = 0; k < seconds * 60; k++) {
    if (k % 120 === 0) {
      const r = bot.next();
      if (r < 0.5) w.trigger(bot.pick(ids));
      else if (r < 0.7) w.arm(bot.pick(ids));
      else if (r < 0.8) w.manifest();
    }
    const near = w.state.npcs[Math.floor(k / 600) % Math.max(1, w.state.npcs.length)];
    w.setGhost(near ? { x: near.pos.x - 0.5, z: near.pos.z, inWall: k % 900 < 30 } : null);
    poke?.(w, k);
    all.push(...w.step(DT));
  }
  return { events: JSON.stringify(all), state: JSON.stringify(w.state), raw: all };
}

describe('不给 openingGaps、不调 close / dawn 时和原来一模一样', () => {
  test('Spawner 对着原来算法的拷贝：逐步给出一样的结果，抽随机数的次数、顺序也一样', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rngA = createRng(seed), rngB = createRng(seed);
      const now = new Spawner(rngA), old = new LegacySpawner(rngB);
      const bot = createRng(seed + 1000);
      let inHouse = 0, t = 0, mismatches = 0, spawned = 0;
      for (let k = 0; k < 60 * 900; k++) {
        t += DT;
        const a = now.update(t, inHouse), b = old.update(t, inHouse);
        if (a !== b) mismatches++;
        if (a) {
          inHouse++;
          spawned++;
        }
        // 屋里平均每 10 秒走一个；偶尔调试时手动多放一个
        if (bot.next() < 1 / 600) inHouse = Math.max(0, inHouse - 1);
        else if (bot.next() < 1 / 1800) inHouse++;
      }
      expect(mismatches).toBe(0);
      expect(spawned).toBeGreaterThan(30); // 确实反复补了很多次人，不是空转
      expect(rngA.next()).toBe(rngB.next()); // 两边抽了同样多次
    }
  });

  test('整个世界：不给 openingGaps / 给 undefined / 给 [] / 给 [SPAWN.stagger, SPAWN.stagger]，事件和最后的状态逐个相同', () => {
    for (const seed of [1, 2, 3]) {
      const base = scripted({ seed }, 240);
      expect(base.raw.length).toBeGreaterThan(100); // 脚本确实把各种事件都弄出来了
      for (const openingGaps of [undefined, [], [SPAWN.stagger, SPAWN.stagger]]) {
        const other = scripted({ seed, openingGaps }, 240);
        expect(firstDiff(other.events, base.events)).toBeNull();
        expect(firstDiff(other.state, base.state)).toBeNull();
      }
    }
  });

  test('没收夜时调 reopen() 什么都不做，不打乱已经排好的', () => {
    for (const seed of [1, 2]) {
      const base = scripted({ seed }, 200);
      const poked = scripted({ seed }, 200, (w, k) => {
        if (k % 600 === 301) w.reopen();
      });
      expect(firstDiff(poked.events, base.events)).toBeNull();
      expect(firstDiff(poked.state, base.state)).toBeNull();
    }
  });

  test('平常的 spawn 事件没有 last，exit 事件没有 calm（键都不存在）', () => {
    const w = createWorld({ seed: 4 });
    const ev = runTo(w, 150, () => {
      // 隔一阵吓走一个，让进、出都发生很多次
      if (Math.floor(w.state.time * 60) % 600 === 0) {
        const n = w.state.npcs.find((x) => x.mode !== 'fleeing');
        if (n) scareAway(n);
      }
    });
    const spawns = ofType(events(ev), 'spawn'), exits = ofType(events(ev), 'exit');
    expect(spawns.length).toBeGreaterThan(5);
    expect(exits.length).toBeGreaterThan(3);
    for (const e of spawns) expect(Object.keys(e).sort()).toEqual(['npc', 'type']);
    for (const e of exits) expect(Object.keys(e).sort()).toEqual(['name', 'npc', 'total', 'type']);
  });

  test('一次 spawn 抽两次随机数（性格一次、名字一次）：避开的名字再多也不多抽、不少抽', () => {
    // 用同一颗种子在外面重放：性格、名字一次一抽，与世界里连着放进来的 30 个人逐个对上；
    // 30 个远远超过 WINDOW，避开的名字（屋里的人 + 最近进来的）已经很多
    const seed = 21;
    const w = createWorld({ seed, autoSpawn: false });
    const ref = createRng(seed);
    const names: string[] = [];
    for (let k = 0; k < 30; k++) {
      const personality = pickPersonality(ref);
      const name = pickName(ref, names, names.slice(-WINDOW));
      const n = w.spawn();
      expect(n.personality).toBe(personality);
      expect(n.name).toBe(name);
      names.push(name);
    }
  });
});

// ——————————————————————————————————————————————————————————————————
// 收夜
// ——————————————————————————————————————————————————————————————————

describe('close()：收夜', () => {
  test('之后不再进人：屋里少了人也不补；不收夜的对照局在 SPAWN.delay 范围内就补上了', () => {
    const play = (shut: boolean) => {
      const w = createWorld({ seed: 11 });
      runTo(w, 15);
      expect(w.state.npcs.length).toBe(3);
      if (shut) w.close();
      scareAway(w.state.npcs[0]);
      const t0 = w.state.time;
      return { w, t0, ev: runTo(w, t0 + 120) };
    };
    const control = play(false);
    const spawned = spawnTimes(control.ev);
    expect(spawned.length).toBeGreaterThanOrEqual(1);
    expect(spawned[0] - control.t0).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.1);
    expect(spawned[0] - control.t0).toBeLessThanOrEqual(SPAWN.delay[1] + 0.3);

    const shut = play(true);
    expect(ofType(events(shut.ev), 'spawn')).toEqual([]);
    // 屋里的人照常在：没人被带走，走了的只有被吓跑的那一个
    expect(ofType(events(shut.ev), 'exit').length).toBe(1);
    expect(shut.w.state.npcs.length).toBe(2);
  });

  test('已经排上、还没进门的那一次也取消——开局还没排完的，和开局之后排上的都是', () => {
    // 开局：第一个在 2 秒进来，第二个排在 2 + 25 秒；5 秒时收夜，第二个再也不来
    const opening = createWorld({ seed: 12, openingGaps: [25, 25] });
    runTo(opening, 5);
    expect(opening.state.npcs.length).toBe(1);
    opening.close();
    const ev1 = runTo(opening, 120);
    expect(ofType(events(ev1), 'spawn')).toEqual([]);
    expect(opening.state.npcs.length).toBe(1);

    // 开局之后：走了一个，补人已经排上（SPAWN.delay 秒以后进门），收夜时还没进。
    // 同一颗种子不收夜的对照局里，那一次是进了的（收夜之前两局的随机数完全一样）
    const play = (shut: boolean) => {
      const w = createWorld({ seed: 13 });
      runTo(w, 15);
      scareAway(w.state.npcs[0]);
      runFor(w, 2); // 他开始逃跑，屋里不到 3 人，补人那一次排上了（最早 SPAWN.delay[0] 秒以后进门）
      if (shut) w.close();
      return runFor(w, 60);
    };
    expect(ofType(events(play(false)), 'spawn').length).toBeGreaterThanOrEqual(1);
    expect(ofType(events(play(true)), 'spawn')).toEqual([]);
  });

  test('收夜时屋里没人（都走了）→ 最后再进来一位：spawn 事件带 last，之后再没人来', () => {
    const w = createWorld({ seed: 14, openingGaps: [25, 25] });
    runTo(w, 8);
    scareAway(w.state.npcs[0]);
    runUntilEmpty(w);
    expect(w.state.npcs.length).toBe(0);
    expect(w.state.time).toBeLessThan(SPAWN.first + 25); // 第二个人还没到（排着，马上就被收夜取消）
    w.close();
    // 事件和 spawn() 一样在下一次 step 返回；人已经在门外了
    expect(w.state.npcs.length).toBe(1);
    const last = w.state.npcs[0];
    expect(last.mode).toBe('entering');
    expect(last.pos).toEqual(FRONT_DOOR.outside);
    const ev = events(runFor(w, 100));
    expect(ofType(ev, 'spawn')).toEqual([{ type: 'spawn', npc: last.id, last: true }]);
    // 之后是一位普通的访客：进门、闲逛，没有时限；原来排在 27 秒的第二个人没有来
    expect(w.state.npcs.map((n) => n.id)).toEqual([last.id]);
    expect(last.mode === 'wander' || last.mode === 'alert').toBe(true);
  });

  test('收夜时屋里的人都在逃跑也算没人：最后再进来一位', () => {
    const w = createWorld({ seed: 15, autoSpawn: false });
    const a = w.spawn({ pos: { x: 8, z: 6 }, personality: 'timid' });
    const b = w.spawn({ pos: { x: 9, z: 6.5 }, personality: 'timid' });
    scareAway(a);
    scareAway(b);
    runFor(w, 0.5);
    expect([a.mode, b.mode]).toEqual(['fleeing', 'fleeing']);
    w.close();
    const ev = events(runFor(w, 0.1));
    const spawns = ofType(ev, 'spawn');
    expect(spawns.length).toBe(1);
    expect(spawns[0].last).toBe(true);
    // 逃跑的两个照常跑出去（吓跑 2 人），最后一位不受影响
    runFor(w, 30);
    expect(w.state.scaredOff).toBe(2);
    expect(w.state.npcs.map((n) => n.id)).toEqual([spawns[0].npc]);
  });

  test('收夜时屋里有人 → 不放最后一位', () => {
    const w = createWorld({ seed: 16, autoSpawn: false });
    w.spawn({ pos: { x: 8, z: 6 }, personality: 'brave' });
    w.close();
    const spawns = ofType(events(runFor(w, 60)), 'spawn');
    expect(spawns).toEqual([{ type: 'spawn', npc: 1 }]); // 只有手动放的那一位自己的事件，没有带 last 的
    expect(w.state.npcs.length).toBe(1);

    // 一个在逃跑、一个站着：还有一个人在，就不放
    const v = createWorld({ seed: 17, autoSpawn: false });
    const runner = v.spawn({ pos: { x: 8, z: 6 }, personality: 'timid' });
    v.spawn({ pos: { x: 12, z: 6 }, personality: 'brave' });
    scareAway(runner);
    runFor(v, 0.3);
    expect(runner.mode).toBe('fleeing');
    v.close();
    const ev = events(runFor(v, 30));
    expect(ofType(ev, 'spawn').filter((e) => e.last)).toEqual([]);
    expect(v.state.npcs.length).toBe(1);
  });

  test('屋里的人照常闹，没有时限：收夜 10 分钟以后三位都还在，吓满了照常逃跑、计数；最后一个走了也没人再来', () => {
    const w = createWorld({ seed: 18 });
    runTo(w, 15);
    const inside = [...w.state.npcs];
    expect(inside.length).toBe(3);
    w.close();
    const ev = runFor(w, 600);
    expect(ofType(events(ev), 'exit')).toEqual([]);
    expect(ofType(events(ev), 'spawn')).toEqual([]);
    expect(w.state.npcs.map((n) => n.id)).toEqual(inside.map((n) => n.id));
    // 吓满了照常逃跑，exit 的 total 一个一个加
    for (const n of inside) scareAway(n);
    const ev2 = events(runUntilEmpty(w));
    expect(ofType(ev2, 'flee').length).toBe(3);
    expect(ofType(ev2, 'exit').map((e) => e.total)).toEqual([1, 2, 3]);
    expect(ofType(ev2, 'exit').every((e) => e.calm === undefined)).toBe(true);
    expect(w.state.scaredOff).toBe(3);
    expect(ofType(events(runFor(w, 120)), 'spawn')).toEqual([]);
  });

  test('收夜以后自动生成也不再补人：整个开局过完、全员被吓跑，屋里空着', () => {
    const w = createWorld({ seed: 19 });
    runTo(w, 15);
    w.close();
    const ev = runFor(w, 5, () => {
      for (const n of w.state.npcs) if (n.mode !== 'fleeing') scareAway(n);
    });
    ev.push(...runUntilEmpty(w));
    expect(ofType(events(ev), 'spawn')).toEqual([]);
    expect(w.state.scaredOff).toBe(3);
    expect(ofType(events(runFor(w, 120)), 'spawn')).toEqual([]);
  });

  test('close() 连着调两次，只放一位；没有自动生成（autoSpawn: false）的世界屋里没人时收夜也放一位', () => {
    const w = createWorld({ seed: 20, autoSpawn: false });
    w.close();
    w.close();
    const spawns = ofType(events(runFor(w, 1)), 'spawn');
    expect(spawns).toEqual([{ type: 'spawn', npc: 1, last: true }]);
    expect(w.state.npcs.length).toBe(1);
  });
});

// ——————————————————————————————————————————————————————————————————
// 又开门
// ——————————————————————————————————————————————————————————————————

describe('reopen()：收夜以后接着闹', () => {
  test('屋里空了以后 reopen：照常补人，一个一个按 SPAWN.delay 来（不是开局的节奏），补到 3 人为止', () => {
    const w = createWorld({ seed: 22, openingGaps: [25, 25] });
    runTo(w, 8);
    scareAway(w.state.npcs[0]);
    runUntilEmpty(w);
    w.close(); // 最后一位进来
    runFor(w, 5);
    expect(w.state.npcs.length).toBe(1);
    scareAway(w.state.npcs[0]);
    runUntilEmpty(w);
    expect(w.state.npcs.length).toBe(0);

    const t0 = w.state.time;
    w.reopen();
    const ev = runTo(w, t0 + 150);
    const t = spawnTimes(ev);
    expect(t.length).toBe(SPAWN.target); // 补满 3 个，到数就停
    [t[0] - t0, t[1] - t[0], t[2] - t[1]].forEach((gap) => {
      expect(gap).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.05);
      expect(gap).toBeLessThanOrEqual(SPAWN.delay[1] + 0.1);
    });
    expect(ofType(events(ev), 'spawn').some((e) => e.last)).toBe(false);
    expect(w.state.npcs.length).toBe(SPAWN.target);
  });

  test('屋里还有人时收夜、马上 reopen：原来排着的那一次作废，重新按 SPAWN.delay 排，不按开局的时刻', () => {
    const w = createWorld({ seed: 23, openingGaps: [25, 25] });
    runTo(w, 5);
    w.close();
    runFor(w, 1);
    const t0 = w.state.time;
    w.reopen();
    const ev = runTo(w, t0 + 120);
    const t = spawnTimes(ev);
    expect(t.length).toBe(SPAWN.target - 1);
    // 开局时第二个排在 27 秒；现在是 reopen 以后 SPAWN.delay 秒
    expect(t[0] - t0).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.05);
    expect(t[0] - t0).toBeLessThanOrEqual(SPAWN.delay[1] + 0.1);
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.05);
    expect(t[1] - t[0]).toBeLessThanOrEqual(SPAWN.delay[1] + 0.1);
  });

  test('close → reopen → close：第二次收夜屋里没人时又放一位', () => {
    const w = createWorld({ seed: 24, autoSpawn: false });
    w.close();
    runFor(w, 1);
    expect(w.state.npcs.length).toBe(1);
    scareAway(w.state.npcs[0]);
    runUntilEmpty(w);
    w.reopen();
    w.close();
    const spawns = ofType(events(runFor(w, 1)), 'spawn');
    expect(spawns.map((e) => e.last)).toEqual([true]);
    expect(w.state.npcs.length).toBe(1);
  });
});

// ——————————————————————————————————————————————————————————————————
// 天亮
// ——————————————————————————————————————————————————————————————————

/** 一个人，在 pos 出现，天亮时 mode 是下面各种之一；返回他和世界。每个都跑到「这个状态」才结束 */
const DAWN_SCENES: [string, () => { w: World; n: NpcState }][] = [
  ['刚进门（还在门外）', () => {
    const w = createWorld({ seed: 31, autoSpawn: false });
    const n = w.spawn({ personality: 'average' });
    runFor(w, 0.5);
    return { w, n };
  }],
  ['在走', () => {
    const w = createWorld({ seed: 32, autoSpawn: false });
    const n = w.spawn({ pos: BEDROOM_FAR, personality: 'average', goal: { x: 12, z: 3 } });
    runFor(w, 2);
    return { w, n };
  }],
  ['站着左右照', () => {
    const w = createWorld({ seed: 33, autoSpawn: false });
    const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'brave' });
    runFor(w, 0.5);
    return { w, n };
  }],
  ['听到声音在察觉（停下盯着声源）', () => {
    const w = createWorld({ seed: 34, autoSpawn: false });
    const n = w.spawn({ pos: { x: 3, z: 9 }, personality: 'average', lookDir: bearing({ x: 3, z: 9 }, prop('music-box')) });
    w.trigger('music-box');
    for (let k = 0; k < 120 && !n.notice; k++) w.step(DT);
    expect(n.notice).not.toBeNull();
    return { w, n };
  }],
  ['听到声音在走过去查看（警觉）', () => {
    const w = createWorld({ seed: 35, autoSpawn: false });
    const n = w.spawn({ pos: { x: 3, z: 9 }, personality: 'average', lookDir: bearing({ x: 3, z: 9 }, prop('music-box')) });
    w.trigger('music-box');
    for (let k = 0; k < 60 * 6 && n.mode !== 'alert'; k++) w.step(DT);
    expect(n.mode).toBe('alert');
    return { w, n };
  }],
  ['被惊吓物件定住盯着（蓄势中）', () => {
    const w = createWorld({ seed: 36, autoSpawn: false });
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearing(STUDY, prop('portrait')) });
    w.trigger('portrait');
    runFor(w, 0.3); // 肖像要 0.94 秒才落下，这时他停着盯着它
    expect(n.speed).toBe(0);
    return { w, n };
  }],
  ['刚被吓到、正僵住', () => {
    const w = createWorld({ seed: 37, autoSpawn: false });
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearing(STUDY, prop('portrait')) });
    w.trigger('portrait');
    for (let k = 0; k < 60 * 3 && n.mode !== 'startled'; k++) w.step(DT);
    expect(n.mode).toBe('startled');
    return { w, n };
  }],
];

describe('dawn()：天亮', () => {
  test.each(DAWN_SCENES)('天亮时%s的人也改成 leaving，放下手上的事，走出前门，出门时 exit 带 calm、不算吓跑', (_name, scene) => {
    const { w, n } = scene();
    w.dawn();
    expect(n.mode).toBe('leaving');
    expect(n.notice ?? null).toBeNull();
    expect(n.path.length).toBeGreaterThan(0);
    const ev = events(runUntilEmpty(w));
    expect(w.state.npcs.length).toBe(0);
    expect(ofType(ev, 'exit')).toEqual([{ type: 'exit', npc: n.id, name: n.name, total: 0, calm: true }]);
    expect(w.state.scaredOff).toBe(0);
    expect(ofType(ev, 'flee')).toEqual([]);
  });

  test('天亮后没人再进来：已经排上的那一次取消，屋里空了也不补最后一位', () => {
    const w = createWorld({ seed: 40, openingGaps: [25, 25] });
    runTo(w, 5);
    expect(w.state.npcs.length).toBe(1);
    w.dawn(); // 第二个排在 27 秒，被取消
    const ev = events(runTo(w, 120));
    expect(ofType(ev, 'spawn')).toEqual([]);
    expect(w.state.npcs.length).toBe(0); // 唯一的一位走出去了
    expect(ofType(ev, 'exit')).toEqual([{ type: 'exit', npc: 1, name: expect.any(String), total: 0, calm: true }]);
    // 空屋子里 close()：已经收夜了（天亮就是先收夜），不会补最后一位
    w.close();
    expect(ofType(events(runFor(w, 60)), 'spawn')).toEqual([]);
  });

  test('走路的速度和闲逛一样（SPEED.wander），一路走到门外；从卧室出来穿过走廊走到前门，路上一直是 leaving', () => {
    const w = createWorld({ seed: 41, autoSpawn: false });
    const n = w.spawn({ pos: BEDROOM_FAR, personality: 'brave', goal: { x: 3, z: 9 } });
    runFor(w, 3);
    w.dawn();
    let maxSpeed = 0, steps = 0;
    const seen = new Set<string>();
    const ev: SimEvent[] = [];
    let lastPos = { ...n.pos };
    while (w.state.npcs.length > 0 && steps++ < 60 * 90) {
      seen.add(n.mode);
      if (n.mode === 'leaving') maxSpeed = Math.max(maxSpeed, n.speed);
      lastPos = { ...n.pos };
      ev.push(...w.step(DT));
    }
    expect(maxSpeed).toBeCloseTo(SPEED.wander, 5);
    // 是走到了门外才算离开（离门外那一点不到半米），不是半路被谁放走的
    expect(Math.hypot(lastPos.x - FRONT_DOOR.outside.x, lastPos.z - FRONT_DOOR.outside.z)).toBeLessThan(0.5);
    // 一路只有 leaving（没有闲逛、警觉），走完才算离开；用时差不多是路程 / 速度
    expect([...seen]).toEqual(['leaving']);
    expect(steps / 60).toBeGreaterThan(5);
    expect(steps / 60).toBeLessThan(25);
    expect(ofType(ev, 'exit').map((e) => e.calm)).toEqual([true]);
  });

  test('路上被吓满：照常逃跑（fleeing），出门的 exit 不带 calm，total 加一；另一位照旧安静地走，total 不动', () => {
    const w = createWorld({ seed: 42, autoSpawn: false });
    const scared = w.spawn({ pos: NEAR_DOOR, personality: 'timid' });
    const calm = w.spawn({ pos: BEDROOM_FAR, personality: 'brave', goal: { x: 3, z: 9 } });
    runFor(w, 1);
    w.dawn();
    runFor(w, 1);
    expect(scared.mode).toBe('leaving');
    scareAway(scared);
    const ev = events(runUntilEmpty(w));
    expect(ofType(ev, 'flee').map((e) => e.npc)).toEqual([scared.id]);
    const exits = ofType(ev, 'exit');
    expect(exits).toEqual([
      { type: 'exit', npc: scared.id, name: scared.name, total: 1 }, // 吓跑的先出门，不带 calm
      { type: 'exit', npc: calm.id, name: calm.name, total: 1, calm: true }, // 安静走的后出，total 还是 1（不加）
    ]);
    expect(w.state.scaredOff).toBe(1);
  });

  test('受惊僵住（startled）完回到 leaving，不回闲逛；声音和引诱不再让他改道、不察觉、不调查，只是涨恐惧值', () => {
    // 肖像把他吓一跳
    const w = createWorld({ seed: 43, autoSpawn: false });
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearing(STUDY, prop('portrait')) });
    w.dawn();
    w.trigger('portrait');
    const modes: string[] = [];
    const ev: SimEvent[] = [];
    for (let steps = 0; w.state.npcs.length > 0 && steps < 60 * 90; steps++) {
      ev.push(...w.step(DT));
      if (modes[modes.length - 1] !== n.mode) modes.push(n.mode);
    }
    expect(ofType(ev, 'startle').filter((e) => e.object === 'portrait').length).toBe(1);
    expect(modes).toEqual(['leaving', 'startled', 'leaving', 'gone'].slice(0, modes.length)); // 只有这几种，没有 wander / alert
    expect(modes.slice(0, 3)).toEqual(['leaving', 'startled', 'leaving']);
    expect(ofType(ev, 'exit').map((e) => e.calm)).toEqual([true]);

    // 近处响起八音盒：他听见了（涨恐惧值），但接着走，不停下盯着、不改道去查看
    const v = createWorld({ seed: 44, autoSpawn: false });
    const at = { x: 3, z: 9 };
    const m = v.spawn({ pos: at, personality: 'average', lookDir: bearing(at, prop('music-box')) });
    v.dawn();
    v.trigger('music-box');
    const evs = events(runFor(v, 1));
    expect(ofType(evs, 'heard').map((e) => e.npc)).toEqual([m.id]);
    expect(m.fear).toBeGreaterThan(0); // 只是会被吓：恐惧值涨了
    expect(m.mode).toBe('leaving'); // 但没有停下盯着，也没有改道去查看
    expect(m.speed).toBeGreaterThan(0);
    evs.push(...events(runUntilEmpty(v)));
    expect(ofType(evs, 'notice')).toEqual([]);
    expect(ofType(evs, 'exit').map((e) => e.calm)).toEqual([true]);
  });

  test('天亮时正在逃跑的人照旧逃跑；已经在 leaving 的人再调 dawn 不重来', () => {
    const w = createWorld({ seed: 45, autoSpawn: false });
    const runner = w.spawn({ pos: { x: 8, z: 6 }, personality: 'timid' });
    const walker = w.spawn({ pos: BEDROOM_FAR, personality: 'brave', goal: { x: 3, z: 9 } });
    scareAway(runner);
    runFor(w, 0.5);
    expect(runner.mode).toBe('fleeing');
    w.dawn();
    expect(runner.mode).toBe('fleeing');
    expect(walker.mode).toBe('leaving');
    runFor(w, 1);
    const path = walker.path;
    w.dawn();
    expect(walker.path).toBe(path);
    const ev = events(runUntilEmpty(w));
    expect(ofType(ev, 'exit')).toEqual([
      { type: 'exit', npc: runner.id, name: runner.name, total: 1 },
      { type: 'exit', npc: walker.id, name: walker.name, total: 1, calm: true },
    ]);
  });

  test('天亮以后 reopen：照常补人，新进来的人闲逛（不是 leaving）；close() 在天亮之后是空操作', () => {
    const w = createWorld({ seed: 46 });
    runTo(w, 15);
    expect(w.state.npcs.length).toBe(3);
    const old = w.state.npcs.map((n) => n.id);
    w.dawn();
    // 还在往外走的时候 reopen：他们照旧走，新来的补上
    const ev = runFor(w, 1); // 刚进门、还在门外的那位这一秒里就掉头出去了
    w.reopen();
    w.close(); // 又开门以后的一次新收夜（屋里还有人，不放最后一位）
    w.reopen();
    const t0 = w.state.time;
    const modes = new Map<number, Set<string>>();
    ev.push(...runTo(w, t0 + 90, () => {
      for (const n of w.state.npcs) {
        if (!modes.has(n.id)) modes.set(n.id, new Set());
        modes.get(n.id)!.add(n.mode);
      }
    }));
    const exits = ofType(events(ev), 'exit');
    // 原来的三位自己走出去了（calm），不算吓跑
    expect(exits.filter((e) => old.includes(e.npc)).map((e) => e.calm)).toEqual([true, true, true]);
    // 新来的从 entering 到 wander，没有谁变成 leaving，也没人走
    const fresh = [...modes.keys()].filter((id) => !old.includes(id));
    expect(fresh.length).toBeGreaterThanOrEqual(2);
    for (const id of fresh) {
      expect(modes.get(id)!.has('leaving')).toBe(false);
      expect(modes.get(id)!.has('wander')).toBe(true);
    }
    expect(exits.filter((e) => fresh.includes(e.npc))).toEqual([]);
    const gaps = spawnTimes(ev).map((t, k, a) => t - (k === 0 ? t0 : a[k - 1]));
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.05);
      expect(g).toBeLessThanOrEqual(SPAWN.delay[1] + 0.1);
    }
  });

  test('几个人同时往门口走：在门洞里一个接一个出去，不会互相卡住（离出口近的先走），几秒就出完，都算安静地走', () => {
    // 这几种站法，离出口近的先走的规则去掉以后，大多数种子都会在门口卡死（两个人也会）
    const groups: [string, Vec2[]][] = [
      ['两个贴着', [{ x: 7.7, z: 10.6 }, { x: 8.3, z: 10.6 }]],
      ['三个并排', [{ x: 7.2, z: 10 }, { x: 8, z: 10 }, { x: 8.8, z: 10 }]],
      ['三个乱站', [{ x: 8.37, z: 10.85 }, { x: 7.52, z: 10.97 }, { x: 8.09, z: 10.46 }]],
      ['四个围着', [{ x: 7.5, z: 10.2 }, { x: 8.5, z: 10.2 }, { x: 7.5, z: 10.9 }, { x: 8.5, z: 10.9 }]],
    ];
    for (const [name, spots] of groups) {
      for (const seed of [1, 2, 3, 4]) {
        const w = createWorld({ seed, autoSpawn: false });
        for (const at of spots) w.spawn({ pos: at, personality: 'average' });
        runFor(w, 0.5);
        w.dawn();
        const t0 = w.state.time;
        const ev = events(runUntilEmpty(w, 30));
        const exits = ofType(ev, 'exit');
        const lastAt = w.state.time - t0;
        expect({ name, seed, left: w.state.npcs.length }).toEqual({ name, seed, left: 0 });
        expect(exits.map((e) => e.calm)).toEqual(spots.map(() => true));
        // 靠自己走出去的几秒就够；兜底（8 秒）是给卡死的人用的，这里一个也不该用上它
        expect(lastAt).toBeLessThan(6);
        expect(w.state.scaredOff).toBe(0);
      }
    }
  });

  test('天亮以后的兜底：要出门的人 8 秒里挪不到半米就放他出去（leaving 带 calm，逃跑的算吓跑）；天亮之前不管', () => {
    // 摆一个要出门却动不了的人：每一步把他放回原处，等于被什么卡住了
    const hold = (n: NpcState) => {
      const at = { x: n.pos.x, z: n.pos.z };
      return () => {
        n.pos.x = at.x;
        n.pos.z = at.z;
      };
    };
    const setup = (seed: number) => {
      const w = createWorld({ seed, autoSpawn: false });
      const walker = w.spawn({ pos: BEDROOM_FAR, personality: 'brave' });
      const runner = w.spawn({ pos: { x: 8, z: 6 }, personality: 'timid' });
      scareAway(runner);
      runFor(w, 0.3);
      expect(runner.mode).toBe('fleeing');
      const holds = [hold(walker), hold(runner)];
      return { w, walker, runner, each: () => holds.forEach((h) => h()) };
    };

    // 天亮之前：卡多久都不管（兜底不是平常的夜里用的），一个逃跑的、一个闲逛的都还在
    const quiet = setup(52);
    runFor(quiet.w, 30, quiet.each);
    expect(quiet.w.state.npcs.map((n) => n.mode)).toEqual(['wander', 'fleeing']);

    // 天亮以后：8 秒左右放出去，各自按自己的身份算
    const { w, walker, runner, each } = setup(51);
    w.dawn();
    const t0 = w.state.time;
    const stamped = runFor(w, 12, each);
    const exits = stamped.filter((x) => x.e.type === 'exit');
    expect(exits.map((x) => x.e)).toEqual([
      { type: 'exit', npc: walker.id, name: walker.name, total: 0, calm: true },
      { type: 'exit', npc: runner.id, name: runner.name, total: 1 },
    ]);
    for (const x of exits) {
      expect(x.t - t0).toBeGreaterThan(7.9);
      expect(x.t - t0).toBeLessThan(8.3);
    }
    expect(w.state.scaredOff).toBe(1);
    expect(w.state.npcs.length).toBe(0);
  });

  test('现有的毛病：两个逃跑的人在前门门洞里迎面对上会互相卡死（这一路没改它）；天亮以后 8 秒左右放他们出去，都算吓跑', () => {
    const w = createWorld({ seed: 53, autoSpawn: false });
    // 两个人都朝南站在门洞北边一点（给了朝向，和种子无关）：同时吓跑，在门洞里一个往南一个往回走，正好迎面
    const a = w.spawn({ pos: { x: 8.05, z: 11.3 }, personality: 'timid', lookDir: Math.PI / 2 });
    const b = w.spawn({ pos: { x: 7.95, z: 11.9 }, personality: 'timid', lookDir: Math.PI / 2 });
    scareAway(a);
    scareAway(b);
    // 前提：不到天亮，他们就卡在门洞里，一个钟头也出不去（以后要是把这个卡死修了，这一条前提会先失败：把这条测试改成别的卡法或者删掉）
    runFor(w, 40);
    expect(w.state.npcs.map((n) => n.mode)).toEqual(['fleeing', 'fleeing']);
    expect(Math.hypot(a.pos.x - FRONT_DOOR.inside.x, a.pos.z - FRONT_DOOR.inside.z)).toBeLessThan(2);
    w.dawn();
    const t0 = w.state.time;
    const ev = events(runUntilEmpty(w, 20));
    expect(w.state.npcs.length).toBe(0);
    expect(w.state.time - t0).toBeGreaterThan(7.5); // 8 秒里没动才放
    expect(w.state.time - t0).toBeLessThan(10);
    expect(ofType(ev, 'exit').map((e) => [e.total, e.calm])).toEqual([[1, undefined], [2, undefined]]);
    expect(w.state.scaredOff).toBe(2);
  });

  test('各个种子、各种折腾（附身、引诱、现身、鬼魂贴着）里天亮：之后没人回到闲逛 / 警觉 / 进门，没人进来，都出了门，吓跑的计数只算被吓跑的', () => {
    // 几个种子加起来要真的碰到这几种情形，不然上面的检查是空转
    let calmExits = 0, scaredExits = 0, startledWhileLeaving = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const w = createWorld({ seed });
      const bot = createRng(seed * 977 + 5);
      const ids = w.state.objects.map((o) => o.id);
      const bad: string[] = [];
      let dawned = false;
      const each = () => {
        const k = Math.round(w.state.time * 60);
        if (k % 90 === 0) {
          const r = bot.next();
          if (r < 0.6) w.trigger(bot.pick(ids));
          else if (r < 0.75) w.manifest();
        }
        // 鬼魂贴着一个人：发毛、后颈一凉（天亮以后也照样吓，leaving 的人会被吓得僵住）
        const near = w.state.npcs[Math.floor(w.state.time / 7) % Math.max(1, w.state.npcs.length)];
        w.setGhost(near ? { x: near.pos.x - 0.4, z: near.pos.z, inWall: false } : null);
        if (!dawned) return;
        for (const n of w.state.npcs) {
          if (!['leaving', 'startled', 'fleeing'].includes(n.mode) && bad.length < 8) bad.push(`seed ${seed} t=${w.state.time.toFixed(2)} #${n.id} ${n.mode}`);
          if (n.mode === 'startled') startledWhileLeaving++;
        }
      };
      runTo(w, 150, each);
      dawned = true;
      const before = w.state.scaredOff;
      w.dawn();
      const evs: SimEvent[] = [];
      const end = w.state.time + 240;
      while (w.state.npcs.length > 0 && w.state.time < end) evs.push(...events(runFor(w, DT, each)));
      expect(bad).toEqual([]);
      expect(ofType(evs, 'spawn')).toEqual([]);
      expect(w.state.npcs.length).toBe(0);
      // 计数只算被吓跑的：每个不带 calm 的 exit 让 total 加一，带 calm 的不动
      let total = before;
      for (const e of ofType(evs, 'exit')) {
        if (e.calm) calmExits++;
        else {
          total++;
          scaredExits++;
        }
        expect(e.total).toBe(total);
      }
      expect(w.state.scaredOff).toBe(total);
    }
    expect(calmExits).toBeGreaterThan(10);
    expect(scaredExits).toBeGreaterThan(0);
    expect(startledWhileLeaving).toBeGreaterThan(0);
  });
});

// ——————————————————————————————————————————————————————————————————
// 一夜里不重名
// ——————————————————————————————————————————————————————————————————

describe('一夜里不重名', () => {
  test('名字池：不重复，够大（比最近要避开的 + 屋里最多的人数还多），原来的 16 个在最前面没动', () => {
    expect(new Set(NAMES).size).toBe(NAMES.length);
    expect(RECENT_NAMES).toBe(WINDOW);
    expect(NAMES.length).toBeGreaterThanOrEqual(WINDOW + SPAWN.target + 1);
    expect(NAMES.length).toBeGreaterThanOrEqual(48);
    expect(NAMES.slice(0, 4)).toEqual(['Mia', 'Theo', 'Priya', 'Ollie']);
    expect(NAMES.slice(0, 16).join(' ')).toBe('Mia Theo Priya Ollie June Sam Nora Leo Ada Felix Iris Hugo Maya Ezra Lena Otis');
    // 都是一个单词的名字（登记簿、播报里一行排得下）
    for (const n of NAMES) expect(n).toMatch(/^[A-Z][a-z]{1,5}$/);
  });

  test('pickName：避开屋里的人和最近进来的；避不开再退一步；只抽一次随机数', () => {
    const rng = createRng(5);
    // 剩下唯一一个没被避开的
    const taken = NAMES.slice(0, 3), recent = NAMES.slice(3, NAMES.length - 1);
    for (let k = 0; k < 100; k++) expect(pickName(rng, taken, recent)).toBe(NAMES[NAMES.length - 1]);
    // 只避开屋里的人时和原来一样：不和屋里的人重名
    for (let k = 0; k < 100; k++) expect(NAMES.slice(0, 40)).not.toContain(pickName(rng, NAMES.slice(0, 40)));
    // 避开的太多、一个不剩：先保住「不和屋里的人重名」，只在屋里的人以外抽
    const crowded = NAMES.slice(0, 5), allRecent = NAMES;
    for (let k = 0; k < 100; k++) expect(crowded).not.toContain(pickName(rng, crowded, allRecent));
    // 屋里的人就占满名字池：只好重名
    expect(NAMES).toContain(pickName(rng, NAMES, NAMES));

    // 不管避开了几个，都只抽一次：抽完以后两个种子相同的随机数发生器还是同步的
    for (const [t, r] of [[[], []], [NAMES.slice(0, 3), NAMES.slice(3, 30)], [NAMES.slice(0, 3), NAMES.slice(3, NAMES.length - 1)], [NAMES.slice(0, 5), NAMES], [NAMES, NAMES]] as [string[], string[]][]) {
      const a = createRng(9), b = createRng(9);
      pickName(a, t, r);
      b.next();
      expect(a.next()).toBe(b.next());
    }
  });

  test('整局里：连着进来的 25 个人（WINDOW + 1）没有两个同名；开局的前 24 个全不同（走了的也算）', () => {
    for (const seed of [1, 2, 3, 4]) {
      const w = createWorld({ seed });
      const names: string[] = [];
      const ev = runTo(w, 900, () => {
        // 进来待 1 秒就吓走，让进出不停：一局里进来几十个人
        for (const n of w.state.npcs) if (n.mode !== 'fleeing' && n.modeTime > 1) scareAway(n);
      });
      // 按进门的顺序取名字：spawn 事件里的 npc id 对应的名字，在 state 里已经查不到的（走了的），用 exit 事件补上
      const nameOf = new Map<number, string>();
      for (const e of events(ev)) if (e.type === 'exit') nameOf.set(e.npc, e.name);
      for (const n of w.state.npcs) nameOf.set(n.id, n.name);
      for (const e of ofType(events(ev), 'spawn')) names.push(nameOf.get(e.npc)!);
      expect(names.length).toBeGreaterThan(WINDOW * 2); // 够多，窗口滑过了很多次
      expect(new Set(names.slice(0, WINDOW)).size).toBe(WINDOW);
      for (let k = 0; k + WINDOW + 1 <= names.length; k++) {
        expect(new Set(names.slice(k, k + WINDOW + 1)).size).toBe(WINDOW + 1);
      }
    }
  });

  test('走了的人最近 24 个也不会立刻重名；超过 24 个以后才可能又轮到他', () => {
    // 屋里每次只有一个人（放进来就让他走），「屋里的人」那一层避不开 Mia，只有「最近进来的」这一层管得住。
    // 名字池 48 个、只避开屋里的人时，24 次里不抽到 Mia 的几率约六成，二十颗种子都躲过去的几率是零
    let again = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const w = createWorld({ seed, autoSpawn: false });
      const leave = (n: NpcState) => {
        n.mode = 'gone'; // 走了（这一步末尾从屋里移除）
        w.step(DT);
      };
      leave(w.spawn({ name: 'Mia' })); // 手动给了名字的也记在「最近进来的」里
      expect(w.state.npcs.length).toBe(0);
      for (let k = 0; k < WINDOW; k++) {
        const n = w.spawn();
        expect(n.name).not.toBe('Mia');
        leave(n);
      }
      // 她已经滑出最近的 24 个：又可以被抽到（名字池里去掉最近 24 个还剩 24 个，抽很多次总能轮到）
      for (let k = 0; k < 400; k++) {
        const n = w.spawn();
        const hit = n.name === 'Mia';
        leave(n);
        if (hit) {
          again++;
          break;
        }
      }
    }
    expect(again).toBe(20);
  });
});

// 上面各个场景用的出生点都要真的能走：布局改了（家具挪了）、点落到墙里，人会原地走不动，测试会莫名其妙地超时
describe('测试用的位置', () => {
  test('各个出生点都是能走的格子', () => {
    const grid = new Grid();
    for (const p of [STUDY, BEDROOM_FAR, NEAR_DOOR, { x: 8, z: 6 }, { x: 3, z: 9 }, { x: 12, z: 3 }]) {
      expect(grid.walkableAt(p)).toBe(true);
    }
  });
});
