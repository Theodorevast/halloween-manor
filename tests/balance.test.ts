// 数值平衡的回归测试：两个机器人（见 tests/bots.ts）在固定种子下玩，断言体验目标。
// 改 config 里的恐惧值、回落、习惯化、性格倍率之后跑这个文件；想看每局的明细：BALANCE_REPORT=1 ./node_modules/.bin/vitest run tests/balance.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { median, runBot } from './bots';
import type { BotRun, VisitorLog } from './bots';
import { FEAR, PERSONALITIES, SPAWN } from '../src/config/visitors';
import { SCARES } from '../src/config/scares';

/** 正常对局：5 个种子 × 5 分钟，自动生成访客 */
const SEEDS = [1, 2, 3, 4, 5];
const GAME_SECONDS = 300;
/** 专门对付一个 brave：屋里只有他一个人（没有尖叫传染帮忙，最难的情形），10 个种子 */
const LONE_SEEDS = Array.from({ length: 10 }, (_, i) => 100 + i);
const LONE_SECONDS = 240;
/** 「大约 3 分钟的专心对付」 */
const FOCUS_LIMIT = 180;

let skilled: BotRun[], random: BotRun[], lone: BotRun[];
const avgExits = (runs: BotRun[]) => runs.reduce((a, r) => a + r.exits, 0) / runs.length;
const totalExits = (runs: BotRun[]) => runs.reduce((a, r) => a + r.exits, 0);
const exitedWithin = (v: VisitorLog, s: number) => v.exitedAt !== null && v.exitedAt - v.spawnedAt <= s;

beforeAll(() => {
  skilled = SEEDS.map((s) => runBot(s, 'skilled', { seconds: GAME_SECONDS }));
  random = SEEDS.map((s) => runBot(s, 'random', { seconds: GAME_SECONDS }));
  lone = LONE_SEEDS.map((s) =>
    runBot(s, 'skilled', { seconds: LONE_SECONDS, autoSpawn: false, setup: (w) => void w.spawn({ personality: 'brave' }) }),
  );
  // tsconfig 里没有 node 的类型，经 globalThis 取环境变量
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  if (env?.BALANCE_REPORT) console.log(report());
});

function report(): string {
  const row = (r: BotRun) => {
    const brave = r.visitors.filter((v) => v.personality === 'brave');
    return `  seed ${r.seed}: exits ${r.exits}, median life ${median(r.lifetimes).toFixed(0)} s, brave ${brave.filter((v) => v.exitedAt !== null).length}/${brave.length}`;
  };
  const loneTimes = lone.map((r) => (r.lifetimes[0] === undefined ? '—' : r.lifetimes[0].toFixed(0)));
  return [
    'skilled:', ...skilled.map(row),
    `  avg ${avgExits(skilled).toFixed(1)}, median life ${median(skilled.flatMap((r) => r.lifetimes)).toFixed(0)} s`,
    'random:', ...random.map(row),
    `  avg ${avgExits(random).toFixed(1)}`,
    `lone brave (s to exit, ${LONE_SECONDS} s cap): ${loneTimes.join(', ')}`,
  ].join('\n');
}

describe('数值平衡（固定种子，无界面）', () => {
  test('目标 1：skilled 每 5 分钟平均吓跑 ≥ 3 人；被吓跑的人从进门到离开的中位数在 45–120 秒', () => {
    expect(avgExits(skilled)).toBeGreaterThanOrEqual(3);
    const life = median(skilled.flatMap((r) => r.lifetimes));
    expect(life).toBeGreaterThanOrEqual(45);
    expect(life).toBeLessThanOrEqual(120);
  });

  test('目标 2：brave 吓得跑——单独对付一个 brave，大多数 3 分钟内吓跑；正常对局里的 brave 也大多数 3 分钟内离开', () => {
    const fast = lone.filter((r) => r.lifetimes.length === 1 && r.lifetimes[0] <= FOCUS_LIMIT).length;
    expect(fast).toBeGreaterThan(LONE_SEEDS.length / 2);
    // 正常对局：只看进门后还剩 ≥ 3 分钟的 brave
    const braves = skilled.flatMap((r) => r.visitors.filter((v) => v.personality === 'brave' && v.spawnedAt <= GAME_SECONDS - FOCUS_LIMIT));
    expect(braves.length).toBeGreaterThanOrEqual(3);
    expect(braves.filter((v) => exitedWithin(v, FOCUS_LIMIT)).length).toBeGreaterThan(braves.length / 2);
  });

  test('目标 3：random 明显更差（不到 skilled 的一半），但也不是一个都吓不跑', () => {
    expect(avgExits(random)).toBeLessThanOrEqual(avgExits(skilled) / 2);
    expect(totalExits(random)).toBeGreaterThan(0);
  });

  test('目标 4：单次附身不可能把恐惧值为 0 的人直接吓跑', () => {
    const maxMult = Math.max(...Object.values(PERSONALITIES).map((p) => p.fearMult));
    const maxFear = Math.max(...Object.values(SCARES).map((s) => s.fear));
    // 最大的一次惊吓落在最胆小的人身上
    expect(maxFear * maxMult).toBeLessThan(FEAR.max);
    // 再加上同一次附身吓到的其他人（最多 SPAWN.target − 1 个）各传染他一次
    expect(maxFear * maxMult + (SPAWN.target - 1) * FEAR.contagion * maxMult).toBeLessThan(FEAR.max);
    // 实测：两个机器人玩下来，单次惊吓最大的一次
    for (const r of [...skilled, ...random, ...lone]) expect(r.maxSingleScare).toBeLessThan(FEAR.max);
  });
});
