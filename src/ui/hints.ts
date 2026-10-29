// 只出现一次的情境提示、做不到时的一句回应（2026-10-30 试玩报告 P1-2 b、P1-3、P1-4 b）。文案全在 STRINGS.onboarding。
// - 情境提示：每种第一次碰到时出现一次（一页只一次），排在画面下方正中、开场操作说明那一行的位置，同样的小型大写排法，
//   停 HINT.hold 秒淡出；提示说的那件事已经做了（附身了、现身了），过了 HINT.minHold 秒就先淡出：
//     firstAim      第一次准星对准够得着的物件（第三人称才有）
//     firstMiss     第一次附身落空（惊吓类物件到生效窗口结束都没吓到人，见 createMissWatch）
//     firstLure     第一次有人听见引诱（heard）
//     firstRevealed 第一次被手电照到、而且现身已就绪（第三人称才有）
//   那一行同一时刻只放一句（bottomLine）：开场的操作说明（hud.ts）还挂着时，提示先等它淡完；等到的时候已经不算数了
//   （准星移开了、不再被照着、过了新鲜期）就不出，留到下一次碰到。暂停中（Click to resume 挂着）不出新的
// - 做不到时的回应（refused）：挂在准星下面一点，斜体灰烬色，很快淡掉；同一种 HINT.refuseGap 秒内不重复
// 判断都在纯函数 createHintCore / createMissWatch 里（tests/hints.test.ts 直接测），createHints 只管 DOM。
// main.ts 只调这里，不自己拼文案
import { SCARES } from '../config/scares';
import { STRINGS } from '../config/strings';
import { TRAP } from '../config/visitors';
import { watchGhostUi } from '../engine/ghostRig';
import type { FrameCtx, Module } from '../engine/types';
import type { ManifestPhase, ScareObjectState, ScareType, SimEvent, WorldState } from '../sim/types';

/** 做不到时的原因（main.ts 按模拟的返回值和状态判断后传进来） */
export type Refusal = 'manifestCooldown' | 'manifestWall' | 'trapsFull' | 'tooFar';

/** 哪一种情境提示（STRINGS.onboarding.hints 的键） */
export type HintKey = keyof typeof STRINGS.onboarding.hints;

/**
 * 现身被拒以后回应哪一句（main.ts：world.manifest() 返回 false 之后，按此刻的现身阶段问）。
 * 冷却中 → manifestCooldown（Not yet.）；就绪却被拒 → manifestWall（模拟只在鬼魂中心所在的格子挡视线时拒，见 World.manifest）；
 * 正在现身（蓄力、停留）时再按 → null，不回应：现身正在发生，说 Not yet 不对
 */
export function manifestRefusal(phase: ManifestPhase): Refusal | null {
  return phase === 'cooldown' ? 'manifestCooldown' : phase === 'idle' ? 'manifestWall' : null;
}

/**
 * 设机关被拒以后要不要说 trapsFull（Two traps are already set.）：同时设下的满了（TRAP.max），而且这个物件自己没设着——
 * 自己已经设着的，悬停标签写着 Trap set，再按一下什么都不用说
 */
export function trapsFull(objects: readonly Pick<ScareObjectState, 'id' | 'armed'>[], id: string): boolean {
  return objects.filter((o) => o.armed > 0).length >= TRAP.max && !((objects.find((o) => o.id === id)?.armed ?? 0) > 0);
}

export interface Hints extends Module {
  /** 某种「做不到」：每次都回应一句（很轻、很快淡掉），同一种短时间内不重复 */
  refused(kind: Refusal): void;
  /** 准星第一次对准一个够得着的物件（picking 的 onHover 给非 null 时调） */
  aimed(objectId: string): void;
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  update(ctx: FrameCtx): void;
}

/** 时刻（秒，真实时间） */
export const HINT = {
  /** 一句提示停多久（不算淡入淡出） */
  hold: 7,
  /** 淡出多久：和 styles.css 里 .hud-hintline 的 transition 一致；淡完才把那一行还回去 */
  fade: 1.2,
  /** 提示上来以后，它说的那件事已经做了（附身了、设了机关、现身了），至少停这么久再淡出 */
  minHold: 3,
  /** 等着上的提示多久以后不算数（落空、有人听见引诱都是一下子的事；准星、手电看此刻的状态） */
  fresh: { firstMiss: 10, firstLure: 8 },
  /** 同一种「做不到」多久之内不再回应 */
  refuseGap: 4,
  /** 「做不到」那一句停多久，淡出在 styles.css 的 .hud-refusal */
  refuseHold: 1.6,
};

