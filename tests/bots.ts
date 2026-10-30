// 平衡测试用的「玩家」机器人（无界面，固定种子）。tests/balance.test.ts 用它们断言数值目标。
// - skilled：像一个会玩的人。
//   1. 眼睛图标亮了（seenBy 非空）就附身那个惊吓物件（每 0.25 秒看一次，大概是人的反应速度）
//   2. 先引诱、再惊吓：预测听见引诱声的人会怎么走（和模拟用同一个 alertPath；警觉时手电一直指着声源，到了再左右扫），
//      途中或查看时会看见一个可用的惊吓物件，就拉响引诱。lureCoverage 统计这在多少位置成立
//      （旧布局：厨房门 1/231、八音盒 10/86，几乎用不上；现布局见 tests/balance.test.ts 目标 5）
//   3. 续恐惧：听得见的人已经在害怕、此刻没在警觉 / 受惊，也拉响引诱（恐惧值上涨、回落计时重来）
//   4. 机关（2026-10-28）：每 TRAP_EVERY 步看一次，设下的不到 TRAP.max 个，就在没人看得见的背后型物件（摇椅、床）里
//      挑离访客最近的那个设下（TRAP_NEAR 米以内有人才设：等人路过时在他背后发作）。衣柜先不设，见 TRAP_TYPES
// - random：每 3 秒随机点一个能附身的物件，不看时机
// - idle：不附身（只用来看鬼魂单独有多大用）
// 鬼魂（第三人称改版，opts.ghost = 'hover'）：和上面任何一种叠加。每步把鬼魂飘向最近的访客、贴在他身后 GHOST_BOT.behind 米
// （跟定一个人，直到他逃跑或离开），比真人跟得紧：是鬼魂效果的上限。opts.reach 限制只附身离鬼魂多近的物件（第三人称的准星）
// 现身（2026-10-28，opts.ghost = 'manifest'）：鬼魂飘到跟定的人面前（他手电照的方向上）MANIFEST_BOT.front 米处，
// 一冷却好就现身（现身期间不动）；也可以和 skilled 叠加（附身 + 现身）
// 2026-10-30 用户试玩以后（路 GP）加了两种打法，拿来对照「只按现身」和「先引诱再附身」（tests/balance.test.ts 的「现身是收尾」）：
// - opts.ghost = 'spam'：严格玩家 critic 的「狂按 F」——跟着最近的人往他面前飘，人在 MANIFEST.range 内、冷却一好就按，不管飘到没有
//   （和 'manifest' 的区别：'manifest' 是会玩的只按现身，飘到他手电照着的地方才按）
// - opts.ghost = 'hug'：用户说的「站在人旁边狂按 F」——贴在跟定的人身后 GHOST_BOT.behind 米（发毛、后颈一凉也都吃到），冷却一好就按
// - kind = 'lurer'：先引诱、再附身的玩家（第三人称，鬼魂要飘过去，只能附身 LURER.reach 米内的物件），见 lurerStep；
//   opts.finisher 时对已经紧张的人现身收尾
// opts.world / opts.night：给 createWorld 的开关（正式游戏的 nightWorld）、到点收夜 / 天亮（正式游戏的一夜），默认都不给
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import type { Rng } from '../src/sim/rng';
import { Grid } from '../src/sim/grid';
import { createBrowse } from '../src/sim/browse';
import { alertPath, investigateDist, scanStops } from '../src/sim/npc';
import { canHear, canSee } from '../src/sim/perception';
import { reachOf } from '../src/sim/reach';
import { facesToward } from '../src/sim/scares';
import { cellCenter, cellOf, FRONT_DOOR, GRID_H, GRID_W } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { MANIFEST, SCAN, TRAP, VISION } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import { GHOST_SOURCE } from '../src/sim/types';
import type { NpcState, Personality, ScareObjectState, ScareType, SimEvent, Vec2, World, WorldOptions } from '../src/sim/types';

export type BotKind = 'skilled' | 'random' | 'idle' | 'lurer';
/**
 * 鬼魂：none = 没有鬼魂（触屏的俯视模式），hover = 鬼魂机器人贴着最近的访客，manifest = 到他面前现身，
 * spam = 跟着最近的人、冷却一好就现身（不管在不在他光里），hug = 贴在他身后、冷却一好就现身。kind = 'lurer' 自己开鬼魂，不看这一项
 */
