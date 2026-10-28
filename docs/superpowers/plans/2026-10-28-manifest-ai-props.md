# 访客反馈、手电照出鬼魂、主动现身、床和机关：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 按 `docs/superpowers/specs/2026-10-28-manifest-ai-props-design.md` 做出：访客的察觉那一拍和看得懂的反馈、手电照出鬼魂、主动现身（吓人、赶人）、床、机关、访客的新动作和声音。10/30 中午前合起来，10/30 下午给用户试玩。

**Architecture：** 先由主会话做任务 1（接口：类型、参数、床的占位物件），之后分五路并行，每路只改自己名下的文件：模拟（S）、鬼魂画面（V）、物件（P）、声音（U）、动作流水线（M）。最后主会话做任务 I（接线、操控、全部测试）。

**Tech Stack：** Vite 8、TypeScript 7、three.js r186（`three/webgpu` + TSL，自动退回 WebGL2）、Web Audio（全部程序化合成）、vitest 5、playwright-core + 本机 Chrome、Tripo API（`scripts/tripo/`）、Blender 5.2 无头（`scripts/blender/`）

## Global Constraints

- 克制、写实，不要游戏感：不发光、不描边、不全屏闪图、不加 UI 闪烁；现身时鬼魂不动、头慢慢抬起，不扑过来、不变大、不说话；镜头不推近
- 声音：不用大调、和弦进行、上行音阶、「叮」；恐怖用低持续音、小二度不和谐、低频冲击（braam）
- 灯闪每秒不超过 3 次（WCAG 2.3.1）；灯不全灭、不白闪
- 吉祥物不见血；床、衣柜不露出身体部位、不出现脸
- 不新加灯：灯的数量一变所有材质都要重编（会卡）。借现有的灯（台灯、门廊灯、镜子那盏平时为 0 的点光、手电）
- 模拟层（`src/sim/`）是纯 TypeScript，不引用 three.js；画面、声音只读 `WorldState`、订阅 `SimEvent`
- 中文注释、中文提交说明，风格照现有代码；英文界面文案放 `src/config/strings.ts`
- 每个任务结束：`./node_modules/.bin/tsc --noEmit -p .` 无错、`./node_modules/.bin/vitest run` 全过，再提交
- 用 `./node_modules/.bin/<工具>`，不用 `npx`；日志放 `.logs/`；端口用 5731–5739，用前 `netstat` 查，只停自己起的进程
- git：本地提交，`git add -u` 加按目录加，提交前 `git diff --cached --stat` 核对（工具输出里路径名可能显示成别的名字，按路径 add 会静悄悄地什么都没加上）；不推送
- 提交说明末尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 性能：四个访客满载 High、Low 仍 60 fps（`node scripts/perf.mjs`、`--low`）；冷启动（`sh .logs/ready-variant.sh <名字> 3`）不超过 4.5 秒
- Tripo：本计划只批准花 160 积分（任务 M1 的 4 个动作 × 4 套）；别的步骤不能扣积分。key 只在 `.env.local`，不打印

---

## 文件和负责的路

| 文件 | 路 | 作用 |
|---|---|---|
| `src/sim/types.ts`、`src/config/visitors.ts`、`src/config/scares.ts`、`src/config/house.ts`、`src/view/torches.ts`（新） | 任务 1（主会话） | 接口和参数 |
| `src/sim/npc.ts`、`src/sim/world.ts`、`src/sim/pathfind.ts`、`src/sim/manifest.ts`（新）、`src/sim/traps.ts`（新）、`tests/notice.test.ts`（新）、`tests/manifest.test.ts`（新）、`tests/traps.test.ts`（新）、`tests/ghost.test.ts`、`tests/balance.test.ts`、`tests/bots.ts` | S（模拟） | 访客行为、现身、机关 |
| `src/view/ghost.ts`、`src/view/flashlight.ts`、`src/view/lightfx.ts`（新）、`src/view/frost.ts`（新）、`dev/ghost.ts` | V（鬼魂画面） | 手电照出、变实、降帧、借光出入、灯闪、霜 |
| `src/view/props/bed.ts`（新）、`src/view/props.ts`、`src/view/furniture.ts`、`src/view/overlays.ts`、`src/engine/picking.ts`、`dev/props.ts` | P（物件） | 床、机关的提示、按住设机关 |
| `src/audio/*` | U（声音） | 现身、被照到、喘气、呜咽、床、机关 |
| `scripts/tripo/*`、`scripts/blender/*`、`src/config/character.ts`、`src/view/characters.ts`、`dev/characters.ts`、`public/assets/visitors/*` | M（动作） | 4 个新动作 |
| `src/main.ts`、`src/engine/ghostRig.ts`、`src/ui/hud.ts`、`src/config/strings.ts`、`scripts/smoke.mjs`、`README.md` | 任务 I（主会话） | 接线、操控、冒烟测试 |

**执行顺序**：任务 1 → S、V、P、U、M 并行（各路内部按编号顺序）→ 任务 I。S 路最长，先开。

---

### Task 1：接口和参数（主会话做，做完才开并行）

**Files:**
- Modify: `src/sim/types.ts`、`src/config/visitors.ts`、`src/config/scares.ts`、`src/config/house.ts`、`src/config/strings.ts`、`src/view/overlays.ts`（`GHOST_MARK_Y`）、`src/audio/engine.ts`（`SOURCE_Y`）、`src/audio/sfx.ts`（`TRIGGER` 改 Partial）、`src/view/props.ts`（`builders`）、`src/sim/world.ts`（新字段初始化、`manifest()`/`arm()` 先返回 false）
- Create: `src/view/torches.ts`、`src/view/props/bed.ts`（静态的被子，P1 再做动画）

**Interfaces（Produces，后面各路都用这些名字）：**

