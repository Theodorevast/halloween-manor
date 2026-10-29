# 最终全分支审查：feat/manifest-ai-props（67427c4..29d4799，29 个提交）

范围和做法：这次只看各路审查看不到的部分：跨路契约、时序、全局约束、任务 I 的接线（5c65439、d5225b8、29d4799）。读过的代码：`src/main.ts`；`src/sim/{world,manifest,traps,types,scares,perception,grid}.ts` 和 `npc.ts` 的差异；`src/view/{ghost,lightfx,frost,flashlight,torches,props,overlays,characters,particles}.ts`、`props/bed.ts` 的差异；`src/audio/{engine,ghost,sfx,breath}.ts`；`src/engine/{ghostRig,picking,types}.ts`、`src/ui/hud.ts`、`strings.ts`、`styles.css`、`debug.ts`、`scripts/smoke.mjs`，以及各路的审查报告和 `final-deferred.md`。没有改工作区，没有跑测试套件。只用 node 算了一下灯闪的次数（见 Minor 4）。

### Strengths

1. **现身三个节拍的契约是稳的。** 模拟里 windup → drop → end 一定成套、按顺序发（`src/sim/manifest.ts:39-72`、`world.ts:149-183`）。画面和声音都按事件走，各自都有兜底：画面漏了 drop 时，按 `state.manifest` 补上换材质（`src/view/ghost.ts:1101-1107`）；声音没收到 end 时，持续音和环境声让路在 `MANIFEST_SFX.maxLife` 之后自己收（`src/audio/ghost.ts:213`、`:281`、`:294`）。
2. **各模块的时刻对得上。** 灯闪效果、霜的起点、鬼魂换材质都从事件之后第一次 update 的那一帧开始算，是同一帧（`lightfx.ts:269`、`frost.ts:181-186`、`ghost.ts:1095`）。抬头按模拟的 `man.t` 走（`ghost.ts:1118`），hit-stop 时会和模拟一起停。落下那一批里有人被吓跑时，冲击让给吓跑的 braam，冷气挪到静音之后（`engine.ts:373-380`）。咔哒的 0.2 / 0.4 秒正好落在节奏表里两个 a 的位置。床塌下的时刻等于 `hitAt`，有测试钉住（`tests/bed.test.ts:33-35`）；床的声音时间线也读 `SCARES.bed.hitAt`。
3. **定住的写法不会让现身位置漂。** `pin` 一开就把速度清零，不再滑（`ghostRig.ts` 的 `|| pinned) vx = vz = 0`）。模拟用的是上一次 `setGhost` 的位置，和画面最多差一帧，约 4 厘米。
4. **手电登记表分工清楚。** 每支手电一个槽，只有它自己写（`flashlight.ts:121`、`:243-246`）。模块顺序是 characters → ghost → lightfx，所以鬼魂和灯闪读到的都是同一帧的手电位置；`torchDim` 晚一帧生效，看不出来。任务 I 把照出的范围改成模拟的 VISION（`ghost.ts:436`、`:448`、`:501`），「实」那份被照亮的一面仍按真灯算（`torchIrradiance`）。审查里的 4c（7–9 米照得出、访客却不察觉）这样就没了。
5. **机关状态只有一个来源。** 标记、霜、标签都每帧读 `state.objects[].armed`（`overlays.ts:313`、`:344`；`props.ts:225`）。所以「附身让机关作废但不发事件」影响不到画面。
6. **object 为 'ghost' 的 startle 对每个消费者都安全。** 滚动提示按物件名查不到就不播（`hud.ts:105-111`），现身另外播「saw you in the dark」（`hud.ts:362`）。声音只把 chill(neck) 当成后颈一凉（`engine.ts:298`），现身落下的 startle 照常倒吸气或尖叫。
7. **娃娃屋模式隔离得干净。** 没有 ghost rig 就不建鬼魂、lightfx、frost（`main.ts:164`、`:173`）；`onArm` 是空函数（`picking.ts:275`）；`setGhost(null)` 让 `manifest()` 永远返回 false；冷却环只在锁定指针时显示。
8. **全局约束都守住了。** 没有加新灯（唯一新建的 SpotLight 在开发页 `dev/props.ts`）。`src/sim/` 不引用 three.js。新的英文文案只在 `strings.ts`，注释是中文。灯闪不全灭（`minLevel` 0.1、`floor` 0.3），也不冲高：节奏表只用到 m 和比 m 暗的字母。「蓄力节奏 + 落下 + 收」任意 1 秒内不超过 3 下，有测试（`tests/lightfx.test.ts`）。新材质都标了 `deferCompile`，首次现身实测没有超过 50 ms 的帧。

