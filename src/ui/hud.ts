// 界面：开场遮罩、左上计数、左下事件播报、右下按钮（设计文档「开场」「界面（HUD，英文）」）。
// 第三人称（engine/ghostRig.ts）另有：画面正中的准星（只在指针锁定时）、开场后停几秒的操作提示、
// 丢了指针锁定时的「Click to resume」；旋转按钮藏起来。这些状态从 watchGhostUi 来，不用 main.ts 接线。
// 视觉方向写在 styles.css 开头。文案全部从 STRINGS 取；动态文字一律用 textContent，不拼 HTML。
// 上手（2026-10-30 试玩报告 P1-1 b、P1-2 b、P1-3、P1-6）：
// - 点了开始、遮罩还挂着时按钮写 The candles are almost lit…（不退回 Lighting the candles…，看着像卡住了）
// - 开场的操作说明推迟到第一个访客走过以后（KEYS.delay 秒），停 KEYS.hold 秒；垫一层很淡的黑底，只在「·」处折行；
//   和情境提示（ui/hints.ts）排在同一个位置，同一时刻只放一句（bottomLine）
// - 「Click to resume」那张标签下面挂一行操作说明（Esc 就是暂停，随时能再看）
// - 附身落空（惊吓类到生效窗口结束都没吓到人）：播报补一行安静的 No one saw the lamp.，只在头 MISSED_LINES 次
// - 触屏：按钮写 Tap to begin、标题页提示多半句怎么点；竖屏时标题页和开场各说一句「把手机横过来」
// 天亮自己走的人（exit 带 calm，2026-10-30「一夜」）：播报写 walked out into the morning（安静的灰字），不跳计数；
// 收夜时最后再来的那一位（spawn 带 last）不播进门那一行（收夜的控制器播 lastArrival）
import { STRINGS } from '../config/strings';
import { watchGhostUi } from '../engine/ghostRig';
import type { FrameCtx, Module, Quality } from '../engine/types';
import type { SimEvent, WorldState } from '../sim/types';
import { bottomLine, createMissWatch, markLineEnds, setSegments } from './hints';

export interface HudHandlers {
  /** 返回 false：先别收起开场遮罩（还在准备），准备好了 main.ts 自己调 hideStart() */
  onBegin(): boolean | void;
  onRotate(dir: 1 | -1): void;
  /** 返回切换后是否静音 */
  onToggleMute(): boolean;
  /** 返回切换后的画质 */
  onToggleQuality(): Quality;
}

export interface Hud extends Module {
  showStart(): void;
  hideStart(): void;
  showError(msg: string): void;
  setQuality(q: Quality): void;
  /** 渲染器和模型还没就绪时为 false：开场按钮显示加载文案、点了不开始。默认 true */
  setReady(ready: boolean): void;
  /** 播报一行（不是模拟事件带出来的那种，比如收夜的 "No one else is coming tonight."）。quiet = 次要的灰字 */
  say(text: string, tone?: 'quiet' | 'scare'): void;
}

/** 播报最多几条、每条停留多久、淡出多久（秒）——计划 Task 7 */
const TICKER_MAX = 4;
const TICKER_LIFE = 6;
const TICKER_FADE = 1.2;
/** 开场遮罩淡出（秒），和 styles.css 里 .hud-start 的 transition 一致 */
const START_FADE = 0.8;
/**
 * 第三人称开场的操作说明（秒）：开场后多久开始淡入、停多久、淡出多久（淡出和 styles.css 里 .hud-keys 的 transition 一致，
 * 淡完才把那一行还给情境提示）。原来 1.2 秒就出来、停 6 秒，正好撞上第一个访客推门、从身边走过（开场后约 2–4 秒），
 * 没人看（2026-10-30 试玩报告 P1-3 c）
 */