// ── 画面下方正中那一行 ─────────────────────────────────────────

type LineOwner = 'keys' | 'hint';
let lineOwner: LineOwner | null = null;

/**
 * 画面下方正中那一行同一时刻只放一句：开场的那一句（hud.ts：操作说明，触屏竖屏时是「把手机横过来」）记作 keys，
 * 情境提示记作 hint。谁先占着谁先说完，后来的等它淡完。一页只有一个界面，所以用模块级的状态（同 ghostRig 的 watchGhostUi）
 */
export const bottomLine = {
  get owner(): LineOwner | null {
    return lineOwner;
  },
  /** 想用这一行：空着或者本来就是自己的，占上、返回 true；别人占着返回 false */
  claim(who: LineOwner): boolean {
    if (lineOwner !== null && lineOwner !== who) return false;
    lineOwner = who;
    return true;
  },
  /** 用完了（淡完了）还回去；不是自己占着的不动 */
  release(who: LineOwner): void {
    if (lineOwner === who) lineOwner = null;
  },
};

// ── 附身落空 ───────────────────────────────────────────────

/** 一次落空：哪个物件、哪一种 */
export interface Miss {
  object: string;
  type: ScareType;
}

/**
 * 附身落空的判断：惊吓类物件被玩家附身（trigger）以后，到生效窗口（SCARES[type].active，模拟里是物件的 active 倒数到 0）
 * 结束都没有这个物件的 startle。引诱类不算（它靠声音，本来就不用被看见）；机关发作的那一下也不算（trap sprung 紧跟着的
 * trigger，时机是机关自己挑的，不是玩家点的）。
 * 用法同主循环：每个事件 onEvent，这一帧的事件都分发完以后 settle（同一批事件里 trigger 后面的 startle 也要先记上）。
 * hud.ts 用它在播报栏补一行 missed（只在头几次），情境提示用它出 firstMiss
 */
export function createMissWatch() {
  /** 还在生效窗口里的附身：物件 id → 哪一种、吓到人没有 */
  const open = new Map<string, { type: ScareType; hit: boolean }>();
  /** 刚发作的机关：紧跟着的那个 trigger 是它的 */
  const sprung = new Set<string>();
  return {
    onEvent(e: SimEvent): void {
      if (e.type === 'trap') {
        if (e.phase === 'sprung') sprung.add(e.object);
      } else if (e.type === 'trigger') {
        if (sprung.delete(e.object)) open.delete(e.object);
        else if (SCARES[e.scareType].kind === 'sight') open.set(e.object, { type: e.scareType, hit: false });
      } else if (e.type === 'startle' && e.object !== null) {
        const w = open.get(e.object);
        if (w) w.hit = true;
      }
    },
    /** 生效窗口已经结束的附身收起来，返回其中没吓到人的（没有就是空数组） */
    settle(objects: readonly ScareObjectState[]): Miss[] {
      if (open.size === 0) return [];
      const out: Miss[] = [];
      for (const [id, w] of open) {
        if ((objects.find((o) => o.id === id)?.active ?? 0) > 0) continue;
        open.delete(id);
        if (!w.hit) out.push({ object: id, type: w.type });
      }
      return out;
    },
  };
}

// ── 情境提示的判断（纯逻辑） ──────────────────────────────────────

export interface HintEnv {
  /** 第三人称（能操控鬼魂）：准星、现身只有这时才有 */
  ghost: boolean;
  /** 准星此刻对着够得着的物件 */
  aiming: boolean;
  /** 暂停中（第三人称开过场、指针没锁着，Click to resume 挂着）：这时不出新的提示 */
  paused: boolean;
}

const manifestReady = (s: Readonly<WorldState>) => s.manifest.phase === 'idle' && s.manifest.cooldown <= 0;

