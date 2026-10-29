// 场景叠层（HTML，挂在 #overlay 里，不接收指针）：访客头顶的名牌和恐惧条、物件上方的眼睛和冷却圆环、悬停标签。
// 每帧都要跟着相机走，所以 DOM 只在第一次需要时创建，之后放进池子复用；
// 每帧只改 transform，文字、颜色、类名只在真的变化时才写。
// 第三人称（透视镜头）下：在镜头背后的不显示（toScreen 给 NaN），隔着墙（鬼魂看不见）的不显示——
// 墙全高以后，名牌、眼睛不该隔着墙露出来，找人靠声音（设计文档第 9 节）——离鬼魂远的淡出；
// 镜头差不多平视，标记改挂在每种物件的顶上（俯视时统一 1.2 米就够了）
// 机关（2026-10-28）：设下了的物件（armed > 0），眼睛换成空心的，不管有没有人看着它都亮着（只有玩家看得到的提示）
import { CHARACTER } from '../config/character';
import { SCARES } from '../config/scares';
import { STRINGS } from '../config/strings';
import { FEAR } from '../config/visitors';
import { ghostSees } from '../engine/ghostRig';
import { isGhostRig, type CameraRig, type FrameCtx, type Module } from '../engine/types';
import type { NpcState, ScareObjectState, ScareType, Vec2 } from '../sim/types';

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

const BONE = [220, 210, 189];
const EMBER = [255, 122, 26];
/** 恐惧条颜色：骨白 → 橙，分 16 档（颜色只在换档时才写进 DOM），≥ DREAD_AT 用血红 */
function fearColor(f: number): string {
  if (f >= DREAD_AT) return 'var(--blood)';
  const t = Math.round((Math.max(0, f) / DREAD_AT) * 16) / 16;
  const c = BONE.map((b, i) => Math.round(b + (EMBER[i] - b) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** 眼睛的内容：实心的（有人看得见它）和空心的（机关设下了：眼睑只有一道描边、里面透明，瞳孔是一个空圈） */
const EYE_SOLID =
  '<path d="M1.2 7C5 1.6 19 1.6 22.8 7 19 12.4 5 12.4 1.2 7Z" fill="rgba(5,6,8,.72)" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="7" r="3.4" fill="currentColor"/><circle cx="12" cy="7" r="1.4" fill="#050608"/>';
const EYE_HOLLOW =
  '<path d="M1.2 7C5 1.6 19 1.6 22.8 7 19 12.4 5 12.4 1.2 7Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>' +
  '<circle cx="12" cy="7" r="3.2" fill="none" stroke="currentColor" stroke-width="1.2"/>';
const EYE = `<svg class="ov-eye" viewBox="0 0 24 14" aria-hidden="true" focusable="false">${EYE_SOLID}</svg>`;
/** 空心眼睛的行内样式（styles.css 里 .ov-eye 的规则管不到它）：霜的冷白，不用幽绿；只留一圈黑边压住背景，不发绿光 */
const HOLLOW_STYLE = { color: 'rgb(190,205,224)', filter: 'drop-shadow(0 0 2px rgba(0, 0, 0, 0.95))', transform: 'scaleY(1)' };
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
}

interface Mark {
  el: HTMLDivElement;
  inner: HTMLDivElement;
  fade: number;
  arc: SVGCircleElement;
  /** 眼睛的 svg：机关设下时换内容、写行内样式 */
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
    const name = document.createElement('span');
    name.className = 'ov-name';
    const tag = document.createElement('span');
    tag.className = 'ov-tag';
    line.append(name, tag);
    const bar = div('ov-bar', inner);
    const fill = div('ov-bar-fill', bar);
    // 「紧张」门槛的刻度：过了这条线访客走得更快、手电发抖
    div('ov-bar-tick', bar).style.left = `${(FEAR.nervous / FEAR.max) * 100}%`;
    return { el, inner, fade: 1, name, tag, fill, shown: 0, color: '', fleeing: false, frame: -1, w: 0, lift: 0 };
  };

  const acquire = (n: NpcState): Plate => {
    const p = spare.pop() ?? makePlate();
    p.name.textContent = n.name;
    p.tag.textContent = STRINGS.personalityTag[n.personality];
    p.shown = n.fear;
    p.color = '';
    p.fleeing = false;
    p.el.classList.remove('is-fleeing');
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
  const tipState = document.createElement('span');
  tipState.className = 'ov-tip-state';
  card.append(tipName, tipState);
  div('ov-tip-string', tipIn);
  let hoverId: string | null = null;
  // classList.add / remove 即使类名没变也会改写属性，所以显隐状态自己记着，只在变化时写
  let tipShown = false;
  const showTip = (on: boolean) => {
    if (on === tipShown) return;
    tipShown = on;
    tip.classList.toggle('is-on', on);
  };
  let tipNameText = '';
  let tipStateText = '';
  let cardHalf = 0;
  let cardShift = 0;

  let vw = root.clientWidth || innerWidth;
  const onResize = () => { vw = root.clientWidth || innerWidth; };
  addEventListener('resize', onResize);

  let frame = 0;
  /** 名牌内容的高度（像素），第一次 acquire 时量到 */
  let plateH = 26;
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
      // 机关设下了：眼睛换成空心的，一直亮着（不管有没有人看着它）；解除 / 触发了换回去。只在变化时写
      const armed = o.armed > 0;
      if (armed !== m.armed) {
        m.armed = armed;
        m.el.classList.toggle('is-armed', armed);
        m.eye.innerHTML = armed ? EYE_HOLLOW : EYE_SOLID;
        m.eye.style.color = armed ? HOLLOW_STYLE.color : '';
        m.eye.style.filter = armed ? HOLLOW_STYLE.filter : '';
        m.eye.style.transform = armed ? HOLLOW_STYLE.transform : '';
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

  const updateTip = (objects: ScareObjectState[]) => {
    const o = hoverId ? objects.find((x) => x.id === hoverId) : undefined;
    const s = o ? rig.toScreen(o.pos, markY(o)) : null;
    if (!o || !s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) {
      showTip(false);
      return;
    }
    // 设了机关的写「Trap set」（这时点一下附身会把机关用掉），不写 Ready
    const armed = o.armed > 0;
    const ready = o.cooldown <= 0 && !armed;
    const name = STRINGS.propName[o.type];
    const state = armed ? STRINGS.trapSet : ready ? STRINGS.ready : STRINGS.cooldown(o.cooldown);
    let measure = false;
    if (name !== tipNameText) {
      tipNameText = name;
      tipName.textContent = name;
      measure = true;
    }
    if (state !== tipStateText) {
      tipStateText = state;
      tipState.textContent = state;
      tip.classList.toggle('is-ready', ready);
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
    update({ dt, state }: FrameCtx) {
      frame++;
      updatePlates(state.npcs, dt);
      updateMarks(state.objects);
      updateTip(state.objects);
    },
    setHover(id) {
      hoverId = id;
    },
    // 电影段落（吓跑黑边）期间整层淡出：名牌、眼睛、冷却圆环、悬停标签都先让开
    setHidden(hidden) {
      root.classList.toggle('is-hidden', hidden);
    },
    dispose() {
      removeEventListener('resize', onResize);
      root.replaceChildren();
      root.classList.remove('ov');
      plates.clear();
      marks.clear();
      spare.length = 0;
    },
  };
}
