// 把格子、感知、物件、访客状态机、生成器组合成一个 World。集成阶段只用 createWorld。
// 每一步（1/60 秒）的顺序：引诱结算 → 惊吓结算 → 尖叫传染 → 访客状态机 → 物件计时 → 时间前进 → 生成 → 移除离开的 → seenBy。
// 先结算惊吓再移动：玩家点下去的那一刻，看着物件的人就会被吓到，不会因为同一步里转开了而落空。
import { FRONT_DOOR } from '../config/house';
import { FEAR, HIT_STOP, VISION } from '../config/visitors';
import { angleOf } from '../lib/angle';
import { Grid } from './grid';
import { canBeScared, createNav, createNpc, exposure, hear, startle, updateNpc } from './npc';
import type { Npc, NpcCtx } from './npc';
import { canHear, canSee } from './perception';
import { createRng } from './rng';
import { createScareObjects, facesToward, tickObject, triggerObject, windingUp } from './scares';
import { pickName, pickPersonality, Spawner } from './spawner';
import type { NpcState, SimEvent, SpawnOptions, Vec2, World, WorldOptions, WorldState } from './types';

/** 模拟固定步长（秒）：设计文档「架构」 */
export const SIM_DT = 1 / 60;
/** 步长累积和 hit-stop 扣减的浮点容差 */
const EPS = 1e-9;

