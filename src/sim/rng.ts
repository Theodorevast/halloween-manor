// 带种子的随机数。模拟层所有随机都走这里，同一 seed、同一操作序列结果完全相同（测试可复现）。
// 算法是 mulberry32：32 位状态、够快、分布对游戏足够好。

export interface Rng {
  /** [0, 1) */
  next(): number;
  /** [a, b) */
  range(a: number, b: number): number;
  pick<T>(xs: readonly T[]): T;
  /** 按权重抽一个键；权重为 0 的永远抽不到 */
  weighted<K extends string>(w: Record<K, number>): K;
}

export function createRng(seed: number): Rng {
  // 大种子（Date.now()）取低 32 位
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('rng.pick: empty list');
      return xs[Math.floor(next() * xs.length)];
    },
    weighted<K extends string>(w: Record<K, number>): K {
      const keys = Object.keys(w) as K[];
      let total = 0;
      for (const k of keys) total += w[k];
      const r = next() * total;
      let acc = 0;
      for (const k of keys) {
        acc += w[k];
        if (r < acc) return k;
      }
      // 只有浮点误差会走到这里：返回最后一个权重 > 0 的
      for (let i = keys.length - 1; i >= 0; i--) if (w[keys[i]] > 0) return keys[i];
      throw new Error('rng.weighted: no positive weight');
    },
  };
}
