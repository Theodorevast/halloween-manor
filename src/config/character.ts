// 访客角色模型。换吉祥物时只改这里：url、facing、clips
// 动画片段名写成 GLB 里的原名；没有的写 null（画面层会用程序化挤压回弹代替）

export interface CharacterSpec {
  url: string;
  /** 归一化后的身高（米） */
  targetHeight: number;
  /**
   * 身长（前后、左右里较长的那个）最多多少米：超过时整体再缩小，身高也跟着变矮。
   * 长身子的四足模型按身高缩放会太长，转身时头尾扫进墙和家具里；人形模型碰不到这个上限
   */
  maxLength: number;
  /** 模型自身的正面朝向，相对 +z 的偏转（弧度）。正面朝 +z 时为 0，朝 +x 时为 π/2 */
  facingOffset: number;
  clips: { idle: string | null; walk: string | null; run: string | null; scared: string | null };
  /** 走路动画在 1 米/秒时的播放速率，用来让步频和移动速度匹配（按归一化之后的实际大小量，见 dev/characters.html 的 calibrate()） */
  walkRateAt1ms: number;
  runRateAt1ms: number;
}

export const CHARACTER: CharacterSpec = {
  url: `${import.meta.env.BASE_URL}assets/mascot/placeholder-fox.glb`,
  targetHeight: 1.1,
  // 占位狐狸的身长是身高的 1.96 倍：按 1.1 米身高是 2.15 米长，转身、贴墙走时穿进墙和家具（2026-10-28 第二次试玩）。
  // 限到 1.4 米长，身高随之约 0.72 米。备用小人和以后的人形访客不受影响（身长远小于 1.4 米）
  maxLength: 1.4,
  facingOffset: 0, // 占位狐狸正面朝 +z（dev/characters.html 的 calibrate() 和脚下箭头都确认过）
  clips: { idle: 'Survey', walk: 'Walk', run: 'Run', scared: null },
  // 下面两个由 dev/characters.html 的 __chars.calibrate() 量出：1.1 米身高（缩放 0.0139）时 Walk 片段原速脚相对身体后滑
  // 1.37 米/秒，Run 2.15 米/秒，即 0.73 / 0.47。限到 1.4 米身长后缩放是 0.00905（原来的 0.65 倍），步子按比例变短，
  // 速率乘 1 / 0.65 = 1.54
  walkRateAt1ms: 1.12,
  runRateAt1ms: 0.72,
};

/**
 * 换装吉祥物访客（scripts/Tripo 流水线 + Blender 精修产出的 public/assets/visitors/<id>.glb）。
 * 每个访客进门时按编号轮流分一套，相邻两个人穿得不一样。一个都加载不到时退回上面的 CHARACTER。
 * 片段名照 public/assets/visitors/manifest.json 里的 clips 填；facingOffset 和两个速率用 dev/characters.html 的 calibrate() 量
 */
export const VISITOR_SPECS: CharacterSpec[] = [];

/** 手电挂在角色身上的高度（米），按 targetHeight 的身高定；模型因 maxLength 变矮时按比例降低（占位狐狸约 0.52 米） */
export const FLASHLIGHT_HEIGHT = 0.8;
