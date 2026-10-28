// 灯闪（view/lightfx.ts）：节奏表的亮度、现身那一串灯闪守不守规矩（不全灭、不白闪、任意 1 秒最多暗 3 下）、
// 灯的强度被主人每帧改写时照样压得暗、效果结束后原样还回去；灯罩、灯笼的自发光跟着一起暗（评审 I3）。
// 用真的 three 场景（不渲染），按 ghost.ts 现身时的调用顺序走一遍
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { MANIFEST } from '../src/config/visitors';
import type { RenderCore } from '../src/engine/types';
import type { WorldState } from '../src/sim/types';
import { GHOST } from '../src/view/ghost';
import { LIGHTFX, countDips, createLightFx, dipStarts, letterLevel, patternDips, patternLevel } from '../src/view/lightfx';
import { TORCH_COUNT, torchDim, torches } from '../src/view/torches';

const M = GHOST.manifest;
const DT = 1 / 120;

function makeScene() {
  const scene = new THREE.Scene();
  const houseRoot = new THREE.Group();
  houseRoot.position.set(-8, 0, -6); // 和正式页面一样，房屋坐标的原点不在世界原点
  scene.add(houseRoot);
  const lamp = new THREE.PointLight(0xffb35c, 4.2, 4.8, 2);
  lamp.position.set(1, 1.3, 1);
  lamp.userData.lightfx = true;
  const far = new THREE.PointLight(0xffb35c, 1.8, 2.4, 2);
  far.position.set(12, 1.3, 10);
  far.userData.lightfx = true;
  const untagged = new THREE.PointLight(0xffffff, 3, 4, 2);
  untagged.position.set(1.2, 1, 1.2);
  houseRoot.add(lamp, far, untagged);
  const fx = createLightFx({ scene, houseRoot } as unknown as RenderCore);
  let time = 0;
  /** 走 seconds 秒；owner 模拟台灯自己每帧写强度（平时的轻闪），在 lightfx 之前 */
  const run = (seconds: number, out: number[] = [], owner?: (t: number) => void) => {
    for (let k = 0; k < Math.round(seconds / DT); k++) {
      time += DT;
      owner?.(time);
      fx.update({ dt: DT, time, state: {} as WorldState });
      out.push(lamp.intensity / 4.2);
    }
    return out;
  };
  return { scene, lamp, far, untagged, fx, run };
}

/** 按 ghost.ts 的 onManifest 走一遍现身：蓄力 → 落下（暗一下 + 停留时压着）→ 收（放开 + 暗一下）→ 再走 1 秒 */
function playManifest(s: ReturnType<typeof makeScene>, pos = { x: 1.6, z: 1.2 }) {
  const levels: number[] = [];
  s.fx.pulse(pos, M.radius, M.windup, MANIFEST.windup);
  s.run(MANIFEST.windup, levels);
  s.fx.dipAll(pos, M.radius, M.drop.depth, M.drop.ms);
  const release = s.fx.pulse(pos, M.radius, M.hold, MANIFEST.hold + M.holdSlack);
  s.run(MANIFEST.hold, levels);
  release();
  s.fx.dipAll(pos, M.radius, M.end.depth, M.end.ms);
  s.run(1, levels);
  return levels;
}