export const KEYS = { delay: 4.5, hold: 10, fade: 1.2 };
/** 触屏竖屏：开场后多久说一句「把手机横过来」、停多久（秒）；横过来了就收。等娃娃屋的开场镜头（约 2.5 秒）落定再说 */
const TURN = { delay: 3, hold: 7 };
/** 附身落空的那一行播报只在头几次（之后玩家已经懂了，不刷屏） */
const MISSED_LINES = 3;

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
    <button type="button" class="hud-begin"></button>
    <p class="hud-error" role="alert" hidden></p>
  </div>
  <p class="hud-hint"><span class="hud-hint-text"></span><span class="hud-turn"></span></p>
  <div class="hud-start-light" aria-hidden="true"></div>
</section>
<div class="hud-play" hidden>
  <p class="hud-counter" aria-live="polite"><span class="hud-counter-label"></span><span class="hud-counter-n"></span></p>
  <ol class="hud-ticker" role="log"></ol>
  <div class="hud-aim" aria-hidden="true"></div>
  <div class="hud-cool" aria-hidden="true"></div>
  <p class="hud-note hud-keys"></p>
  <div class="hud-resume" role="status"><p class="hud-resume-card"></p><p class="hud-note hud-resume-keys"></p></div>
  <div class="hud-controls">
    <button type="button" class="hud-btn" data-act="left">${ICON_LEFT}</button>
    <button type="button" class="hud-btn" data-act="right">${ICON_RIGHT}</button>
    <button type="button" class="hud-btn" data-act="mute">${ICON_SOUND}</button>
    <button type="button" class="hud-btn hud-btn-quality" data-act="quality">${ICON_CANDLE}<span class="hud-btn-text"></span></button>
  </div>
