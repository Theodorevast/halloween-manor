// 「这一下会吓到谁」（src/sim/reach.ts 的 reachOf，手感分析 FEEL-1）：名牌上的小眼睛按它亮。
// 它不另立规则，只把结算的规则原样搬过来（world.ts 的引诱结算、惊吓结算的 seenBy、现身的蓄力察觉 + 落下时看得见），
// 所以这里拿真的模拟对照：出手之前 reachOf 说会吓到谁，出手以后模拟真的吓到了谁。
// - 引诱：触发那一步结算，站着的人谁听见和 reachOf 逐人一致
// - 惊吓类：reachOf 就是 seenBy；附身那一刻看着它的人一定被吓到（蓄势期间被定住盯着它）
// - 现身：落下时手电照着那里的人被吓到；蓄力 0.6 秒里会转过来的只有已经紧张（恐惧值 ≥ FEAR.nervous）、
//   MANIFEST.noticeRadius 米内看得见那里的人（2026-10-30 路 GP；原来 5 米内的人不管朝哪、隔不隔墙都转过来）。
//   站着的人左右照手电，光锥边上会有人在这 0.6 秒里照进来或照出去，所以按比例对照（≥ 98%）
import { describe, expect, it } from 'vitest';
import { cellCenter, cellOf, GRID_H, GRID_W, PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { FEAR, GHOST, MANIFEST, TRAITS } from '../src/config/visitors';
import { angleOf } from '../src/lib/angle';
import { Grid } from '../src/sim/grid';
import { reachOf } from '../src/sim/reach';
import { createRng } from '../src/sim/rng';
import { createWorld } from '../src/sim/world';
import type { Personality, SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
const grid = new Grid();
const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
const angleTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const sorted = (a: readonly number[]) => [...a].sort((x, y) => x - y);

/** 推进 seconds 秒（每步先摆鬼魂，和主循环一样），收集事件 */
function drive(w: World, seconds: number, ghost: Vec2 | null): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    w.setGhost(ghost);
    ev.push(...w.step(DT));
  }
  return ev;
}

/** 站着不动的人：在 pos 生成、寻路目标就是原地（到了以后原地左右照手电） */
function stand(w: World, pos: Vec2, lookDir: number, personality: Personality = 'average') {
  return w.spawn({ pos, lookDir, personality, goal: pos });
}

const walkableCells: [number, number][] = [];
for (let j = 0; j < GRID_H; j++) for (let i = 0; i < GRID_W; i++) if (grid.isWalkable(i, j)) walkableCells.push([i, j]);

/** 离 at 不超过 maxD 米、能站人的随机一点（格子里随机偏一点，不总在格心） */
function nearPoint(rng: ReturnType<typeof createRng>, at: Vec2, maxD: number): Vec2 {
  for (;;) {
    const a = rng.range(-Math.PI, Math.PI), d = Math.sqrt(rng.next()) * maxD;
    const p = { x: at.x + Math.cos(a) * d, z: at.z + Math.sin(a) * d };
    const [i, j] = cellOf(p.x, p.z);
    if (grid.isWalkable(i, j)) return p;
  }
}

