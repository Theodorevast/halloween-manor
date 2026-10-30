// 界面：开场遮罩、左上计数、左下事件播报、右下按钮（设计文档「开场」「界面（HUD，英文）」）。
// 第三人称（engine/ghostRig.ts）另有：画面正中的准星（只在指针锁定时）、开场后停几秒的操作提示、
// 丢了指针锁定时的「Click to resume」；旋转按钮藏起来。这些状态从 watchGhostUi 来，不用 main.ts 接线。
// 视觉方向写在 styles.css 开头。文案全部从 STRINGS 取；动态文字一律用 textContent，不拼 HTML。
// 上手（2026-10-30 试玩报告 P1-1 b、P1-2 b、P1-3、P1-6）：
// - 开场的操作说明推迟到第一个访客走过以后（KEYS.delay 秒）；垫一层很淡的黑底，只在「·」处折行；
//   和情境提示（ui/hints.ts）排在同一个位置，同一时刻只放一句（bottomLine）
// - 「Click to resume」那张标签下面挂一行操作说明（Esc 就是暂停，随时能再看），暂停时画面整体压暗（eye S-4）
// - 触屏：按钮写 Tap to begin；竖屏时标题页和开场各说一句「把手机横过来」
// 说明和开局（2026-10-30 用户试玩「F 没有任何提示，要有游戏说明」，严格玩家 newbie F1、S1、G1、G5）：
// - 标题页：目标一行、三步说明（titleSteps：触屏用 Tap，没有现身的换掉第三步，第三步里的 F 排成键帽）、一夜多长；
//   开场按钮在准备好之前写 Lighting the candles…、下面一条慢慢变满的细线（setProgress，transform 的过渡在合成线程上走），
//   准备好才亮（加上标本签的框、呼吸）。整页都能点；还在点蜡烛时就点了的记下来（按钮改写 almostLit），main.ts 准备好了自动开场
// - 常驻的按键说明（右下角）：Click possess · Hold set a trap · F appear，F 后面写 Ready / 冷却秒数（fStatus）；
//   三样都用过以后只留 F 和状态（createUseWatch）；暂停时让给「Click to resume」下面那一行完整的
// - 开场的操作说明留到第一次成功附身为止（createOpeningLine），中间情境提示要用那一行时让出来、提示说完再回来
// - 失败要说话：附身落空（No one saw the lamp.）、现身落空（No one saw you. Stand in their light.）在各自第一次成功之前每次都说，
//   之后只在一共说过的不到 MISSED_LINES 次时说（hints.ts 的 missLineDue）
// 天亮自己走的人（exit 带 calm，2026-10-30「一夜」）：播报写 walked out into the morning（安静的灰字），不跳计数；
// 收夜时最后再来的那一位（spawn 带 last）不播进门那一行（收夜的控制器播 lastArrival）
// 瞄准和反馈（2026-10-30 手感分析）：
// - FEEL-6 播报不让尖叫传染把正事挤掉：同一阵的传染并成一行（Hugo and Iris flinched at a scream），满了先挤安静的行（pushLine）
// - FEEL-7 准星对着够不着的物件（GhostUi.aimFar）：外圈变虚线
// 试玩之后的打磨（2026-10-30 第一轮试玩 qa-playtest.md）：
// - P2-1 收夜以后（一夜不在 night，main.ts 每帧 setNightPhase）出门写 {name} is gone.，不再问 Who's next?；
//   光收回前门那几秒（retreat、登记簿）准星和冷却环慢慢淡掉（.hud-play.is-closing）
// - P2-2 收夜、天亮那两句（sayLine）用 exit 那一档的亮度（骨白）、停 TICKER.night 秒，不加灯、不闪
// - P2-4 机关设下以后没人来、到时间自己解除（trap expired）：播报一行安静的 The bed stopped waiting.
import { STRINGS } from '../config/strings';
import { watchGhostUi } from '../engine/ghostRig';
import type { FrameCtx, Module, Quality } from '../engine/types';
import type { NightPhase } from '../night';
import type { ManifestState, SimEvent, WorldState } from '../sim/types';
import { bottomLine, createMissWatch, createSuccessWatch, createUseWatch, markLineEnds, missLineDue, setSegments } from './hints';

export interface HudHandlers {
  /** 返回 false：先别收起开场遮罩（还在准备），准备好了 main.ts 自己调 hideStart() */
  onBegin(): boolean | void;
  onRotate(dir: 1 | -1): void;
  /** 返回切换后是否静音 */
  onToggleMute(): boolean;
  /** 返回切换后的画质 */
  onToggleQuality(): Quality;
}

/** 建 HUD 时就要知道的（标题页的三步说明按它挑）：ghost = 第三人称（有鼠标和键盘，main.ts 的 ghostMode） */
export interface HudOptions {
  ghost?: boolean;
}

export interface Hud extends Module {
  showStart(): void;
  hideStart(): void;
  showError(msg: string): void;
  setQuality(q: Quality): void;
  /** 还没准备好时为 false：开场按钮写 Lighting the candles…、下面一条细线显示进度；点了记下来（main.ts 准备好了自动开场）。默认 true */
  setReady(ready: boolean): void;
  /** 准备到哪儿了（0..1，main.ts 按 src/warmup.ts 的 bootProgress 给）：开场按钮下面那条细线 */
  setProgress(fraction: number): void;
  /** 播报一行（不是模拟事件带出来的那种，比如收夜的 "No one else is coming tonight."）。quiet = 次要的灰字 */
  say(text: string, tone?: 'quiet' | 'scare'): void;
  /** 一夜此刻在哪一段（main.ts 每帧给，只在变化时动 DOM）：收夜以后出门那一行不再问 Who's next?；光收回、登记簿时准星和冷却环淡掉 */
  setNightPhase(phase: NightPhase): void;
  /**
   * Keep haunting 开新的一夜（整体审查最后一轮的复审）：左上角的 Scared off tonight 从 0 重新数。
   * 只在显示上减去这一刻的累计；模拟的 scaredOff 照旧累计（墙上影子的 afterScared 拿它当基准，清了会让它失效）
   */
  newNight(): void;
}

