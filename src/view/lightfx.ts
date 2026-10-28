// 灯闪（2026-10-28，调研 L1）：附近的灯像坏灯泡一样暗几下。Quake 式节奏表（一个字母一档亮度，每秒 10 个字母）
// + 钨丝灯的热惯性（亮暗变化有几十毫秒的拖尾，越暗越偏暖红）。不全灭、不白闪；用的人自己守住「每秒最多暗 3 下」
// （WCAG 2.3.1，countDips 可以拿来查）。现身（ghost.ts）、机关、台灯共用。
//
// 不新建灯（灯的数量一变，所有材质都要重编）：
// - 场景里标了 userData.lightfx 的灯（台灯 props/lamp.ts、门廊灯 house.ts），第一次 update 时遍历一次场景收集起来；
//   标记可以带上跟着这盏灯一起暗的自发光（灯罩、灯泡、灯笼，见 LightFxTag）：灯暗了灯罩还亮着就不像坏灯泡（2026-10-29 评审 I3）；
// - 访客的手电通过 torches.ts 的 torchDim（flashlight.ts 自己乘强度、自己偏色），位置从登记表读。
// 灯的强度（和台灯灯罩的 glow）平时由各自的模块每帧写（台灯偶尔轻闪、门廊灯微微抖），这里在它们写完以后乘上压暗系数：
// 记住自己上次写的值，发现被别人改过就把新值当作底数。主循环里各模块的先后不一定，所以渲染前（scene.onBeforeRender）再补一次。
// 没有效果、亮度也回到 1 的灯不再碰（不和主人抢），强度、颜色、自发光都原样还回去
import type * as THREE from 'three/webgpu';
import type { FrameCtx, Module, RenderCore } from '../engine/types';
import type { Vec2 } from '../sim/types';
import { TORCH_COUNT, torchDim, torches } from './torches';

export const LIGHTFX = {
  /** 节奏表每秒几个字母（Quake 的原样） */
  rate: 10,
  /** 'a' 的亮度：最暗，不全灭（调研：压到 30–50%） */
  floor: 0.3,
  /** 'z' 的亮度：最亮，只稍微冲高一点，不白闪 */
  ceil: 1.2,
  /** 几个效果叠在一起、或者 dipAll 给的深度，最暗也有这么亮 */
  minLevel: 0.1,
  /** 越暗越偏红：颜色往 warm 偏 (1 − 亮度) × warmK */
  warm: 0xff6a3a,
  warmK: 0.5,
  /** 钨丝的热惯性（秒）：变暗、变亮各自的时间常数（调研：几十毫秒的量级，【推】） */
  tauDown: 0.02,
  tauUp: 0.045,
  /** 半径最外面这一圈（占半径的比例）里效果慢慢减弱，不在半径处一刀切 */
  edge: 0.25,
  /** 亮度离 1 这么近就当作已经回到 1，写回原值、不再碰这盏灯 */
  settle: 0.003,
};

/** 一个字母的亮度：a = floor，m = 1，z = ceil，中间线性；不认识的字符当 m。m 必须正好是 1（灯回到 1 才不再碰，见 apply） */
export function letterLevel(c: string): number {
  const n = c.charCodeAt(0) - 97;
  if (!(n >= 0 && n <= 25)) return 1;
  return n <= 12 ? 1 - ((1 - LIGHTFX.floor) * (12 - n)) / 12 : 1 + ((LIGHTFX.ceil - 1) * (n - 12)) / 13;
}

/** 节奏表在开始后 t 秒时的亮度（每秒 LIGHTFX.rate 个字母，放完从头再来） */
export function patternLevel(pattern: string, t: number): number {
  if (!pattern.length || t < 0) return 1;
  return letterLevel(pattern[Math.floor(t * LIGHTFX.rate) % pattern.length]);
}

/**
 * 现身蓄力的节奏表（'a' 最暗、'm' 正常，每秒 LIGHTFX.rate 个字母，只放 MANIFEST.windup 秒）。
 * 画面（ghost.ts 的 GHOST.manifest.windup）和声音（audio/ghost.ts 的 MANIFEST_SFX.clicks：灯每暗一下一声咔哒）共用这一份：
 * 咔哒的时刻从它推出（patternDips），改这里，灯和咔哒一起跟着变。放在这里是因为声音不能引用 ghost.ts（它带着 GLTFLoader、TSL 一大串），
 * 而这个文件只依赖手电登记表，是轻的
 */
export const MANIFEST_WINDUP_PATTERN = 'mmamammmmammamamm';

