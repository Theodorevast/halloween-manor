# 万圣节 Manor 实现计划

> **For agentic workers:** 本计划按「共享契约先行、各任务并行」执行：契约文件已经写好并提交，任务 1–7 由子 agent 并行实现，任务 8（集成）由主会话完成。每个子 agent 只看自己的任务，所以每个任务都写全了它需要的接口。

**Goal**：做出设计文档 `docs/superpowers/specs/2026-10-26-haunted-house-design.md` 描述的万圣节鬼屋网页游戏，10月31日 公开上线。

**Architecture**：`src/sim/` 是纯 TypeScript 的模拟层（不引用 three.js），对外只暴露 `World`；画面（`src/view/`、`src/engine/`）、声音（`src/audio/`）、界面（`src/ui/`）都实现 `Module` 接口，只读 `WorldState`、订阅 `SimEvent`。`src/main.ts` 把它们接起来。

**Tech Stack**：Vite 8 · TypeScript 7 · three 0.186（`three/webgpu` + TSL，自动退回 WebGL2）· Web Audio · vitest 5 · playwright-core + 本机 Chrome。

## Global Constraints

- 设计文档是需求的唯一来源；本计划里的数值都来自 `src/config/*.ts`，**代码里不要硬编码这些数值，从 config 读**
- 运行时依赖只有 `three` 和两个字体包。**不要 `npm install` 任何东西**；确实需要新依赖，在最终报告里提出
- 许可：不用 AGPL、GPL、专有许可的代码。three.js 的 `examples/jsm`（`three/addons/...`）可以用
- 界面文案全部是英文，从 `src/config/strings.ts` 取；代码注释用中文，风格照 `src/config/house.ts`（简洁、说清「为什么」）
- 声音规则：不用大调、和弦进行、上行音阶、「叮」类奖励音；靠不协和（小二度）和突然性制造惊吓，不靠音量
- 桌面优先；手机上能点、不崩即可
- 角度约定：方向角 a 对应 (cos a, sin a)，x 向东、z 向南；工具函数在 `src/lib/angle.ts`
- 房屋坐标：所有房屋里的物体都加到 `core.houseRoot` 下，局部坐标 = `config/house.ts` 的米坐标，y 向上

### 契约文件（只读）

以下文件是各任务共用的接口，**不要修改**（任务 5 例外：可以改 `src/config/character.ts` 里的 `facingOffset`、`walkRateAt1ms`、`runRateAt1ms`）。需要额外的东西就写在自己的文件里，并在最终报告里说明：

`src/config/house.ts` · `src/config/scares.ts` · `src/config/visitors.ts` · `src/config/character.ts` · `src/config/strings.ts` · `src/sim/types.ts` · `src/engine/types.ts` · `src/lib/angle.ts` · `src/view/palette.ts` · `dev/harness.ts` · `scripts/shot.mjs` · `package.json` · `tsconfig.json` · `vite.config.ts`

### 协作规则（多个 agent 同时在这个目录里工作）

- 只创建 / 修改自己任务列出的文件
- **不要 git commit、不要 git add**，主会话会统一审查和提交
- 类型检查：`./node_modules/.bin/tsc --noEmit -p . 2>&1 | grep -E "<你的文件路径>"`，只看自己文件的错误（别的任务可能正写到一半）
- 用 `./node_modules/.bin/vite`、`./node_modules/.bin/vitest`，**不要用 `npx`**（这台机器上 `npx` 会找到别的项目里的版本）
- 开发服务器只用分配给你的端口，加 `--strictPort`，日志写到 `.logs/`：`(./node_modules/.bin/vite --port <端口> --strictPort > .logs/vite-<端口>.log 2>&1 &)`。这台机器上有别的项目在跑，**不要结束任何不是你启动的进程**；做完后用 PowerShell 按端口结束你自己的 vite：`Get-NetTCPConnection -LocalPort <端口> -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess }`
- 截图自查：`node scripts/shot.mjs http://127.0.0.1:<端口>/dev/<页面>.html shots/<名字>.png --wait 2000 [--key 3] [--eval "js"]`，然后用 Read 工具看图片。截图放 `shots/`（已在 .gitignore）
- 开发沙盒 `dev/harness.ts`：提供最小渲染器、相机和会动的假状态（两个假访客、PROPS 里的全部物件）。按键 1–7 附身物件，F 让 0 号访客逃跑，Q / E 旋转镜头；Playwright 里用 `window.__harness.trigger('portrait')`、`.flee(0)`、`.rotate(1)`。用法见 `dev/harness-check.ts`
- 收尾报告（最终回复）写：改了哪些文件；怎么验证的（测试结果、看过哪些截图、看到了什么）；没做完或有疑问的地方；对契约的任何偏离

### 端口分配

| 任务 | 端口 |
|---|---|
| 主会话 | 5731 |
| 2 引擎 | 5737 |
| 3 房子 | 5732 |
| 4 物件 | 5733 |
| 5 角色与手电 | 5734 |
| 6 声音 | 5735 |
| 7 界面 | 5736 |

---

### Task 1：模拟层

**Files**
- Create：`src/sim/rng.ts`、`src/sim/grid.ts`、`src/sim/pathfind.ts`、`src/sim/perception.ts`、`src/sim/npc.ts`、`src/sim/scares.ts`、`src/sim/spawner.ts`、`src/sim/world.ts`
- Test：`tests/grid.test.ts`、`tests/pathfind.test.ts`、`tests/perception.test.ts`、`tests/world.test.ts`