/**
 * 播报最多几条（max）、每条停留多久（life）、淡出多久（fade，秒）——计划 Task 7；
 * 尖叫传染在 merge 秒内并成一行（2026-10-30 手感分析 FEEL-6，见 pushLine）
 */
export const TICKER = { max: 4, life: 6, fade: 1.2, merge: 1.2, night: 10 };
/** 开场遮罩淡出（秒），和 styles.css 里 .hud-start 的 transition 一致 */
const START_FADE = 0.8;
/**
 * 第三人称开场的操作说明（秒）：开场后多久淡入（delay）；第一次至少停多久（hold）——之后要等第一次成功附身才走
 * （2026-10-30 newbie G1：原来停 10 秒就走，那 10 秒新手正忙着看访客进门）；情境提示要用那一行时让出来，提示说完再回来，
 * 再回来的那几次至少停 again 秒才让；淡出多久（fade，和 styles.css 里 .hud-keys 的 transition 一致，淡完才把那一行还回去）。
 * delay 原来 1.2 秒，正好撞上第一个访客推门、从身边走过（开场后约 2–4 秒），没人看（2026-10-30 试玩报告 P1-3 c）
 */
export const KEYS = { delay: 4.5, hold: 10, again: 3, fade: 1.2 };
/** 触屏竖屏：开场后多久说一句「把手机横过来」、停多久（秒）；横过来了就收。等娃娃屋的开场镜头（约 2.5 秒）落定再说 */
const TURN = { delay: 3, hold: 7 };
/** 开场按钮下面那条细线：比真进度往前多走一点（JS 卡着的时候它照样往前挪，见 setProgress），最多多走这么多；两次改写至少隔多久（毫秒） */
const WICK = { lead: 0.04, minGap: 120 };

// 图标：细线 + 实心箭头，像旧版画里的刻线。currentColor 跟着按钮颜色走
const SVG = (body: string) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
const ARROW = '<path d="M12.6 5A7 7 0 1 1 5 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M13.1 2.2 8.3 5l4.8 2.8Z" fill="currentColor"/>';
const ICON_LEFT = SVG(ARROW);
const ICON_RIGHT = SVG(`<g transform="matrix(-1 0 0 1 24 0)">${ARROW}</g>`);
const ICON_SOUND = SVG(
  '<path d="M3.8 9.4h3.4l4.4-3.6v12.4l-4.4-3.6H3.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
    '<path class="hud-waves" d="M14.9 9.3a3.8 3.8 0 0 1 0 5.4M17.5 6.7a7.5 7.5 0 0 1 0 10.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
    '<path class="hud-cross" d="M15.3 9.7l4.6 4.6M19.9 9.7l-4.6 4.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
);
// 画质用蜡烛：High 是一整朵火苗，Low 是将熄的小火苗（画质主要管的就是光：阴影和泛光）
const ICON_CANDLE = SVG(
  '<path d="M9.7 11.4h4.6v8.8H9.7ZM6.6 20.2h10.8M12 11.4V9.8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path class="hud-flame-hi" d="M12 2.4c2 2.3 2.6 3.8 2.6 4.9a2.6 2.6 0 0 1-5.2 0c0-1.1.6-2.6 2.6-4.9Z" fill="currentColor"/>' +
    '<path class="hud-flame-lo" d="M12 6.2c1.1 1.2 1.4 2 1.4 2.5a1.4 1.4 0 0 1-2.8 0c0-.5.3-1.3 1.4-2.5Z" fill="currentColor"/>',
);
// 膨胀线：两段由外向内渐粗的楔形 + 中间一颗菱形，维多利亚排字房的常用分隔
const RULE =
  '<svg class="hud-rule" viewBox="0 0 240 8" aria-hidden="true" focusable="false">' +
  '<path d="M2 4 112 2.3Q114.2 4 112 5.7ZM238 4 128 2.3Q125.8 4 128 5.7ZM120 .9 123.1 4 120 7.1 116.9 4Z" fill="currentColor"/></svg>';

const TEMPLATE = `
<section class="hud-start" data-start aria-labelledby="hud-title">
  <div class="hud-start-page">
    <h1 class="hud-title" id="hud-title"></h1>
    ${RULE}
    <p class="hud-headphones"></p>
    <p class="hud-hint"><span class="hud-hint-text"></span><span class="hud-turn"></span></p>
    <ol class="hud-steps"><li></li><li></li><li></li></ol>
    <p class="hud-night"></p>
    <div class="hud-begin-wrap">
      <button type="button" class="hud-begin"><span class="hud-begin-text"></span></button>
      <span class="hud-wick" aria-hidden="true"><span class="hud-wick-fill"></span></span>
    </div>
    <p class="hud-error" role="alert" hidden></p>
  </div>
  <div class="hud-start-light" aria-hidden="true"></div>
</section>
<div class="hud-play" hidden>
  <p class="hud-counter" aria-live="polite"><span class="hud-counter-label"></span><span class="hud-counter-n"></span></p>
  <ol class="hud-ticker" role="log"></ol>
  <div class="hud-aim" aria-hidden="true"></div>
  <div class="hud-cool" aria-hidden="true"></div>
  <p class="hud-note hud-keys"></p>
  <div class="hud-legend" aria-hidden="true">
    <p class="hud-legend-row hud-legend-more" data-row="possess"><span class="hud-legend-key"></span> <span class="hud-legend-act"></span></p>
    <p class="hud-legend-row hud-legend-more" data-row="trap"><span class="hud-legend-key"></span> <span class="hud-legend-act"></span></p>
    <p class="hud-legend-row" data-row="appear"><kbd class="hud-key"></kbd><span class="hud-legend-act hud-legend-more"></span><span class="hud-legend-state"></span></p>
  </div>
  <div class="hud-resume" role="status"><p class="hud-resume-card"></p><p class="hud-note hud-resume-keys"></p></div>
  <div class="hud-controls">
    <button type="button" class="hud-btn" data-act="left">${ICON_LEFT}</button>
    <button type="button" class="hud-btn" data-act="right">${ICON_RIGHT}</button>
    <button type="button" class="hud-btn" data-act="mute">${ICON_SOUND}</button>
    <button type="button" class="hud-btn hud-btn-quality" data-act="quality">${ICON_CANDLE}<span class="hud-btn-text"></span></button>
  </div>
</div>`;

