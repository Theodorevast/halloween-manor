// 衣柜：被从里面拉上（设计文档 4.3，调研 3.3 的 A 版）。卧室北墙那个衣柜：柜体是家具（furniture.ts，门洞留空），
// 这里是两扇门和门里的东西。被附身时：
// - 锁舌「咔哒」一声，门板轻轻一震，像有人从里面推了一下，还没开；
// - 左边那扇（−x，西边，合页在它外侧）自己慢慢开出一条缝：先快后慢，到 WARDROBE.openDeg 一下子停死，不回弹、不晃。
//   门往西南转出来，门缝朝东南：默认的娃娃屋机位（东南）正好看进门缝（开右边那扇的话，门板正好挡在这个机位前面）；
// - 停住。门缝里是吃光的黑（调研 S3），手电照进去只照亮挂着的外套靠门的那条边，其中一件轻轻晃一下；
// - WARDROBE.slamAt：门被从里面猛地拉上，WARDROBE_SHUT 撞上门框、硬停，门和门里的东西震一下（2 毫米以内），
//   柜顶的灰从边上翻下去，几秒里慢慢落到门前的地上（particles.ts 的扬灰，plaster.ts 的 fall）。
// 约三分之一的时候（trigger 事件的 variant < WARDROBE.fingersChance），合上之前先有四根苍白的手指从门缝里伸出来、
// 弯过门边扶住它，合上时缩回去；看不见手后面连着什么。不露脸、不发光、不扑出来；B 版（柜顶的剪影、手电抬高）不在这里。
// 时间轴全在 config/scares.ts 的 WARDROBE（声音也读它），这里只有画面自己的幅度和形状（WARDROBE_LOOK）。
//
// 局部坐标（props.ts 摆放：根在 propCenter，转 yawFor(facing)）：衣柜朝南，yaw = 0；物件格是衣柜三格里中间那一格，
// 原点正好在衣柜正中的地面，局部坐标就是衣柜的模型坐标（furniture.ts 的 WARDROBE_BOX、furnitureFrame），正面 +z（南）、x 向东。
//
// 吃光的黑：门洞里一个不受光的纯黑内衬（背面朝外的盒子，从门洞看进去看到的是它的里面）。外套是受光的布，
// 但顶点色按离门洞多深压暗，所以手电照进去也只照亮外套靠门的那一条边，再往里就没进黑里了。
// 手指：一个网格，16 节胶囊（四根手指 × 掌骨、近节、中节、远节），每帧在 CPU 上按关节角摆好写进顶点
// （1024 个顶点、1568 个三角形，只在手指露出来的那半秒里写）；颜色按离门板里面多深压暗，从门缝里看是从黑里伸出来的，掌骨那头没进黑里。
// 普通受光的材质，不发光；平时看不见，标了 deferCompile（开场按钮可用之后再编，见 main.ts）
import * as THREE from 'three/webgpu';
import { color, positionGeometry, smoothstep } from 'three/tsl';
import { CELL, FURNITURE, PROPS, buildTiles, propCenter } from '../../config/house';
import { WARDROBE, WARDROBE_SHUT } from '../../config/scares';
import type { Quality } from '../../engine/types';
import type { WorldState } from '../../sim/types';
import { FURNITURE_TOP, WARDROBE_BOX, furnitureFrame } from '../furniture';
import {
  C, Parts, bodyMaterial, bump, clamp01, mesh, outCubic, outQuad, seg, wobble, type PropFrame, type PropRig, type TriggerEvent,
} from './kit';