```ts
// src/sim/types.ts
export type ScareType = 'musicBox' | 'door' | 'lamp' | 'rockingChair' | 'portrait' | 'mirror' | 'bed';
/** 察觉的来源：声音（引诱、尖叫、鬼魂穿墙声）、手电照到鬼魂、开始发毛、现身蓄力 */
export type NoticeKind = 'sound' | 'ghost' | 'chill' | 'manifest';
export interface NoticeState {
  kind: NoticeKind;
  /** 来源位置（房屋米坐标） */
  src: Vec2;
  /** 已经察觉了多久（秒） */
  t: number;
  /** 一共要盯多久（秒，已乘性格系数） */
  hold: number;
}
// NpcState 加：
  /** 正在察觉（那一拍）：停下、手电先转向来源、盯着看；null = 没有 */
  notice?: NoticeState | null;
export type ManifestPhase = 'idle' | 'windup' | 'hold' | 'cooldown';
export interface ManifestState {
  phase: ManifestPhase;
  /** 这一段已经过了多久（秒） */
  t: number;
  /** 剩余冷却（秒），0 = 可以现身 */
  cooldown: number;
  /** 现身的位置（蓄力开始时鬼魂所在处）；idle 时为 null */
  pos: Vec2 | null;
}
/** 访客暂时绕开的地方（看见现身以后），寻路时这里的格子代价很高 */
export interface AvoidZone { pos: Vec2; r: number; until: number }
// WorldState 加：
  manifest: ManifestState;
  avoid: AvoidZone[];
// ScareObjectState 加：
  /** 机关：设下后的剩余秒数，0 = 没有设下 */
  armed: number;
/** setGhost 的参数：鬼魂在哪、此刻是不是在墙里（穿墙声） */
export interface GhostInput { x: number; z: number; inWall?: boolean }
// SimEvent 加：
  | { type: 'notice'; npc: number; kind: NoticeKind; src: Vec2 }
  /** 某个访客的手电开始 / 不再照着鬼魂（只显形、不吓人） */
  | { type: 'reveal'; npc: number; on: boolean }
  /** 现身：windup 蓄力开始、drop 落下（scared = 被吓到的人）、end 收回 */
  | { type: 'manifest'; phase: 'windup' | 'drop' | 'end'; pos: Vec2; scared: number[] }
  | { type: 'trap'; object: string; phase: 'armed' | 'sprung' | 'expired' }
// World 加 / 改：
  /** 主动现身。没有鬼魂、冷却中、正在现身时返回 false；成功时下一次 step 返回 manifest windup */
  manifest(): boolean;
  /** 设机关。物件不存在、冷却中、已经设下、同时设下的已满时返回 false */
  arm(objectId: string): boolean;
  setGhost(g: GhostInput | null): void;
```

```ts
// src/config/visitors.ts 新增（FEAR.screamAt 先不动，S3 再改）
export const NOTICE = {
  /** 盯着看多久（秒，随机），再乘性格的 noticeHold */
  hold: [0.5, 1.0] as [number, number],
  /** 察觉时手电转向的速度是 BEHAVIOR.turnRate 的几倍（手电先转，身体按平常速度跟上） */
  torchTurn: 2,
  /** 察觉中又来一个来源：优先级高的或一样高的接管 */
  priority: { manifest: 3, sound: 2, ghost: 1, chill: 0 } as Record<NoticeKind, number>,
};
export const TRAITS: Record<Personality, { investigateDist: number; noticeHold: number; chillRange: number; recheck: number }> = {
  timid: { investigateDist: 1.5, noticeHold: 1.5, chillRange: 1.2, recheck: 0 },
  average: { investigateDist: 1.5, noticeHold: 1, chillRange: 1, recheck: 0 },
  brave: { investigateDist: 0.8, noticeHold: 1, chillRange: 1, recheck: 0.5 },
};
// GHOST 里加：
  /** 进入发毛范围后多久内一定有反应（秒）：停一下、回头照一下 */
  onset: 0.5,
  /** 发毛到这个程度还贴着：后退半步、手电一直照着背后 */
  backAt: 0.7,
  /** 鬼魂穿墙声能被多远的访客听见（米）、听见涨多少恐惧值 */
  hearWall: 3,
  hearFear: 2,
export const MANIFEST = {
  windup: 0.6,
  hold: 1.5,
  cooldown: 18,
  /** 落下时看得见鬼魂的最远距离（米） */
  range: 6,
  fear: 30,
  /** 距离系数：near[0] 米内 nearMult[0]，near[1] 米处 nearMult[1]，中间线性 */
  near: [1, 6] as [number, number],
  nearMult: [1.3, 0.6] as [number, number],
  /** 正中系数：光锥正中 center[0]，光锥边上 center[1] */
  center: [1.2, 0.9] as [number, number],
  /** 鬼魂被这个人的手电照着时再乘 */
  lit: 1.25,
  /** 蓄力时多远内的访客会察觉（米） */
  noticeRadius: 5,
  /** 被吓到的人：后退到离鬼魂至少 backOff 米，之后 avoidTime 秒内绕开 avoidRadius 米的圆 */
  backOff: 1.5,
  avoidRadius: 2.5,
  avoidTime: 20,
};
export const TRAP = {
  /** 按住多久算「设下」（秒；picking.ts 用） */
  holdToArm: 0.5,
  max: 2,
  expire: 60,
  /** 背后型：物件在访客背后这么远（米）时开始蓄势 */
  behind: [1.5, 3] as [number, number],
  /** 进入范围后最多等多久挑时机（秒） */
  wait: 1.5,
  fearMult: 0.9,
};
```

```ts
// src/config/scares.ts
  bed: { kind: 'sight', range: 5, fear: 26, cooldown: 14, active: 3.2, broken: 0, hitAt: 2.6 },
// src/config/house.ts 的 PROPS（床本身已经挡路，这一格标成 Prop 不改变能不能走）
  { id: 'bed', type: 'bed', cell: [2, 20], facing: E, room: 'bedroom' },
```

```ts
// src/view/torches.ts（手电的共享登记表：flashlight.ts 写，ghost.ts 读）
import type { Vec2 } from '../sim/types';
export interface TorchSample {
  /** 房屋米坐标；y 为离地高度 */
  x: number; y: number; z: number;
  /** 光轴方向（单位向量，房屋坐标） */
  dx: number; dy: number; dz: number;
  /** 光锥半角（弧度）、照多远（米）、强度 0..1（0 = 没点亮） */
  angle: number; range: number; power: number;
}
export const TORCH_COUNT = 4;
/** 每帧由 flashlight.ts 覆盖写；没在用的手电 power = 0 */
export const torches: TorchSample[] = Array.from({ length: TORCH_COUNT }, () => ({ x: 0, y: -100, z: 0, dx: 0, dy: 0, dz: 1, angle: 0, range: 0, power: 0 }));
/** 手电强度的外部乘数（灯闪用，lightfx.ts 写，flashlight.ts 读），1 = 不变 */
export const torchDim: number[] = Array.from({ length: TORCH_COUNT }, () => 1);
export const asVec2 = (t: TorchSample): Vec2 => ({ x: t.x, z: t.z });
```

