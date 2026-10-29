// 一夜（2026-10-30 路 NC）：src/night.ts 的状态机，和 src/view/house.ts 里门廊灯慢慢熄 / 亮回来、天亮的光这两段纯逻辑。
// - 状态机用替身测：模拟只记 close / reopen / dawn 调了几次（close 时屋里没人，照 World.close 的约定放进最后一位），
//   播报、门廊灯、天亮的光、环境层、显影、登记簿、前门、重新载入都是记账的函数。每帧真实时间 1/60 秒，模拟时间跟着走（hit-stop 时不走）；
//   模拟在这一帧里产生的事件先分发、再 update，和 main.ts 的主循环一样
// - 门廊灯：真的 createPorchDimmer + 真的 lightfx（和 tests/flicker.test.ts 门廊灯那一组同一个办法），countDips 按 60 Hz 数：
//   熄灯自己就是一次慢慢变暗（数出来最多一下，不抖），附近的现身放在熄灯、亮回来的每一个时刻上，任意 1 秒也不超过 3 下
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { NIGHT } from '../src/config/night';
import { STRINGS } from '../src/config/strings';
import { HIT_STOP, MANIFEST } from '../src/config/visitors';
import type { RenderCore } from '../src/engine/types';
import { NIGHT_FX, createNight, type NightDeps, type NightTiming } from '../src/night';
import type { NpcMode, NpcState, SimEvent, WorldState } from '../src/sim/types';
import { manifestLights } from '../src/view/ghost';
import { DAWN, PORCH_FADE, createPorchDimmer, dawnLights, porchFlicker, smoothRamp } from '../src/view/house';
import { countDips, createLightFx, dipStarts } from '../src/view/lightfx';
import { PALETTE } from '../src/view/palette';

const HZ = 60;
const DT = 1 / HZ;
const { silence, reveal } = NIGHT.closing;
const LAST_CALL = `say ${STRINGS.ticker.lastCall}`;
const PORCH_OUT = `porch ${NIGHT.porchFade.level} ${NIGHT.porchFade.seconds}`;
const DAWN_SAY = `say ${STRINGS.ticker.dawn}`;
const DAWN_UP = `dawnLight 1 ${NIGHT_FX.dawnLight}`;
const HUSH = `ambience ${NIGHT_FX.hush} ${silence + reveal}`;
const BACK = `ambience 1 ${NIGHT_FX.ambienceBack}`;

function visitor(id: number, name: string, mode: NpcMode = 'wander'): NpcState {
  return { id, name, personality: 'average', pos: { x: 8, z: 8 }, heading: 0, lookDir: 0, mode, modeTime: 0, fear: 0, nervous: false, speed: 0, screaming: 0, path: [] };
}

interface SetupOpts {
  timing?: NightTiming;
  reduced?: boolean;
  /** close 时屋里没人就放进最后一位（World.close 的约定；事件下一帧才分发，和真的模拟一样） */
  lastOnClose?: boolean;
  /** 合上登记簿时（main.ts 把收夜那一页的 onToggle(false) 接到 keepHaunting：会重入） */
  onShut?: () => void;
}

