// 访客登记簿（2026-10-30「一夜」）：每个访客一行小故事（几点进来、被什么吓跑），收夜时翻开，中途也能翻（右下角的本子）。
// 记录在 register.ts（纯 TS），这里只管页面：一页维多利亚式的访客登记（样式在 register.css，沿用 styles.css 的纸张、外框和字体）。
// 文案全部从 STRINGS.register 取；动态文字一律用 textContent，不拼 HTML。不做大号数字、表格、打分、评级。
// 自己的 DOM：本子按钮和这一页都挂在 root 下面自己的一层里，不改 hud.ts；本子放在 HUD 右下按钮栏（.hud-controls）的左边，
// 只读那一栏的位置（量不到时退回右下角）。第三人称要先按 Esc 放开鼠标才点得到（main.ts 在 onToggle 里放开 / 重新请求指针锁定）
import './register.css';
import { STRINGS } from '../config/strings';
import type { FrameCtx, Module } from '../engine/types';
import type { SimEvent, WorldState } from '../sim/types';
import { outfitOf as charactersOutfitOf } from '../view/characters';
import { createRegister, type RegisterLine } from './register';

export interface RegisterOpenOptions {
  /** true = 收夜时翻开（按钮是 Keep haunting、Another night）；false = 中途翻开（按钮是 Back to the manor） */
  closing: boolean;
}

export interface RegisterView extends Module {
  open(opts: RegisterOpenOptions): void;
  close(): void;
  readonly isOpen: boolean;
  /** 收夜后玩家点 Keep haunting */
  onKeepHaunting(cb: () => void): void;
  /** 收夜后玩家点 Another night（main.ts 重新载入） */
  onAnotherNight(cb: () => void): void;
  /**
   * 翻开、合上时（main.ts 用来放开 / 重新请求指针锁定、暂停输入）。每次 open() 都发 true（已经翻开着再 open，比如中途翻开着到了收夜，也发）；
   * 每次真的合上发 false（本来就合着时再 close() 什么都不做、不发）
   */
  onToggle(cb: (open: boolean) => void): void;
  /** 墙上多一个影子出现过（页脚多一句 "And one more, who did not sign."） */
  noteOtherOne(): void;
  /** Keep haunting：新的一夜从模拟时间 t0 开始，换一页（register.ts 的 newNight）；下次翻开就是新的这一页 */
  newNight(t0: number): void;
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  update(ctx: FrameCtx): void;
}

export interface RegisterViewOptions {
  /** 访客编号 → 造型 id。默认是 view/characters.ts 的 outfitOf；开发页（dev/ui.ts）给假的 */
  outfitOf?: (npcId: number) => string | undefined;
}

const R = STRINGS.register;
/** 本子和 HUD 按钮栏之间的空隙（px），和 .hud-controls 里按钮之间的 gap 一样 */
const DOCK_GAP = 6;
/** 合上时淡出多久（ms），和 register.css 里 .rg-page.is-leaving 的 transition 一致 */
const CLOSE_FADE = 350;

// 小本子：细线的账簿，书脊一道、封面一张小标签、底下垂一截书签丝带（和 hud.ts 的图标一样是 1.4 粗的刻线，currentColor）
const BOOK =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M7.4 3.7h10.2a.8.8 0 0 1 .8.8v13.9a.8.8 0 0 1-.8.8H7.4a1.8 1.8 0 0 1-1.8-1.8V5.5a1.8 1.8 0 0 1 1.8-1.8Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>' +
  '<path d="M8.9 3.9v15.2" fill="none" stroke="currentColor" stroke-width="1.1"/>' +
  '<path d="M11.3 7.3h4.6v3h-4.6Z" fill="none" stroke="currentColor" stroke-width="1"/>' +
  '<path d="M13.9 19.4v2.9l1-.85 1 .85v-2.9" fill="currentColor"/></svg>';
// 膨胀线：两段由外向内渐粗的楔形 + 中间一颗菱形（和标题页那一道一样，hud.ts 的 RULE）
const RULE =
  '<svg class="rg-rule" viewBox="0 0 240 8" aria-hidden="true" focusable="false">' +
  '<path d="M2 4 112 2.3Q114.2 4 112 5.7ZM238 4 128 2.3Q125.8 4 128 5.7ZM120 .9 123.1 4 120 7.1 116.9 4Z" fill="currentColor"/></svg>';

