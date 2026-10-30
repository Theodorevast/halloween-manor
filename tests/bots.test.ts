// 平衡机器人自己的统计（tests/bots.ts）：目标 6 的「附身了几次、其中几次真的吓到人」要记在对的那一次附身头上；
// 2026-10-30 路 GP 的几种打法（只按现身、先引诱再附身）真的是那样打的：对照的数字才算数
import { describe, expect, test } from 'vitest';
import { GHOST_BOT, LURER, landingLog, runBot } from './bots';
import { GHOST_SOURCE } from '../src/sim/types';
import { createWorld } from '../src/sim/world';
import { SCARES } from '../src/config/scares';
import type { SimEvent, World } from '../src/sim/types';

const DT = 1 / 60;

/** 推进 seconds 秒，每步的事件交给 log；until 为真的那一步停下（返回 true），一直没等到返回 false */
function drive(w: World, log: ReturnType<typeof landingLog>, seconds: number, until?: (e: SimEvent) => boolean): boolean {
  for (let k = 0; k < Math.round(seconds / DT); k++) {
    const ev = w.step(DT);
    log.observe(ev, w.state.objects);
    if (until && ev.some(until)) return true;
  }
  return false;
}

describe('几种打法（tests/balance.test.ts 的「现身是收尾」）', () => {
  /** 跑一局，每一步看一眼世界（watch）；返回这一局的统计 */
  const play = (run: (setup: (w: World) => void) => ReturnType<typeof runBot>, watch: (w: World, ev: SimEvent[]) => void) =>
    run((w) => {
      const step = w.step.bind(w);
      w.step = (dt) => {
        const ev = step(dt);
        watch(w, ev);
        return ev;
      };
    });

  test('只按现身的三种（spam、hug、manifest）：一件物件都不碰，没有 trigger、机关；物件涨的恐惧值是 0；冷却一好就按（约每 20 秒一次）', () => {
    for (const ghost of ['spam', 'hug', 'manifest'] as const) {
      let triggers = 0;
      const r = play((setup) => runBot(3, 'idle', { ghost, seconds: 120, setup }), (_, ev) => {
        triggers += ev.filter((e) => e.type === 'trigger' || e.type === 'trap').length;
      });
      expect(triggers).toBe(0);
      expect(r.propFear).toBe(0);
      expect(r.manifests).toBeGreaterThanOrEqual(4);
    }
  });

  test('hug 真的贴着人（身后 GHOST_BOT.behind 米上下）按，不在他的光里也按；spam 不等飘到就按', () => {
    let drops = 0, near = 0, unlit = 0;
    play((setup) => runBot(5, 'idle', { ghost: 'hug', seconds: 200, setup }), (w, ev) => {
      for (const e of ev) {
        if (e.type !== 'manifest' || e.phase !== 'drop') continue;
        drops++;
        const d = Math.min(...w.state.npcs.map((n) => Math.hypot(n.pos.x - e.pos.x, n.pos.z - e.pos.z)));
        if (d <= 1.5 * GHOST_BOT.behind + 1) near++;
        if (e.scared.length === 0) unlit++;
      }
    });
    expect(drops).toBeGreaterThanOrEqual(6);
    expect(near / drops).toBeGreaterThanOrEqual(0.8);
    expect(unlit).toBeGreaterThan(0); // 新规则下贴在身后的有不少是打空的
    const spam = runBot(5, 'idle', { ghost: 'spam', seconds: 200 });
    expect(spam.manifests).toBeGreaterThanOrEqual(drops - 2); // 一样频繁，不看站位
  });

  test('先引诱再附身（lurer）：只附身离鬼魂 LURER.reach 米内的物件；不给 finisher 一次都不现身；真的有引诱带来的惊吓；给 finisher 才现身', () => {
    let far = 0, fired = 0, ghost: { x: number; z: number } | null = null, windups = 0;
    const r = play(
      (setup) =>
        runBot(7, 'lurer', {
          seconds: 300,
          setup: (w) => {
            const set = w.setGhost.bind(w);
            w.setGhost = (g) => {
              ghost = g;
              set(g);
            };
            const trig = w.trigger.bind(w);
            w.trigger = (id) => {
              const o = w.state.objects.find((x) => x.id === id)!;
              fired++;
              // 这一步飘完才告诉模拟（setGhost），这里看到的是上一步的位置：留一步的余量（2 米/秒 / 60）
              if (ghost && Math.hypot(o.pos.x - ghost.x, o.pos.z - ghost.z) > LURER.reach + 0.05) far++;
              return trig(id);
            };
            setup(w);
          },
        }),
      (_, ev) => {
        windups += ev.filter((e) => e.type === 'manifest' && e.phase === 'windup').length;
      },
    );
    expect(fired).toBeGreaterThan(10);
    expect(far).toBe(0);
    expect(windups).toBe(0);
    expect(r.lureLedScares).toBeGreaterThan(5);
    expect(r.exits).toBeGreaterThan(0);
    const f = runBot(7, 'lurer', { seconds: 300, finisher: true });
    expect(f.manifests).toBeGreaterThan(0);
    expect(f.manifestScares).toBeGreaterThan(0);
  });

  test('opts.night：到点收夜、天亮，天亮自己走的人记在 calm，不算吓跑；opts.world 的开关真的给了模拟（屋里最多 4 人）', () => {
    let most = 0, startles = 0;
    const r = play(
      (setup) => runBot(9, 'idle', { seconds: 300, world: { openingGaps: [12, 12, 12], target: 4 }, night: { close: 200, dawn: 270 }, setup }),
      (w, ev) => {
        most = Math.max(most, w.state.npcs.length);
        startles += ev.filter((e) => e.type === 'startle' && e.object === GHOST_SOURCE).length;
      },
    );
    expect(most).toBe(4);
    expect(startles).toBe(0);
    expect(r.exits).toBe(0);
    expect(r.calm).toBe(4);
  });
});

