// 落地穿衣镜：两根立柱夹着一面可以俯仰的椭圆镜，镜面是深色高光泽的材质（不做真实反射）。
// 被附身（时间线见 MIRROR_T）：
// 1. 镜子里像有人对着玻璃呼气：一层冷雾从镜面中间（脸的嘴边）往外漫开，边缘不规则，雾里有细密的水汽斑；
// 2. 一只手从镜子里面按在玻璃上：雾里先出现掌根，再一路印到指尖（手印处雾被抹开，露出黑亮的镜面）；
// 3. 雾后面隐约闪过两下脸，然后黑掉、停顿——0.6 秒时整张脸猛地扑到镜面上、最亮，镜子一震（这一下是高潮，不动）。
//    脸贴上玻璃的地方雾被抹开（额头、颧骨、下巴；眼窝和嘴没贴上，还是雾），脸是压在黑亮的镜面上的，
//    手电把雾照得发白时也不会把脸冲淡；
// 4. 脸按噪声一块块化开，化开的边缘有一圈很淡的冷光，不是一下子切掉；
// 5. 脸化开的地方雾慢慢合拢；雾气和手印留在镜面上，几秒里从边缘往中间慢慢散掉。
// 雾、手印都画在镜面自己的材质里（几个 uniform），脸是贴着镜面的一块面片；不在运行时新建任何材质、网格或灯。
// 脸（2026-10-30 恐怖画）：素材中台生成的真实质感的脸（public/assets/paintings/mirror-face.webp：湿头发、双手按在起雾的玻璃上、黑底），
// 下载不到时用原来程序画的那张。照片是不透明的：脸和指尖留着，黑底和外圈的头发化进雾里（faceAlpha），再按镜面的椭圆裁掉，
// 雾、手印、时间线、亮度、冷光都照旧。
// 镜子前面放一盏平时强度为 0 的冷光点光源，跟着脸一起亮：镜子背对镜头时也能看到浴室里闪了一下。
import * as THREE from 'three/webgpu';
import {
  abs, clamp, color, float, length, luminance, max, min, mix, mx_noise_float, positionLocal, smoothstep, texture, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { PALETTE } from '../palette';
import { paintingTexture } from '../paintings';
import { C, Parts, bodyMaterial, inOutSine, lerp, mesh, outExpo, outQuad, seg, wobble, type PropFrame, type PropRig } from './kit';

// 椭圆镜（米）：外框半轴、镜面半轴、中心高度、往后仰的角度
const OA = 0.28, OB = 0.58;
const GA = 0.24, GB = 0.53;
const MID_Y = 0.98;
const TILT = -0.07;
const POST_X = 0.34, POST_H = 1.62;
/** 脸的面片：尺寸、中心在镜面上的高度（镜面坐标，原点在镜面中心） */
const FACE_W = 0.36, FACE_H = 0.48, FACE_Y = 0.13;
/** 脸的面片宽、高（米）：贴图按这个比例裁（tests/paintings.test.ts 查） */
export const MIRROR_FACE = [FACE_W, FACE_H] as const;
/**
 * 照片怎么从雾里浮出来（照片是不透明的、黑底）：以脸的中心 center（面片 uv，下沿为 0）为圆心，横向乘 wide（椭圆往两边多伸一点，
 * 按在玻璃上的手指留得住一半），椭圆距离 oval[0] 起淡、oval[1] 没；core 以内整块都在（整张脸：眼睛、嘴、贴在脸上的湿头发），
 * 往外只留亮的地方（下巴、指尖：线性亮度 key 之间过渡），黑底和外圈的头发化进雾里。原来按圆角矩形淡出，深色的头发在发白的雾上
 * 留下一圈方方的边，像镜子上贴了一张照片；只留亮处、圈太小时眼睛也被抠掉，成了一张没眼睛的白面具（看样发现）。
 * edge：面片最外这么宽的一圈也淡到 0（贴图在边上被夹住，面片外面不能拖出边上的像素）。
 * eyes：照片里两只眼睛的高度，化开时眼睛一带最后才没
 */
const FACE_FADE = {
  center: [0.5, 0.56] as [number, number], wide: 0.8, oval: [0.62, 1.05] as [number, number], core: [0.45, 0.75] as [number, number],
  key: [0.03, 0.22] as [number, number], edge: 0.04, eyes: 0.69,
};

/** 表演的时间线（秒，从 trigger 算起） */
export const MIRROR_T = {
  /** 呼气的雾从嘴边漫满整面镜子 */
  fogTo: 0.42,
  /** 手印从掌根按到指尖 */
  handFrom: 0.15,
  handTo: 0.36,
  /** 脸扑上来（声音的冲击点；config/scares.ts 的 hitAt 对这里） */
  hit: 0.6,
  /** 脸化开 */
  dissolveFrom: 0.8,
  dissolveTo: 1.25,
  /** 雾和手印留在镜面上，从 clearFrom 起从边缘往中间散，clearTo 散完 */
  clearFrom: 2.4,
  clearTo: 5.4,
};
const T = MIRROR_T;

/**
 * 脸在雾后面的两下闪现、扑上来之后的亮度：[开始时间（秒）, 亮度]，每段持续到下一段开始。
 * 0.5–0.6 秒完全黑掉，留出停顿；0.6 秒是重击（亮度 > 1 的第一项，声音的冲击点对这里）
 */
const FLICKER: [number, number][] = [
  [0.0, 0.0], [0.38, 0.65], [0.43, 0.0], [0.47, 0.4], [0.5, 0.0],
  [T.hit, 1.3], [0.7, 1.12],
];
/** 化开：亮度 level（泛光退下去之后的样子），每 step 秒在 MIRROR_FLASH 里记一次「剩下多少 × 亮度」 */
const DISSOLVE = { level: 1.0, step: 0.05 };
/** 化开的进度 0..1（0 = 整张脸，1 = 没了） */
const dissolveAt = (t: number) => inOutSine(seg(t, T.dissolveFrom, T.dissolveTo));

/**
 * 脸的亮度表（声音对齐用，sfx.ts 的 mirror() 读它）：[时间, 亮度]，每段持续到下一段开始。
 * 扑上来之前是 FLICKER；化开那段是连续的，这里按 DISSOLVE.step 取样成「亮度 × 剩下的比例」，
 * 声音的上层音簇跟着它一级级收掉；最后一项（亮度 0）是脸完全消失的时刻
 */
export const MIRROR_FLASH: [number, number][] = [
  ...FLICKER,
  ...Array.from({ length: Math.round((T.dissolveTo - T.dissolveFrom) / DISSOLVE.step) }, (_, i): [number, number] => {
    const at = T.dissolveFrom + i * DISSOLVE.step;
    return [+at.toFixed(3), +(DISSOLVE.level * (1 - dissolveAt(at))).toFixed(3)];
  }),
  [T.dissolveTo, 0],
];

/**
 * 冷雾：反照率（偏冷的灰；手电贴近照上去会很亮，再浅就和扑上来的脸一样亮了）、
 * 镜面上发的一点散光（月光色的倍数：没有手电照着时也看得出起了雾）
 */
const CONDENSE = {
  frost: new THREE.Color(0x2e3438),
  glow: 0.22,
  /** 雾漫开的前沿：噪声让边缘不规则的幅度、前沿的软边宽度 */
  edgeNoise: 0.2,
  edgeSoft: 0.12,
  /** 水汽斑：频率（每米）、深浅 */
  mottleFreq: 70,
  mottle: 0.14,
  /** 嘴边最厚，往外薄到这个比例 */
  rim: 0.6,
  /** 脸被雾遮住多少：在雾后面闪的两下 / 扑上来贴在玻璃上之后 */
  veil: [0.6, 0.12] as [number, number],
};

/**
 * 脸印：扑上来那一下（缩放 scale）脸贴着玻璃的地方雾被抹掉 clear；贴得实不实按脸贴图的亮度（luma 之间过渡），
 * 眼窝、嘴、头发处不抹（取模糊的 mip 级 blur，印子是软的，不是一缕缕头发）。之后 settle 秒里雾回来，剩 keep。
 * keep 取 0：脸化开以后留下的脸印在截图里像一块污渍、认不出是脸，只留手印当「来过」的痕迹
 */
const IMPRINT = { scale: 1.24, clear: 0.9, luma: [0.25, 0.65] as [number, number], settle: 1.6, keep: 0, blur: 4 };

/** 手印：在镜面上的中心、大小（米，贴图的整个框）、转角；手印里雾被抹掉的比例、边上被挤起的一圈雾 */
const HAND = { x: 0.1, y: -0.2, w: 0.14, h: 0.21, rot: -0.2, clear: 0.92, ridge: 0.35 };

/** 化开的边：冷光颜色（线性，>1 的部分交给泛光）、宽度（噪声单位）、亮度 */
const EDGE = { color: new THREE.Color(0.55, 0.8, 1.0), width: 0.11, gain: 1.6 };

const sample = (tab: [number, number][], t: number) => {
  let v = tab[0][1];
  for (const [at, x] of tab) if (t >= at) v = x;
  return v;
};

/**
 * 用 Canvas 画镜子里的脸：长脸、深陷的黑眼窝、张大的嘴，边缘渐隐到透明（像从镜子深处浮出来）。
 * 2026-10-30 起只是备用：生成的照片（mirror-face.webp）下载不到时用它
 */
function paintFace(): HTMLCanvasElement {
  const W = 256, H = 340;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const cx = W / 2;
  // 头：中心偏白、带一点幽绿，往外渐隐
  let gr = g.createRadialGradient(cx, H * 0.46, 10, cx, H * 0.5, W * 0.48);
  gr.addColorStop(0, 'rgba(236,246,238,1)');
  gr.addColorStop(0.55, 'rgba(206,226,214,0.95)');
  gr.addColorStop(0.8, 'rgba(150,180,165,0.45)');
  gr.addColorStop(1, 'rgba(120,150,140,0)');
  g.fillStyle = gr;
  g.beginPath();
  g.ellipse(cx, H * 0.5, W * 0.4, H * 0.47, 0, 0, Math.PI * 2);
  g.fill();
  // 两侧垂下来的黑发
  g.strokeStyle = 'rgba(10,14,12,0.75)';
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {
    const s = i % 2 ? 1 : -1;
    const x0 = cx + s * (W * 0.1 + (i * 7) % 40);
    g.lineWidth = 2 + (i % 4);
    g.beginPath();
    g.moveTo(x0, H * 0.04);
    g.bezierCurveTo(x0 + s * 30, H * 0.25, x0 + s * (20 + (i % 5) * 6), H * 0.6, x0 + s * (26 + (i % 3) * 10), H * 0.98);
    g.stroke();
  }
  // 颧骨下凹、太阳穴的阴影
  g.fillStyle = 'rgba(60,80,72,0.35)';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + s * W * 0.17, H * 0.6, W * 0.07, H * 0.11, s * 0.2, 0, Math.PI * 2);
    g.fill();
  }
  // 眼窝：很大、很黑、往下斜；中间一点针尖似的亮光
  g.shadowColor = 'rgba(0,0,0,0.9)';
  g.shadowBlur = 14;
  g.fillStyle = '#020303';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + s * W * 0.135, H * 0.41, W * 0.085, H * 0.07, s * -0.25, 0, Math.PI * 2);
    g.fill();
  }
  // 嘴：竖着张开的黑洞
  g.beginPath();
  g.ellipse(cx, H * 0.76, W * 0.065, H * 0.11, 0, 0, Math.PI * 2);
  g.fill();
  g.shadowBlur = 0;
  // 鼻子：两道细缝
  g.fillStyle = 'rgba(20,30,26,0.8)';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.ellipse(cx + s * 6, H * 0.585, 3, 7, s * 0.3, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(220,255,235,0.95)';
  for (const s of [-1, 1]) {
    g.beginPath();
    g.arc(cx + s * W * 0.135, H * 0.415, 2.2, 0, Math.PI * 2);
    g.fill();
  }
  return cv;
}