const TEMPLATE = `
<div class="rg-dock" hidden>
  <button type="button" class="hud-btn rg-book" aria-haspopup="dialog">${BOOK}</button>
</div>
<section class="rg-page" role="dialog" aria-modal="true" aria-labelledby="rg-title" hidden>
  <div class="rg-scroll" tabindex="-1">
    <article class="rg-sheet">
      <header class="rg-head">
        <h2 class="rg-title" id="rg-title"></h2>
        <p class="rg-sub"></p>
        ${RULE}
      </header>
      <ol class="rg-list"></ol>
      <div class="rg-foot"></div>
      <div class="rg-end">
        <p class="rg-notover"></p>
        <div class="rg-actions"></div>
      </div>
    </article>
  </div>
</section>`;

/** 钟点和后面的 am / pm（STRINGS.register.meridiem）之间换成不断行的空格：窄屏折行时 "1:40" 和 "am" 不分到两行 */
const NBSP = String.fromCharCode(0xa0);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keepTimes = (s: string) =>
  s.replace(new RegExp(`(\\d) (${escRe(R.meridiem.am)}|${escRe(R.meridiem.pm)})(?![a-z])`, 'g'), `$1${NBSP}$2`);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 一行：名字（小型大写）· 性格标注（斜体）· 穿哪套，下一行斜体写几点进来、怎么走的。空的项不写（分隔的「·」在 register.css 里） */
function entry(l: RegisterLine): HTMLLIElement {
  const li = el('li', 'rg-entry');
  const who = el('p', 'rg-who');
  who.append(el('span', 'rg-name', l.name));
  if (l.tag) who.append(el('span', 'rg-tag', l.tag));
  if (l.outfit) who.append(el('span', 'rg-outfit', l.outfit));
  li.append(who, el('p', 'rg-story', keepTimes(l.story)));
  return li;
}

