// 现身落下时地面雾被推开一圈（第二波 ART-6：view/fog.ts 的 DRAFT.manifest、waveAt、waveDensity、startDraftAt）；
// 顺带钉住娃娃屋屋外那圈雾的「屋外程度」（ART-10：顶点属性 outside）。
//
// 灯闪（WCAG 2.3.1，数法和 tests/lightfx.test.ts 一样：lightfx.ts 的 countDips，60 Hz 采样，从高点掉 0.1 以上算一次）：
// 现身这一串灯（蓄力两下 + 落下一下）已经占满了「任意 1 秒最多 3 下」，所以雾这一圈不能自己再暗一下。
// 雾的亮度曲线 = 气浪造成的密度倍数（waveDensity：着色器里 draftField 的 CPU 镜像；不透明度 = 1 − exp(−τ)，τ 正比于密度，所以亮度和它单调相关）。
// 查三件事：
// 1. 每一点上（半径、缕系数各取一遍）曲线只有一下：波前过来浓一下、过去薄一下、慢慢回来——是一次平滑的变化，不是来回抖。
// 2. 整圈合起来看（半径 R0 以内按面积取平均）：雾只是被推开、挤到波前上，总量不少，平均亮度一次都不暗；叠上灯那一串仍是 3 下。
// 3. 鬼魂脚下（半径 0.5 米以内）：变薄和落下那一下灯暗同一刻开始，叠上灯那一串仍是 3 下。
// 已知（写在报告里）：波前扫过的那一圈（半径 0.6–2.3 米）里，灯 × 雾逐点相乘的最严口径下，最坏 4 下（蓄力 2 + 落下 1 + 波前过去的那一下）。
// 那一圈只是一条窄带（半宽 0.35 米）在地面上往外走，每个点上就那一下，不是整屏闪；这里不把它当成通过
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST } from '../src/config/visitors';
import { HOUSE_D, HOUSE_W, ROOMS } from '../src/config/house';
import type { CameraRig, RenderCore } from '../src/engine/types';
import type { SimEvent, WorldState } from '../src/sim/types';
import { DRAFT, FOG, createFogView, topDownDim, waveAt, waveDensity } from '../src/view/fog';
import { manifestLights } from '../src/view/ghost';
import { countDips, createLightFx, dipStarts } from '../src/view/lightfx';

const L = DRAFT.manifest;
const HZ = 60;
/** 网格采得出来的最小半宽：高档 0.15 米一格、低档 0.4 米一格，不能比两格窄（writeDraft 的 minW） */
const MIN_W = { high: FOG.layout.high.step * DRAFT.minSteps, low: FOG.layout.low.step * DRAFT.minSteps };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DRAFT.manifest：参数照美术总监定的', () => {
  it('一圈气浪：2.6 米、1.1 秒、半宽 0.35、挤浓 1.35、变薄 0.5、推 0.3、起点 0.25、撕成缕 0.6', () => {
    expect(DRAFT.manifest).toEqual({ reach: 2.6, time: 1.1, width: 0.35, spread: 1.0, compress: 1.35, trough: 0.5, push: 0.3, start: 0.25, stir: 0.6 });
  });
  it('厨房门撞上的那一圈（slam）没改：照原来的数', () => {
    expect(DRAFT.slam).toEqual({ reach: 4.2, time: 1.8, width: 0.45, spread: 1.3, compress: 1.6, trough: 0.6, push: 0.45, start: 0.35, stir: 0.8 });
  });
});

