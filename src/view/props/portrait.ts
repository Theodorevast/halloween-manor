// 肖像：画架上一幅维多利亚风格的女士像（2026-10-30 起是素材中台生成的油画，public/assets/paintings/portrait.webp，穿丧服的年轻女士）。
// 被附身时眼睛猛地转向最近的访客、瞳孔里亮起一点幽绿；就在那一刻，她的脸开始化开成同一幅画的恐怖版（portrait-possessed.webp：
// 脸成了张大嘴的骷髅、脸周围的颜料起泡龟裂），从脸往外漫过整幅画，访客受惊（0.94 秒）时正好换完（见 PORTRAIT_REVEAL），不闪；
// 那张脸留 1.5 秒盯着人，然后画框发抖、整幅画向前扑倒、脸朝下砸在地上，回弹一下（时间线见 T）。broken 期间一直趴着，reset 时还脸朝下就换回平常的样子，飘回画架。
// 画砸下去时把地上积的灰吹开：画扶回画架以后，地板上留下一块比周围干净的长方形印子，几秒里慢慢淡掉（见 PRINT）。
import * as THREE from 'three/webgpu';
import {
  abs, clamp, color, dot, exp, float, length, max, min, mix, mx_noise_float, positionLocal, smoothstep, texture, uniform, uv, vec2, vec3,
} from 'three/tsl';
import { C, Parts, bodyMaterial, bump, inOutCubic, inOutSine, inQuad, lerp, mesh, outCubic, outQuad, seg, wobble, type PropFrame, type PropRig } from './kit';
import { SCARES } from '../../config/scares';
import { PALETTE } from '../palette';
import { paintingTexture } from '../paintings';

// 画布尺寸（米）和画框
const CW = 0.62, CH = 0.82;
const FW = 0.74, FH = 0.94, FD = 0.05;
/** 画布的宽、高（米）：两张贴图按这个比例裁（tests/paintings.test.ts 查） */
export const PORTRAIT_CANVAS = [CW, CH] as const;
/** 画框底边（翻倒的转轴）在物件局部坐标里的位置：画架托板上、托板前沿 */
const LEDGE_Y = 0.755, LEDGE_Z = 0.13;
/** 平时向后靠的角度（rotation.x，负 = 顶部往后） */
const LEAN = -0.1;
/** 倒地后转轴的位置 */
const FALLEN_Z = 0.25;
const CANVAS_Z = -0.012;
/** 备用的程序画（paintPortrait）里两只眼睛离中线多远（米） */
const EYE_X = 0.046;

/**
 * 画上的眼睛（贴图 uv：左上角为原点，向右、向下；和 portrait.webp 逐像素对得上）。
 * pupils：平时那张两只眼的瞳孔；sockets：恐怖版两个黑眼窝的中心；open：眼睛（眼睑之间）的半宽、半高。
 * 附身时瞳孔往访客那边挪（眼睑里的那一块贴图整体平移，最多 travel），瞳孔里亮起一点幽绿（换脸以后亮在眼窝里）
 */
const EYES = {
  pupils: [[0.421, 0.263], [0.532, 0.264]] as [number, number][],
  sockets: [[0.411, 0.244], [0.513, 0.251]] as [number, number][],
  open: [0.024, 0.012] as [number, number],
  travel: [0.009, 0.004] as [number, number],
  /** 幽绿的一点：亮芯、外晕的大小（画布高度为 1）和亮度 */
  core: { r: 0.004, gain: 2.6 },
  halo: { r: 0.013, gain: 0.35 },
};
/** 眼睛在画框坐标里的高度（画框底边中点为原点）：访客的方向按这里算 */
const EYE_Y = FH / 2 + (0.5 - EYES.pupils[0][1]) * CH;
/** 眼睛最多转多少（弧度）：左右 yaw，往下 down、往上 up */
const LOOK = { yaw: 0.85, down: 0.55, up: 0.35 };

/** 换完以后脸留多少秒才开始扑倒 */
const FACE_HOLD = 1.5;
const FALL = SCARES.portrait.hitAt + FACE_HOLD;
/**
 * 时间线（秒，从 trigger 算起）。2026-10-30 试玩 S2：原来 0.6 秒就扑倒，脸只看得见半秒，0.9 秒起画面上只剩画架。
 * 现在访客受惊（SCARES.portrait.hitAt，0.94 秒，不变）对着换脸，砸地往后挪：发抖、扑倒、砸地、回弹之间的间隔照旧。
 * 声音（sfx.ts）、灰（particles.ts）都读这一份，砸地的声音和灰跟着真的砸地走
 */