/** 亮度序列（每秒 rate 个采样）里每一次「暗下去」开始的时刻（秒）。什么算「暗一下」见下面的 countDips */
export function dipStarts(levels: readonly number[], rate = LIGHTFX.rate, drop = 0.1): number[] {
  const starts: number[] = [];
  let peak = 1, low = 1, falling = false;
  for (let i = 0; i < levels.length; i++) {
    const v = levels[i];
    if (!falling) {
      peak = Math.max(peak, v);
      if (v < peak - drop) { falling = true; low = v; starts.push(i / rate); }
    } else {
      low = Math.min(low, v);
      if (v > low + drop) { falling = false; peak = v; }
    }
  }
  return starts;
}

/**
 * 节奏表里每一次灯暗下去的时刻（秒，相对开始）；within 给了就只要这么多秒以内的（节奏表放的时间可能比它短，
 * 比如现身蓄力只放 MANIFEST.windup 秒）。和 countDips 数的「暗一下」是同一个算法（dipStarts）：
 * 连着暗的字母算一次，掉得不到 10% 的抖动不算；现身蓄力的表只用 m 和比 m 暗的字母，就是每段暗字母的头一个
 */
export function patternDips(pattern: string, within = Infinity): number[] {
  return dipStarts(Array.from(pattern, (c) => letterLevel(c))).filter((t) => t < within - 1e-9);
}

/**
 * 亮度序列（每秒 rate 个采样）里任意 1 秒内最多暗下去几次。「暗一下」= 从上一个高点往下掉了 drop 以上（默认 0.1，
 * WCAG 2.3.1 的「闪一次」是一对相反的、10% 以上的亮度变化），掉的过程算一次，回升 drop 以上之后再掉才算下一次。
 * 给测试和调参用：现身蓄力的节奏 + 落下那一下 + 收那一下，任意 1 秒内不能超过 3
 */
export function countDips(levels: readonly number[], rate = LIGHTFX.rate, drop = 0.1): number {
  const starts = dipStarts(levels, rate, drop);
  let best = 0;
  for (let a = 0; a < starts.length; a++) {
    let n = 0;
    for (let b = a; b < starts.length && starts[b] < starts[a] + 1 - 1e-9; b++) n++;
    best = Math.max(best, n);
  }
  return best;
}

