// 爽点反馈：吓跑 → 大震 + 暗红暗角脉冲；尖叫 → 小震；惊吓物件吓到人 → 镜头冲向那个物件。hit-stop 由模拟层自己做（state.hitStop），这里不管。
// 系统设置了「减少动态效果」时震动只留 30%、不冲镜（推拉镜头是最容易让人晕的一种），暗角脉冲是颜色变化、不晃画面，照常
import type { Vec2 } from '../sim/types';
import { PALETTE } from '../view/palette';
import type { CameraRig, FrameCtx, Module, RenderCore } from './types';

const SHAKE = {
  flee: { strength: 0.35, duration: 0.5 },
  scream: { strength: 0.08, duration: 0.2 },
  reducedMotion: 0.3,
};
const FLEE_PULSE = 1;
const PUNCH = {
  /** 一次涨这么多恐惧值 = 满幅冲镜。48 是落地镜的基础值：最重的惊吓吓到普通访客 */
  full: 48,
  /**
   * 惊吓落下的那一刻已经过去这么多模拟秒才轮到画面，就不补了：镜头和物件动画、尖叫对不上，不如不冲。
   * 正常游戏一帧最多走 0.1 秒，碰不到；只有调试快进 step(ms) 会一下跳过去好几秒
   */
  stale: 0.2,
};

export function createJuice(rig: CameraRig, core: RenderCore): Module {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const k = () => (mq?.matches ? SHAKE.reducedMotion : 1);
  // 这一帧里最重的那一下惊吓，帧末统一冲一次镜：一个物件同一步吓到两个人只冲一次
  let pending: { pos: Vec2; strength: number; time: number } | null = null;
  return {
    onEvent(e, state) {
      if (e.type === 'flee') {
        rig.shake(SHAKE.flee.strength * k(), SHAKE.flee.duration);
        core.fx.vignettePulse(FLEE_PULSE, PALETTE.dread);
      } else if (e.type === 'startle') {
        if (e.scream) rig.shake(SHAKE.scream.strength * k(), SHAKE.scream.duration);
        // object 为 null 是被别人的尖叫传染，没有可以看的东西
        const o = e.object !== null && !mq?.matches ? state.objects.find((x) => x.id === e.object) : undefined;
        if (!o) return;
        // 开方：灯这种小惊吓也看得出推了一下，大惊吓之间仍分得出轻重
        const strength = Math.sqrt(Math.min(1, Math.max(0, e.amount) / PUNCH.full));
        if (!pending || strength > pending.strength || state.time - pending.time > PUNCH.stale) {
          pending = { pos: { x: o.pos.x, z: o.pos.z }, strength, time: state.time };
        }
      }
    },
    update({ state }: FrameCtx) {
      if (!pending) return;
      if (state.time - pending.time <= PUNCH.stale) rig.punch(pending.pos, pending.strength);
      pending = null;
    },
  };
}
