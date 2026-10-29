// 模拟层的共享类型。模拟层（src/sim/）是纯 TypeScript，不引用 three.js；
// 画面、声音、界面只读 WorldState、订阅 SimEvent，不直接改模拟状态。
// 坐标是房屋米坐标（x 向东、z 向南），角度约定见 src/lib/angle.ts。

export interface Vec2 { x: number; z: number }

export type Personality = 'timid' | 'average' | 'brave';

/**
 * wander   闲逛：挑一个别的房间走过去，到了左右照一照
 * alert    警觉：听到声音，走到声源旁查看
 * startled 受惊：僵住、跳起，结束后回到之前的状态
 * fleeing  逃跑：冲向前门
 * entering 进门：从门外走进门厅
 * gone     已离开（下一步从 npcs 里移除）
 */
/**
 * leaving（2026-10-30「一夜」的天亮）：不是被吓跑，是天快亮了自己走：按走路的速度走到前门出去（exit 事件带 calm）。
 * 路上照样能被吓到（吓到就改成 fleeing）
 */
export type NpcMode = 'entering' | 'wander' | 'alert' | 'startled' | 'fleeing' | 'leaving' | 'gone';

/** 察觉的来源：声音（引诱、尖叫、鬼魂穿墙声）、手电照到鬼魂、开始发毛、现身蓄力 */
export type NoticeKind = 'sound' | 'ghost' | 'chill' | 'manifest';

/** 察觉那一拍（2026-10-28 访客反馈，设计文档 2.1）：停下、手电先转向来源、盯着看一会儿 */
export interface NoticeState {
  kind: NoticeKind;
  /** 来源位置（房屋米坐标） */
  src: Vec2;
  /** 已经察觉了多久（秒） */
  t: number;
  /** 一共要盯多久（秒，已乘性格系数） */
  hold: number;
}

export interface NpcState {
  id: number;
  name: string;
  personality: Personality;
  pos: Vec2;
  /** 身体朝向（方向角） */
  heading: number;
  /** 手电朝向（方向角）。视野就是手电光锥 */
  lookDir: number;
  mode: NpcMode;
  /** 当前状态已持续的秒数 */
  modeTime: number;
  /** 0–100 */
  fear: number;
  /** fear ≥ 60：走得更快，手电抖动 */
  nervous: boolean;
  /**
   * 当前移动速度（米/秒），画面用它选走 / 跑动画。就是这一步实际挪动的距离 / 步长（含侧身让路、被挤开），
   * 起步、停下、拐弯时连续变化（加减速见 config/visitors.ts 的 MOTION）
   */
  speed: number;
  /** > 0：正在尖叫，剩余秒数 */
  screaming: number;
  /** 当前路径的剩余路点（米坐标）。画面不用，调试用 */
  path: Vec2[];
  /**
   * 鬼魂贴近带来的发毛程度（0–1，平滑过的，第三人称改版）：画面可以拿来发抖，声音拿来加一层寒意。
   * 模拟层每步都写；没有鬼魂（setGhost(null)）时恒为 0。可选只是为了不打扰手写 NpcState 的调试页
   */
  uneasy?: number;
  /**
   * 正在察觉（那一拍）：停下、手电先转向来源、盯着看；null = 没有。
   * 画面、调试用（身体和手电的朝向本来就在 heading / lookDir 里）。可选的理由同 uneasy
   */
  notice?: NoticeState | null;
}

export type ScareKind = 'lure' | 'sight';
export type ScareType = 'musicBox' | 'door' | 'lamp' | 'rockingChair' | 'portrait' | 'mirror' | 'bed' | 'wardrobe';

export interface ScareObjectState {
  id: string;
  type: ScareType;
  pos: Vec2;
  facing: number;
  /** 剩余冷却秒数，0 = 可以附身 */
  cooldown: number;
  /** 剩余生效窗口秒数（> 0 时惊吓表现正在播放） */
  active: number;
  /** 物件处于「被破坏」状态的剩余秒数：台灯熄灭、肖像倒在地上。0 = 正常 */
  broken: number;
  /** 此刻能看见它的 NPC id（引诱类物件为空数组） */
  seenBy: number[];
  /** 机关：设下后的剩余秒数，0 = 没有设下 */
  armed: number;
}

