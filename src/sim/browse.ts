// 闲逛时被画像、镜子、挂画吸引（2026-10-30 用户试玩以后，路 GP；playtest.md S2：三个整夜 46 次触发，镜子、画像都是 0 次，六幅挂画基本只是背景）：
// 这里只管「有哪几处、站在哪看、这一次挑哪一处」；走过去、停下、盯着看在 npc.ts（beginWander、startGaze）。
// 只有 WorldOptions.browse 给了才有（正式游戏，config/visitors.ts 的 nightWorld）；不给时 npc.ts 连随机数都不多抽。
// 挑哪一处：全屋被看得最少的（(次数 + 0.5) / 权重：画像、镜子权重高，一夜开头先轮到它们），一样少就挑最久没人看的，
// 刚被看过的、正有人奔着去的不挑，所以一夜下来每处都有人看。只有真的走到、看了才算次数：半路被叫走的下一个人接着去
import { CELL, PAINTINGS, ROOMS } from '../config/house';
import { SCARES } from '../config/scares';
import { BROWSE, VISION } from '../config/visitors';
import type { Grid } from './grid';
import type { Rng } from './rng';
import { facesToward } from './scares';
import type { ScareObjectState, Vec2, WorldOptions } from './types';

export interface BrowseSpot {
  /** 物件 id 或挂画 id（NpcState.gazing 就是它） */
  id: string;
  /** 看的目标点：手电对着这里。挂画的画在墙上，这里取墙根前面一点（墙格挡视线，不能当视线的终点） */
  pos: Vec2;
  /** 站着看的地方：正面 BROWSE.dist 米、能走、看得见它 */
  stands: Vec2[];
  /** 权重：高的被看得多（BROWSE.weight，挂画是 1） */
  weight: number;
  /** 被停下来看过几次；最近一次是什么时候；有人奔着它去的话，到什么时候之前别人不挑 */
  seen: number;
  lastAt: number;
  claimUntil: number;
}

export interface Browse {
  spots: BrowseSpot[];
  /** 这一次闲逛走去看的机会（WorldOptions.browse） */
  chance: number;
  /** 看多久（秒） */
  hold: [number, number];
  /** 最近被看的那一处 */
  last: BrowseSpot | null;
}

/** 挂画的目标点离墙根多远（米） */
const INSET = 0.05;
/** 站的地方离家具、墙至少这么远（米） */
const CLEAR = 0.2;
/** 摆站的地方时的步长（米） */
const STAND_STEP = 0.25;

/** 站的地方：目标点沿正面（nx, nz）dist 米、左右偏 BROWSE.side 米以内 */
function standsFor(grid: Grid, pos: Vec2, nx: number, nz: number, maxDist: number, ok: (p: Vec2) => boolean): Vec2[] {
  const out: Vec2[] = [];
  const [d0, d1] = BROWSE.dist;
  const clear = (p: Vec2) =>
    [[0, 0], [CLEAR, 0], [-CLEAR, 0], [0, CLEAR], [0, -CLEAR]].every(([dx, dz]) => grid.walkableAt({ x: p.x + dx, z: p.z + dz }));
  for (let d = d0; d <= d1 + 1e-9; d += STAND_STEP) {
    for (let s = -BROWSE.side; s <= BROWSE.side + 1e-9; s += STAND_STEP) {
      const p = { x: pos.x + nx * d - nz * s, z: pos.z + nz * d + nx * s };
      const r = Math.hypot(d, s);
      if (r > Math.min(d1, maxDist) + 1e-9 || !clear(p) || !grid.lineOfSight(p, pos) || !ok(p)) continue;
      out.push(p);
    }
  }
  return out;
}

export function createBrowse(grid: Grid, objects: readonly ScareObjectState[], opts: NonNullable<WorldOptions['browse']>): Browse {
  const spots: BrowseSpot[] = [];
  const add = (id: string, pos: Vec2, weight: number, stands: Vec2[]) => spots.push({ id, pos, stands, weight, seen: 0, lastAt: -Infinity, claimUntil: -Infinity });
  for (const o of objects) {
    if (o.type !== 'portrait' && o.type !== 'mirror') continue;
    // 站的地方要真的吓得到（和 seenBy 同一条规则）：留一点余量，走到时差 BEHAVIOR.arrive 也还在范围里
    const range = Math.min(SCARES[o.type].range, VISION.range) - CLEAR;
    add(o.id, o.pos, BROWSE.weight[o.type], standsFor(grid, o.pos, Math.cos(o.facing), Math.sin(o.facing), range, (p) => facesToward(o, p)));
  }
  for (const p of PAINTINGS) {
    const r = ROOMS[p.room];
    const nx = Math.round(Math.cos(p.facing)), nz = Math.round(Math.sin(p.facing));
    // 朝西的画挂在房间的东墙，朝南的挂在北墙（PaintingPlacement.facing）；along 是沿墙的米坐标
    const pos = {
      x: nz !== 0 ? p.along : nx < 0 ? r.x1 * CELL - INSET : r.x0 * CELL + INSET,
      z: nx !== 0 ? p.along : nz < 0 ? r.z1 * CELL - INSET : r.z0 * CELL + INSET,
    };
    add(p.id, pos, 1, standsFor(grid, pos, nx, nz, BROWSE.dist[1], () => true));
  }
  return { spots: spots.filter((s) => s.stands.length > 0), chance: opts.chance, hold: opts.hold, last: null };
}

/** 这一次去看哪一处（见文件开头）；都不能挑时 null。只抽一次随机数（一样少、一样久的里面挑一个） */
export function pickSpot(b: Browse, rng: Rng, now: number): BrowseSpot | null {
  const free = b.spots.filter((s) => s !== b.last && s.claimUntil <= now);
  if (free.length === 0) return null;
  const key = (s: BrowseSpot) => (s.seen + 0.5) / s.weight;
  const least = Math.min(...free.map(key));
  const few = free.filter((s) => key(s) <= least + 1e-9);
  const oldest = Math.min(...few.map((s) => s.lastAt));
  return rng.pick(few.filter((s) => s.lastAt <= oldest));
}
