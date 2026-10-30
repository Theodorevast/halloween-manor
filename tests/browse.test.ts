// 闲逛时被画像、镜子、挂画吸引（2026-10-30 用户试玩以后，路 GP；playtest.md S2：三个整夜 46 次触发，镜子、画像都是 0 次，六幅挂画基本只是背景）：
// 走到它跟前 1.5–2.5 米、停下、面朝它、手电照着看 2–3 秒，再走；目标挑全屋被看得最少的，刚看过的不挑；紧张的人不停。
// 只有正式游戏打开（WorldOptions.browse，config/visitors.ts 的 nightWorld）：不给时和原来逐步相同（抽随机数的次数、顺序也一样）
import { describe, expect, test } from 'vitest';
import * as THREE from 'three/webgpu';
import { PAINTINGS } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { FEAR, NIGHT_VISITS, nightWorld, VISION } from '../src/config/visitors';
import { angleOf, wrapAngle } from '../src/lib/angle';
import { createBrowse } from '../src/sim/browse';
import type { BrowseSpot } from '../src/sim/browse';
import { Grid } from '../src/sim/grid';
import { canSee } from '../src/sim/perception';
import { facesToward } from '../src/sim/scares';
import { createWorld } from '../src/sim/world';
import { TORCH, createFlashlight } from '../src/view/flashlight';
import { torches } from '../src/view/torches';
import { runBot } from './bots';
import type { NpcState, SimEvent, Vec2, World, WorldOptions } from '../src/sim/types';

const DT = 1 / 60;
const grid = new Grid();
const OPTS = { chance: 1, hold: [2, 3] as [number, number] };
const objects = () => createWorld({ seed: 1, autoSpawn: false }).state.objects;
const spots = (): BrowseSpot[] => createBrowse(grid, objects(), OPTS).spots;
const spotById = (id: string) => spots().find((s) => s.id === id)!;
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.z - b.z);

/** 一个人闲逛 seconds 秒（each 每步之前），记下每一次停下来看：看的是谁、看了多久、停的位置，和那段时间里手电是不是一直照着它 */
function gazes(w: World, n: NpcState, seconds: number, each?: () => void) {
  const out: { id: string; t: number; at: Vec2; lit: number; faced: boolean }[] = [];
  let cur: (typeof out)[number] | null = null;
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    each?.();
    w.step(DT);
    const id = n.gazing ?? null;
    if (id && (!cur || cur.id !== id)) out.push((cur = { id, t: 0, at: { ...n.pos }, lit: 0, faced: false }));
    else if (!id) cur = null;
    if (cur) {
      cur.t += DT;
      const s = spotById(cur.id);
      if (canSee(grid, n, s.pos, VISION.range)) cur.lit += DT;
      if (Math.abs(wrapAngle(n.heading - angleOf(s.pos.x - n.pos.x, s.pos.z - n.pos.z))) < 0.2) cur.faced = true;
    }
  }
  return out;
}

const walker = (seed: number, fear = 0) => {
  const w = createWorld({ seed, autoSpawn: false, browse: OPTS });
  const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average', lookDir: 0 });
  n.fear = fear;
  return { w, n };
};

describe('吸引人的地方（createBrowse）', () => {
  test('八处：画像、镜子、六幅挂画；每处至少几个站的地方，都在它正面 1.5–2.5 米、能走、看得见它（镜子、画像按结算的规则真看得到）', () => {
    const all = spots();
    expect(all.map((s) => s.id).sort()).toEqual(['mirror', 'portrait', ...PAINTINGS.map((p) => p.id)].sort());
    for (const s of all) {
      expect(s.stands.length, s.id).toBeGreaterThanOrEqual(3);
      for (const p of s.stands) {
        expect(grid.walkableAt(p), `${s.id} ${p.x},${p.z}`).toBe(true);
        expect(grid.lineOfSight(p, s.pos), `${s.id} ${p.x},${p.z}`).toBe(true);
        expect(dist(p, s.pos), s.id).toBeGreaterThanOrEqual(1.5 - 1e-6);
        expect(dist(p, s.pos), s.id).toBeLessThanOrEqual(2.5 + 1e-6);
      }
    }
    for (const o of objects().filter((x) => x.id === 'portrait' || x.id === 'mirror')) {
      for (const p of spotById(o.id).stands) {
        expect(facesToward(o, p), o.id).toBe(true);
        expect(dist(p, o.pos), o.id).toBeLessThan(Math.min(SCARES[o.type].range, VISION.range));
      }
    }
  });

  test('挂画的位置在屋里（不在墙格里），站的地方照得到：手电对着它时 canSee 成立', () => {
    for (const s of spots().filter((x) => x.id !== 'portrait' && x.id !== 'mirror')) {
      for (const p of s.stands) {
        const look = { pos: p, lookDir: angleOf(s.pos.x - p.x, s.pos.z - p.z) };
        expect(canSee(grid, look, s.pos, VISION.range), s.id).toBe(true);
      }
    }
  });
});