function setup(o: SetupOpts = {}) {
  const log: string[] = [];
  const state = { time: 0, npcs: [] as NpcState[] };
  const n = { close: 0, reopen: 0, dawn: 0, open: 0, shut: 0, reload: 0 };
  const pending: SimEvent[] = [];
  let door = 0;
  let reduced = o.reduced ?? false;
  const deps: NightDeps = {
    world: {
      state,
      close() {
        n.close++;
        log.push('close');
        if (o.lastOnClose && state.npcs.length === 0) {
          state.npcs.push(visitor(99, 'Ada', 'entering'));
          pending.push({ type: 'spawn', npc: 99, last: true });
        }
      },
      reopen() {
        n.reopen++;
        log.push('reopen');
      },
      dawn() {
        n.dawn++;
        log.push('dawn');
      },
    },
    say: (text) => log.push(`say ${text}`),
    porch: (level, seconds) => log.push(`porch ${level} ${seconds}`),
    dawnLight: (k, seconds) => log.push(`dawnLight ${k} ${seconds}`),
    ambience: (level, seconds) => log.push(`ambience ${level} ${seconds}`),
    retreat: (seconds) => log.push(`retreat ${seconds}`),
    spread: (seconds) => log.push(`spread ${seconds}`),
    door: () => door,
    openRegister() {
      n.open++;
      log.push('openRegister');
    },
    closeRegister() {
      n.shut++;
      log.push('closeRegister');
      o.onShut?.();
    },
    reload() {
      n.reload++;
      log.push('reload');
    },
    reduced: () => reduced,
  };
  const night = createNight(deps, o.timing);
  const ws = state as unknown as WorldState;
  /** 一帧：真实时间 dt；模拟时间走 dt × sim（hit-stop、模拟停着时 sim = 0）；上一帧模拟产生的事件先分发，再 update */
  const frame = (dt = DT, sim = 1) => {
    state.time += dt * sim;
    for (const e of pending.splice(0)) night.onEvent(e, ws);
    night.update({ dt, time: 0, state: ws });
  };
  const run = (seconds: number, sim = 1, dt = DT) => {
    for (let k = Math.round(seconds / dt); k > 0; k--) frame(dt, sim);
  };
  /** 一直走到模拟时间 ≥ t */
  const until = (t: number) => {
    while (state.time < t - 1e-9) frame();
  };
  /** 屋里的人都走了、门关上，一直走到登记簿翻开 */
  const toRegister = () => {
    state.npcs.length = 0;
    door = 0;
    for (let k = 0; night.phase !== 'register' && k < 60 * HZ; k++) frame();
  };
  return {
    night, state, n, ws, frame, run, until, toRegister,
    setDoor: (v: number) => (door = v),
    setReduced: (v: boolean) => (reduced = v),
    /** 取走记下的调用 */
    take: () => log.splice(0),
  };
}

/** 数一段 phase 持续了几帧 */
function framesIn(t: ReturnType<typeof setup>, phase: string) {
  let k = 0;
  while (t.night.phase === phase && k < 100 * HZ) {
    t.frame();
    k++;
  }
  return k;
}