export type GhostPolicy = 'none' | 'hover' | 'manifest' | 'spam' | 'hug';

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
/**
 * 「狂按 F」的机器人（opts.ghost = 'spam'，严格玩家 critic 的 spam 玩家）：往跟定的人面前 front 米处飘（他手电照的方向上，先试第一个），
 * 他在 MANIFEST.range 米内、冷却一好就按，不等飘到
 */
export const SPAM_BOT = { front: [2.4, 1.8, 3.0, 1.3] };
/**
 * 「先引诱、再附身」的机器人（kind = 'lurer'）：只能附身离鬼魂 reach 米内的物件（第三人称的准星，engine/picking.ts 的 AIM_RANGE）；
 * 飘到离要用的物件 near 米处就停（够得着、不贴着）；一个计划最多等 plan 秒；没事做时在跟定的人 hover 米外跟着（不贴身发毛）；
 * finisher 时对恐惧值 ≥ finish 的人现身收尾
 */
export const LURER = { reach: 4, near: 3, plan: 14, hover: 3, finish: 40 };
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
  /** 鬼魂机器人穿墙（告诉模拟的 inWall 由假变真）的次数；模拟去抖、每人冷却以后，真正被听见的会少一些 */
  wallPasses: number;
  /** 天亮自己走的人数（opts.night，exit 带 calm）：不算吓跑，不在 exits 里 */
  calm: number;
  /** 物件（惊吓类、引诱类，含机关）让人涨的恐惧值、现身让人涨的恐惧值（几局对照「谁干了活」） */
  propFear: number;
  manifestFear: number;
  /** 画像、镜子被人看着（seenBy 不空）：几次（连续看够 LOOK_MIN 秒才算一次）、一共几秒 */
  looks: Record<'portrait' | 'mirror', { n: number; seconds: number }>;
  /** 六幅挂画：有人停下来、手电照着看（NpcState.gazing + canSee）了几次；每幅几次 */
  paintingStops: number;
  paintings: Record<string, number>;
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
  /** 给 createWorld 的开关（比如正式游戏的 nightWorld）；seed、autoSpawn 另给 */
  world?: Omit<WorldOptions, 'seed' | 'autoSpawn'>;
  /** 正式游戏的一夜：模拟时间到 close 秒收夜（World.close）、到 dawn 秒天亮（World.dawn） */
  night?: { close: number; dawn: number };
  /** kind = 'lurer'：对已经紧张的人现身收尾（LURER.finish） */
  finisher?: boolean;
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
 * 设了也不多吓到谁，反倒让目标 6 统计的附身次数变少；背后型（在他背后发作、他回头）是它自己点不出来的。
 * 衣柜也是背后型，但机器人先不设它（2026-10-29 lane Q1，等用户定）：它在卧室门边，单独一个 brave 每进一次卧室它就发作一次。
 * 每次受惊不管涨多少都让回落重新计时，等于白送一次「续恐惧」，顶替了引诱续恐惧和鬼魂贴身的用处，所以衣柜吓多少几乎不影响结果。
 * 加进来以后，衣柜的数值怎么调都过不了两条（恐惧值 0–26、冷却 14–60、range 1.5–9、active 2.3–5 都试过）：
 * 目标 5「单个 brave：会用引诱 ≥ 不用 + 4」（不用引诱 3 分钟内吓跑的 5 → 6–9 局）、
 * 鬼魂 2「单个 brave 加鬼魂中位 ≤ 0.8 × 不加」（不加鬼魂的中位 87 → 80–84 秒，加鬼魂的一直是 68 秒）
 */
const TRAP_TYPES: ReadonlySet<ScareType> = new Set<ScareType>(['rockingChair', 'bed']);
/** 听见引诱声后多少秒内被吓到，算作引诱带来的惊吓 */
const LURE_LED_WINDOW = 8;
/** 预测路径时每隔多少米检查一次能不能看见惊吓物件 */
const PREDICT_STEP = 0.5;

/** 机器人预测用的地图；每局开始时重建（测试里可能临时改了摆放） */
let grid = new Grid();

