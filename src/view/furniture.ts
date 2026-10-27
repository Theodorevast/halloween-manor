// 家具：FURNITURE 里每种 FurnitureKind 用基础几何体拼成低多边形模型，全部合成一个网格（1 次 draw call）。
// 模型坐标：正面朝 +z，x 是宽度方向，y 向上；摆放时按 yawFor(facing) 转向、平移到 rect 中心。
// 填满 rect；背后贴着墙格时，背面再往后伸到墙面（墙体只有 WALL_T 厚，墙格靠屋里那 0.15 米本来就走不进去），
// 不然书架、衣柜和墙之间会露一条缝。
// 第三人称模式（传了 dissolve）：鬼魂穿过家具时，家具在它周围溶开、洞边结霜，和墙一样（walls.ts 的 DISSOLVE），
// 洞比墙上的小一圈（DISSOLVE.furniture）；家具的影子照旧。
import * as THREE from 'three/webgpu';
import { attribute, positionLocal } from 'three/tsl';
import { CELL, FURNITURE, Tile, WALL_T, idx, inGrid, type Furniture, type FurnitureKind } from '../config/house';
import { yawFor } from '../lib/angle';
import { PALETTE } from './palette';
import { DISSOLVE, GeoBuilder, applyDissolve, type DissolveUniforms } from './walls';

/**
 * 家具的关键高度（米，从地板算）。物件任务按这些数摆东西：八音盒放在床头柜顶面上
 */
export const FURNITURE_TOP: Record<FurnitureKind, number> = {
  bookshelf: 2.0,
  desk: 0.75,
  sofa: 0.42, // 坐面；靠背 0.86
  fireplace: 1.16, // 壁炉台面
  counter: 0.9,
  table: 0.75,
  bed: 0.5, // 床面；床头板 1.15
  nightstand: 0.55,
  wardrobe: 2.1,
  coatRack: 1.75,
  bathtub: 0.62,
  sink: 0.85,
  rug: 0.016,
  runner: 0.016,
};

// ───────────────────────── 颜色 ─────────────────────────

const C = (hex: number) => new THREE.Color(hex);
const shade = (hex: number, k: number) => C(hex).multiplyScalar(k);
const mixC = (a: number, b: number, t: number) => C(a).lerp(C(b), t);

const COL = {
  woodDark: C(PALETTE.woodDark),
  wood: C(PALETTE.wood),
  woodLight: shade(PALETTE.wood, 1.35),
  iron: shade(PALETTE.wallTrim, 0.55),
  stone: mixC(PALETTE.tile, PALETTE.wallTrim, 0.45),
  stoneDark: mixC(PALETTE.tile, PALETTE.wallTrim, 0.75),
  marble: shade(PALETTE.tile, 1.25),
  porcelain: mixC(PALETTE.tile, PALETTE.moonSky, 0.45).multiplyScalar(1.3),
  linen: mixC(PALETTE.wallpaper, PALETTE.moonSky, 0.5).multiplyScalar(1.45),
  fabric: C(PALETTE.fabric),
  fabricDark: shade(PALETTE.fabric, 0.6),
  fabricLight: shade(PALETTE.fabric, 1.35),
  green: mixC(PALETTE.wallTrim, PALETTE.possess, 0.06).multiplyScalar(0.85),
  brass: C(PALETTE.brass),
  ash: shade(PALETTE.tile, 0.7),
  ink: shade(PALETTE.wallTrim, 0.4),
  candle: mixC(PALETTE.lamp, PALETTE.moonSky, 0.55).multiplyScalar(1.2),
  paper: mixC(PALETTE.lamp, PALETTE.tile, 0.6).multiplyScalar(1.1),
};
/** 书脊的颜色：在调色板周围变化 */
const BOOKS = [
  C(PALETTE.fabric), shade(PALETTE.fabric, 0.7), mixC(PALETTE.wallTrim, PALETTE.possess, 0.15),
  mixC(PALETTE.wallpaper, PALETTE.moon, 0.5), C(PALETTE.wood), shade(PALETTE.brass, 0.75),
  mixC(PALETTE.woodDark, PALETTE.fabric, 0.5), shade(PALETTE.tile, 0.6),
];

/** 表面：粗糙度、金属度（顶点属性 surf） */
const MATTE = [0.88, 0] as const;
const VARNISH = [0.55, 0] as const;
const GLAZE = [0.28, 0] as const;
const METAL = [0.42, 0.75] as const;
const CLOTH = [0.98, 0] as const;

/** 确定性随机（书的宽度、颜色这类摆设用），同一份布局每次一样 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────────────────────── 拼装工具 ─────────────────────────

/** 模型坐标里的一件家具：宽 w（x：-w/2..w/2），进深 z：zb（背面）..zf（正面） */
interface Frame { w: number; zb: number; zf: number; rand: () => number }