/** 画面自己的数（时间轴在 config/scares.ts 的 WARDROBE，这里只管多大、什么形状） */
export const WARDROBE_LOOK = {
  /**
   * 锁舌那一下：门板被从里面推开多少度（锁舌挡着，马上弹回去），再磕一下（第一下的 rattle 倍）。
   * kick、rattleAt：两下各占 latch 时段的哪一段（0..1，时段改长改短跟着伸缩）
   */
  latchDeg: 0.8,
  kick: [0.1, 0.47] as const,
  rattleAt: [0.47, 0.7] as const,
  rattle: 0.35,
  /** 开门：outQuad 只用到 openCut 那一段再拉满到 openDeg（先快后慢；到头时还带着一点速度就停死，不是慢慢蹭到头） */
  openCut: 0.85,
  /** 合上：一开始就有速度（线性项占 slamLinear），越关越快，撞上就停（不缓冲、不回弹） */
  slamLinear: 0.3,
  /** 撞上以后门和门里的东西震一下（柜体是家具，不动）：每个轴的幅度（米；两个轴合起来不到 2 毫米）、多久震完（秒） */
  shake: 0.0013,
  shakeTime: 0.16,
  /** 晃的那件外套：hold 开始后多久被碰了一下（秒）、摆幅（弧度，绕挂钩前后摆）、周期（秒）、衰减的时间常数（秒） */
  coat: { from: 0.05, amp: 0.07, period: 1.1, tau: 0.6 },
  /** 手指：伸出来（先从门缝里探出来、再弯过门边扶住）用多久、一根比一根晚多少；合上那一刻起多快缩回去（秒） */
  finger: { reach: 0.28, stagger: 0.03, retract: 0.08 },
  /**
   * 吃光的黑：门里的东西离柜体正面 lit 米以内不压暗，到 dark 米全黑（顶点色乘 smoothstep）。
   * 外套最靠门的边离柜体正面七八厘米，只有最前面三四厘米留得住光，再往里就是黑的（手电直照也一样）
   */
  deep: { lit: 0.06, dark: 0.17 },
};

const W = WARDROBE;
const LK = WARDROBE_LOOK;
/**
 * 门撞上门框的那一刻（config/scares.ts 的 WARDROBE_SHUT = slamAt + slamTime，只在那里算；声音的闷响、模拟里惊吓落下的那一刻也是它）：
 * 硬停、震、柜顶落灰都从这一刻起
 */
const SHUT = WARDROBE_SHUT;
/** 演完：撞上、震完，再留一点给门里那件外套晃完（门已经关上，看不见），之后回到静止 */
const END = SHUT + 0.3;

// ───────────────────────── 时间曲线（纯函数，tests/wardrobe-view.test.ts 钉着） ─────────────────────────

/** 开的那扇门开了多少度（t：trigger 以后的秒数；< 0 = 没在表演）。门往外开为正，合页那边按方向换算成 rotation.y */
export function doorDeg(t: number): number {
  if (t <= W.latch[0]) return 0;
  if (t < W.latch[1]) {
    const u = seg(t, ...W.latch);
    return LK.latchDeg * (bump(seg(u, ...LK.kick)) + LK.rattle * bump(seg(u, ...LK.rattleAt)));
  }
  if (t < W.open[1]) return (W.openDeg * outQuad(seg(t, ...W.open) * LK.openCut)) / outQuad(LK.openCut);
  if (t < W.slamAt) return W.openDeg;
  if (t < SHUT) {
    const u = seg(t, W.slamAt, SHUT);
    return W.openDeg * (1 - (LK.slamLinear * u + (1 - LK.slamLinear) * u * u));
  }
  return 0;
}

/** 这一次有没有手指：只看 trigger 事件的 variant（没有 variant 当 0，见 sim/types.ts 的约定） */
export const hasFingers = (variant: number | undefined) => (variant ?? 0) < W.fingersChance;

/**
 * 第 i 根手指（0 食指 … 3 小指）伸出来扶住门边的程度：0 = 缩在柜子里（不显示），1 = 扶住。
 * fingers 时段一开始一根接一根伸出来；合上那一刻（fingers 时段的末尾 = slamAt）起很快缩回去，门撞上之前缩完
 */