**Interfaces**
- Consumes：`src/sim/types.ts`（`World`、`WorldState`、`NpcState`、`SimEvent`、`SpawnOptions`、`WorldOptions`）；`src/config/house.ts`（`buildTiles`、`walkable`、`blocksSight`、`cellOf`、`cellCenter`、`propCenter`、`PROPS`、`ROOMS`、`roomAt`、`FRONT_DOOR`、`GRID_W`、`GRID_H`）；`src/config/scares.ts`；`src/config/visitors.ts`；`src/lib/angle.ts`
- Produces：
  - `createWorld(opts: WorldOptions): World`（`src/sim/world.ts`）—— 集成阶段只用这一个
  - `createRng(seed: number): Rng`，`Rng = { next(): number; range(a: number, b: number): number; pick<T>(xs: readonly T[]): T; weighted<K extends string>(w: Record<K, number>): K }`
  - `class Grid`：`constructor(tiles?: Uint8Array)`、`isWalkable(i, j)`、`isOpaque(i, j)`、`lineOfSight(a: Vec2, b: Vec2): boolean`、`nearestWalkable(p: Vec2): [number, number]`
  - `findPath(grid: Grid, from: Vec2, to: Vec2): Vec2[] | null`（米坐标路点，不含起点）
  - `canSee(grid: Grid, npc: Pick<NpcState, 'pos' | 'lookDir'>, target: Vec2, range: number): boolean`
  - `canHear(grid: Grid, listener: Vec2, source: Vec2, range: number): boolean`

**行为（全部数值从 config 读）**

1. **固定步长**：`step(dt)` 累积时间，按 1/60 秒切分推进。`state.hitStop > 0` 时只扣减 hitStop、不推进模拟（`state.time` 不走）
2. **视线** `lineOfSight`：两点之间按格子做 Bresenham，经过 `isOpaque`（墙、窗）的格子就看不见；家具和物件不挡视线
3. **寻路** `findPath`：8 方向 A*，斜走时两个正交邻格都要能走（不切墙角），斜步代价 √2；起点或终点不能走时用 `nearestWalkable`；最后做路径平滑：两个路点之间每 0.1 米采样，采样点及其垂直方向 ±0.2 米处都在可走格里，就删掉中间路点
4. **看见** `canSee`：距离 ≤ range，且 `angleDiff(npc.lookDir, 指向目标的角度) ≤ VISION.halfAngle`，且 `lineOfSight`
5. **听见** `canHear`：有视线时距离 ≤ range；没有视线时距离 ≤ range × `WALL_HEARING_FACTOR`
6. **附身** `trigger(id)`：冷却中返回 false。否则 `cooldown = spec.cooldown`、`active = spec.active`；惊吓类同时 `broken = spec.broken`（为 0 的不设）；本步事件里加 `trigger`
7. **引诱生效**（触发那一步）：所有没在逃跑的访客，`canHear(访客位置, 物件位置, spec.range)` 为真的：恐惧值 += `spec.fear × 性格倍率 × 习惯化系数`，转入 `alert`，目标是物件旁最近的可走格；发 `heard` 事件。引诱不会让人僵住，也不会触发尖叫
8. **惊吓生效**：`active > 0` 期间每一步，对每个没在逃跑、这一次触发里还没被吓过的访客，若 `canSee(访客, 物件位置, spec.range)`：`amount = spec.fear × 性格倍率 × FEAR.habituation^(此人被这种物件吓过的次数)`；进入 `startled`（记住之前的状态，`FEAR.startleTime` 秒后恢复）；`amount ≥ FEAR.screamAt` 时尖叫（`screaming = FEAR.screamTime`）；发 `startle` 事件（`object` = 物件 id）
9. **尖叫传染**：有人尖叫时，其他没在逃跑、`canHear(他, 尖叫者, FEAR.screamRadius)` 的人：恐惧值 += `FEAR.contagion × 性格倍率`，转入 `alert` 走向尖叫者的位置（不僵住）；发 `startle` 事件，`object: null`、`scream: false`
10. **恐惧值**：上限 `FEAR.max`。距离上次被吓（startle 或 heard）超过 `FEAR.decayDelay` 秒后，每秒减 `FEAR.decayRate`，不低于 0，逃跑中不减。`nervous = fear ≥ FEAR.nervous`
11. **吓跑**：恐惧值一到 `FEAR.max` 立刻转 `fleeing`（不管当前在不在受惊），`screaming = FEAR.screamTime`，`state.hitStop = HIT_STOP`，发 `flee` 事件。逃跑：寻路到前门格，再直线走到 `FRONT_DOOR.outside`，速度 `SPEED.flee`；手电方向在朝向 ±0.9 弧度内快速乱晃。走到后 `mode = 'gone'`、`scaredOff += 1`，发 `exit` 事件（带 name 和 total），并在这一步结束时从 `npcs` 里移除
12. **闲逛**：随机选一个不是当前房间的房间（`ROOMS`，可以包括 hall），在房间里随机挑一个可走格（优先不贴墙的格子）寻路过去；速度 `SPEED.wander`，紧张时 `SPEED.nervous`；走路时手电朝向 = 身体朝向 + 小幅摆动（幅度 0.25，周期 `BEHAVIOR.sweepPeriod`）；到达后原地按 `BEHAVIOR.lookAround` 范围随机停留，手电左右扫（幅度 `BEHAVIOR.sweepAmp`）；寻路失败就换一个目标
13. **警觉**：寻路到目标，速度 `SPEED.alert`，手电一直朝向声源；到达后停 `BEHAVIOR.investigate` 秒，手电在声源方向 ±0.4 弧度内扫；然后回到闲逛。警觉中再听到新声音就改去新声源
14. **进门**：生成在 `FRONT_DOOR.outside`，直线走到 `FRONT_DOOR.inside`（速度 `SPEED.enter`），然后闲逛。进门中也能被吓
15. **转向**：身体朝向和手电朝向都按 `BEHAVIOR.turnRate` 限速转动（受惊时除外）。`speed` 字段写当前实际速度
16. **seenBy**：每步更新，惊吓类物件 = 此刻 `canSee(访客, 物件, spec.range)` 的访客 id；引诱类为空数组
17. **复原**：`broken` 倒数到 0 的那一步发 `reset` 事件；`cooldown`、`active` 倒数到 0 为止
18. **生成访客**（`autoSpawn` 默认 true）：`SPAWN.first` 秒时进第一个，之后每 `SPAWN.stagger` 秒进一个直到 `SPAWN.target` 人；之后屋里（不算逃跑中的）少于 `SPAWN.target` 人时，安排一次 `SPAWN.delay` 范围内的随机延迟，同一时间只安排一次。名字从 `NAMES` 里抽，和屋里的人不重名；性格按 `PERSONALITIES[*].weight` 加权抽；id 从 1 递增。生成时发 `spawn` 事件
19. **`spawn(opts)`**：立刻放一个访客。给了 `pos` 时默认 `mode: 'wander'`、站在原地（先执行一次「到达后左右照」），否则在门外 `entering`。也发 `spawn` 事件
20. **确定性**：所有随机都走注入的 `Rng`，同一 seed、同一操作序列，结果完全相同

