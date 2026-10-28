// 访客状态机：进门 → 闲逛 ⇄ 警觉，被吓 → 受惊（僵住后恢复原状态），恐惧值满 → 逃跑 → 离开。
// 对外的 NpcState 就是这里的 npc.s（同一个对象放进 WorldState.npcs），内部状态放在 Npc 的其他字段里。
// 2026-10-28 第三人称改版加了三样（参数都在 config/visitors.ts）：
// - 鬼魂贴近时发毛（feelGhost，每步在状态机之前）：恐惧值慢慢上涨、走慢，贴得够久是「后颈一凉」（GHOST）
// - 走路的加减速（walk / stand）：沿路径的速度平滑变化，拐弯前提前转身、降速，快到终点时刹住（MOTION）
// - 访客之间互相避让（senseCrowd / separate）：侧身让路、跟着走、被挤开，挡住太久就绕开重新寻路（CROWD）
// 2026-10-28 访客反馈（设计文档 2.1–2.3）：察觉那一拍（notice）。听到声音、开始发毛时先停下、手电先转向来源、身体跟上，
// 盯 NOTICE.hold 秒再决定下一步（声音：走过去查看）；状态机在这期间暂停，路径留着（NOTICE、TRAITS）。
// 发毛不再随机回头张望：进入范围 GHOST.onset 秒内一定察觉一次，贴着发毛到 GHOST.backAt 就后退（retreat）；
// 鬼魂穿墙的声音也听得见（hearGhost）
import { CELL, cellCenter, cellOf, FRONT_DOOR, GRID_H, idx, inGrid, ROOMS, roomAt, Tile } from '../config/house';
import type { RoomId } from '../config/house';
import { BEHAVIOR, CROWD, FEAR, GHOST, MOTION, NOTICE, PERSONALITIES, SPEED, TRAITS } from '../config/visitors';
import { angleOf, wrapAngle } from '../lib/angle';
import { Grid } from './grid';
import { findPath } from './pathfind';
import type { Rng } from './rng';
import { windingUp } from './scares';
import type { ScareObject } from './scares';
import { GHOST_SOURCE } from './types';
import type { NoticeKind, NpcState, Personality, ScareType, SimEvent, Vec2 } from './types';

// 以下几个手电摆动幅度是计划里给的定值（config 里没有），集中放在这里方便调
/** 走路时手电在身体朝向两侧的小幅摆动（弧度），周期用 BEHAVIOR.sweepPeriod */
const WALK_SWEEP = 0.25;
/** 逃跑时手电在身体朝向两侧乱晃的范围（弧度） */
const FLEE_JITTER = 0.9;
/** 逃跑时每隔多久换一个乱晃的目标方向（秒）：短到看起来是慌乱地乱照 */
const FLEE_JITTER_HOLD: [number, number] = [0.08, 0.22];
/** 闲逛挑目标时最多试几次寻路，都失败就原地再照一会儿 */
const WANDER_TRIES = 8;

// 走路和避让里的几个小量（不是玩法参数）
/** 预判别人时，自己至少按这么快（米/秒）来算：站着正要起步的人也要提前让 */
const PLAN_SPEED = 0.4;
/** 跟在别人后面停下时，在 minDist 之外再留这么一点（米） */
const FOLLOW_MARGIN = 0.02;
/** 不算别人挡路时这一步想走的速度超过它（米/秒），才算「想走」（原地转身、察觉时不算被挡住） */
const WANT_MOVE = 0.2;
/** 剩下的路程比开始计时时少了这么多（米）才算有进展 */
const PROGRESS = 0.1;
/** 绕开别人重新寻路时，别人身边多近的格子（格子中心到他，米）当作走不通 */
const REPLAN_BLOCK = CROWD.minDist * 0.8;
/**
 * 给别人让路时，刹车距离按这个减速度（米/秒²）算：比 MOTION.decel 小，提前开始减速、留有余量，
 * 别人也在动（也在减速、拐弯）时大多仍用平常的减速就停得住，很少要急刹
 */
const CROWD_BRAKE = MOTION.decel * 0.6;
/** 两人完全重合时，按 id 错开推开的方向（黄金角，弧度） */
const GOLDEN = 2.399963;

// 鬼魂贴近的反应（参数在 GHOST）
/** 进入发毛范围后最早多久察觉（秒，计划给的定值）：最晚 GHOST.onset */
const ONSET_MIN = 0.15;
/** 胆大的被惊吓物件吓完、再照一眼那个物件：盯多久（秒，设计文档 2.5 给的定值） */
const RECHECK_HOLD = 1;
/**
 * 发毛到 GHOST.backAt 还贴着：后退半步（米）——退到比现在离鬼魂远这么多的地方。
 * 计划写的是 retreat(…, 0.5)（「离鬼魂至少 0.5 米」），可那样鬼魂在 0.5 米外时（机器人就贴在 0.5 米）一步也不用退
 */
const BACK_STEP = 0.5;

const TAU = Math.PI * 2;
const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

/** 前门两格中间：逃跑时先寻路到这里，再直线走到门外 */
const DOOR_POINT: Vec2 = (() => {
  const cs = FRONT_DOOR.cells.map(([i, j]) => cellCenter(i, j));
  return { x: cs.reduce((s, c) => s + c.x, 0) / cs.length, z: cs.reduce((s, c) => s + c.z, 0) / cs.length };
})();

/**
 * 前门外那一小段（不在格子里）：进门、逃出门时走的直线，也允许在门宽范围内侧身让路。
 * 前门在南墙上（FRONT_DOOR.cells 在最后一行）：门外 = 房子南边以外、门洞两格的 x 范围内，到门外那个点再往外 1 米
 */
const APRON = (() => {
  const xs = FRONT_DOOR.cells.map(([i]) => i);
  return { x0: Math.min(...xs) * CELL, x1: (Math.max(...xs) + 1) * CELL, z0: GRID_H * CELL, z1: FRONT_DOOR.outside.z + 1 };
})();

/** 寻路用的地图信息：每个房间里能走的格子，以及其中不贴墙（8 个邻格都能走）的格子 */
export interface Nav {
  grid: Grid;
  rooms: Record<RoomId, { all: [number, number][]; open: [number, number][] }>;
}

export function createNav(grid: Grid): Nav {
  const rooms = {} as Nav['rooms'];
  for (const id of ROOM_IDS) {
    const r = ROOMS[id];
    const all: [number, number][] = [];
    const open: [number, number][] = [];
    for (let j = r.z0; j < r.z1; j++) {
      for (let i = r.x0; i < r.x1; i++) {
        if (!grid.isWalkable(i, j)) continue;
        all.push([i, j]);
        let clear = true;
        for (let dj = -1; dj <= 1 && clear; dj++) for (let di = -1; di <= 1; di++) if (!grid.isWalkable(i + di, j + dj)) clear = false;
        if (clear) open.push([i, j]);
      }
    }
    rooms[id] = { all, open };
  }
  return { grid, rooms };
}

/** 状态机每步要用的上下文（world.ts 提供） */
export interface NpcCtx {
  nav: Nav;
  rng: Rng;
  /** 这一步开始时的模拟时间 */
  now: number;
  dt: number;
  events: SimEvent[];
  /** 有人开始尖叫：world 结算尖叫传染 */
  onScream(npc: Npc): void;
  /** 有人开始逃跑：world 设 hit-stop */
  onFlee(npc: Npc): void;
  /** 屋里所有访客（含自己）：避让用。看别人的位置用 px / pz（这一步开始移动前的快照） */
  crowd: readonly Npc[];
  /** 鬼魂的位置（房屋米坐标）；null = 没有鬼魂 */
  ghost: Vec2 | null;
}

/** walk = 沿 s.path 走；look = 原地停留（闲逛到达后左右照 / 警觉到达后查看） */
type Act = 'walk' | 'look';

/** 习惯化按「种类」记：六种物件，加上鬼魂的「后颈一凉」 */
type HabitKey = ScareType | 'ghost';

/** 受惊结束后要恢复的状态 */
interface Resume {
  mode: 'entering' | 'wander' | 'alert';
  act: Act;
  lookLeft: number;
  lookT: number;
  lookBase: number;
  source: Vec2 | null;
  /** 被吓到时正在察觉一个声音（还没走过去）：恢复后不回原来的事，去查看它。原来的路径在僵住期间原样留着 */
  alertAt: Vec2 | null;
}

export interface Npc {
  readonly s: NpcState;
  /** 性格的恐惧倍率 */
  readonly mult: number;
  /** 上次被吓（startle、heard、够分量的发毛）的模拟时间；生成时算一次 */
  lastScare: number;
  /** 被每种物件（和鬼魂的后颈一凉）吓过的「有效次数」和上次被这种吓的时间（习惯化，会随时间恢复） */
  readonly habit: Partial<Record<HabitKey, { n: number; t: number }>>;
  act: Act;
  /** 原地停留还剩几秒、已经停了几秒、左右照的中心方向 */
  lookLeft: number;
  lookT: number;
  lookBase: number;
  /** 走路时手电摆动的相位计时 */
  sweepT: number;
  /** 警觉：声源位置（手电一直指着它） */
  source: Vec2 | null;
  /** 受惊：还要僵住几秒，结束后恢复成什么 */
  startleLeft: number;
  resume: Resume | null;
  /** 最近一次吓到他的惊吓物件在哪（胆大的僵住结束后再照一眼用）；被别的吓到（后颈一凉）为 null */
  lastScareSrc: Vec2 | null;
  /** 逃跑：当前乱晃的目标偏角和保持时间 */
  jitter: number;
  jitterLeft: number;
  /**
   * 被定住盯着的惊吓物件（它还在蓄势）：停下脚步、身体和手电转向它，路径和各种计时都暂停，
   * 惊吓落下后照常判定、照常恢复。不加恐惧值，NpcState 里只表现为 speed 0
   */
  transfixOn: ScareObject | null;