/**
 * idle     没在现身
 * windup   蓄力：附近的访客察觉、灯暗下来
 * hold     落下以后停留：鬼魂几乎不动
 * cooldown 收回以后的冷却
 */
export type ManifestPhase = 'idle' | 'windup' | 'hold' | 'cooldown';

/** 主动现身的状态（右键 / F，2026-10-28，设计文档 3.2） */
export interface ManifestState {
  phase: ManifestPhase;
  /** 这一段已经过了多久（秒） */
  t: number;
  /** 剩余冷却（秒），0 = 可以现身 */
  cooldown: number;
  /** 现身的位置（蓄力开始时鬼魂所在处）；idle 时为 null */
  pos: Vec2 | null;
}

/**
 * 访客暂时绕开的地方（看见现身以后），寻路时这里的格子代价很高。until 是模拟时刻（和 WorldState.time 同一个钟）。
 * who：谁绕开——被这一次现身吓到的人（manifest drop 事件的 scared）；没看见的人照常走（用户 2026-10-29 定的）
 */
export interface AvoidZone { pos: Vec2; r: number; until: number; who: number[] }

export interface WorldState {
  /** 模拟时间（秒），hit-stop 期间不走 */
  time: number;
  npcs: NpcState[];
  objects: ScareObjectState[];
  /** 今晚吓跑的总人数 */
  scaredOff: number;
  /** > 0：hit-stop 剩余秒数，期间模拟暂停（渲染不停） */
  hitStop: number;
  /** 主动现身：到哪一段了、冷却还剩多久、在哪里现身 */
  manifest: ManifestState;
  /** 访客暂时绕开的地方（看见现身以后）；每个圈只有被那一次吓到的人（who）绕 */
  avoid: AvoidZone[];
}

/**
 * 「后颈一凉」那次 startle 的 object：不是物件 id，state.objects 里找不到它。
 * 按 id 找物件的消费者要能接受找不到（2026-10-28 时 src/ 里现有的都已经判空）
 */
export const GHOST_SOURCE = 'ghost';

export type SimEvent =
  /** last：收夜（World.close）时屋里没人，最后再放进来的那一位（播报 "{name} is the last to arrive."） */
  | { type: 'spawn'; npc: number; last?: boolean }
  /** 玩家附身物件 */
  /**
   * variant：这一次附身的随机数（0..1，模拟每次都给）。画面和声音按它挑同一个变体，两边一致，比如衣柜 A 版里
   * WARDROBE.fingersChance 的时候先有几根手指扶住门边。可选只是为了不打扰手写事件的开发页、测试（没有当 0）
   */
  | { type: 'trigger'; object: string; scareType: ScareType; variant?: number }
  /** NPC 听到引诱声，转入警觉 */
  | { type: 'heard'; npc: number; object: string }
  /**
   * NPC 被吓到（僵住、够多就尖叫）。object 是物件 id；为 null 表示被别人的尖叫吓到（这种不僵住）；
   * 为 GHOST_SOURCE 表示鬼魂贴着后颈吹了一口凉气（同一步前面有一个 neck: true 的 chill，amount 是同一笔，别加两次）
   */
  | { type: 'startle'; npc: number; object: string | null; amount: number; scream: boolean }
  /** 恐惧值涨满，开始逃跑（同时触发 hit-stop） */
  | { type: 'flee'; npc: number }
  /** 走出前门。total = 今晚累计吓跑人数 */
  /** calm：天亮自己走的（World.dawn），不算吓跑，total 不加 */
  | { type: 'exit'; npc: number; name: string; total: number; calm?: boolean }
  /**
   * 鬼魂贴近带来的寒意（第三人称改版）。neck = true 时是「后颈一凉」的惊吓（贴得很近停留够久），
   * 紧跟着同一步有一个 object = GHOST_SOURCE 的 startle；
   * 否则是持续发毛的一小步（鬼魂在身边时约每 GHOST.chillEvery 秒一个）。amount 为这一下涨的恐惧值
   */
  | { type: 'chill'; npc: number; amount: number; neck: boolean }
  /** 物件从「被破坏」状态复原（台灯亮回、肖像立回画架） */
  | { type: 'reset'; object: string }
  /** 访客察觉那一拍开始（或被优先级更高的新来源接管）：来源的种类和位置 */
  | { type: 'notice'; npc: number; kind: NoticeKind; src: Vec2 }
  /** 某个访客的手电开始 / 不再照着鬼魂（只显形、不吓人） */
  | { type: 'reveal'; npc: number; on: boolean }
  /** 现身：windup 蓄力开始、drop 落下（scared = 被吓到的人）、end 收回 */
  | { type: 'manifest'; phase: 'windup' | 'drop' | 'end'; pos: Vec2; scared: number[] }
  /**
   * 机关：armed 设下、sprung 触发、expired 设下后一直没触发、到时间自动解除（到了时机却附身不了时也按 expired 作废，见 world.ts 的 fireTrap）。
   * 玩家直接附身设下的物件、让机关跟着作废时不发事件（最终审查 S M3）：机关状态以 ScareObjectState.armed 为准，
   * 画面（霜、空心眼睛、悬停标签）都每帧读它，不靠这个事件
   */
  | { type: 'trap'; object: string; phase: 'armed' | 'sprung' | 'expired' };

