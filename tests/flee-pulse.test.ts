// 第二波路 VX（newbie S2、eye S-2「吓跑人时整屏闪成暗红色，像受击红屏」）：吓跑一个人时的画面反馈。
// - juice.ts：不再是暗红，换成很淡的冷色暗角；镜头一抖还在，但小一些；几个人接连吓跑不叠加（震动和暗角都取最大、不相加）
// - postfx.ts 的暗角脉冲（createPulseEnvelope）：浓度不超过最大的那一下；任意 1 秒内画面边缘暗下去不超过 3 下
//   （lightfx 的 countDips，60 Hz，和灯闪同一个口径）
// 着色器里怎么混颜色靠截图验收（lane-VX-shots 的 f*）；这里守数和节奏
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJuice } from '../src/engine/juice';
import { PULSE, createPulseEnvelope } from '../src/engine/postfx';
import type { CameraRig, RenderCore } from '../src/engine/types';
import type { SimEvent, WorldState } from '../src/sim/types';
import { countDips } from '../src/view/lightfx';

const HZ = 60;
const DT = 1 / HZ;
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** 假的镜头和画面：记下 shake、vignettePulse 收到的参数 */
function fakes() {
  const shakes: number[] = [];
  const pulses: { strength: number; color: number | undefined }[] = [];
  const rig = { shake: (a: number) => shakes.push(a) } as unknown as CameraRig;
  const core = { fx: { vignettePulse: (strength: number, color?: number) => pulses.push({ strength, color }), setReveal() {} } } as unknown as RenderCore;
  return { rig, core, shakes, pulses };
}
const flee = (id = 1): SimEvent => ({ type: 'flee', npc: id }) as SimEvent;
const state = {} as WorldState;
/** 假时钟：juice.ts 按 performance.now 算上一下震动还剩多少 */
const clock = () => {
  let t = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => t);
  return { advance: (seconds: number) => { t += seconds * 1000; } };
};

describe('吓跑一个人：juice.ts', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('暗角是冷色、很暗，不是红的（原来是 PALETTE.dread 的暗红 0x5a0a0a）', () => {
    const f = fakes();
    const j = createJuice(f.rig, f.core);
    j.onEvent?.(flee(), state);
    expect(f.pulses.length).toBe(1);
    const hex = f.pulses[0].color;
    expect(hex).toBeTypeOf('number');
    const c = new THREE.Color(hex!);
    // 冷：蓝 ≥ 红，红不比绿多；暗：显示值的亮度不到 0.06（近黑，混进去只是压暗四角）
    expect(c.b).toBeGreaterThanOrEqual(c.r);
    expect(c.r).toBeLessThanOrEqual(c.g + 1e-6);
    const display = 0.2126 * ((hex! >> 16) & 255) / 255 + 0.7152 * ((hex! >> 8) & 255) / 255 + 0.0722 * (hex! & 255) / 255;
    expect(display).toBeLessThan(0.06);
    expect(lum(c)).toBeLessThan(0.01);
  });

  it('镜头还是会抖一下，但比原来（创伤值 0.6）小', () => {
    const f = fakes();
    const j = createJuice(f.rig, f.core);
    j.onEvent?.(flee(), state);
    expect(f.shakes.length).toBe(1);
    expect(f.shakes[0]).toBeGreaterThan(0.2);
    expect(f.shakes[0]).toBeLessThan(0.6);
  });

  it('几个人同一刻、接连吓跑：震动不叠加（加进去的创伤值合起来不超过一下）；抖完了再有人跑，照样再抖一下', () => {
    const f = fakes();
    const j = createJuice(f.rig, f.core);
    const c = clock();
    j.onEvent?.(flee(1), state);
    j.onEvent?.(flee(2), state);
    j.onEvent?.(flee(3), state);
    const one = f.shakes[0];
    expect(f.shakes.reduce((s, x) => s + x, 0)).toBeCloseTo(one, 10);
    // 0.15 秒后又一个：最多只补上这段时间衰减掉的（两台镜头的创伤值都是每秒退 1），加起来不超过「一下」的满幅
    c.advance(0.15);
    j.onEvent?.(flee(4), state);
    const added = f.shakes.slice(1).reduce((s, x) => s + x, 0);
    expect(added).toBeLessThanOrEqual(0.15 + 1e-9);
    // 抖完（两秒以后）再有人跑：又是完整的一下
    c.advance(2);
    const before = f.shakes.length;
    j.onEvent?.(flee(5), state);
    expect(f.shakes.length).toBe(before + 1);
    expect(f.shakes.at(-1)).toBeCloseTo(one, 10);
  });

  it('别的事件不管（惊吓、尖叫都不抖、不压暗）', () => {
    const f = fakes();
    const j = createJuice(f.rig, f.core);
    for (const type of ['startle', 'scream', 'exit', 'spawn']) j.onEvent?.({ type, npc: 1 } as unknown as SimEvent, state);
    expect(f.shakes).toEqual([]);
    expect(f.pulses).toEqual([]);
  });
});