describe('waveAt：波前怎么走', () => {
  const at = (t: number, minW = MIN_W.high) => waveAt(L, t, minW);

  it('出发时在鬼魂身宽的位置（start），幅度从 0 起、0.06 秒内淡入，不是一下子出现', () => {
    expect(at(0).radius).toBeCloseTo(L.start, 9);
    expect(at(0).compress).toBe(0);
    expect(at(0.03).compress).toBeGreaterThan(0);
    expect(at(0.03).compress).toBeLessThan(at(0.06).compress);
    // 淡入走完（0.06 秒）以后只随 (1 − u)^1.5 往下衰减
    expect(at(0.06).compress).toBeCloseTo(L.compress * (1 - 0.06 / L.time) ** 1.5, 9);
  });

  it('先快后慢（outCubic）一路往外走，time 秒走到 reach；落下后 0.4 秒在 2 米左右', () => {
    let prev = at(0).radius;
    for (let k = 1; k <= Math.round(L.time * 120); k++) {
      const r = at(k / 120).radius;
      expect(r, `t = ${k / 120}`).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(prev).toBeCloseTo(L.reach, 9);
    expect(at(0.4).radius).toBeGreaterThan(1.8);
    expect(at(0.4).radius).toBeLessThan(2.2);
    // 先快后慢：头一半时间走的比后一半多
    expect(at(L.time / 2).radius - L.start).toBeGreaterThan((L.reach - L.start) / 2);
  });

  it('走完时一点不剩：幅度和推走的距离都回到 0，不在最后一帧突然消失', () => {
    expect(at(L.time).compress).toBe(0);
    expect(at(L.time).shove).toBeCloseTo(0, 12);
    // 最后 0.1 秒里已经很小了
    expect(at(L.time - 0.1).compress).toBeLessThan(0.1 * L.compress);
    // 推走的距离按 inOutSine 退回：单调不增
    let prev = at(0).shove;
    for (let k = 1; k <= Math.round(L.time * 120); k++) {
      const s = at(k / 120).shove;
      expect(s).toBeLessThanOrEqual(prev + 1e-12);
      prev = s;
    }
  });

  it('半宽随走远变宽，不窄于网格采得出来的最小半宽（低档 0.4 米一格 → 0.8 米）', () => {
    expect(at(0).halfWidth).toBeCloseTo(Math.max(L.width, MIN_W.high), 9);
    expect(at(L.time).halfWidth).toBeCloseTo(L.width * (1 + L.spread), 9);
    for (const q of ['high', 'low'] as const) {
      for (let k = 0; k <= 66; k++) expect(at(k / 60, MIN_W[q]).halfWidth).toBeGreaterThanOrEqual(MIN_W[q]);
    }
  });

  it('还没出发（ts < 0）：不起作用（slam 要等门撞上门框，现身没有这一段）', () => {
    const w = waveAt(DRAFT.slam, -0.05, MIN_W.high);
    expect(w.compress).toBe(0);
    expect(w.shove).toBe(0);
    expect(w.radius).toBeCloseTo(DRAFT.slam.start, 9);
  });

  it('slam 照原来的式子算（重构前 writeDraft 里写死的那几行）：半径、半宽、推走、幅度逐帧一样', () => {
    const S = DRAFT.slam;
    const outCubic = (t: number) => 1 - (1 - t) ** 3;
    const inOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t);
    const seg = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
    for (let k = -6; k <= 120; k++) {
      const ts = k / 60;
      const u = seg(ts, 0, S.time);
      const on = ts >= 0 ? 1 : 0;
      const w = waveAt(S, ts, MIN_W.high);
      expect(w.radius).toBeCloseTo(S.start + (S.reach - S.start) * outCubic(u), 12);
      expect(w.halfWidth).toBeCloseTo(Math.max(S.width * (1 + S.spread * u), MIN_W.high), 12);
      expect(w.shove).toBeCloseTo(on * S.push * (1 - inOutSine(u)), 12);
      expect(w.compress).toBeCloseTo(on * S.compress * (1 - u) ** 1.5 * seg(ts, 0, 0.06), 12);
    }
  });
});

describe('waveDensity：推开的是什么样子', () => {
  it('落下后 0.4 秒：波前上浓（挤在一起）、里面薄（被推开）、前面没动，鬼魂周围一圈约 2 米半径', () => {
    const w = waveAt(L, 0.4, MIN_W.high);
    expect(waveDensity(w, L, w.radius)).toBeGreaterThan(1.4); // 波前上
    expect(waveDensity(w, L, w.radius * 0.45)).toBeLessThan(0.9); // 里面
    expect(waveDensity(w, L, w.radius + 4 * w.halfWidth)).toBeCloseTo(1, 3); // 前面没动
    expect(w.radius).toBeGreaterThan(1.5);
  });
  it('没有「缕」（wisp = 1）时只是浓一下薄一下；有缕时撕成一缕一缕：缝里（0.2）比缕上（1.7）薄', () => {
    const w = waveAt(L, 0.3, MIN_W.high);
    expect(waveDensity(w, L, w.radius, 0.2)).toBeLessThan(waveDensity(w, L, w.radius, 1.7));
    // 不在波前上、也不在里面（前面很远）时缕系数不起作用
    expect(waveDensity(w, L, w.radius + 6, 0.2)).toBeCloseTo(1, 6);
    expect(waveDensity(w, L, w.radius + 6, 1.7)).toBeCloseTo(1, 6);
  });
  it('密度倍数永远不为负（雾不会变成「负的雾」）', () => {
    for (let k = 0; k <= 80; k++) {
      const w = waveAt(L, k / 60, MIN_W.low);
      for (let r = 0; r <= 5; r += 0.1) expect(waveDensity(w, L, r, 0.2)).toBeGreaterThanOrEqual(0);
    }
  });
});

