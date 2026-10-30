// 路 HT（2026-10-30 用户试玩：「F 没有任何提示，要有游戏说明」；严格玩家 newbie F1、S1、G1、G5，eye S-4、G-1）：
// 开局不空等（src/warmup.ts：分几路预编译、等 GPU 缓过来、进度）、标题页的三步说明和整页可点、常驻的按键说明、
// 准星旁的 F 键帽、失败要说话（现身落空那一句、落空的播报在第一次成功之前不闭嘴）、开场的操作说明留到第一次成功附身。
// 纯逻辑直接测；DOM 的样子读 styles.css 的规则
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three/webgpu';
import { MANIFEST } from '../src/config/visitors';
import { STRINGS } from '../src/config/strings';
import type { ManifestState, SimEvent, WorldState } from '../src/sim/types';
import { createWorld } from '../src/sim/world';
import { bottomLine, createSuccessWatch, createUseWatch, missLineDue } from '../src/ui/hints';
import { KEYS, beginLabel, createOpeningLine, fStatus, hudLines, titleSteps } from '../src/ui/hud';
import { fKeyDue } from '../src/view/overlays';
import { COMPILE_STREAMS, PREHEAT_LIMIT, PROGRESS_WEIGHTS, SETTLE, bootProgress, compileInStreams, compileWhole, createLoopGuard, createSettleGate, drawNothing, partitionDrawables, withDeadline, type CompileRenderer } from '../src/warmup';

// tsconfig 的 types 里没有 node 的类型：同 overlays.test.ts，用变量当模块名取 node:fs
const fsId = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsId)) as { readFileSync(path: URL, encoding: 'utf8'): string };
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
/** styles.css 里某个选择器（整条、照原样）的规则体；没有为 null */
const rule = (selector: string): string | null => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? null;
};

afterEach(() => {
  bottomLine.release('keys');
  bottomLine.release('hint');
  bottomLine.takeRequest('keys');
});

// ── 开局不空等：分几路预编译 ─────────────────────────────────────────

/** 一个小场景：房子（组）下面几件家具；灯罩下面挂着一盏灯；一个网格下面还有子网格；一件本来就藏着 */
function scene() {
  const root = new THREE.Scene();
  const house = new THREE.Group();
  root.add(house);
  const geo = new THREE.BoxGeometry();
  const mesh = (name: string) => {
    const m = new THREE.Mesh(geo);
    m.name = name;
    return m;
  };
  const leaves = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(mesh);
  house.add(...leaves);
  const shade = mesh('shade');
  shade.add(new THREE.PointLight());
  house.add(shade);
  const body = mesh('body');
  const arm = mesh('arm');
  body.add(arm);
  house.add(body);
  const hidden = mesh('hidden');
  hidden.visible = false;
  house.add(hidden);
  return { root, leaves, shade, body, arm, hidden };
}

