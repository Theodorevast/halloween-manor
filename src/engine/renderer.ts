// 渲染器：WebGPURenderer（浏览器不支持 WebGPU 时 three 自动换成 WebGL2 后端）、画质档位、后处理入口、帧时间监测
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from '../config/house';
import { PALETTE } from '../view/palette';
import { createPostFx, type PostFx } from './postfx';
import type { Quality, RenderCore } from './types';

/** 色调映射：AgX。整栋房子大部分像素落在线性 0.005–0.1 的暗部，
 *  Neutral 在 min(r,g,b) < 0.08 时按 6.25·x² 压暗（0.02 → 0.0025），ACES 也有明显的趾部（0.02 → 0.007），暗部层次会被吃掉；
 *  AgX 走 log2 编码，0.02 → 0.018 几乎原样保留，手电光斑这类 HDR 亮处又能平滑压到白，不会像 Reinhard 那样把高光压灰 */
export const TONE_MAPPING = THREE.AgXToneMapping;
export const EXPOSURE = 1.0;

/** 画质 → 像素比上限 */
const PIXEL_RATIO: Record<Quality, number> = { high: 2, low: 1 };

/** 自动降档：开始后 [from, to] 秒这段的平均帧时间超过 slowMs 就降一次（设计文档：测 3 秒、超过 22 ms） */
const FRAME_WATCH = { from: 1, to: 4, slowMs: 22 };

/** 画面短边小于这么多 CSS 像素时不开泛光（半分辨率起算、再降 4 级，最小一级要 ≥ 1 像素还得有意义） */
const BLOOM_MIN_PX = 64;

export interface RenderCoreOptions {
  /** 调试：强制走 WebGL2 后端 */
  forceWebGL?: boolean;
}

/** createRenderCore 的实际产物：契约里的 RenderCore，外加后处理对象（调试和 dev 页面用） */
export interface EngineCore extends RenderCore {
  post: PostFx | null;
}

const webgl2Available = () => {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // 只是探测，马上释放，别占着浏览器有限的上下文名额
    return !!gl;
  } catch {
    return false;
  }
};

export async function createRenderCore(canvas: HTMLCanvasElement, opts: RenderCoreOptions = {}): Promise<EngineCore> {
  // 探测用临时画布：在正式画布上 getContext 会把它锁死在 WebGL，WebGPU 就用不了了
  if (!('gpu' in navigator) && !webgl2Available()) throw new Error('no-webgl2');

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL ?? false });
  try {
    await renderer.init();
  } catch (err) {
    console.error('renderer.init 失败', err);
    throw new Error('no-webgl2');
  }
  const backend: RenderCore['backend'] = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';

  renderer.toneMapping = TONE_MAPPING;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap; // r186 的 WebGPU 渲染器没有 PCFSoftShadowMap

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.night);
  const houseRoot = new THREE.Group();
  houseRoot.name = 'houseRoot';
  houseRoot.position.set(-HOUSE_W / 2, 0, -HOUSE_D / 2); // 房子中心落在世界原点
  scene.add(houseRoot);

  // 后处理建不起来（例如某个后端不支持其中的节点）就直接渲染，至少画面在
  let post: PostFx | null = null;
  try {
    post = createPostFx(renderer, scene);
  } catch (err) {
    console.warn('后处理不可用，改为直接渲染', err);
  }

  // 画布还没排版（clientWidth 为 0）时先按窗口大小，主循环第一次 resize 前也不会出 0 尺寸的渲染目标
  let width = Math.max(1, canvas.clientWidth || window.innerWidth);
  let height = Math.max(1, canvas.clientHeight || window.innerHeight);
  const pixelRatio = (q: Quality) => Math.min(window.devicePixelRatio || 1, PIXEL_RATIO[q]);
  // 泛光只在 high 档开；画面太小时 BloomNode 的 5 级降采样会降到 0 尺寸，也关掉
  const applyBloom = () => post?.setBloom(core.quality === 'high' && Math.min(width, height) >= BLOOM_MIN_PX);

  const core: EngineCore = {
    renderer,
    scene,
    houseRoot,
    backend,
    quality: 'high',
    post,
    setQuality(q) {
      core.quality = q;
      renderer.setPixelRatio(pixelRatio(q));
      renderer.setSize(width, height, false);
      applyBloom();
    },
    resize(w, h) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      // 窗口拖到另一块屏幕时 devicePixelRatio 会变，每次 resize 顺便按当前档位重设
      renderer.setPixelRatio(pixelRatio(core.quality));
      renderer.setSize(width, height, false);
      applyBloom();
    },
    render(camera) {
      if (post) post.render(camera);
      else renderer.render(scene, camera);
    },
    fx: {
      vignettePulse(strength, color = PALETTE.dread) {
        post?.vignettePulse(strength, color);
      },
    },
  };
  core.setQuality('high');
  return core;
}

/** 返回每帧要调用的函数（参数为这一帧的 dt 秒）；开始后第 1–4 秒的平均帧时间超过 22 ms 时调用一次 onSlow */
export function watchFrameTime(onSlow: () => void): (dt: number) => void {
  let t = 0, sum = 0, n = 0, done = false;
  return (dt) => {
    if (done) return;
    t += dt;
    if (t <= FRAME_WATCH.from) return;
    if (t <= FRAME_WATCH.to) {
      sum += dt;
      n++;
      return;
    }
    done = true;
    if (n > 0 && (sum / n) * 1000 > FRAME_WATCH.slowMs) onSlow();
  };
}
