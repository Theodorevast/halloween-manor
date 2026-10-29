// 地上的范围霜线（src/view/rangeFrost.ts，手感 FEEL-2、FEEL-11）：
// - 范围掩码（二值图）和模拟结算用的是同一套规则：每个物件随机取 500 个格心，和 canSee / canHear / facesToward 直接算的结果一致；
//   现身那张和「察觉半径内、有视线」一致；再放真访客进模拟里，附身那一步谁被吓到 / 谁听见，和掩码说的一样
// - 有符号距离：正负和掩码一致，边界在两格中间；墙不出线（墙两边都不画线，只有距离到头、视线被挡、正面以外那几处出线）
// - 模块：平时藏着、标了 deferCompile；对准时 0.25 秒浮现、移开 0.35 秒退掉；冷却中整体减半；现身蓄力时前沿长到 5 米，收回后化掉；
//   冷却好了脚下的霜往外呼一次（瞄着物件、减少动态、鬼魂在墙里时不呼）
import * as THREE from 'three/webgpu';
import { describe, expect, test, vi } from 'vitest';
import { blocksSight, buildTiles, cellOf, GRID_H, GRID_W, idx, PROPS, propCenter, type Tile } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { MANIFEST, VISION } from '../src/config/visitors';
import type { CameraRig, GhostRig, RenderCore } from '../src/engine/types';
import { angleOf } from '../src/lib/angle';
import { Grid } from '../src/sim/grid';
import { idleManifest } from '../src/sim/manifest';
import { canHear, canSee } from '../src/sim/perception';
import { createRng } from '../src/sim/rng';
import { facesToward } from '../src/sim/scares';
import type { ScareObjectState, SimEvent, Vec2, WorldState } from '../src/sim/types';
import { createWorld } from '../src/sim/world';
import { createRangeFrost, FIELD, RANGE_FROST, inRange, rangeField, rangeMask, smoothField, solidTexels, texelCenter, type RangeAct } from '../src/view/rangeFrost';

const grid = new Grid();
const N = FIELD.w * FIELD.h;
const OBJECTS = PROPS.map((p) => ({ id: p.id, type: p.type, pos: propCenter(p), facing: p.facing }));
const objAct = (id: string): RangeAct => ({ kind: 'object', object: OBJECTS.find((o) => o.id === id)! });

/** 直接用模拟的感知函数算：站在 p、看着物件的访客会不会被它影响（惊吓类：吓到；引诱类：听见） */
function expectedObject(o: (typeof OBJECTS)[number], p: Vec2): boolean {
  const spec = SCARES[o.type];
  if (spec.kind === 'lure') return canHear(grid, p, o.pos, spec.range);
  const look = angleOf(o.pos.x - p.x, o.pos.z - p.z);
  return facesToward(o, p) && canSee(grid, { pos: p, lookDir: look }, o.pos, Math.min(spec.range, VISION.range));
}
/** 现身：察觉半径内（蓄力时就转过来了）、落下时看得见那里（视线、MANIFEST.range） */
function expectedManifest(at: Vec2, p: Vec2): boolean {
  const look = angleOf(at.x - p.x, at.z - p.z);
  return Math.hypot(at.x - p.x, at.z - p.z) <= MANIFEST.noticeRadius && canSee(grid, { pos: p, lookDir: look }, at, MANIFEST.range);
}

const tiles = buildTiles();
const solidAt = (p: Vec2) => {
  const [i, j] = cellOf(p.x, p.z);
  return blocksSight(tiles[idx(i, j)] as Tile);
};
const uvOf = (k: number) => [k % FIELD.w, Math.floor(k / FIELD.w)] as const;
const at = (u: number, v: number) => v * FIELD.w + u;

