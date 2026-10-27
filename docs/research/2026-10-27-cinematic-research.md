# 电影感与特效调研

> 日期：2026年10月27日
> 方法：三个调研子 agent 并行（agent-reach：Exa 搜索、Jina Reader、GitHub CLI；npm registry 核实版本），three 的结论来自本机 `node_modules/three`（0.186.1）源码
> 用途：给后续「电影感升级」选型和实现时查。【源】= 来源原话或源码；【推】= 调研者自己的推断

## 一、参考作品与手法

| 参考 | 学什么 |
|---|---|
| Bruno Simon folio-2025（GitHub `brunosimon/folio-2025`，three WebGPU + TSL，和本项目同栈） | 【源】长焦透视相机（25°）；焦点和缩放 `lerp(…, delta*10)`（约 0.1 秒时间常数）；撞击时镜头横滚弹簧；「电影镜头」模式下隐藏交互标记；移轴模糊 `hashBlur` 只在高档开；开场用世界坐标半径做「从中心显影」 |
| 《塞尔达传说：织梦岛》 | 【源】「窥视微缩模型」镜头；**模糊要按深度算，不能按屏幕位置画带子**（画面下沿按屏幕带子模糊被玩家批评，前景被错误虚化） |
| 《小小梦魇》 | 【源】娃娃屋镜头的目的：「几乎能把手伸进房间」「令人不安的窥视感」；【玩家观察】轻微的船一样的晃动 |
| Henry Heffernan 作品集（GitHub `henryjeff/portfolio-website`） | 【源】待机绕转周期约 78 秒；跟鼠标的目标点和位置用不同速度 lerp（约 0.33 秒和 0.66 秒）产生视差；转场 2 秒 `BezierEasing(0.13, 0.99, 0, 1)` |
| The Flashlight（bcube.ae，2026-10-14，浏览器万圣节鬼屋游戏） | 【源】手电 = 投影聚光 + 宽而暗的溢光 + 镜头前的小补光（最近的表面不会死黑）；一个合成 pass 做色调、「阴影冷、手电暖」调色、暗角、**暗处更强的胶片颗粒**；自适应画质先降分辨率、再降抗锯齿、最后降阴影；HRTF 声像、共享混响、心跳 56→175 bpm |
| Squirrel Eiserloh「Juicing Your Cameras With Math」（GDC 2016） | 【源】「创伤值」0–1，受击加 0.2–0.5，线性衰减；震动 = 创伤值² 或 ³ × 平滑噪声（不用随机数）；3D 里只用旋转；平滑 `x = 0.9x + 0.1·目标` |
| John Nesky「50 Game Camera Mistakes」（GDC 2014，《风之旅人》） | 【源】要避免：视野快速变化（#41）、快速切换机位（#45）、过度震动（#42）、给了控制又收回（#33）。【推】现在 0.12 秒 / 1.3 倍的推近接近 #41、#45 |
| Messenger（Abeto，2025，Awwwards 当日最佳） | 【源】玩家反映晕：镜头「像在糖浆里拖、然后突然加速」「过冲再修正」。教训：速度连续、不过冲、自动运镜要极慢 |
| Autofocus（Anderson Mancini，R3F） | 【源】读鼠标下或屏幕中心的深度，焦点 `smoothTime` 0.25 秒追过去；作者用一个鬼屋场景做过演示 |
| 平滑数学：Freya Holmér、camera-controls、maath | 【源】与帧率无关的写法 `lerp(a, b, 1 − exp(−decay·dt))`；SmoothDamp `smoothTime` 0.25 秒 |
| INSIDE、Hitman GO、Tiny Glade | 【源】景深只给游戏平面之后的东西；建筑模型 / 微缩风的美术方向；移轴拍照模式 |

## 二、three r186 内置效果（从源码核实）

### 必须先知道的坑

