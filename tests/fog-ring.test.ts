// 现身落下时地面雾被推开一圈（第二波 ART-6：view/fog.ts 的 DRAFT.manifest、waveAt、waveDensity、startDraftAt）；
// 顺带钉住娃娃屋屋外那圈雾的「屋外程度」（ART-10：顶点属性 outside）。
//
// 灯闪（WCAG 2.3.1，数法和 tests/lightfx.test.ts 一样：lightfx.ts 的 countDips，60 Hz 采样，从高点掉 0.1 以上算一次）：
// 现身这一串灯（蓄力两下 + 落下一下）已经占满了「任意 1 秒最多 3 下」，所以雾这一圈不能让任何一点的亮度再暗一下。
// 最严的口径（主会话在修复第 1 轮定的）：灯的亮度 × 雾的亮度逐点相乘，数出来整串仍然最多 3 下；
// 门槛取 0.08（比 countDips 默认的 0.1 严一点，留 0.02 的余量）。雾的亮度有两种算法，都查：
// 1. 只看气浪造成的密度倍数（waveDensity，着色器里 draftField 的 CPU 镜像，不透明度 = 1 − exp(−τ)，τ 正比于密度）；
// 2. 把噪声场和气浪的取样点位移（push：雾的花纹被推着挪，花纹的边挪过一个点时那一点的亮度也会变）都算进去（tests/fogField.ts：
//    fogMaterial 里 rho、hs、光程的 CPU 镜像，噪声是 three 的 mx_noise_float 的 CPU 版），亮度取不透明度相对稳态的比（α / α0），
//    只看稳态不透明度 ≥ 0.05 的点（再薄的雾几乎看不见，相对变化大也没有意义）。
// 雾自己的飘（风、翻滚）不算在内：它是慢变化、本来就有，和现身没关系，所以噪声时间在每条曲线里定住。
// 美术总监原定的数（compress 1.35 / trough 0.5 / push 0.3）在这个口径下波前扫过的那一圈最坏 4 下：下面有一条用它们证明这个口径数得出来
import * as THREE from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANIFEST } from '../src/config/visitors';
import { HOUSE_D, HOUSE_W, ROOMS } from '../src/config/house';
import type { CameraRig, RenderCore } from '../src/engine/types';
import type { SimEvent, WorldState } from '../src/sim/types';
import { DRAFT, FOG, createFogView, topDownDim, waveAt, waveDensity, type WaveParams } from '../src/view/fog';
import { manifestLights } from '../src/view/ghost';
import { countDips, createLightFx, dipStarts } from '../src/view/lightfx';
import { VIEWS, fogAlpha } from './fogField';

