// 访客角色模型。换吉祥物时只改这里：url、facing、clips
// 动画片段名写成 GLB 里的原名；没有的写 null（画面层会用程序化挤压回弹代替）

/**
 * 动画片段名（GLB 里的原名），没有的写 null：画面层会退回去（没有 look / afraid 就一直用 idle，没有 flee 就用 run，
 * 没有 scared2 就只用 scared），占位狐狸、备用小人照旧。
 *   idle / walk / run / scared  基本四个
 *   look     察觉（NpcState.notice 不为空）且停着时代替 idle
 *   afraid   紧张（nervous）且停着时代替 idle
 *   flee     逃跑（mode === 'fleeing'）时代替 run
 *   scared2  第二种受惊，和 scared 轮流用
 */
export interface CharacterClips {
  idle: string | null;
  walk: string | null;
  run: string | null;
  scared: string | null;
  look: string | null;
  afraid: string | null;
  flee: string | null;
  scared2: string | null;
}

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
  clips: CharacterClips;
  /** 走路动画在 1 米/秒时的播放速率，用来让步频和移动速度匹配（按归一化之后的实际大小量，见 dev/characters.html 的 calibrate()） */
  walkRateAt1ms: number;
  runRateAt1ms: number;
  /** 逃跑片段（flee）的同一个速率；不写就用 runRateAt1ms（flee 和 run 步频差得远的模型要单独量，量法见 loops） */
  fleeRateAt1ms?: number;
  /**
   * 片段里循环播放的区间 [起, 止]（秒）。片段本身不是循环的就要写：Tripo 的 flee_01 开头约 0.6 秒、结尾约 0.3 秒是站着，
   * 中间才是两步跑，整段循环会「站住—跑—站住」每 2.7 秒来一遍。只取中间一步跑的那一段循环（止点的姿势和起点的姿势对得上，接缝处不跳）。
   * 目前只有 flee 用。区间用 dev/characters.html 控制台的 __chars.loopWindow('flee_01') 找，
   * fleeRateAt1ms 用 __chars.calibrate()（它也按这个区间量）
   */
  loops?: Partial<Record<keyof CharacterClips, readonly [number, number]>>;
  /**
   * 量尺寸时先摆成待机片段的第一帧。Tripo 绑骨的模型静止姿势是 T 字，两臂张开把包围盒撑到 1.45 米宽：
   * 不摆的话 maxLength 会把整个人缩小，手电也会被放到身体侧面很远的地方
   */
  measureIdle?: boolean;
  /** 手电的高度（米，按 targetHeight 的身高）；不写用 FLASHLIGHT_HEIGHT */
  flashlightHeight?: number;
}

export const CHARACTER: CharacterSpec = {
  url: `${import.meta.env.BASE_URL}assets/mascot/placeholder-fox.glb`,
  targetHeight: 1.1,
  // 占位狐狸的身长是身高的 1.96 倍：按 1.1 米身高是 2.15 米长，转身、贴墙走时穿进墙和家具（2026-10-28 第二次试玩）。
  // 限到 1.4 米长，身高随之约 0.72 米。备用小人和以后的人形访客不受影响（身长远小于 1.4 米）
  maxLength: 1.4,
  facingOffset: 0, // 占位狐狸正面朝 +z（dev/characters.html 的 calibrate() 和脚下箭头都确认过）
  clips: { idle: 'Survey', walk: 'Walk', run: 'Run', scared: null, look: null, afraid: null, flee: null, scared2: null },
  // 下面两个由 dev/characters.html 的 __chars.calibrate() 量出：1.1 米身高（缩放 0.0139）时 Walk 片段原速脚相对身体后滑
  // 1.37 米/秒，Run 2.15 米/秒，即 0.73 / 0.47。限到 1.4 米身长后缩放是 0.00905（原来的 0.65 倍），步子按比例变短，
  // 速率乘 1 / 0.65 = 1.54
  walkRateAt1ms: 1.12,
  runRateAt1ms: 0.72,
};

/**
 * 换装吉祥物访客的片段名（四套是同一批 Tripo 预设动作，名字一样，见 public/assets/visitors/manifest.json 的 clips）。
 * 2026-10-28：流水线分两批 retarget（scripts/tripo/visitors.json 的 animate），Blender 精修把第二批并进同一个 GLB，一共 8 段
 */
const VISITOR_CLIPS: CharacterClips = {
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  scared: 'scared_01',
  look: 'look_around',
  afraid: 'afraid',
  flee: 'flee_01',
  scared2: 'scared_02',
};

/**
 * flee_01 的循环区间（四套一样：同一个预设，帧数相同；__chars.loopWindow('flee_01') 在四套里都挑出了这一段）：
 * 第 31 帧到第 52 帧（30 帧/秒）一步完整的跑，止点和起点的姿势只差 0.02 弧度（相邻两帧差 0.07），前后 0.1 秒的变化也对得上
 */
const FLEE_LOOP = [31 / 30, 52 / 30] as const;

