// 访客生成节奏（设计文档「节奏」）：开局 SPAWN.first 秒进第一个，之后每 SPAWN.stagger 秒一个直到 SPAWN.target 人；
// 之后屋里（不算逃跑中的）不到 SPAWN.target 人时，安排一次 SPAWN.delay 范围内的随机延迟，同一时间只安排一次。
// 「一夜」（2026-10-30）加了两处，都默认关着，不给、不调就和原来一模一样（同一个种子抽随机数的次数、顺序都不变）：
// - 开局的间隔可以另给（openingGaps）：第一个人独自进来，过一会儿才有第二个敲门
// - 收夜（close）以后不再安排新访客，已经排上、还没进门的那一次取消；reopen 以后照常补人
// 用户试玩以后（2026-10-30，路 GP）又加了两处，也默认关着（SpawnerOptions，正式游戏才给）：
// - 屋里最多几人（target，不给是 SPAWN.target）
// - 结伴进门（pairs）：开局以后轮到有人进门、屋里容得下两个时，有 chance 的机会第二个人隔 gap 秒跟进；
//   这一夜过了 final 秒以后进门的都结伴，而且等屋里容得下两个才来（收夜前最后来的一批是两人结伴）
import { NAMES, PERSONALITIES, SPAWN } from '../config/visitors';
import type { Rng } from './rng';
import type { Personality, WorldOptions } from './types';

/** Spawner 的开关：和 WorldOptions 里同名的两项一样 */
export type SpawnerOptions = Pick<WorldOptions, 'target' | 'pairs'>;

/** 时间比较的容差：固定步长累加会有浮点误差，2.0 秒可能算成 1.9999999 */
const EPS = 1e-6;

export class Spawner {
  private opening = true;
  private nextAt: number | null = SPAWN.first;
  /** 开局：排过几次下一个（第 k 次用 gaps[k]，用完了按 SPAWN.stagger） */
  private gapAt = 0;
  /** 收夜了：update 一律不放人，也不再安排 */
  private closed = false;
  /** 结伴进门：第二个人什么时候跟进（模拟时间）；没有在等的为 null。等他的时候不另外安排 */
  private companionAt: number | null = null;
  /** 这一夜从什么时候算起（开局 0，reopen 的那一刻）：pairs.final 按它算 */
  private nightStart = 0;
  private readonly rng: Rng;
  private readonly gaps: readonly number[];
  private readonly target: number;
  private readonly pairs: SpawnerOptions['pairs'];

  /**
   * openingGaps：开局第 2、3… 个访客和前一个之间隔多久（秒，见 WorldOptions.openingGaps）；不给 = 每个都隔 SPAWN.stagger。
   * opts：屋里最多几人、结伴进门（见 SpawnerOptions）；不给就是 SPAWN.target、没有结伴
   */
  constructor(rng: Rng, openingGaps: readonly number[] = [], opts: SpawnerOptions = {}) {
    this.rng = rng;
    this.gaps = [...openingGaps];
    this.target = opts.target ?? SPAWN.target;
    this.pairs = opts.pairs;
  }

  /** 这一夜已经到了「收夜前最后一批」（pairs.final 秒以后）：进门的都结伴、等屋里容得下两个 */
  private late(time: number): boolean {
    const f = this.pairs?.final;
    return f !== undefined && time + EPS >= this.nightStart + f;
  }

  /** 每步调用一次。time = 当前模拟时间，inHouse = 屋里不算逃跑中的人数。返回这一步要不要放一个访客进门 */
  update(time: number, inHouse: number): boolean {
    if (this.closed) return false;
    if (this.opening) {
      if (time + EPS < this.nextAt!) return false;
      const go = inHouse < this.target;
      if (inHouse + (go ? 1 : 0) < this.target) this.nextAt! += this.gaps[this.gapAt++] ?? SPAWN.stagger;
      else {
        this.opening = false;
        this.nextAt = null;
      }
      return go;
    }
    // 结伴的第二个人：到点就进（屋里这时满了就算了），之前不另外安排
    if (this.companionAt !== null) {
      if (time + EPS < this.companionAt) return false;
      this.companionAt = null;
      return inHouse < this.target;
    }
    // 收夜前最后一批：等屋里容得下两个再安排
    const room = this.late(time) ? 2 : 1;
    if (this.nextAt === null) {
      if (inHouse + room <= this.target) this.nextAt = time + this.rng.range(SPAWN.delay[0], SPAWN.delay[1]);
      return false;
    }
    if (time + EPS < this.nextAt) return false;
    this.nextAt = null;
    // 等待期间人数可能已经够了（比如调试时手动放了人）；最后一批要容得下两个
    if (inHouse + room > this.target) return false;
    // 结伴：屋里容得下两个时，最后一批一定结伴，平常有 chance 的机会（只有给了 pairs 才抽这一次随机数）
    if (this.pairs && inHouse + 2 <= this.target && (room === 2 || this.rng.next() < this.pairs.chance)) {
      this.companionAt = time + this.pairs.gap;
    }
    return true;
  }

  /** 收夜：之后不再放人，已经排上、还没进门的那一次取消（开局还没排完的、结伴还没跟进的第二个人也一样） */
  close(): void {
    this.closed = true;
    this.nextAt = null;
    this.companionAt = null;
  }

  /**
   * 收夜以后玩家选 Keep haunting：照常补人——和开局之后一样，屋里不到 target 人就安排一次 SPAWN.delay 范围内的延迟，
   * 一个一个来（给了 pairs 就照常结伴）；开局不再重来（不会又按 first、stagger 连着进三个）。没收夜时什么都不做，不打乱已经排好的。
   * at：新的一夜从什么时候算起（pairs.final 按它算；不给就不动）
   */
  reopen(at?: number): void {
    if (!this.closed) return;
    this.closed = false;
    this.opening = false;
    this.nextAt = null;
    this.companionAt = null;
    if (at !== undefined) this.nightStart = at;
  }
}

/**
 * 一夜里「最近进来过的」要避开几个名字：名字池 NAMES 的一半，连着进来的 25 个人里不会有两个同名。
 * 名字池不能比它加屋里最多的人数（SPAWN.target，正式游戏 nightWorld 的 target）还小，见 tests/night.test.ts
 */
export const RECENT_NAMES = 24;

/**
 * 从名字池里抽一个名字，不管避开了几个都只抽一次随机数（同一个种子抽随机数的次数、顺序不变）。
 * 避开 taken（屋里的人）和 recent（一夜里最近进来过的）；两样都避开以后一个不剩，就只避开 taken；全被占了才允许重名
 */
export function pickName(rng: Rng, taken: Iterable<string>, recent: Iterable<string> = []): string {
  const used = new Set(taken);
  const notTaken = NAMES.filter((n) => !used.has(n));
  for (const n of recent) used.add(n);
  const fresh = NAMES.filter((n) => !used.has(n));
  return rng.pick(fresh.length > 0 ? fresh : notTaken.length > 0 ? notTaken : NAMES);
}

const WEIGHTS = Object.fromEntries(
  (Object.keys(PERSONALITIES) as Personality[]).map((k) => [k, PERSONALITIES[k].weight]),
) as Record<Personality, number>;

/** 按 PERSONALITIES[*].weight 加权抽性格 */
export function pickPersonality(rng: Rng): Personality {
  return rng.weighted(WEIGHTS);
}
