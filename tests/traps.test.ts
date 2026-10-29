// 机关（设计文档 4.2，config/visitors.ts 的 TRAP）：设下、同时最多 TRAP.max 个、TRAP.expire 秒没触发自动解除；
// 背后型（摇椅、床）在物件到了访客背后 1.5–3 米时触发、他回头被吓到；迎面型（肖像、镜子、台灯）手电照到时触发；
// 引诱类（八音盒、厨房门）进入听得见的范围就响；恐惧值 × TRAP.fearMult；等时机最多 TRAP.wait 秒、离开范围前一定触发
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { Grid } from '../src/sim/grid';
import { createNav, createNpc } from '../src/sim/npc';
import type { Npc } from '../src/sim/npc';
import { createRng } from '../src/sim/rng';
import { createScareObjects } from '../src/sim/scares';
import type { ScareObject } from '../src/sim/scares';
import { tickTraps } from '../src/sim/traps';
import { PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { PERSONALITIES, TRAP } from '../src/config/visitors';
import { angleOf, wrapAngle } from '../src/lib/angle';
import type { SimEvent, Vec2, World } from '../src/sim/types';

const DT = 1 / 60;
const ofType = <T extends SimEvent['type']>(ev: SimEvent[], type: T) =>
  ev.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);
const obj = (w: World, id: string) => w.state.objects.find((o) => o.id === id)!;
const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
const bearingTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);
function run(w: World, seconds: number): SimEvent[] {
  const ev: SimEvent[] = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) ev.push(...w.step(DT));
  return ev;
}
/** 一步一步推进，直到这一步的事件里有 pred 为真的；返回这一步之前的全部事件、这一步的事件，和这一步开始时的模拟时间 */
function stepUntil(w: World, pred: (e: SimEvent) => boolean, seconds = 30) {
  const before: SimEvent[] = [];
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    const t = w.state.time;
    const ev = w.step(DT);
    if (ev.some(pred)) return { before, ev, at: t };
    before.push(...ev);
  }
  throw new Error('没等到');
}
const sprung = (id: string) => (e: SimEvent) => e.type === 'trap' && e.object === id && e.phase === 'sprung';

describe('机关：设下、上限、到期', () => {
  test('arm 成功下一步发 trap armed、armed = TRAP.expire；已经设下、同时设下满了、id 不存在时返回 false', () => {
    const w = createWorld({ seed: 110, autoSpawn: false });
    expect(w.arm('nope')).toBe(false);
    expect(w.arm('rocking-chair')).toBe(true);
    expect(w.arm('rocking-chair')).toBe(false);
    const ev = w.step(DT);
    expect(ofType(ev, 'trap')).toEqual([{ type: 'trap', object: 'rocking-chair', phase: 'armed' }]);
    expect(obj(w, 'rocking-chair').armed).toBeCloseTo(TRAP.expire - DT, 6);
    expect(TRAP.max).toBe(2);
    expect(w.arm('bed')).toBe(true);
    expect(w.arm('portrait')).toBe(false); // 第三个
  });

  test('冷却中的物件设不了；玩家直接附身设下的物件：照常触发，机关跟着作废', () => {
    const w = createWorld({ seed: 111, autoSpawn: false });
    expect(w.trigger('lamp-living')).toBe(true);
    expect(w.arm('lamp-living')).toBe(false);
    expect(w.arm('portrait')).toBe(true);
    w.step(DT);
    expect(w.trigger('portrait')).toBe(true);
    expect(obj(w, 'portrait').armed).toBe(0);
    expect(ofType(run(w, 1), 'trap')).toEqual([]);
  });

  test('到了时机却附身不了（物件在冷却中）：就在本该触发的那一步作废——armed 归零、发 trap expired，不发 sprung / trigger，之后不再试（最终审查 S M4）', () => {
    // 同下面「背后型（摇椅）」那条：访客从旁边走过、摇椅到了他背后时触发
    const play = (stuck: boolean) => {
      const w = createWorld({ seed: 113, autoSpawn: false });
      w.spawn({ pos: { x: 11.75, z: 4.25 }, personality: 'average', lookDir: 0, goal: { x: 15.25, z: 4.25 } });
      expect(w.arm('rocking-chair')).toBe(true);
      // 正常走不到：armTrap 要求冷却为 0，会设冷却的只有 triggerObject，它同时清掉 armed。这里直接改状态，模拟以后改出来的这种情形
      if (stuck) obj(w, 'rocking-chair').cooldown = 30;
      return { w, ...stepUntil(w, (e) => e.type === 'trap' && e.object === 'rocking-chair' && e.phase !== 'armed') };
    };
    const ok = play(false), stuck = play(true);
    expect(ofType(ok.ev, 'trap')).toEqual([{ type: 'trap', object: 'rocking-chair', phase: 'sprung' }]);
    expect(stuck.at).toBe(ok.at);
    expect(ofType(stuck.ev, 'trap')).toEqual([{ type: 'trap', object: 'rocking-chair', phase: 'expired' }]);
    expect(ofType([...stuck.before, ...stuck.ev], 'trigger')).toEqual([]);
    expect(obj(stuck.w, 'rocking-chair').armed).toBe(0);
    // 他还在背后的范围里：不再每步试着触发，也没有别的机关事件
    const later = run(stuck.w, 2);
    expect(ofType(later, 'trap')).toEqual([]);
    expect(ofType(later, 'trigger')).toEqual([]);
  });

  test('TRAP.expire 秒没人来：trap expired、armed 归零、物件没有触发（不进冷却）', () => {
    const w = createWorld({ seed: 112, autoSpawn: false });
    w.arm('portrait');
    w.step(DT);
    const almost = run(w, TRAP.expire - 0.1);
    expect(ofType(almost, 'trap')).toEqual([]);
    const ev = run(w, 0.2);
    expect(ofType(ev, 'trap')).toEqual([{ type: 'trap', object: 'portrait', phase: 'expired' }]);
    expect(obj(w, 'portrait').armed).toBe(0);
    expect(obj(w, 'portrait').cooldown).toBe(0);
    expect(ofType([...almost, ...ev], 'trigger')).toEqual([]);
  });
});

