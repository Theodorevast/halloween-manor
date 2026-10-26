// 后处理（TSL）：场景 → 泛光（只取亮处）→ 色调映射 + 转 sRGB → 暗角 / 暗角脉冲 / 胶片颗粒。
// r186 里后处理管线类叫 THREE.RenderPipeline（PostProcessing 是 r183 起废弃的别名，会打警告）。
// 暗角、脉冲、颗粒放在色调映射之后的显示空间里做：调色板是 sRGB 值，直接混进去就是屏幕上看到的颜色；
// 颗粒按显示亮度加，暗部和亮部一样细，不会被色调映射放大或压没
import * as THREE from 'three/webgpu';
import { float, fract, length, luminance, mix, pass, rand, renderOutput, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { PALETTE } from '../view/palette';

/** 泛光。阈值是场景线性亮度（色调映射之前）：被普通光照亮的漫反射面在 0.05–0.6 之间，
 *  只有手电光斑中心、灯泡 / 灯罩这类 HDR 亮处会超过 0.9，所以阈值偏高 + 一段软过渡 */
export const BLOOM = { threshold: 0.9, smoothWidth: 0.4, strength: 0.45, radius: 0.4 };
/** 暗角：d 是到画面中心的距离（边中点 0.71，角 1） */
export const VIGNETTE = { strength: 0.45, inner: 0.35, outer: 1.0 };
/** 暗角脉冲：先快速泛起（attack），再在 duration 内退去；最多把边缘混到 maxMix 的比例 */
export const PULSE = { attack: 0.07, duration: 0.6, inner: 0.25, outer: 0.95, maxMix: 0.85 };
/** 胶片颗粒：显示空间的幅度（±amount/2），按 fps 换一次花样，像胶片而不是电视雪花 */
export const GRAIN = { amount: 0.035, fps: 24 };

export interface PostFx {
  /** 每帧调一次，代替 renderer.render */
  render(camera: THREE.Camera): void;
  setBloom(on: boolean): void;
  readonly bloomOn: boolean;
  vignettePulse(strength: number, color?: number): void;
  /** 调试用：脉冲的时间倍率（dev 页面放慢它，好截到中间态）。不影响颗粒 */
  timeScale: number;
  dispose(): void;
}

/** 0xRRGGBB → 不做色彩空间转换的 0..1 分量（显示空间直接用） */
const hexToDisplay = (hex: number, out: THREE.Vector3) =>
  out.set(((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255);

export function createPostFx(renderer: THREE.WebGPURenderer, scene: THREE.Scene): PostFx {
  const pipeline = new THREE.RenderPipeline(renderer);
  // 关掉管线自带的输出变换，自己在中间调 renderOutput：这样暗角和颗粒可以接在色调映射后面
  pipeline.outputColorTransform = false;

  // 相机每帧由 render(camera) 传进来，先放一个占位
  const scenePass = pass(scene, new THREE.OrthographicCamera());
  const color = scenePass.getTextureNode('output');

  const bloomNode = bloom(color, BLOOM.strength, BLOOM.radius, BLOOM.threshold);
  bloomNode.smoothWidth.value = BLOOM.smoothWidth;

  const uPulse = uniform(0);
  const uPulseColor = uniform(hexToDisplay(PALETTE.dread, new THREE.Vector3()));
  const uSeed = uniform(new THREE.Vector2());

  // hdr：场景线性颜色（不透明，alpha 固定 1）
  const finish = (hdr: THREE.Node<'vec3'>) => {
    const ldr = renderOutput(vec4(hdr, 1)); // 色调映射（renderer.toneMapping）+ 转到 sRGB
    const p = uv().sub(0.5);
    const d = length(p).mul(Math.SQRT2);
    let rgb = ldr.rgb.mul(float(1).sub(smoothstep(VIGNETTE.inner, VIGNETTE.outer, d).mul(VIGNETTE.strength)));
    rgb = mix(rgb, uPulseColor, smoothstep(PULSE.inner, PULSE.outer, d).mul(uPulse));
    // 颗粒：亮处稍弱（胶片的颗粒主要在暗部和中间调）
    const n = rand(fract(uv().add(uSeed))).sub(0.5);
    rgb = rgb.add(n.mul(GRAIN.amount).mul(float(1).sub(luminance(rgb).mul(0.5))));
    return vec4(rgb, 1);
  };
  const withBloom = finish(color.rgb.add(bloomNode.rgb));
  const noBloom = finish(color.rgb);

  let bloomOn = true;
  pipeline.outputNode = withBloom;

  let last = performance.now();
  let grainClock = 0;
  let grainStep = -1;
  let pulseT = Infinity;
  let pulseStrength = 0;

  const pulseValue = () => {
    if (pulseT >= PULSE.duration) return 0;
    if (pulseT < PULSE.attack) return pulseStrength * (1 - (1 - pulseT / PULSE.attack) ** 2);
    const u = (pulseT - PULSE.attack) / (PULSE.duration - PULSE.attack);
    return pulseStrength * (0.5 + 0.5 * Math.cos(Math.PI * u));
  };

  const fx: PostFx = {
    timeScale: 1,
    get bloomOn() { return bloomOn; },
    render(camera) {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      pulseT += dt * fx.timeScale;
      uPulse.value = Math.min(1, pulseValue()) * PULSE.maxMix;

      grainClock += dt;
      const step = Math.floor(grainClock * GRAIN.fps);
      if (step !== grainStep) {
        grainStep = step;
        uSeed.value.set(Math.random(), Math.random());
      }

      scenePass.camera = camera;
      pipeline.render();
    },
    setBloom(on) {
      if (on === bloomOn) return;
      bloomOn = on;
      pipeline.outputNode = on ? withBloom : noBloom;
      pipeline.needsUpdate = true;
    },
    vignettePulse(strength, colorHex = PALETTE.dread) {
      // 叠加：峰值取「此刻的强度」和新强度里大的那个；从此刻的强度接着往上泛，不会跳变
      const cur = pulseValue();
      pulseStrength = Math.max(strength, cur);
      // 起音曲线 v = S·(1 − (1 − x)²) 反解出 v = cur 时的进度 x
      pulseT = pulseStrength > 0 ? PULSE.attack * (1 - Math.sqrt(Math.max(0, 1 - cur / pulseStrength))) : 0;
      hexToDisplay(colorHex, uPulseColor.value);
    },
    dispose() {
      bloomNode.dispose();
      scenePass.dispose();
      pipeline.dispose();
    },
  };
  return fx;
}
