// 电影化编排：开场显影、惊吓时拉焦点、悬停时焦点移过去、吓跑时的电影黑边（2026-10-27 电影感升级）。
// 镜头本身的运动（推近、呼吸、震动）在 camera.ts；景深和显影遮罩的实现在 postfx.ts，这里只决定「什么时候、对准哪里」
import type { CameraRig, Module, RenderCore } from './types';

export interface Cinematic extends Module {
  /** 鼠标悬停的物件 id（main.ts 从拾取器转过来） */
  setHover(id: string | null): void;
  /** 开场：从黑暗里显影 + 镜头下降，开场点击后调用一次 */
  intro(seconds: number): void;
}

/** 场景叠层要能在电影段落里整体让开 */
export interface OverlayControl {
  setHidden(hidden: boolean): void;
}

export function createCinematic(rig: CameraRig, _core: RenderCore, _overlays: OverlayControl): Cinematic {
  // 占位：镜头与电影段落任务实现
  return {
    setHover() {},
    intro(seconds) {
      rig.intro(seconds);
    },
  };
}
