// 访客登记簿的记录（2026-10-30「一夜」）：纯 TypeScript，吃 SimEvent 和 WorldState（vitest 直接测），页面在 registerView.ts。
// 每个访客一行：名字 · 性格标注 · 穿哪套；第二行是几点进来、怎么走的。
// 「怎么走的」= 逃跑之前最后一个让他恐惧值上涨的事件，逃跑那一刻定下来：
//   物件的 startle、引诱类的 heard（听见了也涨恐惧值）→ ranFrom；那一下是机关发作的（trap sprung 紧跟着那件的 trigger）→ trap
//   现身落下（manifest drop 的 scared）→ sawYou
//   后颈一凉、慢慢发毛（chill）→ coldBreath
//   被别人的尖叫吓到（startle 的 object 为 null）→ scream
//   现身落下、后颈一凉同一步还有一个 object = GHOST_SOURCE 的 startle：是同一笔恐惧值，不改上面记下的
// 天亮自己走的（exit 带 calm）写 leftAtDawn，不算吓跑；还在屋里的写 stillInside。
// 钟点：模拟时间 0 是 NIGHT.clock.start 点，NIGHT.dawn 是 NIGHT.clock.end 点，中间线性，过了天亮照样往后走。
// Keep haunting 以后是新的一夜（newNight，整体审查 I-3）：换一页（上一夜的人、墙上多一个影子那一句不再带），钟点从这一夜开始的时刻算。
// 页脚两三句，数字用英文单词写在句子里。不做大号数字、表格、打分、评级
import { VISITOR_SPECS } from '../config/character';
import { NIGHT } from '../config/night';
import { STRINGS } from '../config/strings';
import { GHOST_SOURCE } from '../sim/types';
import type { Personality, ScareType, SimEvent, WorldState } from '../sim/types';

const R = STRINGS.register;
const F = R.footer;

export const REGISTER = {
  /** 一页最多写几行（宽屏两栏各六行）；多出来的一句 andOthers 带过（只多一个时整页都写，不写 "and one others"） */
  maxLines: 12,
  /** 页脚最多几句（cameRan 算一句；墙上多一个影子那一句也算） */
  footer: 3,
};

// ── 钟点 ─────────────────────────────────────────────

const DAY = 24 * 60;

/** 模拟时间 → 从第 0 天零点算起的第几分钟（往下取整，钟面上 9:12 就是 9:12 到 9:13 之间） */
function minuteOf(t: number): number {
  const { start, end } = NIGHT.clock;
  const hours = (((end - start) % 24) + 24) % 24 || 24;
  return Math.floor(start * 60 + (t * hours * 60) / NIGHT.dawn + 1e-6);
}

/** 模拟时间 → 钟点（"9:12 pm"）。meridiem = false 时不带 am / pm（一行里第二个钟点和第一个同在上午或下午时） */
export function clockAt(t: number, meridiem = true): string {
  const m = ((minuteOf(t) % DAY) + DAY) % DAY;
  const h = Math.floor(m / 60);
  const text = `${h % 12 || 12}:${String(m % 60).padStart(2, '0')}`;
  return meridiem ? `${text} ${h < 12 ? R.meridiem.am : R.meridiem.pm}` : text;
}

/** 两个时刻在同一天的同一个半天（都是上午或都是下午） */
const sameHalf = (a: number, b: number) => Math.floor(minuteOf(a) / 720) === Math.floor(minuteOf(b) / 720);

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
 * 只从 VISITOR_SPECS 里找：并进访客轮换（开发服务器、COLLAB=1 构建，地址带 ?collab）时才找得到，默认构建里 COLLAB_SPECS 连同名字整个被摇掉。
 * 给不出（还没建好角色、穿备用小人）时是空串：这一项不写
 */
export function outfitName(id: string | undefined): string {
  if (!id) return '';
  if (Object.hasOwn(R.outfit, id)) return R.outfit[id];
  return VISITOR_SPECS.find((s) => s.label && s.url.endsWith(`/${id}.glb`))?.label ?? '';
}

// ── 记录 ─────────────────────────────────────────────

/** 怎么走的（逃跑之前最后一个让他恐惧值上涨的事件） */
export type Cause =
  | { kind: 'prop'; prop: ScareType; trap: boolean }
  | { kind: 'sawYou' }
  | { kind: 'coldBreath' }
  | { kind: 'scream' };

interface Visitor {
  id: number;
  name: string;
  personality: Personality;
  /** 进门（spawn）的模拟时刻；没见过他的 spawn（登记簿建得比他进门晚）为 null，那一行不写几点进来 */
  cameAt: number | null;
  /** 最近一次让他恐惧值上涨的事件；逃跑那一刻定下来 */
  cause: Cause | null;
  /** cause 是哪个模拟时刻记下的：同一步里 GHOST_SOURCE 的 startle 不覆盖现身、后颈一凉 */
  causeAt: number;
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
  /** 翻开这一页。now：此刻的模拟时间（还在屋里的人算到这一刻）；maxLines 默认 REGISTER.maxLines */
  page(now: number, maxLines?: number): RegisterPage;
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
  const clock = (t: number, meridiem = true) => clockAt(t - origin, meridiem);

