# Halloween Manor

万圣节网页小游戏：你是一只鬼，从斜俯视的上帝视角看着一栋黑暗的老宅，附身屋里的物件，把拿着手电筒的访客吓得尖叫着逃出门。沙盒玩法，没有输赢。

- 设计：`docs/superpowers/specs/2026-10-26-haunted-house-design.md`（末尾「替用户做的决定」是待审清单）
- 实现计划：`docs/superpowers/plans/2026-10-27-haunted-house.md`
- 技术栈：Vite · TypeScript · three.js r186（`three/webgpu`，自动退回 WebGL2）· Web Audio（声音全部程序化合成）

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发服务器（这台机器上 5173 可能被占，可以加 `-- --port 5731 --strictPort`） |
| `npm test` | 模拟层单测 + 平衡测试（机器人自动玩，约 1–2 秒） |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 构建到 `dist/`（相对路径，放到任何静态托管的任何子路径下都能打开） |
| `npm run smoke` | 构建 → 预览 → 本机 Chrome 无头打开 → 逐项断言（含触屏点击、390 px 宽），截图在 `shots/`。加 `-- --webgl` 测 WebGL2 回退路径 |
| `node scripts/perf.mjs` | 放满 4 个访客量帧时间，看自动降档。`--cpu` 用纯 CPU 软件渲染模拟最差的机器，`--low` 测 Low 档，`--empty` 是没有访客的对照组 |

用 `./node_modules/.bin/<工具>` 而不是 `npx`：这台机器上 `npx` 可能会找到别的项目里的版本。

地址参数：
- `?debug` 挂出 `window.__haunt`：`state()` 看文字版状态，`step(ms)` 快进，`trigger(id)` 附身，`spawn({...})` 放访客，`setTimeScale(n)` 加速，`screenOf(id)` 取物件的屏幕坐标
- `?webgl` 强制走 WebGL2。有人反馈画面不对时，先让对方加上它，看是不是 WebGPU 的问题
- `?nofog` 关掉贴地雾气（对比效果、排查性能时用）
- `?noparticles` 关掉粒子（浮尘、粉尘、白气）
- `?dollhouse` 在电脑上也用娃娃屋俯视；`?noghostfx` 不画鬼魂和穿墙溶解，`?noceiling` 不加天花板（对比效果、排查性能时用）
- `?fx=-ao` 关掉部分后处理（`?fx=legacy` 回到旧管线）；`?gputime` 配合 `?debug` 读 GPU 时间：`__haunt.fx.gpu()`

## 玩法速览

- **有鼠标和键盘（第三人称，你就是那只鬼）**：开场点一下锁定鼠标；WASD 飘（能穿墙），鼠标转向，滚轮调镜头远近（1–4 米）；准星对准 4 米内、看得见的物件点击附身；Esc 放开鼠标，点一下继续。访客看不见你，但你贴在他身后会让他发毛，贴得够近够久是一次「后颈一凉」。隔着墙看不到名牌，靠脚步声找人（戴耳机）
- **触屏设备（娃娃屋俯视）**：Q / E 旋转镜头，滚轮缩放；电脑上加 `?dollhouse` 也能用这个模式
- M 静音，右下角可切画质
- 点泛着幽绿光的物件附身。**引诱**（八音盒、厨房门）发出声音，把听见的人引过去；**惊吓**（台灯、摇椅、肖像、落地镜）必须被人看见才生效，物件上方的眼睛图标亮着就说明此刻有人看得见
- 核心套路：先引诱，再惊吓。八音盒和卧室台灯是一对，厨房门和摇椅是一对

## 访客模型：吉祥物换装（Tripo 流水线）

`scripts/tripo/visitors.mjs` 把翠宝换上万圣节服装、建 3D、绑骨、套动作，导出到 `public/assets/visitors/<id>.glb`。清单和每一步的参数在 `scripts/tripo/visitors.json`，选模型的依据在 `docs/research/2026-10-28-glimmerby-api-models.md`。

1. 换装图（Tripo image-to-image）：`node scripts/tripo/visitors.mjs --run all --yes --until costume`，图在 `assets-src/visitors/<id>/costume.png`
2. 修图（公司素材中台 vmc）：把手改回三指加拇指、去掉多出来的配件。挑好的图复制成 `assets-src/visitors/<id>/touchup.png`，母版留在 `assets/generated/vmc/<任务ID>/`
3. 满意后把清单里这个访客的 `status` 改成 `approved`，再 `--run <id> --yes`：四视图 → 3D（P2-20260801）→ 绑骨检查 → 绑骨 → 4 个动作 → 导出
4. 导出前自动用本机 Blender 精修（`scripts/blender/refine.mjs`，可以单独跑）：球身、帽子、披风整块跟着躯干，挂在腿边的配件不跟着腿拉伸，同时清碎片、限面数和贴图、去根运动。预览表在 `assets-src/visitors/<id>/refine-preview/<id>-sheet.png`，第一行是权重：蓝色跟身体，橙色跟腿和手臂
5. 不联网的自测：`node scripts/tripo/selftest.mjs`。先看要花多少：`--dry-run`

导出后在 `src/config/character.ts` 的 `VISITOR_SPECS` 里登记（片段名照 `public/assets/visitors/manifest.json` 填）。有几套就按编号轮流分给进门的人；一套都加载不到时用占位狐狸。

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

- 占位狐狸身长约 2.15 米，在 2 米宽的走廊里显得太大；换成吉祥物后自然解决
- 门厅和走廊没有物件，新访客要走进房间才会被吓（布局调整的取舍，见设计文档）
- 平衡是机器人测出来的：会玩的机器人每 5 分钟吓跑约 9 人，真人大概会慢一些，需要试玩确认
- 门廊灯不投影，门厅地板靠南墙处有一点暖光
- 第一个访客进门时还有一下约 150 ms 的卡顿（只有第一次）。页面 JS 侧已经预编译过，剩下的开销在浏览器 GPU 进程里
- 别的房间的物体在开场按钮可用之后在后台编（约 4.5 秒）。玩家一出现开场按钮就点开始、马上飞到别的房间，头一两次可能还会卡 50–80 ms；第一次飞到落地镜跟前有一下约 0.13 秒（只有第一次，原因没查到）
- 性能：本机显卡上 4 个访客满载约 7 ms/帧；纯 CPU 软件渲染下 Low 档约 8 fps（最差情况）。场景约 14 盏灯，每个像素都要算一遍，开销主要和分辨率成正比，所以 Low 档按 75% 分辨率渲染

## 部署前还要做的

- 选托管平台并部署（需要你同意）。`npm run build` 的 `dist/` 是纯静态文件，放哪儿都行
- 确定域名后，在 `index.html` 加 `og:image`（完整的绝对地址，1200×630 的游戏截图），分享链接时才有预览图
- 换上吉祥物后重跑 `npm run smoke` 和 `node scripts/perf.mjs`