/**
 * 换装吉祥物访客（scripts/Tripo 流水线 + Blender 精修产出的 public/assets/visitors/<id>.glb）。
 * 每个访客进门时按编号轮流分一套，相邻两个人穿得不一样。一个都加载不到时退回上面的 CHARACTER。
 * 片段名照 public/assets/visitors/manifest.json 里的 clips 填；facingOffset 和两个速率用 dev/characters.html 的 calibrate() 量
 */
export const VISITOR_SPECS: CharacterSpec[] = [
  {
    // 维多利亚吸血鬼（2026-10-28：P2 + 四视图 + Blender 精修，12247 三角面）
    url: `${import.meta.env.BASE_URL}assets/visitors/vampire.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    // 下面三个由 dev/characters.html?visitor=vampire 的 __chars.calibrate() 量出（按待机姿势量尺寸、身高 1.1 米）：正面朝 +x（1.566 / 1.575）
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 1.726,
    runRateAt1ms: 0.552,
    fleeRateAt1ms: 0.487, // flee_01 的循环区间（FLEE_LOOP）里脚相对身体后滑 2.055 米/秒
    measureIdle: true,
    // 球身的手在胯和球心之间：手电拿在球的下半截前面，不是举在胸口
    flashlightHeight: 0.6,
  },
  {
    // 提灯夜行的探险家（同上，12952 三角面）。calibrate()：正面 1.567 / 1.642
    url: `${import.meta.env.BASE_URL}assets/visitors/lantern-explorer.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 2.364,
    runRateAt1ms: 0.823,
    fleeRateAt1ms: 0.723,
    measureIdle: true,
    flashlightHeight: 0.6,
  },
  {
    // 女巫（同上，11417 三角面）。calibrate()：正面 1.555 / 1.578
    url: `${import.meta.env.BASE_URL}assets/visitors/witch.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 2.039,
    runRateAt1ms: 0.651,
    fleeRateAt1ms: 0.591,
    measureIdle: true,
    flashlightHeight: 0.6,
  },
  {
    // 手绘骷髅（同上，13577 三角面）。calibrate()：正面 1.588。腿最短，步子小、步频快（脚踝骨被放在鞋子中间，
    // calibrate 要放宽「贴地」的高度才认得出脚）
    url: `${import.meta.env.BASE_URL}assets/visitors/skeleton.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 3.467,
    runRateAt1ms: 1.428,
    fleeRateAt1ms: 1.105,
    measureIdle: true,
    flashlightHeight: 0.6,
  },
];

/**
 * 联名皮肤（JOJO：翠宝穿承太郎、DIO 的衣服）。流水线和精修参数同上面四套（scripts/tripo/visitors.json 的 jotaro、dio）。
 * 授权确认之前不进公开的访客轮换：只在地址带 ?collab 时并进 VISITOR_SPECS（dev/characters.html 也要带：?visitor=jotaro&collab）。
 * 两套的腿短、膝盖低：calibrate() 量 run、flee 时把小腿骨（LeftLeg，骨头位置在膝盖）也当成贴地的脚，膝盖不像脚那样贴地后滑，量出来偏了
 * （jotaro 1.094 / 0.684，dio 0.949 / 0.752）。run、flee 改用只算脚、脚尖四根骨头的量法（同样的贴地判断和中位数，Blender 里量；
 * 这个量法在吸血鬼、骷髅上和上面写的数只差 1%–3%）。walk 两种量法一样
 */
export const COLLAB_SPECS: CharacterSpec[] = [
  {
    // 承太郎装（P2 + 四视图 + Blender 精修，默认参数，12863 三角面）。calibrate()：正面 1.596 / 1.633 / 1.518
    url: `${import.meta.env.BASE_URL}assets/visitors/jotaro.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 2.78,
    runRateAt1ms: 0.847,
    fleeRateAt1ms: 0.849,
    measureIdle: true,
    flashlightHeight: 0.6,
  },
  {
    // DIO 装（同上，精修加 --trust arms：短袖跟着手臂，不然手垂下来袖子横着像翅膀；13356 三角面）。calibrate()：正面 1.595 / 1.599 / 1.547
    url: `${import.meta.env.BASE_URL}assets/visitors/dio.glb`,
    targetHeight: 1.1,
    maxLength: 1.4,
    facingOffset: Math.PI / 2,
    clips: VISITOR_CLIPS,
    loops: { flee: FLEE_LOOP },
    walkRateAt1ms: 2.152,
    runRateAt1ms: 0.718,
    fleeRateAt1ms: 0.665,
    measureIdle: true,
    flashlightHeight: 0.6,
  },
];

// node 里跑测试时没有 location：不并，测试看到的还是公开的四套
if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('collab')) VISITOR_SPECS.push(...COLLAB_SPECS);

/** 手电挂在角色身上的高度（米），按 targetHeight 的身高定；模型因 maxLength 变矮时按比例降低（占位狐狸约 0.52 米） */
export const FLASHLIGHT_HEIGHT = 0.8;
