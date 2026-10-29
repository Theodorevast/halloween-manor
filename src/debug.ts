// 调试接口：地址带 ?debug 时挂到 window.__haunt，给冒烟测试和手动排查用。正常访问不挂。
// 例外：?night=<分钟>（一夜多久天亮，看样时用）不用带 ?debug，见 nightTiming
import { NIGHT } from './config/night';
import { AO, BLOOM, GRADE, GRAIN, REVEAL, type FxFlags } from './engine/postfx';
import type { EngineCore } from './engine/renderer';
import type { CameraRig, RenderCore } from './engine/types';
import type { NightSnapshot, NightTiming } from './night';
import type { SimEvent, SpawnOptions, World, WorldState } from './sim/types';
// 第三人称调试口用（见文件末尾 ghostDebug）
import * as THREE from 'three/webgpu';
import { HOUSE_D, HOUSE_W } from './config/house';
import { ghostRigDebug, watchGhostUi } from './engine/ghostRig';
import { isGhostRig, type GhostState } from './engine/types';

export interface DebugDeps {
  world: World;
  /** 把模拟事件分发给各模块（和主循环同一个函数），快进时画面和声音也跟着反应 */
  dispatch(evs: SimEvent[]): void;
  /** 主循环每帧用 dt × timeScale 推进模拟 */
  control: { timeScale: number };
  rig: CameraRig;
  core: RenderCore;
  /** 一夜（src/night.ts，main.ts 接好的）：收夜、天亮、Keep haunting，和看状态 */
  night?: NightHooks;
}

/** 一夜的调试口（main.ts 把控制器、登记簿、前门接进来） */
export interface NightHooks {
  endNight(): void;
  dawn(): void;
  keepHaunting(): void;
  /** 控制器的状态，加上登记簿开着没有、前门开着多少（0..1） */
  snapshot(): NightSnapshot & { register: boolean; door: number };
}

/**
 * ?night=<分钟>：一夜多久天亮（模拟时间），收夜跟着按 NIGHT.length / NIGHT.dawn 的比例缩放（200 / 270），看样、试收尾时用
 * （?night=1：44 秒收夜、1 分钟天亮）。不带 ?debug 也认；没给、给的不是正数就是 NIGHT 原来的
 */
export function nightTiming(search = typeof location === 'undefined' ? '' : location.search): NightTiming {
  const minutes = Number(new URLSearchParams(search).get('night'));
  if (!(minutes > 0) || !Number.isFinite(minutes)) return { length: NIGHT.length, dawn: NIGHT.dawn };
  const dawn = minutes * 60;
  return { length: (dawn * NIGHT.length) / NIGHT.dawn, dawn };
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
  /** 取走记下的模拟事件（主循环和 step 推进出来的都算，只留最近 EVENT_LOG 个），取完清空。冒烟测试看现身、机关有没有发事件 */
  events(): SimEvent[];
  /** 一夜：立刻收夜（不等屋里的人走光：静、光收回、翻开登记簿） */
  endNight(): void;
  /** 一夜：立刻天亮（屋里没被吓走的人自己出门；step 快进看他们走光、收尾） */
  dawn(): void;
  /** 一夜：收夜那一页上点 Keep haunting（冒烟测试优先点真的按钮） */
  keepHaunting(): void;
  /** 一夜此刻的状态：phase（night / closed / silence / retreat / register）、这一夜的时刻、登记簿开着没有、前门开着多少；没接时为 null */
  night(): (NightSnapshot & { register: boolean; door: number }) | null;
}

const f1 = (n: number) => n.toFixed(1);
/** events() 最多留多少个 */
const EVENT_LOG = 500;

export function installDebug(d: DebugDeps) {
  if (!new URLSearchParams(location.search).has('debug')) return;
  // 事件记录：包一层 world.step（主循环、快进都走它），只在 ?debug 时
  let log: SimEvent[] = [];
  const step0 = d.world.step.bind(d.world);
  d.world.step = (dt) => {
    const evs = step0(dt);
    if (evs.length) {
      log.push(...evs);
      if (log.length > EVENT_LOG) log = log.slice(-EVENT_LOG);
    }
    return evs;
  };
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
    events() {
      const out = structuredClone(log);
      log = [];
      return out;
    },
    endNight: () => d.night?.endNight(),
    dawn: () => d.night?.dawn(),
    keepHaunting: () => d.night?.keepHaunting(),
    night: () => d.night?.snapshot() ?? null,
  };
  (window as unknown as { __haunt: HauntDebug }).__haunt = api;
  Object.assign(api, cameraDebug(d));
  Object.assign(api, postDebug(d));
  Object.assign(api, ghostDebug(d));
  // ?pipelog：从加载起记下新建的渲染管线（含开场的预编译），window.__pipelog.stop() 取结果
  if (new URLSearchParams(location.search).has('pipelog')) (window as unknown as { __pipelog: unknown }).__pipelog = (api as unknown as PostDebug).fx.pipelines();
  console.info('[debug] window.__haunt 已就绪：state() / raw() / step(ms) / trigger(id) / spawn(opts) / rotate(dir) / setTimeScale(n) / endNight() / dawn() / night()');
}

