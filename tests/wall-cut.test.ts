// 第二波路 VX（eye S-1、newbie G3「墙后的洞发蓝光、每帧变形，切开的家具露出纯白截面」）和底光（eye F-1）。
// - 洞不随时间变：没有时间 uniform；CPU 镜像 holeFieldAt（着色器里 dissolveAt 同一个式子，不含只随空间的噪声）说明形状只由鬼魂、镜头的位置决定，
//   穿墙时一路连续（舷窗 → 张大成剖面），平滑并集不出尖角，也不会把场压到洞外
// - 洞边不发光、不结霜：rim、frost 恒为 0，rimGlow 是黑的
// - 截面：跟着材质自己的颜色压暗（着色器靠截图验收，这里守数）
// - 底光：墙角、墙根、墙顶比房间中间、墙面中间暗；走廊的墙上没有不存在的内墙带来的暗带
// - 天花板不接鬼魂的微光（eye G-3 那块跟着镜头走的灰色椭圆）
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { WALL_H } from '../src/config/house';
import { DISSOLVE, HOLE_TEST, ROOM_FILL, dissolveAt, fillShapeAt, holeFieldAt, holeTouchesBox, makeDissolveUniforms, writeDissolve } from '../src/view/walls';

// tsconfig 的 types 里没有 node 的类型：用变量当模块名取 node:fs（tests/overlays.test.ts 同样的写法）
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL, encoding: 'utf8'): string };

type P3 = { x: number; y: number; z: number };
const V = (x: number, y: number, z: number): P3 => ({ x, y, z });
/** 北墙的南面（书房那一侧）：z = 4.65，法线朝南。鬼魂、镜头沿 x = 2.5 往北走 */
const N: P3 = V(0, 0, 1);
const wallZ = 4.65;

