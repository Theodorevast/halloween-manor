// 平衡测试用的「玩家」机器人（无界面，固定种子）。tests/balance.test.ts 用它们断言数值目标。
// - skilled：像一个会玩的人。
//   1. 眼睛图标亮了（seenBy 非空）就附身那个惊吓物件（每 0.25 秒看一次，大概是人的反应速度）
//   2. 先引诱、再惊吓：预测听见引诱声的人会怎么走（警觉时手电一直指着声源），路上会看见一个可用的惊吓物件，就拉响引诱。
//      实测这栋房子里几乎用不上：听得见厨房门的 231 格里只有 1 格、听得见八音盒的 86 格里只有 10 格（门厅西侧，
//      路过门厅台灯）走过去会看见惊吓物件
//   3. 续恐惧：听得见的人已经在害怕、此刻没在警觉 / 受惊，也拉响引诱（恐惧值上涨、回落计时重来）。
//      这条才是引诱真正起作用的地方：去掉它，单独一个 brave 3 分钟内吓跑的比例从八九成掉到两到七成
// - random：每 3 秒随机点一个能附身的物件，不看时机
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { Grid } from '../src/sim/grid';
import { findPath } from '../src/sim/pathfind';
import { canHear, canSee } from '../src/sim/perception';
import { cellCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { VISION } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import type { NpcState, Personality, ScareObjectState, Vec2, World } from '../src/sim/types';

export type BotKind = 'skilled' | 'random';
/** skilled 用引诱的方式（只用于对比分析；正式测试用默认的 'both'） */
export type LurePolicy = 'both' | 'predict' | 'topup' | 'none';

export interface VisitorLog {
  id: number;
  personality: Personality;
  spawnedAt: number;
  /** 被吓跑走出前门的时间；没走就是 null */
  exitedAt: number | null;
}

export interface BotRun {
  seed: number;
  kind: BotKind;
  seconds: number;
  visitors: VisitorLog[];
  exits: number;
  /** 被吓跑的人从进门到离开的秒数 */
  lifetimes: number[];
  /** 单次附身里一个人恐惧值涨得最多的一次（不含尖叫传染） */
  maxSingleScare: number;
}

export interface RunOptions {
  seconds?: number;
  autoSpawn?: boolean;
  /** 开局前对 world 做的事（比如只放一个 brave 访客） */
  setup?: (w: World) => void;
  lures?: LurePolicy;
}

const DT = 1 / 60;
/** skilled 每隔多少步看一次眼睛图标：0.25 秒 */
const SIGHT_EVERY = 15;
/** skilled 每隔多少步考虑一次引诱：1 秒（要预测路径，算得慢一些） */
const LURE_EVERY = 60;
/** 随机机器人每 3 秒点一次 */
const RANDOM_EVERY = 180;
/** 预测路径时每隔多少米检查一次能不能看见惊吓物件 */
const PREDICT_STEP = 0.5;

const grid = new Grid();

/** 一局：opts.seconds 秒的模拟时间（默认 300），按 1/60 步进 */
export function runBot(seed: number, kind: BotKind, opts: RunOptions = {}): BotRun {
  const seconds = opts.seconds ?? 300;
  const lures = opts.lures ?? 'both';
  const w = createWorld({ seed, autoSpawn: opts.autoSpawn ?? true });
  opts.setup?.(w);
  const rng = createRng(seed * 7919 + 17);
  const visitors = new Map<number, VisitorLog>();
  let maxSingleScare = 0;
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    if (kind === 'skilled') {
      if (k % SIGHT_EVERY === 0) fireLitEyes(w);
      if (k % LURE_EVERY === 0 && lures !== 'none') fireLures(w, lures);
    } else if (k % RANDOM_EVERY === 0) randomMove(w, rng);
    for (const e of w.step(DT)) {
      if (e.type === 'spawn') {
        const n = w.state.npcs.find((m) => m.id === e.npc)!;
        visitors.set(e.npc, { id: e.npc, personality: n.personality, spawnedAt: w.state.time, exitedAt: null });
      } else if (e.type === 'exit') {
        visitors.get(e.npc)!.exitedAt = w.state.time;
      } else if (e.type === 'startle' && e.object !== null) {
        maxSingleScare = Math.max(maxSingleScare, e.amount);
      }
    }
  }
  const list = [...visitors.values()];
  const lifetimes = list.filter((v) => v.exitedAt !== null).map((v) => v.exitedAt! - v.spawnedAt);
  return { seed, kind, seconds, visitors: list, exits: lifetimes.length, lifetimes, maxSingleScare };
}

const ready = (o: ScareObjectState) => o.cooldown === 0;
const isSight = (o: ScareObjectState) => SCARES[o.type].kind === 'sight';

function fireLitEyes(w: World) {
  for (const o of w.state.objects) if (isSight(o) && ready(o) && o.seenBy.length > 0) w.trigger(o.id);
}

function fireLures(w: World, policy: LurePolicy) {
  const sights = w.state.objects.filter((o) => isSight(o) && ready(o));
  for (const lure of w.state.objects) {
    if (isSight(lure) || !ready(lure)) continue;
    const range = SCARES[lure.type].range;
    // 只考虑会被这一声拉走的人：听得见、没在逃跑 / 警觉 / 受惊
    const hearers = w.state.npcs.filter(
      (n) => n.mode !== 'fleeing' && n.mode !== 'alert' && n.mode !== 'startled' && canHear(grid, n.pos, lure.pos, range),
    );
    const predicted = policy !== 'topup' && hearers.some((n) => walksPastScare(n, lure.pos, sights));
    const topUp = policy !== 'predict' && hearers.some((n) => n.fear > 0);
    if (predicted || topUp) w.trigger(lure.id);
  }
}

/** 预测：n 听见 source 后走过去（手电指着声源），路上会不会看见 sights 里的某一个 */
function walksPastScare(n: NpcState, source: Vec2, sights: ScareObjectState[]): boolean {
  if (sights.length === 0) return false;
  const [i, j] = grid.nearestWalkable(source, n.pos);
  const path = findPath(grid, n.pos, cellCenter(i, j));
  if (!path) return false;
  let a = n.pos;
  for (const b of path) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / PREDICT_STEP));
    for (let s = 1; s <= steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
      const look = { pos: p, lookDir: angleOf(source.x - p.x, source.z - p.z) };
      for (const o of sights) if (canSee(grid, look, o.pos, Math.min(SCARES[o.type].range, VISION.range))) return true;
    }
    a = b;
  }
  return false;
}

function randomMove(w: World, rng: Rng) {
  const choices = w.state.objects.filter(ready);
  if (choices.length > 0) w.trigger(rng.pick(choices).id);
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
