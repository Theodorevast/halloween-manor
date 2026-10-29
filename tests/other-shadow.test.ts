// 墙上多一个影子（The Other One，src/view/otherShadow.ts）：
// - 手电照到那个人形的几何（光锥、照程、中间隔墙、光锥边上放宽的余量）
// - 出现的规则（createOtherDirector，纯逻辑）：时间、次数、没被照着才放、被照过就撤、访客走近就撤、
//   玩家的鬼魂被照着时不放、玩家看不见时不放
// - 站位（OTHER_SPOTS）：在能走的地板上、贴墙 0.3–0.6 米、不在访客走的路上
// - 画面上那份网格（createOtherShadow）：一开场就在场景里、只进手电阴影图、平时整个丢掉；有人的手电扫过时出现、回调登记簿
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  CELL, DOORWAYS, FRONT_DOOR, FURNITURE, PROPS, WALL_T, blocksSight, buildTiles, cellCenter, cellOf, idx, inGrid, propCenter, roomAt, walkable,
  type Tile,
} from '../src/config/house';
import { OTHER_SHADOW } from '../src/config/night';
import type { RenderCore } from '../src/engine/types';
import { idleManifest } from '../src/sim/manifest';
import type { ManifestState, NpcState, Vec2, WorldState } from '../src/sim/types';
import { TORCH } from '../src/view/flashlight';
import {
  OTHER_LOOK, OTHER_SPOTS, createOtherDirector, createOtherShadow, lightOnSpot, torchOnFigure,
  type OtherEvent, type OtherFrame, type OtherSpot,
} from '../src/view/otherShadow';
import { GHOST_SHADOW_LAYER, torches, type TorchSample } from '../src/view/torches';

const DT = 1 / 60;
const spot = (id: string): OtherSpot => {
  const s = OTHER_SPOTS.find((x) => x.id === id);
  if (!s) throw new Error(`没有站位 ${id}`);
  return s;
};
/** 走廊西头（走廊里一眼望到底的那面墙）：大部分规则都在这里测 */
const WEST = spot('hall-west');
const EAST = spot('hall-east');
/** 规则开始生效以后的某个时刻 */
const LATE = OTHER_SHADOW.after + 5;

/** 一支手电：在 (x, z)、离地 0.6 米（和访客手里的一样高），照向 (tx, tz) 处人形的胸口（离地 1.1 米）。光锥、照程和外圈那盏灯一样 */
function torch(x: number, z: number, tx: number, tz: number, power = 1): TorchSample {
  const y = 0.6, dx = tx - x, dy = 1.1 - y, dz = tz - z, l = Math.hypot(dx, dy, dz);
  return { x, y, z, dx: dx / l, dy: dy / l, dz: dz / l, angle: TORCH.halo.angle, range: TORCH.distance, power };
}
/** 同一个位置照向反方向：人在附近、看得见那里，光锥碰不到它（快要扫过去的样子） */
const away = (x: number, z: number, tx: number, tz: number) => torch(x, z, 2 * x - tx, 2 * z - tz);
/** 光轴绕竖直轴转开 deg 度（从照向 (tx, tz) 的方向） */
function turned(x: number, z: number, tx: number, tz: number, deg: number): TorchSample {
  const a = Math.atan2(tz - z, tx - x) + (deg * Math.PI) / 180, d = Math.hypot(tx - x, tz - z);
  return torch(x, z, x + Math.cos(a) * d, z + Math.sin(a) * d);
}

/** 走廊里一个人：站在离西头人形 4.2 米处（走廊正中），手电照向 / 背对西头 */
const HALL = { x: 5, z: 6 };
const facing = (s: OtherSpot = WEST) => torch(HALL.x, HALL.z, s.x, s.z);
const facingAway = (s: OtherSpot = WEST) => away(HALL.x, HALL.z, s.x, s.z);

const frame = (p: Partial<OtherFrame> = {}): OtherFrame => ({
  time: LATE, scaredOff: 0, dt: DT, torches: [], visitors: [], ghost: null, ghostLit: false, ...p,
});

