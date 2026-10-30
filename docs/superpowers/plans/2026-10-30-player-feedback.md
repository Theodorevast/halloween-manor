# 用户试玩之后的一轮（鬼魂、说明、人数、更吓人、严格玩家挑的毛病）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal：** 用户 2026-10-30 亲自试玩后说：鬼魂太透明、老以为它朝着自己；F 没有任何提示，要有游戏说明；NPC 太少；不够吓人（平面上可以放真正的恐怖图片）。再加上三位「严格玩家」挑出的毛病（`.superpowers/sdd/2026-10-30-strict-player/summary.md` 和同目录 `newbie.md`、`critic.md`、`eye.md`）。

**用户已定：** 屋里同时最多 4 人；JOJO 联名默认进轮换、公开构建也带（主会话已改，d419271）；恐怖图片用 GPT Image 2.5 sunburst 生成 9 张（主会话在生成，图到了交给 IMG 那一路）；其余照主会话的方案（下面各路）。

**Architecture：** 每路一个 worktree（`C:\Users\MSI\Desktop\万圣节-lanes\<路>`，分支 `feat/pf-lane-<路>`），只改自己名下的文件，各自审查后合进 `feat/night-onboarding`。

## Global Constraints

- 用户这次明确要**更吓人**；但仍然不要游戏 UI 味：不加发光描边、漂浮数字、漫画符号、弹跳的奖励提示、大调「叮」声、整屏饱和色闪
- 灯闪任意 1 秒内最多暗 3 下（`src/view/lightfx.ts` 的 `countDips`，60 Hz，叠加、前后接上都算）；整屏的明暗、颜色脉冲也按这个口径
- 不新加灯（灯的数量一变所有材质都要重编，会卡）；新材质、新网格进开场的 `precompileAll` 或者标 `deferCompile`，第一次出现不能卡
- 性能：`node scripts/perf.mjs`（High）、`--low` 本机 60 fps（**perf.mjs、smoke.mjs 的端口写死 5738：复制一份到自己的 `.logs/`、改成自己的端口 + 100 再量**）；WebGPU 和 WebGL2（`?webgl`）都要能跑；手机（娃娃屋、触屏）要能玩
- `src/sim/` 是纯 TypeScript，不引用 three.js；改模拟规则要有意为之：机器人和平衡测试（`tests/balance.test.ts`）的数字会变的，在报告里贴前后对比、说明为什么
- 英文界面文案只放 `src/config/strings.ts`
- 中文注释、中文提交说明；用 `./node_modules/.bin/<工具>`，不用 `npx`
- 每路结束：`./node_modules/.bin/tsc --noEmit -p .` 无错、`./node_modules/.bin/vitest run --hookTimeout=120000` 全过，再提交

---

## 文件归属

| 路 | 端口 | 文件 |
|---|---|---|
| GH 鬼魂 | 5732 | `src/view/ghost.ts`、`src/config/ghost.ts`、测试 |
| HT 说明和开局 | 5733 | `src/ui/hud.ts`、`src/ui/hints.ts`、`src/view/overlays.ts`、`src/styles.css`、`src/config/strings.ts`（onboarding、title 这几段）、`src/main.ts`（只为开局等待和按钮进度）、测试 |
| GP 玩法 | 5734 | `src/sim/*`、`src/config/visitors.ts`、`src/config/night.ts`（只改 NIGHT 的开局间隔）、`src/ui/register.ts`、`src/ui/registerView.ts`、`src/config/strings.ts`（register 那一段）、`tests/balance.test.ts` 和别的 sim 测试 |
| VX 画面 | 5735 | `src/engine/juice.ts`、`src/engine/postfx.ts`、`src/view/walls.ts`、`src/view/house.ts`、`src/view/flashlight.ts`、`src/view/palette.ts`、测试 |
| CU 镜头和标记 | 5736 | `src/engine/ghostRig.ts`、`src/engine/camera.ts`、`src/view/rangeFrost.ts`、`src/view/props.ts`、`src/view/props/kit.ts`、测试 |
| IMG 恐怖画 | 5737 | `src/view/props/portrait.ts`、`src/view/props/mirror.ts`、新 `src/view/paintings.ts`、`src/config/house.ts`（只加挂画的位置）、`public/assets/paintings/`、`src/main.ts`（只加挂画模块的接线） |

