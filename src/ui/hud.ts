// 界面：开场遮罩、左上计数、左下事件播报、右下按钮（设计文档「开场」「界面（HUD，英文）」）。
// 第三人称（engine/ghostRig.ts）另有：画面正中的准星（只在指针锁定时）、开场后停几秒的操作提示、
// 丢了指针锁定时的「Click to resume」；旋转按钮藏起来。这些状态从 watchGhostUi 来，不用 main.ts 接线。
// 视觉方向写在 styles.css 开头。文案全部从 STRINGS 取；动态文字一律用 textContent，不拼 HTML
import { STRINGS } from '../config/strings';
import { watchGhostUi } from '../engine/ghostRig';
import type { FrameCtx, Module, Quality } from '../engine/types';
import type { SimEvent, WorldState } from '../sim/types';

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
}

/** 播报最多几条、每条停留多久、淡出多久（秒）——计划 Task 7 */
const TICKER_MAX = 4;
const TICKER_LIFE = 6;
const TICKER_FADE = 1.2;
/** 开场遮罩淡出（秒），和 styles.css 里 .hud-start 的 transition 一致 */
const START_FADE = 0.8;
/** 第三人称的操作提示：开场后多久开始淡入、停多久（秒）。淡入淡出本身 1.2 秒，在 styles.css 的 .hud-keys */
const KEYS_DELAY = 1.2;
const KEYS_HOLD = 6;

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
  <p class="hud-hint"></p>
  <div class="hud-start-light" aria-hidden="true"></div>
</section>
<div class="hud-play" hidden>
  <p class="hud-counter" aria-live="polite"><span class="hud-counter-label"></span><span class="hud-counter-n"></span></p>
  <ol class="hud-ticker" role="log"></ol>
  <div class="hud-aim" aria-hidden="true"></div>
  <div class="hud-cool" aria-hidden="true"></div>
  <p class="hud-keys"></p>
  <p class="hud-resume" role="status"></p>
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
      return { text: STRINGS.ticker.exit(e.name), tone: 'exit' };
    default:
      return null;
  }
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
  keysHint.textContent = STRINGS.ghost.controls;
  resume.textContent = STRINGS.ghost.resume;

  $('.hud-title').textContent = STRINGS.title;
  headphones.textContent = STRINGS.start.headphones;
  beginBtn.textContent = STRINGS.start.begin;
  beginBtn.setAttribute('aria-label', STRINGS.start.begin);
  hint.textContent = STRINGS.start.hint;
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
  let keysShown = false;
  let keysTimer = 0;
  // toggle 带第二个参数时，类名没变就不写属性，状态变化时整体刷一遍即可
  function refreshGhost() {
    const live = ghost.active && playing && !errored;
    left.hidden = right.hidden = ghost.active;
    aim.classList.toggle('is-on', live && ghost.locked);
    aim.classList.toggle('is-aiming', live && ghost.locked && ghost.aiming);
    cool.classList.toggle('is-on', live && ghost.locked && ghost.cool > 0);
    resume.classList.toggle('is-on', live && ghost.engaged && !ghost.locked && !ghost.pending);
  }
  // 操作提示一页只出现一次：重新锁定指针时不再出来
  function showKeysOnce() {
    if (!ghost.active || !playing || keysShown) return;
    keysShown = true;
    keysTimer = window.setTimeout(() => {
      keysHint.classList.add('is-on');
      keysTimer = window.setTimeout(() => keysHint.classList.remove('is-on'), KEYS_HOLD * 1000);
    }, KEYS_DELAY * 1000);
  }
  const unwatchGhost = watchGhostUi((s) => {
    // 能操控鬼魂（第三人称）时开场提示多一句：访客只看得见手电照着的东西
    if (s.active !== ghost.active) hint.textContent = s.active ? `${STRINGS.start.hint} ${STRINGS.start.ghostHint}` : STRINGS.start.hint;
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
    setReady(r) {
      ready = r;
      const label = r ? STRINGS.start.begin : STRINGS.start.loading;
      beginBtn.textContent = label;
      beginBtn.setAttribute('aria-label', label);
      beginBtn.disabled = !r;
    },
    onEvent(e, state) {
      const l = tickerLine(e, state);
      if (l) push(l.text, l.tone);
      if (e.type === 'exit') setCount(e.total, true);
    },
    update(ctx: FrameCtx) {
      now = ctx.time;
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
      clearTimeout(hideTimer);
      clearTimeout(keysTimer);
      unwatchGhost();
      root.innerHTML = '';
    },
  };
}