class Kit {
  private m = new THREE.Matrix4();
  constructor(readonly b: GeoBuilder) {}

  surf(s: readonly [number, number]) { this.b.set('surf', s[0], s[1]); return this; }

  /** 轴对齐盒子（模型坐标） */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: THREE.Color, s: readonly [number, number] = MATTE) {
    this.b.color(c);
    this.surf(s);
    this.b.box(Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1), Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1));
    return this;
  }

  /** 以 (x, z) 为底面中心、竖直的低多边形柱子；sx / sz 不同就成了椭圆柱 */
  cyl(x: number, z: number, y0: number, y1: number, r: number, c: THREE.Color, opts: { seg?: number; rTop?: number; sx?: number; sz?: number; s?: readonly [number, number] } = {}) {
    const g = new THREE.CylinderGeometry(opts.rTop ?? r, r, y1 - y0, opts.seg ?? 6);
    this.m.makeScale(opts.sx ?? 1, 1, opts.sz ?? 1).setPosition(x, (y0 + y1) / 2, z);
    this.b.color(c);
    this.surf(opts.s ?? MATTE);
    this.b.geometry(g, this.m);
    return this;
  }

  /** 横放的圆柱（木柴、毛巾杆）：沿 x 方向 */
  log(x0: number, x1: number, y: number, z: number, r: number, c: THREE.Color, yaw = 0) {
    const g = new THREE.CylinderGeometry(r, r, Math.abs(x1 - x0), 5);
    const rot = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const turn = new THREE.Matrix4().makeRotationY(yaw);
    this.m.identity().multiply(turn).multiply(rot);
    this.m.setPosition((x0 + x1) / 2, y, z);
    this.b.color(c);
    this.surf(MATTE);
    this.b.geometry(g, this.m);
    return this;
  }

  /** 绕竖直轴转一个角度的扁盒子（地毯花纹、桌上的纸） */
  tilted(x: number, z: number, y0: number, y1: number, w: number, d: number, yaw: number, c: THREE.Color, s: readonly [number, number] = MATTE) {
    const g = new THREE.BoxGeometry(w, y1 - y0, d);
    this.m.makeRotationY(yaw).setPosition(x, (y0 + y1) / 2, z);
    this.b.color(c);
    this.surf(s);
    this.b.geometry(g, this.m);
    return this;
  }
}

// ───────────────────────── 各种家具 ─────────────────────────

type Maker = (k: Kit, f: Frame) => void;

const bookshelf: Maker = (k, { w, zb, zf, rand }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.bookshelf, side = 0.05;
  k.box(x0, 0, zb, x0 + side, H - 0.06, zf, COL.woodDark, VARNISH);
  k.box(x1 - side, 0, zb, x1, H - 0.06, zf, COL.woodDark, VARNISH);
  k.box(x0, 0, zb, x1, H - 0.06, zb + 0.03, COL.iron);
  k.box(x0 + side, 0, zb, x1 - side, 0.1, zf - 0.02, COL.woodDark); // 踢脚
  k.box(x0, H - 0.06, zb, x1, H, zf, COL.wood, VARNISH); // 顶冠
  const shelves = [0.1, 0.56, 1.02, 1.48, H - 0.09];
  for (let s = 0; s < shelves.length; s++) {
    const y = shelves[s];
    k.box(x0 + side, y, zb + 0.03, x1 - side, y + 0.03, zf, COL.wood, VARNISH);
    if (s === shelves.length - 1) break;
    // 一排书：宽窄、高矮、颜色随机，偶尔留空
    const top = shelves[s + 1] - 0.04;
    let x = x0 + side + 0.01;
    while (x < x1 - side - 0.05) {
      const bw = 0.03 + rand() * 0.045;
      if (rand() < 0.08) { x += bw * 2; continue; }
      const bh = Math.min(top - y - 0.03, 0.26 + rand() * 0.14);
      const bd = 0.2 + rand() * 0.08;
      const c = BOOKS[Math.floor(rand() * BOOKS.length)].clone().multiplyScalar(0.8 + rand() * 0.4);
      k.box(x, y + 0.03, zf - 0.02 - bd, Math.min(x + bw, x1 - side - 0.005), y + 0.03 + bh, zf - 0.02, c, CLOTH);
      x += bw + 0.004;
    }
  }
};