/** setGhost 的参数：鬼魂在哪、此刻是不是在墙里（穿墙声）。只给 { x, z } 也行 */
export interface GhostInput { x: number; z: number; inWall?: boolean }

export interface World {
  readonly state: WorldState;
  /** 推进 dt 秒（内部按 1/60 秒固定步长切分），返回期间产生的事件 */
  step(dt: number): SimEvent[];
  /** 玩家附身物件。冷却中或 id 不存在返回 false；成功时下一次 step 返回 trigger 事件 */
  trigger(objectId: string): boolean;
  /** 立刻放进一个访客（测试和调试用；正常游戏由生成器自动放）。默认在门外、状态 entering */
  spawn(opts?: SpawnOptions): NpcState;
  /** 主动现身。没有鬼魂、冷却中、正在现身、鬼魂中心所在的格子挡视线（墙、窗）时返回 false（什么都不发生、不进冷却）；成功时下一次 step 返回 manifest windup */
  manifest(): boolean;
  /** 设机关。物件不存在、冷却中、已经设下、同时设下的已满时返回 false */
  arm(objectId: string): boolean;
  /**
   * 玩家操控的鬼魂在哪（房屋米坐标，第三人称模式每帧调一次）；null = 没有鬼魂（触屏的俯视模式）。
   * inWall：此刻是不是在墙里（鬼魂穿墙声，访客在 GHOST.hearWall 米内听得见）。
   * 访客看不见鬼魂，但鬼魂贴近时会发毛（2026-10-28 第三人称改版）
   */
  setGhost(g: GhostInput | null): void;
  /**
   * 收夜（2026-10-30「一夜」）：之后不再安排新访客（已经排上、还没进门的那一次取消）。调的那一刻屋里没人（都走了或都在逃跑），
   * 就最后再放一位进来（spawn 事件带 last）。屋里的人照常闹，没有时限
   */
  close(): void;
  /** 收夜以后玩家选 Keep haunting：照常补人（和开局之后一样，按 SPAWN.delay 一个一个来） */
  reopen(): void;
  /**
   * 天亮（2026-10-30：用户要「5 分钟内能玩完的完整游戏」）：屋里还没走的人（不在逃跑的）都改成 leaving，按走路的速度出前门，
   * 出门时 exit 事件带 calm。不再有人进来（等于先 close）
   */
  dawn(): void;
}

export interface SpawnOptions {
  pos?: Vec2;
  personality?: Personality;
  name?: string;
  lookDir?: number;
  /** 默认 'entering'；给了 pos 时默认 'wander' */
  mode?: 'entering' | 'wander';
  /** 测试和调试用：生成后先寻路走到这里（闲逛状态，到了再左右照）；给了它就不看 mode */
  goal?: Vec2;
}

export interface WorldOptions {
  /** 随机数种子 */
  seed: number;
  /** 测试用：关掉自动生成访客 */
  autoSpawn?: boolean;
  /**
   * 开局几个访客之间隔多久进门（秒，第一个仍在 SPAWN.first）。不给就是原来的 SPAWN.stagger：机器人、平衡测试都不给，数字不变。
   * 正式游戏给 NIGHT.openingGaps（第一个人独自进来，过一会儿才有第二个敲门）
   */
  openingGaps?: number[];
}