/** night：收夜、天亮那两句（sayLine）：exit 那一档的亮度、停 TICKER.night 秒 */
export type Tone = 'quiet' | 'scare' | 'flee' | 'exit' | 'night';

/** 这一口气的行停多久（秒，不算淡出）：收夜、天亮那两句 TICKER.night（2026-10-30 试玩 P2-2：6 秒就淡、灰色斜体，很容易错过），别的 TICKER.life */
export const lifeOf = (tone: Tone): number => (tone === 'night' ? TICKER.night : TICKER.life);

/** 播报的一行：文字、口气；尖叫传染那一行另带被传染的人的名字（scream），播报栏据此把同一阵的传染并成一行 */
export interface TickerLine {
  text: string;
  tone: Tone;
  scream?: string;
}

/**
 * HUD 的 say 播的一行（不是模拟事件带出来的那种）：收夜、天亮那两句是 night 口气（亮度和 exit 一档、停得久），
 * 别的（最后一位进门、平常的 say）照给的口气。按文案认：这两句由 src/night.ts 经 main.ts 的 say 播，不带口气
 */
export function sayLine(text: string, tone: 'quiet' | 'scare' = 'quiet'): TickerLine {
  if (text === STRINGS.ticker.lastCall || text === STRINGS.ticker.dawn) return { text, tone: 'night' };
  return { text, tone };
}

/** 播报文案：名字从 state.npcs 里按 id 找（exit 自带名字），物件名用 STRINGS.propName；closed = 收夜以后（不再有人来） */
function tickerLine(e: SimEvent, s: WorldState, closed: boolean): TickerLine | null {
  const who = (id: number) => s.npcs.find((n) => n.id === id)?.name;
  const prop = (id: string) => {
    const o = s.objects.find((x) => x.id === id);
    return o ? STRINGS.propName[o.type] : undefined;
  };
  switch (e.type) {
    case 'spawn': {
      // 收夜时最后再来的那一位（last）：收夜的控制器自己播 "{name} is the last to arrive."，这里不再播进门那一行
      if (e.last) return null;
      const n = who(e.npc);
      return n ? { text: STRINGS.ticker.spawn(n), tone: 'quiet' } : null;
    }
    case 'heard': {
      const n = who(e.npc), p = prop(e.object);
      return n && p ? { text: STRINGS.ticker.heard(n, p), tone: 'quiet' } : null;
    }
    case 'startle': {
      const n = who(e.npc);
      if (!n) return null;
      if (e.object === null) return { text: STRINGS.ticker.startleScream(n), tone: 'quiet', scream: n };
      const p = prop(e.object);
      return p ? { text: STRINGS.ticker.startle(n, p), tone: 'scare' } : null;
    }
    case 'chill': {
      // 平时的发毛每 0.7 秒一步，不进播报；只播「后颈一凉」那一下（同一步还会有一个 startle，那个不播）
      if (!e.neck) return null;
      const n = who(e.npc);
      return n ? { text: STRINGS.ticker.neck(n), tone: 'scare' } : null;
    }
    case 'flee': {
      const n = who(e.npc);
      return n ? { text: STRINGS.ticker.flee(n), tone: 'flee' } : null;
    }
    case 'exit':
      // 天亮自己走的（calm）：不是被吓跑的，安静的一行，不写讣告的短剑号
      if (e.calm) return { text: STRINGS.ticker.leftCalm(e.name), tone: 'quiet' };
      // 收夜以后不会再有人来：不问 Who's next?（试玩 P2-1：它原来是登记簿前黑屏上的最后一行）
      return { text: closed ? STRINGS.ticker.exitClosed(e.name) : STRINGS.ticker.exit(e.name), tone: 'exit' };
    case 'trap': {
      // 机关没人来、到时间自己解除（试玩 P2-4：原来悄悄失效，标签自己回到 No one is watching）。设下、发作不播（发作有惊吓那一行）
      if (e.phase !== 'expired') return null;
      const p = prop(e.object);
      return p ? { text: STRINGS.ticker.trapExpired(p), tone: 'quiet' } : null;
    }
    default:
      return null;
  }
}

/**
 * 一个模拟事件在 HUD 上的结果：播报几行、计数跳到多少（null = 不动）。纯函数（tests/hints.test.ts、tests/opening.test.ts 测）。
 * 现身落下：被吓到的每人一行（同一步的 startle 是 object = 'ghost'，tickerLine 不播）；谁也没吓到、而且这一次该说（opts.manifestMiss，
 * hud.ts 按 missLineDue 给）：一行安静的 No one saw you. Stand in their light.（2026-10-30 newbie S1：原来一个字都没有）；
 * 出门：被吓跑的计数跳到 total、数字压印一下；天亮自己走的（calm）不算吓跑，计数不动
 */