**测试（必须有，可以多写）**

```ts
// tests/grid.test.ts
import { describe, expect, test } from 'vitest';
import { Grid } from '../src/sim/grid';

describe('Grid', () => {
  const g = new Grid();
  test('墙、地板、门洞、物件格', () => {
    expect(g.isWalkable(0, 0)).toBe(false);
    expect(g.isWalkable(5, 5)).toBe(true);
    expect(g.isWalkable(4, 9)).toBe(true); // 书房门洞
    expect(g.isWalkable(3, 4)).toBe(false); // 肖像所在格
    expect(g.isOpaque(3, 4)).toBe(false); // 物件不挡视线
  });
  test('视线：走廊里通，隔墙不通', () => {
    expect(g.lineOfSight({ x: 1, z: 6 }, { x: 15, z: 6 })).toBe(true);
    expect(g.lineOfSight({ x: 2.5, z: 2.5 }, { x: 7.5, z: 2.5 })).toBe(false); // 书房 → 客厅隔着墙
  });
});
```

```ts
// tests/pathfind.test.ts 要点
// 1. 书房 (2.25, 6.25) → 浴室 (13.5, 9.0) 有路径，每个路点所在格都可走，相邻路点之间的直线不穿墙（每 0.1 米采样检查）
// 2. 路径经过书房门洞（第 9 行、第 4–5 列附近）和浴室门洞
// 3. 终点在墙里 (5.25, 4.75) 时，返回到最近可走格的路径，不返回 null
```

```ts
// tests/perception.test.ts 要点
// 1. 访客在 (8, 6) 朝东 (lookDir 0)，目标 (11, 6)：看得见；目标 (5, 6)（身后）：看不见
// 2. 访客在 (8, 6) 朝北，目标 (8, 2)（客厅，中间隔着第 9 行的墙）：看不见
// 3. canHear：同房间 6 米、range 7：听得见；隔墙 6 米、range 7（7 × 0.6 = 4.2）：听不见
```

```ts
// tests/world.test.ts 要点（autoSpawn: false，seed 固定）
// 1. 在书房 (2.75, 3.75) 放一个 average 访客，lookDir 指向肖像 propCenter；trigger('portrait') 返回 true；
//    step(0.1) 的事件里有 trigger 和 startle（amount 32、scream true）；fear = 32
// 2. 冷却中再 trigger('portrait') 返回 false
// 3. 推进 17 秒等冷却结束（期间 reset 事件出现一次），再 trigger：这次 amount = 16（习惯化减半）
// 4. timid 访客在 (13.25, 8.75)、lookDir 0（朝东，面对 2 米外的落地镜）：trigger('mirror') → amount 72；
//    再让它涨满（例如 20 秒后冷却结束再附身一次镜子：72 × 0.5 = 36，72 − 衰减 + 36 ≥ 100 时成立；不成立就多附身几次）→
//    出现 flee 事件且 state.hitStop === 0.15；记下 state.time，step(0.1) 后 state.time 不变、hitStop ≈ 0.05；再 step(0.1) 后 time 前进约 0.05
// 5. 逃跑后推进 20 秒：出现 exit 事件，scaredOff === 1，npcs 里不再有它
// 6. 卧室 (4, 8.5) 放 A（离八音盒约 2.9 米，同一房间）、厨房 (13, 2.5) 放 B（远超 7 米）：trigger('music-box') →
//    A 有 heard 事件且 mode === 'alert'、fear === 4（average）；B 没有 heard 事件、mode 仍是 wander
// 7. fear = 40 的人 10 秒内不再受惊：fear 降到 40 − (10 − 4) × 3 = 22（允许 ±0.5）
// 8. autoSpawn: true：2.1 秒时 1 人；14.5 秒时 3 人；同一 seed 跑两遍，名字和性格完全一致
// 9. 4 个访客时，1000 次 step(1/60) 总耗时 < 200 ms
```

