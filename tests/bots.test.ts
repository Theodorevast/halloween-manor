// 平衡机器人自己的统计（tests/bots.ts）：目标 6 的「附身了几次、其中几次真的吓到人」要记在对的那一次附身头上
import { describe, expect, test } from 'vitest';
import { landingLog } from './bots';
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
