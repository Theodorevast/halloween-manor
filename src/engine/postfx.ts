// 后处理（TSL）。r186 里后处理管线类叫 THREE.RenderPipeline（PostProcessing 是 r183 起废弃的别名，会打警告）。
//
// High：场景（间接光乘上一帧的 SSAO）→ × 这一帧的 SSAO（直射光上的接触阴影，亮的光源不动）→ + 泛光（宽的几级偏暖：胶片光晕）→ 开场显影
//       → 色调映射 + 转 sRGB → 调色 → 暗角 / 暗角脉冲 → 胶片颗粒；场景画完后用它的深度算这一帧的 SSAO
// Low ：场景 → 开场显影 → 色调映射 + 转 sRGB → 调色 → 暗角 / 脉冲 → 颗粒（没有泛光、AO）
// 2026-10-28 做减法：去掉了景深（常开的微缩景深、惊吓拉焦、悬停和开场跟焦）
//
// - 两档各一条 RenderPipeline，共用同一个场景 pass：切画质只是换一条管线画，不重编场景材质。
//   AO 挂在渲染器的全局 context 上，Low 档把它的强度 uniform 设成 0（SSAO 那三遍也不跑）
// - 场景 pass 没有 MRT（只有 output + 深度）：AO 的法线从深度重建，没做 TAAU 所以也没有速度缓冲
// - 节点在第一次 render(camera) 时才建：SSAO 要的是真正的镜头相机（构造时就要），createRenderCore 在相机之前跑。
//   第一次 render 顺手把另一档的管线也画一遍，两档的着色器都在「Lighting the candles…」后面编好，之后切档不卡
// - 调色、暗角、脉冲、颗粒在色调映射之后的显示空间里做：调色板是 sRGB 值，直接混进去就是屏幕上看到的颜色；
//   颗粒按显示亮度加，不会被色调映射放大或压没
// - 深度：两种相机都要对——娃娃屋是正交相机，第三人称是透视相机。管线按相机建（换相机整套重建），
//   所以在建图时按相机类型选深度换算（viewZOf），着色器里没有分支；从深度还原位置一律走投影逆矩阵（getViewPosition），
//   两种相机通用。near / far 用 reference 从相机上读（后处理四边形里的 cameraNear / cameraFar 是四边形自己的相机）
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, PI2, abs, clamp, cross, dot, exp, float, fract, getScreenPositionFromClip, getViewPosition, int,
  interleavedGradientNoise, length, luminance, max, mix, orthographicDepthToViewZ, pass, perspectiveDepthToViewZ,
  positionWorld, rand, reference, renderOutput, screenCoordinate, smoothstep, step, texture, uniform, uv, vec2, vec3,
  vec4, vogelDiskSample,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import SSAONode from 'three/addons/tsl/display/SSAONode.js';
import { CELL, FRONT_DOOR, HOUSE_D, HOUSE_W } from '../config/house';
import type { Vec2 } from '../sim/types';
import { PALETTE } from '../view/palette';
import { HEAD_H, SILL_H } from '../view/walls';
import type { Quality } from './types';

/**
 * 泛光。阈值是场景线性亮度（色调映射之前）：被普通光照亮的漫反射面在 0.05–0.6 之间，手电正照着的近处表面也只到 1 上下，
 * 这些都是「被照亮的表面」，不该晕开（用户说过不要泛光糊一片）；只有光源本身——灯罩口里被灯泡直照的内壁（亮度 3 以上）、
 * 台灯泡（lamp.ts，约 2.4）、手电镜片（flashlight.ts，约 2.7）——要留在阈值上面。
 * 所以阈值 2.2 + 一段宽的软过渡（smoothWidth 1.2：2.2 起、3.4 才全量），强度也收到 0.32（2026-10-30 ART-7；同一机位量过：
 * 手电光斑、台灯旁的墙那层暖雾基本没了，灯罩上方的晕少三成，灯罩口的亮边和镜片的晕还在，只是小了）。
 * 改这几个数之前，先看光源的亮度还在不在阈值上面（tests/postfx-ao.test.ts 守着）。
 * scale：亮部提取的分辨率比例（相对画布物理像素），按像素比再除一次，高 DPR 下屏幕上的光晕大小不变、开销不涨。
 * tints：每级 mip 的颜色（0 最细 → 4 最宽）。胶片光晕（halation）：强光穿过乳剂、在片基背面反射回来，
 * 在亮处外圈留下一圈偏红橙的晕；细的几级保持中性（灯芯不变色），越宽越暖（最宽两级比原来收了一点，还是偏暖）。亮度（Rec.709）大致守恒
 */
