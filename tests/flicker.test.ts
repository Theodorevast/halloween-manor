// 灯闪合规（2026-10-29 路 F）：附身台灯、台灯复原、访客紧张时的手电——任意 1 秒内最多暗 3 下（WCAG 2.3.1）。
// 数法和 tests/lightfx.test.ts 一样：lightfx.ts 的 countDips（60 Hz 采样，从高点掉 0.1 以上算一次），全项目的灯闪检查口径一致。
// 台灯、手电都是跑真的 createLamp / createFlashlight（node 里不渲染，只读它们写出来的亮度），不是只看表；
// 旧的两处（地址带 ?oldflicker 时还用它们，看样时对比新旧）也在这里量一遍：它们确实超了，这就是改的理由。
// 顺带钉住最终审查的两个小修：手电镜片跟着 torchDim 一起暗（V-M4）、手电多于登记表的槽数时只提醒一次（V-M5）
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST, SPAWN } from '../src/config/visitors';
import { lamp as lampSfx, rng, type Bus } from '../src/audio/sfx';
import type { RenderCore } from '../src/engine/types';
import type { ScareObjectState, WorldState } from '../src/sim/types';
import { NERVOUS_FLICKER, TORCH, nervousWave } from '../src/view/flashlight';
import { GHOST } from '../src/view/ghost';
import { LIGHTFX, countDips, createLightFx, dipStarts, letterLevel, thermal } from '../src/view/lightfx';
import { PALETTE } from '../src/view/palette';
import { FLICKER_END, LAMP_FLICKER, LAMP_FLICKER_OLD, LAMP_PATTERN, LAMP_RELIGHT, createLamp, sampleTable } from '../src/view/props/lamp';
import { TORCH_COUNT, torchDim, torches } from '../src/view/torches';

/** 要查的几种帧率：手机 30、常见 60、高刷 120 / 144（硬切的表和过了热惯性的亮度，数出来都不能超） */
const RATES = [30, 60, 120, 144];
const frames = (hz: number, seconds: number) => {
  // 秒数不是有限数就报错：NaN 会让采样数组悄悄变空，countDips([]) = 0，测试就空转通过了（缺了导出时真的发生过）
  if (!Number.isFinite(seconds)) throw new Error(`frames(${hz}, ${seconds})：秒数不是有限数`);
  return Math.round(seconds * hz);
};
/** 被附身的表演时长（秒）：lamp.ts 的 FLICKER_END 必须正好是它（见第一条测试）；其余测试都用这个字面值，缺了导出时也能量出真数 */
const END = 1.2;

/** 一个序列里每一次暗下去：起点（秒）和深度（最低点离 1 的距离）。回升判断和 dipStarts 是同一条规则 */
function dipList(levels: readonly number[], hz: number) {
  return dipStarts(levels, hz).map((at) => {
    const i = Math.round(at * hz);
    let low = levels[i];
    for (let j = i; j < levels.length && levels[j] <= low + 0.1; j++) low = Math.min(low, levels[j]);
    return { at, depth: 1 - low };
  });
}

