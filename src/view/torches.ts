// 手电的共享登记表（2026-10-28 手电照出鬼魂）：flashlight.ts 每帧写，ghost.ts 读（鬼魂的着色器按它判断谁被光锥照着）。
// 不放进模拟层：这是画面的事（光锥的几何、灯闪的亮度），模拟层自己用 canSee 算谁看得见谁。
import type { Vec2 } from '../sim/types';

export interface TorchSample {
  /** 房屋米坐标；y 为离地高度 */
  x: number; y: number; z: number;
  /** 光轴方向（单位向量，房屋坐标） */
  dx: number; dy: number; dz: number;
  /** 光锥半角（弧度）、照多远（米）、强度 0..1（0 = 没点亮） */
  angle: number; range: number; power: number;
}

export const TORCH_COUNT = 4;

/** 每帧由 flashlight.ts 覆盖写；没在用的手电 power = 0 */
export const torches: TorchSample[] = Array.from({ length: TORCH_COUNT }, () => ({ x: 0, y: -100, z: 0, dx: 0, dy: 0, dz: 1, angle: 0, range: 0, power: 0 }));

/** 手电强度的外部乘数（灯闪用，lightfx.ts 写，flashlight.ts 读），1 = 不变 */
export const torchDim: number[] = Array.from({ length: TORCH_COUNT }, () => 1);

/**
 * 鬼魂墙上的影子（调研 L2）用的层：ghost.ts 的影子网格只放在这一层，flashlight.ts 让手电外圈的阴影相机也看这一层。
 * 主相机、月光的阴影相机都不看它：影子只进手电的阴影图（layer 1 是 walls.ts 的只投影全高墙）
 */
export const GHOST_SHADOW_LAYER = 5;

export const asVec2 = (t: TorchSample): Vec2 => ({ x: t.x, z: t.z });
