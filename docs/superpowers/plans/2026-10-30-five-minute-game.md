# 5 分钟的完整一局：光影、粒子、镜头、范围显示、反馈 实施计划（第二波）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 用户 2026-10-30 离开 8 小时前的要求：「做一个 5 分钟内能玩完的完整游戏，有细节（画面，包括光影、粒子等）和乐趣（审美、镜头、范围显示、有效反馈）」。
第一波（`docs/superpowers/plans/2026-10-30-night-onboarding.md`）给一局加了开头、中段、收夜、天亮、登记簿和上手；这一波补画面和手感。

**依据（实现的人先读自己那一节点名的段落，数值照抄）：**
- 美术总监的分析 `.superpowers/sdd/2026-10-30-five-minute-game/art-direction.md`（ART-1 … ART-10，带机位、数值、验收；截图和量图脚本在 `shots-art/`）
- 手感设计的分析 `.superpowers/sdd/2026-10-30-five-minute-game/feel-and-feedback.md`（镜头、范围显示、反馈；第二部分的几路按它写）
- 共用背景 `.superpowers/sdd/2026-10-30-five-minute-game/analysis-context.md`

**Architecture：** 每路一个 worktree（`C:\Users\MSI\Desktop\万圣节-lanes\<路>`，分支 `feat/fmg-lane-<路>`），只改自己名下的文件，各自审查后合进 `feat/night-onboarding`。

**Tech Stack：** Vite 8、TypeScript 7、three.js r186（`three/webgpu` + TSL，WebGL2 回退）、Web Audio（程序化）、vitest 5、playwright-core + 本机 Chrome

## Global Constraints

- 克制、写实，不要游戏感：不加发光描边、色差、全屏闪、漂浮数字、漫画符号、弹跳的奖励提示、大调「叮」声；泛光不能糊一片。用户以前从 12 个选项里只挑了：镜头轻推近、受惊跳得更大、缩着走、地面雾
- 灯闪任意 1 秒内最多暗 3 下（WCAG 2.3.1），用 `src/view/lightfx.ts` 的 `countDips` 按 60 Hz 数，叠加、前后接上都算；慢变化不能有抖动
- 不新加灯（灯的数量一变所有材质都要重编，会卡）。改已有灯的颜色强度、uniform 可以。新材质、新网格要进开场的 `precompileAll`，或者标 `deferCompile`；第一次出现不能卡
- 性能：`node scripts/perf.mjs`（High）、`--low`、`--cpu` 都要量，High 和 Low 本机 60 fps；`--cpu` 比改之前慢不超过 10%。WebGPU 和 WebGL2（`?webgl`）都要能跑、都截图；手机（俯视、触屏）要能玩
- 模拟层（`src/sim/`）是纯 TypeScript，不引用 three.js；机器人和平衡测试（`tests/balance.test.ts`）的数字不能变（新的模拟开关默认关）
- 英文界面文案只放 `src/config/strings.ts`；要新文案写进报告，主会话统一加
- 联名皮肤（`COLLAB_SPECS`）的名字、地址不能进默认构建
- 不花钱：不调用生成模型、不买素材
- 中文注释、中文提交说明，风格照现有代码；用 `./node_modules/.bin/<工具>`，不用 `npx`
- 每路结束：`./node_modules/.bin/tsc --noEmit -p .` 无错、`./node_modules/.bin/vitest run --hookTimeout=120000` 全过，再提交

---

## 文件归属（第一部分：画面三路）

| 路 | 端口 | 文件 |
|---|---|---|
| LT 光 | 5732 | 新 `src/view/bounce.ts`；`src/view/walls.ts`；`src/view/house.ts`；`src/view/flashlight.ts`（只加 `wallDistance` 的导出）；`src/view/fog.ts`（只加 `fogSky` 和 `update` 里那两行）；`src/night.ts`（只改 `NIGHT_FX.dawnLight`）；测试 `tests/bounce.test.ts`（新）、`tests/night-controller.test.ts`（只加天亮单调那条） |
| PX 后处理 | 5733 | `src/engine/postfx.ts`；`src/view/props/lamp.ts`（只改灯泡亮度那一处）；`src/view/flashlight.ts`（只改镜片亮度那两处）；`src/view/particles/breath.ts`；测试按需新建 |
| GF 鬼魂和雾 | 5734 | `src/view/ghost.ts`；`src/view/fog.ts`（除了 LT 那两处）；测试按需新建 |