- [ ] **Step 1：写上面的类型和参数**；`world.ts` 里 `state` 初始化 `manifest: { phase: 'idle', t: 0, cooldown: 0, pos: null }`、`avoid: []`，`createScareObjects` 给 `armed: 0`；`manifest()`、`arm()` 先 `return false`；`setGhost(g)` 存 `{ x, z }`（`inWall` 先不用）
- [ ] **Step 2：补按物件种类建的五张表**：`strings.ts` 的 `propName.bed = 'Bed'`；`overlays.ts` 的 `GHOST_MARK_Y.bed = 0.9`；`engine.ts` 的 `SOURCE_Y.bed = 0.55`；`sfx.ts` 的 `TRIGGER` 改成 `Partial<Record<ScareType, SfxFn>>`，`engine.ts` 里调用处改成 `TRIGGER[type]?.(...)`；`props.ts` 的 `builders.bed = () => createBed()`
- [ ] **Step 3：`src/view/props/bed.ts` 的静态被子**：按家具表里 `bedroom-bed`（rect x 1–4、z 18–22 格，朝东）算出床面范围，建一块细分 40×60 的平面（床面高 `FURNITURE_TOP.bed` + 0.06 米），`bodyMaterial(0.9)`，返回 `PropRig`（`trigger` / `reset` / `update` 先什么都不做，`hit` 盒子盖住床面，`shells` 用这块被子）。`furniture.ts` 的床先不改
- [ ] **Step 4：跑测试**：`./node_modules/.bin/tsc --noEmit -p .`；`./node_modules/.bin/vitest run`。平衡测试如果因为多了床而变（多一个惊吓物件），把床的 `fear` 调到让原有不变量仍然成立（下限 18），记在 `scares.ts` 的注释里
- [ ] **Step 5：提交** `feat: 现身、察觉、机关、床的接口和参数（行为下一步做）`

---

## 路 S：模拟（一个助手按顺序做）

### Task S1：察觉那一拍

**Files:** Modify `src/sim/npc.ts`；Create `tests/notice.test.ts`

**Interfaces:**
- Consumes：`NOTICE`、`TRAITS`、`NoticeState`、`notice` 事件
- Produces：`export function notice(npc: Npc, ctx: NpcCtx, kind: NoticeKind, src: Vec2): boolean`（接管成功返回 true）；`hear()` 改成先 `notice(kind 'sound')`，盯完再进警觉（胆大的 `investigateDist` 用 `TRAITS`）

- [ ] **Step 1：写失败的测试**（`tests/notice.test.ts`，用 `createWorld({ seed: 1, autoSpawn: false })`，访客站在门厅 `{ x: 8, z: 9.5 }`，朝东）

```ts
import { describe, expect, test } from 'vitest';
import { createWorld } from '../src/sim/world';
import { NOTICE, TRAITS } from '../src/config/visitors';
import type { SimEvent } from '../src/sim/types';
const DT = 1 / 60;
const run = (w: ReturnType<typeof createWorld>, s: number) => { const ev: SimEvent[] = []; for (let t = 0; t < s; t += DT) ev.push(...w.step(DT)); return ev; };

describe('察觉那一拍', () => {
  test('听到引诱声：先停下、手电先转过去，盯 0.5–1 秒后才开始走', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: { x: 13, z: 9 }, lookDir: Math.PI, personality: 'average' }); // 卧室门外，背对卧室
    w.trigger('music-box');
    const ev = run(w, 0.2);
    expect(ev.some((e) => e.type === 'notice' && e.npc === n.id && e.kind === 'sound')).toBe(true);
    expect(n.notice?.kind).toBe('sound');
    expect(n.speed).toBeLessThan(0.3);
    run(w, NOTICE.hold[1] * TRAITS.average.noticeHold + 0.3);
    expect(n.notice ?? null).toBeNull();
    expect(n.mode).toBe('alert');
  });
  test('手电先转、身体后转：察觉开始 0.15 秒时手电已经比身体更接近来源', () => {
    const w = createWorld({ seed: 1, autoSpawn: false });
    const n = w.spawn({ pos: { x: 13, z: 9 }, lookDir: Math.PI, personality: 'average' });
    w.trigger('music-box');
    run(w, 0.15);
    const box = w.state.objects.find((o) => o.id === 'music-box')!.pos;
    const want = Math.atan2(box.z - n.pos.z, box.x - n.pos.x);
    const off = (a: number) => Math.abs(Math.atan2(Math.sin(a - want), Math.cos(a - want)));
    expect(off(n.lookDir)).toBeLessThan(off(n.heading));
  });
  test('受惊、逃跑中不察觉', () => {
    const w = createWorld({ seed: 2, autoSpawn: false });
    const a = w.spawn({ pos: { x: 13, z: 9 }, lookDir: Math.PI });
    w.trigger('mirror'); // 让 a 先被别的东西吓到不容易摆，直接改状态
    a.mode = 'fleeing';
    w.trigger('music-box');
    const ev = run(w, 0.3);
    expect(ev.some((e) => e.type === 'notice' && e.npc === a.id)).toBe(false);
  });
  test('优先级：察觉发毛时来了声音，声音接管；察觉声音时开始发毛，不接管', () => {
    const nav = createNav(new Grid());
    const npc = createNpc({ id: 1, name: 'A', personality: 'average', pos: { x: 8, z: 9.5 }, lookDir: 0, mode: 'wander', now: 0 }, { rng: createRng(1), nav });
    const events: SimEvent[] = [];
    const ctx = { nav, rng: createRng(1), now: 0, dt: DT, events, onScream: () => {}, onFlee: () => {}, crowd: [npc], ghost: null } as NpcCtx;
    expect(notice(npc, ctx, 'chill', { x: 7, z: 9.5 })).toBe(true);
    expect(notice(npc, ctx, 'sound', { x: 9, z: 9.5 })).toBe(true);
    expect(npc.s.notice?.kind).toBe('sound');
    expect(notice(npc, ctx, 'chill', { x: 7, z: 9.5 })).toBe(false);
    expect(npc.s.notice?.kind).toBe('sound');
  });
  test('胆小的盯得久：noticeHold 1.5 倍', () => {
    const end = (personality: 'timid' | 'average') => {
      const w = createWorld({ seed: 3, autoSpawn: false });
      const n = w.spawn({ pos: { x: 13, z: 9 }, lookDir: Math.PI, personality });
      w.trigger('music-box');
      let t = 0;
      while (t < 5) { w.step(DT); t += DT; if (t > 0.1 && !n.notice) break; }
      return t;
    };
    const r = end('timid') / end('average');
    expect(r).toBeGreaterThan(1.2);
    expect(r).toBeLessThan(1.8);
  });
});
```
这一条用到的引用：`import { createNav, createNpc, notice } from '../src/sim/npc'; import type { NpcCtx } from '../src/sim/npc'; import { Grid } from '../src/sim/grid'; import { createRng } from '../src/sim/rng';`（照 `tests/ghost.test.ts` 的 `bench()`）。

