// 访客（NPC）的参数（设计文档 1. 体验与玩法 /「访客」「节奏」「爽点」）
import type { NoticeKind, Personality } from '../sim/types';

export const PERSONALITIES: Record<Personality, { fearMult: number; weight: number }> = {
  timid: { fearMult: 1.5, weight: 30 },
  average: { fearMult: 1.0, weight: 45 },
  brave: { fearMult: 0.6, weight: 25 },
};

export const NAMES = [
  'Mia', 'Theo', 'Priya', 'Ollie', 'June', 'Sam', 'Nora', 'Leo',
  'Ada', 'Felix', 'Iris', 'Hugo', 'Maya', 'Ezra', 'Lena', 'Otis',
];

export const SPEED = { wander: 1.3, nervous: 1.7, alert: 1.1, flee: 3.2, enter: 1.2 };

export const FEAR = {
  max: 100,
  /** 连续这么多秒没被吓，开始回落 */
  decayDelay: 4,
  /** 每秒回落（原为 3：回落太快，一个人被吓到一半，走出房间就清零了，几乎吓不跑人。见 tests/balance.test.ts） */
  decayRate: 0.75,
  /** ≥ 这个值进入紧张 */
  nervous: 60,
  /** ≥ 这个值恐惧条变血红（只影响画面） */
  dread: 80,
  /**
   * 一次涨了这么多以上就尖叫。2026-10-28 15 → 25（设计文档 2.4）：尖叫只留给吓破胆的时候，其余的惊吓是僵住加倒吸一口气。
   * 现在 average 被摇椅（22）、台灯（18）吓到不叫，被肖像（32）、床（26）、镜子（48）吓到才叫；brave 只有镜子会叫
   */
  screamAt: 25,
  /**
   * true：这一下涨完恐惧值到了 dread（恐惧条变血红），哪怕只涨一点也尖叫——吓破胆了。
   * 用涨完的值：从 60 多被吓进 dread 的那一下也叫（那正是「吓破胆」的一刻）
   */
  screamDread: true,
  /** 尖叫持续秒数 */
  screamTime: 1.1,
  /** 尖叫声能传多远（米） */
  screamRadius: 8,
  /**
   * 听到别人尖叫，恐惧值增加多少（再乘性格倍率）。
   * 2026-10-28 5 → 7：screamAt 15 → 25 以后尖叫少了一大截，每一声的传染加重一点补回来。机器人实测（tests/balance.test.ts，
   * 5 个种子 × 5 分钟）：5 时 skilled 每局 10.4 人、第三人称中位存活 46 秒（离下限 45 只差 1 秒）；
   * 7 时 skilled 10.4 人、第三人称 49 秒、「鬼魂有用」余量 1.9；8 时「鬼魂有用」只剩 0.5。
   * 目标 4（单次附身吓不跑恐惧值为 0 的人）：72 + 2 × 7 × 1.5 = 93 < 100
   */
  contagion: 7,
  /** 受惊时僵住多久（秒，含跳起） */
  startleTime: 0.8,
  /** 第 n 次被同一种物件吓：效果 × habituation^(n-1) */
  habituation: 0.5,
  /**
   * 习惯化恢复：每过这么多秒，「被这种物件吓过的次数」减 1（连续恢复）；0 = 永不恢复。
   * 不恢复的话每个人能被吓到的总量有上限（brave 全部物件各吓一次也到不了 100），所以要恢复；
   * 15 秒内连着用同一种物件仍然会减半，鼓励换着吓
   */
  habituationRecover: 15,
};

export const VISION = {
  /** 手电光锥半角（弧度），视野就是光锥 */
  halfAngle: (30 * Math.PI) / 180,
  range: 7,
};

