import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { createRng } from '../src/sim/rng';
import { Spawner, pickName } from '../src/sim/spawner';
import { Grid } from '../src/sim/grid';
import { createNpc, exposure } from '../src/sim/npc';
import { cellOf, FRONT_DOOR, inGrid, PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { BEHAVIOR, FEAR, HIT_STOP, NAMES, PERSONALITIES, SPAWN, SPEED } from '../src/config/visitors';
import { angleOf, wrapAngle } from '../src/lib/angle';
import type { NpcState, SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
const angleTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
const obj = (w: World, id: string) => w.state.objects.find((o) => o.id === id)!;
const npcById = (w: World, id: number) => w.state.npcs.find((n) => n.id === id);
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** 按 chunk 秒一段推进 seconds 秒，收集全部事件 */
function run(w: World, seconds: number, chunk = 0.1): SimEvent[] {
  const ev: SimEvent[] = [];
  let t = 0;
  while (t < seconds - 1e-9) {
    const d = Math.min(chunk, seconds - t);
    ev.push(...w.step(d));
    t += d;
  }
  return ev;
}

/** 习惯化系数：之前被这种物件吓过的有效次数 count，距上次 gap 秒（按 config 的恢复速度） */
const habFactor = (gap: number, count = 1) =>
  FEAR.habituation ** Math.max(0, count - (FEAR.habituationRecover > 0 ? gap / FEAR.habituationRecover : 0));

/** 把访客挪到 pos、手电朝向 lookAt（测试里直接改状态：state 里的对象就是模拟用的对象） */
function place(n: NpcState, pos: Vec2, lookAt: Vec2) {
  n.pos.x = pos.x;
  n.pos.z = pos.z;
  n.lookDir = angleTo(pos, lookAt);
}

describe('World：附身与惊吓（计划测试 1–3）', () => {
  const STUDY = { x: 2.75, z: 3.75 };

  test('肖像吓到看着它的 average 访客：trigger + startle（32，尖叫），fear = 32', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: angleTo(STUDY, prop('portrait')) });
    expect(w.trigger('portrait')).toBe(true);
    const ev = w.step(0.1);
    expect(ofType(ev, 'trigger')).toEqual([{ type: 'trigger', object: 'portrait', scareType: 'portrait' }]);
    expect(ofType(ev, 'startle')).toEqual([{ type: 'startle', npc: n.id, object: 'portrait', amount: 32, scream: true }]);
    expect(n.fear).toBe(32);
    expect(n.mode).toBe('startled');
    expect(n.screaming).toBeGreaterThan(0);
  });

  test('冷却中再附身返回 false；冷却结束（期间 reset 一次）再附身：按习惯化（含随时间恢复）算', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: angleTo(STUDY, prop('portrait')) });
    w.trigger('portrait');
    w.step(0.1);
    expect(w.trigger('portrait')).toBe(false);
    const portrait = obj(w, 'portrait');
    expect(portrait.cooldown).toBeGreaterThan(0);
    expect(portrait.broken).toBeGreaterThan(0);

    const ev = run(w, 17);
    expect(ofType(ev, 'reset')).toEqual([{ type: 'reset', object: 'portrait' }]);
    expect(portrait.cooldown).toBe(0);
    expect(portrait.broken).toBe(0);
    // 生效窗口里一直看着也只被吓一次
    expect(ofType(ev, 'startle')).toEqual([]);

    // 17 秒里它闲逛走开了，把它请回肖像前。
    // 计划原写「这次 16（减半）」：那是习惯化不恢复时的数；现在每 habituationRecover 秒恢复一次，隔 17 秒按配置算
    place(n, STUDY, prop('portrait'));
    const t2 = w.state.time; // 惊吓在下一步的第一小步结算，那时模拟时间就是 t2；第一次在 0
    expect(w.trigger('portrait')).toBe(true);
    const ev2 = w.step(0.1);
    const s = ofType(ev2, 'startle');
    expect(s.length).toBe(1);
    const want = SCARES.portrait.fear * habFactor(t2);
    expect(s[0].amount).toBeCloseTo(want, 9);
    expect(s[0].scream).toBe(want >= FEAR.screamAt);
  });

  test('习惯化：同一种物件连着吓减半；每过 habituationRecover 秒恢复一次；别的种类不受影响', () => {
    const R = FEAR.habituationRecover, h = FEAR.habituation, base = SCARES.lamp.fear;
    expect(R).toBeGreaterThan(0);
    const npc = createNpc(
      { id: 1, name: 'Ada', personality: 'average', pos: { x: 8, z: 6 }, lookDir: 0, mode: 'wander', now: 0 },
      { rng: createRng(1) },
    );
    expect(exposure(npc, 'lamp', base, 0)).toBe(base);
    expect(exposure(npc, 'lamp', base, 0)).toBe(base * h); // 立刻再吓：减半
    expect(exposure(npc, 'lamp', base, 0)).toBe(base * h * h);
    expect(exposure(npc, 'lamp', base, R)).toBeCloseTo(base * h ** 2, 9); // 有效 3 次，过 R 秒恢复 1 次 → 2 次
    expect(exposure(npc, 'lamp', base, R + R / 2)).toBeCloseTo(base * h ** 2.5, 9); // 可以是小数
    expect(exposure(npc, 'lamp', base, 20 * R)).toBe(base); // 很久以后完全恢复
    expect(exposure(npc, 'portrait', SCARES.portrait.fear, 0)).toBe(SCARES.portrait.fear);
  });

  test('id 不存在返回 false；trigger 事件只在下一次 step 里出现一次', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    expect(w.trigger('nope')).toBe(false);
    expect(w.trigger('lamp-living')).toBe(true);
    expect(ofType(w.step(0.05), 'trigger').length).toBe(1);
    expect(ofType(w.step(0.05), 'trigger').length).toBe(0);
  });

  test('附身设置冷却、生效窗口和被破坏时长；没人看见就白白浪费冷却', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    w.trigger('lamp-living');
    const lamp = obj(w, 'lamp-living');
    expect(lamp.cooldown).toBe(SCARES.lamp.cooldown);
    expect(lamp.active).toBe(SCARES.lamp.active);
    expect(lamp.broken).toBe(SCARES.lamp.broken);
    w.trigger('rocking-chair');
    expect(obj(w, 'rocking-chair').broken).toBe(0); // 摇椅没有被破坏状态
    w.trigger('music-box');
    expect(obj(w, 'music-box').broken).toBe(0); // 引诱类不设
    const ev = run(w, 2);
    expect(ofType(ev, 'startle')).toEqual([]);
    expect(lamp.active).toBe(0);
    expect(w.trigger('lamp-living')).toBe(false);
    // 台灯 6 秒后复原，冷却 8 秒
    const ev2 = run(w, 4.1);
    expect(ofType(ev2, 'reset')).toEqual([{ type: 'reset', object: 'lamp-living' }]);
    run(w, 2);
    expect(lamp.cooldown).toBe(0);
    expect(w.trigger('lamp-living')).toBe(true);
  });

  test('生效窗口内转过来看见的人也会被吓到；窗口结束后就不会了', () => {
    const w = createWorld({ seed: 2, autoSpawn: false });
    const lamp = prop('lamp-living');
    const p1 = { x: 9, z: 3 }, p2 = { x: 8.5, z: 2.5 };
    const a = w.spawn({ pos: p1, personality: 'average', lookDir: angleTo(p1, lamp) + Math.PI });
    const b = w.spawn({ pos: p2, personality: 'average', lookDir: angleTo(p2, lamp) + Math.PI });
    w.trigger('lamp-living');
    expect(ofType(w.step(0.5), 'startle')).toEqual([]);
    place(a, p1, lamp);
    const ev = w.step(0.1);
    // b 离得近，会听见 a 的尖叫（object 为 null），这里只看台灯
    expect(ofType(ev, 'startle').filter((e) => e.object !== null).map((e) => [e.npc, e.object])).toEqual([[a.id, 'lamp-living']]);
    run(w, 1.2); // 窗口（1.5 秒）结束
    place(b, p2, lamp);
    expect(ofType(w.step(0.1), 'startle').filter((e) => e.object !== null)).toEqual([]);
  });

  test('习惯化按物件种类算：两盏台灯是同一种，摇椅是另一种', () => {
    const w = createWorld({ seed: 3, autoSpawn: false });
    const p = { x: 9, z: 3 };
    const n = w.spawn({ pos: p, personality: 'average', lookDir: angleTo(p, prop('lamp-living')) });
    w.trigger('lamp-living');
    expect(ofType(w.step(0.1), 'startle')[0].amount).toBe(SCARES.lamp.fear);
    run(w, 3);
    const q = { x: 7.5, z: 9.5 };
    place(n, q, prop('lamp-foyer'));
    const t2 = w.state.time;
    w.trigger('lamp-foyer');
    const second = ofType(w.step(0.1), 'startle')[0].amount;
    expect(second).toBeCloseTo(SCARES.lamp.fear * habFactor(t2), 9);
    expect(second).toBeLessThan(SCARES.lamp.fear); // 3 秒前刚被另一盏台灯吓过
    run(w, 3);
    const r = { x: 8, z: 3.5 };
    place(n, r, prop('rocking-chair'));
    w.trigger('rocking-chair');
    expect(ofType(w.step(0.1), 'startle')[0].amount).toBe(SCARES.rockingChair.fear);
  });

  test('落地镜要站在 2.5 米内：3 米外看着也吓不到', () => {
    const w = createWorld({ seed: 4, autoSpawn: false });
    const p = { x: 12.25, z: 8.75 };
    w.spawn({ pos: p, personality: 'timid', lookDir: 0 });
    w.trigger('mirror');
    expect(ofType(run(w, 1.6), 'startle')).toEqual([]);
  });
});

