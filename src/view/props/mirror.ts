// 落地穿衣镜：两根立柱夹着一面可以俯仰的椭圆镜，镜面是深色高光泽的材质（不做真实反射）。
// 被附身：镜子里「啪」地闪出一张苍白的脸（CanvasTexture，自发光），断断续续闪两下，
// 然后黑掉、停顿（0.3–0.6 秒）——0.6 秒时整张脸猛地扑到镜面上、最亮，镜子一震；1 秒内闪烁着消失。
// 镜子前面放一盏平时强度为 0 的冷光点光源，跟着脸一起亮：镜子背对镜头时也能看到浴室里闪了一下。
import * as THREE from 'three/webgpu';
import { abs, color, float, positionLocal, smoothstep, texture, uniform, vec3 } from 'three/tsl';
import { PALETTE } from '../palette';
import { C, Parts, bodyMaterial, lerp, mesh, outExpo, seg, wobble, type PropFrame, type PropRig } from './kit';

// 椭圆镜（米）：外框半轴、镜面半轴、中心高度、往后仰的角度
const OA = 0.28, OB = 0.58;
const GA = 0.24, GB = 0.53;
const MID_Y = 0.98;
const TILT = -0.07;
const POST_X = 0.34, POST_H = 1.62;

/**
 * 脸的闪现表：[开始时间（秒）, 亮度]，每段持续到下一段开始。
 * 0 秒立刻出现（不渐入）；0.31–0.6 秒完全黑掉，留出停顿；0.6 秒是重击（声音的冲击点对这里）。
 */
export const MIRROR_FLASH: [number, number][] = [
  [0.0, 0.85], [0.09, 0.0], [0.14, 0.6], [0.21, 0.0], [0.26, 0.4], [0.31, 0.0],
  [0.6, 1.3], [0.84, 0.0], [0.88, 0.75], [0.93, 0.0], [0.96, 0.35], [1.0, 0.0],
];
const HIT = 0.6;
const END = 1.0;

const sample = (tab: [number, number][], t: number) => {
  let v = tab[0][1];
  for (const [at, x] of tab) if (t >= at) v = x;
  return v;
};

/** 用 Canvas 画镜子里的脸：长脸、深陷的黑眼窝、张大的嘴，边缘渐隐到透明（像从镜子深处浮出来） */
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

  // 镜面：近黑、很光滑；加一道很淡的斜向高光和上亮下暗的月光色，让它读得出是玻璃
  const glassMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.06, metalness: 0.5 });
  glassMat.colorNode = color(0x0c1216);
  const streak = smoothstep(float(0.035), float(0), abs(positionLocal.x.add(positionLocal.y.mul(0.55)).sub(0.06)));
  const grad = positionLocal.y.div(GB).mul(0.5).add(0.5);
  glassMat.emissiveNode = color(PALETTE.moon).mul(grad.mul(0.07).add(streak.mul(0.14)));
  const glass = mesh(new THREE.ShapeGeometry(ellipseShape(GA, GB), 24), glassMat, 'mirror-glass');
  glass.position.z = 0.004;
  glass.castShadow = false;
  swing.add(glass);

  // 脸：一块贴着镜面的面片，平时完全透明
  const faceTex = new THREE.CanvasTexture(paintFace());
  faceTex.colorSpace = THREE.SRGBColorSpace;
  const faceAmt = uniform(0);
  const faceMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  const ft = texture(faceTex);
  // 苍白里带一点幽绿；> 1 的部分交给泛光
  faceMat.colorNode = ft.rgb.mul(vec3(0.95, 1.05, 1.0)).mul(faceAmt.mul(1.5));
  faceMat.opacityNode = ft.a.mul(faceAmt.min(1));
  const face = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.48), faceMat);
  face.name = 'mirror-face';
  face.position.set(0, 0.13, 0.008);
  face.renderOrder = 3;
  face.visible = false;
  swing.add(face);
  model.add(swing);

  // 跟着脸亮的冷光（平时 0）
  const flash = new THREE.PointLight(PALETTE.possess, 0, 4.5, 2);
  flash.position.set(0, 1.15, 0.55);
  flash.castShadow = false;
  model.add(flash);

  let t = -1;

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
      if (t < 0) return;
      t += f.dt;
      const a = t < END ? sample(MIRROR_FLASH, t) : 0;
      faceAmt.value = a;
      face.visible = a > 0;
      // 脸的大小：先在镜子深处（小），0.6 秒猛地扑上来（放大），之后慢慢退一点
      const lunge = t < HIT ? lerp(0.9, 0.98, t / HIT) : lerp(1.24, 1.12, outExpo(seg(t, HIT, END)));
      face.scale.setScalar(lunge);
      face.position.x = a > 0.9 ? wobble(t * 4, 2) * 0.006 : 0;
      flash.intensity = a * 2.6;
      // 镜子一震：出现那一下轻，0.6 秒那一下重
      const k = 0.4 * (1 - seg(t, 0, 0.15)) + (t >= HIT ? 1 - seg(t, HIT, HIT + 0.28) : 0);
      swing.rotation.set(TILT + wobble(t * 3.3, 1) * 0.04 * k, 0, wobble(t * 3.1, 4) * 0.025 * k);
      stand.position.x = wobble(t * 3.7, 7) * 0.006 * k;
      if (t >= END + 0.3) {
        t = -1;
        faceAmt.value = 0;
        face.visible = false;
        flash.intensity = 0;
        swing.rotation.set(TILT, 0, 0);
        stand.position.x = 0;
      }
    },
    dispose() {
      faceTex.dispose();
      flash.dispose();
    },
  };
}