describe('范围掩码：和结算同一套规则', () => {
  test('格子：128 × 96，每格 0.125 米，盖满整栋房子；格心在格子正中', () => {
    expect(FIELD.w * FIELD.cell).toBeCloseTo(GRID_W * 0.5, 9);
    expect(FIELD.h * FIELD.cell).toBeCloseTo(GRID_H * 0.5, 9);
    expect(texelCenter(0)).toEqual({ x: 0.0625, z: 0.0625 });
    expect(texelCenter(at(5, 3))).toEqual({ x: 5.5 * 0.125, z: 3.5 * 0.125 });
  });

  test.each(OBJECTS.map((o) => [o.id, o] as const))('%s：随机 500 个格心，和 canSee / canHear / facesToward 一致', (_id, o) => {
    const mask = rangeMask(grid, { kind: 'object', object: o });
    expect(mask.length).toBe(N);
    const rng = createRng(0x5eed ^ o.id.length * 977);
    for (let n = 0; n < 500; n++) {
      const k = Math.floor(rng.next() * N);
      const p = texelCenter(k);
      expect({ k, p, inside: mask[k] === 1 }).toEqual({ k, p, inside: expectedObject(o, p) });
      expect(inRange(grid, { kind: 'object', object: o }, p)).toBe(mask[k] === 1);
    }
    // 不是空的、也不是满的：每个物件都有里面和外面
    const inside = mask.reduce((c, m) => c + m, 0);
    expect(inside).toBeGreaterThan(50);
    expect(inside).toBeLessThan(N - 50);
  });

  test('整张对一遍（不抽样）：每个格心都和直接算的一致', () => {
    for (const o of OBJECTS) {
      const mask = rangeMask(grid, { kind: 'object', object: o });
      let bad = 0;
      for (let k = 0; k < N; k++) if ((mask[k] === 1) !== expectedObject(o, texelCenter(k))) bad++;
      expect({ id: o.id, bad }).toEqual({ id: o.id, bad: 0 });
    }
  });

  test('镜子：只算正面（朝东），2.5 米；Nora 站 2.75 米在外面，Ezra 2.15 米在里面（feel-shots 的 C 段）', () => {
    const mask = rangeMask(grid, objAct('mirror'));
    const m = OBJECTS.find((o) => o.id === 'mirror')!;
    const k = (p: Vec2) => at(Math.floor(p.x / FIELD.cell), Math.floor(p.z / FIELD.cell));
    expect(mask[k({ x: 14.0, z: 8.9 })]).toBe(0); // Nora 2.75 米
    expect(mask[k({ x: 13.4, z: 8.85 })]).toBe(1); // Ezra 2.15 米
    expect(mask[k({ x: m.pos.x - 0.2, z: m.pos.z + 1 })]).toBe(0); // 镜子背后那一侧
  });

  test('现身：12 个随机站位 × 500 个格心，和「察觉半径内、有视线」一致；墙格里现身是空的', () => {
    const rng = createRng(4242);
    let placed = 0;
    while (placed < 12) {
      const a = { x: rng.range(0.5, 15.5), z: rng.range(0.5, 11.5) };
      if (solidAt(a)) continue;
      placed++;
      const mask = rangeMask(grid, { kind: 'manifest', at: a });
      for (let n = 0; n < 500; n++) {
        const k = Math.floor(rng.next() * N);
        const p = texelCenter(k);
        expect({ a, p, inside: mask[k] === 1 }).toEqual({ a, p, inside: expectedManifest(a, p) });
      }
    }
    // 鬼魂在墙格里（world.manifest 不让现身）：谁也看不见那里
    const wall = rangeMask(grid, { kind: 'manifest', at: { x: 5.25, z: 2.5 } });
    expect(wall.reduce((c, m) => c + m, 0)).toBe(0);
  });

  test('现算一张范围（二值图 + 距离变换 + 平滑）几毫秒：空闲时先算好，第一次瞄准还没算到、现身蓄力时现算', () => {
    const solid = solidTexels(grid);
    const all = () => { for (const o of OBJECTS) smoothField(rangeField(rangeMask(grid, { kind: 'object', object: o }), solid), solid); };
    // 先热一遍（第一次是冷的 JIT），再取三次里最快的一次：墙钟断言在机器忙时会抖，刚合并完冷编译时偶尔超过上限
    all();
    let best = Infinity;
    for (let k = 0; k < 3; k++) {
      const t0 = performance.now();
      all();
      best = Math.min(best, performance.now() - t0);
    }
    expect(best / OBJECTS.length).toBeLessThan(25); // 测试机上的宽松上限；页面里实测 1.6–2.7 毫秒，见报告
  });
});

