// 场景叠层（HTML，挂在 #overlay 里，不接收指针）：访客头顶的名牌和恐惧条、物件上方的眼睛和冷却圆环、悬停标签。
// 每帧都要跟着相机走，所以 DOM 只在第一次需要时创建，之后放进池子复用；
// 每帧只改 transform，文字、颜色、类名只在真的变化时才写。
// 第三人称（透视镜头）下：在镜头背后的不显示（toScreen 给 NaN），隔着墙（鬼魂看不见）的不显示——
// 墙全高以后，名牌、眼睛不该隔着墙露出来，找人靠声音（设计文档第 9 节）——离鬼魂远的淡出；
// 镜头差不多平视，标记改挂在每种物件的顶上（俯视时统一 1.2 米就够了）
// 机关（2026-10-28）：设下了的物件（armed > 0），眼睛换成空心的，不管有没有人看着它都亮着（只有玩家看得到的提示）
// 悬停标签的第二行说实话（2026-10-30 试玩报告 P1-2 a，见 tipState）：惊吓类写谁在看着它 / 没人看着，和眼睛说的是同一件事
// 瞄准和反馈（2026-10-30 手感分析，用户：「不知道在什么范围内可以吓到他」）：
// - FEEL-1 名牌上的小眼睛：名字前面一只和物件上同一个图形的眼睛，亮着 = 这个人会被你下一个动作影响（pendingAct：准星 / 手指对着的物件，
//   没对着物件时是在鬼魂所在处现身）。谁会被影响按 sim/reach.ts 的 reachOf 算，规则照搬结算；每 REACH_EVERY 秒算一次。
//   物件在冷却中时眼睛是灰的（人在范围里，但还不能出手）。现身蓄力、停留、冷却时不亮；收夜以后的静场、光收回、登记簿那几段屋里没人，自然没有
// - FEEL-3 结果写在准星对着的地方：附身以后准星还对着它时，标签第二行先报结果（谁跳了、谁听见了、没人看见），停 OUTCOME.hold 秒再回到冷却秒数
// - FEEL-7 够不着：准星对着 4–10 米外看得见的物件（拾取器发的 GhostUi.aimFar），标签写名字和 Too far away.
import { CHARACTER } from '../config/character';
import { SCARES } from '../config/scares';
import { STRINGS } from '../config/strings';
import { FEAR } from '../config/visitors';
import { ghostSees, watchGhostUi } from '../engine/ghostRig';
import { isGhostRig, type CameraRig, type FrameCtx, type Module } from '../engine/types';
import { Grid } from '../sim/grid';
import { reachOf, type ReachAct } from '../sim/reach';
import type { ManifestState, NpcState, ScareObjectState, ScareType, SimEvent, Vec2, WorldState } from '../sim/types';
import { createMissWatch } from '../ui/hints';

/** 名牌、物件标记离地多高（米）——计划 Task 7 */
const PLATE_Y = 1.45;
const MARK_Y = 1.2;
/**
 * 第三人称：名牌离地多高——镜头差不多平视，头顶到名牌的空当在画面上不再被压扁，所以贴近头顶一点（访客身高 + 0.2 米）。
 * 按 targetHeight 算：占位狐狸因为身长上限只有约 0.72 米高，名牌会显得高一些，换成人形吉祥物后正好
 */
const GHOST_PLATE_Y = CHARACTER.targetHeight + 0.2;
/** 第三人称：标记和悬停标签挂多高（米）——各物件顶上再高 0.15–0.2 米（落地灯 1.5、八音盒连床头柜约 0.7、门 1.98……） */
const GHOST_MARK_Y: Record<ScareType, number> = {
  musicBox: 0.95,
  door: 2.15,
  lamp: 1.7,
  rockingChair: 1.35,
  portrait: 2.05,
  mirror: 1.85,
  bed: 0.9,
  wardrobe: 2.3,
};
/** 第三人称：离鬼魂这么远（米）开始淡出，到 FADE_FAR 完全不显示 */
const FADE_NEAR = 7;
const FADE_FAR = 10;
/** 恐惧值到这里，恐惧条从橙色变成血红 */
const DREAD_AT = FEAR.dread;
/** 冷却圆环半径（SVG 单位，标记框 32 × 32） */
const RING_R = 13;
const RING_C = 2 * Math.PI * RING_R;
/** 悬停标签离屏幕边缘至少留多少像素 */
const EDGE = 8;
/** 名牌上的小眼睛（FEEL-1）：多久算一次「此刻待出手的动作会影响谁」（秒）。对准的物件变了立刻重算，不等这一下 */
const REACH_EVERY = 0.1;
/**
 * 结果（FEEL-3）：停多久（秒，真实时间）。有人：从最后一个名字算起（每多一个名字从头计时）；没人：从生效窗口结束算起。
 * 之后回到冷却秒数
 */