describe('节奏表', () => {
  it('a 最暗但不灭，m 正常，z 只冲高一点', () => {
    expect(letterLevel('a')).toBeCloseTo(LIGHTFX.floor);
    expect(letterLevel('m')).toBe(1);
    expect(letterLevel('z')).toBeCloseTo(LIGHTFX.ceil);
    expect(LIGHTFX.floor).toBeGreaterThan(0);
    expect(LIGHTFX.ceil).toBeLessThanOrEqual(1.25);
    for (let c = 98; c <= 122; c++) expect(letterLevel(String.fromCharCode(c))).toBeGreaterThan(letterLevel(String.fromCharCode(c - 1)));
  });
  it('每秒 10 个字母，放完从头再来', () => {
    expect(patternLevel('ma', 0.05)).toBe(1);
    expect(patternLevel('ma', 0.15)).toBeCloseTo(LIGHTFX.floor);
    expect(patternLevel('ma', 0.25)).toBe(1);
  });
  it('停留时压着的那一档在 40% 左右（设计文档）', () => {
    expect(letterLevel(M.hold)).toBeGreaterThan(0.35);
    expect(letterLevel(M.hold)).toBeLessThan(0.5);
  });
  it('蓄力只放 MANIFEST.windup 秒：暗两三下，压到 30–50%', () => {
    const seq = Array.from({ length: Math.round(MANIFEST.windup * 100) }, (_, i) => patternLevel(M.windup, i / 100));
    const dips = countDips(seq, 100);
    expect(dips).toBeGreaterThanOrEqual(2);
    expect(dips).toBeLessThanOrEqual(3);
    expect(Math.min(...seq)).toBeGreaterThanOrEqual(0.3 - 1e-9);
    expect(Math.min(...seq)).toBeLessThanOrEqual(0.5);
  });
});

describe('countDips', () => {
  it('从高点往下掉 10% 以上算一次，回升以后再掉才算下一次', () => {
    expect(countDips([1, 1, 0.3, 1, 0.3, 1], 10)).toBe(2);
    expect(countDips([1, 0.95, 1, 0.95], 10)).toBe(0); // 5% 的抖动不算
    expect(countDips([1, 0.4, 0.4, 0.2, 1], 10)).toBe(1); // 一路往下是一次
    expect(countDips([0.42, 0.42, 0.2, 1], 10)).toBe(1); // 从压着的 42% 再暗一下也算
    // 隔得超过 1 秒的不算在同一秒里
    expect(countDips([1, 0.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0.3, 1], 10)).toBe(1);
  });
});

describe('patternDips（声音的咔哒从这里推，见 audio/ghost.ts 的 MANIFEST_SFX.clicks）', () => {
  const at = (i: number) => i / LIGHTFX.rate;
  it('节奏表里每次灯暗下去的时刻：第 i 个字母从 i / 每秒字母数 秒开始；连着暗的算一次；一开头就暗也算', () => {
    expect(patternDips('mmamam')).toEqual([at(2), at(4)]);
    expect(patternDips('mmaammam')).toEqual([at(2), at(6)]);
    expect(patternDips('amm')).toEqual([0]);
    expect(patternDips('mlmlml')).toEqual([]); // l 只暗 6%，不到 10% 的抖动不算
    expect(patternDips('')).toEqual([]);
  });
  it('within 只取这么多秒以内的：刚好在 within 上的不要（节奏表放不到那一刻）', () => {
    expect(patternDips('mmamam', at(5))).toEqual([at(2), at(4)]);
    expect(patternDips('mmamam', at(4))).toEqual([at(2)]);
  });
  it('和 countDips 是同一个算法（dipStarts）：不到 1 秒的节奏表，两边数出一样多的暗下去', () => {
    for (const p of ['mmamam', 'mmaammam', 'amamam', 'mkmkmm', 'mlmlml']) {
      const levels = Array.from(p, (c) => letterLevel(c));
      expect(patternDips(p)).toEqual(dipStarts(levels));
      expect(patternDips(p).length).toBe(countDips(levels));
    }
  });
});