describe('一夜的状态机（src/night.ts）', () => {
  it('到 NIGHT.length（模拟时间）收夜：world.close 一次、播报 lastCall、门廊灯在 porchFade.seconds 秒里熄到 porchFade.level；之前什么都不做', () => {
    const t = setup();
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(NIGHT.length - 0.5);
    expect(t.take()).toEqual([]);
    expect(t.night.phase).toBe('night');
    t.until(NIGHT.length + 0.5);
    expect(t.take()).toEqual(['close', LAST_CALL, PORCH_OUT]);
    expect(t.night.phase).toBe('closed');
    // 屋里有人：照常闹，没有时限，不再重复
    t.run(30);
    expect(t.take()).toEqual([]);
    expect(t.n.close).toBe(1);
  });

  it('收夜那一刻屋里没人：模拟放进来的最后一位（spawn 带 last）播报 lastArrival(名字)；平时的进门、找不到名字的都不播', () => {
    const t = setup({ lastOnClose: true });
    t.state.npcs.push(visitor(1, 'Mia'));
    t.night.onEvent({ type: 'spawn', npc: 1 }, t.ws);
    t.night.onEvent({ type: 'spawn', npc: 42, last: true }, t.ws);
    expect(t.take()).toEqual([]);
    t.state.npcs.length = 0;
    t.until(NIGHT.length + 0.1);
    expect(t.take()).toEqual(['close', LAST_CALL, PORCH_OUT, `say ${STRINGS.ticker.lastArrival('Ada')}`]);
    // Ada 在屋里：不收尾
    t.run(5);
    expect(t.night.phase).toBe('closed');
  });

  it('收尾要三样都齐：已经收夜、屋里没人（逃跑中的还算在屋里）、前门关上（openness ≤ NIGHT_FX.doorShut）；静 silence 秒 → 光收回 reveal 秒 → 翻开登记簿', () => {
    const t = setup();
    // 没收夜：屋里没人、门关着也不收
    t.run(10);
    expect(t.night.phase).toBe('night');
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(NIGHT.length + 1);
    t.take();
    t.state.npcs[0].mode = 'fleeing';
    t.run(3);
    expect(t.night.phase).toBe('closed');
    // 刚冲出门：屋里没人了，门还开着
    t.state.npcs.length = 0;
    t.setDoor(0.6);
    t.run(2);
    expect(t.night.phase).toBe('closed');
    expect(t.take()).toEqual([]);
    t.setDoor(NIGHT_FX.doorShut);
    t.frame();
    expect(t.night.phase).toBe('silence');
    expect(t.take()).toEqual([HUSH]);
    expect(Math.abs(framesIn(t, 'silence') - silence * HZ)).toBeLessThanOrEqual(1);
    expect(t.take()).toEqual([`retreat ${reveal}`]);
    expect(Math.abs(framesIn(t, 'retreat') - reveal * HZ)).toBeLessThanOrEqual(1);
    expect(t.take()).toEqual(['openRegister']);
    expect(t.night.phase).toBe('register');
    // 登记簿开着：等玩家选，不再做别的（天亮的时刻过了也不来）
    t.until(NIGHT.dawn + 10);
    expect(t.take()).toEqual([]);
    expect(t.n.dawn).toBe(0);
  });

  it('最后一个人正在 hit-stop 里（模拟停着）、到点那一步正好有人被吓跑：收夜照收；收尾等他跑出门', () => {
    const t = setup({ lastOnClose: true });
    t.state.npcs.push(visitor(1, 'Theo'));
    // 停在到点的前一帧：下一帧就是到点的那一步，他在这一步被吓跑
    t.until(NIGHT.length - 1.5 * DT);
    expect(t.n.close).toBe(0);
    t.state.npcs[0].mode = 'fleeing';
    t.frame();
    expect(t.n.close).toBe(1);
    t.run(HIT_STOP, 0);
    t.run(2);
    expect(t.night.phase).toBe('closed');
    t.state.npcs.length = 0;
    t.frame();
    expect(t.night.phase).toBe('silence');
  });

  it('到 NIGHT.dawn 天亮：world.dawn 一次、播报 dawn 一次、天亮的光在 NIGHT_FX.dawnLight 秒里起来；之后的帧不再重复', () => {
    const t = setup();
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(NIGHT.dawn - 0.5);
    t.take();
    expect(t.n.dawn).toBe(0);
    t.until(NIGHT.dawn + 0.5);
    expect(t.take()).toEqual(['dawn', DAWN_SAY, DAWN_UP]);
    t.run(10);
    expect(t.take()).toEqual([]);
    expect(t.n).toMatchObject({ close: 1, dawn: 1 });
    // 天亮以后最后一个人出门：照样走收尾
    t.toRegister();
    expect(t.night.phase).toBe('register');
  });

  it('一下快进过收夜和天亮（?debug 的 step）：同一帧里先收夜、后天亮，各一次', () => {
    const t = setup();
    t.state.npcs.push(visitor(1, 'Mia'));
    t.frame();
    t.state.time = NIGHT.dawn + 30;
    t.frame();
    expect(t.take()).toEqual(['close', LAST_CALL, PORCH_OUT, 'dawn', DAWN_SAY, DAWN_UP]);
    t.run(5);
    expect(t.n).toMatchObject({ close: 1, dawn: 1 });
  });

  it('Keep haunting：合上登记簿；光重新铺开、门廊灯亮回来、环境层回来、天亮的光退回夜里；world.reopen；这一夜从这一刻重新计时', () => {
    const t = setup();
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(NIGHT.dawn + 1);
    t.toRegister();
    // 在登记簿上看了一会儿（模拟照走）
    t.run(12.3);
    t.take();
    const T = t.state.time;
    t.night.keepHaunting();
    expect(t.take()).toEqual([
      'closeRegister', `spread ${NIGHT_FX.spread}`, `porch 1 ${NIGHT.porchFade.seconds}`, BACK, `dawnLight 0 ${NIGHT_FX.dawnBack}`, 'reopen',
    ]);
    expect(t.night.phase).toBe('night');
    expect(t.night.snapshot()).toMatchObject({ phase: 'night', start: T, closeAt: T + NIGHT.length, dawnAt: T + NIGHT.dawn, dawned: false });
    // 又有人来了：到这一夜的 +length 才再收夜、+dawn 才再天亮
    t.state.npcs.push(visitor(2, 'Theo'));
    t.until(T + NIGHT.length - 0.5);
    expect(t.take()).toEqual([]);
    t.until(T + NIGHT.length + 0.5);
    expect(t.take()).toEqual(['close', LAST_CALL, PORCH_OUT]);
    t.until(T + NIGHT.dawn - 0.5);
    expect(t.take()).toEqual([]);
    t.until(T + NIGHT.dawn + 0.5);
    expect(t.take()).toEqual(['dawn', DAWN_SAY, DAWN_UP]);
    expect(t.n).toMatchObject({ close: 2, dawn: 2, reopen: 1, open: 1, shut: 1 });
    // 第二夜照样收尾
    t.toRegister();
    expect(t.n.open).toBe(2);
  });

  it('收夜早于天亮（屋里的人在天亮前就都吓跑了）：Keep haunting 以后天亮从新的这一夜算，旧的那个时刻不再来', () => {
    const t = setup();
    t.until(NIGHT.length + 0.1);
    t.toRegister();
    const T = t.state.time;
    expect(T).toBeLessThan(NIGHT.dawn);
    t.night.keepHaunting();
    t.state.npcs.push(visitor(2, 'Theo'));
    t.until(NIGHT.dawn + 1);
    expect(t.n.dawn).toBe(0);
    t.until(T + NIGHT.dawn + 0.1);
    expect(t.n.dawn).toBe(1);
  });

  it('Another night：重新载入', () => {
    const t = setup();
    t.night.anotherNight();
    expect(t.n.reload).toBe(1);
  });

  it('减少动态效果：门廊灯、天亮的光、光收回、重新铺开都直接切（秒数 0），光收回那一段不等；静的那两秒照旧（只是声音）', () => {
    const t = setup({ reduced: true });
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(NIGHT.dawn + 0.1);
    expect(t.take()).toEqual(['close', LAST_CALL, `porch ${NIGHT.porchFade.level} 0`, 'dawn', DAWN_SAY, 'dawnLight 1 0']);
    t.state.npcs.length = 0;
    t.frame();
    expect(t.night.phase).toBe('silence');
    expect(t.take()).toEqual([HUSH]);
    expect(Math.abs(framesIn(t, 'silence') - silence * HZ)).toBeLessThanOrEqual(1);
    expect(t.take()).toEqual(['retreat 0', 'openRegister']);
    expect(t.night.phase).toBe('register');
    t.night.keepHaunting();
    expect(t.take()).toEqual(['closeRegister', 'spread 0', 'porch 1 0', BACK, 'dawnLight 0 0', 'reopen']);
  });

  it('静、光收回的这几秒里屋里又有人了（调试放的人、模拟晚一步才放进来的最后一位）：作罢，环境层回来（光收回过的话再铺开），接着等', () => {
    const t = setup();
    // 屋里没人：收夜那一帧就开始静（替身不放最后一位）
    t.until(NIGHT.length + 0.1);
    expect(t.night.phase).toBe('silence');
    expect(t.take()).toEqual(['close', LAST_CALL, PORCH_OUT, HUSH]);
    t.run(silence / 2);
    t.state.npcs.push(visitor(5, 'Ada', 'entering'));
    t.frame();
    expect(t.night.phase).toBe('closed');
    expect(t.take()).toEqual([BACK]);
    // 又走了：从头再静一遍
    t.state.npcs.length = 0;
    t.frame();
    expect(t.night.phase).toBe('silence');
    t.run(silence + reveal / 2);
    expect(t.night.phase).toBe('retreat');
    t.take();
    t.state.npcs.push(visitor(6, 'Theo'));
    t.frame();
    expect(t.night.phase).toBe('closed');
    expect(t.take()).toEqual([`spread ${NIGHT_FX.spread}`, BACK]);
    expect(t.n.open).toBe(0);
  });

  it('切走标签页回来（主循环停着，回来第一帧的 dt 限制在 0.1 秒）：静、光收回照真实时间接着走，不跳', () => {
    const t = setup();
    t.until(NIGHT.length + DT);
    expect(t.night.phase).toBe('silence');
    t.frame(0.1, 1);
    t.run(silence - 0.1 - 3 * DT);
    expect(t.night.phase).toBe('silence');
    t.run(4 * DT);
    expect(t.night.phase).toBe('retreat');
  });

  it('调试：endNight 不等屋里的人走光（没收夜的先收夜，接着静、光收回、翻开登记簿）；dawnNow 立刻天亮（没收夜的先收夜），只算一次', () => {
    const a = setup();
    a.state.npcs.push(visitor(1, 'Mia'));
    a.run(10);
    a.night.endNight();
    expect(a.take()).toEqual(['close', LAST_CALL, PORCH_OUT, HUSH]);
    expect(a.night.phase).toBe('silence');
    a.run(silence + reveal + 0.1);
    expect(a.night.phase).toBe('register');
    expect(a.n.open).toBe(1);
    // 收夜那一刻已经过了（在登记簿上）：再调不做事
    a.night.endNight();
    expect(a.n.close).toBe(1);

    const b = setup();
    b.state.npcs.push(visitor(1, 'Mia'));
    b.run(10);
    b.night.dawnNow();
    expect(b.take()).toEqual(['close', LAST_CALL, PORCH_OUT, 'dawn', DAWN_SAY, DAWN_UP]);
    b.night.dawnNow();
    b.until(NIGHT.dawn + 1);
    expect(b.n).toMatchObject({ close: 1, dawn: 1 });

    // 正在静的时候 endNight：不等了（屋里又有人也不作罢）
    const c = setup();
    c.until(NIGHT.length + 0.1);
    expect(c.night.phase).toBe('silence');
    c.night.endNight();
    c.state.npcs.push(visitor(3, 'Ada'));
    c.run(silence + reveal + 0.1);
    expect(c.night.phase).toBe('register');
  });

  it('keepHaunting 只认登记簿翻开着的那一段：别的时候调不算；连着调、合上登记簿时重入都只算一次', () => {
    const t = setup();
    t.night.keepHaunting();
    expect(t.n.reopen).toBe(0);
    t.until(NIGHT.length + 0.1);
    t.toRegister();
    t.night.keepHaunting();
    t.night.keepHaunting();
    expect(t.n).toMatchObject({ reopen: 1, shut: 1 });

    const r = setup({ onShut: () => r.night.keepHaunting() });
    r.until(NIGHT.length + 0.1);
    r.toRegister();
    r.night.keepHaunting();
    expect(r.n).toMatchObject({ reopen: 1, shut: 1 });
    expect(r.night.phase).toBe('night');
  });

  it('夜长可以另给（?night）：按给的 length、dawn 收夜、天亮', () => {
    const t = setup({ timing: { length: 40, dawn: 54 } });
    t.state.npcs.push(visitor(1, 'Mia'));
    t.until(39.9);
    expect(t.n.close).toBe(0);
    t.until(40.1);
    expect(t.n.close).toBe(1);
    t.until(54.1);
    expect(t.n.dawn).toBe(1);
    expect(t.night.snapshot()).toMatchObject({ closeAt: 40, dawnAt: 54 });
  });
});