- [ ] **Step 2：跑，确认失败**：`./node_modules/.bin/vitest run tests/notice.test.ts` → FAIL（`notice` 不存在 / 没有 notice 事件）
- [ ] **Step 3：实现**
  - `Npc` 加 `noticeHome: { heading: number } | null`；`s.notice` 用 `NpcState.notice`
  - `notice(npc, ctx, kind, src)`：受惊、逃跑、离开的人返回 false；已有察觉且新来源优先级低于它返回 false；否则 `s.notice = { kind, src, t: 0, hold: rng.range(...NOTICE.hold) * TRAITS[p].noticeHold }`，发 `notice` 事件，返回 true
  - `updateNpc` 在状态机之前：有察觉时 `brake`（`MOTION.decel` 减速到 0，不急刹）、手电 `turnToward(lookDir, 来源方向, BEHAVIOR.turnRate * NOTICE.torchTurn * dt)`、身体 `turnToward(heading, 来源方向, BEHAVIOR.turnRate * dt)`；`t += dt`；`t ≥ hold` 时清空并按 kind 收尾：`sound` → `beginAlert`（原来 hear 里的那段），`ghost` / `chill` → 回到原来的事（闲逛照走），`manifest` → 什么都不做（由 S5 的定住接管）
  - `isFrozen` 不包括察觉（察觉时只是停下，可以被挤开）
  - `hear()`：恐惧值照加、事件照发；不是受惊中就 `notice(kind 'sound', source)`，把「察觉完去查看」记成 `npc.afterNotice = source`；受惊中照旧改恢复目标
  - `beginAlert` 里停下查看的距离用 `TRAITS[p].investigateDist`（原来是 `BEHAVIOR.investigateDist`）
- [ ] **Step 4：跑 `tests/notice.test.ts` 和全部测试**。`tests/world.test.ts` 里「听到就转入警觉」之类的时序断言如果因为多了察觉那一拍而失败，把等待时间加上 `NOTICE.hold[1] * 1.5`，不要删断言
- [ ] **Step 5：提交** `feat: 访客的察觉那一拍：停下、手电先转、盯一会儿再决定`

### Task S2：发毛立刻有反应、鬼魂穿墙声听得见

**Files:** Modify `src/sim/npc.ts`（`feelGhost`）、`src/sim/world.ts`（`setGhost` 的 `inWall`）、`tests/ghost.test.ts`

- [ ] **Step 1：写失败的测试**（加在 `tests/ghost.test.ts`）
  - 鬼魂从 3 米外移到访客正后方 1 米：0.5 秒（`GHOST.onset`）内出现 `notice`（kind `chill`），手电随后转向鬼魂方向（角度差 < 0.3 弧度）
  - 同一次贴近只触发一次（之后 3 秒内不再有 kind `chill` 的 notice）；离开到 `GHOST.radius` 外再回来，又触发一次
  - 贴着、发毛到 `GHOST.backAt` 以上：访客离鬼魂的距离在 2 秒内变大（后退）
  - 原来的随机回头去掉：`GHOST.glanceEvery` 相关的测试改成上面这套
  - 穿墙声：`w.setGhost({ x, z, inWall: true })`（前一步 `inWall: false`），3 米内的访客有 kind `sound` 的 notice、恐惧值 +`GHOST.hearFear × 性格倍率`；4 米外的没有
  - 胆小的发毛范围 × 1.2：鬼魂在 1.7 米处（> radius 1.5、< 1.8）时胆小的有 chill，普通的没有
- [ ] **Step 2：跑，确认失败**
- [ ] **Step 3：实现**
  - `feelGhost`：距离判断用 `GHOST.radius * TRAITS[p].chillRange`；`Npc` 加 `ghostNear: boolean`（上一步在不在范围内）和 `onsetAt: number`；进入范围那一步记 `onsetAt = now + rng.range(0.15, GHOST.onset)`，到点 `notice(npc, ctx, 'chill', 鬼魂位置)`；`u ≥ GHOST.backAt` 时调 `retreat(npc, ctx, 鬼魂位置, 0.5)`（新函数，S5 也用它：沿远离 `from` 的方向找一个离 `from` 至少 `dist` 米、能走、离当前位置最近的点 `walkTo`，手电保持照向来源）
  - 删掉 `glanceLeft / glanceNextAt / glanceHome` 和 `GHOST.glance*` 参数（画面若用到 `glance`，改成看 `s.notice`）
  - `npc.ts` 导出 `hearGhost(npc, ctx, amount, src)`：加恐惧值（算「被吓」，让回落重新计时）、`notice(npc, ctx, 'sound', src)`，察觉完去查看（和 `hear` 一样的收尾），**不发 `heard` 事件**（`heard` 的 object 是物件 id，界面的滚动提示会按它查物件名）
  - `world.ts`：`setGhost` 记住上一次的 `inWall`；由假变真的那一步，对 `GHOST.hearWall` 内、`canHear` 的人 `hearGhost(n, ctx, GHOST.hearFear * n.mult, 鬼魂位置)`
- [ ] **Step 4：跑全部测试**；`tests/balance.test.ts` 里鬼魂相关的两条若变（反应更确定），只改阈值、不改不变量，改动写在注释里
- [ ] **Step 5：提交** `feat: 鬼魂贴近 0.5 秒内必有反应、贴着会后退；穿墙声 3 米内听得见`

### Task S3：尖叫只留给吓破胆的时候、胆大的再照一眼

**Files:** Modify `src/config/visitors.ts`（`FEAR.screamAt` 15 → 25，`FEAR.screamDread: true` 的说明）、`src/sim/npc.ts`（`startleWith`）、`tests/world.test.ts`、`tests/balance.test.ts`