type Director = ReturnType<typeof createOtherDirector>;
/** 推 seconds 秒（每步 DT，模拟时间从 t0 起一起走），每步的输入由 f(这一段过了多久) 给；返回事件和发生的时刻（离 t0） */
function run(d: Director, seconds: number, f: (t: number) => Partial<OtherFrame>, t0 = LATE) {
  const out: { at: number; e: OtherEvent }[] = [];
  const steps = Math.round(seconds / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT;
    for (const e of d.step(frame({ time: t0 + t, ...f(t) }))) out.push({ at: t, e });
  }
  return out;
}
const types = (evs: { e: OtherEvent }[]) => evs.map((x) => x.e.type);
/** 推到出现 type 这种事件为止（最多 seconds 秒）：返回期间的事件、停在第几秒（离 t0） */
function until(d: Director, seconds: number, f: (t: number) => Partial<OtherFrame>, t0: number, type: OtherEvent['type']) {
  const evs: { at: number; e: OtherEvent }[] = [];
  const steps = Math.round(seconds / DT);
  for (let k = 1; k <= steps; k++) {
    const t = k * DT;
    const got = d.step(frame({ time: t0 + t, ...f(t) }));
    for (const e of got) evs.push({ at: t, e });
    if (got.some((e) => e.type === type)) return { evs, t };
  }
  return { evs, t: seconds };
}
/** 只在西头这一个站位上测的导演（别的站位不来凑热闹） */
const westOnly = () => createOtherDirector([WEST]);
/** 西头放上去：人在走廊里背对着它，推一小会儿 */
function placed(d: Director = westOnly(), t0 = LATE) {
  const evs = run(d, 0.5, () => ({ torches: [facingAway()], visitors: [HALL] }), t0);
  expect(types(evs)).toEqual(['place']);
  expect(d.spot?.id).toBe(WEST.id);
  return d;
}

describe('手电照到人形（torchOnFigure / lightOnSpot）', () => {
  it('正对着照：碰到，而且照得清楚；转开 90 度：碰不到', () => {
    const on = torchOnFigure(facing(), WEST.x, WEST.z);
    expect(on.touch).toBe(true);
    expect(on.amount).toBeGreaterThan(OTHER_LOOK.litMin);
    const off = torchOnFigure(turned(HALL.x, HALL.z, WEST.x, WEST.z, 90), WEST.x, WEST.z);
    expect(off.touch).toBe(false);
    expect(off.amount).toBe(0);
  });

  it('没点亮（power = 0）、照程以外都碰不到', () => {
    expect(torchOnFigure({ ...facing(), power: 0 }, WEST.x, WEST.z).touch).toBe(false);
    const far = torch(WEST.x + TORCH.distance + 1, WEST.z, WEST.x, WEST.z);
    expect(torchOnFigure(far, WEST.x, WEST.z).touch).toBe(false);
  });

  it('光锥边上放宽了 pad：光轴刚偏出光锥一点也算碰到（这时候不放、不撤），偏得够多才算没碰到', () => {
    // 人形的角半径（按最宽的地方、到胸口的距离）+ 光锥半角：偏这么多，光锥的边正好擦着人形
    const d = Math.hypot(WEST.x - HALL.x, WEST.z - HALL.z);
    const edge = ((TORCH.halo.angle + Math.asin(0.27 / d)) * 180) / Math.PI;
    const pad = (OTHER_LOOK.pad * 180) / Math.PI;
    expect(torchOnFigure(turned(HALL.x, HALL.z, WEST.x, WEST.z, edge + pad / 2), WEST.x, WEST.z).touch).toBe(true);
    expect(torchOnFigure(turned(HALL.x, HALL.z, WEST.x, WEST.z, edge + pad + 3), WEST.x, WEST.z).touch).toBe(false);
  });

  it('越靠光锥边越暗：偏到光锥边上时照到的程度低于「照得清楚」的门槛', () => {
    const edge = (TORCH.halo.angle * 180) / Math.PI;
    expect(torchOnFigure(turned(HALL.x, HALL.z, WEST.x, WEST.z, edge - 3), WEST.x, WEST.z).amount).toBeLessThan(OTHER_LOOK.litMin);
  });

  it('中间隔着墙不算（卧室里往北照向走廊西头）', () => {
    const t = torch(1.0, 9.5, WEST.x, WEST.z);
    expect(torchOnFigure(t, WEST.x, WEST.z).touch).toBe(true); // 只看光锥是碰到的
    expect(lightOnSpot(WEST, [t])).toEqual({ touch: false, lit: 0 });
    expect(lightOnSpot(WEST, [facing()]).touch).toBe(true);
  });
});

