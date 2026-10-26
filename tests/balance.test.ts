// 数值平衡的回归测试：两个机器人（见 tests/bots.ts）在固定种子下玩，断言体验目标。
// 改 config 里的恐惧值、回落、习惯化、性格倍率之后跑这个文件；想看每局的明细：BALANCE_REPORT=1 ./node_modules/.bin/vitest run tests/balance.test.ts
import { beforeAll, describe, expect, test } from 'vitest';
import { lureCoverage, median, runBot } from './bots';
import type { BotRun, LurePolicy, VisitorLog } from './bots';
import { createWorld } from '../src/sim/world';
import { FEAR, PERSONALITIES, SPAWN } from '../src/config/visitors';
import { SCARES } from '../src/config/scares';
import { PROPS } from '../src/config/house';

/** 正常对局：5 个种子 × 5 分钟，自动生成访客 */
const SEEDS = [1, 2, 3, 4, 5];
const GAME_SECONDS = 300;
/** 专门对付一个 brave：屋里只有他一个人（没有尖叫传染帮忙，最难的情形），10 个种子 */
const LONE_SEEDS = Array.from({ length: 10 }, (_, i) => 100 + i);
const LONE_SECONDS = 240;
/** 「大约 3 分钟的专心对付」 */
const FOCUS_LIMIT = 180;

let skilled: BotRun[], random: BotRun[], lone: BotRun[];
/** 同一个 skilled 机器人，只换引诱的用法：只按预测「引过去会看见惊吓」才拉（predict）/ 完全不用引诱（none） */
let planned: BotRun[], noLures: BotRun[], lonePlanned: BotRun[], loneNoLures: BotRun[];
const avgExits = (runs: BotRun[]) => runs.reduce((a, r) => a + r.exits, 0) / runs.length;
const totalExits = (runs: BotRun[]) => runs.reduce((a, r) => a + r.exits, 0);
const exitedWithin = (v: VisitorLog, s: number) => v.exitedAt !== null && v.exitedAt - v.spawnedAt <= s;
const fastLone = (runs: BotRun[]) => runs.filter((r) => r.lifetimes.length === 1 && r.lifetimes[0] <= FOCUS_LIMIT).length;
/** 惊吓类物件的 id */
const SIGHT_PROPS = PROPS.filter((p) => SCARES[p.type].kind === 'sight').map((p) => p.id);
/** 把几局的「附身次数 / 吓到人的次数」按物件加起来 */
function landingOf(runs: BotRun[]): Record<string, { fired: number; landed: number }> {
  const t: Record<string, { fired: number; landed: number }> = {};
  for (const id of SIGHT_PROPS) t[id] = { fired: 0, landed: 0 };
  for (const r of runs) {
    for (const [id, v] of Object.entries(r.landing)) {
      t[id].fired += v.fired;
      t[id].landed += v.landed;
    }
  }
  return t;
}
const landingLine = (runs: BotRun[]) =>
  Object.entries(landingOf(runs))
    .map(([id, v]) => `${id} ${v.landed}/${v.fired}${v.fired ? ` (${Math.round((100 * v.landed) / v.fired)}%)` : ''}`)
    .join(', ');