- [ ] 先写 grid 测试 → 跑（失败）→ 实现 → 跑（通过）；pathfind、perception、world 同样
- [ ] `./node_modules/.bin/vitest run` 全部通过
- [ ] `tsc` 对 `src/sim/`、`tests/` 无报错

---

### Task 2：引擎（渲染器、相机、拾取、后处理、震动）

**Files**
- Create：`src/engine/renderer.ts`、`src/engine/camera.ts`、`src/engine/picking.ts`、`src/engine/postfx.ts`、`src/engine/juice.ts`、`dev/engine.html`、`dev/engine.ts`

**Interfaces**
- Consumes：`src/engine/types.ts`（`RenderCore`、`CameraRig`、`Module`、`Quality`）；`src/config/house.ts`（`HOUSE_W`、`HOUSE_D`）；`src/view/palette.ts`
- Produces：
  - `createRenderCore(canvas: HTMLCanvasElement): Promise<RenderCore>` —— WebGPU 和 WebGL2 都不可用时 `throw new Error('no-webgl2')`
  - `watchFrameTime(onSlow: () => void): (dt: number) => void` —— 返回每帧要调用的函数；开始后第 1–4 秒的平均帧时间 > 22 ms 时调用一次 `onSlow`
  - `createCameraRig(canvas: HTMLCanvasElement): CameraRig`
  - `createPicker(canvas: HTMLCanvasElement, rig: CameraRig, getTargets: () => THREE.Object3D[]): Picker`，`Picker = { onHover(cb: (id: string | null) => void): void; onPick(cb: (id: string) => void): void; dispose(): void }`
  - `createJuice(rig: CameraRig, core: RenderCore): Module`

**要求**

1. 渲染器：`new THREE.WebGPURenderer({ canvas, antialias: true })`，`await renderer.init()`；`backend` 用 `renderer.backend.isWebGPUBackend` 判断；阴影开、`THREE.PCFShadowMap`（r186 的 WebGPU 渲染器没有 PCFSoftShadowMap）；色调映射自选（暗场景要保住暗部层次）；背景 `PALETTE.night`；`houseRoot` 位置 `(-HOUSE_W / 2, 0, -HOUSE_D / 2)`，让房子中心在世界原点
2. 画质：`high` = 像素比 `min(devicePixelRatio, 2)` + 泛光开；`low` = 像素比 1 + 泛光关。`setQuality` 只管渲染器层面的东西（各模块自己的阴影尺寸由模块的 `setQuality` 处理）
3. 后处理（`postfx.ts`，TSL）：轻微泛光（只让手电、台灯这类亮处发光，阈值偏高）、暗角、胶片颗粒（随时间变化，强度很低）。先查 r186 里后处理管线类的名字：`grep -rn "class RenderPipeline\|class PostProcessing" node_modules/three/src`，以实际为准；泛光用 `three/addons/tsl/display/BloomNode.js`。`fx.vignettePulse(strength, color)`：暗角边缘泛起这个颜色（默认 `PALETTE.dread`），0.6 秒内退去
4. 相机：`OrthographicCamera`，仰角 35°，方位角 = 45° + quarter × 90°（quarter 0 时相机在房子东南方向）；画面始终装下整栋房子并留边距（横屏、竖屏都要对）；`rotate` 用 0.45 秒缓入缓出过渡方位角，`viewDir` 在过渡中连续变化，`quarter` 在调用时立即更新并回调 `onRotate`；过渡中再按旋转要排队或接着转，不能跳；`zoom` 限制 0.75–1.6，平滑过渡；滚轮缩放由相机自己监听；`shake` 多次叠加、按时长衰减；`intro(seconds)`：从更高、更远（缩放 0.6、仰角 55°）缓动到正常；`toScreen` 返回画布像素坐标
5. 拾取：`pointermove` 时射线检测 `getTargets()`，从命中物体沿 parent 往上找 `userData.propId`；悬停变化时回调 `onHover`，并设置画布 `cursor: pointer`；按下和抬起间隔 < 400 ms、位移 < 6 px 才算一次点击，回调 `onPick`；触屏点击也要能用
6. 震动（`juice.ts`）：`flee` 事件 → `rig.shake(0.35, 0.5)` + `core.fx.vignettePulse(1, PALETTE.dread)`；`startle` 且 `scream` 为真 → `rig.shake(0.08, 0.2)`；`prefers-reduced-motion` 时震动强度 × 0.3
7. `dev/engine.html`：用真正的 `createRenderCore` + `createCameraRig` + `createPicker`（不用 harness 的渲染器，但可以复用 harness 的思路），放一块地板和几个带 `userData.propId` 的方块，按键测试旋转、缩放、震动、暗角脉冲、悬停高亮

**验证**
- [ ] 截图：4 个方位各一张，房子范围（16 × 12 米的地板）完整在画面内；竖屏 390 × 844 一张
- [ ] 截图：暗角脉冲进行到一半时一张；泛光能看出亮块周围的光晕
- [ ] 用 `--eval` 调 `toScreen` 和实际像素位置对比（比如在房屋 (8, 6) 放一个亮色方块，看截图里它是否在 toScreen 返回的位置）
- [ ] 拾取：`--eval` 派发 pointermove / pointerdown / pointerup 到方块的屏幕坐标，确认回调拿到正确的 id
- [ ] `tsc` 无报错

---

### Task 3：房子

**Files**
- Create：`src/view/house.ts`、`src/view/walls.ts`、`src/view/furniture.ts`、`dev/house.html`、`dev/house.ts`

