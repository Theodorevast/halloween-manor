// 平衡测试用的「玩家」机器人（无界面，固定种子）。tests/balance.test.ts 用它们断言数值目标。
// - skilled：像一个会玩的人。
//   1. 眼睛图标亮了（seenBy 非空）就附身那个惊吓物件（每 0.25 秒看一次，大概是人的反应速度）
//   2. 先引诱、再惊吓：预测听见引诱声的人会怎么走（和模拟用同一个 alertPath；警觉时手电一直指着声源，到了再左右扫），
//      途中或查看时会看见一个可用的惊吓物件，就拉响引诱。lureCoverage 统计这在多少位置成立
//      （旧布局：厨房门 1/231、八音盒 10/86，几乎用不上；现布局见 tests/balance.test.ts 目标 5）
//   3. 续恐惧：听得见的人已经在害怕、此刻没在警觉 / 受惊，也拉响引诱（恐惧值上涨、回落计时重来）
//   4. 机关（2026-10-28）：每 TRAP_EVERY 步看一次，设下的不到 TRAP.max 个，就在没人看得见的背后型物件（摇椅、床）里
//      挑离访客最近的那个设下（TRAP_NEAR 米以内有人才设：等人路过时在他背后发作）
// - random：每 3 秒随机点一个能附身的物件，不看时机
// - idle：不附身（只用来看鬼魂单独有多大用）
// 鬼魂（第三人称改版，opts.ghost = 'hover'）：和上面任何一种叠加。每步把鬼魂飘向最近的访客、贴在他身后 GHOST_BOT.behind 米
// （跟定一个人，直到他逃跑或离开），比真人跟得紧：是鬼魂效果的上限。opts.reach 限制只附身离鬼魂多近的物件（第三人称的准星）
// 现身（2026-10-28，opts.ghost = 'manifest'）：鬼魂飘到跟定的人面前（他手电照的方向上）MANIFEST_BOT.front 米处，
// 一冷却好就现身（现身期间不动）；也可以和 skilled 叠加（附身 + 现身）
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { Grid } from '../src/sim/grid';
import { alertPath } from '../src/sim/npc';
import { canHear, canSee } from '../src/sim/perception';
import { facesToward } from '../src/sim/scares';
import { cellCenter, cellOf, FRONT_DOOR, GRID_H, GRID_W } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { BEHAVIOR, TRAITS, TRAP, VISION } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import { GHOST_SOURCE } from '../src/sim/types';
import type { NpcState, Personality, ScareObjectState, ScareType, Vec2, World } from '../src/sim/types';

export type BotKind = 'skilled' | 'random' | 'idle';
/** 鬼魂：none = 没有鬼魂（触屏的俯视模式），hover = 鬼魂机器人贴着最近的访客，manifest = 到他面前现身 */
export type GhostPolicy = 'none' | 'hover' | 'manifest';

/**
 * 鬼魂机器人：飘的速度（米/秒，大概是轻轻按着 WASD）、贴在身后多远（米，在后颈一凉的距离以内）、开局在哪
 * （和 engine/ghostRig.ts 的占位一样在门厅）
 */
export const GHOST_BOT = { speed: 2, behind: 0.5, start: { x: FRONT_DOOR.inside.x, z: FRONT_DOOR.inside.z } };
/**
 * 现身机器人：在跟定的人面前多远处现身（米，按他手电照的方向；先试第一个，中间隔着墙就近一点再试），
 * 飘到离那一点多近就现身（米）。现身的冷却（MANIFEST.cooldown）一好就现身：大约每 20 秒一次
 */
export const MANIFEST_BOT = { front: [2, 1.5, 1], ready: 0.2 };
/** skilled 用引诱的方式（只用于对比分析；正式测试用默认的 'both'） */
export type LurePolicy = 'both' | 'predict' | 'topup' | 'none';