/** 钨丝的热惯性：亮度从 cur 往 target 走一步（变暗快、变亮慢一点） */
export function thermal(cur: number, target: number, dt: number): number {
  if (dt <= 0) return cur;
  const tau = target < cur ? LIGHTFX.tauDown : LIGHTFX.tauUp;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** 一个效果：节奏表（pattern 不为 null）或一次压暗（depth）。t0 为 NaN = 刚加进来，下一次 update 时从那一帧开始算 */
interface Effect {
  center: Vec2;
  radius: number;
  t0: number;
  dur: number;
  pattern: string | null;
  depth: number;
  stopped: boolean;
}

/**
 * 灯上的 userData.lightfx：true，或者再带上跟着这盏灯一起暗的自发光（灯暗了灯罩还亮着，就不像坏灯泡）：
 * - glow：一个数值 uniform（台灯：灯罩、灯泡的自发光都乘它，台灯每帧自己写）。灯罩的颜色是着色器里的常量，
 *   换颜色要重编材质，所以只跟着暗、不偏色（台灯的光本身照样偏暖红）
 * - emissive：用 material.color 画的自发光材质（门廊的灯笼）：颜色跟着暗，也和灯一样往暖红偏
 */
export type LightFxTag = true | { glow?: { value: number }; emissive?: { color: THREE.Color } };

/**
 * 越暗越偏红：base 的色调往 warm 偏 w（0..1），亮度（最大的那个分量）不变。base 的最大分量是 1 时就是 base.lerp(warm, w)；
 * w = 0 时原样拷回（还原时逐位相等）
 */
function warmShift(out: THREE.Color, base: THREE.Color, warm: THREE.Color, w: number): THREE.Color {
  if (w <= 0) return out.copy(base);
  const s = Math.max(base.r, base.g, base.b);
  if (s <= 0) return out.copy(base);
  return out.copy(base).multiplyScalar(1 / s).lerp(warm, w).multiplyScalar(s);
}

/** 管着的一盏灯：底数（主人写的强度、颜色）、自己上次写的值、热惯性后的亮度；跟着它的自发光（见 LightFxTag）同样记底数 */
interface Managed {
  light: THREE.Light;
  pos: Vec2;
  base: number;
  written: number;
  baseColor: THREE.Color;
  writtenColor: THREE.Color;
  glow: { ref: { value: number }; base: number; written: number } | null;
  emissive: { mat: { color: THREE.Color }; base: THREE.Color; written: THREE.Color } | null;
  level: number;
  /** 没在压暗：不碰这盏灯 */
  idle: boolean;
}

export interface LightFx extends Module {
  /**
   * center 附近 radius 米内的灯按节奏表 pattern 闪 seconds 秒（每秒 10 个字母，放完从头再来）。
   * 返回一个函数，调了就提前结束（比如现身停留时压着的灯，收的时候放开）；不用可以不管
   */
  pulse(center: Vec2, radius: number, pattern: string, seconds: number): () => void;
  /** center 附近 radius 米内的灯一起暗 ms 毫秒，暗到原来的 depth（0.15 = 剩 15%，不全灭） */
  dipAll(center: Vec2, radius: number, depth: number, ms: number): void;
  /** p 点此刻的压暗系数（所有效果叠起来、还没过热惯性），1 = 不变。鬼魂自己的明暗跟着它（借光出入） */
  level(p: Vec2): number;
  update(ctx: FrameCtx): void;
  dispose(): void;
}

export function createLightFx(core: RenderCore): LightFx {
  const effects: Effect[] = [];
  let lights: Managed[] | null = null;
  const torchLevel: number[] = Array.from({ length: TORCH_COUNT }, () => 1);
  let now = 0;
  let warm: THREE.Color | null = null;

  /** 第一次 update：收集场景里标了 userData.lightfx 的灯（之后不再扫） */
  const collect = () => {
    const out: Managed[] = [];
    core.houseRoot.updateWorldMatrix(true, true);
    core.scene.traverse((o) => {
      const l = o as THREE.Light;
      if (!l.isLight || !o.userData.lightfx) return;
      // 位置换到房屋坐标（台灯、门廊灯都不动，收集时算一次）
      const p = l.getWorldPosition(l.position.clone());
      core.houseRoot.worldToLocal(p);
      warm ??= l.color.clone().setHex(LIGHTFX.warm);
      const tag = o.userData.lightfx as LightFxTag;
      const g = typeof tag === 'object' && typeof tag.glow?.value === 'number' ? tag.glow : null;
      const e = typeof tag === 'object' && tag.emissive?.color?.isColor ? tag.emissive : null;
      out.push({
        light: l, pos: { x: p.x, z: p.z }, base: l.intensity, written: l.intensity,
        baseColor: l.color.clone(), writtenColor: l.color.clone(),
        glow: g ? { ref: g, base: g.value, written: g.value } : null,
        emissive: e ? { mat: e, base: e.color.clone(), written: e.color.clone() } : null,
        level: 1, idle: true,
      });
    });
    return out;
  };

  /** p 点在时刻 t 的压暗系数：覆盖到这里的效果里取最暗的那个（只有冲高的效果时才会 > 1） */
  const levelAt = (p: Vec2, t: number) => {
    let k = Infinity;
    for (const e of effects) {
      if (e.stopped || !(t >= e.t0 && t < e.t0 + e.dur)) continue;
      const d = Math.hypot(p.x - e.center.x, p.z - e.center.z);
      if (d >= e.radius) continue;
      const w = 1 - smooth01(e.radius * (1 - LIGHTFX.edge), e.radius, d);
      const v = e.pattern !== null ? patternLevel(e.pattern, t - e.t0) : e.depth;
      k = Math.min(k, 1 + (v - 1) * w);
    }
    return k === Infinity ? 1 : Math.min(LIGHTFX.ceil, Math.max(LIGHTFX.minLevel, k));
  };

  /**
   * 把压暗系数写到灯上（和跟着它的自发光上）：被主人改过的值当作新的底数（见文件头）。update 和渲染前各调一次，重复调结果一样。
   * 亮度回到 1 时写回的就是底数本身（偏色 w = 0 时原样拷回），之后不再碰
   */
  const apply = () => {
    if (!lights || !warm) return;
    for (const m of lights) {
      if (m.idle) continue;
      const l = m.light;
      const w = Math.max(0, 1 - m.level) * LIGHTFX.warmK;
      if (l.intensity !== m.written) m.base = l.intensity;
      if (!l.color.equals(m.writtenColor)) m.baseColor.copy(l.color);
      l.intensity = m.written = m.base * m.level;
      warmShift(l.color, m.baseColor, warm, w);
      m.writtenColor.copy(l.color);
      const g = m.glow;
      if (g) {
        if (g.ref.value !== g.written) g.base = g.ref.value;
        g.ref.value = g.written = g.base * m.level;
      }
      const e = m.emissive;
      if (e) {
        if (!e.mat.color.equals(e.written)) e.base.copy(e.mat.color);
        warmShift(e.mat.color, e.base, warm, w);
        if (m.level !== 1) e.mat.color.multiplyScalar(m.level);
        e.written.copy(e.mat.color);
      }
      // 回到 1 了：上面已经写回原值，之后不再碰
      if (m.level === 1) m.idle = true;
    }
  };

  /** 开始压暗一盏灯：此刻的强度、颜色、自发光就是主人写的底数 */
  const wake = (m: Managed) => {
    m.idle = false;
    m.base = m.written = m.light.intensity;
    m.baseColor.copy(m.light.color);
    m.writtenColor.copy(m.light.color);
    if (m.glow) m.glow.base = m.glow.written = m.glow.ref.value;
    if (m.emissive) {
      m.emissive.base.copy(m.emissive.mat.color);
      m.emissive.written.copy(m.emissive.mat.color);
    }
  };

  // 渲染前再补一次（各模块 update 的先后不一定：台灯、门廊灯可能在这个模块之后才写强度）
  const prevHook = core.scene.onBeforeRender;
  core.scene.onBeforeRender = (...args) => {
    apply();
    prevHook.call(core.scene, ...args);
  };

  const add = (e: Omit<Effect, 't0' | 'stopped'>): Effect => {
    const full: Effect = { ...e, center: { x: e.center.x, z: e.center.z }, t0: NaN, stopped: false };
    effects.push(full);
    return full;
  };

  const self: LightFx = {
    pulse(center, radius, pattern, seconds) {
      const e = add({ center, radius, dur: Math.max(0, seconds), pattern, depth: 1 });
      return () => { e.stopped = true; };
    },
    dipAll(center, radius, depth, ms) {
      add({ center, radius, dur: Math.max(0, ms) / 1000, pattern: null, depth: Math.min(1, Math.max(LIGHTFX.minLevel, depth)) });
    },
    level(p) {
      return levelAt(p, now);
    },
    update(ctx: FrameCtx) {
      now = ctx.time;
      const dt = ctx.dt;
      lights ??= collect();
      // 新加的效果从这一帧开始算（事件在两帧之间到，这样第一帧就是节奏表的第一个字母 / 压暗的第一帧）
      for (const e of effects) if (Number.isNaN(e.t0)) e.t0 = now;
      for (let i = effects.length - 1; i >= 0; i--) {
        const e = effects[i];
        if (e.stopped || now >= e.t0 + e.dur) effects.splice(i, 1);
      }
      const busy = effects.length > 0;

      for (const m of lights) {
        if (m.idle && !busy) continue;
        const target = busy ? levelAt(m.pos, now) : 1;
        if (m.idle) {
          if (target === 1) continue;
          wake(m);
        }
        m.level = thermal(m.level, target, dt);
        if (target === 1 && Math.abs(m.level - 1) < LIGHTFX.settle) m.level = 1;
      }
      apply();

      // 手电：登记表里的位置；没点亮的（power = 0）也照样算，进门那一刻接得上
      for (let i = 0; i < TORCH_COUNT; i++) {
        const t = torches[i];
        const target = busy ? levelAt(t, now) : 1;
        let k = thermal(torchLevel[i], target, dt);
        if (target === 1 && Math.abs(k - 1) < LIGHTFX.settle) k = 1;
        torchLevel[i] = k;
        torchDim[i] = k;
      }
    },
    dispose() {
      core.scene.onBeforeRender = prevHook;
      effects.length = 0;
      for (const m of lights ?? []) {
        if (m.idle) continue;
        m.light.intensity = m.base;
        m.light.color.copy(m.baseColor);
        if (m.glow) m.glow.ref.value = m.glow.base;
        if (m.emissive) m.emissive.mat.color.copy(m.emissive.base);
      }
      lights = null;
      for (let i = 0; i < TORCH_COUNT; i++) torchDim[i] = 1;
    },
  };

  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug')) {
    (window as unknown as { __lightfx: unknown }).__lightfx = {
      self,
      stats: () => ({
        effects: effects.length,
        lights: (lights ?? []).map((m) => ({
          name: m.light.name, level: +m.level.toFixed(3), intensity: +m.light.intensity.toFixed(3), idle: m.idle,
          glow: m.glow ? +m.glow.ref.value.toFixed(3) : null, emissive: m.emissive ? m.emissive.mat.color.getHexString() : null,
        })),
        torchDim: torchDim.map((v) => +v.toFixed(3)),
      }),
    };
  }
  return self;
}
