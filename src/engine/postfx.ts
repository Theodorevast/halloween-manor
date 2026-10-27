// 后处理（TSL）。r186 里后处理管线类叫 THREE.RenderPipeline（PostProcessing 是 r183 起废弃的别名，会打警告）。
//
// High：场景（间接光乘上一帧的 SSAO）→ 微缩景深 → + 泛光（宽的几级偏暖：胶片光晕）→ 开场显影
//       → 色调映射 + 转 sRGB → 调色 → 暗角 / 暗角脉冲 → 胶片颗粒；场景画完后用它的深度算这一帧的 SSAO
// Low ：场景 → 开场显影 → 色调映射 + 转 sRGB → 调色 → 暗角 / 脉冲 → 颗粒（没有泛光、景深、AO）
//
// - 两档各一条 RenderPipeline，共用同一个场景 pass：切画质只是换一条管线画，不重编场景材质。
//   AO 挂在渲染器的全局 context 上，Low 档把它的强度 uniform 设成 0（SSAO 那三遍也不跑）
// - 场景 pass 没有 MRT（只有 output + 深度）：AO 的法线从深度重建，没做 TAAU 所以也没有速度缓冲
// - 节点在第一次 render(camera) 时才建：SSAO、景深要的是真正的镜头相机（构造时就要），createRenderCore 在相机之前跑。
//   第一次 render 顺手把另一档的管线也画一遍，两档的着色器都在「Lighting the candles…」后面编好，之后切档不卡
// - 调色、暗角、脉冲、颗粒在色调映射之后的显示空间里做：调色板是 sRGB 值，直接混进去就是屏幕上看到的颜色；
//   颗粒按显示亮度加，不会被色调映射放大或压没
// - 深度：正交相机。three 自带的 getViewZNode() / depthAwareBlur 按透视算，这里一律自己用 orthographicDepthToViewZ，
//   near / far 用 reference 从相机上读（后处理四边形里的 cameraNear / cameraFar 是四边形自己的相机）
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, PI2, abs, clamp, cross, dot, exp, float, fract, getScreenPositionFromClip, getViewPosition, int,
  interleavedGradientNoise, length, luminance, max, mix, orthographicDepthToViewZ, pass, positionWorld, rand,
  reference, renderOutput, rtt, screenCoordinate, smoothstep, step, texture, uniform, uv, vec2, vec3, vec4,
  vogelDiskSample,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import SSAONode from 'three/addons/tsl/display/SSAONode.js';
import { CELL, FRONT_DOOR, HOUSE_D, HOUSE_W } from '../config/house';
import type { Vec2 } from '../sim/types';
import { PALETTE } from '../view/palette';
import { HEAD_H, SILL_H } from '../view/walls';
import type { Quality } from './types';

/**
 * 泛光。阈值是场景线性亮度（色调映射之前）：被普通光照亮的漫反射面在 0.05–0.6 之间，
 * 只有手电光斑中心、灯泡 / 灯罩这类 HDR 亮处会超过 0.9，所以阈值偏高 + 一段软过渡。
 * scale：亮部提取的分辨率比例（相对画布物理像素），按像素比再除一次，高 DPR 下屏幕上的光晕大小不变、开销不涨。
 * tints：每级 mip 的颜色（0 最细 → 4 最宽）。胶片光晕（halation）：强光穿过乳剂、在片基背面反射回来，
 * 在亮处外圈留下一圈偏红橙的晕；细的几级保持中性（灯芯不变色），越宽越暖。亮度（Rec.709）大致守恒
 */
export const BLOOM = {
  threshold: 0.9,
  smoothWidth: 0.4,
  strength: 0.45,
  radius: 0.45,
  scale: 0.5,
  tints: [[1, 1, 1], [1.03, 0.99, 0.94], [1.14, 0.94, 0.76], [1.32, 0.85, 0.55], [1.48, 0.77, 0.42]] as [number, number, number][],
};
/** 暗角：d 是到画面中心的距离（边中点 0.71，角 1） */
export const VIGNETTE = { strength: 0.45, inner: 0.35, outer: 1.0 };
/** 暗角脉冲：先快速泛起（attack），再在 duration 内退去；最多把边缘混到 maxMix 的比例 */
export const PULSE = { attack: 0.07, duration: 0.6, inner: 0.25, outer: 0.95, maxMix: 0.85 };
/**
 * 胶片颗粒：显示空间的幅度（±amount/2），按 fps 换一次花样，像胶片而不是电视雪花。
 * 幅度随显示亮度从 dark 降到 bright（knee 是过渡区间）：真胶片的颗粒在暗部最显眼，亮处几乎看不见
 */
export const GRAIN = { fps: 24, dark: 0.046, bright: 0.012, knee: [0.04, 0.55] as [number, number] };
/**
 * 调色（显示空间，色调映射之后）：月光下的暗部、中间调偏冷、略去饱和；钨丝灯的亮部偏暖；黑位略抬起、带一点冷。
 * 按显示亮度 Y 分区：暗部权重 1 − smoothstep(shadow)，亮部权重 smoothstep(highlight)。乘法色只做轻微偏移，
 * 整体是「同一张照片换了一卷胶片」，不是滤镜
 */