/** 把模块全部重新载入：这几个模块的状态在模块级（?oldflicker 载入时读一次、手电的槽位计数全局共用），要隔开就得重新载入。search 给了就假装地址带着它 */
async function fresh(search = '') {
  vi.resetModules();
  if (search) vi.stubGlobal('location', { search });
  const [three, lamp, flash, reg] = await Promise.all([
    import('three/webgpu'),
    import('../src/view/props/lamp'),
    import('../src/view/flashlight'),
    import('../src/view/torches'),
  ]);
  return { three, lamp, flash, reg };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── 附身台灯 ────────────────────────────────────────────────────────────────

/** 一个真的台灯：run(秒, 帧率) 每帧 update 一次，返回每帧之后的亮度（灯罩的 glow，和 light.intensity 是同一个乘数） */
function lampRig() {
  const rig = createLamp(1);
  let light: THREE.PointLight | undefined;
  rig.model.traverse((o) => {
    if ((o as THREE.PointLight).isPointLight) light = o as THREE.PointLight;
  });
  const glow = (light!.userData.lightfx as { glow: { value: number } }).glow;
  const obj: ScareObjectState = { id: 'lamp', type: 'lamp', pos: { x: 0, z: 0 }, facing: 0, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 };
  let time = 0;
  return {
    rig, light: light!, glow, obj,
    /** 附身：和模拟层一样把 broken 设成剩余秒数（SCARES.lamp.broken）。不设的话，表演一结束 lamp.ts 的兜底以为灯已经修好了，自己就复原起来 */
    trigger() {
      obj.active = 1.5;
      obj.broken = 6;
      rig.trigger({} as WorldState, { type: 'trigger', object: 'lamp', scareType: 'lamp' });
    },
    run(seconds: number, hz: number) {
      const out: number[] = [];
      for (let k = 0; k < frames(hz, seconds); k++) {
        time += 1 / hz;
        rig.update({ dt: 1 / hz, time, obj, state: {} as WorldState });
        out.push(glow.value);
      }
      return out;
    },
  };
}

/** 表在 0 .. seconds 秒里每个采样点的亮度（硬切：每一段持续到下一段开始） */
const tableLevels = (tab: [number, number][], hz: number, seconds = END) =>
  Array.from({ length: frames(hz, seconds) }, (_, i) => sampleTable(tab, i / hz));
const OFF_AT = LAMP_FLICKER[LAMP_FLICKER.length - 1][0];

describe('附身台灯的闪烁表 LAMP_FLICKER（由节奏表推出来）', () => {
  it('形状不变（sfx.ts 照它放噼啪）：[开始秒, 亮度][]，开始时间递增，最后一项是熄灭，熄灭在 FLICKER_END 之前；FLICKER_END 仍是 1.2 秒', () => {
    expect(FLICKER_END).toBe(1.2);
    expect(LAMP_FLICKER.length).toBeGreaterThan(2);
    expect(LAMP_FLICKER[0][0]).toBe(0);
    for (const [at, v] of LAMP_FLICKER) {
      expect(Number.isFinite(at)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
    }
    for (let i = 1; i < LAMP_FLICKER.length; i++) expect(LAMP_FLICKER[i][0]).toBeGreaterThan(LAMP_FLICKER[i - 1][0]);
    expect(LAMP_FLICKER[LAMP_FLICKER.length - 1][1]).toBe(0);
    expect(OFF_AT).toBeLessThan(FLICKER_END);
  });

  it('是节奏表（LAMP_PATTERN，每秒 LIGHTFX.rate 个字母）推出来的：每个字母那一小段的亮度就是 letterLevel，字母放完就熄灭', () => {
    for (let i = 0; i < LAMP_PATTERN.length; i++) {
      expect(sampleTable(LAMP_FLICKER, (i + 0.5) / LIGHTFX.rate)).toBe(letterLevel(LAMP_PATTERN[i]));
    }
    expect(OFF_AT).toBeCloseTo(LAMP_PATTERN.length / LIGHTFX.rate, 9);
    expect(sampleTable(LAMP_FLICKER, OFF_AT + 0.01)).toBe(0);
  });

  it.each(RATES)('任意 1 秒最多暗 3 下，连最后熄灭那一下也算在内（硬切的表，%i Hz 采样）', (hz) => {
    expect(countDips(tableLevels(LAMP_FLICKER, hz), hz)).toBeLessThanOrEqual(3);
  });

  it('闪的过程里不全灭：熄灭之前每一段都不低于 LIGHTFX.floor', () => {
    for (const [, v] of LAMP_FLICKER.slice(0, -1)) expect(v).toBeGreaterThanOrEqual(LIGHTFX.floor - 1e-9);
  });

  it('像坏灯泡：暗的几下深浅不一、间隔不等；最后冲高一下（全表只有它最亮，不超过 LIGHTFX.ceil）再熄灭', () => {
    // 只看熄灭之前：最后那一下熄灭是「坏了」，不是闪
    const dips = dipList(tableLevels(LAMP_FLICKER, 120, OFF_AT - 0.001), 120);
    expect(dips.length).toBeGreaterThanOrEqual(2);
    expect(new Set(dips.map((d) => d.depth.toFixed(2))).size).toBeGreaterThan(1);
    const gaps = dips.slice(1).map((d, i) => +(d.at - dips[i].at).toFixed(2));
    expect(new Set(gaps).size).toBeGreaterThan(1);
    const peak = Math.max(...LAMP_FLICKER.map(([, v]) => v));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(LIGHTFX.ceil);
    expect(LAMP_FLICKER.filter(([, v]) => v === peak)).toHaveLength(1);
    expect(LAMP_FLICKER[LAMP_FLICKER.length - 2][1]).toBe(peak);
  });
});

describe('真的台灯被附身（createLamp，亮度过了钨丝的热惯性）', () => {
  it.each(RATES)('%i fps：任意 1 秒最多暗 3 下、过程中不全灭、最后冲高一下再熄灭', (hz) => {
    const L = lampRig();
    L.run(0.5, hz); // 先正常亮着
    L.trigger();
    const levels = L.run(END + 0.4, hz); // 连熄灭之后的 0.4 秒一起数
    expect(countDips(levels, hz)).toBeLessThanOrEqual(3);
    // 熄灭之前（那一帧之前）：永远不低于 floor，热惯性只会把变化抹平、不会冲破表里的值
    const lit = levels.slice(0, frames(hz, OFF_AT) - 1);
    expect(Math.min(...lit)).toBeGreaterThanOrEqual(LIGHTFX.floor - 1e-6);
    // 冲高那一档只有 0.1 秒：30 fps 才三帧，热惯性还没把它拉到 1 以上，所以只在 60 fps 以上要求看得出冲高
    if (hz >= 60) expect(Math.max(...levels)).toBeGreaterThan(1.05);
    expect(Math.max(...levels)).toBeLessThanOrEqual(LIGHTFX.ceil + 1e-6);
    expect(levels[levels.length - 1]).toBeLessThan(0.02);
  });

  it('钨丝的热惯性：台灯的亮度 = 表里的亮度每帧过 lightfx 的 thermal（变暗快、变亮慢一点），不是一帧硬切', () => {
    const hz = 60, dt = 1 / hz;
    const L = lampRig();
    L.trigger();
    const levels = L.run(END, hz);
    let t = 0, want = 1;
    for (let i = 0; i < levels.length; i++) {
      t += dt;
      want = thermal(want, t < END ? sampleTable(LAMP_FLICKER, t) : 0, dt);
      if (t <= END) expect(levels[i]).toBeCloseTo(want, 12);
    }
    // 第一档（比 1 暗）的头一帧只走了一部分
    expect(levels[0]).toBeLessThan(1);
    expect(levels[0]).toBeGreaterThan(LAMP_FLICKER[0][1]);
  });

  it('灯的强度和灯罩、灯泡的自发光（glow）是同一个乘数：一起暗、一起亮', () => {
    const L = lampRig();
    L.run(0.3, 60);
    const base = L.light.intensity / L.glow.value;
    L.trigger();
    for (let k = 0; k < 72; k++) {
      const [v] = L.run(1 / 60, 60);
      expect(L.light.intensity).toBeCloseTo(base * v, 9);
    }
  });
});

describe('台灯复原 LAMP_RELIGHT（也查一遍）', () => {
  it('形状不变：最后一段从 0.5 秒起（sfx.ts 的 warm、lamp.ts 的 0.15 秒预热爬升都按这个数）', () => {
    expect(LAMP_RELIGHT[LAMP_RELIGHT.length - 1]).toEqual([0.5, 1.0]);
  });

  it.each(RATES)('%i fps：从黑着复原，任意 1 秒最多暗 3 下（开头从全黑起步被算成的那一下也数进去），最后稳稳亮回', (hz) => {
    const L = lampRig();
    L.trigger();
    L.run(END + 0.2, hz);
    L.obj.broken = 6; // 坏着：一直黑
    L.run(0.3, hz);
    L.obj.broken = 0;
    L.rig.reset();
    const levels = L.run(1, hz);
    expect(countDips(levels, hz)).toBeLessThanOrEqual(3);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1.2 + 1e-6);
    expect(levels[levels.length - 1]).toBeGreaterThan(0.95);
  });
});

describe('旧的闪法（地址带 ?oldflicker 时用，看样对比；这里量一遍：它们确实超了，这就是改的理由）', () => {
  it('旧台灯表：1.2 秒里暗 9 下（任意 1 秒最多 8 下），最暗是全黑，最亮冲到 1.8', () => {
    const levels = tableLevels(LAMP_FLICKER_OLD, 60);
    expect(dipStarts(levels, 60)).toHaveLength(9);
    expect(countDips(levels, 60)).toBe(8);
    expect(Math.min(...levels)).toBe(0);
    expect(Math.max(...levels)).toBe(1.8);
  });

  it('默认用的是新的，不是旧的', () => {
    expect(LAMP_FLICKER).not.toEqual(LAMP_FLICKER_OLD);
    expect(TORCH.nervous.flicker).toBe(NERVOUS_FLICKER.safe);
  });
});

// ── 声音照同一张表放噼啪 ────────────────────────────────────────────────────

/** 只够 Snd 建图用的 WebAudio 替身（和 tests/audio.test.ts 的同一个做法），并记下 grainBuffer 写出的声轨（噼啪都在里面） */
class FakeParam {
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  detune = new FakeParam();
  Q = new FakeParam();
  pan = new FakeParam();
  offset = new FakeParam();
  playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  connect<T>(dest: T): T { return dest; }
  disconnect() {}
  start() {}
  stop() {}
}
class FakePeriodicWave {}
const tracks: Float32Array[] = [];
class FakeAudioBuffer {
  private readonly d: Float32Array;
  constructor(o: { length: number }) {
    this.d = new Float32Array(o.length);
    tracks.push(this.d);
  }
  getChannelData() { return this.d; }
}

/** 声轨里每一簇噼啪的起点（秒）：相隔 20 毫秒以上的静默算两簇 */
function crackleStarts(d: Float32Array, sr: number): number[] {
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) < 1e-9) continue;
    if (i - last > 0.02 * sr) out.push(i / sr);
    last = i;
  }
  return out;
}