- [ ] **Step 1：写失败的测试**：涨 20 的惊吓不尖叫、涨 25 的尖叫；恐惧值 ≥ 80 时再被吓（哪怕涨 5）也尖叫；胆大的被惊吓物件吓完、僵住结束后，有 `TRAITS.brave.recheck` 的几率（用固定种子）手电回到物件方向停 1 秒（`notice` kind `sound`、src = 物件位置）
- [ ] **Step 2：跑，确认失败**
- [ ] **Step 3：实现**：`scream = amount >= FEAR.screamAt || s.fear >= FEAR.dread`；`restore()` 之后胆大的按 `recheck` 几率 `notice(npc, ctx, 'sound', 物件位置)`（物件位置从 `startle` 传进来，存在 `npc.lastScareSrc`）
- [ ] **Step 4：跑平衡测试**：尖叫变少 → 传染变少，会玩的机器人每 5 分钟吓跑的人数可能下降。调 `FEAR.contagion`（5 → 不超过 8），让「会玩的机器人每 5 分钟约 9 人」这条仍在原来的容差里；调了什么写进 `config/visitors.ts` 的注释
- [ ] **Step 5：提交** `feat: 尖叫只留给吓破胆的时候；胆大的被吓完还要再照一眼`

### Task S4：手电照到鬼魂（只显形、不吓人）

**Files:** Modify `src/sim/world.ts`；Test `tests/manifest.test.ts`（新，先放这一节）

- [ ] **Step 1：写失败的测试**：访客朝东、鬼魂在他正前方 3 米（有视线）→ 出现 `reveal`（on: true）和 kind `ghost` 的 `notice`，恐惧值不变；鬼魂移到他身后 → `reveal`（on: false）；隔着墙不 reveal；同一个人被照着时不重复发 on
- [ ] **Step 2：跑，确认失败**
- [ ] **Step 3：实现**：`world.ts` 每步（移动之后、seenBy 之前）对每个 `canBeScared` 的人算 `lit = ghost && canSee(grid, n.s, ghost, VISION.range)`，和上一步不同就发 `reveal`；由假变真时 `notice(n, ctx, 'ghost', ghost)`。`Npc` 加 `litGhost: boolean`
- [ ] **Step 4：跑全部测试**
- [ ] **Step 5：提交** `feat: 访客的手电照到鬼魂：发 reveal、愣一下，不涨恐惧值`

### Task S5：主动现身（吓人、赶人）

**Files:** Create `src/sim/manifest.ts`；Modify `src/sim/world.ts`、`src/sim/pathfind.ts`（avoid 代价）、`src/sim/npc.ts`（`retreat`）；Test `tests/manifest.test.ts`

**Interfaces:**
- Produces：`manifest.ts` 导出 `createManifest(): { state: ManifestState; start(ghost: Vec2): boolean; tick(dt: number): 'windup' | 'drop' | 'end' | null }`；`npc.ts` 导出 `retreat(npc: Npc, ctx: NpcCtx, from: Vec2, dist: number): void`；`pathfind.ts` 的寻路接受 `avoid: readonly AvoidZone[]` 和 `now: number`（圆内格子代价 × 20）

- [ ] **Step 1：写失败的测试**（`tests/manifest.test.ts`）
  - 没有鬼魂时 `manifest()` 返回 false；有鬼魂时返回 true，下一步有 `manifest` windup；冷却中返回 false；`MANIFEST.windup` 秒后 drop，再 `MANIFEST.hold` 秒后 end，`state.manifest.cooldown` ≈ 18
  - 蓄力时 5 米内的人有 kind `manifest` 的 notice，并且手电对着鬼魂
  - drop：只有看得见鬼魂（光锥 + 视线 + 6 米）的人在 `scared` 里、被吓到（有 startle，object = `GHOST_SOURCE`）；背对的人不在
  - 吓多少：1 米、在光锥正中、被他的手电照着的 average = `30 × 1.3 × 1.2 × 1.25`（±0.5，习惯化第一次为 1）；6 米、光锥边上 = `30 × 0.6 × 0.9`（±0.5）
  - 被吓到的人在 `MANIFEST.avoidTime` 内往远离现身点的方向走，和现身点的距离 2 秒后 ≥ `MANIFEST.backOff`；`state.avoid` 里有一个半径 2.5 米、到期时间正确的圈；之后他的寻路路线不穿过这个圈（能绕的话）
  - 只靠现身能吓跑胆大的（机器人：每 18 秒在他面前 2 米现身一次，5 分钟内恐惧值到 100），但比「物件 + 现身」的机器人慢（放进 `tests/balance.test.ts`，机器人写在 `tests/bots.ts`）
- [ ] **Step 2：跑，确认失败**
- [ ] **Step 3：实现**
  - `manifest.ts`：状态机 idle → windup（`t` 到 `MANIFEST.windup`）→ hold（到 `MANIFEST.hold`）→ cooldown（`cooldown` 倒数到 0）→ idle
  - `world.ts`：`manifest()` 要有鬼魂、`phase === 'idle'`；windup 那一步发事件，并对 `noticeRadius` 内的人 `notice(n, ctx, 'manifest', pos)`；hold 期间看得见的人 `transfixOn` 用一个假的物件对象（`{ state: { pos, type: 'manifest' } }` 不行就加 `npc.transfixPos: Vec2 | null`，`isFrozen` 和手电转向一起支持）；drop 那一步按上面的公式算恐惧值 `exposure(n, 'manifest', ...)`（`HabitKey` 加 `'manifest'`），`startleWith(n, ctx, GHOST_SOURCE, amount, pos)`，再 `retreat(n, ctx, pos, MANIFEST.backOff)`，`state.avoid.push({ pos, r: MANIFEST.avoidRadius, until: now + MANIFEST.avoidTime })`；每步清掉过期的 avoid
  - `retreat`（S2 已有）：在僵住结束、恢复状态时调用；之后照常闲逛（闲逛挑目标时跳过 avoid 圈里的点）
- [ ] **Step 4：跑全部测试**
- [ ] **Step 5：提交** `feat: 主动现身：蓄力 0.6 秒、落下吓看得见的人、被吓的人后退并绕开 20 秒`

### Task S6：机关（模拟）

**Files:** Create `src/sim/traps.ts`；Modify `src/sim/world.ts`、`src/sim/scares.ts`；Test `tests/traps.test.ts`