// ───────────────────────── 灯闪 ─────────────────────────

/**
 * 现身那一串灯（真的 lightfx，按 ghost.ts 的调用顺序：蓄力 → 落下 → 停留 → 收），HZ 采样，最后多走 1 秒。
 * 返回灯的亮度序列和「落下」是第几个采样
 */
function lampSeries(): { lamp: number[]; drop: number } {
  const scene = new THREE.Scene();
  const houseRoot = new THREE.Group();
  houseRoot.position.set(-8, 0, -6);
  scene.add(houseRoot);
  const light = new THREE.PointLight(0xffb35c, 4.2, 4.8, 2);
  light.position.set(1, 1.3, 1);
  light.userData.lightfx = true;
  houseRoot.add(light);
  const fx = createLightFx({ scene, houseRoot } as unknown as RenderCore);
  const lamp: number[] = [];
  let time = 0;
  const run = (seconds: number) => {
    for (let k = 0; k < Math.round(seconds * HZ); k++) {
      time += 1 / HZ;
      fx.update({ dt: 1 / HZ, time, state: {} as WorldState });
      lamp.push(light.intensity / 4.2);
    }
  };
  const pos = { x: 1.6, z: 1.2 };
  manifestLights(fx, 'windup', pos);
  run(MANIFEST.windup);
  const drop = lamp.length;
  const release = manifestLights(fx, 'drop', pos);
  run(MANIFEST.hold);
  release?.();
  manifestLights(fx, 'end', pos);
  run(1);
  fx.dispose();
  return { lamp, drop };
}

/** 一点上（离鬼魂 r 米、缕系数 wisp）雾的亮度曲线：落下之前是 1，之后是气浪的密度倍数 */
const fogCurve = (n: number, drop: number, r: number, wisp: number, hz = HZ, minW = MIN_W.high) =>
  Array.from({ length: n }, (_, k) => (k < drop * (hz / HZ) ? 1 : waveDensity(waveAt(L, k / hz - drop / HZ, minW), L, r, wisp)));

