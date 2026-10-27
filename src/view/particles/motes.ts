// 浮尘：整栋房子里悬着一两千颗极小的灰尘，平时看不见；只有落在手电光锥里、又没被墙挡住的那些亮起来，
// 像真实的手电光束里飘着的灰。
//
// 做法：一个实例化精灵，每颗的位置全由实例编号的哈希 + 时间算出（两层慢正弦漂移 + 很慢的整体气流），
// 不存缓冲、不用计算着色器，WebGL2 回退也一样。亮度 = 这一点受到的手电光（light.ts：真实光锥、距离衰减、
// 射线挡墙）× 前向散射。光弱到看不见的颗粒在顶点里把面片缩成 0，不产生片元：开销只在顶点（几千个，可以忽略）。
// 尺寸按屏幕像素定（灰尘本身远小于一个像素，看到的大小是光学模糊），所以镜头缩放时不变；面片保底 minDevicePx 个设备像素，
// 太小的按面积把亮度降回去，免得光栅化采不准、一动就闪。
import * as THREE from 'three/webgpu';
import { exp, float, max, min, mod, pow, sin, smoothstep, uniform, uv, varying, vec2, vec3 } from 'three/tsl';
import { HOUSE_D, HOUSE_W } from '../../config/house';
import { lightAt, type LightUniforms } from './light';
import { ge, makeSprite, protectMRT, rnd, type ScreenUniforms } from './common';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export const MOTES = {
  /** 颗数（low 档不画） */
  count: 4000,
  /** 分布的空间（房屋米坐标）：整栋房子 + 前门外一点，离地 y[0]–y[1] 米 */
  box: { x: [0, HOUSE_W] as const, z: [0, HOUSE_D + 1.5] as const, y: [0.12, 1.32] as const },
  /** 贴地那一段埋在雾里：离地 floorFade[0] 到 [1] 米之间慢慢亮起来；顶上 topFade 之间淡掉 */
  floorFade: [0.14, 0.45] as const,
  topFade: [1.1, 1.32] as const,
  /** 漂移：两层正弦，每个轴的频率在 freq 赫兹之间随机，幅度 amp 米（y 方向再乘 ampY） */
  wobble: [
    { amp: 0.13, freq: [0.02, 0.06] as const },
    { amp: 0.035, freq: [0.07, 0.18] as const },
  ],
  ampY: 0.55,
  /** 整体很慢的气流（米/秒，x / z），走出空间的从另一边绕回来 */
  wind: [0.007, 0.003] as const,
  /** 亮点直径（CSS 像素）：随机数的 sizeCurve 次方，大多 1 像素左右，少数接近 3 像素 */
  px: [1, 3] as const,
  sizeCurve: 3,
  /** 面片至少这么多个设备像素宽（高斯淡出，实际亮的部分约一半） */
  minDevicePx: 2.5,
  /** 面片宽 = 亮点直径 × quad（边缘留给高斯淡出） */
  quad: 2.2,
  /** 亮度：受到的光 × gain（线性，色调映射之前）。整体再随机乘 0.35–1（有的灰大、有的灰小） */
  gain: 0.03,
  /** 最亮不超过（线性）：单颗不会亮过泛光阈值太多，避免闪成星星 */
  maxLum: 1.1,
  /** 前向散射的 g：顺着光束朝镜头照时灰更显眼 */
  phaseG: 0.3,
  /** 薄片翻转时偶尔闪一下：amount 是闪烁所占的比例，freq 赫兹 */
  twinkle: { amount: 0.35, freq: [0.08, 0.3] as const },
  /** 受到的光（最亮的分量）小于它就不画 */
  cutoff: 0.4,
  /** prefers-reduced-motion：漂移和闪烁的速度乘这个 */
  reducedMotion: 0.4,
};

export interface Motes {
  object: THREE.Sprite;
  /** 漂移用的时间（秒，已乘 reduced-motion 倍率） */
  time: THREE.UniformNode<'float', number>;
  dispose(): void;
}