/** 一局：opts.seconds 秒的模拟时间（默认 300），按 1/60 步进 */
export function runBot(seed: number, kind: BotKind, opts: RunOptions = {}): BotRun {
  const seconds = opts.seconds ?? 300;
  const lures = opts.lures ?? 'both';
  grid = new Grid();
  const w = createWorld({ ...opts.world, seed, autoSpawn: opts.autoSpawn ?? true });
  opts.setup?.(w);
  const rng = createRng(seed * 7919 + 17);
  const visitors = new Map<number, VisitorLog>();
  let maxSingleScare = 0, lureLedScares = 0;
  const land = landingLog();
  const fire: Fire = (id) => {
    const ok = w.trigger(id);
    const o = w.state.objects.find((x) => x.id === id);
    if (ok && o && isSight(o)) land.fired(id);
    return ok;
  };
  const lastHeard = new Map<number, number>();
  /** 这一步的现身落下吓到了谁（同一步紧跟着的 GHOST_SOURCE startle 算现身的，不算后颈一凉） */
  let dropAt = -1, dropped = new Set<number>();
  const looks = lookLog(w);
  const lurer = kind === 'lurer';
  const ghost: GhostBot | null =
    lurer || opts.ghost === 'hover' || opts.ghost === 'manifest' || opts.ghost === 'spam' || opts.ghost === 'hug'
      ? { pos: { ...GHOST_BOT.start }, target: null, wasInWall: null, passes: 0, plan: null, pulled: new Map<string, number>() }
      : null;
  const steer = opts.ghost === 'manifest' ? manifestGhost : opts.ghost === 'spam' ? spamGhost : opts.ghost === 'hug' ? hugGhost : moveGhost;
  const reach = lurer ? LURER.reach : opts.reach ?? Infinity;
  const inReach = (o: ScareObjectState) => !ghost || Math.hypot(o.pos.x - ghost.pos.x, o.pos.z - ghost.pos.z) <= reach;
  let chills = 0, necks = 0, ghostFear = 0, maxNeck = 0, manifests = 0, manifestScares = 0, calm = 0, propFear = 0, manifestFear = 0;
  let closed = false, dawned = false;
  const steps = Math.round(seconds / DT);
  for (let k = 0; k < steps; k++) {
    if (opts.night && !closed && w.state.time >= opts.night.close) {
      closed = true;
      w.close();
    }
    if (opts.night && !dawned && w.state.time >= opts.night.dawn) {
      dawned = true;
      w.dawn();
    }
    if (lurer) lurerStep(w, ghost!, k, fire, opts.finisher === true);
    else if (ghost) steer(w, ghost);
    if (kind === 'skilled') {
      if (k % SIGHT_EVERY === 0) fireLitEyes(w, fire, inReach);
      if (k % LURE_EVERY === 0 && lures !== 'none') fireLures(w, lures, fire, inReach);
      if (k % TRAP_EVERY === 0) armTraps(w, inReach);
    } else if (kind === 'random' && k % RANDOM_EVERY === 0) randomMove(w, rng, fire);
    const events = w.step(DT);
    land.observe(events, w.state.objects);
    for (const e of events) {
      if (e.type === 'spawn') {
        const n = w.state.npcs.find((m) => m.id === e.npc)!;
        visitors.set(e.npc, { id: e.npc, personality: n.personality, spawnedAt: w.state.time, exitedAt: null, peakFear: 0 });
      } else if (e.type === 'exit') {
        if (e.calm) calm++;
        else visitors.get(e.npc)!.exitedAt = w.state.time;
      } else if (e.type === 'heard') {
        lastHeard.set(e.npc, w.state.time);
        propFear += e.amount ?? 0;
      } else if (e.type === 'manifest' && e.phase === 'drop') {
        manifests++;
        manifestScares += e.scared.length;
        dropAt = w.state.time;
        dropped = new Set(e.scared);
      } else if (e.type === 'chill') {
        ghostFear += e.amount;
        if (e.neck) {
          necks++;
          maxNeck = Math.max(maxNeck, e.amount);
        } else chills++;
      } else if (e.type === 'startle' && e.object !== null && e.object !== GHOST_SOURCE) {
        maxSingleScare = Math.max(maxSingleScare, e.amount);
        propFear += e.amount;
        const h = lastHeard.get(e.npc);
        if (h !== undefined && w.state.time - h <= LURE_LED_WINDOW) lureLedScares++;
      } else if (e.type === 'startle' && e.object === GHOST_SOURCE && dropAt === w.state.time && dropped.has(e.npc)) {
        manifestFear += e.amount;
      }
    }
    for (const n of w.state.npcs) {
      const v = visitors.get(n.id);
      if (v && n.mode !== 'fleeing') v.peakFear = Math.max(v.peakFear, n.fear);
    }
    looks.observe();
  }
  const list = [...visitors.values()];
  const lifetimes = list.filter((v) => v.exitedAt !== null).map((v) => v.exitedAt! - v.spawnedAt);
  return {
    seed, kind, seconds, visitors: list, exits: lifetimes.length, lifetimes, maxSingleScare, lureLedScares, landing: land.landing,
    chills, necks, ghostFear, maxNeck, manifests, manifestScares, wallPasses: ghost?.passes ?? 0, calm, propFear, manifestFear, ...looks.result(),
  };
}

