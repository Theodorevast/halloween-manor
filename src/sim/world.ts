// 把格子、感知、物件、访客状态机、生成器组合成一个 World。集成阶段只用 createWorld。
// 每一步（1/60 秒）的顺序：过期的绕开圈 → 机关（到时机就触发，和玩家点一下一样）→ 引诱结算 → 惊吓结算 →
// 主动现身（蓄力察觉 / 落下吓人 / 停留定住 / 收回）→ 尖叫传染 →
// 鬼魂穿墙声 → 鬼魂贴近（发毛、察觉、后退、后颈一凉）→ 尖叫传染 →
// 访客状态机（移动、互相避让）→ 兜底推开挤在一起的人 → 物件计时 → 时间前进 → 生成 → 移除离开的 → 手电照到鬼魂 → seenBy。
// 先结算惊吓再移动：玩家点下去的那一刻，看着物件的人就会被吓到，不会因为同一步里转开了而落空。
import { cellOf, FRONT_DOOR } from '../config/house';
import { FEAR, GHOST, HIT_STOP, MANIFEST, TRAP, VISION } from '../config/visitors';
import { angleOf } from '../lib/angle';
import { Grid } from './grid';
import { createManifest, idleManifest, manifestFear } from './manifest';
import { canBeScared, createNav, createNpc, exposure, feelGhost, hear, hearGhostWall, notice, retreat, separate, startle, startleWith, updateNpc, walkTo } from './npc';
import type { Npc, NpcCtx } from './npc';
import { canHear, canSee } from './perception';
import { createRng } from './rng';
import { createScareObjects, facesToward, tickObject, triggerObject, windingUp } from './scares';
import type { ScareObject } from './scares';
import { armTrap, startledByWindup, tickTraps, trapKind } from './traps';
import { pickName, pickPersonality, Spawner } from './spawner';
import { GHOST_SOURCE } from './types';
import type { GhostInput, NpcState, SimEvent, SpawnOptions, Vec2, World, WorldOptions, WorldState } from './types';

/** 模拟固定步长（秒）：设计文档「架构」 */
export const SIM_DT = 1 / 60;
/** 步长累积和 hit-stop 扣减的浮点容差 */
const EPS = 1e-9;