- [ ] **Step 1：写失败的测试**（`tests/traps.test.ts`）
  - `arm('rocking-chair')` 返回 true、下一步有 trap armed、`armed` ≈ 60；同时设下的第三个返回 false；冷却中的物件返回 false
  - 60 秒没人来：trap expired、`armed` = 0、物件没有触发（cooldown 不变）
  - 背后型（摇椅、床）：访客从物件旁走过、物件在他背后 1.5–3 米时触发（trap sprung + trigger），他察觉（notice kind `sound`）、回头，落下时被吓到（startle object = 物件 id），恐惧值 = 正常 × 0.9
  - 迎面型（肖像、镜子、台灯）：手电照到时触发
  - 引诱类（八音盒、门）：进入听得见范围就触发
  - 等时机：进入范围后最多 1.5 秒；离开范围前一定触发
- [ ] **Step 2：跑，确认失败**
- [ ] **Step 3：实现**：`traps.ts` 导出 `armTrap(o, armedCount): boolean`、`tickTraps(objects, npcs, grid, now, dt, fire: (o) => void, events)`；`fire` 走 `triggerObject` 那条路（和玩家点一下一样），只是恐惧值乘 `TRAP.fearMult`（`ScareObject` 加 `fearMult` 字段，`startle` 时乘上）。背后型 = `rockingChair`、`bed`（以后的衣柜）；迎面型 = `portrait`、`mirror`、`lamp`；引诱类按 `spec.kind === 'lure'`
- [ ] **Step 4：跑全部测试**；`tests/bots.ts` 的「会玩」机器人加一条：没人看得见物件时偶尔设机关，平衡测试的不变量照旧成立
- [ ] **Step 5：提交** `feat: 机关：设下后等人路过、在背后发作，60 秒没触发自动解除`

---

## 路 V：鬼魂画面（一个助手按顺序做）

### Task V1：手电登记表、手电照出鬼魂（G1）

**Files:** Modify `src/view/flashlight.ts`、`src/view/ghost.ts`、`dev/ghost.ts`

**Interfaces:** Consumes `torches`、`torchDim`（任务 1）；Produces `ghost.ts` 的 uniform `uReveal`（0..1，最亮那支手电对鬼魂的照射程度，给声音和调试读：`export function ghostRevealAmount(): number`）

- [ ] **Step 1：`flashlight.ts` 每帧写登记表**：`createFlashlight` 里用模块级计数分配 `slot`（`const slot = nextSlot++ % TORCH_COUNT`，不改调用处，V 路不碰 `characters.ts`）；`update()` 末尾写 `torches[slot] = { x, y, z, dx, dy, dz（光轴单位向量）, angle: TORCH.halo.angle, range: TORCH.distance, power: p.power × flick × torchDim[slot] }`；`park()` 写 `power = 0`；强度本身也乘 `torchDim[slot]`（灯闪用）
- [ ] **Step 2：`ghost.ts` 的着色器**：加 4 组 uniform（`vec4 pos + range`、`vec4 dir + cosAngle`、`float power × los`），`los` 在 CPU 上每帧每支算一次：`ghostSees(手电位置, 鬼魂位置)`（`engine/ghostRig.ts` 已有的格子视线）？0 或 1。片元里：

```ts
// 对每支手电 i：片元世界坐标 P，L = P − pos_i；d = |L|；cosθ = dot(L / d, dir_i)
// 光锥内的程度：smoothstep(cosAngle_i, mix(cosAngle_i, 1, 0.35), cosθ) × (1 − smoothstep(range_i × 0.7, range_i, d)) × power_i × los_i
// reveal = max(四支)；不透明度 × mix(1, 3, reveal)；soft 区间下限从 GHOST.body.soft[0] 收到 0.55（轮廓变清楚）；
// 颜色 mix(原色, 手电暖色 0.95/0.8/0.6 × 0.5, reveal × 0.35)
```
写进 `createGhostMaterial`，常量放 `GHOST.reveal = { density: 3, soft: 0.55, warm: 0.35, edge: 0.35 }`
- [ ] **Step 3：看样**：`dev/ghost.html` 加 `?torch=x,z,dir` 放一支假手电照着鬼魂；`node scripts/shot.mjs "http://127.0.0.1:5731/dev/ghost.html?torch=6,5,0" shots/ghost/reveal.png --wait 3000`，对比没有手电的截图：光里的人影明显更实、轮廓更清楚，光外不变
- [ ] **Step 4：`tsc`、`vitest`、`node scripts/smoke.mjs --no-build`（先 `npm run build`）通过**
- [ ] **Step 5：提交** `feat: 手电照出鬼魂：光锥里的人影变浓、变清楚、带一点暖色`

### Task V2：现身的画面：变实、降帧、借光出入（G2、G3、G4）

**Files:** Modify `src/view/ghost.ts`；Create `src/view/lightfx.ts`、`src/view/frost.ts`；Modify `dev/ghost.ts`

**Interfaces:**
- Consumes：`WorldState.manifest`、`manifest` 事件、`torchDim`
- Produces：`lightfx.ts` 导出 `createLightFx(core: RenderCore): Module & { registerLight(light: THREE.Light, getPos: () => Vec2): void; pulse(center: Vec2, radius: number, pattern: string, seconds: number): void; dipAll(center: Vec2, radius: number, depth: number, ms: number): void }`；`frost.ts` 导出 `createFrost(core: RenderCore): Module & { grow(pos: Vec2, radius: number, seconds: number): void; small(id: string, pos: Vec2, on: boolean): void }`（`small` 给机关提示用）

- [ ] **Step 1：`lightfx.ts`**：Quake 式节奏表（字母 a 最暗、m 正常、z 最亮，每秒 10 个字母；现身蓄力用 `"mmamammmmammamamm"` 一类，不超过每秒 3 次暗下）；强度压到 30–50% 时颜色往暖红偏（`color.lerp(0xff6a3a, (1 − k) × 0.5)`）；灯包括：台灯的点光（`props/lamp.ts` 暴露出来）、门廊灯、手电（通过 `torchDim`）。不新建灯
- [ ] **Step 2：`frost.ts`**：贴地的一块圆（`depthWrite: false`、`polygonOffset`），着色器里按半径、噪声画霜（颜色用 `walls.ts` 的 `DISSOLVE.frostAlbedo`），`grow` 在给定秒数里从 0 长到半径，之后 3–5 秒化掉
- [ ] **Step 3：`ghost.ts` 现身**：uniform `uSolid`（0..1）、`uStep`（1 = 降帧）。`manifest` 事件：windup → `lightfx.pulse(pos, 5, 蓄力节奏, 0.6)`、`frost.grow(pos, 1.2, 0.6)`；drop → `lightfx.dipAll(pos, 5, 0.15, 100)`，在暗下去的那一帧把 `uSolid` 直接设成 1（不淡入）：不透明度 0.85、颜色压暗到 0.1、改成普通混合（备好第二个材质，drop 那一帧换上，hold 结束那一帧换回，两个材质都在开场预编译里编好）、顶点飘动停下、头部那段（身高 0.75 以上的顶点）在 1.5 秒里绕 x 轴转 8°，时间按 0.1 秒取整（`floor(t × 10) / 10`）；end → `dipAll(pos, 5, 0.2, 80)`，暗下那一帧换回原材质
- [ ] **Step 4：看样**：`dev/ghost.html?manifest` 每 4 秒自动现身一次；截 windup 中、drop 后 0.3 秒、end 后 0.3 秒三张；确认：没有淡入淡出、灯没有全灭、没有白闪
- [ ] **Step 5：测试、提交** `feat: 现身的画面：灯像坏灯泡一样暗几下、霜往外长、借暗下去的一下变实，停留时降到每秒 10 帧`

