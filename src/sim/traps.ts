// 机关（2026-10-28，设计文档 4.2；参数见 config/visitors.ts 的 TRAP）：玩家对着物件按住左键设下（World.arm），
// 访客走进范围时挑个时机自动触发（和玩家点一下一样走 triggerObject，恐惧值 × TRAP.fearMult）。按物件分三种：
// - 背后型（摇椅、床）：物件在访客背后 TRAP.behind 米时（太近的先等他走远一点）；蓄势的声音让他察觉、回头（world.ts 发察觉）
// - 迎面型（肖像、镜子、台灯）：访客的手电照到它的那一刻
// - 引诱类（八音盒、厨房门）：有人走进听得见的范围就响
// 等时机：进了范围、还没到最好的时机，最多等 TRAP.wait 秒；照现在的速度眼看要走出范围，就不等了，在离开之前触发。
// 同时最多 TRAP.max 个；设下 TRAP.expire 秒还没触发就自动解除（trap expired）。纯 TypeScript
import { TRAP, VISION } from '../config/visitors';
import { angleDiff, angleOf } from '../lib/angle';
import type { Grid } from './grid';
import { canBeScared } from './npc';
import type { Npc } from './npc';
import { canHear, canSee } from './perception';
import { facesToward } from './scares';
import type { ScareObject } from './scares';
import type { NpcState, ScareType, SimEvent, Vec2 } from './types';

/** 背后型的物件 */
const BEHIND: ReadonlySet<ScareType> = new Set<ScareType>(['rockingChair', 'bed', 'wardrobe']);
export type TrapKind = 'behind' | 'facing' | 'lure';
export const trapKind = (o: ScareObject): TrapKind => (o.spec.kind === 'lure' ? 'lure' : BEHIND.has(o.state.type) ? 'behind' : 'facing');

/** 预判离开范围：照现在的速度再走这么多秒（身体朝走的方向）还在不在范围里 */
const LEAVE_AHEAD = 0.25;
/** 走得比这慢（米/秒）就当站着：预判时身体朝向不变 */
const MOVING = 0.1;
/** 倒计时、等待的容差（同 scares.ts）：1/60 累加会差一点点 */
const EPS = 1e-9;

/** 设下。冷却中、已经设下、同时设下的已满（armedCount ≥ TRAP.max）时返回 false */
export function armTrap(o: ScareObject, armedCount: number): boolean {
  if (o.state.cooldown > 0 || o.state.armed > 0 || armedCount >= TRAP.max) return false;
  o.state.armed = TRAP.expire;
  o.trapWait = null;
  return true;
}

/** 判断用的一个人：位置、身体朝向、手电朝向（预判时是「再走一会儿」以后的样子） */
type Viewer = Pick<NpcState, 'pos' | 'heading' | 'lookDir'>;

/** 这个人在不在这个机关的范围里 */
function inRange(o: ScareObject, kind: TrapKind, v: Viewer, grid: Grid): boolean {
  const at = o.state.pos, d = Math.hypot(at.x - v.pos.x, at.z - v.pos.z);
  switch (kind) {
    case 'lure':
      return canHear(grid, v.pos, at, o.spec.range);
    case 'facing':
      return d <= Math.min(o.spec.range, VISION.range) && facesToward(o.state, v.pos) && grid.lineOfSight(v.pos, at);
    case 'behind':
      return (
        d <= TRAP.behind[1] &&
        d > 1e-6 &&
        angleDiff(angleOf(at.x - v.pos.x, at.z - v.pos.z), v.heading) > Math.PI / 2 &&
        grid.lineOfSight(v.pos, at)
      );
  }
}

/** 在范围里，而且正是最好的时机：引诱类一进来就是；迎面型是手电照到它；背后型是离得够远（≥ TRAP.behind[0]，回头才看得全） */
function bestNow(o: ScareObject, kind: TrapKind, v: Viewer, grid: Grid): boolean {
  const at = o.state.pos;
  switch (kind) {
    case 'lure':
      return true;
    case 'facing':
      return canSee(grid, v, at, Math.min(o.spec.range, VISION.range));
    case 'behind':
      return Math.hypot(at.x - v.pos.x, at.z - v.pos.z) >= TRAP.behind[0];
  }
}

/** 照现在的速度再走 LEAVE_AHEAD 秒（走着的人身体朝走的方向）以后的样子 */
function ahead(n: Npc): Viewer {
  const s = n.s, v = Math.hypot(n.vx, n.vz);
  return {
    pos: { x: s.pos.x + n.vx * LEAVE_AHEAD, z: s.pos.z + n.vz * LEAVE_AHEAD },
    heading: v > MOVING ? angleOf(n.vx, n.vz) : s.heading,
    lookDir: s.lookDir,
  };
}

/**
 * 每步（world.ts 在结算引诱、惊吓之前调）：设下的机关倒计时，到期发 trap expired；
 * 有人在范围里就按「等时机」决定这一步要不要触发，要就调 fire（world.ts：走 triggerObject、发事件、让背后型附近的人察觉）。
 * 正在等的那个人逃跑了、离开了，就不等了（下一个进来的人重新算）
 */
export function tickTraps(
  objects: readonly ScareObject[],
  npcs: readonly Npc[],
  grid: Grid,
  now: number,
  dt: number,
  fire: (o: ScareObject) => void,
  events: SimEvent[],
): void {
  for (const o of objects) {
    if (o.state.armed <= 0) continue;
    const kind = trapKind(o);
    const here = npcs.filter((n) => canBeScared(n) && inRange(o, kind, n.s, grid));
    let go = here.some((n) => bestNow(o, kind, n.s, grid));
    if (!go && here.length > 0) {
      o.trapWait ??= { since: now, npc: here[0].s.id };
      go = now - o.trapWait.since >= TRAP.wait - EPS || here.some((n) => !inRange(o, kind, ahead(n), grid));
    } else if (!go && o.trapWait) {
      // 等着的人已经出了范围（预判没赶上，比如一下子转过身）：只要他还在屋里，照样触发
      const id = o.trapWait.npc;
      go = npcs.some((n) => n.s.id === id && canBeScared(n));
      if (!go) o.trapWait = null;
    }
    if (go) {
      o.trapWait = null;
      fire(o);
      continue;
    }
    const left = o.state.armed - dt;
    if (left > EPS) {
      o.state.armed = left;
      continue;
    }
    o.state.armed = 0;
    o.trapWait = null;
    events.push({ type: 'trap', object: o.state.id, phase: 'expired' });
  }
}

/** 背后型触发时，谁会被蓄势的声音惊动（察觉、回头）：听得见（物件的距离、隔墙打折），此刻还没看着它的人 */
export function startledByWindup(o: ScareObject, n: Npc, grid: Grid): boolean {
  const at: Vec2 = o.state.pos;
  return canBeScared(n) && canHear(grid, n.s.pos, at, o.spec.range) && !canSee(grid, n.s, at, Math.min(o.spec.range, VISION.range));
}
