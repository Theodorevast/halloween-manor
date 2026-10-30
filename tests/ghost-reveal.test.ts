// 手电照出鬼魂的 CPU 那份（view/ghost.ts 的 torchRevealAt）：近处淡出（第二波 ART-3）。
// 访客的手电贴近鬼魂（不到 1 米）时，光锥的尖端落在鬼魂身上，照出的程度原来一下拉满；现在在 GHOST.reveal.near 米以内按 smoothstep 淡到 0。
// 着色器里（torchReveal）和这里（torchRevealAt）乘同一个，让 CPU 估的值（鬼魂墙上的影子、墙上多一个影子的判断 otherShadow.ts 的 ghostLit）
// 和画面一致。（美术总监分析里客厅沙发那几张的粉紫圆盘是手电聚光近距离打在沙发靠背上过曝出来的，把鬼魂藏掉它还在，不归这里管，见 GF 路报告）
import { describe, expect, it } from 'vitest';
import { VISION } from '../src/config/visitors';
import { GHOST, torchRevealAt } from '../src/view/ghost';
import type { TorchSample } from '../src/view/torches';

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 一支朝 +x 平放的手电（离地 1 米）：光锥半角 33°（外圈比访客的视野宽一点）、照程 9 米 */
const torch = (over: Partial<TorchSample> = {}): TorchSample => ({
  x: 0, y: 1, z: 0, dx: 1, dy: 0, dz: 0, angle: 0.58, range: 9, power: 1, ...over,
});

/**
 * 没有近处淡出时的公式（改之前的 torchRevealAt）：光锥 × 照程 × 强度 × 视线。照原样再写一遍当参照，
 * 不引用 ghost.ts 的常量以外的东西（半角、照程用访客的视野 VISION，见 ghost.ts 的 SEE_COS）
 */
function withoutNear(t: TorchSample, los: number, x: number, y: number, z: number): number {
  const R = GHOST.reveal;
  const seeCos = Math.cos(VISION.halfAngle);
  const lx = x - t.x, ly = y - t.y, lz = z - t.z;
  const d = Math.hypot(lx, ly, lz);
  const cosT = (lx * t.dx + ly * t.dy + lz * t.dz) / Math.max(d, 0.001);
  return smooth01(seeCos, lerp(seeCos, 1, R.edge), cosT) * (1 - smooth01(VISION.range * R.far, VISION.range, d)) * t.power * los;
}

/** 光轴上、离手电 d 米处的一点 */
const onAxis = (d: number, t = torch(), los = 1) => torchRevealAt(t, los, t.x + d * t.dx, t.y + d * t.dy, t.z + d * t.dz);

describe('手电照出鬼魂：近处淡出（torchRevealAt）', () => {
  it('参数：从 0.5 米淡入、1.4 米满（GHOST.reveal.near）', () => {
    expect(GHOST.reveal.near).toEqual([0.5, 1.4]);
  });

  it('0.5 米以内为 0：光轴正中、强度满、中间没有墙，也照不出来（含贴在手电上）', () => {
    for (const d of [0, 0.05, 0.2, 0.35, 0.49, 0.5]) expect(onAxis(d), `d = ${d}`).toBe(0);
    // 没有近处淡出时这些点本来是照满的：这条才是「近处淡出」起了作用，不是别的原因照不出
    for (const d of [0.2, 0.35, 0.49]) expect(withoutNear(torch(), 1, d, 1, 0), `d = ${d}`).toBeCloseTo(1, 6);
  });

  it('1.4 米以外和原来一模一样：光轴上、偏离光轴、强度不到 1、视线被平滑到一半，各取几个距离（到照程尽头）', () => {
    const t = torch({ power: 0.8 });
    for (const d of [1.4, 1.41, 1.8, 2.5, 3.6, 4.9, 5.5, 6.3, 6.9, 7.2]) {
      for (const off of [0, 0.15, 0.3, 0.45]) {
        // 偏离光轴：在 xz 平面里转 off 弧度
        const x = t.x + d * Math.cos(off), z = t.z + d * Math.sin(off);
        expect(torchRevealAt(t, 0.5, x, t.y, z), `d = ${d}, off = ${off}`).toBeCloseTo(withoutNear(t, 0.5, x, t.y, z), 12);
      }
    }
  });

  it('0.5 到 1.4 米之间：从 0 平滑地涨到满，一路单调不减，没有台阶（相邻 1 厘米最多差 0.04）', () => {
    let prev = 0;
    for (let d = 0.5; d <= 1.4001; d += 0.01) {
      const v = onAxis(d);
      expect(v, `d = ${d.toFixed(2)}`).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v - prev, `d = ${d.toFixed(2)}`).toBeLessThan(0.04);
      prev = v;
    }
    expect(prev).toBeCloseTo(1, 6);
    // 正中间（0.95 米）= smoothstep 的一半，不是 0 也不是满
    expect(onAxis(0.95)).toBeCloseTo(0.5, 6);
    // 贴近发毛那个距离（1 米）还剩一多半：被照出来的程度比原来（满）少，但还在
    expect(onAxis(1.0)).toBeGreaterThan(0.5);
    expect(onAxis(1.0)).toBeLessThan(0.7);
  });

  it('近处淡出是乘上去的：强度、视线、光锥都还管用（强度 0、视线 0、光锥外在近处仍是 0；半强度时是一半）', () => {
    expect(onAxis(1.0, torch({ power: 0 }))).toBe(0);
    expect(onAxis(1.0, torch(), 0)).toBe(0);
    expect(onAxis(1.0, torch({ power: 0.5 }), 1)).toBeCloseTo(onAxis(1.0) * 0.5, 12);
    // 光锥外（偏离光轴 60°）：近处也是 0
    const t = torch();
    expect(torchRevealAt(t, 1, t.x + Math.cos(1.05), t.y, t.z + Math.sin(1.05))).toBe(0);
  });

  it('2–5 米（被照出来的常见距离）和原来一样：画面上那个样子不变（ART-3 验收：a12 机位）', () => {
    for (let d = 2; d <= 5.0001; d += 0.25) {
      expect(onAxis(d), `d = ${d}`).toBeCloseTo(withoutNear(torch(), 1, d, 1, 0), 12);
    }
  });
});

describe('被照出的颜色（GHOST.reveal.warmColor / warm）：近中性，不往粉紫里偏', () => {
  it('暖色三个通道相差不到 15%（原来 (0.95, 0.8, 0.6) 差 37%，混进冷蓝的身体里变粉紫）', () => {
    const c = GHOST.reveal.warmColor;
    const hi = Math.max(c.r, c.g, c.b), lo = Math.min(c.r, c.g, c.b);
    expect((hi - lo) / hi).toBeLessThan(0.15);
    // 偏暖的方向没变：红 ≥ 绿 ≥ 蓝
    expect(c.r).toBeGreaterThanOrEqual(c.g);
    expect(c.g).toBeGreaterThanOrEqual(c.b);
  });

  it('混进去的量 0.22：照满（reveal = 1）时身体的颜色离冷白的芯不到 0.07（线性），原来（0.35）偏得更多', () => {
    const core = GHOST.core, w = GHOST.reveal.warmColor, k = GHOST.reveal.warm;
    expect(k).toBeCloseTo(0.22, 6);
    const shift = Math.max(Math.abs(lerp(core.r, w.r, k) - core.r), Math.abs(lerp(core.g, w.g, k) - core.g), Math.abs(lerp(core.b, w.b, k) - core.b));
    expect(shift).toBeLessThan(0.07);
  });
});