export const BLOOM = {
  threshold: 2.2,
  smoothWidth: 1.2,
  strength: 0.32,
  radius: 0.45,
  scale: 0.5,
  tints: [[1, 1, 1], [1.03, 0.99, 0.94], [1.14, 0.94, 0.76], [1.2, 0.9, 0.66], [1.3, 0.86, 0.58]] as [number, number, number][],
};
/** 暗角：d 是到画面中心的距离（边中点 0.71，角 1） */
export const VIGNETTE = { strength: 0.45, inner: 0.35, outer: 1.0 };
/**
 * 暗角脉冲（吓跑一个人时 juice.ts 调）：把画面边缘往一个颜色（PALETTE.dread，近黑的冷色）混，d 在 inner..outer 之间渐入，最多混 maxMix。
 * 浓度 0..1 的包络见 createPulseEnvelope：attack 秒慢慢收拢（smoothstep，两头平）、停 hold 秒、release 秒里退去（余弦）。
 * 2026-10-30 第二波（路 VX，newbie S2、eye S-2）：原来 0.07 秒冲到满、四角混到 85% 的暗红，整屏泛红像「你受伤了」；
 * 现在很淡（四角最多压暗 30%，画面中间 inner 以内不动），慢慢收拢再松开，像屏住一口气
 */
export const PULSE = { attack: 0.22, hold: 0.15, release: 0.9, inner: 0.42, outer: 1.05, maxMix: 0.3 };

/** 暗角脉冲的浓度包络（纯逻辑，测试直接走它）：trigger 来一下，step 走 dt 秒、返回此刻的浓度 */
export interface PulseEnvelope {
  readonly value: number;
  trigger(strength: number): void;
  step(dt: number): number;
}

/**
 * 几个人接连吓跑不叠加：浓度取最大，不相加（tests/flee-pulse.test.ts）——
 * - 正在收拢：从此刻的浓度接着往「两下里大的那个」收拢（起点就是此刻的值，不跳变）
 * - 停住时：来的不比此刻浓，就把停住的时间往后续；更浓，从此刻接着收拢上去
 * - 正在退：来的不比此刻浓，就停在此刻的浓度（再停 attack + hold 秒）然后接着退——画面只是多暗了一会儿，不会再暗一下；
 *   更浓，从此刻的浓度收拢上去
 * 这样画面边缘每暗下去一次（countDips 数的「一下」），中间至少隔着 attack + hold + 退去三分之一的时间（约 0.7 秒），任意 1 秒最多两下
 */