### Task V3（有空就做）：鬼魂在墙上的影子（L2）

- 鬼魂加一个只进阴影图的网格（`castShadow = true`、主画面里不画：`material.colorWrite = false` 加 `depthWrite = false`，或用阴影专用层），只在 `uReveal > 0.2` 或现身时显示；手电阴影图本来就在画
- 看样：手电从侧面照到鬼魂，身后的墙上有影子。性能：`node scripts/perf.mjs` 满载仍 60 fps
- 提交 `feat: 鬼魂被手电照到时在墙上投下影子`

### Task V4（有空就做，等用户的新鬼魂模型）：换模型的接口
- `src/config/ghost.ts`（新）：`export const GHOST_MODEL: { url: string | null; animated: boolean; clip: string | null } = { url: null, animated: false, clip: null }`
- `ghost.ts`：`url` 为 null 时用现在的 `buildGhostGeometry`；不为 null 时加载 GLB，每个网格换上鬼魂的两层材质（身体 + 雾晕，现身时换实的那份），按包围盒算 `GhostLook` 的 bottom / top；`animated` 时现身那 1.5 秒播 `clip`（照样每秒 10 帧）
- 看样：拿占位狐狸的 GLB 试一下能换上；提交 `feat: 鬼魂可以换成任意 GLB 模型`

---

## 路 P：物件（一个助手按顺序做）

### Task P1：床（被子下面有人，S4）

**Files:** Modify `src/view/props/bed.ts`、`src/view/furniture.ts`（`bed` 的 Maker 不再画被子那块）、`dev/props.ts`

- [ ] **Step 1：被子的顶点位移**：三个鼓包（膝、躯干、头）沿床的长轴排，每个是一个高斯鼓包 `h_i × exp(−r²/σ²)`；`uniform` 驱动 `knee / torso / head / breath / headShift / collapse / dent`。时间轴（秒，从 trigger 起）：0–1.2 依次升起（膝 0–0.5、躯干 0.3–0.9、头 0.7–1.2）→ 1.2–2.2 呼吸（周期 3 秒，幅度 1.5 厘米）→ 2.2–2.6 头那块沿枕头横移 10 厘米、呼吸停 → 2.6 塌平（0.12 秒）→ 凹陷（负的躯干鼓包，深 2 厘米）5 秒回平。法线按位移重算（有限差分），手电掠过时鼓包有影子
- [ ] **Step 2：落下时扬灰**：复用肖像的粉尘粒子（`particles/`），从床面中间扬起
- [ ] **Step 3：看样**：`dev/props.html` 按 8 触发床；截 1.0、2.0、2.7、4.0 秒四张；确认：没有露出身体部位、没有脸，塌下以后留着凹陷
- [ ] **Step 4：测试、冒烟测试**（`scripts/smoke.mjs` 的「准星对准每个物件」现在有 8 个）、**提交** `feat: 床：被子下面慢慢鼓起一个人形，会呼吸，一下子塌平`

### Task P2：机关的操作和提示

**Files:** Modify `src/engine/picking.ts`、`src/view/props.ts`、`src/view/overlays.ts`

**Interfaces:** Produces `Picker.onArm(cb: (id: string) => void): void`

- [ ] **Step 1：按住设机关**：第三人称的拾取器 `pointerdown` 时记下时间和对准的物件，不立刻 `onPick`；`pointerup` 时按住不到 `TRAP.holdToArm` 秒 → `onPick(id)`（点一下照旧），到了 → `onArm(id)`。按住期间对准的物件变了就作废。**注意**：这会让点一下附身晚到松开时才发生——把 `onPick` 改到 `pointerdown` 之后 `holdToArm` 秒内松开就立刻发（松开那一刻），不要等满 0.5 秒
- [ ] **Step 2：提示**：`armed > 0` 的物件表面一层很薄的霜（`frost.small(id, pos, true)`，V 路的接口；V 还没合入时先用物件幽光外壳的一个冷色变体）；`overlays.ts` 物件上方的眼睛标记换成空心
- [ ] **Step 3：测试、提交** `feat: 按住约 0.5 秒设机关；设下的物件结一层薄霜`

### Task P3（有空就做）：衣柜（A 版）
按设计 4.3 和调研 3.3：卧室北墙的衣柜拆出门板绕合页转，门缝里的黑（S3），落下时门被从里面拉上（闷响、落灰）。新 `ScareType` `'wardrobe'` 要主会话在 `types.ts` 加（P 路先发消息说一声）。

---

## 路 U：声音（一个助手）

### Task U1：所有新声音

**Files:** Modify `src/audio/engine.ts`、`src/audio/sfx.ts`、`src/audio/voices.ts`、`src/audio/ghost.ts`；`dev/audio.ts`（每个新声音一个试听按钮）

**Interfaces:** Consumes `manifest`、`reveal`、`notice`、`trap` 事件，`NpcState.fear`；Produces 无（只听事件）

