// 一夜（2026-10-30「一夜」）：给一局一个收尾。到点收夜（不再有人来、门廊灯慢慢熄），到点天亮（屋里没被吓走的人自己出门），
// 屋里没人、前门关上以后：静一会儿 → 光从屋里收回前门 → 翻开访客登记簿；Keep haunting 再来一夜，Another night 重新载入。
// 不加目标、不计分、没有失败。时刻和长度见 config/night.ts 的 NIGHT（?night=<分钟> 另给，见 debug.ts 的 nightTiming）。
//
// 纯逻辑：不碰 DOM、three、WebAudio。main.ts 把模拟、播报、门廊灯和天亮的光（house.ts）、显影（cinematic.ts）、环境层（audio）、
// 登记簿、前门接进 NightDeps；tests/night-controller.test.ts 用替身直接测。
//
// 两个钟
//   - 收夜、天亮看模拟时间（WorldState.time，从这一夜开始算）：hit-stop 期间不走，?debug 的 step、setTimeScale 能快进，冒烟测试测得到；
//     Keep haunting 以后从那一刻重新算（下一次 +length 收夜、+dawn 天亮）
//   - 收尾的静、光收回看真实时间（每帧的 dt，主循环已经限制在 0.1 秒以内）：标签页切走时主循环停了，这里也停，回来接着走，不跳
// 边角
//   - 最后一个人正在 hit-stop 里 / 到点那一步正好有人被吓跑：逃跑中（天亮自己走的也一样）的人还在 state.npcs 里，出了门才删，
//     收尾等他出门、门关上。那一刻屋里没人（都走了或都在逃跑）时模拟自己放最后一位进来（World.close 的约定，spawn 带 last）
//   - 静、光收回的这几秒里屋里又有人了（调试放的人，或者模拟晚一步才放进来的最后一位）：作罢，环境层回来、光收回过的话再铺开，接着等
//   - 天亮比收夜先到（?night 调出来的极端值）：先收夜再天亮。一下快进过两个时刻：同一帧里先收夜后天亮
//   - 登记簿开着的时候模拟照走（和 Esc 放开鼠标时一样不暂停）：收夜那一页上屋里是空的、也不会再有人来，天亮的时刻过了也不再做事
//   - 减少动态效果：门廊灯、天亮的光、光收回、重新铺开都直接切；光收回那一段不等（静的那两秒是声音，照旧）
import { NIGHT } from './config/night';
import { STRINGS } from './config/strings';
import type { FrameCtx, Module } from './engine/types';
import type { SimEvent, World, WorldState } from './sim/types';

/**
 * 收尾和 Keep haunting 的表现参数（时刻、长度在 config/night.ts 的 NIGHT）。
 * 环境层是线性增益：hush 0.18 ≈ −15 dB，持续音和风还隐约在（房子还在），但静下来了；完全静音像是卡住了
 */
export const NIGHT_FX = {
  /** 前门开着不到这么多（frontDoor.openness，0 = 关上、1 = 全开）就算关上了 */
  doorShut: 0.02,
  /** 收尾时环境层压到多少（线性增益），在 NIGHT.closing 的静 + 光收回这段时间里慢慢压下去 */
  hush: 0.18,
  /** Keep haunting 以后环境层回来用几秒 */
  ambienceBack: 4,
  /** 天亮的光起来用几秒（house.ts 的 setDawn；smoothstep，慢、克制，最后几位出门前走完）；Keep haunting 以后退回夜里用几秒 */
  dawnLight: 30,
  dawnBack: 4,
  /** Keep haunting：光从前门重新铺开用几秒（和开场一样长） */
  spread: 2.5,
};

/**
 * night    夜里：还没到收夜
 * closed   收夜了：不再有人来，门廊灯在熄，等屋里的人走光、前门关上（天亮可能在这一段到）
 * silence  屋里没人、门关上了：静一会儿，环境层慢慢压下去
 * retreat  光从屋里收回前门（开场显影倒着放）
 * register 收夜那一页登记簿翻开着：等 Keep haunting / Another night
 */
export type NightPhase = 'night' | 'closed' | 'silence' | 'retreat' | 'register';

/** 一夜多长：length 秒收夜、dawn 秒天亮（模拟时间，从这一夜开始算） */
export interface NightTiming {
  length: number;
  dawn: number;
}