describe('闲逛时走过去看（WorldOptions.browse）', () => {
  test('走到跟前停下、面朝它、手电一直照着，看 2–3 秒再走；一个人闲逛两分多钟，八处都看过，连着两次不看同一处', () => {
    const { w, n } = walker(5);
    const seen = gazes(w, n, 170);
    expect(new Set(seen.map((g) => g.id)).size).toBe(8);
    seen.slice(0, -1).forEach((g, k) => {
      expect(g.id).not.toBe(seen[k + 1].id);
      expect(g.t, g.id).toBeGreaterThanOrEqual(OPTS.hold[0] - 0.1);
      expect(g.t, g.id).toBeLessThanOrEqual(OPTS.hold[1] + 0.7); // 转过去的时间（最多半圈 0.63 秒）另算
      expect(g.faced, g.id).toBe(true); // 身体真的转过去了
      expect(g.lit, g.id).toBeGreaterThanOrEqual(OPTS.hold[0] - 0.1); // 手电照上以后实打实看这么久
      const d = dist(g.at, spotById(g.id).pos);
      expect(d, g.id).toBeGreaterThanOrEqual(1.3);
      expect(d, g.id).toBeLessThanOrEqual(2.7);
    });
  });

  test('看画像、镜子的时候眼睛亮着（seenBy 有他），够玩家出手；走开以后灭', () => {
    const { w, n } = walker(6);
    const lit: Record<string, number> = { portrait: 0, mirror: 0 };
    for (let k = 0; k < 60 * 170; k++) {
      w.step(DT);
      for (const o of w.state.objects) if (o.id in lit && n.gazing === o.id && o.seenBy.includes(n.id)) lit[o.id] += DT;
    }
    expect(lit.portrait).toBeGreaterThanOrEqual(OPTS.hold[0] - 0.1);
    expect(lit.mirror).toBeGreaterThanOrEqual(OPTS.hold[0] - 0.1);
  });

  test('紧张的人不停：恐惧值一直在 FEAR.nervous 以上时，闲逛一分钟一次都不停下来看', () => {
    const { w, n } = walker(7, FEAR.nervous + 10);
    const seen = gazes(w, n, 60, () => void (n.fear = FEAR.nervous + 10));
    expect(seen).toEqual([]);
  });

  test('正走过去、看到一半紧张起来：不再看，接着走', () => {
    const { w, n } = walker(8);
    for (let k = 0; k < 60 * 40 && !n.gazing; k++) w.step(DT);
    expect(n.gazing).toBeTruthy();
    n.fear = FEAR.nervous + 10;
    w.step(DT * 3);
    expect(n.gazing ?? null).toBeNull();
    for (let k = 0; k < 60; k++) {
      n.fear = FEAR.nervous + 10;
      w.step(DT);
      expect(n.gazing ?? null).toBeNull();
    }
    expect(n.path.length).toBeGreaterThan(0);
  });

  test('看的时候被吓到、听见声音：不再盯着（gazing 清掉），僵住完不接着看；去查看声音', () => {
    const hit = walker(9);
    for (let k = 0; k < 60 * 40 && !hit.n.gazing; k++) hit.w.step(DT);
    expect(hit.n.gazing).toBeTruthy();
    hit.w.setGhost({ x: hit.n.pos.x, z: hit.n.pos.z });
    expect(hit.w.manifest()).toBe(true); // 贴脸现身：落下就吓到他
    for (let k = 0; k < 60 && hit.n.mode !== 'startled'; k++) hit.w.step(DT);
    expect(hit.n.mode).toBe('startled');
    expect(hit.n.gazing ?? null).toBeNull();

    const heard = walker(10);
    const door = heard.w.state.objects.find((o) => o.id === 'kitchen-door')!;
    for (let k = 0; k < 60 * 120; k++) {
      heard.w.step(DT);
      if (heard.n.gazing && dist(heard.n.pos, door.pos) < 5) break;
    }
    expect(heard.n.gazing).toBeTruthy();
    expect(heard.w.trigger('kitchen-door')).toBe(true);
    for (let k = 0; k < 60 * 2 && heard.n.mode !== 'alert'; k++) heard.w.step(DT);
    expect(heard.n.mode).toBe('alert');
    expect(heard.n.gazing ?? null).toBeNull();
  });

  test('几个人不会同时奔着同一处去：四个人一起闲逛，同一时刻没有两个人盯着同一处', () => {
    const w = createWorld({ seed: 11, autoSpawn: false, browse: OPTS });
    const ns = [{ x: 8, z: 6 }, { x: 3, z: 6 }, { x: 13, z: 6 }, { x: 8, z: 9.5 }].map((pos) => w.spawn({ pos, personality: 'average', lookDir: 0 }));
    let same = 0, any = 0;
    for (let k = 0; k < 60 * 120; k++) {
      w.step(DT);
      const ids = ns.map((n) => n.gazing).filter(Boolean);
      any += ids.length;
      if (new Set(ids).size < ids.length) same++;
    }
    expect(any).toBeGreaterThan(60 * 30);
    expect(same).toBe(0);
  });

  test('天亮以后不再停下来看：走得干干净净', () => {
    const { w, n } = walker(12);
    for (let k = 0; k < 60 * 40 && !n.gazing; k++) w.step(DT);
    w.dawn();
    expect(n.gazing ?? null).toBeNull();
    for (let k = 0; k < 60 * 30 && w.state.npcs.length > 0; k++) {
      w.step(DT);
      expect(n.gazing ?? null).toBeNull();
    }
    expect(w.state.npcs.length).toBe(0);
  });
});