describe('现身那一串灯闪（真的 lightfx，按 ghost.ts 的调用顺序）', () => {
  it('不全灭、不白闪、任意 1 秒最多暗 3 下', () => {
    const levels = playManifest(makeScene());
    expect(Math.min(...levels)).toBeGreaterThanOrEqual(LIGHTFX.minLevel - 1e-9);
    expect(Math.min(...levels)).toBeGreaterThan(0.05);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1 + 1e-9);
    expect(countDips(levels, 1 / DT)).toBeLessThanOrEqual(3);
  });
  it('落下那一下够深（换材质时灯已经暗到 30% 以下），停留时压在 40% 左右，越暗越偏红', () => {
    const s = makeScene();
    const pos = { x: 1.6, z: 1.2 };
    s.fx.pulse(pos, M.radius, M.windup, MANIFEST.windup);
    s.run(MANIFEST.windup);
    s.fx.dipAll(pos, M.radius, M.drop.depth, M.drop.ms);
    s.fx.pulse(pos, M.radius, M.hold, MANIFEST.hold + M.holdSlack);
    const atSwap = s.run((M.drop.ms / 1000) * M.swapAt);
    expect(atSwap[atSwap.length - 1]).toBeLessThan(0.3);
    // 暗下去时颜色往暖红偏：蓝分量掉得比红分量多
    const c = s.lamp.color;
    const base = new THREE.Color(0xffb35c);
    expect(c.b / c.r).toBeLessThan(base.b / base.r);
    const held = s.run(0.6);
    expect(held[held.length - 1]).toBeGreaterThan(0.35);
    expect(held[held.length - 1]).toBeLessThan(0.5);
  });
  it('结束后强度、颜色原样还回去；半径外的灯、没标 lightfx 的灯不碰', () => {
    const s = makeScene();
    playManifest(s);
    s.run(1);
    expect(s.lamp.intensity).toBe(4.2);
    expect(s.lamp.color.getHex()).toBe(0xffb35c);
    expect(s.far.intensity).toBe(1.8);
    expect(s.untagged.intensity).toBe(3);
  });
  it('灯的主人每帧改写强度（台灯平时的轻闪）也照样压得暗，结束后接着用主人写的值', () => {
    const s = makeScene();
    const owner = (t: number) => { s.lamp.intensity = 4.2 * (0.9 + 0.1 * Math.sin(t * 7)); };
    const pos = { x: 1.6, z: 1.2 };
    s.fx.dipAll(pos, M.radius, 0.2, 500);
    const during = s.run(0.4, [], owner);
    expect(during[during.length - 1]).toBeLessThan(0.3);
    s.run(1, [], owner);
    // 回到 1 以后不再碰：主人写多少就是多少
    owner(123);
    s.fx.update({ dt: DT, time: 999, state: {} as WorldState });
    expect(s.lamp.intensity).toBeCloseTo(4.2 * (0.9 + 0.1 * Math.sin(123 * 7)), 10);
  });
  it('渲染前再补一次：主人在 lightfx 的 update 之后才写强度，画出来的照样是暗的', () => {
    const s = makeScene();
    s.fx.dipAll({ x: 1.6, z: 1.2 }, M.radius, 0.2, 500);
    s.run(0.3);
    s.lamp.intensity = 4.2; // 主人在后面写了一次
    s.scene.onBeforeRender(null as never, s.scene, null as never, null as never, null as never, null as never);
    expect(s.lamp.intensity).toBeLessThan(4.2 * 0.3);
  });
  it('手电通过 torchDim 一起暗，结束后回到 1', () => {
    const s = makeScene();
    const saved = torches.map((t) => ({ ...t }));
    Object.assign(torches[0], { x: 2.5, z: 1.5, power: 1 });
    Object.assign(torches[1], { x: 30, z: 30, power: 1 });
    try {
      s.fx.dipAll({ x: 1.6, z: 1.2 }, M.radius, 0.2, 300);
      s.run(0.2);
      expect(torchDim[0]).toBeLessThan(0.35);
      expect(torchDim[1]).toBe(1);
      s.run(1);
      for (let i = 0; i < TORCH_COUNT; i++) expect(torchDim[i]).toBe(1);
    } finally {
      saved.forEach((t, i) => Object.assign(torches[i], t));
      s.fx.dispose();
    }
  });
});