export const BEHAVIOR = {
  /** 闲逛到达后左右照的时长范围（秒） */
  lookAround: [2, 4] as [number, number],
  /** 警觉时到达声源后查看多久（秒） */
  investigate: 3,
  // 警觉时走到离声源多近停下查看：按性格，见 TRAITS.investigateDist（原来这里全员共用一个 1.5，2026-10-28 并过去了，只留一份）
  /** 警觉查看时，手电以声源方向为中心左右扫的幅度（弧度）：扫一扫声源周围 */
  investigateSweep: 0.8,
  /** 闲逛时手电左右扫的幅度（弧度）和周期（秒） */
  sweepAmp: 0.6,
  sweepPeriod: 2.6,
  /** 身体和手电转向速度（弧度/秒） */
  turnRate: 5,
  /** 被惊吓物件的蓄势「定住」时，转向它的速度是 turnRate 的几倍：比平时快，但不是一下子扭过去 */
  transfixTurn: 2.5,
  /** 走到路点多近算到达（米） */
  arrive: 0.15,
  /** 走出前门后再走多远消失（米） */
  exitWalk: 1.2,
};

/**
 * 察觉那一拍（2026-10-28 访客反馈，设计文档 2.1）：听到声音、手电照到鬼魂、开始发毛、现身蓄力时，
 * 访客减速停下，手电先转向来源，身体按平常速度跟上，盯着看一会儿，再按来源和性格决定下一步。
 * 受惊（startled）、逃跑中不触发
 */
export const NOTICE = {
  /** 盯着看多久（秒，随机），再乘性格的 noticeHold */
  hold: [0.5, 1.0] as [number, number],
  /** 察觉时手电转向的速度是 BEHAVIOR.turnRate 的几倍（手电先转，身体按平常速度跟上） */
  torchTurn: 2,
  /** 察觉中又来一个来源：优先级高的或一样高的接管 */
  priority: { manifest: 3, sound: 2, ghost: 1, chill: 0 } as Record<NoticeKind, number>,
};

/**
 * 性格差异（设计文档 2.5）。investigateDist：警觉时走到离声源这么近、并且看得见声源的地方就停下查看（米），
 * 不贴到声源跟前——站远一点才看得见周围；胆大的走得更近（原来全员共用 BEHAVIOR.investigateDist = 1.5，已并到这里）；
 * noticeHold：察觉盯着看的时长系数；chillRange：发毛范围（GHOST.radius 一类的距离）的系数；
 * recheck：被惊吓类物件吓过以后，再回头照一眼那个物件的几率（胆大的才有）
 */
export const TRAITS: Record<Personality, { investigateDist: number; noticeHold: number; chillRange: number; recheck: number }> = {
  timid: { investigateDist: 1.5, noticeHold: 1.5, chillRange: 1.2, recheck: 0 },
  average: { investigateDist: 1.5, noticeHold: 1, chillRange: 1, recheck: 0 },
  brave: { investigateDist: 0.8, noticeHold: 1, chillRange: 1, recheck: 0.5 },
};

/**
 * 走路的加减速（2026-10-28 第三人称改版：「动画生硬」——起步、停下、拐弯都不能一下子变速，
 * 画面的走路动画按 speed 调步频，速度连续它才接得上）。速度米/秒，加速度米/秒²。
 * 受惊僵住、被蓄势的惊吓物件定住仍然是一下子停住（那是吓呆了，见 npc.ts 的 freeze）
 */
export const MOTION = {
  /** 起步加速度：0 → 1.3 米/秒约 0.5 秒 */
  accel: 2.6,
  /** 逃跑起步：0 → 3.2 米/秒约 0.5 秒 */
  fleeAccel: 6.5,
  /** 平常减速（快到终点、拐弯前、发毛放慢、回头张望前停下） */
  decel: 3,
  /** 来不及时的急刹（前面突然有人、新路线比刹车距离还短）：快，但仍不是一下子停住 */
  hardDecel: 8,
  /** 快到拐角前多少秒开始转身（身体朝向渐渐转向下一段路，到拐角时正好转一半） */
  anticipate: 0.3,
  /** 拐角处限速 = 巡航速度 × cos(拐角 / 2)，但不低于这个比例（掉头时） */
  cornerMin: 0.35,
};

/**
 * 访客之间互相避让（2026-10-28 第三人称改版：「穿模」）。距离都是两人中心之间（米）。
 * 做法：迎面 / 交叉时提前侧身（正对面时各自靠右）；前面有人就跟着走或停下；站着的人被挤开一点；
 * 被挡住没有进展就绕开挡路的人重新寻路，绕不开就换个打算。1 米宽的门洞里正好容得下两条道（见 wallGap）
 */
