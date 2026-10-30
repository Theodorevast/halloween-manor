# Halloween Manor

万圣节网页小游戏：你是一只鬼，在一栋黑暗的老宅里附身屋里的物件，把拿着手电筒的访客吓得尖叫着逃出门。有鼠标和键盘时是第三人称（你就是那只鬼，能穿墙飘），触屏是娃娃屋俯视。

一局是一夜，约 5 分钟：开局一个人推门进来 → 墙上偶尔多一个影子 → 3 分 20 秒收夜（不再有人来，门廊灯熄）→ 4 分 30 秒天亮（没被吓走的人自己出门）→ 最后一个人出门，翻开访客登记簿。登记簿上点 Keep haunting 接着玩，点 Another night 重新来一夜。不计分、没有输赢，登记簿就是这一夜的结局。

真实时间试玩三整夜（QA，2026-10-30，WebGPU 两夜、WebGL2 一夜）：从遮罩收起到翻开登记簿 4 分 43 秒到 4 分 48 秒；从打开网页算，WebGPU 约 5 分 2–4 秒（含加载和点开始后的等待）。两种后端和手机竖横屏都能玩通，页面报错 0、访客卡住 0（`qa-playtest.md`）。

- 设计：`docs/superpowers/specs/2026-10-26-haunted-house-design.md`（末尾「替用户做的决定」是待审清单）
- 实现计划：`docs/superpowers/plans/2026-10-27-haunted-house.md`
- 一夜的计划（10/30 第一波：开头、中段、收夜、天亮、访客登记簿、上手提示、标签说实话）：`docs/superpowers/plans/2026-10-30-night-onboarding.md`
- 5 分钟一局的计划（10/30 第二波：光影、粒子、镜头、范围显示、有效反馈）：`docs/superpowers/plans/2026-10-30-five-minute-game.md`
- 10/30 看样清单（这一轮要你定的）：`docs/superpowers/specs/2026-10-30-preview-checklist.md`
- 这一夜各路的报告和审查（只在本机，不进 git）：`.superpowers/sdd/2026-10-30-night-onboarding/`、`.superpowers/sdd/2026-10-30-five-minute-game/`；下面「已知问题」里的出处都指它们
- 技术栈：Vite · TypeScript · three.js r186（`three/webgpu`，自动退回 WebGL2）· Web Audio（声音全部程序化合成）

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（这台机器上 5173 可能被占，可以加 `-- --port 5731 --strictPort`） |
| `npm test` | 全部单测（模拟层、画面和声音的纯逻辑）+ 平衡测试（机器人自动玩）。空闲时约 8 秒，几路同时跑、冷编译时 20 秒以上（2026-10-30：768 条，7.6 秒） |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 构建到 `dist/`（相对路径，放到任何静态托管的任何子路径下都能打开） |
| `npm run smoke` | 构建 → 预览 → 本机 Chrome 无头打开 → 逐项断言（含一夜的收尾和登记簿、触屏点击、390 px 宽），截图在 `shots/`。加 `-- --webgl` 测 WebGL2 回退路径 |
| `node scripts/perf.mjs` | 放满 4 个访客量帧时间，看自动降档。`--cpu` 用纯 CPU 软件渲染模拟最差的机器，`--low` 测 Low 档，`--empty` 是没有访客的对照组 |

`npm run smoke` 和 `node scripts/perf.mjs` 的预览端口都写死 5738，几路同时跑会撞，见「已知问题」。

用 `./node_modules/.bin/<工具>` 而不是 `npx`：这台机器上 `npx` 可能会找到别的项目里的版本。

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