describe('洞的形状：只由鬼魂、镜头的位置决定', () => {
  it('没有时间 uniform；writeDissolve 不收时间（原来花纹每秒往上飘 0.06 米，镜头不动洞边也在扭）', () => {
    const u = makeDissolveUniforms();
    expect('time' in u).toBe(false);
    expect(writeDissolve.length).toBe(4);
    const src = readFileSync(new URL('../src/view/walls.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function dissolveAt('), src.indexOf('/** 鬼魂的冷光照到 P 点'));
    expect(body).not.toMatch(/\btime\b/);
    expect(body).not.toMatch(/creep/);
  });

  it('同样的鬼魂和镜头，算两次洞一模一样；洞边的噪声振幅只有几厘米（原来 0.17 + 0.06 米的撕裂边）', () => {
    const g = V(2.5, 1.1, 3.5), c = V(2.5, 2, 6.2);
    for (const P of [V(2.5, 1.2, wallZ), V(3.2, 1.6, wallZ), V(1.1, 0.8, wallZ)]) expect(holeFieldAt(P, N, g, c, 1, true)).toBe(holeFieldAt(P, N, g, c, 1, true));
    const amp = DISSOLVE.noise.reduce((s, n) => s + n.amp, 0);
    expect(amp).toBeLessThanOrEqual(0.08);
    for (const n of DISSOLVE.noise) expect(n.freq).toBeLessThan(5);
  });

  it('真按 W 穿墙（2 米/秒，60 Hz，镜头在后面 2.4 米）：墙上每个点的场一帧变化不超过速度 × (grow + 1) × dt，舷窗一路张大，没有跳变', () => {
    const v = 2, dt = 1 / 60, L = 2.4;
    const maxStep = v * (DISSOLVE.sight.grow + 1) * dt * 1.1;
    const pts: P3[] = [];
    for (let x = 0.5; x <= 5; x += 0.25) for (let y = 0.3; y <= 2.3; y += 0.25) pts.push(V(x, y, wallZ));
    let prev: number[] | null = null;
    let areas: number[] = [];
    // 鬼魂从墙前（南面）1 米走到墙后（北面）足够远，镜头还没过墙就停
    for (let z = wallZ + 1; z + L > wallZ + 0.02; z -= v * dt) {
      const g = V(2.5, 1.15, z), c = V(2.5, 2, z + L);
      const f = pts.map((P) => holeFieldAt(P, N, g, c, 1, true));
      if (prev) f.forEach((d, i) => expect(Math.abs(d - prev![i])).toBeLessThanOrEqual(maxStep));
      prev = f;
      areas.push(f.filter((d) => d < 0).length);
    }
    // 开始时没有洞（还没碰到墙）；鬼魂走远时洞在一路变大；最后整面墙几乎都开了
    expect(areas[0]).toBe(0);
    expect(Math.max(...areas)).toBeGreaterThan(pts.length * 0.8);
    const i0 = areas.findIndex((a) => a > 0);
    areas = areas.slice(i0);
    // 从出现洞开始，往后每帧最多少几个点（洞的大小几乎只往大走；鬼魂身边的洞和视线上的洞交接时有一点起伏）
    for (let i = 1; i < areas.length; i++) expect(areas[i]).toBeGreaterThanOrEqual(areas[i - 1] - pts.length * 0.03);
  });

  it('平滑并集：两个洞连上的地方比 min 只多收最多 blend / 4，离得远时和 min 一样；HOLE_TEST.pad 把这一点算进去了', () => {
    const g = V(2.5, 1.1, wallZ - 0.1), c = V(2.5, 2, wallZ + 2.3);
    const rawMin = (P: P3) => holeFieldAt(P, N, g, c, 1, true, true);
    for (let x = 0.5; x <= 5; x += 0.1) for (let y = 0.2; y <= 2.3; y += 0.1) {
      const P = V(x, y, wallZ);
      const a = holeFieldAt(P, N, g, c, 1, true), b = rawMin(P);
      expect(a).toBeLessThanOrEqual(b + 1e-9);
      expect(b - a).toBeLessThanOrEqual(DISSOLVE.blend / 4 + 1e-9);
    }
    expect(HOLE_TEST.pad).toBeGreaterThanOrEqual(DISSOLVE.noise[0].amp + DISSOLVE.noise[1].amp + DISSOLVE.cut.band + DISSOLVE.blend / 4);
  });
});

describe('洞边：不发光、不结霜；截面跟着材质、偏暗', () => {
  it('dissolveAt 的 rim、frost 恒为 0（常量），rimGlow 是黑的：frontDoor.ts、props.ts 还读这几个名字，读到的都是 0', () => {
    const src = readFileSync(new URL('../src/view/walls.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function dissolveAt('), src.indexOf('/** 鬼魂的冷光照到 P 点'));
    expect(body).toMatch(/frost:\s*float\(0\),\s*rim:\s*float\(0\)/);
    expect(body).not.toMatch(/frostAlbedo|rimGlow|frostGlow|crystal/);
    // 真的建得出节点：frontDoor.ts、props.ts 接着 d.rim、d.frost 乘
    const d = dissolveAt(makeDissolveUniforms(), vec3(0, 0, 0) as unknown as THREE.Node<'vec3'>, vec3(0, 0, 1) as unknown as THREE.Node<'vec3'>);
    expect(typeof d.rim.mul).toBe('function');
    expect(typeof d.frost.mul).toBe('function');
    expect(DISSOLVE.rimGlow.getHex()).toBe(0);
  });

  it('截面只把底色压暗（0 < dark < 1，不混别的颜色），带子很窄（几厘米，不是一道粗黑框）', () => {
    expect(DISSOLVE.cut.dark).toBeGreaterThan(0);
    expect(DISSOLVE.cut.dark).toBeLessThan(1);
    expect(DISSOLVE.cut.band).toBeLessThanOrEqual(0.06);
    const src = readFileSync(new URL('../src/view/walls.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export function applyDissolve('), src.indexOf('这一帧墙上、家具上会不会有洞或截面'));
    expect(body).not.toMatch(/frostAlbedo|rimGlow|frostGlow/);
  });

  it('舷窗本身留着：视线胶囊、墙后从交点剖开的规则还在', () => {
    // 鬼魂刚过墙（沿吊臂过了不到 cutFrom）：交点附近有洞、离得远的墙还在——是舷窗，不是整面没了
    const g = V(2.5, 1.15, wallZ - 0.4), c = V(2.5, 2, wallZ + 2);
    expect(holeFieldAt(V(2.5, 1.3, wallZ), N, g, c, 1, true)).toBeLessThan(0);
    expect(holeFieldAt(V(0.6, 1.3, wallZ), N, g, c, 1, true)).toBeGreaterThan(0);
    expect(holeFieldAt(V(4.6, 1.3, wallZ), N, g, c, 1, true)).toBeGreaterThan(0);
    expect(DISSOLVE.sight.cutFrom).toBeGreaterThan(0);
    expect(DISSOLVE.sight.grow).toBeGreaterThan(0);
  });
});

