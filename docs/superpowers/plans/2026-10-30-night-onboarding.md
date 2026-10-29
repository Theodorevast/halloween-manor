# 一夜、访客登记簿、上手 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 上线前（10/31）给一局加上开头、中段和收尾（「一夜」），加上访客登记簿，修好试玩发现的上手问题。不加目标、不计分、没有失败。

**依据：**
- 内容分析 `.superpowers/sdd/2026-10-29-wardrobe-collab-polish/content-proposal.md`（候选 1 登记簿、2 收夜、3 前门、5 墙上多一个影子）
- 试玩报告 `.superpowers/sdd/2026-10-29-wardrobe-collab-polish/ux-playtest.md`（P1-1、P1-2、P1-3、P1-6 的 a、c）
- 用户 2026-10-30 的决定：
  - 整套一夜，夜长 8 分钟
  - 中段做「墙上多一个影子」
  - 上手只做「开场和提示」「标签说实话」（不做「第一个访客固定胆小」，不做「鬼魂淡出」）

**Architecture：** 主会话已经做完接口（提交 8081474、15d28be）：
- `World.close()` / `reopen()`、`WorldOptions.openingGaps`、spawn 事件的 `last`（占位）
- `src/config/night.ts` 的 `NIGHT`、`OTHER_SHADOW`
- `STRINGS.ticker.lastCall`、`lastArrival`，`STRINGS.onboarding`、`STRINGS.register`（英文文案）
- 占位模块：`src/ui/hints.ts`、`src/ui/registerView.ts`、`src/view/frontDoor.ts`、`src/view/otherShadow.ts`
- `Hud.say`、`GhostRig.hold`（占位）

之后六路并行，每路只改自己名下的文件，各自审查后合入。

**Tech Stack：** Vite 8、TypeScript 7、three.js r186（`three/webgpu` + TSL，WebGL2 回退）、Web Audio（程序化）、vitest 5、playwright-core + 本机 Chrome

## Global Constraints

- 克制、写实，不要游戏感：
  - 不发光、不描边、不全屏闪图、不加 UI 闪烁、镜头不推近
  - 不加大号数字、百分比、评级、奖励音效
  - 文字只用小型大写、斜体、细线、透明度，和现有的播报、标签一个口气
- 灯闪任意 1 秒内最多暗 3 下（WCAG 2.3.1），用 `src/view/lightfx.ts` 的 `countDips` 按 60 Hz 数，叠加、前后接上都算。慢慢变暗（门廊灯熄）不算闪，但不能有抖动
- 不新加灯：灯的数量一变所有材质都要重编（会卡）。新网格的材质要进开场的预编译，或者标 `deferCompile`；第一次出现不能卡（合并后主会话用 `scripts/stall-outfits.mjs` 一类的探针量）
- 模拟层（`src/sim/`）是纯 TypeScript，不引用 three.js
- **机器人和平衡测试的数字不能变**：新的模拟开关默认关着（`openingGaps` 不给、不调 `close()`），只有正式游戏打开
- 英文界面文案只放 `src/config/strings.ts`，接口提交里已经写好草稿。要改措辞写进报告，不要自己改别的路会用到的那些
- 联名皮肤（`COLLAB_SPECS`）的名字、地址不能进默认构建：只放在 `character.ts` 的 `__COLLAB__` 分支里
- 中文注释、中文提交说明，风格照现有代码
- 每路结束：`./node_modules/.bin/tsc --noEmit -p .` 无错、`./node_modules/.bin/vitest run --hookTimeout=120000` 全过，再提交
- 用 `./node_modules/.bin/<工具>`，不用 `npx`
- 端口只用分给自己那一路的，用前 `netstat -ano | grep <端口>` 查，只停自己起的进程。5731 是主会话的开发服务器，不要碰
- 开发服务器：`./node_modules/.bin/vite --config .logs/vite.lane.config.ts --port <端口> --strictPort`
- 性能、冒烟测试由主会话合并后统一跑
- git：
  - 本地提交，按目录 `git add -u <目录>`（新文件 `git add <目录>`），提交前 `git diff --cached --stat` 核对
  - 不推送，不改 git 配置
  - 提交说明末尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 用 Python 改文件时 `open(p, 'w', encoding='utf-8', newline='')`（读也带 `newline=''`）

## 端口和文件归属