export interface VisitorLog {
  id: number;
  personality: Personality;
  spawnedAt: number;
  /** 被吓跑走出前门的时间；没走就是 null */
  exitedAt: number | null;
  /** 在屋里时恐惧值最高到过多少 */
  peakFear: number;
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
  /** 鬼魂：发毛的 chill 事件数、后颈一凉的次数、两者一共涨了多少恐惧值、后颈一凉最大的一次 */
  chills: number;
  necks: number;
  ghostFear: number;
  maxNeck: number;
  /** 现身：落下了几次、一共吓到几人次 */
  manifests: number;
  manifestScares: number;
}

export interface RunOptions {
  seconds?: number;
  autoSpawn?: boolean;
  /** 开局前对 world 做的事（比如只放一个 brave 访客） */
  setup?: (w: World) => void;
  lures?: LurePolicy;
  /** 鬼魂（默认 none） */
  ghost?: GhostPolicy;
  /** 只附身离鬼魂这么近（米）的物件（第三人称：准星只对准 4 米内的物件）；默认不限 */
  reach?: number;
}

const DT = 1 / 60;
/** skilled 每隔多少步看一次眼睛图标：0.25 秒 */
const SIGHT_EVERY = 15;
/** skilled 每隔多少步考虑一次引诱：1 秒（要预测路径，算得慢一些） */
const LURE_EVERY = 60;
/** 随机机器人每 3 秒点一次 */
const RANDOM_EVERY = 180;
/** skilled 每隔多少步考虑一次设机关：2 秒 */
const TRAP_EVERY = 120;
/** 离最近的访客多远以内（米）的物件才值得设：太远的等 TRAP.expire 秒也等不来人 */
const TRAP_NEAR = 8;
/**
 * 只设背后型（摇椅、床）：迎面型的机关就是「手电照到它就附身」，这个机器人本来每 0.25 秒就盯着眼睛图标附身了，
 * 设了也不多吓到谁，反倒让目标 6 统计的附身次数变少；背后型（在他背后发作、他回头）是它自己点不出来的
 */
const TRAP_TYPES: ReadonlySet<ScareType> = new Set<ScareType>(['rockingChair', 'bed']);
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
  const ghost: GhostBot | null = opts.ghost === 'hover' || opts.ghost === 'manifest' ? { pos: { ...GHOST_BOT.start }, target: null } : null;
  const steer = opts.ghost === 'manifest' ? manifestGhost : moveGhost;
  const reach = opts.reach ?? Infinity;
  const inReach = (o: ScareObjectState) => !ghost || Math.hypot(o.pos.x - ghost.pos.x, o.pos.z - ghost.pos.z) <= reach;
  let chills = 0, necks = 0, ghostFear = 0, maxNeck = 0, manifests = 0, manifestScares = 0;
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    if (ghost) steer(w, ghost);
    if (kind === 'skilled') {
      if (k % SIGHT_EVERY === 0) fireLitEyes(w, fire, inReach);
      if (k % LURE_EVERY === 0 && lures !== 'none') fireLures(w, lures, fire, inReach);
      if (k % TRAP_EVERY === 0) armTraps(w, inReach);
    } else if (kind === 'random' && k % RANDOM_EVERY === 0) randomMove(w, rng, fire);
    for (const e of w.step(DT)) {
      if (e.type === 'spawn') {
        const n = w.state.npcs.find((m) => m.id === e.npc)!;
        visitors.set(e.npc, { id: e.npc, personality: n.personality, spawnedAt: w.state.time, exitedAt: null, peakFear: 0 });
      } else if (e.type === 'exit') {
        visitors.get(e.npc)!.exitedAt = w.state.time;
      } else if (e.type === 'heard') {
        lastHeard.set(e.npc, w.state.time);
      } else if (e.type === 'manifest' && e.phase === 'drop') {
        manifests++;
        manifestScares += e.scared.length;
      } else if (e.type === 'chill') {
        ghostFear += e.amount;
        if (e.neck) {
          necks++;
          maxNeck = Math.max(maxNeck, e.amount);
        } else chills++;
      } else if (e.type === 'startle' && e.object !== null && e.object !== GHOST_SOURCE) {
        if (pendingLand.delete(e.object)) landing[e.object].landed++;
        maxSingleScare = Math.max(maxSingleScare, e.amount);
        const h = lastHeard.get(e.npc);
        if (h !== undefined && w.state.time - h <= LURE_LED_WINDOW) lureLedScares++;
      }
    }
    for (const n of w.state.npcs) {
      const v = visitors.get(n.id);
      if (v && n.mode !== 'fleeing') v.peakFear = Math.max(v.peakFear, n.fear);
    }
  }
  const list = [...visitors.values()];
  const lifetimes = list.filter((v) => v.exitedAt !== null).map((v) => v.exitedAt! - v.spawnedAt);
  return {
    seed, kind, seconds, visitors: list, exits: lifetimes.length, lifetimes, maxSingleScare, lureLedScares, landing,
    chills, necks, ghostFear, maxNeck, manifests, manifestScares,
  };
}