describe('出现的规则（createOtherDirector）', () => {
  it(`时间：不到 OTHER_SHADOW.after（${OTHER_SHADOW.after} 秒）、吓跑不到 afterScared（${OTHER_SHADOW.afterScared} 个）时不放；到了时间才放`, () => {
    const d = westOnly();
    // after 之前 3 秒（吓跑的人数差一个）：不放
    expect(run(d, 3, () => ({ torches: [facingAway()], visitors: [HALL], scaredOff: OTHER_SHADOW.afterScared - 1 }), OTHER_SHADOW.after - 4)).toEqual([]);
    const later = run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL] }), OTHER_SHADOW.after);
    expect(types(later)).toEqual(['place']);
  });

  it('吓跑够了 afterScared 个，不到时间也放', () => {
    const d = westOnly();
    const evs = run(d, 0.5, () => ({ torches: [facingAway()], visitors: [HALL], scaredOff: OTHER_SHADOW.afterScared }), 10);
    expect(types(evs)).toEqual(['place']);
  });

  it('只在没被照着的时候放：手电照着那个位置时不放，转开以后才放', () => {
    const d = westOnly();
    expect(run(d, 2, () => ({ torches: [facing()], visitors: [HALL] }))).toEqual([]);
    // 刚偏出光锥、还在放宽的余量里：照样不放
    const edge = ((TORCH.halo.angle + Math.asin(0.27 / 4.2)) * 180) / Math.PI + (OTHER_LOOK.pad * 180) / Math.PI / 2;
    expect(run(d, 2, () => ({ torches: [turned(HALL.x, HALL.z, WEST.x, WEST.z, edge)], visitors: [HALL] }))).toEqual([]);
    expect(types(run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL] })))).toEqual(['place']);
  });

  it('附近没有拿着手电、看得见那里的人（没人会扫过去）时不放', () => {
    const d = westOnly();
    // 人在卧室（隔着墙）；人在走廊另一头（OTHER_LOOK.promise 米以外）
    expect(run(d, 2, () => ({ torches: [away(2.5, 9.5, WEST.x, WEST.z)], visitors: [{ x: 2.5, z: 9.5 }] }))).toEqual([]);
    const far = { x: WEST.x + OTHER_LOOK.promise + 1, z: 6 };
    expect(run(d, 2, () => ({ torches: [away(far.x, far.z, WEST.x, WEST.z)], visitors: [far] }))).toEqual([]);
  });

  it('被照到算出现一次（appeared + 1，同一次只算一次）；照满 litFor 秒以后，照着的时候不撤，一转开就撤', () => {
    const d = placed();
    expect(d.appeared).toBe(0);
    // 照 litFor 再多 1 秒：中间一直在，appear 只有一个
    const lit = run(d, OTHER_SHADOW.litFor + 1, () => ({ torches: [facing()], visitors: [HALL] }));
    expect(types(lit)).toEqual(['appear']);
    expect(lit[0].at).toBeLessThan(0.05);
    expect(d.appeared).toBe(1);
    expect(d.spot?.id).toBe(WEST.id);
    // 光锥转开：下一帧就撤
    const off = run(d, 0.2, () => ({ torches: [facingAway()], visitors: [HALL] }));
    expect(off.map((x) => x.e)).toEqual([{ type: 'withdraw', spot: WEST, why: 'done', seen: true }]);
    expect(off[0].at).toBeLessThan(DT * 1.5);
    expect(d.spot).toBeNull();
    expect(d.appeared).toBe(1);
  });

  it('照得不够 litFor 秒、光锥转开了：还在（下一次扫过来还看得见），累计够了再撤', () => {
    const d = placed();
    const half = OTHER_SHADOW.litFor * 0.6;
    expect(types(run(d, half, () => ({ torches: [facing()], visitors: [HALL] })))).toEqual(['appear']);
    expect(run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL] }))).toEqual([]);
    expect(d.spot?.id).toBe(WEST.id);
    // 第二次扫过来：累计到 litFor 以后，再转开就撤
    expect(run(d, half, () => ({ torches: [facing()], visitors: [HALL] }))).toEqual([]);
    expect(types(run(d, 0.2, () => ({ torches: [facingAway()], visitors: [HALL] })))).toEqual(['withdraw']);
    expect(d.appeared).toBe(1);
  });

  it(`一晚最多 OTHER_SHADOW.max（${OTHER_SHADOW.max}）次；两次之间至少隔 OTHER_LOOK.gap 秒，下一次先挑没用过的站位`, () => {
    const d = createOtherDirector([WEST, EAST]);
    // 人在走廊正中：两头都在 promise 米以内、看得见；手电照向北墙，两头都碰不到
    const mid = { x: 8, z: 6 };
    const north = (p: Vec2) => torch(p.x, p.z, p.x, p.z - 3);
    let t0 = LATE, lastEnd = -Infinity;
    const used: string[] = [];
    for (let k = 0; k < OTHER_SHADOW.max; k++) {
      // 等到放上去为止（第一次马上放；之后要隔够 gap）
      const w = until(d, OTHER_LOOK.gap + 5, () => ({ torches: [north(mid)], visitors: [mid] }), t0, 'place');
      expect(types(w.evs)).toEqual(['place']);
      if (k === 0) expect(w.t).toBeLessThan(0.5);
      t0 += w.t;
      expect(t0 - lastEnd).toBeGreaterThanOrEqual(OTHER_LOOK.gap - 1e-6);
      const s = d.spot!;
      if (k < 2) expect(used).not.toContain(s.id);
      used.push(s.id);
      // 那个人走到离它 3.2 米处照过去：出现；照够了转向北墙：撤
      const by = { x: s.x + s.nx * 3.2, z: s.z };
      const lit = run(d, OTHER_SHADOW.litFor + 0.2, () => ({ torches: [torch(by.x, by.z, s.x, s.z)], visitors: [by] }), t0);
      t0 += OTHER_SHADOW.litFor + 0.2;
      const off = run(d, 0.1, () => ({ torches: [north(by)], visitors: [by] }), t0);
      expect(types([...lit, ...off])).toEqual(['appear', 'withdraw']);
      lastEnd = t0 + off[0].at;
      t0 += 0.1;
    }
    expect(d.appeared).toBe(OTHER_SHADOW.max);
    // 够了：再等多久都不放
    expect(run(d, OTHER_LOOK.gap * 3, () => ({ torches: [north(mid)], visitors: [mid] }), t0)).toEqual([]);
  });

  it('访客走到 near 米内：没被照着就立刻撤；没被照到过的不算出现', () => {
    const d = placed();
    const close = { x: WEST.x + OTHER_SHADOW.near - 0.1, z: WEST.z };
    const evs = run(d, 0.2, () => ({ torches: [away(close.x, close.z, WEST.x, WEST.z)], visitors: [close] }));
    expect(evs.map((x) => x.e)).toEqual([{ type: 'withdraw', spot: WEST, why: 'near', seen: false }]);
    expect(evs[0].at).toBeLessThan(DT * 1.5);
    expect(d.appeared).toBe(0);
  });

  it('访客走到 near 米内时正被照着：等到没被照着再撤；贴到 OTHER_LOOK.tooClose 以内就不等了', () => {
    const d = placed();
    const close = { x: WEST.x + OTHER_SHADOW.near - 0.1, z: WEST.z };
    // 走近、手电照着它：照着的时候一直在（出现了一次）
    const lit = run(d, 2, () => ({ torches: [torch(close.x, close.z, WEST.x, WEST.z)], visitors: [close] }));
    expect(types(lit)).toEqual(['appear']);
    // 再贴近到 tooClose 以内：照着也撤
    const tight = { x: WEST.x + OTHER_LOOK.tooClose - 0.05, z: WEST.z };
    const evs = run(d, 0.2, () => ({ torches: [torch(tight.x + 0.3, tight.z, WEST.x, WEST.z)], visitors: [tight] }));
    expect(evs.map((x) => x.e)).toEqual([{ type: 'withdraw', spot: WEST, why: 'near', seen: true }]);
    expect(d.appeared).toBe(1);
  });

  it('访客在 OTHER_LOOK.clear 米内时不放', () => {
    const d = westOnly();
    const by = { x: WEST.x + OTHER_LOOK.clear - 0.2, z: WEST.z };
    expect(run(d, 2, () => ({ torches: [away(by.x, by.z, WEST.x, WEST.z)], visitors: [by] }))).toEqual([]);
  });

  it('玩家的鬼魂被照着（或正在现身）时不放，不再被照着以后还要等 ghostCalm 秒', () => {
    const d = westOnly();
    expect(run(d, 2, () => ({ torches: [facingAway()], visitors: [HALL], ghostLit: true }))).toEqual([]);
    const calm = run(d, OTHER_LOOK.ghostCalm + 1, () => ({ torches: [facingAway()], visitors: [HALL] }));
    expect(types(calm)).toEqual(['place']);
    expect(calm[0].at).toBeGreaterThanOrEqual(OTHER_LOOK.ghostCalm - 1e-9);
  });

  it('放着的时候玩家的鬼魂被照到：没出现过的立刻撤（墙上不同时有两个影子）', () => {
    const d = placed();
    const evs = run(d, 0.2, () => ({ torches: [facingAway()], visitors: [HALL], ghostLit: true }));
    expect(evs.map((x) => x.e)).toEqual([{ type: 'withdraw', spot: WEST, why: 'ghost', seen: false }]);
  });

  it('玩家的鬼魂挡在手电和站位之间（离那条线 ghostLine 米以内）时不放：扫过去会先照到鬼魂，两个影子落在同一面墙上', () => {
    const d = westOnly();
    // 鬼魂在走廊里、访客（HALL）和西头之间，离西头比 ghostClear 远（只看「挡在线上」这一条）
    const between = { x: WEST.x + OTHER_LOOK.ghostClear + 0.3, z: WEST.z + OTHER_LOOK.ghostLine * 0.5 };
    expect(between.x).toBeLessThan(HALL.x);
    expect(Math.hypot(between.x - WEST.x, between.z - WEST.z)).toBeGreaterThan(OTHER_LOOK.ghostClear);
    expect(run(d, 2, () => ({ torches: [facingAway()], visitors: [HALL], ghost: between }))).toEqual([]);
    // 鬼魂在访客身后（不在线上）：放
    expect(types(run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL], ghost: { x: HALL.x + 2, z: HALL.z } })))).toEqual(['place']);
  });

  it('同一个站位一晚只用一次（第二次在别处）：另一处没有合适的时机就不放', () => {
    const d = westOnly();
    expect(types(run(d, 0.5, () => ({ torches: [facingAway()], visitors: [HALL] })))).toEqual(['place']);
    expect(types(run(d, OTHER_SHADOW.litFor + 0.2, () => ({ torches: [facing()], visitors: [HALL] }), LATE + 0.5))).toEqual(['appear']);
    expect(types(run(d, 0.1, () => ({ torches: [facingAway()], visitors: [HALL] }), LATE + 2))).toEqual(['withdraw']);
    expect(run(d, OTHER_LOOK.gap * 2, () => ({ torches: [facingAway()], visitors: [HALL] }), LATE + 3)).toEqual([]);
    expect(d.appeared).toBe(1);
  });

  it('玩家的鬼魂离站位 ghostClear 米以内时不放（同一支手电会把两个影子投到同一面墙上）', () => {
    const d = westOnly();
    const ghost = { x: WEST.x + OTHER_LOOK.ghostClear - 0.3, z: WEST.z + 0.3 };
    expect(run(d, 2, () => ({ torches: [facingAway()], visitors: [HALL], ghost }))).toEqual([]);
    expect(types(run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL], ghost: { x: 9, z: 6 } })))).toEqual(['place']);
  });

  it('玩家看不见那面墙时不放；放了还没出现、玩家转开了就撤', () => {
    const d = westOnly();
    expect(run(d, 2, () => ({ torches: [facingAway()], visitors: [HALL], inView: () => false }))).toEqual([]);
    expect(types(run(d, 1, () => ({ torches: [facingAway()], visitors: [HALL], inView: () => true })))).toEqual(['place']);
    const evs = run(d, 0.2, () => ({ torches: [facingAway()], visitors: [HALL], inView: () => false }));
    expect(evs.map((x) => x.e)).toEqual([{ type: 'withdraw', spot: WEST, why: 'view', seen: false }]);
  });

  it('放上去以后 OTHER_LOOK.wait 秒都没人照到：撤掉，过一会儿可以再放', () => {
    const d = placed();
    const evs = run(d, OTHER_LOOK.wait + 0.5, () => ({ torches: [facingAway()], visitors: [HALL] }), LATE + 0.5);
    expect(types(evs)).toEqual(['withdraw']);
    expect((evs[0].e as Extract<OtherEvent, { type: 'withdraw' }>).why).toBe('wait');
    expect(d.appeared).toBe(0);
    const again = run(d, OTHER_LOOK.retry + 1, () => ({ torches: [facingAway()], visitors: [HALL] }), LATE + OTHER_LOOK.wait + 1);
    expect(types(again)).toEqual(['place']);
  });
});