const T = {
  snap: 0.07, // 眼睛甩过去，脸同时开始化开
  trembleFrom: FALL - 0.22,
  fall: FALL, // 开始扑倒
  impact: FALL + 0.34, // 砸地
  bounce1: FALL + 0.5,
  bounce2: FALL + 0.6,
  end: FALL + 0.7,
};

/**
 * 换脸：被附身、眼睛甩过去那一刻（T.snap）起，time 秒里从脸（face，贴图 uv）往外化开到整幅画，访客受惊时正好换完。前沿的形状：
 * 到脸的距离（画布高度为 1，宽按 CW / CH 缩）加噪声（最多 noise，见 portraitReveal），软边 soft；前沿后面 3 × soft 那一圈颜料暗下去 scorch
 * （像从画布背后烧过来），前沿过去就恢复。reach：离脸最远的角有多远。不加亮、不闪
 */
export const PORTRAIT_REVEAL = {
  time: SCARES.portrait.hitAt - T.snap,
  /**
   * 前沿分两段匀速（portraitRot）：前 faceAt 的时间走到 faceRot，刚好盖住整张脸（约 0.7 秒换完脸，一路看得出五官一处处化开，
   * 比访客受惊早一个反应的时间）；剩下的时间漫过脸外面那一大片，那里两张图差别小
   */
  faceAt: 0.72,
  faceRot: 0.27,
  face: [0.49, 0.3] as [number, number],
  noise: 0.08,
  soft: 0.05,
  reach: 0.81,
  scorch: 0.25,
  /**
   * 换过去的那张脸里透出一点冷光（线性，乘恐怖版的颜色）：访客的手电拿得低，光圈的上沿才扫到脸，换脸常常落在暗处看不出来。
   * 只在脸上（离脸 radius[0] 起淡、radius[1] 没），跟着换脸化开的进度亮起来（不跳），砸地以后跟眼睛的幽绿一起退掉；颜色同鬼魂的冷光
   */
  inner: { gain: 0.16, radius: [0.09, 0.2] as [number, number], color: [0.55, 0.68, 0.86] as [number, number, number] },
};
/** 前沿走完整幅画要走多远：最远的角 + 噪声 + 烧暗那一圈（进度 1 时哪儿都换完、也不再暗） */
const REVEAL_SPAN = PORTRAIT_REVEAL.reach + PORTRAIT_REVEAL.noise + PORTRAIT_REVEAL.soft * 3;

/** 换脸的进度（0 = 平常的女士像，1 = 换完）：t 是触发以后的秒数。两段匀速，见 PORTRAIT_REVEAL.faceAt */
export const portraitRot = (t: number) => {
  const { time, faceAt, faceRot } = PORTRAIT_REVEAL;
  const u = seg(t, T.snap, T.snap + time);
  return u < faceAt ? (u / faceAt) * faceRot : lerp(faceRot, 1, (u - faceAt) / (1 - faceAt));
};

/** 贴图 uv（u, v，左上角为原点）这一点在进度 rot 时换过去了多少（0..1）；n 是这一点的噪声（0..1）。着色器里是同一个式子 */
export function portraitReveal(u: number, v: number, rot: number, n: number): number {
  const R = PORTRAIT_REVEAL;
  const d = Math.hypot((u - R.face[0]) * (CW / CH), v - R.face[1]);
  const front = rot * REVEAL_SPAN - d - n * R.noise;
  const k = Math.min(1, Math.max(0, front / R.soft));
  return k * k * (3 - 2 * k);
}

/**
 * 地上的印子。原本想做「墙上一块没褪色的墙纸」，但这幅画是立在画架上的：画面离北墙约 0.45 米，
 * 左边还挡着半扇窗（北墙的窗洞到 x = 3.5 米，画框到 3.38 米），几十年也不会在墙上晒出一块清楚的方印；
 * 北墙在一半的镜头方向下还是降低的矮墙。所以改成地板上的印子：画脸朝下拍在积灰的地板上，
 * 底下的空气把灰挤向四周——画扶回去以后露出一块颜色深一点、干净的长方形，四周一圈被挤出来的浅灰，
 * 几秒里灰慢慢落回去、印子淡掉。四个镜头方向都看得见。
 * 用乘法混合（屏幕上的地板颜色 × 系数）：系数就是反照率的比例，手电、月光照上去照样对，也不用知道地板本来什么色。
 * 系数是线性空间的 rgb
 */