const desk: Maker = (k, { w, zb, zf, rand }) => {
  const H = FURNITURE_TOP.desk, x0 = -w / 2, x1 = w / 2;
  k.box(x0, H - 0.04, zb, x1, H, zf, COL.woodDark, VARNISH);
  k.box(x0 + 0.08, H, zb + 0.08, x1 - 0.08, H + 0.003, zf - 0.08, COL.green, CLOTH); // 皮面
  for (const [a, b] of [[x0 + 0.02, x0 + 0.34], [x1 - 0.34, x1 - 0.02]]) {
    k.box(a, 0, zb + 0.04, b, H - 0.04, zf - 0.03, COL.wood, VARNISH);
    for (let d = 0; d < 3; d++) {
      const y = 0.05 + d * 0.21;
      k.box(a + 0.02, y, zf - 0.03, b - 0.02, y + 0.18, zf - 0.01, COL.woodDark, VARNISH);
      k.box((a + b) / 2 - 0.025, y + 0.08, zf - 0.01, (a + b) / 2 + 0.025, y + 0.1, zf + 0.005, COL.brass, METAL);
    }
  }
  k.box(x0 + 0.34, 0.25, zb + 0.04, x1 - 0.34, H - 0.04, zb + 0.07, COL.wood); // 挡板
  k.box(x0 + 0.34, H - 0.16, zf - 0.05, x1 - 0.34, H - 0.04, zf - 0.02, COL.woodDark, VARNISH); // 中间抽屉
  // 桌面上的东西：一摞书、墨水瓶、烛台、几张纸
  k.box(x0 + 0.12, H, zb + 0.12, x0 + 0.36, H + 0.05, zb + 0.32, BOOKS[0], CLOTH);
  k.box(x0 + 0.14, H + 0.05, zb + 0.14, x0 + 0.35, H + 0.09, zb + 0.31, BOOKS[3], CLOTH);
  k.cyl(x1 - 0.2, zb + 0.2, H, H + 0.05, 0.025, COL.ink, { s: GLAZE });
  k.cyl(x1 - 0.16, zb + 0.4, H, H + 0.02, 0.05, COL.brass, { s: METAL });
  k.cyl(x1 - 0.16, zb + 0.4, H + 0.02, H + 0.14, 0.012, COL.brass, { s: METAL });
  k.cyl(x1 - 0.16, zb + 0.4, H + 0.14, H + 0.2, 0.014, COL.candle);
  for (let i = 0; i < 3; i++) {
    k.tilted(0.02 + i * 0.03, (zb + zf) / 2 + 0.05 + i * 0.02, H + 0.004 + i * 0.002, H + 0.006 + i * 0.002, 0.21, 0.28, (rand() - 0.5) * 0.5, COL.paper);
  }
};

const fireplace: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, M = FURNITURE_TOP.fireplace;
  k.box(x0, 0, zb, x1, 0.06, zf, COL.stoneDark); // 炉床
  k.box(x0, 0.06, zb, x0 + 0.2, M - 0.06, zf - 0.06, COL.stone);
  k.box(x1 - 0.2, 0.06, zb, x1, M - 0.06, zf - 0.06, COL.stone);
  k.box(x0 + 0.2, 0.78, zb, x1 - 0.2, M - 0.06, zf - 0.06, COL.stone);
  k.box(x0 + 0.2, 0.06, zb, x1 - 0.2, 0.78, zb + 0.12, COL.iron); // 炉膛深处
  k.box(x0 + 0.2, 0.06, zb + 0.12, x0 + 0.24, 0.78, zf - 0.08, COL.iron);
  k.box(x1 - 0.24, 0.06, zb + 0.12, x1 - 0.2, 0.78, zf - 0.08, COL.iron);
  k.box(x0, M - 0.06, zb, x1, M, zf, COL.woodDark, VARNISH); // 壁炉台
  // 冷掉的炉膛：铁架、两根木柴、一点灰
  k.box(x0 + 0.28, 0.06, zb + 0.2, x1 - 0.28, 0.1, zf - 0.14, COL.ash);
  k.box(x0 + 0.3, 0.1, zf - 0.16, x1 - 0.3, 0.2, zf - 0.14, COL.iron);
  k.log(x0 + 0.3, x1 - 0.32, 0.15, zb + 0.28, 0.045, COL.woodDark, 0.15);
  k.log(x0 + 0.34, x1 - 0.3, 0.22, zb + 0.32, 0.04, shade(PALETTE.woodDark, 0.6), -0.2);
  // 台面上：座钟、两个烛台
  k.box(-0.09, M, zb + 0.06, 0.09, M + 0.2, zb + 0.18, COL.woodDark, VARNISH);
  k.cyl(0, zb + 0.181, M + 0.1, M + 0.11, 0.06, COL.brass, { seg: 8, s: METAL });
  for (const x of [x0 + 0.1, x1 - 0.1]) {
    k.cyl(x, zb + 0.15, M, M + 0.02, 0.04, COL.brass, { s: METAL });
    k.cyl(x, zb + 0.15, M + 0.02, M + 0.16, 0.012, COL.brass, { s: METAL });
    k.cyl(x, zb + 0.15, M + 0.16, M + 0.24, 0.014, COL.candle);
  }
};