export const CROWD = {
  /** 身体不重叠：两人中心至少隔这么远 */
  minDist: 0.55,
  /** 舒适距离：比这近就互相让开一点；跟在别人后面时也停在这个距离 */
  comfort: 0.8,
  /** 被挤开的最大速度 */
  pushSpeed: 0.6,
  /** 看多远以内的人 */
  sense: 3,
  /** 预判多少秒：照现在的速度走下去，这段时间里最近会比 passDist 近，就提前侧身 */
  horizon: 1.5,
  passDist: 0.75,
  /** 预判的最近点横向偏差小于这个值算「正对面」：各自靠右 */
  keepRight: 0.05,
  /** 侧身让路的最大横向速度、横向（含被挤开）的加速度 */
  sideSpeed: 0.7,
  sideAccel: 3,
  /**
   * 侧身、被挤开时离不能走的格子至少多远：门洞宽 1 米，两条道的中心最多隔 1 − 2 × 0.2 = 0.6 米 > minDist，
   * 迎面的两个人在门洞里也错得开
   */
  wallGap: 0.2,
  /** 逃跑的人挤别人时的力度倍数、自己被挤时的倍数（慌不择路，别人给他让路） */
  fleeShove: 1.5,
  fleeResist: 0.3,
  /**
   * 想走却没有进展（剩下的路程不减少）多久算「被挡住」：挡路的人先走（逃跑中、站着不动、id 更小）时等 stuckShort 秒，
   * 否则等 stuckLong 秒（迎面僵持时总有一方先让），然后绕开挡路的人重新寻路
   */
  stuckShort: 0.8,
  stuckLong: 2,
  /** 被挡住时离终点不到这么远，就当作到了（别人正站在自己要去的地方） */
  closeEnough: 1.2,
};

/**
 * 鬼魂贴近（2026-10-28 第三人称改版，设计文档第 9 节「新玩法」）。访客看不见鬼魂，但它贴近时会发毛：
 * 恐惧值慢慢上涨（每 chillEvery 秒结算一小步，发 chill 事件）、走慢；
 * 贴得很近停留够久是一次「后颈一凉」的惊吓。逃跑中的人不理会鬼魂；setGhost(null)（触屏的俯视模式）时全都不生效。
 * 2026-10-28 访客反馈（设计文档 2.2）：原来的随机回头张望去掉了，改成确定的反应——进入范围 onset 秒内察觉一次（回头照一下），
 * 一直贴着就按程度递进：发抖 → 发毛到 backAt 后退半步、手电照着背后 → 后颈一凉。发毛范围按性格乘 TRAITS.chillRange。
 * 平衡见 tests/balance.test.ts 的「鬼魂」两条：只靠鬼魂吓不跑 brave，配合附身有帮助但不能一边倒
 */