export function createPulseEnvelope(): PulseEnvelope {
  type Phase = 'idle' | 'rise' | 'hold' | 'fall';
  let phase: Phase = 'idle';
  let t = 0;
  let from = 0;
  let peak = 0;
  const value = () => {
    switch (phase) {
      case 'idle': return 0;
      case 'rise': {
        const x = Math.min(1, t / PULSE.attack);
        return from + (peak - from) * x * x * (3 - 2 * x);
      }
      case 'hold': return peak;
      case 'fall': return peak * (0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, t / PULSE.release)));
    }
  };
  return {
    get value() { return value(); },
    trigger(strength) {
      const s = Math.min(1, Math.max(0, strength));
      if (!(s > 0)) return;
      const cur = value();
      if (phase === 'hold' && s <= peak) { t = 0; return; }
      // 收拢、退去、停住时来了更浓的、或者原来没有：都从此刻的浓度收拢到两者里大的那个
      from = cur;
      peak = Math.max(s, cur, phase === 'rise' ? peak : 0);
      phase = 'rise';
      t = 0;
    },
    step(dt) {
      if (phase === 'idle') return 0;
      t += Math.max(0, dt);
      if (phase === 'rise' && t >= PULSE.attack) { phase = 'hold'; t -= PULSE.attack; }
      if (phase === 'hold' && t >= PULSE.hold) { phase = 'fall'; t -= PULSE.hold; }
      if (phase === 'fall' && t >= PULSE.release) { phase = 'idle'; t = 0; peak = 0; from = 0; }
      return value();
    },
  };
}
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
 * 环境光遮蔽（只在 High）。要的是墙根、家具底下、房间角落、访客脚下暗一点（接触阴影），不是描边。
 * 做法：场景 pass 画完以后，用它的深度算这一帧的 AO（法线从深度重建），存起来，两处用：
 * 1. 场景材质里：乘在间接光（半球光、环境光）上，用的是上一帧的结果；材质按「上一帧的相机」把自己的世界坐标投回 AO 图上取值，
 *    镜头转动、推近时 AO 仍然贴在墙根上。没有单独的预 pass：少画一遍场景（CPU 少一次遍历），开场也少编一批着色器。
 *    代价是动的东西（访客）的 AO 慢一帧，看不出来。但整栋房子的间接光几乎是 0（材质底色 0.013–0.04、半球光 ×0.55），
 *    光靠这一处 AO 开关前后画面几乎没有差别（2026-10-30 美术总监量过）；
 * 2. 后处理里（buildHigh，ART-4）：这一帧的结果，按 direct 的比例乘到整幅画面（直射光、自发光、叠上去的雾都在里面）上，
 *    才是看得见的接触阴影；亮处（亮度 protect[0]–protect[1]，灯罩、镜片、光斑正中）渐渐不乘。
 * 透明物体不写深度、不参与 AO，但它们叠在墙角时画面上的颜色会跟着被乘（雾、鬼魂、白气是加法 / 普通混合叠上去的）：
 * direct 只给 0.4，最多压暗 40% × 遮挡，墙根那圈雾不会被压没。
 * range：超过 radius × range 米的遮挡不算。降低的墙顶在屏幕上紧挨着墙后的地板，深度却差一米多，
 * three 自带的衰减永远不到 0，墙后会出一圈黑晕
 */
export const AO = {
  radius: 0.4,
  range: 1.6,
  /** 2.6 → 4（2026-10-30 PX 审查：direct 留 0.4 时 2.6 在鞋下只暗约 2%，接触阴影看不出；只提这一项，不动 direct，雾和鬼魂最多被压的比例不变） */
  intensity: 4,
  bias: 0.08,
  samples: 12,
  /** 最终乘到间接光上的比例（1 = 全量） */
  strength: 1.0,
  /** 计算分辨率（相对画布物理像素，再除以像素比） */
  scale: 0.5,
  /** 深度感知模糊：深度差超过 radius / sharpness 米的邻居基本不参与 */
  blurSharpness: 8,
  /** 后处理里乘到整幅画面（直射光）上的比例：一个像素最多被压暗这么多（× 遮挡程度）。见 aoDirectWeight */
  direct: 0.4,
  /** 直射光上的 AO 的保护区间：像素的场景线性亮度（色调映射之前）从 protect[0] 到 protect[1] 渐渐不乘，亮的光源不被压暗 */
  protect: [0.8, 2.0] as [number, number],
};

/** GLSL / TSL 的 smoothstep（两个边界之间 3t² − 2t³，边界之外取 0 / 1） */
const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 后处理里乘到直射光上的 AO 权重 k（buildHigh 里着色器的同一条曲线，纯函数、好测）：
 * 亮度 lum（场景线性亮度）在 protect[0] 以下满额 direct，到 protect[1] 渐渐（smoothstep）降到 0；
 * strength 是 uAOStrength（AO 关、Low 档、还没算出来时为 0，调试里 aoStrength(0.5) 就是一半）。
 */