- **有鼠标和键盘（第三人称，你就是那只鬼）**：开场点一下锁定鼠标；WASD 飘（能穿墙），鼠标转向，滚轮调镜头远近（1–4 米）；准星对准 4 米内、看得见的物件点击附身；Esc 放开鼠标，点一下继续。访客看不见你，但你贴在他身后会让他发毛，贴得够近够久是一次「后颈一凉」。隔着墙看不到名牌，靠脚步声找人（戴耳机）
  - **手电**：访客只看得见手电照着的东西。你被照到时会变浓、变清楚（有一层很低的压力声），他会停下来盯着看，但不会被吓到。穿墙的「呼」会让附近的人回头、走过去查看（不涨恐惧值）
  - **现身**：右键或 F。附近的灯像坏灯泡一样暗两下，0.6 秒后你在原地显出一个暗色的人形，停 1.5 秒、慢慢抬头；看得见你的人被吓到，往后退，20 秒里绕开这一块。冷却 18 秒（准星外那圈很淡的弧）。现身期间你不能动，只能转视角；人在墙里时按了没反应（墙里谁也看不见你），也不扣冷却
  - **机关**：对着物件按住左键约 0.5 秒。设下的物件结一层薄霜、眼睛图标变空心、标签写「Trap set」（已经设了 2 个时再按住没反应，等其中一个发作或解除）；有人走近时它自己挑时机发作（摇椅、床、衣柜等他背对着；肖像、镜子、台灯等他的手电照到它；八音盒、厨房门有人听得见就响），60 秒没人来就解除，最多同时 2 个
  - **范围**：准星对着物件（4 米内、看得见）时，地上浮出它的范围，一条淡淡的霜线：线里面是会被它吓到（惊吓类：站在那儿看得见它的人，镜子和画像只算正面）或听见（引诱类）的地方，墙另一边不画。名牌上名字前的小眼睛亮着，就是你现在这一下会吓到他（引诱类是会引来他）：对着物件时指附身这个物件，没对着物件、现身就绪时指在原地现身；物件在冷却时眼睛是灰的。现身蓄力的 0.6 秒里，一圈霜线从脚下跑到 5 米外停住，冷却好了再往外呼一次。霜线在收夜、翻开登记簿时安静
  - **反馈**：出手以后，准星对着的标签第二行写结果：惊吓类 "Theo jumped" 或 "No one saw it"，引诱类 "Theo heard it" 或 "No one heard it"，停约 1.6 秒再回到冷却秒数。够不着（4–10 米、看得见）时标签写 "Too far away."，准星外圈变虚线。对着惊吓类物件时标签也写此刻有没有人看着（"Theo is watching" / "No one is watching"）；做不到的事（现身冷却中、在墙里现身、机关已经 2 个）会在准星下面说一句原因。访客害怕、或者被你贴近发毛时会呼白气（手电照着才看得清）
  - **登记簿**：右下角按钮栏左边的本子（开局以后才出现；第三人称要先 Esc 放开鼠标才点得到），随时能翻开；收夜那一页有 Keep haunting 和 Another night，半夜翻开写 "The night is not over."。翻开时模拟照跑
- **触屏设备（娃娃屋俯视）**：Q / E 旋转镜头，滚轮缩放；电脑上加 `?dollhouse` 也能用这个模式。范围霜线（线宽按屏幕像素换算）、结果标签在娃娃屋里也有
- M 静音，右下角可切画质
- 点泛着幽绿光的物件附身（第三人称里这层光压得很淡、只给 4 米内够得着的物件，娃娃屋不变）。**引诱**（八音盒、厨房门）发出声音，把听见的人引过去；**惊吓**（台灯、摇椅、肖像、落地镜、卧室的床和衣柜）必须被人看见才生效，物件上方的眼睛图标亮着就说明此刻有人看得见
- 核心套路：先引诱，再惊吓。八音盒和卧室台灯是一对，厨房门和摇椅是一对

## 访客模型：吉祥物换装（Tripo 流水线）

`scripts/tripo/visitors.mjs` 把翠宝换上万圣节服装、建 3D、绑骨、套动作，导出到 `public/assets/visitors/<id>.glb`。清单和每一步的参数在 `scripts/tripo/visitors.json`，选模型的依据在 `docs/research/2026-10-28-glimmerby-api-models.md`。