const sofa: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, seat = FURNITURE_TOP.sofa;
  for (const x of [x0 + 0.06, x1 - 0.06]) for (const z of [zb + 0.06, zf - 0.06]) k.cyl(x, z, 0, 0.12, 0.025, COL.woodDark, { rTop: 0.035 });
  k.box(x0, 0.12, zb, x1, 0.3, zf, COL.fabricDark, CLOTH); // 底座
  k.box(x0 + 0.1, 0.3, zb + 0.12, x1 - 0.1, seat, zf, COL.fabric, CLOTH); // 坐垫
  k.box(x0 + 0.02, 0.12, zf - 0.015, x1 - 0.02, 0.17, zf + 0.0, COL.woodDark, VARNISH); // 前沿木条
  k.box(x0, 0.3, zb, x1, 0.76, zb + 0.12, COL.fabric, CLOTH); // 靠背
  k.box(x0 + 0.5, 0.76, zb, x1 - 0.5, 0.86, zb + 0.12, COL.fabric, CLOTH); // 驼峰
  k.box(x0 + 0.2, 0.76, zb, x0 + 0.5, 0.81, zb + 0.12, COL.fabric, CLOTH);
  k.box(x1 - 0.5, 0.76, zb, x1 - 0.2, 0.81, zb + 0.12, COL.fabric, CLOTH);
  k.box(x0 + 0.5, 0.86, zb, x1 - 0.5, 0.875, zb + 0.12, COL.woodDark, VARNISH);
  for (const [a, b] of [[x0, x0 + 0.1], [x1 - 0.1, x1]]) {
    k.box(a, 0.3, zb, b, 0.58, zf, COL.fabric, CLOTH);
    k.box(a - 0.005, 0.58, zb, b + 0.005, 0.6, zf, COL.woodDark, VARNISH);
  }
  k.box(x0 + 0.14, seat, zb + 0.12, x0 + 0.42, seat + 0.22, zb + 0.2, COL.fabricLight, CLOTH); // 靠垫
};

const counter: Maker = (k, { w, zb, zf, rand }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.counter;
  const rx0 = -0.45, rx1 = 0.45; // 中间是铸铁炉灶
  for (const [a, b] of [[x0, rx0], [rx1, x1]]) {
    k.box(a, 0, zb, b, 0.08, zf - 0.05, COL.iron);
    k.box(a, 0.08, zb, b, H - 0.04, zf, COL.wood, VARNISH);
    // 柜门：每 0.5 米一扇，门板略凸
    const n = Math.max(1, Math.round((b - a) / 0.5));
    const dw = (b - a) / n;
    for (let i = 0; i < n; i++) {
      const da = a + i * dw + 0.03, db = a + (i + 1) * dw - 0.03;
      k.box(da, 0.12, zf, db, H - 0.1, zf + 0.008, COL.woodDark, VARNISH);
      const kx = i % 2 === 0 ? db - 0.06 : da + 0.06;
      k.box(kx - 0.01, 0.6, zf + 0.008, kx + 0.01, 0.68, zf + 0.02, COL.brass, METAL);
    }
    k.box(a, H - 0.04, zb, b, H, zf, COL.marble, GLAZE); // 台面
  }
  // 炉灶
  k.box(rx0, 0, zb, rx1, H - 0.02, zf, COL.iron, METAL);
  k.box(rx0 + 0.05, 0.12, zf, rx1 - 0.05, 0.6, zf + 0.012, shade(PALETTE.wallTrim, 0.8), METAL);
  k.box(rx0 + 0.1, 0.62, zf + 0.012, rx1 - 0.1, 0.65, zf + 0.04, COL.brass, METAL); // 把手横杆
  k.box(rx0, H - 0.02, zb, rx1, H, zf, shade(PALETTE.wallTrim, 0.4), METAL);
  for (const x of [rx0 + 0.22, rx1 - 0.22]) k.cyl(x, (zb + zf) / 2 + 0.03, H, H + 0.012, 0.13, COL.iron, { seg: 8, s: METAL });
  // 炉上一口锅，台面上的罐子和瓶子
  k.cyl(rx1 - 0.22, (zb + zf) / 2 + 0.03, H + 0.012, H + 0.17, 0.11, shade(PALETTE.brass, 0.7), { seg: 8, rTop: 0.12, s: METAL });
  for (let i = 0; i < 7; i++) {
    const right = i >= 3;
    const x = right ? rx1 + 0.25 + (i - 3) * 0.32 + rand() * 0.1 : x0 + 0.2 + i * 0.3 + rand() * 0.1;
    const r = 0.035 + rand() * 0.03;
    const h = 0.1 + rand() * 0.16;
    const c = i % 3 === 0 ? COL.porcelain : i % 3 === 1 ? shade(PALETTE.tile, 0.8) : mixC(PALETTE.wallTrim, PALETTE.possess, 0.2);
    k.cyl(x, zb + 0.12 + rand() * 0.15, H, H + h, r, c, { seg: 7, s: GLAZE });
  }
  k.box(x0 + 1.1, H, zb + 0.1, x0 + 1.5, H + 0.025, zb + 0.38, COL.woodLight); // 砧板
};

