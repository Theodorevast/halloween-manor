// 开场前的预热（2026-10-30 开局不空等，严格玩家 newbie F1、eye G-1）。原来开场按钮在「镜头看得见的那部分」编好时就能点，
// 整栋房子的后台预编译那时才开始，点了开始还要再等它 8 秒（按钮写着 The candles are almost lit…，页面不动）。
// 现在整栋房子的预编译在加载阶段就开始、分几路同时编，开场按钮显示进度，全编好、GPU 也缓过来了才亮；点了就开场。步骤见 main.ts 的 boot。
// 这里放它用到的几样（tests/opening.test.ts 直接测）：
// - drawNothing：什么物体都不画地走一遍渲染，让后处理链 setup（预编译要对得上真画时的场景 pass，要先有这一步）
// - compileWhole、compileInStreams：整栋房子（不剔除）编给场景 pass，分几路同时编。three r186 的 compileAsync 一个物体一个物体地排，
//   每个都等 GPU 编完它的管线才排下一个；分几路，GPU 那边就能同时编几条（本机实测：整栋房子约 10 秒 → 约 5 秒）
// - createSettleGate：GPU 把活干完以后，等帧间隔也稳下来才算准备好
// - bootProgress：开场按钮那条细线该到哪儿（各段按权重相加，只增不减）
import type * as THREE from 'three/webgpu';

/** 整栋房子的后台预编译分几路同时编（本机 2、4、8、16 路比过：4 和 8 差不多，16 反而慢） */
export const COMPILE_STREAMS = 4;

/** 能画出来的那几种物体（three 的 compileAsync 收集的就是这些） */
const drawable = (o: THREE.Object3D) => {
  const d = o as THREE.Object3D & { isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean };
  return d.isMesh === true || d.isLine === true || d.isPoints === true || d.isSprite === true;
};
const isLight = (o: THREE.Object3D) => (o as THREE.Object3D & { isLight?: boolean }).isLight === true;

/**
 * 场景里此刻露着的可画物体，按 n 份轮流分开。只分「叶子」（下面没有别的可画物体，也没有灯）：有可画子物体的，藏了它子物体也跟着藏了；
 * 下面挂着灯的，藏了它灯也跟着藏了，那一路收集到的灯就少一盏，编出来的管线对不上（灯的数量在着色器里）。这两种不分、每一份都露着
 * （返回的 shared）。本来就藏着的（visible 为 false，或者某个祖先藏着）不收：它们本来就不编
 */