| 路 | 端口 | 文件 |
|---|---|---|
| NS 模拟 | 不用 | `src/sim/world.ts`、`src/sim/spawner.ts`、`src/config/visitors.ts`（只动 `NAMES`）、`tests/night.test.ts`（新）、`tests/world.test.ts`（名字池那一条） |
| RG 登记簿 | 5732 | `src/ui/register.ts`（新）、`src/ui/registerView.ts`、`src/ui/register.css`（新）、`src/view/characters.ts`（只加 `outfitOf`）、`src/config/character.ts`（只加造型的 `label`）、`dev/ui.ts`、`tests/register.test.ts`（新） |
| FD 前门 | 5733 | `src/view/frontDoor.ts`、`src/config/frontDoor.ts`（新，画面和声音共用的时刻）、`src/audio/sfx.ts`（只把前门的时刻改成读它）、`src/view/walls.ts`（只加一个只读导出）、`tests/front-door.test.ts`（新） |
| OS 墙上影子 | 5734 | `src/view/otherShadow.ts`、`src/view/ghost.ts`（只加导出）、`tests/other-shadow.test.ts`（新） |
| OB 上手 | 5735 | `src/engine/ghostRig.ts`、`src/engine/picking.ts`、`src/ui/hud.ts`、`src/ui/hints.ts`、`src/view/overlays.ts`、`src/styles.css`、`tests/hints.test.ts`（新）、`tests/overlays.test.ts` |
| NC 收夜 | 5736 | `src/night.ts`（新）、`src/main.ts`、`src/view/house.ts`（门廊灯的接口）、`src/audio/engine.ts`、`src/audio/ambience.ts`、`src/engine/cinematic.ts`、`src/debug.ts`、`scripts/smoke.mjs`、`tests/night-controller.test.ts`（新） |

别的文件不改。真需要改，先在报告里写清楚改哪一行、为什么，交给主会话合并时处理。

---

## 路 NS：模拟（开局间隔、收夜、最后一位、一夜里不重名）

1. `WorldOptions.openingGaps`：开局几个访客之间的间隔（秒；第一个仍在 `SPAWN.first`，第二个在它之后 `openingGaps[0]`，以此类推，用完了按原来的 `SPAWN.stagger`）。不给就和现在一模一样（逐步对比：同一个种子、不给时的事件序列逐个相同）
2. `World.close()`：
   - 之后不再安排新访客，已经排上、还没进门的那一次也取消
   - 调的那一刻屋里没人（都走了、或者都在逃跑），就最后再放一位进来，spawn 事件带 `last: true`；屋里有人就不放
   - 屋里的人照常闹，没有时限
3. `World.reopen()`：照常补人，和开局之后一样按 `SPAWN.delay` 一个一个来
4. 一夜里尽量不重名：`pickName` 避开的名字加上最近进来过的 24 个，仍然只抽一次随机数（同一个种子抽随机数的次数不变）。名字池 `NAMES` 扩到约 48 个，英文常见名，男女都有，不要名人
5. 测试 `tests/night.test.ts`：
   - `openingGaps` 的时刻
   - 不给时和原来完全一样
   - `close()` 以后不再进人，已排上的取消
   - `close()` 时屋里没人 → 进来一位带 `last`；屋里有人 → 不进
   - `reopen()` 以后照常补人
   - 一夜里前 24 个不重名
   - 平衡测试（`tests/balance.test.ts`）的数字和改之前逐个相同：报告里贴前后对比

## 路 RG：访客登记簿

**记录**（`src/ui/register.ts`，纯 TS，吃 `SimEvent` 和 `WorldState`，vitest 直接测）

- 每个访客一行：名字、性格标注（`STRINGS.personalityTag`）、穿哪套
  - 造型的名字：普通造型用 `STRINGS.register.outfit[id]`
  - 联名的两套用 `character.ts` 里 `COLLAB_SPECS` 自己的 `label`（只在 `__COLLAB__` 分支里）
  - 造型 id 由 `characters.ts` 新导出的 `outfitOf(npcId)` 给
- 几点进来、怎么走的：
  - 「怎么走的」= 逃跑之前最后一个让他恐惧值上涨的事件：
    - 物件的 startle → `ranFrom`（机关发作的 → `trap`）
    - 现身 drop 的 `scared` → `sawYou`
    - 后颈一凉、发毛（chill）→ `coldBreath`
    - 被别人的尖叫吓到（startle 的 object 为 null）→ `scream`
  - 还在屋里的写 `stillInside`
- 钟点：按 `NIGHT.clock`（晚 9 点到凌晨 3 点）和 `NIGHT.length` 换算成 `9:12 pm` 这种写法，过了一夜的长度以后照样往后走
- 页脚两三句，挑最有意思的：
  - `cameRan`
  - `noneSaw` / `someSaw`
  - `mostWork`：吓跑人最多的物件
  - `stayedLongest`
  - `oneMore`：`noteOtherOne` 调过时
  - 数字用英文单词写进句子（one、two … twenty，再多就用阿拉伯数字也写在句子里）

**页面**（`src/ui/registerView.ts` + `src/ui/register.css`）