const table: Maker = (k, { w, zb, zf, rand }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.table;
  k.box(x0, H - 0.04, zb, x1, H, zf, COL.wood, VARNISH);
  k.box(x0 + 0.06, H - 0.13, zb + 0.06, x1 - 0.06, H - 0.04, zf - 0.06, COL.woodDark);
  for (const x of [x0 + 0.1, x1 - 0.1]) for (const z of [zb + 0.1, zf - 0.1]) {
    k.cyl(x, z, 0, H - 0.13, 0.03, COL.woodDark, { rTop: 0.04 });
  }
  const cz = (zb + zf) / 2;
  k.cyl(0.05, cz, H, H + 0.07, 0.11, COL.porcelain, { seg: 8, rTop: 0.15, s: GLAZE }); // 碗
  k.cyl(-0.45, cz - 0.15, H, H + 0.01, 0.12, COL.porcelain, { seg: 8, s: GLAZE }); // 盘子
  k.cyl(0.45, cz + 0.1, H, H + 0.22, 0.035, mixC(PALETTE.wallTrim, PALETTE.possess, 0.25), { seg: 6, rTop: 0.012, s: GLAZE }); // 瓶子
  k.cyl(0.4, cz - 0.25, H, H + 0.02, 0.04, COL.brass, { s: METAL });
  k.cyl(0.4, cz - 0.25, H + 0.02, H + 0.15, 0.012, COL.brass, { s: METAL });
  k.cyl(0.4, cz - 0.25, H + 0.15, H + 0.2, 0.014, COL.candle);
  k.tilted(-0.1, cz + 0.25, H, H + 0.003, 0.4, 0.25, (rand() - 0.5) * 0.3, COL.linen, CLOTH); // 餐巾
};

/** 地毯：边、底、中间的菱形花纹。很薄，不挡路，不投影也无所谓 */
function carpet(k: Kit, w: number, zb: number, zf: number, base: THREE.Color, field: THREE.Color, motif: THREE.Color, step: number) {
  const x0 = -w / 2, x1 = w / 2, T = FURNITURE_TOP.rug;
  k.box(x0, 0, zb, x1, T - 0.004, zf, base, CLOTH);
  const inset = Math.min(0.12, w * 0.12);
  k.box(x0 + inset, T - 0.004, zb + inset, x1 - inset, T, zf - inset, field, CLOTH);
  const len = zf - zb - inset * 2;
  const n = Math.max(1, Math.floor(len / step));
  for (let i = 0; i < n; i++) {
    const z = zb + inset + (i + 0.5) * (len / n);
    const s = Math.min(w - inset * 2, step) * 0.3;
    k.tilted(0, z, T, T + 0.002, s, s, Math.PI / 4, motif, CLOTH);
  }
}

const runner: Maker = (k, { w, zb, zf }) => carpet(k, w, zb, zf, COL.fabricDark, COL.fabric, mixC(PALETTE.fabric, PALETTE.brass, 0.3).multiplyScalar(0.8), 1.0);
const rug: Maker = (k, { w, zb, zf }) => {
  carpet(k, w, zb, zf, mixC(PALETTE.fabric, PALETTE.moon, 0.4), shade(PALETTE.fabric, 0.85), mixC(PALETTE.fabric, PALETTE.brass, 0.3).multiplyScalar(0.8), zf - zb);
  // 四角的小方块
  const T = FURNITURE_TOP.rug, d = 0.26;
  for (const x of [-w / 2 + d, w / 2 - d]) for (const z of [zb + d, zf - d]) k.tilted(x, z, T, T + 0.002, 0.12, 0.12, 0, mixC(PALETTE.fabric, PALETTE.brass, 0.35), CLOTH);
};

