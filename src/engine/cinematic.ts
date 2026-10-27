// 电影化编排：开场从黑暗里显影（2026-10-27 电影感升级）。
// 镜头本身的运动（开场下降）在 camera.ts；显影遮罩的实现在 postfx.ts，这里只决定「什么时候、从哪里铺开」。
// 2026-10-28 做减法：去掉了悬停焦点、开场跟焦（景深整个去掉了）和吓跑时的电影黑边
import { FRONT_DOOR } from '../config/house';
import type { Vec2 } from '../sim/types';
import type { CameraRig, FrameCtx, Module, RenderCore } from './types';

/**
 * 开场显影：光从前门铺开，总长 = intro(seconds) 给的秒数（main.ts 传 2.5）。
 * - 先停 0.35 秒：开场遮罩要 0.8 秒才淡完，开头大半被挡住，光要等遮罩开始变透才铺开
 * - 之后用指数缓出（1 − e^(−3u)，归一化到 u = 1 时正好为 1）：开头铺得快、越往后越慢，轻轻落定，不回弹。
 *   实测（2.5 秒）：0.8 秒遮罩淡完时约 50%，1.5 秒约 85%，2 秒约 95%
 * 系统设置了「减少动态效果」时直接显影完，也不播 camera.ts 的下降镜头
 */
const REVEAL = { delay: 0.35, expo: 3 };

export interface Cinematic extends Module {
  /** 开场：从黑暗里显影 + 镜头下降（减少动态效果时只显影，不下降），开场点击后调用一次 */
  intro(seconds: number): void;
}

export function createCinematic(rig: CameraRig, core: RenderCore): Cinematic {
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const door: Vec2 = { x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z };

  // 开场点击之前画面停在黑暗里：只剩月光照着的窗和门廊灯
  core.fx.setReveal(0, door);

  let reveal: { t: number; dur: number } | null = null;
  const updateReveal = (dt: number) => {
    if (!reveal) return;
    reveal.t += dt;
    const u = Math.min(1, Math.max(0, (reveal.t - REVEAL.delay) / Math.max(0.01, reveal.dur - REVEAL.delay)));
    if (u >= 1) {
      core.fx.setReveal(1, door);
      reveal = null;
    } else core.fx.setReveal((1 - Math.exp(-REVEAL.expo * u)) / (1 - Math.exp(-REVEAL.expo)), door);
  };

  return {
    intro(seconds) {
      if (reducedMotion?.matches) {
        // 减少动态效果：不播下降镜头（拉远再推近 + 仰角变化，最容易晕的一类动作），直接显影完
        reveal = null;
        core.fx.setReveal(1, door);
        return;
      }
      rig.intro(seconds);
      reveal = { t: 0, dur: Math.max(0.01, seconds) };
      core.fx.setReveal(0, door);
    },
    update({ dt }: FrameCtx) {
      updateReveal(dt);
    },
  };
}