/** 看够多少秒才算「看了一次」：手电扫过去那一下不算 */
const LOOK_MIN = 1;

/** 画像、镜子被看了几次几秒，挂画被停下来照着看了几次（BotRun 的 looks、paintingStops、paintings）。每步 observe 一次 */
function lookLog(w: World) {
  const spots = new Map(createBrowse(grid, w.state.objects, { chance: 0, hold: [0, 0] }).spots.map((s) => [s.id, s]));
  const looks = { portrait: { n: 0, seconds: 0 }, mirror: { n: 0, seconds: 0 } };
  const run = { portrait: 0, mirror: 0 };
  const paintings: Record<string, number> = {};
  /** 这个人这一次停下来看（看的是哪一处），已经记过照着看了 */
  const counted = new Map<number, string>();
  return {
    observe() {
      for (const id of ['portrait', 'mirror'] as const) {
        if (w.state.objects.find((o) => o.id === id)!.seenBy.length > 0) {
          looks[id].seconds += DT;
          run[id] += DT;
          if (run[id] >= LOOK_MIN && run[id] - DT < LOOK_MIN) looks[id].n++;
        } else run[id] = 0;
      }
      for (const n of w.state.npcs) {
        const id = n.gazing ?? null;
        if (!id) {
          counted.delete(n.id);
          continue;
        }
        const s = spots.get(id);
        if (!s || id === 'portrait' || id === 'mirror' || counted.get(n.id) === id || !canSee(grid, n, s.pos, VISION.range)) continue;
        counted.set(n.id, id);
        paintings[id] = (paintings[id] ?? 0) + 1;
      }
    },
    result() {
      return { looks, paintings, paintingStops: Object.values(paintings).reduce((a, b) => a + b, 0) };
    },
  };
}

/**
 * 目标 6 的统计：机器人每附身一个惊吓物件（fired），这一次有没有真的吓到至少一个人。
 * observe 每步调一次（这一步的事件、此刻的物件状态）：附身了、还没吓到人的物件，第一次有人被它吓到（startle 的 object 是它）记一次吓到；
 * 生效窗口（active）走完还没人被吓到，这一次就是落空，不再等。以前一直等下去：同一个物件之后被机关触发吓到了人，
 * 会记到前面落空的那次附身头上（最终审查 S M5），落空率偏低
 */
export function landingLog() {
  const landing: Record<string, { fired: number; landed: number }> = {};
  /** 附身了、生效窗口还没走完、还没吓到人的惊吓物件（同一个物件冷却比生效窗口长，不会重叠） */
  const pending = new Set<string>();
  return {
    landing,
    fired(id: string) {
      (landing[id] ??= { fired: 0, landed: 0 }).fired++;
      pending.add(id);
    },
    observe(events: readonly SimEvent[], objects: readonly ScareObjectState[]) {
      for (const e of events) if (e.type === 'startle' && e.object !== null && pending.delete(e.object)) landing[e.object].landed++;
      // 先认这一步的惊吓、再关窗口：窗口最后一步吓到的人照样算
      for (const id of pending) if (!(objects.find((o) => o.id === id)!.active > 0)) pending.delete(id);
    },
  };
}