describe('声音（audio/sfx.ts 的 lamp）照同一张表放噼啪：新表喂给真的 lamp 音效，照样读得出噼啪', () => {
  it('熄灭之前至少一声噼啪（亮度从暗跳到 ≥ 0.6），熄灭那一下的「啪」也在；表的最后一项当熄灭时刻、最亮的一项当冲高时刻', () => {
    for (const name of ['GainNode', 'StereoPannerNode', 'BiquadFilterNode', 'OscillatorNode', 'AudioBufferSourceNode', 'ConstantSourceNode']) vi.stubGlobal(name, FakeNode);
    vi.stubGlobal('PeriodicWave', FakePeriodicWave);
    vi.stubGlobal('AudioBuffer', FakeAudioBuffer);
    tracks.length = 0;
    const saved = rng.next;
    let s = 12345;
    rng.next = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); // 固定种子：每次数出来一样
    try {
      const bus = { ac: { sampleRate: 48000, currentTime: 0 }, sfx: new FakeNode(), voice: new FakeNode(), amb: new FakeNode(), reverb: new FakeNode(), noise: { duration: 4 }, pulse: {} } as unknown as Bus;
      const end = lampSfx(bus, 0, 0);
      // 声音在熄灭（表的最后一项）之后 0.35 秒收尾
      expect(end).toBeCloseTo(OFF_AT + 0.35, 6);
      expect(tracks).toHaveLength(1);
      const starts = crackleStarts(tracks[0], 48000);
      expect(starts.filter((t) => t < OFF_AT - 0.02).length).toBeGreaterThanOrEqual(1);
      expect(starts.some((t) => Math.abs(t - OFF_AT) < 0.02)).toBe(true);
    } finally {
      rng.next = saved;
    }
  });
});