describe('雾的亮度曲线：用 countDips 数（和灯闪同一个口径）', () => {
  it('前提：现身这一串灯自己是 3 下，已经占满了任意 1 秒的额度（所以雾不能再多一下）', () => {
    const { lamp } = lampSeries();
    expect(countDips(lamp, HZ)).toBeLessThanOrEqual(3);
    // 最密的那 1 秒里正好是 3 下（蓄力 2 下 + 落下 1 下）
    const starts = dipStarts(lamp, HZ);
    expect(starts.filter((t) => t < MANIFEST.windup + 0.5).length).toBe(3);
  });

  it('每一点上只有一下：半径 0 到 reach + 3 个半宽（每 5 厘米）、缕系数 0.2–1.7（每 0.1），30 / 60 / 120 Hz，高档和低档的网格宽度', () => {
    const wisp = (DRAFT.wisp as [number, number]);
    let worst = 0;
    let checked = 0;
    for (const hz of [30, 60, 120]) {
      for (const q of ['high', 'low'] as const) {
        const n = Math.round((L.time + 0.5) * hz);
        for (let r = 0; r <= L.reach + 3 * L.width * (1 + L.spread); r += 0.05) {
          for (let w = wisp[0]; w <= wisp[1] + 1e-9; w += 0.1) {
            const dips = countDips(fogCurve(n, 0, r, w, hz, MIN_W[q]), hz);
            worst = Math.max(worst, dips);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('整圈合起来看：半径 3 / 4 / 6 米以内按面积取平均，雾的总量不少（推开、挤到波前上），平均亮度一次都不暗；叠上灯那一串仍是 3 下', () => {
    const { lamp, drop } = lampSeries();
    for (const R0 of [3, 4, 6]) {
      const mean = (t: number) => {
        let sum = 0, area = 0;
        for (let r = 0.025; r < R0; r += 0.05) {
          sum += waveDensity(waveAt(L, t, MIN_W.high), L, r, 1) * r;
          area += r;
        }
        return sum / area;
      };
      const fog = lamp.map((_, k) => (k < drop ? 1 : mean((k - drop) / HZ)));
      expect(Math.min(...fog), `R0 = ${R0}`).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(countDips(fog, HZ), `R0 = ${R0}`).toBeLessThanOrEqual(1);
      expect(countDips(lamp.map((v, k) => v * fog[k]), HZ), `R0 = ${R0}`).toBeLessThanOrEqual(3);
    }
  });

  it('鬼魂脚下（半径 0.5 米以内）：变薄和落下那一下灯暗同一刻开始（0.1 秒内），叠上灯那一串仍是 3 下', () => {
    const { lamp, drop } = lampSeries();
    for (let r = 0; r <= 0.5001; r += 0.05) {
      for (const wisp of [0.2, 1, 1.7]) {
        const fog = fogCurve(lamp.length, drop, r, wisp);
        const starts = dipStarts(fog, HZ).map((t) => t - drop / HZ);
        expect(starts.length, `r = ${r.toFixed(2)}, wisp = ${wisp}`).toBe(1);
        expect(starts[0], `r = ${r.toFixed(2)}, wisp = ${wisp}`).toBeLessThan(0.1);
        expect(countDips(lamp.map((v, k) => v * fog[k]), HZ), `r = ${r.toFixed(2)}, wisp = ${wisp}`).toBeLessThanOrEqual(3);
      }
    }
  });

  it('已知的限度（写在报告里）：灯 × 雾逐点相乘（最严的口径，假设那一点的亮度全来自被灯照亮的雾）时，波前扫过的那一圈（半径 0.6–2.3 米）最坏 4 下，'
    + '其余半径（鬼魂脚下、2.4 米以外）仍是 3 下。钉住它别再变坏；它是一条窄带（半宽 0.35 米）往外走，每个点上就那一下，不是整屏闪', () => {
    const { lamp, drop } = lampSeries();
    let worst = 0;
    for (let r = 0; r <= L.reach + 1.5; r += 0.1) {
      let m = 0;
      for (let w = DRAFT.wisp[0]; w <= DRAFT.wisp[1] + 1e-9; w += 0.1) {
        const fog = fogCurve(lamp.length, drop, r, w);
        m = Math.max(m, countDips(lamp.map((v, k) => v * fog[k]), HZ));
      }
      worst = Math.max(worst, m);
      if (r <= 0.5 || r >= 2.4) expect(m, `r = ${r.toFixed(1)}`).toBeLessThanOrEqual(3);
    }
    expect(worst).toBeLessThanOrEqual(4);
  });

  it('曲线只有三段：涨（波前过来）、落（过去以后薄）、慢慢涨回 1，每一段都是单向的，不过冲、不来回', () => {
    for (const r of [0.1, 0.2, 0.8, 1.5, 2.2, 2.8]) {
      const fog = fogCurve(Math.round((L.time + 0.3) * 120), 0, r, 1, 120);
      const iMax = fog.indexOf(Math.max(...fog));
      let iMin = iMax;
      for (let k = iMax; k < fog.length; k++) if (fog[k] < fog[iMin]) iMin = k;
      for (let k = 1; k <= iMax; k++) expect(fog[k], `r = ${r} 涨, k = ${k}`).toBeGreaterThanOrEqual(fog[k - 1] - 1e-6);
      for (let k = iMax + 1; k <= iMin; k++) expect(fog[k], `r = ${r} 落, k = ${k}`).toBeLessThanOrEqual(fog[k - 1] + 1e-6);
      for (let k = iMin + 1; k < fog.length; k++) expect(fog[k], `r = ${r} 回, k = ${k}`).toBeGreaterThanOrEqual(fog[k - 1] - 1e-6);
      expect(fog[fog.length - 1]).toBeCloseTo(1, 2);
    }
  });
});

// ───────────────────────── 事件接线（不渲染，读 uniform） ─────────────────────────

/** 假的渲染核心：雾只用到 houseRoot、scene、quality；?debug 时 window.__fog.uniforms 能读到每个扰动槽 */
function makeFog() {
  const win: Record<string, unknown> = {};
  vi.stubGlobal('window', win);
  vi.stubGlobal('location', { search: '?debug' });
  const houseRoot = new THREE.Group();
  const core = { houseRoot, scene: new THREE.Scene(), quality: 'high' } as unknown as RenderCore;
  const fog = createFogView(core, {} as CameraRig);
  type V4 = { value: THREE.Vector4 };
  const dbg = win.__fog as { uniforms: { drafts: { amt: V4; ring: V4; geo: V4; wave: { value: THREE.Vector2 } }[]; persp: { value: number } } };
  const state = {} as WorldState;
  const frame = (dt: number, time: number) => fog.update?.({ dt, time, state });
  return { fog, dbg, houseRoot, frame, drafts: dbg.uniforms.drafts };
}
const manifest = (phase: 'windup' | 'drop' | 'end', x: number, z: number): SimEvent => ({ type: 'manifest', phase, pos: { x, z }, scared: [] });
const ROOM_IDS = Object.keys(ROOMS);
/** 打包的房间（fog.ts 的 ROOM_PACK = 16）：a + 16 × b */
const packed = (a: string, b: string) => ROOM_IDS.indexOf(a) + 16 * ROOM_IDS.indexOf(b);

describe('现身事件：只有落下推雾', () => {
  it('蓄力、收：没有任何扰动；落下：开一个，从鬼魂的位置、它所在的房间出发', () => {
    const f = makeFog();
    f.frame(1 / 60, 0);
    f.fog.onEvent?.(manifest('windup', 2.6, 6.2), {} as WorldState);
    f.fog.onEvent?.(manifest('end', 2.6, 6.2), {} as WorldState);
    f.frame(1 / 60, 1 / 60);
    for (const d of f.drafts) expect(d.amt.value.w).toBe(0);

    f.fog.onEvent?.(manifest('drop', 2.6, 6.2), {} as WorldState);
    f.frame(1 / 60, 2 / 60);
    const d = f.drafts[0];
    expect(d.geo.value.x).toBeCloseTo(2.6, 9);
    expect(d.geo.value.y).toBeCloseTo(6.2, 9);
    // 走廊（hall）：两个房间都填它
    expect(d.ring.value.w).toBe(packed('hall', 'hall'));
    expect(d.ring.value.x).toBeGreaterThanOrEqual(L.start);
    expect(d.ring.value.x).toBeLessThan(L.start + 0.5);
    // 这一种气浪自己的形状系数：变薄 / 变浓 = trough / compress，撕成缕 = stir
    expect(d.wave.value.x).toBeCloseTo(L.trough / L.compress, 9);
    expect(d.wave.value.y).toBeCloseTo(L.stir, 9);
  });

  it('按 dt 往外走：落下后 0.4 秒波前约 2 米；1.1 秒后槽空出来，什么都不剩', () => {
    const f = makeFog();
    f.fog.onEvent?.(manifest('drop', 8, 6), {} as WorldState);
    let t = 0;
    const run = (to: number) => { while (t < to - 1e-9) { t += 1 / 60; f.frame(1 / 60, t); } };
    run(0.4);
    expect(f.drafts[0].ring.value.x).toBeGreaterThan(1.8);
    expect(f.drafts[0].ring.value.x).toBeLessThan(2.2);
    expect(f.drafts[0].amt.value.w).toBeGreaterThan(0.3);
    run(L.time + 0.1);
    expect(f.drafts[0].amt.value.w).toBe(0);
    expect(f.drafts[0].ring.value.z).toBe(0);
  });

  it('房间：在门洞里是门两边的房间；在房间里是那个房间；站在墙里按偏向的那一侧，不推到隔壁', () => {
    const f = makeFog();
    // 走廊通客厅的门洞（格子 15、16 × 9，米坐标 x 7.5–8.5、z 4.5–5）
    f.fog.onEvent?.(manifest('drop', 8.0, 4.75), {} as WorldState);
    // 客厅正中
    f.fog.onEvent?.(manifest('drop', 8.0, 2.5), {} as WorldState);
    // 门厅正中
    f.fog.onEvent?.(manifest('drop', 8.0, 9.5), {} as WorldState);
    f.frame(1 / 60, 1 / 60); // uniform 在 update 里写
    expect(f.drafts[0].ring.value.w).toBe(packed('living', 'hall'));
    expect(f.drafts[1].ring.value.w).toBe(packed('living', 'living'));
    expect(f.drafts[2].ring.value.w).toBe(packed('foyer', 'foyer'));
  });

  it('扰动槽满了（4 个）再来一个：顶掉进度最靠后的，不报错', () => {
    const f = makeFog();
    for (let k = 0; k < 6; k++) f.fog.onEvent?.(manifest('drop', 2 + k, 6), {} as WorldState);
    f.frame(1 / 60, 1 / 60);
    expect(f.drafts.filter((d) => d.amt.value.w > 0).length).toBe(4);
  });
});

// ───────────────────────── 娃娃屋屋外的雾（ART-10） ─────────────────────────

describe('屋外程度（顶点属性 outside）', () => {
  /** 雾的两个网格（高、低档）的顶点：位置、outside、dens */
  function grids() {
    const f = makeFog();
    const group = f.houseRoot.children.find((o) => o.name === 'fog') as THREE.Group;
    return (['high', 'low'] as const).map((q) => {
      const mesh = group.children.find((o) => o.name === `ground-fog-${q}`) as THREE.Mesh;
      const g = mesh.geometry;
      return { q, pos: g.getAttribute('position') as THREE.BufferAttribute, out: g.getAttribute('outside') as THREE.BufferAttribute, dens: g.getAttribute('dens') as THREE.BufferAttribute };
    });
  }
  const outsideDist = (x: number, z: number) => Math.hypot(Math.max(0, -x, x - HOUSE_W), Math.max(0, -z, z - HOUSE_D));
  const smooth = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  it('参数：俯视时屋外密度 ×0.55，第二层细噪声权重 0.36 → 0.2，1 米里从屋里（0）渐变到屋外（1）', () => {
    expect(FOG.topDown).toEqual({ dim: 0.55, detail: 0.2, ramp: 1 });
    expect(FOG.noise[1].weight).toBe(0.36);
  });

  it('topDownDim：屋里、第三人称永远 1；娃娃屋的屋外夜里 ×0.55，天亮（环境色 ×1.8）时再除以 1.8——屋外「贴上去的亮度」（密度 × 环境色）和夜里一样', () => {
    const D = FOG.topDown.dim;
    // 屋里（屋外程度 0）：不管相机、不管天亮，都是 1
    for (const lift of [1, 1.8]) for (const persp of [true, false]) expect(topDownDim(0, persp, lift)).toBe(1);
    // 第三人称（透视）：屋外也是 1（门外的雾照旧，天亮的晨雾也照旧）
    for (const lift of [1, 1.4, 1.8]) expect(topDownDim(1, true, lift)).toBe(1);
    // 娃娃屋的屋外：夜里 0.55
    expect(topDownDim(1, false)).toBeCloseTo(D, 12);
    expect(topDownDim(1, false, 1)).toBeCloseTo(D, 12);
    // 天亮：FOG_DAWN 是环境色 ×1.8（LT 路，ART-2）；密度 × 环境色不变
    expect(topDownDim(1, false, 1.8)).toBeCloseTo(D / 1.8, 12);
    expect(topDownDim(1, false, 1.8) * 1.8).toBeCloseTo(topDownDim(1, false, 1), 12);
    // 比夜里还暗的环境色不放大屋外的雾（lift 小于 1 按 1 算）
    expect(topDownDim(1, false, 0.5)).toBeCloseTo(D, 12);
    // 屋外程度在 0 和 1 之间时按比例过渡，一路单调
    let prev = 1;
    for (let m = 0; m <= 1.0001; m += 0.05) {
      const v = topDownDim(m, false, 1.8);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
  });

  it('每个顶点都有：房子占地里（含墙体）= 0，离外沿 1 米以外 = 1，中间是 smoothstep；高、低档一样', () => {
    for (const { q, pos, out } of grids()) {
      expect(out, q).toBeTruthy();
      expect(out.count).toBe(pos.count);
      let inside = 0, far = 0, mid = 0;
      for (let k = 0; k < pos.count; k++) {
        const d = outsideDist(pos.getX(k), pos.getZ(k));
        const want = smooth(0, FOG.topDown.ramp, d);
        expect(out.getX(k), `${q} #${k}`).toBeCloseTo(want, 5);
        if (d === 0) inside++;
        else if (d >= FOG.topDown.ramp) far++;
        else mid++;
      }
      expect(inside, q).toBeGreaterThan(100);
      expect(far, q).toBeGreaterThan(100);
      expect(mid, q).toBeGreaterThan(10);
    }
  });

  it('屋里的静态密度没动：屋里的顶点密度都在 1 以上（墙根、门口堆积），屋外的顶点从 FOG.outside 往外淡出', () => {
    for (const { q, pos, dens } of grids()) {
      for (let k = 0; k < pos.count; k++) {
        const x = pos.getX(k), z = pos.getZ(k);
        if (x > 0.2 && x < HOUSE_W - 0.2 && z > 0.2 && z < HOUSE_D - 0.2) expect(dens.getX(k), `${q} #${k}`).toBeGreaterThanOrEqual(1);
      }
    }
  });
});
