// 可附身物件的运行时：冷却、生效窗口、被破坏 / 复原。生效（谁被吓到）由 world.ts 结合感知来算。
import { PROPS, propCenter } from '../config/house';
import { SCARES } from '../config/scares';
import type { ScareSpec } from '../config/scares';
import type { ScareObjectState, ScareType, SimEvent, Vec2 } from './types';

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
      armed: 0,
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

/** 有「正面」的物件：只有站在正面那一侧的人看得见它的脸，才会被吓到、才会让眼睛图标亮 */
const FACED: ReadonlySet<ScareType> = new Set<ScareType>(['portrait', 'mirror']);

/** p 处的人能不能看到物件吓人的那一面（台灯、摇椅四面都算） */
export function facesToward(o: Pick<ScareObjectState, 'type' | 'pos' | 'facing'>, p: Vec2): boolean {
  if (!FACED.has(o.type)) return true;
  // 要在正面前方至少一点点：正侧面不算（cos(π/2) 不是精确的 0，所以要有容差）
  return (p.x - o.pos.x) * Math.cos(o.facing) + (p.z - o.pos.z) * Math.sin(o.facing) > 1e-6;
}

/**
 * 惊吓类物件是否还在蓄势：已经触发、还没到 hitAt（惊吓落下）。这期间不判定谁被吓到，
 * 看见它的人被「定住」盯着它（见 npc.ts 的 transfixOn），等落下那一步再正常判定
 */
export function windingUp(o: ScareObject): boolean {
  return o.spec.kind === 'sight' && o.state.active > 0 && o.spec.active - o.state.active < o.spec.hitAt - 1e-9;
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