- 维多利亚式访客登记的一页：
  - 沿用 `styles.css` 里的纸张、边框变量和字体（IM Fell English、EB Garamond）
  - 标题、副标题，每人一行（名字小型大写，第二行斜体），页脚散文
- 版式：宽屏两栏；390 px 单栏、可以滚；人太多时只写前面一些行，剩下的 `andOthers`
- 按钮：
  - 收夜时：Keep haunting、Another night
  - 中途翻开：Back to the manor，加一句 `notOver`
- 交互：
  - 键盘能操作，焦点可见，Esc 关（中途翻开时）
  - 减少动态时不做翻页动画
- 右下角按钮栏旁边一个小本子按钮（提示 `STRINGS.register.open`），自己的 DOM，不改 `hud.ts`：
  - 触屏直接点
  - 第三人称要先按 Esc 放开鼠标才点得到
- 不做大号数字、表格、打分、评级
- `dev/ui.ts`：用假事件（十来个访客、各种走法、联名一套）预览这一页，宽屏、390 px 各截一张

**测试** `tests/register.test.ts`：

- 每种走法的归因
- 钟点换算
- 页脚的挑法
- 重名、还在屋里
- `andOthers`

## 路 FD：看得见的前门

- 门洞里一扇门，程序化，照厨房门 `src/view/props/door.ts` 的样式、用现成的材质：
  - 绕西侧合页往屋里开约 100°，让出进门那条路（先在 `config/house.ts` 里核对前门洞和进门路线的坐标）
  - 鬼魂和镜头穿过时溶开（照 `furniture.ts`、`props.ts` 的溶开写法，在自己的模块里做）
  - 投影
- 时刻：
  - spawn 事件 → 开：两下敲门之后推开，和现有的吱呀声对上（`sfx.ts` 的前门声）
  - 先把前门声音的时刻挪进新的 `src/config/frontDoor.ts`，画面和声音读同一份，测试钉住
  - 访客走到门口之前门要开到 70° 以上
  - 附近有进门、逃跑的人就一直开着
  - exit 事件 → 和那声关门同一刻合上
  - 没人了慢慢自己合上，没有声音
  - 有人被吓跑时，在他跑到门口之前被撞开
- `openness` 读数：0 = 关上，1 = 全开（收夜检测用）
- 俯视（触屏）模式：南墙降低时门板跟着藏起来，`walls.ts` 只加一个只读导出
- 一开场就在场景里，开场的预编译就编好了
- 截图：开、关、俯视
- 测试 `tests/front-door.test.ts`：时刻对齐、开合曲线、spawn / exit 的状态

## 路 OS：墙上多一个影子（The Other One）

- 用鬼魂墙上影子（L2）的同一个办法：`ghost.ts` 的 `createGhostShadowMaterial`、只进手电阴影图的一份网格（`torches.ts` 的 `GHOST_SHADOW_LAYER`）
  - 再做一份同样的网格，给它自己的一组 uniform：不飘，不跟玩家的鬼魂
  - 主画面和月光都看不见它，只在某个访客的手电照到它时，墙上多一个兜帽人形的影子
- 站位：几个贴墙 0.3–0.6 米、不在访客走的路上的位置，比如：
  - 走廊两头
  - 卧室衣柜旁的墙角
  - 客厅壁炉边
  - 浴室进门的墙角
  - 先在 `config/house.ts` 里核对格子
- 出现的规则：
  - `OTHER_SHADOW.after` 秒以后，或者吓跑 `afterScared` 个以后，一晚最多 `max` 次
  - 只在没有手电照着那个位置的时候放上去
  - 被照到约 `litFor` 秒以后，在下一次没被照着时撤掉
  - 有访客走到 `near` 米内就提前撤
  - 静止、头微低；不闪、不发声、不出脸
  - 访客没反应
- 不能和玩家自己的鬼魂影子同时出现在同一面墙上：玩家的鬼魂被照着时不放，免得被当成自己的
- 一开场就在场景里（影子关着时着色器整个丢掉），开场第一帧画手电阴影图时管线就编好
- `appeared`、`onAppear`：给登记簿记一笔
- 截图：走廊里一个访客的手电照到它的那一刻，WebGPU、WebGL2 各一张
- 测试 `tests/other-shadow.test.ts`：出现规则（时间、次数、没被照着才放、被照过就撤、访客走近就撤）

## 路 OB：上手（开场和提示、标签说实话）

1. **开场不收输入**（试玩 P1-1 a、b）：
   - `GhostRig.hold(on)` 实现：hold 期间鼠标转向、按键移动、右键 / F 都不算；放开时视角回到开场那一刻的朝向
   - 点了开始、遮罩还挂着时，按钮上的字换成 `STRINGS.onboarding.almostLit`，不再变回 `Lighting the candles…`。`hud.ts` 的 `setReady(false)` 在已经点过开始时用这一句
   - main.ts 什么时候调 hold 由 NC 那一路接；你在报告里写清楚调法