describe('机关：三种触发', () => {
  test('背后型（摇椅）：访客从旁边走过、摇椅到了他背后 1.5–3 米时触发（sprung + trigger）；他察觉（kind sound）、回头，被吓到，恐惧值 × fearMult', () => {
    const w = createWorld({ seed: 113, autoSpawn: false });
    const chair = prop('rocking-chair');
    // 厨房南边那一排，从西往东走（一开始就朝东）：摇椅在路北边半米，走过它以后才到背后
    const n = w.spawn({ pos: { x: 11.75, z: 4.25 }, personality: 'average', lookDir: 0, goal: { x: 15.25, z: 4.25 } });
    expect(w.arm('rocking-chair')).toBe(true);
    const { ev } = stepUntil(w, sprung('rocking-chair'));
    const d = dist(n.pos, chair);
    expect(d).toBeGreaterThanOrEqual(TRAP.behind[0] - 0.05);
    expect(d).toBeLessThanOrEqual(TRAP.behind[1]);
    expect(Math.abs(wrapAngle(bearingTo(n.pos, chair) - n.heading))).toBeGreaterThan(Math.PI / 2);
    expect(ofType(ev, 'trigger')).toEqual([{ type: 'trigger', object: 'rocking-chair', scareType: 'rockingChair', variant: expect.any(Number) }]);
    expect(ofType(ev, 'notice')).toEqual([{ type: 'notice', npc: n.id, kind: 'sound', src: chair }]);
    expect(obj(w, 'rocking-chair').armed).toBe(0);
    expect(obj(w, 'rocking-chair').cooldown).toBeGreaterThan(0);
    // 回头照过去、被吓到（摇椅的生效窗口里）
    const hit = stepUntil(w, (e) => e.type === 'startle' && e.npc === n.id, SCARES.rockingChair.active);
    const st = ofType(hit.ev, 'startle').find((e) => e.npc === n.id)!;
    expect(st.object).toBe('rocking-chair');
    expect(st.amount).toBeCloseTo(SCARES.rockingChair.fear * TRAP.fearMult * PERSONALITIES.average.fearMult, 9);
  });

  test('迎面型（肖像）：他的手电扫到肖像的那一刻触发，蓄势时被定住，落下被吓到（× fearMult）', () => {
    const w = createWorld({ seed: 114, autoSpawn: false });
    const STUDY = { x: 2.75, z: 3.75 };
    const portrait = prop('portrait');
    // 站着左右照（± 0.6 弧度），肖像在照的方向往一边偏 0.8 弧度：一开始照不到，扫过去就照到了
    const n = w.spawn({ pos: STUDY, personality: 'average', lookDir: bearingTo(STUDY, portrait) - 0.8 });
    expect(w.arm('portrait')).toBe(true);
    w.step(DT);
    expect(obj(w, 'portrait').seenBy).toEqual([]);
    const { ev } = stepUntil(w, sprung('portrait'), 3);
    expect(Math.abs(wrapAngle(n.lookDir - bearingTo(n.pos, portrait)))).toBeLessThanOrEqual(0.53);
    expect(ofType(ev, 'trigger').map((e) => e.object)).toEqual(['portrait']);
    const hit = stepUntil(w, (e) => e.type === 'startle' && e.npc === n.id, 2);
    expect(ofType(hit.ev, 'startle')[0]).toMatchObject({ object: 'portrait', amount: SCARES.portrait.fear * TRAP.fearMult });
  });

  test('引诱类（八音盒）：走进听得见的范围那一步就响，听见的人照常察觉、去查看（× fearMult）', () => {
    const w = createWorld({ seed: 115, autoSpawn: false });
    const box = prop('music-box');
    const n = w.spawn({ pos: { x: 9, z: 6 }, personality: 'average', goal: { x: 2.5, z: 6.25 } }); // 走廊里往西走，走向卧室门口
    expect(Math.hypot(9 - box.x, 6 - box.z)).toBeGreaterThan(SCARES.musicBox.range);
    expect(w.arm('music-box')).toBe(true);
    const { ev, before } = stepUntil(w, sprung('music-box'), 10);
    expect(ofType(before, 'heard')).toEqual([]);
    expect(ofType(ev, 'trigger').map((e) => e.object)).toEqual(['music-box']);
    expect(ofType(ev, 'heard')).toEqual([{ type: 'heard', npc: n.id, object: 'music-box' }]);
    expect(n.fear).toBeCloseTo(SCARES.musicBox.fear * TRAP.fearMult, 9);
    expect(n.notice?.kind).toBe('sound');
  });
});

