# Halloween Manor

万圣节网页小游戏：你是一只鬼，在一栋黑暗的老宅里附身屋里的物件，把拿着手电筒的访客吓得尖叫着逃出门。屋里最多同时 4 个访客，有时两人结伴进门。有鼠标和键盘时是第三人称（你就是那只鬼，能穿墙飘），触屏是娃娃屋俯视。

一局是一夜，约 5 分钟：开局一个人推门进来，之后每隔 12 秒再进一个，直到屋里有 4 人（`NIGHT.openingGaps` 是 [12, 12, 12]），偶尔两人结伴 → 墙上偶尔多一个影子 → 3 分 20 秒收夜（不再有人来，门廊灯熄；收夜前 50 秒起进门的都是两人结伴，等屋里容得下两个才来，不是每夜都有；收夜以后屋里的人恐惧值涨得快一点、消得慢一点，最后一分多钟还有事做）→ 4 分 30 秒天亮（没被吓走的人自己出门）→ 最后一个人出门，翻开访客登记簿。登记簿上点 Keep haunting 接着玩，点 Another night 重新来一夜。不计分、没有输赢，登记簿就是这一夜的结局；收夜那一页页脚第一句是一句评语，按这一夜吓跑的比例给（全吓跑 `Word will spread about this house.`，一个都没跑 `They will say the house is only old.`），不打分、不写数字。

真实时间试玩（QA，2026-10-30 17:14–17:32，游戏代码 `eb57099`，WebGPU 三整夜：引诱后原地等、只按 F、追眼睛附身，另有 WebGL2 和手机横屏各 1 分钟）：从点开始到翻开登记簿 4 分 46 秒、4 分 47 秒，全吓跑的那夜 3 分 49 秒；打开网页到能点 6.8–10.0 秒（单独开 6.8–7.4 秒，和别的页面同跑 7.5–10.0 秒）；点开始到开场约 20 毫秒（17–22 毫秒）。页面报错 0、访客卡住 0（`.superpowers/sdd/2026-10-30-player-feedback/playtest.md`）。动手的是机器人，声音、真人手感和「吓不吓人」测不到。

- 设计：`docs/superpowers/specs/2026-10-26-haunted-house-design.md`（末尾「替用户做的决定」是待审清单）
- 实现计划：`docs/superpowers/plans/2026-10-27-haunted-house.md`
- 一夜的计划（10/30 第一波：开头、中段、收夜、天亮、访客登记簿、上手提示、标签说实话）：`docs/superpowers/plans/2026-10-30-night-onboarding.md`
- 5 分钟一局的计划（10/30 第二波：光影、粒子、镜头、范围显示、有效反馈）：`docs/superpowers/plans/2026-10-30-five-minute-game.md`
- 用户试玩之后这一轮的计划（10/30 第三波：鬼魂看得清、游戏说明、人数、更吓人、严格玩家挑的毛病）：`docs/superpowers/plans/2026-10-30-player-feedback.md`
- 10/30 看样清单（这一轮要你定的；第 24 节是用户试玩之后这一轮的）：`docs/superpowers/specs/2026-10-30-preview-checklist.md`
- 这一夜各路的报告和审查（只在本机，不进 git）：`.superpowers/sdd/2026-10-30-night-onboarding/`、`.superpowers/sdd/2026-10-30-five-minute-game/`、`.superpowers/sdd/2026-10-30-player-feedback/`（六路报告 `lane-*-report.md`、整体审查 `combined-review.md`、真实时间试玩 `playtest.md`）；下面「已知问题」里的出处都指它们
- 技术栈：Vite · TypeScript · three.js r186（`three/webgpu`，自动退回 WebGL2）· Web Audio（声音全部程序化合成）

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（这台机器上 5173 可能被占，可以加 `-- --port 5731 --strictPort`）。不再监视 `.logs`、`.superpowers`、`assets`、`assets-src`、`shots`、`dist`（`vite.config.ts` 的 `server.watch.ignored`）：往这些目录里写 html、ts 不会让打开的游戏页面整页刷新（2026-10-30 一小时刷了 183 次才发现） |
| `npm test` | 全部单测（模拟层、画面和声音的纯逻辑）+ 平衡测试（机器人自动玩）。空闲时约 8 秒（768 条时量的），几路同时跑、冷编译时 20 秒以上。2026-10-30 试玩这一轮各路自己报的是 900–1080 条全过（最后一次是 HT 修复轮的 1080 条），合并后的总数和耗时没重量 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 构建到 `dist/`（相对路径，放到任何静态托管的任何子路径下都能打开） |
| `npm run smoke` | 构建 → 预览 → 本机 Chrome 无头打开 → 逐项断言（含一夜的收尾和登记簿、触屏点击、390 px 宽），截图在 `shots/`。加 `-- --webgl` 测 WebGL2 回退路径 |
| `node scripts/perf.mjs` | 放满 4 个访客量帧时间，看自动降档。`--cpu` 用纯 CPU 软件渲染模拟最差的机器，`--low` 测 Low 档，`--empty` 是没有访客的对照组 |

`npm run smoke` 和 `node scripts/perf.mjs` 的预览端口都写死 5738，几路同时跑会撞，见「已知问题」。

用 `./node_modules/.bin/<工具>` 而不是 `npx`：这台机器上 `npx` 可能会找到别的项目里的版本。

并行的 worktree 里不要用 `git stash`：栈是各 worktree 共用的，这一轮 GH 和 CU 就互相 pop 过对方的条目（没丢东西，是按哈希一个个核对回来的）。要取改前的文件，用 `git archive` 或 `git show <提交>:<路径>`。