  // ——— 察觉那一拍（s.notice 是正在察觉的来源和计时） ———
  /**
   * 站着的时候身体要转到的朝向（见 turnBack）：察觉开始时的朝向（察觉完照到鬼魂、发毛的人要转回去），
   * 或者后退完面朝吓到他的地方。走着的人由走路接管，清成 null
   */
  noticeHome: { heading: number } | null;
  /** 察觉完要去查看的声源（听到声音时记下）；null = 察觉完回到原来的事 */
  afterNotice: Vec2 | null;

  // ——— 走路与避让 ———
  /** 沿路径走的速度（米/秒），按 MOTION 平滑加减速。NpcState.speed 是这一步实际挪动的距离 / dt */
  v: number;
  /** 最近一次沿路径走的方向（单位向量）：停下时顺着它把最后一点速度滑完 */
  mx: number;
  mz: number;
  /**
   * 走着时侧身让路 + 被挤开的横向速度（米/秒，相对自己要走的方向，向右为正），按 CROWD.sideAccel 平滑。
   * 记相对值而不是房屋坐标：路一拐弯，侧向速度跟着转，不会突然变成往后拽、让速度跳一下
   */
  side: number;
  /** 站着时被挤开的速度（米/秒，房屋坐标），按 CROWD.sideAccel 平滑。走起来时换算进 side */
  ax: number;
  az: number;
  /** 这一步开始移动前的位置（world.ts 每步写入）：别人避让时看的是它，和更新顺序无关 */
  px: number;
  pz: number;
  /** 上一步实际的速度（米/秒，world.ts 写入）：别人预判用 */
  vx: number;
  vz: number;
  /** 想走却没有进展的累计秒数，以及开始计时时剩下的路程 */
  stuckT: number;
  stuckL: number;

  // ——— 鬼魂 ———
  /** 发毛程度（0–1，平滑过的），s.uneasy 同步它 */
  uneasy: number;
  /** 发毛的习惯化：有效的「减半」次数（可以是小数） */
  chillHabit: number;
  /** 还没结算的发毛恐惧值，和这一轮已经累计了多久 */
  chillAcc: number;
  chillT: number;
  /** 后颈一凉：在 neckRadius 内累计停留了多久；冷却到什么时候（模拟时间） */
  neckDwell: number;
  neckReadyAt: number;
  /** 最近一次感觉到的鬼魂方向（方向角） */
  ghostBearing: number;
  /** 正在一次「贴近」里：从感觉得到鬼魂开始，到鬼魂离开发毛范围为止（见 feelGhost） */
  ghostNear: boolean;
  /** 这次贴近什么时候察觉（模拟时间）；已经察觉过、或者鬼魂不在范围里为 Infinity */
  onsetAt: number;
  /** 这次贴近已经后退过了（每次贴近只退一次） */
  backedOff: boolean;
  /** 正在后退（retreat）：走的时候手电一直照着这里（吓到他的地方），到了以后面朝这里左右照 */
  retreatFrom: Vec2 | null;
  /** 上一步他的手电照没照着鬼魂（world.ts 写；变了就发 reveal） */
  litGhost: boolean;
}

export interface NpcInit {
  id: number;
  name: string;
  personality: Personality;
  pos: Vec2;
  lookDir: number;
  mode: 'entering' | 'wander';
  now: number;
}

export function createNpc(o: NpcInit, ctx: Pick<NpcCtx, 'rng'> & Partial<Pick<NpcCtx, 'nav'>>): Npc {
  const s: NpcState = {
    id: o.id,
    name: o.name,
    personality: o.personality,
    pos: { x: o.pos.x, z: o.pos.z },
    heading: o.lookDir,
    lookDir: o.lookDir,
    mode: o.mode,
    modeTime: 0,
    fear: 0,
    nervous: false,
    speed: 0,
    screaming: 0,
    path: [],
    uneasy: 0,
    notice: null,
  };
  const npc: Npc = {
    s,
    mult: PERSONALITIES[o.personality].fearMult,
    lastScare: o.now,
    habit: {},
    act: 'walk',
    lookLeft: 0,
    lookT: 0,
    lookBase: o.lookDir,
    sweepT: 0,
    source: null,
    startleLeft: 0,
    resume: null,
    lastScareSrc: null,
    jitter: 0,
    jitterLeft: 0,
    transfixOn: null,
    noticeHome: null,
    afterNotice: null,
    v: 0,
    mx: Math.cos(o.lookDir),
    mz: Math.sin(o.lookDir),
    side: 0,
    ax: 0,
    az: 0,
    px: o.pos.x,
    pz: o.pos.z,
    vx: 0,
    vz: 0,
    stuckT: 0,
    stuckL: Infinity,
    uneasy: 0,
    chillHabit: 0,
    chillAcc: 0,
    chillT: 0,
    neckDwell: 0,
    neckReadyAt: -Infinity,
    ghostBearing: 0,
    ghostNear: false,
    onsetAt: Infinity,
    backedOff: false,
    retreatFrom: null,
    litGhost: false,
  };
  if (o.mode === 'entering') {
    const inside = { x: FRONT_DOOR.inside.x, z: FRONT_DOOR.inside.z };
    // 正常从门外进来，直线走进门；调试时放在屋里能走的地方，就寻路过去，不穿墙
    const viaPath = ctx.nav && ctx.nav.grid.walkableAt(o.pos) ? findPath(ctx.nav.grid, o.pos, inside) : null;
    setPath(npc, viaPath ?? [inside]);
  }
  else startLook(npc, ctx, o.lookDir); // 站在原地先左右照一照
  return npc;
}

export const canBeScared = (n: Npc) => n.s.mode !== 'fleeing' && n.s.mode !== 'gone';

/** 吓呆了：受惊僵住，或者被蓄势的惊吓物件定住。这时不走、不被挤开 */
const isFrozen = (n: Npc) =>
  n.s.mode === 'startled' || (n.transfixOn !== null && (n.s.mode === 'entering' || n.s.mode === 'wander' || n.s.mode === 'alert'));

/**
 * 这个人这次被 type 吓到的量：base × 性格倍率 × habituation^n，n = 之前被这种物件吓过的有效次数。
 * 有效次数每过 FEAR.habituationRecover 秒恢复 1（连续地恢复，可以是小数；0 = 不恢复）。调用一次算一次「被吓过」。
 * 鬼魂的「后颈一凉」也按这个算（type = 'ghost'）
 */
export function exposure(npc: Npc, type: HabitKey, base: number, now: number): number {
  const h = npc.habit[type];
  const rec = FEAR.habituationRecover;
  const n = h ? (rec > 0 ? Math.max(0, h.n - (now - h.t) / rec) : h.n) : 0;
  npc.habit[type] = { n: n + 1, t: now };
  return base * npc.mult * FEAR.habituation ** n;
}

/** 加恐惧值。scare = false 时不算「被吓」（不让回落重新计时） */
function addFear(npc: Npc, amount: number, now: number, scare = true) {
  const s = npc.s;
  s.fear = Math.min(FEAR.max, s.fear + amount);
  s.nervous = s.fear >= FEAR.nervous;
  if (scare) npc.lastScare = now;
}

/**
 * 被惊吓类物件吓到：僵住 FEAR.startleTime 秒（记住之前的状态），够多就尖叫，涨满就直接逃跑。
 * 受惊中再被吓：重新开始僵住，恢复目标不变。
 */
export function startle(npc: Npc, ctx: NpcCtx, objectId: string, type: ScareType, objPos: Vec2, base: number): void {
  startleWith(npc, ctx, objectId, exposure(npc, type, base, ctx.now), objPos);
  if (npc.s.mode === 'startled') npc.lastScareSrc = { x: objPos.x, z: objPos.z };
}

/**
 * startle 的后半段：已经算好这一下涨多少（后颈一凉先发 chill 再走这里）。
 * 尖叫只留给吓破胆的时候（设计文档 2.4）：一次涨了 FEAR.screamAt 以上，或者这一下涨完到了 FEAR.dread（screamDread）
 */
function startleWith(npc: Npc, ctx: NpcCtx, objectId: string, amount: number, srcPos: Vec2): void {
  const s = npc.s;
  addFear(npc, amount, ctx.now);
  npc.lastScareSrc = null; // 物件的 startle 回头再记（见 startle）
  const scream = amount >= FEAR.screamAt || (FEAR.screamDread && s.fear >= FEAR.dread);
  ctx.events.push({ type: 'startle', npc: s.id, object: objectId, amount, scream });
  if (scream) {
    s.screaming = FEAR.screamTime;
    ctx.onScream(npc);
  }
  if (s.fear >= FEAR.max) {
    beginFlee(npc, ctx);
    return;
  }
  // 察觉到一半被吓到：那一拍作废。听到的声音照样算数（和「受惊中听到」一样），恢复后去查看
  const go = npc.afterNotice;
  clearNotice(npc);
  if (s.mode !== 'startled') {
    npc.resume = snapshot(npc);
    npc.resume.alertAt = go;
  }
  s.mode = 'startled';
  s.modeTime = 0;
  freeze(npc);
  npc.startleLeft = FEAR.startleTime;
  // 受惊不受转向限速：手电一下子定在吓到它的东西上（后颈一凉：猛地照向身后，什么也没有）
  const b = bearing(s.pos, srcPos);
  if (b !== null) s.lookDir = b;
}

/**
 * 听到声音（引诱声或别人的尖叫）：恐惧值增加；先察觉那一拍（停下、手电转向声源、盯一会儿），
 * 盯完再转入警觉走向声源，不僵住。
 * 受惊中听到：不打断僵住，只把「恢复后做什么」改成去查看这个声源（原来的路径在僵住期间原样留着）。
 */
export function hear(npc: Npc, ctx: NpcCtx, amount: number, source: Vec2, event: SimEvent): void {
  listen(npc, ctx, amount, source, event);
}

/** hear / hearGhost 的共同部分：event 为 null 时不发事件 */
function listen(npc: Npc, ctx: NpcCtx, amount: number, source: Vec2, event: SimEvent | null) {
  const s = npc.s;
  addFear(npc, amount, ctx.now);
  if (event) ctx.events.push(event);
  if (s.fear >= FEAR.max) {
    beginFlee(npc, ctx);
    return;
  }
  if (s.mode !== 'startled') {
    // 正在察觉更要紧的（现身蓄力）时不转过来，但声音记下了：那一拍完了照样去查看
    notice(npc, ctx, 'sound', source);
    npc.afterNotice = { x: source.x, z: source.z };
    return;
  }
  npc.resume ??= snapshot(npc);
  npc.resume.alertAt = { x: source.x, z: source.z };
}