// ── 门廊灯慢慢熄、亮回来（house.ts 的 createPorchDimmer）──────────────────────────────────────

/** 门廊灯的亮度（乘 PORCH.intensity 之前）：微抖的时钟从 phase 秒起；from 给了先直接切到它；先走 pre 秒，再 set(level, seconds)，再走 post 秒 */
function fade(o: { phase?: number; from?: number; pre?: number; level?: number; seconds?: number; post: number }): number[] {
  const d = createPorchDimmer();
  if (o.from !== undefined) d.set(o.from, 0);
  const out: number[] = [];
  // 第 i 帧（从 0 数）的微抖时钟 = phase + (i + 1) / 60（乘出来，不累加：和下面比 porchFlicker 时一位不差）
  const go = (s: number) => {
    for (let k = Math.round(s * HZ); k > 0; k--) out.push(d.step(DT, (o.phase ?? 0) + (out.length + 1) * DT));
  };
  go(o.pre ?? 1);
  d.set(o.level ?? NIGHT.porchFade.level, o.seconds ?? NIGHT.porchFade.seconds);
  go(o.post);
  return out;
}

/** 附近现身的鬼魂站在这里（房屋坐标）；门廊灯放在 (1, 1)，和 tests/flicker.test.ts 门廊灯那一组一样 */
const GHOST_AT = { x: 1.6, z: 1.2 };

