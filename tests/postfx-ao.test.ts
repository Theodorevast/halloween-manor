// 第二波路 PX（ART-4、ART-7）：AO 乘到直射光上当接触阴影（postfx.ts buildHigh）、泛光收紧以后光源还在阈值上面。
// 着色器里没法在 node 里跑：AO 的保护曲线在 postfx.ts 里写成了同一条数学的纯函数（aoDirectWeight / aoDirectFactor），这里守它的形状；
// 光源的亮度（手电镜片、台灯泡）要留在泛光阈值和 AO 保护区间上面，不然收紧泛光 / 把 AO 乘到整幅画面以后，光源本身反而被压暗、不晕了。
import * as THREE from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { AO, BLOOM, aoDirectFactor, aoDirectWeight } from '../src/engine/postfx';
import { PALETTE } from '../src/view/palette';

// tsconfig 的 types 里只有 vite/client、没有 node 的类型：用变量当模块名取 node:fs（tests/overlays.test.ts 同样的写法）
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL, encoding: 'utf8'): string };

/** 线性亮度（Rec.709，和着色器里 luminance() 的系数一样） */
const lum = (c: { r: number; g: number; b: number }) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

describe('AO 乘到直射光上的权重（ART-4）', () => {
  const [p0, p1] = AO.protect;

  it('保护区间是个正的区间，权重上限 AO.direct 不超过 0.5（最多把一个像素压暗一半）', () => {
    expect(p0).toBeGreaterThan(0);
    expect(p1).toBeGreaterThan(p0);
    expect(AO.direct).toBeGreaterThan(0);
    expect(AO.direct).toBeLessThanOrEqual(0.5);
  });

  it('暗处和普通受光面（亮度不到 protect[0]）满额：权重 = AO.direct', () => {
    for (const y of [0, 0.01, 0.05, 0.3, p0 * 0.99, p0]) expect(aoDirectWeight(y)).toBeCloseTo(AO.direct, 10);
  });

  it('亮度到 protect[1] 以上（灯罩、镜片、光斑正中）不乘：权重 = 0', () => {
    for (const y of [p1, p1 * 1.01, 3, 10, 1000]) expect(aoDirectWeight(y)).toBe(0);
  });

  it('保护区间里平滑地单调往下走（中点正好一半），没有台阶、没有回升', () => {
    expect(aoDirectWeight((p0 + p1) / 2)).toBeCloseTo(AO.direct / 2, 10);
    let prev = Infinity;
    for (let i = 0; i <= 400; i++) {
      const w = aoDirectWeight((i / 400) * (p1 * 1.5));
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(AO.direct + 1e-12);
      prev = w;
    }
  });

  it('strength 是乘数：0（AO 关、Low 档、还没算出来、画布刚换尺寸）= 一点都不乘；调试里 aoStrength(0.5) 就是一半', () => {
    for (const y of [0, 0.5, 1.4]) {
      expect(aoDirectWeight(y, 0)).toBe(0);
      expect(aoDirectWeight(y, 0.5)).toBeCloseTo(aoDirectWeight(y) / 2, 10);
    }
  });

  it('最终倍数 = mix(1, ao, k)：没有遮挡（ao = 1）原样；全遮挡（ao = 0）的暗处最多压掉 AO.direct，雾和鬼魂叠在墙角时不会被压没', () => {
    for (const y of [0, 0.4, 1.4, 5]) expect(aoDirectFactor(1, y)).toBe(1);
    expect(aoDirectFactor(0, 0)).toBeCloseTo(1 - AO.direct, 10);
    expect(aoDirectFactor(0, 0)).toBeGreaterThanOrEqual(0.5);
    // 遮挡越重越暗，单调
    let prev = 2;
    for (let i = 0; i <= 20; i++) {
      const f = aoDirectFactor(1 - i / 20, 0.2);
      expect(f).toBeLessThanOrEqual(prev + 1e-12);
      prev = f;
    }
    // 亮的光源：遮挡再重也不动
    expect(aoDirectFactor(0, p1)).toBe(1);
  });
});

describe('光源留在泛光阈值和 AO 保护区间上面（ART-7 配 ART-4）', () => {
  it('泛光阈值收到只有光源才过：比普通受光面（最亮 ~1）高，软过渡的宽度也在', () => {
    expect(BLOOM.threshold).toBeGreaterThan(1.5);
    expect(BLOOM.smoothWidth).toBeGreaterThan(0);
    // AO 的保护区间不能比泛光阈值还高：晕开的光源一定不被 AO 压暗
    expect(AO.protect[1]).toBeLessThanOrEqual(BLOOM.threshold);
  });

  it('手电镜片：亮度（亮芯色 × 增益）在泛光阈值和 AO 保护上限之上，还能晕出一点', async () => {
    vi.resetModules();
    const [flash, reg] = await Promise.all([import('../src/view/flashlight'), import('../src/view/torches')]);
    const parent = new THREE.Group();
    const fl = flash.createFlashlight(parent, 'high', 1);
    const lens = fl.hand.children.find((c) => c.name === 'torch-lens')!;
    const lensColor = lens.userData.lensColor as THREE.Color;
    // 初值（还没 update 过）和 update 之后（torchDim = 1）都得是这个亮度：两处写的增益要一致
    expect(lum(lensColor)).toBeGreaterThan(BLOOM.threshold);
    expect(lum(lensColor)).toBeGreaterThanOrEqual(AO.protect[1]);
    reg.torchDim.fill(1);
    fl.update({ x: 5, y: 0.8, z: 5, dir: 0, power: 1, nervous: false }, 1 / 60, 0);
    // 在 update 之前亮度不一样也行，但 update 之后（torchDim 刚好 = 1 时颜色不重算，沿用初值）仍要在阈值上
    expect(lum(lensColor)).toBeGreaterThan(BLOOM.threshold);
    // 压暗（torchDim 0.3）：跟着暗，不是定死的
    reg.torchDim.fill(0.3);
    fl.update({ x: 5, y: 0.8, z: 5, dir: 0, power: 1, nervous: false }, 1 / 60, 1 / 60);
    expect(lum(lensColor)).toBeLessThan(BLOOM.threshold);
    reg.torchDim.fill(1);
    fl.dispose();
  });

  it('台灯泡：峰值亮度（灯色 × (glow 乘数 + 底)）在泛光阈值和 AO 保护上限之上（lamp.ts 里那一行的数）', () => {
    const src = readFileSync(new URL('../src/view/props/lamp.ts', import.meta.url), 'utf8');
    const m = /bulbMat\.colorNode\s*=\s*color\(PALETTE\.lamp\)\.mul\(glow\.mul\(([\d.]+)\)\.add\(([\d.]+)\)\)/.exec(src);
    expect(m, '找不到灯泡那一行：bulbMat.colorNode = color(PALETTE.lamp).mul(glow.mul(增益).add(底))').not.toBeNull();
    const peak = lum(new THREE.Color(PALETTE.lamp)) * (Number(m![1]) + Number(m![2]));
    expect(peak).toBeGreaterThan(BLOOM.threshold);
    expect(peak).toBeGreaterThanOrEqual(AO.protect[1]);
  });
});