// ——— 察觉那一拍 ———

/**
 * 察觉到一个来源（设计文档 2.1）：停下、手电先转向 src、身体跟上，盯 NOTICE.hold（× 性格的 noticeHold）秒，
 * 再按来源决定下一步（见 endNotice）。受惊、逃跑、已离开的人不察觉；正在察觉的来源优先级更高时不接管
 * （NOTICE.priority，一样高或更高就接管：转向新来源、重新计时）。接管成功发 notice 事件、返回 true。
 * hold：盯多久（秒）；不给就按 NOTICE.hold 随机再乘性格的 noticeHold
 */
export function notice(npc: Npc, ctx: NpcCtx, kind: NoticeKind, src: Vec2, hold?: number): boolean {
  const s = npc.s;
  if (!canBeScared(npc) || s.mode === 'startled') return false;
  const cur = s.notice;
  if (cur && NOTICE.priority[kind] < NOTICE.priority[cur.kind]) return false;
  // 接着上一次察觉（或者还没转回去）时，记的仍是最早的朝向
  if (!cur && !npc.noticeHome) npc.noticeHome = { heading: s.heading };
  s.notice = {
    kind,
    src: { x: src.x, z: src.z },
    t: 0,
    hold: hold ?? ctx.rng.range(NOTICE.hold[0], NOTICE.hold[1]) * TRAITS[s.personality].noticeHold,
  };
  ctx.events.push({ type: 'notice', npc: s.id, kind, src: { x: src.x, z: src.z } });
  return true;
}

/** 察觉作废（受惊、逃跑）：连同「察觉完去查看」一起清掉 */
function clearNotice(npc: Npc) {
  npc.s.notice = null;
  npc.afterNotice = null;
  npc.noticeHome = null;
}

/**
 * 察觉中（updateNpc 在状态机之前调）：沿路按 MOTION.decel 刹住（不急刹，可以被挤开），
 * 手电按 NOTICE.torchTurn 倍的速度转向来源，身体按平常的速度跟上；盯够了交给 endNotice
 */
function attend(npc: Npc, ctx: NpcCtx) {
  const s = npc.s, nt = s.notice!, dt = ctx.dt;
  brake(npc, ctx);
  const b = bearing(s.pos, nt.src);
  if (b !== null) {
    s.lookDir = turnToward(s.lookDir, b, BEHAVIOR.turnRate * NOTICE.torchTurn * dt);
    s.heading = turnToward(s.heading, b, BEHAVIOR.turnRate * dt);
  }
  nt.t += dt;
  if (nt.t >= nt.hold - 1e-9) endNotice(npc, ctx);
}

/**
 * 那一拍完了：听到了声音就走过去查看（警觉）；照到鬼魂、发毛就回到原来的事（站着的人身体转回察觉前的朝向，
 * 走着的人接着走原来的路）；现身蓄力什么都不做，等落下（现身的「定住」接管）
 */
function endNotice(npc: Npc, ctx: NpcCtx) {
  npc.s.notice = null;
  const go = npc.afterNotice;
  npc.afterNotice = null;
  if (go) {
    npc.noticeHome = null;
    beginAlert(npc, ctx, go);
  }
}

/** 察觉时停下：走着的人沿原来的路按 MOTION.decel 减速到 0（路径留着）；站着的人和平常站着一样（会被挤开） */
function brake(npc: Npc, ctx: NpcCtx) {
  const s = npc.s;
  if (npc.act !== 'walk' || s.path.length === 0) {
    stand(npc, ctx);
    return;
  }
  const vmax = s.mode === 'entering' ? SPEED.enter : s.mode === 'alert' ? SPEED.alert : s.nervous ? SPEED.nervous : SPEED.wander;
  walk(npc, ctx, vmax, s.mode !== 'entering', true);
}

// ——— 鬼魂贴近 ———

/**
 * 鬼魂贴近（world.ts 每步在状态机之前对每个人调一次）。访客看不见鬼魂，只会发毛：
 * - 强度 u（0–1）：GHOST.full 米内为满，往外线性减到发毛范围 R = GHOST.radius × 性格的 chillRange 为 0
 *   （中间隔墙时两个距离都乘 wallFactor）；再乘方向系数：鬼魂在身体正后方为 1，正前方为 GHOST.front
 * - 恐惧值按 GHOST.rate × u × 性格倍率 × 发毛的习惯化 累计，每 GHOST.chillEvery 秒结算一次、发 chill（neck: false）
 * - 进入范围（u 由 0 变正，算一次「贴近」）后 ONSET_MIN–GHOST.onset 秒内察觉一次（kind chill，来源是鬼魂那一刻的位置）：
 *   停一下、回头照一下。一直待在范围里不再察觉，离开再回来才算下一次（设计文档 2.2）
 * - 察觉过以后还贴着、强度 ≥ GHOST.backAt：后退半步（retreat，每次贴近一次），手电一直照着鬼魂那边
 * - 后颈一凉：GHOST.neckRadius 米内累计停留 GHOST.neckDwell 秒 → chill（neck: true）+ 一次正常的受惊
 *   （object = GHOST_SOURCE，习惯化按 'ghost' 这一种算），之后每人冷却 GHOST.neckCooldown 秒
 * - 发毛程度（平滑过的 u）让人走慢（walk 里用）
 * 逃跑中、已离开的人不理会鬼魂；没有鬼魂时只让发毛程度回落、习惯化恢复
 */
export function feelGhost(npc: Npc, ctx: NpcCtx): void {
  const s = npc.s, dt = ctx.dt;
  /** 这个人感觉得到的鬼魂：逃跑中、已离开的人不理会 */
  const g = canBeScared(npc) ? ctx.ghost : null;
  const R = GHOST.radius * TRAITS[s.personality].chillRange;
  let u = 0, neck = false, d = Infinity;
  if (g !== null) {
    const dx = g.x - s.pos.x, dz = g.z - s.pos.z;
    d = Math.hypot(dx, dz);
    if (d < R) {
      const wall = ctx.nav.grid.lineOfSight(s.pos, g) ? 1 : GHOST.wallFactor;
      if (d > 1e-6) npc.ghostBearing = angleOf(dx, dz);
      const close = clamp01((R * wall - d) / ((R - GHOST.full) * wall));
      const behind = d > 1e-6 ? (1 - Math.cos(wrapAngle(npc.ghostBearing - s.heading))) / 2 : 1;
      u = close * (GHOST.front + (1 - GHOST.front) * behind);
      neck = d <= GHOST.neckRadius * wall;
    }
  }
  // 一次「贴近」：从感觉得到（u > 0）开始，约好这次什么时候察觉；到鬼魂离开发毛范围（d ≥ R）为止。
  // 范围里隔着墙忽隐忽现（视线时有时无）不算离开：贴着墙飘的鬼魂不会让人一回头再一回头
  if (!npc.ghostNear && u > 0) {
    npc.ghostNear = true;
    npc.onsetAt = ctx.now + ctx.rng.range(ONSET_MIN, GHOST.onset);
    npc.backedOff = false;
  } else if (npc.ghostNear && !(d < R)) {
    npc.ghostNear = false;
    npc.onsetAt = Infinity;
  }
  npc.uneasy += clamp(u - npc.uneasy, -GHOST.fall * dt, GHOST.rise * dt);
  s.uneasy = npc.uneasy;

  // 恐惧值：一点点累计，每 chillEvery 秒结算成一个 chill。这一步里习惯化在连续加深，按积分算
  // （∫ rate·u·mult·h^(n + u·t/habitPer) dt），一直贴着涨的总量正好不超过 rate × habitPer / ln(1/h) × 性格倍率，和步长无关
  if (u > 0) {
    const h = FEAR.habituation, k = -Math.log(h);
    npc.chillAcc +=
      k > 0
        ? ((GHOST.rate * npc.mult * GHOST.habitPer) / k) * h ** npc.chillHabit * (1 - h ** ((u * dt) / GHOST.habitPer))
        : GHOST.rate * u * npc.mult * dt;
    npc.chillHabit += (u * dt) / GHOST.habitPer;
  } else if (npc.chillHabit > 0) npc.chillHabit = Math.max(0, npc.chillHabit - dt / GHOST.habitRecover);
  if (npc.chillAcc > 0) {
    npc.chillT += dt;
    if (npc.chillT >= GHOST.chillEvery - 1e-9) {
      const amount = npc.chillAcc;
      npc.chillAcc = 0;
      npc.chillT = 0;
      if (canBeScared(npc)) {
        addFear(npc, amount, ctx.now, amount >= GHOST.holdMin);
        ctx.events.push({ type: 'chill', npc: s.id, amount, neck: false });
        if (s.fear >= FEAR.max) {
          beginFlee(npc, ctx);
          return;
        }
      }
    }
  }

  if (g === null) {
    npc.neckDwell = 0;
    return;
  }

  // 后颈一凉
  if (ctx.now < npc.neckReadyAt - 1e-9) npc.neckDwell = 0;
  else if (neck) {
    npc.neckDwell += dt;
    if (npc.neckDwell >= GHOST.neckDwell - 1e-9) {
      npc.neckDwell = 0;
      npc.neckReadyAt = ctx.now + GHOST.neckCooldown;
      const amount = exposure(npc, 'ghost', GHOST.neckFear, ctx.now);
      ctx.events.push({ type: 'chill', npc: s.id, amount, neck: true });
      startleWith(npc, ctx, GHOST_SOURCE, amount, g);
      return;
    }
  } else npc.neckDwell = Math.max(0, npc.neckDwell - GHOST.neckDecay * dt);

  if (!npc.ghostNear) return;
  // 到点察觉一次：停一下、回头照一下（受惊中、正在察觉更要紧的东西时，这一次就算了）
  if (ctx.now >= npc.onsetAt - 1e-9) {
    npc.onsetAt = Infinity;
    notice(npc, ctx, 'chill', g);
  }
  // 察觉过了还贴着：后退半步。察觉那一拍还没完时先定好往哪退，盯完再走
  const free = npc.transfixOn === null && (s.mode === 'entering' || s.mode === 'wander' || s.mode === 'alert');
  if (free && npc.onsetAt === Infinity && !npc.backedOff && u >= GHOST.backAt) {
    npc.backedOff = true;
    retreat(npc, ctx, g, d + BACK_STEP);
  }
}