describe('机关：等时机（直接调 tickTraps）', () => {
  /** 一个设下的物件、一个站在 pos 的访客（不走状态机，位置、朝向、速度都手动摆） */
  function bench(id: string, pos: Vec2, heading: number) {
    const grid = new Grid();
    const objects = createScareObjects();
    const o = objects.find((x) => x.state.id === id)!;
    o.state.armed = TRAP.expire;
    const npc: Npc = createNpc({ id: 1, name: 'Ada', personality: 'average', pos, lookDir: heading, mode: 'wander', now: 0 }, { rng: createRng(1), nav: createNav(grid) });
    const fired: number[] = [];
    let now = 0;
    const events: SimEvent[] = [];
    const tick = () => {
      tickTraps(objects, [npc], grid, now, DT, (x: ScareObject) => {
        fired.push(now);
        x.state.armed = 0;
      }, events);
      now += DT;
    };
    return { o, npc, fired, tick, at: () => now };
  }

  test('进了范围、一直没到最好的时机（迎面型：手电没照到）：最多等 TRAP.wait 秒就触发', () => {
    const portrait = prop('portrait');
    const p = { x: 2.75, z: 3.75 };
    const b = bench('portrait', p, bearingTo(p, portrait) + Math.PI); // 背对肖像站着
    for (let k = 0; k < Math.round((TRAP.wait + 0.5) / DT) && b.fired.length === 0; k++) b.tick();
    expect(b.fired.length).toBe(1);
    expect(b.fired[0]).toBeLessThanOrEqual(TRAP.wait + 1e-9);
    expect(b.fired[0]).toBeGreaterThanOrEqual(TRAP.wait - DT - 1e-9);
  });

  test('进了范围、马上要走出去（照现在的速度）：等不到 TRAP.wait 也在离开之前触发', () => {
    const chair = prop('rocking-chair');
    // 摇椅在他背后 0.6 米（背后型的范围里，但太近、不是最好的时机），他朝摇椅走回去：一走就不在背后了
    const p = { x: chair.x + 0.6, z: chair.z + 0.4 };
    const away = bearingTo(chair, p);
    const b = bench('rocking-chair', p, away);
    b.tick();
    expect(b.fired).toEqual([]);
    // 转身朝摇椅那边走（速度 1.3 米/秒）：下一刻摇椅就在他前面了
    b.npc.vx = -Math.cos(away) * 1.3;
    b.npc.vz = -Math.sin(away) * 1.3;
    b.tick();
    expect(b.fired.length).toBe(1);
  });

  test('背后型：太近（< 1.5 米）先不触发，走远到 1.5 米那一刻触发', () => {
    const chair = prop('rocking-chair');
    const b = bench('rocking-chair', { x: chair.x + 0.3, z: 4.25 }, 0); // 朝东，摇椅在背后左边
    let fired = -1;
    for (let k = 0; k < 60 && fired < 0; k++) {
      b.npc.s.pos.x += 1.3 * DT; // 朝东走
      b.npc.vx = 1.3;
      b.tick();
      if (b.fired.length) fired = dist(b.npc.s.pos, chair);
    }
    expect(fired).toBeGreaterThanOrEqual(TRAP.behind[0]);
    expect(fired).toBeLessThan(TRAP.behind[0] + 0.05);
  });
});
