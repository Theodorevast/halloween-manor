// 第三人称鬼魂镜头与操控（2026-10-28 改版）：WASD 飘、鼠标转向、滚轮调远近，镜头在鬼魂后上方。
// 占位：先借用娃娃屋相机，鬼魂停在门厅。镜头任务实现
import { createCameraRig } from './camera';
import type { GhostRig, GhostState } from './types';

export function createGhostRig(canvas: HTMLCanvasElement): GhostRig {
  const base = createCameraRig(canvas);
  const ghost: GhostState = { x: 8, y: 1.4, z: 10, heading: -Math.PI / 2, speed: 0, inWall: false };
  return Object.assign(base, { ghost, lockPointer() {} });
}