// ── 访客紧张时的手电 ────────────────────────────────────────────────────────

/** 100 个种子，铺在 0..100（createFlashlight 里是 Math.random() * 100） */
const SEEDS = Array.from({ length: 100 }, (_, k) => k * 0.9731 + 0.13);
const waveLevels = (seed: number, depth: number, seconds = 30, hz = 60) =>
  Array.from({ length: seconds * hz }, (_, i) => 1 - depth * nervousWave(i / hz, seed));
const worstDips = (depth: number) => Math.max(...SEEDS.map((s) => countDips(waveLevels(s, depth), 60)));

describe('访客紧张时手电的亮度闪烁（TORCH.nervous.flicker）', () => {
  it('新的深度比 countDips 的门槛（0.1）还小：100 个种子 × 30 秒，任意 1 秒最多暗 3 下（实际一次都数不出来）', () => {
    expect(TORCH.nervous.flicker).toBeLessThan(0.1);
    expect(worstDips(TORCH.nervous.flicker)).toBeLessThanOrEqual(3);
    for (const hz of [30, 120]) expect(countDips(waveLevels(SEEDS[7], TORCH.nervous.flicker, 30, hz), hz)).toBeLessThanOrEqual(3);
  });

  it('旧的深度 0.22：100 个种子 × 30 秒，任意 1 秒最多暗到 4–5 下，几乎每个种子都超（所以才改）', () => {
    expect(NERVOUS_FLICKER.old).toBe(0.22);
    expect(worstDips(NERVOUS_FLICKER.old)).toBeGreaterThanOrEqual(5);
    expect(SEEDS.filter((s) => countDips(waveLevels(s, NERVOUS_FLICKER.old), 60) > 3).length).toBeGreaterThanOrEqual(90);
  });

  it('真的手电（createFlashlight + update，一直紧张 30 秒）：亮度也不超过每秒 3 下；同一支手电用旧的深度会超', async () => {
    const f = await fresh();
    const pose = { x: 5, y: 0.8, z: 5, dir: 0, power: 1, nervous: true };
    for (const seed of [3.7, 41.2, 77.7]) {
      const parent = new f.three.Group();
      const fl = f.flash.createFlashlight(parent, 'high', seed);
      const halo = parent.children.find((c) => (c as THREE.SpotLight).isSpotLight && c.castShadow) as THREE.SpotLight;
      const run = (depth: number, t0: number) => {
        f.flash.TORCH.nervous.flicker = depth;
        return Array.from({ length: 30 * 60 }, (_, i) => {
          fl.update(pose, 1 / 60, t0 + i / 60);
          return halo.intensity / f.flash.TORCH.halo.intensity;
        });
      };
      expect(countDips(run(f.flash.NERVOUS_FLICKER.old, 0), 60)).toBeGreaterThan(3);
      expect(countDips(run(f.flash.NERVOUS_FLICKER.safe, 100), 60)).toBeLessThanOrEqual(3);
    }
  });

  it('叠上现身的灯闪（lightfx 写的 torchDim：蓄力、落下、停留、收）也不超：100 个种子 × 现身放在 30 秒里的 3 个位置；旧的深度会叠成 4 下', () => {
    const M = GHOST.manifest, hz = 60, dt = 1 / hz;
    const scene = new THREE.Scene();
    const houseRoot = new THREE.Group();
    scene.add(houseRoot);
    const fx = createLightFx({ scene, houseRoot } as unknown as RenderCore);
    const saved = { ...torches[0] };
    const pos = { x: 1.6, z: 1.2 };
    Object.assign(torches[0], { x: 2.5, z: 1.5, power: 1 });
    const dim: number[] = [];
    try {
      let time = 0;
      const run = (seconds: number) => {
        for (let k = 0; k < Math.round(seconds / dt); k++) {
          time += dt;
          fx.update({ dt, time, state: {} as WorldState });
          dim.push(torchDim[0]);
        }
      };
      fx.pulse(pos, M.radius, M.windup, MANIFEST.windup);
      run(MANIFEST.windup);
      fx.dipAll(pos, M.radius, M.drop.depth, M.drop.ms);
      const release = fx.pulse(pos, M.radius, M.hold, MANIFEST.hold + M.holdSlack);
      run(MANIFEST.hold);
      release();
      fx.dipAll(pos, M.radius, M.end.depth, M.end.ms);
      run(1);
    } finally {
      Object.assign(torches[0], saved);
      fx.dispose();
    }
    expect(countDips(dim, hz)).toBeLessThanOrEqual(3); // 现身这一串自己就是 3 下，不能再多
    const stacked = (depth: number) => {
      let worst = 0;
      for (const seed of SEEDS) {
        for (const t0 of [0, 3.3, 17.9]) {
          worst = Math.max(worst, countDips(dim.map((d, i) => d * (1 - depth * nervousWave(t0 + i / hz, seed))), hz));
        }
      }
      return worst;
    };
    expect(stacked(TORCH.nervous.flicker)).toBeLessThanOrEqual(3);
    expect(stacked(NERVOUS_FLICKER.old)).toBeGreaterThanOrEqual(4);
  });
});