### Issues

#### Critical (must fix before merge)

无。

#### Important (should fix before merge)

无。

#### Minor

**1. 跨路手抄对齐的几个时刻，没有测试把两边连起来。**
- 位置：`src/audio/ghost.ts:210` 的 `MANIFEST_SFX.clicks: [0.2, 0.4]` 对应 `src/view/ghost.ts:150` 的 `GHOST.manifest.windup`（两个 a 在 0.2、0.4 秒）；`src/audio/sfx.ts:1199`、`:1206` 的 `BED.rise` / `breathAt` 对应 `src/view/props/bed.ts:22-37` 的 `BED_TIMELINE`；`src/view/frost.ts:19` 的 `FROST.big.hold: 1.5` 对应 `MANIFEST.hold`。
- 现状：现在三处都对得上。但 `tests/audio.test.ts:90-98` 只查咔哒在蓄力段之内，床那边只钉了 collapse = hitAt。
- 为什么要管：10/30 上午看样的第 2、3、4 项（现身、灯闪的节奏、床）调的正是这几个数。只改画面一边，咔哒就会响在灯没暗的时候，布料声和鼓包会错开，霜会在收回之前就化。玩家看得出、听得出。
- 修法：加一条 vitest（两边的模块都已经能在 vitest 里 import：`tests/lightfx.test.ts` 引了 `view/ghost`，`tests/bed.test.ts` 引了 `props/bed`）：
  - 从 `GHOST.manifest.windup` 里算出 `MANIFEST.windup` 秒内每次「从 m 掉下去」的时刻，等于 `clicks`；
  - `BED.rise` 三段的起点 ≈ `BED_TIMELINE.rise` 三段的起点；
  - `FROST.big.hold` 直接改成引用 `MANIFEST.hold`。
- 约 15 分钟，最好在看样调参之前做。

**2. 机关满 2 个时，再按住第三个没有任何反馈。**
- 位置：`src/sim/world.ts:319-324` 的 `arm()` 返回 false，不发事件；第三个物件的悬停标签照样写「Ready」（`src/view/overlays.ts:344-347`）；没有声音，也不结霜。
- 为什么要管：这符合规格（`TRAP.max = 2`），但试玩时最容易碰上：设了两个，再去设第三个。看起来就像「按住失灵了」。
- 修法：试玩前先告诉用户「最多 2 个，满了按住没反应」。之后可以在悬停标签里加一档：`strings.ts` 加一条，比如 `trapsFull: 'Two traps already set'`，`overlays.ts:347` 在已满且这个物件没设时用它。要不要加，看用户试完再定。

**3. 鬼魂中心在墙格里时现身，谁也吓不到，冷却照样扣。**
- 位置：`src/sim/world.ts:314-317` 的 `manifest()` 不看鬼魂在哪。落下时的 `canSee` 走 `src/sim/grid.ts:53`，视线检查连终点格一起算，终点是墙格就看不见。蓄力时的察觉（`world.ts:156-160`）只看距离、不看视线。
- 结果：在墙里按 F，灯照样闪、霜照样长，实体半截嵌在墙里；附近的人回头盯着墙，但没有人被吓到，18 秒冷却白扣。
- 为什么要管：鬼魂本来就常贴着墙、在墙里埋伏，玩家会以为现身不灵。
- 修法：交给试玩定。最省事的做法：鬼魂所在格不透光时，`manifest()` 返回 false。

**4. 原有的「紧张时手电闪」也超过了每秒 3 下，和 LAMP_FLICKER 是同一类问题。**
- 位置：`src/view/flashlight.ts:207-209`（分支开始前就有，67427c4 的 `:187-189`）。恐惧值 ≥ 60 的访客，手电强度是 `1 − 0.22 × min(1, n + dip)`。
- 实测：用 `lightfx.ts` 自己的 `countDips`（掉 0.1 算一次）按 60 Hz 数，100 个随机种子里，任意 1 秒最多 4–5 下（84 个种子是 4 下，16 个是 5 下），平均 30 秒 62 下。现身蓄力时，它和 lightfx 的压暗是相乘的（`flashlight.ts:220-221`）。
- 为什么要管：这一轮定了「灯闪每秒不超过 3 次（WCAG 2.3.1）」，但测试只守了现身的节奏表。紧张访客的手电在第三人称里离镜头很近，光斑不小。这不是这一轮引入的。
- 修法：和 LAMP_FLICKER 一起问用户，一次定。改法有两种：深度压到 0.1 以下（`TORCH.nervous.flicker` 0.22 → 约 0.08），或者把两个正弦换成每秒不超过 3 次的节奏表。再补一条 `countDips` 测试。