1. 换装图（Tripo image-to-image）：`node scripts/tripo/visitors.mjs --run all --yes --until costume`，图在 `assets-src/visitors/<id>/costume.png`
2. 修图（公司素材中台 vmc）：把手改回三指加拇指、去掉多出来的配件。挑好的图复制成 `assets-src/visitors/<id>/touchup.png`，母版留在 `assets/generated/vmc/<任务ID>/`
3. 满意后把清单里这个访客的 `status` 改成 `approved`，再 `--run <id> --yes`：四视图 → 3D（P2-20260801）→ 绑骨检查 → 绑骨 → 4 个动作 → 导出
4. 导出前自动用本机 Blender 精修（`scripts/blender/refine.mjs`，可以单独跑）：球身、帽子、披风整块跟着躯干，挂在腿边的配件不跟着腿拉伸，同时清碎片、限面数和贴图、去根运动。预览表在 `assets-src/visitors/<id>/refine-preview/<id>-sheet.png`，第一行是权重：蓝色跟身体，橙色跟腿和手臂
5. 不联网的自测：`node scripts/tripo/selftest.mjs`。先看要花多少：`--dry-run`

导出后在 `src/config/character.ts` 的 `VISITOR_SPECS` 里登记（片段名照 `public/assets/visitors/manifest.json` 填），再用 `/dev/characters.html?visitor=<id>` 跑 `await __chars.calibrate()` 量朝向和步频（腿很短的模型它会把小腿当成脚，run、flee 量偏，见 `character.ts` 里联名两套的注释）。开场按钮只等第一套；其余几套开场后边玩边下载，编好管线才加入轮换（WebGL2 上点了开始以后等它们加完再开场，最多 30 秒）。进门的人接着上一个人往下轮，相邻两人穿得不一样；一套都加载不到时用占位狐狸（`?fox` 强制只用狐狸）。联名的两套登记在 `COLLAB_SPECS`，默认加进来，插在第一套后面（`?nocollab` 不加；`COLLAB=0` 构建里没有，见 `vite.config.ts`）。

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

