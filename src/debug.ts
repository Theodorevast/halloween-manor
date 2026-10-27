// 调试接口：地址带 ?debug 时挂到 window.__haunt，给冒烟测试和手动排查用。正常访问不挂
import { AO, BLOOM, DOF, GRADE, GRAIN, REVEAL, type FxFlags } from './engine/postfx';
import type { EngineCore } from './engine/renderer';
import type { CameraRig, RenderCore } from './engine/types';
import type { SimEvent, SpawnOptions, World, WorldState } from './sim/types';

export interface DebugDeps {
  world: World;
  /** 把模拟事件分发给各模块（和主循环同一个函数），快进时画面和声音也跟着反应 */
  dispatch(evs: SimEvent[]): void;
  /** 主循环每帧用 dt × timeScale 推进模拟 */
  control: { timeScale: number };
  rig: CameraRig;
  core: RenderCore;
}

export interface HauntDebug {
  backend: RenderCore['backend'];
  /** 文字版状态，一眼看清每个访客和物件 */
  state(): string;
  /** 状态的深拷贝 */
  raw(): WorldState;
  /** 立刻快进 ms 毫秒（按 1/60 秒切分），期间的事件照常分发 */
  step(ms: number): void;
  trigger(id: string): boolean;
  spawn(opts?: SpawnOptions): ReturnType<World['spawn']>;
  rotate(dir: 1 | -1): void;
  setTimeScale(n: number): void;
  /** 物件在画布上的像素位置（离地 0.8 米处，大致是物件中部），测试用它来点中物件 */
  screenOf(objectId: string): { x: number; y: number } | null;
}

const f1 = (n: number) => n.toFixed(1);

export function installDebug(d: DebugDeps) {
  if (!new URLSearchParams(location.search).has('debug')) return;
  const api: HauntDebug = {
    backend: d.core.backend,
    state() {
      const s = d.world.state;
      const lines = [`t=${f1(s.time)}s scaredOff=${s.scaredOff} hitStop=${f1(s.hitStop)} timeScale=${d.control.timeScale}`];
      for (const n of s.npcs) {
        lines.push(`npc#${n.id} ${n.name} (${n.personality}) ${n.mode} fear=${f1(n.fear)} pos=(${f1(n.pos.x)},${f1(n.pos.z)}) look=${f1(n.lookDir)} speed=${f1(n.speed)}`);
      }
      for (const o of s.objects) {
        lines.push(`obj ${o.id} cd=${f1(o.cooldown)} active=${f1(o.active)} broken=${f1(o.broken)} seenBy=[${o.seenBy.join(',')}]`);
      }
      return lines.join('\n');
    },
    raw: () => structuredClone(d.world.state),
    step(ms) {
      let left = ms / 1000;
      while (left > 1e-6) {
        const dt = Math.min(1 / 60, left);
        d.dispatch(d.world.step(dt));
        left -= dt;
      }
    },
    trigger: (id) => d.world.trigger(id),
    spawn: (opts) => structuredClone(d.world.spawn(opts)),
    rotate: (dir) => d.rig.rotate(dir),
    setTimeScale(n) {
      d.control.timeScale = Math.max(0, n);
    },
    screenOf(objectId) {
      const o = d.world.state.objects.find((x) => x.id === objectId);
      return o ? d.rig.toScreen(o.pos, 0.8) : null;
    },
  };
  (window as unknown as { __haunt: HauntDebug }).__haunt = api;
  Object.assign(api, cameraDebug(d));
  Object.assign(api, postDebug(d));
  console.info('[debug] window.__haunt 已就绪：state() / raw() / step(ms) / trigger(id) / spawn(opts) / rotate(dir) / setTimeScale(n)');
}

// ── 镜头与电影段落的调试口（电影感升级）：量呼吸、震动的角度，记下 fx.focus / fx.setReveal 收到的调用 ──
export interface CameraDebug {
  /** 相机此刻的朝向（度）：az = 方位角（从房子中心指向相机，和 viewDir 同一个量），elev = 仰角，roll = 横滚 */
  camAngles(): { az: number; elev: number; roll: number };
  /** 开始记录 fx.focus / fx.setReveal 的调用（包一层，照常转给原实现）；返回记录数组，之后的调用会追加进去 */
  recordFx(): { t: number; fn: string; args: unknown[] }[];
}