  /** 找这个访客；没记过就从 state.npcs 里记下（cameAt：spawn 那一刻，别的事件先到时为 null）。state 里也没有就记不下 */
  const ensure = (id: number, state: Readonly<WorldState>, cameAt: number | null = null): Visitor | null => {
    const known = byId.get(id);
    if (known) return known;
    const n = state.npcs.find((x) => x.id === id);
    if (!n) return null;
    const v: Visitor = {
      id, name: n.name, personality: n.personality, cameAt,
      cause: null, causeAt: -1, ranAt: null, calmAt: null, sawYou: false, outfit: outfitOf(id),
    };
    byId.set(id, v);
    list.push(v);
    return v;
  };

  /** 恐惧值涨了一下：记下是什么（逃跑、出门以后不再改） */
  const raise = (id: number, cause: Cause | null, state: Readonly<WorldState>) => {
    const v = ensure(id, state);
    if (!v || !cause || v.ranAt !== null || v.calmAt !== null) return;
    v.cause = cause;
    v.causeAt = state.time;
  };

  const propCause = (objectId: string, state: Readonly<WorldState>): Cause | null => {
    const o = state.objects.find((x) => x.id === objectId);
    return o ? { kind: 'prop', prop: o.type, trap: byTrap.get(objectId) ?? false } : null;
  };

  /** 第二行：几点进来、怎么走的。第二个钟点和进门那个同在上午或下午时不再写 am / pm（"came in at 9:12 pm; ran from the wardrobe at 9:18"） */
  const story = (v: Visitor): string => {
    const came = v.cameAt;
    const at = (t: number) => clock(t, came === null || !sameHalf(came - origin, t - origin));
    const parts: string[] = [];
    if (came !== null) parts.push(R.cameIn(clock(came)));
    if (v.ranAt !== null) {
      const time = at(v.ranAt);
      const c = v.cause;
      if (c?.kind === 'prop') parts.push(c.trap ? R.trap(STRINGS.propName[c.prop], time) : R.ranFrom(STRINGS.propName[c.prop], time));
      else if (c?.kind === 'sawYou') parts.push(R.sawYou(time));
      else if (c?.kind === 'coldBreath') parts.push(R.coldBreath(time));
      else if (c?.kind === 'scream') parts.push(R.scream(time));
      // 没记到是什么（调试时直接改了恐惧值）：只写几点进来
    } else if (v.calmAt !== null) parts.push(R.leftAtDawn(at(v.calmAt)));
    else parts.push(R.stillInside);
    return parts.join('; ');
  };

  const line = (v: Visitor): RegisterLine => {
    v.outfit ??= outfitOf(v.id);
    return { id: v.id, name: v.name, tag: STRINGS.personalityTag[v.personality], outfit: outfitName(v.outfit), story: story(v) };
  };

  /** 吓跑人最多的那件物件：至少两个、至少占吓跑的一半、比别的物件都多（"did most of the work" 要说实话）；没有就是 null */
  const busiest = (ran: Visitor[]): ScareType | null => {
    const tally = new Map<ScareType, number>();
    for (const v of ran) if (v.cause?.kind === 'prop') tally.set(v.cause.prop, (tally.get(v.cause.prop) ?? 0) + 1);
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
   * 页脚：有人吓跑时先写 cameRan（came 数所有进来的，ran 只数吓跑的），再按顺序挑能写的，连 cameRan 最多 REGISTER.footer 句：
   *   mostWork（一件物件干了大半的活）→ someSaw（有人见过你现身）→ neverRan（有人天亮自己走了）→ stayedLongest → noneSaw（兜底）。
   * 墙上多一个影子出现过时，最后单独一句 oneMore，也占一句
   */
  const foot = (now: number) => {
    const ran = list.filter((v) => v.ranAt !== null);
    const calm = list.filter((v) => v.calmAt !== null).length;
    const seen = list.filter((v) => v.sawYou).length;
    const out: string[] = [];
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
    return { footer: out, postscript: otherOne ? F.oneMore : '' };
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
          raise(e.npc, propCause(e.object, state), state);
          break;
        case 'startle': {
          if (e.object === null) raise(e.npc, { kind: 'scream' }, state);
          else if (e.object !== GHOST_SOURCE) raise(e.npc, propCause(e.object, state), state);
          else {
            // 现身落下、后颈一凉：同一步前面那个事件已经记过（同一笔恐惧值）。前面没有（手写的事件）就按后颈一凉算
            const v = ensure(e.npc, state);
            const marked = v?.causeAt === t && (v.cause?.kind === 'sawYou' || v.cause?.kind === 'coldBreath');
            if (!marked) raise(e.npc, { kind: 'coldBreath' }, state);
          }
          break;
        }
        case 'chill':
          raise(e.npc, { kind: 'coldBreath' }, state);
          break;
        case 'manifest':
          if (e.phase !== 'drop') break;
          for (const id of e.scared) {
            const v = ensure(id, state);
            if (v) v.sawYou = true;
            raise(id, { kind: 'sawYou' }, state);
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
    page(now, maxLines = REGISTER.maxLines) {
      const shown = list.length > maxLines + 1 ? list.slice(0, maxLines) : list;
      const hidden = list.length - shown.length;
      return { lines: shown.map(line), others: hidden > 0 ? R.andOthers(inWords(hidden)) : '', ...foot(now) };
    },
  };
}