export const GRADE = {
  shadow: [0.0, 0.42] as [number, number],
  highlight: [0.4, 0.85] as [number, number],
  /** 暗部 / 中间调的饱和度（1 = 不变）；亮部不动，灯光的暖色保留 */
  satShadow: 0.8,
  satMid: 0.92,
  /** 暗部偏冷（乘法） */
  shadowTint: [0.94, 0.99, 1.08] as [number, number, number],
  /** 亮部偏暖（乘法）：钨丝灯 */
  highlightTint: [1.06, 1.0, 0.86] as [number, number, number],
  /** 抬黑：显示值 0 映射到这个冷调深灰，其余按 1 − lift 线性压缩（亮部几乎不变） */
  lift: [0.009, 0.012, 0.019] as [number, number, number],
};

/**
 * 景深（只在 High）。CoC 按深度算（正交相机的观察空间 z），不按屏幕位置画带子（《织梦岛》的教训：竖着的人物会被错误地虚掉）。
 * |Δz| < dead 米全清晰，再过 ramp 米涨到 max（0..1：0.5 = 第一级模糊全量，1 = 第二级模糊全量）。
 * - mini：常开的微缩景深。焦平面在画面中心对着的地面（房子中间的深度）；最远的地板、最近的墙头轻微发软，
 *   远角房间里的访客只是稍软，读得清
 * - focus：fx.focus(target, { strength: 1 }) 的强度（惊吓强调），焦点外明显虚掉；strength 在两者之间插值
 */
export const DOF = {
  mini: { dead: 4.2, ramp: 4.5, max: 0.34 },
  focus: { dead: 0.8, ramp: 2.4, max: 1.0 },
  /** 默认焦点高度（米）：focus() 没给 height 时用，大致是物件 / 人的中部 */
  height: 0.8,
  /** 焦点移动和强度变化的平滑时间（秒，临界阻尼弹簧），focus() 没给 smoothTime 时用 */
  smoothTime: 0.25,
  /** 常态焦点：画面中心视线和这个高度的水平面的交点 */
  defaultHeight: 0.3,
  /** 模糊用的副本分辨率（相对画布物理像素，再除以像素比） */
  scale: 0.5,
  /** 两级高斯模糊的 sigma（第二级在第一级基础上再降一半分辨率） */
  sigma: [1, 2] as [number, number],
  /** 焦内像素在模糊副本里的最小权重：模糊按 CoC 加权，清晰的人物不会被糊进周围的虚化里、在身边留一圈光晕 */
  minWeight: 0.02,
};

/**
 * 开场显影（所有档位）。progress 0：只剩门廊灯一圈和远墙上月光照亮的窗；往 1 走时，光从 origin 按水平距离铺开，
 * 前沿 soft 米。正好 1 时整段跳过（uniform 分支，没有额外开销）。
 * 窗按位置认，不按亮度：窗玻璃是加法混合、不写深度，玻璃后面的像素深度 = 1；视线在外墙所在的竖直面上、
 * 窗台到窗楣的高度之间穿过去的背景像素就是窗。按亮度认的话，屋外被月光照着的雾也会留下来
 */
export const REVEAL = {
  /** progress = 1 时光铺到离原点多远（米）：房子最远的角离前门外约 15.4 米，再加屋外看得见的一圈 */
  reach: 21,
  soft: 3.5,
  /** 门廊灯周围始终看得见：内半径全亮，外半径淡到 0（米，三维距离） */
  porch: [1.0, 2.9] as [number, number],
  /** 窗所在的竖直面：外墙中线（离房子外沿半格） */
  wallInset: CELL / 2,
  /** 没被照到的地方保留多少（0 = 纯黑；抬黑和颗粒还在，所以看着是「接近黑」） */
  floor: 0.0,
};

/**
 * 环境光遮蔽（只在 High）：只乘在间接光（半球光、环境光）上，手电、台灯、月光的直射光照旧，透明物体不参与。
 * 要的是墙根、家具底下、房间角落暗一点，不是描边。
 * 做法：场景 pass 画完以后，用它的深度算这一帧的 AO（法线从深度重建），存起来给下一帧的受光材质用；
 * 材质按「上一帧的相机」把自己的世界坐标投回 AO 图上取值，镜头转动、推近时 AO 仍然贴在墙根上。
 * 没有单独的预 pass：少画一遍场景（CPU 少一次遍历），开场也少编一批着色器。代价是动的东西（访客）的 AO 慢一帧，看不出来。
 * range：超过 radius × range 米的遮挡不算。降低的墙顶在屏幕上紧挨着墙后的地板，深度却差一米多，
 * three 自带的衰减永远不到 0，墙后会出一圈黑晕
 */
export const AO = {
  radius: 0.4,
  range: 1.6,
  intensity: 2.6,
  bias: 0.08,
  samples: 12,
  /** 最终乘到间接光上的比例（1 = 全量） */
  strength: 1.0,
  /** 计算分辨率（相对画布物理像素，再除以像素比） */
  scale: 0.5,
  /** 深度感知模糊：深度差超过 radius / sharpness 米的邻居基本不参与 */
  blurSharpness: 8,
};

/** 调试 / 量性能用的开关：关掉的效果整段不进图。全关 = 升级前的管线 */
export interface FxFlags {
  grade: boolean;
  halation: boolean;
  dof: boolean;
  ao: boolean;
  reveal: boolean;
}
export const DEFAULT_FLAGS: FxFlags = { grade: true, halation: true, dof: true, ao: true, reveal: true };

export interface FocusOpts { height?: number; strength?: number; smoothTime?: number }