- 第二波里有两路还没合进来，在修复轮和审查里：光（手电的反弹光、看得见的天亮、墙后的镜头整片溶开、墙纸地板做旧）和鬼魂和雾（手电照出鬼魂时近处淡出、现身推开地面的雾、娃娃屋屋外的雾压淡、鬼魂挡住访客时淡下去）。这份 README 写的都是已经在 `feat/night-onboarding` 上的；那两路合并后的样子写在看样清单里（第 12、17–20 节，标「会怎样」）。合并以后这一条删掉
- 门厅和走廊没有物件，新访客要走进房间才会被吓（布局调整的取舍，见设计文档）
- 平衡是机器人测出来的：会玩的机器人每 5 分钟吓跑约 11 人（`tests/balance.test.ts` 的报告，2026-10-30）。机器人对局不调 `World.close` / `World.dawn`，测的是不收夜的沙盒局；真正的一夜 3 分 20 秒以后就没人再来，天亮自己走的不算吓跑，吓跑的会少一些。真人大概也会慢一些，需要试玩确认
- 门廊灯不投影，门厅地板靠南墙处有一点暖光
- 开场按钮只等房子和第一套访客造型（开场前下载 2.83 MB，2026-10-29 限速实测：50 Mbps 约 4.5 秒、10 Mbps 约 6.1 秒、4 Mbps 约 9.7 秒可用）；别的房间的物体在后台编，这之前点了开始，开场遮罩会留着、按钮写「The candles are almost lit…」（这段时间鼠标和键盘不动鬼魂，开场的镜头不会被晃走），编完才开场。其余几套造型开场后边玩边下载（5.30 MB），编好管线才加入轮换，加入时不卡（`node scripts/stall-outfits.mjs` 探针）。编管线用到了 three r186 的内部接口：升级 three 以后对不上会在控制台警告一次，并且要重跑这个探针（WebGPU 和 `--webgl` 各一次）。真实时间试玩量到的等待（机器上有别的负载，偏大）：WebGPU 打开网页 5.8–8.5 秒按钮可用，从按钮可用到真正开局 9.5–14.2 秒，什么时候点都一样；WebGL2 打开网页 19.4 秒才可用，点了再等 8.9 秒；按钮可用以后主线程还有 1.3–1.8 秒的长任务，这时点击会慢半拍（`qa-playtest.md` P2-5，要不要让按钮等编完再亮见看样清单第 11 节）
- Another night 是整页重新载入：标题页加载 8.1 秒、点开始后再等 9.1 秒，约 20 秒才重新开局（`qa-playtest.md` 局 1b、P2-6；`src/night.ts` 的 `anotherNight` 走 `reload`）。这一轮保留（稳）；要根治得做不重载的重开（重建 world、各视图复位），工作量大，留到上线后
- 访客的材质同一套造型的人共用（透明度按物体传），这样预编译编过的管线进门时直接能用。以前每人复制一份，每个新访客进门都要现编。例外是手电的阴影图材质（`ShadowMaterial`）：每个新访客进门约 0.6 秒后还会现编 1–3 条，WebGPU 上没引起长帧，WebGL2 第一位进门那一帧 83 ms；手机横屏衣柜「手指」那一下也有 167 + 117 ms 的长帧，QA 一并记在这一条（`qa-playtest.md` P2-10；`src/view/characters.ts` 里写明了这个取舍）。要再省，就让开局前每套造型都投一次影
- 第一次飞到落地镜跟前可能有一下约 0.13 秒（只有第一次，原因没查到）
- 附身台灯、访客紧张时的手电原来都超过「灯闪每秒最多 3 下」（防光敏，WCAG 2.3.1），2026-10-29 改成不超过（`src/view/props/lamp.ts` 的 `LAMP_PATTERN`、`src/view/flashlight.ts` 的 `TORCH.nervous`），`?oldflicker` 对比旧的。台灯和附近的现身叠在一起时也不超过：台灯自己在闪（附身、复原）时现身的压暗不叠上去；前后脚接上时（现身蓄力后不到 1 秒附身台灯、台灯刚复原就现身，原来会到每秒 4–5 下），台灯不跟着现身的蓄力、收那两下，只跟着落下、停留暗。代价是蓄力那 0.6 秒台灯不再跟着暗两下（门廊灯、手电照旧），看样时确认。门廊灯平时的摇曳压到单独数不出来（`src/view/house.ts` 的 `porchFlicker`）。台灯平时的轻闪也压到数不出来（`BLIP_DEPTH`，原来附身前刚好轻闪完一下时会凑成 4 下，约万分之七的附身时刻；防光敏优先，轻闪看起来更轻一点）
- 平衡里几条不变量余量很薄（`BALANCE_REPORT=1 ./node_modules/.bin/vitest run tests/balance.test.ts --hookTimeout=120000 --reporter=verbose` 会打出余量，2026-10-30：第三人称中位存活余 1.0 秒、加鬼魂吓跑的倍数余 1.2、会用引诱的多 1 局，只靠现身把单个 brave 5 分钟内吓跑的余量是 0：10 局正好 10 局）。机器人用固定种子，不会随机失败，但改模拟时容易翻。穿墙声先不涨恐惧值（用户 2026-10-29），鬼魂本身的威胁主要靠现身。衣柜当机关是背后型（用户 2026-10-29 定的），机器人测平衡时不用它当机关：真人用它连着吓胆大的会不会太强，要试玩看
- 骷髅的后背是纯黑的（四视图生成时只在正面画了骨头）；要的话可以单独改背面那张视图（约 5 积分）再重做 3D
- 性能：本机显卡上 4 个访客满载约 7 ms/帧；纯 CPU 软件渲染下 Low 档约 8 fps（最差情况）。场景约 14 盏灯，每个像素都要算一遍，开销主要和分辨率成正比，所以 Low 档按 75% 分辨率渲染。这一夜各路在几路同时占着机器时量到 `--cpu` 下 Low 档每帧约 215–385 毫秒，比这里写的慢；各路自己改前改后的对比都在 ±10% 以内，分不清是改动还是负载，合并后在机器空闲时重量（`lane-AF-report.md`、`lane-GF-report.md` 的 perf 一节）
- 一夜的收尾有几处还没定：Keep haunting 以后钟点接着往后走（`clockAt` 按模拟时间的绝对值换算），第二夜到天亮时登记簿会写成下午的钟点（集成审查里的例子是 "walked out at 3:20 pm, as the sky paled"，`integration-review.md` Minor 5）；登记簿翻开时模拟照跑，访客照常走、一夜的钟也照走（`src/main.ts` 里 `world.step` 不看 `registerView.isOpen`，`lane-NC-report.md` 顾虑）；天亮自己出门的人，关门声没降电平（`src/audio/sfx.ts` 的 `exitDoor` 不看 `exit.calm`）；一群人出门只响一声，是单测和真模拟对出来的，没人耳听过（`integration-review.md` 无法验证 1）。要你定的在看样清单第 11、14 节
- 前门门洞里两个逃跑的人迎面会互相卡住，是这一夜之前就有的毛病，没有根治：现在靠 `src/sim/world.ts` 的 `WEDGE_SECONDS`、`WEDGE_MOVE` 兜底（要出门的人 8 秒挪不到半米就放走，只管逃跑的和天亮自己走的）。机器人玩 600 个夜没碰到过，真人连着在门厅吓人时不一定；从根上修会改默认行为、要重跑平衡，留到上线后（`lane-NS-review.md`、`lane-NS-rereview-1.md`）
- 范围显示有几处边界：现身那一圈画到 5 米（`MANIFEST.noticeRadius`，会转过来的人），落下时的结算是 6 米（`MANIFEST.range`），5–6 米之间手电正好朝着现身点的人会被吓到却在圈外，所以「圈外一定安全」不成立；物件的霜线假定访客正看着那里，手电没朝着的人真结算时不会被吓（`lane-RF-review.md` 风险 1）。名牌上的小眼睛有几个边角只说对一半：蓄势定住的人（`transfixOn`）现身时转向的是那个物件，眼睛仍算他会转过来；天亮往外走的人听得见引诱声但不会走过来；5–6 米那一圈会随访客手电扫过一开一合，没有迟滞；调试的 `endNight()` 在屋里有人时名牌上还会亮眼睛（`lane-AF-report.md` 顾虑 3、4、9，`lane-AF-review.md` Minor 6）
- 播报栏满了（`TICKER.max`，4 行）又都是要紧的行（吓到、逃跑、出门）时，新来的安静行直接不进栏：收夜、天亮、最后一位进门那几句旁白，在一阵吓人的尾声里可能整句看不到（`lane-AF-review.md` Minor 5；收夜那一句的亮度和停留另一路在改，`qa-playtest.md` P2-2，改完再看这一条还成不成立）。现身落下时合并的那一行 "Theo, June and 4 others flinched at a scream" 会把同一步已经有 "saw you" 行的人也算进去，内容没错，有点重复（`lane-AF-report.md` 顾虑 6）
- 物件幽光的「够得着才亮」读的是 `ghostDissolve.ghost`（`src/view/walls.ts` 导出、`src/view/house.ts` 每帧写）：`?noghostfx` 时它不写，物件就不按远近淡，拿它做对照会被带偏；`modules` 里 house 排在 props 前，换了顺序只是晚一帧（`lane-AF-review.md` 风险 5）
- 现身没吓到人时什么都不说：准星处的结果标签只管物件（惊吓类、引诱类），现身落空没有任何回应；QA 两次落空都是这样（`qa-playtest.md` 的「范围显示的基线」；`src/view/overlays.ts` 的 `createOutcomeWatch` 只记物件）。要不要加一句，见看样清单第 16 节
- 后处理的小瑕疵：AO 在鞋缘有 1–2 像素的暗边（半分辨率的 AO 图双线性上采样），台灯后面的墙上有一小块 ≤ 6% 的暗斑（灯离墙不到 0.64 米，AO 压了灯自己点光照亮的墙）（`lane-PX-review.md` M-9）。泛光收紧以后镜子「化开」的冷光边不再晕、台灯电压冲高时泛光变大一点，QA 看过，两处都不突兀，建议保持现状（`qa-playtest.md` 定点检查 2）；白气在 QA 的截图里不显眼，没法评价
- 试玩（`.superpowers/sdd/2026-10-29-wardrobe-collab-polish/ux-playtest.md`）里没做的 P2 还在：触屏没有机关（`src/engine/picking.ts` 的娃娃屋拾取器注释写明点一下只会附身）；Esc 放开鼠标时模拟不暂停；鼠标灵敏度固定（`ghostRig.ts` 的 `sens`）、不能反转 Y 轴；没开声音的人找人更慢，标题只写 `Put on headphones.`
- `scripts/perf.mjs`、`scripts/smoke.mjs` 的预览端口写死 5738（`PORT`），几路同时跑会撞：smoke 开头会先等端口空出来（最多约 2 分钟），perf 不等，会连到别人的预览服务器上去量别人的构建。这一夜各路都拷一份改了端口再跑（`lane-PX-report.md` 顾虑 5、`lane-LT-report.md` 的 perf 一节）；要根治就把端口做成参数。全套测试在几路同时跑、冷编译时偶发超时（负载下整套 20 秒以上），已把 `vitest.config.ts` 的 `testTimeout` 放到 30 秒、两条墙钟断言改成热身后取最快一段（`10f0cb4`）；`npm test` 偶尔红一条、重跑就好时，先看是不是负载（`integration-report.md` 第 7 节）