export const aoDirectWeight = (lum: number, strength: number = 1): number =>
  AO.direct * (1 - smooth01(AO.protect[0], AO.protect[1], lum)) * strength;

/** 这个像素最后乘多少：mix(1, ao, k)。ao = 1（没有遮挡）原样；最暗也只压到 1 − direct */
export const aoDirectFactor = (ao: number, lum: number, strength: number = 1): number =>
  1 + (ao - 1) * aoDirectWeight(lum, strength);

/** 调试 / 量性能用的开关：关掉的效果整段不进图。全关 = 升级前的管线 */
export interface FxFlags {
  grade: boolean;
  halation: boolean;
  ao: boolean;
  reveal: boolean;
}
export const DEFAULT_FLAGS: FxFlags = { grade: true, halation: true, ao: true, reveal: true };

export interface PostFx {
  /** 每帧调一次，代替 renderer.render */
  render(camera: THREE.Camera): void;
  setQuality(q: Quality): void;
  /** 画面太小时关泛光（BloomNode 的 5 级降采样会降到 0 尺寸） */
  setBloom(on: boolean): void;
  readonly bloomOn: boolean;
  vignettePulse(strength: number, color?: number): void;
  setReveal(progress: number, origin?: Vec2): void;
  /** 调试：脉冲的时间倍率（dev 页面放慢它，好截到中间态）。不影响颗粒 */
  timeScale: number;
  /** 调试：切换各效果（重建管线） */
  setFlags(f: Partial<FxFlags>): void;
  readonly flags: Readonly<FxFlags>;
  /** 场景 pass 的渲染目标（按这个镜头建好管线）：后台预编译要编给它，见 RenderCore.precompileAll */
  sceneTarget(camera: THREE.Camera): THREE.RenderTarget;
  /** 调试：颗粒花样不再变化（A/B 截图做差时用） */
  freezeGrain: boolean;
  /** 调试：临时改 AO 强度（不重建管线，同一帧前后对比用）；null = AO.strength */
  aoStrength: number | null;
  /** 调试：画面换成中间结果（0 正常，1 AO 图，2 场景线性亮度 ÷ 4，3 后处理里 AO 实际乘的倍数）；只在 ?fxview 下有效 */
  view: number;
  dispose(): void;
}

/** 0xRRGGBB → 不做色彩空间转换的 0..1 分量（显示空间直接用） */
const hexToDisplay = (hex: number, out: THREE.Vector3) =>
  out.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

type N<T extends string = string> = THREE.Node<T>;
type F = N<'float'>;
type V3 = N<'vec3'>;
type Tex = THREE.TextureNode;

// ───────────────────────── 深度换算 ─────────────────────────

/** 这台相机的深度贴图值 → 观察空间 z（负数）。正交相机深度沿视线线性，透视相机不是 */
const viewZOf = (camera: THREE.Camera, near: F, far: F) =>
  (camera as THREE.PerspectiveCamera).isPerspectiveCamera === true
    ? (d: F) => perspectiveDepthToViewZ(d, near, far) as unknown as F
    : (d: F) => orthographicDepthToViewZ(d, near, far) as unknown as F;

// ───────────────────────── SSAO ─────────────────────────

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
 * SSAO 改三处：法线从深度重建（不要法线缓冲），遮挡加距离截断（见 AO.range），模糊按这台相机的深度换算判断边缘
 * （原版 depthAwareBlur 一律按透视公式换算 viewZ，正交深度进去以后深度差被压小几百倍，等于不判断边缘，轮廓外会糊出一圈）。
 * 采样本身（视平面上的圆盘偏移 → 投影回屏幕）对两种相机都对，沿用原版的做法
 */
class DepthSSAONode extends SSAONode {
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
    const persp = (this.cam as THREE.PerspectiveCamera).isPerspectiveCamera === true;

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
      // 翻到朝向相机的一面：正交相机朝 +z（视线处处平行），透视相机朝原点（视线从相机发散出去）
      const facing = persp ? dot(n0, P).negate() : n0.z;
      const nrm = n0.mul(facing.sign().add(0.5).sign()).toVar();
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

