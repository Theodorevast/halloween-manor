// 访客登记簿（2026-10-30「一夜」）：每个访客一行小故事（几点进来、被什么吓跑），收夜时翻开，中途也能翻（右下角的本子）。
// 接口先占位：登记簿那一路实现（记录在 register.ts，页面在这里；文案在 STRINGS.register；不做大号数字、表格、打分、评级）
import type { FrameCtx, Module } from '../engine/types';
import type { SimEvent, WorldState } from '../sim/types';

export interface RegisterOpenOptions {
  /** true = 收夜时翻开（按钮是 Keep haunting、Another night）；false = 中途翻开（按钮是 Back to the manor） */
  closing: boolean;
}

export interface RegisterView extends Module {
  open(opts: RegisterOpenOptions): void;
  close(): void;
  readonly isOpen: boolean;
  /** 收夜后玩家点 Keep haunting */
  onKeepHaunting(cb: () => void): void;
  /** 收夜后玩家点 Another night（main.ts 重新载入） */
  onAnotherNight(cb: () => void): void;
  /** 翻开、合上时（main.ts 用来放开 / 重新请求指针锁定、暂停输入） */
  onToggle(cb: (open: boolean) => void): void;
  /** 墙上多一个影子出现过（页脚多一句 "And one more, who did not sign."） */
  noteOtherOne(): void;
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  update(ctx: FrameCtx): void;
}

export function createRegisterView(_root: HTMLElement): RegisterView {
  return {
    open() {},
    close() {},
    get isOpen() {
      return false;
    },
    onKeepHaunting() {},
    onAnotherNight() {},
    onToggle() {},
    noteOtherOne() {},
    onEvent() {},
    update() {},
  };
}
