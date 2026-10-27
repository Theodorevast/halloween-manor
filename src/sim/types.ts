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
export type NpcMode = 'entering' | 'wander' | 'alert' | 'startled' | 'fleeing' | 'gone';

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
  /** 当前移动速度（米/秒），画面用它选走 / 跑动画 */
  speed: number;
  /** > 0：正在尖叫，剩余秒数 */
  screaming: number;
  /** 当前路径的剩余路点（米坐标）。画面不用，调试用 */
  path: Vec2[];
}

export type ScareKind = 'lure' | 'sight';
export type ScareType = 'musicBox' | 'door' | 'lamp' | 'rockingChair' | 'portrait' | 'mirror';

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
}

export interface WorldState {
  /** 模拟时间（秒），hit-stop 期间不走 */
  time: number;
  npcs: NpcState[];
  objects: ScareObjectState[];
  /** 今晚吓跑的总人数 */
  scaredOff: number;
  /** > 0：hit-stop 剩余秒数，期间模拟暂停（渲染不停） */
  hitStop: number;
}

export type SimEvent =
  | { type: 'spawn'; npc: number }
  /** 玩家附身物件 */
  | { type: 'trigger'; object: string; scareType: ScareType }
  /** NPC 听到引诱声，转入警觉 */
  | { type: 'heard'; npc: number; object: string }
  /** NPC 被吓到。object 为 null 表示被别人的尖叫吓到 */
  | { type: 'startle'; npc: number; object: string | null; amount: number; scream: boolean }
  /** 恐惧值涨满，开始逃跑（同时触发 hit-stop） */
  | { type: 'flee'; npc: number }
  /** 走出前门。total = 今晚累计吓跑人数 */
  | { type: 'exit'; npc: number; name: string; total: number }
  /**
   * 鬼魂贴近带来的寒意（第三人称改版）。neck = true 时是「后颈一凉」的惊吓（贴得很近停留够久），
   * 否则是持续发毛的一小步。amount 为这一下涨的恐惧值
   */
  | { type: 'chill'; npc: number; amount: number; neck: boolean }
  /** 物件从「被破坏」状态复原（台灯亮回、肖像立回画架） */
  | { type: 'reset'; object: string };

export interface World {
  readonly state: WorldState;
  /** 推进 dt 秒（内部按 1/60 秒固定步长切分），返回期间产生的事件 */
  step(dt: number): SimEvent[];
  /** 玩家附身物件。冷却中或 id 不存在返回 false；成功时下一次 step 返回 trigger 事件 */
  trigger(objectId: string): boolean;
  /** 立刻放进一个访客（测试和调试用；正常游戏由生成器自动放）。默认在门外、状态 entering */
  spawn(opts?: SpawnOptions): NpcState;
  /**
   * 玩家操控的鬼魂在哪（房屋米坐标，第三人称模式每帧调一次）；null = 没有鬼魂（触屏的俯视模式）。
   * 访客看不见鬼魂，但鬼魂贴近时会发毛（2026-10-28 第三人称改版）
   */
  setGhost(pos: Vec2 | null): void;
}

export interface SpawnOptions {
  pos?: Vec2;
  personality?: Personality;
  name?: string;
  lookDir?: number;
  /** 默认 'entering'；给了 pos 时默认 'wander' */
  mode?: 'entering' | 'wander';
}

export interface WorldOptions {
  /** 随机数种子 */
  seed: number;
  /** 测试用：关掉自动生成访客 */
  autoSpawn?: boolean;
}