    const toViewZ = viewZOf(this.cam, reference('near', 'float', this.cam) as unknown as F, reference('far', 'float', this.cam) as unknown as F);
    const blur = Fn(() => {
      const uvN = uv();
      const vz = (u: N<'vec2'>) => toViewZ(depthTex.sample(u).r);
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

// ───────────────────────── 组装 ─────────────────────────

export interface PostFxOptions {
  /** 房屋坐标系的根节点：setReveal 的坐标是房屋米坐标 */
  houseRoot: THREE.Object3D;
}

export function createPostFx(renderer: THREE.WebGPURenderer, scene: THREE.Scene, opts: PostFxOptions): PostFx {
  const flags: FxFlags = { ...DEFAULT_FLAGS };
  // 调试：?fx=-ao,-grade 关掉某几项，?fx=legacy 全关（= 升级前的管线），对比加载时间和性能用
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
  // 结果图 aoTarget 归这里，SSAO 节点往里写（见 DepthSSAONode）；是上一帧的结果，按上一帧的相机（uPrevVP）投回去取。
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
    ssao: DepthSSAONode | null;
    high: THREE.RenderPipeline;
    low: THREE.RenderPipeline;
    /** High 管线里自己建的节点（泛光），换泛光开关时只重建这部分 */
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
    let ssao: DepthSSAONode | null = null;
    if (flags.ao) {
      ssao = new DepthSSAONode(depth, camera, aoTarget, uPrevVP);
      ssao.radius.value = AO.radius;
      ssao.intensity.value = AO.intensity;
      ssao.bias.value = AO.bias;
      ssao.blurSharpness.value = AO.blurSharpness;
    }

    // —— 相机相关的 uniform（引用相机自己的矩阵对象，每帧自动是最新的）——
    const projInv = uniform(camera.projectionMatrixInverse);
    const camWorld = uniform(camera.matrixWorld);

    /** 屏幕 uv + 深度值 → 房屋坐标（投影逆矩阵还原观察空间位置，正交、透视通用） */
    const houseAt = (uvN: N<'vec2'>, d: F): V3 => camWorld.mul(vec4(getViewPosition(uvN, d, projInv), 1.0)).xyz.sub(uHouseOff);
    /** 屏幕 uv 这条视线在近 / 远裁剪面上的两点（房屋坐标）：两种相机下视线都是这两点连成的直线 */
    const viewRay = (uvN: N<'vec2'>) => ({ p0: houseAt(uvN, float(0)), p1: houseAt(uvN, float(1)) });
    /** 视线碰到地面（房屋坐标 y = 0）时在 p0 → p1 上的比例（往上看、碰不到地面的视线取远端） */
    const groundT = (ray: { p0: V3; p1: V3 }) => clamp(ray.p0.y.div(max(ray.p0.y.sub(ray.p1.y), 1e-4)), 0, 1);
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
          const ray = viewRay(uvN);
          // 背景（深度 = 1，没有东西写深度）改用视线和地面的交点；两边都算、按 0 / 1 混合（不用 select：见文件头的坑）
          const bg = step(0.99999, d);
          const P = mix(houseAt(uvN, d), mix(ray.p0, ray.p1, groundT(ray)), bg);
          const R = mix(float(-REVEAL.soft), float(REVEAL.reach), uReveal);
          const radial = float(1).sub(smoothstep(R.sub(REVEAL.soft), R, length(P.xz.sub(uRevealOrigin))));
          const porch = float(1).sub(smoothstep(REVEAL.porch[0], REVEAL.porch[1], length(P.sub(uPorch))));
          const win = throughWindow(ray).mul(bg);
          const m = max(max(radial, porch), win);
          out.mulAssign(mix(float(REVEAL.floor), float(1), m));
        });
        return out;
      })() as V3;
    };

    // —— High ——
    const highNodes: { dispose(): void }[] = [];
    let bloomNode: ReturnType<typeof bloom> | null = null;
    const buildHigh = () => {
      // 场景 pass 在这一行第一次被遇到：three 按建图时第一次遇到的顺序调度各 pass，下面的 SSAO 排在它后面，读的是这一帧的深度
      let hdr: V3 = color.rgb;
      let aoFactor: F | null = null; // 后处理里 AO 实际乘的倍数（调试视图 3 看它）
      if (ssao) {
        // AO 当接触阴影（ART-4）：这一帧的 AO（SSAO 在场景 pass 后面、这条管线的输出之前算好）乘到整幅画面上，不只是间接光。
        // k 的曲线就是 aoDirectWeight：暗处满额 AO.direct，亮度到 protect 区间里渐渐降到 0（灯罩、镜片、光斑正中不被压暗）；
        // uAOStrength 为 0（AO 关、刚切到 High、画布刚换尺寸）时一点都不乘。泛光吃的是没乘过的场景色：它只提取阈值以上的光源，
        // 阈值（BLOOM.threshold）在保护区间上限之上，两边不冲突
        const ao = ssao.getTextureNode().sample(uv()).r;
        const k = float(AO.direct).mul(float(1).sub(smoothstep(AO.protect[0], AO.protect[1], luminance(color.rgb)))).mul(uAOStrength);
        aoFactor = mix(float(1), ao, k) as unknown as F;
        hdr = hdr.mul(aoFactor);
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
        // 调试视图（只在 ?fxview 下建）：1 = AO 图；2 = 场景线性亮度 ÷ 4（读数 = 灰度 / 255 × 4，调泛光阈值、AO 保护区间时看亮度在哪）；
        // 3 = 后处理里 AO 实际乘的倍数（白 = 1 不动）。
        // 用 mix 选，不用 select / If：WebGL 后端在条件块里采样贴图会出错（贴图 uv 翻转要建临时变量）
        const v1 = uView.equal(1).select(float(1), float(0));
        outNode = mix(outNode, vec4(vec3(aoTex.sample(uv()).r), 1), v1);
        const v2 = uView.equal(2).select(float(1), float(0));
        outNode = mix(outNode, vec4(vec3(luminance(color.rgb).div(4)), 1), v2);
        const v3 = uView.equal(3).select(float(1), float(0));
        outNode = mix(outNode, vec4(vec3(aoFactor ?? float(1)), 1), v3);
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
        if (ssao) ssao.resolutionScale = AO.scale * k;
      },
    };
    // 换泛光开关时只重建 High 的输出部分（场景 pass、AO 不动）
    rebuildHigh = () => {
      for (const n of b.highNodes) n.dispose();
      b.highNodes.length = 0;
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
  const pulse = createPulseEnvelope();
  let lastDpr = -1;
  let porchFound = false;
  let aoWasHigh = false;
  const bufSize = new THREE.Vector2();
  const lastBuf = new THREE.Vector2();
  const v0 = new THREE.Vector3();

  const fx: PostFx = {
    timeScale: 1,
    freezeGrain: false,
    aoStrength: null,
    get view() { return uView.value; },
    set view(v: number) { uView.value = v; },
    get bloomOn() { return bloomOn; },
    get flags() { return flags; },
    sceneTarget(camera) {
      if (!built || built.camera !== camera) {
        disposeBuilt();
        built = build(camera);
        lastDpr = -1;
      }
      return built.scenePass.renderTarget;
    },
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
      opts.houseRoot.getWorldPosition(uHouseOff.value);

      uPulse.value = pulse.step(dt * fx.timeScale) * PULSE.maxMix;

      grainClock += dt;
      const step = Math.floor(grainClock * GRAIN.fps);
      if (step !== grainStep && !fx.freezeGrain) {
        grainStep = step;
        uSeed.value.set(Math.random(), Math.random());
      }

      camera.updateMatrixWorld();
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
      // 不叠加：浓度取最大、从此刻的浓度接着走，不跳变（见 createPulseEnvelope）
      pulse.trigger(strength);
      hexToDisplay(colorHex, uPulseColor.value);
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