export function createWorld(opts: WorldOptions): World {
  const rng = createRng(opts.seed);
  const grid = new Grid();
  const nav = createNav(grid);
  const objects = createScareObjects();
  const byId = new Map(objects.map((o) => [o.state.id, o]));
  const state: WorldState = { time: 0, npcs: [], objects: objects.map((o) => o.state), scaredOff: 0, hitStop: 0 };
  /** 和 state.npcs 一一对应（同顺序），带内部状态 */
  const npcs: Npc[] = [];
  const spawner = opts.autoSpawn === false ? null : new Spawner(rng);
  let nextId = 1;
  /** 两次 step 之间产生的事件（trigger、手动 spawn），下一次 step 一起返回 */
  let pending: SimEvent[] = [];
  let acc = 0;

  // 尖叫传染：这一步里开始尖叫的人排队结算，每人每步最多传染一次
  const screamQueue: Npc[] = [];
  const screamed = new Set<number>();

  const ctx: NpcCtx = {
    nav,
    rng,
    now: 0,
    dt: SIM_DT,
    events: pending,
    onScream: (n) => {
      if (screamed.has(n.s.id)) return;
      screamed.add(n.s.id);
      screamQueue.push(n);
    },
    onFlee: () => {
      state.hitStop = HIT_STOP;
    },
  };

  const inHouse = () => npcs.reduce((c, n) => c + (canBeScared(n) ? 1 : 0), 0);

  function addNpc(o: SpawnOptions, events: SimEvent[]): NpcState {
    const personality = o.personality ?? pickPersonality(rng);
    const name = o.name ?? pickName(rng, state.npcs.map((n) => n.name));
    const inside = FRONT_DOOR.inside, outside = FRONT_DOOR.outside;
    let pos: Vec2, mode: 'entering' | 'wander', lookDir: number;
    if (o.pos) {
      pos = o.pos;
      mode = o.mode ?? 'wander';
      lookDir = o.lookDir ?? (mode === 'entering' ? angleOf(inside.x - pos.x, inside.z - pos.z) : rng.range(-Math.PI, Math.PI));
    } else if (o.mode === 'wander') {
      // 没给位置却要闲逛：站在门厅里进门后的位置
      pos = inside;
      mode = 'wander';
      lookDir = o.lookDir ?? angleOf(inside.x - outside.x, inside.z - outside.z);
    } else {
      pos = outside;
      mode = 'entering';
      lookDir = o.lookDir ?? angleOf(inside.x - outside.x, inside.z - outside.z);
    }
    const npc = createNpc({ id: nextId++, name, personality, pos, lookDir, mode, now: state.time }, ctx);
    npcs.push(npc);
    state.npcs.push(npc.s);
    events.push({ type: 'spawn', npc: npc.s.id });
    return npc.s;
  }

  /** 尖叫传染：尖叫声 FEAR.screamRadius 内听得见的人恐惧 +contagion × 性格倍率，转入警觉走向尖叫者（不僵住） */
  function flushScreams() {
    for (let q = 0; q < screamQueue.length; q++) {
      const src = screamQueue[q];
      for (const n of npcs) {
        if (n === src || !canBeScared(n)) continue;
        if (!canHear(grid, n.s.pos, src.s.pos, FEAR.screamRadius)) continue;
        const amount = FEAR.contagion * n.mult;
        hear(n, ctx, amount, src.s.pos, { type: 'startle', npc: n.s.id, object: null, amount, scream: false });
      }
    }
    screamQueue.length = 0;
  }

  function tick(events: SimEvent[]) {
    ctx.now = state.time;
    ctx.events = events;
    screamed.clear();
    screamQueue.length = 0;
    // 尖叫倒计时放在最前面：这一步新开始的尖叫，步末仍是完整的 FEAR.screamTime
    for (const n of npcs) n.s.screaming = Math.max(0, n.s.screaming - SIM_DT);

    // 引诱：触发那一步，听得见的人恐惧值增加、转入警觉
    for (const o of objects) {
      if (!o.pendingLure) continue;
      o.pendingLure = false;
      for (const n of npcs) {
        if (!canBeScared(n) || !canHear(grid, n.s.pos, o.state.pos, o.spec.range)) continue;
        const amount = exposure(n, o.state.type, o.spec.fear, state.time);
        hear(n, ctx, amount, o.state.pos, { type: 'heard', npc: n.s.id, object: o.state.id });
      }
    }
    // 惊吓：蓄势期间（触发到 hitAt），看见它的人被定住盯着它（附身那一刻眼睛亮着的人在第一步就被定住，
    // 这一步还没人移动过）；从落下到生效窗口结束，看见它的人每人吓一次
    for (const o of objects) {
      if (o.spec.kind !== 'sight' || o.state.active <= 0) continue;
      const range = Math.min(o.spec.range, VISION.range);
      if (windingUp(o)) {
        for (const n of npcs) {
          if (n.transfixOn || !canBeScared(n)) continue;
          if (facesToward(o.state, n.s.pos) && canSee(grid, n.s, o.state.pos, range)) n.transfixOn = o;
        }
        continue;
      }
      for (const n of npcs) {
        if (!canBeScared(n) || o.scared.has(n.s.id)) continue;
        if (!facesToward(o.state, n.s.pos) || !canSee(grid, n.s, o.state.pos, range)) continue;
        o.scared.add(n.s.id);
        startle(n, ctx, o.state.id, o.state.type, o.state.pos, o.spec.fear);
      }
    }
    flushScreams();

    for (const n of npcs) updateNpc(n, ctx);
    flushScreams(); // 状态机兜底触发的逃跑也会尖叫
    for (const n of npcs) {
      if (n.s.mode !== 'gone') continue;
      state.scaredOff += 1;
      events.push({ type: 'exit', npc: n.s.id, name: n.s.name, total: state.scaredOff });
    }

    for (const o of objects) tickObject(o, SIM_DT, events);
    state.time += SIM_DT;

    if (spawner && spawner.update(state.time, inHouse())) addNpc({}, events);

    for (let k = npcs.length - 1; k >= 0; k--) {
      if (npcs[k].s.mode !== 'gone') continue;
      npcs.splice(k, 1);
      state.npcs.splice(k, 1);
    }

    // seenBy：此刻看得见的人（逃跑中的不算，他们已经吓不到了）。每步给新数组，画面可以放心比较引用
    for (const o of objects) {
      if (o.spec.kind !== 'sight') {
        if (o.state.seenBy.length > 0) o.state.seenBy = [];
        continue;
      }
      const range = Math.min(o.spec.range, VISION.range);
      const seen: number[] = [];
      for (const n of npcs) {
        if (canBeScared(n) && facesToward(o.state, n.s.pos) && canSee(grid, n.s, o.state.pos, range)) seen.push(n.s.id);
      }
      o.state.seenBy = seen;
    }
  }

  return {
    state,

    step(dt: number): SimEvent[] {
      const events = pending;
      pending = [];
      if (!(dt > 0)) return events;
      // hit-stop：只扣减 hit-stop，模拟不走
      if (state.hitStop > 0) {
        const used = Math.min(state.hitStop, dt);
        state.hitStop -= used;
        dt -= used;
        if (state.hitStop <= EPS) state.hitStop = 0;
        else return events;
      }
      acc += dt;
      while (acc >= SIM_DT - EPS) {
        acc -= SIM_DT;
        tick(events);
        // 这一步里有人被吓跑：hit-stop 从下一次 step 开始扣，这次剩下的时间丢掉
        if (state.hitStop > 0) {
          acc = 0;
          break;
        }
      }
      if (acc < 0) acc = 0;
      return events;
    },

    trigger(objectId: string): boolean {
      const o = byId.get(objectId);
      if (!o || !triggerObject(o)) return false;
      pending.push({ type: 'trigger', object: o.state.id, scareType: o.state.type });
      return true;
    },

    spawn(o: SpawnOptions = {}): NpcState {
      return addNpc(o, pending);
    },
  };
}