describe('reachOf：引诱（八音盒、厨房门）', () => {
  it('卧室八音盒：同屋有视线 6 米内的人、隔墙 4.2 米内的人听得见；隔墙 5 米的、屋外的听不见——和触发后的 heard 逐人一致', () => {
    const w = createWorld({ seed: 11, autoSpawn: false });
    const mb = prop('music-box');
    const a = stand(w, { x: 3.5, z: 9.5 }, 0); // 卧室里，有视线
    const b = stand(w, { x: 3.0, z: 6.0 }, 0); // 走廊，隔着卧室北墙，约 3.6 米
    const c = stand(w, { x: 5.8, z: 6.0 }, 0); // 走廊东边，隔墙约 6 米
    drive(w, 0.2, null);
    expect(grid.lineOfSight(a.pos, mb)).toBe(true);
    const reach = reachOf(grid, w.state, { kind: 'object', id: 'music-box' });
    expect(reach).toContain(a.id);
    expect(reach).not.toContain(c.id);
    expect(w.trigger('music-box')).toBe(true);
    const heard = ofType(drive(w, 0.1, null), 'heard').filter((e) => e.object === 'music-box').map((e) => e.npc);
    expect(sorted(reach)).toEqual(sorted(heard));
    expect(b.id).toBeGreaterThan(0);
  });

  it('逃跑中的人（canBeScared 为假）不算：结算也不会让他听见', () => {
    const w = createWorld({ seed: 12, autoSpawn: false });
    const n = stand(w, { x: 3.5, z: 9.5 }, 0);
    drive(w, 0.1, null);
    expect(reachOf(grid, w.state, { kind: 'object', id: 'music-box' })).toEqual([n.id]);
    n.fear = 100; // 下一步状态机兜底让他逃跑
    drive(w, 0.05, null);
    expect(n.mode).toBe('fleeing');
    expect(reachOf(grid, w.state, { kind: 'object', id: 'music-box' })).toEqual([]);
  });

  it('200 个随机站位：引诱的 reachOf 和触发后的 heard 逐人完全一致', () => {
    const rng = createRng(2026);
    let people = 0, agree = 0, heardAny = 0;
    for (let t = 0; t < 200; t++) {
      const w = createWorld({ seed: 500 + t, autoSpawn: false });
      const id = t % 2 === 0 ? 'music-box' : 'kitchen-door';
      const at = prop(id);
      const ns = Array.from({ length: 3 }, () => stand(w, nearPoint(rng, at, 10), rng.range(-Math.PI, Math.PI)));
      drive(w, 0.2, null);
      const reach = new Set(reachOf(grid, w.state, { kind: 'object', id }));
      w.trigger(id);
      const heard = new Set(ofType(drive(w, 0.1, null), 'heard').filter((e) => e.object === id).map((e) => e.npc));
      for (const n of ns) {
        people++;
        if (reach.has(n.id) === heard.has(n.id)) agree++;
        if (heard.has(n.id)) heardAny++;
      }
    }
    expect(heardAny).toBeGreaterThan(100); // 前提：样本里一半左右的人听得见，不是全都够不着
    expect(agree).toBe(people);
  });
});

describe('reachOf：惊吓类（就是 seenBy，同一条规则）', () => {
  it('看着肖像的人在名单上，背对的、在背面的不在；附身以后名单上的人都被吓到', () => {
    const w = createWorld({ seed: 21, autoSpawn: false });
    const pt = prop('portrait');
    const front = { x: pt.x, z: pt.z + 2.5 };
    const watcher = stand(w, front, angleTo(front, pt));
    const away = stand(w, { x: pt.x + 1, z: pt.z + 2.5 }, angleTo(pt, front));
    drive(w, 0.1, null);
    watcher.lookDir = angleTo(watcher.pos, pt);
    drive(w, 1 / 60, null);
    const reach = reachOf(grid, w.state, { kind: 'object', id: 'portrait' });
    expect(reach).toEqual(w.state.objects.find((o) => o.id === 'portrait')!.seenBy);
    expect(reach).toContain(watcher.id);
    expect(reach).not.toContain(away.id);
    w.trigger('portrait');
    const startled = ofType(drive(w, SCARES.portrait.active + 0.1, null), 'startle').filter((e) => e.object === 'portrait').map((e) => e.npc);
    expect(startled).toContain(watcher.id);
  });

  /** 物件 id 附近随机站 3 个人：一半大致朝着物件（偏 ±0.6 弧度，光锥半角 0.52），一半随便朝哪 */
  function crowdNear(w: World, rng: ReturnType<typeof createRng>, id: string) {
    const at = prop(id);
    return Array.from({ length: 3 }, () => {
      const p = nearPoint(rng, at, 6.5);
      return stand(w, p, rng.next() < 0.5 ? angleTo(p, at) + rng.range(-0.6, 0.6) : rng.range(-Math.PI, Math.PI));
    });
  }

  it('200 个随机站位：附身那一刻名单上的人全都被吓到（不说谎）；生效窗口里多出来的只有后来照进来的人', () => {
    const rng = createRng(77);
    const sights = PROPS.filter((p) => SCARES[p.type].kind === 'sight').map((p) => p.id);
    let people = 0, agree = 0, missedPredicted = 0, predicted = 0;
    for (let t = 0; t < 200; t++) {
      const w = createWorld({ seed: 900 + t, autoSpawn: false });
      const id = sights[t % sights.length];
      const ns = crowdNear(w, rng, id);
      drive(w, 0.2, null);
      const reach = new Set(reachOf(grid, w.state, { kind: 'object', id }));
      w.trigger(id);
      const type = PROPS.find((p) => p.id === id)!.type;
      const hit = new Set(ofType(drive(w, SCARES[type].active + 0.1, null), 'startle').filter((e) => e.object === id).map((e) => e.npc));
      for (const n of ns) {
        people++;
        if (reach.has(n.id)) {
          predicted++;
          if (!hit.has(n.id)) missedPredicted++;
        }
        if (reach.has(n.id) === hit.has(n.id)) agree++;
      }
    }
    expect(predicted).toBeGreaterThan(80); // 前提：样本里有足够多的人看着物件
    expect(missedPredicted).toBe(0);
    // 不一致的只有「附身时没看着、窗口里手电扫过来」的人（这里一半的人故意站在光锥边上，比实际对局多得多）
    expect(agree / people).toBeGreaterThanOrEqual(0.95);
  });

  it('台灯（hitAt 0：附身那一步就结算）：那一步被吓到的人和名单逐人完全一致', () => {
    const rng = createRng(78);
    let predicted = 0;
    for (let t = 0; t < 120; t++) {
      const w = createWorld({ seed: 1400 + t, autoSpawn: false });
      const id = t % 2 === 0 ? 'lamp-living' : 'lamp-bedroom';
      crowdNear(w, rng, id);
      drive(w, 0.2, null);
      const reach = reachOf(grid, w.state, { kind: 'object', id });
      predicted += reach.length;
      w.trigger(id);
      const hit = ofType(drive(w, DT, null), 'startle').filter((e) => e.object === id).map((e) => e.npc);
      expect(sorted(hit)).toEqual(sorted(reach));
    }
    expect(predicted).toBeGreaterThan(40);
  });

  it('不存在的物件：空', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    expect(reachOf(grid, w.state, { kind: 'object', id: 'nope' })).toEqual([]);
  });
});