const bed: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, top = FURNITURE_TOP.bed;
  k.box(x0 + 0.04, 0.12, zb + 0.06, x1 - 0.04, 0.3, zf - 0.05, COL.woodDark, VARNISH); // 床架
  k.box(x0 + 0.06, 0.3, zb + 0.08, x1 - 0.06, 0.45, zf - 0.08, COL.linen, CLOTH); // 床垫
  const cover = zb + 0.6;
  k.box(x0 + 0.04, 0.45, cover, x1 - 0.04, top, zf - 0.06, COL.fabric, CLOTH); // 被子
  k.box(x0 + 0.02, 0.24, cover, x0 + 0.04, top, zf - 0.06, COL.fabric, CLOTH); // 两侧垂下
  k.box(x1 - 0.04, 0.24, cover, x1 - 0.02, top, zf - 0.06, COL.fabric, CLOTH);
  k.box(x0 + 0.06, top - 0.005, cover - 0.12, x1 - 0.06, top + 0.015, cover + 0.02, COL.linen, CLOTH); // 翻折的床单
  for (const s of [-1, 1]) k.box(s * 0.08, 0.45, zb + 0.14, s * (w / 2 - 0.12), 0.56, zb + 0.46, COL.linen, CLOTH); // 枕头
  // 床头板、床尾板，四角立柱
  k.box(x0, 0, zb, x1, 1.15, zb + 0.06, COL.woodDark, VARNISH);
  k.box(x0 + 0.12, 0.6, zb + 0.06, x1 - 0.12, 1.05, zb + 0.075, COL.wood, VARNISH);
  k.box(x0, 0, zf - 0.05, x1, 0.68, zf, COL.woodDark, VARNISH);
  for (const x of [x0 + 0.04, x1 - 0.04]) {
    k.cyl(x, zb + 0.04, 0, 1.25, 0.04, COL.woodDark, { s: VARNISH });
    k.cyl(x, zb + 0.04, 1.25, 1.33, 0.045, COL.brass, { rTop: 0.01, s: METAL });
    k.cyl(x, zf - 0.035, 0, 0.78, 0.035, COL.woodDark, { s: VARNISH });
    k.cyl(x, zf - 0.035, 0.78, 0.84, 0.04, COL.brass, { rTop: 0.01, s: METAL });
  }
};

const nightstand: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.nightstand;
  for (const x of [x0 + 0.06, x1 - 0.06]) for (const z of [zb + 0.06, zf - 0.06]) k.box(x - 0.02, 0, z - 0.02, x + 0.02, 0.12, z + 0.02, COL.woodDark);
  k.box(x0 + 0.03, 0.12, zb + 0.03, x1 - 0.03, H - 0.03, zf - 0.03, COL.wood, VARNISH);
  k.box(x0, H - 0.03, zb, x1, H, zf, COL.woodDark, VARNISH); // 顶面正好 0.55 米：八音盒放这里
  k.box(x0 + 0.06, 0.36, zf - 0.03, x1 - 0.06, H - 0.06, zf - 0.015, COL.woodDark, VARNISH); // 抽屉
  k.box(-0.02, 0.42, zf - 0.015, 0.02, 0.44, zf, COL.brass, METAL);
  k.box(x0 + 0.06, 0.16, zf - 0.03, x1 - 0.06, 0.32, zf - 0.025, shade(PALETTE.woodDark, 0.6)); // 下层空格
};

const wardrobe: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.wardrobe;
  for (const x of [x0 + 0.08, x1 - 0.08]) for (const z of [zb + 0.08, zf - 0.08]) k.box(x - 0.03, 0, z - 0.03, x + 0.03, 0.08, z + 0.03, COL.woodDark);
  k.box(x0 + 0.03, 0.08, zb, x1 - 0.03, H - 0.1, zf - 0.02, COL.wood, VARNISH);
  k.box(x0, H - 0.1, zb, x1, H, zf, COL.woodDark, VARNISH); // 顶檐
  k.box(x0 + 0.02, 0.08, zb, x1 - 0.02, 0.16, zf, COL.woodDark, VARNISH); // 底座
  k.box(x0 + 0.06, 0.2, zf - 0.02, x1 - 0.06, 0.4, zf - 0.005, COL.woodDark, VARNISH); // 底部抽屉
  const mid = 0;
  for (const [a, b] of [[x0 + 0.06, mid - 0.01], [mid + 0.01, x1 - 0.06]]) {
    k.box(a, 0.44, zf - 0.02, b, H - 0.16, zf - 0.005, COL.woodDark, VARNISH); // 门
    k.box(a + 0.07, 0.56, zf - 0.005, b - 0.07, 1.2, zf + 0.005, COL.wood, VARNISH); // 门芯
    k.box(a + 0.07, 1.3, zf - 0.005, b - 0.07, H - 0.28, zf + 0.005, COL.wood, VARNISH);
  }
  k.box(mid - 0.05, 1.1, zf - 0.005, mid - 0.03, 1.22, zf + 0.015, COL.brass, METAL);
  k.box(mid + 0.03, 1.1, zf - 0.005, mid + 0.05, 1.22, zf + 0.015, COL.brass, METAL);
};