地址参数：
- `?debug` 挂出 `window.__haunt`：`state()` 看文字版状态，`step(ms)` 快进，`trigger(id)` 附身，`spawn({...})` 放访客，`setTimeScale(n)` 加速，`screenOf(id)` 取物件的屏幕坐标
- `?night=<分钟>` 改天亮的时刻（单位分钟），收夜按 200 : 270 的比例跟着缩（`?night=1`：44 秒收夜、1 分钟天亮），看收尾和登记簿时用；不带 `?debug` 也认。`?debug` 下还有 `__haunt.endNight()`（立刻收夜，不等屋里的人走光：静、光收回、翻开登记簿）、`__haunt.dawn()`（立刻天亮，没被吓走的人自己出门，再用 `step(5000)` 快进看他们走光）、`__haunt.keepHaunting()`（点收夜那一页的 Keep haunting）、`__haunt.night()`（现在在哪一段：`phase` 是 night / closed / silence / retreat / register，还有登记簿开着没有、前门开了多少）。登记簿的版式和句子不想玩一夜就能看：开发页 `/dev/ui.html?collab`，点开场（控制台 `document.querySelector('[data-start]').click()`）后 `__ui.register()`
- `?fxview` 配合 `?debug`：`__haunt.fx.view(n)` 把画面换成后处理的中间结果（1 是 AO 图，2 是场景线性亮度 ÷ 4，3 是后处理里 AO 实际乘的倍数，0 回到正常），调泛光阈值、AO 保护区间时看亮度在哪用；不带 `?fxview` 时这几个视图不建，`view()` 没有效果。`__haunt.fx.aoStrength(0)` 把 AO 关掉做前后对比（`aoStrength(null)` 恢复）
- `?noother` 不建墙上的影子；`?debug` 下 `window.__otherShadow`（`state()`、`place(id)`、`clear()`、`inView()`）和 `window.__rangeFrost`（`show(id)`、`exhale()`、`debug()`）看样用
- `?webgl` 强制走 WebGL2。有人反馈画面不对时，先让对方加上它，看是不是 WebGPU 的问题
- `?nofog` 关掉贴地雾气（对比效果、排查性能时用）
- `?noparticles` 关掉粒子（浮尘、粉尘、白气）
- `?dollhouse` 在电脑上也用娃娃屋俯视；`?noghostfx` 不画鬼魂和穿墙溶解，`?noceiling` 不加天花板（对比效果、排查性能时用）
- `?fx=-ao` 关掉部分后处理（`?fx=legacy` 回到旧管线）；`?gputime` 配合 `?debug` 读 GPU 时间：`__haunt.fx.gpu()`
- `?solid=0.1` 现身时「实」的那份没被照着时的暗度（默认 0.03 是暗色剪影；0.1 偏灰，像一团实雾）。看样时对比用
- `?debug` 下还有：`__haunt.events()` 取走记下的模拟事件（现身、机关、察觉……）；控制台的 `[boot]` 几行是冷启动各段的时刻；`?pipelog` 记下新建的渲染管线（`__pipelog.stop()`）
- 联名皮肤（翠宝穿承太郎、DIO 的衣服）2026-10-30 起默认就在访客轮换里（用户定：公开构建也带，授权由用户负责），插在第一套后面（开场还是公开的那一套，第 2、3 个进门的人穿联名）。`?nocollab` 不并；`COLLAB=0 npm run build` 构建不带这两个模型，JS 里也没有它们的地址，`assets/visitors/manifest.json` 也不进 `dist/`
- `?oldflicker` 附身台灯、访客紧张时的手电换回旧的闪法（旧的超过每秒 3 下，看样对比用）
- `?procghost` 鬼魂换回程序化的兜帽人形（默认用 `public/assets/ghost/ghost.glb`，见 `src/config/ghost.ts`）

## 玩法速览

- **标题页和提示**（2026-10-30 用户试玩：「F 没有任何提示，要有游戏说明」）：标题页一行目标 `Scare the visitors out the front door.`，下面三步：`Find someone with a flashlight.` / `Possess what they are looking at — an eye appears above it. Make a sound first if no one is looking.` / `Step into their light and press F to appear.`，再一行 `A night lasts about five minutes. At dawn the house empties.`。触屏第二步写 Tap，没有现身的设备（触屏、娃娃屋）第三步换成 `Scare them again before they calm down, and they will run.`。整页可点开始，加载中点了会记住、好了自动开始。开场后右下角常驻一小块按键说明（Click possess · Hold set a trap · F appear），F 后面写状态（`Ready` 或冷却秒数），三样都用过一次以后只留 F 和状态；下沿还有一行完整的操作说明，挂到第一次成功附身，最多约 30 秒（`KEYS.max`）；Esc 暂停时给完整说明。现身就绪、此刻有人会被现身吓到时，准星旁出一个小小的 `F` 键帽，没人会被吓到时不出。做不到、落空时当场有话：`Not yet.`、`No one saw you. Stand in their light.`
- **恐怖的东西**（用户：「不够吓人」）：六幅恐怖挂画挂在门厅（两幅）、走廊、书房、客厅、卧室的墙上（`PAINTINGS`，`src/config/house.ts`）：木画框，画布有一点光泽，受手电和反弹光照、不发光，跟着墙一起溶开。画像平时是正常的女士像，被附身时眼睛转过来，约 0.7 秒从脸往外化开成恐怖版，脸停约 1.5 秒再扑倒；落地镜里扑上来的脸换成了真实质感的脸，停到约 1.8 秒。手机（娃娃屋）里没有挂画，画像也太小，见「已知问题」
- **访客的新花样**：被引诱的人走到声源以后不再原地发愣，先盯声源 0.8 秒、用手电把这间屋扫一圈，扫过看得见的惊吓物件时停 1 秒（`SCAN`，`src/config/visitors.ts`），给你出手的窗口。平时闲逛，访客每次挑下一个去处，有 0.6 的机会走到画像、镜子或六幅挂画前面 1.5–2.5 米，面朝它、抬起手电照着看 2–3 秒（`NIGHT_VISITS.browse`、`BROWSE`，`src/sim/browse.ts`；紧张的人不停）。全屋被看得最少的先轮到，镜子、画像排在挂画前面；站的地方照 `seenBy` 的规则挑，是真吓得到的位置
- **镜头**：吓跑那一刻镜头轻轻偏向逃跑的人（最多 10°、约 0.6 秒偏过去，不回摆；你一动鼠标、方向键或按左键就停；减少动态效果时不做；人已经在画面里或在身后时不偏，`LEAN`，`src/engine/ghostRig.ts`）。手机竖屏时娃娃屋放大 1.26 倍，房子撑满宽度