export interface PostFx {
  /** 每帧调一次，代替 renderer.render */
  render(camera: THREE.Camera): void;
  setQuality(q: Quality): void;
  /** 画面太小时关泛光（BloomNode 的 5 级降采样会降到 0 尺寸） */
  setBloom(on: boolean): void;
  readonly bloomOn: boolean;
  vignettePulse(strength: number, color?: number): void;
  focus(target: Vec2 | null, opts?: FocusOpts): void;
  setReveal(progress: number, origin?: Vec2): void;
  /** 调试：脉冲的时间倍率（dev 页面放慢它，好截到中间态）。不影响颗粒 */
  timeScale: number;
  /** 调试：切换各效果（重建管线） */
  setFlags(f: Partial<FxFlags>): void;
  readonly flags: Readonly<FxFlags>;
  /** 调试：颗粒花样不再变化（A/B 截图做差时用） */
  freezeGrain: boolean;
  /** 调试：临时改 AO 强度（不重建管线，同一帧前后对比用）；null = AO.strength */
  aoStrength: number | null;
  /** 调试：画面换成中间结果（0 正常，1 AO，2 景深 CoC）；只在 ?fxview 下有效 */
  view: number;
  /** 调试：此刻的焦点状态 */
  readonly focusState: { x: number; y: number; z: number; strength: number; viewZ: number };
  dispose(): void;
}

/** 0xRRGGBB → 不做色彩空间转换的 0..1 分量（显示空间直接用） */
const hexToDisplay = (hex: number, out: THREE.Vector3) =>
  out.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

type N<T extends string = string> = THREE.Node<T>;
type F = N<'float'>;
type V3 = N<'vec3'>;
type Tex = THREE.TextureNode;

// ───────────────────────── 正交 SSAO ─────────────────────────

/** SSAONode 的私有成员（r186）：只换两个材质的片元，渲染目标、分辨率、逐帧调度都沿用原类 */
interface SSAOInternals {
  _aoRenderTarget: THREE.RenderTarget;
  _textureNode: Tex;
  _aoMaterial: THREE.NodeMaterial;
  _blurMaterial: THREE.NodeMaterial;
  _blurInput: Tex;
  _blurDirection: THREE.UniformNode<'vec2', THREE.Vector2>;
  _cameraProjectionMatrix: THREE.UniformNode<'mat4', THREE.Matrix4>;
  _cameraProjectionMatrixInverse: THREE.UniformNode<'mat4', THREE.Matrix4>;
}

/**
 * SSAO 改三处：法线从深度重建（不要法线缓冲），遮挡加距离截断（见 AO.range），模糊按正交深度判断边缘
 * （原版 depthAwareBlur 用透视公式换算 viewZ，正交深度进去以后深度差被压小几百倍，等于不判断边缘，轮廓外会糊出一圈）
 */
class OrthoSSAONode extends SSAONode {
  /** 已经算出过结果 */
  ready = false;
  /**
   * target：结果写进调用方持有的这张图（和原类自己建的那张同格式）。场景材质从开场起就绑定这张图：
   * TextureNode 的着色器缓存键里有贴图的 uuid，中途换图会让所有受光材质重新编译一遍。
   * prevVP：每次算 AO 时记下这一刻相机的 投影 × 视图 矩阵，下一帧材质用它把世界坐标投回 AO 图
   */
  constructor(depth: Tex, private readonly cam: THREE.Camera, target: THREE.RenderTarget,
    private readonly prevVP: THREE.UniformNode<'mat4', THREE.Matrix4>) {
    super(depth, depth, cam); // 第二个参数是法线，这里用不上（片元整个换掉），随便给一个贴图节点
    const self = this as unknown as SSAOInternals;
    self._aoRenderTarget.dispose();
    self._aoRenderTarget = target;
    self._textureNode.value = target.texture;
  }

  updateBefore(frame: THREE.NodeFrame) {
    this.prevVP.value.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    const r = super.updateBefore(frame);
    this.ready = true;
    return r;
  }

  dispose() {
    // 结果图归调用方，别跟着释放
    (this as unknown as SSAOInternals)._aoRenderTarget = new THREE.RenderTarget(1, 1, { depthBuffer: false });
    super.dispose();
  }