export const GHOST = {
  /** 多近开始发毛（米）；GHOST.full 米以内是满强度，往外线性减到 radius 处为 0 */
  radius: 1.5,
  full: 0.5,
  /** 隔着墙（没有视线，鬼魂能穿墙）时，上面两个距离和 neckRadius 都乘这个系数 */
  wallFactor: 0.6,
  /** 鬼魂在正前方时的强度是正后方的几倍（中间按 (1 − cos) / 2 过渡）：看不见它，背后才最瘆人 */
  front: 0.35,
  /** 满强度时恐惧值每秒涨多少（再乘性格倍率和发毛的习惯化） */
  rate: 2,
  /** 每隔多久结算一次、发一个 chill 事件（秒）：不是每步都发 */
  chillEvery: 0.7,
  /**
   * 一步发毛至少涨这么多，才算「被吓」、让回落重新计时（FEAR.decayDelay）；
   * 隔得远、或者已经习惯了，这一点点寒意不会让恐惧值一直不回落
   */
  holdMin: 0.3,
  /**
   * 发毛的习惯化：每受满 habitPer 秒的满强度发毛，之后的发毛再减半（系数 FEAR.habituation）；
   * 鬼魂不在身边时每 habitRecover 秒恢复一次。一直贴着同一个人，发毛涨的总量有上限：
   * rate × habitPer / ln(1 / FEAR.habituation) × 性格倍率（habituation = 0.5 时 average 约 23，brave 约 14，timid 约 35）
   */
  habitPer: 8,
  habitRecover: 15,
  /** 发毛程度（0–1，放慢、后退、画面发抖用）每秒最多升 / 降多少 */
  rise: 2.5,
  fall: 1,
  /** 发毛到满时走路速度 × (1 − slow) */
  slow: 0.35,
  /** 后颈一凉：鬼魂在 neckRadius 米内累计停留 neckDwell 秒；离开时累计的停留每秒回落 neckDecay 秒（短暂离开不清零） */
  neckRadius: 0.8,
  neckDwell: 2,
  neckDecay: 1,
  /**
   * 后颈一凉的基础恐惧值（再乘性格倍率；习惯化和物件一样，按「被这一种吓过几次」算，见 FEAR.habituation）。
   * 12：average 倒吸一口气不尖叫（< FEAR.screamAt）；timid 18，FEAR.screamAt 改成 25 以后也不叫了（恐惧值到 dread 以后才叫）。
   * 机器人实测（2026-10-28，鬼魂一直贴在身后 0.5 米、不附身，4 分钟）：恐惧值最高 brave 约 26、average 约 53、timid 约 87；
   * 原定 14 时 timid 到了 99，差一点就只靠鬼魂吓跑
   */
  neckFear: 12,
  /** 每人被吹过一次后多久（秒）内不再累计停留 */
  neckCooldown: 8,
  /** 进入发毛范围后多久内一定有反应（秒）：停一下、回头照一下 */
  onset: 0.5,
  /** 发毛到这个程度还贴着：后退半步、手电一直照着背后 */
  backAt: 0.7,
  /** 鬼魂穿墙声能被多远的访客听见（米）、听见涨多少恐惧值 */
  hearWall: 3,
  hearFear: 2,
};

/**
 * 主动现身（2026-10-28，设计文档 3.2）：右键或 F。蓄力 windup 秒（附近的访客察觉、灯暗下来）→ 落下（结算谁被吓到）→
 * 停留 hold 秒（鬼魂几乎不动）→ 收回，进入冷却。克制：不扑过来、不变大、不说话。
 * 被吓到的恐惧值 = fear × 距离系数 × 正中系数 × 在光里 × 性格倍率 × 习惯化（按 'manifest' 这一种算）
 */
export const MANIFEST = {
  windup: 0.6,
  hold: 1.5,
  cooldown: 18,
  /** 落下时看得见鬼魂的最远距离（米） */
  range: 6,
  fear: 30,
  /** 距离系数：near[0] 米内 nearMult[0]，near[1] 米处 nearMult[1]，中间线性 */
  near: [1, 6] as [number, number],
  nearMult: [1.3, 0.6] as [number, number],
  /** 正中系数：光锥正中 center[0]，光锥边上 center[1] */
  center: [1.2, 0.9] as [number, number],
  /** 鬼魂被这个人的手电照着时再乘 */
  lit: 1.25,
  /** 蓄力时多远内的访客会察觉（米） */
  noticeRadius: 5,
  /** 被吓到的人：后退到离鬼魂至少 backOff 米，之后 avoidTime 秒内绕开 avoidRadius 米的圆 */
  backOff: 1.5,
  avoidRadius: 2.5,
  avoidTime: 20,
};

/**
 * 机关（2026-10-28，设计文档 4.2）：对着物件按住左键设下，访客走进范围时等个时机自动触发。
 * 同时最多 max 个；设下 expire 秒还没触发就自动解除；恐惧值 × fearMult，冷却照常
 */
export const TRAP = {
  /** 按住多久算「设下」（秒；picking.ts 用） */
  holdToArm: 0.5,
  max: 2,
  expire: 60,
  /** 背后型：物件在访客背后这么远（米）时开始蓄势 */
  behind: [1.5, 3] as [number, number],
  /** 进入范围后最多等多久挑时机（秒） */
  wait: 1.5,
  fearMult: 0.9,
};

export const SPAWN = {
  /** 屋里少于这么多人就安排下一个访客 */
  target: 3,
  /** 安排后多久进门（秒） */
  delay: [8, 15] as [number, number],
  /** 开局第一个访客进门的时间（秒） */
  first: 2,
  /** 开局阶段每隔多久进一个，直到 target 人 */
  stagger: 6,
};

/** 吓跑瞬间的 hit-stop 时长（秒） */
export const HIT_STOP = 0.15;
