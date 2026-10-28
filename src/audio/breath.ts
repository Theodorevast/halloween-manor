// 访客的近处小声音：喘气和呜咽的排程（2026-10-28 访客反馈，设计文档 2.7）。只在 3D 启用后（setListener）才有，和脚步一样；
// 声音本身的合成在 voices.ts（pant、whimper），这里只管「谁、什么时候、多响」。engine.ts 的 tick 每帧调 update。
//
// 规则
//   喘气：恐惧值 ≥ FEAR.nervous 的访客一路循环（一次 pant = 一个呼吸周期，一口吸气 + 一口呼气）。周期随恐惧值从 BREATH.period[0]（2.2 秒，
//     恐惧值 = FEAR.nervous）线性缩到 BREATH.period[1]（1.3 秒，恐惧值 = FEAR.max），每个周期 ±8%；强度（音量）从 0.65 涨到 1。
//     恐惧值要掉到 FEAR.nervous − BREATH.hyst 以下才停（免得在 60 附近一开一关）。刚开始喘的第一口晚 0.15–0.7 秒，几个人不会同时起头。
//     受惊僵住（startled）、尖叫时屏住呼吸：这几拍不排，等缓过来再接（至少 0.4 秒后）
//   呜咽：恐惧值 ≥ FEAR.dread 的访客每 6–10 秒一声（第一声在跨过阈值后 0.8–2.5 秒）；僵住、尖叫、逃跑时不出声
//   距离：凑近才听得见。「耳朵」是鬼魂（玩家就是鬼魂；镜头在鬼魂身后 1–4 米，用镜头算的话要贴到镜头跟前才听得见，不对），没有鬼魂就用听者。
//     耳朵到访客的水平距离 full（0.8 米）以内满音量，到 far（2.6 米）完全听不见，中间按平方渐弱（2 米处 −19 dB）；超出 far 的周期不建节点。
//     声音走访客的常驻声道（footsteps.ts 的 Crowd.voice：PannerNode HRTF + 隔墙遮挡），所以方向对、隔墙会闷；
//     常驻声道分完了（屋里超过 FOOT.voices 个访客）就在他此刻的位置现建一个
//   俯视（娃娃屋）模式没有：那里没有「凑近」，也没有脚步声
import { FEAR } from '../config/visitors';
import type { NpcState } from '../sim/types';
import type { Crowd } from './footsteps';
import { rand, type Bus } from './sfx';
import type { Place } from './space';
import { pant, whimper } from './voices';

export const BREATH = {
  /** 喘气周期（秒）：恐惧值 FEAR.nervous 时 period[0]，FEAR.max 时 period[1]；每个周期的随机幅度 */
  period: [2.2, 1.3] as [number, number],
  jitter: 0.08,
  /** 恐惧值掉到 FEAR.nervous − hyst 以下才停 */
  hyst: 4,
  /** 喘得多重（pant 的 strength）：恐惧值 FEAR.nervous 时 strength[0]，FEAR.max 时 strength[1] */
  strength: [0.65, 1] as [number, number],
  /** 耳朵到访客的水平距离（米）：full 以内满音量，到 far 完全听不见，中间按平方渐弱 */
  full: 0.8,
  far: 2.6,
  /** 比这还轻（线性）的周期不建节点 */
  minGain: 0.03,
  /** 呜咽的间隔（秒）、跨过阈值后第一声的等待（秒） */
  whimperEvery: [6, 10] as [number, number],
  whimperFirst: [0.8, 2.5] as [number, number],
  /** 屏住呼吸之后，下一口至少等多久（秒） */
  holdBack: 0.4,
  /** 没有常驻声道时，声音从多高出来（米） */
  voiceY: 0.9,
};

/** 恐惧值 → 喘气周期（秒） */
export function breathPeriod(fear: number): number {
  const u = Math.min(1, Math.max(0, (fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));
  return BREATH.period[0] + (BREATH.period[1] - BREATH.period[0]) * u;
}

/** 恐惧值 → 喘得多重 0..1 */
export function breathStrength(fear: number): number {
  const u = Math.min(1, Math.max(0, (fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));
  return BREATH.strength[0] + (BREATH.strength[1] - BREATH.strength[0]) * u;
}

/** 耳朵到访客的水平距离（米）→ 音量系数 0..1：full 以内 1，far 以外 0，中间平方渐弱 */
export function closeGain(d: number): number {
  if (!(d < BREATH.far)) return 0;
  if (d <= BREATH.full) return 1;
  const u = (BREATH.far - d) / (BREATH.far - BREATH.full);
  return u * u;
}

export interface Breath {
  /**
   * 每帧：给每个恐惧值够高的访客排下一口气 / 下一声呜咽。now = 这一帧的声音安排在哪个时刻（AudioContext 时间）；
   * ear = 耳朵的位置（第三人称里是鬼魂），不给就用听者。3D 没启用时什么都不做
   */
  update(npcs: readonly NpcState[], now: number, dt: number, ear?: { x: number; z: number } | null): void;
}

interface Person {
  /** 正在喘（带滞后） */
  on: boolean;
  /** 下一口气的时刻 */
  next: number;
  /** 下一声呜咽的时刻；-1 = 还没到呜咽的恐惧值 */
  whimperAt: number;
}

export function createBreath(bus: Bus, crowd: Crowd): Breath {
  const people = new Map<number, Person>();
  return {
    update(npcs, now, _dt, ear) {
      const space = bus.space;
      if (!space?.active) return;
      const e = ear && Number.isFinite(ear.x) && Number.isFinite(ear.z) ? ear : space.listener;
      for (const id of people.keys()) if (!npcs.some((n) => n.id === id && n.mode !== 'gone')) people.delete(id);

      for (const n of npcs) {
        if (n.mode === 'gone') continue;
        let p = people.get(n.id);
        if (!(n.fear >= FEAR.nervous || (p?.on && n.fear >= FEAR.nervous - BREATH.hyst))) {
          if (p) p.on = false;
          continue;
        }
        if (!p) people.set(n.id, (p = { on: false, next: 0, whimperAt: -1 }));
        if (!p.on) {
          p.on = true;
          p.next = now + rand(0.15, 0.7);
        }
        // 受惊僵住、尖叫时屏住呼吸
        const holding = n.mode === 'startled' || n.screaming > 0;
        const g = closeGain(Math.hypot(n.pos.x - e.x, n.pos.z - e.z));
        const at = (): Place => crowd.voice(n) ?? { x: n.pos.x, y: BREATH.voiceY, z: n.pos.z };

        if (now >= p.next) {
          if (holding) p.next = now + BREATH.holdBack;
          else {
            const period = breathPeriod(n.fear);
            if (g >= BREATH.minGain) pant(bus, now, { id: n.id, personality: n.personality, at: at(), period, strength: breathStrength(n.fear) * g });
            p.next = now + period * rand(1 - BREATH.jitter, 1 + BREATH.jitter);
          }
        }

        if (n.fear < FEAR.dread) {
          p.whimperAt = -1;
          continue;
        }
        if (p.whimperAt < 0) p.whimperAt = now + rand(BREATH.whimperFirst[0], BREATH.whimperFirst[1]);
        if (now >= p.whimperAt && !holding && n.mode !== 'fleeing') {
          if (g >= BREATH.minGain) whimper(bus, now, { id: n.id, personality: n.personality, at: at(), strength: g });
          p.whimperAt = now + rand(BREATH.whimperEvery[0], BREATH.whimperEvery[1]);
        }
      }
    },
  };
}
