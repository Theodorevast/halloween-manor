// 访客（NPC）的参数（设计文档 1. 体验与玩法 /「访客」「节奏」「爽点」）
import type { Personality } from '../sim/types';

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
  /** 一次涨了这么多以上就尖叫 */
  screamAt: 15,
  /** 尖叫持续秒数 */
  screamTime: 1.1,
  /** 尖叫声能传多远（米） */
  screamRadius: 8,
  /** 听到别人尖叫，恐惧值增加多少 */
  contagion: 5,
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
  /** 警觉：走到离声源这么近、并且看得见声源的地方就停下查看（米），不贴到声源跟前——站远一点才看得见周围 */
  investigateDist: 1.5,
  /** 警觉查看时，手电以声源方向为中心左右扫的幅度（弧度）：扫一扫声源周围 */
  investigateSweep: 0.8,
  /** 闲逛时手电左右扫的幅度（弧度）和周期（秒） */
  sweepAmp: 0.6,
  sweepPeriod: 2.6,
  /** 身体和手电转向速度（弧度/秒） */
  turnRate: 5,
  /** 走到路点多近算到达（米） */
  arrive: 0.15,
  /** 走出前门后再走多远消失（米） */
  exitWalk: 1.2,
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