2. **操作说明**（P1-3 a、b、c）：
   - 开场提示推迟到开场后 4–5 秒（第一个访客走过以后），停留约 10 秒
   - 垫一层很淡的黑底（取 `.ov-tip-card` 的底色，透明度约 0.5），压在光斑上也读得出；窄窗口在「·」处折行
   - 「Click to resume」那张标签下面挂一行 `STRINGS.onboarding.controlsOnPause`
3. **标签说实话**（P1-2 a）：惊吓类物件悬停标签的第二行：
   - 有人看着写 `watching` / `watchingMany`（沿用幽绿小型大写）
   - 没人看着写 `noOneWatching`（灰烬色）
   - 冷却中照旧写秒数，设了机关照旧写 `Trap set`
   - 引诱类照旧写 `Ready`
4. **情境提示**（`src/ui/hints.ts` 实现，P1-2 b、P1-4 b）：
   - 只出现一次的 `STRINGS.onboarding.hints`，每种第一次碰到时出现，停几秒淡出，和操作说明一个排法：
     - 第一次准星对准物件：`firstAim`
     - 第一次附身落空：`firstMiss`
     - 第一次有人听见引诱：`firstLure`
     - 第一次被手电照到、而且现身已就绪：`firstRevealed`
   - 附身落空：惊吓类物件 trigger 以后，到 `SCARES[type].active` 结束都没吓到人。播报栏补一行 `missed`（只在头两三次）
   - `refused(kind)`：做不到时一句很轻的回应，同一种短时间内不重复。`tooFar` 由 `picking.ts` 判断：准星对着一个物件，但够不着
5. **触屏**（P1-6 a、c）：
   - 开场按钮写 `tapToBegin`，标题页提示加 `tapHint`
   - 竖屏时一句 `turnSideways`，小型大写
6. 测试：
   - `tests/hints.test.ts`：每条提示只出现一次；落空的判断；refused 不重复
   - `tests/overlays.test.ts`：标签几种状态的文字
7. 截图：开场提示、Esc 那张、标签几种状态、一条情境提示、手机竖屏

## 路 NC：收夜（把一夜串起来）

**`src/night.ts`**（新）

- 用模拟时间 `WorldState.time` 计时
- 到 `NIGHT.length`：
  - `world.close()`
  - `hud.say(STRINGS.ticker.lastCall)`
  - 门廊灯在 `NIGHT.porchFade.seconds` 里慢慢熄（`house.ts` 加一个接口：慢变暗，不抖，不算闪）
  - 收到 spawn 事件的 `last` 时，`hud.say(lastArrival(name))`
- 收夜检测：已经 close、屋里没人、前门关上（`frontDoor.openness` 很小）
- 收夜：
  - 静 `closing.silence` 秒，环境层慢慢压下去（`audio` 加一个电平接口，不新加声音）
  - 光从屋里收回前门：开场显影反着放，`core.fx.setReveal`，`cinematic.ts` 里加反向的那一段
  - 翻开登记簿 `registerView.open({ closing: true })`
- Keep haunting：
  - 合上登记簿
  - 光重新铺开、门廊灯亮回来、环境层回来
  - `world.reopen()`
  - 一夜重新计时，下一次再到 `NIGHT.length` 再收
- Another night：`location.reload()`
- 减少动态时：反向显影、门廊灯都直接切

**`main.ts` 接线**

- 正式游戏的 `createWorld` 给 `openingGaps: NIGHT.openingGaps`
- 建前门 `createFrontDoor`、墙上影子 `createOtherShadow`、提示 `createHints`、登记簿 `createRegisterView`，放进 modules
- 登记簿翻开时放开指针锁定，合上时提示点一下继续
- `otherShadow.onAppear` → `registerView.noteOtherOne()`
- `rig.hold(true)`：从点开始到真正开场
- 做不到时调 `hints.refused`：
  - `world.manifest()` 返回 false：按状态分冷却中 / 在墙里
  - `world.arm()` 返回 false：机关满了
- 触屏、俯视模式也要能收夜、翻登记簿

**调试和测试**

- `debug.ts`：`?night=<分钟>` 改夜长，`__haunt.endNight()` 立刻收夜
- `scripts/smoke.mjs` 加三项：
  - 收夜以后登记簿翻开
  - Keep haunting 以后又有人进门
  - 前门在有人进门时开
- 测试 `tests/night-controller.test.ts`：一夜的状态机，纯逻辑抽出来测
  - 到点 close
  - 最后一位
  - 收夜条件
  - Keep haunting 重新计时
  - 门廊灯渐变不算闪：`countDips`