export function hudLines(e: SimEvent, s: WorldState, opts: { closed?: boolean; manifestMiss?: boolean } = {}): { lines: TickerLine[]; count: number | null } {
  if (e.type === 'manifest') {
    if (e.phase !== 'drop') return { lines: [], count: null };
    if (e.scared.length === 0) return { lines: opts.manifestMiss ? [{ text: STRINGS.onboarding.manifestMissed, tone: 'quiet' }] : [], count: null };
    const lines: TickerLine[] = [];
    for (const id of e.scared) {
      const n = s.npcs.find((x) => x.id === id)?.name;
      if (n) lines.push({ text: STRINGS.ticker.seen(n), tone: 'scare' });
    }
    return { lines, count: null };
  }
  const l = tickerLine(e, s, opts.closed ?? false);
  return { lines: l ? [l] : [], count: e.type === 'exit' && !e.calm ? e.total : null };
}

/** 播报栏里的一行（数据；hud.ts 另记它对应的 <li>）：fading = 已经在淡出；scream = 尖叫传染那一行：并进来的名字、还能并到什么时候 */
export interface TickerRow {
  text: string;
  tone: Tone;
  born: number;
  fading: boolean;
  scream: { names: string[]; until: number } | null;
}

/** 尖叫传染的那一行（scream 不为 null） */
type ScreamRow = TickerRow & { scream: NonNullable<TickerRow['scream']> };

/** 尖叫传染那一行（line.scream）要并进哪一行：TICKER.merge 秒内开的、还没淡出的传染行；别的行、没有可并的，null */
export function mergeTarget(rows: readonly TickerRow[], line: TickerLine, now: number): ScreamRow | null {
  if (line.scream === undefined) return null;
  for (let k = rows.length - 1; k >= 0; k--) {
    const r = rows[k];
    if (r.scream && !r.fading && now <= r.scream.until) return r as ScreamRow;
  }
  return null;
}

/**
 * 播报栏加一行（2026-10-30 手感分析 FEEL-6：现身落下那一步，3 行 saw you in the dark 被同一步的 4 行尖叫传染挤掉了）。
 * 纯函数，原地改 rows（tests/hints.test.ts 直接测），返回 DOM 要做的事：
 * - 尖叫传染那一行（line.scream）：TICKER.merge 秒内开的、还没淡出的传染行还在，就并进去——改写同一行，
 *   名字用 STRINGS.names 连起来（Hugo and Iris flinched at a scream），套原来的 STRINGS.ticker.startleScream，不加新句子
 * - 否则新起一行；超过 TICKER.max 行时先挤最旧的安静行（quiet），没有安静行才挤最旧的一行。
 *   scare、flee、exit 这些要紧的行留到自然淡出；满是要紧的行时新来的安静行自己就是最旧的安静行，不进栏
 */
export function pushLine(rows: TickerRow[], line: TickerLine, now: number): { merged: TickerRow | null; added: TickerRow | null; evicted: TickerRow[] } {
  const into = mergeTarget(rows, line, now);
  if (into && line.scream !== undefined) {
    if (!into.scream.names.includes(line.scream)) {
      into.scream.names.push(line.scream);
      into.text = STRINGS.ticker.startleScream(STRINGS.names(into.scream.names));
    }
    return { merged: into, added: null, evicted: [] };
  }
  const added: TickerRow = {
    text: line.text,
    tone: line.tone,
    born: now,
    fading: false,
    scream: line.scream !== undefined ? { names: [line.scream], until: now + TICKER.merge } : null,
  };
  rows.push(added);
  const evicted: TickerRow[] = [];
  while (rows.length > TICKER.max) {
    const k = rows.findIndex((r) => r.tone === 'quiet');
    evicted.push(...rows.splice(k < 0 ? 0 : k, 1));
  }
  return { merged: null, added: rows.includes(added) ? added : null, evicted };
}

/**
 * 开场按钮上的字：准备好之前 Lighting the candles…；准备好了 Click（触屏 Tap）to begin the haunting.；
 * 还没准备好就点了开始（记下来了，准备好自动开场）：The candles are almost lit…，一直写到淡出（不跳回 Click to begin）
 */
export function beginLabel(o: { ready: boolean; begun: boolean; touch: boolean }): string {
  if (o.begun) return STRINGS.onboarding.almostLit;
  if (!o.ready) return STRINGS.start.loading;
  return o.touch ? STRINGS.onboarding.tapToBegin : STRINGS.start.begin;
}

/**
 * 标题页的三步说明（2026-10-30 用户：「要有游戏说明」）：找拿手电的人；附身他正看着的东西（触屏说 Tap）；
 * 第三人称：走进他的光里按 F 现身。没有现身的（触屏、有鼠标的娃娃屋）第三步换成「趁他没缓过来再吓」
 */
export function titleSteps(o: { touch: boolean; ghost: boolean }): string[] {
  const st = STRINGS.start.steps;
  return [st.find, o.touch ? st.tapLook : st.look, o.ghost ? st.appear : st.again];
}

/** 常驻的按键说明里 F 后面的状态：就绪写 Ready；冷却中写剩几秒（同悬停标签，向上取整）；正在现身（蓄力、停留）不写 */
export function fStatus(m: ManifestState): string {
  if (m.phase === 'idle') return m.cooldown > 0 ? STRINGS.cooldown(m.cooldown) : STRINGS.ready;
  if (m.phase === 'cooldown') return STRINGS.cooldown(m.cooldown);
  return '';
}

/**
 * 第三人称开场的操作说明（WASD drift · Mouse look · …）什么时候挂着（2026-10-30 newbie G1）。纯逻辑（tests/opening.test.ts 测），
 * 用画面下方正中那一行（hints.ts 的 bottomLine）：
 * - start：开场就先占着那一行（第一个访客推门的那几秒不出任何字），KEYS.delay 秒后显示
 * - 第一次至少挂 KEYS.hold 秒；之后要等第一次成功附身（succeeded）才淡出、把那一行还回去，不再回来
 * - 情境提示在等那一行（wanted，bottomLine.takeRequest）：挂够了（第一次 KEYS.hold，再回来的 KEYS.again）就淡出让给它；
 *   它说完把那一行还回来，还没成功附身就再挂上
 * tick 每帧调，返回此刻显示不显示（淡出的时候已经是 false：CSS 慢慢淡）
 */
