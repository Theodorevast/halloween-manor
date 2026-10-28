// 主动现身（右键 / F，设计文档 3.2）的时间轴：idle → windup（蓄力 MANIFEST.windup 秒）→ hold（落下以后停留 MANIFEST.hold 秒）
// → cooldown（收回以后冷却 MANIFEST.cooldown 秒）→ idle。谁察觉、谁被吓到、谁被定住由 world.ts 结合感知来算，这里只管时间；
// 另有落下那一刻吓多少的公式（manifestFear）。纯 TypeScript，画面、声音按 WorldState.manifest 和 manifest 事件同步。
import { MANIFEST, VISION } from '../config/visitors';
import { angleDiff, angleOf } from '../lib/angle';
import type { ManifestState, NpcState, Vec2 } from './types';

/** 倒计时归零的容差（同 scares.ts）：1/60 累减会剩 1e-13 这种尾巴 */
const EPS = 1e-9;

/** 没在现身的状态：WorldState.manifest 的初值。dev 页手写 WorldState 时也用它，不用各抄一份字面量 */
export const idleManifest = (): ManifestState => ({ phase: 'idle', t: 0, cooldown: 0, pos: null });

export interface Manifest {
  /** 就是 WorldState.manifest（同一个对象） */
  readonly state: ManifestState;
  /** 在 ghost 处开始蓄力。不在 idle（正在现身、冷却中）返回 false */
  start(ghost: Vec2): boolean;
  /**
   * 推进 dt 秒（world.ts 每步调一次）。返回这一步进入的时刻：windup 蓄力开始（start 之后的第一步）、
   * drop 落下（windup 那一步之后 MANIFEST.windup 秒）、end 收回（落下之后 MANIFEST.hold 秒，同时开始冷却）；别的步 null
   */
  tick(dt: number): 'windup' | 'drop' | 'end' | null;
}

export function createManifest(state: ManifestState = idleManifest()): Manifest {
  /** start 之后还没发过 windup */
  let fresh = false;
  return {
    state,
    start(ghost) {
      if (state.phase !== 'idle') return false;
      state.phase = 'windup';
      state.t = 0;
      state.pos = { x: ghost.x, z: ghost.z };
      fresh = true;
      return true;
    },
    tick(dt) {
      switch (state.phase) {
        case 'idle':
          return null;
        case 'windup':
          // 发 windup 的那一步算 0 秒：之后整整 MANIFEST.windup 秒落下
          if (fresh) {
            fresh = false;
            return 'windup';
          }
          state.t += dt;
          if (state.t < MANIFEST.windup - EPS) return null;
          state.phase = 'hold';
          state.t = 0;
          return 'drop';
        case 'hold':
          state.t += dt;
          if (state.t < MANIFEST.hold - EPS) return null;
          state.phase = 'cooldown';
          state.t = 0;
          state.cooldown = MANIFEST.cooldown;
          return 'end';
        case 'cooldown': {
          state.t += dt;
          const left = state.cooldown - dt;
          state.cooldown = left <= EPS ? 0 : left;
          if (state.cooldown === 0) {
            state.phase = 'idle';
            state.t = 0;
            state.pos = null;
          }
          return null;
        }
      }
    },
  };
}

/**
 * 「被这个人的手电照着」算光锥里的哪一块：照计划里画面「手电照出鬼魂」（V1）的写法，只是用模拟的光锥 VISION——
 * 角度上从光锥边（0）到往里 LIT_EDGE（按 cos 插值）处渐变到满，距离上 VISION.range × LIT_NEAR 以内为满、到 VISION.range 渐变到 0。
 * 所以看得见（在光锥里）不一定「在光里」：光锥边上、远处只是隐约看见
 */
const LIT_EDGE = 0.35;
const LIT_NEAR = 0.7;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 鬼魂在 at 处被 viewer 的手电照着的程度（0–1）：光锥正中、近处为 1，光锥边上、照程尽头为 0 */
export function torchLight(viewer: Pick<NpcState, 'pos' | 'lookDir'>, at: Vec2): number {
  const dx = at.x - viewer.pos.x, dz = at.z - viewer.pos.z, d = Math.hypot(dx, dz);
  if (d < 1e-6) return 1;
  const cosA = Math.cos(VISION.halfAngle);
  const angular = smooth(cosA, lerp(cosA, 1, LIT_EDGE), Math.cos(angleDiff(viewer.lookDir, angleOf(dx, dz))));
  return angular * (1 - smooth(VISION.range * LIT_NEAR, VISION.range, d));
}

/**
 * 落下那一刻，看得见鬼魂（光锥 + 视线 + MANIFEST.range，由调用方判断）的人这一下的基础恐惧值（再乘性格倍率和习惯化，见 npc.ts 的 exposure）：
 * MANIFEST.fear × 距离系数（near[0] 米内 nearMult[0]，near[1] 米处 nearMult[1]，中间线性）
 * × 正中系数（光锥正中 center[0]，光锥边上 center[1]，按偏离的角度线性）× 在光里（1 到 MANIFEST.lit，按 torchLight）
 */
export function manifestFear(viewer: Pick<NpcState, 'pos' | 'lookDir'>, at: Vec2): number {
  const dx = at.x - viewer.pos.x, dz = at.z - viewer.pos.z, d = Math.hypot(dx, dz);
  const far = Math.max(0, Math.min(1, (d - MANIFEST.near[0]) / (MANIFEST.near[1] - MANIFEST.near[0])));
  const near = lerp(MANIFEST.nearMult[0], MANIFEST.nearMult[1], far);
  const off = d < 1e-6 ? 0 : Math.min(1, angleDiff(viewer.lookDir, angleOf(dx, dz)) / VISION.halfAngle);
  const center = lerp(MANIFEST.center[0], MANIFEST.center[1], off);
  const lit = lerp(1, MANIFEST.lit, torchLight(viewer, at));
  return MANIFEST.fear * near * center * lit;
}