export function fingerGrip(t: number, i = 0): number {
  const F = LK.finger;
  const t0 = W.fingers[0] + i * F.stagger;
  if (t < t0) return 0;
  return Math.min(1, (t - t0) / F.reach, 1 - seg(t, W.fingers[1], W.fingers[1] + F.retract));
}

/** 晃的那件外套此刻偏了多少（弧度，绕挂钩前后摆）：hold 里被碰了一下，摆一下、越摆越小 */
export function coatSwing(t: number): number {
  const c = LK.coat, t0 = W.hold[0] + c.from;
  if (t < t0) return 0;
  const s = t - t0;
  return c.amp * Math.sin((2 * Math.PI * s) / c.period) * Math.exp(-s / c.tau);
}

/** 撞上那一下门和门里的东西震多少（米，x、z）：撞上之前、震完以后都是 0 */
export function slamShake(t: number): [number, number] {
  if (t < SHUT || t >= SHUT + LK.shakeTime) return [0, 0];
  const k = (1 - seg(t, SHUT, SHUT + LK.shakeTime)) * LK.shake;
  return [wobble(t * 3, 11) * k, wobble(t * 3, 17) * k];
}

// ───────────────────────── 布局 ─────────────────────────

export interface WardrobeLayout {
  /** 衣柜宽（米）；背面（背后是墙格，伸到墙面）、正面（顶檐、底座的前沿） */
  w: number;
  zb: number;
  zf: number;
  /** 门洞：半宽（侧板的里面）、下沿、上沿 */
  xo: number;
  y0: number;
  y1: number;
  /** 柜体正面（门板背面贴着它，也就是门洞的口）、背板的正面 */
  zFace: number;
  zBack: number;
}

let layoutCache: WardrobeLayout | null = null;

/**
 * 衣柜在物件局部坐标里的布局（从家具表和 furniture.ts 换算，不建任何东西）。算一次就记住（家具表不会在运行时变）。
 * 别的模块不要在导入时就调它：家具表改错时它会抛错，导入期抛错整页白屏、走不到 main.ts 的报错界面
 */
export function wardrobeLayout(): WardrobeLayout {
  if (layoutCache) return layoutCache;
  const f = FURNITURE.find((x) => x.id === 'bedroom-wardrobe');
  const p = PROPS.find((x) => x.type === 'wardrobe');
  if (!f || !p) throw new Error('wardrobe: 家具表里没有 bedroom-wardrobe，或者 PROPS 里没有衣柜');
  // 物件格是衣柜正中、朝向一样（tests/wardrobe-view.test.ts 钉着），物件局部坐标就是衣柜的模型坐标，下面不用换算
  const c = propCenter(p);
  const cx = ((f.rect.x0 + f.rect.x1) / 2) * CELL, cz = ((f.rect.z0 + f.rect.z1) / 2) * CELL;
  if (Math.abs(c.x - cx) > 1e-6 || Math.abs(c.z - cz) > 1e-6 || p.facing !== f.facing) {
    throw new Error('wardrobe: 物件格不在衣柜正中，或者朝向和衣柜不一样');
  }
  const fr = furnitureFrame(f, buildTiles());
  const B = WARDROBE_BOX;
  layoutCache = {
    w: fr.w, zb: fr.zb, zf: fr.zf,
    xo: fr.w / 2 - B.inset, y0: B.y0, y1: FURNITURE_TOP.wardrobe - B.top,
    zFace: fr.zf - B.front, zBack: fr.zb + B.back,
  };
  return layoutCache;
}

/** 落灰的位置：柜顶面正中（物件局部坐标）。particles.ts 按物件的摆放换算成房屋坐标 */
export function wardrobeDustSpot(): { x: number; y: number; z: number } {
  const L = wardrobeLayout();
  return { x: 0, y: FURNITURE_TOP.wardrobe, z: (L.zb + L.zf) / 2 };
}

// ───────────────────────── 门、外套 ─────────────────────────

/** 衣杆：高度、半径（米）；横在门洞上部，进深正中 */
const RAIL = { y: 1.8, r: 0.011 };