/**
 * 听到鬼魂穿墙的声音（world.ts 在 inWall 由假变真的那一步调）：恐惧值涨 amount（算「被吓」，回落重新计时），
 * 其余和 hear 一样：先察觉那一拍（kind sound，来源是穿墙的地方），盯完走过去查看；受惊中只改恢复目标。
 * 不发 heard 事件：heard 的 object 是物件 id，界面的滚动提示会按它查物件名
 */
export function hearGhost(npc: Npc, ctx: NpcCtx, amount: number, src: Vec2): void {
  listen(npc, ctx, amount, src, null);
}

/** 后退时落脚点的搜索：远离方向左右各偏几档、每档多少弧度（最多偏 90°）；离来源的距离往外最多再找多远、每圈多远（米） */
const RETREAT_FAN = 6;
const RETREAT_FAN_STEP = Math.PI / 12;
const RETREAT_REACH = 1;
const RETREAT_RING = 0.25;
/** 检查能不能直线走到落脚点时的采样间隔（米） */
const RETREAT_SAMPLE = 0.1;

/**
 * 后退（发毛贴得太近、被现身吓到）：沿远离 from 的方向，找一个离 from 至少 dist 米、能走、离现在的位置最近的点
 * （正后方走不了就往两边偏，最多偏 90°），寻路走过去（转入闲逛）；走的时候手电一直照着 from，
 * 到了以后面朝 from 左右照一会儿，再照常闲逛。已经够远、或者附近没有能走的点，就原地转向 from 照一照
 */
export function retreat(npc: Npc, ctx: NpcCtx, from: Vec2, dist: number): void {
  const s = npc.s;
  const spot = retreatSpot(ctx.nav.grid, s.pos, from, dist, s.heading);
  if (spot && Math.hypot(spot.x - s.pos.x, spot.z - s.pos.z) > BEHAVIOR.arrive && walkTo(npc, ctx, spot)) {
    npc.retreatFrom = { x: from.x, z: from.z };
    return;
  }
  s.mode = 'wander';
  s.modeTime = 0;
  npc.source = null;
  npc.retreatFrom = { x: from.x, z: from.z };
  lookAround(npc, ctx);
}

/** retreat 的落脚点（见上）。和 from 几乎重合时按身体朝向往前退 */
function retreatSpot(grid: Grid, pos: Vec2, from: Vec2, dist: number, heading: number): Vec2 | null {
  const d = Math.hypot(pos.x - from.x, pos.z - from.z);
  const a0 = d > 1e-6 ? angleOf(pos.x - from.x, pos.z - from.z) : heading;
  const r0 = Math.max(dist, d);
  let best: Vec2 | null = null, bestD = Infinity;
  for (let k = -RETREAT_FAN; k <= RETREAT_FAN; k++) {
    const a = a0 + k * RETREAT_FAN_STEP, ux = Math.cos(a), uz = Math.sin(a);
    for (let r = r0; r <= r0 + RETREAT_REACH + 1e-9; r += RETREAT_RING) {
      const p = { x: from.x + ux * r, z: from.z + uz * r };
      const dd = Math.hypot(p.x - pos.x, p.z - pos.z);
      if (dd >= bestD || !grid.walkableAt(p) || !straightWalk(grid, pos, p)) continue;
      best = p;
      bestD = dd;
    }
  }
  return best;
}

/** 从 a 直线走到 b 一路都是能走的格子（a 本身不查：进门途中在门外也能退） */
function straightWalk(grid: Grid, a: Vec2, b: Vec2): boolean {
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(len / RETREAT_SAMPLE));
  for (let k = 1; k <= n; k++) {
    if (!grid.walkableAt({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n })) return false;
  }
  return true;
}

/** 推进一步 */
export function updateNpc(npc: Npc, ctx: NpcCtx): void {
  const s = npc.s, dt = ctx.dt;
  s.modeTime += dt;
  if (canBeScared(npc)) {
    // 正常只会在被吓时涨满；这里兜底（调试时直接改了恐惧值）。要在回落之前判断
    if (s.fear >= FEAR.max) beginFlee(npc, ctx);
    // 连续 decayDelay 秒没被吓才开始回落；逃跑中不回落
    else if (s.fear > 0 && ctx.now - npc.lastScare >= FEAR.decayDelay) s.fear = Math.max(0, s.fear - FEAR.decayRate * dt);
  }
  s.nervous = s.fear >= FEAR.nervous;

  // 被惊吓物件的蓄势定住：只转向它，别的都不动（受惊、逃跑照常走下面的分支）
  if (npc.transfixOn && !windingUp(npc.transfixOn)) npc.transfixOn = null;
  if (npc.transfixOn && (s.mode === 'entering' || s.mode === 'wander' || s.mode === 'alert')) {
    freeze(npc);
    const b = bearing(s.pos, npc.transfixOn.state.pos);
    if (b !== null) {
      const max = BEHAVIOR.turnRate * BEHAVIOR.transfixTurn * dt;
      s.heading = turnToward(s.heading, b, max);
      s.lookDir = turnToward(s.lookDir, b, max);
    }
    return;
  }

  // 察觉那一拍：停下盯着来源，状态机（路径、各种计时）暂停；受惊、逃跑照常走下面的分支
  if (s.notice && (s.mode === 'entering' || s.mode === 'wander' || s.mode === 'alert')) {
    attend(npc, ctx);
    return;
  }

  switch (s.mode) {
    case 'startled': {
      freeze(npc);
      npc.startleLeft -= dt;
      if (npc.startleLeft <= 1e-9) restore(npc, ctx);
      break;
    }
    case 'entering': {
      const r = walk(npc, ctx, SPEED.enter, false);
      walkSweep(npc, dt);
      if (r === 'arrived') beginWander(npc, ctx);
      else if (r === 'stuck') unstick(npc, ctx);
      break;
    }
    case 'wander': {
      if (npc.act === 'walk') {
        const r = walk(npc, ctx, s.nervous ? SPEED.nervous : SPEED.wander, true);
        // 后退时手电一直照着吓到他的地方（背后），平常走路时照前面、小幅摆动
        const back = npc.retreatFrom && bearing(s.pos, npc.retreatFrom);
        if (back !== null && back !== undefined) lookToward(npc, dt, back);
        else walkSweep(npc, dt);
        if (r === 'arrived') lookAround(npc, ctx);
        else if (r === 'stuck') unstick(npc, ctx);
      } else {
        stand(npc, ctx);
        npc.lookT += dt;
        npc.lookLeft -= dt;
        turnBack(npc, dt);
        lookToward(npc, dt, npc.lookBase + BEHAVIOR.sweepAmp * Math.sin((TAU * npc.lookT) / BEHAVIOR.sweepPeriod));
        if (npc.lookLeft <= 0) beginWander(npc, ctx);
      }
      break;
    }
    case 'alert': {
      const toSrc = (npc.source && bearing(s.pos, npc.source)) ?? s.lookDir;
      if (npc.act === 'walk') {
        const r = walk(npc, ctx, SPEED.alert, true);
        lookToward(npc, dt, toSrc);
        if (r === 'arrived') startInvestigate(npc);
        else if (r === 'stuck') unstick(npc, ctx);
      } else {
        stand(npc, ctx);
        npc.lookT += dt;
        npc.lookLeft -= dt;
        npc.noticeHome = null;
        s.heading = turnToward(s.heading, toSrc, BEHAVIOR.turnRate * dt);
        lookToward(npc, dt, toSrc + BEHAVIOR.investigateSweep * Math.sin((TAU * npc.lookT) / BEHAVIOR.sweepPeriod));
        if (npc.lookLeft <= 0) beginWander(npc, ctx);
      }
      break;
    }
    case 'fleeing': {
      const r = walk(npc, ctx, SPEED.flee, false);
      npc.jitterLeft -= dt;
      if (npc.jitterLeft <= 0) {
        npc.jitter = ctx.rng.range(-FLEE_JITTER, FLEE_JITTER);
        npc.jitterLeft = ctx.rng.range(FLEE_JITTER_HOLD[0], FLEE_JITTER_HOLD[1]);
      }
      lookToward(npc, dt, s.heading + npc.jitter);
      if (r === 'arrived') {
        s.mode = 'gone';
        s.modeTime = 0;
        s.speed = 0;
      } else if (r === 'stuck') unstick(npc, ctx);
      break;
    }
    case 'gone':
      break;
  }
}

// ——— 状态切换 ———

/** 闲逛：随机挑一个别的房间里的可走格（优先不贴墙的）寻路过去；寻路失败换目标，都失败就原地再照一会儿 */
export function beginWander(npc: Npc, ctx: Pick<NpcCtx, 'nav' | 'rng'>): void {
  const s = npc.s;
  s.mode = 'wander';
  s.modeTime = 0;
  npc.source = null;
  npc.retreatFrom = null;
  const [ci, cj] = cellOf(s.pos.x, s.pos.z);
  const here = roomAt(ci, cj);
  const choices = ROOM_IDS.filter((r) => r !== here);
  for (let t = 0; t < WANDER_TRIES; t++) {
    const cells = ctx.nav.rooms[ctx.rng.pick(choices)];
    const pool = cells.open.length > 0 ? cells.open : cells.all;
    if (pool.length === 0) continue;
    const [i, j] = ctx.rng.pick(pool);
    const path = findPath(ctx.nav.grid, s.pos, cellCenter(i, j));
    if (path && path.length > 0) {
      setPath(npc, path);
      npc.act = 'walk';
      return;
    }
  }
  startLook(npc, ctx, s.heading);
}

