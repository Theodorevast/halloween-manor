// 可附身物件的参数表（设计文档 1. 体验与玩法 /「可附身物件」）
import type { ScareKind, ScareType } from '../sim/types';

export interface ScareSpec {
  kind: ScareKind;
  /** 引诱：听得见的距离；惊吓：能被吓到的最远距离（米） */
  range: number;
  /** 基础恐惧值（再乘性格倍率和习惯化系数） */
  fear: number;
  /** 冷却（秒） */
  cooldown: number;
  /** 生效窗口（秒）：惊吓类在这段时间内被看见就生效；引诱类即声音持续时长 */
  active: number;
  /**
   * 惊吓类：触发后过多久惊吓才真正「落下」（秒），从这一刻起到 active 结束才判定谁被吓到。
   * 取自物件动画的高潮时刻（src/view/props/*.ts 的时间轴），让访客的受惊、尖叫和画面上最吓人的瞬间同步，
   * 而不是鬼脸还没出来人就先跳了。引诱类在触发那一步结算，不用这个值
   */
  hitAt: number;
  /** 触发后进入「被破坏」状态多久再复原（秒）；0 = 没有这个状态 */
  broken: number;
}

/**
 * 衣柜的时间轴（秒，从 trigger 算起；调研 3.3 的 A 版「被从里面拉上」）。画面（view/props/wardrobe.ts）和声音（audio/sfx.ts）都读这里，
 * 不各抄一份：
 * - latch：柜子里「咔哒」一声（锁舌），门板轻轻一震，像有人从里面推了一下
 * - open：门自己慢慢开出一条缝，到 openDeg 度（先快后慢，停住，不回弹、不晃），配一声长长的合页吱呀
 * - hold：停住，没有声音（看着它的访客被定住，手电照着门缝）
 * - slamAt（SCARES.wardrobe.hitAt 就用它）：门猛地合上，slamTime 秒合完；一声闷响加锁舌，柜顶落灰，低频冲击
 * - fingersChance：variant（trigger 事件）小于它时，合上之前先有几根苍白的手指从门缝里扶住门边（fingers 时段），看不见手后面连着什么
 * - settle：合上以后多久灰落完、环境声回来
 */
export const WARDROBE = {
  latch: [0, 0.3] as const,
  open: [0.3, 1.6] as const,
  openDeg: 25,
  hold: [1.6, 2.2] as const,
  slamAt: 2.2,
  slamTime: 0.12,
  fingersChance: 1 / 3,
  fingers: [1.7, 2.2] as const,
  settle: 5,
};

export const SCARES: Record<ScareType, ScareSpec> = {
  musicBox: { kind: 'lure', range: 7, fear: 4, cooldown: 14, active: 4, broken: 0, hitAt: 0 },
  door: { kind: 'lure', range: 9, fear: 10, cooldown: 10, active: 0.6, broken: 0, hitAt: 0 },
  // 台灯一触发就开始闪；摇椅第一次摆到头（0.25 秒，第一声嘎吱）；肖像砸到地上（0.94 秒）；镜中脸扑出（0.6 秒）；
  // 床：被子下面慢慢鼓起一个人形、起伏，2.6 秒时一下子塌平（设计文档 4.1）；蓄势这 2.6 秒里看见它的人被定住盯着
  lamp: { kind: 'sight', range: 6, fear: 18, cooldown: 8, active: 1.5, broken: 6, hitAt: 0 },
  rockingChair: { kind: 'sight', range: 6, fear: 22, cooldown: 10, active: 3, broken: 0, hitAt: 0.25 },
  portrait: { kind: 'sight', range: 6, fear: 32, cooldown: 16, active: 1.8, broken: 10, hitAt: 0.94 },
  mirror: { kind: 'sight', range: 2.5, fear: 48, cooldown: 20, active: 1.5, broken: 0, hitAt: 0.6 },
  bed: { kind: 'sight', range: 5, fear: 26, cooldown: 14, active: 3.2, broken: 0, hitAt: 2.6 },
  // 衣柜（2026-10-29，设计文档 4.3、调研 3.3）：门自己开一条缝、停住，2.2 秒时被从里面猛地拉上。按机器人测（lane Q1）：
  // 恐惧值 17（average 倒吸一口气不叫、timid 叫，比床轻：卧室里已经有床和台灯）、冷却 20。恐惧值 23 以上时单个 brave 吓得太快，
  // 「单个 brave 加鬼魂中位 ≤ 0.8 × 不加」过不了；冷却 14–17 时正常对局被吓跑的人中位存活短 2–4 秒。range 4–6、active 2.5–3.2
  // 机器人测出来的数字一样，先留原值。机器人还没把它当机关用，见 tests/bots.ts 的 TRAP_TYPES
  wardrobe: { kind: 'sight', range: 5, fear: 17, cooldown: 20, active: 2.8, broken: 0, hitAt: WARDROBE.slamAt },
};


/** 引诱声隔着墙（声源和听者之间没有视线）时，听得见的距离乘这个系数 */
export const WALL_HEARING_FACTOR = 0.6;