- **有鼠标和键盘（第三人称，你就是那只鬼）**：开场点一下锁定鼠标；WASD 飘（能穿墙），鼠标转向，滚轮调镜头远近（1–4 米）；准星对准 4 米内、看得见的物件点击附身；Esc 放开鼠标，点一下继续。访客看不见你，但你贴在他身后会让他发毛，贴得够近够久是一次「后颈一凉」。隔着墙看不到名牌，靠脚步声找人（戴耳机）
  - **手电**：访客只看得见手电照着的东西。你被照到时会变浓、变清楚（有一层很低的压力声），他会停下来盯着看，但不会被吓到。穿墙的「呼」会让附近的人回头、走过去查看（不涨恐惧值）
  - **现身**：右键或 F。附近的灯像坏灯泡一样暗两下，0.6 秒后你在原地显出一个暗色的人形，停 1.5 秒、慢慢抬头；**现身只吓两种人**（2026-10-30 起）：手电此刻照着你的人，和已经紧张（恐惧值到 `FEAR.nervous`，走得快、手电抖）又看得见你的人；蓄力不再隔着墙、也不再只凭距离把附近的人转过来。吓多少看这个人此刻有多怕：恐惧值为 0 时只有 0.5 倍，满了是 1.5 倍（`MANIFEST.primed`）——**物件先把人吓紧张，F 收尾**。被吓到的人往后退，20 秒里绕开这一块。冷却 18 秒（准星外那圈很淡的弧）。现身期间你不能动，只能转视角；人在墙里时按了没反应（墙里谁也看不见你），也不扣冷却
  - **机关**：对着物件按住左键约 0.5 秒。设下的物件结一层薄霜、眼睛图标变空心、标签写「Trap set」（已经设了 2 个时再按住没反应，等其中一个发作或解除）；有人走近时它自己挑时机发作（摇椅、床、衣柜等他背对着；肖像、镜子、台灯等他的手电照到它；八音盒、厨房门有人听得见就响），60 秒没人来就解除，最多同时 2 个
  - **范围**：准星对着物件（4 米内、看得见）时，地上浮出它的范围，一条淡淡的霜线：线里面是会被它吓到（惊吓类：站在那儿看得见它的人，镜子和画像只算正面）或听见（引诱类）的地方，墙另一边不画。名牌上名字前的小眼睛亮着，就是你现在这一下会吓到他（引诱类是会引来他）：对着物件时指附身这个物件，没对着物件、现身就绪时指在原地现身；物件在冷却时眼睛是灰的。现身蓄力的 0.6 秒里，一圈霜线从脚下跑到 6 米外停住（`MANIFEST.noticeRadius`，和落下时的结算 `MANIFEST.range` 是同一个数；6 米是最远范围，圈里只有手电照着你的人和已经紧张的人才会被吓到），冷却好了再往外呼一次。霜线在收夜、翻开登记簿时安静
  - **反馈**：出手以后，准星对着的标签第二行写结果：惊吓类 "Theo jumped" 或 "No one saw it"，引诱类 "Theo heard it" 或 "No one heard it"，停约 1.6 秒再回到冷却秒数。够不着（4–10 米、看得见）时标签写 "Too far away."，准星外圈变虚线。对着惊吓类物件时标签也写此刻有没有人看着（"Theo is watching" / "No one is watching"）；做不到的事（现身冷却中、在墙里现身、机关已经 2 个）会在准星下面说一句原因。访客害怕、或者被你贴近发毛时会呼白气（手电照着才看得清）。现身没吓到任何人时，播报栏写 `No one saw you. Stand in their light.`
  - **登记簿**：右下角按钮栏左边的本子（开局以后才出现；第三人称要先 Esc 放开鼠标才点得到），随时能翻开；收夜那一页有 Keep haunting 和 Another night，半夜翻开写 "The night is not over."。翻开时模拟照跑。收夜那一页页脚第一句是评语（`STRINGS.register.verdict`：全吓跑 `Word will spread about this house.`、至少一半 `Some of them will not come back.`、有人跑但不到一半 `Most of them will sleep tonight.`、一个都没跑 `They will say the house is only old.`）。每个人「怎么走的」记他恐惧值涨得最多的那一类来源，不再只看最后一下；钟点一律写 am / pm