describe('范围掩码：放真访客进模拟，附身那一步的结算和掩码一致', () => {
  /** 在物件周围随机站一批人（能走的格子），都看着物件；附身一下走一步，返回 [是否在掩码里, 是否被吓到 / 听见] */
  function settle(id: string, seed: number, count: number) {
    const o = OBJECTS.find((x) => x.id === id)!;
    const mask = rangeMask(grid, objAct(id));
    const lure = SCARES[o.type].kind === 'lure';
    const out: [boolean, boolean][] = [];
    const rng = createRng(seed);
    for (let batch = 0; batch < count / 20; batch++) {
      const w = createWorld({ seed: seed + batch, autoSpawn: false });
      const who = new Map<number, boolean>();
      while (who.size < 20) {
        const k = Math.floor(rng.next() * N);
        const p = texelCenter(k);
        if (!grid.walkableAt(p) || Math.hypot(p.x - o.pos.x, p.z - o.pos.z) > SCARES[o.type].range + 2) continue;
        const s = w.spawn({ pos: p, lookDir: angleOf(o.pos.x - p.x, o.pos.z - p.z), personality: 'average', goal: p });
        who.set(s.id, mask[k] === 1);
      }
      // 放人、附身之后只走一步：这一步先结算引诱、惊吓，再让人走动（world.ts 的顺序），站位和手电朝向都还是放进来时的
      expect(w.trigger(id)).toBe(true);
      const ev = w.step(1 / 60);
      const want = lure ? 'heard' : 'startle';
      const hit = new Set(
        ev.filter((e): e is Extract<SimEvent, { type: 'startle' | 'heard' }> => (e.type === 'startle' || e.type === 'heard') && e.type === want && e.object === id).map((e) => e.npc),
      );
      for (const [npc, inside] of who) out.push([inside, hit.has(npc)]);
    }
    return out;
  }

  test.each([['lamp-living'], ['lamp-bedroom'], ['music-box'], ['kitchen-door']])('%s：每个人都对得上，里外都有人', (id) => {
    const res = settle(id, 77 + id.length, 120);
    const mismatched = res.filter(([a, b]) => a !== b);
    expect(mismatched).toEqual([]);
    expect(res.some(([a]) => a)).toBe(true);
    expect(res.some(([a]) => !a)).toBe(true);
  });
});