**5. 过时的注释和没人用的代码。**
- `src/sim/world.ts:229` 还写着穿墙声「涨一点点恐惧值」，但 `GHOST.hearFear` 已经是 0（也就是 S 路复审的 R2）。
- `src/view/props.ts:44` 还写着「V 路的 frost.small 还没合入，先用……」。V 路早已合入，用外壳现在是定案。
- `src/view/frost.ts` 的 `small()` 和 `FROST.small` 没有调用者。
- 修法：改两行注释；`frost.small` 留着的话，在注释里写明「现在不用，机关提示用 props.ts 的外壳」。

**6. 访客模型多了 1.37 MB，而且要全部下载完开场按钮才可用。**
- 位置：`public/assets/visitors/*.glb` 四套从 6.02 MB 涨到 7.39 MB（+23%，每套多了 4 段动作）；`src/view/characters.ts:412` 用 `Promise.allSettled` 等全部加载完才算 ready。
- 为什么要管：本机冷启动看不出来（走的是本地服务器），上线后慢网要多等：10 Mbps 下约 1.1 秒。冷启动预算本来就贴着边。
- 修法：上线时确认托管平台对 `.glb` 开了 gzip / brotli（动画数据压缩率很高），以后再考虑关键帧量化或 meshopt。不挡合并。

**7. 停留那 1.5 秒的持续帧率没有量过。**
- 位置：「实」的那份（`src/view/ghost.ts:555` 起，每个片元要算 4 支手电 × 两个光锥，外加 `pow` / `acos`，见 `torchIrradiance` `:468` 起）只在停留时画。
- 现状：`.logs/stall-manifest.mjs` 只记超过 50 ms 的帧，只跑了 WebGPU，只放了一个访客；`scripts/perf.mjs` 既不触发现身，也不设机关。
- 为什么要管：Low 档或 WebGL2 回退的慢机器上，停留那 1.5 秒可能掉到 60 fps 以下。时间很短，风险低。
- 修法：上线前在 Low 和 `?webgl` 下各量一次：四个访客满载、设两个机关、现身一次，看停留期间的平均帧时间。

**8. 「手电照到鬼魂时那个人倒吸一口气」是 U 路自己加的。**
- 位置：`src/audio/engine.ts:387-394`（`NOTICE_GAP = 4`，`:90`）。
- 现状：设计 3.1 只写了压力声。U 路审查已经说过「可以留，要主会话或用户点头」，但不在这次交给我的「已知待办」里。
- 修法：放进看样清单；用户不要的话，把 `NOTICE_GAP` 设成 0 就关掉了。

### Deferred-minor triage