- **触屏设备（娃娃屋俯视）**：Q / E 旋转镜头，滚轮缩放；电脑上加 `?dollhouse` 也能用这个模式。范围霜线（线宽按屏幕像素换算）、结果标签在娃娃屋里也有。竖屏时放大 1.26 倍（两头的尖角各裁掉约 1.5 米，床被裁掉约一半，QA 四个方位第一下都点得中）；没有挂画（内墙是 0.5 米的矮墙）
- M 静音，右下角可切画质
- 点被瞄准的物件附身（第三人称里物件描一圈冷白灰的细线，平时 1.25 像素、瞄着 2 像素，只给 4 米内够得着的物件，镜头钻进物件、被墙上的洞碰到时不画；娃娃屋不变）。**引诱**（八音盒、厨房门）发出声音，把听见的人引过去；**惊吓**（台灯、摇椅、肖像、落地镜、卧室的床和衣柜）必须被人看见才生效，物件上方的眼睛图标亮着就说明此刻有人看得见
- 核心套路：先引诱，再惊吓。八音盒和卧室台灯是一对，厨房门和摇椅是一对

## 访客模型：吉祥物换装（Tripo 流水线）

`scripts/tripo/visitors.mjs` 把翠宝换上万圣节服装、建 3D、绑骨、套动作，导出到 `public/assets/visitors/<id>.glb`。清单和每一步的参数在 `scripts/tripo/visitors.json`，选模型的依据在 `docs/research/2026-10-28-glimmerby-api-models.md`。

1. 换装图（Tripo image-to-image）：`node scripts/tripo/visitors.mjs --run all --yes --until costume`，图在 `assets-src/visitors/<id>/costume.png`
2. 修图（公司素材中台 vmc）：把手改回三指加拇指、去掉多出来的配件。挑好的图复制成 `assets-src/visitors/<id>/touchup.png`，母版留在 `assets/generated/vmc/<任务ID>/`
3. 满意后把清单里这个访客的 `status` 改成 `approved`，再 `--run <id> --yes`：四视图 → 3D（P2-20260801）→ 绑骨检查 → 绑骨 → 4 个动作 → 导出
4. 导出前自动用本机 Blender 精修（`scripts/blender/refine.mjs`，可以单独跑）：球身、帽子、披风整块跟着躯干，挂在腿边的配件不跟着腿拉伸，同时清碎片、限面数和贴图、去根运动。预览表在 `assets-src/visitors/<id>/refine-preview/<id>-sheet.png`，第一行是权重：蓝色跟身体，橙色跟腿和手臂
5. 不联网的自测：`node scripts/tripo/selftest.mjs`。先看要花多少：`--dry-run`

导出后在 `src/config/character.ts` 的 `VISITOR_SPECS` 里登记（片段名照 `public/assets/visitors/manifest.json` 填），再用 `/dev/characters.html?visitor=<id>` 跑 `await __chars.calibrate()` 量朝向和步频（腿很短的模型它会把小腿当成脚，run、flee 量偏，见 `character.ts` 里联名两套的注释）。开场按钮只等第一套的下载（加上整栋房子的预编译，见「已知问题」）；其余几套开场后边玩边下载，编好管线才加入轮换（WebGL2 上按钮要等它们编完才亮，最多约 40 秒）。进门的人接着上一个人往下轮，相邻两人穿得不一样；一套都加载不到时用占位狐狸（`?fox` 强制只用狐狸）。联名的两套登记在 `COLLAB_SPECS`，默认加进来，插在第一套后面（`?nocollab` 不加；`COLLAB=0` 构建里没有，见 `vite.config.ts`）。

现在有四套：维多利亚吸血鬼、提灯夜行的探险家、女巫、手绘骷髅（2026-10-28；从换装图到动作一共花了 825 积分，其中四视图、建模、绑骨、动作 780）。另有两套联名（2026-10-29：翠宝穿承太郎、DIO 的衣服，换装图修图走素材中台的 GPT Image，3D 一共 490 积分；承太郎的手套、大衣颜色由导出时的 `scripts/blender/retint.py` 调，规则在 `visitors.json` 的 `retint`）。每套约 1.1–1.7 MB：底色贴图 2048、法线和粗糙度 1024，都是 WebP。

## 换上别的模型

1. 把 GLB 放进 `public/assets/mascot/`
2. 先不改配置，直接预览：`/dev/characters.html?url=/assets/mascot/<文件名>.glb&ambient=1.2&focus=0&fzoom=3&arrows`，控制台会打印动画片段名、原始尺寸、三角面数。加 `&clips=待机,走,跑,受惊`（片段名，没有的写 `-`）可以直接看动作
3. 在页面控制台运行 `await __chars.calibrate()`，它会建议 `facingOffset`、`walkRateAt1ms`、`runRateAt1ms`。`rootMotion` 必须是 false（true 说明动画片段自己带位移，要重新导出原地动画）
4. 改 `src/config/character.ts`：`url`、`facingOffset`、`clips`（片段名照控制台打印的原样写，没有的写 `null`），以及两个速率
5. 检查：箭头和脸的朝向一致；按 1 看受惊跳起，按 F 看逃跑；`?visitors=4` 加 `__chars.perf(4)` 看性能
6. 面数尽量控制在 1.5 万三角面以内（每个访客每帧最多要画 6 次：主画面 + 4 支手电的阴影 + 月光阴影）。meshopt 压缩和量化的 GLB 都能直接用；**Draco 和 KTX2 没接**
7. 吉祥物比占位狐狸矮的话，可以考虑把 `FLASHLIGHT_HEIGHT`（`src/config/character.ts`，现在 0.8 米）降到 0.6 左右

公开使用吉祥物形象是否需要公司批准，请自己确认。

## 需要你试听的声音

Claude 听不到声音，下面这些按「最没把握」排序。打开 `/dev/audio.html` 可以逐个点按钮试听，不用进游戏。参数都在 `src/audio/` 里：