/** 此刻露着、能被收集到的网格的名字（祖先藏着的也不算） */
const visibleNames = (root: THREE.Object3D) => {
  const out: string[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if ((o as THREE.Mesh).isMesh) out.push(o.name);
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out.sort();
};

describe('开局不空等：整栋房子分几路同时预编译（src/warmup.ts）', () => {
  it('叶子网格轮流分成 n 份；下面挂着灯的、有子网格的不分（每一路都露着）；本来就藏着的不收', () => {
    const s = scene();
    const { parts, shared } = partitionDrawables(s.root, 3);
    expect(parts).toHaveLength(3);
    const flat = parts.flat().map((o) => o.name).sort();
    expect(flat).toEqual(['a', 'arm', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect(Math.max(...parts.map((p) => p.length)) - Math.min(...parts.map((p) => p.length))).toBeLessThanOrEqual(1);
    expect(shared.map((o) => o.name).sort()).toEqual(['body', 'shade']);
  });

  it('每一路收集的那一下只露出自己那一份（加上共用的），每片叶子正好被一路收到；调完全部露回来', async () => {
    const s = scene();
    const seen: string[][] = [];
    const done = compileInStreams(s.root, 3, async () => {
      seen.push(visibleNames(s.root));
    });
    expect(visibleNames(s.root)).toEqual(['a', 'arm', 'b', 'body', 'c', 'd', 'e', 'f', 'g', 'shade']);
    await done;
    expect(seen).toHaveLength(3);
    for (const v of seen) expect(v).toEqual(expect.arrayContaining(['body', 'shade']));
    const leafCount = new Map<string, number>();
    for (const v of seen) for (const n of v) if (n !== 'body' && n !== 'shade') leafCount.set(n, (leafCount.get(n) ?? 0) + 1);
    expect([...leafCount.keys()].sort()).toEqual(['a', 'arm', 'b', 'c', 'd', 'e', 'f', 'g']);
    expect([...leafCount.values()].every((n) => n === 1)).toBe(true);
    expect(s.hidden.visible).toBe(false);
  });

  it('进度：几路加起来，只增不减，全编完是 1', async () => {
    const s = scene();
    const fr: number[] = [];
    const resolvers: (() => void)[] = [];
    const reporters: ((e: { loaded: number; total: number }) => void)[] = [];
    const done = compileInStreams(s.root, 2, (p) => {
      reporters.push(p);
      return new Promise<void>((res) => resolvers.push(res));
    }, (f) => fr.push(f));
    reporters[0]({ loaded: 1, total: 4 });
    reporters[1]({ loaded: 2, total: 2 });
    reporters[0]({ loaded: 1, total: 4 });
    reporters[0]({ loaded: 3, total: 4 });
    resolvers[1]();
    resolvers[0]();
    await done;
    expect(fr[fr.length - 1]).toBe(1);
    for (let i = 1; i < fr.length; i++) expect(fr[i]).toBeGreaterThan(fr[i - 1]);
    expect(fr[0]).toBeCloseTo(1 / 8, 5);
  });

  it(`默认分 ${COMPILE_STREAMS} 路（2 到 8 路之间：本机实测 4、8 差不多，16 反而慢）`, () => {
    expect(COMPILE_STREAMS).toBeGreaterThanOrEqual(2);
    expect(COMPILE_STREAMS).toBeLessThanOrEqual(8);
  });

  it('compileWhole：编的那一下不剔除、渲染目标是给的那个、进度传下去；调完（同步返回时）剔除和渲染目标都恢复', async () => {
    const s = scene();
    const target = {} as THREE.RenderTarget;
    const before = {} as THREE.RenderTarget;
    let current: THREE.RenderTarget | null = before;
    const seen: { culled: boolean; target: unknown; progress: unknown }[] = [];
    const renderer: CompileRenderer = {
      getRenderTarget: () => current,
      setRenderTarget: (t) => { current = t; },
      compileAsync: async (root, _camera, _targetScene, progress) => {
        let culled = false;
        root.traverse((o) => { if (o.frustumCulled) culled = true; });
        seen.push({ culled, target: current, progress });
      },
    };
    const onProgress = () => {};
    const done = compileWhole({ renderer, scene: s.root }, new THREE.PerspectiveCamera(), target, onProgress);
    expect(current).toBe(before);
    expect(s.leaves[0].frustumCulled).toBe(true);
    await done;
    expect(seen).toEqual([{ culled: false, target, progress: onProgress }]);
  });

  it('drawNothing：画的那一下物体的 layers 全关，灯不动（灯少了 lightsNode 要变）；画完恢复，draw 抛错也恢复', () => {
    const s = scene();
    s.leaves[0].layers.set(3);
    const light = s.shade.children[0];
    const masks = { leaf: s.leaves[0].layers.mask, other: s.leaves[1].layers.mask, light: light.layers.mask };
    drawNothing(s.root, () => {
      for (const m of [s.leaves[0], s.leaves[1], s.shade, s.body, s.arm, s.hidden]) expect(m.layers.mask).toBe(0);
      expect(light.layers.mask).toBe(masks.light);
    });
    expect(s.leaves[0].layers.mask).toBe(masks.leaf);
    expect(s.leaves[1].layers.mask).toBe(masks.other);
    expect(() => drawNothing(s.root, () => { throw new Error('x'); })).toThrow('x');
    expect(s.leaves[1].layers.mask).toBe(masks.other);
  });

  it('main.ts 的次序：先空画一帧（不然按 1 倍采样编，真画时全用不上）→ 整栋房子分几路编（带进度）→ 编完才真画第一套访客', () => {
    const main = src('main.ts');
    const empty = main.indexOf('drawNothing(c.scene,');
    const bg = main.indexOf('compileInStreams(c.scene, COMPILE_STREAMS');
    const prewarm = main.indexOf('await characters.prewarm(');
    expect(empty).toBeGreaterThan(0);
    expect(bg).toBeGreaterThan(empty);
    expect(prewarm).toBeGreaterThan(bg);
    expect(main).toMatch(/compileWhole\(c, r\.camera, engine\.post\?\.sceneTarget\(r\.camera\)/);
    expect(main.slice(prewarm, prewarm + 200)).toMatch(/await precompiled/);
  });
});

describe('开局不空等：整栋真画过以后等 GPU 缓过来（createSettleGate）', () => {
  it(`没 start 过不算稳；start 以后连着 ${SETTLE.frames} 帧都不超过 ${SETTLE.slowMs} ms 才稳`, () => {
    const g = createSettleGate();
    expect(g.frame(16, 0)).toBe(false);
    g.start(10);
    for (let i = 0; i < SETTLE.frames - 1; i++) expect(g.frame(16, 10 + i * 0.016)).toBe(false);
    expect(g.frame(16, 10.2)).toBe(true);
  });

  it('中间来一帧长的（GPU 在编管线，整页都停着）：从头数', () => {
    const g = createSettleGate();
    g.start(0);
    for (let i = 0; i < SETTLE.frames - 1; i++) g.frame(16, i * 0.016);
    const t1 = SETTLE.maxWait / 2;
    expect(g.frame(800, t1)).toBe(false);
    for (let i = 0; i < SETTLE.frames - 1; i++) expect(g.frame(16, t1 + i * 0.016)).toBe(false);
    expect(g.frame(16, t1 + 0.2)).toBe(true);
  });

  it(`机器本来就慢（每帧都超过 ${SETTLE.slowMs} ms）：等满 ${SETTLE.maxWait} 秒也算稳`, () => {
    const g = createSettleGate();
    g.start(0);
    let t = 0;
    let ok = false;
    while (!ok && t < SETTLE.maxWait + 1) {
      t += 0.12;
      ok = g.frame(120, t);
    }
    expect(ok).toBe(true);
    expect(t).toBeGreaterThanOrEqual(SETTLE.maxWait);
    expect(t).toBeLessThan(SETTLE.maxWait + 0.2);
  });

  it('main.ts：准备好要等整栋真画过、延后的画过、稳了（WebGL2 还要其余造型有了着落）；准备好之前点了开始的，直接开场', () => {
    const main = src('main.ts');
    const fn = /const becomeReady = \(\) => \{([\s\S]*?)\n {2}\};/.exec(main)?.[1] ?? '';
    for (const need of ['prewarmed', 'bgDone', 'warmAll', 'warmFrames', 'settled', 'outfitsSettled', 'wantBegin', 'start()']) expect(fn, need).toContain(need);
  });

  it('main.ts：GPU 把活干完（queue.onSubmittedWorkDone）才开始数平稳的帧；时间用真实时间，不用每帧最多走 0.1 秒的 time', () => {
    const main = src('main.ts');
    expect(main).toMatch(/onSubmittedWorkDone/);
    expect(main).toMatch(/if \(stage0\.gpu\) settle\.start\(now \/ 1000\)/);
    expect(main).toMatch(/settle\.frame\(gap, now \/ 1000\)/);
  });
});

describe('开局不空等：开场按钮那条细线（bootProgress）', () => {
  const none = { renderer: false, scene: false, compile: 0, drawn: false, gpu: false, settled: false };
  it('各段权重加起来是 1；什么都没做是 0，全做完是 1', () => {
    expect(Object.values(PROGRESS_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    expect(bootProgress(none)).toBe(0);
    expect(bootProgress({ renderer: true, scene: true, compile: 1, drawn: true, gpu: true, settled: true })).toBeCloseTo(1, 6);
  });
  it('每一段往前走，总数只增不减；预编译占得最多（细线真正能动的那一段）', () => {
    const steps = [
      none,
      { ...none, renderer: true },
      { ...none, renderer: true, scene: true },
      { ...none, renderer: true, scene: true, compile: 0.5 },
      { ...none, renderer: true, scene: true, compile: 1 },
      { ...none, renderer: true, scene: true, compile: 1, drawn: true },
      { ...none, renderer: true, scene: true, compile: 1, drawn: true, gpu: true },
    ];
    const ps = steps.map(bootProgress);
    for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect(PROGRESS_WEIGHTS.compile).toBe(Math.max(...Object.values(PROGRESS_WEIGHTS)));
  });
  it('超出 0..1 的比例按 0..1 算', () => {
    expect(bootProgress({ ...none, compile: 2 })).toBeCloseTo(PROGRESS_WEIGHTS.compile, 6);
    expect(bootProgress({ ...none, compile: -1 })).toBe(0);
  });
});

describe('开场按钮和标题页（newbie F1、G5）', () => {
  it('还在点蜡烛：Lighting the candles…；加载中就点了：The candles are almost lit…（记下了，一直写到淡出）；好了：Click / Tap to begin', () => {
    expect(beginLabel({ ready: false, begun: false, touch: false })).toBe(STRINGS.start.loading);
    expect(beginLabel({ ready: false, begun: true, touch: false })).toBe(STRINGS.onboarding.almostLit);
    expect(beginLabel({ ready: true, begun: true, touch: false })).toBe(STRINGS.onboarding.almostLit);
    expect(beginLabel({ ready: true, begun: false, touch: false })).toBe(STRINGS.start.begin);
    expect(beginLabel({ ready: true, begun: false, touch: true })).toBe(STRINGS.onboarding.tapToBegin);
  });

  it('三步说明：第三人称（有 F）照用户给的三句；触屏第二步用 Tap、第三步换成没有 F 的那一句', () => {
    expect(titleSteps({ touch: false, ghost: true })).toEqual([
      'Find someone with a flashlight.',
      'Possess what they are looking at — an eye appears above it. Make a sound first if no one is looking.',
      'Step into their light and press F to appear.',
    ]);
    const tap = titleSteps({ touch: true, ghost: false });
    expect(tap[0]).toBe('Find someone with a flashlight.');
    expect(tap[1].startsWith('Tap what they are looking at')).toBe(true);
    expect(tap.join(' ')).not.toMatch(/\bF\b|press|click/i);
    // 有鼠标的娃娃屋（?dollhouse）：没有现身，也不说 Tap
    const doll = titleSteps({ touch: false, ghost: false });
    expect(doll[1]).toBe(STRINGS.start.steps.look);
    expect(doll[2]).toBe(STRINGS.start.steps.again);
  });

  it('再一行：一夜多长、天亮时怎样', () => {
    expect(STRINGS.start.night).toBe('A night lasts about five minutes. At dawn the house empties.');
  });

  it('整页都能点：加载中按钮是 disabled（脚本靠它判断能不能开场），但不吃点击（pointer-events: none），点击落到整页上', () => {
    expect(rule('.hud-begin:disabled') ?? '').toMatch(/pointer-events:\s*none\s*;/);
    // hud.ts 的 begin 不再因为还没准备好就丢掉这一下
    const hud = src('ui/hud.ts');
    const fn = /const begin = \(\) => \{([\s\S]*?)\n {2}\};/.exec(hud)?.[1] ?? '';
    expect(fn).not.toMatch(/!ready/);
  });

  it('细线：transform 的 transition（合成线程上走，主线程卡着也照走），不用循环的 CSS 动画，不发光', () => {
    const fill = rule('.hud-wick-fill') ?? '';
    expect(fill).toMatch(/transform-origin:\s*0/);
    expect(fill).toMatch(/transition:\s*transform\s+[\d.]+s/);
    expect(fill).not.toMatch(/animation|glow|shadow/);
    expect(rule('.hud-wick') ?? '').not.toMatch(/animation/);
  });
});

// ── 常驻的按键说明、准星旁的 F 键帽 ───────────────────────────────────

const manifest = (patch: Partial<ManifestState> = {}): ManifestState => {
  const s = createWorld({ seed: 3, autoSpawn: false }).state.manifest;
  return { ...s, ...patch };
};

describe('常驻的按键说明（右下角，HT-2）', () => {
  it('F 后面的状态：就绪写 Ready；冷却中写剩几秒（向上取整）；正在现身（蓄力、停留）不写', () => {
    expect(fStatus(manifest({ phase: 'idle', cooldown: 0 }))).toBe(STRINGS.ready);
    expect(fStatus(manifest({ phase: 'cooldown', cooldown: 11.2 }))).toBe('12s');
    expect(fStatus(manifest({ phase: 'cooldown', cooldown: MANIFEST.cooldown }))).toBe(`${MANIFEST.cooldown}s`);
    expect(fStatus(manifest({ phase: 'windup' }))).toBe('');
    expect(fStatus(manifest({ phase: 'hold' }))).toBe('');
  });

  it('三样（玩家点的附身、设下机关、现身）都用过一次才缩成只剩 F；机关自己发作的那一下不算玩家附身', () => {
    const u = createUseWatch();
    u.onEvent({ type: 'trap', object: 'bed', phase: 'sprung' });
    u.onEvent({ type: 'trigger', object: 'bed', scareType: 'bed' });
    expect(u.all).toBe(false);
    u.onEvent({ type: 'trigger', object: 'portrait', scareType: 'portrait' });
    u.onEvent({ type: 'trap', object: 'portrait', phase: 'armed' });
    expect(u.all).toBe(false);
    u.onEvent({ type: 'manifest', phase: 'windup', pos: { x: 1, z: 1 }, scared: [] });
    expect(u.all).toBe(true);
  });

  it('文案在 STRINGS.onboarding.legend：Click possess · Hold set a trap · F appear', () => {
    const l = STRINGS.onboarding.legend;
    expect(`${l.click} ${l.possess} · ${l.hold} ${l.trap} · ${STRINGS.onboarding.fKey} ${l.appear}`).toBe('Click possess · Hold set a trap · F appear');
  });

  it('样式：骨白的键、灰烬色的动作，垫一层很淡的黑底；缩起来以后附身、机关两行收起；暂停、收夜那几秒让开', () => {
    expect(rule('.hud-legend')).not.toBeNull();
    expect(rule('.hud-legend.is-compact .hud-legend-row[data-row="possess"]') ?? rule('.hud-legend.is-compact .hud-legend-more')).not.toBeNull();
    expect(css).toMatch(/\.hud-play\.is-paused \.hud-legend/);
    expect(css).toMatch(/\.hud-play\.is-closing \.hud-legend/);
    expect(rule('.hud-legend') ?? '').not.toMatch(/glow|animation/);
  });
});

describe('准星旁的 F 键帽（HT-3：有人此刻能被现身吓到才出）', () => {
  it('fKeyDue：有鬼魂、现身就绪（idle、冷却为 0）、reachOf 现身那一种不空', () => {
    const g = { x: 3, z: 6 };
    expect(fKeyDue(g, manifest({ phase: 'idle', cooldown: 0 }), [1])).toBe(true);
    expect(fKeyDue(g, manifest({ phase: 'idle', cooldown: 0 }), [])).toBe(false);
    expect(fKeyDue(g, manifest({ phase: 'cooldown', cooldown: 4 }), [1])).toBe(false);
    expect(fKeyDue(g, manifest({ phase: 'windup' }), [1])).toBe(false);
    expect(fKeyDue(null, manifest({ phase: 'idle', cooldown: 0 }), [1])).toBe(false);
  });

  it('overlays.ts 按 reachOf 的现身那一种算（和名牌上的小眼睛同一套规则），灭的时候用 holdOn 留一会儿，不一闪一闪', () => {
    const ov = src('view/overlays.ts');
    expect(ov).toMatch(/reachOf\(grid, state, \{ kind: 'manifest'/);
    expect(ov).toMatch(/fKeyDue\(/);
    expect(ov).toMatch(/holdOn\([^)]*fKey/);
  });

  it('样式：小小的键帽（细框、底边略厚），不发光、不弹跳，淡入淡出', () => {
    const k = rule('.ov-fkey') ?? '';
    expect(k).toMatch(/opacity:\s*0\s*;/);
    expect(k).toMatch(/transition:\s*opacity/);
    expect(k).not.toMatch(/glow|animation|scale\(/);
    expect(rule('.ov-fkey.is-on') ?? '').toMatch(/opacity:\s*1\s*;/);
  });
});

// ── 失败要说话 ───────────────────────────────────────────────────

describe('失败要说话（newbie S1）', () => {
  const s = createWorld({ seed: 3, autoSpawn: false }).state as WorldState;
  const drop = (scared: number[]): SimEvent => ({ type: 'manifest', phase: 'drop', pos: { x: 3, z: 6 }, scared });

  it('现身落下、谁也没吓到：播一句 No one saw you. Stand in their light.（安静的灰字）', () => {
    expect(STRINGS.onboarding.manifestMissed).toBe('No one saw you. Stand in their light.');
    expect(hudLines(drop([]), s, { manifestMiss: true })).toEqual({ lines: [{ text: STRINGS.onboarding.manifestMissed, tone: 'quiet' }], count: null });
    // 不该说的时候（成功过、也说够了）不说
    expect(hudLines(drop([]), s, { manifestMiss: false }).lines).toEqual([]);
    // 蓄力、收回不说
    expect(hudLines({ type: 'manifest', phase: 'windup', pos: { x: 3, z: 6 }, scared: [] }, s, { manifestMiss: true }).lines).toEqual([]);
  });

  it('吓到了人照旧每人一行 saw you in the dark，不说落空', () => {
    const w = createWorld({ seed: 3, autoSpawn: false });
    const n = w.spawn({ pos: { x: 3, z: 6 }, name: 'Theo' });
    expect(hudLines(drop([n.id]), w.state, { manifestMiss: true }).lines).toEqual([{ text: STRINGS.ticker.seen('Theo'), tone: 'scare' }]);
  });

  it('落空的播报：第一次成功之前每次都说（原来 3 次就停）；成功过以后只在一共说过的不到 3 次时说', () => {
    for (let said = 0; said < 20; said++) expect(missLineDue(said, false)).toBe(true);
    expect(missLineDue(0, true)).toBe(true);
    expect(missLineDue(2, true)).toBe(true);
    expect(missLineDue(3, true)).toBe(false);
  });

  it('成功：附身的物件吓到了人（这个物件的 startle，机关发作的也算）；现身吓到了人。尖叫传染、后颈一凉不算附身成功', () => {
    const w = createSuccessWatch();
    w.onEvent({ type: 'startle', npc: 1, object: null, amount: 3, scream: false });
    w.onEvent({ type: 'startle', npc: 1, object: 'ghost', amount: 9, scream: false });
    w.onEvent({ type: 'manifest', phase: 'drop', pos: { x: 1, z: 1 }, scared: [] });
    expect(w.possession).toBe(false);
    expect(w.manifest).toBe(false);
    w.onEvent({ type: 'startle', npc: 1, object: 'lamp-living', amount: 18, scream: false });
    expect(w.possession).toBe(true);
    w.onEvent({ type: 'manifest', phase: 'drop', pos: { x: 1, z: 1 }, scared: [1] });
    expect(w.manifest).toBe(true);
  });

  it('hud.ts：两种落空都按 missLineDue 说（附身看附身成功过没有，现身看现身成功过没有），不再有「只说 3 次」的硬上限', () => {
    const hud = src('ui/hud.ts');
    expect(hud).toMatch(/missLineDue\(missedSaid, success\.possession\)/);
    expect(hud).toMatch(/missLineDue\(manifestSaid, success\.manifest\)/);
    expect(hud).not.toMatch(/missedSaid >= MISSED_LINES/);
  });
});

describe('开场的操作说明留到第一次成功附身为止（newbie G1），最多约 30 秒，中间让给情境提示', () => {
  /** 推进到 t（每 0.1 秒一步），返回最后一次的「显示没有」 */
  const run = (line: ReturnType<typeof createOpeningLine>, from: number, to: number, o: { ok?: boolean; want?: () => boolean } = {}) => {
    let on = false;
    for (let t = from; t <= to + 1e-9; t += 0.1) on = line.tick(t, o.ok ?? false, o.want?.() ?? false);
    return on;
  };

  it(`开场后 ${KEYS.delay} 秒出来；一直没成功附身也最多挂 ${KEYS.max} 秒（试玩：两行字整夜压在画面下沿，右下角已有常驻说明），淡完还回那一行，不再回来`, () => {
    const line = createOpeningLine();
    line.start(0);
    expect(bottomLine.owner).toBe('keys'); // 开场一开始就先占着那一行
    expect(run(line, 0, KEYS.delay - 0.2)).toBe(false);
    expect(run(line, KEYS.delay - 0.1, KEYS.delay + 0.1)).toBe(true);
    const end = KEYS.delay + KEYS.max;
    expect(run(line, KEYS.delay + 0.2, end - 0.2)).toBe(true);
    expect(run(line, end - 0.1, end + 0.2)).toBe(false);
    expect(bottomLine.owner).toBe('keys'); // 淡出中还占着
    run(line, end + 0.3, end + KEYS.fade + 0.5);
    expect(bottomLine.owner).toBeNull();
    expect(line.done).toBe(true);
    expect(run(line, end + 10, end + 300)).toBe(false);
  });

  it(`让给提示再回来的：显示的时间加起来也不超过 ${KEYS.max} 秒`, () => {
    const line = createOpeningLine();
    line.start(0);
    // 第一次挂满 hold 就让给在等的提示；提示占着那一段不算显示
    run(line, 0, KEYS.delay + KEYS.hold + KEYS.fade + 0.5, { want: () => true });
    let shown = 0;
    for (let t = KEYS.delay + KEYS.hold + KEYS.fade + 0.6; t < 200; t += 0.1) if (line.tick(t, false, false)) shown += 0.1;
    expect(shown).toBeGreaterThan(KEYS.max - KEYS.hold - 0.5);
    expect(shown).toBeLessThan(KEYS.max - KEYS.hold + 0.5);
    expect(line.done).toBe(true);
  });

  it(`让给提示时已经只剩不到 ${KEYS.again} 秒：不再回来（不出来闪一下就走）`, () => {
    const line = createOpeningLine();
    line.start(0);
    let t = 0;
    const step = (seconds: number, want = false) => {
      for (const end = t + seconds; t < end; t += 0.1) line.tick(t, false, want);
    };
    step(KEYS.delay + 0.1); // 出来了
    step(KEYS.max - 1.2); // 显示到只剩约 1 秒
    step(KEYS.fade + 0.5, true); // 提示要用：让出来、淡完
    expect(bottomLine.owner).toBeNull();
    expect(line.done).toBe(true);
    expect(line.tick(t + 1, false, false)).toBe(false);
  });

  it('上限约 30 秒，比第一次至少挂的时间长', () => {
    expect(KEYS.max).toBeGreaterThanOrEqual(25);
    expect(KEYS.max).toBeLessThanOrEqual(35);
    expect(KEYS.max).toBeGreaterThan(KEYS.hold);
  });

  it(`成功附身以后：第一次至少停满 ${KEYS.hold} 秒，再淡出（${KEYS.fade} 秒）、把那一行还回去，不再回来`, () => {
    const line = createOpeningLine();
    line.start(0);
    run(line, 0, KEYS.delay + 1);
    expect(run(line, KEYS.delay + 1.1, KEYS.delay + KEYS.hold - 0.2, { ok: true })).toBe(true);
    expect(run(line, KEYS.delay + KEYS.hold - 0.1, KEYS.delay + KEYS.hold + 0.2, { ok: true })).toBe(false);
    expect(bottomLine.owner).toBe('keys'); // 淡出中还占着
    run(line, KEYS.delay + KEYS.hold + 0.3, KEYS.delay + KEYS.hold + KEYS.fade + 0.5, { ok: true });
    expect(bottomLine.owner).toBeNull();
    expect(line.done).toBe(true);
    expect(run(line, 30, 60, { ok: true })).toBe(false);
  });

  it(`情境提示在等那一行：第一次停满 ${KEYS.hold} 秒以后让出来；提示用完还回来，接着挂（还没成功附身）`, () => {
    const line = createOpeningLine();
    line.start(0);
    run(line, 0, KEYS.delay + 1);
    // 提示一直在等：头 KEYS.hold 秒不让
    expect(run(line, KEYS.delay + 1.1, KEYS.delay + KEYS.hold - 0.2, { want: () => true })).toBe(true);
    // 停满了：淡出、淡完把那一行还回去
    run(line, KEYS.delay + KEYS.hold - 0.1, KEYS.delay + KEYS.hold + KEYS.fade + 0.3, { want: () => true });
    expect(bottomLine.owner).toBeNull();
    expect(bottomLine.claim('hint')).toBe(true);
    // 提示占着：操作说明不回来
    const t1 = KEYS.delay + KEYS.hold + KEYS.fade + 0.4;
    expect(run(line, t1, t1 + 5)).toBe(false);
    bottomLine.release('hint');
    expect(run(line, t1 + 5.1, t1 + 5.3)).toBe(true);
    expect(line.done).toBe(false);
  });

  it(`再回来的那几次：又有提示在等，挂满 ${KEYS.again} 秒就让（不一闪就走）`, () => {
    const line = createOpeningLine();
    line.start(0);
    run(line, 0, KEYS.delay + KEYS.hold + 0.1, { want: () => true });
    // 让出来、淡完、没有提示来占：回来（记下回来的那一刻）
    let back = NaN;
    for (let t = KEYS.delay + KEYS.hold + 0.2; t < 30 && Number.isNaN(back); t += 0.1) if (line.tick(t, false, false)) back = t;
    expect(back).toBeGreaterThanOrEqual(KEYS.delay + KEYS.hold + KEYS.fade);
    expect(run(line, back + 0.1, back + KEYS.again - 0.15, { want: () => true })).toBe(true);
    expect(run(line, back + KEYS.again, back + KEYS.again + 0.2, { want: () => true })).toBe(false);
  });

  it('情境提示等那一行时要一声（bottomLine.request），开场的那一句每帧读一次（takeRequest，读完就清）', () => {
    expect(bottomLine.takeRequest('keys')).toBe(false);
    bottomLine.request('hint');
    expect(bottomLine.takeRequest('keys')).toBe(true);
    expect(bottomLine.takeRequest('keys')).toBe(false);
    // 自己要的不算
    bottomLine.request('keys');
    expect(bottomLine.takeRequest('keys')).toBe(false);
  });
});

describe('暂停、做不到的那一句读得出来（eye S-4）', () => {
  it('暂停（Click to resume 挂着）：画面整体压暗再放字', () => {
    const dim = rule('.hud-play.is-paused::before') ?? '';
    expect(dim).toMatch(/opacity:\s*1\s*;/);
    expect(rule('.hud-play::before') ?? '').toMatch(/background:\s*rgba\(5,\s*6,\s*8,\s*0\.\d+\)/);
  });
  it('做不到的那一句（Not yet. 等）垫一层很淡的黑底', () => {
    expect(rule('.hud-refusal') ?? '').toMatch(/background:\s*rgba\(8,\s*7,\s*9,/);
  });
});

// ── 开局不能挂死（2026-10-30 整体审查 I-1、I-2：两条都是读代码推出来的路径）──────────────────

describe('预热的每一步有上限（withDeadline，整体审查 I-1）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('到点没结果：走失败分支（错误里写着等的是什么、等了多久）；原来的 promise 后来再回来也不走第二次', async () => {
    vi.useFakeTimers();
    let finish!: (v: string) => void;
    const slow = new Promise<string>((res) => { finish = res; });
    const ok = vi.fn();
    const fallback = vi.fn();
    void withDeadline(slow, 1000, 'GPU').then(ok, fallback);
    await vi.advanceTimersByTimeAsync(999);
    expect(fallback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(String(fallback.mock.calls[0][0])).toMatch(/GPU.*1 秒/);
    finish('late');
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('按时回来：走正常分支、带着原来的值；表收掉了，过了点也不走失败分支', async () => {
    vi.useFakeTimers();
    let finish!: (v: string) => void;
    const p = new Promise<string>((res) => { finish = res; });
    const ok = vi.fn();
    const fallback = vi.fn();
    void withDeadline(p, 1000, 'GPU').then(ok, fallback);
    finish('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(ok).toHaveBeenCalledWith('done');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('按时失败：原样走失败分支（还是原来那个错）；表也收掉', async () => {
    vi.useFakeTimers();
    const boom = new Error('boom');
    const fallback = vi.fn();
    void withDeadline(Promise.reject(boom), 1000, 'GPU').catch(fallback);
    await vi.advanceTimersByTimeAsync(0);
    expect(fallback).toHaveBeenCalledWith(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('到点以后原来的 promise 才失败：不算未处理的拒绝，也不走第二次', async () => {
    vi.useFakeTimers();
    let fail!: (e: Error) => void;
    const slow = new Promise<void>((_res, rej) => { fail = rej; });
    const fallback = vi.fn();
    const unhandled = vi.fn();
    const proc = (globalThis as unknown as { process: { on(e: string, f: () => void): void; off(e: string, f: () => void): void } }).process;
    proc.on('unhandledRejection', unhandled);
    void withDeadline(slow, 1000, 'GPU').catch(fallback);
    await vi.advanceTimersByTimeAsync(1000);
    fail(new Error('late'));
    vi.useRealTimers();
    await new Promise((res) => setTimeout(res, 5));
    proc.off('unhandledRejection', unhandled);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it('上限：GPU 那一步 10 秒，预编译那一步 90 秒（都比本机正常的时长宽得多）', () => {
    expect(PREHEAT_LIMIT.gpuMs).toBe(10_000);
    expect(PREHEAT_LIMIT.compileMs).toBe(90_000);
  });

  it('main.ts：两步都套了上限；GPU 到点记一笔接着往下走，预编译到点走原来「边画边编」那个分支', () => {
    const main = src('main.ts');
    const ask = /const askGpu = \(\) => \{([\s\S]*?)\n {2}\};/.exec(main)?.[1] ?? '';
    expect(ask).toMatch(/withDeadline\(done, PREHEAT_LIMIT\.gpuMs/);
    expect(ask).toMatch(/console\.warn/);
    expect(ask.match(/progress\(\{ gpu: true \}\)|go\(\)/g)?.length).toBeGreaterThanOrEqual(1);
    const pre = main.slice(main.indexOf('const precompiled ='), main.indexOf('bootMark(\'场景建好，开始预编译\')'));
    expect(pre).toMatch(/withDeadline\(\s*compileInStreams\(/);
    expect(pre).toMatch(/PREHEAT_LIMIT\.compileMs/);
    expect(pre).toMatch(/console\.warn\('\[boot\] 整栋房子预编译失败，改为边画边编', err\)/);
    // 到点以后 bgDone、warmAll 照样设：循环和就绪判断走得下去
    const fail = pre.slice(pre.indexOf('(err) =>'));
    expect(fail).toMatch(/bgDone = true/);
    expect(fail).toMatch(/warmAll = true/);
  });
});

describe('动画循环抛错（createLoopGuard，整体审查 I-2）', () => {
  const guard = (maxLogs?: number) => {
    const fatal = vi.fn();
    const log = vi.fn();
    return { fatal, log, on: createLoopGuard({ fatal, log }, maxLogs) };
  };

  it('还没开局：第一次走 fatal（错误界面），记一次日志；three 每帧重抛同一个错，都不再报', () => {
    const g = guard();
    const err = new Error('render failed');
    for (let frame = 0; frame < 120; frame++) g.on(err, true);
    expect(g.fatal).toHaveBeenCalledTimes(1);
    expect(g.log).toHaveBeenCalledTimes(1);
    expect(g.log).toHaveBeenCalledWith(err);
  });

  it('fatal 过以后换一个错也不再走 fatal（错误界面只挂一次）', () => {
    const g = guard();
    g.on(new Error('a'), true);
    g.on(new Error('b'), true);
    expect(g.fatal).toHaveBeenCalledTimes(1);
  });

  it('开局以后：只记日志，不走 fatal；每帧同样的错（新建的 Error 也算）只记一次', () => {
    const g = guard();
    for (let frame = 0; frame < 120; frame++) g.on(new Error('same'), false);
    expect(g.fatal).not.toHaveBeenCalled();
    expect(g.log).toHaveBeenCalledTimes(1);
  });

  it('不同的错各记一次，最多记 maxLogs 种（错误文字里带变化的编号时不会刷屏）', () => {
    const g = guard(3);
    for (let k = 0; k < 50; k++) g.on(new Error(`node ${k}`), false);
    expect(g.log).toHaveBeenCalledTimes(3);
  });

  it('抛的不是 Error（字符串）也认得出是同一个', () => {
    const g = guard();
    g.on('oops', false);
    g.on('oops', false);
    expect(g.log).toHaveBeenCalledTimes(1);
  });

  it('main.ts：循环体包在 try/catch 里；还没开局（遮罩挂着、设备也没丢）才算要命；要命时设 lost、挂 bootFailed、停循环', () => {
    const main = src('main.ts');
    expect(main).toMatch(/setAnimationLoop\(\(\) => \{\s*try \{\s*frame\(\);\s*\} catch \(err\) \{\s*loopError\(err, !started && !lost\);/);
    const made = main.slice(main.indexOf('createLoopGuard({'), main.indexOf('setAnimationLoop(() => {\n    try'));
    expect(made).toMatch(/lost = true/);
    expect(made).toMatch(/hud\.showError\(STRINGS\.bootFailed\)/);
    expect(made).toMatch(/setAnimationLoop\(null\)/);
  });
});