/**
 * 挂着的外套：外套侧着挂（肩宽沿进深），从门缝里看见的是外套靠门的那条边（袖子、前襟）。
 * x：挂在哪（都在开的那扇门后面，也就是西半边：东半边那扇门一直关着，看不见，不挂）；len：衣架到下摆多长；
 * col：颜色（暗、旧、去饱和）。第一件离门缝最近，就是 hold 里晃的那件
 */
const COATS = [
  { x: -0.13, len: 1.0, col: 0x2e2c2a }, // 炭灰的呢大衣
  { x: -0.31, len: 0.82, col: 0x352327 }, // 褪了色的暗酒红短外套（调色板的 fabric 压暗、去饱和）
  { x: -0.49, len: 0.95, col: 0x302b22 }, // 橄榄褐的风衣
];

type V3 = [number, number, number];

/**
 * 一扇门（照原来 furniture.ts 画的门）：门板、上下两块门芯、靠门缝那边的铜把手。
 * 门占 x ∈ [a, b]，背面在 z0（门板厚 WARDROBE_BOX.door，门芯再凸出 panel）；handle：把手的 x 范围
 */
function addDoor(p: Parts, L: WardrobeLayout, a: number, b: number, z0: number, handle: [number, number]) {
  const B = WARDROBE_BOX, H = FURNITURE_TOP.wardrobe;
  const zs = z0 + B.door; // 门板正面
  const box = (x0: number, y0: number, za: number, x1: number, y1: number, zb: number, col: number) =>
    p.box(x1 - x0, y1 - y0, zb - za, col, [(x0 + x1) / 2, (y0 + y1) / 2, (za + zb) / 2]);
  box(a, L.y0, z0, b, L.y1, zs, C.woodDark);
  box(a + 0.07, 0.56, zs, b - 0.07, 1.2, zs + B.panel, C.wood);
  box(a + 0.07, 1.3, zs, b - 0.07, H - 0.28, zs + B.panel, C.wood);
  box(handle[0], 1.1, zs, handle[1], 1.22, zs + 0.02, C.brass);
}

/** 盒子往下摆张开：越往下，进深方向（z）放得越大，最下面放大 1 + k 倍 */
function flare(g: THREE.BufferGeometry, k: number) {
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pos.getZ(i) * (1 + (k * (max.y - pos.getY(i))) / (max.y - min.y)));
  return g;
}

/** 颜色乘一个系数（hex 进、hex 出，按线性值乘） */
const dim = (hex: number, k: number) => new THREE.Color(hex).multiplyScalar(k).getHex();

/**
 * 一件挂着的外套。o：挂钩挂上衣杆的那一点（衣服往 -y 垂；厚度沿 x，肩宽沿 z）。
 * 低多边形：挂钩、衣架、顺着衣架斜下去的肩、往下摆略微张开的身子、垂在前后两边的袖子、领子；进深方向切几段，压暗才有渐变
 */
function addCoat(p: Parts, o: V3, len: number, col: number) {
  const at = (x: number, y: number, z: number): V3 => [o[0] + x, o[1] + y, o[2] + z];
  p.add(new THREE.CylinderGeometry(0.0035, 0.0035, 0.06, 4), C.iron, at(0, -0.025, 0)); // 挂钩
  for (const s of [-1, 1]) {
    p.add(new THREE.BoxGeometry(0.014, 0.018, 0.21), C.woodDark, at(0, -0.07, s * 0.1), [s * 0.2, 0, 0]); // 衣架
    p.add(new THREE.BoxGeometry(0.075, 0.07, 0.22, 1, 1, 3), col, at(0, -0.105, s * 0.105), [s * 0.2, 0, 0]); // 肩
    p.add(new THREE.BoxGeometry(0.055, 0.6, 0.075, 1, 2, 2), dim(col, 0.82), at(0, -0.46, s * 0.19), [-s * 0.03, 0, 0]); // 袖子
  }
  const h = len - 0.15;
  p.add(flare(new THREE.BoxGeometry(0.07, h, 0.4, 1, 3, 8), 0.08), col, at(0, -0.15 - h / 2, 0)); // 身子
  p.add(new THREE.BoxGeometry(0.085, 0.06, 0.13), dim(col, 0.75), at(0, -0.085, 0)); // 领子
}

