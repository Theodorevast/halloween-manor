// 机关设下后的空心眼睛（src/view/overlays.ts 的 updateMarks、src/styles.css 的 .ov-mark.is-armed .ov-eye）。
// node 里没有 DOM，overlays 的 DOM 没法跑；这里读 styles.css 和 overlays.ts 的文本，守三件事：
// 规则在、颜色滤镜变换是设计定的值；它排在 .is-seen / .is-ready 两条之后（优先级一样，后写的赢，不然 ready 的幽绿会盖回来）；
// overlays.ts 不再给眼睛写行内样式（行内样式比样式表里任何规则都高，之后在 CSS 里就改不动了）。
// 文件末尾一组测悬停标签第二行的文字（tipState 是纯函数，直接调）；再往后是瞄准和反馈（2026-10-30 手感分析）：
// 名牌上的小眼睛（FEEL-1）、结果写在标签上（FEEL-3）、够不着（FEEL-7）、恐惧条（FEEL-10）
import { describe, expect, it } from 'vitest';
import { PROPS, propCenter } from '../src/config/house';
import { SCARES } from '../src/config/scares';
import { STRINGS } from '../src/config/strings';
import { angleOf } from '../src/lib/angle';
import { createWorld } from '../src/sim/world';
import { OUTCOME, WATCH_LINGER, createOutcomeWatch, createWatchLinger, pendingAct, tipState } from '../src/view/overlays';
import type { ManifestState, NpcMode, NpcState, ScareObjectState, ScareType, Vec2, World } from '../src/sim/types';

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

// ── 瞄准和反馈（2026-10-30 手感分析 FEEL-1、FEEL-3、FEEL-7、FEEL-10）────────────────────────────

describe('名字连起来（STRINGS.names，结果和播报合并共用）', () => {
  it('一个、两个、三个、四个以上', () => {
    expect(STRINGS.names(['Theo'])).toBe('Theo');
    expect(STRINGS.names(['Theo', 'Mia'])).toBe('Theo and Mia');
    expect(STRINGS.names(['Theo', 'Mia', 'Sam'])).toBe('Theo, Mia and Sam');
    expect(STRINGS.names(['Theo', 'Mia', 'Sam', 'June'])).toBe('Theo, Mia and 2 others');
    expect(STRINGS.names(['Theo', 'Mia', 'Sam', 'June', 'Ada'])).toBe('Theo, Mia and 3 others');
    expect(STRINGS.names([])).toBe('');
  });
});

describe('此刻待出手的动作（pendingAct，FEEL-1：名牌上的小眼睛按它亮）', () => {
  const idle = { phase: 'idle', t: 0, cooldown: 0, pos: null } as ManifestState;
  it('准星 / 手指对着够得着的物件：附身它（第三人称、娃娃屋一样）', () => {
    expect(pendingAct('lamp-living', { x: 1, z: 2 }, idle)).toEqual({ kind: 'object', id: 'lamp-living' });
    expect(pendingAct('mirror', null, idle)).toEqual({ kind: 'object', id: 'mirror' });
  });
  it('没对着物件、第三人称、现身就绪：在鬼魂所在处现身', () => {
    expect(pendingAct(null, { x: 8, z: 6 }, idle)).toEqual({ kind: 'manifest', at: { x: 8, z: 6 } });
  });
  it('现身在冷却、正在蓄力 / 停留，或者没有鬼魂（娃娃屋）：没有', () => {
    expect(pendingAct(null, { x: 8, z: 6 }, { ...idle, phase: 'cooldown', cooldown: 4 })).toBeNull();
    expect(pendingAct(null, { x: 8, z: 6 }, { ...idle, phase: 'windup', pos: { x: 8, z: 6 } })).toBeNull();
    expect(pendingAct(null, { x: 8, z: 6 }, { ...idle, phase: 'hold', pos: { x: 8, z: 6 } })).toBeNull();
    expect(pendingAct(null, null, idle)).toBeNull();
  });
});

