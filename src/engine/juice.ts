// 爽点反馈：惊吓物件吓到人 → 镜头冲向那个物件、景深焦点拉到物件和受惊的人之间、镜头轻轻一抖；
// 吓跑 → 镜头明显一抖 + 暗红暗角脉冲；被别人的尖叫传染 → 很轻的一抖。hit-stop 由模拟层自己做（state.hitStop），这里不管。
// 震动用创伤值（camera.ts 的 shake）：各事件往里加，镜头按创伤值² 转一点点角度，像摄影师被吓得手一缩。
// 系统设置了「减少动态效果」时不冲镜（推拉镜头是最容易让人晕的一种），震动只留约 30%；
// 焦点变化和暗角脉冲是清晰度、颜色的变化，不晃画面，照常
import type { Vec2 } from '../sim/types';
import { PALETTE } from '../view/palette';
import { PUNCH as CAMERA_PUNCH } from './camera';
import { focusChannel } from './cinematic';
import type { CameraRig, FrameCtx, Module, RenderCore } from './types';

/**
 * 往创伤值里加多少（0..1，封顶 1）。画面转角 ∝ 创伤值²，所以单独一下惊吓只是轻轻一颤（满幅的 25%），
 * 把人吓跑的那一下（惊吓 + 吓跑同一步到）加满 1，才是最大的那一抖
 */
const TRAUMA = {
  /** 吓跑：加得最多 */
  flee: 0.6,
  /** 惊吓物件吓到人：恐惧值涨满 PUNCH.full 时加这么多，弱的按 √ 缩小（台灯吓普通访客约 0.31） */
  scare: 0.5,
  /** 被别人的尖叫传染（没有物件）：单独几乎看不出，和别的叠在一起时添一点 */
  contagion: 0.25,
  /** 减少动态效果：创伤值乘这个。转角和创伤值的平方成正比，0.55² ≈ 0.3，即保留约 30% 的幅度 */
  reducedMotion: 0.55,
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
/**
 * 惊吓拉焦：冲镜的同一刻，景深焦点拉到物件上，焦外虚化开到最强（1），镜头开始退回时松开。
 * - 焦点不正对物件，往受惊的人那边挪 35%：人和物件通常相距 2 米上下，两个都不至于虚掉
 * - 拉过去 0.1 秒（跟 0.12 秒的推进一起到位）；已经在拉焦时换目标 0.18 秒滑过去（和冲镜换目标的平移一致）；
 *   松开 0.3 秒（大约 0.8 秒回到常态，和镜头退回一样长）
 */
const FOCUS = {
  strength: 1,
  towardVisitor: 0.35,
  attack: 0.1,
  glide: 0.18,
  release: 0.3,
  /** 保持多久（秒）：镜头推进 + 停留 */
  hold: CAMERA_PUNCH.attack + CAMERA_PUNCH.hold,
};

export function createJuice(rig: CameraRig, core: RenderCore): Module {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => mq?.matches === true;
  const focus = focusChannel(core);
  // 这一帧里最重的那一下惊吓，帧末统一冲一次镜、拉一次焦：一个物件同一步吓到两个人只冲一次
  let pending: { pos: Vec2; aim: Vec2; strength: number; time: number } | null = null;
  /** 这一帧惊吓 / 传染要加的创伤值：取最大的一下，同一步吓到两个人不会抖两倍 */
  let pendingTrauma = 0;
  /** 正在保持的惊吓拉焦 */
  let held: { t: number; strength: number } | null = null;

  return {
    onEvent(e, state) {
      if (e.type === 'flee') {
        rig.shake(TRAUMA.flee * (reduced() ? TRAUMA.reducedMotion : 1));
        core.fx.vignettePulse(FLEE_PULSE, PALETTE.dread);
      } else if (e.type === 'startle') {
        // object 为 null 是被别人的尖叫传染，没有可以看的东西
        const o = e.object !== null ? state.objects.find((x) => x.id === e.object) : undefined;
        if (!o) {
          if (e.scream) pendingTrauma = Math.max(pendingTrauma, TRAUMA.contagion);
          return;
        }
        // 开方：灯这种小惊吓也看得出推了一下，大惊吓之间仍分得出轻重
        const strength = Math.sqrt(Math.min(1, Math.max(0, e.amount) / PUNCH.full));
        pendingTrauma = Math.max(pendingTrauma, TRAUMA.scare * strength);
        if (!pending || strength > pending.strength || state.time - pending.time > PUNCH.stale) {
          const n = state.npcs.find((x) => x.id === e.npc);
          const k = n ? FOCUS.towardVisitor : 0;
          const aim = n ? { x: o.pos.x + (n.pos.x - o.pos.x) * k, z: o.pos.z + (n.pos.z - o.pos.z) * k } : { x: o.pos.x, z: o.pos.z };
          pending = { pos: { x: o.pos.x, z: o.pos.z }, aim, strength, time: state.time };
        }
      }
    },
    update({ dt, state }: FrameCtx) {
      if (pendingTrauma > 0) {
        rig.shake(pendingTrauma * (reduced() ? TRAUMA.reducedMotion : 1));
        pendingTrauma = 0;
      }
      if (held && (held.t += dt) >= FOCUS.hold) {
        held = null;
        focus.set('scare', null, { smoothTime: FOCUS.release });
      }
      if (!pending) return;
      const p = pending;
      pending = null;
      if (state.time - p.time > PUNCH.stale) return;
      // 拉焦跟着冲镜走：镜头没采用这一下（画面上正播着更强的），焦点也不动。不冲镜时按同样的规则自己判断
      const accepted = reduced() ? !held || p.strength >= held.strength - 1e-6 : rig.punch(p.pos, p.strength);
      if (!accepted) return;
      focus.set('scare', p.aim, { strength: FOCUS.strength, smoothTime: held ? FOCUS.glide : FOCUS.attack });
      held = { t: 0, strength: p.strength };
    },
  };
}
