// 墙上多一个影子（The Other One，2026-10-30「一夜」的中段）：一晚最多 OTHER_SHADOW.max 次，某个访客的手电扫过一面墙，
// 墙上投出一个兜帽人形的影子，那里什么也没有，也不是你；下一次照过去就没了。访客没反应，播报不提。
// 用鬼魂墙上影子（L2：只进手电阴影图的一份网格）的同一个办法。接口先占位：影子那一路实现
import type { Module, RenderCore } from '../engine/types';

export interface OtherShadow extends Module {
  /** 这一夜出现过几次（登记簿页脚那一句要不要写） */
  readonly appeared: number;
  /** 出现了一次时回调（登记簿记一笔） */
  onAppear(cb: () => void): void;
}

export function createOtherShadow(_core: RenderCore): OtherShadow {
  return {
    appeared: 0,
    onAppear() {},
  };
}