export interface NightDeps {
  /** 模拟：收夜、重开、天亮；state 只读时间和屋里的人 */
  world: Pick<World, 'close' | 'reopen' | 'dawn'> & { readonly state: Pick<WorldState, 'time' | 'npcs'> };
  /** 播报一行（HUD 的 say，安静的灰字） */
  say(text: string): void;
  /** 门廊灯往 level（0..1）走，seconds 秒走完（0 = 直接切）：house.ts 的 setPorch */
  porch(level: number, seconds: number): void;
  /** 天亮的光：0 夜里、1 天亮，seconds 秒走完：house.ts 的 setDawn */
  dawnLight(k: number, seconds: number): void;
  /** 环境层整体电平（线性增益，1 = 原样），seconds 秒走完：audio 的 setAmbience */
  ambience(level: number, seconds: number): void;
  /** 光从屋里收回前门 / 从前门重新铺开，seconds 秒（0 = 直接切）：cinematic 的 retreat / spread */
  retreat(seconds: number): void;
  spread(seconds: number): void;
  /** 前门开着多少（0 = 关上）：frontDoor.openness */
  door(): number;
  /** 登记簿：翻开收夜那一页（Keep haunting、Another night）/ 合上 */
  openRegister(): void;
  closeRegister(): void;
  /** Another night：重新载入 */
  reload(): void;
  /**
   * Keep haunting：新的一夜从模拟时间 t0 开始（整体审查 I-3）。main.ts 接到登记簿（换一页：上一夜的不再累计，钟点从 t0 算，第二夜也是 9 pm 起）
   * 和墙上多一个影子（一晚最多几次按这一夜重新算）
   */
  newNight(t0: number): void;
  /** 此刻是不是「减少动态效果」（每次用到时问：玩家可能中途改系统设置） */
  reduced(): boolean;
}

/** 调试、冒烟看的状态 */
export interface NightSnapshot {
  phase: NightPhase;
  /** 这一夜从模拟时间几秒开始、几秒收夜、几秒天亮；天亮过没有 */
  start: number;
  closeAt: number;
  dawnAt: number;
  dawned: boolean;
  /** 调试的 endNight 叫的收尾：屋里有人也不作罢 */
  forced: boolean;
}

export interface Night extends Module {
  readonly phase: NightPhase;
  /**
   * 收尾（静、光收回、收夜那一页）：屋里已经空了、画面在收回前门（整体审查 M-1）。main.ts 这时不收现身、设机关、附身，
   * 场景叠层（名牌、悬停标签）收起，范围霜线也不画；Keep haunting 以后（回到 night）放开
   */
  readonly quiet: boolean;
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  update(ctx: FrameCtx): void;
  /** 收夜那一页上点了 Keep haunting（只认登记簿翻开着的那一段；连着调、重入都只算一次） */
  keepHaunting(): void;
  /** 点了 Another night：重新载入 */
  anotherNight(): void;
  /** 调试：立刻收夜（不等屋里的人走光：没收夜的先收夜，接着静、光收回、翻开登记簿） */
  endNight(): void;
  /** 调试：立刻天亮（没收夜的先收夜） */
  dawnNow(): void;
  snapshot(): NightSnapshot;
}

/** 时刻比较的容差：固定步长累加有浮点误差，200 秒可能算成 199.9999999 */
const EPS = 1e-6;