interface GhostBot {
  pos: Vec2;
  /** 正跟着的访客 id */
  target: number | null;
  /** 上一步告诉模拟的 inWall（还没告诉过为 null）；穿墙的次数 */
  wasInWall: boolean | null;
  passes: number;
  /** kind = 'lurer' 的计划（见 lurerStep）；别的机器人不用 */
  plan: LurerPlan | null;
  /** kind = 'lurer'：给谁拉过哪个引诱物件、什么时候（SCAN.again 秒内同一个人不再为同一个引诱物件做计划：他只会回头看一眼） */
  pulled: Map<string, number>;
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
  const inWall = grid.isOpaque(i, j);
  if (inWall && g.wasInWall === false) g.passes++;
  g.wasInWall = inWall;
  w.setGhost({ x: g.pos.x, z: g.pos.z, inWall });
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

/**
 * 「狂按 F」的鬼魂走一步（opts.ghost = 'spam'）：现身期间不动；否则往跟定的人面前飘（SPAM_BOT.front，他手电照的方向上、和他之间没有墙），
 * 他在 MANIFEST.range 米内、冷却好了、鬼魂不在墙里就现身——不管飘到没有、在不在他的光里
 */
function spamGhost(w: World, g: GhostBot) {
  const phase = w.state.manifest.phase;
  const t = phase === 'windup' || phase === 'hold' ? undefined : targetOf(w, g);
  if (t) {
    const spot = frontSpot(t, SPAM_BOT.front) ?? t.pos;
    driftTo(g, spot.x, spot.z);
  }
  placeGhost(w, g);
  if (t && phase === 'idle' && Math.hypot(t.pos.x - g.pos.x, t.pos.z - g.pos.z) <= MANIFEST.range) w.manifest();
}

/** 「贴身狂按」的鬼魂走一步（opts.ghost = 'hug'）：现身期间不动；否则贴在跟定的人身后 GHOST_BOT.behind 米，冷却好了、鬼魂不在墙里就现身 */
function hugGhost(w: World, g: GhostBot) {
  const phase = w.state.manifest.phase;
  const t = phase === 'windup' || phase === 'hold' ? undefined : targetOf(w, g);
  if (t) driftTo(g, t.pos.x - Math.cos(t.heading) * GHOST_BOT.behind, t.pos.z - Math.sin(t.heading) * GHOST_BOT.behind);
  placeGhost(w, g);
  if (t && phase === 'idle') w.manifest();
}

/** 他手电照的方向上 fronts 米处（先试第一个；那里在墙里、或者和他之间隔着墙就试下一个）；都不行为 null */
function frontSpot(t: NpcState, fronts: readonly number[]): Vec2 | null {
  for (const f of fronts) {
    const p = { x: t.pos.x + Math.cos(t.lookDir) * f, z: t.pos.z + Math.sin(t.lookDir) * f };
    const [i, j] = cellOf(p.x, p.z);
    if (!grid.isOpaque(i, j) && grid.lineOfSight(t.pos, p)) return p;
  }
  return null;
}

/** 「先引诱、再附身」的计划：lure（先拉响这个引诱物件，null = 不用引诱）→ 飘到 sight 旁等眼睛亮；finish：飘到 npc 面前现身收尾 */
type LurerPlan =
  | { kind: 'lure'; lure: string | null; sight: string; npc: number; until: number; pulled: boolean }
  | { kind: 'finish'; npc: number; until: number };

/** 鬼魂朝 p 飘，飘到离它 within 米以内就停；返回飘完离 p 多远 */
function approach(g: GhostBot, p: Vec2, within: number): number {
  const d = Math.hypot(p.x - g.pos.x, p.z - g.pos.z);
  if (d <= within) return d;
  const k = (d - within) / d;
  return within + driftTo(g, g.pos.x + (p.x - g.pos.x) * k, g.pos.z + (p.z - g.pos.z) * k);
}

/**
 * 「先引诱、再附身」的机器人走一步（kind = 'lurer'，第三人称：鬼魂飘过去，只能附身 LURER.reach 米内的物件）：
 * 1. 每 SIGHT_EVERY 步：够得着的惊吓物件眼睛亮了（seenBy 非空）、冷却好了就附身（和 skilled 一样，只是够得着的才行）
 * 2. finisher：现身冷却好了、有人恐惧值 ≥ LURER.finish 时，飘到他手电照着的地方（MANIFEST_BOT.front），这里现身会吓到他（reachOf）就现身
 * 3. 没有计划时（每 LURE_EVERY 步想一次）：跟定离鬼魂最近的人，找他听得见、能拉响的引诱物件，预测他被引过去、查看时会看见哪件
 *    可用的惊吓物件（lureTarget，和 lureLeadsToScare 同一套）；有就去拉响它、再到那件惊吓物件旁等眼睛亮；
 *    没有就挑他附近（6 米内、有视线）一件可用的惊吓物件过去等着（不引诱）。一个计划最多 LURER.plan 秒
 * 4. 没计划时在跟定的人 LURER.hover 米外跟着（不贴身：不靠发毛、后颈一凉）
 */
function lurerStep(w: World, g: GhostBot, k: number, fire: Fire, finisher: boolean) {
  const now = w.state.time;
  const live = (id: number) => w.state.npcs.find((n) => n.id === id && n.mode !== 'fleeing' && n.mode !== 'gone');
  const obj = (id: string) => w.state.objects.find((o) => o.id === id)!;
  const reachable = (o: ScareObjectState) => Math.hypot(o.pos.x - g.pos.x, o.pos.z - g.pos.z) <= LURER.reach;
  const m = w.state.manifest.phase;
  const busy = m === 'windup' || m === 'hold';
  // 计划作废：超时、人走了
  const p = g.plan;
  if (p && (now > p.until || !live(p.npc))) g.plan = null;
  if (g.plan?.kind === 'finish' && m !== 'idle') g.plan = null;
  // 1. 眼睛亮了就附身
  if (k % SIGHT_EVERY === 0) {
    for (const o of w.state.objects) {
      if (!isSight(o) || !ready(o) || o.seenBy.length === 0 || !reachable(o)) continue;
      fire(o.id);
      if (g.plan?.kind === 'lure' && g.plan.sight === o.id) g.plan = null;
    }
  }
  // 2. 现身收尾：有人已经够怕了
  if (finisher && !g.plan && m === 'idle') {
    const primed = w.state.npcs.filter((n) => n.mode !== 'fleeing' && n.mode !== 'gone' && n.fear >= LURER.finish);
    primed.sort((a, b) => Math.hypot(a.pos.x - g.pos.x, a.pos.z - g.pos.z) - Math.hypot(b.pos.x - g.pos.x, b.pos.z - g.pos.z));
    if (primed.length > 0) g.plan = { kind: 'finish', npc: primed[0].id, until: now + LURER.plan };
  }
  // 3. 想一个计划
  if (!g.plan && k % LURE_EVERY === 0) {
    const t = targetOf(w, g);
    if (t) g.plan = lurePlan(w, g, t, now);
  }
  // 走
  if (!busy) {
    const plan = g.plan;
    if (plan?.kind === 'finish') {
      const n = live(plan.npc)!;
      const spot = frontSpot(n, MANIFEST_BOT.front);
      if (spot) driftTo(g, spot.x, spot.z);
      placeGhost(w, g);
      if (reachOf(grid, w.state, { kind: 'manifest', at: g.pos }).includes(n.id) && w.manifest()) g.plan = null;
      return;
    }
    if (plan?.kind === 'lure' && plan.lure && !plan.pulled) {
      const lure = obj(plan.lure);
      if (approach(g, lure.pos, LURER.near) <= LURER.reach && ready(lure)) {
        const n = live(plan.npc)!;
        // 飘过来的这几秒里他走开了、听不见了：这个计划不成了
        if (canHear(grid, n.pos, lure.pos, SCARES[lure.type].range)) {
          fire(lure.id);
          plan.pulled = true;
          g.pulled.set(`${n.id}:${lure.id}`, w.state.time);
        } else g.plan = null;
      }
    } else if (plan?.kind === 'lure') {
      approach(g, obj(plan.sight).pos, LURER.near);
    } else {
      const t = targetOf(w, g);
      if (t) approach(g, t.pos, LURER.hover);
    }
  }
  placeGhost(w, g);
}

/**
 * 给跟定的人 t 想一个计划：能拉响的引诱物件（冷却好了、他听得见、他没在逃跑 / 警觉 / 受惊 / 察觉一个声音），预测他被引过去以后
 * 会看见哪件可用的惊吓物件（lureTarget）；挑鬼魂飘过去最近的那一对。都没有就挑他附近（VISION.range 内、有视线）一件可用的惊吓物件等着
 */
function lurePlan(w: World, g: GhostBot, t: NpcState, now: number): LurerPlan | null {
  const sights = w.state.objects.filter((o) => isSight(o) && ready(o));
  if (sights.length === 0) return null;
  const free = t.mode !== 'fleeing' && t.mode !== 'alert' && t.mode !== 'startled' && t.notice?.kind !== 'sound';
  let best: { lure: string; sight: string; cost: number } | null = null;
  if (free) {
    for (const lure of w.state.objects) {
      if (isSight(lure) || !ready(lure) || !canHear(grid, t.pos, lure.pos, SCARES[lure.type].range)) continue;
      // 刚为他拉过这一个：SCAN.again 秒内他只会回头看一眼，不会再走过去
      if (now - (g.pulled.get(`${t.id}:${lure.id}`) ?? -Infinity) < SCAN.again) continue;
      const sight = lureTarget(t.pos, lure.pos, sights, grid, t.personality, w.state.objects);
      if (!sight) continue;
      const cost = Math.hypot(lure.pos.x - g.pos.x, lure.pos.z - g.pos.z) + Math.hypot(sight.pos.x - lure.pos.x, sight.pos.z - lure.pos.z);
      if (!best || cost < best.cost) best = { lure: lure.id, sight: sight.id, cost };
    }
  }
  if (best) return { kind: 'lure', lure: best.lure, sight: best.sight, npc: t.id, until: now + LURER.plan, pulled: false };
  let near: ScareObjectState | null = null, nd = Infinity;
  for (const o of sights) {
    const d = Math.hypot(o.pos.x - t.pos.x, o.pos.z - t.pos.z);
    if (d < nd && d <= VISION.range && facesToward(o, t.pos) && grid.lineOfSight(t.pos, o.pos)) {
      near = o;
      nd = d;
    }
  }
  return near ? { kind: 'lure', lure: null, sight: near.id, npc: t.id, until: now + LURER.plan, pulled: false } : null;
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
    const predicted = policy !== 'topup' && hearers.some((n) => lureLeadsToScare(n.pos, lure.pos, sights, grid, n.personality, w.state.objects));
    const topUp = policy !== 'predict' && hearers.some((n) => n.fear > 0);
    if (predicted || topUp) fire(lure.id);
  }
}

