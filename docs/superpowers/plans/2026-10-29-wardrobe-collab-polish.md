# 衣柜、联名皮肤、新鬼魂、上线前打磨 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 10/30 上午看样前做完：衣柜（设计文档 4.3 的 A 版）、灯闪合规（每秒不超过 3 下）、访客造型边玩边加载、几处健壮性小修；联名皮肤（翠宝穿承太郎、DIO 的衣服）和新的主角鬼魂模型先出图给用户挑，挑好再做 3D。

**Architecture：** 主会话已经做完接口（提交 3511955：`ScareType` 加 `'wardrobe'`、`config/scares.ts` 的 `WARDROBE` 时间轴、trigger 事件带 `variant`、衣柜占位物件、机器人暂时不用衣柜）。之后八路并行，每路只改自己名下的文件，各自审查后合入，最后主会话接线、跑全部测试。

**Tech Stack：** Vite 8、TypeScript 7、three.js r186（`three/webgpu` + TSL，自动退回 WebGL2）、Web Audio（全部程序化合成）、vitest 5、playwright-core + 本机 Chrome、Tripo API（`scripts/tripo/`）、Blender 5.2 无头（`scripts/blender/`）、公司素材中台 `vmc`

依据：`docs/superpowers/specs/2026-10-28-manifest-ai-props-design.md`（4.3 衣柜、1 范围）、`docs/research/2026-10-28-horror-visual-language.md`（3.3 衣柜）、`docs/superpowers/reviews/2026-10-29-manifest-ai-props-final-review.md`（延后的小问题）、`docs/superpowers/specs/2026-10-30-preview-checklist.md`

## Global Constraints