- **场景 pass 开着 4× MSAA**（`antialias: true`）。TRAA / TAAU 要 `pass(scene, cam, { samples: 0 })`，否则静默失效（issue #33314）
- **好几个深度工具默认按透视相机算**：`PassNode.getViewZNode()` / `getLinearDepthNode()`、`depthAwareBlur`（SSAO 自带的模糊）、`depthAwareBlend`、`SoftParticles`、`GodraysNode`、`VolumetricLightingModel`。正交相机要自己用 `orthographicDepthToViewZ(depth, near, far)`
- 正交相机下正确的：TRAA / TAAU、SSR、SSS、Outline、RecurrentDenoise；GTAO / SSAO 用投影逆矩阵重建位置，基本正确（GTAO 有一点透视偏差）
- 后处理全屏四边形里的 `cameraNear` / `cameraFar` 读的是四边形自己的正交相机（0 / 1），要用 `reference('near', 'float', rigCamera)`
- **降墙和物件幽光用 `positionNode` 改顶点，运动矢量会错**（`positionPrevious` 只有蒙皮、实例化等会更新）。要用 TRAA / TAAU / 运动模糊，先在这些 positionNode 里 `positionPrevious.assign(pos)`
- 透明物体会覆盖法线和速度缓冲（MRT 附件默认不混合）：雾、光锥、玻璃、幽光会盖掉后面不透明表面的值
- TRAA、TAAU、SSAO、GTAO、Godrays 等构造时要传真正的相机；现在 `createPostFx` 在相机建好之前就跑了，要改顺序或首帧再建
- r186 里**没有 TSL 版的移轴**（`TiltShiftShader.js` 只给旧的 WebGLRenderer）；`AnamorphicNode` 在 r185 删了

### 可用节点（`three/addons/tsl/display/`）

| 节点 | 用途 | 需要 | 开销（读代码估算） | 相关度 |
|---|---|---|---|---|
| `bloom` | 泛光，新增 `setResolutionScale`、每级 mip 着色 `bloomTintColors` | — | 半分辨率高通 + 5 级 mip 模糊 | 已在用 |
| `ssao`（r185 新增） | 环境光遮蔽，自带深度感知模糊 | 深度 + 法线 | 半分辨率 16 采样 + 2 遍 5 采样模糊，约为 GTAO 一半 | 高 |
| `ao`（GTAO） | 地平线环境光遮蔽 | 深度（+法线） | 默认全分辨率，36 次深度采样，要降噪或 TRAA | 中高 |
| `dof` | 景深（近 / 远散景） | viewZ | 7 次绘制，每像素约 40+ 次采样 | 中高（事件时用） |
| `traa` | 时间抗锯齿 | 深度 + 速度，关 MSAA | 1 次解析 + 拷贝 | 高（赋能项） |
| `taau`（r184 新增） | 时间抗锯齿 + 超分辨率 | 深度 + 速度，关 MSAA | 场景只着色 s² 的像素（0.6² ≈ 36%） | **高** |
| `fsr1`、`sharpen` | 空间超分 + 锐化 | — | 2 遍 / 1 遍 | 中 |
| `lut3D` + `LUTCubeLoader` 等；核心 `cdl`、`saturation` 等 | 调色 | — | 一次 3D 贴图采样 / 纯计算 | **高** |
| `sss` | 单盏方向光的接触阴影，支持正交 | 深度 | 1 遍光线步进 | 低中 |
| `godrays` | 阴影图光线步进的光束 | 深度 + 阴影图 | 半分辨率约 60 次阴影比较 | 中，**正交需要改写** |
| `VolumeNodeMaterial` | 体积光 | 场景深度 | 低分辨率 × 步数 × 灯数 | 低（只支持透视；雾已经在做这件事） |
| 其余：SSR、SSGI、Lensflare、Film、MotionBlur、Outline、ChromaticAberration 等 | — | — | — | 低，或用户已否决 |