describe('手电抬起来照画（view/flashlight.ts 的 TorchPose.lift）', () => {
  /** 手在 0.8 米高，朝东：光轴每走 1 米升多少 */
  const slope = (lift?: number) => {
    const fl = createFlashlight(new THREE.Group(), 'high', 1);
    const x = 3.25 + (lift ?? 2);
    fl.update({ x, y: 0.8, z: 5, dir: 0, power: 1, nervous: false, ...(lift === undefined ? {} : { lift }) }, DT, 0);
    const r = torches.find((t) => t.x === x && t.z === 5)!;
    fl.dispose();
    return r.dy / Math.hypot(r.dx, r.dz);
  };

  test('平时（不给、给 0）和原来一样照 aim 米外的地面', () => {
    expect(slope()).toBeCloseTo(-0.8 / TORCH.aim, 6);
    expect(slope(0)).toBeCloseTo(-0.8 / TORCH.aim, 6);
  });

  test('抬满：站在 1.5–2.5 米外，光轴正好落在每一幅挂画的画布上', () => {
    const k = slope(1);
    for (const p of PAINTINGS) {
      for (const d of [1.5, 2, 2.5]) {
        const y = 0.8 + k * d;
        expect(y, `${p.id} ${d} 米`).toBeGreaterThanOrEqual(p.y - p.size[1] / 2);
        expect(y, `${p.id} ${d} 米`).toBeLessThanOrEqual(p.y + p.size[1] / 2);
      }
    }
  });
});

describe('开关', () => {
  /** 一局的脚本（固定的操作顺序），和 tests/night.test.ts 的 scripted 一个路数 */
  function scripted(opts: WorldOptions, seconds: number) {
    const w = createWorld(opts);
    const all: SimEvent[] = [];
    for (let k = 0; k < seconds * 60; k++) {
      if (k % 300 === 0) w.trigger(w.state.objects[(k / 300) % w.state.objects.length].id);
      all.push(...w.step(DT));
    }
    return JSON.stringify([all, w.state]);
  }

  test('不给 browse 和给 undefined：事件和最后的状态逐个相同（默认世界的机器人数字不变）；没有人有 gazing', () => {
    for (const seed of [1, 2]) {
      const a = scripted({ seed }, 180), b = scripted({ seed, browse: undefined }, 180);
      expect(a === b).toBe(true);
      expect(a.includes('"gazing":"')).toBe(false);
    }
  });

  test('娃娃屋（触屏）不建挂画（view/paintings.ts）：nightWorld(…, false) 只看画像、镜子，不会对着空墙照', () => {
    expect(nightWorld(200, false).browse!.paintings).toBe(false);
    expect(createBrowse(grid, objects(), { ...OPTS, paintings: false }).spots.map((s) => s.id).sort()).toEqual(['mirror', 'portrait']);
    const w = createWorld({ seed: 13, autoSpawn: false, browse: { ...OPTS, paintings: false } });
    const n = w.spawn({ pos: { x: 8, z: 6 }, personality: 'average', lookDir: 0 });
    const ids = new Set(gazes(w, n, 90).map((g) => g.id));
    expect([...ids].sort()).toEqual(['mirror', 'portrait']);
  });

  test('正式游戏打开（nightWorld，第三人称有挂画），机器人默认不开', () => {
    expect(nightWorld(200).browse).toEqual({ ...NIGHT_VISITS.browse, paintings: true });
    expect(NIGHT_VISITS.browse.hold).toEqual([2, 3]);
    const r = runBot(1, 'idle', { seconds: 60 });
    expect(r.paintingStops).toBe(0);
    expect(r.looks.portrait.n + r.looks.mirror.n).toBe(0);
  });

  test('机器人的统计：开着的时候数得到画像、镜子被看了几次几秒，挂画停下来照着看了几次', () => {
    const r = runBot(2, 'idle', { seconds: 200, world: { browse: { chance: 1, hold: [2, 3] } } });
    expect(r.paintingStops).toBeGreaterThan(3);
    expect(r.looks.portrait.n).toBeGreaterThan(0);
    expect(r.looks.mirror.n).toBeGreaterThan(0);
    expect(r.looks.portrait.seconds + r.looks.mirror.seconds).toBeGreaterThan(4);
  });
});