| 条目 | 裁定 | 理由 |
|---|---|---|
| **任务 1** | | |
| T1 M-1 床的幽光外壳看不见 | drop | P1 已修（lane-P-review 说「M-1 确实修好了」） |
| T1 M-2 被子范围的两条提醒 | drop | P1 已照做：lift 0、垂边，悬停时床不放大（`props.ts` 的 `NO_HOVER_SCALE`） |
| T1 M-3 两处范围外改动 | drop | 已披露，只是记一笔 |
| T1 M-4 investigateDist 两份来源 | drop | 已并成 `TRAITS` 一份，`BEHAVIOR.investigateDist` 删掉了 |
| T1 M-5 TRIGGER 改成 Partial | drop | 已改回 `Record`（`sfx.ts:1351`），调用处不再带 `?.` |
| T1 M-6 默认 ManifestState 字面量六份 | drop | 已有 `idleManifest()`，world 和五个开发页都用它 |
| **M 路** | | |
| M-1 Blender 合并保护失败时放行 | fix later | 只在重跑流水线时才会出事；现有四套 GLB 已核过（8 段 × 69 条通道） |
| M-2 `character.ts:89` 注释说过头 | fix later | 只是注释 |
| M-3 `loops` 的类型比实现宽 | fix later | 现在只有 flee 用；收窄类型就行 |
| M-4 FLEE_LOOP / fleeRateAt1ms 和预设绑死 | fix later | 换预设才会出事；加载时查一下区间在不在片段时长内 |
| M-5 分批组成和 reroll 的小坑 | fix later | 流水线遇到这种情况会停下来要求 `--reroll`，不会悄悄花积分；写进 HELP 即可 |
| M-6 新的混合规则没有测试 | fix later | 只缺测试 |
| **P 路** | | |
| P-2 tick 先发回调、后排下一帧 | fix later | 现在的回调（`world.arm` / `trigger`、`setHover`）不会抛错；以后顺手把 `requestAnimationFrame` 挪到 `picking.ts:348-354` 的最前面 |
| P-3 卡顿会把短按读成长按 | fix later | 要在按下和松开之间正好卡住 0.4 秒以上才会发生；自然游玩实测没有超过 100 ms 的帧 |
| P-4 DOM 接线没有测试 | fix later | 修复轮已经把按键判定抽成 `createHoldInput` 并补了测试，剩下的只是几行 `addEventListener` |
| P-5 空心眼睛用行内样式 | fix later | 代码整洁问题；改成 `styles.css` 里的 `.ov-mark.is-armed .ov-eye` |
| P-6 床扬灰复制了肖像的逻辑 | fix later | 等加第三个（衣柜）时再整理成一张表 |
| P-7 两处注释 / 测试标题不准 | fix later | 只是注释 |
| **V 路** | | |
| V-M1 「实」的那份不写深度 | fix later | 停留时，身后的冷雾会画到实体上面，显得不够实。看样时看一眼；换成 GLB 模型之前必须修 |
| V-M2 没用过的手电槽 smoothstep 两端相等 | drop | 已不存在：照出改用常量 `SEE_COS`（`ghost.ts:448`），照度那边夹到 0.9999（`:483`） |
| V-M3 霜带一点自发光 | fix later | 和墙上的霜一致。「不发光」要不要连这一点也去掉，看样时问用户；机关提示的外壳也是一样 |
| V-M4 手电镜片不跟着暗 | fix later | 只是一个很小的亮点 |
| V-M5 分槽超过 4 支时悄悄回绕 | fix later | 现在走不到（`TORCH_SLOTS = SPAWN.target + 1 = 4`）；加一条 warn 即可 |
| V-M6 影子网格每帧进所有手电的阴影图 | drop | 满载 High / Low 已量过 60 fps；真要省再做 |
| V 复审：`?solid` 只在开发页能切 | drop | 任务 I 已接进正式页（`main.ts:168-170`） |
| V 复审：亮面不封顶 | fix later | 1 米内偏亮；看样时用户嫌亮，再加一行 `min(…, 0.3)` |
| V 复审：「实」那份的片元开销没量 | fix later | 见本报告 Minor 7 |
| V 复审：torchReveal 两端夹 0.9999 | drop | 同 V-M2，已经不需要了 |
| V 复审：绿色细边是原有的高亮 | drop | 只是信息 |
| V 复审：LAMP_FLICKER 1.2 秒 9 下 | 用户定（已在待问清单里） | 原有问题；连同本报告 Minor 4 的手电一起问 |
| **U 路**（11 条，见 lane-U-review.md） | | |
| U M-1 现身冲击让路的条件比 braam 去重宽 | fix later | 要 0.8 秒内先有人吓跑、落下时又吓跑一个才会出现，那时上一声 braam 还没响完；条件改成「这一批真的放了 braam」，一行 |
| U M-2 lit 名单只靠 on / off 事件 | fix later | 只在 AudioContext 恢复中的那几帧丢事件时才会卡住；那个人下一次照到 / 移开、逃跑或离场时就自己好了。根治：`NpcState` 暴露 litGhost，sync 按它对 |
| U M-3 两次现身重叠时只记得最后一个持续音 | drop | 冷却 18 秒，走不到；也不泄漏 |
| U M-4 照到鬼魂的倒吸气没有并发上限 | fix later | 同一步里几个人同时照到时会齐声倒吸；试玩时听一下，嫌太齐就加上限 2 |
| U M-5 喘气实际约 1.5 米内才听得见 | fix later | 改文档或参数，看样时调 |
| U M-6 breath 和 space.update 共用一个 guard | fix later | 健壮性问题；现在不会抛错 |
| U M-7 压力声的节点一直在 | drop | 只有一组节点，开销可以忽略 |
| U M-8 环境声让路（A1）覆盖不全 | fix later | 设计上的可选项（床不压环境声、蓄力时喘气不屏住），看样时问用户 |
| U M-9 测试只守常量 | fix later | 只缺测试 |
| U M-10 试听按钮不全 | fix later | 只影响开发页；10/30 看样前补上呜咽、冷气、咔哒的单发按钮会省事 |
| U M-11 `at` 变量被遮蔽、开发页写死 60 | fix later | 小毛病 |
| **S 路** | | |
| S M1 / M2（hearFear、全局绕开圈） | drop | 用户 10/29 已裁定，并已照裁定实现 |
| S M3 附身让机关作废时不发事件 | drop | 消费者都读 `state.armed`（`overlays.ts:313`、`props.ts:225`），没有谁需要这个事件；在 `types.ts` 的 trap 事件注释里写一句就行 |
| S M4 fireTrap 失败时机关卡住 | fix later | 走不到：`armTrap` 要求冷却为 0；`triggerObject` 只在冷却 > 0 时失败，而会设冷却的只有它自己，设的同时也清掉 armed。以后动这里时再加固 |
| S M5 机器人统计落空率记错 | fix later | 只影响测试统计 |
| S M6 transfixPos 没有测试 | fix later | 逻辑是对的（end 和 beginFlee 都会清），只缺测试 |
| S M7 retreat 的两个小问题 | (a) fix later、(b) drop | (a) 进门途中或警觉中被吓到的人会丢掉原来的目标，但不会卡住；(b) MANIFEST.fear 的注释已改成「backOff 米以外被吓到的人不挪步」（`visitors.ts:268`） |
| S M8 照到鬼魂的察觉没有冷却 | fix later | 鬼魂站在一个正左右照的访客旁边，每 1.3–2.6 秒（sweepAmp 0.6、周期 2.6）他会重新停下盯一次。读起来像「又察觉到了」；试玩时看用户觉不觉得像卡顿，再决定加不加冷却 |
| S M9 「吓多少」测试的容差是绝对值 | fix later | 只影响测试 |
| S R1 全局 0.9 秒去抖没有测试钉住 | fix later | 只缺测试 |
| S R2 `world.ts:229` 的过期注释 | fix later | 只是注释（本报告 Minor 5） |
| S R3 「正数的 hear 会让回落重新计时」没有测试 | fix later | 只缺测试 |
| S R4 平衡有三条贴着界限 | 用户知情（已在待问清单里） | 固定种子，不会随机变红；见下面的补充 |
| S R5 types.ts 加了必填的 AvoidZone.who | drop | 纯加法的类型改动，各路都已跟上 |
| S 范围外：落下时先 startleWith、后放绕开圈 | fix later | 当场被吓跑的人，第一条逃跑路线不绕开那个圈。房间只有一扇门时，绕不绕都要从那里穿过去；只有另有路可走时才有差别。修法：把 `world.ts:171` 的 push 挪到 `:165` 的 forEach 之前 |