对应官方示例：`webgpu_postprocessing_ao`、`_dof`、`_dof_basic`、`_traa`、`webgpu_upscaling_taau`、`_fsr1`、`_3dlut`、`_sss`、`_godrays`（`https://threejs.org/examples/#<名字>`）。

## 三、特效工具与素材（npm / GitHub 实测，2026-10-27）

| 名称 | 用途 | r186 WebGPU | 许可 | 适合度 |
|---|---|---|---|---|
| 手写 TSL 粒子（`SpriteNodeMaterial`、`instancedArray`、r186 新增 `softParticles()`、`curlNoise`） | 浮尘、粉尘、雾丝、呼气 | 可用；按哈希 + 时间驱动的粒子不需要计算着色器，WebGL2 回退也能跑 | MIT | **高** |
| three-nebula（`three-nebula/webgpu`） | CPU 发射器 + 实例化 TSL 四边形 | 读源码可用，未实跑 | MIT | 中 |
| three.quarks、wawa-vfx、three-custom-shader-material | — | **不可用**（走 `onBeforeCompile` / `ShaderMaterial` 的 GLSL 路径） | MIT | 低 |
| @newkrok/three-particles、three-plume | — | 代码可用但 peer 依赖不含 0.186，npm 会拒装；后者只支持 WebGPU | MIT | 低 |
| `WoodNodeMaterial`（three 自带）、tsl-textures | 程序化木纹、锈、缎面、烟等 | 可用 | MIT | 中高（开销大，建议烘焙成贴图） |
| `DecalGeometry`（three 自带） | 投射贴花 | 可用（CPU 几何体） | MIT | 高（肖像掉落后墙上的干净矩形印） |
| Codrops「WebGPU Gommage Effect」（2026-01-28） | TSL 噪声溶解 + 同步粉尘粒子的教程 | three 0.181 写的，未在 0.186 验证 | MIT | 中（当配方用） |
| `IESSpotLight` + `IESLoader`；`ProjectorLight` | 真实光型的手电 | 可用 | MIT | 高（先测；可能把每支手电的两盏灯减成一盏） |
| `Lut3DNode` + Inspector 调色扩展（r181 起） | 在浏览器里实时调色、导出 .CUBE | 可用 | MIT | 高 |
| powershot-threejs | 胶片模拟（颗粒、光晕、片门抖动） | 导入可用，但只支持 WebGPU，且要替换色调映射 | MIT | 中（更适合预告片 / 拍照模式） |
| camera-controls | 平滑镜头控制，支持正交 | 和渲染器无关 | MIT | 低中（和现有 CameraRig 重复） |
| @gltf-transform/cli | 减面、压缩贴图、meshopt | 离线工具 | MIT | 高（把 Poly Haven 模型压进面数预算） |

CC0 素材：Poly Haven（摇椅、华丽镜子、相框、老油灯、落地钟、哥特柜、吊灯、旧床架、烛台、老式手电等，需减面）；ambientCG（7 种墙纸材质）；大都会博物馆开放资源（William Morris 墙纸、公有领域肖像画，接口改为 `/v1.1/search`）；Kenney 粒子贴图。Quaternius 风格太卡通，不合基调。

本机已装、能直接用上的 skill：webgpu-threejs-tsl（写 TSL 粒子和材质）、threejs-bloom（选择性泛光）、threejs-image-pipeline（排后处理顺序和预算）、threejs-visual-validation（像素级验证效果是否真的出现）、game-juice / game-feel（惊吓节拍的层次和延迟审计）、web-shader-extractor（把参考网页的着色器效果抓下来移植，先查许可）。

## 四、调研中被安全分类器拦截的一份报告

「参考作品」那份报告被自动模式的分类器拦了一次（原因未说明，可能是它把两个开源作品集的源码下载到临时目录阅读）。报告内容只当作调研笔记使用，没有运行或引用下载的代码；项目文件经 `git status` 核实没有被改动。
