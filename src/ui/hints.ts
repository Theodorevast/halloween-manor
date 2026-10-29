// 只出现一次的情境提示、做不到时的一句回应（2026-10-30 试玩报告 P1-2 / P1-3）。
// 接口先占位：上手那一路实现（排在操作说明那一行的位置，同样的小型大写排法，停几秒淡出；文案在 STRINGS.onboarding）。
// main.ts 只调这里，不自己拼文案
import type { FrameCtx, Module } from '../engine/types';
import type { SimEvent, WorldState } from '../sim/types';

/** 做不到时的原因（main.ts 按模拟的返回值和状态判断后传进来） */
export type Refusal = 'manifestCooldown' | 'manifestWall' | 'trapsFull' | 'tooFar';

export interface Hints extends Module {
  /** 某种「做不到」：每次都回应一句（很轻、很快淡掉），同一种短时间内不重复 */
  refused(kind: Refusal): void;
  /** 准星第一次对准一个够得着的物件（picking 的 onHover 给非 null 时调） */
  aimed(objectId: string): void;
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  update(ctx: FrameCtx): void;
}

export function createHints(_root: HTMLElement): Hints {
  return {
    refused() {},
    aimed() {},
    onEvent() {},
    update() {},
  };
}
