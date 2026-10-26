// 平衡测试用的「玩家」机器人（无界面，固定种子）。tests/balance.test.ts 用它们断言数值目标。
// - skilled：像一个会玩的人。
//   1. 眼睛图标亮了（seenBy 非空）就附身那个惊吓物件（每 0.25 秒看一次，大概是人的反应速度）
//   2. 先引诱、再惊吓：预测听见引诱声的人会怎么走（和模拟用同一个 alertPath；警觉时手电一直指着声源，到了再左右扫），
//      途中或查看时会看见一个可用的惊吓物件，就拉响引诱。lureCoverage 统计这在多少位置成立
//      （旧布局：厨房门 1/231、八音盒 10/86，几乎用不上；现布局见 tests/balance.test.ts 目标 5）
//   3. 续恐惧：听得见的人已经在害怕、此刻没在警觉 / 受惊，也拉响引诱（恐惧值上涨、回落计时重来）
// - random：每 3 秒随机点一个能附身的物件，不看时机
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { Grid } from '../src/sim/grid';
import { alertPath } from '../src/sim/npc';
import { canHear, canSee } from '../src/sim/perception';
import { facesToward } from '../src/sim/scares';
import { cellCenter, GRID_H, GRID_W } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { BEHAVIOR, VISION } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import type { Personality, ScareObjectState, Vec2, World } from '../src/sim/types';

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
  /** 「先引诱、再惊吓」成功的次数：一个人听见引诱声后 LURE_LED_WINDOW 秒内被惊吓物件吓到 */
  lureLedScares: number;
  /** 每个惊吓物件：机器人附身了几次、其中几次真的吓到了至少一个人 */
  landing: Record<string, { fired: number; landed: number }>;
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
/** 听见引诱声后多少秒内被吓到，算作引诱带来的惊吓 */
const LURE_LED_WINDOW = 8;
/** 预测路径时每隔多少米检查一次能不能看见惊吓物件 */
const PREDICT_STEP = 0.5;
/** 预测到达后的查看：在左右扫的范围里取几个方向 */
const SWEEP_SAMPLES = 9;

/** 机器人预测用的地图；每局开始时重建（测试里可能临时改了摆放） */
let grid = new Grid();

/** 一局：opts.seconds 秒的模拟时间（默认 300），按 1/60 步进 */
export function runBot(seed: number, kind: BotKind, opts: RunOptions = {}): BotRun {
  const seconds = opts.seconds ?? 300;
  const lures = opts.lures ?? 'both';
  grid = new Grid();
  const w = createWorld({ seed, autoSpawn: opts.autoSpawn ?? true });
  opts.setup?.(w);
  const rng = createRng(seed * 7919 + 17);
  const visitors = new Map<number, VisitorLog>();
  let maxSingleScare = 0, lureLedScares = 0;
  const landing: Record<string, { fired: number; landed: number }> = {};
  /** 附身了、还没吓到人的惊吓物件（同一个物件冷却比生效窗口长，不会重叠） */
  const pendingLand = new Set<string>();
  const fire: Fire = (id) => {
    const ok = w.trigger(id);
    const o = w.state.objects.find((x) => x.id === id);
    if (ok && o && isSight(o)) {
      (landing[id] ??= { fired: 0, landed: 0 }).fired++;
      pendingLand.add(id);
    }
    return ok;
  };
  const lastHeard = new Map<number, number>();
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    if (kind === 'skilled') {
      if (k % SIGHT_EVERY === 0) fireLitEyes(w, fire);
      if (k % LURE_EVERY === 0 && lures !== 'none') fireLures(w, lures, fire);
    } else if (k % RANDOM_EVERY === 0) randomMove(w, rng, fire);
    for (const e of w.step(DT)) {
      if (e.type === 'spawn') {
        const n = w.state.npcs.find((m) => m.id === e.npc)!;
        visitors.set(e.npc, { id: e.npc, personality: n.personality, spawnedAt: w.state.time, exitedAt: null });
      } else if (e.type === 'exit') {
        visitors.get(e.npc)!.exitedAt = w.state.time;
      } else if (e.type === 'heard') {
        lastHeard.set(e.npc, w.state.time);
      } else if (e.type === 'startle' && e.object !== null) {
        if (pendingLand.delete(e.object)) landing[e.object].landed++;
        maxSingleScare = Math.max(maxSingleScare, e.amount);
        const h = lastHeard.get(e.npc);
        if (h !== undefined && w.state.time - h <= LURE_LED_WINDOW) lureLedScares++;
      }
    }
  }
  const list = [...visitors.values()];
  const lifetimes = list.filter((v) => v.exitedAt !== null).map((v) => v.exitedAt! - v.spawnedAt);
  return { seed, kind, seconds, visitors: list, exits: lifetimes.length, lifetimes, maxSingleScare, lureLedScares, landing };
}