/**
 * 吃光的黑（调研 S3）：门里的东西按离柜体正面多深压暗顶点色。dz：几何体的 z 加上它才是物件局部坐标的进深。
 * 门板在柜体正面前面，乘的是 1，不受影响
 */
function shadeByDepth(g: THREE.BufferGeometry, dz: number, zFace: number) {
  const { lit, dark } = LK.deep;
  const pos = g.attributes.position, col = g.attributes.color;
  for (let i = 0; i < pos.count; i++) {
    const u = clamp01((pos.getZ(i) + dz - (zFace - dark)) / (dark - lit));
    const k = u * u * (3 - 2 * u);
    col.setXYZ(i, col.getX(i) * k, col.getY(i) * k, col.getZ(i) * k);
  }
}

// ───────────────────────── 手指 ─────────────────────────

/**
 * 四根手指（食指到小指，从上往下；手横着伸出来，四指弯过门边）：高度（米）、各节的半径和长度（掌骨、近节、中节、远节），
 * lift：中节离开门面翘起多少、bend：远节再往门面弯多少（弧度；每根略有不同，不像一排复制出来的）。手指在把手（1.1–1.22 米）上面一点。
 * 掌骨只留指根后面一小截（不到 2 厘米），splay：往门后（合页那边）斜多少。门开到 25° 以后，门后那一块是露在外面的楔形空间、
 * 不在柜子里，掌骨一长就在亮的外套边上显出一截黑桩（审查 Minor-3）
 */
const HAND = [
  { y: 1.369, r: [0.0095, 0.0088, 0.0081, 0.0074], len: [0.017, 0.041, 0.025, 0.02], lift: 0.12, bend: 0.26, splay: 1.1 },
  { y: 1.35, r: [0.0098, 0.0091, 0.0084, 0.0076], len: [0.018, 0.045, 0.028, 0.021], lift: 0.16, bend: 0.28, splay: 1.15 },
  { y: 1.331, r: [0.0094, 0.0086, 0.0079, 0.0072], len: [0.017, 0.042, 0.026, 0.02], lift: 0.13, bend: 0.27, splay: 1.2 },
  { y: 1.314, r: [0.0085, 0.0076, 0.007, 0.0065], len: [0.016, 0.033, 0.019, 0.018], lift: 0.2, bend: 0.3, splay: 1.3 },
];

/**
 * 手指的其余几个数。skin：苍白发灰、偏冷的底色（手电是暖光，底色不冷一点照出来就成了肉色）；gap：离门板留的缝（米）；
 * pull：缩回去时整只手往门后退多少（米）；
 * slide：伸出来的前这一段（0..1）是「从门缝里探出来」，后面是「弯过门边扶住」（缩回去倒过来：先松开、再退回去）；
 * droop：掌骨往下斜多少（弧度）：和娃娃屋镜头的仰角（35°）差不多，从默认的东南机位看，掌骨正好藏在指节后面；
 * dark / lit：颜色按合页坐标的 z（门板里面是 0，往柜子里为负）压暗，dark 米全黑、lit 米不压：指根以后没进黑里
 */
const FINGER = { skin: 0xa1a7a5, gap: 0.0015, pull: 0.11, slide: 0.5, droop: 0.55, dark: -0.035, lit: 0.02 };

/**
 * 手指的网格（合页坐标：原点在合页轴上，门板占 x ∈ [0, 门缝那条边]、z ∈ [0, 门板厚]；合页在门的西边，
 * 所以门缝那条边在 +x，「往合页那边」是 −x）。
 * 每节一个胶囊，基础形状沿 +y 从 0 到这一节的长度；pose 按关节角把每节转到位写进顶点（只转不镜像，三角形绕向不变）
 */