export function createOpeningLine(k = KEYS) {
  let phase: 'idle' | 'queued' | 'on' | 'fading' | 'away' | 'done' = 'idle';
  /** queued：什么时候显示；on：从什么时候显示的；fading：什么时候淡完 */
  let at = 0;
  let shows = 0;
  return {
    get done(): boolean {
      return phase === 'done';
    },
    start(now: number): void {
      if (phase !== 'idle') return;
      phase = 'queued';
      at = now + k.delay;
      bottomLine.claim('keys');
    },
    tick(now: number, succeeded: boolean, wanted: boolean): boolean {
      switch (phase) {
        case 'queued':
          if (now >= at && bottomLine.claim('keys')) {
            phase = 'on';
            at = now;
            shows++;
          }
          break;
        case 'on':
          if (now - at >= (shows === 1 ? k.hold : k.again) && (succeeded || wanted)) {
            phase = 'fading';
            at = now + k.fade;
          }
          break;
        case 'fading':
          if (now >= at) {
            bottomLine.release('keys');
            // 让给提示的、还没成功附身的：回来；成功附身了的：不回来
            phase = succeeded ? 'done' : 'away';
          }
          break;
        case 'away':
          if (succeeded) phase = 'done';
          else if (!wanted && bottomLine.claim('keys')) {
            phase = 'on';
            at = now;
            shows++;
          }
          break;
      }
      return phase === 'on';
    },
  };
}

/** 一句话里单独的那个键（F）排成键帽（标题页第三步）；没有就照常写字 */
function setWithKey(el: HTMLElement, text: string, key: string): void {
  const i = text.indexOf(` ${key} `);
  if (i < 0) {
    el.textContent = text;
    return;
  }
  const kbd = document.createElement('kbd');
  kbd.className = 'hud-key';
  kbd.textContent = key;
  el.replaceChildren(text.slice(0, i + 1), kbd, text.slice(i + 1 + key.length));
}