别的文件不改。真需要改，先在报告里写清楚改哪一行、为什么，交给主会话合并时处理。

## 路 LT：光（ART-1、ART-2、ART-5 的墙那一半、ART-9）

照 `art-direction.md` 的做法、数值、验收做，顺序：
1. **ART-1 手电的反弹光**（P0）。全照报告做。另外：
   - 落点的计算（`updateBounce` 里从手电位置、方向、射程算出落点和所在房间）写成纯函数，`tests/bounce.test.ts` 测：落在地板上、落在墙上（往回退 `pullBack`）、手电关着、离镜头超过 7 米、落在门洞里时用手电自己的房间
   - 「不漏到隔壁」要截图验收（报告里的机位）
2. **ART-2 天亮看得见**（P0）。全照报告做（`skyGlass`、`fogSky`、`DAWN` 的新值、屋外底色、`NIGHT_FX.dawnLight` 30 秒、收夜时灯笼留 0.06）。`GRADE.shadowTint` 那一项**不做**。
   `tests/night-controller.test.ts` 加一条：天亮的玻璃倍数、屋外底色随 k 单调
3. **ART-5 的墙那一半**：`walls.ts` 的 `applyDissolve` 里 `d.rim` 乘侧看收掉的那一项（物件的幽光那一半归第二部分「瞄准」那一路，这一路不碰 `props.ts`、`kit.ts`）
4. **ART-9 做旧**（P2）：前三项做完、量过 perf 还有余量才做；High、Low 任一掉到 60 fps 以下就不做，在报告里写明量到的数字

截图机位、量图脚本：`.superpowers/sdd/2026-10-30-five-minute-game/shots-art/`（`shoot*.mjs`、`region.mjs`、`metrics.mjs`）。改之前、改之后同一机位各截一张，WebGL2 也截一张。

## 路 PX：后处理和粒子（ART-4、ART-7、ART-8）

照 `art-direction.md` 的做法、数值、验收做：
1. **ART-4 让 AO 看得见**：只改 `postfx.ts`；注意报告里说的「雾和鬼魂在墙角会跟着暗」，验收截图要看墙根的雾还在
2. **ART-7 收紧泛光**：`postfx.ts` 的 `BLOOM`、台灯泡、手电镜片
3. **ART-8 白气**：只改 `particles/breath.ts` 的数
每一项改之前、改之后同一机位各截一张；perf 三种都量。纯数值的改动不强求新测试，但已有测试要全过；如果某项能写成可测的函数（比如 AO 的保护曲线），就写测试。

## 路 GF：鬼魂和雾（ART-3、ART-6、ART-10）

照 `art-direction.md` 的做法、数值、验收做：
1. **ART-3 粉红光盘**（P0）：`torchReveal`、`torchRevealAt` 加近处淡出，暖色改成近中性。`torchRevealAt` 是 CPU 那份，测试要覆盖「近处淡出」（0.5 米以内为 0、1.4 米以外不变）
2. **ART-6 现身推开地面雾、长袍受光面亮一点**：`fog.ts` 的 `startDraftAt` 和 `onEvent`；用 `countDips` 查雾的亮度曲线不多出一下（写成测试）
3. **ART-10 娃娃屋屋外的雾压淡**
依赖：OS 路（墙上影子，只改了 `ghost.ts` 的一个导出）合并以后从最新的 `feat/night-onboarding` 开出。

---

## 第二部分：镜头、范围显示、反馈（按手感设计的分析 `feel-and-feedback.md`）

