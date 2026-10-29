// 「一夜」的模拟（2026-10-30，路 NS）：开局间隔（WorldOptions.openingGaps）、收夜（World.close / reopen）、最后一位（spawn 事件的 last）、
// 一夜里不重名（pickName 避开最近进来的 RECENT_NAMES 个）。
// 这些开关默认关着：不给 openingGaps、不调 close 时，模拟和原来逐步相同——Spawner 对着原来算法的一份拷贝逐步对比，
// 整个世界对着等价的另一种写法逐步对比；平衡数字由 tests/balance.test.ts 管（它不给这些开关，数字一个都不能变）
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { pickName, pickPersonality, RECENT_NAMES, Spawner } from '../src/sim/spawner';
import { FRONT_DOOR } from '../src/config/house';
import { NIGHT } from '../src/config/night';
import { FEAR, NAMES, SPAWN } from '../src/config/visitors';
import type { NpcState, SimEvent, World, WorldOptions } from '../src/sim/types';

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

describe('不给 openingGaps、不调 close 时和原来一模一样', () => {
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