**Interfaces**
- Consumes：`RenderCore`、`CameraRig`、`Module`、`Quality`（`src/engine/types.ts`）；`src/config/house.ts` 全部；`PALETTE`
- Produces：`createHouseView(core: RenderCore, rig: CameraRig): Module`

**要求**

1. 地板：每个房间一块，房间之间材质略有区别（木地板：书房、客厅、卧室、走廊、门厅；地砖：厨房、浴室）；低多边形、平直着色，可以用 TSL 做很淡的木纹或砖缝
2. 墙：由 `buildTiles()` 里的 `Wall` / `Window` 格生成。墙格 0.5 米宽，墙体居中、厚 `WALL_T`，转角和 T 形接头要接得严丝合缝（建议：每个墙格画一根中心柱，向相邻墙格方向各伸一段）。墙要合并几何体，整栋房子的 draw call 控制在 60 以内
3. 窗：`Window` 格是带窗洞的墙（窗台 0.9 米、窗顶 2.0 米），窗洞里一块淡淡发月光的玻璃
4. 降墙（`walls.ts`）：墙分成「外墙四面」和「内墙」。外墙的外法线和 `rig.viewDir` 点积 < 0 的两面是远墙，保持 `WALL_H`；其余外墙和全部内墙降到 `WALL_CUT_H`（窗只在全高的墙上显示）。每帧根据 `rig.viewDir` 算目标高度，0.3 秒平滑过渡。门洞、前门照常留空
5. 只投影的全高墙：把所有墙的全高版本另做一份，放在 layer 1、`castShadow = true`，主相机看不见。灯的阴影相机要能看见 layer 1：查一下 r186 的阴影渲染是否尊重 `light.shadow.camera.layers`（读 `node_modules/three/src` 里阴影相关代码）。如果尊重，在报告里写清楚灯那边要怎么设置（任务 5 的手电要配合）；如果不尊重，放弃这个做法并在报告里说明
6. 月光：冷蓝色 `DirectionalLight`（`PALETTE.moon`），从远墙那一侧斜着照进窗户（方向跟着 `rig.quarter` 变，保证总是从远墙的窗照进来），强度很低；`high` 档投影（2048），`low` 档不投影。很弱的 `HemisphereLight`（`PALETTE.moonSky` / `PALETTE.moonGround`）。窗下地板上可以加一块淡淡的月光光斑（加法混合的透明面片），便宜又有氛围
7. 家具（`furniture.ts`）：`FURNITURE` 里每一种 `FurnitureKind` 都用基础几何体拼成低多边形模型，填满 `rect`、按 `facing` 朝向，高度写实（床 0.5、书桌 0.75、书架 2.0、床头柜 0.55 —— 八音盒放在床头柜上，物件任务按 0.55 米放）；地毯、走廊长毯只画不挡路；接收和投射阴影
8. 屋外：房子外面一圈深色地面（比房子大一圈，边缘融进背景）；前门外一条小路和一盏很暗的门廊灯（暖色 PointLight，不投影）
9. `setQuality`：`low` 关月光阴影

**验证**
- [ ] `dev/house.html` 用 harness（`createHarness({ ambient: 1.2 })` 看结构；`ambient: 0.25` 看氛围）
- [ ] 截图：亮光下 4 个方位各一张（`window.__harness.rotate(1)`），检查：墙接头严密、降墙正确（远墙两面全高带窗，其余矮）、家具在 rect 里、门洞是空的
- [ ] 截图：暗光下一张，看月光是从窗户照进来
- [ ] 在 dev 页面里把 PROPS 位置画成小柱子（同 harness-check），确认物件格没被家具、墙占住
- [ ] 打印 `renderer.info.render.drawCalls`（或 r186 的等价字段）≤ 60
- [ ] `tsc` 无报错

---

### Task 4：可附身物件

**Files**
- Create：`src/view/props.ts`（太大可以拆成 `src/view/props/*.ts`）、`dev/props.html`、`dev/props.ts`

**Interfaces**
- Consumes：`RenderCore`、`Module`、`FrameCtx`、`Quality`；`PROPS`、`propCenter`、`CELL`、`WALL_CUT_H`（`src/config/house.ts`）；`SCARES`；`ScareObjectState`、`SimEvent`；`PALETTE`；`yawFor`
- Produces：`createPropsView(core: RenderCore): PropsView`，`PropsView = Module & { pickTargets(): THREE.Object3D[]; setHover(id: string | null): void }`

**要求**（全部程序化低多边形；每个物件挂到 `houseRoot`，位置 `propCenter(p)`，朝向 `yawFor(p.facing)` 意义下的正面朝 `facing`）

| 物件 | 平时 | 被附身（`trigger` 事件 / `active > 0`） | 被破坏（`broken > 0`）与复原（`reset` 事件） |
|---|---|---|---|
| portrait | 画架上一幅维多利亚风格肖像（用 CanvasTexture 画一张脸，眼睛是单独的小网格） | 眼睛转向最近的访客（`state.npcs`）约 0.6 秒，然后整幅画向前砸到地上（带一次小回弹） | 倒在地上，`reset` 时立回画架 |
| lamp（×2） | 落地灯，灯罩里一盏暖色 PointLight（`PALETTE.lamp`，不投影），偶尔极轻微地闪 | 1.2 秒内不规则地闪烁，然后熄灭 | 熄灭；`reset` 时闪两下亮回 |
| rockingChair | 静止的摇椅 | 自己摇起来，3 秒内越摇越快，然后慢慢停下 | — |
| door | 厨房门（门洞两格中间，宽 1 米、高 2 米，合页在西侧），平时开着贴在墙边 | 0.12 秒内猛地关上（带回弹），关 1.5 秒，再慢慢自己打开 | — |
| musicBox | 床头柜（高 0.55 米）上的小八音盒 | 盖子打开，里面的小人偶转 4 秒，然后合上 | — |
| mirror | 落地椭圆穿衣镜，朝西；镜面是深色、高光泽的材质（不做真实反射） | 镜面里浮现一张苍白的脸（CanvasTexture，自发光），1 秒内闪烁着出现又消失 | — |