**对已知待办的补充（说法基本对，补几句）：**
- **LAMP_FLICKER**：问用户的时候，把紧张时的手电闪（Minor 4）一起带上，一次定。
- **平衡贴界**：看样时要定 `MANIFEST.fear`（20 还是 30）。「只靠现身比附身 + 现身慢」那条不变量在 30 时只有 0.1 秒余量（见 `visitors.ts` 里 MANIFEST.fear 的注释），用户选 30 的话它多半会变红。这是要和用户一起改不变量的决定，不是修 bug。改任何模拟参数前后都重跑 balance。
- **机关提示用外壳**：`frost.small` 和 `FROST.small` 现在没人用，`props.ts:44` 的注释还写着「还没合入」。
- **冷启动**：多出的 0.3–0.5 秒主要在阻塞的预编译里（鬼魂着色器加了照出）；上线时还要加上 GLB 多出的 1.37 MB（Minor 6）。机器空闲时再量一次。
- **合并**：master 就是 67427c4，没有分叉，可以直接快进。合完记得清掉五个 lane worktree（`万圣节-lanes/{S,V,P,U,M}`）和对应的分支。

### Assessment

**Ready to merge? Yes**：没有 Critical / Important。跨路的事件和状态契约、各模块的时刻、娃娃屋模式、全局约束都对得上，延后的 Minor 里没有一条需要合并前修。建议在 10/30 看样调参之前加上 Minor 1 那条跨路测试；试玩前告诉用户两件事：机关最多 2 个（Minor 2），在墙里现身无效（Minor 3）。