  setup(builder: THREE.NodeBuilder) {
    const out = super.setup(builder);
    const self = this as unknown as SSAOInternals;
    const depthTex = this.depthNode as Tex;
    const proj = self._cameraProjectionMatrix;
    const projInv = self._cameraProjectionMatrixInverse;
    const radius = this.radius;
    const maxD2 = radius.mul(AO.range).mul(radius.mul(AO.range));

    const ao = Fn(() => {
      const uvN = uv();
      const depth = depthTex.sample(uvN).r.toVar();
      depth.greaterThanEqual(1.0).discard();
      const P = getViewPosition(uvN, depth, projInv).toVar();
      // 法线：左右、上下各取一个邻居，每个方向用深度差小的那一边（轮廓上不会跨到背景去），叉乘
      const px = vec2(1).div(uniform(this.resolution));
      const at = (o: N<'vec2'>) => {
        const u = uvN.add(o);
        return getViewPosition(u, depthTex.sample(u).r, projInv);
      };
      const R = at(vec2(px.x, 0)).sub(P).toVar(), L = P.sub(at(vec2(px.x.negate(), 0))).toVar();
      const D = at(vec2(0, px.y)).sub(P).toVar(), U = P.sub(at(vec2(0, px.y.negate()))).toVar();
      // 不用 select（会编成 if / else）：按深度差挑一边用 step + mix
      const dx = mix(R, L, step(abs(R.z), abs(L.z)).oneMinus());
      const dy = mix(D, U, step(abs(D.z), abs(U.z)).oneMinus());
      const n0 = cross(dx, dy).normalize();
      const nrm = n0.mul(n0.z.sign().add(0.5).sign()).toVar(); // 朝向相机（观察空间 +z）
      const phi = interleavedGradientNoise(screenCoordinate).mul(PI2).toVar();
      const clipP = proj.mul(vec4(P, 1.0)).toVar();
      const occ = float(0).toVar();
      Loop({ start: int(0), end: int(AO.samples), type: 'int', condition: '<' }, ({ i }: { i: N<'int'> }) => {
        const off = vogelDiskSample(i, int(AO.samples), phi).mul(radius);
        const suv = getScreenPositionFromClip(clipP.add(proj.mul(vec4(off, 0.0, 0.0))));
        const S = getViewPosition(suv, depthTex.sample(suv).r, projInv);
        const v = S.sub(P).toVar();
        const d2 = dot(v, v).toVar();
        const cosA = dot(v, nrm).div(max(d2.sqrt(), 0.0001));
        const fall = clamp(float(1).sub(d2.div(maxD2)), 0, 1);
        occ.addAssign(max(cosA.sub(this.bias), 0.0).mul(fall));
      });
      return clamp(occ.div(AO.samples).mul(this.intensity).oneMinus(), 0, 1);
    });
    self._aoMaterial.fragmentNode = ao();
    self._aoMaterial.needsUpdate = true;

    const near = reference('near', 'float', this.cam) as unknown as F;
    const far = reference('far', 'float', this.cam) as unknown as F;
    const blur = Fn(() => {
      const uvN = uv();
      const vz = (u: N<'vec2'>) => orthographicDepthToViewZ(depthTex.sample(u).r, near, far);
      const c = vz(uvN).toVar();
      const sum = float(0).toVar();
      const wsum = float(0).toVar();
      for (let k = -2; k <= 2; k++) {
        const su = uvN.add(self._blurDirection.mul(k));
        const w = exp(abs(vz(su).sub(c)).div(radius).mul(this.blurSharpness).negate()).mul(Math.exp(-0.5 * k * k));
        sum.addAssign(self._blurInput.sample(su).r.mul(w));
        wsum.addAssign(w);
      }
      return sum.div(max(wsum, 0.0001));
    });
    self._blurMaterial.fragmentNode = blur();
    self._blurMaterial.needsUpdate = true;
    return out;
  }
}

// ───────────────────────── 平滑 ─────────────────────────

/** 临界阻尼弹簧（Unity SmoothDamp 的写法）：与帧率无关，不过冲 */
function smoothDamp(cur: number, target: number, vel: { v: number }, smoothTime: number, dt: number) {
  const st = Math.max(1e-4, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel.v + omega * change) * dt;
  vel.v = (vel.v - omega * temp) * e;
  return target + (change + temp) * e;
}

// ───────────────────────── 组装 ─────────────────────────

export interface PostFxOptions {
  /** 房屋坐标系的根节点：focus / setReveal 的坐标都是房屋米坐标 */
  houseRoot: THREE.Object3D;
}