1. **可附身的幽光**：`cooldown === 0` 时物件泛一层很淡的幽绿光（`PALETTE.possess`，缓慢呼吸）；悬停时（`setHover`）更亮、整体放大 1.04；冷却中没有幽光。建议做法：一层略放大的背面外壳网格，加法混合
2. **拾取**：每个物件一个包住它的不可见碰撞盒，`userData.propId = id`，由 `pickTargets()` 返回。确认 three.js 的 Raycaster 会不会跳过 `visible = false` 的物体；会跳过就用一个不写颜色、不写深度的材质代替
3. 门的物件不能挡住门洞的通行观感：开着时贴墙
4. 动画用自己写的缓动（不引第三方库），由 `update(ctx)` 驱动，`dt` 来自 ctx
5. 台灯的光在 `low` 档可以降低强度或减少衰减距离，自己判断

**验证**
- [ ] `dev/props.html` 用 harness（`ambient: 1.2`），镜头拉近（`h.rig.zoom(1.6)`）
- [ ] 截图：全部物件平时状态；依次按 1–7 后 300 ms 各一张（看动画中间态）；肖像倒地状态；台灯熄灭状态
- [ ] 截图：`ambient: 0.25` 时一张，看台灯的光和幽光
- [ ] `--eval` 测 `pickTargets()` 的数量 = 7，每个都带 `propId`
- [ ] `tsc` 无报错

---

### Task 5：访客角色与手电

**Files**
- Create：`src/view/characters.ts`、`src/view/flashlight.ts`、`src/view/fallbackCharacter.ts`、`dev/characters.html`、`dev/characters.ts`
- Modify（只限这几个字段）：`src/config/character.ts` 的 `facingOffset`、`walkRateAt1ms`、`runRateAt1ms`

**Interfaces**
- Consumes：`RenderCore`、`Module`、`FrameCtx`、`Quality`；`CHARACTER`、`FLASHLIGHT_HEIGHT`（`src/config/character.ts`）；`NpcState`、`SimEvent`；`VISION`；`PALETTE`；`yawFor`
- Produces：`createCharactersView(core: RenderCore): Promise<Module>`

**要求**

1. **加载与归一化**：`GLTFLoader` + `MeshoptDecoder`（`three/addons/libs/meshopt_decoder.module.js`，吉祥物可能是压缩导出的）。`updateMatrixWorld` 后用 `Box3.setFromObject` 量包围盒（量化模型的 accessor 范围不是真实尺寸），缩放到 `targetHeight`，x / z 居中，脚底对齐 y = 0；打印全部动画片段名。占位狐狸是 `placeholder-fox.glb`（带骨骼，片段 Survey / Walk / Run，原始高约 79 单位）。判断它的正面朝向，把 `facingOffset` 改对
2. **每个访客一份**：`SkeletonUtils.clone`（`three/addons/utils/SkeletonUtils.js`）；`AnimationMixer`；按状态选片段：速度 < 0.1 用 idle，逃跑或速度 > 2 用 run，否则 walk；切换时 0.2 秒交叉淡入淡出；`timeScale = speed × walkRateAt1ms`（跑步用 `runRateAt1ms`），调到脚步不打滑
3. **程序化层**（有没有动画片段都要叠加）：受惊时先压扁 0.1 秒，再跳起 0.35 米（上升 sine.out、下落 power3.in），落地 0.05 秒过冲回弹；紧张时身体微微发抖；逃跑时身体前倾。没有 walk 片段时，走路用上下弹跳的挤压回弹代替
4. **备用小人**（`fallbackCharacter.ts`）：GLB 加载失败时用：胶囊身体 + 球形头 + 两个点状眼睛，按性格换围巾颜色；同样归一化到 `targetHeight`；控制台 `console.warn`
5. **位置和朝向**：位置 = `npc.pos`（houseRoot 坐标），朝向 = `yawFor(npc.heading) + facingOffset`，朝向变化做平滑插值
6. **手电**（`flashlight.ts`）：参考 工具 证据板的做法，两盏 SpotLight 叠加：外圈（宽而软，`penumbra 1`，`castShadow`，角度约 `VISION.halfAngle × 1.1`，颜色 `PALETTE.torchHalo`）+ 亮芯（窄，不投影，`PALETTE.torchCore`）；光源在角色身前、高 `FLASHLIGHT_HEIGHT`，目标在 `lookDir` 方向 3.5 米外的地面；手里一个小手电网格。阴影 `high` 1024、`low` 512，调好 bias 避免墙上出现条纹。紧张时亮度轻微闪烁。再加一个很淡的加法混合光锥网格（体积光的假象），`low` 档关掉
7. 任务 3 可能会用 layer 1 放「只投影的全高墙」：外圈 SpotLight 的 `shadow.camera.layers.enable(1)`，这样它能被那些墙挡住
8. **事件**：`spawn` → 新角色在门口淡入；`exit` → 角色淡出后移除；state 里不再有的 NPC 也要清理
9. **性能**：4 个访客 + 8 盏聚光（4 盏投影）在 `high` 档要流畅