const ready = (o: ScareObjectState) => o.cooldown === 0;
const isSight = (o: ScareObjectState) => SCARES[o.type].kind === 'sight';

/** 机器人附身用的函数（runBot 里包了一层，用来统计惊吓有没有落到人身上） */
type Fire = (id: string) => boolean;

function fireLitEyes(w: World, fire: Fire) {
  for (const o of w.state.objects) if (isSight(o) && ready(o) && o.seenBy.length > 0) fire(o.id);
}

function fireLures(w: World, policy: LurePolicy, fire: Fire) {
  const sights = w.state.objects.filter((o) => isSight(o) && ready(o));
  for (const lure of w.state.objects) {
    if (isSight(lure) || !ready(lure)) continue;
    const range = SCARES[lure.type].range;
    // 只考虑会被这一声拉走的人：听得见、没在逃跑 / 警觉 / 受惊
    const hearers = w.state.npcs.filter(
      (n) => n.mode !== 'fleeing' && n.mode !== 'alert' && n.mode !== 'startled' && canHear(grid, n.pos, lure.pos, range),
    );
    const predicted = policy !== 'topup' && hearers.some((n) => lureLeadsToScare(n.pos, lure.pos, sights));
    const topUp = policy !== 'predict' && hearers.some((n) => n.fear > 0);
    if (predicted || topUp) fire(lure.id);
  }
}

/**
 * 预测：站在 from 的人听见 source 后会怎么走（和模拟用同一个 alertPath），走的时候手电指着声源，
 * 到了查看位置再左右扫（BEHAVIOR.investigateSweep）。途中或查看时能看见 sights 里的某一个（含正面朝向）就返回 true
 */
export function lureLeadsToScare(from: Vec2, source: Vec2, sights: readonly ScareObjectState[], g: Grid = grid): boolean {
  if (sights.length === 0) return false;
  const path = alertPath(g, from, source);
  if (!path) return false;
  const sees = (p: Vec2, lookDir: number) =>
    sights.some((o) => facesToward(o, p) && canSee(g, { pos: p, lookDir }, o.pos, Math.min(SCARES[o.type].range, VISION.range)));
  const bearing = (p: Vec2) => angleOf(source.x - p.x, source.z - p.z);
  let a = from;
  if (path.length === 0 && sees(a, bearing(a))) return true;
  for (const b of path) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / PREDICT_STEP));
    for (let s = 1; s <= steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
      if (sees(p, bearing(p))) return true;
    }
    a = b;
  }
  const amp = BEHAVIOR.investigateSweep;
  for (let k = 0; k < SWEEP_SAMPLES; k++) if (sees(a, bearing(a) - amp + (2 * amp * k) / (SWEEP_SAMPLES - 1))) return true;
  return false;
}

/** 每个引诱物件：能听见它的可走格有多少，其中多少格的人被它引过去时会看见一个惊吓物件 */
export function lureCoverage(objects: readonly ScareObjectState[], g: Grid = grid): { id: string; hearing: number; leads: number }[] {
  const sights = objects.filter(isSight);
  return objects.filter((o) => !isSight(o)).map((lure) => {
    let hearing = 0, leads = 0;
    for (let j = 0; j < GRID_H; j++) {
      for (let i = 0; i < GRID_W; i++) {
        if (!g.isWalkable(i, j)) continue;
        const p = cellCenter(i, j);
        if (!canHear(g, p, lure.pos, SCARES[lure.type].range)) continue;
        hearing++;
        if (lureLeadsToScare(p, lure.pos, sights, g)) leads++;
      }
    }
    return { id: lure.id, hearing, leads };
  });
}

function randomMove(w: World, rng: Rng, fire: Fire) {
  const choices = w.state.objects.filter(ready);
  if (choices.length > 0) fire(rng.pick(choices).id);
}

export const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