describe('World：吓跑与 hit-stop（计划测试 4–5）', () => {
  const BATH = { x: 13.25, z: 8.75 };

  test('timid 访客面对 2 米外的落地镜：amount 72', () => {
    const w = createWorld({ seed: 5, autoSpawn: false });
    const n = w.spawn({ pos: BATH, personality: 'timid', lookDir: 0 });
    w.trigger('mirror');
    const s = ofType(w.step(0.1), 'startle');
    expect(s).toEqual([{ type: 'startle', npc: n.id, object: 'mirror', amount: 72, scream: true }]);
    expect(n.fear).toBe(72);
    expect(n.mode).toBe('startled');
  });

  test('涨满就逃跑：flee 事件、hitStop = 0.15；hit-stop 期间模拟不走；逃出前门后 exit、计数 +1、移除', () => {
    const w = createWorld({ seed: 5, autoSpawn: false });
    const n = w.spawn({ pos: BATH, personality: 'timid', name: 'Theo', lookDir: 0 });
    // 计划里的「20 秒后再附身镜子」凑不满：72 衰减到 24，再 +36 只有 60。这里直接给它一个之前被吓剩下的恐惧值
    n.fear = 40;
    w.trigger('mirror');
    const ev = w.step(0.1);
    expect(ofType(ev, 'startle')[0].amount).toBe(72);
    expect(ofType(ev, 'flee')).toEqual([{ type: 'flee', npc: n.id }]);
    expect(n.mode).toBe('fleeing');
    expect(n.fear).toBe(FEAR.max);
    expect(n.screaming).toBe(FEAR.screamTime);
    expect(w.state.hitStop).toBe(HIT_STOP);

    const t0 = w.state.time;
    const pos0 = { ...n.pos };
    w.step(0.1);
    expect(w.state.time).toBe(t0);
    expect(w.state.hitStop).toBeCloseTo(0.05, 9);
    expect(n.pos).toEqual(pos0);
    w.step(0.1);
    expect(w.state.hitStop).toBe(0);
    expect(w.state.time - t0).toBeCloseTo(0.05, 6);

    // 逃跑：手电在朝向 ±0.9 弧度内乱晃，速度 SPEED.flee
    let maxSpeed = 0;
    let looks = new Set<number>();
    const ev2: SimEvent[] = [];
    for (let k = 0; k < 20 * 60; k++) {
      ev2.push(...w.step(DT));
      const m = npcById(w, n.id);
      if (!m) break;
      expect(m.mode).toBe('fleeing');
      expect(Math.abs(wrapAngle(m.lookDir - m.heading))).toBeLessThanOrEqual(0.9 + 1e-9);
      looks.add(Math.round(wrapAngle(m.lookDir - m.heading) * 10));
      maxSpeed = Math.max(maxSpeed, m.speed);
      expect(m.fear).toBe(FEAR.max); // 逃跑中不衰减
    }
    expect(maxSpeed).toBeCloseTo(SPEED.flee, 5);
    expect(looks.size).toBeGreaterThan(5);
    expect(ofType(ev2, 'exit')).toEqual([{ type: 'exit', npc: n.id, name: 'Theo', total: 1 }]);
    expect(w.state.scaredOff).toBe(1);
    expect(npcById(w, n.id)).toBeUndefined();
    expect(w.state.npcs.length).toBe(0);
  });

  test('hit-stop 期间也能附身，trigger 事件照常返回', () => {
    const w = createWorld({ seed: 5, autoSpawn: false });
    const n = w.spawn({ pos: BATH, personality: 'timid', lookDir: 0 });
    n.fear = 90;
    w.trigger('mirror');
    w.step(0.1);
    expect(w.state.hitStop).toBe(HIT_STOP);
    expect(w.trigger('lamp-foyer')).toBe(true);
    const ev = w.step(0.05);
    expect(ofType(ev, 'trigger').map((e) => e.object)).toEqual(['lamp-foyer']);
  });

  test('连环惊吓（不改状态）：门响 + 镜子 + 两个同伴的尖叫，三个 timid 访客一起涨满逃跑', () => {
    const w = createWorld({ seed: 6, autoSpawn: false });
    const mirror = prop('mirror');
    const ps = [BATH, { x: 13.5, z: 8.0 }, { x: 13.5, z: 9.5 }];
    const ns = ps.map((p) => w.spawn({ pos: p, personality: 'timid', lookDir: angleTo(p, mirror) }));
    w.trigger('kitchen-door');
    w.trigger('mirror');
    const ev = w.step(0.1);
    // 门：10 × 1.5 = 15；镜子：48 × 1.5 = 72；尖叫传染：5 × 1.5 = 7.5，两个同伴各一次 → 102 → 封顶 100
    expect(ofType(ev, 'heard').length).toBe(3);
    expect(ofType(ev, 'startle').filter((e) => e.object === 'mirror').map((e) => e.amount)).toEqual([72, 72, 72]);
    const contagion = ofType(ev, 'startle').filter((e) => e.object === null);
    expect(contagion.length).toBeGreaterThanOrEqual(4);
    for (const e of contagion) {
      expect(e.amount).toBe(7.5);
      expect(e.scream).toBe(false);
    }
    expect(ofType(ev, 'flee').map((e) => e.npc).sort()).toEqual(ns.map((n) => n.id).sort());
    for (const n of ns) expect(n.fear).toBe(FEAR.max);
    expect(w.state.hitStop).toBe(HIT_STOP);
    const ev2 = run(w, 25);
    expect(ofType(ev2, 'exit').map((e) => e.total)).toEqual([1, 2, 3]);
    expect(w.state.scaredOff).toBe(3);
    expect(w.state.npcs.length).toBe(0);
  });

  test('恐惧值被直接改到满（调试用）时，下一步也会逃跑', () => {
    const w = createWorld({ seed: 7, autoSpawn: false });
    const n = w.spawn({ pos: { x: 8, z: 6 } });
    n.fear = FEAR.max;
    const ev = w.step(DT);
    expect(ofType(ev, 'flee')).toEqual([{ type: 'flee', npc: n.id }]);
    expect(n.mode).toBe('fleeing');
  });
});