**验证**
- [ ] `dev/characters.html` 用 harness（两个假访客）；`ambient: 0.25`
- [ ] 截图：平常走动；按 1（肖像，会吓 0 号）后 200 ms（看跳起）；按 F 后 300 ms（逃跑）
- [ ] 截图：`ambient: 1.2` 镜头拉近一张，看模型朝向和身高是否正确（身高 1.1 米大约是墙高 2.4 的一半不到）
- [ ] 截图：把 `CHARACTER.url` 临时指向一个不存在的文件（只在 dev 页面里覆盖，不改 config）验证备用小人
- [ ] `tsc` 无报错

---

### Task 6：声音

**Files**
- Create：`src/audio/engine.ts`、`src/audio/ambience.ts`、`src/audio/sfx.ts`、`src/audio/voices.ts`、`dev/audio.html`、`dev/audio.ts`

**Interfaces**
- Consumes：`Module`、`FrameCtx`；`SimEvent`、`WorldState`、`Vec2`；`ScareType`
- Produces：
  ```ts
  export interface AudioSys extends Module {
    /** 必须在用户的点击里调用（开场遮罩的点击）；之后 AudioContext 被挂起时，下一次点击里再调用一次即可恢复 */
    unlock(): Promise<void>;
    setMuted(m: boolean): void;
    readonly muted: boolean;
  }
  /** pan：把房屋坐标转换成 -1..1 的声像（主会话用相机的 toScreen 实现） */
  export function createAudio(pan: (p: Vec2) => number): AudioSys;
  ```

**要求**（全部用 Web Audio 程序化合成，不用音频文件；较重的声音可以在 `unlock` 时用 `OfflineAudioContext` 预渲染成 AudioBuffer）

| 事件 | 声音 |
|---|---|
| 环境层（`unlock` 后一直在） | D1 / D2 正弦持续音 + 低通噪声风声，**很轻**；平均恐惧值越高，持续音略微变响、加进一个小二度的上方音；每 20–50 秒随机一声木头嘎吱 |
| `trigger` musicBox | 小调、音准微微走调、带 wow / flutter 抖动的 4 秒短旋律，整体**下行**；八音盒的金属音色（短促的高频衰减） |
| `trigger` door | 噪声爆发 + 低频撞击 + 混响尾巴 |
| `trigger` lamp | 1.8 kHz 以上的干短电流噼啪（跟着闪烁节奏）+ 50 Hz 嗡声 |
| `trigger` rockingChair | 带通噪声的木头嘎吱，3 秒内周期越来越快 |
| `trigger` portrait | 先一声低沉的拉长音（眼睛转动），再一声闷响 + 木框碎裂 |
| `trigger` mirror | 反向渐强（0.6 秒）+ 小二度音簇冲击 |
| `startle`（scream 为真） | 共振峰合成的短促卡通式惊叫（约 0.8 秒），音高按 npc id 变化，timid 更高更尖 |
| `startle`（object 为 null） | 很轻的倒吸一口气（带通噪声，短） |
| `flee` | braam 冲击：低频锯齿音簇（含小二度）+ 噪声，1.5 秒；冲击前 0.15 秒（hit-stop）完全静音一下更有效 |
| `exit` | 远处一声闷闷的关门声（不是「叮」） |
| `spawn` | 前门吱呀一声 + 两下敲门 |
| `reset`（台灯） | 电流嗡地一下接通 |

1. 主总线：master gain → `DynamicsCompressorNode`（当限幅器用）→ destination；`setMuted` 用 gain 渐变（0.1 秒），不要断开节点
2. 混响：`ConvolverNode`，冲激响应用代码生成（衰减噪声，约 2.2 秒）；各音效按需送混响
3. 声像：`StereoPannerNode`，用 `pan(物件位置)` 或 `pan(访客位置)`
4. 同一时间最多 3 声尖叫，多了丢弃；每个声音结束后断开节点，防止泄漏
5. 不用大调、和弦进行、上行音阶、「叮」；文件开头的注释写清楚每个声音的配方（用户试听后要来这里调参数）
6. `dev/audio.html`：每个声音一个按钮（点击后先 unlock）；一个「Render all offline」按钮，把每个声音用 OfflineAudioContext 渲染后算峰值和 RMS（dBFS），结果 `console.log` 并写到 `window.__audioReport`

**验证**
- [ ] 用 `node scripts/shot.mjs http://127.0.0.1:5735/dev/audio.html shots/audio.png --wait 1000 --eval "window.renderAll()" --eval-wait 8000 --eval "JSON.stringify(window.__audioReport)"` 拿到每个声音的指标（`renderAll` 的名字自定，在报告里写清）
- [ ] 指标：限幅后峰值 ≤ −1 dBFS；环境层 RMS ≤ −30 dBFS；惊吓类 RMS 在 −20 到 −10 dBFS 之间；各声音时长符合上表
- [ ] 你听不到声音：报告里附上指标表，并列出「需要用户试听判断」的清单
- [ ] `tsc` 无报错

---

### Task 7：界面（HUD 与场景叠层）

**Files**
- Create：`src/ui/hud.ts`、`src/view/overlays.ts`、`src/styles.css`、`dev/ui.html`、`dev/ui.ts`