interface GhostBot {
  pos: Vec2;
  /** 正跟着的访客 id */
  target: number | null;
}

/** 跟定的人：还在屋里（没逃跑、没离开）就接着跟，否则换离鬼魂最近的 */
function targetOf(w: World, g: GhostBot): NpcState | undefined {
  const alive = (id: number | null) => w.state.npcs.find((n) => n.id === id && n.mode !== 'fleeing' && n.mode !== 'gone');
  let t = alive(g.target);
  if (!t) {
    let best = Infinity;
    for (const n of w.state.npcs) {
      if (n.mode === 'fleeing' || n.mode === 'gone') continue;
      const d = Math.hypot(n.pos.x - g.pos.x, n.pos.z - g.pos.z);
      if (d < best) {
        best = d;
        t = n;
      }
    }
    g.target = t ? t.id : null;
  }
  return t;
}

/** 鬼魂直线飘向 (hx, hz)（能穿墙），这一步最多 GHOST_BOT.speed × DT；返回飘完离那一点多远 */
function driftTo(g: GhostBot, hx: number, hz: number): number {
  const dx = hx - g.pos.x, dz = hz - g.pos.z, d = Math.hypot(dx, dz), step = GHOST_BOT.speed * DT;
  if (d <= step) {
    g.pos.x = hx;
    g.pos.z = hz;
    return 0;
  }
  g.pos.x += (dx / d) * step;
  g.pos.z += (dz / d) * step;
  return d - step;
}

/**
 * 把鬼魂的位置交给模拟。穿墙时访客听得见（GHOST.hearWall）：和真的鬼魂一样告诉模拟此刻在不在墙里。
 * 按格子近似（中心在墙格、窗格里）：真的鬼魂按身体（半径 0.16 米）碰没碰到 0.2 米厚的墙体算，差不了几厘米
 */
function placeGhost(w: World, g: GhostBot) {
  const [i, j] = cellOf(g.pos.x, g.pos.z);
  w.setGhost({ x: g.pos.x, z: g.pos.z, inWall: grid.isOpaque(i, j) });
}

/**
 * 鬼魂机器人走一步：跟定的人逃跑 / 离开了就换离鬼魂最近的（不算逃跑中的），飘向他身后 GHOST_BOT.behind 米处
 * （按他身体朝向的反方向；鬼魂能穿墙，直线飘），然后交给模拟
 */
function moveGhost(w: World, g: GhostBot) {
  const t = targetOf(w, g);
  if (t) driftTo(g, t.pos.x - Math.cos(t.heading) * GHOST_BOT.behind, t.pos.z - Math.sin(t.heading) * GHOST_BOT.behind);
  placeGhost(w, g);
}

/**
 * 现身机器人走一步：现身期间（蓄力、停留）不动；否则飘向跟定的人面前 MANIFEST_BOT.front 米处
 * （他手电照的方向上、和他之间没有墙），到了而且冷却好了就现身
 */