describe('跟着灯一起暗的自发光（评审 I3：灯暗了灯罩还亮着就不像坏灯泡）', () => {
  /** 和 lamp.ts、house.ts 一样的标记：台灯带灯罩、灯泡共用的 glow uniform，门廊灯带灯笼的材质 */
  function makeLit() {
    const scene = new THREE.Scene();
    const houseRoot = new THREE.Group();
    scene.add(houseRoot);
    const glow = uniform(1);
    const lamp = new THREE.PointLight(0xffb35c, 4.2, 4.8, 2);
    lamp.position.set(1, 1.3, 1);
    lamp.userData.lightfx = { glow };
    const lantern = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(0xffb35c).multiplyScalar(0.55) });
    const lanternBase = lantern.color.clone();
    const porch = new THREE.PointLight(0xffb35c, 1.8, 2.4, 2);
    porch.position.set(2, 1.35, 1);
    porch.userData.lightfx = { emissive: lantern };
    houseRoot.add(lamp, porch);
    const fx = createLightFx({ scene, houseRoot } as unknown as RenderCore);
    let time = 0;
    /** 台灯自己每帧写 glow 和强度（平时的轻闪），在 lightfx 之前 */
    const owner = (t: number) => {
      const blip = 0.9 + 0.1 * Math.sin(t * 7);
      glow.value = blip;
      lamp.intensity = 4.2 * blip;
    };
    const run = (seconds: number) => {
      for (let k = 0; k < Math.round(seconds / DT); k++) {
        time += DT;
        owner(time);
        fx.update({ dt: DT, time, state: {} as WorldState });
      }
    };
    return { scene, glow, lamp, lantern, lanternBase, porch, fx, run, owner, time: () => time };
  }

  it('台灯的 glow 跟着灯一起暗（主人每帧写也压得暗），结束后接着用主人写的值', () => {
    const s = makeLit();
    s.run(0.2);
    s.fx.dipAll({ x: 1.5, z: 1 }, 5, 0.2, 500);
    s.run(0.3);
    const ownerNow = 0.9 + 0.1 * Math.sin(s.time() * 7);
    expect(s.glow.value).toBeLessThan(ownerNow * 0.3);
    // 和灯的强度压的是同一个系数
    expect(s.glow.value / ownerNow).toBeCloseTo(s.lamp.intensity / (4.2 * ownerNow), 6);
    s.run(1.5);
    // 回到 1 以后不再碰：主人写多少就是多少
    s.owner(42);
    s.fx.update({ dt: DT, time: 999, state: {} as WorldState });
    expect(s.glow.value).toBe(0.9 + 0.1 * Math.sin(42 * 7));
  });

  it('门廊的灯笼：颜色跟着暗、往暖红偏，结束后逐位还原', () => {
    const s = makeLit();
    s.fx.dipAll({ x: 1.5, z: 1 }, 5, 0.2, 500);
    s.run(0.3);
    const c = s.lantern.color, b = s.lanternBase;
    expect(c.r).toBeLessThan(b.r * 0.3);
    expect(c.b / c.r).toBeLessThan(b.b / b.r); // 偏暖红：蓝分量掉得比红分量多
    expect(Math.max(c.r, c.g, c.b)).toBeGreaterThan(0); // 不全灭
    s.run(1.5);
    expect(c.equals(b)).toBe(true);
    expect(s.porch.intensity).toBe(1.8);
  });

  it('渲染前补的那一次也带上自发光；dispose 原样还回去', () => {
    const s = makeLit();
    s.fx.dipAll({ x: 1.5, z: 1 }, 5, 0.2, 500);
    s.run(0.3);
    s.glow.value = 1; // 台灯在 lightfx 之后才写
    s.scene.onBeforeRender(null as never, s.scene, null as never, null as never, null as never, null as never);
    expect(s.glow.value).toBeLessThan(0.3);
    s.fx.dispose();
    expect(s.glow.value).toBe(1);
    expect(s.lantern.color.equals(s.lanternBase)).toBe(true);
  });
});
