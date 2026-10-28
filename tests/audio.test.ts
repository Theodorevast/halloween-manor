// 声音的纯数值部分（WebAudio 节点在 node 里没有，合成本身靠 dev/audio.html 的离线渲染量；这里只守几个不该悄悄变掉的约定）
import { describe, expect, it } from 'vitest';
import { CELL, FURNITURE } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { FEAR, MANIFEST } from '../src/config/visitors';
import { BREATH, breathPeriod, breathStrength, closeGain } from '../src/audio/breath';
import { MANIFEST_SFX } from '../src/audio/ghost';
import { BED, TRIGGER, pillowSpot } from '../src/audio/sfx';

const db = (x: number) => 20 * Math.log10(x);

describe('喘气：周期、强度、距离', () => {
  it('周期从 FEAR.nervous 的 2.2 秒线性缩到 FEAR.max 的 1.3 秒，范围外夹住', () => {
    expect(breathPeriod(FEAR.nervous)).toBeCloseTo(2.2, 6);
    expect(breathPeriod(FEAR.max)).toBeCloseTo(1.3, 6);
    expect(breathPeriod((FEAR.nervous + FEAR.max) / 2)).toBeCloseTo(1.75, 6);
    expect(breathPeriod(0)).toBe(breathPeriod(FEAR.nervous));
    expect(breathPeriod(500)).toBe(breathPeriod(FEAR.max));
    let prev = Infinity;
    for (let f = FEAR.nervous; f <= FEAR.max; f += 5) {
      const p = breathPeriod(f);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });

  it('强度随恐惧值涨，在 strength 范围内', () => {
    expect(breathStrength(FEAR.nervous)).toBeCloseTo(BREATH.strength[0], 6);
    expect(breathStrength(FEAR.max)).toBeCloseTo(BREATH.strength[1], 6);
    expect(breathStrength(80)).toBeGreaterThan(breathStrength(65));
  });

  it('凑近才听得见：full 米以内满音量、far 米以外没有、2 米处至少轻 15 dB、单调不增', () => {
    expect(closeGain(0)).toBe(1);
    expect(closeGain(BREATH.full)).toBe(1);
    expect(closeGain(BREATH.far)).toBe(0);
    expect(closeGain(10)).toBe(0);
    expect(closeGain(Number.NaN)).toBe(0);
    expect(db(closeGain(2))).toBeLessThan(-15);
    expect(closeGain(2)).toBeGreaterThan(BREATH.minGain / 4);
    let prev = 1;
    for (let d = 0; d <= 3; d += 0.1) {
      const g = closeGain(d);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
  });

  it('呜咽的恐惧值门槛（FEAR.dread）在喘气（FEAR.nervous）之上', () => {
    expect(FEAR.dread).toBeGreaterThan(FEAR.nervous);
    expect(FEAR.nervous - BREATH.hyst).toBeGreaterThan(0);
  });
});

describe('床：声音的时间线', () => {
  it('每种物件都有声音（TRIGGER 的键和 SCARES 的键一样）', () => {
    expect(Object.keys(TRIGGER).sort()).toEqual(Object.keys(SCARES).sort());
  });

  it('呼吸在落下前 0.6 秒以上就屏住（调研原则 11：先抽空再落下，前脉冲抑制）', () => {
    expect(SCARES.bed.hitAt - (BED.breathAt + BED.breathDur)).toBeGreaterThanOrEqual(0.6);
  });

  it('布料摩擦三段依次开始，都在落下之前收尾；呼吸在最后一段摩擦收尾前后开始', () => {
    const starts = BED.rise.map((r) => r[0]);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    for (const [a, peak, b] of BED.rise) {
      expect(a).toBeLessThan(peak);
      expect(peak).toBeLessThan(b);
      expect(b).toBeLessThan(SCARES.bed.hitAt - 0.6);
    }
    expect(BED.breathAt).toBeGreaterThanOrEqual(BED.rise[BED.rise.length - 1][1]);
  });

  it('枕头在床的矩形里，并且比床的中心更靠西墙（床头朝西）', () => {
    const bed = FURNITURE.find((f) => f.id === 'bedroom-bed')!;
    const p = pillowSpot()!;
    const { x0, z0, x1, z1 } = bed.rect;
    expect(p.x).toBeGreaterThan(x0 * CELL);
    expect(p.x).toBeLessThan(x1 * CELL);
    expect(p.z).toBeGreaterThan(z0 * CELL);
    expect(p.z).toBeLessThan(z1 * CELL);
    expect(p.x).toBeLessThan(((x0 + x1) / 2) * CELL);
  });
});

describe('现身：声音的时间线', () => {
  it('灯暗的咔哒都落在蓄力那段里、按先后排', () => {
    const c = MANIFEST_SFX.clicks;
    expect([...c].sort((a, b) => a - b)).toEqual([...c]);
    for (const t of c) {
      expect(t).toBeGreaterThan(0);
      expect(t).toBeLessThan(MANIFEST.windup);
    }
  });

  it('保险时间比蓄力 + 停留长，环境声回来的参数是正数', () => {
    expect(MANIFEST_SFX.maxLife).toBeGreaterThan(MANIFEST.windup + MANIFEST.hold);
    const h = MANIFEST_SFX.hush;
    expect(h.db).toBeLessThan(0);
    for (const v of [h.down, h.back, h.up]) expect(v).toBeGreaterThan(0);
  });

  it('持续音是小二度：两个频率差约 1 个半音', () => {
    const [lo, hi] = MANIFEST_SFX.drone.hz;
    expect(12 * Math.log2(hi / lo)).toBeCloseTo(1, 1);
  });
});
