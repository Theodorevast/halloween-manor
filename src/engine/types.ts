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

/** 第三人称镜头：仍然实现 CameraRig（rotate / punch 等对它可以是空操作），多一个鬼魂状态 */
export interface GhostRig extends CameraRig {
  readonly ghost: GhostState;
  /** 指针锁定后鼠标转向；开场点击时调用（必须在用户手势里） */
  lockPointer(): void;
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
  /** 后处理特效的触发口 */
  fx: {
    /** 暗角泛起一圈颜色再退去（吓跑瞬间用暗红） */
    vignettePulse(strength: number, color?: number): void;
    /**
     * 景深焦点。target 为房屋米坐标（opts.height 为离地高度，默认 0.8 米）；opts.strength 0..1 决定焦外虚化多强
     * （1 = 惊吓推近时的强度，悬停时用小一些的值）。传 null 回到常态：高画质下是常开的微缩景深，低画质下没有景深。
     * 焦点位置和强度在 fx 内部平滑过渡（opts.smoothTime 秒，默认 0.25），调用方可以每帧调也可以只在变化时调
     */
    focus(target: Vec2 | null, opts?: { height?: number; strength?: number; smoothTime?: number }): void;
    /**
     * 开场显影：progress 0 = 画面里只剩月光照亮的窗户和门廊灯，1 = 正常画面。origin 为光从哪里铺开
     * （房屋米坐标，默认前门外）。由镜头编排每帧驱动，fx 自己不做动画
     */
    setReveal(progress: number, origin?: Vec2): void;
  };
}

/** 正交斜俯视相机（engine/camera.ts 产出） */
export interface CameraRig {
  camera: THREE.OrthographicCamera;
  /** 0..3：方位角 = 45° + quarter × 90°。quarter = 0 时相机在房子东南方向往西北看 */
  readonly quarter: number;
  /** 相机在水平面上「从房子中心指向相机」的单位方向（房屋坐标）；旋转过渡中会连续变化 */
  readonly viewDir: Vec2;
  rotate(dir: 1 | -1): void;
  /** 乘法缩放，结果限制在 0.75–1.6 */
  zoom(factor: number): void;
  /**
   * 震动：往创伤值（0..1，加完封顶 1）里加 amount。创伤值每秒线性减 1，镜头按创伤值² 小角度地抖（只转不移），
   * 像摄影师被吓得手一缩。吓跑 0.6，惊吓 0.3–0.5，尖叫传染 0.25（juice.ts 的 TRAUMA）
   */
  shake(amount: number): void;
  /**
   * 冲镜：快速推近并偏向 target（房屋米坐标），停一下再缓缓退回。strength 0..1 决定推多近、偏多少。
   * 播放中再来一次：从当前位置平滑转向新目标；比画面上正在播的弱的忽略。返回这次是否被采用（被忽略时 false）
   */
  punch(target: Vec2, strength: number): boolean;
  /** 开场：镜头从高处、拉远的位置缓缓降到正常位置 */
  intro(seconds: number): void;
  /** quarter 改变时（旋转开始时）回调 */
  onRotate(cb: (quarter: number) => void): void;
  update(dt: number): void;
  resize(w: number, h: number): void;
  /** 房屋米坐标 → 屏幕像素坐标（相对画布左上角）；y 为高度（米） */
  toScreen(p: Vec2, y?: number): { x: number; y: number };
}
