// 访客角色模型。换吉祥物时只改这里：url、facing、clips
// 动画片段名写成 GLB 里的原名；没有的写 null（画面层会用程序化挤压回弹代替）

export interface CharacterSpec {
  url: string;
  /** 归一化后的身高（米） */
  targetHeight: number;
  /** 模型自身的正面朝向，相对 +z 的偏转（弧度）。正面朝 +z 时为 0，朝 +x 时为 π/2 */
  facingOffset: number;
  clips: { idle: string | null; walk: string | null; run: string | null; scared: string | null };
  /** 走路动画在 1 米/秒时的播放速率，用来让步频和移动速度匹配 */
  walkRateAt1ms: number;
  runRateAt1ms: number;
}

export const CHARACTER: CharacterSpec = {
  url: `${import.meta.env.BASE_URL}assets/mascot/placeholder-fox.glb`,
  targetHeight: 1.1,
  facingOffset: 0,
  clips: { idle: 'Survey', walk: 'Walk', run: 'Run', scared: null },
  walkRateAt1ms: 1,
  runRateAt1ms: 0.4,
};

/** 手电挂在角色身上的高度（米） */
export const FLASHLIGHT_HEIGHT = 0.8;