/** 测试和调试用（world.spawn 的 goal）：转入闲逛，寻路走到 goal，到了再左右照。到不了返回 false（原状态不变） */
export function walkTo(npc: Npc, ctx: Pick<NpcCtx, 'nav'>, goal: Vec2): boolean {
  const path = findPath(ctx.nav.grid, npc.s.pos, goal);
  if (!path || path.length === 0) return false;
  npc.s.mode = 'wander';
  npc.s.modeTime = 0;
  npc.source = null;
  npc.retreatFrom = null;
  setPath(npc, path);
  npc.act = 'walk';
  return true;
}

/**
 * 闲逛走到了：原地左右照。刚后退完（retreatFrom）就面朝吓到他的地方照（身体也转过去，见 turnBack），
 * 否则照着走过来的方向
 */
function lookAround(npc: Npc, ctx: Pick<NpcCtx, 'rng'>) {
  const s = npc.s;
  const from = npc.retreatFrom;
  npc.retreatFrom = null;
  const b = from ? bearing(s.pos, from) : null;
  if (b === null) {
    startLook(npc, ctx, s.heading);
    return;
  }
  startLook(npc, ctx, b);
  npc.noticeHome = { heading: b };
}

/** 闲逛到达后：原地停 BEHAVIOR.lookAround 范围内随机的秒数，手电以 base 为中心左右扫 */
function startLook(npc: Npc, ctx: Pick<NpcCtx, 'rng'>, base: number) {
  const s = npc.s;
  s.mode = 'wander';
  s.path = [];
  npc.act = 'look';
  npc.lookT = 0;
  npc.lookLeft = ctx.rng.range(BEHAVIOR.lookAround[0], BEHAVIOR.lookAround[1]);
  npc.lookBase = base;
}

/** 警觉：按 alertPath 走过去（走到多近看性格：TRAITS.investigateDist）；已经在查看位置或寻路失败就原地查看 */
function beginAlert(npc: Npc, ctx: NpcCtx, source: Vec2) {
  const s = npc.s;
  s.mode = 'alert';
  s.modeTime = 0;
  npc.source = { x: source.x, z: source.z };
  npc.retreatFrom = null;
  const path = alertPath(ctx.nav.grid, s.pos, source, TRAITS[s.personality].investigateDist);
  if (path && path.length > 0) {
    setPath(npc, path);
    npc.act = 'walk';
  } else startInvestigate(npc);
}

/** 查看位置的采样间隔（米） */
const ALERT_SAMPLE = 0.1;

/**
 * 警觉的路线（不含起点）：朝声源旁最近的可走格（一样近时挑自己这一侧的）走，
 * 走到离声源 dist 米以内（按性格：TRAITS.investigateDist）、站在可走格上、看得见声源的第一个点就停。
 * 已经在这样的位置返回空数组；到不了返回 null。机器人测试也用它预测访客会走到哪里
 */
export function alertPath(grid: Grid, from: Vec2, source: Vec2, dist: number): Vec2[] | null {
  const R2 = dist ** 2;
  const viewSpot = (p: Vec2) =>
    (p.x - source.x) ** 2 + (p.z - source.z) ** 2 <= R2 && grid.walkableAt(p) && grid.lineOfSight(p, source);
  if (viewSpot(from)) return [];
  const [i, j] = grid.nearestWalkable(source, from);
  const path = findPath(grid, from, cellCenter(i, j));
  if (!path) return null;
  let a = from;
  for (let k = 0; k < path.length; k++) {
    const b = path[k];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / ALERT_SAMPLE));
    for (let t = 1; t <= n; t++) {
      const p = { x: a.x + ((b.x - a.x) * t) / n, z: a.z + ((b.z - a.z) * t) / n };
      if (viewSpot(p)) return [...path.slice(0, k), p];
    }
    a = b;
  }
  return path;
}

/** 警觉到达后：停 BEHAVIOR.investigate 秒，手电在声源方向两侧扫 */
function startInvestigate(npc: Npc) {
  npc.s.path = [];
  npc.act = 'look';
  npc.lookT = 0;
  npc.lookLeft = BEHAVIOR.investigate;
}

/** 逃跑：寻路到前门两格中间，再直线走到门外；还在门外（进门途中）就直接回头 */
function beginFlee(npc: Npc, ctx: NpcCtx) {
  const s = npc.s;
  s.mode = 'fleeing';
  s.modeTime = 0;
  s.fear = FEAR.max;
  s.nervous = true;
  s.screaming = FEAR.screamTime;
  npc.resume = null;
  npc.source = null;
  npc.startleLeft = 0;
  npc.act = 'walk';
  npc.jitter = 0;
  npc.jitterLeft = 0;
  npc.transfixOn = null;
  npc.retreatFrom = null;
  clearNotice(npc);
  const [i, j] = cellOf(s.pos.x, s.pos.z);
  const path = inGrid(i, j) ? findPath(ctx.nav.grid, s.pos, DOOR_POINT) ?? [{ ...DOOR_POINT }] : [];
  path.push({ x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z });
  setPath(npc, path);
  ctx.events.push({ type: 'flee', npc: s.id });
  ctx.onFlee(npc);
  ctx.onScream(npc);
}

function snapshot(npc: Npc): Resume {
  const mode = npc.s.mode;
  return {
    mode: mode === 'entering' || mode === 'alert' ? mode : 'wander',
    act: npc.act,
    lookLeft: npc.lookLeft,
    lookT: npc.lookT,
    lookBase: npc.lookBase,
    source: npc.source,
    alertAt: null,
  };
}

/**
 * 受惊结束：恢复之前的状态（路径还在 s.path 里），手电按限速转回去；僵住期间听到了声音就去查看。
 * 胆大的被惊吓物件吓完，有 TRAITS.recheck 的几率先再照一眼那个物件（察觉那一拍，盯 RECHECK_HOLD 秒）才走
 */
function restore(npc: Npc, ctx: NpcCtx) {
  resumeAfterStartle(npc, ctx);
  const src = npc.lastScareSrc, p = TRAITS[npc.s.personality].recheck;
  npc.lastScareSrc = null;
  if (src && p > 0 && ctx.rng.next() < p) notice(npc, ctx, 'sound', src, RECHECK_HOLD);
}

function resumeAfterStartle(npc: Npc, ctx: NpcCtx) {
  const r = npc.resume;
  npc.resume = null;
  npc.startleLeft = 0;
  if (!r) {
    beginWander(npc, ctx);
    return;
  }
  if (r.alertAt) {
    beginAlert(npc, ctx, r.alertAt);
    return;
  }
  const s = npc.s;
  s.mode = r.mode;
  s.modeTime = 0;
  npc.act = r.act;
  npc.lookLeft = r.lookLeft;
  npc.lookT = r.lookT;
  npc.lookBase = r.lookBase;
  npc.source = r.source;
  npc.stuckT = 0;
  npc.stuckL = Infinity;
}

function setPath(npc: Npc, path: Vec2[]) {
  npc.s.path = path;
  npc.stuckT = 0;
  npc.stuckL = Infinity;
  sideToWorld(npc);
}

/**
 * 换了路（新路的方向可能完全不同）：相对旧方向的侧向速度换成房屋坐标的余量，让它按原来的方向慢慢收掉，
 * 不跟着新方向一下子转过去（那样会突然朝别人 / 墙挪、被卡住，速度跳一下）
 */
function sideToWorld(npc: Npc) {
  if (npc.side === 0) return;
  npc.ax += -npc.mz * npc.side;
  npc.az += npc.mx * npc.side;
  npc.side = 0;
}

// ——— 走路 ———

type Step = 'walking' | 'arrived' | 'stuck';

/**
 * 沿路径走一步。
 * - 速度 v 按 MOTION 平滑加减速；目标速度 = vmax × 发毛放慢，察觉那一拍时为 0；拐角前按拐角大小提前降速；
 *   身体朝向偏得越多越慢（偏 90° 以上原地转身）；stopAtEnd 时按刹车距离在终点正好停住（离散地算，落地那一步也不突变）
 * - 位置沿折线走 v × dt：跨过路点接着走，中间路点到了 BEHAVIOR.arrive 范围就换下一个（拐角切圆一点）；
 *   不停的终点（进门、逃出门）也是到了 arrive 范围就算到
 * - 身体朝向按限速转向路的方向，快到拐角时提前转，到拐角时正好转一半
 * - 别人：前面通道里有人就跟着 / 停下（逃跑的人不让），迎面 / 交叉时侧身，离得太近被挤开（见 senseCrowd）
 * hold：察觉那一拍（见 brake）——目标速度为 0、身体朝向不管（由察觉转向来源），路径留着
 * 返回：还在走 / 走完了 / 被挡住太久（交给 unstick）
 */