const PRINT = {
  /** 干净处：灰被吹掉，露出更深、更暖的木头本色 */
  clean: [0.55, 0.5, 0.45] as const,
  /** 挤出来的灰：浅、偏冷灰（蓝通道抬得多，木头的暖色被冲淡） */
  dust: [1.8, 1.95, 2.3] as const,
  /** 灰圈：离画框边多远最浓、多宽（米）；往外吹出去的灰条最远多少米 */
  ridgeAt: 0.03,
  ridgeWidth: 0.045,
  spray: 0.2,
  /** 砸地后灰圈多久出全；扶回画架落定以后停多久开始淡、多久淡完（秒） */
  appear: 0.2,
  hold: 3.5,
  fade: 5.0,
};

/** 复原（reset）时落回画架、停稳的时刻（秒，从 reset 算起；sfx.ts 的 PORTRAIT_RESET.settle 也是这个数） */
const RESET_SETTLE = 1.05;

/**
 * 用 Canvas 画一张维多利亚女士像：深色衣裙、高领蕾丝、盘发，脸色发青，表情冷硬；整张画发黄、带龟裂。
 * 2026-10-30 起只是备用：两张生成的油画下载不到时用它（两张都用它，就没有换脸）
 */
function paintPortrait(): HTMLCanvasElement {
  const PX = 420;
  const W = Math.round(CW * PX), H = Math.round(CH * PX);
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d')!;
  const X = (x: number) => (x + CW / 2) * PX;
  const Y = (y: number) => (CH / 2 - y) * PX;
  const S = (m: number) => m * PX;
  const ell = (x: number, y: number, rx: number, ry: number, fill: string | CanvasGradient, rot = 0) => {
    g.beginPath();
    g.ellipse(X(x), Y(y), S(rx), S(ry), rot, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };

  // 背景：暗橄榄色，中间（头后面）略亮
  let gr: CanvasGradient = g.createRadialGradient(X(0), Y(0.1), S(0.05), X(0), Y(0.05), S(0.5));
  gr.addColorStop(0, '#3a3824');
  gr.addColorStop(0.6, '#1c1b12');
  gr.addColorStop(1, '#0a0907');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);

  // 衣裙：肩膀到画底
  g.beginPath();
  g.moveTo(X(-0.33), Y(-0.42));
  g.lineTo(X(-0.3), Y(-0.24));
  g.bezierCurveTo(X(-0.27), Y(-0.15), X(-0.13), Y(-0.13), X(-0.06), Y(-0.08));
  g.lineTo(X(0.06), Y(-0.08));
  g.bezierCurveTo(X(0.13), Y(-0.13), X(0.27), Y(-0.15), X(0.3), Y(-0.24));
  g.lineTo(X(0.33), Y(-0.42));
  g.closePath();
  gr = g.createLinearGradient(X(-0.3), 0, X(0.3), 0);
  gr.addColorStop(0, '#060606');
  gr.addColorStop(0.45, '#1b1a1d');
  gr.addColorStop(1, '#080809');
  g.fillStyle = gr;
  g.fill();
  // 衣裙上几道暗褶
  g.strokeStyle = 'rgba(60,58,70,0.35)';
  g.lineWidth = S(0.004);
  for (const x of [-0.17, -0.09, 0.1, 0.19]) {
    g.beginPath();
    g.moveTo(X(x * 0.7), Y(-0.16));
    g.quadraticCurveTo(X(x * 1.05), Y(-0.3), X(x * 1.2), Y(-0.42));
    g.stroke();
  }

  // 脖子
  gr = g.createLinearGradient(X(-0.04), 0, X(0.04), 0);
  gr.addColorStop(0, '#5e5444');
  gr.addColorStop(0.5, '#8f8268');
  gr.addColorStop(1, '#4e4538');
  g.fillStyle = gr;
  g.fillRect(X(-0.036), Y(-0.02), S(0.072), S(0.08));

  // 高领蕾丝 + 胸针
  g.beginPath();
  g.moveTo(X(-0.05), Y(-0.02));
  g.lineTo(X(0.05), Y(-0.02));
  g.lineTo(X(0.07), Y(-0.12));
  g.quadraticCurveTo(X(0), Y(-0.15), X(-0.07), Y(-0.12));
  g.closePath();
  g.fillStyle = '#a69a80';
  g.fill();
  g.strokeStyle = 'rgba(40,34,26,0.5)';
  g.lineWidth = S(0.002);
  for (let i = 0; i < 6; i++) {
    g.beginPath();
    g.moveTo(X(-0.06 + i * 0.024), Y(-0.03));
    g.lineTo(X(-0.064 + i * 0.026), Y(-0.12));
    g.stroke();
  }
  ell(0, -0.125, 0.022, 0.028, '#6b5530');
  ell(0, -0.125, 0.015, 0.02, '#b0a58c');

  // 头发（盘起来，后面的一大团 + 头顶发髻）
  ell(0, 0.105, 0.128, 0.155, '#170f0a');
  ell(0, 0.245, 0.06, 0.045, '#1d140d');

  // 脸：苍白发青，颧骨下有阴影
  gr = g.createRadialGradient(X(-0.015), Y(0.1), S(0.01), X(0), Y(0.07), S(0.13));
  gr.addColorStop(0, '#b4a88c');
  gr.addColorStop(0.55, '#958a70');
  gr.addColorStop(1, '#4f4838');
  ell(0, 0.07, 0.09, 0.122, gr);
  // 颧骨下的凹陷
  ell(-0.055, 0.03, 0.03, 0.045, 'rgba(45,38,30,0.35)', 0.3);
  ell(0.055, 0.03, 0.03, 0.045, 'rgba(45,38,30,0.35)', -0.3);
  // 额头上中分的头发
  g.fillStyle = '#170f0a';
  g.beginPath();
  g.moveTo(X(-0.1), Y(0.12));
  g.quadraticCurveTo(X(-0.07), Y(0.2), X(0), Y(0.19));
  g.quadraticCurveTo(X(-0.04), Y(0.16), X(-0.09), Y(0.06));
  g.fill();
  g.beginPath();
  g.moveTo(X(0.1), Y(0.12));
  g.quadraticCurveTo(X(0.07), Y(0.2), X(0), Y(0.19));
  g.quadraticCurveTo(X(0.04), Y(0.16), X(0.09), Y(0.06));
  g.fill();

  // 眼窝（深）+ 眼白（3D 眼球盖在上面，这里只是兜底）
  for (const s of [-1, 1]) {
    ell(s * EYE_X, 0.1 + 0.002, 0.03, 0.02, 'rgba(30,20,16,0.7)');
    ell(s * EYE_X, 0.1, 0.017, 0.011, '#8a8270');
    // 眉毛：往中间压下去，显得凶
    g.strokeStyle = '#1a120c';
    g.lineWidth = S(0.006);
    g.beginPath();
    g.moveTo(X(s * 0.07), Y(0.13));
    g.lineTo(X(s * 0.018), Y(0.12));
    g.stroke();
  }
  // 鼻子：一道侧影 + 鼻孔
  g.strokeStyle = 'rgba(50,40,30,0.6)';
  g.lineWidth = S(0.004);
  g.beginPath();
  g.moveTo(X(0.008), Y(0.09));
  g.quadraticCurveTo(X(0.016), Y(0.045), X(0.004), Y(0.035));
  g.stroke();
  ell(-0.008, 0.034, 0.006, 0.003, 'rgba(30,22,18,0.7)');
  ell(0.01, 0.034, 0.006, 0.003, 'rgba(30,22,18,0.7)');
  // 嘴：薄、嘴角往下
  g.strokeStyle = '#3a2420';
  g.lineWidth = S(0.005);
  g.beginPath();
  g.moveTo(X(-0.03), Y(-0.008));
  g.quadraticCurveTo(X(0), Y(0.002), X(0.03), Y(-0.008));
  g.stroke();

  // 发黄的旧清漆 + 龟裂
  g.fillStyle = 'rgba(90,70,20,0.16)';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(10,8,4,0.28)';
  g.lineWidth = 1;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    let x = rnd() * W, y = rnd() * H;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (rnd() - 0.5) * 30;
      y += (rnd() - 0.5) * 30;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // 暗角
  gr = g.createRadialGradient(W / 2, H * 0.42, W * 0.25, W / 2, H / 2, W * 0.75);
  gr.addColorStop(0, 'rgba(0,0,0,0)');
  gr.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  return cv;
}

