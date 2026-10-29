// 第二波路 PX（FEEL-8）：贴近发毛时访客也呼出白气。breath.ts 的 breathLevel(fear, uneasy) 是「谁在呼气、呼多重」的那一步：
// null = 不呼；0..1 = 强度（给 interval / 每口气几团用）。纯函数，没有渲染、没有随机。
import { describe, expect, it } from 'vitest';
import { FEAR } from '../src/config/visitors';
import { BREATH, breathLevel } from '../src/view/particles/breath';

/** 以前的取法（恐惧值过了紧张线，按紧张线到 FEAR.max 之间的位置）：没有发毛的时候，新函数必须和它一模一样 */
const fearOnly = (fear: number) => Math.min(1, Math.max(0, (fear - FEAR.nervous) / (FEAR.max - FEAR.nervous)));

describe('breathLevel：谁在呼气、呼多重（FEAR.nervous 以前就有，chillFrom / chillMax 是发毛那一条）', () => {
  it('发毛的两个数在设计值上：0.25 起算、最强 0.6（比恐惧值满了的 1 淡得多）', () => {
    expect(BREATH.chillFrom).toBe(0.25);
    expect(BREATH.chillMax).toBe(0.6);
  });

  it('不怕（恐惧值不到紧张线）、鬼魂也没贴近（发毛不到 chillFrom）：不呼', () => {
    expect(breathLevel(0, 0)).toBeNull();
    expect(breathLevel(FEAR.nervous - 0.01, 0)).toBeNull();
    expect(breathLevel(30, BREATH.chillFrom - 0.01)).toBeNull();
    expect(breathLevel(FEAR.nervous - 0.01, BREATH.chillFrom - 0.001)).toBeNull();
  });

  it('发毛缺省（娃娃屋没有鬼魂，npc.uneasy 不存在）按 0：和只看恐惧值时一样', () => {
    expect(breathLevel(10)).toBeNull();
    expect(breathLevel(FEAR.nervous)).toBe(0);
    expect(breathLevel(80)).toBeCloseTo(fearOnly(80), 12);
  });

  it('恐惧值过了紧张线、没有发毛：和以前一模一样（紧张线上 0，FEAR.max 是 1，线性），超过 FEAR.max 也封在 1', () => {
    for (const fear of [FEAR.nervous, 61, 70, 80, 90, FEAR.max, FEAR.max + 20]) {
      expect(breathLevel(fear, 0)).toBeCloseTo(fearOnly(fear), 12);
      expect(breathLevel(fear, BREATH.chillFrom - 0.01)).toBeCloseTo(fearOnly(fear), 12); // 发毛没到线，不改变它
    }
    expect(breathLevel(FEAR.nervous, 0)).toBe(0);
    expect(breathLevel(FEAR.max, 0)).toBe(1);
    expect(breathLevel(FEAR.max + 20, 0)).toBe(1);
  });

  it('恐惧值没过线、鬼魂贴着（发毛 ≥ chillFrom）：呼；强度从 chillFrom 处的 0 线性涨到发毛 1 时的 chillMax', () => {
    expect(breathLevel(0, BREATH.chillFrom)).toBe(0); // 刚进范围：呼，但是最慢的节奏
    expect(breathLevel(0, 1)).toBeCloseTo(BREATH.chillMax, 12);
    // 分析里的两个例子：发毛 0.7（0.8 米、身后）≈ 0.36，满 1 ≈ 0.6
    expect(breathLevel(0, 0.7)).toBeCloseTo(0.36, 12);
    // 中点
    expect(breathLevel(0, (BREATH.chillFrom + 1) / 2)).toBeCloseTo(BREATH.chillMax / 2, 12);
  });

  it('间隔照 BREATH.every 内插：发毛 0.7 约 1.9 秒一口，满 1 约 1.4 秒一口（贴得越近喘得越急，但还是比吓破胆的 0.72 秒慢得多）', () => {
    const every = (f: number) => BREATH.every[0] + (BREATH.every[1] - BREATH.every[0]) * f;
    expect(every(breathLevel(0, 0.7)!)).toBeGreaterThan(1.8);
    expect(every(breathLevel(0, 0.7)!)).toBeLessThan(2.0);
    expect(every(breathLevel(0, 1)!)).toBeGreaterThan(1.3);
    expect(every(breathLevel(0, 1)!)).toBeLessThan(1.5);
    expect(every(breathLevel(0, 1)!)).toBeGreaterThan(BREATH.every[1] * 1.5);
  });

  it('恐惧和发毛都有：取大的，不相加（贴着一个已经吓得发抖的人，不会比他自己吓破胆时更急）', () => {
    expect(breathLevel(90, 1)).toBeCloseTo(Math.max(fearOnly(90), BREATH.chillMax), 12); // 恐惧值那条更大
    expect(breathLevel(FEAR.nervous + 2, 1)).toBeCloseTo(BREATH.chillMax, 12); // 发毛那条更大
    for (const fear of [0, 40, 61, 75, 100]) {
      for (const u of [0, 0.3, 0.6, 1]) {
        const v = breathLevel(fear, u);
        if (v === null) continue;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
        expect(v).toBeGreaterThanOrEqual(fearOnly(fear) - 1e-12);
      }
    }
  });

  it('对发毛、对恐惧值都单调不降；只有发毛时永远不超过 chillMax（超出范围的发毛值也不超）', () => {
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      const v = breathLevel(0, i / 40);
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeLessThanOrEqual(BREATH.chillMax + 1e-12);
      prev = v;
    }
    expect(breathLevel(0, 3)).toBeCloseTo(BREATH.chillMax, 12);
    prev = -1;
    for (let fear = FEAR.nervous; fear <= FEAR.max; fear += 2) {
      const v = breathLevel(fear, 0.4)!;
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = v;
    }
  });
});