describe('站位（OTHER_SPOTS）', () => {
  const tiles = buildTiles();
  const tileAt = (x: number, z: number) => {
    const [i, j] = cellOf(x, z);
    return inGrid(i, j) ? (tiles[idx(i, j)] as Tile) : null;
  };

  it('简报点名的几处都有：走廊两头、卧室衣柜旁、客厅壁炉边、浴室进门的墙角', () => {
    expect(OTHER_SPOTS.map((s) => s.id).sort()).toEqual(['bath-door', 'bedroom-wardrobe', 'hall-east', 'hall-west', 'living-hearth'].sort());
  });

  it('每个站位站在能走的地板上，人形半径（0.27 米）以内没有墙和家具', () => {
    for (const s of OTHER_SPOTS) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const t = tileAt(s.x + Math.cos(a) * 0.27, s.z + Math.sin(a) * 0.27);
        expect(t !== null && walkable(t), `${s.id} 的 ${k} 方向`).toBe(true);
      }
      expect(walkable(tileAt(s.x, s.z)!), s.id).toBe(true);
    }
  });

  it('背后那面墙的墙面离人形 0.3–0.6 米；法线朝屋里（单位向量）；人形侧对着屋里（手电从屋里照过来，墙上是它的侧影：兜帽往前探、头低着）', () => {
    for (const s of OTHER_SPOTS) {
      expect(Math.hypot(s.nx, s.nz)).toBeCloseTo(1, 9);
      // 沿 −n 往墙那边走，找到第一个挡视线的格子，墙面在它的中心往屋里 WALL_T / 2
      let d = 0;
      while (d < 2 && !blocksSight(tileAt(s.x - s.nx * d, s.z - s.nz * d) as Tile)) d += 0.01;
      const [i, j] = cellOf(s.x - s.nx * d, s.z - s.nz * d);
      const c = cellCenter(i, j);
      const face = (s.x - c.x) * s.nx + (s.z - c.z) * s.nz - WALL_T / 2;
      expect(face, s.id).toBeGreaterThanOrEqual(0.3);
      expect(face, s.id).toBeLessThanOrEqual(0.6);
      // 正对着照只是一团兜帽的轮廓，侧着照才看得出低着头（看样截图对比过）
      expect(Math.abs(Math.cos(s.facing) * s.nx + Math.sin(s.facing) * s.nz), s.id).toBeLessThan(0.3);
    }
  });

  it('不在访客走的路上：离门洞、前门、引诱物件（访客听见声音会走过去查看）都至少 near + 0.3 米', () => {
    const keep = OTHER_SHADOW.near + 0.3;
    // 引诱物件（SCARES 里 kind = 'lure' 的：八音盒、厨房门）；惊吓物件访客只是看见，不会走过去
    const lures = PROPS.filter((p) => p.type === 'musicBox' || p.type === 'door');
    expect(lures.length).toBeGreaterThan(0);
    const points: [string, Vec2][] = [
      ...DOORWAYS.flatMap((d) => d.cells.map(([i, j]) => [`门洞 ${i},${j}`, cellCenter(i, j)] as [string, Vec2])),
      ...FRONT_DOOR.cells.map(([i, j]) => [`前门 ${i},${j}`, cellCenter(i, j)] as [string, Vec2]),
      ...lures.map((p) => [p.id, propCenter(p)] as [string, Vec2]),
    ];
    for (const s of OTHER_SPOTS) {
      for (const [what, p] of points) expect(Math.hypot(p.x - s.x, p.z - s.z), `${s.id} ↔ ${what}`).toBeGreaterThanOrEqual(keep);
    }
  });

  it('站位两两之间隔开 3 米以上，或者在不同的房间（第二次换个地方，才看得出是「它」在走动，不是同一个东西卡在那里）', () => {
    const room = (s: OtherSpot) => roomAt(...cellOf(s.x, s.z));
    for (const a of OTHER_SPOTS) {
      expect(room(a), a.id).not.toBeNull();
      for (const b of OTHER_SPOTS) {
        if (a !== b && room(a) === room(b)) expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} ↔ ${b.id}`).toBeGreaterThan(3);
      }
    }
  });

  it('站位不压在家具上（家具的格子范围外，留出人形半径）', () => {
    for (const s of OTHER_SPOTS) {
      for (const f of FURNITURE) {
        if (!f.blocks) continue;
        const x0 = f.rect.x0 * CELL, x1 = f.rect.x1 * CELL, z0 = f.rect.z0 * CELL, z1 = f.rect.z1 * CELL;
        const dx = Math.max(x0 - s.x, 0, s.x - x1), dz = Math.max(z0 - s.z, 0, s.z - z1);
        expect(Math.hypot(dx, dz), `${s.id} ↔ ${f.id}`).toBeGreaterThanOrEqual(0.27);
      }
    }
  });
});

describe('画面上那份网格（createOtherShadow）', () => {
  const saved = torches.map((t) => ({ ...t }));
  afterEach(() => {
    torches.forEach((t, i) => Object.assign(t, saved[i]));
    vi.unstubAllGlobals();
  });

  const fakeCore = () => {
    const scene = new THREE.Scene();
    const houseRoot = new THREE.Group();
    scene.add(houseRoot);
    return { scene, houseRoot, backend: 'WebGPU', quality: 'high' } as unknown as RenderCore;
  };
  const npc = (p: Vec2): NpcState => ({
    id: 1, name: 'Ada', personality: 'average', pos: { ...p }, heading: 0, lookDir: 0, mode: 'wander', modeTime: 0, fear: 0,
    nervous: false, speed: 0, screaming: 0, path: [],
  });
  const state = (time: number, npcs: NpcState[], manifest: ManifestState = idleManifest()): WorldState => ({
    time, npcs, objects: [], scaredOff: 0, hitStop: 0, manifest, avoid: [],
  });
  const setTorch = (t: TorchSample) => Object.assign(torches[0], t);
  /** 影子的 uniform（uShadow）在材质的 maskShadowNode 里；测试通过网格上挂的 userData.uniforms 读（模块自己挂的，调试也用它） */
  const shadowOf = (m: THREE.Mesh) => (m.userData.uniforms as { shadow: { value: number } }).shadow.value;

  it('一开场就在场景里：只在 GHOST_SHADOW_LAYER 这一层、投影、不剔除、一直可见；影子平时关着（片元全丢）', () => {
    const core = fakeCore();
    createOtherShadow(core);
    const m = core.houseRoot.getObjectByName('other-shadow') as THREE.Mesh;
    expect(m).toBeTruthy();
    expect(m.layers.mask).toBe(1 << GHOST_SHADOW_LAYER);
    expect(m.castShadow).toBe(true);
    expect(m.receiveShadow).toBe(false);
    expect(m.frustumCulled).toBe(false);
    expect(m.visible).toBe(true);
    expect(shadowOf(m)).toBe(0);
    const mat = m.material as THREE.MeshBasicNodeMaterial;
    // 和鬼魂墙上的影子同一个材质（ghost.ts 的 createGhostShadowMaterial）：不写颜色、不写深度，阴影 pass 里按 maskShadowNode 丢片元
    expect(mat.maskShadowNode).toBeTruthy();
    expect(mat.colorWrite).toBe(false);
    expect(mat.depthWrite).toBe(false);
  });

  it('不飘、不跟玩家：自己那组 uniform 是「实」的姿势（uSolid = 1）、头微低、时间定住', () => {
    const core = fakeCore();
    createOtherShadow(core);
    const m = core.houseRoot.getObjectByName('other-shadow') as THREE.Mesh;
    const u = m.userData.uniforms as { solid: { value: number }; step: { value: number }; head: { value: number }; time: { value: number } };
    expect(u.solid.value).toBe(1);
    expect(u.step.value).toBe(1);
    expect(u.head.value).toBeGreaterThan(0);
    expect(u.head.value).toBeLessThan((20 * Math.PI) / 180);
  });

  it('有人的手电扫过：没照着时放上去（uShadow = 1），照到时 onAppear 回调一次、appeared + 1；照够了转开就撤（uShadow = 0）', () => {
    const core = fakeCore();
    const other = createOtherShadow(core);
    const m = core.houseRoot.getObjectByName('other-shadow') as THREE.Mesh;
    let calls = 0;
    other.onAppear(() => calls++);
    let t = LATE;
    const tick = (seconds: number, tt: TorchSample, at: Vec2 = HALL) => {
      setTorch(tt);
      for (let k = 0; k < Math.round(seconds / DT); k++) {
        t += DT;
        other.update!({ dt: DT, time: t, state: state(t, [npc(at)]) });
      }
    };
    tick(0.5, facingAway());
    expect(shadowOf(m)).toBe(1);
    // 放在西头：位置、朝向（面朝屋里），高度和玩家的鬼魂一样
    expect(m.position.x).toBeCloseTo(WEST.x, 9);
    expect(m.position.z).toBeCloseTo(WEST.z, 9);
    expect(m.position.y).toBeCloseTo(OTHER_LOOK.y, 9);
    expect(calls).toBe(0);
    tick(OTHER_SHADOW.litFor + 0.3, facing());
    expect(calls).toBe(1);
    expect(other.appeared).toBe(1);
    expect(shadowOf(m)).toBe(1);
    tick(0.1, facingAway());
    expect(shadowOf(m)).toBe(0);
    expect(other.appeared).toBe(1);
  });

  it('不到时间（OTHER_SHADOW.after）不放', () => {
    const core = fakeCore();
    const other = createOtherShadow(core);
    const m = core.houseRoot.getObjectByName('other-shadow') as THREE.Mesh;
    setTorch(facingAway());
    for (let k = 0; k < 60; k++) other.update!({ dt: DT, time: k * DT, state: state(10 + k * DT, [npc(HALL)]) });
    expect(shadowOf(m)).toBe(0);
  });

  it('玩家正在现身（蓄力、停留）时不放', () => {
    const core = fakeCore();
    const other = createOtherShadow(core);
    const m = core.houseRoot.getObjectByName('other-shadow') as THREE.Mesh;
    setTorch(facingAway());
    const hold: ManifestState = { phase: 'hold', t: 0.5, cooldown: 0, pos: { x: 12, z: 6 } };
    for (let k = 0; k < 60; k++) other.update!({ dt: DT, time: k * DT, state: state(LATE + k * DT, [npc(HALL)], hold) });
    expect(shadowOf(m)).toBe(0);
  });

  it('地址带 ?noother 时不建网格（看样对比、量开销），接口照样能用', () => {
    vi.stubGlobal('location', { search: '?noother' });
    const core = fakeCore();
    const other = createOtherShadow(core);
    expect(core.houseRoot.getObjectByName('other-shadow')).toBeUndefined();
    other.onAppear(() => {});
    other.update?.({ dt: DT, time: 0, state: state(LATE, []) });
    expect(other.appeared).toBe(0);
  });
});