describe('试玩 S1：物件被挖开时不像渲染坏了', () => {
  it('家具、物件（holeScale 不是 1）：鬼魂周围的洞不看面的法线，薄部件各个面的洞口对得上（不再一圈错开的小台阶）；墙还是按面压扁', () => {
    const ghost = V(5, 1.2, 5), cam = V(5, 2, 7.4);
    const normals = [V(1, 0, 0), V(-1, 0, 0), V(0, 1, 0), V(0, 0, 1), V(0, 0, -1)];
    for (const P of [V(5.3, 1.2, 5), V(5, 1.6, 5.1), V(4.7, 0.9, 4.8), V(5.45, 1.2, 5)]) {
      const f = normals.map((n) => holeFieldAt(P, n, ghost, cam, DISSOLVE.furniture));
      for (const v of f) expect(v).toBeCloseTo(f[0], 10);
      const w = normals.map((n) => holeFieldAt(P, n, ghost, cam, 1));
      expect(Math.max(...w) - Math.min(...w)).toBeGreaterThan(0.01);
    }
  });

  it('holeTouchesBox：鬼魂贴着、视线穿过的物件算被挖开（外壳不画）；瞄着前面够得着的物件（洞没碰到）照常', () => {
    const box = { x0: 2, z0: 2, x1: 3, z1: 2.4 };
    // 鬼魂贴着
    expect(holeTouchesBox(box, { x: 2.5, z: 2.7 }, { x: 2.5, z: 5 })).toBe(true);
    // 镜头在物件这边、鬼魂在那边：视线穿过物件
    expect(holeTouchesBox(box, { x: 2.5, z: 3.6 }, { x: 2.5, z: 1.2 })).toBe(true);
    // 视线从旁边擦过，离它不到胶囊半径
    expect(holeTouchesBox(box, { x: 3.4, z: 4.2 }, { x: 3.4, z: 0.5 })).toBe(true);
    // 鬼魂面对着 1.6 米外的物件，镜头在鬼魂后面：洞碰不到，外壳照常（悬停的描边还在）
    expect(holeTouchesBox(box, { x: 2.5, z: 4 }, { x: 2.5, z: 6.4 })).toBe(false);
    // 隔着一段距离从旁边过
    expect(holeTouchesBox(box, { x: 5, z: 2 }, { x: 5, z: 4.4 })).toBe(false);
  });

  it('物件的底光、洞口压暗都接上了；前门也有底光（门板不再是一块黑）', () => {
    const props = readFileSync(new URL('../src/view/props.ts', import.meta.url), 'utf8');
    const body = props.slice(props.indexOf('const dissolveMaterial ='), props.indexOf('const frost = createFrostHint()'));
    expect(body).toMatch(/diffuseColor\.rgb\.mul\(roomFillAt\(P, ROOM_FILL\.props\)\)/);
    expect(body).toMatch(/DISSOLVE\.cut\.thinDark/);
    const door = readFileSync(new URL('../src/view/frontDoor.ts', import.meta.url), 'utf8');
    expect(door).toMatch(/roomFillAt\(P, ROOM_FILL\.props\)/);
    // 被挖开的物件，外壳的亮度乘 whole
    expect(props).toMatch(/e\.glow\.amount\.value = amount \* e\.whole/);
    // 洞口压得比原来暗（原来 0.4），是自己的颜色乘一个数，不混别的颜色；物件的细部件压得轻一点，不是一根黑刺
    expect(DISSOLVE.cut.dark).toBeLessThanOrEqual(0.3);
    expect(DISSOLVE.cut.thinDark).toBeGreaterThan(DISSOLVE.cut.dark);
    expect(DISSOLVE.cut.thinDark).toBeLessThan(1);
  });
});