const L = DRAFT.manifest;
const HZ = 60;
/** 网格采得出来的最小半宽：高档 0.15 米一格、低档 0.4 米一格，不能比两格窄（writeDraft 的 minW） */
const MIN_W = { high: FOG.layout.high.step * DRAFT.minSteps, low: FOG.layout.low.step * DRAFT.minSteps };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DRAFT.manifest：参数', () => {
  it('一圈气浪：几何照美术总监定的（2.6 米、1.1 秒、起点 0.25、扩散 1.0）；幅度按修复第 1 轮重新定（不变薄、挤浓 0.25、推 0.06 米、撕成缕 0.3、半宽 0.7）', () => {
    expect(DRAFT.manifest).toEqual({ reach: 2.6, time: 1.1, width: 0.7, spread: 1.0, compress: 0.25, trough: 0, push: 0.06, start: 0.25, stir: 0.3 });
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
  it('落下后 0.4 秒：波前上浓一点（> 1.1）、里面不薄（没有 trough，≥ 1）、前面没动，鬼魂周围一圈约 2 米半径', () => {
    const w = waveAt(L, 0.4, MIN_W.high);
    expect(waveDensity(w, L, w.radius)).toBeGreaterThan(1.1); // 波前上
    expect(waveDensity(w, L, w.radius * 0.45)).toBeGreaterThanOrEqual(1 - 1e-9); // 里面
    expect(waveDensity(w, L, w.radius + 4 * w.halfWidth)).toBeCloseTo(1, 3); // 前面没动
    expect(w.radius).toBeGreaterThan(1.5);
  });
  it('没有变薄：没有「缕」（wisp = 1）时密度倍数处处 ≥ 1；有缕时最多掉一成（缝里 0.2）', () => {
    for (let k = 0; k <= 80; k++) {
      const w = waveAt(L, k / 60, MIN_W.high);
      for (let r = 0; r <= 5; r += 0.05) {
        expect(waveDensity(w, L, r, 1), `t = ${k / 60}, r = ${r.toFixed(2)}`).toBeGreaterThanOrEqual(1 - 1e-9);
        expect(waveDensity(w, L, r, DRAFT.wisp[0]), `t = ${k / 60}, r = ${r.toFixed(2)}`).toBeGreaterThan(0.9);
      }
    }
  });
  it('有缕时撕成一缕一缕：缝里（0.2）比缕上（1.7）薄；不在波前上（前面很远）时缕系数不起作用', () => {
    const w = waveAt(L, 0.3, MIN_W.high);
    expect(waveDensity(w, L, w.radius, 0.2)).toBeLessThan(waveDensity(w, L, w.radius, 1.7));
    expect(waveDensity(w, L, w.radius + 6, 0.2)).toBeCloseTo(1, 6);
    expect(waveDensity(w, L, w.radius + 6, 1.7)).toBeCloseTo(1, 6);
  });
  it('密度倍数永远不为负（雾不会变成「负的雾」）', () => {
    for (let k = 0; k <= 80; k++) {
      const w = waveAt(L, k / 60, MIN_W.low);
      for (let r = 0; r <= 5; r += 0.1) expect(waveDensity(w, L, r, 0.2)).toBeGreaterThanOrEqual(0);
    }
  });
  it('圈还在（防止为了数得过去把它关掉）：波前上至少浓两成（compress ≥ 0.2）、花纹至少被推 5 厘米（push ≥ 0.05）、波前至少 0.5 米半宽', () => {
    expect(L.compress).toBeGreaterThanOrEqual(0.2);
    expect(L.push).toBeGreaterThanOrEqual(0.05);
    expect(waveAt(L, 0.06, MIN_W.high).shove).toBeGreaterThanOrEqual(0.05 * 0.99);
    expect(waveAt(L, 0.1, MIN_W.high).halfWidth).toBeGreaterThanOrEqual(0.5);
    // 波前走到中途（0.25 秒，1.5 米）时，那一点上最浓能到 1.1 以上
    const w = waveAt(L, 0.25, MIN_W.high);
    expect(waveDensity(w, L, w.radius)).toBeGreaterThan(1.1);
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

/** 数的门槛：比 countDips 默认的 0.1 严一点，留 0.02 的余量（修复第 1 轮：逐点落差 ≤ 0.08） */
const STRICT = 0.08;
const LAMP = lampSeries();

/** 一点上（离鬼魂 r 米、缕系数 wisp）只看密度倍数的雾亮度曲线：落下之前是 1，之后是气浪的密度倍数 */
const fogCurve = (n: number, drop: number, r: number, wisp: number, p: WaveParams = L, hz = HZ, minW = MIN_W.high) =>
  Array.from({ length: n }, (_, k) => (k < drop * (hz / HZ) ? 1 : waveDensity(waveAt(p, k / hz - drop / HZ, minW), p, r, wisp)));

/** 第一种算法（只看密度倍数）：最严口径下所有点的最大下数。半径 0 到 reach + 3 个半宽（每 5 厘米）、缕系数 0.2–1.7（每 0.1），高档和低档的网格宽度 */
function worstByMultiplier(p: WaveParams, stopAt = Infinity): number {
  let worst = 0;
  for (const q of ['high', 'low'] as const) {
    for (let r = 0; r <= p.reach + 3 * p.width * (1 + p.spread); r += 0.05) {
      for (let w = DRAFT.wisp[0]; w <= DRAFT.wisp[1] + 1e-9; w += 0.1) {
        const fog = fogCurve(LAMP.lamp.length, LAMP.drop, r, w, p, HZ, MIN_W[q]);
        worst = Math.max(worst, countDips(LAMP.lamp.map((v, k) => v * fog[k]), HZ, STRICT));
        if (worst >= stopAt) return worst;
      }
    }
  }
  return worst;
}

/**
 * 第二种算法（噪声场 + 取样点位移都算进去）：鬼魂在 (8, 6)，围着它的地板上取点（半径 0.2–3.8 米每 0.2 米 × 8 个方向），
 * 噪声时间、静态密度（空地 1、墙根堆积 1.8）、镜头（第三人称、娃娃屋）各取几种；每个点一条曲线：灯 × （α / α0），α0 是稳态不透明度，
 * 只看 α0 ≥ 0.05 的点。返回最大下数和数过的曲线条数；stopAt 给了就在数到这么多下时收工（找反例用，不用数完）
 */
function worstByField(p: WaveParams, stopAt = Infinity): { worst: number; curves: number } {
  const C = { x: 8, z: 6 };
  let worst = 0, curves = 0;
  for (const q of ['high', 'low'] as const) {
    for (const T0 of [1.1, 9.3, 17.7, 31.7, 55.1, 71.3]) {
      for (const dens of [1, 1.8]) {
        for (const vk of ['third', 'doll'] as const) {
          for (let r = 0.2; r <= 3.81; r += 0.2) {
            for (let a = 0; a < 8; a++) {
              const phi = (a / 8) * Math.PI * 2 + 0.17;
              const sx = C.x + r * Math.cos(phi), sz = C.z + r * Math.sin(phi);
              const a0 = fogAlpha(sx, sz, T0, null, VIEWS[vk], dens);
              if (a0 < 0.05) continue;
              const P = LAMP.lamp.map((l, k) => {
                const age = (k - LAMP.drop) / HZ;
                return age < 0 ? l : (l * fogAlpha(sx, sz, T0, { cx: C.x, cz: C.z, age, L: p, minW: MIN_W[q] }, VIEWS[vk], dens)) / a0;
              });
              worst = Math.max(worst, countDips(P, HZ, STRICT));
              curves++;
              if (worst >= stopAt) return { worst, curves };
            }
          }
        }
      }
    }
  }
  return { worst, curves };
}

describe('灯闪：这一圈不能让任何一点的亮度多暗一下（灯 × 雾逐点相乘，countDips 门槛 0.08）', () => {
  it('前提：现身这一串灯自己是 3 下（蓄力 2 + 落下 1），门槛 0.08 也一样；已经占满了任意 1 秒的额度，雾不能再多一下', () => {
    expect(countDips(LAMP.lamp, HZ)).toBe(3);
    expect(countDips(LAMP.lamp, HZ, STRICT)).toBe(3);
    // 最密的那 1 秒里正好是 3 下
    expect(dipStarts(LAMP.lamp, HZ, STRICT).filter((t) => t < MANIFEST.windup + 0.5).length).toBe(3);
  });

  it('第一种算法（只看气浪的密度倍数）：整串（蓄力 2 + 落下 1 + 这一圈）每一点上任意 1 秒最多 3 下', () => {
    expect(worstByMultiplier(L)).toBeLessThanOrEqual(3);
  }, 60_000);

  it('第二种算法（噪声场、取样点位移都算进去）：几千条曲线（高低档、两种镜头、几种噪声时间和静态密度），整串每一条任意 1 秒最多 3 下', () => {
    const r = worstByField(L);
    expect(r.curves).toBeGreaterThan(3000);
    expect(r.worst).toBeLessThanOrEqual(3);
  }, 60_000);

  it('这个口径数得出来：美术总监原定的数（compress 1.35 / trough 0.5 / push 0.3 / stir 0.6 / 半宽 0.35）在同样的口径下会多出一下（4 下）', () => {
    const original: WaveParams = { ...L, width: 0.35, compress: 1.35, trough: 0.5, push: 0.3, stir: 0.6 };
    expect(worstByMultiplier(original, 4)).toBeGreaterThanOrEqual(4);
    expect(worstByField(original, 4).worst).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('push 不能再大：0.15 米（现在的 2.5 倍）就有云边上的点多出一下；compress 0.4（现在的 1.6 倍）也有', () => {
    expect(worstByField({ ...L, push: 0.15 }, 4).worst).toBeGreaterThanOrEqual(4);
    expect(worstByField({ ...L, compress: 0.4 }, 4).worst).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('曲线只有「涨 → 落回 1」两段，每一段都是单向的，不过冲、不来回（只看密度倍数，缕系数 1）', () => {
    for (const r of [0.1, 0.2, 0.8, 1.5, 2.2, 2.8]) {
      const fog = fogCurve(Math.round((L.time + 0.3) * 120), 0, r, 1, L, 120);
      const iMax = fog.indexOf(Math.max(...fog));
      for (let k = 1; k <= iMax; k++) expect(fog[k], `r = ${r} 涨, k = ${k}`).toBeGreaterThanOrEqual(fog[k - 1] - 1e-6);
      for (let k = iMax + 1; k < fog.length; k++) expect(fog[k], `r = ${r} 落, k = ${k}`).toBeLessThanOrEqual(fog[k - 1] + 1e-6);
      expect(Math.min(...fog)).toBeGreaterThanOrEqual(1 - 1e-9); // 没有变薄
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
    expect(f.drafts[0].amt.value.w).toBeGreaterThan(0.3 * L.compress); // 0.4 秒时幅度还剩约一半（(1 − u)^1.5）
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