describe('有符号距离：线只出在范围真正的边上', () => {
  const solid = solidTexels(grid);
  const W = RANGE_FROST.width.ghost;

  test('墙格、窗格才是「实」的；门洞、家具、物件格不是', () => {
    for (let k = 0; k < N; k++) expect(solid[k] === 1).toBe(solidAt(texelCenter(k)));
  });

  test.each(OBJECTS.map((o) => [o.id] as const))('%s：正负和掩码一致；边界两侧各半格；夹在 ±clamp', (id) => {
    const mask = rangeMask(grid, objAct(id));
    const f = rangeField(mask, solid);
    for (let k = 0; k < N; k++) {
      expect(Math.abs(f[k])).toBeLessThanOrEqual(FIELD.clamp + 1e-9);
      if (solid[k]) continue;
      expect({ k, positive: f[k] > 0 }).toEqual({ k, positive: mask[k] === 1 });
      const [u, v] = uvOf(k);
      // 和左右、上下的邻格（都不是墙）分在边界两侧：各离边界半格
      for (const [du, dv] of [[1, 0], [0, 1]]) {
        const uu = u + du, vv = v + dv;
        if (uu >= FIELD.w || vv >= FIELD.h) continue;
        const k2 = at(uu, vv);
        if (solid[k2] || mask[k2] === mask[k]) continue;
        expect(Math.abs(f[k])).toBeCloseTo(FIELD.cell / 2, 2);
        expect(Math.abs(f[k2])).toBeCloseTo(FIELD.cell / 2, 2);
      }
    }
  });

  test('距离：抽 300 个格心和暴力算的「到最近的另一侧地板格」比，误差 ≤ 4 厘米（chamfer 的近似）', () => {
    const rng = createRng(99);
    for (const id of ['lamp-living', 'mirror', 'music-box']) {
      const mask = rangeMask(grid, objAct(id));
      const f = rangeField(mask, solid);
      for (let n = 0; n < 100; n++) {
        const k = Math.floor(rng.next() * N);
        if (solid[k]) continue;
        const p = texelCenter(k);
        let best = Infinity;
        for (let q = 0; q < N; q++) {
          if (solid[q] || mask[q] === mask[k]) continue;
          const c = texelCenter(q);
          best = Math.min(best, Math.hypot(c.x - p.x, c.z - p.z));
        }
        const want = Math.min(FIELD.clamp, best - FIELD.cell / 2) * (mask[k] ? 1 : -1);
        expect(Math.abs(f[k] - want)).toBeLessThanOrEqual(0.04 + 1e-6);
      }
    }
  });

  test('客厅台灯：西墙两边都不出线（客厅这侧离边界远，书房那侧在外面）；墙体中间才翻号，被墙身挡住', () => {
    const mask = rangeMask(grid, objAct('lamp-living'));
    const f = rangeField(mask, solid);
    // 客厅 z 0.5–4.5（行 4..35），西墙是第 10 列格子 = x 5.0–5.5 = 纹素列 40..43；书房最东一列纹素 39，客厅最西一列 44
    for (let v = 6; v < 34; v++) {
      expect(f[at(44, v)]).toBeGreaterThan(W + 0.1); // 客厅这侧：远在线之外（只有极淡的片）
      expect(f[at(39, v)]).toBeLessThan(-0.1); // 书房那侧：在外面，什么都不画
      expect(f[at(43, v)]).toBeGreaterThan(0); // 墙格里，靠客厅的半边跟客厅
      expect(f[at(42, v)]).toBeGreaterThan(0);
      expect(f[at(41, v)]).toBeLessThan(0); // 靠书房的半边跟书房
      expect(f[at(40, v)]).toBeLessThan(0);
    }
  });

  test('客厅台灯：走廊里有一段线（门洞外那一楔的边），客厅里没有线', () => {
    const mask = rangeMask(grid, objAct('lamp-living'));
    const f = rangeField(mask, solid);
    const lineIn = (z0: number, z1: number, x0: number, x1: number) => {
      let n = 0;
      for (let k = 0; k < N; k++) {
        const p = texelCenter(k);
        if (solid[k] || p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
        if (f[k] > 0 && f[k] < W) n++;
      }
      return n;
    };
    expect(lineIn(5.0, 7.0, 0.5, 15.5)).toBeGreaterThan(10); // 走廊
    expect(lineIn(0.5, 4.5, 5.5, 10.5)).toBe(0); // 客厅
  });

  test('墙格里的值跟最近的地板走；离地板超过两格（外墙外半边）当作外面', () => {
    const mask = rangeMask(grid, objAct('lamp-living'));
    const f = rangeField(mask, solid);
    // 北外墙：第 0 行格子 = 纹素行 0..3。客厅那一段，靠屋里的两行（2、3）跟客厅（正），外面两行（0、1）是外面
    for (let u = 46; u < 82; u++) {
      expect(f[at(u, 3)]).toBeGreaterThan(0);
      expect(f[at(u, 2)]).toBeGreaterThan(0);
      expect(f[at(u, 1)]).toBe(-FIELD.clamp);
      expect(f[at(u, 0)]).toBe(-FIELD.clamp);
    }
  });
});

describe('平滑：视线那一楔的台阶磨成斜线，别的不动', () => {
  const solid = solidTexels(grid);
  const W = RANGE_FROST.width.ghost;

  test.each(OBJECTS.map((o) => [o.id] as const))('%s：离边界 0.25 米以外，平滑前后正负一样（只磨边界附近）', (id) => {
    const mask = rangeMask(grid, objAct(id));
    const raw = rangeField(mask, solid);
    const f = smoothField(raw, solid);
    let bad = 0;
    for (let k = 0; k < N; k++) {
      if (solid[k] || Math.abs(raw[k]) < 0.25) continue;
      if (f[k] > 0 !== mask[k] > 0) bad++;
    }
    expect(bad).toBe(0);
  });

  test('客厅台灯：平滑以后西墙两边照样不出线（墙格不参与平滑，够不到墙那边的地板）', () => {
    const f = smoothField(rangeField(rangeMask(grid, objAct('lamp-living')), solid), solid);
    for (let v = 6; v < 34; v++) {
      expect(f[at(44, v)]).toBeGreaterThan(W + 0.1);
      expect(f[at(39, v)]).toBeLessThan(-0.1);
    }
  });

  test('走廊里那一楔的边：平滑后的零线比台阶顺（相邻两行的边界横向跳动变小）', () => {
    const mask = rangeMask(grid, objAct('lamp-living'));
    const raw = rangeField(mask, solid);
    const f = smoothField(raw, solid);
    // 走廊（z 5.0–7.0 = 纹素行 40..55）里，从门洞往西找第一个由正变负的位置（插值到零点），看逐行的变化
    const edge = (g: Float32Array, v: number) => {
      for (let u = 70; u > 30; u--) {
        const a = g[at(u, v)], b = g[at(u - 1, v)];
        if (a > 0 && b <= 0) return u - 1 + b / (b - a) + 0.5;
      }
      return NaN;
    };
    const jumps = (g: Float32Array) => {
      let worst = 0;
      for (let v = 41; v < 55; v++) {
        const a = edge(g, v), b = edge(g, v + 1);
        if (Number.isFinite(a) && Number.isFinite(b)) worst = Math.max(worst, Math.abs(a - b));
      }
      return worst * FIELD.cell;
    };
    expect(jumps(raw)).toBeGreaterThanOrEqual(0.25); // 台阶：一跳就是一两格以上
    expect(jumps(f)).toBeLessThan(jumps(raw) * 0.6);
  });
});

// ── 模块：用真的 three 场景（不渲染），看显隐和各段的时间 ──
function makeCore(): RenderCore {
  const scene = new THREE.Scene();
  const houseRoot = new THREE.Group();
  houseRoot.position.set(-8, 0, -6);
  scene.add(houseRoot);
  return { scene, houseRoot, backend: 'WebGPU', quality: 'high' } as unknown as RenderCore;
}
function makeRig(ghost?: Vec2): CameraRig {
  const camera = new THREE.OrthographicCamera(-10, 10, 6, -6, 0.1, 100);
  const base = { camera, quarter: 0, viewDir: { x: 1, z: 0 }, rotate() {}, zoom() {}, shake() {}, intro() {}, onRotate() {}, update() {}, resize() {}, toScreen: () => ({ x: 0, y: 0 }) };
  if (!ghost) return base as unknown as CameraRig;
  return { ...base, camera: new THREE.PerspectiveCamera(60, 1.6, 0.1, 100), ghost: { x: ghost.x, y: 1, z: ghost.z, heading: 0, speed: 0, inWall: false } } as unknown as GhostRig;
}
function makeState(): WorldState {
  return {
    time: 0, npcs: [], scaredOff: 0, hitStop: 0, avoid: [], manifest: idleManifest(),
    objects: OBJECTS.map((o): ScareObjectState => ({ ...o, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0 })),
  };
}
/** 推 seconds 秒（每帧 1/60），返回最后一帧的调试快照 */
function run(m: ReturnType<typeof createRangeFrost>, state: WorldState, seconds: number, clock: { t: number }) {
  const dt = 1 / 60;
  for (let s = 0; s < seconds - 1e-9; s += dt) {
    clock.t += dt;
    m.update({ dt, time: clock.t, state });
  }
  return m.debug();
}

describe('模块：显隐和时间', () => {
  test('一开场就在场景里、平时藏着、标了 deferCompile（开场按钮可用之后由 main.ts 预编译，第一次瞄准不现编）', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const meshes: THREE.Mesh[] = [];
    core.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    expect(meshes.length).toBe(2); // 高档、低档各一份（切画质不重编）
    for (const mesh of meshes) {
      expect(mesh.userData.deferCompile).toBe(true);
      expect(mesh.visible).toBe(false);
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
      expect(mesh.renderOrder).toBe(RANGE_FROST.renderOrder);
    }
    m.dispose();
  });

  test('对准：0.25 秒浮现到 1；移开：0.35 秒线性退掉，退完藏起来', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    run(m, state, 0.1, clock);
    m.show('lamp-living');
    let d = run(m, state, 0.125, clock);
    expect(d.visible).toBe(true);
    expect(d.slots[0].level).toBeGreaterThan(0.6);
    expect(d.slots[0].level).toBeLessThan(0.95);
    expect(d.slots[0].shift).toBeGreaterThan(0); // 边界还在从里面往外推
    d = run(m, state, 0.15, clock);
    expect(d.slots[0].level).toBe(1);
    expect(d.slots[0].shift).toBe(0);
    m.show(null);
    d = run(m, state, 0.175, clock);
    expect(d.slots[0].level).toBeCloseTo(0.5, 1);
    d = run(m, state, 0.2, clock);
    expect(d.slots[0].level).toBe(0);
    expect(d.visible).toBe(false);
    m.dispose();
  });

  test('换一个物件：旧的退、新的进，同时画两张（各占一个通道）', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    m.show('music-box');
    run(m, state, 0.4, clock);
    m.show('lamp-bedroom');
    const d = run(m, state, 0.1, clock);
    const box = d.slots.find((s) => s.id === 'music-box')!;
    const lamp = d.slots.find((s) => s.id === 'lamp-bedroom')!;
    expect(box.level).toBeGreaterThan(0.6);
    expect(box.target).toBe(0);
    expect(lamp.level).toBeGreaterThan(0.3);
    expect(lamp.target).toBe(1);
    m.dispose();
  });

  test('冷却中的物件也画，整体减半', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    state.objects.find((o) => o.id === 'mirror')!.cooldown = 12;
    const clock = { t: 0 };
    m.show('mirror');
    const d = run(m, state, 0.8, clock);
    expect(d.slots[0].level).toBe(1);
    expect(d.slots[0].cool).toBeCloseTo(RANGE_FROST.cooling, 2);
    m.dispose();
  });

  test('现身：蓄力那一刻以鬼魂为中心算掩码，前沿 0.6 秒长到 5 米（和 frost.ts 同一条曲线），收回后 1.2 秒化掉', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    const pos = { x: 8, z: 6 };
    m.onEvent!({ type: 'manifest', phase: 'windup', pos, scared: [] }, state);
    let d = run(m, state, 0.3 + 1 / 60, clock); // 第一帧定起点
    const g = 0.3 / MANIFEST.windup;
    expect(d.manifest.front).toBeCloseTo(MANIFEST.noticeRadius * (1 - (1 - g) ** 2), 1);
    d = run(m, state, 0.4, clock);
    expect(d.manifest.front).toBeCloseTo(MANIFEST.noticeRadius, 6);
    expect(d.manifest.level).toBe(1);
    m.onEvent!({ type: 'manifest', phase: 'drop', pos, scared: [] }, state);
    d = run(m, state, MANIFEST.hold, clock);
    expect(d.manifest.level).toBe(1);
    m.onEvent!({ type: 'manifest', phase: 'end', pos, scared: [] }, state);
    d = run(m, state, 0.6, clock);
    expect(d.manifest.level).toBeCloseTo(0.5, 1);
    d = run(m, state, 0.7, clock);
    expect(d.manifest.level).toBe(0);
    expect(d.visible).toBe(false);
    m.dispose();
  });

  test('一直对着物件按 F：蓄力、停留时物件的范围让开，收回、霜开始化的时候它自己回来（不用重新瞄）', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    const pos = { x: 8, z: 6 };
    m.show('lamp-living');
    run(m, state, 0.4, clock);
    m.onEvent!({ type: 'manifest', phase: 'windup', pos, scared: [] }, state);
    let d = run(m, state, 0.2, clock);
    expect(d.slots[0].target).toBe(0);
    expect(d.slots[0].level).toBeLessThan(0.5);
    d = run(m, state, 1.6, clock);
    expect(d.slots.every((s) => s.id === null)).toBe(true);
    m.onEvent!({ type: 'manifest', phase: 'end', pos, scared: [] }, state);
    d = run(m, state, 0.4, clock);
    const lamp = d.slots.find((s) => s.id === 'lamp-living')!;
    expect(lamp.target).toBe(1);
    expect(lamp.level).toBe(1);
    m.dispose();
  });

  test('冷却好了（cooldown → idle 那一帧）、没瞄着物件：以鬼魂为中心往外呼一次，0.9 秒到 5 米，比蓄力淡，再 1.2 秒化掉', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    state.manifest = { phase: 'cooldown', t: 0, cooldown: 0.05, pos: { x: 3, z: 3 } };
    run(m, state, 0.1, clock);
    state.manifest = idleManifest();
    let d = run(m, state, 0.45 + 1 / 60, clock);
    expect(d.manifest.kind).toBe('exhale');
    expect(d.manifest.center).toEqual({ x: 8, z: 6 });
    expect(d.manifest.front).toBeGreaterThan(MANIFEST.noticeRadius * 0.6);
    expect(d.manifest.front).toBeLessThan(MANIFEST.noticeRadius);
    expect(d.manifest.line).toBe(RANGE_FROST.exhale.line);
    expect(d.manifest.line).toBeLessThan(RANGE_FROST.weights.ghost.line);
    d = run(m, state, 0.45, clock);
    expect(d.manifest.front).toBeCloseTo(MANIFEST.noticeRadius, 6);
    d = run(m, state, RANGE_FROST.exhale.melt + 0.05, clock);
    expect(d.manifest.level).toBe(0);
    expect(d.visible).toBe(false);
    m.dispose();
  });

  test('冷却好了的那一刻上一次现身的霜还在化（快进时会撞上）：呼气接过来；还在蓄力、停留时不呼', () => {
    const core = makeCore();
    const m = createRangeFrost(core, makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const state = makeState();
    const clock = { t: 0 };
    const pos = { x: 3, z: 6 };
    m.onEvent!({ type: 'manifest', phase: 'windup', pos, scared: [] }, state);
    m.onEvent!({ type: 'manifest', phase: 'end', pos, scared: [] }, state);
    state.manifest = { phase: 'cooldown', t: 0, cooldown: 0.05, pos };
    run(m, state, 0.3, clock);
    expect(m.debug().manifest.kind).toBe('manifest'); // 还在化
    state.manifest = idleManifest();
    let d = run(m, state, 0.2, clock);
    expect(d.manifest.kind).toBe('exhale');
    expect(d.manifest.center).toEqual({ x: 8, z: 6 });
    m.dispose();

    const m2 = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false });
    const s2 = makeState();
    m2.onEvent!({ type: 'manifest', phase: 'windup', pos, scared: [] }, s2);
    s2.manifest = { phase: 'cooldown', t: 0, cooldown: 0.05, pos };
    run(m2, s2, 0.1, clock);
    s2.manifest = idleManifest();
    d = run(m2, s2, 0.2, clock);
    expect(d.manifest.kind).toBe('manifest'); // 蓄力那张不让
    m2.dispose();
  });

  test('冷却好了但正瞄着物件、减少动态、鬼魂在墙里、娃娃屋（没有鬼魂）：都不呼', () => {
    const cases: [string, () => ReturnType<typeof createRangeFrost>][] = [
      ['瞄着物件', () => {
        const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false });
        m.show('lamp-living');
        return m;
      }],
      ['减少动态', () => createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => true })],
      ['墙里', () => createRangeFrost(makeCore(), makeRig({ x: 5.25, z: 2.5 }), { reduced: () => false })],
      ['娃娃屋', () => createRangeFrost(makeCore(), makeRig(), { reduced: () => false })],
    ];
    for (const [name, make] of cases) {
      const m = make();
      const state = makeState();
      const clock = { t: 0 };
      state.manifest = { phase: 'cooldown', t: 0, cooldown: 0.05, pos: { x: 3, z: 3 } };
      run(m, state, 0.1, clock);
      state.manifest = idleManifest();
      const d = run(m, state, 0.3, clock);
      expect({ name, kind: d.manifest.kind }).toEqual({ name, kind: null });
      m.dispose();
    }
  });
});