describe('底光：墙角仍然暗', () => {
  // 书房：x 0.25..5.25，z 0.25..4.75（墙体中线）；墙面离中线 0.1 米
  it('竖着的墙角比墙面中间暗得多；地板的四角比中间暗得多', () => {
    expect(fillShapeAt(0.4, 1.2, 0.35, 'upright')).toBeLessThan(fillShapeAt(2.75, 1.2, 0.35, 'upright') * 0.45);
    expect(fillShapeAt(0.4, 0, 0.4, 'flat')).toBeLessThan(fillShapeAt(2.75, 0, 2.5, 'flat') * 0.35);
  });

  it('墙根、墙顶比墙面中间暗；地板、天花板离墙近的地方比中间暗', () => {
    const mid = fillShapeAt(2.75, 1.2, 0.35, 'upright');
    expect(mid).toBeCloseTo(1, 1);
    expect(fillShapeAt(2.75, 0.02, 0.35, 'upright')).toBeLessThan(mid * 0.7);
    expect(fillShapeAt(2.75, WALL_H, 0.35, 'upright')).toBeLessThan(mid * 0.7);
    expect(fillShapeAt(2.75, 0, 0.4, 'flat')).toBeLessThan(fillShapeAt(2.75, 0, 2.5, 'flat') * 0.8);
  });

  it('房间中间的地板、墙面中间是满的；任何地方都不是 0（轮廓总看得出）、不超过 1', () => {
    expect(fillShapeAt(2.75, 0, 2.5, 'flat')).toBeCloseTo(1, 5);
    for (let x = 0.1; x <= 15.9; x += 0.3) for (let z = 0.1; z <= 11.9; z += 0.3) for (const y of [0, 0.5, 1.2, 2.4]) {
      for (const s of ['upright', 'flat'] as const) {
        const k = fillShapeAt(x, y, z, s);
        expect(k).toBeGreaterThanOrEqual(ROOM_FILL.corner.level * Math.min(ROOM_FILL.low[0], ROOM_FILL.high[0], ROOM_FILL.edge[0]) - 1e-9);
        expect(k).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('走廊的墙上，内墙的位置（x = 5.25）不多出一条暗带：内墙只到走廊边上', () => {
    // 走廊 z 5..7，墙面在 z = 4.85 上。x = 5.25 正对着书房和客厅之间的内墙，隔着走廊的墙，走廊里看不见它
    expect(fillShapeAt(5.25, 1.2, 4.86, 'upright')).toBeCloseTo(fillShapeAt(3, 1.2, 4.86, 'upright'), 5);
  });
});

describe('天花板上那块灰色椭圆（eye G-3）', () => {
  it('天花板不接鬼魂的微光（ghostGlow: false），墙、家具、地板照旧', () => {
    const house = readFileSync(new URL('../src/view/house.ts', import.meta.url), 'utf8');
    const ceiling = house.slice(house.indexOf('function buildCeiling('), house.indexOf('// ───────────────────────── 组装'));
    expect(ceiling).toMatch(/ghostGlow:\s*false/);
    expect(house.slice(house.indexOf('function buildFloors('), house.indexOf('// ───────────────────────── 屋外'))).toMatch(/ghostGlowAt\(/);
  });
});