describe('reachOf：现身（蓄力察觉 + 落下时看得见）', () => {
  /** 200 个随机站位里被吓到的人至少这么多（不然对照没有意义） */
  const SCARED_ANY = 100;

  it('手感分析 E 段的摆法（2026-10-30 起的规则）：2 米背对的 Mia 平静时不算（蓄力不再让人转身），已经紧张时算（会转过来）；5.5 米背对的 Hugo、隔墙 4.6 米的 Iris 不算——和落下的 scared 一致', () => {
    for (const fear of [0, FEAR.nervous + 10]) {
      const w = createWorld({ seed: 31, autoSpawn: false });
      const at = { x: 8.0, z: 6.0 };
      const mia = stand(w, { x: 10.0, z: 5.6 }, 0);
      const hugo = stand(w, { x: 13.5, z: 6.4 }, 0);
      const iris = stand(w, { x: 11.8, z: 8.6 }, angleTo({ x: 11.8, z: 8.6 }, at));
      drive(w, 0.1, at);
      mia.fear = fear;
      iris.fear = fear; // 隔着墙：再紧张也看不见那里
      const want = fear > 0 ? [mia.id] : [];
      const reach = reachOf(grid, w.state, { kind: 'manifest', at });
      expect(sorted(reach)).toEqual(want);
      expect(w.manifest()).toBe(true);
      const drop = ofType(drive(w, MANIFEST.windup + 0.1, at), 'manifest').find((e) => e.phase === 'drop')!;
      expect(sorted(drop.scared)).toEqual(want);
      expect(hugo.id).not.toBe(iris.id);
    }
  });

  it('5–6 米之间：本来就对着那里（光锥里、有视线）的人算，背对的不算', () => {
    const w = createWorld({ seed: 32, autoSpawn: false });
    const at = { x: 6.0, z: 6.0 };
    const p1 = { x: 11.6, z: 6.0 }, p2 = { x: 11.6, z: 6.3 };
    const facing = stand(w, p1, angleTo(p1, at));
    const away = stand(w, p2, 0);
    drive(w, 0.05, at);
    facing.lookDir = angleTo(facing.pos, at);
    expect(reachOf(grid, w.state, { kind: 'manifest', at })).toEqual([facing.id]);
    expect(away.id).toBeGreaterThan(0);
  });

  it('鬼魂在墙格里：空（模拟这时不让现身）', () => {
    const w = createWorld({ seed: 33, autoSpawn: false });
    stand(w, { x: 4.0, z: 6.0 }, 0);
    drive(w, 0.05, null);
    const wall = cellCenter(10, 9); // 书房和客厅之间、走廊北墙上的墙格
    expect(grid.isOpaque(...cellOf(wall.x, wall.z))).toBe(true);
    expect(reachOf(grid, w.state, { kind: 'manifest', at: wall })).toEqual([]);
    w.setGhost(wall);
    expect(w.manifest()).toBe(false);
  });

  it('刚被台灯吓到、还僵着的人（startled）蓄力时不会转过来：背对鬼魂就不算，落下时也确实没吓到他', () => {
    const w = createWorld({ seed: 34, autoSpawn: false });
    const lamp = prop('lamp-living');
    const p = { x: 9.0, z: 2.0 }; // 客厅里，看着台灯（东北）
    const at = { x: 7.5, z: 3.5 }; // 他身后（西南）约 2.1 米，同一个房间
    const n = stand(w, p, angleTo(p, lamp));
    drive(w, 0.1, at);
    n.lookDir = angleTo(n.pos, lamp);
    n.fear = FEAR.nervous + 10; // 已经紧张：没僵着的时候蓄力会转过来
    drive(w, DT, at);
    expect(w.state.objects.find((o) => o.id === 'lamp-living')!.seenBy).toEqual([n.id]);
    // 没被吓的时候：已经紧张、noticeRadius 内、有视线，蓄力时会转过来，算
    expect(reachOf(grid, w.state, { kind: 'manifest', at })).toEqual([n.id]);
    w.trigger('lamp-living');
    const ev = drive(w, DT, at);
    expect(ofType(ev, 'startle').map((e) => e.npc)).toEqual([n.id]);
    expect(n.mode).toBe('startled');
    // 僵着（FEAR.startleTime 0.8 秒）、手电定在台灯上：这时现身，他不会转过来
    expect(reachOf(grid, w.state, { kind: 'manifest', at })).toEqual([]);
    expect(w.manifest()).toBe(true);
    const drop = ofType(drive(w, MANIFEST.windup + 0.1, at), 'manifest').find((e) => e.phase === 'drop')!;
    expect(drop.scared).toEqual([]);
  });

  it('天亮往外走的人（leaving）蓄力时不转过来：鬼魂在他背后不算、落下时也确实没吓到；在他前面（光锥里）照样算、照样吓到', () => {
    // 走廊正中 (8, 6) 的人：天亮以后往南穿过门厅的门洞、走向前门（npc.ts 的 beginLeave），边走边照前面
    const setup = (at: Vec2, seed: number) => {
      const w = createWorld({ seed, autoSpawn: false });
      const n = stand(w, { x: 8.0, z: 6.0 }, Math.PI / 2);
      n.fear = FEAR.nervous + 10; // 已经紧张：不往外走的话，背后现身也会转过来
      drive(w, 0.1, at);
      w.dawn();
      drive(w, 0.3, at);
      return { w, n };
    };
    // 背后：客厅里、隔着客厅的门洞有视线，noticeRadius 内——不往外走的紧张的人蓄力时会转过来（会算），他不会
    const behind = { x: 8.0, z: 3.5 };
    const a = setup(behind, 37);
    expect(a.n.mode).toBe('leaving');
    expect(grid.lineOfSight(a.n.pos, behind)).toBe(true);
    expect(Math.hypot(a.n.pos.x - behind.x, a.n.pos.z - behind.z)).toBeLessThan(MANIFEST.noticeRadius);
    expect(reachOf(grid, a.w.state, { kind: 'manifest', at: behind })).toEqual([]);
    expect(a.w.manifest()).toBe(true);
    const dropA = ofType(drive(a.w, MANIFEST.windup + 0.1, behind), 'manifest').find((e) => e.phase === 'drop')!;
    expect(dropA.scared).toEqual([]);
    // 前面：门厅里、他正走过去的方向上（光锥里），落下时看得见
    const ahead = { x: 8.0, z: 9.5 };
    const b = setup(ahead, 38);
    expect(b.n.mode).toBe('leaving');
    expect(reachOf(grid, b.w.state, { kind: 'manifest', at: ahead })).toEqual([b.n.id]);
    expect(b.w.manifest()).toBe(true);
    const dropB = ofType(drive(b.w, MANIFEST.windup + 0.1, ahead), 'manifest').find((e) => e.phase === 'drop')!;
    expect(dropB.scared).toEqual([b.n.id]);
  });

  it('逃跑中的人不算（和结算一样用 canBeScared）', () => {
    const w = createWorld({ seed: 35, autoSpawn: false });
    const at = { x: 8.0, z: 6.0 };
    const n = stand(w, { x: 9.0, z: 6.0 }, Math.PI);
    drive(w, 0.05, at);
    n.fear = 100;
    drive(w, 0.05, at);
    expect(n.mode).toBe('fleeing');
    expect(reachOf(grid, w.state, { kind: 'manifest', at })).toEqual([]);
  });

  it('200 个随机站位（站着不动，一半已经紧张）：发毛范围外，出手前的 reachOf 和随后落下事件里的 scared 一致 ≥ 98%；发毛范围里只会少报、不会多报', () => {
    // 鬼魂贴得比发毛范围（GHOST.radius × 性格的 chillRange）还近时，平静的人也会回头照一下（npc.ts 的 feelGhost，onset 的时刻是随机的），
    // 照着了落下时照样被吓到：这一下什么时候来 NpcState 里看不出，眼睛不预报（少报）。但名单上的人一定被吓到（不多报）
    const rng = createRng(4242);
    let people = 0, agree = 0, scaredAny = 0, trials = 0, sameSet = 0, close = 0, closeMiss = 0;
    const misses: string[] = [];
    while (trials < 200) {
      const w = createWorld({ seed: 3000 + trials, autoSpawn: false });
      const [gi, gj] = walkableCells[Math.floor(rng.next() * walkableCells.length)];
      const c = cellCenter(gi, gj);
      const at = { x: c.x + rng.range(-0.2, 0.2), z: c.z + rng.range(-0.2, 0.2) };
      const ns = Array.from({ length: 3 }, () => stand(w, nearPoint(rng, at, 7), rng.range(-Math.PI, Math.PI)));
      // 一半平静（只有手电照着那里才算），一半已经紧张（看得见那里就会转过来）
      for (const n of ns) n.fear = rng.next() < 0.5 ? 0 : rng.range(FEAR.nervous, 90);
      drive(w, 0.3, at);
      const reach = new Set(reachOf(grid, w.state, { kind: 'manifest', at }));
      if (!w.manifest()) continue; // 鬼魂在能走的格子里，不会失败；万一失败就换一个
      trials++;
      const drop = ofType(drive(w, MANIFEST.windup + 0.1, at), 'manifest').find((e) => e.phase === 'drop');
      const scared = new Set(drop?.scared ?? []);
      let same = true;
      for (const n of ns) {
        const d = Math.hypot(n.pos.x - at.x, n.pos.z - at.z);
        if (scared.has(n.id)) scaredAny++;
        if (d < GHOST.radius * TRAITS[n.personality].chillRange) {
          // 发毛范围里：名单上的人一定被吓到；名单外的可能回头看见
          close++;
          expect(!reach.has(n.id) || scared.has(n.id), `#${trials} ${n.name} d=${d.toFixed(2)}`).toBe(true);
          if (reach.has(n.id) !== scared.has(n.id)) closeMiss++;
          continue;
        }
        people++;
        if (reach.has(n.id) === scared.has(n.id)) agree++;
        else {
          same = false;
          misses.push(`#${trials} ${n.name} d=${d.toFixed(2)} reach=${reach.has(n.id)} scared=${scared.has(n.id)}`);
        }
      }
      if (same) sameSet++;
    }
    expect(scaredAny).toBeGreaterThan(SCARED_ANY); // 前提：样本里有足够多的人被吓到
    expect(close).toBeGreaterThan(20); // 前提：发毛范围里也有不少人
    expect(closeMiss).toBeLessThan(close);
    expect(agree / people, misses.join('\n')).toBeGreaterThanOrEqual(0.98);
    expect(sameSet / trials).toBeGreaterThanOrEqual(0.95);
  });
});
