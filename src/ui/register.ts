// 访客登记簿的记录（2026-10-30「一夜」）：纯 TypeScript，吃 SimEvent 和 WorldState（vitest 直接测），页面在 registerView.ts。
// 每个访客一行：名字 · 性格标注 · 穿哪套；第二行是几点进来、怎么走的。
// 「怎么走的」= 逃跑之前让他恐惧值涨得最多的那一类来源（2026-10-30 路 GP，critic S-4：原来只记最后一下，
// 两次现身吓到 95、最后几点是后颈一凉的人写成 felt a cold breath）。逃跑那一刻定下来，四类：
//   物件（startle、引诱类的 heard：听见了也涨恐惧值）→ ranFrom，写这一类里涨得最多的那一件；那件是机关发作的（trap sprung 紧跟着
//     那件的 trigger）→ trap（同一件物件机关和附身分开算）
//   现身落下（manifest drop 的 scared，同一步紧跟着的 object = GHOST_SOURCE 的 startle 是那一笔）→ sawYou
//   后颈一凉、慢慢发毛（chill；后颈一凉同一步紧跟着的 GHOST_SOURCE startle 是同一笔，不另加）→ coldBreath
//   被别人的尖叫吓到（startle 的 object 为 null）→ scream
//   每一类把涨的恐惧值加起来（事件里的 amount；手写的 heard 没有 amount 时按物件的基础恐惧值），一样多时最近涨过的那一类算
// 天亮自己走的（exit 带 calm）写 leftAtDawn，不算吓跑；还在屋里的写 stillInside。
// 钟点：模拟时间 0 是 NIGHT.clock.start 点，NIGHT.dawn 是 NIGHT.clock.end 点，中间线性，过了天亮照样往后走。
// Keep haunting 以后是新的一夜（newNight，整体审查 I-3）：换一页（上一夜的人、墙上多一个影子那一句不再带），钟点从这一夜开始的时刻算。
// 页脚两三句，数字用英文单词写在句子里。不做大号数字、表格、打分、评级。
// 收夜那一页（page 的 closing）页脚第一句是一句评语（STRINGS.register.verdict，2026-10-30 路 GP）：按这一夜吓跑的比例，克制，不计分
import { VISITOR_SPECS } from '../config/character';
import { NIGHT } from '../config/night';
import { SCARES } from '../config/scares';
import { STRINGS } from '../config/strings';
import { GHOST_SOURCE } from '../sim/types';
import type { Personality, ScareType, SimEvent, WorldState } from '../sim/types';

const R = STRINGS.register;
const F = R.footer;

export const REGISTER = {
  /** 一页最多写几行（宽屏两栏各六行）；多出来的一句 andOthers 带过（只多一个时整页都写，不写 "and one others"） */
  maxLines: 12,
  /** 页脚最多几句（cameRan 算一句；墙上多一个影子那一句也算；收夜那一页最前面的评语不算在里面） */
  footer: 3,
  /** 评语按吓跑的比例（吓跑的 / 进来的）分档：全跑了 all；至少 most 是 most；有人跑是 few；一个没跑是 none */
  verdict: { most: 0.5 },
};

// ── 钟点 ─────────────────────────────────────────────

const DAY = 24 * 60;

/** 模拟时间 → 从第 0 天零点算起的第几分钟（往下取整，钟面上 9:12 就是 9:12 到 9:13 之间） */
function minuteOf(t: number): number {
  const { start, end } = NIGHT.clock;
  const hours = (((end - start) % 24) + 24) % 24 || 24;
  return Math.floor(start * 60 + (t * hours * 60) / NIGHT.dawn + 1e-6);
}

