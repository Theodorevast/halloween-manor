// 三种粒子共用的小工具：按实例编号取随机数、画面空间的尺寸换算、正交相机下的软粒子、保护后处理的 MRT 附件。
import * as THREE from 'three/webgpu';
import {
  cameraNear, cameraFar, float, hash, instanceIndex, modelViewMatrix, mrt, orthographicDepthToViewZ, output, smoothstep,
  step, uniform, varying, vec4, viewportDepthTexture,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * 第 k 个随机数（0..1），只由实例编号（和 seed）决定：同一颗粒子每帧取到的值一样，不用存任何缓冲。
 * k < 32；seed 换一个整数就是另一套随机数（每次扬尘换个样子）
 */
export const rnd = (k: number, seed: F | number = 0): F =>
  hash(float(instanceIndex).mul(32).add(k).add(seed)) as unknown as F;

/**
 * 比较 → 0 / 1 的浮点数。粒子着色器里不用 select()：r186 的 select 生成 if / else 代码块，
 * 被几处共用的节点如果第一次是在某个分支里生成的，变量只在那个分支里赋值，另一个分支读到的是 0
 * （2026-10-27 实测：粉尘的不透明度在灰的那一支全是 0）。改成两边都算、按 0 / 1 混合，没有分支
 */
export const ge = (a: F, b: F | number): F => step(b, a);
export const lt = (a: F, b: F | number): F => float(1).sub(step(b, a));

/** 每帧更新：一个 CSS 像素 / 一个设备像素在画面上是多少米（正交相机，和深度无关） */
export function makeScreenUniforms() {
  return {
    worldPerCssPx: uniform(0.01),
    /** 设备像素比（renderer.getPixelRatio）：浮尘的最小尺寸按设备像素保底 */
    pixelRatio: uniform(1),
  };
}
export type ScreenUniforms = ReturnType<typeof makeScreenUniforms>;

const _size = new THREE.Vector2();
export function updateScreenUniforms(s: ScreenUniforms, renderer: THREE.WebGPURenderer, camera: THREE.Camera) {
  renderer.getSize(_size);
  // 正交投影矩阵的 [1][1] = 2 / (top − bottom)（zoom 已经算进 top / bottom）：画面高 2 / P11 米
  const p11 = camera.projectionMatrix.elements[5];
  s.worldPerCssPx.value = p11 > 0 ? 2 / (p11 * Math.max(1, _size.y)) : 0.01;
  s.pixelRatio.value = renderer.getPixelRatio();
}

/** 粒子中心的视空间 z（顶点里算好传给片元）。正交相机下正对镜头的面片上每个片元都是这个深度 */
export const centerViewZ = (center: V3): F => varying((modelViewMatrix.mul(vec4(center, 1)) as unknown as THREE.Node<'vec4'>).z, 'vPartViewZ') as unknown as F;

/**
 * 软粒子（正交相机版）：粒子面片和后面的地板 / 墙 / 家具相交的地方，按两者的视空间深度差在 dist 米内淡掉，
 * 不出现面片插进地板的硬直线。r186 的 softParticles() 按透视相机算深度，这里照 fog.ts 用 orthographicDepthToViewZ。
 * 深度贴图节点几个材质共用一个：每次渲染只拷一次深度（只有画到用它的物体时才拷，粒子不在时整个物体藏起来）
 */
let sharedDepth: THREE.Node<'vec4'> | null = null;
export function softFade(viewZ: F, dist: F | number): F {
  sharedDepth ??= viewportDepthTexture() as unknown as THREE.Node<'vec4'>;
  const sceneZ = orthographicDepthToViewZ(sharedDepth.x, cameraNear, cameraFar);
  return smoothstep(0, dist, viewZ.sub(sceneZ));
}

/**
 * 后处理以后可能给场景 pass 加 MRT（法线、速度给 SSAO / TAAU 用）。three 的 MRT 附件默认不混合：
 * 透明物体会把自己的法线、速度原样盖到后面不透明表面的值上。粒子只该改颜色，所以其余附件一律「保留目标值」
 * （src × 0 + dst × 1）。名字不在 pass 的 MRT 里的条目不起作用。
 * 必须带上 output：pass 没有 MRT 时 three 直接拿材质自己的 mrtNode 当输出，缺了 output 就什么都不画；
 * pass 有 MRT 时两者合并，这里的 output 就是 pass 里通常写的那个 output 节点
 */
const KEEP_TARGETS = ['normal', 'velocity', 'emissive', 'metalrough', 'albedo', 'diffuse', 'diffuseColor', 'roughness', 'metalness', 'depth', 'viewZ'];
let keep: THREE.BlendMode | null = null;
export function protectMRT(mat: THREE.NodeMaterial) {
  if (!keep) {
    keep = new THREE.BlendMode(THREE.CustomBlending);
    keep.blendSrc = THREE.ZeroFactor;
    keep.blendDst = THREE.OneFactor;
    keep.blendSrcAlpha = THREE.ZeroFactor;
    keep.blendDstAlpha = THREE.OneFactor;
    keep.blendEquation = THREE.AddEquation;
    keep.blendEquationAlpha = THREE.AddEquation;
  }
  const m = mrt({ output });
  for (const name of KEEP_TARGETS) m.setBlendMode(name, keep);
  mat.mrtNode = m;
}

/** 一个装 count 颗粒子的实例化精灵（一次绘制）。不做视锥剔除：粒子散在整栋房子里，精灵自己的包围球不对 */
export function makeSprite(mat: THREE.SpriteNodeMaterial, count: number, name: string, renderOrder: number) {
  const s = new THREE.Sprite(mat);
  s.name = name;
  // count 只能在 > 1 的范围内改：从 1 变成 > 1 会换渲染对象的缓存键，等于重新编译
  s.count = Math.max(2, count);
  s.frustumCulled = false;
  s.renderOrder = renderOrder;
  s.castShadow = false;
  s.receiveShadow = false;
  return s;
}

export const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
