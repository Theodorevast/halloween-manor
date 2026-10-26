// 可附身物件的运行时：冷却、生效窗口、被破坏 / 复原。生效（谁被吓到）由 world.ts 结合感知来算。
import { PROPS, propCenter } from '../config/house';
import { SCARES } from '../config/scares';
import type { ScareSpec } from '../config/scares';
import type { ScareObjectState, SimEvent } from './types';

/** 倒计时归零的容差：1/60 累减 16 秒会剩 1e-13 这种尾巴，不能让它多拖一步 */
const EPS = 1e-9;

export interface ScareObject {
  readonly state: ScareObjectState;
  readonly spec: ScareSpec;
  /** 这一次触发里已经被吓过的访客 id（惊吓类：窗口内每人只吓一次） */
  readonly scared: Set<number>;
  /** 引诱类刚被触发，下一步结算谁听见 */
  pendingLure: boolean;
}

export function createScareObjects(): ScareObject[] {
  return PROPS.map((p) => ({
    state: {
      id: p.id,
      type: p.type,
      pos: propCenter(p),
      facing: p.facing,
      cooldown: 0,
      active: 0,
      broken: 0,
      seenBy: [],
    },
    spec: SCARES[p.type],
    scared: new Set<number>(),
    pendingLure: false,
  }));
}

/** 附身。冷却中返回 false；否则设冷却、生效窗口（惊吓类再设被破坏时长），返回 true */
export function triggerObject(o: ScareObject): boolean {
  const s = o.state;
  if (s.cooldown > 0) return false;
  s.cooldown = o.spec.cooldown;
  s.active = o.spec.active;
  if (o.spec.kind === 'sight' && o.spec.broken > 0) s.broken = o.spec.broken;
  o.scared.clear();
  o.pendingLure = o.spec.kind === 'lure';
  return true;
}

const countdown = (v: number, dt: number) => {
  const r = v - dt;
  return r <= EPS ? 0 : r;
};

/** 每步倒数；被破坏状态倒数到 0 的那一步发 reset */
export function tickObject(o: ScareObject, dt: number, events: SimEvent[]): void {
  const s = o.state;
  s.cooldown = countdown(s.cooldown, dt);
  s.active = countdown(s.active, dt);
  if (s.broken > 0) {
    s.broken = countdown(s.broken, dt);
    if (s.broken === 0) events.push({ type: 'reset', object: s.id });
  }
}