export const OUTCOME = { hold: 1.6 };

const BONE = [220, 210, 189];
const EMBER = [255, 122, 26];
/** 恐惧条颜色：骨白 → 橙，分 16 档（颜色只在换档时才写进 DOM），≥ DREAD_AT 用血红 */
function fearColor(f: number): string {
  if (f >= DREAD_AT) return 'var(--blood)';
  const t = Math.round((Math.max(0, f) / DREAD_AT) * 16) / 16;
  const c = BONE.map((b, i) => Math.round(b + (EMBER[i] - b) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** 眼睛的内容：实心的（有人看得见它）和空心的（机关设下了：眼睑只有一道描边、里面透明，瞳孔是一个空圈；颜色、滤镜在 styles.css 的 .ov-mark.is-armed .ov-eye） */
const EYE_SOLID =
  '<path d="M1.2 7C5 1.6 19 1.6 22.8 7 19 12.4 5 12.4 1.2 7Z" fill="rgba(5,6,8,.72)" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="7" r="3.4" fill="currentColor"/><circle cx="12" cy="7" r="1.4" fill="#050608"/>';
const EYE_HOLLOW =
  '<path d="M1.2 7C5 1.6 19 1.6 22.8 7 19 12.4 5 12.4 1.2 7Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
const EYE = `<svg class="ov-eye" viewBox="0 0 24 14" aria-hidden="true" focusable="false">${EYE_SOLID}</svg>`;
const RING =
  '<svg class="ov-ring" viewBox="0 0 32 32" aria-hidden="true" focusable="false">' +
  `<circle class="ov-ring-track" cx="16" cy="16" r="${RING_R}"/>` +
  `<circle class="ov-ring-arc" cx="16" cy="16" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(2)}"/></svg>`;

const div = (cls: string, parent: HTMLElement) => {
  const d = document.createElement('div');
  d.className = cls;
  parent.appendChild(d);
  return d;
};
const at = (x: number, y: number) => `translate3d(${Math.round(x)}px,${Math.round(y)}px,0)`;

/**
 * 悬停标签第二行的口气：ready 幽绿小型大写（现在出手正好）、unseen 灰烬色小型大写（没人看着 / 没人看见）、cooling 秒数、armed 机关、
 * outcome 骨白小型大写（结果：谁跳了、谁听见了）、far 灰烬色斜体（够不着）
 */
export type TipTone = 'ready' | 'unseen' | 'cooling' | 'armed' | 'outcome' | 'far';

/** 一次附身的结果（createOutcomeWatch 给）：被吓到 / 听见的人的名字，空 = 生效窗口结束都没人 */
export interface Outcome {
  names: readonly string[];
}

/**
 * 悬停标签的第二行（2026-10-30「标签说实话」）。原来惊吓类物件只要不在冷却就写幽绿的 Ready，没人看着时点下去白白落空，
 * Ready 还和「有人看着」的那只绿眼睛同一个颜色。现在：
 * - 刚附身过、结果还挂着（opts.outcome，FEEL-3）：先报结果——惊吓类「Theo jumped」、引诱类「Theo and Mia heard it」（骨白），
 *   没人写 No one saw it / No one heard it（灰烬色）。冷却中也是它先，过了 OUTCOME.hold 秒才回到秒数
 * - 够不着（opts.far，FEEL-7：准星对着 4–10 米外的它）：Too far away.（灰烬色）。冷却中、设了机关也这么写：从这里点不了
 * - 设了机关：Trap set（这时点一下附身会把机关用掉）；冷却中：剩几秒。这两种和原来一样，有没有人看着都这么写
 * - 引诱类：Ready（引诱靠声音，模拟不给它算谁看得见）
 * - 惊吓类：有人看着写「Theo is watching」，几个人写「Theo and one other / others are watching」（名字取 seenBy 里的第一个，
 *   也就是先进门的那位，人走动时名字不来回换）；没人看着写 No one is watching。
 *   只认名单上还在的人（seenBy 是模拟这一步算的，名字从 npcs 里找）；天亮自己往外走（leaving）的人看着它也照常写，他只是在看
 */
export function tipState(
  o: ScareObjectState,
  npcs: readonly NpcState[],
  opts: { outcome?: Outcome | null; far?: boolean } = {},
): { text: string; tone: TipTone } {
  const lure = SCARES[o.type].kind === 'lure';
  const out = opts.outcome;
  if (out) {
    if (out.names.length === 0) return { text: lure ? STRINGS.outcome.noneHeard : STRINGS.outcome.noneSaw, tone: 'unseen' };
    const who = STRINGS.names(out.names);
    return { text: lure ? STRINGS.outcome.heard(who) : STRINGS.outcome.jumped(who), tone: 'outcome' };
  }
  if (opts.far) return { text: STRINGS.onboarding.refused.tooFar, tone: 'far' };
  if (o.armed > 0) return { text: STRINGS.trapSet, tone: 'armed' };
  if (o.cooldown > 0) return { text: STRINGS.cooldown(o.cooldown), tone: 'cooling' };
  if (lure) return { text: STRINGS.ready, tone: 'ready' };
  let first: string | null = null;
  let count = 0;
  for (const id of o.seenBy) {
    const name = npcs.find((n) => n.id === id)?.name;
    if (name === undefined) continue;
    first ??= name;
    count++;
  }
  if (first === null) return { text: STRINGS.onboarding.noOneWatching, tone: 'unseen' };
  return { text: count === 1 ? STRINGS.onboarding.watching(first) : STRINGS.onboarding.watchingMany(first, count - 1), tone: 'ready' };
}

/**
 * 此刻待出手的动作（FEEL-1，名牌上的小眼睛按它亮）：准星 / 手指对着够得着的物件（hover）就是附身它；
 * 没对着物件、有鬼魂（第三人称）、现身就绪（idle、冷却为 0）时是在鬼魂所在处现身；别的时候（现身蓄力、停留、冷却中，娃娃屋没悬停）没有。
 * 准星对着够不着的物件时 hover 是 null：那一下点不了，能出手的仍然只有现身，眼睛照旧按现身亮
 */
export function pendingAct(hover: string | null, ghost: Vec2 | null, m: ManifestState): ReachAct | null {
  if (hover) return { kind: 'object', id: hover };
  if (ghost && m.phase === 'idle' && m.cooldown <= 0) return { kind: 'manifest', at: { x: ghost.x, z: ghost.z } };
  return null;
}

/**
 * 附身的结果（FEEL-3）：谁被吓到（惊吓类的 startle）、谁听见（引诱类的 heard），或者生效窗口结束都没人。
 * 用法同主循环：每个事件 onEvent，这一帧的事件都分发完以后 settle；current 给标签用。时间 now 是真实时间（秒）。
 * - 惊吓类「没人看见」直接用 OB 的 createMissWatch（生效窗口结束都没有这个物件的 startle；机关自己发作的那一下不算）
 * - 引诱类在触发后的第一步结算（world.ts）：settle 时模拟时间比触发那一刻往前走过了就算结算完；没人听见就是 No one heard it。
 *   这一帧模拟没走（帧率高于 60、hit-stop）就再等一帧，不急着说没人
 * - 机关自己发作的那一下，吓到人照写，没吓到人不写（同 createMissWatch）
 */
export function createOutcomeWatch(hold = OUTCOME.hold) {
  const misses = createMissWatch();
  /** 刚发作的机关：紧跟着的那个 trigger 是它的 */
  const sprung = new Set<string>();
  /** 物件 id → 这一次附身：lure 引诱类；ids / names 吓到 / 听见的人；at 最近一次有新内容的时刻；none 窗口结束都没人；open 窗口还开着 */
  const recs = new Map<string, { lure: boolean; ids: number[]; names: string[]; at: number; none: boolean; open: boolean; simAt: number; trap: boolean }>();
  /** 上一次 settle 时的模拟时间：引诱看它判断结算了没有 */
  let sim = 0;
  return {
    onEvent(e: SimEvent, s: Readonly<WorldState>, now: number): void {
      misses.onEvent(e);
      if (e.type === 'trap') {
        if (e.phase === 'sprung') sprung.add(e.object);
      } else if (e.type === 'trigger') {
        const lure = SCARES[e.scareType].kind === 'lure';
        recs.set(e.object, { lure, ids: [], names: [], at: -Infinity, none: false, open: true, simAt: sim, trap: sprung.delete(e.object) });
      } else if ((e.type === 'startle' || e.type === 'heard') && e.object !== null) {
        const r = recs.get(e.object);
        if (!r || r.lure !== (e.type === 'heard') || r.ids.includes(e.npc)) return;
        const name = s.npcs.find((n) => n.id === e.npc)?.name;
        if (name === undefined) return;
        r.ids.push(e.npc);
        r.names.push(name);
        r.at = now;
      }
    },
    settle(s: Readonly<WorldState>, now: number): void {
      for (const m of misses.settle(s.objects)) {
        const r = recs.get(m.object);
        if (r && r.ids.length === 0) {
          r.none = true;
          r.at = now;
        }
      }
      for (const [id, r] of recs) {
        if (r.open) {
          if (!r.lure) r.open = (s.objects.find((o) => o.id === id)?.active ?? 0) > 0;
          else if (s.time > r.simAt + 1e-9) {
            r.open = false;
            if (r.ids.length === 0 && !r.trap) {
              r.none = true;
              r.at = now;
            }
          }
        }
        if (!r.open && now - r.at >= hold) recs.delete(id);
      }
      sim = s.time;
    },
    /** 物件 id 此刻要报的结果；没有（没附身过、窗口里还没人、已经报完了）为 null */
    current(id: string, now: number): Outcome | null {
      const r = recs.get(id);
      if (!r || now - r.at >= hold || (r.ids.length === 0 && !r.none)) return null;
      return { names: r.names };
    },
    /** 物件 id 附身过、结果还没报完（生效窗口还开着，或者结果还挂着） */
    pending(id: string, now: number): boolean {
      const r = recs.get(id);
      return r !== undefined && (r.open || now - r.at < hold);
    },
  };
}

/**
 * 远近、遮挡淡出写在内层元素上（外层的 is-on 管池子里的显隐和淡入淡出，互不干扰；内层的 opacity 过渡在 styles.css）。
 * fade 按 0.05 一档，只在换档时写
 */
const setFade = (el: HTMLElement, cur: number, f: number) => {
  if (f === cur) return cur;
  el.style.opacity = f >= 1 ? '' : String(f);
  return f;
};

interface Plate {
  el: HTMLDivElement;
  /** 内层（.ov-plate-in）：远近淡出写在它上面 */
  inner: HTMLDivElement;
  /** 此刻的远近淡出（0..1） */
  fade: number;
  name: HTMLSpanElement;
  tag: HTMLSpanElement;
  fill: HTMLElement;
  /** 显示中的恐惧值（平滑追赶真实值，跳涨时有一点过程） */
  shown: number;
  color: string;
  fleeing: boolean;
  /** 最近一次被用到的帧号；不等于当前帧就说明访客已离开 */
  frame: number;
  /** 名牌内容宽度（像素），只在 acquire 时量一次 */
  w: number;
  /** 为了不和别的名牌重叠而上移的距离（平滑追赶目标值） */
  lift: number;
  /** 名字前面的小眼睛（FEEL-1）：这个人会被下一个动作影响（is-reach）；物件还在冷却（is-cool，眼睛灰的）。只在变化时写类名 */
  reach: boolean;
  cool: boolean;
}

interface Mark {
  el: HTMLDivElement;
  inner: HTMLDivElement;
  fade: number;
  arc: SVGCircleElement;
  /** 眼睛的 svg：机关设下时换内容（样式靠 el 上的 is-armed 类，写在 styles.css） */
  eye: SVGSVGElement;
  cooling: boolean;
  seen: boolean;
  ready: boolean;
  /** 机关设下了（眼睛是空心的） */
  armed: boolean;
  dash: number;
}

export function createOverlays(
  root: HTMLElement,
  rig: CameraRig,
): Module & { setHover(id: string | null): void; setHidden(hidden: boolean): void } {
  root.classList.add('ov');
  const ghost = isGhostRig(rig) ? rig.ghost : null;
  /** 名牌上的小眼睛（FEEL-1）按模拟同一张格子图算视线、听觉（只读，格子只和布局有关） */
  const grid = new Grid();
  /** 准星此刻对着的够不着的物件（FEEL-7，拾取器每帧发）；第三人称才有 */
  let farId: string | null = null;
  const unwatchUi = watchGhostUi((s) => {
    farId = s.aimFar;
  });
  /** 附身的结果（FEEL-3） */
  const outcomes = createOutcomeWatch();
  /** 最近一帧的真实时间：事件在 update 之前分发，按它记 */
  let now = 0;
  const plateY = ghost ? GHOST_PLATE_Y : PLATE_Y;
  const markY = (o: ScareObjectState) => (ghost ? GHOST_MARK_Y[o.type] : MARK_Y);
  /**
   * 0 = 不显示（在镜头背后、隔着墙、离鬼魂太远），1 = 照常，中间是远处的淡出。俯视镜头下永远是 1。
   * 隔墙按鬼魂的视线算（和拾取一样），不按镜头：镜头常常隔着一面溶开的墙跟在后面
   */
  const fadeOf = (p: Vec2, s: { x: number; y: number }) => {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return 0;
    if (!ghost) return 1;
    const t = (FADE_FAR - Math.hypot(p.x - ghost.x, p.z - ghost.z)) / (FADE_FAR - FADE_NEAR);
    if (t <= 0 || !ghostSees(ghost, p)) return 0;
    return t >= 1 ? 1 : Math.round(t * 20) / 20;
  };

  // ── 名牌池 ───────────────────────────────────────────
  const plates = new Map<number, Plate>();
  const spare: Plate[] = [];

  const makePlate = (): Plate => {
    const el = div('ov-plate', root);
    const inner = div('ov-plate-in', el);
    const line = div('ov-plate-name', inner);
    // 名字前面的小眼睛（FEEL-1）：和物件上的眼睛同一个图形；平时 scaleY(0) 收着，占位不变（名牌宽度只在进门时量一次，之后不跳）
    line.innerHTML = `<svg class="ov-plate-mark" viewBox="0 0 24 14" aria-hidden="true" focusable="false">${EYE_SOLID}</svg>`;
    const name = document.createElement('span');
    name.className = 'ov-name';
    const tag = document.createElement('span');
    tag.className = 'ov-tag';
    line.append(name, tag);
    const bar = div('ov-bar', inner);
    const fill = div('ov-bar-fill', bar);
    // 「紧张」门槛的刻度：过了这条线访客走得更快、手电发抖
    div('ov-bar-tick', bar).style.left = `${(FEAR.nervous / FEAR.max) * 100}%`;
    return { el, inner, fade: 1, name, tag, fill, shown: 0, color: '', fleeing: false, frame: -1, w: 0, lift: 0, reach: false, cool: false };
  };

  const acquire = (n: NpcState): Plate => {
    const p = spare.pop() ?? makePlate();
    p.name.textContent = n.name;
    p.tag.textContent = STRINGS.personalityTag[n.personality];
    p.shown = n.fear;
    p.color = '';
    p.fleeing = false;
    p.reach = p.cool = false;
    p.el.classList.remove('is-fleeing', 'is-reach', 'is-cool');
    p.el.classList.add('is-on');
    // 只在访客进门时读一次布局：名字定了宽度就不变，之后每帧只改 transform
    const box = (p.el.firstElementChild as HTMLElement).getBoundingClientRect();
    p.w = box.width;
    if (box.height > 0) plateH = box.height;
    p.lift = 0;
    plates.set(n.id, p);
    return p;
  };

  // ── 物件标记（物件是固定的一组，第一次见到时创建） ──────────
  const marks = new Map<string, Mark>();
  const makeMark = (o: ScareObjectState): Mark => {
    const el = div('ov-mark is-on', root);
    const inner = div('ov-mark-in', el);
    inner.innerHTML = RING + EYE;
    const arc = inner.querySelector<SVGCircleElement>('.ov-ring-arc')!;
    const eye = inner.querySelector<SVGSVGElement>('.ov-eye')!;
    const m: Mark = { el, inner, fade: 1, arc, eye, cooling: false, seen: false, ready: true, armed: false, dash: -1 };
    el.classList.add('is-ready', SCARES[o.type].kind === 'lure' ? 'is-lure' : 'is-sight');
    marks.set(o.id, m);
    return m;
  };

  // ── 悬停标签：一个，复用 ───────────────────────────────
  const tip = div('ov-tip', root);
  const tipIn = div('ov-tip-in', tip);
  const card = div('ov-tip-card', tipIn);
  const tipName = document.createElement('span');
  tipName.className = 'ov-tip-name';
  const tipStateEl = document.createElement('span');
  tipStateEl.className = 'ov-tip-state';
  card.append(tipName, tipStateEl);
  div('ov-tip-string', tipIn);
  let hoverId: string | null = null;
  /**
   * 触屏（娃娃屋、没有精确指针）：轻点附身以后手指抬起 1.5 秒悬停就收了（picking.ts 的 TOUCH_HOVER_MS），台灯的生效窗口正好 1.5 秒，
   * 「No one saw it」永远来不及出来。所以刚点过的那个物件，结果报完之前标签留着（FEEL-3 在手机上的样子）。鼠标的悬停照常跟着鼠标走
   */
  const touch = !ghost && typeof matchMedia === 'function' && !matchMedia('(pointer: fine)').matches;
  let stickId: string | null = null;
  // classList.add / remove 即使类名没变也会改写属性，所以显隐状态自己记着，只在变化时写
  let tipShown = false;
  const showTip = (on: boolean) => {
    if (on === tipShown) return;
    tipShown = on;
    tip.classList.toggle('is-on', on);
  };
  let tipNameText = '';
  let tipStateText = '';
  let tipTone: TipTone | null = null;
  let cardHalf = 0;
  let cardShift = 0;

  let vw = root.clientWidth || innerWidth;
  const onResize = () => { vw = root.clientWidth || innerWidth; };
  addEventListener('resize', onResize);

  let frame = 0;
  /** 名牌内容的高度（像素），第一次 acquire 时量到 */
  let plateH = 26;

  // ── 名牌上的小眼睛（FEEL-1）：此刻待出手的动作会影响谁 ───────────────────
  /** 会被影响的访客 id；reachCool = 那个动作是附身一个还在冷却的物件（眼睛灰的） */
  let reachIds = new Set<number>();
  let reachCool = false;
  let reachTimer = Infinity;
  /** 上一次算的时候对准的是哪个物件：变了立刻重算 */
  let reachHover: string | null = null;
  const updateReach = (state: WorldState, dt: number) => {
    reachTimer += dt;
    if (reachTimer < REACH_EVERY && hoverId === reachHover) return;
    reachTimer = 0;
    reachHover = hoverId;
    const act = pendingAct(hoverId, ghost, state.manifest);
    reachIds = new Set(act ? reachOf(grid, state, act) : []);
    reachCool = act?.kind === 'object' && (state.objects.find((o) => o.id === act.id)?.cooldown ?? 0) > 0;
  };
  const placed: { x: number; y: number; w: number }[] = [];
  const pending: { p: Plate; x: number; y: number }[] = [];

  /**
   * 名牌互相避让：访客站得近时名牌会叠成一团。从画面最下面的（离镜头最近的）开始摆，
   * 后面的碰到已摆好的就往上挪到它上方。名牌的锚点在底边中点（styles.css 的 .ov-plate-in）
   */
  const layoutPlates = (dt: number) => {
    pending.sort((a, b) => b.y - a.y);
    placed.length = 0;
    const gap = 3;
    for (const it of pending) {
      let y = it.y;
      for (let moved = true; moved; ) {
        moved = false;
        for (const q of placed) {
          const overlapX = Math.abs(it.x - q.x) < (it.p.w + q.w) / 2 + gap;
          const overlapY = y > q.y - plateH - gap && y - plateH < q.y + gap;
          if (overlapX && overlapY) {
            y = q.y - plateH - gap;
            moved = true;
          }
        }
      }
      placed.push({ x: it.x, y, w: it.p.w });
      it.p.lift += (it.y - y - it.p.lift) * Math.min(1, dt * 12);
      it.p.el.style.transform = at(it.x, it.y - it.p.lift);
    }
    pending.length = 0;
  };

  const updatePlates = (npcs: NpcState[], dt: number) => {
    for (const n of npcs) {
      if (n.mode === 'gone') continue;
      const p = plates.get(n.id) ?? acquire(n);
      p.frame = frame;
      const s = rig.toScreen(n.pos, plateY);
      const f = fadeOf(n.pos, s);
      p.fade = setFade(p.inner, p.fade, f);
      // 不显示的不参加避让排布（不占地方）；还在淡出的照样跟着人走
      if (f > 0) pending.push({ p, x: s.x, y: s.y });
      else if (Number.isFinite(s.x) && Number.isFinite(s.y)) p.el.style.transform = at(s.x, s.y - p.lift);

      p.shown += (n.fear - p.shown) * Math.min(1, dt * 10);
      if (Math.abs(n.fear - p.shown) < 0.05) p.shown = n.fear;
      p.fill.style.transform = `scaleX(${(Math.min(FEAR.max, p.shown) / FEAR.max).toFixed(3)})`;
      const c = fearColor(p.shown);
      if (c !== p.color) {
        p.color = c;
        p.fill.style.backgroundColor = c;
      }
      const fleeing = n.mode === 'fleeing';
      if (fleeing !== p.fleeing) {
        p.fleeing = fleeing;
        p.el.classList.toggle('is-fleeing', fleeing);
      }
      const reach = reachIds.has(n.id);
      if (reach !== p.reach) {
        p.reach = reach;
        p.el.classList.toggle('is-reach', reach);
      }
      const cool = reach && reachCool;
      if (cool !== p.cool) {
        p.cool = cool;
        p.el.classList.toggle('is-cool', cool);
      }
    }
    layoutPlates(dt);
    // 这一帧没被用到的名牌：访客已经离开，收回池子
    for (const [id, p] of plates) {
      if (p.frame === frame) continue;
      p.el.classList.remove('is-on');
      plates.delete(id);
      spare.push(p);
    }
  };

  const updateMarks = (objects: ScareObjectState[]) => {
    for (const o of objects) {
      const m = marks.get(o.id) ?? makeMark(o);
      const spec = SCARES[o.type];
      const cooling = o.cooldown > 0;
      const seen = o.seenBy.length > 0;
      if (cooling !== m.cooling) {
        m.cooling = cooling;
        m.el.classList.toggle('is-cooling', cooling);
      }
      if (seen !== m.seen) {
        m.seen = seen;
        m.el.classList.toggle('is-seen', seen);
      }
      // 能附身 + 有人看着 = 现在出手：眼睛变成和物件幽光一样的绿
      if (!cooling !== m.ready) {
        m.ready = !cooling;
        m.el.classList.toggle('is-ready', !cooling);
      }
      // 机关设下了：眼睛换成空心的，一直亮着（不管有没有人看着它）；解除 / 触发了换回去。只在变化时写。
      // 颜色、滤镜、睁开多大都在 styles.css 的 .ov-mark.is-armed .ov-eye，这里只换内容和类名
      const armed = o.armed > 0;
      if (armed !== m.armed) {
        m.armed = armed;
        m.el.classList.toggle('is-armed', armed);
        m.eye.innerHTML = armed ? EYE_HOLLOW : EYE_SOLID;
      }
      if (cooling) {
        // 剩下的弧长 = 剩余冷却的比例
        const dash = Math.round(RING_C * (1 - Math.min(1, o.cooldown / spec.cooldown)) * 4) / 4;
        if (dash !== m.dash) {
          m.dash = dash;
          m.arc.style.strokeDashoffset = String(dash);
        }
      }
      const s = rig.toScreen(o.pos, markY(o));
      m.fade = setFade(m.inner, m.fade, fadeOf(o.pos, s));
      if (Number.isFinite(s.x) && Number.isFinite(s.y)) m.el.style.transform = at(s.x, s.y);
    }
  };

  const updateTip = (objects: ScareObjectState[], npcs: NpcState[]) => {
    // 准星对着够得着的物件（hoverId）；没有的话，第三人称准星对着 4–10 米外看得见的物件（farId，FEEL-7）：写名字和 Too far away.
    const far = !hoverId && ghost !== null && farId !== null;
    if (stickId && (hoverId || !outcomes.pending(stickId, now))) stickId = null;
    const id = hoverId ?? (far ? farId : stickId);
    const o = id ? objects.find((x) => x.id === id) : undefined;
    const s = o ? rig.toScreen(o.pos, markY(o)) : null;
    if (!o || !s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      showTip(false);
      return;
    }
    const name = STRINGS.propName[o.type];
    // 刚附身过、结果还挂着（FEEL-3）：第二行先报结果
    const st = tipState(o, npcs, { outcome: outcomes.current(o.id, now), far });
    let measure = false;
    if (name !== tipNameText) {
      tipNameText = name;
      tipName.textContent = name;
      measure = true;
    }
    if (st.text !== tipStateText) {
      tipStateText = st.text;
      tipStateEl.textContent = st.text;
      measure = true;
    }
    if (st.tone !== tipTone) {
      tipTone = st.tone;
      tip.classList.toggle('is-ready', st.tone === 'ready');
      tip.classList.toggle('is-unseen', st.tone === 'unseen');
      tip.classList.toggle('is-outcome', st.tone === 'outcome');
      tip.classList.toggle('is-far', st.tone === 'far');
      measure = true;
    }
    showTip(true);
    if (measure) cardHalf = card.offsetWidth / 2;
    // 标签挂在冷却圆环的正上方，用一根细线（标本签的线）连到物件
    const y = s.y - 16;
    tip.style.transform = at(s.x, y);
    // 靠近屏幕边缘时只把卡片推回来，细线仍然指着物件
    const shift = Math.round(Math.max(EDGE + cardHalf, Math.min(vw - EDGE - cardHalf, s.x)) - s.x);
    if (shift !== cardShift) {
      cardShift = shift;
      card.style.transform = shift ? `translateX(${shift}px)` : '';
    }
  };

  return {
    update({ dt, time, state }: FrameCtx) {
      frame++;
      now = time;
      outcomes.settle(state, time);
      updateReach(state, dt);
      updatePlates(state.npcs, dt);
      updateMarks(state.objects);
      updateTip(state.objects, state.npcs);
    },
    onEvent(e: SimEvent, state: WorldState) {
      outcomes.onEvent(e, state, now);
    },
    setHover(id) {
      if (touch && !id && hoverId) stickId = hoverId;
      hoverId = id;
    },
    // 电影段落（吓跑黑边）期间整层淡出：名牌、眼睛、冷却圆环、悬停标签都先让开
    setHidden(hidden) {
      root.classList.toggle('is-hidden', hidden);
    },
    dispose() {
      removeEventListener('resize', onResize);
      unwatchUi();
      root.replaceChildren();
      root.classList.remove('ov');
      plates.clear();
      marks.clear();
      spare.length = 0;
    },
  };
}
