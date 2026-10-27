// 爽点反馈：吓跑一个人 → 镜头轻轻一抖 + 暗红暗角脉冲。hit-stop 由模拟层自己做（state.hitStop），这里不管。
// 震动用创伤值（rig.shake）：镜头按创伤值² 转一点点角度，像摄影师被吓得手一缩。
// 2026-10-28 做减法：惊吓落下时不再冲镜推近、拉焦，惊吓和尖叫传染也不再震，只留吓跑这一下（比以前小）。
// 系统设置了「减少动态效果」时震动只留约 30%；暗角脉冲是颜色的变化，不晃画面，照常
import { PALETTE } from '../view/palette';
import type { CameraRig, Module, RenderCore } from './types';

/**
 * 吓跑时往创伤值里加多少（0..1）。画面转角 ∝ 创伤值²：0.6 是满幅的 36%（娃娃屋镜头约 0.2° 横滚）。
 * 以前惊吓 + 吓跑同一步到会叠满 1，现在只有这一下，所以比以前小了约三分之二
 */
const TRAUMA = {
  flee: 0.6,
  /** 减少动态效果：创伤值乘这个。转角和创伤值的平方成正比，0.55² ≈ 0.3，即保留约 30% 的幅度 */
  reducedMotion: 0.55,
};
const FLEE_PULSE = 1;

export function createJuice(rig: CameraRig, core: RenderCore): Module {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => mq?.matches === true;

  return {
    onEvent(e) {
      if (e.type !== 'flee') return;
      rig.shake(TRAUMA.flee * (reduced() ? TRAUMA.reducedMotion : 1));
      core.fx.vignettePulse(FLEE_PULSE, PALETTE.dread);
    },
  };
}