describe('World：引诱与尖叫传染（计划测试 6）', () => {
  const A_POS = { x: 4, z: 8.5 };
  // 计划里 B 在 (13, 2.5)，但那一格是厨房餐桌；挪到旁边能走的 (13, 3.25)
  const B_POS = { x: 13, z: 3.25 };

  test('八音盒：同房间的 A 听见（heard、alert、fear 4），厨房的 B 没听见', () => {
    const w = createWorld({ seed: 8, autoSpawn: false });
    const a = w.spawn({ pos: A_POS, personality: 'average' });
    const b = w.spawn({ pos: B_POS, personality: 'average' });
    expect(w.trigger('music-box')).toBe(true);
    const ev = w.step(0.1);
    expect(ofType(ev, 'heard')).toEqual([{ type: 'heard', npc: a.id, object: 'music-box' }]);
    expect(a.mode).toBe('alert');
    expect(a.fear).toBe(4);
    expect(b.mode).toBe('wander');
    expect(b.fear).toBe(0);
    // 引诱不僵住、不尖叫
    expect(ofType(ev, 'startle')).toEqual([]);
    expect(a.screaming).toBe(0);
  });

  test('警觉：走到八音盒旁，手电一直指着它；查看 3 秒后回到闲逛', () => {
    const w = createWorld({ seed: 8, autoSpawn: false });
    const a = w.spawn({ pos: A_POS, personality: 'average' });
    const mb = prop('music-box');
    w.trigger('music-box');
    w.step(DT);
    expect(a.mode).toBe('alert');
    const grid = new Grid();
    let arrivedAt = -1;
    for (let k = 0; k < 60 * 10 && a.mode === 'alert'; k++) {
      w.step(DT);
      if (a.mode !== 'alert') break;
      if (a.speed > 0) {
        expect(a.speed).toBeLessThanOrEqual(SPEED.alert + 1e-9);
        // 走动中手电朝向声源（转向限速，走了一小段后应该已经对准）
        if (k > 45) expect(Math.abs(wrapAngle(a.lookDir - angleTo(a.pos, mb)))).toBeLessThan(0.05);
      } else if (arrivedAt < 0 && a.path.length === 0) {
        arrivedAt = w.state.time;
        const d = Math.hypot(a.pos.x - mb.x, a.pos.z - mb.z);
        expect(d).toBeLessThan(0.8);
        expect(grid.walkableAt(a.pos)).toBe(true);
      }
      if (arrivedAt >= 0) {
        // 查看时手电在声源方向 ±0.4 弧度内
        expect(Math.abs(wrapAngle(a.lookDir - angleTo(a.pos, mb)))).toBeLessThanOrEqual(0.4 + 0.05);
      }
    }
    expect(arrivedAt).toBeGreaterThan(0);
    expect(a.mode).toBe('wander');
    expect(w.state.time - arrivedAt).toBeCloseTo(BEHAVIOR.investigate, 1);
  });

  test('引诱也算习惯化次数：门响过一个冷却再响，只恢复了一部分', () => {
    const w = createWorld({ seed: 9, autoSpawn: false });
    const P = { x: 13.25, z: 10.75 }; // 浴室南边，和厨房门洞在同一列，有视线
    const a = w.spawn({ pos: P, personality: 'timid' });
    const base = SCARES.door.fear * PERSONALITIES.timid.fearMult;
    w.trigger('kitchen-door');
    w.step(0.1);
    expect(a.fear).toBe(base);
    run(w, SCARES.door.cooldown);
    a.pos.x = P.x;
    a.pos.z = P.z;
    const t2 = w.state.time, before = a.fear;
    expect(w.trigger('kitchen-door')).toBe(true);
    const ev = w.step(0.1);
    expect(ofType(ev, 'heard').length).toBe(1);
    const want = base * habFactor(t2);
    expect(a.fear - before).toBeCloseTo(want, 9);
    if (SCARES.door.cooldown < FEAR.habituationRecover) expect(want).toBeLessThan(base);
  });

  test('门隔着墙按 0.6 倍距离算：6 米外有视线听得见，隔墙 5.9 米（> 9 × 0.6）听不见', () => {
    const w = createWorld({ seed: 10, autoSpawn: false });
    // 浴室南边，和厨房门洞、浴室门洞在同一列（第 26 列），有视线
    const near = w.spawn({ pos: { x: 13.25, z: 10.75 }, personality: 'average' });
    const far = w.spawn({ pos: { x: 7.5, z: 2.5 }, personality: 'average' }); // 客厅，隔着第 21 列的墙
    w.trigger('kitchen-door');
    const ev = w.step(0.1);
    expect(ofType(ev, 'heard').map((e) => e.npc)).toEqual([near.id]);
    expect(far.mode).toBe('wander');
  });

  test('尖叫传染：书房里尖叫，旁边的人恐惧 +5、转入警觉（不僵住），发 object 为 null 的 startle', () => {
    const w = createWorld({ seed: 11, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const a = w.spawn({ pos: STUDY, personality: 'average', lookDir: angleTo(STUDY, prop('portrait')) });
    const b = w.spawn({ pos: { x: 4.25, z: 2.25 }, personality: 'average', lookDir: 0 }); // 背对肖像
    const c = w.spawn({ pos: { x: 13.25, z: 9.25 }, personality: 'average' }); // 浴室，太远
    w.trigger('portrait');
    const ev = w.step(0.1);
    const st = ofType(ev, 'startle');
    expect(st).toContainEqual({ type: 'startle', npc: a.id, object: 'portrait', amount: 32, scream: true });
    expect(st).toContainEqual({ type: 'startle', npc: b.id, object: null, amount: 5, scream: false });
    expect(st.some((e) => e.npc === c.id)).toBe(false);
    expect(b.mode).toBe('alert');
    expect(b.fear).toBe(5);
    expect(b.screaming).toBe(0);
    expect(c.mode).toBe('wander');
  });

  test('受惊中听到声音：不打断僵住，恢复时转入警觉；先听到再被吓也一样', () => {
    const w = createWorld({ seed: 12, autoSpawn: false });
    const p = { x: 9, z: 3 };
    const n = w.spawn({ pos: p, personality: 'brave', lookDir: angleTo(p, prop('lamp-living')) });
    w.trigger('lamp-living');
    w.step(0.1);
    expect(n.mode).toBe('startled');
    w.step(0.2);
    w.trigger('kitchen-door'); // 客厅里隔墙 4.4 米，门的隔墙距离 9 × 0.6 = 5.4
    const ev = w.step(0.1);
    expect(ofType(ev, 'heard').map((e) => e.npc)).toEqual([n.id]);
    expect(n.mode).toBe('startled');
    run(w, FEAR.startleTime - 0.4 + 0.05);
    expect(n.mode).toBe('alert');

    const w2 = createWorld({ seed: 12, autoSpawn: false });
    const m = w2.spawn({ pos: p, personality: 'brave', lookDir: angleTo(p, prop('lamp-living')) });
    w2.trigger('kitchen-door');
    w2.trigger('lamp-living');
    const ev2 = w2.step(0.1);
    expect(ofType(ev2, 'heard').length).toBe(1);
    expect(ofType(ev2, 'startle').length).toBe(1);
    expect(m.mode).toBe('startled');
    run(w2, FEAR.startleTime);
    expect(m.mode).toBe('alert');
  });

  test('受惊结束后恢复原状态：闲逛的回到闲逛，进门中的回到进门', () => {
    const w = createWorld({ seed: 13, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const a = w.spawn({ pos: STUDY, personality: 'brave', lookDir: angleTo(STUDY, prop('portrait')) });
    const q = { x: 8, z: 11.4 };
    const b = w.spawn({ pos: q, mode: 'entering', personality: 'brave', lookDir: angleTo(q, prop('lamp-foyer')) });
    expect(b.mode).toBe('entering');
    w.trigger('portrait');
    w.trigger('lamp-foyer');
    const ev = w.step(0.1);
    expect(ofType(ev, 'startle').map((e) => e.npc).sort()).toEqual([a.id, b.id]);
    expect(a.mode).toBe('startled');
    expect(b.mode).toBe('startled');
    const posB = { ...b.pos };
    run(w, FEAR.startleTime - 0.15);
    expect(b.mode).toBe('startled');
    expect(b.pos).toEqual(posB); // 僵住不动
    expect(b.speed).toBe(0);
    run(w, 0.1);
    expect(a.mode).toBe('wander');
    expect(b.mode).toBe('entering');
  });
});

describe('World：恐惧值（计划测试 7）', () => {
  test('fear = 40 的人 10 秒内不再受惊：降到 40 − (10 − decayDelay) × decayRate', () => {
    const w = createWorld({ seed: 14, autoSpawn: false });
    const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average' });
    n.fear = 40;
    run(w, FEAR.decayDelay - 0.1);
    expect(n.fear).toBe(40); // decayDelay 秒内不回落
    run(w, 10 - (FEAR.decayDelay - 0.1));
    expect(Math.abs(n.fear - (40 - (10 - FEAR.decayDelay) * FEAR.decayRate))).toBeLessThanOrEqual(0.5);
    run(w, 40 / FEAR.decayRate + 1);
    expect(n.fear).toBe(0); // 不低于 0
  });

  test('被吓后重新计时；恐惧值封顶；紧张标志', () => {
    const w = createWorld({ seed: 15, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: angleTo(STUDY, prop('portrait')) });
    n.fear = 50;
    run(w, FEAR.decayDelay + 1); // 已经回落了 1 秒
    const f0 = 50 - FEAR.decayRate;
    expect(n.fear).toBeCloseTo(f0, 1);
    place(n, STUDY, prop('portrait'));
    w.trigger('portrait');
    w.step(0.1);
    expect(n.fear).toBeCloseTo(Math.min(FEAR.max, f0 + SCARES.portrait.fear), 1);
    expect(n.fear).toBeGreaterThanOrEqual(FEAR.nervous);
    expect(n.nervous).toBe(true);
    const f = n.fear;
    run(w, FEAR.decayDelay - 0.2);
    expect(n.fear).toBe(f); // 重新计时：decayDelay 秒内不回落
    run(w, (f - FEAR.nervous) / FEAR.decayRate + 1);
    expect(n.fear).toBeLessThan(FEAR.nervous);
    expect(n.nervous).toBe(false);
  });

  test('紧张时闲逛更快', () => {
    const w = createWorld({ seed: 16, autoSpawn: false });
    const calm = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average' });
    const nerv = w.spawn({ pos: { x: 8, z: 6.5 }, personality: 'average' });
    let maxCalm = 0, maxNerv = 0;
    for (let k = 0; k < 60 * 8; k++) {
      nerv.fear = 70; // 每步拉回来，保持紧张
      w.step(DT);
      maxCalm = Math.max(maxCalm, calm.speed);
      maxNerv = Math.max(maxNerv, nerv.speed);
    }
    expect(maxCalm).toBeCloseTo(SPEED.wander, 5);
    expect(maxNerv).toBeCloseTo(SPEED.nervous, 5);
  });
});

describe('World：生成访客（计划测试 8）', () => {
  function opening(seed: number) {
    const w = createWorld({ seed });
    const ev = run(w, 2.1);
    const at2 = w.state.npcs.length;
    ev.push(...run(w, 12.4));
    return { w, ev, at2, at14: w.state.npcs.length, who: w.state.npcs.map((n) => [n.id, n.name, n.personality]) };
  }

  test('2.1 秒时 1 人；14.5 秒时 3 人；同一 seed 跑两遍名字和性格完全一致', () => {
    const a = opening(42);
    const b = opening(42);
    expect(a.at2).toBe(1);
    expect(a.at14).toBe(3);
    expect(ofType(a.ev, 'spawn').map((e) => e.npc)).toEqual([1, 2, 3]);
    expect(a.who).toEqual(b.who);
    expect(new Set(a.who.map((x) => x[1])).size).toBe(3); // 不重名
    for (const [, name, pers] of a.who) {
      expect(NAMES).toContain(name);
      expect(Object.keys(PERSONALITIES)).toContain(pers);
    }
  });

  test('开局节奏：SPAWN.first 秒进第一个，之后每 SPAWN.stagger 秒一个', () => {
    const w = createWorld({ seed: 43 });
    const times: number[] = [];
    for (let k = 0; k < 60 * 20; k++) if (ofType(w.step(DT), 'spawn').length) times.push(w.state.time);
    expect(times.length).toBe(SPAWN.target);
    times.forEach((t, k) => expect(t).toBeCloseTo(SPAWN.first + k * SPAWN.stagger, 1));
  });

  test('自动生成的访客在门外、状态 entering，走进门厅后开始闲逛', () => {
    const w = createWorld({ seed: 44 });
    run(w, 2.05);
    const n = w.state.npcs[0];
    expect(n.mode).toBe('entering');
    expect(Math.hypot(n.pos.x - FRONT_DOOR.outside.x, n.pos.z - FRONT_DOOR.outside.z)).toBeLessThan(0.1);
    run(w, 1);
    expect(n.speed).toBeCloseTo(SPEED.enter, 5);
    run(w, 2);
    expect(n.mode).toBe('wander');
  });

  test('有人逃跑后屋里不到 3 人：SPAWN.delay 范围内补一个', () => {
    const w = createWorld({ seed: 45 });
    run(w, 14.5);
    expect(w.state.npcs.length).toBe(3);
    w.state.npcs[0].fear = FEAR.max;
    const t0 = w.state.time;
    let spawnedAt = -1;
    for (let k = 0; k < 60 * 20 && spawnedAt < 0; k++) {
      const ev = w.step(DT);
      if (ofType(ev, 'spawn').length) spawnedAt = w.state.time;
      // 屋里不算逃跑的最多 3 人
      expect(w.state.npcs.filter((n) => n.mode !== 'fleeing').length).toBeLessThanOrEqual(SPAWN.target);
    }
    // t0 之后第一步逃跑（hit-stop 0.15 秒里时间不走），然后在 delay 范围内补人
    expect(spawnedAt - t0).toBeGreaterThanOrEqual(SPAWN.delay[0] - 0.05);
    expect(spawnedAt - t0).toBeLessThanOrEqual(SPAWN.delay[1] + 0.1);
    expect(w.state.npcs.map((n) => n.id)).toContain(4);
  });

  test('Spawner：开局按节奏，之后少人时只安排一次延迟', () => {
    const sp = new Spawner(createRng(1));
    expect(sp.update(SPAWN.first - 0.01, 0)).toBe(false);
    expect(sp.update(SPAWN.first, 0)).toBe(true);
    expect(sp.update(SPAWN.first + SPAWN.stagger - 0.01, 1)).toBe(false);
    expect(sp.update(SPAWN.first + SPAWN.stagger, 1)).toBe(true);
    expect(sp.update(SPAWN.first + 2 * SPAWN.stagger, 2)).toBe(true);
    // 满员后不再生成
    let t = SPAWN.first + 2 * SPAWN.stagger;
    for (let k = 0; k < 60 * 30; k++) expect(sp.update((t += DT), 3)).toBe(false);
    // 两个人走了：先安排一个，到点放一个；之后再安排下一个
    const t0 = t;
    const got: number[] = [];
    let inHouse = 1;
    for (let k = 0; k < 60 * 40 && got.length < 2; k++) {
      t += DT;
      if (sp.update(t, inHouse)) { got.push(t - (got.length ? got[got.length - 1] + t0 : t0)); inHouse++; }
    }
    expect(got.length).toBe(2);
    for (const d of got) {
      expect(d).toBeGreaterThanOrEqual(SPAWN.delay[0] - 1e-6);
      expect(d).toBeLessThanOrEqual(SPAWN.delay[1] + DT * 2);
    }
  });

  test('pickName：不和屋里的人重名；名字用完了才允许重名', () => {
    const rng = createRng(3);
    for (let k = 0; k < 200; k++) {
      const taken = NAMES.slice(0, 15);
      expect(pickName(rng, taken)).toBe(NAMES[15]);
    }
    expect(NAMES).toContain(pickName(rng, NAMES));
  });

  test('spawn()：给了 pos 默认闲逛、先原地左右照；不给 pos 在门外 entering；id 递增；发 spawn 事件', () => {
    const w = createWorld({ seed: 46, autoSpawn: false });
    const a = w.spawn({ pos: { x: 8, z: 6 }, lookDir: 0, name: 'Mia', personality: 'brave' });
    const b = w.spawn();
    expect([a.id, b.id]).toEqual([1, 2]);
    expect(a).toMatchObject({ name: 'Mia', personality: 'brave', mode: 'wander', lookDir: 0, heading: 0, fear: 0 });
    expect(b.mode).toBe('entering');
    expect(b.pos).toEqual(FRONT_DOOR.outside);
    expect(b.name).not.toBe('Mia');
    const ev = w.step(DT);
    expect(ofType(ev, 'spawn')).toEqual([{ type: 'spawn', npc: 1 }, { type: 'spawn', npc: 2 }]);
    // 原地左右照至少 BEHAVIOR.lookAround[0] 秒
    const dirs: number[] = [];
    for (let k = 0; k < 60 * (BEHAVIOR.lookAround[0] - 0.1); k++) {
      w.step(DT);
      dirs.push(a.lookDir);
    }
    expect(a.pos).toEqual({ x: 8, z: 6 });
    expect(a.speed).toBe(0);
    expect(Math.max(...dirs) - Math.min(...dirs)).toBeGreaterThan(0.5); // 手电在扫
    for (const d of dirs) expect(Math.abs(wrapAngle(d))).toBeLessThanOrEqual(BEHAVIOR.sweepAmp + 1e-9);
    run(w, BEHAVIOR.lookAround[1] - BEHAVIOR.lookAround[0] + 0.5);
    expect(a.path.length + (a.speed > 0 ? 1 : 0)).toBeGreaterThan(0); // 开始走去别的房间
  });
});

describe('World：闲逛、转向、不穿墙', () => {
  test('闲逛会去别的房间，到达后停留', () => {
    const w = createWorld({ seed: 47, autoSpawn: false });
    const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average' }); // 走廊
    const rooms = new Set<string>();
    const grid = new Grid();
    for (let k = 0; k < 60 * 60; k++) {
      w.step(DT);
      const [i, j] = cellOf(n.pos.x, n.pos.z);
      if (n.speed === 0 && n.mode === 'wander') rooms.add(`${i},${j}`);
      expect(grid.isWalkable(i, j)).toBe(true);
    }
    expect(rooms.size).toBeGreaterThan(3);
  });

  test('转向限速：身体和手电每步最多转 turnRate × dt（受惊时除外）', () => {
    const w = createWorld({ seed: 48 });
    const prev = new Map<number, { h: number; l: number; m: string }>();
    const ids = PROPS.map((p) => p.id);
    const limit = BEHAVIOR.turnRate * DT + 1e-9;
    for (let k = 0; k < 60 * 90; k++) {
      if (k % 150 === 0) w.trigger(ids[(k / 150) % ids.length]);
      w.step(DT);
      for (const n of w.state.npcs) {
        const p = prev.get(n.id);
        if (p && p.m !== 'startled' && n.mode !== 'startled') {
          expect(Math.abs(wrapAngle(n.heading - p.h))).toBeLessThanOrEqual(limit);
          expect(Math.abs(wrapAngle(n.lookDir - p.l))).toBeLessThanOrEqual(limit);
        }
        prev.set(n.id, { h: n.heading, l: n.lookDir, m: n.mode });
      }
    }
  });

  test('长时间跑：访客永远站在可走格里（门外那一段除外），恐惧值在 0–100', () => {
    const grid = new Grid();
    const w = createWorld({ seed: 49 });
    const ids = PROPS.map((p) => p.id);
    let exits = 0;
    for (let k = 0; k < 60 * 240; k++) {
      if (k % 97 === 0) w.trigger(ids[k % ids.length]);
      exits += ofType(w.step(DT), 'exit').length;
      for (const n of w.state.npcs) {
        const [i, j] = cellOf(n.pos.x, n.pos.z);
        const outsideDoor = !inGrid(i, j) && Math.abs(n.pos.x - FRONT_DOOR.outside.x) <= 0.5 && n.pos.z >= 11.5;
        if (!(grid.isWalkable(i, j) || outsideDoor)) throw new Error(`npc ${n.id} (${n.mode}) 在墙里：${n.pos.x}, ${n.pos.z}`);
        expect(n.fear).toBeGreaterThanOrEqual(0);
        expect(n.fear).toBeLessThanOrEqual(FEAR.max);
      }
    }
    expect(w.state.scaredOff).toBe(exits);
  });
});

describe('World：seenBy', () => {
  test('惊吓类物件：此刻看得见它的访客；引诱类为空数组', () => {
    const w = createWorld({ seed: 50, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const a = w.spawn({ pos: STUDY, lookDir: angleTo(STUDY, prop('portrait')) });
    const q = { x: 4, z: 3.5 };
    w.spawn({ pos: q, lookDir: angleTo(q, prop('portrait')) + Math.PI });
    const m = w.spawn({ pos: { x: 4, z: 8.5 }, lookDir: angleTo({ x: 4, z: 8.5 }, prop('music-box')) });
    w.step(DT);
    expect(obj(w, 'portrait').seenBy).toEqual([a.id]);
    expect(obj(w, 'music-box').seenBy).toEqual([]);
    expect(obj(w, 'mirror').seenBy).toEqual([]);
    expect(m.mode).toBe('wander');
  });

  test('逃跑中的访客不算（他们吓不到了）', () => {
    const w = createWorld({ seed: 51, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const a = w.spawn({ pos: STUDY, lookDir: angleTo(STUDY, prop('portrait')) });
    w.step(DT);
    expect(obj(w, 'portrait').seenBy).toEqual([a.id]);
    a.fear = FEAR.max;
    w.step(DT);
    expect(a.mode).toBe('fleeing');
    expect(obj(w, 'portrait').seenBy).toEqual([]);
  });
});

describe('World：固定步长与确定性（计划测试 9）', () => {
  test('按 1/60 秒切分：step(0.1) 前进 6 步，零碎时间累积到下一次', () => {
    const w = createWorld({ seed: 52, autoSpawn: false });
    w.step(0.1);
    expect(w.state.time).toBeCloseTo(0.1, 9);
    w.step(0.01);
    expect(w.state.time).toBeCloseTo(0.1, 9);
    w.step(0.01);
    expect(w.state.time).toBeCloseTo(0.1 + DT, 9);
    w.step(0);
    expect(w.state.time).toBeCloseTo(0.1 + DT, 9);
  });

  function scripted(seed: number) {
    const w = createWorld({ seed });
    const log: SimEvent[] = [];
    const ids = PROPS.map((p) => p.id);
    w.spawn({ pos: { x: 8, z: 6 } });
    for (let k = 0; k < 60 * 60; k++) {
      if (k % 90 === 0) w.trigger(ids[(k / 90) % ids.length]);
      log.push(...w.step(k % 3 === 0 ? 0.031 : 0.007));
    }
    return { log, state: JSON.stringify(w.state) };
  }

  test('同一 seed、同一操作序列，结果完全相同；换 seed 结果不同', () => {
    const a = scripted(1234);
    const b = scripted(1234);
    expect(b.log).toEqual(a.log);
    expect(b.state).toBe(a.state);
    expect(scripted(999).state).not.toBe(a.state);
  });

  test('4 个访客时，1000 次 step(1/60) 总耗时 < 200 ms', () => {
    const w = createWorld({ seed: 53, autoSpawn: false });
    w.spawn({ pos: { x: 2.75, z: 3.75 } });
    w.spawn({ pos: { x: 8, z: 6 } });
    w.spawn({ pos: { x: 13.25, z: 8.75 } });
    w.spawn();
    const ids = PROPS.map((p) => p.id);
    const t0 = performance.now();
    for (let k = 0; k < 1000; k++) {
      if (k % 120 === 0) w.trigger(ids[(k / 120) % ids.length]);
      w.step(1 / 60);
    }
    const ms = performance.now() - t0;
    expect(w.state.npcs.length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(200);
  });
});

describe('Rng', () => {
  test('同一 seed 同一序列；next 在 [0, 1)', () => {
    const a = createRng(7), b = createRng(7), c = createRng(8);
    const xs = Array.from({ length: 100 }, () => a.next());
    expect(Array.from({ length: 100 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 100 }, () => c.next())).not.toEqual(xs);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  test('range、pick、weighted', () => {
    const r = createRng(9);
    for (let k = 0; k < 1000; k++) {
      const v = r.range(8, 15);
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThan(15);
      expect(['a', 'b', 'c']).toContain(r.pick(['a', 'b', 'c']));
    }
    const counts = { timid: 0, average: 0, brave: 0 };
    const w = { timid: 30, average: 45, brave: 25 };
    for (let k = 0; k < 20000; k++) counts[r.weighted(w)]++;
    expect(counts.timid / 20000).toBeCloseTo(0.3, 1);
    expect(counts.average / 20000).toBeCloseTo(0.45, 1);
    expect(counts.brave / 20000).toBeCloseTo(0.25, 1);
    expect(r.weighted({ only: 0, real: 1 })).toBe('real');
  });

  test('大种子（Date.now()）也能用', () => {
    const r = createRng(1761500000000);
    const x = r.next();
    expect(x).toBeGreaterThanOrEqual(0);
    expect(x).toBeLessThan(1);
  });
});
