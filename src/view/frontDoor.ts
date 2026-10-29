// 看得见的前门（2026-10-30「一夜」）：门洞里一扇门，有人进来时推开（和敲门、吱呀声对上），进来以后自己慢慢合上；
// 有人被吓跑时在他跑到之前被撞开，他冲出去、远处那声关门响起的同一刻在他身后合上。
// 接口先占位：前门那一路实现
import type { GhostRig, Module, RenderCore } from '../engine/types';

export interface FrontDoor extends Module {
  /** 门现在开着多少（0 = 关上，1 = 全开）：收夜检测「最后一个人走了、门关上了」用 */
  readonly openness: number;
}

export function createFrontDoor(_core: RenderCore, _rig: GhostRig | null): FrontDoor {
  return { openness: 0 };
}