- 克制、写实，不要游戏感：不发光、不描边、不全屏闪图、不加 UI 闪烁；镜头不推近
- 声音：不用大调、和弦进行、上行音阶、「叮」；恐怖用低持续音、小二度不和谐、低频冲击（braam）
- 灯闪任意 1 秒内最多暗 3 下（WCAG 2.3.1），用 `src/view/lightfx.ts` 的 `countDips` / `dipStarts` 按 60 Hz 采样来数
- 吉祥物不见血；床、衣柜不露出身体部位（衣柜 A 版的几根手指除外，看不见手后面连着什么）、不出现脸
- 不新加灯：灯的数量一变所有材质都要重编（会卡）。借现有的灯
- 模拟层（`src/sim/`）是纯 TypeScript，不引用 three.js；画面、声音只读 `WorldState`、订阅 `SimEvent`
- 中文注释、中文提交说明，风格照现有代码；英文界面文案只放 `src/config/strings.ts`
- 每个任务结束：`./node_modules/.bin/tsc --noEmit -p .` 无错、`./node_modules/.bin/vitest run` 全过，再提交
- 用 `./node_modules/.bin/<工具>`，不用 `npx`；日志放 `.logs/`；端口只用分给自己那一路的（下表），用前 `netstat -ano | grep <端口>` 查，只停自己起的进程。主工作区的 5731 是主会话的开发服务器，不要碰
- 开发服务器：`./node_modules/.bin/vite --config .logs/vite.lane.config.ts --port <端口> --strictPort`（依赖缓存放各自的 `.vite-lane`）
- 性能（`scripts/perf.mjs`）、冷启动、冒烟测试（`scripts/smoke.mjs`，占 5738）由主会话合并后统一跑：这台机器上同时开着很多浏览器，各路自己量的数不准。各路只截图、跑自己的探针
- git：本地提交，按目录 `git add -u <目录>`（新文件 `git add <目录>`），提交前 `git diff --cached --stat` 核对（工具输出里路径名可能显示成别的名字，按路径 add 会静悄悄地什么都没加上）；不推送；不改 git 配置
- 用 Python 改文件时 `open(p, 'w', encoding='utf-8', newline='')`（读也带 `newline=''`），否则 Windows 会把整份文件换成 CRLF
- 提交说明末尾：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`（不是 Opus 的模型写自己的名字）
- Tripo：这一轮用户批准一共 600 积分：K 路最多 530，G 路最多 70。每一步先 `--dry-run` 看积分，会超就停下报告。key 只在 `.env.local`：不打印、不读出来、不写进日志和提交
- 素材中台 `vmc`：只能跑主会话给出的、用户已经确认过的完整命令（带 `--yes`）；自己只能 `--dry-run`。不读 `~/.config/vmc/credentials.json`
- 联名皮肤（JOJO）：授权确认之前只在地址带 `?collab` 时出现，不进公开的访客轮换。用户给的几张参考图是别人画的同人图，不喂给任何生成模型、不复制进项目

## 端口和文件归属

| 路 | 端口 | 文件 |
|---|---|---|
| W 衣柜画面 | 5732 | `src/view/props/wardrobe.ts`、`src/view/props/kit.ts`、`src/view/props.ts`、`src/view/furniture.ts`、`src/view/particles.ts`、`dev/props.ts`、`tests/wardrobe-view.test.ts`（新） |
| A 衣柜声音 | 5733 | `src/audio/sfx.ts`、`dev/audio.ts`、`tests/wardrobe-audio.test.ts`（新） |
| Q1 模拟 | 不用 | `src/sim/*`、`src/config/scares.ts`（只改衣柜那一行）、`src/config/visitors.ts`（要改先在报告里写理由）、`tests/` 下模拟相关的测试、`tests/bots.ts`、`tests/balance.test.ts` |
| F 灯闪 | 5734 | `src/view/props/lamp.ts`、`src/view/flashlight.ts`、`tests/flicker.test.ts`（新） |
| L 加载 | 5735、5736 | `src/view/characters.ts`、`src/main.ts`（只动加载、开场那部分）、`index.html`、`scripts/loadtime.mjs`（新） |
| Q2 小修 | 5737 | `src/audio/engine.ts`、`src/audio/breath.ts`、`src/engine/picking.ts`、`src/view/overlays.ts`（`GHOST_MARK_Y` 已由主会话改好）、`src/styles.css`、`tests/picking.test.ts`、`tests/audio.test.ts` |
| K 联名皮肤 | 5739 | `scripts/tripo/visitors.json`（加两个访客）、`assets-src/visitors/<新 id>/`、`public/assets/visitors/`（新 GLB、`manifest.json`）、`src/config/character.ts` |
| G 新鬼魂 | 5738 | `src/view/ghost.ts`、`src/config/ghost.ts`、`dev/ghost.ts`、`scripts/tripo/ghost.mjs`（新）、`scripts/blender/ghost_cleanup.py`（新）、`public/assets/ghost/`（新）、`assets-src/ghost/`（新） |

别的文件不改。真需要改，先在报告里写清楚改哪一行、为什么，交给主会话合并时处理。

---

## 路 W：衣柜的画面（A 版「被从里面拉上」）

照调研 3.3 的 A 版和 `src/config/scares.ts` 的 `WARDROBE` 时间轴（画面和声音都读它，不要自己再写一份数）。

- 柜体留在 `furniture.ts`，但不再画门；两扇门、门里的东西都在 `props/wardrobe.ts`（换掉现在的占位）。衣柜朝南，物件局部坐标就是房屋坐标的偏移（原点在衣柜正中，正面 +z）
- 开的是 +x 那一扇（绕它外侧的合页转），另一扇一直关着
- `latch`：门板轻轻一震（像从里面推了一下），还没开
- `open`：0 → `WARDROBE.openDeg` 度，先快后慢，到了就停死，不回弹、不晃
- 门里：内壁是「吃光的黑」（调研 S3：不受光的纯黑，手电照进去只照亮边缘），挂着两三件外套（布料、受光），其中一件在 `hold` 里轻轻晃一下
- 手指：trigger 事件的 `variant < WARDROBE.fingersChance` 时，在 `WARDROBE.fingers` 时段里三四根苍白的手指从门缝里扶住门边，合上时缩回去。普通受光的材质，不发光；看不见手后面连着什么
- `slamAt`：门在 `slamTime` 秒里猛地合上，硬停（整只柜子可以震一下，2 毫米以内）；柜顶落灰。灰用 `particles.ts` 现有的扬灰：顺手把床、肖像、衣柜三处的扬灰整理成一张表（最终审查 P-6）
- `PropRig.trigger(state)` 改成 `trigger(state, e)`（`e` 是那个 trigger 事件），所有物件照改，别的物件不用 `e`
- 其余照现有物件的规矩：幽光外壳、机关的霜外壳、鬼魂穿过时溶开、悬停不放大（`NO_HOVER_SCALE` 已含衣柜）、不常出现的材质标 `deferCompile`、High / Low 两档、`dispose`
- `dev/props.ts`：按 9 附身衣柜；`?focus=wardrobe` 能对准；加一个参数强制手指那个变体（比如 `&fingers`）
- 测试 `tests/wardrobe-view.test.ts`：门的角度曲线（各时段的关键时刻、开到头不超过 `openDeg`、停住时不动、合上后是 0）；手指变体只看 `variant`
- 截图（`shots/wardrobe/`）：手电照着（`?torch=…&ambient=0.25`）的 0.2、1.0、1.9（手指那一版也要一张）、2.25、3.0 秒；WebGL2 一张（`?webgl`）
- 不做：B 版（柜顶的剪影、手电抬高）、发光、脸、尖叫、扑出来

## 路 A：衣柜的声音

`src/audio/sfx.ts` 里写 `wardrobe` 这个 `SfxFn`，换掉 `TRIGGER` 里借的 `door`。时间轴读 `config/scares.ts` 的 `WARDROBE`，不抄数：

- `latch` 时段：锁舌「咔哒」（短、低通，不能像「叮」），接一下门板被推的闷响
- `open` 时段：一声长长的合页吱呀，跟着开门先快后慢（可以借现有的嘎吱合成）
- `hold`：没有声音
- `slamAt`：门板的闷响 + 锁舌 + 低频冲击（和床的 `BED_HIT` 一个分量，不比现有的物件响）；之后一点点落灰的「嘶」
- 用 `LEVEL` 表里新的一档；3D 位置用已有的 `placeAt`（`SOURCE_Y.wardrobe` 已经是 1.1）
- `dev/audio.ts`：衣柜的试听按钮（单发，和上一轮加的单发按钮一样的写法）；顺手修最终审查 U M-11 的两处：`sfx.ts` `trapArm` 里 `at` 被遮蔽，`dev/audio.ts` 写死的 `nervous: fear >= 60` 改用 `FEAR.nervous`
- 测试 `tests/wardrobe-audio.test.ts`：几个声音的时刻和 `WARDROBE` 对齐（锁舌在 `latch` 里、吱呀覆盖 `open`、`hold` 里没有新声音、闷响和低频冲击在 `slamAt` ±0.02 秒）
- 用 `dev/audio.html` 的离线渲染（Render all offline）量峰值、响度，和床、肖像比，写进报告

## 路 Q1：模拟（衣柜的数值、几处小修）

1. 让机器人用衣柜：去掉 `tests/bots.ts` 的 `UNTUNED`、`tests/balance.test.ts` 里 `SIGHT_PROPS` 对衣柜的排除；机关机器人的 `TRAP_TYPES` 加衣柜（背后型）
2. 按机器人调 `SCARES.wardrobe` 的 `range`、`fear`、`cooldown`、`active`（`hitAt` 保持 `WARDROBE.slamAt`），所有平衡测试照过，目标 6 对衣柜也成立（≥ 85% 的附身吓到人），其余几条的余量不比调之前差。报告里给调前、调后的平衡数字表
3. 最终审查延后的模拟小修：
   - S M3：`types.ts` 的 trap 事件注释写明「附身让机关作废时不发事件，状态以 `state.armed` 为准」
   - S M4：`fireTrap` 里 `triggerObject` 失败时清掉 `armed`、发 `trap expired`
   - S M5：机器人把机关的惊吓记到之前落空的那次附身头上，改对
   - S M6：补测试：停留期间走进视线的人被定住（speed 为 0），到 end 那一步放开
   - S M7(a)：进门途中、警觉中被现身吓到后退的人，退完接着去原来的目标
   - S M9：「吓多少」测试的容差改成相对的（2%）
   - S R1：补测试钉住全局 0.9 秒去抖：第一次穿墙后 0.5 秒才走进范围的人，在离第一次不到 0.9 秒的第二次翻转时不察觉
   - S R3：补测试：涨了正数的「听见」（引诱声、尖叫传染）照样让回落重新计时
- 不动：`MANIFEST.fear`、`GHOST.hearFear`、照到鬼魂的察觉冷却（S M8）：这三条等用户看样时定

## 路 F：灯闪不超过每秒 3 下

1. 附身台灯（`src/view/props/lamp.ts`）：设计「有空就做」里的「灯闪节奏表套到现有台灯上」：照 `lightfx.ts` 的写法用一串字母（每秒 `LIGHTFX.rate` 个）定节奏，导出的 `LAMP_FLICKER` 由它推出来，格式不变（`[开始秒, 亮度][]`，`sfx.ts` 按它放噼啪，不能改形状），`FLICKER_END` 仍是 1.2 秒。任意 1 秒最多暗 3 下；像坏灯泡：不规则，最后冲高一下再熄灭（熄灭之后是 broken，不算闪）；闪的过程里不全灭。亮暗的变化加钨丝的热惯性（`lightfx.ts` 的 `thermal`）。`LAMP_RELIGHT` 也查一遍
2. 访客紧张时的手电（`src/view/flashlight.ts` 的 `TORCH.nervous`）：100 个种子 × 30 秒，任意 1 秒最多暗 3 下（现在 0.22 时最多 4–5 下）。调小强度，或者换成节奏表
3. 地址带 `?oldflicker` 时两处都用旧的（看样时对比用；在 node 里跑测试时没有 `location`，要判断）
4. 顺手修最终审查的 V-M4（手电镜片跟着 `torchDim` 一起暗）、V-M5（手电多于 `TORCH_COUNT` 支、槽位回绕时 `console.warn` 一次）
5. 测试 `tests/flicker.test.ts`：新的台灯表、复原表、紧张手电（多种子）都不超过每秒 3 下；旧的确实超过（说明为什么改）；`LAMP_FLICKER` 的形状和 `sfx.ts` 能读出至少一声噼啪
6. 截图或录几帧亮度曲线对比新旧（写进报告）

## 路 L：开场更快（访客造型边玩边加载）

上线后玩家是从网上下载：访客模型一共 7.39 MB，现在要全部下载完、编完，开场按钮才可用。

1. 先量：`vite build --outDir .logs/dist-L`，在 5736 起 preview；Chrome 用 CDP 的 `Network.emulateNetworkConditions` 限速（50 Mbps / 20 ms、10 Mbps / 40 ms、4 Mbps / 80 ms），量开场按钮可用的时间和各类资源的字节数，每档 3 次。写成 `scripts/loadtime.mjs`
2. 改：开场按钮只等第一个访客要穿的那套造型（加上房子等原来就要的）；其余几套在开场按钮可用之后后台下载，编好管线以后才进入轮换（沿用 `characters.ts` 现有的 `stageOutfits` / `useAllOutfits` / 可用造型那一套）。在那之前进门的访客只穿已经能用的造型
3. 不能退步：第一个访客进门、后面几套造型加入轮换时都不卡（自己写探针：照 `.logs/stall-natural-wait12.mjs` 的写法，改成你的端口；那份脚本连的是主会话的 5731，不要直接用）；没有页面报错
4. 有用的话给第一套造型加 `<link rel="preload">`（量了再说）
5. 不重新压缩模型、贴图（会改画面）；觉得值得做的写进报告
6. 报告：改前、改后三档网速的时间表

## 路 Q2：几处小修（声音引擎、拾取、标记）

最终审查延后的：
- U M-1：现身落下时冲击让路的条件改成「这一批真的放了 braam」
- U M-2：AudioContext 不在 running 时，reveal 的 on / off 照样记账（只是不出声），不再丢事件
- U M-6：喘气和 `space.update` 不再共用一个 guard
- P-2：`picking.ts` 的 tick 先排下一帧，再发回调
- P-3：按住多久按事件的时间戳算，卡一帧不会把点一下读成按住
- P-4：补 DOM 接线的测试（假画布派发 pointerdown / pointerup / contextmenu）
- P-5：空心眼睛的颜色、滤镜、变换改成 `styles.css` 里的 `.ov-mark.is-armed .ov-eye`，不用行内样式
- 每条有测试的补测试；改动前后的行为写进报告

## 路 K：联名皮肤（翠宝穿承太郎、DIO 的衣服）

分两段做，中间要用户看图：

**第一段（现在）：只出换装草图**
1. `scripts/tripo/visitors.json` 加两个访客 `jotaro`、`dio`（`status: draft`）。服装用文字写，不用用户给的同人图：
   - jotaro：深藏青的学生帽（帽檐后沿和帽子连成一片、略带撕裂感），帽前有一条金链、一个金色的手形小徽章和一颗圆金扣；高领的深藏青长外套（敞着前襟，球身正面的 logo 露在外面），左边领口垂一条粗金链；腰间一条带扣的皮带
   - dio：亮黄色的短外套（短到球身中间、袖口和领口有深色滚边），球顶戴一个绿色的心形头箍，绿色的绑带；不拿路牌
   - 这两套的 `costume.promptTemplate` 用 overrides 覆盖：保留原模板里「还是同一个吉祥物」的那些要求（黑色球身、正面 logo 看得见、半透明灰色手臂、黄色球鞋、没有脸、T 字站姿、浅灰背景、手里不拿东西），去掉「维多利亚哥特、灰暗颜色」那句，换成「照原作的配色，做工像搪胶玩具的配件」
2. `--dry-run` 看积分，再 `--run jotaro,dio --yes` 只做到换装图（草稿）。每套最多出两次（第二次要换说法），这一段最多花 40 积分
3. 停下，报告：两套草图的路径、花了多少积分、你觉得哪里不对。不往下做 3D

**第二段（主会话把用户挑好的图和修手的命令发给你之后）**：修手（主会话给的 vmc 命令）→ 挑图存成 `touchup.png` → `status: approved` → 四视图、建模、绑骨、动作（两批 8 个，和现有四套一样）、导出（Blender 精修，照现有四套的参数，有问题再调）→ `dev/characters.html?visitor=<id>` 的 `__chars.calibrate()` 量朝向和步频 → `src/config/character.ts` 加 `COLLAB_SPECS`，只在地址带 `?collab` 时并进 `VISITOR_SPECS`（node 里没有 `location`，要判断）→ 截图（四个方向、走、跑、受惊）。两段合计最多 530 积分

## 路 G：主角鬼魂的新模型（更精致的兜帽人形）

**第一段（现在）**
1. 先修最终审查的 V-M1：「实」的那份写深度，停留时身后的冷雾不再画到它上面（换成网格模型之前必须修）。改前、改后各截一张（`dev/ghost.html?manifest`）
2. 出四张概念图：写 `scripts/tripo/ghost.mjs`（用 `scripts/tripo/client.mjs`，状态记在 `assets-src/ghost/` 下自己的文件里，不碰 `assets-src/tripo-state.json`），Tripo 文生图（`seedream_v5`，每张 5 积分）。方向：高瘦的兜帽人形幽灵，厚重的长斗篷、深兜帽把脸完全藏住（没有脸），手藏在长袖里贴着身体，下摆破成一条条的（像烟），站直、头微微低着，全身、正面偏一点、浅灰背景、哑光、不发光、写实克制，不要卡通床单鬼。这一段最多 20 积分
3. 停下，报告四张图的路径

**第二段（主会话把用户挑的那张发给你之后）**：图生模型（H3.1 + smart low poly，或者更便宜的不带贴图的，先 `--dry-run`；鬼魂用自己的材质，贴图用不上），两段合计最多 70 积分 → `scripts/blender/ghost_cleanup.py`（居中、去掉地面和碎块、一个网格、≤ 8000 三角面、法线朝外）→ `public/assets/ghost/ghost.glb` → `config/ghost.ts` 的 `GHOST_MODEL.url` 指过去（`?procghost` 回到程序化的人形）→ 看被照出、变实、抬头（顶点按高度转，静态模型也有）、墙上的影子、穿墙溶开都正常；截图和程序化的人形对比
