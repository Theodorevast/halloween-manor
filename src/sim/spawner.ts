// 访客生成节奏（设计文档「节奏」）：开局 SPAWN.first 秒进第一个，之后每 SPAWN.stagger 秒一个直到 SPAWN.target 人；
// 之后屋里（不算逃跑中的）不到 SPAWN.target 人时，安排一次 SPAWN.delay 范围内的随机延迟，同一时间只安排一次。
// 「一夜」（2026-10-30）加了两处，都默认关着，不给、不调就和原来一模一样（同一个种子抽随机数的次数、顺序都不变）：
// - 开局的间隔可以另给（openingGaps）：第一个人独自进来，过一会儿才有第二个敲门
// - 收夜（close）以后不再安排新访客，已经排上、还没进门的那一次取消；reopen 以后照常补人
import { NAMES, PERSONALITIES, SPAWN } from '../config/visitors';
import type { Rng } from './rng';
import type { Personality } from './types';

/** 时间比较的容差：固定步长累加会有浮点误差，2.0 秒可能算成 1.9999999 */
const EPS = 1e-6;

export class Spawner {
  private opening = true;
  private nextAt: number | null = SPAWN.first;
  /** 开局：排过几次下一个（第 k 次用 gaps[k]，用完了按 SPAWN.stagger） */
  private gapAt = 0;
  /** 收夜了：update 一律不放人，也不再安排 */
  private closed = false;
  private readonly rng: Rng;
  private readonly gaps: readonly number[];

  /** openingGaps：开局第 2、3… 个访客和前一个之间隔多久（秒，见 WorldOptions.openingGaps）；不给 = 每个都隔 SPAWN.stagger */
  constructor(rng: Rng, openingGaps: readonly number[] = []) {
    this.rng = rng;
    this.gaps = [...openingGaps];
  }

  /** 每步调用一次。time = 当前模拟时间，inHouse = 屋里不算逃跑中的人数。返回这一步要不要放一个访客进门 */
  update(time: number, inHouse: number): boolean {
    if (this.closed) return false;
    if (this.opening) {
      if (time + EPS < this.nextAt!) return false;
      const go = inHouse < SPAWN.target;
      if (inHouse + (go ? 1 : 0) < SPAWN.target) this.nextAt! += this.gaps[this.gapAt++] ?? SPAWN.stagger;
      else {
        this.opening = false;
        this.nextAt = null;
      }
      return go;
    }
    if (this.nextAt === null) {
      if (inHouse < SPAWN.target) this.nextAt = time + this.rng.range(SPAWN.delay[0], SPAWN.delay[1]);
      return false;
    }
    if (time + EPS < this.nextAt) return false;
    this.nextAt = null;
    // 等待期间人数可能已经够了（比如调试时手动放了人）
    return inHouse < SPAWN.target;
  }

  /** 收夜：之后不再放人，已经排上、还没进门的那一次取消（开局还没排完的也一样） */
  close(): void {
    this.closed = true;
    this.nextAt = null;
  }

  /**
   * 收夜以后玩家选 Keep haunting：照常补人——和开局之后一样，屋里不到 SPAWN.target 人就安排一次 SPAWN.delay 范围内的延迟，
   * 一个一个来；开局不再重来（不会又按 first、stagger 连着进三个）。没收夜时什么都不做，不打乱已经排好的
   */
  reopen(): void {
    if (!this.closed) return;
    this.closed = false;
    this.opening = false;
    this.nextAt = null;
  }
}

/**
 * 一夜里「最近进来过的」要避开几个名字：名字池 NAMES 的一半，连着进来的 25 个人里不会有两个同名。
 * 名字池不能比它加屋里最多的人数（SPAWN.target）还小，见 tests/night.test.ts
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