## 路 GH：鬼魂看得清、朝向一眼看出

1. 平时的不透明度提高（`GHOST` 的 `minAlpha` 一类，用户：「太透明」）；挡住访客时淡到约 0.6（`GHOST.occlude.alpha` 现在 0.35），实体 / 被照着时照比例上调
2. 背影不能像正脸（用户：「我老以为它朝着我」；eye.md G-2、QA P2-9）：兜帽背面不要有暗的椭圆凹陷（改成浅一些、有布褶明暗的料子）；正面的兜帽里是深的空洞，只有从正面才看得到两点很淡的冷光（眼睛），背面看不到（按法线和视线方向算）
3. 飘动时身体往前倾（按速度，最多约 8°），下摆、袖口往后拖一点，朝向一眼看出
4. 模型是 `public/assets/ghost/ghost.glb`（`?procghost` 是程序化的兜帽人形），两种都要对；截图：正面、背面、侧面、飘动中，第三人称和被手电照着各一组

## 路 HT：游戏说明、F 的提示、失败要说话、开局不空等

1. **标题页三步说明**（strings 里写，排版照现有标题页）：Find someone with a flashlight. / Possess what they are looking at — an eye appears above it. Make a sound first if no one is looking. / Step into their light and press F to appear. 再一行：A night lasts about five minutes. At dawn the house empties. 手机版用 Tap 的说法
2. **常驻的按键说明**：右下角（或准星下方）一小块：Click possess · Hold set a trap · F appear；F 后面写状态（Ready / 冷却秒数）。每个动作都成功用过一次以后缩成只剩 F 的状态；Esc 照旧给完整说明
3. **F 的提示**：现身就绪、有人此刻能被现身吓到（AF 路的 `reachOf` 已经算了谁会被吓到）时，准星旁出一个小小的 `F` 键帽；没人能被吓到时不出
4. **失败要说话**（newbie S1）：现身没吓到任何人时播一句 `No one saw you. Stand in their light.`（新文案）；落空的播报在第一次成功之前不闭嘴（现在 3 次就停）；操作说明留到第一次成功附身为止
5. **开局不空等**（newbie F1、eye G-1）：点开始以后的那段等待（等后台预编译）挪到点之前：后台预编译在加载阶段就开始，开场按钮在它编完前显示进度（「Lighting the candles…」后面跟一个慢慢变满的细线或百分比，不靠主线程的 CSS 动画），编完才亮；点了就开场。量：打开网页到能动的总时间不变或更短，点了以后 < 1 秒
6. 标题页整页可点开始（newbie G5）；加载中点了要记住、好了自动开始

## 路 GP：玩法（现身不是唯一解、人多一点、结尾有起伏、登记簿有一句评语）

1. **现身的规则**（critic F-1，主会话核对过 `src/sim/world.ts:211-215`：蓄力时 5 米内的人只按距离就会转过来，隔着墙也算）：蓄力不再让人隔墙转身；现身只吓「手电此刻照着鬼魂的人」和「已经紧张（`nervous` 或恐惧值 ≥ 某个值）、看得见那里的人」；吓的分量按这个人此刻的恐惧值加成（物件先把人吓紧张，F 收尾）。改完用机器人量：「只按 F」的打法和「先引诱再附身」的打法，后者吓跑的人不能比前者少
2. **引诱接得上附身**（critic S-1）：被引诱的人走到声源附近以后，用手电把这间屋扫一圈，扫过惊吓物件时停一下（给玩家出手的窗口，约 1 秒）
3. **人数**：屋里同时最多 4 人（`SPAWN.target` 3 → 4，用户定）；开局间隔 20 → 12 秒（`NIGHT.openingGaps`）；之后偶尔两人结伴进门（约三分之一的机会，第二个人隔 2 秒跟进）。只在正式游戏打开（`WorldOptions`），机器人默认不变的部分保持不变
4. **结尾有起伏**（critic S-3、newbie G4）：收夜前最后来的一批是两人结伴；收夜以后屋里的人更容易被吓（恐惧值涨得快一点、消得慢一点），让最后一分多钟有事可做
5. **登记簿一句评语**（不计分）：按这一夜吓跑的比例给一句克制的话（新文案放 strings 的 register 段，比如全吓跑 "Word will spread about this house."、一半 "Some of them will not come back."、没人跑 "They will say the house is only old."），写在页脚第一句
6. 登记簿「怎么走的」只记最后一下的问题（critic S-4：F 出了大力却记成 cold breath）：改成记这个人恐惧值涨得最多的那一类来源
测试：现身规则、引诱后的扫视、人数、结伴、评语；`tests/balance.test.ts` 的数字会变，贴前后对比