export function createMotes(light: LightUniforms, screen: ScreenUniforms): Motes {
  const time = uniform(0);
  const r = (k: number) => rnd(k);
  const lerp = (a: number, b: number, t: F) => float(a).add(t.mul(b - a));
  const { box } = MOTES;
  const W = box.x[1] - box.x[0], D = box.z[1] - box.z[0];

  // —— 位置：哈希出起点 + 两层慢正弦 + 整体气流，x / z 绕回空间里 ——
  const base = vec3(lerp(box.x[0], box.x[1], r(0)), lerp(box.y[0], box.y[1], r(1)), lerp(box.z[0], box.z[1], r(2)));
  let wob: V3 = vec3(0, 0, 0);
  MOTES.wobble.forEach((o, k) => {
    const k0 = 3 + k * 6;
    const w = vec3(r(k0), r(k0 + 1), r(k0 + 2)).mul(o.freq[1] - o.freq[0]).add(o.freq[0]).mul(Math.PI * 2);
    const ph = vec3(r(k0 + 3), r(k0 + 4), r(k0 + 5)).mul(Math.PI * 2);
    wob = wob.add(sin(w.mul(time).add(ph)).mul(vec3(o.amp, o.amp * MOTES.ampY, o.amp)));
  });
  const drift = base.add(wob).add(vec3(MOTES.wind[0], 0, MOTES.wind[1]).mul(time));
  const p = vec3(
    mod(drift.x.sub(box.x[0]), W).add(box.x[0]),
    drift.y,
    mod(drift.z.sub(box.z[0]), D).add(box.z[0]),
  );

  // —— 亮度：手电光 × 前向散射 × 这颗灰的大小 × 闪烁 × 高度淡出 ——
  const L = lightAt(light, p, { phaseG: MOTES.phaseG });
  const peak = max(L.x, max(L.y, L.z));
  const tw = MOTES.twinkle;
  const twF = lerp(tw.freq[0], tw.freq[1], r(16)).mul(Math.PI * 2);
  const glint = pow(sin(time.mul(twF).add(r(17).mul(Math.PI * 2))).mul(0.5).add(0.5), 6);
  const twinkle = float(1 - tw.amount).add(glint.mul(tw.amount * 2));
  const heightFade = smoothstep(MOTES.floorFade[0], MOTES.floorFade[1], p.y)
    .mul(float(1).sub(smoothstep(MOTES.topFade[0], MOTES.topFade[1], p.y)));
  const grain = lerp(0.35, 1, r(18));

  // —— 尺寸：CSS 像素 → 设备像素，保底 minDevicePx；面片放大的部分按面积把亮度降回去 ——
  const px = lerp(MOTES.px[0], MOTES.px[1], pow(r(19), MOTES.sizeCurve));
  const dev = px.mul(screen.pixelRatio);
  const quadDev = max(dev.mul(MOTES.quad), MOTES.minDevicePx);
  const energy = dev.mul(MOTES.quad).div(quadDev);
  // 光弱的（光锥外、墙后、埋在雾里的）面片缩成 0：不产生片元
  const lit = ge(peak.mul(heightFade), MOTES.cutoff);
  const size = quadDev.div(screen.pixelRatio).mul(screen.worldPerCssPx).mul(lit);

  const col = L.mul(MOTES.gain).mul(grain).mul(twinkle).mul(heightFade).mul(energy.mul(energy));
  const vCol = varying(min(col, vec3(MOTES.maxLum, MOTES.maxLum, MOTES.maxLum)), 'vMoteCol');

  const mat = new THREE.SpriteNodeMaterial({
    transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
  });
  mat.positionNode = p;
  mat.scaleNode = vec2(size, size);
  // 片元：高斯圆点（面片边上约 0.01，再减掉，边缘不留方框）
  const q = uv().sub(0.5).mul(2);
  const g = max(exp(q.dot(q).mul(-4.5)).sub(0.011), 0).div(0.989);
  mat.colorNode = vCol;
  mat.opacityNode = g;
  mat.alphaTest = 0.004; // 面片外圈不写（后处理的 MRT 附件也就不被盖掉）
  protectMRT(mat);

  const object = makeSprite(mat, MOTES.count, 'dust-motes', 2.2);
  return {
    object,
    time,
    dispose() { mat.dispose(); },
  };
}