function createFingers(L: WardrobeLayout) {
  const B = WARDROBE_BOX;
  /** 门缝那条边（合页坐标的 x） */
  const xe = L.xo - B.gap / 2;
  const bones: { off: number; base: Float32Array; nbase: Float32Array }[] = [];
  const pos: number[] = [], nrm: number[] = [], index: number[] = [];
  for (const f of HAND) {
    for (let k = 0; k < 4; k++) {
      const g = new THREE.CapsuleGeometry(f.r[k], f.len[k], 3, 7).translate(0, f.len[k] / 2, 0);
      const off = pos.length / 3;
      const p = g.attributes.position.array as Float32Array, n = g.attributes.normal.array as Float32Array;
      for (let i = 0; i < p.length; i++) { pos.push(p[i]); nrm.push(n[i]); }
      if (g.index) for (const i of g.index.array) index.push(i + off);
      else for (let i = 0; i < p.length / 3; i++) index.push(i + off);
      bones.push({ off, base: new Float32Array(p), nbase: new Float32Array(n) });
      g.dispose();
    }
  }
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(new Float32Array(pos), 3).setUsage(THREE.DynamicDrawUsage);
  const nrmAttr = new THREE.BufferAttribute(new Float32Array(nrm), 3).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', nrmAttr);
  geo.setIndex(index);
  // 手指的位置每帧在变：包围球按动得到的整个范围给一个，不按某一帧的顶点算（不然在画面边上会被错剔掉）
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(xe, 1.34, -0.05), 0.24);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(xe - 0.24, 1.1, -0.29), new THREE.Vector3(xe + 0.24, 1.58, 0.19));

  // 普通受光的材质，不发光：苍白的底色 × 按进深压暗（从门缝里看，手指是从黑里伸出来的）
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  mat.colorNode = color(FINGER.skin).mul(smoothstep(FINGER.dark, FINGER.lit, positionGeometry.z));
  const m = mesh(geo, mat, 'wardrobe-fingers');
  m.visible = false;
  // 平时看不见：不进开场那次阻塞的预编译，开场按钮可用之后由 main.ts 编好（第一次出手指时不卡）
  m.userData.deferCompile = true;

  const out = posAttr.array as Float32Array, nout = nrmAttr.array as Float32Array;
  /**
   * 把第 b 节放到 (sx, sy, sz)、沿方向 (dx, dy, dz)（单位向量，离竖直方向远着呢）：基础形状的 +y 转到这个方向，
   * 绕轴怎么转无所谓（胶囊是圆的）
   */
  const place = (b: number, sx: number, sy: number, sz: number, dx: number, dy: number, dz: number) => {
    const { off, base, nbase } = bones[b];
    // 基 Y' = d，X' = d × 上 再归一（= (−dz, 0, dx) / |…|），Z' = X' × Y'：正交、右手，三角形的绕向不变
    const h = Math.hypot(dx, dz);
    const ax = -dz / h, az = dx / h; // X'（水平）
    const zx = -dy * az, zy = az * dx - ax * dz, zz = dy * ax; // Z' = X' × Y'
    for (let i = 0, j = off * 3; i < base.length; i += 3, j += 3) {
      const vx = base[i], vy = base[i + 1], vz = base[i + 2];
      out[j] = sx + vx * ax + vy * dx + vz * zx;
      out[j + 1] = sy + vy * dy + vz * zy;
      out[j + 2] = sz + vx * az + vy * dz + vz * zz;
      const nx = nbase[i], ny = nbase[i + 1], nz = nbase[i + 2];
      nout[j] = nx * ax + ny * dx + nz * zx;
      nout[j + 1] = ny * dy + nz * zy;
      nout[j + 2] = nx * az + ny * dz + nz * zz;
    }
  };

  /** 按每根手指的 grip（0..1）摆好四根手指 */
  const pose = (grip: readonly number[]) => {
    HAND.forEach((f, i) => {
      const s = outCubic(clamp01(grip[i] / FINGER.slide));
      const c = outCubic(clamp01((grip[i] - FINGER.slide) / (1 - FINGER.slide)));
      // 近节在门缝那条边的端面外头往前（+z）伸，伸过门板正面再弯过来：中节、远节趴在门板正面上，指尖朝合页（−x）
      const back = (1 - s) * FINGER.pull;
      const px = xe + f.r[1] + FINGER.gap, pz = B.door + f.r[1] + FINGER.gap - back; // 中间那个指节
      const mz = pz - f.len[1]; // 指根
      // 掌骨：从门后的黑里（往合页那边、往下斜）伸到指根
      const ch = Math.cos(FINGER.droop), sh = Math.sin(FINGER.droop);
      const ux = Math.sin(f.splay) * ch, uz = Math.cos(f.splay) * ch; // 掌骨方向（指向指根）的水平部分
      const am = c * (Math.PI / 2 - f.lift), ad = am + c * f.bend; // 中节、远节从 +z 往合页那边转过去多少
      const dx = px - f.len[2] * Math.sin(am), dz = pz + f.len[2] * Math.cos(am);
      place(i * 4, px - f.len[0] * ux, f.y - f.len[0] * sh, mz - f.len[0] * uz, ux, sh, uz);
      place(i * 4 + 1, px, f.y, mz, 0, 0, 1);
      place(i * 4 + 2, px, f.y, pz, -Math.sin(am), 0, Math.cos(am));
      place(i * 4 + 3, dx, f.y, dz, -Math.sin(ad), 0, Math.cos(ad));
    });
    posAttr.needsUpdate = true;
    nrmAttr.needsUpdate = true;
  };
  pose([0, 0, 0, 0]);
  return { mesh: m, pose };
}