/**
 * 情境提示、做不到时的回应的判断。时间 now 都是秒（真实时间，FrameCtx.time），由调用方给，所以好测。
 * tick 每帧调（这一帧的事件都分发完以后），返回此刻那一行该写哪一句提示；null = 那一行此刻不归提示用（或者正在淡出）
 */
export function createHintCore() {
  const shown = new Set<HintKey>();
  /** 等着上的提示（碰到的先后），at = 碰到的时刻 */
  const queue: { key: HintKey; at: number }[] = [];
  /** 正在显示的提示；done = 它说的那件事已经做了，可以先淡出 */
  let cur: { key: HintKey; since: number; until: number; done: boolean } | null = null;
  /** 淡出的提示什么时候淡完（淡完才把那一行还回去）；0 = 没在淡出 */
  let fadeEnd = 0;
  const misses = createMissWatch();
  /** 此刻手电照着鬼魂的访客 */
  const lit = new Set<number>();
  /** 刚发作的机关（紧跟着的 trigger 不是玩家点的） */
  const sprung = new Set<string>();
  /** 每种「做不到」上一次回应的时刻 */
  const refusedAt = new Map<Refusal, number>();

  const want = (key: HintKey, now: number) => {
    if (shown.has(key) || cur?.key === key) return;
    const q = queue.find((x) => x.key === key);
    if (q) q.at = now; // 又碰到一次：重新算新鲜
    else queue.push({ key, at: now });
  };

  /** 等着的提示此刻还算不算数 */
  const still = (q: { key: HintKey; at: number }, now: number, s: Readonly<WorldState>, env: HintEnv) => {
    switch (q.key) {
      case 'firstAim':
        return env.ghost && env.aiming;
      case 'firstRevealed':
        return env.ghost && lit.size > 0 && manifestReady(s);
      case 'firstMiss':
      case 'firstLure':
        return now - q.at <= HINT.fresh[q.key];
    }
  };

  return {
    /** 已经出过的提示 */
    shown: shown as ReadonlySet<HintKey>,

    /** 准星对准了一个够得着的物件（第三人称） */
    aimed(now: number, env: HintEnv): void {
      if (env.ghost) want('firstAim', now);
    },

    onEvent(e: SimEvent, _s: Readonly<WorldState>, now: number): void {
      misses.onEvent(e);
      switch (e.type) {
        case 'heard':
          want('firstLure', now);
          break;
        case 'reveal':
          if (e.on) lit.add(e.npc);
          else lit.delete(e.npc);
          break;
        case 'exit':
          lit.delete(e.npc); // 照着鬼魂走出门的人（天亮自己走的）不一定先发 reveal off
          break;
        case 'trap':
          if (e.phase === 'sprung') sprung.add(e.object);
          else if (e.phase === 'armed' && cur?.key === 'firstAim') cur.done = true;
          break;
        case 'trigger':
          if (!sprung.delete(e.object) && cur?.key === 'firstAim') cur.done = true;
          break;
        case 'manifest':
          if (e.phase === 'windup' && cur?.key === 'firstRevealed') cur.done = true;
          break;
      }
    },

    tick(now: number, s: Readonly<WorldState>, env: HintEnv): HintKey | null {
      if (misses.settle(s.objects).length > 0) want('firstMiss', now);
      if (!shown.has('firstRevealed') && env.ghost && lit.size > 0 && manifestReady(s)) want('firstRevealed', now);

      if (cur) {
        if (now < cur.until && !(cur.done && now - cur.since >= HINT.minHold)) return cur.key;
        cur = null;
        fadeEnd = now + HINT.fade;
      }
      if (fadeEnd > 0) {
        if (now < fadeEnd) return null;
        fadeEnd = 0;
        bottomLine.release('hint');
      }
      while (queue.length > 0) {
        const q = queue[0];
        if (!still(q, now, s, env)) {
          queue.shift(); // 不算数了：不出，下一次碰到再说
          continue;
        }
        if (env.paused || !bottomLine.claim('hint')) return null; // 暂停中、开场的那一句还挂着：等
        queue.shift();
        shown.add(q.key);
        cur = { key: q.key, since: now, until: now + HINT.hold, done: false };
        return q.key;
      }
      return null;
    },

    /** 做不到：返回这一次要写的那句话；同一种 HINT.refuseGap 秒内再来返回 null（不重复） */
    refused(kind: Refusal, now: number): string | null {
      const last = refusedAt.get(kind);
      if (last !== undefined && now - last < HINT.refuseGap) return null;
      refusedAt.set(kind, now);
      return STRINGS.onboarding.refused[kind];
    },
  };
}