/** 按 60 Hz 走一段：triggers 是触发的时刻（秒）和强度；返回每一帧的浓度 */
function run(triggers: [number, number][], seconds: number): number[] {
  const env = createPulseEnvelope();
  const out: number[] = [];
  const todo = [...triggers].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < Math.round(seconds * HZ); i++) {
    const t = i * DT;
    while (todo.length && todo[0][0] <= t + 1e-9) env.trigger(todo.shift()![1]);
    out.push(env.step(DT));
  }
  return out;
}
/** 画面四角的亮度系数：脉冲把四角往近黑的颜色混 maxMix × 浓度（最坏情况：颜色当作纯黑） */
const corner = (v: number[]) => v.map((x) => 1 - PULSE.maxMix * x);

describe('暗角脉冲的包络（postfx.ts 的 createPulseEnvelope）', () => {
  it('一下：慢慢收拢到 1、停一下、再慢慢退到 0，整段走完就是 0；浓度一直在 0..1 之间', () => {
    const v = run([[0, 1]], 3);
    const peak = Math.max(...v);
    expect(peak).toBeCloseTo(1, 6);
    for (const x of v) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(1 + 1e-12);
    }
    const total = PULSE.attack + PULSE.hold + PULSE.release;
    expect(v[Math.ceil((total + 0.05) * HZ)]).toBe(0);
    // 不是「被打了一下」：收拢至少 0.15 秒（第一帧不会就到顶）
    expect(PULSE.attack).toBeGreaterThanOrEqual(0.15);
    expect(v[0]).toBeLessThan(0.3);
  });

  it('不相加：同一刻来三下，和来一下一模一样；接连来的几下，浓度从不超过其中最大的那一下', () => {
    const one = run([[0, 1]], 3);
    const three = run([[0, 1], [0, 1], [0, 1]], 3);
    expect(three).toEqual(one);
    for (const gap of [0.05, 0.1, 0.2, 0.35, 0.5, 0.8]) {
      const v = run(Array.from({ length: 6 }, (_, k): [number, number] => [k * gap, 0.6]), 6);
      expect(Math.max(...v)).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    // 先来一下淡的、再来一下浓的：浓度到浓的那一下为止
    const v = run([[0, 0.4], [0.1, 0.9]], 3);
    expect(Math.max(...v)).toBeCloseTo(0.9, 6);
  });

  it('不跳变：接连触发时浓度一帧最多变一小步（不超过收拢那一段 smoothstep 的最大斜率 1.5 / attack）', () => {
    const maxStep = (1.5 / PULSE.attack / HZ) * 1.02;
    for (const gap of [0.03, 0.1, 0.25, 0.5, 0.7, 1.1]) {
      const v = run(Array.from({ length: 8 }, (_, k): [number, number] => [k * gap, 1]), 10);
      for (let i = 1; i < v.length; i++) expect(Math.abs(v[i] - v[i - 1])).toBeLessThan(maxStep);
    }
  });

  it('任意 1 秒内画面四角暗下去不超过 3 下（countDips，60 Hz；实际最多 2 下）：等间隔、随机地接连吓跑都算', () => {
    let worst = 0;
    for (let gap = 0.02; gap <= 1.5; gap += 0.01) {
      const v = run(Array.from({ length: Math.ceil(8 / gap) }, (_, k): [number, number] => [k * gap, 1]), 10);
      worst = Math.max(worst, countDips(corner(v), HZ));
    }
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 200; n++) {
      const tr: [number, number][] = [];
      for (let t = rnd() * 0.5; t < 8; t += 0.02 + rnd() * 0.9) tr.push([t, 0.3 + rnd() * 0.7]);
      worst = Math.max(worst, countDips(corner(run(tr, 10)), HZ));
    }
    expect(worst).toBeLessThanOrEqual(2);
    expect(worst).toBeGreaterThanOrEqual(1);
  });

  it('很淡：四角最多压暗 maxMix（≤ 0.35），画面中间（inner 以内）不动', () => {
    expect(PULSE.maxMix).toBeGreaterThan(0);
    expect(PULSE.maxMix).toBeLessThanOrEqual(0.35);
    expect(PULSE.inner).toBeGreaterThanOrEqual(0.35);
    expect(PULSE.outer).toBeGreaterThan(PULSE.inner);
  });
});