export function createRegisterView(root: HTMLElement, opts: RegisterViewOptions = {}): RegisterView {
  const reg = createRegister(opts.outfitOf ?? charactersOutfitOf);
  const layer = el('div', 'rg');
  layer.innerHTML = TEMPLATE;
  root.append(layer);
  const $ = <T extends Element = HTMLElement>(sel: string) => layer.querySelector<T>(sel)!;
  const dock = $('.rg-dock');
  const book = $<HTMLButtonElement>('.rg-book');
  const page = $('.rg-page');
  const scroll = $('.rg-scroll');
  const list = $('.rg-list');
  const foot = $('.rg-foot');
  const notOver = $('.rg-notover');
  const actions = $('.rg-actions');
  $('.rg-title').textContent = R.title;
  $('.rg-sub').textContent = R.subtitle;
  notOver.textContent = R.notOver;
  book.setAttribute('aria-label', R.open);
  book.title = R.open;

  const keepCbs: (() => void)[] = [];
  const anotherCbs: (() => void)[] = [];
  const toggleCbs: ((open: boolean) => void)[] = [];
  let open = false;
  let closing = false;
  /** 最近一次看到的模拟时间（还在屋里的人算到这一刻） */
  let now = 0;
  let started = false;
  let hideTimer = 0;
  /** 翻开之前焦点在哪（合上时还回去） */
  let returnFocus: Element | null = null;

  // ── 本子的位置：HUD 右下按钮栏的左边，底边对齐 ─────────────────
  let bar: HTMLElement | null = null;
  const watchBar = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  function place() {
    if (!bar?.isConnected) {
      bar = document.querySelector<HTMLElement>('.hud-controls');
      if (bar) watchBar?.observe(bar);
    }
    const r = bar?.getBoundingClientRect();
    if (!r || r.width === 0) {
      // 量不到（开发页、HUD 还没显示）：退回 register.css 里的右下角
      dock.style.removeProperty('right');
      dock.style.removeProperty('bottom');
      return;
    }
    const doc = document.documentElement;
    dock.style.right = `${Math.round(doc.clientWidth - r.left + DOCK_GAP)}px`;
    dock.style.bottom = `${Math.round(doc.clientHeight - r.bottom)}px`;
  }
  addEventListener('resize', place);

  /** 开局以后（模拟开始走了）才露出本子，和 HUD 的按钮栏一起淡入 */
  function showBook() {
    if (started) return;
    started = true;
    dock.hidden = false;
    place();
    requestAnimationFrame(() => {
      place();
      dock.classList.add('is-on');
    });
  }

  // ── 翻开、合上 ─────────────────────────────────────
  function render() {
    // 收夜那一页：页脚第一句是评语（register.ts 的 verdictOf）；中途翻开的不写
    const p = reg.page(now, undefined, { closing });
    list.replaceChildren(...p.lines.map(entry), ...(p.others ? [el('li', 'rg-others', p.others)] : []));
    foot.replaceChildren();
    if (p.footer.length) {
      // 一句一个整块（register.css 的 .rg-s）：折行只落在两句之间，不把一句话拦腰截断
      const prose = el('p', 'rg-prose');
      p.footer.forEach((s, i) => prose.append(...(i ? [' '] : []), el('span', 'rg-s', keepTimes(s))));
      foot.append(prose);
    }
    if (p.postscript) foot.append(el('p', 'rg-ps', p.postscript));
    foot.hidden = !foot.childElementCount;
    notOver.hidden = closing;
    const act = (label: string, fn: () => void) => {
      const b = el('button', 'rg-act', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };
    actions.replaceChildren(
      ...(closing
        ? [
            act(R.keepHaunting, () => {
              view.close();
              for (const cb of keepCbs) cb();
            }),
            act(R.anotherNight, () => {
              for (const cb of anotherCbs) cb();
            }),
          ]
        : [act(R.back, () => view.close())]),
    );
  }

  /**
   * 翻开时这一页独占键盘：焦点只在这一页里转（Tab 到最后一个按钮再往后回到第一个），Esc 合上——只在中途翻开时；
   * 收夜那一页 Esc 不合上，只能点那两个按钮（main.ts 把收夜那一页的任何合上都当 Keep haunting）。
   * 在 window 的捕获阶段拦下 keydown、不再往下传：鬼魂镜头按住的方向键、WASD 只看「开过场」不看指针锁定，用方向键滚这一页时鬼魂会跟着飘；
   * HUD 的 M、Q / E，现身的 F 也一样。浏览器自己的动作（滚动、按钮的回车 / 空格）照常；keyup 不拦，之前按住的键松开时照样放掉
   */
  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (!closing) {
        e.preventDefault();
        view.close();
      }
      return;
    }
    if (e.key !== 'Tab') return;
    const btns = [...actions.querySelectorAll<HTMLButtonElement>('button')];
    if (!btns.length) return;
    const first = btns[0], last = btns[btns.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === scroll || !page.contains(at))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (at === last || !page.contains(at))) {
      e.preventDefault();
      first.focus();
    }
  };
  addEventListener('keydown', onKey, true);

  book.addEventListener('click', () => view.open({ closing: false }));

  /**
   * 自己这一层被冲掉了就挂回去：和 HUD 共用 #hud 当 root、又比 createHud 先建的话，hud.ts 的 root.innerHTML = TEMPLATE 会把它清掉。
   * 记录（reg）在 JS 里，挂回去什么都不丢
   */
  let disposed = false;
  const attach = () => {
    if (!disposed && !layer.isConnected) root.append(layer);
  };

  const view: RegisterView = {
    open(o) {
      attach();
      closing = o.closing;
      render();
      scroll.scrollTop = 0;
      if (open) {
        // 已经翻开（中途翻开着到了收夜）：只换内容和按钮，不再转一次页。焦点原来在被换掉的 Back to the manor 上，就回到这一页
        if (!page.contains(document.activeElement)) scroll.focus({ preventScroll: true });
      } else {
        open = true;
        returnFocus = document.activeElement;
        clearTimeout(hideTimer);
        page.classList.remove('is-leaving');
        page.hidden = false;
        // 先让它以透明的样子排一次版，再加 is-on：淡入和翻页才会从头播
        void page.offsetWidth;
        page.classList.add('is-on');
        scroll.focus({ preventScroll: true });
      }
      // 每次 open 都发（已经翻开着也发）：main.ts 在这里放开指针锁定
      for (const cb of toggleCbs) cb(true);
    },
    close() {
      if (!open) return;
      open = false;
      page.classList.remove('is-on');
      page.classList.add('is-leaving');
      clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        page.hidden = true;
        page.classList.remove('is-leaving');
      }, CLOSE_FADE);
      if (page.contains(document.activeElement)) {
        if (returnFocus instanceof HTMLElement && returnFocus.isConnected && returnFocus !== document.body) returnFocus.focus({ preventScroll: true });
        else (document.activeElement as HTMLElement | null)?.blur();
      }
      returnFocus = null;
      for (const cb of toggleCbs) cb(false);
    },
    get isOpen() {
      return open;
    },
    onKeepHaunting(cb) {
      keepCbs.push(cb);
    },
    onAnotherNight(cb) {
      anotherCbs.push(cb);
    },
    onToggle(cb) {
      toggleCbs.push(cb);
    },
    noteOtherOne() {
      reg.noteOtherOne();
    },
    newNight(t0) {
      reg.newNight(t0);
    },
    onEvent(e, state) {
      now = state.time;
      reg.onEvent(e, state);
      if (state.time > 0) showBook();
    },
    update({ state }) {
      attach();
      now = state.time;
      if (state.time > 0) showBook();
    },
    dispose() {
      disposed = true;
      clearTimeout(hideTimer);
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', place);
      watchBar?.disconnect();
      layer.remove();
    },
  };
  return view;
}
