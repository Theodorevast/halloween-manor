// 第二波路 VX：手电贴近时的过曝（深红沙发上一块发粉的光斑、eye G-9 侧面一大块橙色光斑）和手电的影子（eye G-4 纯黑、边缘破碎）。
// 着色器那一半（聚光灯的 colorNode）靠截图验收（lane-VX-shots 的 t*、s01）；这里守 CPU 上同一个式子 torchNearK 的形状，
// 和两盏灯确实接上了：colorNode、外圈的影子留光、PCF 半径
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { TORCH, createFlashlight, torchNearK } from '../src/view/flashlight';

const H = TORCH.halo.intensity, C = TORCH.core.intensity;
/** 光轴上两盏灯合起来的照度（不算光锥边缘）：改了以后 / 原来 */
const E = (d: number) => (H * torchNearK(d, TORCH.near.halo) + C * torchNearK(d, TORCH.near.core)) * Math.pow(d, -TORCH.decay);
const E0 = (d: number) => (H + C) * Math.pow(d, -TORCH.decay);

describe('手电贴近时压暗（torchNearK）', () => {
  for (const [name, n] of Object.entries(TORCH.near)) {
    it(`${name}：系数在 0..1 之间，离得越远越接近 1（单调不减）；照度再近也不超过 near 米处原来的水平，离得越近只增不减`, () => {
      let prevK = 0, prevE = Infinity;
      const cap = Math.pow(n, -TORCH.decay);
      for (let d = 0.02; d <= 9; d += 0.01) {
        const k = torchNearK(d, n);
        expect(k).toBeGreaterThan(0);
        expect(k).toBeLessThanOrEqual(1);
        expect(k).toBeGreaterThanOrEqual(prevK - 1e-12);
        prevK = k;
        const e = k * Math.pow(d, -TORCH.decay);
        expect(e).toBeLessThanOrEqual(cap * (1 + 1e-9));
        expect(e).toBeLessThanOrEqual(prevE + 1e-12);
        prevE = e;
      }
    });
  }

  it('近处明显暗下来（两盏合起来，光轴上）：半米处的照度不到原来的两成半，1 米处不到一半；贴得再近，照度也不超过光斑落地处（aim 米）的两倍', () => {
    expect(E(0.5) / E0(0.5)).toBeLessThan(0.25);
    expect(E(1) / E0(1)).toBeLessThan(0.5);
    for (const d of [0.05, 0.1, 0.2, 0.4, 0.8, 1.2]) expect(E(d)).toBeLessThan(E(TORCH.aim) * 2);
  });

  it('远处几乎不变：光斑落地的地方（TORCH.aim 米）差不到 4%，2 米处差不到 30%；亮芯收得比外圈多（光斑主要是亮芯）', () => {
    expect(E(TORCH.aim) / E0(TORCH.aim)).toBeGreaterThan(0.96);
    expect(E(2) / E0(2)).toBeGreaterThan(0.7);
    expect(TORCH.near.core).toBeGreaterThan(TORCH.near.halo);
  });
});

describe('两盏灯接上了：贴近压暗、影子留光', () => {
  it('外圈、亮芯都带 colorNode（贴近压暗）；外圈的影子只挡掉一部分光、边缘按 PCF 半径软一点', () => {
    const parent = new THREE.Group();
    const f = createFlashlight(parent, 'high', 0);
    const spots = parent.children.filter((o): o is THREE.SpotLight => (o as THREE.SpotLight).isSpotLight === true);
    expect(spots.length).toBe(2);
    for (const s of spots) expect(typeof (s as unknown as { colorNode?: unknown }).colorNode).toBe('function');
    const halo = spots.find((s) => s.castShadow)!;
    expect(halo).toBeTruthy();
    expect(halo.shadow.intensity).toBe(TORCH.shadow.intensity);
    expect(halo.shadow.intensity).toBeGreaterThan(0.7);
    expect(halo.shadow.intensity).toBeLessThan(1);
    expect(halo.shadow.radius).toBe(TORCH.shadow.radius);
    expect(halo.shadow.radius).toBeGreaterThanOrEqual(1.5);
    // 亮芯不投影：它的阴影相机只用来判断「在不在光锥投影范围里」，近平面要比贴着手电的那几厘米还近
    const core = spots.find((s) => !s.castShadow)!;
    expect(core.shadow.camera.near).toBeLessThanOrEqual(0.05);
    f.dispose();
  });
});
