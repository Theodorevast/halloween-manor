// 肖像：画架上一幅维多利亚风格的女士像。被附身时眼睛（单独的小球）猛地转向最近的访客、瞳孔泛起幽绿，
// 盯 0.6 秒、画框发抖，然后整幅画向前扑倒、脸朝下砸在地上，回弹一下。broken 期间一直趴着，reset 时飘回画架。
// 画砸下去时把地上积的灰吹开：画扶回画架以后，地板上留下一块比周围干净的长方形印子，几秒里慢慢淡掉（见 PRINT）。
import * as THREE from 'three/webgpu';
import { abs, color, exp, float, length, max, min, mix, mx_noise_float, positionLocal, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { C, Parts, bodyMaterial, bump, inOutCubic, inOutSine, inQuad, lerp, mesh, outCubic, outQuad, seg, wobble, type PropFrame, type PropRig } from './kit';
import { PALETTE } from '../palette';

// 画布尺寸（米）和画框
const CW = 0.62, CH = 0.82;
const FW = 0.74, FH = 0.94, FD = 0.05;
/** 画框底边（翻倒的转轴）在物件局部坐标里的位置：画架托板上、托板前沿 */
const LEDGE_Y = 0.755, LEDGE_Z = 0.13;
/** 平时向后靠的角度（rotation.x，负 = 顶部往后） */
const LEAN = -0.1;
/** 倒地后转轴的位置 */
const FALLEN_Z = 0.25;
/** 眼睛在画框坐标里的位置（画框底边中点为原点）、眼球半径 */
const EYE_Y = FH / 2 + 0.1;
const EYE_X = 0.046;
const EYE_R = 0.017;
const CANVAS_Z = -0.012;

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

// 时间线（秒，从 trigger 算起）
const T = {
  snap: 0.07, // 眼睛甩过去
  trembleFrom: 0.38,
  fall: 0.6, // 开始扑倒
  impact: 0.94, // 砸地
  bounce1: 1.1,
  bounce2: 1.2,
  end: 1.3,
};

/** 用 Canvas 画一张维多利亚女士像：深色衣裙、高领蕾丝、盘发，脸色发青，表情冷硬；整张画发黄、带龟裂 */
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

  const tex = new THREE.CanvasTexture(paintPortrait());
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const canvasMat = new THREE.MeshStandardNodeMaterial({ map: tex, roughness: 0.62, metalness: 0 });
  const canvasMesh = mesh(new THREE.PlaneGeometry(CW, CH), canvasMat, 'portrait-canvas');
  canvasMesh.castShadow = false; // 画框和背板已经投影了
  canvasMesh.position.set(0, cy, CANVAS_Z);
  pivot.add(canvasMesh);

  // 眼睛：一个球，正前方一圈是瞳孔（用局部 z 坐标在着色器里分出来），附身时瞳孔发幽绿的光
  const eyeGlow = uniform(0);
  const eyeMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  const pupil = smoothstep(float(EYE_R * 0.74), float(EYE_R * 0.8), positionLocal.z);
  eyeMat.colorNode = mix(color(0x9c937c), color(0x0a0706), pupil);
  eyeMat.emissiveNode = color(PALETTE.possess).mul(pupil).mul(eyeGlow).mul(2.2);
  const eyeGeo = new THREE.SphereGeometry(EYE_R, 14, 10);
  const eyes = [-1, 1].map((s) => {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.name = 'portrait-eye';
    e.rotation.order = 'YXZ';
    e.position.set(s * EYE_X, EYE_Y, CANVAS_Z);
    pivot.add(e);
    return e;
  });
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
    look.tYaw = THREE.MathUtils.clamp(Math.atan2(ex, Math.max(ez, 0.05)), -0.85, 0.85);
    look.tPitch = THREE.MathUtils.clamp(Math.atan2(ey, Math.hypot(ex, ez)), -0.55, 0.35);
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
      r = 0;
      sinceReset = 0;
      printFrom = print;
    },
    update(f) {
      const { dt, obj } = f;
      // 兜底：错过了事件时按 state 对齐（例如中途创建视图）
      if (t < 0 && r < 0) {
        if (!fallen && obj.broken > 0 && obj.active <= 0) { fallen = true; fallenPose(); print = 1; }
        else if (fallen && obj.broken <= 0) { r = 0; sinceReset = 0; printFrom = print; }
      }

      if (t >= 0) {
        t += dt;
        // 0–0.6：盯着人
        if (t < T.fall + 0.1) aimEyes(f);
        const snap = t < T.snap ? outCubic(seg(t, 0, T.snap)) : 1;
        look.yaw = lerp(look.yaw, look.tYaw, t < T.snap ? snap : 1 - Math.exp(-dt * 22));
        look.pitch = lerp(look.pitch, look.tPitch, t < T.snap ? snap : 1 - Math.exp(-dt * 22));
        eyeGlow.value = t < T.impact ? outCubic(seg(t, 0, 0.06)) : 1 - seg(t, T.impact, T.impact + 0.5);

        if (t < T.fall) {
          restPose();
          // 0.38 起画框开始发抖，越抖越凶
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

      for (const e of eyes) e.rotation.set(-look.pitch, look.yaw, 0);
    },
    dispose() {
      tex.dispose(); // 几何体和材质由 props.ts 统一释放
    },
  };
}

/** 时间线（声音对齐用） */
export const PORTRAIT_TIMELINE = T;