</div>`;

type Tone = 'quiet' | 'scare' | 'flee' | 'exit';

/** 播报文案：名字从 state.npcs 里按 id 找（exit 自带名字），物件名用 STRINGS.propName */
function tickerLine(e: SimEvent, s: WorldState): { text: string; tone: Tone } | null {
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
      if (e.object === null) return { text: STRINGS.ticker.startleScream(n), tone: 'quiet' };
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
      return e.calm ? { text: STRINGS.ticker.leftCalm(e.name), tone: 'quiet' } : { text: STRINGS.ticker.exit(e.name), tone: 'exit' };
    default:
      return null;
  }
}

/**
 * 一个模拟事件在 HUD 上的结果：播报几行、计数跳到多少（null = 不动）。纯函数（tests/hints.test.ts 测）。
 * 现身落下：被吓到的每人一行（同一步的 startle 是 object = 'ghost'，tickerLine 不播）；
 * 出门：被吓跑的计数跳到 total、数字压印一下；天亮自己走的（calm）不算吓跑，计数不动
 */
export function hudLines(e: SimEvent, s: WorldState): { lines: { text: string; tone: Tone }[]; count: number | null } {
  if (e.type === 'manifest') {
    if (e.phase !== 'drop') return { lines: [], count: null };
    const lines: { text: string; tone: Tone }[] = [];
    for (const id of e.scared) {
      const n = s.npcs.find((x) => x.id === id)?.name;
      if (n) lines.push({ text: STRINGS.ticker.seen(n), tone: 'scare' });
    }
    return { lines, count: null };
  }
  const l = tickerLine(e, s);
  return { lines: l ? [l] : [], count: e.type === 'exit' && !e.calm ? e.total : null };
}

/**
 * 开场按钮上的字：能点之前 Lighting the candles…；能点了 Click（触屏 Tap）to begin the haunting.；
 * 点过开始、遮罩还挂着（还在编管线、等造型）The candles are almost lit…——原来退回 Lighting the candles…，
 * 光标又刚被锁走，看着像卡死了（试玩报告 P1-1 b）
 */
export function beginLabel(o: { ready: boolean; begun: boolean; touch: boolean }): string {
  if (o.begun) return STRINGS.onboarding.almostLit;
  if (!o.ready) return STRINGS.start.loading;
  return o.touch ? STRINGS.onboarding.tapToBegin : STRINGS.start.begin;
}

export function createHud(root: HTMLElement, h: HudHandlers): Hud {
  root.innerHTML = TEMPLATE;
  const $ = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const start = $('.hud-start');
  const beginBtn = $<HTMLButtonElement>('.hud-begin');
  const headphones = $('.hud-headphones');
  const hint = $('.hud-hint');
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
  setSegments(keysHint, STRINGS.ghost.controls);
  $('.hud-resume-card').textContent = STRINGS.ghost.resume;
  setSegments(resumeKeys, STRINGS.onboarding.controlsOnPause);

  /** 触屏（没有精确指针，main.ts 这时用娃娃屋俯视）：文案写 Tap，竖屏时提醒把手机横过来 */
  const touch = !matchMedia('(pointer: fine)').matches;
  const portraitMq = matchMedia('(orientation: portrait)');
  root.classList.toggle('is-touch', touch);
  /** 标题页底部的玩法说明：触屏多半句怎么点 */
  const hintBase = touch ? `${STRINGS.start.hint} ${STRINGS.onboarding.tapHint}` : STRINGS.start.hint;

  $('.hud-title').textContent = STRINGS.title;
  headphones.textContent = STRINGS.start.headphones;
  const beginText = beginLabel({ ready: true, begun: false, touch });
  beginBtn.textContent = beginText;
  beginBtn.setAttribute('aria-label', beginText);
  hintText.textContent = hintBase;
  $('.hud-turn').textContent = STRINGS.onboarding.turnSideways;
  for (const [b, label] of [[left, STRINGS.buttons.rotateLeft], [right, STRINGS.buttons.rotateRight]] as const) {
    b.setAttribute('aria-label', label);
    b.title = label;
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let startShown = false;
  let ready = true;
  let begun = false;
  let errored = false;
  let playing = false;
  let now = 0;
  let count = -1;
  let hideTimer = 0;
  const lines: { li: HTMLLIElement; born: number; fading: boolean }[] = [];
  /** 附身落空：判断见 hints.ts 的 createMissWatch；播报过几次 */
  const misses = createMissWatch();
  let missedSaid = 0;

  // ── 开场 ────────────────────────────────────────────
  // 烛光：一圈暖光跟着指针走，照亮印在黑底上的字；减弱动态时固定在中间
  const onLight = (e: PointerEvent) => {
    if (reduced.matches) return;
    start.style.setProperty('--lx', `${e.clientX}px`);
    start.style.setProperty('--ly', `${e.clientY}px`);
  };
  start.addEventListener('pointermove', onLight);

  const begin = () => {
    if (!startShown || !ready || begun || errored) return;
    begun = true;
    // onBegin 必须在这次点击 / 按键的调用栈里同步执行：音频解锁要靠用户手势
    if (h.onBegin() !== false) hideStart();
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

  // ── 第三人称：准星、操作提示、「点一下继续」 ─────────────────────
  const ghost = { active: false, engaged: false, locked: false, pending: false, aiming: false, cool: 0 };
  let resumeOn = false;
  // toggle 带第二个参数时，类名没变就不写属性，状态变化时整体刷一遍即可
  function refreshGhost() {
    const live = ghost.active && playing && !errored;
    left.hidden = right.hidden = ghost.active;
    aim.classList.toggle('is-on', live && ghost.locked);
    aim.classList.toggle('is-aiming', live && ghost.locked && ghost.aiming);
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

  // ── 开场的那一句（第三人称：操作说明；触屏竖屏：把手机横过来），一页只出现一次 ──────────
  // 排在画面下方正中那一行，和情境提示轮流用（hints.ts 的 bottomLine）。开场一开始就先占着这一行，直到它说完、淡完：
  // 第一个访客推门、从身边走过的那几秒（开场后约 2–4 秒）画面上不出任何字，情境提示（比如被他的手电照到）也等它说完再看还算不算数
  let openingQueued = false;
  /** 等着上 / 正在显示的那一句；turn = 「把手机横过来」（横过来了就不说、说着的也收） */
  let opening: { due: number; hold: number; turn: boolean } | null = null;
  let openingOn = false;
  let openingOff = 0;
  /** 淡完、把那一行还回去的时刻（0 = 不用还） */
  let openingFree = 0;
  function showKeysOnce() {
    if (!playing || openingQueued || errored) return;
    if (ghost.active) {
      openingQueued = true;
      opening = { due: now + KEYS.delay, hold: KEYS.hold, turn: false };
    } else if (touch) {
      openingQueued = true;
      if (portraitMq.matches) opening = { due: now + TURN.delay, hold: TURN.hold, turn: true };
    }
    if (opening) bottomLine.claim('keys');
  }
  function updateOpening() {
    if (opening && !openingOn && now >= opening.due) {
      if (opening.turn && !portraitMq.matches) {
        // 已经横过来了：不用说了，这一行还回去
        opening = null;
        bottomLine.release('keys');
      } else if (bottomLine.claim('keys')) {
        setSegments(keysHint, opening.turn ? STRINGS.onboarding.turnSideways : STRINGS.ghost.controls);
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
    // 能操控鬼魂（第三人称）时开场提示多一句：访客只看得见手电照着的东西
    if (s.active !== ghost.active) hintText.textContent = s.active ? `${hintBase} ${STRINGS.start.ghostHint}` : hintBase;
    ghost.active = s.active;
    ghost.engaged = s.engaged;
    ghost.locked = s.locked;
    ghost.pending = s.pending;
    ghost.aiming = s.aim !== null;
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
  const setCount = (n: number, stamp: boolean) => {
    if (n === count) return;
    count = n;
    const s = STRINGS.counter(n);
    const i = s.lastIndexOf(String(n));
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
  const push = (text: string, tone: Tone) => {
    const li = document.createElement('li');
    li.className = `hud-line is-${tone}`;
    li.textContent = text;
    ticker.append(li);
    lines.push({ li, born: now, fading: false });
    while (lines.length > TICKER_MAX) lines.shift()!.li.remove();
    if (!reduced.matches) {
      // 整栏从下往上推一行（底部对齐，最旧的一条在顶上被移走时不会跳）
      ticker.animate([{ transform: `translateY(${li.offsetHeight}px)` }, { transform: 'none' }], {
        duration: 320,
        easing: 'cubic-bezier(.2,.7,.2,1)',
      });
      li.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 420, easing: 'ease-out' });
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
      push(text, tone);
    },
    setReady(r) {
      ready = r;
      // 已经点过开始（main.ts 的 begin 还要等后台预编译、等造型）：写 almostLit，不退回加载中
      const label = beginLabel({ ready: r, begun, touch });
      beginBtn.textContent = label;
      beginBtn.setAttribute('aria-label', label);
      beginBtn.disabled = !r;
    },
    onEvent(e, state) {
      misses.onEvent(e);
      const { lines: out, count: n } = hudLines(e, state);
      for (const l of out) push(l.text, l.tone);
      if (n !== null) setCount(n, true);
    },
    update(ctx: FrameCtx) {
      now = ctx.time;
      updateOpening();
      // 附身落空（这一帧的事件都分发完了）：头几次补一行安静的播报，之后不再说
      for (const m of misses.settle(ctx.state.objects)) {
        if (missedSaid >= MISSED_LINES) break;
        missedSaid++;
        push(STRINGS.onboarding.missed(STRINGS.propName[m.type]), 'quiet');
      }
      // 计数以事件为准；万一漏了事件（调试快进等），从 state 补上，只增不减
      if (ctx.state.scaredOff > count) setCount(ctx.state.scaredOff, false);
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        const age = now - l.born;
        if (!l.fading && age > TICKER_LIFE) {
          l.fading = true;
          l.li.classList.add('is-fading');
        }
        if (age > TICKER_LIFE + TICKER_FADE) {
          l.li.remove();
          lines.splice(i, 1);
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