/**
 * 一盏门廊灯（标记和 house.ts 一样：带灯笼的 emissive，没有 busy）挂进场景、真的 lightfx 收集它；附近的现身按 ghost.ts 的 manifestLights 调：
 * 蓄力在第 windup 帧，落下、停留在 MANIFEST.windup 秒后，收在再过 MANIFEST.hold 秒后。第 setAt 帧门廊灯开始往 level 走（seconds 秒）。
 * 每帧先门廊灯写自己的强度（dimmer），再 lightfx 乘压暗；返回 lightfx 之后的强度（底数 1，强度就是亮度）
 */
function porchNearManifest(o: { phase: number; from?: number; setAt: number; level: number; seconds: number; windup: number; frames: number }): number[] {
  const scene = new THREE.Scene();
  const houseRoot = new THREE.Group();
  scene.add(houseRoot);
  const porch = new THREE.PointLight(0xffb35c, 1, 2.4, 2);
  porch.position.set(1, 1.35, 1);
  porch.userData.lightfx = { emissive: new THREE.MeshBasicNodeMaterial({ color: 0x8c6232 }) };
  houseRoot.add(porch);
  const fx = createLightFx({ scene, houseRoot } as unknown as RenderCore);
  const d = createPorchDimmer();
  if (o.from !== undefined) d.set(o.from, 0);
  const drop = o.windup + Math.round(MANIFEST.windup * HZ), end = drop + Math.round(MANIFEST.hold * HZ);
  let release: (() => void) | null = null;
  const out: number[] = [];
  try {
    for (let k = 0; k < o.frames; k++) {
      if (k === o.setAt) d.set(o.level, o.seconds);
      if (k === o.windup) manifestLights(fx, 'windup', GHOST_AT);
      if (k === drop) release = manifestLights(fx, 'drop', GHOST_AT);
      if (k === end) {
        release?.();
        manifestLights(fx, 'end', GHOST_AT);
      }
      porch.intensity = d.step(DT, o.phase + k / HZ);
      fx.update({ dt: DT, time: k / HZ, state: {} as WorldState });
      out.push(porch.intensity);
    }
  } finally {
    fx.dispose();
  }
  return out;
}