const coatRack: Maker = (k, { w, zb, zf }) => {
  const r = Math.min(w, zf - zb) / 2 - 0.02, cz = (zb + zf) / 2, H = FURNITURE_TOP.coatRack;
  for (let i = 0; i < 4; i++) k.tilted(0, cz, 0, 0.04, r * 2, 0.05, (i * Math.PI) / 4, COL.woodDark);
  k.cyl(0, cz, 0, H, 0.025, COL.woodDark, { s: VARNISH });
  k.cyl(0, cz, H, H + 0.06, 0.035, COL.woodDark, { rTop: 0.01, s: VARNISH });
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    k.tilted(Math.cos(a) * 0.08, cz + Math.sin(a) * 0.08, H - 0.12, H - 0.1, 0.16, 0.02, -a, COL.brass, METAL);
  }
  // 挂着一件外套和一顶礼帽
  k.box(-0.13, 0.95, cz + 0.03, 0.13, H - 0.13, cz + 0.13, COL.fabricDark, CLOTH);
  k.box(-0.1, H - 0.18, cz + 0.02, 0.1, H - 0.1, cz + 0.12, COL.fabricDark, CLOTH);
  k.cyl(-0.09, cz - 0.08, H - 0.1, H - 0.09, 0.11, COL.iron, { seg: 8 });
  k.cyl(-0.09, cz - 0.08, H - 0.09, H + 0.04, 0.065, COL.iron, { seg: 8 });
};

const bathtub: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2;
  k.box(x0, 0, zb, x1, 0.08, zf, COL.stoneDark, GLAZE); // 浴缸底下的台子，填满 rect
  k.box(x0, 0.08, zf - 0.03, x1, 0.085, zf, COL.stone, GLAZE);
  const L = w - 0.3, W = 0.84, cz = zb + 0.2 + W / 2, top = FURNITURE_TOP.bathtub;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    k.cyl(sx * (L / 2 - 0.14), cz + sz * (W / 2 - 0.12), 0.08, 0.2, 0.035, COL.brass, { rTop: 0.05, s: METAL }); // 爪脚
  }
  k.cyl(0, cz, 0.2, top - 0.03, 0.5, COL.green, { seg: 12, rTop: 0.5, sx: (L / 2) / 0.5 * 0.92, sz: (W / 2) / 0.5 * 0.92, s: GLAZE });
  k.cyl(0, cz, top - 0.03, top, 0.5, COL.porcelain, { seg: 12, sx: (L / 2) / 0.5, sz: (W / 2) / 0.5, s: GLAZE }); // 缸沿
  k.cyl(0, cz, top, top + 0.002, 0.5, shade(PALETTE.moon, 0.7), { seg: 12, sx: (L / 2 - 0.07) / 0.5, sz: (W / 2 - 0.07) / 0.5, s: GLAZE }); // 缸里（发暗的水）
  // 龙头
  k.cyl(-L / 2 + 0.1, cz, top, top + 0.16, 0.02, COL.brass, { s: METAL });
  k.box(-L / 2 + 0.08, top + 0.14, cz - 0.02, -L / 2 + 0.22, top + 0.17, cz + 0.02, COL.brass, METAL);
};

const sink: Maker = (k, { w, zb, zf }) => {
  const x0 = -w / 2, x1 = w / 2, H = FURNITURE_TOP.sink;
  k.box(x0 + 0.04, 0, zb, x1 - 0.04, 0.08, zf - 0.04, COL.woodDark);
  k.box(x0 + 0.02, 0.08, zb, x1 - 0.02, H - 0.05, zf - 0.01, COL.wood, VARNISH);
  for (const [a, b] of [[x0 + 0.06, -0.01], [0.01, x1 - 0.06]]) {
    k.box(a, 0.14, zf - 0.01, b, H - 0.12, zf + 0.002, COL.woodDark, VARNISH);
  }
  k.box(x0, H - 0.05, zb, x1, H, zf, COL.marble, GLAZE);
  k.box(x0, H, zb, x1, H + 0.2, zb + 0.03, COL.marble, GLAZE); // 后挡板
  const cz = (zb + zf) / 2 + 0.04;
  k.cyl(0, cz, H, H + 0.002, 0.5, shade(PALETTE.tile, 0.45), { seg: 10, sx: 0.5, sz: 0.4, s: GLAZE }); // 盆
  k.cyl(0, zb + 0.08, H, H + 0.14, 0.015, COL.brass, { s: METAL });
  k.box(-0.015, H + 0.11, zb + 0.08, 0.015, H + 0.14, zb + 0.2, COL.brass, METAL);
  for (const x of [-0.12, 0.12]) k.cyl(x, zb + 0.08, H, H + 0.07, 0.018, COL.brass, { s: METAL });
};