export function createPostFx(renderer: THREE.WebGPURenderer, scene: THREE.Scene, opts: PostFxOptions): PostFx {
  const flags: FxFlags = { ...DEFAULT_FLAGS };
  // 调试：?fx=-dof,-ao 关掉某几项，?fx=legacy 全关（= 升级前的管线），对比加载时间和性能用
  for (const k of (new URLSearchParams(location.search).get('fx') ?? '').split(',').filter(Boolean)) {
    if (k === 'legacy') for (const f of Object.keys(flags) as (keyof FxFlags)[]) flags[f] = false;
    else if (k.startsWith('-') && k.slice(1) in flags) flags[k.slice(1) as keyof FxFlags] = false;
  }
  let quality: Quality = 'high';
  let bloomOn = true;

  // —— 两档共用、和相机无关的 uniform ——
  const uPulse = uniform(0);
  const uPulseColor = uniform(hexToDisplay(PALETTE.dread, new THREE.Vector3()));
  const uSeed = uniform(new THREE.Vector2());
  const uAOStrength = uniform(0);
  const uFocusZ = uniform(-40);
  const uDead = uniform(DOF.mini.dead);
  const uRamp = uniform(DOF.mini.ramp);
  const uCocMax = uniform(DOF.mini.max);
  const uReveal = uniform(1);
  const uRevealOrigin = uniform(new THREE.Vector2(FRONT_DOOR.outside.x, FRONT_DOOR.outside.z));
  const uPorch = uniform(new THREE.Vector3(9.55, 1.35, 12.6)); // 门廊灯（房屋坐标）：首帧从场景里按名字找，找不到用这个
  const uHouseOff = uniform(new THREE.Vector3());
  // 调试视图只在 ?fxview 下建：正式画面和 ?debug（冒烟测试、量性能）的着色器保持一致
  const debugViews = new URLSearchParams(location.search).has('fxview');
  const uView = uniform(0);
  const tints = BLOOM.tints.map(([r, g, b]) => new THREE.Vector3(r, g, b));

  // —— AO 接进所有受光材质的间接光：挂在渲染器的全局 context 上，而且在任何着色器编译之前就挂好 ——
  // 挂在场景 pass 自己的 contextNode 上也行，但那样场景材质的着色器和 main.ts 开场 compileAsync（不经过 pass）编出来的不一样，
  // 每个材质要多编一遍（实测开场多 1.5 秒以上）。全局挂上以后两边是同一份着色器。
  // 读的是普通贴图节点（不是 SSAO 的 PassTextureNode）：场景材质引用它不会顺带去跑 SSAO。
  // 结果图 aoTarget 归这里，SSAO 节点往里写（见 OrthoSSAONode）；是上一帧的结果，按上一帧的相机（uPrevVP）投回去取。
  // Low 档 / 关 AO / 还没算出来时强度 uniform 为 0，不跑 SSAO
  const aoTarget = new THREE.RenderTarget(1, 1, { depthBuffer: false, format: THREE.RedFormat });
  aoTarget.texture.name = 'postfx.ao';
  const aoTex = texture(aoTarget.texture);
  const uPrevVP = uniform(new THREE.Matrix4());
  if (flags.ao) {
    const aoUV = getScreenPositionFromClip(uPrevVP.mul(vec4(positionWorld, 1)));
    const aoValue = mix(float(1), aoTex.sample(aoUV).r, uAOStrength);
    const ctx = renderer.contextNode.value as Record<string, unknown>;
    ctx.getAO = (input: N | null, { material }: { material: THREE.Material }) => {
      // 透明物体、不受光照的材质（灯罩里的光、门廊灯笼）不乘
      if (material.transparent || (material as { isMeshBasicMaterial?: boolean }).isMeshBasicMaterial) return input;
      return input !== null ? (input as F).mul(aoValue) : aoValue;
    };
  }

  /** 一次建图的全部产物（按相机建；换相机或改开关时整套释放重建） */
  interface Built {
    camera: THREE.Camera;
    scenePass: THREE.PassNode;
    ssao: OrthoSSAONode | null;
    high: THREE.RenderPipeline;
    low: THREE.RenderPipeline;
    /** High 管线里自己建的节点（泛光、景深），换泛光开关时只重建这部分 */
    highNodes: { dispose(): void }[];
    lowWarm: boolean;
    setScales(dpr: number): void;
  }
  let built: Built | null = null;

  const build = (camera: THREE.Camera): Built => {
    // —— 场景 pass（两档共用）——
    const scenePass = pass(scene, camera);
    const color = scenePass.getTextureNode('output') as Tex;
    const depth = scenePass.getTextureNode('depth') as Tex;

    // —— AO：场景 pass 画完后用它的深度算（透明的雾、光锥、粒子、玻璃不写深度，自然不参与），结果给下一帧的间接光 ——
    let ssao: OrthoSSAONode | null = null;
    if (flags.ao) {
      ssao = new OrthoSSAONode(depth, camera, aoTarget, uPrevVP);
      ssao.radius.value = AO.radius;
      ssao.intensity.value = AO.intensity;
      ssao.bias.value = AO.bias;
      ssao.blurSharpness.value = AO.blurSharpness;
    }

    // —— 相机相关的 uniform（引用相机自己的矩阵对象，每帧自动是最新的）——
    const near = reference('near', 'float', camera) as unknown as F;
    const far = reference('far', 'float', camera) as unknown as F;
    const projInv = uniform(camera.projectionMatrixInverse);
    const camWorld = uniform(camera.matrixWorld);

    /** 屏幕 uv 这条视线在近 / 远裁剪面上的两点（房屋坐标） */
    const viewRay = (uvN: N<'vec2'>) => {
      const w = (z: number) => camWorld.mul(vec4(getViewPosition(uvN, float(z), projInv), 1.0)).xyz.sub(uHouseOff);
      return { p0: w(0), p1: w(1) };
    };
    /** 视线碰到地面（房屋坐标 y = 0）时的深度值（正交相机：深度沿视线线性，近裁剪面 0、远裁剪面 1） */
    const groundDepth = (ray: { p0: V3; p1: V3 }) => clamp(ray.p0.y.div(max(ray.p0.y.sub(ray.p1.y), 1e-4)), 0, 1);
    /** 屏幕 uv + 深度 → 房屋坐标。背景（深度 = 1，没有东西写深度）改用视线和地面的交点 */
    const housePos = (ray: { p0: V3; p1: V3 }, d: F, bg: N<'bool'>) =>
      mix(ray.p0, ray.p1, bg.select(groundDepth(ray), d));
    /** 视线有没有在某面外墙的竖直面上、窗台到窗楣之间穿过（0 / 1） */
    const throughWindow = (ray: { p0: V3; p1: V3 }) => {
      const { p0, p1 } = ray;
      const dv = p1.sub(p0);
      const lo = REVEAL.wallInset;
      let hit: F = float(0);
      for (const [axis, c] of [['x', lo], ['x', HOUSE_W - lo], ['z', lo], ['z', HOUSE_D - lo]] as const) {
        const other = axis === 'x' ? 'z' : 'x';
        const len = axis === 'x' ? HOUSE_D : HOUSE_W;
        const dd = dv[axis];
        const t = float(c).sub(p0[axis]).div(abs(dd).max(1e-5).mul(dd.sign().add(0.5).sign()));
        const q = p0.add(dv.mul(t));
        const inY = q.y.greaterThan(SILL_H).and(q.y.lessThan(HEAD_H));
        // 墙角那一格不算（窗都不在墙角；墙角的接缝里漏出来的背景不该亮）
        const inS = q[other].greaterThan(CELL).and(q[other].lessThan(len - CELL));
        hit = max(hit, inY.and(inS).and(t.greaterThan(0)).select(float(1), float(0)));
      }
      return hit;
    };

    // —— 收尾（显示空间）：调色 → 暗角 → 脉冲 → 颗粒 ——
    const finish = (hdr: V3) => {
      const ldr = renderOutput(vec4(hdr, 1)); // 色调映射（renderer.toneMapping）+ 转到 sRGB
      let rgb: V3 = ldr.rgb;
      if (flags.grade) {
        const Y = luminance(rgb);
        const wS = float(1).sub(smoothstep(GRADE.shadow[0], GRADE.shadow[1], Y));
        const wH = smoothstep(GRADE.highlight[0], GRADE.highlight[1], Y);
        const sat = mix(mix(float(GRADE.satMid), float(GRADE.satShadow), wS), float(1), wH);
        rgb = mix(vec3(Y), rgb, sat);
        rgb = rgb.mul(mix(vec3(1), vec3(...GRADE.shadowTint), wS));
        rgb = rgb.mul(mix(vec3(1), vec3(...GRADE.highlightTint), wH));
        const lift = vec3(...GRADE.lift);
        rgb = lift.add(rgb.mul(vec3(1).sub(lift)));
      }
      const p = uv().sub(0.5);
      const d = length(p).mul(Math.SQRT2);
      rgb = rgb.mul(float(1).sub(smoothstep(VIGNETTE.inner, VIGNETTE.outer, d).mul(VIGNETTE.strength)));
      rgb = mix(rgb, uPulseColor, smoothstep(PULSE.inner, PULSE.outer, d).mul(uPulse));
      const n = rand(fract(uv().add(uSeed))).sub(0.5);
      const amp = flags.grade
        ? mix(float(GRAIN.dark), float(GRAIN.bright), smoothstep(GRAIN.knee[0], GRAIN.knee[1], luminance(rgb)))
        : float(0.035).mul(float(1).sub(luminance(rgb).mul(0.5))); // 升级前的颗粒
      rgb = rgb.add(n.mul(amp));
      return vec4(rgb, 1);
    };

    // —— 开场显影 ——
    const reveal = (hdr: V3): V3 => {
      if (!flags.reveal) return hdr;
      return Fn(() => {
        const out = vec3(hdr).toVar();
        If(uReveal.lessThan(0.9999), () => {
          const uvN = uv();
          const d = depth.sample(uvN).r;
          const bg = d.greaterThanEqual(0.99999);
          const ray = viewRay(uvN);
          const P = housePos(ray, d, bg);
          const R = mix(float(-REVEAL.soft), float(REVEAL.reach), uReveal);
          const radial = float(1).sub(smoothstep(R.sub(REVEAL.soft), R, length(P.xz.sub(uRevealOrigin))));
          const porch = float(1).sub(smoothstep(REVEAL.porch[0], REVEAL.porch[1], length(P.sub(uPorch))));
          const win = bg.select(throughWindow(ray), float(0));
          const m = max(max(radial, porch), win);
          out.mulAssign(mix(float(REVEAL.floor), float(1), m));
        });
        return out;
      })() as V3;
    };

    // —— High ——
    const highNodes: { dispose(): void }[] = [];
    let dofSrc: THREE.RTTNode | null = null;
    let bloomNode: ReturnType<typeof bloom> | null = null;
    let cocDbg: F | null = null;
    const buildHigh = () => {
      let hdr: V3 = color.rgb;
      if (flags.dof) {
        const viewZ = (u: N<'vec2'>) => {
          const d = depth.sample(u).r;
          // 背景：按视线和地面的交点算深度（窗外、屋外地面跟着地板一起虚，不会因为「无穷远」而全虚）
          const bg = d.greaterThanEqual(0.99999);
          return orthographicDepthToViewZ(bg.select(groundDepth(viewRay(u)), d), near, far);
        };
        const coc = (u: N<'vec2'>) => smoothstep(uDead, uDead.add(uRamp), abs(viewZ(u).sub(uFocusZ))).mul(uCocMax);
        // 半分辨率副本：rgb = 场景，a = CoC（模糊按它加权）
        dofSrc = rtt(vec4(color.rgb, max(coc(uv()), DOF.minWeight)), null, null, { resolutionScale: DOF.scale });
        const b1 = gaussianBlur(dofSrc, null, DOF.sigma[0], { premultipliedAlpha: true });
        const b2 = gaussianBlur(b1.getTextureNode(), null, DOF.sigma[1], { premultipliedAlpha: true, resolutionScale: 0.5 });
        highNodes.push(dofSrc, b1, b2);
        const c = coc(uv());
        cocDbg = c;
        const w1 = clamp(c.mul(2), 0, 1);
        const w2 = clamp(c.mul(2).sub(1), 0, 1);
        hdr = mix(mix(hdr, b1.getTextureNode().rgb, w1), b2.getTextureNode().rgb, w2);
      }
      if (bloomOn) {
        bloomNode = bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
        bloomNode.smoothWidth.value = BLOOM.smoothWidth;
        if (flags.halation) bloomNode.bloomTintColors.forEach((v, i) => v.copy(tints[i]));
        highNodes.push(bloomNode);
        hdr = hdr.add(bloomNode.rgb);
      }
      const pipe = new THREE.RenderPipeline(renderer);
      // 关掉管线自带的输出变换，自己在中间调 renderOutput：调色、暗角、颗粒接在色调映射后面
      pipe.outputColorTransform = false;
      let outNode: N<'vec4'> = finish(reveal(hdr));
      if (debugViews) {
        // 调试视图（只在 ?fxview 下建）：1 = AO，2 = 景深 CoC（红 = 第一级，绿 = 第二级）
        const ao = aoTex.sample(uv()).r;
        const cc = cocDbg ?? float(0);
        // 用 mix 选，不用 select / If：WebGL 后端在条件块里采样贴图会出错（贴图 uv 翻转要建临时变量）
        const v1 = uView.equal(1).select(float(1), float(0));
        const v2 = uView.equal(2).select(float(1), float(0));
        outNode = mix(mix(outNode, vec4(vec3(ao), 1), v1), vec4(clamp(cc.mul(2), 0, 1), clamp(cc.mul(2).sub(1), 0, 1), 0, 1), v2);
      }
      // SSAO 要排在场景 pass 后面（读这一帧的深度）。three 按建图时第一次遇到的顺序调度各 pass：
      // 在输出图最后摸一下 SSAO 的结果（乘 0）——场景 pass 早在前面就遇到了
      if (ssao) outNode = outNode.add(vec4(vec3(ssao.getTextureNode().sample(vec2(0.5)).r.mul(0)), 0));
      pipe.outputNode = outNode;
      return pipe;
    };

    // —— Low ——
    const low = new THREE.RenderPipeline(renderer);
    low.outputColorTransform = false;
    low.outputNode = finish(reveal(color.rgb));

    const b: Built = {
      camera, scenePass, ssao, high: buildHigh(), low, highNodes, lowWarm: false,
      setScales(dpr) {
        const k = 1 / Math.max(1, dpr);
        bloomNode?.setResolutionScale(BLOOM.scale * k);
        dofSrc?.setResolutionScale(DOF.scale * k);
        if (ssao) ssao.resolutionScale = AO.scale * k;
      },
    };
    // 换泛光开关时只重建 High 的输出部分（场景 pass、AO 不动）
    rebuildHigh = () => {
      for (const n of b.highNodes) n.dispose();
      b.highNodes.length = 0;
      dofSrc = null;
      bloomNode = null;
      b.high.dispose();
      b.high = buildHigh();
      b.setScales(lastDpr);
    };
    return b;
  };
  let rebuildHigh: () => void = () => {};

  const disposeBuilt = () => {
    if (!built) return;
    for (const n of built.highNodes) n.dispose();
    built.ssao?.dispose();
    built.scenePass.dispose();
    built.high.dispose();
    built.low.dispose();
    built = null;
  };

  // —— 每帧状态 ——
  let last = performance.now();
  let grainClock = 0;
  let grainStep = -1;
  let pulseT = Infinity;
  let pulseStrength = 0;
  let lastDpr = -1;
  let porchFound = false;
  let aoWasHigh = false;
  const bufSize = new THREE.Vector2();
  const lastBuf = new THREE.Vector2();

  const pulseValue = () => {
    if (pulseT >= PULSE.duration) return 0;
    if (pulseT < PULSE.attack) return pulseStrength * (1 - (1 - pulseT / PULSE.attack) ** 2);
    const u = (pulseT - PULSE.attack) / (PULSE.duration - PULSE.attack);
    return pulseStrength * (0.5 + 0.5 * Math.cos(Math.PI * u));
  };

  // 焦点：房屋坐标（米），三个分量和强度各自走临界阻尼弹簧
  const focusCur = { x: FRONT_DOOR.inside.x, y: DOF.defaultHeight, z: FRONT_DOOR.inside.z, s: 0 };
  const focusVel = { x: { v: 0 }, y: { v: 0 }, z: { v: 0 }, s: { v: 0 } };
  let focusTarget: { x: number; y: number; z: number } | null = null;
  let focusStrength = 0;
  let focusSmooth = DOF.smoothTime;
  let focusPrimed = false;
  let focusViewZ = -40;
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  const houseWorld = new THREE.Vector3();

  /** 常态焦点：画面中心的视线和 y = defaultHeight 平面的交点（房屋坐标）；冲镜、平移时跟着画面中心走 */
  const defaultFocus = (camera: THREE.Camera, out: { x: number; y: number; z: number }) => {
    v0.set(0, 0, -1).unproject(camera);
    v1.set(0, 0, 1).unproject(camera);
    const h = DOF.defaultHeight + houseWorld.y;
    const t = Math.abs(v0.y - v1.y) > 1e-6 ? (v0.y - h) / (v0.y - v1.y) : 0.5;
    v0.lerp(v1, Math.min(1, Math.max(0, t)));
    out.x = v0.x - houseWorld.x;
    out.y = DOF.defaultHeight;
    out.z = v0.z - houseWorld.z;
  };
  const tmpTarget = { x: 0, y: 0, z: 0 };

  const updateFocus = (camera: THREE.Camera, dt: number) => {
    const tgt = focusTarget ?? (defaultFocus(camera, tmpTarget), tmpTarget);
    const sTarget = focusTarget ? focusStrength : 0;
    if (!focusPrimed) {
      focusPrimed = true;
      Object.assign(focusCur, tgt, { s: sTarget });
    } else {
      focusCur.x = smoothDamp(focusCur.x, tgt.x, focusVel.x, focusSmooth, dt);
      focusCur.y = smoothDamp(focusCur.y, tgt.y, focusVel.y, focusSmooth, dt);
      focusCur.z = smoothDamp(focusCur.z, tgt.z, focusVel.z, focusSmooth, dt);
      focusCur.s = Math.min(1, Math.max(0, smoothDamp(focusCur.s, sTarget, focusVel.s, focusSmooth, dt)));
    }
    v0.set(focusCur.x, focusCur.y, focusCur.z).add(houseWorld).applyMatrix4(camera.matrixWorldInverse);
    focusViewZ = v0.z;
    uFocusZ.value = focusViewZ;
    const s = focusCur.s;
    uDead.value = DOF.mini.dead + (DOF.focus.dead - DOF.mini.dead) * s;
    uRamp.value = DOF.mini.ramp + (DOF.focus.ramp - DOF.mini.ramp) * s;
    uCocMax.value = DOF.mini.max + (DOF.focus.max - DOF.mini.max) * s;
  };

  const fx: PostFx = {
    timeScale: 1,
    freezeGrain: false,
    aoStrength: null,
    get view() { return uView.value; },
    set view(v: number) { uView.value = v; },
    get bloomOn() { return bloomOn; },
    get flags() { return flags; },
    get focusState() { return { ...focusCur, strength: focusCur.s, viewZ: focusViewZ }; },
    render(camera) {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      if (!built || built.camera !== camera) {
        disposeBuilt();
        built = build(camera);
        lastDpr = -1;
      }
      const b = built;
      const dpr = renderer.getPixelRatio();
      if (dpr !== lastDpr) { lastDpr = dpr; b.setScales(dpr); }

      if (!porchFound) {
        porchFound = true;
        const porch = scene.getObjectByName('porch-light');
        if (porch) {
          opts.houseRoot.updateWorldMatrix(true, false);
          porch.getWorldPosition(v0);
          uPorch.value.copy(opts.houseRoot.worldToLocal(v0));
        }
      }
      opts.houseRoot.getWorldPosition(houseWorld);
      uHouseOff.value.copy(houseWorld);

      pulseT += dt * fx.timeScale;
      uPulse.value = Math.min(1, pulseValue()) * PULSE.maxMix;

      grainClock += dt;
      const step = Math.floor(grainClock * GRAIN.fps);
      if (step !== grainStep && !fx.freezeGrain) {
        grainStep = step;
        uSeed.value.set(Math.random(), Math.random());
      }

      camera.updateMatrixWorld();
      updateFocus(camera, dt);
      // AO 是上一帧在 High 管线里算的：刚切到 High、画布尺寸刚变（结果图重新分配、是空的）时还没有，这一帧先不乘
      renderer.getDrawingBufferSize(bufSize);
      const resized = bufSize.x !== lastBuf.x || bufSize.y !== lastBuf.y;
      lastBuf.copy(bufSize);
      const aoOn = quality === 'high' && flags.ao && b.ssao !== null && b.ssao.ready && aoWasHigh && !resized;
      uAOStrength.value = aoOn ? fx.aoStrength ?? AO.strength : 0;
      aoWasHigh = quality === 'high';

      // 第一次：先把另一档也画一遍（编译着色器），再画当前档
      if (!b.lowWarm) {
        b.lowWarm = true;
        (quality === 'high' ? b.low : b.high).render();
      }
      (quality === 'high' ? b.high : b.low).render();
    },
    setQuality(q) {
      quality = q;
    },
    setBloom(on) {
      if (on === bloomOn) return;
      bloomOn = on;
      if (built) rebuildHigh();
    },
    vignettePulse(strength, colorHex = PALETTE.dread) {
      // 叠加：峰值取「此刻的强度」和新强度里大的那个；从此刻的强度接着往上泛，不会跳变
      const cur = pulseValue();
      pulseStrength = Math.max(strength, cur);
      // 起音曲线 v = S·(1 − (1 − x)²) 反解出 v = cur 时的进度 x
      pulseT = pulseStrength > 0 ? PULSE.attack * (1 - Math.sqrt(Math.max(0, 1 - cur / pulseStrength))) : 0;
      hexToDisplay(colorHex, uPulseColor.value);
    },
    focus(target, o = {}) {
      focusSmooth = o.smoothTime ?? DOF.smoothTime;
      if (!target) {
        focusTarget = null;
        return;
      }
      const h = o.height ?? DOF.height;
      if (focusTarget) { focusTarget.x = target.x; focusTarget.y = h; focusTarget.z = target.z; }
      else focusTarget = { x: target.x, y: h, z: target.z };
      focusStrength = Math.min(1, Math.max(0, o.strength ?? 1));
    },
    setReveal(progress, origin) {
      uReveal.value = Math.min(1, Math.max(0, progress));
      if (origin) uRevealOrigin.value.set(origin.x, origin.z);
    },
    setFlags(f) {
      Object.assign(flags, f);
      disposeBuilt();
    },
    dispose() {
      disposeBuilt();
      delete (renderer.contextNode.value as Record<string, unknown>).getAO;
      aoTarget.dispose();
    },
  };
  return fx;
}