// ── 只在「·」处折行的一行字（操作说明、情境提示、Click to resume 下面那一行共用） ──────────

/**
 * 写一行「A · B · C」：每一节不折行（.hud-seg），只在「·」后面折；「·」用不断行空格粘在前一节后面，
 * 折到行尾的那个由 markLineEnds 藏起来。没有「·」的（一两句话）照常折行
 */
export function setSegments(el: HTMLElement, text: string): void {
  const parts = text.split(' · ');
  if (parts.length === 1) {
    el.textContent = text;
    return;
  }
  el.replaceChildren();
  parts.forEach((part, i) => {
    const seg = document.createElement('span');
    seg.className = 'hud-seg';
    seg.textContent = part;
    el.append(seg);
    if (i === parts.length - 1) return;
    const sep = document.createElement('span');
    sep.className = 'hud-sep';
    sep.textContent = ' ·';
    el.append(sep, ' ');
  });
}

/**
 * 折到行尾的「·」藏起来：只改 visibility，排版不变，不会藏了又折回去来回跳。行要已经排好（显示出来）才量得准；
 * 显示的时候、窗口大小变了的时候调
 */
export function markLineEnds(el: HTMLElement): void {
  for (const sep of el.querySelectorAll<HTMLElement>('.hud-sep')) {
    const next = sep.nextElementSibling as HTMLElement | null;
    sep.classList.toggle('is-eol', next !== null && next.offsetTop > sep.offsetTop + 1);
  }
}

// ── DOM ──────────────────────────────────────────────────

/**
 * root：HUD 的根节点（#hud，createHud 之后建）。提示那一行、做不到的那一句挂在它的 .hud-play 里（跟着游戏中的 HUD 一起显示），
 * 找不到就挂在 root 上
 */
export function createHints(root: HTMLElement): Hints {
  const host = root.querySelector<HTMLElement>('.hud-play') ?? root;
  const line = document.createElement('p');
  line.className = 'hud-note hud-hintline';
  line.setAttribute('role', 'status');
  const refusal = document.createElement('p');
  refusal.className = 'hud-refusal';
  refusal.setAttribute('role', 'status');
  host.append(line, refusal);

  const core = createHintCore();
  const env: HintEnv = { ghost: false, aiming: false, paused: false };
  const unwatch = watchGhostUi((s) => {
    env.ghost = s.active;
    env.aiming = s.aim !== null;
    env.paused = s.active && s.engaged && !s.locked && !s.pending;
  });
  let now = 0;
  let showing: HintKey | null = null;
  /** 做不到的那一句什么时候收起（0 = 没在显示） */
  let refusalOff = 0;
  const onResize = () => {
    if (showing) markLineEnds(line);
  };
  addEventListener('resize', onResize);

  return {
    refused(kind) {
      const text = core.refused(kind, now);
      if (!text) return;
      refusal.textContent = text;
      refusal.classList.add('is-on');
      refusalOff = now + HINT.refuseHold;
    },
    aimed() {
      core.aimed(now, env);
    },
    onEvent(e, state) {
      core.onEvent(e, state, now);
    },
    update(ctx) {
      now = ctx.time;
      const key = core.tick(now, ctx.state, env);
      if (key !== showing) {
        showing = key;
        if (key) {
          setSegments(line, STRINGS.onboarding.hints[key]);
          line.classList.add('is-on');
          markLineEnds(line);
        } else {
          line.classList.remove('is-on');
        }
      }
      if (refusalOff > 0 && now >= refusalOff) {
        refusalOff = 0;
        refusal.classList.remove('is-on');
      }
    },
    dispose() {
      unwatch();
      removeEventListener('resize', onResize);
      line.remove();
      refusal.remove();
      bottomLine.release('hint');
    },
  };
}