describe('名牌上的小眼睛：样式（FEEL-1）', () => {
  it('收起时 scaleY(0)（占位不变，名牌宽度只在进门时量一次），鬼魂的颜色、一圈黑边，不发光', () => {
    const r = rule('.ov-plate-mark');
    expect(r).not.toBeNull();
    const body = r?.body ?? '';
    expect(body).toMatch(/width:\s*12px\s*;/);
    expect(body).toMatch(/height:\s*7px\s*;/);
    expect(body).toMatch(/color:\s*var\(--ghost\)\s*;/);
    expect(body).toMatch(/transform:\s*scaleY\(0\)\s*;/);
    expect(body).not.toMatch(/125,\s*255,\s*168/);
  });
  it('is-reach 睁开；冷却中（is-cool）灰烬色', () => {
    expect(rule('.ov-plate.is-reach .ov-plate-mark')?.body ?? '').toMatch(/transform:\s*scaleY\(1\)\s*;/);
    expect(rule('.ov-plate.is-reach.is-cool .ov-plate-mark')?.body ?? '').toMatch(/color:\s*var\(--ash\)\s*;/);
  });
  it('overlays.ts 把眼睛插在名字前面（和物件上的眼睛同一个图形），按 reachOf 亮', () => {
    expect(overlays).toMatch(/ov-plate-mark/);
    expect(overlays).toMatch(/reachOf\(/);
    expect(overlays).toMatch(/classList\.toggle\('is-reach'/);
  });
});

describe('恐惧条宽一点、60 的刻度清楚一点（FEEL-10）', () => {
  it('.ov-bar 56 × 4，外框亮一点；.ov-bar-tick 0.55', () => {
    const bar = rule('.ov-bar')?.body ?? '';
    expect(bar).toMatch(/width:\s*56px\s*;/);
    expect(bar).toMatch(/height:\s*4px\s*;/);
    expect(bar).toMatch(/box-shadow:\s*0 0 0 1px rgba\(220,\s*210,\s*189,\s*0?\.22\),\s*0 0 6px rgba\(0,\s*0,\s*0,\s*0?\.9\)\s*;/);
    expect(rule('.ov-bar-tick')?.body ?? '').toMatch(/background:\s*rgba\(220,\s*210,\s*189,\s*0?\.55\)\s*;/);
  });
});

describe('悬停标签第二行先报结果（tipState 的 outcome，FEEL-3）', () => {
  it('惊吓类：有人被吓到写「Theo jumped」（骨白小型大写，tone outcome），几个人连起来；冷却中也先报结果', () => {
    const lamp = objOf('lamp', { cooldown: 7.5 });
    expect(tipState(lamp, crowd, { outcome: { names: ['Theo'] } })).toEqual({ text: 'Theo jumped', tone: 'outcome' });
    expect(tipState(lamp, crowd, { outcome: { names: ['Theo', 'Mia', 'Sam'] } }).text).toBe('Theo, Mia and Sam jumped');
  });
  it('引诱类：「Theo and Mia heard it」', () => {
    expect(tipState(objOf('musicBox', { cooldown: 12 }), crowd, { outcome: { names: ['Theo', 'Mia'] } })).toEqual({ text: 'Theo and Mia heard it', tone: 'outcome' });
  });
  it('窗口结束还没人：No one saw it / No one heard it（灰烬色，同 unseen）', () => {
    expect(tipState(objOf('lamp', { cooldown: 6 }), crowd, { outcome: { names: [] } })).toEqual({ text: 'No one saw it', tone: 'unseen' });
    expect(tipState(objOf('door', { cooldown: 9 }), crowd, { outcome: { names: [] } })).toEqual({ text: 'No one heard it', tone: 'unseen' });
  });
  it('没有结果（null / 不给）：照旧', () => {
    expect(tipState(objOf('lamp', { cooldown: 5.2 }), crowd, { outcome: null })).toEqual({ text: '6s', tone: 'cooling' });
  });
  it('样式：.ov-tip.is-outcome .ov-tip-state 是骨白的小型大写', () => {
    const r = rule('.ov-tip.is-outcome .ov-tip-state');
    expect(r).not.toBeNull();
    expect(r?.body ?? '').toMatch(/font-variant-caps:\s*all-small-caps\s*;/);
    expect(r?.body ?? '').toMatch(/color:\s*var\(--bone\)\s*;/);
  });
});

describe('够不着（tipState 的 far，FEEL-7）', () => {
  it('第二行写 Too far away.（灰烬色），冷却中、设了机关也一样（从这里点不了）', () => {
    const far = { text: STRINGS.onboarding.refused.tooFar, tone: 'far' };
    expect(tipState(objOf('lamp'), crowd, { far: true })).toEqual(far);
    expect(tipState(objOf('lamp', { cooldown: 3 }), crowd, { far: true })).toEqual(far);
    expect(tipState(objOf('bed', { armed: 30 }), crowd, { far: true })).toEqual(far);
  });
  it('刚附身过、结果还挂着：先报结果（那是刚发生的事，不是出手的提示）', () => {
    expect(tipState(objOf('lamp', { cooldown: 7 }), crowd, { far: true, outcome: { names: ['Theo'] } }).text).toBe('Theo jumped');
  });
  it('样式：标签那一行灰烬色斜体；准星外圈变虚线、半透明、不放大', () => {
    const tip = rule('.ov-tip.is-far .ov-tip-state');
    expect(tip?.body ?? '').toMatch(/color:\s*var\(--ash\)\s*;/);
    expect(tip?.body ?? '').toMatch(/font-style:\s*italic\s*;/);
    const ring = rule('.hud-aim.is-far::after');
    expect(ring).not.toBeNull();
    expect(ring?.body ?? '').toMatch(/border-style:\s*dashed\s*;/);
    expect(ring?.body ?? '').toMatch(/opacity:\s*0?\.5\s*;/);
    expect(ring?.body ?? '').toMatch(/transform:\s*none\s*;/);
  });
});

describe('结果的记录（createOutcomeWatch，FEEL-3）：跟着真的模拟走', () => {
  const DT = 1 / 60;
  const prop = (id: string) => propCenter(PROPS.find((p) => p.id === id)!);
  const angleTo = (from: Vec2, to: Vec2) => angleOf(to.x - from.x, to.z - from.z);
  /** 像主循环：每帧推进模拟、分发事件，再 settle；now 是真实时间 */
  function frames(w: World, watch: ReturnType<typeof createOutcomeWatch>, clock: { now: number }, seconds: number, each?: () => void) {
    for (let t = 0; t < seconds - 1e-9; t += DT) {
      clock.now += DT;
      for (const e of w.step(DT)) watch.onEvent(e, w.state, clock.now);
      watch.settle(w.state, clock.now);
      each?.();
    }
  }

  it('看着客厅台灯的 Theo 被吓到：马上写他，停 OUTCOME.hold 秒后收起（回到冷却秒数）', () => {
    const w = createWorld({ seed: 7, autoSpawn: false });
    const watch = createOutcomeWatch();
    const clock = { now: 0 };
    const p = { x: 8.6, z: 2.2 };
    const theo = w.spawn({ pos: p, lookDir: angleTo(p, prop('lamp-living')), personality: 'average', name: 'Theo', goal: p });
    frames(w, watch, clock, 0.1, () => { theo.lookDir = angleTo(theo.pos, prop('lamp-living')); });
    expect(watch.current('lamp-living', clock.now)).toBeNull();
    w.trigger('lamp-living');
    frames(w, watch, clock, 0.33);
    expect(watch.current('lamp-living', clock.now)).toEqual({ names: ['Theo'] });
    frames(w, watch, clock, OUTCOME.hold);
    expect(watch.current('lamp-living', clock.now)).toBeNull();
  });

  it('没人看着时附身卧室台灯：窗口（1.5 秒）结束以后写 No one saw it，从那一刻停 OUTCOME.hold 秒', () => {
    const w = createWorld({ seed: 8, autoSpawn: false });
    const watch = createOutcomeWatch();
    const clock = { now: 0 };
    w.trigger('lamp-bedroom');
    frames(w, watch, clock, SCARES.lamp.active - 0.2);
    expect(watch.current('lamp-bedroom', clock.now)).toBeNull(); // 窗口还开着：照旧写冷却秒数
    frames(w, watch, clock, 0.5); // 1.8 秒
    expect(watch.current('lamp-bedroom', clock.now)).toEqual({ names: [] });
    frames(w, watch, clock, OUTCOME.hold);
    expect(watch.current('lamp-bedroom', clock.now)).toBeNull();
  });

  it('引诱类：触发那一步结算，听见的人马上写上；没人听见的马上写 No one heard it（不用等 4 秒的音乐放完）', () => {
    const w = createWorld({ seed: 9, autoSpawn: false });
    const watch = createOutcomeWatch();
    const clock = { now: 0 };
    w.spawn({ pos: { x: 3.5, z: 9.5 }, lookDir: 0, personality: 'average', name: 'Mia', goal: { x: 3.5, z: 9.5 } });
    frames(w, watch, clock, 0.1);
    w.trigger('music-box');
    frames(w, watch, clock, DT);
    expect(watch.current('music-box', clock.now)).toEqual({ names: ['Mia'] });
    w.trigger('kitchen-door');
    frames(w, watch, clock, DT);
    expect(watch.current('kitchen-door', clock.now)).toEqual({ names: [] });
  });

  it('这一帧模拟没走（帧率高于 60 或 hit-stop）：引诱还没结算，不急着说没人听见', () => {
    const watch = createOutcomeWatch();
    const s = createWorld({ seed: 10, autoSpawn: false }).state;
    watch.settle(s, 1);
    watch.onEvent({ type: 'trigger', object: 'music-box', scareType: 'musicBox' }, s, 1.01);
    watch.settle(s, 1.01); // 模拟时间没变
    expect(watch.current('music-box', 1.01)).toBeNull();
    watch.settle({ ...s, time: s.time + DT }, 1.02);
    expect(watch.current('music-box', 1.02)).toEqual({ names: [] });
  });

  it('每多一个名字从头计时；同一个人不重复', () => {
    const watch = createOutcomeWatch();
    const w = createWorld({ seed: 11, autoSpawn: false });
    const a = w.spawn({ name: 'Theo', pos: { x: 3, z: 3 } }), b = w.spawn({ name: 'Mia', pos: { x: 3, z: 4 } });
    const s = w.state;
    watch.onEvent({ type: 'trigger', object: 'bed', scareType: 'bed' }, s, 0);
    const bed = s.objects.find((o) => o.id === 'bed')!;
    bed.active = 1;
    watch.onEvent({ type: 'startle', npc: a.id, object: 'bed', amount: 20, scream: false }, s, 2.6);
    watch.settle(s, 2.6);
    watch.onEvent({ type: 'startle', npc: a.id, object: 'bed', amount: 20, scream: false }, s, 3.0);
    watch.onEvent({ type: 'startle', npc: b.id, object: 'bed', amount: 20, scream: false }, s, 3.5);
    watch.settle(s, 3.5);
    expect(watch.current('bed', 3.5 + OUTCOME.hold - 0.05)).toEqual({ names: ['Theo', 'Mia'] });
    bed.active = 0;
    watch.settle(s, 3.6);
    expect(watch.current('bed', 3.5 + OUTCOME.hold + 0.05)).toBeNull();
  });

  it('pending：附身以后、结果报完之前为真（触屏手指抬起 1.5 秒后悬停就收了，标签留着等结果）', () => {
    const w = createWorld({ seed: 8, autoSpawn: false });
    const watch = createOutcomeWatch();
    const clock = { now: 0 };
    expect(watch.pending('lamp-bedroom', 0)).toBe(false);
    w.trigger('lamp-bedroom');
    frames(w, watch, clock, 0.5);
    expect(watch.pending('lamp-bedroom', clock.now)).toBe(true); // 窗口还开着
    frames(w, watch, clock, 1.2); // 1.7 秒：No one saw it 挂着
    expect(watch.current('lamp-bedroom', clock.now)).toEqual({ names: [] });
    expect(watch.pending('lamp-bedroom', clock.now)).toBe(true);
    frames(w, watch, clock, OUTCOME.hold);
    expect(watch.pending('lamp-bedroom', clock.now)).toBe(false);
  });

  it('机关自己发作、没吓到人：不写 No one saw it（那一下不是玩家点的，同 createMissWatch）', () => {
    const watch = createOutcomeWatch();
    const s = createWorld({ seed: 12, autoSpawn: false }).state;
    watch.onEvent({ type: 'trap', object: 'bed', phase: 'sprung' }, s, 0);
    watch.onEvent({ type: 'trigger', object: 'bed', scareType: 'bed' }, s, 0);
    watch.settle(s, 4); // active 是 0：窗口已经结束
    expect(watch.current('bed', 4)).toBeNull();
  });
});

// ── 试玩之后的打磨（2026-10-30 第一轮试玩 P1-1 建议 3）：眼睛灭的时候淡掉、标签的「X is watching」留一会儿再换 ─────────────

describe('物件上的眼睛灭的时候慢慢淡掉（P1-1 建议 3）', () => {
  it(`亮起照旧（0.16 秒睁开）；灭的时候 opacity 用 WATCH_LINGER（${WATCH_LINGER} 秒）淡掉，淡完才收回去，不一帧开一帧关`, () => {
    expect(WATCH_LINGER).toBeGreaterThanOrEqual(0.4);
    expect(WATCH_LINGER).toBeLessThanOrEqual(0.5);
    const base = rule('.ov-eye')?.body ?? '';
    expect(base).toMatch(/opacity:\s*0\s*;/);
    // 灭的时候（回到 .ov-eye 本身的样式）：透明度淡 WATCH_LINGER 秒，眼睛的开合等淡完再收（延迟 WATCH_LINGER 秒）
    expect(base).toMatch(new RegExp(`opacity ${WATCH_LINGER}s`));
    expect(base).toMatch(new RegExp(`transform 0s linear ${WATCH_LINGER}s`));
    // 亮起：睁开照旧 0.16 秒
    const seen = rule('.ov-mark.is-seen .ov-eye')?.body ?? '';
    expect(seen).toMatch(/opacity:\s*1\s*;/);
    expect(seen).toMatch(/transform 0\.16s ease-out/);
    // 设了机关的空心眼睛一直睁着：也要不透明
    expect(rule('.ov-mark.is-armed .ov-eye')?.body ?? '').toMatch(/opacity:\s*1\s*;/);
  });
});

describe('标签第二行的「X is watching」灭的时候留一会儿再换（createWatchLinger，P1-1 建议 3）', () => {
  const watching = { text: 'Theo is watching', tone: 'ready' as const };
  const none = { text: STRINGS.onboarding.noOneWatching, tone: 'unseen' as const };

  it(`有人看着 → 没人看着：先留 WATCH_LINGER 秒还写 Theo is watching，过了才换成 No one is watching`, () => {
    const linger = createWatchLinger();
    expect(linger('lamp', watching, 0)).toEqual(watching);
    expect(linger('lamp', none, 0.1)).toEqual(watching);
    expect(linger('lamp', none, WATCH_LINGER - 0.01)).toEqual(watching);
    expect(linger('lamp', none, WATCH_LINGER + 0.01)).toEqual(none);
    // 过了以后不回头
    expect(linger('lamp', none, WATCH_LINGER + 0.02)).toEqual(none);
  });

  it('留着的时候又有人看着：马上写新的（名字跟着换），从那一刻重新算', () => {
    const linger = createWatchLinger();
    linger('lamp', watching, 0);
    expect(linger('lamp', none, 0.2)).toEqual(watching);
    const mia = { text: 'Mia is watching', tone: 'ready' as const };
    expect(linger('lamp', mia, 0.3)).toEqual(mia);
    expect(linger('lamp', none, 0.3 + WATCH_LINGER - 0.01)).toEqual(mia);
  });

  it('结果、够不着、机关、冷却这几种的优先级不变：马上换，不留', () => {
    for (const st of [
      { text: 'Theo jumped', tone: 'outcome' as const },
      { text: 'No one saw it', tone: 'unseen' as const },
      { text: STRINGS.onboarding.refused.tooFar, tone: 'far' as const },
      { text: STRINGS.trapSet, tone: 'armed' as const },
      { text: '6s', tone: 'cooling' as const },
    ]) {
      const linger = createWatchLinger();
      linger('lamp', watching, 0);
      expect(linger('lamp', st, 0.05)).toEqual(st);
      // 之后变成没人看着：也不再拿出很早以前那个名字
      expect(linger('lamp', none, 0.1)).toEqual(none);
    }
  });

  it('换了物件不留（标签说的是这一个物件）；引诱类的 Ready 不算「有人看着」', () => {
    const linger = createWatchLinger();
    linger('lamp', watching, 0);
    expect(linger('mirror', none, 0.1)).toEqual(none);
    const l2 = createWatchLinger();
    l2('music-box', { text: STRINGS.ready, tone: 'ready' }, 0);
    expect(l2('music-box', none, 0.1)).toEqual(none);
  });
});