export function createPortrait(): PropRig {
  const model = new THREE.Group();
  model.name = 'portrait';
  const body = bodyMaterial(0.8);

  // 画架：两条前腿（下宽上窄）、一条后腿、托板、横撑
  const easel = new THREE.Group();
  const ep = new Parts();
  for (const s of [-1, 1]) ep.rod([s * 0.32, 0, 0.14], [s * 0.06, 1.78, -0.06], 0.02, C.wood);
  ep.rod([0, 0, -0.5], [0, 1.62, -0.07], 0.018, C.wood);
  ep.rod([-0.27, 0.32, 0.105], [0.27, 0.32, 0.105], 0.012, C.woodDark);
  ep.rod([0, 0.32, 0.1], [0, 0.32, -0.33], 0.01, C.woodDark);
  ep.box(0.82, 0.035, 0.1, C.woodDark, [0, LEDGE_Y - 0.0175, 0.1]);
  ep.box(0.82, 0.045, 0.016, C.woodDark, [0, LEDGE_Y + 0.008, 0.158]);
  ep.box(0.06, 0.05, 0.05, C.woodDark, [0, 1.72, -0.035]); // 顶上的夹子
  const easelGeo = ep.build();
  const easelMesh = mesh(easelGeo, body, 'easel');
  easel.add(easelMesh);
  model.add(easel);

  // 画：转轴在画框底边前沿；画框 + 背板合并，画布单独一个网格（要贴图）
  const pivot = new THREE.Group();
  pivot.position.set(0, LEDGE_Y, LEDGE_Z);
  pivot.rotation.x = LEAN;
  const fp = new Parts();
  const cy = FH / 2;
  const bar = (FW - CW) / 2;
  fp.box(FW, bar, FD, C.brass, [0, FH - bar / 2, -FD / 2]);
  fp.box(FW, bar, FD, C.brass, [0, bar / 2, -FD / 2]);
  fp.box(bar, CH, FD, C.brass, [-(FW - bar) / 2, cy, -FD / 2]);
  fp.box(bar, CH, FD, C.brass, [(FW - bar) / 2, cy, -FD / 2]);
  // 内圈一道暗色线脚，让画框有层次
  fp.box(CW + 0.02, 0.012, 0.012, C.trim, [0, cy + CH / 2 + 0.002, -0.004]);
  fp.box(CW + 0.02, 0.012, 0.012, C.trim, [0, cy - CH / 2 - 0.002, -0.004]);
  fp.box(0.012, CH, 0.012, C.trim, [-CW / 2 - 0.002, cy, -0.004]);
  fp.box(0.012, CH, 0.012, C.trim, [CW / 2 + 0.002, cy, -0.004]);
  fp.box(CW, CH, 0.012, C.woodDark, [0, cy, -FD + 0.006]); // 背板
  const frameGeo = fp.build();
  const frame = mesh(frameGeo, bodyMaterial(0.55, 0.35), 'portrait-frame');
  pivot.add(frame);

  // 画布：两张油画（平常的、恐怖版，逐像素对齐），按换脸的进度 rot 混；下载不到时两张都用程序画的那张。
  // 贴图不翻转（paintings.ts），贴图 uv 左上角为原点：t = (u, 1 − v)
  const texNormal = paintingTexture('portrait', paintPortrait);
  const texHorror = paintingTexture('portraitPossessed', paintPortrait);
  const rot = uniform(0);
  const eyeGlow = uniform(0);
  /** 瞳孔往访客那边挪多少（贴图 uv，最多 EYES.travel） */
  const eyeLook = uniform(new THREE.Vector2());
  // 上过光油：一层柔和的光泽。画布往后仰，手电从下面照上来正好反到镜头里，0.62 时下半幅一片白（看样发现），所以比墙上的画更哑一点
  const canvasMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.78, metalness: 0 });
  {
    const R = PORTRAIT_REVEAL;
    const t = vec2(uv().x, float(1).sub(uv().y));
    /** 画布高度为 1 的坐标（宽按 CW / CH 缩）：距离、噪声都按它算，横竖一样圆 */
    const q = vec2(t.x.mul(CW / CH), t.y);
    const at = (p: [number, number]) => vec2(p[0] * (CW / CH), p[1]);
    // 眼睑里的那一块往访客那边平移：瞳孔转过去（只平移平常那张：恐怖版是空眼窝）
    const lid = (c: [number, number]) => float(1).sub(smoothstep(0.55, 1, length(t.sub(vec2(...c)).div(vec2(...EYES.open)))));
    const tEyes = t.sub(eyeLook.mul(lid(EYES.pupils[0]).add(lid(EYES.pupils[1]))));
    const normal = texture(texNormal, tEyes).rgb;
    const horror = texture(texHorror, t).rgb;
    // 化开的前沿：到脸的距离 + 两层噪声（0..1），式子同 portraitReveal
    const n01 = clamp(mx_noise_float(vec3(q.mul(6), 1.7)).mul(0.6).add(mx_noise_float(vec3(q.mul(17), 4.3)).mul(0.3)).mul(0.5).add(0.5), 0, 1);
    const dFace = length(q.sub(at(R.face)));
    const front = rot.mul(REVEAL_SPAN).sub(dFace).sub(n01.mul(R.noise));
    const m = smoothstep(0, R.soft, front);
    const scorch = m.mul(float(1).sub(smoothstep(R.soft, R.soft * 3, front))).mul(R.scorch);
    canvasMat.colorNode = mix(normal, horror, m).mul(float(1).sub(scorch));
    // 瞳孔里那一点幽绿：亮芯 + 外晕，跟着瞳孔挪；换脸时移到眼窝中心
    const toSocket = smoothstep(0.1, 0.3, rot);
    const pin = (i: number) => {
      const p = mix(at(EYES.pupils[i]), at(EYES.sockets[i]), toSocket).add(vec2(eyeLook.x.mul(CW / CH), eyeLook.y));
      const e = q.sub(p);
      const r2 = dot(e, e);
      return exp(r2.div(-EYES.core.r * EYES.core.r)).mul(EYES.core.gain).add(exp(r2.div(-EYES.halo.r * EYES.halo.r)).mul(EYES.halo.gain));
    };
    const inner = horror.mul(vec3(...R.inner.color)).mul(m.mul(float(1).sub(smoothstep(R.inner.radius[0], R.inner.radius[1], dFace))).mul(eyeGlow).mul(R.inner.gain));
    canvasMat.emissiveNode = color(PALETTE.possess).mul(eyeGlow).mul(pin(0).add(pin(1))).add(inner);
  }
  const canvasMesh = mesh(new THREE.PlaneGeometry(CW, CH), canvasMat, 'portrait-canvas');
  canvasMesh.castShadow = false; // 画框和背板已经投影了
  canvasMesh.position.set(0, cy, CANVAS_Z);
  canvasMesh.userData.rot = rot; // 测试读换脸的进度
  pivot.add(canvasMesh);
  model.add(pivot);

  // 地上的印子：一块平铺在地板上的面片，盖住画倒地时的位置再往外一圈（画倒地后转轴在 FALLEN_Z，画沿 +z 躺平）
  const printAmt = uniform(0);
  const printMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, fog: false });
  printMat.blending = THREE.CustomBlending;
  printMat.blendEquation = THREE.AddEquation;
  printMat.blendSrc = THREE.DstColorFactor; // 结果 = 系数 × 地板
  printMat.blendDst = THREE.ZeroFactor;
  printMat.blendSrcAlpha = THREE.ZeroFactor;
  printMat.blendDstAlpha = THREE.OneFactor;
  {
    const half = vec2(FW / 2, FH / 2);
    const p = vec2(positionLocal.x, positionLocal.z.sub(FALLEN_Z + FH / 2));
    // 到画框边的有向距离（里面为负）
    const q = abs(p).sub(half);
    const d = length(max(q, 0)).add(min(max(q.x, q.y), 0));
    const n1 = mx_noise_float(vec3(p.x.mul(9), p.y.mul(9), 2.3));
    const n2 = mx_noise_float(vec3(p.x.mul(31), p.y.mul(31), 5.9));
    const n3 = mx_noise_float(vec3(p.x.mul(3.5), p.y.mul(3.5), 8.1));
    // 干净的一块：边缘略毛，里面有几处没吹干净
    const clean = float(1).sub(smoothstep(-0.02, 0.01, d.add(n2.mul(0.008)))).mul(n1.mul(0.18).add(0.86));
    // 灰圈 + 长短不一往外吹的灰条
    const r = d.sub(PRINT.ridgeAt).div(PRINT.ridgeWidth);
    const ridge = exp(r.mul(r).negate()).mul(n2.mul(0.25).add(n1.mul(0.2)).add(0.75));
    const spray = float(1).sub(smoothstep(0, float(PRINT.spray).mul(n3.mul(0.4).add(0.6)), d)).mul(smoothstep(0, 0.02, d)).mul(n2.mul(0.3).add(0.4));
    const dust = min(max(ridge, spray), 1);
    const one = vec3(1, 1, 1);
    printMat.colorNode = mix(one, vec3(...PRINT.clean), clean.mul(printAmt))
      .mul(mix(one, vec3(...PRINT.dust), dust.mul(printAmt)));
  }
  const pad = PRINT.ridgeAt + PRINT.ridgeWidth * 2 + PRINT.spray;
  const printGeo = new THREE.PlaneGeometry(FW + pad * 2, FH + pad * 2).rotateX(-Math.PI / 2).translate(0, 0.003, FALLEN_Z + FH / 2);
  const printMesh = new THREE.Mesh(printGeo, printMat);
  printMesh.name = 'portrait-floor-print';
  printMesh.castShadow = false;
  printMesh.receiveShadow = false;
  // 在月光光斑（1）之后、雾（1.5）之前：月光照在干净的木头上也跟着变深，雾盖在印子上面
  printMesh.renderOrder = 1.2;
  // 系数全是 1 时看不出来；每帧按 print 决定显不显示（见 update 末尾）。
  // 不进开场那次阻塞的预编译（deferCompile）：main.ts 在开场按钮可用之后再异步编它
  printMesh.userData.deferCompile = true;
  model.add(printMesh);

  // 动画状态
  let t = -1; // 距 trigger 的秒数；-1 = 没在表演
  let r = -1; // 距 reset 的秒数
  let fallen = false;
  let jolt = 0; // 画架被带得晃一下
  let print = 0; // 地上印子的浓淡 0..1
  let printFrom = 0; // 开始淡出时的浓淡
  let sinceReset = -1; // 扶回画架以后过了多久（印子按它淡掉）；-1 = 不在淡
  const look = { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };
  const eyeWorld = new THREE.Vector3(0, LEDGE_Y + EYE_Y, LEDGE_Z);

  const restPose = () => {
    pivot.position.set(0, LEDGE_Y, LEDGE_Z);
    pivot.rotation.set(LEAN, 0, 0);
  };
  const fallenPose = (lift = 0) => {
    pivot.position.set(0, 0, FALLEN_Z);
    pivot.rotation.set(Math.PI / 2 - lift, 0, 0);
  };

  /**
   * 眼睛盯谁：优先看「此刻看得见这幅画」的访客（seenBy，就是正被吓的那个），没有就看最近的访客；
   * 换算成物件局部坐标里的方向 → 眼睛的目标角度。屋里没人时左右乱瞟
   */
  const aimEyes = (f: PropFrame) => {
    const { obj, state } = f;
    let best: { x: number; z: number } | null = null;
    let bd = Infinity;
    for (const n of state.npcs) {
      if (n.mode === 'gone') continue;
      const d = Math.hypot(n.pos.x - obj.pos.x, n.pos.z - obj.pos.z) - (obj.seenBy.includes(n.id) ? 1000 : 0);
      if (d < bd) { bd = d; best = n.pos; }
    }
    if (!best) {
      look.tYaw = Math.sin(f.time * 9) > 0 ? 0.6 : -0.6;
      look.tPitch = -0.1;
      return;
    }
    // 房屋坐标 → 局部坐标：减去中心，再绕 y 转 -yaw（model 的父节点 root 带着 yaw）
    const yaw = model.parent ? model.parent.rotation.y : 0;
    const dx = best.x - obj.pos.x, dz = best.z - obj.pos.z;
    const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
    const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
    const ex = lx - eyeWorld.x, ez = lz - eyeWorld.z, ey = 1.0 - eyeWorld.y; // 看访客的脸（约 1 米高）
    look.tYaw = THREE.MathUtils.clamp(Math.atan2(ex, Math.max(ez, 0.05)), -LOOK.yaw, LOOK.yaw);
    look.tPitch = THREE.MathUtils.clamp(Math.atan2(ey, Math.hypot(ex, ez)), -LOOK.down, LOOK.up);
  };
  /** 复原开始（画还脸朝下）：换回平常的女士像，扶起来的时候已经是她 */
  const beginReset = () => {
    r = 0;
    sinceReset = 0;
    printFrom = print;
    rot.value = 0;
  };

  return {
    model,
    // 拾取盒：画架 + 画（立着），往前多包一点，画倒地后点地上的画也算
    hit: { size: [0.9, 1.85, 1.0], center: [0, 0.925, 0.1] },
    shells: [
      { parent: easelMesh, geometry: easelGeo },
      { parent: frame, geometry: new THREE.BoxGeometry(FW, FH, FD).translate(0, FH / 2, -FD / 2) },
    ],
    trigger() {
      if (fallen) return; // 倒着的时候不会被再附身（冷却 16 秒 > 倒地 10 秒），以防万一
      t = 0;
      r = -1;
      sinceReset = -1; // 上一次的印子还没淡完：停在这里，等这次砸下来再盖上
    },
    reset() {
      if (!fallen) return;
      beginReset();
    },
    update(f) {
      const { dt, obj } = f;
      // 兜底：错过了事件时按 state 对齐（例如中途创建视图）
      if (t < 0 && r < 0) {
        if (!fallen && obj.broken > 0 && obj.active <= 0) { fallen = true; fallenPose(); print = 1; rot.value = 1; }
        else if (fallen && obj.broken <= 0) beginReset();
      }

      if (t >= 0) {
        t += dt;
        // 眼睛甩过去那一刻起换脸（扑倒、趴着时一直是恐怖版，复原时才换回来）
        rot.value = portraitRot(t);
        // 一直盯着人，到扑倒为止
        if (t < T.fall + 0.1) aimEyes(f);
        const snap = t < T.snap ? outCubic(seg(t, 0, T.snap)) : 1;
        look.yaw = lerp(look.yaw, look.tYaw, t < T.snap ? snap : 1 - Math.exp(-dt * 22));
        look.pitch = lerp(look.pitch, look.tPitch, t < T.snap ? snap : 1 - Math.exp(-dt * 22));
        eyeGlow.value = t < T.impact ? outCubic(seg(t, 0, 0.06)) : 1 - seg(t, T.impact, T.impact + 0.5);

        if (t < T.fall) {
          restPose();
          // 扑倒前 0.22 秒画框开始发抖，越抖越凶
          const k = inQuad(seg(t, T.trembleFrom, T.fall));
          pivot.rotation.z = wobble(t * 2.2, 1) * 0.03 * k;
          pivot.rotation.x = LEAN + wobble(t * 2.6, 3) * 0.02 * k;
        } else if (t < T.impact) {
          // 扑倒：一开始就有一股推力（线性项），然后越倒越快（二次项）；底边先在托板上转，再滑出去掉下来
          const u = seg(t, T.fall, T.impact);
          const ang = lerp(LEAN, Math.PI / 2, 0.18 * u + 0.82 * inQuad(u));
          pivot.rotation.set(ang, 0, 0);
          pivot.position.set(0, LEDGE_Y * (1 - inQuad(seg(t, T.fall + 0.06, T.impact))), lerp(LEDGE_Z, FALLEN_Z, outQuad(seg(t, T.fall + 0.02, T.impact))));
          jolt = bump(seg(t, T.fall, T.fall + 0.3));
        } else {
          // 砸地：灰被挤向四周
          print = Math.max(print, outQuad(seg(t, T.impact, T.impact + PRINT.appear)));
          // 砸地后回弹两下：画的上沿被弹起来又摔下去
          const lift = 0.11 * bump(seg(t, T.impact, T.bounce1)) + 0.03 * bump(seg(t, T.bounce1, T.bounce2));
          fallenPose(lift);
          pivot.position.x = wobble(t, 5) * 0.006 * (1 - seg(t, T.impact, T.bounce1));
          jolt = 0;
          if (t >= T.end) { t = -1; fallen = true; fallenPose(); }
        }
        easel.rotation.x = -0.05 * jolt;
      } else {
        // 平时：眼睛慢慢回正
        look.yaw = lerp(look.yaw, 0, 1 - Math.exp(-dt * 2));
        look.pitch = lerp(look.pitch, 0, 1 - Math.exp(-dt * 2));
        eyeGlow.value = Math.max(0, eyeGlow.value - dt * 2);
      }

      if (r >= 0) {
        // 复原：先抽动一下，停住，再飘回画架，最后轻轻落定
        r += dt;
        if (r < 0.12) fallenPose(0.09 * bump(seg(r, 0, 0.12)));
        else if (r < 0.32) fallenPose();
        else if (r < 0.92) {
          const u = inOutCubic(seg(r, 0.32, 0.92));
          pivot.rotation.set(lerp(Math.PI / 2, LEAN - 0.03, u), 0, 0);
          pivot.position.set(0, lerp(0, LEDGE_Y, u) + 0.06 * bump(u), lerp(FALLEN_Z, LEDGE_Z, u));
        } else {
          restPose();
          pivot.rotation.x = LEAN - 0.03 * (1 - outCubic(seg(r, 0.92, RESET_SETTLE)));
          if (r >= RESET_SETTLE) { r = -1; fallen = false; restPose(); }
        }
      }

      // 印子：扶回画架落定（RESET_SETTLE）以后停 PRINT.hold 秒，再用 PRINT.fade 秒淡掉
      if (sinceReset >= 0) {
        sinceReset += dt;
        const from = RESET_SETTLE + PRINT.hold;
        print = printFrom * (1 - inOutSine(seg(sinceReset, from, from + PRINT.fade)));
        if (sinceReset >= from + PRINT.fade) { sinceReset = -1; print = 0; }
      }
      printAmt.value = print;
      printMesh.visible = print > 0.002;

      // 瞳孔挪到哪：左右按转角、上下按俯仰（往下看 = 贴图 uv 往下），各自到头时挪满 EYES.travel
      eyeLook.value.set((look.yaw / LOOK.yaw) * EYES.travel[0], (-look.pitch / LOOK.down) * EYES.travel[1]);
    },
    dispose() {
      // 几何体和材质由 props.ts 统一释放；贴图是 paintings.ts 全页共用的那两张（再建一次物件时会重新上传）
      texNormal.dispose();
      texHorror.dispose();
    },
  };
}

/** 时间线（声音对齐用） */
export const PORTRAIT_TIMELINE = T;
