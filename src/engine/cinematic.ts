// 电影化编排：开场从黑暗里显影（2026-10-27 电影感升级）；收夜时光从屋里收回前门、Keep haunting 时重新铺开（2026-10-30「一夜」）。
// 镜头本身的运动（开场下降）在 camera.ts；显影遮罩的实现在 postfx.ts，这里只决定「什么时候、从哪里铺开 / 收回」。
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
 *
 * 收夜（retreat）：同一条曲线倒着放——远处的光先慢慢退，越靠近前门收得越快，最后停在只剩门廊和月光照亮的窗（progress 0），
 * 开场开头停的那 0.35 秒倒过来在最后（光收完了，停一拍再翻开登记簿）。Keep haunting（spread）：和开场一样铺开，镜头不动。
 * 两个都从此刻的进度接着走（收到一半又铺开不会跳）；减少动态效果时直接切
 */
const REVEAL = { delay: 0.35, expo: 3 };

export interface Cinematic extends Module {
  /** 开场：从黑暗里显影 + 镜头下降（减少动态效果时只显影，不下降），开场点击后调用一次 */
  intro(seconds: number): void;
  /** 收夜：光从屋里收回前门（开场显影倒着放），seconds 秒走完（最后 0.35 秒停在 0）；减少动态效果或 0 秒时直接切到 0 */
  retreat(seconds: number): void;
  /** Keep haunting：光从前门重新铺开（开场那条曲线，镜头不动），seconds 秒走完；减少动态效果或 0 秒时直接显影完 */
  spread(seconds: number): void;
}

/** 开场那条曲线：u 0..1 → 0..1，指数缓出 */
const easeOut = (u: number) => (1 - Math.exp(-REVEAL.expo * u)) / (1 - Math.exp(-REVEAL.expo));

export function createCinematic(rig: CameraRig, core: RenderCore): Cinematic {
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const door: Vec2 = { x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z };

  /** 此刻的显影进度（fx.setReveal 只能写，自己记着：收回、铺开都从这里接着走） */
  let progress = 0;
  const set = (p: number) => {
    progress = p;
    core.fx.setReveal(p, door);
  };
  // 开场点击之前画面停在黑暗里：只剩月光照着的窗和门廊灯
  set(0);

  /** 正在走的一段：从 from 到 to（1 = 铺开、0 = 收回），总长 dur 秒 */
  let reveal: { t: number; dur: number; from: number; to: number } | null = null;
  const updateReveal = (dt: number) => {
    if (!reveal) return;
    const r = reveal;
    r.t += dt;
    const span = Math.max(0.01, r.dur - REVEAL.delay);
    if (r.to > r.from) {
      // 铺开：先停 delay，再缓出
      const u = Math.min(1, Math.max(0, (r.t - REVEAL.delay) / span));
      if (u >= 1) {
        set(r.to);
        reveal = null;
      } else set(r.from + (r.to - r.from) * easeOut(u));
    } else {
      // 收回：铺开倒着放（缓入），收完以后停在 0 直到 dur
      const u = Math.min(1, r.t / span);
      set(r.to + (r.from - r.to) * easeOut(1 - u));
      if (r.t >= r.dur) reveal = null;
    }
  };

  /** 从此刻的进度往 to 走 seconds 秒；减少动态效果或 0 秒直接切 */
  const go = (to: number, seconds: number) => {
    if (reducedMotion?.matches || !(seconds > 0) || progress === to) {
      reveal = null;
      set(to);
      return;
    }
    reveal = { t: 0, dur: seconds, from: progress, to };
  };

  return {
    intro(seconds) {
      if (reducedMotion?.matches) {
        // 减少动态效果：不播下降镜头（拉远再推近 + 仰角变化，最容易晕的一类动作），直接显影完
        reveal = null;
        set(1);
        return;
      }
      rig.intro(seconds);
      set(0);
      reveal = { t: 0, dur: Math.max(0.01, seconds), from: 0, to: 1 };
    },
    retreat(seconds) {
      go(0, seconds);
    },
    spread(seconds) {
      go(1, seconds);
    },
    update({ dt }: FrameCtx) {
      updateReveal(dt);
    },
  };
}