/**
 * 预测：站在 from 的人听见 source 后会怎么走（和模拟用同一个 alertPath、investigateDist：走到离声源多近按性格，门要站进门洞），
 * 走的时候手电指着声源；到了查看位置会把四周扫一圈、在看得见的惊吓物件上停一下（2026-10-30 起，npc.ts 的 scanStops）。
 * 途中或查看时能看见 sights 里的某一个（含正面朝向）就返回 true
 */
export function lureLeadsToScare(
  from: Vec2,
  source: Vec2,
  sights: readonly ScareObjectState[],
  g: Grid = grid,
  personality: Personality = 'average',
  props: readonly ScareObjectState[] = sights,
): boolean {
  return lureTarget(from, source, sights, g, personality, props) !== null;
}

/**
 * lureLeadsToScare 的具体一件：他会先看见 sights 里的哪一件（途中先看见的优先，到了以后扫一圈时停下来看的次之）；看不见为 null。
 * 走到离声源多近按模拟的 investigateDist（性格；声源是 props 里的门时站进门洞）
 */
export function lureTarget(
  from: Vec2,
  source: Vec2,
  sights: readonly ScareObjectState[],
  g: Grid = grid,
  personality: Personality = 'average',
  props: readonly ScareObjectState[] = sights,
): ScareObjectState | null {
  if (sights.length === 0) return null;
  const path = alertPath(g, from, source, investigateDist(personality, source, props));
  if (!path) return null;
  const seen = (p: Vec2, lookDir: number) =>
    sights.find((o) => facesToward(o, p) && canSee(g, { pos: p, lookDir }, o.pos, Math.min(SCARES[o.type].range, VISION.range))) ?? null;
  const bearing = (p: Vec2) => angleOf(source.x - p.x, source.z - p.z);
  let a = from;
  for (const b of path) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(len / PREDICT_STEP));
    for (let s = 1; s <= steps; s++) {
      const p = { x: a.x + ((b.x - a.x) * s) / steps, z: a.z + ((b.z - a.z) * s) / steps };
      const o = seen(p, bearing(p));
      if (o) return o;
    }
    a = b;
  }
  return onArrival(g, a, sights);
}

/** 到了查看的位置 at：扫一圈时会停下来看 sights 里的哪几件（npc.ts 的 scanStops，模拟同一条规则）；挑最近的一件，一件都没有为 null */
function onArrival(g: Grid, at: Vec2, sights: readonly ScareObjectState[]): ScareObjectState | null {
  const stops = scanStops(g, at, sights);
  if (stops.length === 0) return null;
  const d = (o: ScareObjectState) => Math.hypot(o.pos.x - at.x, o.pos.z - at.z);
  return stops.reduce((m, o) => (d(o) < d(m) ? o : m));
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
        if (lureLeadsToScare(p, lure.pos, sights, g, 'average', objects)) leads++;
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