/** 扫一串现身的时刻（帧），返回数出来最多的那一种：几下、蓄力在第几秒 */
function worstManifest(windups: number[], run: (w: number) => number[]) {
  let worst = { dips: -1, at: NaN };
  for (const w of windups) {
    const dips = countDips(run(w), HZ);
    if (dips > worst.dips) worst = { dips, at: w / HZ };
  }
  return worst;
}
const span = (a: number, b: number, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);

describe('门廊灯慢慢熄、亮回来（house.ts 的 createPorchDimmer）：慢慢变暗不算闪，但不能抖', () => {
  it('没调过 set：每帧就是原来的 porchFlicker（一位不差，平时的样子不变）', () => {
    const d = createPorchDimmer();
    for (let k = 1; k <= 20 * HZ; k++) expect(d.step(DT, k * DT)).toBe(porchFlicker(k * DT));
  });

  it.each([0, 0.21, 0.43, 0.77])('熄（微抖相位 %f 秒）：先在 PORCH_FADE.flat 秒里收平微抖，之后一路只往下走、不抖；porchFade.seconds 秒正好熄到 porchFade.level；数出来就是一下', (phase) => {
    const pre = 1, S = NIGHT.porchFade.seconds;
    const lv = fade({ phase, pre, post: S + 1 });
    const at = (s: number) => Math.round((pre + s) * HZ) - 1;
    for (let i = at(PORCH_FADE.flat) + 1; i < lv.length; i++) expect(lv[i], `第 ${i} 帧`).toBeLessThanOrEqual(lv[i - 1] + 1e-12);
    expect(lv[at(S - 0.1)]).toBeGreaterThan(NIGHT.porchFade.level * PORCH_FADE.mean);
    expect(lv[at(S) + 1]).toBeCloseTo(NIGHT.porchFade.level * PORCH_FADE.mean, 9);
    expect(lv.at(-1)).toBeCloseTo(NIGHT.porchFade.level * PORCH_FADE.mean, 9);
    expect(countDips(lv, HZ)).toBe(1);
  });

  it('亮回来：一路只往上走，seconds 秒到全亮；之后微抖在 flat 秒里回来，再往后和原来的 porchFlicker 一位不差；一下都数不出来', () => {
    const pre = 1, S = NIGHT.porchFade.seconds;
    const lv = fade({ from: 0, pre, level: 1, post: S + 4 });
    const at = (s: number) => Math.round((pre + s) * HZ) - 1;
    for (let i = at(0) + 1; i <= at(S); i++) expect(lv[i], `第 ${i} 帧`).toBeGreaterThanOrEqual(lv[i - 1] - 1e-12);
    expect(lv[at(S) + 1]).toBeCloseTo(PORCH_FADE.mean, 2);
    for (let i = at(S + PORCH_FADE.flat) + 2; i < lv.length; i++) expect(lv[i]).toBe(porchFlicker((i + 1) * DT));
    // dipStarts 从「高点 1」数起：序列一开头就是黑的（from 0），第 0 帧算一下；亮回来、微抖回来都不再多一下
    expect(dipStarts(lv, HZ)).toEqual([0]);
  });

  it('减少动态效果（seconds = 0）：一下切到 level，微抖跟着停；数出来就是这一下', () => {
    const lv = fade({ seconds: 0, post: 3 });
    expect(lv[HZ]).toBe(NIGHT.porchFade.level * PORCH_FADE.mean);
    expect(countDips(lv, HZ)).toBe(1);
  });

  it('熄到一半又亮回来（熄灯时点了 Keep haunting）：从此刻的亮度接着往上走，不先跳一下', () => {
    const d = createPorchDimmer();
    let v = 0;
    for (let k = 0; k < 8 * HZ; k++) v = d.step(DT, k * DT);
    d.set(0, NIGHT.porchFade.seconds);
    for (let k = 0; k < 8 * HZ; k++) v = d.step(DT, k * DT);
    d.set(1, NIGHT.porchFade.seconds);
    const next = d.step(DT, 8);
    expect(Math.abs(next - v)).toBeLessThan(0.01);
    expect(next).toBeGreaterThanOrEqual(v - 1e-12);
  });

  it('附近现身（真的 lightfx，按 manifestLights 调）放在熄灯的每一个时刻上（步长 1/60 秒，前后各多 1 秒）：任意 1 秒最多 3 下', () => {
    const setAt = HZ, S = NIGHT.porchFade.seconds;
    for (const [phase, step] of [[0, 1], [0.37, 2]] as const) {
      const worst = worstManifest(span(0, setAt + (S + 1) * HZ, step), (w) =>
        porchNearManifest({ phase, setAt, level: NIGHT.porchFade.level, seconds: S, windup: w, frames: setAt + (S + 4) * HZ }));
      // 现身自己就是 3 下（蓄力两下、落下一下；门廊灯照旧跟着蓄力）：最坏正好是它，熄灯不多添一下
      expect(worst.dips, `微抖相位 ${phase}：最坏在蓄力于 ${worst.at.toFixed(3)} 秒时`).toBe(3);
    }
  });

  it('附近现身放在亮回来的每一个时刻上（步长 2/60 秒）：任意 1 秒最多 3 下', () => {
    const setAt = HZ, S = NIGHT.porchFade.seconds;
    const worst = worstManifest(span(0, setAt + (S + 2) * HZ, 2), (w) =>
      porchNearManifest({ phase: 0.11, from: 0, setAt, level: 1, seconds: S, windup: w, frames: setAt + (S + 5) * HZ }));
    expect(worst.dips, `最坏在蓄力于 ${worst.at.toFixed(3)} 秒时`).toBeLessThanOrEqual(3);
  });
});