export function createHud(root: HTMLElement, h: HudHandlers, opts: HudOptions = {}): Hud {
  root.innerHTML = TEMPLATE;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const start = $('.hud-start');
  const beginBtn = $<HTMLButtonElement>('.hud-begin');
  const beginTextEl = $('.hud-begin-text');
  const wickFill = $('.hud-wick-fill');
  const headphones = $('.hud-headphones');
  const hint = $('.hud-hint');
  const steps = $('.hud-steps');
  const nightLine = $('.hud-night');
  const error = $('.hud-error');
  const play = $('.hud-play');
  const counterLabel = $('.hud-counter-label');
  const counterNum = $('.hud-counter-n');
  const ticker = $('.hud-ticker');
  const btn = (act: string) => $<HTMLButtonElement>(`[data-act="${act}"]`);
  const left = btn('left'), right = btn('right'), mute = btn('mute'), quality = btn('quality');
  const qualityText = $('.hud-btn-text');
  const aim = $('.hud-aim');
  const cool = $('.hud-cool');
  const keysHint = $('.hud-keys');
  const resume = $('.hud-resume');
  const resumeKeys = $('.hud-resume-keys');
  const hintText = $('.hud-hint-text');
  const legend = $('.hud-legend');
  const legendState = $('.hud-legend-state');
  setSegments(keysHint, STRINGS.ghost.controls);
  $('.hud-resume-card').textContent = STRINGS.ghost.resume;
  setSegments(resumeKeys, STRINGS.onboarding.controlsOnPause);

  /** 触屏（没有精确指针，main.ts 这时用娃娃屋俯视）：文案写 Tap，竖屏时提醒把手机横过来 */
  const touch = !matchMedia('(pointer: fine)').matches;
  const portraitMq = matchMedia('(orientation: portrait)');
  root.classList.toggle('is-touch', touch);

  $('.hud-title').textContent = STRINGS.title;
  headphones.textContent = STRINGS.start.headphones;
  hintText.textContent = STRINGS.start.goal;
  // 三步说明（titleSteps 按设备挑），第三步里单独的 F 排成键帽；下面一行一夜多长
  titleSteps({ touch, ghost: opts.ghost ?? false }).forEach((text, i) => setWithKey(steps.children[i] as HTMLElement, text, STRINGS.onboarding.fKey));
  nightLine.textContent = STRINGS.start.night;
  $('.hud-turn').textContent = STRINGS.onboarding.turnSideways;
  // 常驻的按键说明：每一行一个键、一个动作；F 那一行后面的状态每帧按模拟写（只在变化时）
  const lg = STRINGS.onboarding.legend;
  for (const [row, key, act] of [['possess', lg.click, lg.possess], ['trap', lg.hold, lg.trap]] as const) {
    $(`[data-row="${row}"] .hud-legend-key`).textContent = key;
    $(`[data-row="${row}"] .hud-legend-act`).textContent = act;
  }
  $('[data-row="appear"] .hud-key').textContent = STRINGS.onboarding.fKey;
  $('[data-row="appear"] .hud-legend-act').textContent = lg.appear;
  for (const [b, label] of [[left, STRINGS.buttons.rotateLeft], [right, STRINGS.buttons.rotateRight]] as const) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let startShown = false;
  let ready = true;
  let begun = false;
  /** 开场按钮下面那条细线：写到哪儿了（scaleX，只增不减）、上一次改写的时刻（毫秒） */
  let wickAt = 0;
  let wickWritten = -Infinity;
  /** 开场按钮上的字：按 ready、begun 写（只在变化时动 DOM） */
  let beginText = '';
  const refreshBegin = () => {
    const label = beginLabel({ ready, begun, touch });
    if (label === beginText) return;
    beginText = label;
    beginTextEl.textContent = label;
    beginBtn.setAttribute('aria-label', label);
  };
  refreshBegin();
  let errored = false;
  let playing = false;
  let now = 0;
  let count = -1;
  let hideTimer = 0;
  /** 播报栏里的行（合并、挤出的判断在 pushLine）和它们的 <li> */
  const rows: TickerRow[] = [];
  const liOf = new Map<TickerRow, HTMLLIElement>();
  /** 附身落空：判断见 hints.ts 的 createMissWatch；附身落空、现身落空各播报过几次（第一次成功之前每次都说，见 missLineDue） */
  const misses = createMissWatch();
  let missedSaid = 0;
  let manifestSaid = 0;
  /** 成功过没有（附身吓到了人、现身吓到了人）：落空的播报、开场的操作说明看它 */
  const success = createSuccessWatch();
  /** 三样动作都用过没有：常驻的按键说明缩成只剩 F（is-compact） */
  const used = createUseWatch();
  let legendCompact = false;
  let fText: string | null = null;
  /** 一夜在哪一段（setNightPhase）：收夜以后（不在 night）出门不问 Who's next?；closing = 光收回前门、登记簿翻开 */
  let nightClosed = false;
  let closing = false;

  // ── 开场 ────────────────────────────────────────────
  // 烛光：一圈暖光跟着指针走，照亮印在黑底上的字；减弱动态时固定在中间
  const onLight = (e: PointerEvent) => {
    if (reduced.matches) return;
    start.style.setProperty('--lx', `${e.clientX}px`);
    start.style.setProperty('--ly', `${e.clientY}px`);
  };
  start.addEventListener('pointermove', onLight);

  // 整页都能点（newbie G5：原来点标题大字也算，可是加载中点了被禁用的按钮，这一下就丢了）。
  // 还没准备好：记下来（main.ts 的 begin 返回 false，准备好了自动开场），按钮改写 almostLit；按钮禁用时不吃点击（styles.css），点击落到整页上
  const begin = () => {
    if (!startShown || begun || errored) return;
    begun = true;
    // onBegin 必须在这次点击 / 按键的调用栈里同步执行：音频解锁、指针锁定要靠用户手势
    if (h.onBegin() !== false) hideStart();
    else refreshBegin();
  };
  start.addEventListener('click', begin);

  function hideStart() {
    if (!startShown) return;
    startShown = false;
    start.classList.add('is-leaving');
    clearTimeout(hideTimer);
    // 淡完再真正藏起来：opacity 0 的元素在自动化测试眼里仍算「可见」
    hideTimer = window.setTimeout(() => { start.hidden = true; }, reduced.matches ? 0 : START_FADE * 1000);
    showPlay();
  }

  function showPlay() {
    if (playing || errored) return;
    playing = true;
    play.hidden = false;
    // 下一帧再加 is-on，让淡入的 transition 生效
    requestAnimationFrame(() => play.classList.add('is-on'));
    showKeysOnce();
    refreshGhost();
  }

  // ── 第三人称：准星、操作提示、常驻的按键说明、「点一下继续」 ─────────────────────
  const ghost = { active: false, engaged: false, locked: false, pending: false, aiming: false, far: false, cool: 0 };
  let resumeOn = false;
  // toggle 带第二个参数时，类名没变就不写属性，状态变化时整体刷一遍即可
  function refreshGhost() {
    const live = ghost.active && playing && !errored;
    left.hidden = right.hidden = ghost.active;
    aim.classList.toggle('is-on', live && ghost.locked);
    // 常驻的按键说明（右下角）：和准星一起，指针锁着（在操控鬼魂）时才有；暂停时让给「Click to resume」下面那一行完整的
    legend.classList.toggle('is-on', live && ghost.locked);
    aim.classList.toggle('is-aiming', live && ghost.locked && ghost.aiming);
    // 够不着（2026-10-30 手感分析 FEEL-7）：准星对着 4–10 米外看得见的物件，外圈浮出来但是虚线（styles.css 的 .hud-aim.is-far）
    aim.classList.toggle('is-far', live && ghost.locked && !ghost.aiming && ghost.far);
    cool.classList.toggle('is-on', live && ghost.locked && ghost.cool > 0);
    const r = live && ghost.engaged && !ghost.locked && !ghost.pending;
    if (r === resumeOn) return;
    resumeOn = r;
    resume.classList.toggle('is-on', r);
    // 暂停时下面那一行开场的操作说明先让开：标签下面已经有同样的一行（styles.css 的 .hud-play.is-paused）
    play.classList.toggle('is-paused', r);
    // 标签下面那一行操作说明：显示出来才量得到哪个「·」折到了行尾
    if (r) markLineEnds(resumeKeys);
  }

  // ── 开场的那一句（第三人称：操作说明；触屏竖屏：把手机横过来）──────────
  // 排在画面下方正中那一行，和情境提示轮流用（hints.ts 的 bottomLine）。开场一开始就先占着这一行：
  // 第一个访客推门、从身边走过的那几秒（开场后约 2–4 秒）画面上不出任何字，情境提示（比如被他的手电照到）也等着。
  // 第三人称的操作说明留到第一次成功附身为止，中间让给情境提示（createOpeningLine）；触屏竖屏那一句只说一次
  let openingQueued = false;
  /** 第三人称的操作说明 */
  let keysLine: ReturnType<typeof createOpeningLine> | null = null;
  /** 触屏竖屏那一句：等着上 / 正在显示；横过来了就不说、说着的也收 */
  let opening: { due: number; hold: number; turn: boolean } | null = null;
  let openingOn = false;
  let openingOff = 0;
  /** 淡完、把那一行还回去的时刻（0 = 不用还） */
  let openingFree = 0;
  function showKeysOnce() {
    if (!playing || openingQueued || errored) return;
    if (ghost.active) {
      openingQueued = true;
      keysLine = createOpeningLine();
      keysLine.start(now);
    } else if (touch) {
      openingQueued = true;
      if (portraitMq.matches) opening = { due: now + TURN.delay, hold: TURN.hold, turn: true };
      if (opening) bottomLine.claim('keys');
    }
  }
  function updateOpening() {
    if (keysLine) {
      // 情境提示在等那一行：每帧读一次（读完就清，提示等着的每一帧都会再要）
      const on = keysLine.tick(now, success.possession, bottomLine.takeRequest('keys'));
      if (on !== openingOn) {
        openingOn = on;
        if (on) setSegments(keysHint, STRINGS.ghost.controls);
        keysHint.classList.toggle('is-on', on);
        if (on) markLineEnds(keysHint);
      }
      return;
    }
    if (opening && !openingOn && now >= opening.due) {
      if (opening.turn && !portraitMq.matches) {
        // 已经横过来了：不用说了，这一行还回去
        opening = null;
        bottomLine.release('keys');
      } else if (bottomLine.claim('keys')) {
        setSegments(keysHint, STRINGS.onboarding.turnSideways);
        keysHint.classList.add('is-on');
        markLineEnds(keysHint);
        openingOn = true;
        openingOff = now + opening.hold;
      }
    }
    if (opening && openingOn && (now >= openingOff || (opening.turn && !portraitMq.matches))) {
      keysHint.classList.remove('is-on');
      openingOn = false;
      opening = null;
      openingFree = now + KEYS.fade;
    }
    if (openingFree > 0 && now >= openingFree) {
      openingFree = 0;
      bottomLine.release('keys');
    }
  }
  const onResize = () => {
    if (openingOn) markLineEnds(keysHint);
    if (resumeOn) markLineEnds(resumeKeys);
  };
  addEventListener('resize', onResize);

  const unwatchGhost = watchGhostUi((s) => {
    ghost.active = s.active;
    ghost.engaged = s.engaged;
    ghost.locked = s.locked;
    ghost.pending = s.pending;
    ghost.aiming = s.aim !== null;
    ghost.far = s.aimFar !== null;
    // 现身的冷却环：剩多少画多少（一段弧），用完了淡出（淡出时弧停在最后的长度，不跳）
    if (s.manifestCooldown > 0) cool.style.setProperty('--cool', s.manifestCooldown.toFixed(3));
    ghost.cool = s.manifestCooldown;
    showKeysOnce();
    refreshGhost();
  });

  // ── 按钮 ────────────────────────────────────────────
  const setMuteUi = (m: boolean) => {
    const label = m ? STRINGS.buttons.unmute : STRINGS.buttons.mute;
    mute.setAttribute('aria-label', label);
    mute.title = `${label} (M)`;
    mute.classList.toggle('is-muted', m);
  };
  const setQualityUi = (q: Quality) => {
    const label = q === 'high' ? STRINGS.buttons.qualityHigh : STRINGS.buttons.qualityLow;
    quality.setAttribute('aria-label', label);
    quality.title = label;
    qualityText.textContent = STRINGS.buttons.qualityShort[q];
    quality.classList.toggle('is-low', q === 'low');
  };
  setMuteUi(false);
  setQualityUi('high');

  const toggleMute = () => setMuteUi(h.onToggleMute());
  left.addEventListener('click', () => h.onRotate(-1));
  right.addEventListener('click', () => h.onRotate(1));
  mute.addEventListener('click', toggleMute);
  quality.addEventListener('click', () => setQualityUi(h.onToggleQuality()));

  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (startShown) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        begin();
      }
      return;
    }
    if (!playing || e.repeat) return;
    const k = e.key.toLowerCase();
    // 第三人称没有 90° 旋转
    if (k === 'q' && !ghost.active) h.onRotate(-1);
    else if (k === 'e' && !ghost.active) h.onRotate(1);
    else if (k === 'm') toggleMute();
  };
  addEventListener('keydown', onKey);

  // ── 计数 ────────────────────────────────────────────
  // 数字单独成一段，好让它在 exit 时像铅字压上纸面那样「印」一下
  /** 这一夜开始时的累计（newNight）：显示的是 count − base */
  let base = 0;
  const setCount = (n: number, stamp: boolean) => {
    if (n === count) return;
    count = n;
    showCount(stamp);
  };
  const showCount = (stamp: boolean) => {
    const shown = count - base;
    const s = STRINGS.counter(shown);
    const i = s.lastIndexOf(String(shown));
    counterLabel.textContent = s.slice(0, i).trimEnd();
    counterNum.textContent = s.slice(i);
    if (stamp && !reduced.matches) {
      counterNum.animate(
        [
          { transform: 'scale(1.7)', filter: 'blur(3px)', opacity: 0 },
          { transform: 'scale(0.94)', filter: 'blur(0)', opacity: 1, offset: 0.55 },
          { transform: 'scale(1)', filter: 'blur(0)', opacity: 1 },
        ],
        { duration: 520, easing: 'cubic-bezier(.3,.7,.3,1)' },
      );
    }
  };
  setCount(0, false);

  // ── 播报 ────────────────────────────────────────────
  const push = (line: TickerLine) => {
    // 改之前每一行在屏幕上的位置：挤掉的可能是中间那一行（先挤安静的），之后每一行各自从原来的位置滑到新位置（FLIP）。
    // 并进已有那一行的（一阵传染同一帧来好几个）只改字、不推栏，不用量
    const animate = !reduced.matches && !mergeTarget(rows, line, now);
    const before = animate ? new Map(rows.map((r) => [r, liOf.get(r)?.getBoundingClientRect().top ?? 0])) : null;
    const { merged, added, evicted } = pushLine(rows, line, now);
    if (merged) {
      // 尖叫传染并进同一行：只改字，不推栏
      const li = liOf.get(merged);
      if (li) li.textContent = merged.text;
      return;
    }
    for (const r of evicted) {
      liOf.get(r)?.remove();
      liOf.delete(r);
    }
    if (!added) return;
    const li = document.createElement('li');
    li.className = `hud-line is-${added.tone}`;
    li.textContent = added.text;
    ticker.append(li);
    liOf.set(added, li);
    if (!animate || !before) return;
    // 新的一行从下面推上来、淡入；原有的行从原来的位置滑过去（底部对齐：一般是整栏往上推一行，挤掉中间一行时它上面的不动）
    const ease = { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' };
    for (const r of rows) {
      const el = liOf.get(r);
      if (!el) continue;
      if (r === added) {
        el.animate([{ transform: `translateY(${el.offsetHeight}px)` }, { transform: 'none' }], ease);
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
        continue;
      }
      const d = (before.get(r) ?? 0) - el.getBoundingClientRect().top;
      if (Math.abs(d) > 0.5) el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], ease);
    }
  };

  function showStart() {
    if (startShown) return;
    clearTimeout(hideTimer);
    startShown = true;
    begun = false;
    start.hidden = false;
    start.classList.remove('is-leaving');
  }

  return {
    showStart,
    hideStart,
    showError(msg) {
      errored = true;
      showStart();
      error.textContent = msg;
      error.hidden = false;
      headphones.hidden = true;
      beginBtn.hidden = true;
      hint.hidden = true;
      start.classList.add('is-error');
      // 第三人称：把鼠标还给玩家，才看得见光标、点得了「点一下重新加载」
      if (document.pointerLockElement) document.exitPointerLock();
      refreshGhost();
    },
    setQuality: setQualityUi,
    say(text, tone = 'quiet') {
      push(sayLine(text, tone));
    },
    newNight() {
      base = Math.max(0, count);
      showCount(false);
    },
    setNightPhase(phase) {
      nightClosed = phase !== 'night';
      // 收夜的静场（silence）：现身按了也不算（main.ts 的 hushed），右下角别再写 F Ready
      play.classList.toggle('is-silent', phase === 'silence');
      const c = phase === 'retreat' || phase === 'register';
      if (c === closing) return;
      closing = c;
      // 光收回前门那几秒：准星和冷却环慢慢淡掉（styles.css 的 .hud-play.is-closing），Keep haunting 以后回来
      play.classList.toggle('is-closing', c);
    },
    setReady(r) {
      ready = r;
      refreshBegin();
      // disabled：脚本（冒烟测试、perf、stall-outfits）靠它判断能不能开场；禁用时按钮不吃点击（styles.css），点击落到整页上照样记下来
      beginBtn.disabled = !r;
      // 准备好了：细线走满、淡掉，按钮加上标本签的框、开始呼吸（styles.css 的 .hud-start.is-ready）
      start.classList.toggle('is-ready', r);
      if (r) {
        wickAt = 1;
        wickFill.style.transform = 'scaleX(1)';
      }
    },
    setProgress(fraction) {
      if (ready || errored) return;
      // 比真进度多走一点（最多 WICK.lead，越到后面越少）：transform 的过渡在合成线程上走，主线程卡着（编管线的时候）细线也照样往前挪一截；
      // 只增不减；两次改写至少隔 WICK.minGap 毫秒（进度一个物体报一次，太密）
      const p = Math.max(0, Math.min(1, fraction));
      const target = Math.min(0.995, Math.max(wickAt, p + Math.min(WICK.lead, (1 - p) * 0.3)));
      const t = performance.now();
      if (target - wickAt < 0.002 || (t - wickWritten < WICK.minGap && target - wickAt < 0.05)) return;
      wickAt = target;
      wickWritten = t;
      wickFill.style.transform = `scaleX(${target.toFixed(3)})`;
    },
    onEvent(e, state) {
      misses.onEvent(e);
      success.onEvent(e);
      used.onEvent(e);
      // 现身落空：这一次该不该说（第一次现身吓到人之前每次都说，见 missLineDue）
      const manifestMiss = missLineDue(manifestSaid, success.manifest);
      const { lines: out, count: n } = hudLines(e, state, { closed: nightClosed, manifestMiss });
      if (manifestMiss && e.type === 'manifest' && e.phase === 'drop' && e.scared.length === 0) manifestSaid++;
      for (const l of out) push(l);
      if (n !== null) setCount(n, true);
      // 三样都用过了：常驻的按键说明缩成只剩 F 和状态
      if (used.all && !legendCompact) {
        legendCompact = true;
        legend.classList.add('is-compact');
      }
    },
    update(ctx: FrameCtx) {
      now = ctx.time;
      updateOpening();
      // 附身落空（这一帧的事件都分发完了）：第一次附身吓到人之前每次补一行安静的播报，之后只在头几次（missLineDue）
      for (const m of misses.settle(ctx.state.objects)) {
        if (!missLineDue(missedSaid, success.possession)) continue;
        missedSaid++;
        push({ text: STRINGS.onboarding.missed(STRINGS.propName[m.type]), tone: 'quiet' });
      }
      // 常驻的按键说明里 F 后面的状态（只在变化时写；Ready 用幽绿，秒数用灰烬色）
      if (ghost.active) {
        const t = fStatus(ctx.state.manifest);
        if (t !== fText) {
          fText = t;
          legendState.textContent = t;
          legendState.classList.toggle('is-ready', t === STRINGS.ready);
        }
      }
      // 计数以事件为准；万一漏了事件（调试快进等），从 state 补上，只增不减
      if (ctx.state.scaredOff > count) setCount(ctx.state.scaredOff, false);
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i];
        const age = now - r.born;
        const life = lifeOf(r.tone);
        if (!r.fading && age > life) {
          r.fading = true;
          liOf.get(r)?.classList.add('is-fading');
        }
        if (age > life + TICKER.fade) {
          liOf.get(r)?.remove();
          liOf.delete(r);
          rows.splice(i, 1);
        }
      }
    },
    dispose() {
      removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      clearTimeout(hideTimer);
      unwatchGhost();
      bottomLine.release('keys');
      root.classList.remove('is-touch');
      root.innerHTML = '';
    },
  };
}