| 声音 | 担心 | 调哪里 |
|---|---|---|
| 尖叫 | 共振峰合成可能听起来像卡祖笛 | `voices.ts`：`SCREAM.f0`、`SCREAM.formant`、`SCREAM.rough`、`FORMANTS`、`SCREAM.level` |
| 摇椅嘎吱 | 可能发嗡、像青蛙；5.6 秒偏长 | `sfx.ts`：`CHAIR.back` / `CHAIR.fwd`、`CHAIR.roll`、`CREAK_GAIN`、`LEVEL.rockingChair` |
| 台灯 50 Hz 嗡声 | 耳机里可能发闷 | `sfx.ts`：`LAMP.fund`、`LAMP.buzz`、`LAMP.crackle` |
| 八音盒结尾的音高下沉 | 下滑音正是 工具 里 v1 被否掉的原因之一 | `sfx.ts`：`MUSIC_BOX.sag`（设 0 去掉） |
| 环境层 | 笔记本扬声器上 D1 / D2 基本听不见 | `ambience.ts`：`AMB.d3`、`AMB.wind`、`AMB.upper` |
| 镜子的反向渐强 | 滤波器从 400 Hz 开到 5000 Hz，可能听成上扫 | `sfx.ts` 的 `mirror()` 里直接写的两个数；`MIRROR.swell`、`MIRROR.stab` |
| 吓跑冲击音 | 失真程度 | `sfx.ts`：`BRAAM.drive`、`BRAAM.lp`、`BRAAM.voices` |

## 已知问题