const MAKERS: Record<FurnitureKind, Maker> = {
  bookshelf, desk, sofa, fireplace, counter, table, bed, nightstand, wardrobe, coatRack, bathtub, sink, rug, runner,
};

// ───────────────────────── 摆放 ─────────────────────────

/** 家具背后（facing 的反方向）紧贴的那一排格子是不是全是墙 */
function backedByWall(f: Furniture, tiles: Uint8Array): boolean {
  const bx = -Math.round(Math.cos(f.facing)), bz = -Math.round(Math.sin(f.facing));
  const { x0, z0, x1, z1 } = f.rect;
  const cells: [number, number][] = [];
  if (bx !== 0) {
    const i = bx > 0 ? x1 : x0 - 1;
    for (let j = z0; j < z1; j++) cells.push([i, j]);
  } else {
    const j = bz > 0 ? z1 : z0 - 1;
    for (let i = x0; i < x1; i++) cells.push([i, j]);
  }
  return cells.every(([i, j]) => inGrid(i, j) && (tiles[idx(i, j)] === Tile.Wall || tiles[idx(i, j)] === Tile.Window));
}

export interface FurnitureView {
  mesh: THREE.Mesh;
  /** 第三人称模式：同一份几何体配不挖洞的材质（附近没有洞的帧用它，见 walls.ts 的 HOLE_TEST）；娃娃屋模式为 null */
  solid: THREE.Mesh | null;
  /** 第三人称模式：这一帧显示挖洞的那份（true）还是不挖洞的那份；两份开局都显示着（一起预编译） */
  setHoles(on: boolean): void;
  dispose(): void;
}

/** dissolve 不为空：第三人称模式，鬼魂周围溶开（见 walls.ts 的 DISSOLVE） */
export function createFurniture(tiles: Uint8Array, dissolve?: DissolveUniforms): FurnitureView {
  const b = new GeoBuilder({ surf: 2 });
  const kit = new Kit(b);
  const back = (CELL - WALL_T) / 2;
  FURNITURE.forEach((f, n) => {
    const sx = (f.rect.x1 - f.rect.x0) * CELL, sz = (f.rect.z1 - f.rect.z0) * CELL;
    // facing 朝东西时，模型的宽度方向对应房屋的 z
    const ew = Math.abs(Math.cos(f.facing)) > 0.5;
    const w = ew ? sz : sx, d = ew ? sx : sz;
    const ext = f.blocks && backedByWall(f, tiles) ? back : 0;
    const frame: Frame = { w, zb: -d / 2 - ext, zf: d / 2, rand: rng(1000 + n * 7919) };
    const cx = ((f.rect.x0 + f.rect.x1) / 2) * CELL, cz = ((f.rect.z0 + f.rect.z1) / 2) * CELL;
    b.transform = new THREE.Matrix4().makeRotationY(yawFor(f.facing)).setPosition(cx, 0, cz);
    MAKERS[f.kind](kit, frame);
  });
  b.transform = null;

  const geometry = b.build();
  const makeMaterial = (masked: boolean) => {
    // 溶解要拿底色去混霜：顶点色自己乘进 colorNode，材质不再开 vertexColors（否则会再乘一遍）
    const m = new THREE.MeshStandardNodeMaterial({ vertexColors: !dissolve, flatShading: true });
    const surf = attribute('surf', 'vec2');
    m.roughnessNode = surf.x;
    m.metalnessNode = surf.y;
    // 几何体就在房屋坐标里（网格本身没有变换），位置、法线属性就是房屋坐标（法线直接读属性，理由见 walls.ts 的 wallMaterial）
    if (dissolve) {
      applyDissolve(m, dissolve, positionLocal, attribute('normal', 'vec3'), attribute('color', 'vec3'), { holeScale: DISSOLVE.furniture, masked });
    }
    return m;
  };
  const mesh = new THREE.Mesh(geometry, makeMaterial(true));
  mesh.name = 'furniture';
  const solid = dissolve ? new THREE.Mesh(geometry, makeMaterial(false)) : null;
  if (solid) solid.name = 'furniture-solid';
  for (const m of solid ? [mesh, solid] : [mesh]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }
  return {
    mesh,
    solid,
    setHoles(on) {
      if (!solid) return;
      mesh.visible = on;
      solid.visible = !on;
    },
    dispose() {
      geometry.dispose();
      for (const m of solid ? [mesh, solid] : [mesh]) (m.material as THREE.Material).dispose();
    },
  };
}
