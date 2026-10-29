// 机关设下后的空心眼睛（src/view/overlays.ts 的 updateMarks、src/styles.css 的 .ov-mark.is-armed .ov-eye）。
// node 里没有 DOM，overlays 的 DOM 没法跑；这里读 styles.css 和 overlays.ts 的文本，守三件事：
// 规则在、颜色滤镜变换是设计定的值；它排在 .is-seen / .is-ready 两条之后（优先级一样，后写的赢，不然 ready 的幽绿会盖回来）；
// overlays.ts 不再给眼睛写行内样式（行内样式比样式表里任何规则都高，之后在 CSS 里就改不动了）。
// 文件末尾一组测悬停标签第二行的文字（tipState 是纯函数，直接调）
import { describe, expect, it } from 'vitest';
import { tipState } from '../src/view/overlays';
import type { NpcMode, NpcState, ScareObjectState, ScareType } from '../src/sim/types';

// tsconfig 的 types 里只有 vite/client、没有 node 的类型，也不为一个测试把 node 类型加进整个工程：用变量当模块名取 node:fs。
// （不用 ?raw：vitest 默认把 .css 当空文件，?raw 也读不到内容）
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const overlays = readFileSync(new URL('../src/view/overlays.ts', import.meta.url), 'utf8');

/** 样式表里「只有这一个选择器」的那条规则：声明块和它在文件里的位置；没有就是 null */
function rule(selector: string): { body: string; at: number } | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return m ? { body: m[1], at: m.index } : null;
}

describe('空心眼睛：样式写在 styles.css 的 .ov-mark.is-armed .ov-eye，不用行内样式（P-5）', () => {
  const armed = rule('.ov-mark.is-armed .ov-eye');

  it('styles.css 里有这条规则：霜的冷白、只留一圈黑边（不发绿光）、眼睛一直睁着（不管有没有人看着它）', () => {
    expect(armed).not.toBeNull();
    const body = armed?.body ?? '';
    expect(body).toMatch(/color:\s*rgb\(190,\s*205,\s*224\)\s*;/);
    expect(body).toMatch(/filter:\s*drop-shadow\(0 0 2px rgba\(0, 0, 0, 0\.95\)\)\s*;/); // 只有黑边这一层
    expect(body).not.toMatch(/125,\s*255,\s*168/); // 不是 .is-ready 那层幽绿的光
    expect(body).toMatch(/transform:\s*scaleY\(1\)\s*;/);
  });

  it('写在 .is-seen、.is-ready 两条规则的后面（选择器的优先级一样，后写的赢；设了机关的物件也可能 is-ready）', () => {
    const seen = rule('.ov-mark.is-seen .ov-eye');
    const ready = rule('.ov-mark.is-ready .ov-eye');
    expect(seen).not.toBeNull();
    expect(ready).not.toBeNull();
    expect(armed?.at ?? -1).toBeGreaterThan(seen?.at ?? Infinity);
    expect(armed?.at ?? -1).toBeGreaterThan(ready?.at ?? Infinity);
  });

  it('overlays.ts 不再给眼睛写行内样式（颜色、滤镜、变换都在样式表里）；换空心 / 实心的内容和 is-armed 类名还在', () => {
    expect(overlays).not.toMatch(/HOLLOW_STYLE/);
    expect(overlays).not.toMatch(/\.eye\.style\b/);
    expect(overlays).toMatch(/classList\.toggle\('is-armed'/);
    expect(overlays).toMatch(/EYE_HOLLOW/);
  });
});

// ── 悬停标签的第二行（2026-10-30 试玩报告 P1-2 a「标签说实话」）：view/overlays.ts 的 tipState，纯函数 ──
// 惊吓类物件：有人看着写谁在看（幽绿小型大写，和「现在可以出手」的眼睛同一个颜色），没人看着写 No one is watching（灰烬色）；
// 冷却中照旧写秒数，设了机关照旧写 Trap set；引诱类照旧写 Ready（引诱靠声音，没有「谁看着」）

const objOf = (type: ScareType, patch: Partial<ScareObjectState> = {}): ScareObjectState => ({
  id: type, type, pos: { x: 0, z: 0 }, facing: 0, cooldown: 0, active: 0, broken: 0, seenBy: [], armed: 0, ...patch,
});
const npcOf = (id: number, name: string, mode: NpcMode = 'wander') =>
  ({ id, name, mode, personality: 'average', fear: 0 }) as unknown as NpcState;
const crowd = [npcOf(1, 'Theo'), npcOf(2, 'Mia'), npcOf(3, 'Sam'), npcOf(4, 'June', 'leaving')];

describe('悬停标签的第二行：标签说实话（tipState）', () => {
  it('惊吓类、没人看着：No one is watching，灰烬色（unseen）', () => {
    expect(tipState(objOf('lamp'), crowd)).toEqual({ text: 'No one is watching', tone: 'unseen' });
  });

  it('一个人看着：「Theo is watching」，幽绿（ready）', () => {
    expect(tipState(objOf('lamp', { seenBy: [1] }), crowd)).toEqual({ text: 'Theo is watching', tone: 'ready' });
  });

  it('两个人：「Theo and one other are watching」；三个以上：「Theo and others are watching」（名字取先进门的那位，不来回换）', () => {
    expect(tipState(objOf('mirror', { seenBy: [1, 2] }), crowd).text).toBe('Theo and one other are watching');
    expect(tipState(objOf('mirror', { seenBy: [2, 1, 3] }), crowd).text).toBe('Mia and others are watching');
  });

  it('天亮自己往外走的人（leaving）看着它：照常写他在看，不写成害怕或者在逃', () => {
    const s = tipState(objOf('portrait', { seenBy: [4] }), crowd);
    expect(s).toEqual({ text: 'June is watching', tone: 'ready' });
    expect(s.text).not.toMatch(/fle|scared|afraid|leav/i);
  });

  it('seenBy 里的人已经不在名单上（刚出门）：不算', () => {
    expect(tipState(objOf('bed', { seenBy: [99] }), crowd)).toEqual({ text: 'No one is watching', tone: 'unseen' });
  });

  it('冷却中照旧写秒数（有人看着也一样）', () => {
    expect(tipState(objOf('lamp', { cooldown: 5.2, seenBy: [1] }), crowd)).toEqual({ text: '6s', tone: 'cooling' });
  });

  it('设了机关照旧写 Trap set（有人看着也一样）', () => {
    expect(tipState(objOf('wardrobe', { armed: 40, seenBy: [1] }), crowd)).toEqual({ text: 'Trap set', tone: 'armed' });
  });

  it('引诱类照旧写 Ready（幽绿）', () => {
    expect(tipState(objOf('musicBox'), crowd)).toEqual({ text: 'Ready', tone: 'ready' });
    expect(tipState(objOf('door'), crowd)).toEqual({ text: 'Ready', tone: 'ready' });
  });

  it('样式：没人看着那一行是灰烬色的小型大写（styles.css 的 .ov-tip.is-unseen .ov-tip-state）', () => {
    const r = rule('.ov-tip.is-unseen .ov-tip-state');
    expect(r).not.toBeNull();
    expect(r?.body ?? '').toMatch(/font-variant-caps:\s*all-small-caps\s*;/);
    expect(r?.body ?? '').toMatch(/color:\s*var\(--ash\)\s*;/);
  });
});
