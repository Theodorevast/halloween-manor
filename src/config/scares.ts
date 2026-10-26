// 可附身物件的参数表（设计文档 1. 体验与玩法 /「可附身物件」）
import type { ScareKind, ScareType } from '../sim/types';

export interface ScareSpec {
  kind: ScareKind;
  /** 引诱：听得见的距离；惊吓：能被吓到的最远距离（米） */
  range: number;
  /** 基础恐惧值（再乘性格倍率和习惯化系数） */
  fear: number;
  /** 冷却（秒） */
  cooldown: number;
  /** 生效窗口（秒）：惊吓类在这段时间内被看见就生效；引诱类即声音持续时长 */
  active: number;
  /** 触发后进入「被破坏」状态多久再复原（秒）；0 = 没有这个状态 */
  broken: number;
}

export const SCARES: Record<ScareType, ScareSpec> = {
  musicBox: { kind: 'lure', range: 7, fear: 4, cooldown: 14, active: 4, broken: 0 },
  door: { kind: 'lure', range: 9, fear: 10, cooldown: 10, active: 0.6, broken: 0 },
  lamp: { kind: 'sight', range: 6, fear: 18, cooldown: 8, active: 1.5, broken: 6 },
  rockingChair: { kind: 'sight', range: 6, fear: 22, cooldown: 10, active: 3, broken: 0 },
  portrait: { kind: 'sight', range: 6, fear: 32, cooldown: 16, active: 1.5, broken: 10 },
  mirror: { kind: 'sight', range: 2.5, fear: 48, cooldown: 20, active: 1.5, broken: 0 },
};

/** 引诱声隔着墙（声源和听者之间没有视线）时，听得见的距离乘这个系数 */
export const WALL_HEARING_FACTOR = 0.6;
