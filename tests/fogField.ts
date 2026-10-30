// 地面雾的密度场在 CPU 上的镜像（只给测试用，不进正式代码）：fog.ts 的 fogMaterial 里顶点着色器算的 rho、hs 和片元积出来的不透明度，
// 加上现身落下那一圈气浪的扰动（draftField：取样点被推开、密度乘 waveDensity）。
// 为什么要有它：tests/fog-ring.test.ts 要按「最严的口径」（灯的亮度 × 雾的亮度逐点相乘）数现身这一串灯闪里雾多出几下暗，
// 而气浪不只改密度，还把噪声的取样点往外推（push，雾的花纹被推着走），花纹挪动时某一点的亮度也会变，只看密度倍数（waveDensity）看不见这一部分。
// 噪声是 three 的 mx_noise_float（MaterialX 的 3D Perlin，three/src/nodes/materialx/MaterialXNoise.js 的 mx_perlin_noise_float_1），逐行抄成了 CPU 版：
// Bob Jenkins 的 lookup3 哈希（uint32）、16 个梯度、fade 曲线、三线性插值，最后乘 0.982。GPU 上是 32 位浮点，这里是 64 位，差在小数点后很远
import { DRAFT, FOG, waveAt, waveDensity, type WaveParams } from '../src/view/fog';

const rotl = (x: number, k: number) => ((x << k) | (x >>> (32 - k))) >>> 0;

/** mx_bjfinal：三个 uint32 搅在一起，取 c */
function bjfinal(a: number, b: number, c: number): number {
  c = (c ^ b) >>> 0; c = (c - rotl(b, 14)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rotl(c, 11)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rotl(a, 25)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rotl(b, 16)) >>> 0;
  a = (a ^ c) >>> 0; a = (a - rotl(c, 4)) >>> 0;
  b = (b ^ a) >>> 0; b = (b - rotl(a, 14)) >>> 0;
  c = (c ^ b) >>> 0; c = (c - rotl(b, 24)) >>> 0;
  return c;
}

/** mx_hash_int(x, y, z) */
const hash3 = (x: number, y: number, z: number): number => {
  const s = (0xdeadbeef + (3 << 2) + 13) >>> 0;
  return bjfinal((s + (x >>> 0)) >>> 0, (s + (y >>> 0)) >>> 0, (s + (z >>> 0)) >>> 0);
};

/** mx_gradient_float(hash, x, y, z) */
function gradient3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) !== 0 ? -u : u) + ((h & 2) !== 0 ? -v : v);
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/** mx_noise_float(vec3)：−1..1 附近，整数格点上是 0 */
export function perlin3(px: number, py: number, pz: number): number {
  const X = Math.floor(px), Y = Math.floor(py), Z = Math.floor(pz);
  const fx = px - X, fy = py - Y, fz = pz - Z;
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const g = (dx: number, dy: number, dz: number) => gradient3(hash3(X + dx, Y + dy, Z + dz), fx - dx, fy - dy, fz - dz);
  const v0 = g(0, 0, 0), v1 = g(1, 0, 0), v2 = g(0, 1, 0), v3 = g(1, 1, 0);
  const v4 = g(0, 0, 1), v5 = g(1, 0, 1), v6 = g(0, 1, 1), v7 = g(1, 1, 1);
  const s1 = 1 - u, t1 = 1 - v, r1 = 1 - w;
  const r = r1 * (t1 * (v0 * s1 + v1 * u) + v * (v2 * s1 + v3 * u)) + w * (t1 * (v4 * s1 + v5 * u) + v * (v6 * s1 + v7 * u));
  return 0.982 * r;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 从哪种镜头看雾：视线俯角的正弦（掠射角的下限）、雾的整体厚度倍数（FOG.eye.density × 离镜头近处变薄）、最浓的不透明度 */
export interface FieldView { sinV: number; thick: number; cap: number }
/**
 * 第三人称（现身只发生在这里）：掠射角取下限 FOG.eye.minSin（光程最长、雾最浓的那一种）、厚度取最厚（离镜头 4.5 米以外，只乘 FOG.eye.density）、
 * 不透明度封顶 FOG.eye.maxAlpha。娃娃屋的正交相机：俯角 35°、不乘厚度、封顶 FOG.maxAlpha。两种都数，哪种更严按哪种
 */
export const VIEWS: Record<'third' | 'doll', FieldView> = {
  third: { sinV: FOG.eye.minSin, thick: FOG.eye.density, cap: FOG.eye.maxAlpha },
  doll: { sinV: Math.sin((35 * Math.PI) / 180), thick: 1, cap: FOG.maxAlpha },
};

/** 一圈气浪此刻的样子：圆心、出发后多少秒、参数、网格最小半宽 */
export interface FieldRing { cx: number; cz: number; age: number; L: WaveParams; minW: number }

/**
 * 地板上水平位置 (sx, sz)（雾的取样点，fogMaterial 里的 S）、噪声时间 t、静态密度 dens（空地 1，墙根、门口堆积更大）处，
 * 这一刻雾的不透明度。ring = null 就是没有气浪（基准）。公式照 fogMaterial：两层噪声（风向坐标系）→ 成片 patch → rho、hs → 视线穿过雾的光程 → 1 − exp(−τ)。
 * 气浪的取样点位移照 draftField：波前里面（smoothstep(R + W, R − W, r)）的点往圆心收 shove × r / (r + 0.3) 米，
 * 密度再乘 waveDensity（缕系数 wisp 取自位移以后的细节噪声）
 */
export function fogAlpha(sx: number, sz: number, t: number, ring: FieldRing | null, view: FieldView, dens = 1): number {
  let dx = 0, dz = 0;
  let mul = 1;
  const w = ring ? waveAt(ring.L, ring.age, ring.minW) : null;
  let r = 0;
  if (ring && w) {
    const ox = sx - ring.cx, oz = sz - ring.cz;
    r = Math.hypot(ox, oz);
    const inside = smooth(w.radius + w.halfWidth, w.radius - w.halfWidth, r);
    const shove = (w.shove * inside * (r / (r + 0.3))) / Math.max(r, 0.01);
    const k = 1 - shove;
    dx = ox * k - ox;
    dz = oz * k - oz;
  }
  const Sx = sx + dx, Sz = sz + dz;
  let fbm = 0, wsum = 0, detail = 0;
  FOG.noise.forEach((o, k) => {
    const speed = Math.hypot(o.wind[0], o.wind[1]);
    const wx = o.wind[0] / speed, wz = o.wind[1] / speed;
    const down = Sx * wx + Sz * wz - t * speed;
    const side = Sz * wx - Sx * wz;
    const n = perlin3((down * o.freq) / o.stretch, side * o.freq * Math.sqrt(o.stretch), t * o.evolve + k * 17.3);
    fbm += n * o.weight;
    wsum += o.weight;
    if (k === FOG.noise.length - 1) detail = n;
  });
  fbm /= wsum;
  const patch = smooth(-0.35, 0.7, fbm);
  if (ring && w) {
    const wisp = smooth(-0.25, 0.55, detail) * (DRAFT.wisp[1] - DRAFT.wisp[0]) + DRAFT.wisp[0];
    mul = waveDensity(w, ring.L, r, wisp);
  }
  const rho = dens * FOG.density * (patch * patch * 1.15 + 0.22) * mul;
  const hs = FOG.scaleH * (patch * 0.4 + 0.75 + detail * 0.12);
  const tau = ((rho * hs) / view.sinV) * (1 - Math.exp(-FOG.top / hs)) * view.thick;
  return Math.min(1 - Math.exp(-tau), view.cap);
}