## 路 VX：画面（红闪、溶洞、亮度、手电近处、天亮）

1. **吓跑时的整屏暗红闪**（`src/engine/juice.ts:27` 的 `vignettePulse(PALETTE.dread)`，newbie S2、eye S-2）：去掉红色，换成很淡的冷色暗角，几个人连着跑也不叠加（取最大，不相加）；镜头晃动保留但减小
2. **墙后的溶洞**（eye S-1、newbie G3）：洞边不发光（`DISSOLVE` 的 rim / glow 收掉或压到看不出），形状不随帧变（噪声只随空间、不随时间；穿墙时洞口变化平滑）；切开的家具截面不要纯白（截面颜色跟着家具本身、偏暗）。用户以前喜欢穿墙的舷窗：舷窗本身留着
3. **亮度**（eye F-1：整夜平均 68% 像素 < 15/255）：抬底光，让房间的轮廓、门洞、家具的剪影始终看得出；目标近黑像素 ≤ 45%（同一套机位前后对比），墙角仍然暗。不加灯：改环境光、半球光、雾的环境色、反弹光的底
4. **手电贴近时的过曝**（深红沙发上的粉色光斑、eye G-9 侧面一大块橙色光斑）：近处（< 1 米）压低手电的强度，或者调色调映射的高光去饱和，截图对比
5. **天亮看得出**（eye G-7）：天亮时窗户射进看得见的冷白光（用已有的月光 / 窗玻璃，不加灯），屋里亮度明显上来
6. 手电的影子纯黑、边缘破碎（eye G-4）：影子里留一点环境光；鬼魂自己的光在天花板上那块固定的灰色光斑（eye G-3）去掉
测试：能测的写测试（暗角不叠加、countDips）；画面用截图前后对比（同一机位），perf 量

## 路 CU：镜头和标记

1. **吓跑那一刻镜头轻轻偏向逃跑的人**（用户以前定过「镜头不自动转向」，这次三位严格玩家都要求看得见回报，主会话的方案）：只在吓跑时，偏航最多 10°、约 0.6 秒偏过去再还给玩家，玩家一动鼠标立刻停；减少动态时不做
2. **手机竖屏**（eye S-6、newbie S3）：娃娃屋镜头拉近到房子占满屏幕宽度，访客更大
3. **范围霜线看得见**（eye S-5）：暗处的细线提亮到看得出，靠近镜头那一段淡掉（不再是一条白带）；现身霜线画 5 米、实际吓 6 米的出入对齐（critic G-1）
4. **被瞄准的物件**（eye S-5）：薄荷绿的整块平涂 / 描边换成冷白灰的细线，不平涂；机关按住时有蓄力进度（物件上的薄霜从下往上长，0.5 秒长满）
5. 吊臂被墙压短时（eye S-3）：镜头抬高一点、鬼魂淡一点，不要糊住三分之一屏幕
测试 + 截图前后对比

## 路 IMG：恐怖画（图由主会话用素材中台生成，原图在 `assets/generated/vmc/`）

1. 画像（`portrait.ts`）：平时是正常的女士像，被附身时（眼睛转过来那一刻）换成恐怖版（同构图，从脸开始化开过去，约 0.4 秒，不闪）
2. 6 幅挂画挂到各房间的空墙上（书房、客厅、走廊、卧室、门厅各至少一幅；避开窗、门洞、物件），木画框、画布有一点光泽，受手电和反弹光照，不发光
3. 镜子里扑上来的那张脸（`mirror.ts`）换成生成的真实质感的脸
4. 贴图从原图压成 webp（最长边 1024，进 `public/assets/paintings/`，记下来源），开场预编译里编好；首次出现不卡；perf 不掉
截图：每幅画在手电下、反弹光下；画像换脸的过程
