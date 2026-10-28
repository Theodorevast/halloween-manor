// 画面 / 声音 / 界面各模块和主循环之间的接口
import type * as THREE from 'three/webgpu';
import type { SimEvent, Vec2, WorldState } from '../sim/types';

export type Quality = 'high' | 'low';

/** 每帧传给各模块的上下文 */
export interface FrameCtx {
  /** 这一帧的真实时间间隔（秒，已限制在 0.1 以内）。hit-stop 期间照常走，表现动画可以继续 */
  dt: number;
  /** 真实时间累计（秒） */
  time: number;
  state: WorldState;
}

/** 所有画面、声音、界面模块的统一形状：主循环每帧调 update，模拟产生事件时调 onEvent */
export interface Module {
  update?(ctx: FrameCtx): void;
  onEvent?(e: SimEvent, state: WorldState): void;
  setQuality?(q: Quality): void;
  dispose?(): void;
}

/**
 * 第三人称模式下玩家操控的鬼魂（2026-10-28 改版）。位置为房屋米坐标（x 向东、z 向南、y 为离地高度）。
 * 由 engine/ghostRig.ts 每帧更新；画面（鬼魂外形、墙的溶解）、声音、模拟（贴近发毛）都读它
 */
export interface GhostState {
  x: number;
  y: number;
  z: number;
  /** 朝向（方向角，约定见 lib/angle.ts） */
  heading: number;
  /** 当前水平速度（米/秒） */
  speed: number;
  /** 鬼魂身体此刻是否在墙里（穿墙效果用） */
  inWall: boolean;
}

/** 第三人称镜头：仍然实现 CameraRig（rotate 等对它可以是空操作），多一个鬼魂状态 */
export interface GhostRig extends CameraRig {
  readonly ghost: GhostState;
  /** 指针锁定后鼠标转向；开场点击时调用（必须在用户手势里） */
  lockPointer(): void;
  /** 现身：指针锁定时按右键或 F，每按一下回调一次（冷却、能不能现身由模拟判断） */
  onManifest(cb: () => void): void;
  /** 定住鬼魂（现身的蓄力和停留期间，main.ts 每帧按模拟设）：按键不再推动，浮动和身体朝向停住；视角、镜头照常转 */
  pin(on: boolean): void;
}

export const isGhostRig = (r: CameraRig): r is GhostRig => 'ghost' in r;

/** 渲染器（engine/renderer.ts 产出） */
export interface RenderCore {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  /** 房屋坐标系的根节点：局部坐标 = config/house.ts 的米坐标（x 向东，z 向南，y 向上） */
  houseRoot: THREE.Group;
  backend: 'WebGPU' | 'WebGL2';
  quality: Quality;
  setQuality(q: Quality): void;
  resize(w: number, h: number): void;
  /** 每帧调一次：有后处理时走后处理，否则直接渲染 */
  render(camera: THREE.Camera): void;
  /**
   * 在后台把场景里所有可见物体的渲染管线编好，包括镜头视锥外的（别的房间）。编给后处理场景 pass 的渲染目标
   * （格式和画布不同，编给画布的管线用不上）。three 的 compileAsync 逐个物体让出主线程，画面照常动；返回编完的 Promise
   */
  precompileAll(camera: THREE.Camera): Promise<void>;
  /** 后处理特效的触发口 */
  fx: {
    /** 暗角泛起一圈颜色再退去（吓跑瞬间用暗红） */
    vignettePulse(strength: number, color?: number): void;
    /**
     * 开场显影：progress 0 = 画面里只剩月光照亮的窗户和门廊灯，1 = 正常画面。origin 为光从哪里铺开
     * （房屋米坐标，默认前门外）。由镜头编排每帧驱动，fx 自己不做动画
     */
    setReveal(progress: number, origin?: Vec2): void;
  };
}

/** 镜头：娃娃屋的正交斜俯视（engine/camera.ts）或第三人称的透视（engine/ghostRig.ts） */
export interface CameraRig {
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  /** 0..3：方位角 = 45° + quarter × 90°。quarter = 0 时相机在房子东南方向往西北看 */
  readonly quarter: number;
  /** 相机在水平面上「从房子中心指向相机」的单位方向（房屋坐标）；旋转过渡中会连续变化 */
  readonly viewDir: Vec2;
  rotate(dir: 1 | -1): void;
  /** 乘法缩放，结果限制在 0.75–1.6 */
  zoom(factor: number): void;
  /**
   * 震动：往创伤值（0..1，加完封顶 1）里加 amount。创伤值每秒线性减 1，镜头按创伤值² 小角度地抖（只转不移），
   * 像摄影师被吓得手一缩。只有吓跑会调（juice.ts 的 TRAUMA.flee = 0.6，减少动态效果时再乘 0.55）；
   * 娃娃屋镜头满幅横滚 0.6°，吓跑那一下约 0.2°。2026-10-28 起惊吓、尖叫传染不再震，镜头也不再冲镜推近
   */
  shake(amount: number): void;
  /** 开场：镜头从高处、拉远的位置缓缓降到正常位置 */
  intro(seconds: number): void;
  /** quarter 改变时（旋转开始时）回调 */
  onRotate(cb: (quarter: number) => void): void;
  update(dt: number): void;
  resize(w: number, h: number): void;
  /** 房屋米坐标 → 屏幕像素坐标（相对画布左上角）；y 为高度（米）。透视镜头下点在镜头背后时 x、y 都是 NaN */
  toScreen(p: Vec2, y?: number): { x: number; y: number };
}