function cameraDebug(d: DebugDeps): CameraDebug {
  const log: { t: number; fn: string; args: unknown[] }[] = [];
  let wrapped = false;
  const deg = 180 / Math.PI;
  return {
    camAngles() {
      const m = d.rig.camera.matrixWorld.elements;
      // 列：x 轴 m[0..2]，y 轴 m[4..6]，z 轴（视线反方向）m[8..10]
      const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
      const az = Math.atan2(zz, zx), elev = Math.asin(Math.max(-1, Math.min(1, zy)));
      // 不横滚时的「上」：(−sinE·cosA, cosE, −sinE·sinA)
      const ux = -Math.sin(elev) * Math.cos(az), uy = Math.cos(elev), uz = -Math.sin(elev) * Math.sin(az);
      const roll = Math.atan2(xx * ux + xy * uy + xz * uz, yx * ux + yy * uy + yz * uz);
      return { az: az * deg, elev: elev * deg, roll: roll * deg };
    },
    recordFx() {
      if (!wrapped) {
        wrapped = true;
        const fx = d.core.fx;
        for (const fn of ['focus', 'setReveal'] as const) {
          const orig = fx[fn].bind(fx) as (...a: unknown[]) => void;
          (fx as unknown as Record<string, (...a: unknown[]) => void>)[fn] = (...args: unknown[]) => {
            log.push({ t: performance.now(), fn, args: structuredClone(args) });
            orig(...args);
          };
        }
      }
      return log;
    },
  };
}

// ── 画面管线的调试口（电影感升级）：直接调 fx.focus / fx.setReveal，切换各效果（量性能、对比截图），读 GPU 时间 ──
export interface PostDebug {
  fx: {
    /** 焦点对到房屋 (x, z)；x 为 null 回到常态 */
    focus(x: number | null, z?: number, strength?: number, height?: number, smoothTime?: number): void;
    /** 开场显影进度；给了 x、z 就改原点 */
    reveal(progress: number, x?: number, z?: number): void;
    /** 不给参数：读开关；给了：改开关（重建管线）。见 postfx.ts 的 FxFlags */
    flags(f?: Partial<FxFlags>): FxFlags | null;
    /** 上次 reset 以来平均每帧的 GPU 时间（要 ?gputime） */
    gpu(reset?: boolean): { ms: number; frames: number } | null;
    focusState(): unknown;
    /** 画面换成中间结果：0 正常，1 AO，2 景深 CoC（地址要带 ?fxview，否则没有效果） */
    view(v: number): void;
    /** 颗粒花样定住（A/B 截图做差时用） */
    freezeGrain(on: boolean): void;
    /** 临时改 AO 强度（null 恢复） */
    aoStrength(v: number | null): void;
    /** 调参：改 postfx.ts 里某组常量（AO / DOF / GRADE / GRAIN / BLOOM / REVEAL）的字段，然后重建管线 */
    tune(group: string, values: Record<string, unknown>): unknown;
  };
}

function postDebug(d: DebugDeps): PostDebug {
  const core = d.core as EngineCore;
  return {
    fx: {
      focus(x, z = 0, strength, height, smoothTime) {
        core.fx.focus(x === null ? null : { x, z }, { strength, height, smoothTime });
      },
      reveal(progress, x, z) {
        core.fx.setReveal(progress, x !== undefined && z !== undefined ? { x, z } : undefined);
      },
      flags(f) {
        if (!core.post) return null;
        if (f) core.post.setFlags(f);
        return { ...core.post.flags };
      },
      gpu: (reset) => core.gpuTime?.(reset) ?? null,
      focusState: () => core.post?.focusState ?? null,
      view(v) {
        if (core.post) core.post.view = v;
      },
      freezeGrain(on) {
        if (core.post) core.post.freezeGrain = on;
      },
      aoStrength(v) {
        if (core.post) core.post.aoStrength = v;
      },
      tune(group, values) {
        const groups: Record<string, object> = { AO, DOF, GRADE, GRAIN, BLOOM, REVEAL };
        const g = groups[group];
        if (!g) return null;
        Object.assign(g, values);
        core.post?.setFlags({});
        return g;
      },
    },
  };
}