function walk(npc: Npc, ctx: NpcCtx, vmax: number, stopAtEnd: boolean, hold = false): Step {
  const s = npc.s, dt = ctx.dt, grid = ctx.nav.grid;
  let path = s.path;
  if (path.length === 0) {
    stand(npc, ctx);
    return 'arrived';
  }
  if (!hold) npc.noticeHome = null;
  const ox = s.pos.x, oz = s.pos.z;
  // 中间路点已经在 arrive 范围里（比如被挤到这里）：换下一个
  while (path.length > 1 && Math.hypot(path[0].x - ox, path[0].z - oz) <= BEHAVIOR.arrive) path.shift();
  const wp = path[0];
  const d = Math.hypot(wp.x - ox, wp.z - oz);
  const fx = d > 1e-9 ? (wp.x - ox) / d : Math.cos(s.heading);
  const fz = d > 1e-9 ? (wp.z - oz) / d : Math.sin(s.heading);
  const want = angleOf(fx, fz);

  // —— 想走多快（先不算别人） ——
  const cruise = vmax * (1 - GHOST.slow * npc.uneasy);
  let soft = hold ? 0 : cruise;
  let face = want;
  if (path.length > 1) {
    const nx = path[1].x - wp.x, nz = path[1].z - wp.z, nl = Math.hypot(nx, nz);
    if (nl > 1e-9) {
      const ux = nx / nl, uz = nz / nl;
      const half = Math.acos(clamp(fx * ux + fz * uz, -1, 1)) / 2;
      const vc = cruise * Math.max(MOTION.cornerMin, Math.cos(half));
      soft = Math.min(soft, Math.sqrt(vc * vc + 2 * MOTION.decel * Math.max(0, d - BEHAVIOR.arrive)));
      // 快到拐角：身体提前转向下一段路，到 arrive 范围边上正好转到两段路的中间。
      // 提前量按巡航速度算（不按此刻的速度：拐弯前一降速，提前量就缩，身体又转回来，会来回晃）
      const k = 0.5 * clamp01(1 - (d - BEHAVIOR.arrive) / (Math.max(cruise, PLAN_SPEED) * MOTION.anticipate));
      const bx = fx * (1 - k) + ux * k, bz = fz * (1 - k) + uz * k;
      if (k > 0 && bx * bx + bz * bz > 1e-6) face = angleOf(bx, bz);
    }
  }
  soft *= Math.max(0, Math.cos(wrapAngle(want - s.heading)));
  const wantMove = soft > WANT_MOVE;

  // —— 别人 ——
  const rx = -fz, rz = fx; // 右手方向（x 向东、z 向南：朝东时右手边是南）
  const crowd = senseCrowd(npc, ctx, fx, fz, true);
  // 侧身时往前走得慢一点：合起来不超过巡航速度
  soft = Math.min(soft, Math.sqrt(Math.max(0, cruise * cruise - npc.side * npc.side - npc.ax * npc.ax - npc.az * npc.az)));
  let hard = stopAtEnd ? brakeSpeed(remaining(ox, oz, path), MOTION.decel, dt) : Infinity;
  if (s.mode !== 'fleeing') hard = Math.min(hard, crowd.follow);

  // —— 加减速 ——
  const v0 = npc.v;
  const up = s.mode === 'fleeing' ? MOTION.fleeAccel : MOTION.accel;
  let v = soft > v0 ? Math.min(soft, v0 + up * dt) : Math.max(soft, v0 - MOTION.decel * dt);
  if (v > hard) v = Math.min(v, Math.max(hard, v0 - MOTION.hardDecel * dt));

  // —— 沿路径走 ——
  let st = stepAlong(path, ox, oz, v * dt);
  if (!freeAt(grid, st.x, st.z) && reroute(npc, grid)) {
    path = s.path;
    st = stepAlong(path, ox, oz, v * dt);
  }
  let x = st.x, z = st.z;
  if (freeAt(grid, x, z)) path.splice(0, st.used);
  else {
    // 重新寻路也绕不开（几乎不会）：贴着墙滑，滑不动就停
    const sl = slide(grid, ox, oz, x, z, 0);
    x = sl.x;
    z = sl.z;
    if (sl.bx && sl.bz) v = 0;
  }
  npc.v = v;
  // 要走的方向：停下时顺着它滑完；也是 side 的参照（换成房屋坐标时用），所以停着也要更新
  npc.mx = fx;
  npc.mz = fz;
  const keep = stopAtEnd ? 1 : 0;
  while (path.length > keep && Math.hypot(path[0].x - x, path[0].z - z) <= BEHAVIOR.arrive) path.shift();

  // —— 侧身：往那边离墙（wallGap 以外）还有多少地方，按 sideAccel 刹得住才往那边去，贴到墙边时是慢慢停下的 ——
  let sideWant = crowd.side;
  if (sideWant !== 0) sideWant = Math.sign(sideWant) * Math.min(Math.abs(sideWant), brakeSpeed(sideRoom(grid, npc, ctx.crowd, x, z, rx * Math.sign(sideWant), rz * Math.sign(sideWant)), CROWD.sideAccel, dt));
  npc.side = approach(npc.side, sideWant, CROWD.sideAccel * dt);
  if (npc.side !== 0) {
    const sg = Math.sign(npc.side);
    npc.side = sg * sideCap(Math.abs(npc.side), sideRoom(grid, npc, ctx.crowd, x, z, rx * sg, rz * sg), dt);
  }
  // 刚从站着转成走、刚换了路：之前那点横向速度不一下子消失，按 sideAccel 慢慢收掉（同样按剩下的地方刹车）
  if (npc.ax !== 0 || npc.az !== 0) {
    const r = Math.hypot(npc.ax, npc.az);
    const k = Math.min(Math.max(0, r - CROWD.sideAccel * dt), sideCap(r, sideRoom(grid, npc, ctx.crowd, x, z, npc.ax / r, npc.az / r), dt)) / r;
    npc.ax *= k;
    npc.az *= k;
  }
  // 合起来的位移不超过 cruise × dt：超了只缩侧向那一份
  let lx = (rx * npc.side + npc.ax) * dt, lz = (rz * npc.side + npc.az) * dt;
  if (lx !== 0 || lz !== 0) {
    const px = x - ox, pz = z - oz, cap = cruise * dt;
    const a2 = lx * lx + lz * lz, b = px * lx + pz * lz, c2 = px * px + pz * pz - cap * cap;
    if (a2 + 2 * b + c2 > 0) {
      const k = clamp01((-b + Math.sqrt(Math.max(0, b * b - a2 * c2))) / a2);
      lx *= k;
      lz *= k;
    }
    const sl = slide(grid, x, z, x + lx, z + lz, CROWD.wallGap);
    if (sl.bx && sl.bz) {
      npc.side = 0;
      npc.ax = 0;
      npc.az = 0;
    }
    x = sl.x;
    z = sl.z;
  }
  s.pos.x = x;
  s.pos.z = z;
  s.speed = Math.hypot(x - ox, z - oz) / dt;
  if (!hold) s.heading = turnToward(s.heading, face, BEHAVIOR.turnRate * dt);

  if (path.length === 0) return 'arrived';
  // —— 被挡住：想走，但剩下的路程一直不减少 ——
  const left = remaining(x, z, path);
  if (!wantMove || left < npc.stuckL - PROGRESS) {
    npc.stuckT = 0;
    npc.stuckL = left;
    return 'walking';
  }
  npc.stuckT += dt;
  // 挡路的人先走（逃跑中、站着不动、id 更小）时自己等得短；迎面僵持时 id 大的先让
  const b = crowd.blocker;
  const yieldFirst = b === null || b.s.mode === 'fleeing' || Math.hypot(b.vx, b.vz) < 0.1 || b.s.id < s.id;
  return npc.stuckT >= (yieldFirst ? CROWD.stuckShort : CROWD.stuckLong) ? 'stuck' : 'walking';
}

/**
 * 没在走路（原地左右照、查看）：沿路径的速度按 MOTION.decel 减到 0（刚停下时顺着原方向滑完最后一点），
 * 离别人太近就被挤开一点
 */
function stand(npc: Npc, ctx: NpcCtx): void {
  const s = npc.s, dt = ctx.dt, grid = ctx.nav.grid;
  const ox = s.pos.x, oz = s.pos.z;
  let x = ox, z = oz;
  sideToWorld(npc); // 刚从走着转成站着：侧向速度换回房屋坐标，接着平滑
  if (npc.v > 0) {
    const v = Math.max(0, npc.v - MOTION.decel * dt);
    const sl = slide(grid, x, z, x + npc.mx * v * dt, z + npc.mz * v * dt, 0);
    x = sl.x;
    z = sl.z;
    npc.v = sl.bx && sl.bz ? 0 : v;
  }
  const crowd = senseCrowd(npc, ctx, npc.mx, npc.mz, false);
  // 被挤开：往那边离墙还有多少地方，按 sideAccel 刹得住才往那边去（贴到墙边时慢慢停下，不是一下子卡住）
  let tx = crowd.pushX, tz = crowd.pushZ;
  const tl = Math.hypot(tx, tz);
  if (tl > 0) {
    const lim = brakeSpeed(sideRoom(grid, npc, ctx.crowd, x, z, tx / tl, tz / tl), CROWD.sideAccel, dt);
    if (tl > lim) {
      tx *= lim / tl;
      tz *= lim / tl;
    }
  }
  const dx = tx - npc.ax, dz = tz - npc.az, dd = Math.hypot(dx, dz), max = CROWD.sideAccel * dt;
  if (dd <= max) {
    npc.ax = tx;
    npc.az = tz;
  } else {
    npc.ax += (dx / dd) * max;
    npc.az += (dz / dd) * max;
  }
  const al = Math.hypot(npc.ax, npc.az);
  if (al > 0) {
    const lim = sideCap(al, sideRoom(grid, npc, ctx.crowd, x, z, npc.ax / al, npc.az / al), dt);
    if (al > lim) {
      npc.ax *= lim / al;
      npc.az *= lim / al;
    }
    const sl = slide(grid, x, z, x + npc.ax * dt, z + npc.az * dt, CROWD.wallGap);
    if (sl.bx) npc.ax = 0;
    if (sl.bz) npc.az = 0;
    x = sl.x;
    z = sl.z;
  }
  s.pos.x = x;
  s.pos.z = z;
  s.speed = Math.hypot(x - ox, z - oz) / dt;
}

/** 吓呆了（受惊僵住、被定住）：一下子停住，不走、不被挤开 */
function freeze(npc: Npc) {
  npc.v = 0;
  npc.side = 0;
  npc.ax = 0;
  npc.az = 0;
  npc.s.speed = 0;
}

/**
 * 被挤偏以后，直线去下一个路点会碰到墙角（门框边上最常见）：从这里重新寻路到原来的终点（不管别人），
 * 新路先回到格子中心再走。逃跑的人先到前门两格中间。在门外那一段或者寻路失败返回 false
 */
function reroute(npc: Npc, grid: Grid): boolean {
  const s = npc.s;
  const [ci, cj] = cellOf(s.pos.x, s.pos.z);
  if (!inGrid(ci, cj) || s.path.length === 0) return false;
  const fleeing = s.mode === 'fleeing';
  const path = findPath(grid, s.pos, fleeing ? DOOR_POINT : s.path[s.path.length - 1]);
  if (!path || path.length === 0) return false;
  if (fleeing) path.push({ x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z });
  s.path = path;
  sideToWorld(npc);
  return true;
}