export function createNight(deps: NightDeps, timing: NightTiming = { length: NIGHT.length, dawn: NIGHT.dawn }): Night {
  let phase: NightPhase = 'night';
  let start = 0;
  let closeAt = timing.length;
  let dawnAt = timing.dawn;
  let dawned = false;
  let forced = false;
  /** 静、光收回这一段走了多久（真实时间）；光收回这一段要多久（减少动态时 0） */
  let timer = 0;
  let retreatFor = NIGHT.closing.reveal;

  const empty = () => deps.world.state.npcs.length === 0;

  /** 收夜那一刻：不再有人来（已经排上的取消；屋里没人时模拟放最后一位进来），播报一行，门廊灯慢慢熄 */
  function lastCall() {
    phase = 'closed';
    deps.world.close();
    deps.say(STRINGS.ticker.lastCall);
    deps.porch(NIGHT.porchFade.level, deps.reduced() ? 0 : NIGHT.porchFade.seconds);
  }

  /** 天亮：屋里没被吓走的人自己出门（World.dawn，等于先收夜：没收夜的先收夜），播报一行，天亮的光慢慢起来 */
  function dawn() {
    if (phase === 'night') lastCall();
    dawned = true;
    deps.world.dawn();
    deps.say(STRINGS.ticker.dawn);
    deps.dawnLight(1, deps.reduced() ? 0 : NIGHT_FX.dawnLight);
  }

  /** 屋里没人、门关上了：静一会儿，环境层在静 + 光收回这段时间里慢慢压下去 */
  function beginClosing(force: boolean) {
    phase = 'silence';
    timer = 0;
    forced = force;
    deps.ambience(NIGHT_FX.hush, NIGHT.closing.silence + NIGHT.closing.reveal);
  }

  /** 静、光收回的时候屋里又有人了：作罢，环境层回来，光收回过的话再铺开 */
  function cancelClosing() {
    if (phase === 'retreat') deps.spread(deps.reduced() ? 0 : NIGHT_FX.spread);
    phase = 'closed';
    timer = 0;
    deps.ambience(1, NIGHT_FX.ambienceBack);
  }

  /** 这一夜从模拟时间 t 开始（开局是 0，Keep haunting 是点下去的那一刻） */
  function restart(t: number) {
    phase = 'night';
    start = t;
    closeAt = t + timing.length;
    dawnAt = t + timing.dawn;
    dawned = false;
    forced = false;
    timer = 0;
  }

  return {
    get phase() {
      return phase;
    },

    get quiet() {
      return phase === 'silence' || phase === 'retreat' || phase === 'register';
    },

    onEvent(e, state) {
      // 收夜那一刻屋里没人，模拟最后放进来的那一位：HUD 照常播他进门，这里再补一句「最后一位」
      if (e.type !== 'spawn' || !e.last) return;
      const name = state.npcs.find((n) => n.id === e.npc)?.name;
      if (name) deps.say(STRINGS.ticker.lastArrival(name));
    },

    update({ dt }) {
      const t = deps.world.state.time;
      if (phase === 'night' && t >= closeAt - EPS) lastCall();
      if ((phase === 'night' || phase === 'closed') && !dawned && t >= dawnAt - EPS) dawn();
      switch (phase) {
        case 'closed':
          if (empty() && deps.door() <= NIGHT_FX.doorShut) beginClosing(false);
          break;
        case 'silence':
          if (!forced && !empty()) {
            cancelClosing();
            break;
          }
          timer += dt;
          if (timer >= NIGHT.closing.silence - EPS) {
            phase = 'retreat';
            timer = 0;
            retreatFor = deps.reduced() ? 0 : NIGHT.closing.reveal;
            deps.retreat(retreatFor);
            // 减少动态：光直接切暗了，不用等
            if (retreatFor === 0) {
              phase = 'register';
              deps.openRegister();
            }
          }
          break;
        case 'retreat':
          if (!forced && !empty()) {
            cancelClosing();
            break;
          }
          timer += dt;
          if (timer >= retreatFor - EPS) {
            phase = 'register';
            deps.openRegister();
          }
          break;
      }
    },

    keepHaunting() {
      if (phase !== 'register') return;
      // 先换阶段再做事：合上登记簿会回调 onToggle(false)，main.ts 又接回这里（重入时上面那一句挡住）
      const t = deps.world.state.time;
      restart(t);
      const r = deps.reduced();
      deps.closeRegister();
      // 新的一夜：登记簿换一页、墙上多一个影子重新计数（合上之后再换：淡出的那一页还是上一夜的）
      deps.newNight(t);
      deps.spread(r ? 0 : NIGHT_FX.spread);
      deps.porch(1, r ? 0 : NIGHT.porchFade.seconds);
      deps.ambience(1, NIGHT_FX.ambienceBack);
      deps.dawnLight(0, r ? 0 : NIGHT_FX.dawnBack);
      deps.world.reopen();
    },

    anotherNight() {
      deps.reload();
    },

    endNight() {
      if (phase === 'night') lastCall();
      if (phase === 'closed') beginClosing(true);
      else if (phase === 'silence' || phase === 'retreat') forced = true;
    },

    dawnNow() {
      if ((phase === 'night' || phase === 'closed') && !dawned) dawn();
    },

    snapshot() {
      return { phase, start, closeAt, dawnAt, dawned, forced };
    },
  };
}