// ── 镜头与电影段落的调试口（电影感升级）：量震动的角度，记下 fx.setReveal 收到的调用 ──
export interface CameraDebug {
  /** 相机此刻的朝向（度）：az = 方位角（从房子中心指向相机，和 viewDir 同一个量），elev = 仰角，roll = 横滚 */
  camAngles(): { az: number; elev: number; roll: number };
  /** 开始记录 fx.setReveal 的调用（包一层，照常转给原实现）；返回记录数组，之后的调用会追加进去 */
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
        for (const fn of ['setReveal'] as const) {
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

// ── 画面管线的调试口（电影感升级）：直接调 fx.setReveal，切换各效果（量性能、对比截图），读 GPU 时间 ──
export interface PostDebug {
  fx: {
    /** 开场显影进度；给了 x、z 就改原点 */
    reveal(progress: number, x?: number, z?: number): void;
    /** 不给参数：读开关；给了：改开关（重建管线）。见 postfx.ts 的 FxFlags */
    flags(f?: Partial<FxFlags>): FxFlags | null;
    /** 上次 reset 以来平均每帧的 GPU 时间（要 ?gputime） */
    gpu(reset?: boolean): { ms: number; frames: number } | null;
    /** 画面换成中间结果：0 正常，1 AO（地址要带 ?fxview，否则没有效果） */
    view(v: number): void;
    /** 颗粒花样定住（A/B 截图做差时用） */
    freezeGrain(on: boolean): void;
    /** 临时改 AO 强度（null 恢复） */
    aoStrength(v: number | null): void;
    /** 调参：改 postfx.ts 里某组常量（AO / GRADE / GRAIN / BLOOM / REVEAL）的字段，然后重建管线 */
    tune(group: string, values: Record<string, unknown>): unknown;
    /**
     * 记下从现在起新建的渲染管线（查卡顿：第一次画到某个物体时现编管线会卡一下）。
     * 返回 stop()：停止记录，返回 [离开始的毫秒, 物体名, 材质类型, 画到哪（阴影图 / 场景 / 画布）]
     */
    pipelines(): { stop(): [number, string, string, string, string][]; code(): Record<string, [string, string]> };
  };
}

function postDebug(d: DebugDeps): PostDebug {
  const core = d.core as EngineCore;
  return {
    fx: {
      reveal(progress, x, z) {
        core.fx.setReveal(progress, x !== undefined && z !== undefined ? { x, z } : undefined);
      },
      flags(f) {
        if (!core.post) return null;
        if (f) core.post.setFlags(f);
        return { ...core.post.flags };
      },
      gpu: (reset) => core.gpuTime?.(reset) ?? null,
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
        const groups: Record<string, object> = { AO, GRADE, GRAIN, BLOOM, REVEAL };
        const g = groups[group];
        if (!g) return null;
        Object.assign(g, values);
        core.post?.setFlags({});
        return g;
      },
      pipelines() {
        type RO = { object: { name: string; type: string; parent?: { name: string } | null }; material: { type: string; name: string }; context?: { depthTexture?: { name?: string } | null; textures?: { name?: string }[] | null }; pipeline?: { cacheKey?: string; vertexProgram?: { code?: string }; fragmentProgram?: { code?: string } } };
        const backend = core.renderer.backend as unknown as { createRenderPipeline(ro: RO, p: unknown): void };
        const orig = backend.createRenderPipeline;
        const t0 = performance.now();
        const log: [number, string, string, string, string][] = [];
        backend.createRenderPipeline = function (ro, p) {
          const target = ro.context?.textures?.length ? (ro.context.textures[0]?.name || 'texture') : ro.context?.depthTexture ? 'shadow/depth' : 'canvas';
          log.push([Math.round(performance.now() - t0), ro.object.name || `${ro.object.parent?.name ?? ''}>${ro.object.type}`, ro.material.name || ro.material.type, target, String(ro.pipeline?.cacheKey ?? '')]);
          return orig.call(this, ro, p);
        };
        const code: Record<string, [string, string]> = {};
        const origRecord = backend.createRenderPipeline;
        backend.createRenderPipeline = function (ro, p) {
          const k = String(ro.pipeline?.cacheKey ?? '').split(',').slice(0, 2).join(',');
          if (!code[k]) code[k] = [ro.pipeline?.vertexProgram?.code ?? '', ro.pipeline?.fragmentProgram?.code ?? ''];
          return origRecord.call(this, ro, p);
        };
        return {
          stop() {
            backend.createRenderPipeline = orig;
            return log;
          },
          /** 管线 cacheKey 前两项（顶点、片元程序 id）→ [顶点着色器, 片元着色器] 的源码 */
          code: () => code,
        };
      },
    },
  };
}

// ── 第三人称的调试口（2026-10-28 改版）：看鬼魂和镜头、摆鬼魂、对准物件、假装指针锁定（无头浏览器锁不上） ──
export interface GhostDebug {
  /** 第三人称时才有；娃娃屋俯视下为 null（测试靠它分辨走的是哪种镜头） */
  ghost: {
    /** 鬼魂状态（房屋米坐标）+ 视角 yaw / pitch（弧度，pitch 向下为正）、dist（米）、cam（镜头位置）、locked（鼠标在操控）、aim（准星下的物件） */
    state(): GhostState & { yaw: number; pitch: number; dist: number; cam: { x: number; y: number; z: number }; locked: boolean; aim: string | null };
    /** 把鬼魂放到房屋坐标 (x, z)，可选朝向（方向角）、俯仰；镜头立刻就位 */
    place(x: number, z: number, heading?: number, pitch?: number): void;
    /** 让准星对准物件（拾取盒的中心）。给了 from 就先把鬼魂挪到物件正面 from 米处、面朝物件。物件不存在时返回 false */
    aimAt(id: string, opts?: { from?: number }): boolean;
    /** 准星此刻对着的物件（够得着、看得见的才算；拾取器每帧更新一次，对准之后等一两帧再读） */
    aimed(): string | null;
    /** 镜头距离（米，1–4），立刻就位 */
    zoom(dist: number): void;
    /** 假装指针锁定：鼠标转向、准星、点击附身都照锁定时一样 */
    fakeLock(on: boolean): void;
    /** 房屋坐标 → 屏幕像素（在镜头背后时为 NaN） */
    toScreen(x: number, z: number, y?: number): { x: number; y: number };
    /** 在鬼魂的位置画一个半透明的占位身形（看构图用，鬼魂外形做好之前） */
    proxy(on: boolean): void;
  } | null;
  /** 同 ghost.aimAt；娃娃屋俯视下返回 false */
  aimAt(id: string, opts?: { from?: number }): boolean;
}

function ghostDebug(d: DebugDeps): GhostDebug {
  const rig = isGhostRig(d.rig) ? d.rig : null;
  const h = rig ? ghostRigDebug(rig) : null;
  if (!rig || !h) return { ghost: null, aimAt: () => false };
  let aim: string | null = null;
  let locked = false;
  watchGhostUi((s) => {
    aim = s.aim;
    locked = s.locked;
  });
  const box = new THREE.Box3();
  const c = new THREE.Vector3();
  /** 物件拾取盒的中心（房屋米坐标）和物件朝向；场景里找不到盒子就用物件位置、离地 0.8 米 */
  const targetOf = (id: string) => {
    const o = d.world.state.objects.find((x) => x.id === id);
    if (!o) return null;
    const hit = d.core.scene.getObjectByName(`hit:${id}`);
    if (!hit) return { x: o.pos.x, y: 0.8, z: o.pos.z, facing: o.facing };
    box.setFromObject(hit).getCenter(c);
    return { x: c.x + HOUSE_W / 2, y: c.y, z: c.z + HOUSE_D / 2, facing: o.facing };
  };
  let proxy: THREE.Mesh | null = null;
  const ghost: NonNullable<GhostDebug['ghost']> = {
    state: () => ({ ...rig.ghost, ...h.view(), locked, aim }),
    place: (x, z, heading, pitch) => h.place(x, z, heading, pitch),
    aimAt(id, opts = {}) {
      const t = targetOf(id);
      if (!t) return false;
      if (opts.from !== undefined) h.place(t.x + Math.cos(t.facing) * opts.from, t.z + Math.sin(t.facing) * opts.from, t.facing + Math.PI);
      h.aim(t.x, t.y, t.z);
      return true;
    },
    aimed: () => aim,
    zoom: (dist) => h.setDist(dist),
    fakeLock: (on) => h.fakeLock(on),
    toScreen: (x, z, y = 0) => rig.toScreen({ x, z }, y),
    proxy(on) {
      if (on === (proxy !== null)) return;
      if (proxy) {
        proxy.removeFromParent();
        proxy.geometry.dispose();
        proxy = null;
        return;
      }
      // 1.34 米高的胶囊，中心在鬼魂的浮动高度：大致是一个人形轮廓占的地方
      const m = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.22, 0.9, 4, 12),
        new THREE.MeshBasicNodeMaterial({ color: 0xcfdde6, transparent: true, opacity: 0.3, depthWrite: false }),
      );
      d.core.houseRoot.add(m);
      proxy = m;
      const follow = () => {
        if (proxy !== m) return;
        m.position.set(rig.ghost.x, rig.ghost.y, rig.ghost.z);
        requestAnimationFrame(follow);
      };
      follow();
    },
  };
  return { ghost, aimAt: ghost.aimAt };
}