/** 模拟时间 → 钟点（"9:12 pm"）。一行里的第二个钟点也写 am / pm（2026-10-30 试玩：原来同在上午或下午时省略，"ran at 11:55" 看着像漏写） */
export function clockAt(t: number): string {
  const m = ((minuteOf(t) % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h < 12 ? R.meridiem.am : R.meridiem.pm}`;
}

// ── 数字、造型的名字 ─────────────────────────────────────

/** 数字写进句子：one 到 twenty 写英文单词（STRINGS.register.numbers），再多写阿拉伯数字。capital：句首大写 */
export function inWords(n: number, capital = false): string {
  const words = R.numbers;
  const w = Number.isInteger(n) && n >= 1 && n < words.length ? words[n] : String(n);
  return capital ? w.charAt(0).toUpperCase() + w.slice(1) : w;
}

/**
 * 造型 id（view/characters.ts 的 outfitOf 给的，地址的文件名）→ 登记簿上写的名字。
 * 公开的几套写在 STRINGS.register.outfit；联名两套用 config/character.ts 里 COLLAB_SPECS 自己的 label，
 * 只从 VISITOR_SPECS 里找：并进访客轮换时才找得到（2026-10-30 起默认并进；地址带 ?nocollab 不并），COLLAB=0 构建里 COLLAB_SPECS 连同名字整个被摇掉。
 * 给不出（还没建好角色、穿备用小人）时是空串：这一项不写
 */
export function outfitName(id: string | undefined): string {
  if (!id) return '';
  if (Object.hasOwn(R.outfit, id)) return R.outfit[id];
  return VISITOR_SPECS.find((s) => s.label && s.url.endsWith(`/${id}.glb`))?.label ?? '';
}

// ── 记录 ─────────────────────────────────────────────

/** 来源的键：物件按「哪件 + 是不是机关」分开，别的按类 */
const causeKey = (c: Cause): string => (c.kind === 'prop' ? `prop:${c.prop}:${c.trap ? 'trap' : ''}` : c.kind);

/**
 * 怎么走的：涨得最多的那一类（物件的各件加在一起算一类），一样多时最近涨过的那一类；是物件就写这一类里涨得最多的那一件
 * （一样多时最近的）。没记到任何一笔（调试时直接改了恐惧值）为 null
 */
function mainCause(v: { tally: ReadonlyMap<string, Tally> }): Cause | null {
  const kinds = new Map<Cause['kind'], { amount: number; seq: number; best: Tally }>();
  for (const t of v.tally.values()) {
    const k = kinds.get(t.cause.kind);
    if (!k) kinds.set(t.cause.kind, { amount: t.amount, seq: t.seq, best: t });
    else {
      k.amount += t.amount;
      k.seq = Math.max(k.seq, t.seq);
      if (t.amount > k.best.amount || (t.amount === k.best.amount && t.seq > k.best.seq)) k.best = t;
    }
  }
  let top: { amount: number; seq: number; best: Tally } | null = null;
  for (const k of kinds.values()) if (!top || k.amount > top.amount || (k.amount === top.amount && k.seq > top.seq)) top = k;
  return top ? top.best.cause : null;
}

/** 收夜那一页的评语：按吓跑的比例（REGISTER.verdict）。一个人都没来过时不写 */
export function verdictOf(ran: number, came: number): string | null {
  if (came <= 0) return null;
  const V = R.verdict;
  if (ran >= came) return V.all;
  if (ran / came >= REGISTER.verdict.most) return V.most;
  return ran > 0 ? V.few : V.none;
}

/** 怎么走的（逃跑之前让他恐惧值涨得最多的那一类来源） */
export type Cause =
  | { kind: 'prop'; prop: ScareType; trap: boolean }
  | { kind: 'sawYou' }
  | { kind: 'coldBreath' }
  | { kind: 'scream' };

/** 一个来源（物件按「哪件 + 是不是机关」分开）一共让他涨了多少、最近一次是第几笔（一样多时最近的算） */
interface Tally { cause: Cause; amount: number; seq: number }

interface Visitor {
  id: number;
  name: string;
  personality: Personality;
  /** 进门（spawn）的模拟时刻；没见过他的 spawn（登记簿建得比他进门晚）为 null，那一行不写几点进来 */
  cameAt: number | null;
  /** 各个来源涨了多少（键见 causeKey）；逃跑、出门以后不再加 */
  tally: Map<string, Tally>;
  /**
   * 同一步里紧跟着的 GHOST_SOURCE startle 是哪一笔：现身落下（sawYou，要加上）还是后颈一凉（neck，chill 里已经加过）；
   * at 是那一步的模拟时刻，过了这一步就不算
   */
  ghostNext: { kind: 'sawYou' | 'neck'; at: number } | null;
  /** 开始逃跑的模拟时刻 */
  ranAt: number | null;
  /** 天亮自己走出前门的模拟时刻（exit 带 calm） */
  calmAt: number | null;
  /** 被现身吓到过（manifest drop 的 scared 里有他），页脚 someSaw 数这个 */
  sawYou: boolean;
  /** 穿哪套（outfitOf 给的造型 id）；给不出时为 undefined，翻开时再问 */
  outfit: string | undefined;
}

/** 登记簿上的一行：第一行 名字 · 性格标注 · 穿哪套（空串的项不写），第二行 story */
export interface RegisterLine {
  id: number;
  name: string;
  tag: string;
  outfit: string;
  story: string;
}

export interface RegisterPage {
  /** 按进门的先后，最多 maxLines 行 */
  lines: RegisterLine[];
  /** "and nine others"；都写下了就是空串 */
  others: string;
  /** 页脚两三句散文 */
  footer: string[];
  /** 墙上多一个影子出现过的那一夜：最后单独一句 oneMore；没有就是空串 */
  postscript: string;
}

export interface Register {
  onEvent(e: SimEvent, state: Readonly<WorldState>): void;
  /** 墙上多一个影子出现过 */
  noteOtherOne(): void;
  /**
   * 翻开这一页。now：此刻的模拟时间（还在屋里的人算到这一刻）；maxLines 默认 REGISTER.maxLines；
   * closing：收夜那一页（页脚第一句写评语 verdict），中途翻开的不写
   */
  page(now: number, maxLines?: number, opts?: { closing?: boolean }): RegisterPage;
  /** 新的一夜从模拟时间 t0 开始（Keep haunting）：换一页，名单、墙上多一个影子那一句清掉，钟点按 t − t0 算（第二夜也是 9 pm 起） */
  newNight(t0: number): void;
}

/** outfitOf：访客编号 → 造型 id（正式游戏是 view/characters.ts 的 outfitOf；测试、开发页给假的） */
export function createRegister(outfitOf: (npcId: number) => string | undefined = () => undefined): Register {
  const list: Visitor[] = [];
  const byId = new Map<number, Visitor>();
  /** 每件物件最近一次附身是不是机关发作的（trap sprung 紧跟着那件的 trigger）。冷却完以前不会再附身，之后的 startle、heard 都按它算 */
  const byTrap = new Map<string, boolean>();
  /** 刚发作、还没等到 trigger 的机关 */
  let sprung: string | null = null;
  let otherOne = false;
  /** 这一夜从模拟时间几秒开始（开局 0；Keep haunting 以后是点下去的那一刻）：钟点按离它多久算 */
  let origin = 0;
  const clock = (t: number) => clockAt(t - origin);

  /** 找这个访客；没记过就从 state.npcs 里记下（cameAt：spawn 那一刻，别的事件先到时为 null）。state 里也没有就记不下 */
  const ensure = (id: number, state: Readonly<WorldState>, cameAt: number | null = null): Visitor | null => {
    const known = byId.get(id);
    if (known) return known;
    const n = state.npcs.find((x) => x.id === id);
    if (!n) return null;
    const v: Visitor = {
      id, name: n.name, personality: n.personality, cameAt,
      tally: new Map(), ghostNext: null, ranAt: null, calmAt: null, sawYou: false, outfit: outfitOf(id),
    };
    byId.set(id, v);
    list.push(v);
    return v;
  };

  /** 第几笔（tally 的 seq）：一样多时最近涨过的那一类算 */
  let seq = 0;

  /** 恐惧值涨了 amount：记到这个来源上（逃跑、出门以后不再改） */
  const raise = (id: number, cause: Cause | null, amount: number, state: Readonly<WorldState>) => {
    const v = ensure(id, state);
    if (!v || !cause || v.ranAt !== null || v.calmAt !== null) return;
    const key = causeKey(cause);
    const t = v.tally.get(key);
    seq += 1;
    if (t) {
      t.amount += amount;
      t.seq = seq;
    } else v.tally.set(key, { cause, amount, seq });
  };

  const propCause = (objectId: string, state: Readonly<WorldState>): Cause | null => {
    const o = state.objects.find((x) => x.id === objectId);
    return o ? { kind: 'prop', prop: o.type, trap: byTrap.get(objectId) ?? false } : null;
  };

  /** 引诱类的 heard 涨了多少：事件里有就用（模拟都给）；手写的没有就按物件的基础恐惧值 */
  const heardAmount = (objectId: string, amount: number | undefined, state: Readonly<WorldState>): number => {
    if (amount !== undefined) return amount;
    const o = state.objects.find((x) => x.id === objectId);
    return o ? SCARES[o.type].fear : 0;
  };

  /** 第二行：几点进来、怎么走的（"came in at 9:12 pm; ran from the wardrobe at 9:18 pm"） */
  const story = (v: Visitor): string => {
    const came = v.cameAt;
    const parts: string[] = [];
    if (came !== null) parts.push(R.cameIn(clock(came)));
    if (v.ranAt !== null) {
      const time = clock(v.ranAt);
      const c = mainCause(v);
      if (c?.kind === 'prop') parts.push(c.trap ? R.trap(STRINGS.propName[c.prop], time) : R.ranFrom(STRINGS.propName[c.prop], time));
      else if (c?.kind === 'sawYou') parts.push(R.sawYou(time));
      else if (c?.kind === 'coldBreath') parts.push(R.coldBreath(time));
      else if (c?.kind === 'scream') parts.push(R.scream(time));
      // 没记到是什么（调试时直接改了恐惧值）：只写几点进来
    } else if (v.calmAt !== null) parts.push(R.leftAtDawn(clock(v.calmAt)));
    else parts.push(R.stillInside);
    return parts.join('; ');
  };

  const line = (v: Visitor): RegisterLine => {
    v.outfit ??= outfitOf(v.id);
    return { id: v.id, name: v.name, tag: STRINGS.personalityTag[v.personality], outfit: outfitName(v.outfit), story: story(v) };
  };

  /** 吓跑人最多的那件物件（按每个人怎么走的，mainCause）：至少两个、至少占吓跑的一半、比别的物件都多（"did most of the work" 要说实话）；没有就是 null */
  const busiest = (ran: Visitor[]): ScareType | null => {
    const tally = new Map<ScareType, number>();
    for (const v of ran) {
      const c = mainCause(v);
      if (c?.kind === 'prop') tally.set(c.prop, (tally.get(c.prop) ?? 0) + 1);
    }
    const [first, second] = [...tally].sort((a, b) => b[1] - a[1]);
    if (!first || first[1] < 2 || first[1] * 2 < ran.length || (second && second[1] === first[1])) return null;
    return first[0];
  };

  /** 待得最久的那位（至少两个人走了；吓跑的待到逃跑那一刻、天亮走的待到出门那一刻；最久的还在屋里就不写） */
  const longest = (now: number): { name: string; until: number } | null => {
    if (list.filter((v) => v.ranAt !== null || v.calmAt !== null).length < 2) return null;
    let best: Visitor | null = null;
    let bestStay = -Infinity;
    for (const v of list) {
      if (v.cameAt === null) continue;
      const stay = (v.ranAt ?? v.calmAt ?? now) - v.cameAt;
      if (stay > bestStay + 1e-9) {
        best = v;
        bestStay = stay;
      }
    }
    const until = best?.ranAt ?? best?.calmAt ?? null;
    return best && until !== null ? { name: best.name, until } : null;
  };

  /**
   * 页脚：收夜那一页（closing）先写一句评语（verdict，按吓跑的比例），不占下面的句数；
   * 有人吓跑时写 cameRan（came 数所有进来的，ran 只数吓跑的），再按顺序挑能写的，连 cameRan 最多 REGISTER.footer 句：
   *   mostWork（一件物件干了大半的活）→ someSaw（有人见过你现身）→ neverRan（有人天亮自己走了）→ stayedLongest → noneSaw（兜底）。
   * 墙上多一个影子出现过时，最后单独一句 oneMore，也占一句
   */
  const foot = (now: number, closing: boolean) => {
    const ran = list.filter((v) => v.ranAt !== null);
    const calm = list.filter((v) => v.calmAt !== null).length;
    const seen = list.filter((v) => v.sawYou).length;
    const out: string[] = [];
    const verdict = closing ? verdictOf(ran.length, list.length) : null;
    if (ran.length > 0) out.push(F.cameRan(inWords(list.length, true), inWords(ran.length, true)));
    const picks: string[] = [];
    const prop = busiest(ran);
    if (prop) picks.push(F.mostWork(STRINGS.propName[prop]));
    if (seen > 0) picks.push(F.someSaw(inWords(seen, true)));
    if (calm > 0) picks.push(F.neverRan(inWords(calm, true)));
    const stay = longest(now);
    if (stay) picks.push(F.stayedLongest(stay.name, clock(stay.until)));
    if (list.length > 0 && seen === 0) picks.push(F.noneSaw);
    out.push(...picks.slice(0, Math.max(0, REGISTER.footer - out.length - (otherOne ? 1 : 0))));
    return { footer: verdict ? [verdict, ...out] : out, postscript: otherOne ? F.oneMore : '' };
  };

  return {
    onEvent(e, state) {
      const t = state.time;
      switch (e.type) {
        case 'spawn':
          ensure(e.npc, state, t);
          break;
        case 'trap':
          if (e.phase === 'sprung') sprung = e.object;
          break;
        case 'trigger':
          byTrap.set(e.object, sprung === e.object);
          sprung = null;
          break;
        case 'heard':
          raise(e.npc, propCause(e.object, state), heardAmount(e.object, e.amount, state), state);
          break;
        case 'startle': {
          if (e.object === null) raise(e.npc, { kind: 'scream' }, e.amount, state);
          else if (e.object !== GHOST_SOURCE) raise(e.npc, propCause(e.object, state), e.amount, state);
          else {
            // 现身落下：这一笔就是现身吓的（drop 事件只说吓到了谁，涨多少在这里）。后颈一凉：chill 里已经加过，不另加。
            // 同一步前面都没有（手写的事件）就按后颈一凉算
            const v = ensure(e.npc, state);
            const next = v?.ghostNext?.at === t ? v.ghostNext : null;
            if (v) v.ghostNext = null;
            if (next?.kind === 'sawYou') raise(e.npc, { kind: 'sawYou' }, e.amount, state);
            else if (!next) raise(e.npc, { kind: 'coldBreath' }, e.amount, state);
          }
          break;
        }
        case 'chill': {
          raise(e.npc, { kind: 'coldBreath' }, e.amount, state);
          const v = e.neck ? byId.get(e.npc) : undefined;
          if (v) v.ghostNext = { kind: 'neck', at: t };
          break;
        }
        case 'manifest':
          if (e.phase !== 'drop') break;
          for (const id of e.scared) {
            const v = ensure(id, state);
            if (!v) continue;
            v.sawYou = true;
            v.ghostNext = { kind: 'sawYou', at: t };
          }
          break;
        case 'flee': {
          const v = ensure(e.npc, state);
          if (v && v.ranAt === null && v.calmAt === null) v.ranAt = t;
          break;
        }
        case 'exit': {
          // 出门时模拟已经把人从 state.npcs 里拿掉了：只认记过的人（按编号，不按名字：一夜里可能重名）
          const v = byId.get(e.npc);
          if (!v || v.ranAt !== null || v.calmAt !== null) break;
          if (e.calm) v.calmAt = t;
          else v.ranAt = t; // 兜底：没收到 flee 就按出门那一刻算
          break;
        }
      }
    },
    noteOtherOne() {
      otherOne = true;
    },
    newNight(t0) {
      list.length = 0;
      byId.clear();
      sprung = null;
      otherOne = false;
      origin = t0;
    },
    page(now, maxLines = REGISTER.maxLines, opts = {}) {
      const shown = list.length > maxLines + 1 ? list.slice(0, maxLines) : list;
      const hidden = list.length - shown.length;
      return { lines: shown.map(line), others: hidden > 0 ? R.andOthers(inWords(hidden)) : '', ...foot(now, opts.closing === true) };
    },
  };
}
