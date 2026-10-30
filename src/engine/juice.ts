// 爽点反馈：吓跑一个人 → 镜头轻轻一抖 + 很淡的冷色暗角。hit-stop 由模拟层自己做（state.hitStop），这里不管。
// 震动用创伤值（rig.shake）：镜头按创伤值² 转一点点角度，像摄影师被吓得手一缩。
// 2026-10-28 做减法：惊吓落下时不再冲镜推近、拉焦，惊吓和尖叫传染也不再震，只留吓跑这一下（比以前小）。
// 2026-10-30 第二波（路 VX，newbie S2、eye S-2）：暗角不再是暗红（整屏泛红像动作游戏的「你受伤了」，意思正好反了），
// 换成近黑的冷色、很淡（postfx.ts 的 PULSE）；震动再小一点；几个人接连吓跑不叠加——暗角取最大（postfx.ts 的 createPulseEnvelope），
// 震动也取最大：只补上一下震动到现在衰减掉的那部分，镜头上的创伤值不会超过一下的满幅。
// 系统设置了「减少动态效果」时震动只留约 30%；暗角脉冲是颜色的变化，不晃画面，照常
import { PALETTE } from '../view/palette';
import type { CameraRig, Module, RenderCore } from './types';

/**
 * 吓跑时镜头上的创伤值（0..1）。画面转角 ∝ 创伤值²：0.42 是满幅的 18%（原来 0.6 是 36%，转角小了一半）。
 * decay：两台镜头（camera.ts、ghostRig.ts）的创伤值每秒退多少（它们的 SHAKE.decay），用来估此刻镜头上还剩多少
 */
export const TRAUMA = {
  flee: 0.42,
  decay: 1,
  /** 减少动态效果：创伤值乘这个。转角和创伤值的平方成正比，0.55² ≈ 0.3，即保留约 30% 的幅度 */
  reducedMotion: 0.55,
};
/** 暗角脉冲的浓度（0..1，乘 postfx.ts 的 PULSE.maxMix）和颜色（近黑的冷色） */
export const FLEE_PULSE = { strength: 1, color: PALETTE.dread };

export function createJuice(rig: CameraRig, core: RenderCore): Module {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => mq?.matches === true;
  /** 上一下之后镜头上的创伤值、那一下的时刻（秒）：下一下来的时候按 TRAUMA.decay 算出此刻还剩多少（只有这里会让镜头抖） */
  let left = 0;
  let at = 0;

  return {
    onEvent(e) {
      if (e.type !== 'flee') return;
      const now = performance.now() / 1000;
      left = Math.max(0, left - (now - at) * TRAUMA.decay);
      at = now;
      // 取最大、不相加：镜头上已经有的不再加，只补到一下的满幅
      const want = TRAUMA.flee * (reduced() ? TRAUMA.reducedMotion : 1);
      const add = want - left;
      if (add > 1e-6) {
        rig.shake(add);
        left = want;
      }
      core.fx.vignettePulse(FLEE_PULSE.strength, FLEE_PULSE.color);
    },
  };
}