beforeAll(() => {
  skilled = SEEDS.map((s) => runBot(s, 'skilled', { seconds: GAME_SECONDS }));
  random = SEEDS.map((s) => runBot(s, 'random', { seconds: GAME_SECONDS }));
  const loneRun = (lures: LurePolicy) =>
    LONE_SEEDS.map((s) =>
      runBot(s, 'skilled', { lures, seconds: LONE_SECONDS, autoSpawn: false, setup: (w) => void w.spawn({ personality: 'brave' }) }),
    );
  lone = loneRun('both');
  planned = SEEDS.map((s) => runBot(s, 'skilled', { seconds: GAME_SECONDS, lures: 'predict' }));
  noLures = SEEDS.map((s) => runBot(s, 'skilled', { seconds: GAME_SECONDS, lures: 'none' }));
  lonePlanned = loneRun('predict');
  loneNoLures = loneRun('none');
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
    `lures: planned-only avg ${avgExits(planned).toFixed(1)} (lure-led scares ${planned.reduce((a, r) => a + r.lureLedScares, 0)}), ` +
      `no lures avg ${avgExits(noLures).toFixed(1)}; lone brave <= ${FOCUS_LIMIT} s: planned ${fastLone(lonePlanned)}/10, none ${fastLone(loneNoLures)}/10`,
    `coverage: ${lureCoverage(createWorld({ seed: 1, autoSpawn: false }).state.objects).map((c) => `${c.id} ${c.leads}/${c.hearing}`).join(', ')}`,
    `landing (skilled, seeds ${SEEDS.join(',')}): ${landingLine(skilled)}`,
    `landing (all skilled games: full / planned-only / no lures): ${landingLine([...skilled, ...planned, ...noLures])}`,
    `landing (random, blind clicks): ${landingLine(random)}`,
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
    expect(fastLone(lone)).toBeGreaterThan(LONE_SEEDS.length / 2);
    // 正常对局：只看进门后还剩 ≥ 3 分钟的 brave
    const braves = skilled.flatMap((r) => r.visitors.filter((v) => v.personality === 'brave' && v.spawnedAt <= GAME_SECONDS - FOCUS_LIMIT));
    expect(braves.length).toBeGreaterThanOrEqual(3);
    expect(braves.filter((v) => exitedWithin(v, FOCUS_LIMIT)).length).toBeGreaterThan(braves.length / 2);
  });

  test('目标 3：random 明显更差（不到 skilled 的一半），但也不是一个都吓不跑', () => {
    expect(avgExits(random)).toBeLessThanOrEqual(avgExits(skilled) / 2);
    expect(totalExits(random)).toBeGreaterThan(0);
  });

  test('目标 5：先引诱、再惊吓真的有用——每个引诱物件把人引过去时，大多数位置都会经过一个惊吓物件', () => {
    for (const c of lureCoverage(createWorld({ seed: 1, autoSpawn: false }).state.objects)) {
      expect(c.hearing).toBeGreaterThan(0);
      expect(c.leads / c.hearing).toBeGreaterThanOrEqual(0.5);
    }
  });

  test('目标 5：同一个 skilled 机器人，会用引诱（只按预测拉）比完全不用引诱明显更强', () => {
    // 吓跑的人数多 25% 以上（另外几组种子实测多 27%–77%，这里取都能过的下限）
    expect(avgExits(planned)).toBeGreaterThanOrEqual(1.25 * avgExits(noLures));
    // 单独一个 brave：3 分钟内吓跑的局数多 4 局以上（共 10 局）
    expect(fastLone(lonePlanned)).toBeGreaterThanOrEqual(fastLone(loneNoLures) + 4);
    // 引诱之后 8 秒内吓到人，平均每局至少 10 次
    expect(planned.reduce((a, r) => a + r.lureLedScares, 0) / planned.length).toBeGreaterThanOrEqual(10);
    // 完整的 skilled（预测 + 续恐惧）也明显强过不用引诱
    expect(avgExits(skilled)).toBeGreaterThanOrEqual(1.25 * avgExits(noLures));
  });

  test('目标 6：skilled 眼睛亮了才附身，每个惊吓物件至少 85% 的附身真的吓到人（蓄势时看见的人会被定住盯着它）', () => {
    // 落不落得下只看「眼睛亮了就附身」这条规则和模拟，跟引诱怎么用无关：把三种 skilled 的局合起来，样本多一些
    const t = landingOf([...skilled, ...planned, ...noLures]);
    for (const id of SIGHT_PROPS) {
      expect(t[id].fired).toBeGreaterThanOrEqual(5);
      expect(t[id].landed / t[id].fired).toBeGreaterThanOrEqual(0.85);
    }
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