describe('机器人的落空统计（landingLog）', () => {
  test('附身吓到了人：记一次吓到；同一次附身吓到两个人也只记一次', () => {
    const w = createWorld({ seed: 130, autoSpawn: false });
    const log = landingLog();
    // 书房里两个人都看着肖像
    const portrait = w.state.objects.find((o) => o.id === 'portrait')!.pos;
    for (const pos of [{ x: 2.75, z: 3.75 }, { x: 3.75, z: 3.25 }]) {
      w.spawn({ pos, personality: 'brave', lookDir: Math.atan2(portrait.z - pos.z, portrait.x - pos.x) });
    }
    expect(w.trigger('portrait')).toBe(true);
    log.fired('portrait');
    drive(w, log, SCARES.portrait.active + 0.1);
    expect(log.landing.portrait).toEqual({ fired: 1, landed: 1 });
  });

  test('落空的附身（生效窗口里没人被吓到）不会被之后机关触发的那次惊吓「补上」（最终审查 S M5）', () => {
    const w = createWorld({ seed: 113, autoSpawn: false });
    const log = landingLog();
    // 机器人附身摇椅，这时屋里没人：落空
    expect(w.trigger('rocking-chair')).toBe(true);
    log.fired('rocking-chair');
    drive(w, log, SCARES.rockingChair.cooldown + 0.1);
    expect(w.state.objects.find((o) => o.id === 'rocking-chair')!.cooldown).toBe(0);
    expect(log.landing['rocking-chair']).toEqual({ fired: 1, landed: 0 });
    // 冷却完设成机关：访客从旁边走过、摇椅到了他背后时触发，他回头被吓到（同 tests/traps.test.ts 背后型那条）
    const n = w.spawn({ pos: { x: 11.75, z: 4.25 }, personality: 'average', lookDir: 0, goal: { x: 15.25, z: 4.25 } });
    expect(w.arm('rocking-chair')).toBe(true);
    const hit = drive(w, log, 30, (e) => e.type === 'startle' && e.npc === n.id && e.object === 'rocking-chair');
    expect(hit).toBe(true);
    // 机关那一次不是机器人附身的，不算；前面落空的那一次仍是落空
    expect(log.landing['rocking-chair']).toEqual({ fired: 1, landed: 0 });
  });
});
