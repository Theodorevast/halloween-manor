// 电影化编排：开场从黑暗里显影、景深焦点的分配（惊吓拉焦 > 开场跟焦 > 悬停）、吓跑时的电影黑边（2026-10-27 电影感升级）。
// 镜头本身的运动（推近、呼吸、震动）在 camera.ts；惊吓拉焦由 juice.ts 在冲镜的同一刻经 focusChannel 发起；
// 景深和显影遮罩的实现在 postfx.ts，这里只决定「什么时候、对准哪里」
import { FRONT_DOOR } from '../config/house';
import type { Vec2, WorldState } from '../sim/types';
import type { CameraRig, FrameCtx, Module, RenderCore } from './types';

/** 悬停：指针停在物件上这么久（秒）焦点才移过去，扫过去的不算；焦外只轻轻虚一点，0.4 秒平滑 */
const HOVER = { dwell: 0.3, strength: 0.35, smoothTime: 0.4 };
/**
 * 开场显影：光从前门铺开，总长 = intro(seconds) 给的秒数（main.ts 传 2.5）。
 * - 先停 0.35 秒：开场遮罩要 0.8 秒才淡完，开头大半被挡住，光要等遮罩开始变透才铺开
 * - 之后用指数缓出（1 − e^(−3u)，归一化到 u = 1 时正好为 1）：开头铺得快、越往后越慢，轻轻落定，不回弹。
 *   实测（2.5 秒）：0.8 秒遮罩淡完时约 50%，1.5 秒约 85%，2 秒约 95%
 * - 同时焦点对在前门、焦外虚一些（0.6）；显影走到 60% 的时间点松开焦点（0.45 秒平滑），整栋房子随之变清楚——一次跟焦的建立镜头
 * 系统设置了「减少动态效果」时直接显影完，不跟焦，也不播 camera.ts 的下降镜头
 */
const REVEAL = { delay: 0.35, expo: 3, focusStrength: 0.6, focusIn: 0.15, focusRelease: 0.6, releaseSmooth: 0.45 };
/**
 * 吓跑时的电影黑边：上下两条黑边滑入、停住、滑出（秒）；期间场景叠层（名牌、眼睛、标签）让开。
 * 黑边高度和缓动曲线在 styles.css 末尾的「电影黑边」一节，时长由这里写进 CSS 变量。
 * 每 20 秒最多一次：连着吓跑几个人时不会一直黑着边
 */
const LETTERBOX = { in: 0.45, hold: 1.2, out: 0.8, cooldown: 20 };

export interface Cinematic extends Module {
  /** 鼠标悬停的物件 id（main.ts 从拾取器转过来） */
  setHover(id: string | null): void;
  /** 开场：从黑暗里显影 + 镜头下降（减少动态效果时只显影，不下降），开场点击后调用一次 */
  intro(seconds: number): void;
}

/** 场景叠层要能在电影段落里整体让开 */
export interface OverlayControl {
  setHidden(hidden: boolean): void;
}

// ── 景深焦点的分配 ─────────────────────────────────────────
type FocusOpts = NonNullable<Parameters<RenderCore['fx']['focus']>[1]>;
/** 几路要焦点的，优先级从高到低：惊吓拉焦（juice.ts）> 开场跟焦 > 悬停 */
export type FocusLayer = 'scare' | 'intro' | 'hover';
const LAYERS: FocusLayer[] = ['scare', 'intro', 'hover'];

export interface FocusChannel {
  /**
   * 某一路要焦点（target 为房屋米坐标）或松开（target = null）。只有当前最高的一路会真的交给 fx.focus；
   * 松开时 opts.smoothTime 是交还给下一路（或回到常态）用的过渡时间
   */
  set(layer: FocusLayer, target: Vec2 | null, opts?: FocusOpts): void;
}

const channels = new WeakMap<RenderCore, FocusChannel>();
/** 每个渲染器一个焦点分配器：juice.ts 和这里拿到的是同一个 */
export function focusChannel(core: RenderCore): FocusChannel {
  const had = channels.get(core);
  if (had) return had;
  const reqs = new Map<FocusLayer, { target: Vec2; opts: FocusOpts }>();
  let shown: FocusLayer | null = null;
  const ch: FocusChannel = {
    set(layer, target, opts = {}) {
      if (target) reqs.set(layer, { target: { x: target.x, z: target.z }, opts });
      else if (!reqs.delete(layer)) return;
      const top = LAYERS.find((l) => reqs.has(l)) ?? null;
      // 变的是被压住的那一路：画面上的焦点不变
      if (top === shown && top !== layer) return;
      shown = top;
      if (!top) {
        core.fx.focus(null, opts.smoothTime !== undefined ? { smoothTime: opts.smoothTime } : undefined);
        return;
      }
      const r = reqs.get(top)!;
      // 上面一路松开、交还给这一路：过渡用松开那一路给的时间
      core.fx.focus(r.target, target ? r.opts : { ...r.opts, smoothTime: opts.smoothTime ?? r.opts.smoothTime });
    },
  };
  channels.set(core, ch);
  return ch;
}