// ───────────────────────── 物件 ─────────────────────────

export function createWardrobe(): PropRig {
  const L = wardrobeLayout();
  const B = WARDROBE_BOX;
  const railZ = (L.zBack + L.zFace) / 2;
  const half = B.gap / 2;
  const model = new THREE.Group();
  model.name = 'wardrobe';
  const body = bodyMaterial(0.6);

  // 不动的部分（一个网格）：右边（东边）那扇门（一直关着）、衣杆、不晃的两件外套
  const sp = new Parts();
  addDoor(sp, L, half, L.xo, L.zFace, [0.03, 0.05]);
  sp.rod([-L.xo + 0.01, RAIL.y, railZ], [L.xo - 0.01, RAIL.y, railZ], RAIL.r, C.brass);
  for (const c of COATS.slice(1)) addCoat(sp, [c.x, RAIL.y, railZ], c.len, c.col);
  const stillGeo = sp.build();
  shadeByDepth(stillGeo, 0, L.zFace);
  const still = mesh(stillGeo, body, 'wardrobe-still');
  model.add(still);

  // 吃光的黑：门洞里一个不受光的纯黑盒子，只画里面（背面）。比柜体的里面往里缩 2 毫米，免得和侧板、背板的里面打架
  const inset = 0.002;
  const zFront = L.zFace - 0.001, zRear = L.zBack + inset;
  const darkGeo = new THREE.BoxGeometry(2 * (L.xo - inset), L.y1 - L.y0 - 2 * inset, zFront - zRear)
    .translate(0, (L.y0 + L.y1) / 2, (zFront + zRear) / 2);
  const dark = new THREE.Mesh(darkGeo, new THREE.MeshBasicNodeMaterial({ color: 0x000000, side: THREE.BackSide }));
  dark.name = 'wardrobe-dark';
  dark.castShadow = false;
  dark.receiveShadow = false;
  model.add(dark);

  // 晃的那件外套：挂钩在衣杆上，绕挂钩前后摆（关在柜子里，不投影；门、柜体投下的影子照样落在它身上）
  const sway = COATS[0];
  const cp = new Parts();
  addCoat(cp, [0, 0, 0], sway.len, sway.col);
  const coatGeo = cp.build();
  shadeByDepth(coatGeo, railZ, L.zFace);
  const pivot = new THREE.Group();
  pivot.position.set(sway.x, RAIL.y, railZ);
  const coat = mesh(coatGeo, body, 'wardrobe-coat');
  coat.castShadow = false;
  pivot.add(coat);
  model.add(pivot);

  // 左边（西边）那扇门：合页在它外侧（门洞左沿、柜体正面），门板在合页坐标里占 x ∈ [0, 门缝那条边]。
  // 往外开（门缝那条边往 +z 走、往西南转）是绕 y 转负角：rotation.y = −doorDeg
  const hinge = new THREE.Group();
  hinge.name = 'wardrobe-hinge';
  hinge.position.set(-L.xo, 0, L.zFace);
  const xe = L.xo - half;
  const dp = new Parts();
  addDoor(dp, L, 0, xe, 0, [L.xo - 0.05, L.xo - 0.03]);
  const door = mesh(dp.build(), body, 'wardrobe-door');
  hinge.add(door);
  // 手指扶着这扇门的门边，跟着门一起动
  const fingers = createFingers(L);
  hinge.add(fingers.mesh);
  model.add(hinge);

  /** 一扇门的幽光外壳（门板 + 门芯的外包盒）：a..b 是门的 x 范围，z0 是门板背面 */
  const doorShell = (a: number, b: number, z0: number) =>
    new THREE.BoxGeometry(b - a, L.y1 - L.y0, B.door + B.panel).translate((a + b) / 2, (L.y0 + L.y1) / 2, z0 + (B.door + B.panel) / 2);

  let t = -1;
  let withFingers = false;
  const grip = [0, 0, 0, 0];
  const rest = () => {
    t = -1;
    hinge.rotation.y = 0;
    pivot.rotation.x = 0;
    model.position.set(0, 0, 0);
    fingers.mesh.visible = false;
  };
  const pose = (s: number) => {
    hinge.rotation.y = -THREE.MathUtils.degToRad(doorDeg(s));
    pivot.rotation.x = coatSwing(s);
    const [sx, sz] = slamShake(s);
    model.position.set(sx, 0, sz);
    let any = false;
    for (let i = 0; i < grip.length; i++) {
      grip[i] = withFingers ? fingerGrip(s, i) : 0;
      if (grip[i] > 0) any = true;
    }
    fingers.mesh.visible = any;
    if (any) fingers.pose(grip);
  };

  return {
    model,
    // 拾取盒盖住整个衣柜（柜体是家具，但玩家看到的就是一个衣柜）；幽光只在两扇门上
    hit: { size: [L.w, FURNITURE_TOP.wardrobe, 2 * L.zf], center: [0, FURNITURE_TOP.wardrobe / 2, 0] },
    shells: [
      { parent: still, geometry: doorShell(half, L.xo, L.zFace) },
      { parent: door, geometry: doorShell(0, xe, 0) },
    ],
    trigger(_state: WorldState, e: TriggerEvent) {
      t = 0;
      withFingers = hasFingers(e.variant);
    },
    reset() {},
    update(f: PropFrame) {
      if (t < 0) return;
      t += f.dt;
      if (t >= END) {
        rest();
        return;
      }
      pose(t);
    },
    setQuality(q: Quality) {
      // low 档：手指不进手电的阴影图（只露半秒、一厘米多粗，512 的阴影图上也看不出影子）
      fingers.mesh.castShadow = q === 'high';
    },
    dispose() {
      // 几何体、材质（连幽光外壳、霜外壳）由 props.ts 统一收集释放；这里没有贴图、没有灯，不用另外释放
    },
  };
}