function manifestGhost(w: World, g: GhostBot) {
  const phase = w.state.manifest.phase;
  const t = phase === 'windup' || phase === 'hold' ? undefined : targetOf(w, g);
  if (t) {
    let spot: Vec2 | null = null;
    for (const f of MANIFEST_BOT.front) {
      const p = { x: t.pos.x + Math.cos(t.lookDir) * f, z: t.pos.z + Math.sin(t.lookDir) * f };
      const [i, j] = cellOf(p.x, p.z);
      if (!grid.isOpaque(i, j) && grid.lineOfSight(t.pos, p)) {
        spot = p;
        break;
      }
    }
    if (spot && driftTo(g, spot.x, spot.z) <= MANIFEST_BOT.ready && phase === 'idle') {
      placeGhost(w, g);
      w.manifest();
      return;
    }
  }
  placeGhost(w, g);
}

const ready = (o: ScareObjectState) => o.cooldown === 0;
const isSight = (o: ScareObjectState) => SCARES[o.type].kind === 'sight';

/** 机器人附身用的函数（runBot 里包了一层，用来统计惊吓有没有落到人身上） */
type Fire = (id: string) => boolean;

/** 能不能附身这个物件（鬼魂够不够得着；没有鬼魂时都能） */
type Reach = (o: ScareObjectState) => boolean;

function fireLitEyes(w: World, fire: Fire, reach: Reach) {
  for (const o of w.state.objects) if (isSight(o) && ready(o) && o.seenBy.length > 0 && reach(o)) fire(o.id);
}

function fireLures(w: World, policy: LurePolicy, fire: Fire, reach: Reach) {
  const sights = w.state.objects.filter((o) => isSight(o) && ready(o));
  for (const lure of w.state.objects) {
    if (isSight(lure) || !ready(lure) || !reach(lure)) continue;
    const range = SCARES[lure.type].range;
    // 只考虑会被这一声拉走的人：听得见、没在逃跑 / 警觉 / 受惊，也没在察觉一个声音（那一拍完了就转入警觉）
    const hearers = w.state.npcs.filter(
      (n) =>
        n.mode !== 'fleeing' && n.mode !== 'alert' && n.mode !== 'startled' && n.notice?.kind !== 'sound' && canHear(grid, n.pos, lure.pos, range),
    );
    const predicted = policy !== 'topup' && hearers.some((n) => lureLeadsToScare(n.pos, lure.pos, sights, grid, TRAITS[n.personality].investigateDist));
    const topUp = policy !== 'predict' && hearers.some((n) => n.fear > 0);
    if (predicted || topUp) fire(lure.id);
  }
}

/**
 * 预测：站在 from 的人听见 source 后会怎么走（和模拟用同一个 alertPath；dist 是他走到离声源多近，按性格），
 * 走的时候手电指着声源，到了查看位置再左右扫（BEHAVIOR.investigateSweep）。途中或查看时能看见 sights 里的某一个（含正面朝向）就返回 true
 */
export function lureLeadsToScare(
  from: Vec2,
  source: Vec2,
  sights: readonly ScareObjectState[],
  g: Grid = grid,
  dist: number = TRAITS.average.investigateDist,
): boolean {
  if (sights.length === 0) return false;
  const path = alertPath(g, from, source, dist);
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

/** 每个引诱物件：能听见它的可走格有多少，其中多少格的人被它引过去时会看见一个惊吓物件（按最常见的 average 走到多近算） */
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

/**
 * 设机关：设下的不到 TRAP.max 个时，在冷却好了、还没设下、此刻没人看得见（眼睛没亮）、够得着的惊吓物件里，
 * 挑离最近的访客（不算逃跑中的）最近的那个设下，那人得在 TRAP_NEAR 米以内
 */
function armTraps(w: World, reach: Reach) {
  if (w.state.objects.filter((o) => o.armed > 0).length >= TRAP.max) return;
  const people = w.state.npcs.filter((n) => n.mode !== 'fleeing' && n.mode !== 'gone');
  let best: ScareObjectState | null = null, bestD = TRAP_NEAR;
  for (const o of w.state.objects) {
    if (!TRAP_TYPES.has(o.type) || !ready(o) || o.armed > 0 || o.seenBy.length > 0 || !reach(o)) continue;
    for (const n of people) {
      const d = Math.hypot(n.pos.x - o.pos.x, n.pos.z - o.pos.z);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
  }
  if (best) w.arm(best.id);
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