/**
 * 用 Canvas 画手印的遮罩（白 = 贴着玻璃）：手指朝上，掌根在下。真的手按在玻璃上，
 * 掌心是空的、指节处有折痕，只有掌根、掌丘和指肚贴得实——这样才像手印，不像剪影
 */
function paintHand(): HTMLCanvasElement {
  const W = 128, H = 192;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  // 手掌
  g.beginPath();
  g.ellipse(66, 136, 38, 44, 0.04, 0, Math.PI * 2);
  g.fill();
  // 四指（底端、顶端、粗细）和拇指：手指并得比较拢，指根埋进手掌里
  const fingers: [number, number, number, number, number][] = [
    [44, 104, 38, 42, 19], // 食指
    [62, 100, 61, 26, 20], // 中指
    [80, 102, 84, 34, 19], // 无名指
    [97, 112, 104, 62, 17], // 小指
  ];
  for (const [x0, y0, x1, y1, w] of fingers) {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(x0, y0);
    g.lineTo(x1, y1);
    g.stroke();
  }
  g.lineWidth = 22;
  g.beginPath();
  g.moveTo(40, 152);
  g.quadraticCurveTo(22, 132, 16, 106);
  g.stroke();
  // 贴得不实的地方：掌心、指节折痕、掌纹（用半透明的黑压暗；画布底是不透明的黑，着色器只读 r 通道。
  // 不能用 destination-out：它只减 alpha，贴图上传时按非预乘处理，r 还是白的）
  const soft = (x: number, y: number, rx: number, ry: number, a: number, rot = 0) => {
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    gr.addColorStop(0, `rgba(0,0,0,${a})`);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.scale(rx, ry);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, 1, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  soft(64, 128, 26, 22, 0.85); // 掌心
  soft(30, 128, 8, 14, 0.5, 0.4); // 拇指根和掌心之间
  g.lineWidth = 2.2;
  g.strokeStyle = 'rgba(0,0,0,0.75)';
  for (const [x0, y0, x1, y1] of fingers) {
    for (const k of [0.36, 0.66]) {
      const x = x0 + (x1 - x0) * k, y = y0 + (y1 - y0) * k;
      g.beginPath();
      g.moveTo(x - 8, y + 1);
      g.lineTo(x + 8, y - 1);
      g.stroke();
    }
  }
  g.lineWidth = 1.6;
  g.strokeStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.moveTo(34, 112);
  g.quadraticCurveTo(60, 120, 98, 108); // 感情线
  g.moveTo(36, 124);
  g.quadraticCurveTo(58, 138, 82, 150); // 智慧线
  g.moveTo(44, 106);
  g.quadraticCurveTo(40, 140, 52, 172); // 生命线
  g.stroke();
  return cv;
}

const ellipseShape = (a: number, b: number, hole?: [number, number]) => {
  const s = new THREE.Shape();
  s.absellipse(0, 0, a, b, 0, Math.PI * 2, false, 0);
  if (hole) {
    const h = new THREE.Path();
    h.absellipse(0, 0, hole[0], hole[1], 0, Math.PI * 2, true, 0);
    s.holes.push(h);
  }
  return s;
};

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

/** 面片 uv（0..1，下沿 v = 0）到脸中心的椭圆距离（FACE_FADE.center、wide；脸的上下沿约 ±1） */
const faceR = (fuv: V2): F => length(fuv.sub(vec2(...FACE_FADE.center)).mul(vec2(2 * FACE_FADE.wide, 2)));
/** 面片 uv 处照片的轮廓（FACE_FADE 的椭圆 × 面片边上那一圈；不看颜色）：面片外面是 0 */
function faceOval(fuv: V2): F {
  const E = FACE_FADE.edge;
  const rect = smoothstep(0, E, min(min(fuv.x, float(1).sub(fuv.x)), min(fuv.y, float(1).sub(fuv.y))));
  return rect.mul(float(1).sub(smoothstep(FACE_FADE.oval[0], FACE_FADE.oval[1], faceR(fuv))));
}
/** 面片 uv 处照片留多少：轮廓里，core 以内整块留，往外只留亮的地方（rgb 是这一点的颜色，线性） */
function faceAlpha(fuv: V2, rgb: THREE.Node<'vec3'>): F {
  const keep = smoothstep(FACE_FADE.key[0], FACE_FADE.key[1], luminance(rgb));
  const core = float(1).sub(smoothstep(FACE_FADE.core[0], FACE_FADE.core[1], faceR(fuv)));
  return faceOval(fuv).mul(mix(keep, float(1), core));
}
/** 脸的贴图在面片 uv 处的颜色：贴图不翻转（paintings.ts），第 0 行是照片的上沿 */
const faceAt = (tex: THREE.Texture, fuv: V2, level?: F) => (level ? texture(tex, vec2(fuv.x, float(1).sub(fuv.y)), level) : texture(tex, vec2(fuv.x, float(1).sub(fuv.y))));

/**
 * 镜面上的雾（镜面和脸的材质共用）：p 是镜面坐标（米，原点在镜面中心）。
 * spread：雾漫开的进度（散去时倒着走：从边上先散）；press：手印按下去的进度。
 * 返回 cover（0 = 干净的镜面，1 = 浓雾）
 */
function condensation(p: V2, spread: F, press: F, imprint: F, handTex: THREE.Texture, faceTex: THREE.Texture): F {
  // 到镜面边缘的归一化距离（中心 0、镜框 1）；呼气从嘴边（脸的面片里嘴的位置，约镜面中心）开始
  const d = length(vec2(p.x.div(GA), p.y.div(GB)));
  const n = mx_noise_float(vec3(p.x.mul(9), p.y.mul(9), 3.1));
  const front = spread.mul(1.3).sub(d).add(n.mul(CONDENSE.edgeNoise));
  const body = smoothstep(0, CONDENSE.edgeSoft, front);
  // 嘴边厚、往外薄；细密的水汽斑
  const thick = float(1).sub(d.mul(1 - CONDENSE.rim));
  const mottle = mx_noise_float(vec3(p.x.mul(CONDENSE.mottleFreq), p.y.mul(CONDENSE.mottleFreq), 7.7)).mul(CONDENSE.mottle).add(1 - CONDENSE.mottle * 0.5);
  let cover: F = clamp(body.mul(thick).mul(mottle), 0, 1);

  // 手印：转到手的坐标系（u 横、v 从掌根 0 到指尖 1），按 v 从掌根往指尖一路印上去
  const c = Math.cos(-HAND.rot), s = Math.sin(-HAND.rot);
  const hx = p.x.sub(HAND.x), hy = p.y.sub(HAND.y);
  const hu = hx.mul(c).sub(hy.mul(s)).div(HAND.w).add(0.5);
  const hv = hx.mul(s).add(hy.mul(c)).div(HAND.h).add(0.5);
  const inBox = smoothstep(0, 0.02, min(min(hu, hv), min(float(1).sub(hu), float(1).sub(hv))));
  // CanvasTexture 默认 flipY：v = 0 是画布底边（掌根）
  const print = texture(handTex, vec2(hu, hv)).r.mul(inBox);
  const reach = smoothstep(0, 0.1, press.mul(1.15).sub(hv).add(n.mul(0.04)));
  const touch = print.mul(reach);
  // 手印里雾被抹掉；手印边上（遮罩半透明的那一圈）雾被挤得稍厚一点
  const ridge = smoothstep(0.05, 0.3, print).mul(float(1).sub(smoothstep(0.35, 0.8, print))).mul(reach).mul(HAND.ridge);
  cover = cover.mul(float(1).sub(touch.mul(HAND.clear))).mul(ridge.add(1));

  // 脸印：按扑上来那一刻的位置和大小，在脸贴图里取样
  const fuv = vec2(p.x.div(FACE_W * IMPRINT.scale), p.y.sub(FACE_Y).div(FACE_H * IMPRINT.scale)).add(0.5);
  const fs = faceAt(faceTex, fuv, float(IMPRINT.blur));
  const skin = faceOval(fuv).mul(fs.a).mul(smoothstep(IMPRINT.luma[0], IMPRINT.luma[1], luminance(fs.rgb)));
  cover = cover.mul(float(1).sub(skin.mul(imprint).mul(IMPRINT.clear)));
  return min(cover, 1);
}

export function createMirror(): PropRig {
  const model = new THREE.Group();
  model.name = 'mirror';
  const body = bodyMaterial(0.55, 0.2);

  // 支架：两根立柱、脚、底横档、顶上的小球
  const stand = new THREE.Group();
  const sp = new Parts();
  for (const s of [-1, 1]) {
    sp.box(0.045, POST_H, 0.045, C.woodDark, [s * POST_X, POST_H / 2, 0]);
    sp.box(0.06, 0.05, 0.44, C.woodDark, [s * POST_X, 0.025, 0]);
    sp.add(new THREE.SphereGeometry(0.035, 6, 4), C.brass, [s * POST_X, POST_H + 0.02, 0]);
    sp.cyl(0.02, 0.02, 0.05, 6, C.brass, [s * (POST_X - 0.04), MID_Y, 0], [0, 0, Math.PI / 2]); // 转轴
  }
  sp.box(POST_X * 2, 0.04, 0.04, C.woodDark, [0, 0.14, 0]);
  const standGeo = sp.build();
  const standMesh = mesh(standGeo, body, 'mirror-stand');
  stand.add(standMesh);
  model.add(stand);

  // 椭圆镜：转轴在两侧立柱之间；外框（挤出的椭圆环）+ 背板 + 镜面
  const swing = new THREE.Group();
  swing.position.y = MID_Y;
  swing.rotation.x = TILT;
  const fp = new Parts();
  fp.add(new THREE.ExtrudeGeometry(ellipseShape(OA, OB, [GA, GB]), { depth: 0.04, bevelEnabled: false, curveSegments: 22 }), C.wood, [0, 0, -0.02]);
  fp.add(new THREE.ShapeGeometry(ellipseShape(GA + 0.01, GB + 0.01), 22), C.woodDark, [0, 0, -0.012], [0, Math.PI, 0]); // 背板（朝后）
  fp.add(new THREE.ExtrudeGeometry(ellipseShape(0.03, 0.03), { depth: 0.012, bevelEnabled: false, curveSegments: 6 }), C.brass, [0, OB - 0.005, 0.01]); // 顶上的铜饰
  const frameGeo = fp.build();
  const frame = mesh(frameGeo, body, 'mirror-frame');
  swing.add(frame);

  // 雾、手印、脸印的 uniform（镜面和脸共用）
  const spread = uniform(0);
  const press = uniform(0);
  const imprint = uniform(0);
  const handTex = new THREE.CanvasTexture(paintHand());
  handTex.colorSpace = THREE.NoColorSpace;
  // 镜中人脸：生成的照片（全页共用的贴图，paintings.ts 下载）；下载不到时换上程序画的那张
  const faceTex = paintingTexture('mirrorFace', paintFace);

  // 镜面：近黑、很光滑；加一道很淡的斜向高光和上亮下暗的月光色，让它读得出是玻璃。
  // 起雾的地方变成乳白、粗糙、不再像金属那样反光（雾把镜面的反光打散成一片均匀的微光），手电照上去会亮
  const glassMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0.5 });
  const gp = positionLocal.xy;
  const cover = condensation(gp, spread, press, imprint, handTex, faceTex);
  const streak = smoothstep(float(0.035), float(0), abs(positionLocal.x.add(positionLocal.y.mul(0.55)).sub(0.06)));
  const grad = positionLocal.y.div(GB).mul(0.5).add(0.5);
  glassMat.colorNode = mix(color(0x0c1216), color(CONDENSE.frost), cover);
  glassMat.roughnessNode = mix(float(0.06), float(0.92), cover);
  glassMat.metalnessNode = mix(float(0.5), float(0), cover);
  glassMat.emissiveNode = color(PALETTE.moon).mul(mix(grad.mul(0.07).add(streak.mul(0.14)), float(CONDENSE.glow), cover));
  const glass = mesh(new THREE.ShapeGeometry(ellipseShape(GA, GB), 24), glassMat, 'mirror-glass');
  glass.position.z = 0.004;
  glass.castShadow = false;
  swing.add(glass);

  // 脸：一块贴着镜面的面片，平时完全透明。在雾后面时被雾遮住一部分（veil）；化开时按噪声一块块消失，边上一圈冷光
  const faceAmt = uniform(0);
  const dissolve = uniform(0);
  const veil = uniform(CONDENSE.veil[0]);
  /** 面片在镜面坐标里的位置 x、y 和缩放：脸的着色器据此找到自己盖着的那块雾 */
  const faceXf = uniform(new THREE.Vector3(0, FACE_Y, 1));
  const faceMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const fUv = uv();
  const ft = faceAt(faceTex, fUv);
  // 化开的噪声：眼睛一带最后才化（偏置），外圈先没
  const dn = mx_noise_float(vec3(fUv.x.mul(5.5), fUv.y.mul(7), 11.3)).mul(0.5)
    .add(mx_noise_float(vec3(fUv.x.mul(15), fUv.y.mul(19), 4.2)).mul(0.22));
  const bias = float(1).sub(length(vec2(fUv.x.sub(0.5).mul(1.3), fUv.y.sub(FACE_FADE.eyes))).mul(1.6));
  const n01 = clamp(dn.add(bias.mul(0.35)).mul(0.6).add(0.45), 0, 1);
  const above = n01.sub(dissolve.mul(1 + EDGE.width + 0.04).sub(EDGE.width));
  const alive = smoothstep(0, 0.03, above);
  const dissolving = smoothstep(0, 0.02, dissolve);
  const edge = float(1).sub(smoothstep(0.02, EDGE.width, above)).mul(alive).mul(dissolving);
  const onGlass = vec2(faceXf.x, faceXf.y).add(positionLocal.xy.mul(faceXf.z));
  const faceCover = condensation(onGlass, spread, press, imprint, handTex, faceTex);
  const seen = float(1).sub(faceCover.mul(veil));
  // 照片留多少：边缘渐隐 × 贴图的 alpha（备用的 Canvas 有）× 镜面的椭圆以内（扑上来放大时面片的上下角伸出镜面）
  const inGlass = float(1).sub(smoothstep(0.93, 1, length(vec2(onGlass.x.div(GA), onGlass.y.div(GB)))));
  const fa = faceAlpha(fUv, ft.rgb).mul(ft.a).mul(inGlass);
  const aFace = fa.mul(faceAmt.min(1)).mul(alive).mul(seen);
  const aEdge = fa.mul(edge).mul(seen).mul(0.85);
  const share = aEdge.div(max(aFace.add(aEdge), 0.001));
  // 苍白里带一点幽绿；> 1 的部分交给泛光
  faceMat.colorNode = mix(ft.rgb.mul(vec3(0.95, 1.05, 1.0)).mul(faceAmt.mul(1.5)), vec3(EDGE.color.r, EDGE.color.g, EDGE.color.b).mul(EDGE.gain), share);
  faceMat.opacityNode = min(aFace.add(aEdge), 1);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(FACE_W, FACE_H), faceMat);
  face.name = 'mirror-face';
  face.position.set(0, FACE_Y, 0.008);
  face.renderOrder = 3;
  // 先留着可见（完全透明），第一次 update 时藏起来。不进开场那次阻塞的预编译（deferCompile）：
  // main.ts 在开场按钮可用之后再异步编它，省掉冷启动的等待，第一次附身镜子时也不会卡
  face.visible = true;
  face.userData.deferCompile = true;
  swing.add(face);
  model.add(swing);

  // 跟着脸亮的冷光（平时 0）
  const flash = new THREE.PointLight(PALETTE.possess, 0, 4.5, 2);
  flash.position.set(0, 1.15, 0.55);
  flash.castShadow = false;
  model.add(flash);

  let t = -1;
  let primed = false;

  const rest = () => {
    t = -1;
    faceAmt.value = 0;
    dissolve.value = 0;
    spread.value = 0;
    press.value = 0;
    imprint.value = 0;
    face.visible = false;
    flash.intensity = 0;
    swing.rotation.set(TILT, 0, 0);
    stand.position.x = 0;
  };

  return {
    model,
    hit: { size: [0.85, POST_H + 0.1, 0.5], center: [0, (POST_H + 0.1) / 2, 0] },
    shells: [
      { parent: standMesh, geometry: standGeo },
      { parent: frame, geometry: new THREE.ExtrudeGeometry(ellipseShape(OA, OB), { depth: 0.04, bevelEnabled: false, curveSegments: 16 }).translate(0, 0, -0.02) },
    ],
    trigger() {
      t = 0;
    },
    reset() {},
    update(f: PropFrame) {
      if (!primed) { primed = true; if (t < 0) face.visible = false; }
      if (t < 0) return;
      t += f.dt;

      // 雾：呼气漫开（先快后慢），停一阵，再从边缘往中间散
      spread.value = t < T.clearFrom ? outQuad(seg(t, 0, T.fogTo)) : 1 - inOutSine(seg(t, T.clearFrom, T.clearTo));
      press.value = inOutSine(seg(t, T.handFrom, T.handTo));
      imprint.value = t < T.hit ? 0 : lerp(1, IMPRINT.keep, outQuad(seg(t, T.hit, T.hit + IMPRINT.settle)));

      // 脸：扑上来之前按闪现表；之后亮度停在 DISSOLVE.level，按噪声化开
      const d = dissolveAt(t);
      const a = t < T.dissolveFrom ? sample(FLICKER, t) : t < T.dissolveTo ? DISSOLVE.level : 0;
      faceAmt.value = a;
      dissolve.value = d;
      face.visible = a > 0;
      veil.value = t < T.hit ? CONDENSE.veil[0] : CONDENSE.veil[1];
      // 脸的大小：先在镜子深处（小），0.6 秒猛地扑上来（放大），之后慢慢退回去、一边化开
      const lunge = t < T.hit ? lerp(0.9, 0.98, t / T.hit) : lerp(1.24, 1.06, outExpo(seg(t, T.hit, T.dissolveTo)));
      face.scale.setScalar(lunge);
      face.position.x = a > 0.9 ? wobble(t * 4, 2) * 0.006 : 0;
      faceXf.value.set(face.position.x, face.position.y, lunge);
      // 冷光跟着「还剩多少脸」走（和 MIRROR_FLASH 一致）
      flash.intensity = a * (1 - d) * 2.6;
      // 镜子一震：第一次闪现轻，0.6 秒那一下重
      const k = 0.4 * (t >= FLICKER[1][0] ? 1 - seg(t, FLICKER[1][0], FLICKER[1][0] + 0.15) : 0) + (t >= T.hit ? 1 - seg(t, T.hit, T.hit + 0.28) : 0);
      swing.rotation.set(TILT + wobble(t * 3.3, 1) * 0.04 * k, 0, wobble(t * 3.1, 4) * 0.025 * k);
      stand.position.x = wobble(t * 3.7, 7) * 0.006 * k;
      if (t >= T.clearTo) rest();
    },
    dispose() {
      faceTex.dispose();
      handTex.dispose();
      flash.dispose();
    },
  };
}