// ── 天亮的光（house.ts 的 smoothRamp、dawnLights）──────────────────────────────────────

describe('天亮的光：只改已有的月光、半球光，慢慢往灰白偏一点、亮一点点', () => {
  it('smoothRamp：smoothstep 走过去，seconds 秒正好到；一路只往一个方向（不过冲）；起步很平；seconds = 0 直接切；中途改目标从此刻的值接着走', () => {
    const r = smoothRamp(0);
    r.set(1, 20);
    const v: number[] = [];
    for (let k = 0; k < 21 * HZ; k++) v.push(r.step(DT));
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1]);
    expect(v[20 * HZ - 3]).toBeLessThan(1);
    expect(v[20 * HZ]).toBe(1);
    expect(v.at(-1)).toBe(1);
    expect(v[HZ - 1]).toBeLessThan(0.01);
    r.set(0, 0);
    expect(r.value).toBe(0);
    expect(r.step(DT)).toBe(0);
    r.set(1, 10);
    for (let k = 0; k < 5 * HZ; k++) r.step(DT);
    const mid = r.value;
    expect(mid).toBeGreaterThan(0.4);
    expect(mid).toBeLessThan(0.6);
    r.set(0, 4);
    const next = r.step(DT);
    expect(next).toBeLessThanOrEqual(mid);
    expect(mid - next).toBeLessThan(0.01);
  });

  it('dawnLights：k = 0 就是原来的夜；k = 1 月光、天空色饱和度降下来（往灰白偏），仍然不偏暖（不像黄昏）；月亮落下去直射弱一点、天光散开亮一些；k 从 0 走到 1 亮度一路只往上', () => {
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const sat = (c: THREE.Color) => c.getHSL({ h: 0, s: 0, l: 0 }).s;
    const night = dawnLights(0);
    expect(night.moon.equals(new THREE.Color(PALETTE.moon))).toBe(true);
    expect(night.sky.equals(new THREE.Color(PALETTE.moonSky))).toBe(true);
    expect([night.moonGain, night.hemiGain, night.patch]).toEqual([1, 1, 1]);
    const dawn = dawnLights(1);
    for (const [d, n] of [[dawn.moon, night.moon], [dawn.sky, night.sky]]) {
      expect(sat(d)).toBeLessThan(sat(n) * 0.75);
      expect(d.b).toBeGreaterThanOrEqual(d.r);
      // 颜色本身的亮度几乎不变（只是变灰），亮多少由强度的乘数管
      expect(Math.abs(lum(d) / lum(n) - 1)).toBeLessThan(0.05);
    }
    // 月亮落下去：直射的月光只暗一点点（ART-2：×0.9）；天光变散：半球光亮一些（×1.5），不像日出那样大亮
    expect(dawn.moonGain).toBeGreaterThanOrEqual(0.85);
    expect(dawn.moonGain).toBeLessThan(1);
    expect(dawn.hemiGain).toBeGreaterThan(1);
    expect(dawn.hemiGain).toBeLessThanOrEqual(1.6);
    let prev = 0;
    for (let k = 0; k <= 100; k++) {
      const l = dawnLights(k / 100);
      const b = lum(l.moon) * l.moonGain + lum(l.sky) * l.hemiGain;
      expect(b).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = b;
    }
  });

  it('看得见的天（ART-2）：窗玻璃的倍数、屋外底色、雾随 k 一路只往上（每个通道都是），k = 0 是夜里原来的样子、k = 1 是 DAWN 给的；天是冷的灰蓝，不偏暖', () => {
    const night = dawnLights(0);
    expect(night.glass.toArray()).toEqual([1, 1, 1]);
    expect(night.background.equals(new THREE.Color(PALETTE.night))).toBe(true);
    expect(night.fog).toBe(0);
    const dawn = dawnLights(1);
    expect(dawn.glass.toArray()).toEqual(DAWN.glass);
    expect(dawn.background.equals(new THREE.Color(DAWN.background))).toBe(true);
    expect(dawn.fog).toBe(DAWN.fog);
    expect(dawn.background.b).toBeGreaterThan(dawn.background.r);
    expect(dawn.glass.z).toBeLessThanOrEqual(dawn.glass.x);
    let prev = dawnLights(0);
    for (let k = 1; k <= 100; k++) {
      const l = dawnLights(k / 100);
      for (const [a, b] of [[l.glass.x, prev.glass.x], [l.glass.y, prev.glass.y], [l.glass.z, prev.glass.z],
        [l.background.r, prev.background.r], [l.background.g, prev.background.g], [l.background.b, prev.background.b], [l.fog, prev.fog]]) {
        expect(a).toBeGreaterThanOrEqual(b - 1e-12);
      }
      prev = l;
    }
  });
});