// ── 最终审查顺手修的两处（V-M4、V-M5）──────────────────────────────────────

describe('手电镜片跟着 torchDim 一起暗（V-M4）', () => {
  it('镜片的颜色 = 亮芯那盏灯此刻的颜色（暗下去时往暖红偏）× torchDim；亮回 1 就原样还原', async () => {
    const f = await fresh();
    const parent = new f.three.Group();
    const fl = f.flash.createFlashlight(parent, 'high', 1);
    const lens = fl.hand.children.find((c) => c.name === 'torch-lens')!;
    const lensColor = lens.userData.lensColor as THREE.Color;
    const core = parent.children.find((c) => (c as THREE.SpotLight).isSpotLight && !c.castShadow) as THREE.SpotLight;
    const pose = { x: 5, y: 0.8, z: 5, dir: 0, power: 1, nervous: false };
    const base = new f.three.Color(PALETTE.torchCore);

    f.reg.torchDim.fill(1);
    fl.update(pose, 1 / 60, 0);
    expect(lensColor.equals(base)).toBe(true);

    f.reg.torchDim.fill(0.3);
    fl.update(pose, 1 / 60, 1 / 60);
    expect(lensColor.r).toBeCloseTo(core.color.r * 0.3, 6);
    expect(lensColor.g).toBeCloseTo(core.color.g * 0.3, 6);
    expect(lensColor.b).toBeCloseTo(core.color.b * 0.3, 6);
    expect(Math.max(lensColor.r, lensColor.g, lensColor.b)).toBeLessThan(Math.max(base.r, base.g, base.b) * 0.35);
    expect(lensColor.b / lensColor.r).toBeLessThan(base.b / base.r); // 越暗越偏红，和两盏灯一致

    f.reg.torchDim.fill(1);
    fl.update(pose, 1 / 60, 2 / 60);
    expect(lensColor.equals(base)).toBe(true);
  });

  it('镜片材质所有手电共用一份（每支一份材质会各编一份着色器，开场多编几个）', async () => {
    const f = await fresh();
    const parent = new f.three.Group();
    const a = f.flash.createFlashlight(parent, 'high', 1);
    const b = f.flash.createFlashlight(parent, 'high', 2);
    const lensOf = (fl: typeof a) => fl.hand.children.find((c) => c.name === 'torch-lens') as THREE.Mesh;
    expect(lensOf(a).material).toBe(lensOf(b).material);
    expect(lensOf(a).userData.lensColor).not.toBe(lensOf(b).userData.lensColor);
  });
});

