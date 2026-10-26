// 访客状态机：进门 → 闲逛 ⇄ 警觉，被吓 → 受惊（僵住后恢复原状态），恐惧值满 → 逃跑 → 离开。
// 对外的 NpcState 就是这里的 npc.s（同一个对象放进 WorldState.npcs），内部状态放在 Npc 的其他字段里。
import { cellCenter, cellOf, FRONT_DOOR, inGrid, ROOMS, roomAt } from '../config/house';
import type { RoomId } from '../config/house';
import { BEHAVIOR, FEAR, PERSONALITIES, SPEED } from '../config/visitors';
import { angleOf, wrapAngle } from '../lib/angle';
import type { Grid } from './grid';
import { findPath } from './pathfind';
import type { Rng } from './rng';
import { windingUp } from './scares';
import type { ScareObject } from './scares';
import type { NpcState, Personality, ScareType, SimEvent, Vec2 } from './types';

// 以下几个手电摆动幅度是计划里给的定值（config 里没有），集中放在这里方便调
/** 走路时手电在身体朝向两侧的小幅摆动（弧度），周期用 BEHAVIOR.sweepPeriod */
const WALK_SWEEP = 0.25;
/** 逃跑时手电在身体朝向两侧乱晃的范围（弧度） */
const FLEE_JITTER = 0.9;
/** 逃跑时每隔多久换一个乱晃的目标方向（秒）：短到看起来是慌乱地乱照 */
const FLEE_JITTER_HOLD: [number, number] = [0.08, 0.22];
/** 闲逛挑目标时最多试几次寻路，都失败就原地再照一会儿 */
const WANDER_TRIES = 8;

const TAU = Math.PI * 2;
const ROOM_IDS = Object.keys(ROOMS) as RoomId[];

/** 前门两格中间：逃跑时先寻路到这里，再直线走到门外 */
const DOOR_POINT: Vec2 = (() => {
  const cs = FRONT_DOOR.cells.map(([i, j]) => cellCenter(i, j));
  return { x: cs.reduce((s, c) => s + c.x, 0) / cs.length, z: cs.reduce((s, c) => s + c.z, 0) / cs.length };
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
}

/** walk = 沿 s.path 走；look = 原地停留（闲逛到达后左右照 / 警觉到达后查看） */
type Act = 'walk' | 'look';

/** 受惊结束后要恢复的状态 */
interface Resume {
  mode: 'entering' | 'wander' | 'alert';
  act: Act;
  lookLeft: number;
  lookT: number;
  lookBase: number;
  source: Vec2 | null;
}

export interface Npc {
  readonly s: NpcState;
  /** 性格的恐惧倍率 */
  readonly mult: number;
  /** 上次被吓（startle 或 heard）的模拟时间；生成时算一次 */
  lastScare: number;
  /** 被每种物件吓过的「有效次数」和上次被这种物件吓的时间（习惯化，会随时间恢复） */
  readonly habit: Partial<Record<ScareType, { n: number; t: number }>>;
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
  /** 逃跑：当前乱晃的目标偏角和保持时间 */
  jitter: number;
  jitterLeft: number;
  /**
   * 被定住盯着的惊吓物件（它还在蓄势）：停下脚步、身体和手电转向它，路径和各种计时都暂停，
   * 惊吓落下后照常判定、照常恢复。不加恐惧值，NpcState 里只表现为 speed 0
   */
  transfixOn: ScareObject | null;
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
    jitter: 0,
    jitterLeft: 0,
    transfixOn: null,
  };
  if (o.mode === 'entering') {
    const inside = { x: FRONT_DOOR.inside.x, z: FRONT_DOOR.inside.z };
    // 正常从门外进来，直线走进门；调试时放在屋里能走的地方，就寻路过去，不穿墙
    const viaPath = ctx.nav && ctx.nav.grid.walkableAt(o.pos) ? findPath(ctx.nav.grid, o.pos, inside) : null;
    s.path = viaPath ?? [inside];
  }
  else startLook(npc, ctx, o.lookDir); // 站在原地先左右照一照
  return npc;
}

export const canBeScared = (n: Npc) => n.s.mode !== 'fleeing' && n.s.mode !== 'gone';

/**
 * 这个人这次被 type 吓到的量：base × 性格倍率 × habituation^n，n = 之前被这种物件吓过的有效次数。
 * 有效次数每过 FEAR.habituationRecover 秒恢复 1（连续地恢复，可以是小数；0 = 不恢复）。调用一次算一次「被吓过」
 */