/** 站着的时候：身体按限速转向 noticeHome（察觉完转回察觉前的朝向；后退完转向吓到他的地方），到了就清掉 */
function turnBack(npc: Npc, dt: number) {
  if (npc.noticeHome === null) return;
  const s = npc.s;
  s.heading = turnToward(s.heading, npc.noticeHome.heading, BEHAVIOR.turnRate * dt);
  if (Math.abs(wrapAngle(s.heading - npc.noticeHome.heading)) < 1e-9) npc.noticeHome = null;
}

/** 走路时手电 = 身体朝向 + 小幅摆动 */
function walkSweep(npc: Npc, dt: number) {
  npc.sweepT += dt;
  lookToward(npc, dt, npc.s.heading + WALK_SWEEP * Math.sin((TAU * npc.sweepT) / BEHAVIOR.sweepPeriod));
}

function lookToward(npc: Npc, dt: number, want: number) {
  npc.s.lookDir = turnToward(npc.s.lookDir, want, BEHAVIOR.turnRate * dt);
}

/** 从 a 按最短方向转向 b，最多转 max 弧度 */
export function turnToward(a: number, b: number, max: number): number {
  const d = wrapAngle(b - a);
  return wrapAngle(a + Math.max(-max, Math.min(max, d)));
}

/** from 指向 to 的方向角；两点几乎重合时返回 null */
function bearing(from: Vec2, to: Vec2): number | null {
  const dx = to.x - from.x, dz = to.z - from.z;
  return dx * dx + dz * dz < 1e-6 ? null : angleOf(dx, dz);
}

/**
 * 还剩 dist 米、按 a 减速时，这一步最多能走多快还停得住。按固定步长离散地算：
 * 每步速度少 a × dt，最后一步正好落在终点，落地那一步的速度不超过 a × dt（下一步变成 0 也不算突变）
 */
export function brakeSpeed(dist: number, a: number, dt: number): number {
  const h = (a * dt) / 2;
  return Math.max(0, Math.sqrt(h * h + 2 * a * Math.max(0, dist)) - h);
}

/** 从 (x, z) 沿路径还要走多远 */
function remaining(x: number, z: number, path: readonly Vec2[]): number {
  let L = 0;
  for (const q of path) {
    L += Math.hypot(q.x - x, q.z - z);
    x = q.x;
    z = q.z;
  }
  return L;
}

/** 沿路径从 (x, z) 走 dist 米（不改路径）：走到哪、经过了几个路点 */
function stepAlong(path: readonly Vec2[], x: number, z: number, dist: number): { x: number; z: number; used: number } {
  let used = 0;
  while (dist > 1e-12 && used < path.length) {
    const q = path[used];
    const dd = Math.hypot(q.x - x, q.z - z);
    if (dist >= dd) {
      x = q.x;
      z = q.z;
      dist -= dd;
      used++;
    } else {
      x += ((q.x - x) / dd) * dist;
      z += ((q.z - z) / dd) * dist;
      dist = 0;
    }
  }
  return { x, z, used };
}

// ——— 避让 ———

/** 这一点能不能站：格子里的可走格，或者前门外那一小段 */
function freeAt(grid: Grid, x: number, z: number): boolean {
  const i = Math.floor(x / CELL), j = Math.floor(z / CELL);
  if (inGrid(i, j)) return grid.isWalkable(i, j);
  return x >= APRON.x0 && x <= APRON.x1 && z >= APRON.z0 && z <= APRON.z1;
}

/** 离墙够不够远：这一点和它东南西北 gap 米处都能站（侧身、被挤开时用；沿路径走不查，路径本身离墙够远） */
function clearAt(grid: Grid, x: number, z: number, gap: number): boolean {
  return freeAt(grid, x, z) && freeAt(grid, x + gap, z) && freeAt(grid, x - gap, z) && freeAt(grid, x, z + gap) && freeAt(grid, x, z - gap);
}

/** 侧挪时先粗后细地试探：这几个距离（米，由近到远），找到挪不过去的那一档再对半细分几次 */
const ROOM_PROBES = [0.03, 0.08, 0.15, 0.25, 0.4];
const ROOM_REFINE = 5;

/**
 * 从 (x, z) 往单位方向 (ux, uz) 侧挪还有多少地方（米，最多 ROOM_PROBES 的最后一档）：
 * 离墙 CROWD.wallGap 以外，并且不会挨到别人（离他们 minDist 以外，按他们这一步开始时的位置算）。
 * 侧身、被挤开的速度按这个距离刹车，贴到墙边、人边时是慢慢停下的
 */
function sideRoom(grid: Grid, npc: Npc, crowd: readonly Npc[], x: number, z: number, ux: number, uz: number): number {
  const gap = CROWD.wallGap, min = CROWD.minDist;
  let room = 0;
  if (clearAt(grid, x, z, gap)) {
    let bad = -1;
    for (const o of ROOM_PROBES) {
      if (!clearAt(grid, x + ux * o, z + uz * o, gap)) {
        bad = o;
        break;
      }
      room = o;
    }
    for (let k = 0; bad > 0 && k < ROOM_REFINE; k++) {
      const m = (room + bad) / 2;
      if (clearAt(grid, x + ux * m, z + uz * m, gap)) room = m;
      else bad = m;
    }
  }
  for (const o of crowd) {
    if (room <= 0) break;
    if (o === npc || o.s.mode === 'gone') continue;
    const dx = o.px - x, dz = o.pz - z;
    const du = dx * ux + dz * uz;
    if (du <= 0) continue; // 他在这个方向的背面：往这边挪只会离他更远
    const c = dx * dx + dz * dz - min * min;
    if (c <= 0) return 0; // 已经挨着了
    const disc = du * du - c;
    if (disc >= 0) room = Math.min(room, du - Math.sqrt(disc));
  }
  return Math.max(0, room);
}

/**
 * 横向速度 speed、往那边还剩 room 米：按 CROWD.sideAccel 刹得住的上限，但一步最多降 MOTION.hardDecel × dt
 * （别人突然靠过来、地方一下子变小时也不是一下子停住；真挨上了由 separate 兜底）
 */
function sideCap(speed: number, room: number, dt: number): number {
  return Math.min(speed, Math.max(brakeSpeed(room, CROWD.sideAccel, dt), speed - MOTION.hardDecel * dt));
}

/**
 * 从 (x0, z0) 挪到 (x1, z1)：整步能站就整步；不然只挪 x 或只挪 z（贴着墙滑）；都不行就不动。
 * gap > 0 时要求离墙 gap 米（clearAt），否则只要能站。bx / bz：x / z 方向的那一份没挪成
 */
function slide(grid: Grid, x0: number, z0: number, x1: number, z1: number, gap: number) {
  const ok = (x: number, z: number) => (gap > 0 ? clearAt(grid, x, z, gap) : freeAt(grid, x, z));
  if (ok(x1, z1)) return { x: x1, z: z1, bx: false, bz: false };
  if (x1 !== x0 && ok(x1, z0)) return { x: x1, z: z0, bx: false, bz: true };
  if (z1 !== z0 && ok(x0, z1)) return { x: x0, z: z1, bx: true, bz: false };
  return { x: x0, z: z0, bx: true, bz: true };
}

interface Crowd {
  /** 前面通道里有人时，这一步最多能走多快（跟着走 / 停在他身前）；没人为 Infinity */
  follow: number;
  /** 定下 follow 的那个人 */
  blocker: Npc | null;
  /** 走着时：想要的横向速度（米/秒，向右为正：侧身让路 + 被挤开） */
  side: number;
  /** 站着时：想要的被挤开速度（米/秒，房屋坐标） */
  pushX: number;
  pushZ: number;
}

/**
 * 看看身边的人（用他们这一步开始时的位置 px / pz 和上一步的速度）。(fx, fz) 是自己要走的方向。
 * - 挤开：比 CROWD.comfort 近就往外让，越近越快（走着的人只往旁边让，前后间距交给「跟着走」；逃跑的人挤得更狠、不太让人）
 * - walking 时还有：
 *   跟着走：前面通道（横向偏差 < minDist）里有人，按刹车距离限速，最多走到离他 minDist；他往前走就跟着他的速度
 *   让行：合流、交叉时照现在的速度走下去 CROWD.horizon 秒内会挨上，该让的一方（见 yieldsTo）提前按刹车距离减速
 *   侧身：照现在的速度走下去，CROWD.horizon 秒内最近会比 passDist 近，就往远离他的一侧让（正对面时靠右）
 * 刹车都按 CROWD_BRAKE 算，结果给 walk 当「硬」上限（来不及时可以用 MOTION.hardDecel 急刹）
 */