export function partitionDrawables(root: THREE.Object3D, n: number): { parts: THREE.Object3D[][]; shared: THREE.Object3D[] } {
  const parts: THREE.Object3D[][] = Array.from({ length: Math.max(1, n) }, () => []);
  const shared: THREE.Object3D[] = [];
  let k = 0;
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (drawable(o)) {
      let leaf = true;
      o.traverse((x) => { if (x !== o && (drawable(x) || isLight(x))) leaf = false; });
      if (leaf) {
        parts[k++ % parts.length].push(o);
        return;
      }
      shared.push(o);
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return { parts, shared };
}

/** compileAsync 的进度（three 给的是 ProgressEvent，这里只用到这两项） */
export interface CompileProgress {
  loaded: number;
  total: number;
}

/**
 * 分 n 路预编译：每一路调一次 compile（main.ts 传 core.precompileAll），调用的同步部分（收集要编的物体）里只露出这一路的那一份叶子，
 * 调用一返回马上把别的几份露回来（compileAsync 在调用的同步部分就收集完了）。
 * onProgress：几路加起来编完的比例（0..1，只增不减；每一路各占 1/n，编完的那一路算满）。全部编完 resolve；哪一路失败就 reject
 */
export function compileInStreams(
  root: THREE.Object3D,
  n: number,
  compile: (onProgress: (e: CompileProgress) => void) => Promise<void>,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  const { parts } = partitionDrawables(root, n);
  const done = parts.map(() => 0);
  let reported = 0;
  const report = () => {
    const f = done.reduce((a, b) => a + b, 0) / done.length;
    if (f <= reported) return;
    reported = f;
    onProgress?.(f);
  };
  const jobs: Promise<void>[] = [];
  parts.forEach((_, k) => {
    const hidden = parts.flatMap((p, j) => (j === k ? [] : p));
    for (const o of hidden) o.visible = false;
    try {
      jobs.push(
        compile((e) => {
          if (e.total > 0) done[k] = Math.max(done[k], Math.min(1, e.loaded / e.total));
          report();
        }).then(() => {
          done[k] = 1;
          report();
        }),
      );
    } finally {
      for (const o of hidden) o.visible = true;
    }
  });
  return Promise.all(jobs).then(() => undefined);
}

/**
 * 什么物体都不画地走一遍 draw（main.ts 传真画一帧）：场景里能画的物体这一下 layers 全关（灯不动：灯少了 lightsNode 要变）。
 * 用处：场景 pass 的 renderTarget.samples、输出类型是后处理链第一次 setup 时（第一次真画）才定的，在那之前预编译，
 * 管线按 1 倍采样编、真画（4 倍）时全用不上。这一帧只编后处理那十来条管线，这些反正要编
 */
export function drawNothing(root: THREE.Object3D, draw: () => void): void {
  const saved: [THREE.Object3D, number][] = [];
  root.traverse((o) => {
    if (drawable(o)) {
      saved.push([o, o.layers.mask]);
      o.layers.mask = 0;
    }
  });
  try {
    draw();
  } finally {
    for (const [o, mask] of saved) o.layers.mask = mask;
  }
}

/** compileWhole 要用的渲染器的几样（方便测试给假的） */
export interface CompileRenderer {
  getRenderTarget(): THREE.RenderTarget | null;
  setRenderTarget(t: THREE.RenderTarget | null): void;
  compileAsync(scene: THREE.Object3D, camera: THREE.Camera, targetScene: THREE.Scene | null, onProgress: ((e: ProgressEvent) => void) | null): Promise<void>;
}

/**
 * 整栋房子编一遍（同 RenderCore.precompileAll，多一个进度）：compileAsync 只收集视锥里的物体，临时关掉剔除；编给 target（后处理的场景 pass：
 * 格式、采样都和画布不同，编给画布的管线用不上）。收集物体、定下渲染目标都在调用的同步部分里，所以调用一返回就能把剔除和渲染目标恢复
 */
export function compileWhole(
  c: { renderer: CompileRenderer; scene: THREE.Object3D },
  camera: THREE.Camera,
  target: THREE.RenderTarget | null,
  onProgress: (e: CompileProgress) => void,
): Promise<void> {
  const culled: THREE.Object3D[] = [];
  c.scene.traverse((o) => {
    if (o.frustumCulled) {
      culled.push(o);
      o.frustumCulled = false;
    }
  });
  const prev = c.renderer.getRenderTarget();
  try {
    if (target) c.renderer.setRenderTarget(target);
    return c.renderer.compileAsync(c.scene, camera, null, onProgress as unknown as (e: ProgressEvent) => void);
  } finally {
    c.renderer.setRenderTarget(prev);
    for (const o of culled) o.frustumCulled = true;
  }
}

/**
 * 准备好之前的最后一道：GPU 把活干完以后（main.ts 的 askGpu），连着 frames 帧的间隔都不超过 slowMs 才算稳了。
 * 机器本来就慢（软件渲染每帧都超过 slowMs）的，从开始等起满 maxWait 秒也算稳了。
 * 只在有帧来的时候判断：卡着的那几秒没有帧，卡完来的第一帧才可能算稳
 */
export const SETTLE = { frames: 8, slowMs: 50, maxWait: 2 };

export function createSettleGate(o: { frames: number; slowMs: number; maxWait: number } = SETTLE) {
  let t0 = NaN;
  let smooth = 0;
  return {
    /** 从这一刻（秒）开始等 */
    start(now: number): void {
      t0 = now;
      smooth = 0;
    },
    get started(): boolean {
      return !Number.isNaN(t0);
    },
    /** 来了一帧：离上一帧多少毫秒、此刻（秒）。返回稳了没有（没 start 过永远 false） */
    frame(intervalMs: number, now: number): boolean {
      if (Number.isNaN(t0)) return false;
      smooth = intervalMs <= o.slowMs ? smooth + 1 : 0;
      return smooth >= o.frames || now - t0 >= o.maxWait;
    },
  };
}

/** 开场前的各段走到哪儿了：renderer、scene 做完没有；compile 整栋房子的预编译（0..1）；drawn 整栋真画过；gpu GPU 把活干完；settled 帧间隔稳了 */
export interface BootStage {
  renderer: boolean;
  scene: boolean;
  compile: number;
  drawn: boolean;
  gpu: boolean;
  settled: boolean;
}

/**
 * 各段占细线多长（加起来是 1）。按本机实测的时长大致分（2026-10-30，共约 10 秒）：建渲染器、下载第一套造型、搭场景约 0.8 秒（网慢时更久），
 * 预编译约 5 秒，真画约 0.5 秒，等 GPU 约 3.5 秒（这几秒整页都停着，细线也动不了），帧间隔稳下来约 0.2 秒
 */
export const PROGRESS_WEIGHTS = { renderer: 0.04, scene: 0.04, compile: 0.56, drawn: 0.08, gpu: 0.24, settled: 0.04 };

/** 开场按钮那条细线此刻该到哪儿（0..1）。各段自己只增不减，加起来也只增不减；全做完是 1 */
export function bootProgress(s: BootStage): number {
  const w = PROGRESS_WEIGHTS;
  const p =
    (s.renderer ? w.renderer : 0) +
    (s.scene ? w.scene : 0) +
    w.compile * Math.max(0, Math.min(1, s.compile)) +
    (s.drawn ? w.drawn : 0) +
    (s.gpu ? w.gpu : 0) +
    (s.settled ? w.settled : 0);
  return Math.min(1, p);
}
