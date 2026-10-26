// 爽点反馈：吓跑 → 大震 + 暗红暗角脉冲；尖叫 → 小震。hit-stop 由模拟层自己做（state.hitStop），这里不管。
// 系统设置了「减少动态效果」时震动只留 30%，暗角脉冲是颜色变化、不晃画面，照常
import { PALETTE } from '../view/palette';
import type { CameraRig, Module, RenderCore } from './types';

const SHAKE = {
  flee: { strength: 0.35, duration: 0.5 },
  scream: { strength: 0.08, duration: 0.2 },
  reducedMotion: 0.3,
};
const FLEE_PULSE = 1;

export function createJuice(rig: CameraRig, core: RenderCore): Module {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const k = () => (mq?.matches ? SHAKE.reducedMotion : 1);
  return {
    onEvent(e) {
      if (e.type === 'flee') {
        rig.shake(SHAKE.flee.strength * k(), SHAKE.flee.duration);
        core.fx.vignettePulse(FLEE_PULSE, PALETTE.dread);
      } else if (e.type === 'startle' && e.scream) {
        rig.shake(SHAKE.scream.strength * k(), SHAKE.scream.duration);
      }
    },
  };
}