export function createWorld(opts: WorldOptions): World {
  const rng = createRng(opts.seed);
  /** 附身变体（trigger 事件的 variant）用单独的一串随机数：不动 rng 的序列，原有的种子、平衡数字都不变 */
  const variantRng = createRng((opts.seed ^ 0x9e3779b9) >>> 0);
  const grid = new Grid();
  const nav = createNav(grid);
  const objects = createScareObjects();
  const byId = new Map(objects.map((o) => [o.state.id, o]));
  const state: WorldState = {
    time: 0,
    npcs: [],
    objects: objects.map((o) => o.state),
    scaredOff: 0,
    hitStop: 0,
    manifest: idleManifest(),
    avoid: [],
  };
  /** 主动现身的时间轴（state.manifest 就是它的状态）；这一次现身吓到了谁（落下时记下，停留期间不再定住他们） */
  const manifestTl = createManifest(state.manifest);
  const manifestScared = new Set<number>();
  /** 和 state.npcs 一一对应（同顺序），带内部状态 */
  const npcs: Npc[] = [];
  const spawner = opts.autoSpawn === false ? null : new Spawner(rng);
  let nextId = 1;
  /** 两次 step 之间产生的事件（trigger、手动 spawn），下一次 step 一起返回 */
  let pending: SimEvent[] = [];
  let acc = 0;
  /** 玩家操控的鬼魂（setGhost 给的，复制一份）；null = 没有鬼魂 */
  let ghost: Vec2 | null = null;
  /**
   * 上一次 setGhost 时鬼魂在不在墙里（null = 那时没有鬼魂）；刚穿进墙的那一刻（由假变真）记下位置，下一步结算谁听见。
   * 去抖：上一次算作穿墙的模拟时间，GHOST.wallGap 秒内不再算（墙角、门框边上 inWall 会来回跳）
   */
  let ghostInWall: boolean | null = null;
  let wallSound: Vec2 | null = null;
  let lastWallAt = -Infinity;

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
    crowd: npcs,
    ghost: null,
    avoid: state.avoid,
  };

  const inHouse = () => npcs.reduce((c, n) => c + (canBeScared(n) ? 1 : 0), 0);

  /**
   * 机关到了时机：和玩家点一下一样附身（恐惧值 × TRAP.fearMult），发 trap sprung + trigger。
   * 背后型：蓄势的声音让附近听得见、还没看着它的人察觉（kind sound）、回头——回过头来看见了，照常被吓到。
   * 附身不了（物件在冷却中）：机关就此作废，和到期一样发 trap expired（最终审查 S M4）。不然它一直设着，
   * 人在范围里时每步都想触发、倒计时也不走，等冷却一好就在随便哪一刻发作。现在走不到：armTrap 要求冷却为 0，
   * 会设冷却的只有 triggerObject，它同时清掉 armed
   */
  function fireTrap(o: ScareObject) {
    if (!triggerObject(o, TRAP.fearMult)) {
      o.state.armed = 0;
      o.trapWait = null;
      ctx.events.push({ type: 'trap', object: o.state.id, phase: 'expired' });
      return;
    }
    ctx.events.push({ type: 'trap', object: o.state.id, phase: 'sprung' });
    ctx.events.push({ type: 'trigger', object: o.state.id, scareType: o.state.type, variant: variantRng.next() });
    if (trapKind(o) !== 'behind') return;
    for (const n of npcs) if (startledByWindup(o, n, grid)) notice(n, ctx, 'sound', o.state.pos);
  }

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
    if (o.goal) walkTo(npc, ctx, o.goal);
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

  /**
   * 主动现身的这一步（设计文档 3.2）：
   * - windup：发事件；MANIFEST.noticeRadius 米内的人察觉（kind manifest，隔墙也算：附近的灯在闪），盯着那里直到落下
   * - drop：看得见那里（光锥 + 视线 + MANIFEST.range）的人被吓到：manifestFear × 性格倍率 × 习惯化（按 'manifest' 这一种算），
   *   照常受惊（object = GHOST_SOURCE），僵住结束后后退到离那里至少 MANIFEST.backOff 米；
   *   有人被吓到就加一个绕开圈（MANIFEST.avoidRadius 米、MANIFEST.avoidTime 秒），只有这一次被吓到的人绕它。
   *   圈先放、再结算受惊：恐惧值本来就高、当场吓跑的人，第一条逃跑路线是在 startleWith 里算的，圈要已经在，路线才绕得开
   * - 停留期间：没被这次吓到、看得见那里的人被定住盯着（不加恐惧值）；end 时放开，发事件
   */
  function stepManifest(events: SimEvent[]) {
    const phase = manifestTl.tick(SIM_DT);
    const at = state.manifest.pos;
    if (!at) return;
    if (phase === 'windup') {
      manifestScared.clear();
      events.push({ type: 'manifest', phase: 'windup', pos: { ...at }, scared: [] });
      for (const n of npcs) {
        if (!canBeScared(n) || Math.hypot(n.s.pos.x - at.x, n.s.pos.z - at.z) > MANIFEST.noticeRadius) continue;
        // 盯到落下的那一步还在察觉（多留一步），落下时看得见的人这时被吓到，那一拍跟着作废
        if (notice(n, ctx, 'manifest', at)) n.s.notice!.hold = Math.max(n.s.notice!.hold, MANIFEST.windup + SIM_DT);
      }
    } else if (phase === 'drop') {
      const seen = npcs.filter((n) => canBeScared(n) && canSee(grid, n.s, at, MANIFEST.range));
      const base = seen.map((n) => manifestFear(n.s, at));
      events.push({ type: 'manifest', phase: 'drop', pos: { ...at }, scared: seen.map((n) => n.s.id) });
      // 先放绕开圈（who = 上面已经算好的这批被吓到的人），再结算受惊：当场涨满逃跑的人，第一条路线在 startleWith 里算
      if (seen.length > 0) {
        state.avoid.push({ pos: { ...at }, r: MANIFEST.avoidRadius, until: state.time + MANIFEST.avoidTime, who: seen.map((n) => n.s.id) });
      }
      seen.forEach((n, k) => {
        manifestScared.add(n.s.id);
        startleWith(n, ctx, GHOST_SOURCE, exposure(n, 'manifest', base[k], state.time), at);
        retreat(n, ctx, at, MANIFEST.backOff);
      });
    } else if (phase === 'end') {
      for (const n of npcs) n.transfixPos = null;
      events.push({ type: 'manifest', phase: 'end', pos: { ...at }, scared: [] });
      return;
    }
    if (state.manifest.phase !== 'hold') return;
    for (const n of npcs) {
      if (n.transfixPos || manifestScared.has(n.s.id) || !canBeScared(n)) continue;
      if (canSee(grid, n.s, at, MANIFEST.range)) n.transfixPos = { ...at };
    }
  }

  function tick(events: SimEvent[]) {
    ctx.now = state.time;
    ctx.events = events;
    screamed.clear();
    screamQueue.length = 0;
    // 看见现身以后的绕开圈：到期就去掉（原地删，ctx.avoid 是同一个数组）
    for (let k = state.avoid.length - 1; k >= 0; k--) if (state.avoid[k].until <= state.time + EPS) state.avoid.splice(k, 1);
    // 机关：在引诱、惊吓结算之前触发，这一步就照常结算（和玩家在这一步之前点了一下一样）
    tickTraps(objects, npcs, grid, state.time, SIM_DT, fireTrap, events);
    // 尖叫倒计时放在最前面：这一步新开始的尖叫，步末仍是完整的 FEAR.screamTime
    for (const n of npcs) n.s.screaming = Math.max(0, n.s.screaming - SIM_DT);

    // 引诱：触发那一步，听得见的人恐惧值增加、转入警觉
    for (const o of objects) {
      if (!o.pendingLure) continue;
      o.pendingLure = false;
      for (const n of npcs) {
        if (!canBeScared(n) || !canHear(grid, n.s.pos, o.state.pos, o.spec.range)) continue;
        const amount = exposure(n, o.state.type, o.spec.fear * o.fearMult, state.time);
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
        startle(n, ctx, o.state.id, o.state.type, o.state.pos, o.spec.fear * o.fearMult);
      }
    }
    stepManifest(events);
    flushScreams();

    // 鬼魂穿墙的声音（设计文档 2.3）：GHOST.hearWall 米内听得见的人（隔墙按 canHear 打折）察觉、回头，盯完走过去查看。
    // 涨多少恐惧值是 GHOST.hearFear：现在是 0（用户 2026-10-29「先不加」），所以只让人回头、过去查看，恐惧值不涨、也不算被吓；调上去就生效。
    // 每人听见一次以后 GHOST.hearCooldown 秒内不再算，涨的量按习惯化减弱（见 hearGhostWall）
    if (wallSound) {
      const src = wallSound;
      wallSound = null;
      for (const n of npcs) {
        if (canBeScared(n) && canHear(grid, n.s.pos, src, GHOST.hearWall)) hearGhostWall(n, ctx, src);
      }
    }
    // 鬼魂贴近：发毛、察觉、后退、后颈一凉。在移动之前：被吹了一口凉气的人这一步就僵住；没有鬼魂时什么都不变
    ctx.ghost = ghost;
    for (const n of npcs) feelGhost(n, ctx);
    flushScreams();

    // 移动：先记下每个人这一步开始时的位置（避让看的是它，和更新顺序无关），都走完再兜底推开挤在一起的人
    for (const n of npcs) {
      n.px = n.s.pos.x;
      n.pz = n.s.pos.z;
    }
    for (const n of npcs) updateNpc(n, ctx);
    separate(npcs, grid, SIM_DT);
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

    // 手电照到鬼魂（设计文档 3.1）：只显形、不吓人。照到的那一刻发 reveal on、愣一下（察觉 kind ghost），不涨恐惧值；
    // 不再照着（转开了、鬼魂走了或没了、开始逃跑）发 reveal off。逃跑中的人不算
    const g = ghost;
    for (const n of npcs) {
      const lit = g !== null && canBeScared(n) && canSee(grid, n.s, g, VISION.range);
      if (lit === n.litGhost) continue;
      n.litGhost = lit;
      events.push({ type: 'reveal', npc: n.s.id, on: lit });
      if (lit) notice(n, ctx, 'ghost', g);
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

    setGhost(g: GhostInput | null) {
      if (!g) {
        ghost = null;
        ghostInWall = null;
        wallSound = null;
        return;
      }
      ghost = { x: g.x, z: g.z };
      const inWall = g.inWall === true;
      // 和声音那边的穿墙声一样：上一次在墙外（不是刚出现）、这一次在墙里，而且离上一次算作穿墙过了 GHOST.wallGap 秒
      if (inWall && ghostInWall === false && state.time - lastWallAt >= GHOST.wallGap - EPS) {
        wallSound = { x: g.x, z: g.z };
        lastWallAt = state.time;
      }
      ghostInWall = inWall;
    },

    close() {
      // 接口先占位（2026-10-30），模拟那一路实现
    },

    reopen() {
      // 接口先占位（2026-10-30），模拟那一路实现
    },

    manifest(): boolean {
      // 要有鬼魂（第三人称）
      if (ghost === null) return false;
      // 鬼魂中心所在的格子挡视线（墙、窗）时不能现身：什么都不发生、不进冷却。落下时的 canSee 连终点格一起查，终点是墙格谁也看不见，
      // 蓄力时的察觉又只看距离，附近的人会白白转头盯着墙。判断和视线检查（Grid.lineOfSight）用的是同一个：Grid.isOpaque
      if (grid.isOpaque(...cellOf(ghost.x, ghost.z))) return false;
      // 正在现身、冷却中时 start 返回 false
      return manifestTl.start(ghost);
    },

    arm(objectId: string): boolean {
      const o = byId.get(objectId);
      if (!o || !armTrap(o, objects.reduce((c, x) => c + (x.state.armed > 0 ? 1 : 0), 0))) return false;
      pending.push({ type: 'trap', object: o.state.id, phase: 'armed' });
      return true;
    },

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
      pending.push({ type: 'trigger', object: o.state.id, scareType: o.state.type, variant: variantRng.next() });
      return true;
    },

    spawn(o: SpawnOptions = {}): NpcState {
      return addNpc(o, pending);
    },
  };
}