- 光（LT）、鬼魂和雾（GF）两路已经合进 `feat/night-onboarding`（在用户试玩这一轮之前）；看样清单第 12、17–20 节里标「会怎样」的，现在都看得到，以代码为准
- 门厅和走廊没有物件，新访客要走进房间才会被吓（布局调整的取舍，见设计文档）
- 平衡是机器人测出来的：会玩的机器人每 5 分钟吓跑约 12 人（12.2，种子 1–5，`tests/balance.test.ts` 的报告，2026-10-30 试玩这一轮之后；原来 11.2）。机器人对局不调 `World.close` / `World.dawn`，测的是不收夜的沙盒局；真正的一夜 3 分 20 秒以后就没人再来，天亮自己走的不算吓跑，吓跑的会少一些。正式一夜的开关（4 人、结伴、收夜后更容易被吓）只有 `nightWorld` 给，机器人默认不开；用它们跑正式一夜（种子 61–110，调参没用过）每 5 分钟吓跑几人，改前 → 改后：狂按 F 6.9 → 6.1、贴身狂按 F 9.4 → 3.0、照着光按 F 6.3 → 4.8、先引诱再附身 5.4 → 8.2、再加现身收尾 7.8 → 11.0，「只按 F」不再是最优（GP 报告）。试玩里机器人追眼睛、引诱、设机关的一夜 11 来 11 跑，只按 F 的一夜 5 来 2 跑，次序相同真人大概也会慢一些，需要试玩确认
- 门廊灯不投影，门厅地板靠南墙处有一点暖光
- 开场按钮现在等房子、第一套访客造型和整栋房子的后台预编译（含挂画、画像、镜子的管线）都编完才亮：标题页写 `Lighting the candles…`，底下一条慢慢变满的细线（合成线程的过渡，不靠主线程的 CSS 动画）；点了以后约 20 毫秒开场（QA 量到 17–22 毫秒，真点击 71 毫秒），不再有「点了还要等约 10 秒」。打开网页到能点：WebGPU 本机不限速 8.9–10.2 秒（原来 16.1–17.2）、4 Mbps 14.1–14.9 秒（原来 22.1–23.3）（HT 路）；QA 单独开 6.8–7.4 秒、和别的页面同跑 7.5–10.0 秒；WebGL2 约 13–15 秒（原来 19.4 秒再点了等 8.9 秒）。开场前的下载在 2.83 MB（2026-10-29 限速实测）之外，挂画贴图又多 0.89 MB（娃娃屋只下 3 张共 0.24 MB），限速下的等待没有重量。最后约 3 秒 GPU 同步编约 36 条管线（后处理、阴影、蒙皮，预编译编不到），整页包括细线都会停一下。预热的两步有上限（等 GPU 10 秒、预编译 90 秒，`src/warmup.ts` 的 `PREHEAT_LIMIT`），到点就放行、没编完的在后台接着编；动画循环里抛错会挂错误界面（`createLoopGuard`），不会让按钮永远停在加载中。其余几套造型开场后边玩边下载（5.30 MB），编好管线才加入轮换，加入时不卡（`node scripts/stall-outfits.mjs` 探针）。编管线用到了 three r186 的内部接口：升级 three 以后对不上会在控制台警告一次，并且要重跑这个探针（WebGPU 和 `--webgl` 各一次）。打开后约 0.6 秒内就点（还没有镜头）锁不了指针，开场后要多点一下 Click to resume
- Another night 还是整页重新载入：重新载入后约 7 秒能点（QA 量到 6.9 秒；原来标题页加载 8.1 秒、点开始后再等 9.1 秒，约 20 秒才重新开局），点了马上开场。这一轮保留（稳）；要根治得做不重载的重开（重建 world、各视图复位），工作量大，留到上线后（`src/night.ts` 的 `anotherNight` 走 `reload`）
- 访客的材质同一套造型的人共用（透明度按物体传），这样预编译编过的管线进门时直接能用。以前每人复制一份，每个新访客进门都要现编。例外是手电的阴影图材质（`ShadowMaterial`）：每个新访客进门约 0.6 秒后还会现编 1–3 条，WebGPU 上没引起长帧，WebGL2 第一位进门那一帧 83 ms；手机横屏衣柜「手指」那一下也有 167 + 117 ms 的长帧，QA 一并记在这一条（`qa-playtest.md` P2-10；`src/view/characters.ts` 里写明了这个取舍）。要再省，就让开局前每套造型都投一次影
- 第一次飞到落地镜跟前可能有一下约 0.13 秒（只有第一次，原因没查到）
- 附身台灯、访客紧张时的手电原来都超过「灯闪每秒最多 3 下」（防光敏，WCAG 2.3.1），2026-10-29 改成不超过（`src/view/props/lamp.ts` 的 `LAMP_PATTERN`、`src/view/flashlight.ts` 的 `TORCH.nervous`），`?oldflicker` 对比旧的。台灯和附近的现身叠在一起时也不超过：台灯自己在闪（附身、复原）时现身的压暗不叠上去；前后脚接上时（现身蓄力后不到 1 秒附身台灯、台灯刚复原就现身，原来会到每秒 4–5 下），台灯不跟着现身的蓄力、收那两下，只跟着落下、停留暗。代价是蓄力那 0.6 秒台灯不再跟着暗两下（门廊灯、手电照旧），看样时确认。门廊灯平时的摇曳压到单独数不出来（`src/view/house.ts` 的 `porchFlicker`）。台灯平时的轻闪也压到数不出来（`BLIP_DEPTH`，原来附身前刚好轻闪完一下时会凑成 4 下，约万分之七的附身时刻；防光敏优先，轻闪看起来更轻一点）
- 平衡里几条不变量余量很薄（`BALANCE_REPORT=1 ./node_modules/.bin/vitest run tests/balance.test.ts --hookTimeout=120000 --reporter=verbose` 会打出余量，2026-10-30：第三人称中位存活余 5.6 秒、加鬼魂吓跑的人数余 0.4（15.0 对 14.6，GP 报告说别的种子实际 1.19–1.22 倍，贴着界限）、会用引诱的多 1 局，只靠现身把单个 brave 5 分钟内吓跑的余量是 0：10 局正好 10 局）。机器人用固定种子，不会随机失败，但改模拟时容易翻。穿墙声先不涨恐惧值（用户 2026-10-29），鬼魂本身的威胁主要靠现身。衣柜当机关是背后型（用户 2026-10-29 定的），机器人测平衡时不用它当机关：真人用它连着吓胆大的会不会太强，要试玩看
- 骷髅的后背是纯黑的（四视图生成时只在正面画了骨头）；要的话可以单独改背面那张视图（约 5 积分）再重做 3D
- 性能：本机显卡上 4 个访客满载约 7 ms/帧；纯 CPU 软件渲染下 Low 档约 8 fps（最差情况）。场景约 14 盏灯，每个像素都要算一遍，开销主要和分辨率成正比，所以 Low 档按 75% 分辨率渲染。这一夜各路在几路同时占着机器时量到 `--cpu` 下 Low 档每帧约 215–385 毫秒，比这里写的慢；各路自己改前改后的对比都在 ±10% 以内，分不清是改动还是负载，合并后在机器空闲时重量（`lane-AF-report.md`、`lane-GF-report.md` 的 perf 一节）
- 一夜的收尾有几处还没定：Keep haunting 以后钟点接着往后走（`clockAt` 按模拟时间的绝对值换算），第二夜到天亮时登记簿会写成下午的钟点（集成审查里的例子是 "walked out at 3:20 pm, as the sky paled"，`integration-review.md` Minor 5）；登记簿翻开时模拟照跑，访客照常走、一夜的钟也照走（`src/main.ts` 里 `world.step` 不看 `registerView.isOpen`，`lane-NC-report.md` 顾虑）；天亮自己出门的人，关门声没降电平（`src/audio/sfx.ts` 的 `exitDoor` 不看 `exit.calm`）；一群人出门只响一声，是单测和真模拟对出来的，没人耳听过（`integration-review.md` 无法验证 1）。要你定的在看样清单第 11、14 节
- 前门门洞里两个逃跑的人迎面会互相卡住，是这一夜之前就有的毛病，没有根治：现在靠 `src/sim/world.ts` 的 `WEDGE_SECONDS`、`WEDGE_MOVE` 兜底（要出门的人 8 秒挪不到半米就放走，只管逃跑的和天亮自己走的）。机器人玩 600 个夜没碰到过，真人连着在门厅吓人时不一定；从根上修会改默认行为、要重跑平衡，留到上线后（`lane-NS-review.md`、`lane-NS-rereview-1.md`）
- 范围显示有几处边界：现身那一圈和落下时的结算都是 6 米（`MANIFEST.noticeRadius`、`MANIFEST.range` 取同一个数，2026-10-30 起；原来画 5 米、实际吓 6 米），「圈外一定安全」成立了；反过来，6 米只是最远范围，现身现在只吓手电照着你的人和已经紧张的人，圈里不都会被吓；物件的霜线假定访客正看着那里，手电没朝着的人真结算时不会被吓（`lane-RF-review.md` 风险 1）。名牌上的小眼睛有几个边角只说对一半：蓄势定住的人（`transfixOn`）现身时转向的是那个物件，眼睛仍算他会转过来；天亮往外走的人听得见引诱声但不会走过来；小眼睛和 F 键帽对贴近发毛、会回头的人少报约 0.5 秒（只少报、不多报，`combined-review.md` M8）；调试的 `endNight()` 在屋里有人时名牌上还会亮眼睛（`lane-AF-report.md` 顾虑 3、4、9，`lane-AF-review.md` Minor 6）
- 播报栏满了（`TICKER.max`，4 行）又都是要紧的行（吓到、逃跑、出门）时，新来的安静行直接不进栏：收夜、天亮、最后一位进门那几句旁白，在一阵吓人的尾声里可能整句看不到（`lane-AF-review.md` Minor 5；收夜那一句的亮度和停留另一路在改，`qa-playtest.md` P2-2，改完再看这一条还成不成立）。现身落下时合并的那一行 "Theo, June and 4 others flinched at a scream" 会把同一步已经有 "saw you" 行的人也算进去，内容没错，有点重复（`lane-AF-report.md` 顾虑 6）
- 物件幽光的「够得着才亮」读的是 `ghostDissolve.ghost`（`src/view/walls.ts` 导出、`src/view/house.ts` 每帧写）：`?noghostfx` 时它不写，物件就不按远近淡，拿它做对照会被带偏；`modules` 里 house 排在 props 前，换了顺序只是晚一帧（`lane-AF-review.md` 风险 5）
- 现身没吓到人时现在会说一句 `No one saw you. Stand in their light.`（`src/config/strings.ts` 的 `manifestMissed`）。第一次成功（附身吓到人或现身吓到人）之前，附身和现身的落空每次都说；成功以后一共说过 3 次（`MISSED_LINES`）就不再说，会了就不刷屏（`src/ui/hints.ts` 的 `missLineDue`）。准星处的结果标签仍然只管物件
- 后处理的小瑕疵：AO 在鞋缘有 1–2 像素的暗边（半分辨率的 AO 图双线性上采样），台灯后面的墙上有一小块 ≤ 6% 的暗斑（灯离墙不到 0.64 米，AO 压了灯自己点光照亮的墙）（`lane-PX-review.md` M-9）。泛光收紧以后镜子「化开」的冷光边不再晕、台灯电压冲高时泛光变大一点，QA 看过，两处都不突兀，建议保持现状（`qa-playtest.md` 定点检查 2）；白气在 QA 的截图里不显眼，没法评价
- 试玩（`.superpowers/sdd/2026-10-29-wardrobe-collab-polish/ux-playtest.md`）里没做的 P2 还在：触屏没有机关（`src/engine/picking.ts` 的娃娃屋拾取器注释写明点一下只会附身）；Esc 放开鼠标时模拟不暂停；鼠标灵敏度固定（`ghostRig.ts` 的 `sens`）、不能反转 Y 轴；没开声音的人找人更慢，标题只写 `Put on headphones.`
- `scripts/perf.mjs`、`scripts/smoke.mjs` 的预览端口写死 5738（`PORT`），几路同时跑会撞：smoke 开头会先等端口空出来（最多约 2 分钟），perf 不等，会连到别人的预览服务器上去量别人的构建。这一夜各路都拷一份改了端口再跑（`lane-PX-report.md` 顾虑 5、`lane-LT-report.md` 的 perf 一节）；要根治就把端口做成参数。全套测试在几路同时跑、冷编译时偶发超时（负载下整套 20 秒以上），已把 `vitest.config.ts` 的 `testTimeout` 放到 30 秒、两条墙钟断言改成热身后取最快一段（`10f0cb4`）；`npm test` 偶尔红一条、重跑就好时，先看是不是负载（`integration-report.md` 第 7 节）
- 试玩（`playtest.md`，2026-10-30，`eb57099`）的「一般」毛病，修复轮只修了严重的两条（S1 墙后的画面、S2 恐怖内容碰不到），这些没动：只按 F 或不去追眼睛的人，一夜只吓跑 2/5，第一次吓跑要等 1:27–2:11；紧跟在访客正后方时鬼魂挡人（0.8 米时人只剩鞋、名牌和透过来的衣服花纹，1.6 米时约挡一半）；访客背面全黑（DIO 背影是一团黄、Jotaro 是一团黑，修复轮给访客背面补了一点底光，`BOUNCE_LIGHT` 0.1 → 0.16，没有再看）；访客听到门响后挤在门洞里互相穿插；结伴进门玩家基本看不到，只有两行播报；鬼魂会站进洗手池和家具里；手机画面仍然很暗，访客很小；引诱那夜第一次吓跑时，截图上看不到人。已经修掉的：下沿的操作说明最多 30 秒（`KEYS.max`），登记簿的钟点一律写 am / pm
- 镜头退到墙后的时间还是不少（试玩：吊臂不再被天花板压短以后，镜头到鬼魂的连线穿墙的时间占比高，小房间里往下看尤其）。修复轮让墙后的画面不再像渲染坏了（门板接了底光、灰白截面和碎条去掉、洞口不再错开，`93d3c36`），镜头本身不再待在墙体里（CU 修复 `7009d8a`：算出来落在墙里才沿吊臂滑到刚出墙）；隔着墙的时间会尽量少，修完没有再量，比例以最后验证为准
- 手机（娃娃屋）基本看不到恐怖画：内墙是 0.5 米的矮墙挂不住，所以不建六幅挂画（访客也只去看画像、镜子，不对着空墙照）；画像太小，换脸几乎看不见（`lane-IMG-report.md` 顾虑 2）。恐怖的东西基本只有鼠标玩家看得到，要不要给手机补要你定（看样清单第 24 节）。竖屏放大以后两头的尖角各裁掉约 1.5 米，走进角落的访客可能看不到
- 整体审查（`combined-review.md`，94ccb72）留下的 Minor：M1 WebGL2 上细线满了还要等其余造型，最多 40 秒；M2 `SCAN.doorway` 让厨房一侧的人站在门板扫过的范围里，门慢慢打开时会穿过他（`props/door.ts` 的 creep）；M3 `scripts/perf.mjs`、`scripts/smoke.mjs` 等按钮亮只等 30 秒，现在按钮要全编完才亮，`--cpu` 可能假失败；M4 `scripts/stall-outfits.mjs` 的注释还是旧流程，WebGL2 的 40 秒路径合并后没人跑过（最后验证加 `--webgl --hang witch`）；M5 `characters.ts` 的手电池 `TORCH_SLOTS` 和 `torches.ts` 里的数是两个碰巧相等的数，手电池 4 个，第 5 个人没有手电（GP 估 20 夜约 1 次、最长 2 秒，QA 三夜没遇到，不用管）；M6 的 5 米：README、看样清单已改，`main.ts` 里的一处注释（94ccb72 时在 248 行）没改；M7 `renderer.ts` 的 `precompileAll` 没人用了；M9 `tests/balance.test.ts` 里镜子那条算式还按 3 人，正式 4 人时要 4 人同时看镜子才破；M10 循环启动之后 boot 才抛错时，`becomeReady` 可能收起错误界面（很窄）；M11 第一套造型、鬼魂模型下载卡住没有上限（原来就有，公网上更容易碰到）