- [ ] **Step 1：现身**：windup → 环境声 0.5 秒内压低 12 dB（A1）、一个小二度的低持续音（55 Hz 和 58.3 Hz 两个正弦，各带一点带通噪声）淡入（A2）、灯每暗一下一声很轻的咔哒（短、低通的噪声脉冲，别像「叮」）；drop → 低频冲击（现有的 braam，`BRAAM` 参数调短）+ 很近的一口冷气（`neckGasp` 的音色，3D 放在鬼魂位置）；end → 持续音 0.8 秒淡出，环境声 1.5 秒后才回来
- [ ] **Step 2：被照到**：`reveal` on 的人数 > 0 时，一层很低、很轻的压力声（约 −30 dB 的低通噪声 + 40 Hz）淡入（0.4 秒），全部 off 时淡出（0.8 秒）
- [ ] **Step 3：访客**：恐惧值 ≥ `FEAR.nervous` 的人一路循环喘气（`shiver` 的呼吸合成，周期按恐惧值从 2.2 秒缩到 1.3 秒），3D 定位、`refDistance` 小（凑近 2 米内才清楚）；恐惧值 ≥ `FEAR.dread` 时每 6–10 秒一声短呜咽（共振峰合成，0.4 秒，往下滑一点）
- [ ] **Step 4：床**：布料摩擦（带通噪声、慢慢起伏）、被布闷住的呼吸（喘气合成加 600 Hz 低通）、塌下的「噗」（低通噪声 0.15 秒）；`TRIGGER.bed`
- [ ] **Step 5：机关**：设下时一声极轻的冰裂声（只有玩家听得见，不是 3D）；sprung 走物件本来的声音
- [ ] **Step 6：`dev/audio.html` 每个都能单独试听；`tsc`、`vitest` 通过；提交** `feat: 现身、被照到、访客喘气和呜咽、床、机关的声音`

---

## 路 M：动作（一个助手；只有这一路花 Tripo 积分，上限 160）

### Task M1：4 个新动作

**Files:** Modify `scripts/tripo/visitors.json`、`scripts/tripo/pipeline.mjs`、`scripts/tripo/selftest.mjs`、`scripts/blender/refine_visitor.py`、`scripts/blender/refine.mjs`、`src/config/character.ts`、`src/view/characters.ts`、`dev/characters.ts`、`public/assets/visitors/*`

- [ ] **Step 1：流水线分批**：`animate.clips` 支持超过 5 个，按 5 个一批建多个 retarget 任务（key `animate`、`animate2`），第二批用 `look: preset:biped:look_around`、`afraid: preset:biped:afraid`、`flee: preset:biped:flee_01`、`scared2: preset:biped:scared_02`。`selftest.mjs` 加一项：8 个动作 → 两个 retarget 请求、第二个只有 4 个
- [ ] **Step 2：Blender 合并**：`refine_visitor.py` 加 `--merge <第二批.glb>`：导入第二个 GLB，把它的动作重定向到第一个骨架上（骨骼名相同，`action` 直接挂到第一个骨架的 NLA），删掉第二个网格和骨架，再照常精修、导出。`refine.mjs` 和流水线的 export 步骤把 `animate2` 的结果传进来
- [ ] **Step 3：先 `--dry-run` 核对只新建 4 个 retarget（每个 40 积分，共 160），再 `node scripts/tripo/visitors.mjs --run all --yes --max-credits 160`**；导出后 `--inspect` 四个 GLB 都有 8 段动作、原地、符合游戏要求
- [ ] **Step 4：画面混合**：`CharacterSpec.clips` 加 `look`、`afraid`、`flee`、`scared2`（可以为 null）；`characters.ts` 的 `POSES` 加这四个：察觉（`s.notice` 不为空）且停着时 `look` 代替 `idle`；紧张（`nervous`）且停着时 `afraid` 代替 `idle`；逃跑（`mode === 'fleeing'`）时 `flee` 代替 `run`；受惊轮流 `scared` / `scared2`。过渡照现有的权重平滑。`dev/characters.html?visitor=<id>` 加键 4 看察觉、5 看紧张站着
- [ ] **Step 5：`tsc`、`vitest`、`node scripts/tripo/selftest.mjs` 通过；提交** `feat: 访客加 4 个动作（张望、害怕、逃跑、第二种受惊），流水线分批生成、Blender 合并`

---

## Task I：接线、操控、全部测试（主会话）

**Files:** Modify `src/main.ts`、`src/engine/ghostRig.ts`、`src/ui/hud.ts`、`src/config/strings.ts`、`scripts/smoke.mjs`、`README.md`、`docs/superpowers/specs/2026-10-26-haunted-house-design.md`

- [ ] **Step 1：操控**：`ghostRig.ts` 加 `onManifest(cb)`：锁定指针时右键（`pointerdown` 且 `button === 2`，`contextmenu` 阻止默认）或 F 键触发；`GhostUi` 加 `manifestCooldown: number`（0..1，1 = 刚用完），准星外面一圈很淡的环按它画（`hud.ts`）
- [ ] **Step 2：接线**（`main.ts`）：`world.setGhost({ x, z, inWall: r.ghost.inWall })`；`r.onManifest(() => world.manifest())`；`picker.onArm((id) => world.arm(id))`；`createLightFx`、`createFrost` 放进 modules；`setGhostUi({ manifestCooldown: world.state.manifest.cooldown / MANIFEST.cooldown })` 每帧写
- [ ] **Step 3：文案**：`strings.ts` 的 `ghost.controls` 改成 `'WASD drift · Mouse look · Click to possess · Hold to set a trap · Right-click or F to appear'`；开场提示加一句 `"They only see what their flashlight shows."`（放在 `start.hint` 后面）
- [ ] **Step 4：冒烟测试**：加三项——F 键现身后有 `manifest` windup / drop 事件（`__haunt` 的事件记录）；按住 0.6 秒设机关后 `armed > 0`；床能被准星对准、附身
- [ ] **Step 5：全部验证**（每条都要贴出结果）：`tsc`；`vitest`；`node scripts/tripo/selftest.mjs`；`node scripts/smoke.mjs`、`node scripts/smoke.mjs --webgl --no-build`；`node scripts/perf.mjs`、`--low`；冷启动 `sh .logs/ready-variant.sh final2 3`；正常节奏 30 秒没有超过 100 ms 的帧（`.logs/stall-natural-wait12.mjs`）
- [ ] **Step 6：README**（操作、新的地址参数）和设计文档第 9 节（这一轮的决定）；提交 `feat: 现身、机关的操控和接线；冒烟测试加三项`

---

## 看样顺序（和用户一个一个看，10/30 上午）

1. 手电照出鬼魂（V1，有空就加 V3 的影子）
2. 现身（V2 + U1 的现身声音）
3. 灯闪的节奏
4. 床（P1 + U1 的床的声音）
5. 机关的手感（P2 + S6）
6. 访客的察觉、发毛反应、新动作（S1–S3 + M1）