## 部署前还要做的

- 选托管平台并部署（需要你同意）。`npm run build` 的 `dist/` 是纯静态文件，放哪儿都行
- 联名皮肤（JOJO）：2026-10-30 用户定公开构建也带（授权由用户负责），默认的 `npm run build` 就带；要去掉用 `COLLAB=0 npm run build`
- 确定域名后，在 `index.html` 加 `og:image`（完整的绝对地址，1200×630 的游戏截图），分享链接时才有预览图
- 换模型、改访客之后重跑 `npm run smoke` 和 `node scripts/perf.mjs`（四套访客满载：High、Low 都是 60 fps，最长一帧 17.5 ms，2026-10-29）
- 开场时间用 `node scripts/loadtime.mjs` 量（三档限速，见上面「已知问题」里的数）；托管平台要对 `.glb` 开压缩或者至少开长缓存
- 光、鬼魂和雾两路合并以后，在合并后的构建上整套重量一遍：`npm run smoke`（WebGPU、`--webgl` 各一遍；第一波集成后两边各 53 项全过，`integration-report.md` 第 6 节；第二波各路合并之后，进度记录 `progress.md` 里没有整套重跑的记录）、`node scripts/perf.mjs`（High、Low、`--cpu`，要在机器空闲时量）、卡顿探针 `node scripts/stall-outfits.mjs`（第一次对准物件、现身、冷却好了呼气、墙上影子出现、前门推开，这几个「第一次」都不能现编管线；各路在自己的构建上量过，合并构建上还没跑，`lane-RF-review.md` ⚠️1）
- 叠起来的灯闪：反弹光、台灯、现身蓄力和落下、门廊灯慢熄、天亮、雾圈、手电紧张闪烁，在同一秒里叠起来会不会超过 3 下（`countDips`）。QA 测的构建（b865768，不含 AF、RF、光、鬼魂和雾）里，三整夜每盏灯任意 1 秒最多暗 3 下、没有超过；到 3 下的地方是第一次现身时离得近的两支手电和门廊灯、附身的台灯，正好卡在上限上，以后在现身附近再叠任何会暗的东西都要重新数（`qa-playtest.md`）。各路只测了自己那一份和少数组合，合并以后要整体再看一遍（`final-review-brief.md` 的第 2 点）
- 合并以后再整局真实时间玩一轮（`role-qa-brief.md`，带 `?pipelog`）：第一轮 QA（`qa-playtest.md`，测的构建 b865768，不含 AF、RF、光、鬼魂和雾）没有 P0；P1 两条（物件吓人很难对上、积极玩时墙上的影子不出现）和多数 P2 另一路在修；局 1 里 3:57 那一下 0.48 秒的停顿没复现，要继续盯
- 整体审查（`final-review-brief.md`，报告放 `final-review.md`）还没出，出来以后分诊里「上线前要修」的几条要办完，这一条再更新