## 部署

`npm run build` 的 `dist/` 是纯静态文件（相对路径，放哪个子路径都能开）。Vercel 上：Framework Preset 选 Vite，Build Command `npm run build`，Output Directory `dist`，Node 24.x（`package.json` 的 `engines.node`）；没有 `vercel.json`，用默认值。

- 默认构建带 JOJO 联名（翠宝穿承太郎、DIO 的衣服）：2026-10-30 用户定的，授权由用户负责。不要联名就用 `COLLAB=0 npm run build`（Vercel 上把环境变量 `COLLAB` 设成 `0`，或者改 Build Command）：两个模型、JS 里它们的地址、`assets/visitors/manifest.json` 都不进 `dist/`。已经部署的页面想临时去掉联名，地址加 `?nocollab`
- 整体审查在干净检出上验证过（`combined-review.md`）：`git archive` 导出，`npm ci` + `vite build` 过，产物 15 MB，里面没有本机路径；`package-lock.json` 装得上 Linux x64 的二进制包；824 个相对引用大小写都对得上。没有真的在 Linux 上构建过
- 托管平台要对 `.glb` 开压缩或者至少开长缓存

## 部署前还要做的

- 选托管平台并部署（需要你同意）。`npm run build` 的 `dist/` 是纯静态文件，放哪儿都行
- 联名皮肤（JOJO）：2026-10-30 用户定公开构建也带（授权由用户负责），默认的 `npm run build` 就带；要去掉用 `COLLAB=0 npm run build`
- 确定域名后，在 `index.html` 加 `og:image`（完整的绝对地址，1200×630 的游戏截图），分享链接时才有预览图
- 换模型、改访客之后重跑 `npm run smoke` 和 `node scripts/perf.mjs`（四套访客满载：High、Low 都是 60 fps，最长一帧 17.5 ms，2026-10-29）
- 开场时间用 `node scripts/loadtime.mjs` 量（三档限速，见上面「已知问题」里的数）；托管平台要对 `.glb` 开压缩或者至少开长缓存
- 光、鬼魂和雾两路和用户试玩后的六路都合并以后，在合并后的构建上整套重量一遍（试玩这一轮各路都没量 perf、没跑 WebGL2 冒烟；VX 的手电近处压暗让每个受光像素多算 8 次投影，perf 超预算就先去掉 `flashlight.ts` 里接 `colorNode` 的两行）：`npm run smoke`（WebGPU、`--webgl` 各一遍；第一波集成后两边各 53 项全过，`integration-report.md` 第 6 节；第二波各路合并之后，进度记录 `progress.md` 里没有整套重跑的记录）、`node scripts/perf.mjs`（High、Low、`--cpu`，要在机器空闲时量）、卡顿探针 `node scripts/stall-outfits.mjs`（第一次对准物件、现身、冷却好了呼气、墙上影子出现、前门推开，这几个「第一次」都不能现编管线；各路在自己的构建上量过，合并构建上还没跑，`lane-RF-review.md` ⚠️1）
- 叠起来的灯闪：反弹光、台灯、现身蓄力和落下、门廊灯慢熄、天亮、雾圈、手电紧张闪烁，在同一秒里叠起来会不会超过 3 下（`countDips`）。QA 测的构建（b865768，不含 AF、RF、光、鬼魂和雾）里，三整夜每盏灯任意 1 秒最多暗 3 下、没有超过；到 3 下的地方是第一次现身时离得近的两支手电和门廊灯、附身的台灯，正好卡在上限上，以后在现身附近再叠任何会暗的东西都要重新数（`qa-playtest.md`）。各路只测了自己那一份和少数组合，合并以后要整体再看一遍（`final-review-brief.md` 的第 2 点）
- 合并以后再整局真实时间玩一轮（`role-qa-brief.md`，带 `?pipelog`）：第一轮 QA（`qa-playtest.md`，测的构建 b865768，不含 AF、RF、光、鬼魂和雾）没有 P0；P1 两条（物件吓人很难对上、积极玩时墙上的影子不出现）和多数 P2 另一路在修；局 1 里 3:57 那一下 0.48 秒的停顿没复现，要继续盯。用户试玩这一轮合并之后已经玩过一轮（`playtest.md`，`eb57099`：致命 0、严重 2），修复轮改的 S1、S2 之后还没再玩
- 整体审查（`final-review-brief.md`，报告放 `final-review.md`）还没出，出来以后分诊里「上线前要修」的几条要办完，这一条再更新