主会话的取舍：FEEL-1 … FEEL-8、FEEL-10、FEEL-11 都做；FEEL-9（收尾时吊臂拉远）留到最后一轮有余量再做。「不建议做的」十条照它的理由不做（镜头不推近、不自动转向、范围不常挂、不用访客的手电标范围……）。
为了不让两路改同一个文件，几条并进第一部分已经在跑的路：

| 加给 | 内容 | 文件 |
|---|---|---|
| LT 光 | FEEL-4 墙后的镜头（靠镜头那半段吊臂上、隔开镜头和鬼魂的墙整片溶开）；做完 ART-1、ART-2、ART-5 以后、ART-9 之前 | `src/view/walls.ts` 的 `dissolveAt`、`DISSOLVE.sight` |
| GF 鬼魂和雾 | FEEL-5 鬼魂挡住访客时自己淡下去 | `src/view/ghost.ts`（`GHOST.occlude`、写 `u.fade` 那里） |
| PX 后处理 | FEEL-8 贴近发毛时访客呼出白气（只改「什么时候呼气」，样子归 ART-8） | `src/view/particles/breath.ts` |

新开两路：

| 路 | 端口 | 文件 |
|---|---|---|
| AF 瞄准和反馈 | 5735 | 新 `src/sim/reach.ts`；`src/view/overlays.ts`；`src/styles.css`；`src/config/strings.ts`（只加 `outcome`、`names`）；`src/ui/hud.ts`；`src/engine/picking.ts`；`src/engine/ghostRig.ts`（只加 `GhostUi.aimFar`）；`src/view/props.ts`、`src/view/props/kit.ts`（ART-5 的物件那一半）；测试 新 `tests/reach.test.ts`、`tests/overlays.test.ts`、`tests/hints.test.ts` |
| RF 范围霜线 | 5736 | 新 `src/view/rangeFrost.ts`；`src/main.ts`（只加它的接线）；测试 新 `tests/range-mask.test.ts` |

## 路 AF：瞄准和反馈（FEEL-1、FEEL-3、FEEL-6、FEEL-7、FEEL-10、ART-5 的物件那一半）

照 `feel-and-feedback.md` 的做法、数值、验收做（ART-5 照 `art-direction.md`），顺序：
1. **FEEL-1 名牌上的小眼睛**（P0）：`src/sim/reach.ts` 纯函数和规则照搬结算；`tests/reach.test.ts` 的一致性测试；机器人和平衡数字不能变（模拟只加只读函数）
2. **FEEL-3 结果写在准星对着的地方**（P0）：`STRINGS.outcome`、`STRINGS.names` 加进 `strings.ts`（`names` 是纯函数：Theo / Theo and Mia / Theo, Mia and Sam / Theo, Mia and 2 others），测试覆盖
3. **FEEL-7 够不着时也有回应**
4. **FEEL-6 播报的合并和挤出顺序**（纯函数 + 单测）
5. **ART-5 的物件那一半**：`props/kit.ts` 的 `createGlow` 朝向和 `props.ts` 的 `GLOW` 第三人称数值（娃娃屋不变）；悬停的物件仍然一眼看得出（截图）。墙那一半归 LT
6. **FEEL-10 恐惧条**
名牌记号、结果、够不着三者在同一个标签 / 名牌上，做完一起截图看一遍：一眼读得懂、不吵。

## 路 RF：范围霜线（FEEL-2、FEEL-11）

照 `feel-and-feedback.md` 的做法、数值、验收做：
1. **FEEL-2 地上的范围霜线**（P0）：新模块 `rangeFrost.ts`；范围掩码的计算（二值图 + 有符号距离）写成纯函数，`tests/range-mask.test.ts` 测和 `canSee` / `canHear` / `facesToward` 一致；材质 `deferCompile`，第一次瞄准不卡（量）；`main.ts` 只加接线（`picker.onHover` → `rangeFrost.show(id)`，模块进 modules）。够不着的物件（4–10 米，AF 路的 FEEL-7）不画线：AF 还没合并时先按 `picking.ts` 现有的「够得着」判断
2. **FEEL-11 现身冷却好了，脚下的霜往外呼一次**（P2）：第 1 项做完、量过再做