export function createCinematic(rig: CameraRig, core: RenderCore, overlays: OverlayControl): Cinematic {
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const focus = focusChannel(core);
  const door: Vec2 = { x: FRONT_DOOR.outside.x, z: FRONT_DOOR.outside.z };
  let lastState: WorldState | null = null;
  /** 真实时间（秒），从 FrameCtx 来 */
  let now = 0;

  // 开场点击之前画面停在黑暗里：只剩月光照着的窗和门廊灯
  core.fx.setReveal(0, door);

  // ── 开场显影 ────────────────────────────────────────────
  let reveal: { t: number; dur: number; focusHeld: boolean } | null = null;
  const revealAt = (t: number, dur: number) => {
    const u = Math.min(1, Math.max(0, (t - REVEAL.delay) / Math.max(0.01, dur - REVEAL.delay)));
    return { u, p: (1 - Math.exp(-REVEAL.expo * u)) / (1 - Math.exp(-REVEAL.expo)) };
  };
  const updateReveal = (dt: number) => {
    if (!reveal) return;
    reveal.t += dt;
    const { u, p } = revealAt(reveal.t, reveal.dur);
    if (reveal.focusHeld && u >= REVEAL.focusRelease) {
      reveal.focusHeld = false;
      focus.set('intro', null, { smoothTime: REVEAL.releaseSmooth });
    }
    if (u >= 1) {
      core.fx.setReveal(1, door);
      reveal = null;
    } else core.fx.setReveal(p, door);
  };

  // ── 悬停焦点 ────────────────────────────────────────────
  let hoverId: string | null = null;
  let hoverT = 0;
  let hoverOn = false;
  const updateHover = (dt: number) => {
    if (!hoverId || hoverOn || !lastState) return;
    hoverT += dt;
    if (hoverT < HOVER.dwell) return;
    const o = lastState.objects.find((x) => x.id === hoverId);
    if (!o) return;
    hoverOn = true;
    focus.set('hover', o.pos, { strength: HOVER.strength, smoothTime: HOVER.smoothTime });
  };

  // ── 电影黑边 ────────────────────────────────────────────
  // 挂在 #hud 前面：和 #overlay 同一层（z-index 1），DOM 在它之后，所以盖住画布和场景叠层、在 HUD 按钮之下
  const lb = document.createElement('div');
  lb.className = 'lb';
  lb.setAttribute('aria-hidden', 'true');
  lb.style.setProperty('--lb-in', `${LETTERBOX.in}s`);
  lb.style.setProperty('--lb-out', `${LETTERBOX.out}s`);
  lb.innerHTML = '<div class="lb-bar lb-top"></div><div class="lb-bar lb-bottom"></div>';
  const hudEl = document.getElementById('hud');
  if (hudEl?.parentNode) hudEl.parentNode.insertBefore(lb, hudEl);
  else document.body.appendChild(lb);
  let beat: { t: number; out: boolean } | null = null;
  let lastBeat = -Infinity;
  const startBeat = () => {
    if (beat || now - lastBeat < LETTERBOX.cooldown) return;
    lastBeat = now;
    beat = { t: 0, out: false };
    lb.classList.add('is-on');
    overlays.setHidden(true);
  };
  const updateBeat = (dt: number) => {
    if (!beat) return;
    beat.t += dt;
    if (!beat.out && beat.t >= LETTERBOX.in + LETTERBOX.hold) {
      // 黑边开始滑出时叠层一起淡回来（叠层淡入 0.4 秒，比黑边滑出快一点）
      beat.out = true;
      lb.classList.remove('is-on');
      overlays.setHidden(false);
    }
    if (beat.t >= LETTERBOX.in + LETTERBOX.hold + LETTERBOX.out) beat = null;
  };

  return {
    setHover(id) {
      if (id === hoverId) return;
      hoverId = id;
      hoverT = 0;
      if (hoverOn) {
        hoverOn = false;
        focus.set('hover', null, { smoothTime: HOVER.smoothTime });
      }
    },
    intro(seconds) {
      if (reducedMotion?.matches) {
        // 减少动态效果：不播下降镜头（拉远再推近 + 仰角变化，和冲镜同一类最容易晕的动作），直接显影完
        reveal = null;
        core.fx.setReveal(1, door);
        return;
      }
      rig.intro(seconds);
      reveal = { t: 0, dur: Math.max(0.01, seconds), focusHeld: true };
      core.fx.setReveal(0, door);
      focus.set('intro', door, { strength: REVEAL.focusStrength, smoothTime: REVEAL.focusIn });
    },
    onEvent(e) {
      if (e.type === 'flee') startBeat();
    },
    update({ dt, time, state }: FrameCtx) {
      now = time;
      lastState = state;
      updateReveal(dt);
      updateHover(dt);
      updateBeat(dt);
    },
    dispose() {
      lb.remove();
      if (beat) overlays.setHidden(false);
    },
  };
}
