// 访客生成节奏（设计文档「节奏」）：开局 SPAWN.first 秒进第一个，之后每 SPAWN.stagger 秒一个直到 SPAWN.target 人；
// 之后屋里（不算逃跑中的）不到 SPAWN.target 人时，安排一次 SPAWN.delay 范围内的随机延迟，同一时间只安排一次。
import { NAMES, PERSONALITIES, SPAWN } from '../config/visitors';
import type { Rng } from './rng';
import type { Personality } from './types';

/** 时间比较的容差：固定步长累加会有浮点误差，2.0 秒可能算成 1.9999999 */
const EPS = 1e-6;

export class Spawner {
  private opening = true;
  private nextAt: number | null = SPAWN.first;
  private readonly rng: Rng;

  constructor(rng: Rng) {
    this.rng = rng;
  }

  /** 每步调用一次。time = 当前模拟时间，inHouse = 屋里不算逃跑中的人数。返回这一步要不要放一个访客进门 */
  update(time: number, inHouse: number): boolean {
    if (this.opening) {
      if (time + EPS < this.nextAt!) return false;
      const go = inHouse < SPAWN.target;
      if (inHouse + (go ? 1 : 0) < SPAWN.target) this.nextAt! += SPAWN.stagger;
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
}

/** 从名字池里抽一个和 taken 不重名的；全被占了才允许重名 */
export function pickName(rng: Rng, taken: Iterable<string>): string {
  const used = new Set(taken);
  const free = NAMES.filter((n) => !used.has(n));
  return rng.pick(free.length > 0 ? free : NAMES);
}

const WEIGHTS = Object.fromEntries(
  (Object.keys(PERSONALITIES) as Personality[]).map((k) => [k, PERSONALITIES[k].weight]),
) as Record<Personality, number>;

/** 按 PERSONALITIES[*].weight 加权抽性格 */
export function pickPersonality(rng: Rng): Personality {
  return rng.weighted(WEIGHTS);
}