export function exposure(npc: Npc, type: ScareType, base: number, now: number): number {
  const h = npc.habit[type];
  const rec = FEAR.habituationRecover;
  const n = h ? (rec > 0 ? Math.max(0, h.n - (now - h.t) / rec) : h.n) : 0;
  npc.habit[type] = { n: n + 1, t: now };
  return base * npc.mult * FEAR.habituation ** n;
}

function addFear(npc: Npc, amount: number, now: number) {
  const s = npc.s;
  s.fear = Math.min(FEAR.max, s.fear + amount);
  s.nervous = s.fear >= FEAR.nervous;
  npc.lastScare = now;
}

/**
 * 被惊吓类物件吓到：僵住 FEAR.startleTime 秒（记住之前的状态），够多就尖叫，涨满就直接逃跑。
 * 受惊中再被吓：重新开始僵住，恢复目标不变。
 */
export function startle(npc: Npc, ctx: NpcCtx, objectId: string, type: ScareType, objPos: Vec2, base: number): void {
  const s = npc.s;
  const amount = exposure(npc, type, base, ctx.now);
  addFear(npc, amount, ctx.now);
  const scream = amount >= FEAR.screamAt;
  ctx.events.push({ type: 'startle', npc: s.id, object: objectId, amount, scream });
  if (scream) {
    s.screaming = FEAR.screamTime;
    ctx.onScream(npc);
  }
  if (s.fear >= FEAR.max) {
    beginFlee(npc, ctx);
    return;
  }
  if (s.mode !== 'startled') npc.resume = snapshot(npc);
  s.mode = 'startled';
  s.modeTime = 0;
  s.speed = 0;
  npc.startleLeft = FEAR.startleTime;
  // 受惊不受转向限速：手电一下子定在吓到它的东西上
  const b = bearing(s.pos, objPos);
  if (b !== null) s.lookDir = b;
}

/**
 * 听到声音（引诱声或别人的尖叫）：恐惧值增加，转入警觉走向声源，不僵住。
 * 受惊中听到：不打断僵住，只把「恢复后做什么」改成去查看这个声源。
 */
export function hear(npc: Npc, ctx: NpcCtx, amount: number, source: Vec2, event: SimEvent): void {
  const s = npc.s;
  addFear(npc, amount, ctx.now);
  ctx.events.push(event);
  if (s.fear >= FEAR.max) {
    beginFlee(npc, ctx);
    return;
  }
  if (s.mode !== 'startled') {
    beginAlert(npc, ctx, source);
    return;
  }
  const keep = { modeTime: s.modeTime, startleLeft: npc.startleLeft, lookDir: s.lookDir };
  beginAlert(npc, ctx, source);
  npc.resume = snapshot(npc);
  s.mode = 'startled';
  s.modeTime = keep.modeTime;
  s.speed = 0;
  s.lookDir = keep.lookDir;
  npc.startleLeft = keep.startleLeft;
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
    s.speed = 0;
    const b = bearing(s.pos, npc.transfixOn.state.pos);
    if (b !== null) {
      const max = BEHAVIOR.turnRate * BEHAVIOR.transfixTurn * dt;
      s.heading = turnToward(s.heading, b, max);
      s.lookDir = turnToward(s.lookDir, b, max);
    }
    return;
  }

  switch (s.mode) {
    case 'startled': {
      s.speed = 0;
      npc.startleLeft -= dt;
      if (npc.startleLeft <= 1e-9) restore(npc, ctx);
      break;
    }
    case 'entering': {
      const arrived = walk(npc, dt, SPEED.enter);
      walkSweep(npc, dt);
      if (arrived) beginWander(npc, ctx);
      break;
    }
    case 'wander': {
      if (npc.act === 'walk') {
        const arrived = walk(npc, dt, s.nervous ? SPEED.nervous : SPEED.wander);
        walkSweep(npc, dt);
        if (arrived) startLook(npc, ctx, s.heading);
      } else {
        s.speed = 0;
        npc.lookT += dt;
        npc.lookLeft -= dt;
        lookToward(npc, dt, npc.lookBase + BEHAVIOR.sweepAmp * Math.sin((TAU * npc.lookT) / BEHAVIOR.sweepPeriod));
        if (npc.lookLeft <= 0) beginWander(npc, ctx);
      }
      break;
    }
    case 'alert': {
      const toSrc = (npc.source && bearing(s.pos, npc.source)) ?? s.lookDir;
      if (npc.act === 'walk') {
        const arrived = walk(npc, dt, SPEED.alert);
        lookToward(npc, dt, toSrc);
        if (arrived) startInvestigate(npc);
      } else {
        s.speed = 0;
        npc.lookT += dt;
        npc.lookLeft -= dt;
        s.heading = turnToward(s.heading, toSrc, BEHAVIOR.turnRate * dt);
        lookToward(npc, dt, toSrc + BEHAVIOR.investigateSweep * Math.sin((TAU * npc.lookT) / BEHAVIOR.sweepPeriod));
        if (npc.lookLeft <= 0) beginWander(npc, ctx);
      }
      break;
    }
    case 'fleeing': {
      const arrived = walk(npc, dt, SPEED.flee);
      npc.jitterLeft -= dt;
      if (npc.jitterLeft <= 0) {
        npc.jitter = ctx.rng.range(-FLEE_JITTER, FLEE_JITTER);
        npc.jitterLeft = ctx.rng.range(FLEE_JITTER_HOLD[0], FLEE_JITTER_HOLD[1]);
      }
      lookToward(npc, dt, s.heading + npc.jitter);
      if (arrived) {
        s.mode = 'gone';
        s.modeTime = 0;
        s.speed = 0;
      }
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
      s.path = path;
      npc.act = 'walk';
      return;
    }
  }
  startLook(npc, ctx, s.heading);
}