describe('修复第 1 轮：安静时不画（审查 I-1），空闲预算的退路（M-1）', () => {
  test('冷却好了那一刻正安静（收夜的静、光收回、登记簿翻着）：不呼；不安静时照呼', () => {
    let quiet = true;
    const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false, quiet: () => quiet });
    const state = makeState();
    const clock = { t: 0 };
    const cool = () => ({ phase: 'cooldown' as const, t: 0, cooldown: 0.05, pos: { x: 3, z: 3 } });
    state.manifest = cool();
    run(m, state, 0.1, clock);
    state.manifest = idleManifest();
    let d = run(m, state, 0.3, clock);
    expect(d.manifest.kind).toBe(null);
    expect(d.visible).toBe(false);
    expect(m.exhale()).toBe(false); // 手动调也不呼
    quiet = false;
    state.manifest = cool();
    run(m, state, 0.1, clock);
    state.manifest = idleManifest();
    d = run(m, state, 0.3, clock);
    expect(d.manifest.kind).toBe('exhale');
    m.dispose();
  });

  test('对准时变安静：物件的范围照平常 0.35 秒退掉；安静期间对准、现身都不画；安静结束准星还对着就回来', () => {
    let quiet = false;
    const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false, quiet: () => quiet });
    const state = makeState();
    const clock = { t: 0 };
    m.show('lamp-living');
    let d = run(m, state, 0.4, clock);
    expect(d.slots[0].level).toBe(1);
    quiet = true;
    d = run(m, state, 0.175, clock);
    expect(d.slots[0].target).toBe(0);
    expect(d.slots[0].level).toBeCloseTo(0.5, 1);
    d = run(m, state, 0.2, clock);
    expect(d.slots.every((s) => s.id === null)).toBe(true);
    expect(d.visible).toBe(false);
    m.show('mirror');
    m.onEvent!({ type: 'manifest', phase: 'windup', pos: { x: 8, z: 6 }, scared: [] }, state);
    d = run(m, state, 0.5, clock);
    expect(d.slots.every((s) => s.id === null)).toBe(true);
    expect(d.manifest.kind).toBe(null);
    expect(d.visible).toBe(false);
    quiet = false;
    d = run(m, state, 0.3, clock);
    const mirror = d.slots.find((s) => s.id === 'mirror')!;
    expect(mirror.target).toBe(1);
    expect(mirror.level).toBe(1);
    m.dispose();
  });

  test('现身那一圈正停着时变安静：照平常 1.2 秒化掉，不等收回', () => {
    let quiet = false;
    const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false, quiet: () => quiet });
    const state = makeState();
    const clock = { t: 0 };
    m.onEvent!({ type: 'manifest', phase: 'windup', pos: { x: 8, z: 6 }, scared: [] }, state);
    let d = run(m, state, 1.0, clock);
    expect(d.manifest.level).toBe(1);
    expect(d.manifest.front).toBeCloseTo(MANIFEST.noticeRadius, 6);
    quiet = true;
    d = run(m, state, 0.6, clock);
    expect(d.manifest.level).toBeCloseTo(0.5, 1);
    d = run(m, state, 0.7, clock);
    expect(d.manifest.kind).toBe(null);
    expect(d.visible).toBe(false);
    m.dispose();
  });

  test('没有 requestIdleCallback（Safari / iOS）：退成 setTimeout 200 毫秒算一个；dispose 取消这条链', () => {
    vi.useFakeTimers();
    try {
      const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false });
      expect(m.debug().cached).toBe(0);
      vi.advanceTimersByTime(200);
      expect(m.debug().cached).toBe(1);
      vi.advanceTimersByTime(400);
      expect(m.debug().cached).toBe(3);
      m.dispose();
      vi.advanceTimersByTime(5000);
      expect(m.debug().cached).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('有 requestIdleCallback：这一段空闲不够算一个就等下一段，超时那一下照算；算完 9 个就停；dispose 取消还在排的那一个', () => {
    const queue: { cb: (d: IdleDeadline) => void; h: number }[] = [];
    const cancelled: number[] = [];
    let h = 0;
    vi.stubGlobal('requestIdleCallback', (cb: (d: IdleDeadline) => void) => { queue.push({ cb, h: ++h }); return h; });
    vi.stubGlobal('cancelIdleCallback', (x: number) => { cancelled.push(x); });
    try {
      const fire = (left: number, didTimeout = false) => queue.shift()!.cb({ timeRemaining: () => left, didTimeout } as IdleDeadline);
      const m = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false });
      expect(queue.length).toBe(1);
      fire(1); // 只剩 1 毫秒、没超时：不算，排下一段
      expect(m.debug().cached).toBe(0);
      expect(queue.length).toBe(1);
      fire(12);
      expect(m.debug().cached).toBe(1);
      fire(0, true); // 等超时了：照算
      expect(m.debug().cached).toBe(2);
      for (let k = 0; k < 7; k++) fire(12);
      expect(m.debug().cached).toBe(PROPS.length);
      expect(queue.length).toBe(0); // 都算完了，不再排
      m.dispose();
      expect(cancelled).toEqual([]);

      const m2 = createRangeFrost(makeCore(), makeRig({ x: 8, z: 6 }), { reduced: () => false });
      const pending = queue[0].h;
      m2.dispose();
      expect(cancelled).toEqual([pending]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