function senseCrowd(npc: Npc, ctx: NpcCtx, fx: number, fz: number, walking: boolean): Crowd {
  const s = npc.s, x = s.pos.x, z = s.pos.z, min = CROWD.minDist;
  // 右手方向：x 向东、z 向南，朝东时右手边是南
  const rx = -fz, rz = fx;
  const vPlan = Math.max(npc.v, PLAN_SPEED);
  const fleeing = s.mode === 'fleeing';
  let follow = Infinity, blocker: Npc | null = null, avoid = 0, push = 0, pushX = 0, pushZ = 0;
  for (const o of ctx.crowd) {
    if (o === npc || o.s.mode === 'gone') continue;
    const dx = o.px - x, dz = o.pz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > CROWD.sense * CROWD.sense) continue;
    const d = Math.sqrt(d2);
    if (d < CROWD.comfort) {
      let k = clamp01((CROWD.comfort - d) / (CROWD.comfort - min)) * CROWD.pushSpeed;
      if (o.s.mode === 'fleeing') k *= CROWD.fleeShove;
      if (fleeing) k *= CROWD.fleeResist;
      let ux: number, uz: number;
      if (d > 1e-6) {
        ux = -dx / d;
        uz = -dz / d;
      } else {
        const a = s.id * GOLDEN;
        ux = Math.cos(a);
        uz = Math.sin(a);
      }
      pushX += ux * k;
      pushZ += uz * k;
      push += (ux * rx + uz * rz) * k;
    }
    if (!walking) continue;
    const along = dx * fx + dz * fz, lat = dx * rx + dz * rz;
    if (along > 0 && Math.abs(lat) < min) {
      const gap = along - Math.sqrt(min * min - lat * lat) - FOLLOW_MARGIN;
      const lim = Math.max(0, brakeSpeed(gap, CROWD_BRAKE, ctx.dt) + o.vx * fx + o.vz * fz);
      if (lim < follow) {
        follow = lim;
        blocker = o;
      }
    }
    const wx = o.vx - fx * vPlan, wz = o.vz - fz * vPlan;
    // 合流 / 交叉：照现在的速度走下去多久会挨上（比 minDist 近）。该让的一方提前按刹车距离减速，让对方先过
    if (yieldsTo(npc, o, dx, dz, fx, fz)) {
      const tc = contactTime(dx, dz, wx, wz, min);
      if (tc < CROWD.horizon) {
        const lim = brakeSpeed(Math.max(0, vPlan * tc - FOLLOW_MARGIN), CROWD_BRAKE, ctx.dt);
        if (lim < follow) {
          follow = lim;
          blocker = o;
        }
      }
    }
    const w2 = wx * wx + wz * wz;
    const t = w2 > 1e-9 ? clamp(-(dx * wx + dz * wz) / w2, 0, CROWD.horizon) : 0;
    const cx = dx + wx * t, cz = dz + wz * t;
    const m = Math.hypot(cx, cz);
    if (m < CROWD.passDist && along > -min) {
      const c = cx * rx + cz * rz;
      avoid += (c > CROWD.keepRight ? -1 : 1) * ((CROWD.passDist - m) / CROWD.passDist) * (1 - t / CROWD.horizon);
    }
  }
  const p = clampLen(pushX, pushZ, CROWD.pushSpeed);
  const side = clamp(clamp(avoid, -1, 1) * CROWD.sideSpeed + push, -CROWD.sideSpeed, CROWD.sideSpeed);
  return { follow, blocker, side, pushX: p.x, pushZ: p.z };
}

/**
 * 走着的两个人快要挨上时谁让：逃跑的人从不让、别人都让他；对方站着不动时不算（交给「跟着走」和侧身）；
 * 对方在我前面、我不在他前面（我在后面合流）就我让；两人都在对方前面（迎面、正交叉）时 id 大的让。两边算出来正好一方让
 */
function yieldsTo(me: Npc, o: Npc, dx: number, dz: number, fx: number, fz: number): boolean {
  if (me.s.mode === 'fleeing') return false;
  if (o.s.mode === 'fleeing') return true;
  const ov = Math.hypot(o.vx, o.vz);
  if (ov < 0.1) return false;
  const heAhead = dx * fx + dz * fz > 0;
  const meAhead = -(dx * o.vx + dz * o.vz) / ov > 0;
  if (heAhead !== meAhead) return heAhead;
  return heAhead && me.s.id > o.s.id;
}

/** 相对位置 (rx, rz)、相对速度 (wx, wz)：多久以后距离会小于 min；已经挨着返回 0，在分开 / 不会挨上返回 Infinity */
function contactTime(rx: number, rz: number, wx: number, wz: number, min: number): number {
  const b = rx * wx + rz * wz;
  if (b >= 0) return Infinity;
  const c = rx * rx + rz * rz - min * min;
  if (c <= 0) return 0;
  const a = wx * wx + wz * wz;
  const disc = b * b - a * c;
  return disc < 0 ? Infinity : (-b - Math.sqrt(disc)) / a;
}

/**
 * 被挡住没有进展（walk 返回 'stuck'）：
 * 1. 离终点不到 CROWD.closeEnough（别人正站在自己要去的地方）：就当作到了（逃跑的人除外）
 * 2. 否则把挡路的人身边的格子当作走不通，重新寻路绕过去
 * 3. 绕不开：闲逛的换个地方去，警觉的就地查看；进门、逃跑的接着等（逃跑的人会把挡路的人挤开）
 */
function unstick(npc: Npc, ctx: NpcCtx): void {
  const s = npc.s;
  npc.stuckT = 0;
  npc.stuckL = Infinity;
  if (s.mode !== 'fleeing' && remaining(s.pos.x, s.pos.z, s.path) <= CROWD.closeEnough) {
    s.path = [];
    if (s.mode === 'wander') lookAround(npc, ctx);
    else if (s.mode === 'alert') startInvestigate(npc);
    else if (s.mode === 'entering') beginWander(npc, ctx);
    return;
  }
  if (replan(npc, ctx)) return;
  if (s.mode === 'wander') beginWander(npc, ctx);
  else if (s.mode === 'alert') startInvestigate(npc);
}

/** 绕开身边的人重新寻路到原来的终点（逃跑：先到前门两格中间再出门）。在门外那一段、或者绕不开时返回 false */
function replan(npc: Npc, ctx: NpcCtx): boolean {
  const s = npc.s;
  if (s.path.length === 0) return false;
  const [ci, cj] = cellOf(s.pos.x, s.pos.z);
  if (!inGrid(ci, cj)) return false;
  const fleeing = s.mode === 'fleeing';
  const goal = fleeing ? DOOR_POINT : s.path[s.path.length - 1];
  const tiles = ctx.nav.grid.tiles.slice();
  for (const o of ctx.crowd) {
    if (o === npc || o.s.mode === 'gone') continue;
    const ox = o.s.pos.x, oz = o.s.pos.z;
    if (Math.hypot(ox - s.pos.x, oz - s.pos.z) > CROWD.sense) continue;
    const [oi, oj] = cellOf(ox, oz);
    for (let j = oj - 2; j <= oj + 2; j++) {
      for (let i = oi - 2; i <= oi + 2; i++) {
        if (!inGrid(i, j) || (i === ci && j === cj)) continue;
        const c = cellCenter(i, j);
        if (Math.hypot(c.x - ox, c.z - oz) <= REPLAN_BLOCK && tiles[idx(i, j)] === Tile.Floor) tiles[idx(i, j)] = Tile.Furniture;
      }
    }
  }
  const path = findPath(new Grid(tiles), s.pos, goal);
  if (!path || path.length === 0) return false;
  if (fleeing) path.push({ x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z });
  setPath(npc, path);
  return true;
}

/** 推开时各自的份量：吓呆的人不动，逃跑的人少挪（他在往外冲，别人给他让） */
const shoveWeight = (n: Npc) => (isFrozen(n) ? 0 : n.s.mode === 'fleeing' ? CROWD.fleeResist : 1);

/**
 * 兜底（world.ts 在所有人走完这一步之后调）：还有两人比 CROWD.minDist 近（避让来不及：同一点生成、几个人挤在门口），
 * 直接推开，各自按份量分，推不动（贴墙、吓呆了）的那份由另一个人补。推开不会让人比这一步本来走得更快
 * （最多 max(本来的速度, CROWD.pushSpeed)），所以 speed 不会因为兜底突然跳高。
 * 最后按这一步实际挪动的距离写 speed（speed 永远是真的）和速度（别人下一步预判用）
 */
export function separate(npcs: readonly Npc[], grid: Grid, dt: number): void {
  const min = CROWD.minDist;
  const before = npcs.map((n) => Math.hypot(n.s.pos.x - n.px, n.s.pos.z - n.pz));
  const limit = before.map((m) => Math.max(m, CROWD.pushSpeed * dt));
  /** 把 k 号沿 (nx, nz) 推 amount 米（受 limit 和墙限制），返回沿这个方向实际推了多少 */
  const shove = (k: number, nx: number, nz: number, amount: number): number => {
    const n = npcs[k], s = n.s;
    if (amount <= 0 || shoveWeight(n) === 0) return 0;
    let tx = s.pos.x + nx * amount - n.px, tz = s.pos.z + nz * amount - n.pz;
    const len = Math.hypot(tx, tz);
    if (len > limit[k]) {
      tx *= limit[k] / len;
      tz *= limit[k] / len;
    }
    const sl = slide(grid, s.pos.x, s.pos.z, n.px + tx, n.pz + tz, 0);
    const moved = (sl.x - s.pos.x) * nx + (sl.z - s.pos.z) * nz;
    if (moved <= 0) return 0;
    s.pos.x = sl.x;
    s.pos.z = sl.z;
    return moved;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let a = 0; a < npcs.length; a++) {
      for (let b = a + 1; b < npcs.length; b++) {
        const A = npcs[a].s, B = npcs[b].s;
        if (A.mode === 'gone' || B.mode === 'gone') continue;
        let nx = A.pos.x - B.pos.x, nz = A.pos.z - B.pos.z;
        const d = Math.hypot(nx, nz);
        if (d >= min - 1e-9) continue;
        if (d > 1e-9) {
          nx /= d;
          nz /= d;
        } else {
          const t = A.id * GOLDEN;
          nx = Math.cos(t);
          nz = Math.sin(t);
        }
        const wa = shoveWeight(npcs[a]), wb = shoveWeight(npcs[b]);
        if (wa + wb <= 0) continue;
        const over = min - d;
        const ma = shove(a, nx, nz, (over * wa) / (wa + wb));
        const mb = shove(b, -nx, -nz, over - ma);
        if (ma + mb < over - 1e-9) shove(a, nx, nz, over - ma - mb);
      }
    }
  }
  for (let k = 0; k < npcs.length; k++) {
    const n = npcs[k];
    if (n.s.mode === 'gone') continue;
    n.vx = (n.s.pos.x - n.px) / dt;
    n.vz = (n.s.pos.z - n.pz) / dt;
    const speed = Math.hypot(n.vx, n.vz);
    // 被拽回来、这一步比本来走得慢：内部的速度也跟着降，下一步不会又一下子弹回原来的速度
    const planned = before[k] / dt;
    if (speed < planned - 1e-9) {
      const r = speed / planned;
      n.v *= r;
      n.side *= r;
      n.ax *= r;
      n.az *= r;
    }
    n.s.speed = speed;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v: number) => clamp(v, 0, 1);
/** 从 v 朝 target 走，最多走 max */
const approach = (v: number, target: number, max: number) => v + clamp(target - v, -max, max);

function clampLen(x: number, z: number, max: number): Vec2 {
  const l = Math.hypot(x, z);
  return l > max ? { x: (x / l) * max, z: (z / l) * max } : { x, z };
}