/** 闲逛到达后：原地停 BEHAVIOR.lookAround 范围内随机的秒数，手电以 base 为中心左右扫 */
function startLook(npc: Npc, ctx: Pick<NpcCtx, 'rng'>, base: number) {
  const s = npc.s;
  s.mode = 'wander';
  s.path = [];
  s.speed = 0;
  npc.act = 'look';
  npc.lookT = 0;
  npc.lookLeft = ctx.rng.range(BEHAVIOR.lookAround[0], BEHAVIOR.lookAround[1]);
  npc.lookBase = base;
}

/** 警觉：按 alertPath 走过去；已经在查看位置或寻路失败就原地查看 */
function beginAlert(npc: Npc, ctx: NpcCtx, source: Vec2) {
  const s = npc.s;
  s.mode = 'alert';
  s.modeTime = 0;
  npc.source = { x: source.x, z: source.z };
  const path = alertPath(ctx.nav.grid, s.pos, source);
  if (path && path.length > 0) {
    s.path = path;
    npc.act = 'walk';
  } else startInvestigate(npc);
}

/** 查看位置的采样间隔（米） */
const ALERT_SAMPLE = 0.1;

/**
 * 警觉的路线（不含起点）：朝声源旁最近的可走格（一样近时挑自己这一侧的）走，
 * 走到离声源 BEHAVIOR.investigateDist 以内、站在可走格上、看得见声源的第一个点就停。
 * 已经在这样的位置返回空数组；到不了返回 null。机器人测试也用它预测访客会走到哪里
 */
export function alertPath(grid: Grid, from: Vec2, source: Vec2): Vec2[] | null {
  const R2 = BEHAVIOR.investigateDist ** 2;
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
  const s = npc.s;
  s.path = [];
  s.speed = 0;
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
  const [i, j] = cellOf(s.pos.x, s.pos.z);
  const path = inGrid(i, j) ? findPath(ctx.nav.grid, s.pos, DOOR_POINT) ?? [{ ...DOOR_POINT }] : [];
  path.push({ x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z });
  s.path = path;
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
  };
}

/** 受惊结束：恢复之前的状态（路径还在 s.path 里），手电按限速转回去 */
function restore(npc: Npc, ctx: NpcCtx) {
  const r = npc.resume;
  npc.resume = null;
  npc.startleLeft = 0;
  if (!r) {
    beginWander(npc, ctx);
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
}

// ——— 移动与转向 ———

/**
 * 沿路径走一步。身体朝向按限速转向下一个路点；朝向偏得越多走得越慢（偏 90° 以上原地转身），不会倒着滑。
 * 离路点 BEHAVIOR.arrive 以内就算到达、换下一个。返回整条路是否走完。
 */
function walk(npc: Npc, dt: number, speed: number): boolean {
  const s = npc.s, path = s.path;
  if (path.length === 0) {
    s.speed = 0;
    return true;
  }
  const wp = path[0];
  const dx = wp.x - s.pos.x, dz = wp.z - s.pos.z;
  const d = Math.hypot(dx, dz);
  s.speed = 0;
  if (d > 1e-9) {
    const want = angleOf(dx, dz);
    s.heading = turnToward(s.heading, want, BEHAVIOR.turnRate * dt);
    const align = Math.max(0, Math.cos(wrapAngle(want - s.heading)));
    const step = Math.min(d, speed * align * dt);
    s.pos.x += (dx / d) * step;
    s.pos.z += (dz / d) * step;
    s.speed = step / dt;
  }
  if (Math.hypot(wp.x - s.pos.x, wp.z - s.pos.z) <= BEHAVIOR.arrive) path.shift();
  return path.length === 0;
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