describe('手电多于登记表的槽数（V-M5）', () => {
  it('第 TORCH_COUNT + 1 支开始回绕、共用槽位：console.warn 一次，再多也只一次；不超过时不吭声', async () => {
    const f = await fresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parent = new f.three.Group();
    for (let i = 0; i < f.reg.TORCH_COUNT; i++) f.flash.createFlashlight(parent, 'high');
    expect(warn).not.toHaveBeenCalled();
    f.flash.createFlashlight(parent, 'high');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(String(f.reg.TORCH_COUNT));
    f.flash.createFlashlight(parent, 'high');
    f.flash.createFlashlight(parent, 'high');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('正常玩的时候不会碰到这条提醒：characters.ts 建的手电数（SPAWN.target + 1）不超过登记表的槽数；谁把 SPAWN.target 调大了，这里先变红', () => {
    expect(SPAWN.target + 1).toBeLessThanOrEqual(TORCH_COUNT);
  });
});

// ── ?oldflicker ──────────────────────────────────────────────────────────────

describe('?oldflicker（看样时对比新旧；node 里没有 location 也不会报错）', () => {
  it('地址带上：台灯表换回旧的、台灯硬切（第一帧就是旧表的 1.6，不过热惯性）、手电深度回到 0.22', async () => {
    const f = await fresh('?oldflicker');
    expect(f.lamp.LAMP_FLICKER).toEqual(f.lamp.LAMP_FLICKER_OLD);
    expect(f.flash.TORCH.nervous.flicker).toBe(f.flash.NERVOUS_FLICKER.old);
    const rig = f.lamp.createLamp(1);
    let light: THREE.PointLight | undefined;
    rig.model.traverse((o) => {
      if ((o as THREE.PointLight).isPointLight) light = o as THREE.PointLight;
    });
    const glow = (light!.userData.lightfx as { glow: { value: number } }).glow;
    const obj: ScareObjectState = { id: 'lamp', type: 'lamp', pos: { x: 0, z: 0 }, facing: 0, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 };
    rig.trigger({} as WorldState, { type: 'trigger', object: 'lamp', scareType: 'lamp' });
    rig.update({ dt: 1 / 60, time: 1 / 60, obj, state: {} as WorldState });
    expect(glow.value).toBe(1.6);
    // 旧的复原也是硬切：0 秒那一档是全黑
    rig.update({ dt: 1.3, time: 1.4, obj, state: {} as WorldState });
    rig.reset();
    rig.update({ dt: 0.1, time: 1.5, obj, state: {} as WorldState });
    expect(glow.value).toBe(1.1);
  });

  it('地址带别的参数、或者没有 location：都用新的', async () => {
    const withOther = await fresh('?debug&oldflickerX=1');
    expect(withOther.flash.TORCH.nervous.flicker).toBe(withOther.flash.NERVOUS_FLICKER.safe);
    expect(withOther.lamp.LAMP_FLICKER).not.toEqual(withOther.lamp.LAMP_FLICKER_OLD);
    vi.unstubAllGlobals();
    expect(typeof location).toBe('undefined');
    const none = await fresh();
    expect(none.flash.TORCH.nervous.flicker).toBe(none.flash.NERVOUS_FLICKER.safe);
    expect(none.lamp.LAMP_FLICKER).not.toEqual(none.lamp.LAMP_FLICKER_OLD);
  });
});