**Interfaces**
- Consumes：`Module`、`FrameCtx`、`Quality`、`CameraRig`（只用 `toScreen`）；`STRINGS`；`SCARES`；`SimEvent`、`WorldState`；`index.html` 里的 `#hud`、`#overlay`、`#stage`
- Produces：
  ```ts
  export interface HudHandlers {
    onBegin(): void;
    onRotate(dir: 1 | -1): void;
    /** 返回切换后是否静音 */
    onToggleMute(): boolean;
    /** 返回切换后的画质 */
    onToggleQuality(): Quality;
  }
  export interface Hud extends Module {
    showStart(): void;
    hideStart(): void;
    showError(msg: string): void;
    setQuality(q: Quality): void;
  }
  export function createHud(root: HTMLElement, h: HudHandlers): Hud;
  export function createOverlays(root: HTMLElement, rig: Pick<CameraRig, 'toScreen'>): Module & { setHover(id: string | null): void };
  ```

**要求**

1. **审美**：先用 Skill 工具加载 `frontend-design-2`（本项目唯一允许的审美 skill），按它的方法定方向。基调：维多利亚哥特、旧印刷品质感、克制；不要卡通万圣节（没有滴血字体、南瓜贴纸）。字体已装：`@fontsource/im-fell-english`（标题）、`@fontsource/eb-garamond`（正文）；在 `styles.css` 里 `@import '@fontsource/im-fell-english/400.css';` 这样引入
2. **开场遮罩**：全屏黑底，标题 `STRINGS.title`，`STRINGS.start.headphones`、`STRINGS.start.begin`、`STRINGS.start.hint`；遮罩元素带 `data-start` 属性（冒烟测试靠它点击）；点击任意处或按 Enter / 空格 → `onBegin()`，遮罩 0.8 秒淡出
3. **HUD**（开场后显示）：左上 `STRINGS.counter(n)`（`exit` 事件时数字有一个克制的小动画）；左下事件播报，最多 4 条，6 秒后淡出，文案用 `STRINGS.ticker.*`（名字从 `state.npcs` 里按 id 找，`exit` 事件自带 name）；右下按钮：左转、右转、静音、画质，内联 SVG 图标 + `aria-label`（`STRINGS.buttons.*`），键盘 Q / E 旋转、M 静音
4. **showError**：遮罩上显示 `STRINGS.noWebGL`
5. **场景叠层**（`overlays.ts`，挂在 `#overlay` 里，`pointer-events: none`）：
   - 每个访客头顶（`toScreen(npc.pos, 1.45)`）：名字 + 性格标注（`STRINGS.personalityTag`，空字符串就不显示）+ 恐惧条（0–100；颜色从骨白到橙 `#ff7a1a`，≥ 80 变血红）；离开的访客移除
   - 每个惊吓类物件上方（`toScreen(obj.pos, 1.2)`）：`seenBy.length > 0` 时显示一只小眼睛图标；`cooldown > 0` 时显示冷却圆环（SVG 圆，`stroke-dashoffset` 按 `cooldown / SCARES[type].cooldown`）；引诱类物件也显示冷却圆环
   - 悬停（`setHover`）：物件名（`STRINGS.propName`）+ `STRINGS.ready` 或剩余冷却秒数
   - DOM 元素复用（对象池），每帧只改 `transform: translate3d(...)` 和必要的文字
6. `prefers-reduced-motion` 时关掉非必要动画；在 390 px 宽的屏幕上不重叠、不出横向滚动条

**验证**
- [ ] `dev/ui.html` 用 harness + overlays + hud（用 `h.emit(...)` 塞事件进播报）
- [ ] 截图：开场遮罩；游戏中（播报 4 条、两个名牌、至少一个眼睛图标、一个冷却圆环、一个悬停提示）；390 × 844 竖屏一张
- [ ] `--eval` 点击 `[data-start]` 后遮罩消失
- [ ] `tsc` 无报错

---

### Task 8：集成（主会话）

**Files**：`src/main.ts`、`src/debug.ts`、`scripts/smoke.mjs`

1. `main.ts`：`createRenderCore` → 失败时 `hud.showError`；`createCameraRig`、各 view、`createAudio(pan)`、`createHud`、`createOverlays`、`createJuice`；`createWorld({ seed: Date.now() })`；主循环：`dt = min(0.1, 实际间隔)`，`events = world.step(dt)`，分发 `onEvent`，再调各模块 `update`，`rig.update`，`core.render`；`watchFrameTime` 自动降档；picker 悬停 → `props.setHover` + `overlays.setHover`，点击 → `world.trigger`；开场：`hud.showStart()`，`onBegin` 里 `audio.unlock()`、`rig.intro(2.5)`，之后才开始 `world.step`
2. `debug.ts`：`?debug` 时挂 `window.__haunt = { state(), raw(), step(ms), trigger(id), spawn(opts), rotate(dir), backend, setTimeScale(n) }`
3. `smoke.mjs`：构建 → `vite preview`（端口 5738）→ 打开 `?debug` → 点 `[data-start]` → 断言：无页面报错；画面有非黑像素；10 秒内至少 1 个访客；放一个访客到肖像前并附身后恐惧值 > 0；截图
4. 审查各任务的代码、跑全部测试、修集成问题、提交

## 自查记录

- 设计文档每一节都有对应任务：玩法 → 1、4、5、7；架构 → 契约 + 8；画面 → 2、3、4、5；声音 → 6；出错与降级 → 2（no-webgl2）、5（备用小人）、8（音频恢复、标签页隐藏）；测试 → 每个任务的验证 + 8 的冒烟
- 房屋尺寸：设计文档原写 16 × 10 米，写契约时为了让房间有 4 米进深改成 16 × 12 米（32 × 24 格），设计文档已同步
