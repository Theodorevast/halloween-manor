# Tripo API 各步骤「最好的模型」调研：访客流水线（2026-10-28）

调研对象是 `scripts/tripo/` 的访客流水线（清单 `visitors.json`、价目 `catalog.mjs`、实现 `pipeline.mjs` / `client.mjs`）。所有结论都出自 Tripo 文档。文档没有明说的地方一律标「未核实」，不拿猜测补。

## 约定与方法

- **没有调用 Tripo API**：没有向 `openapi.tripo3d.ai` 发过任何请求，也没有读 `.env.local`。只读了文档。
- **以线上文档为准（2026-10-28 抓取）**：`https://developers.tripo3d.ai/llms.txt` 列出了 42 个页面，每页都读了 `.md` 版。下面几处内容只在渲染后的页面里，`.md` 版没有，所以另外读了 HTML：
  - image-to-image / text-to-image 按模型分的 `size`、`inputs` 标签页；
  - Retopology 按版本分的标签页；
  - 价目页的 P Series 标签页（数据在页面脚本 `/assets/PricingPage-BaJjD9rg.js` 里）。
- **补充来源**：
  - 模型详情页：`/en/models/p2`、`/v3-1`、`/rig`、`/animation`、`/texture`。
  - 两篇 Cookbook。
  - 官方 CLI 页面 `/en/docs/cli` 里提到 npm 包 `tripo-cli` 自带说明文档（skill）。这里读的是 0.7.3 版，经 jsDelivr：`https://cdn.jsdelivr.net/npm/tripo-cli@0.7.3/skill/...`。这份文档自称 "the full parameter reference from the official API docs"，但它不是网站正文。用到它的地方都标了「CLI 随包文档」。
- **本地镜像 `Desktop/Tripo API网站/docs/research/2026-10-22/tripo-docs/`（10 个文件）**：拿来和线上逐个比对。9 个完全相同。只有 `task-query.md` 线上多了一句 `normalize_scale` 的说明。
- **抓下来的副本**放在 `.logs/tripo-docs-live-2026-10-28/`（已在 .gitignore 里），方便回查原文。
- **单位**：价格单位是积分，`1 credit = $0.01 USD`（价目页原话）。引文保留英文原文，后面附中文说明。

---

## 0. 一页结论

| 步骤 | 推荐（最好的那个） | 单次积分 | 对照 / 备选 | 依据（详见各节） |
|---|---|---|---|---|
| prep（T 姿势，四套共用） | `seedream_v5` + `template: "t_pose"`，2048×2048 PNG（保持现状） | 5 | — | CLI 随包文档称 t_pose 是动画管线的 "golden pre-step"；seedream_v5 是 "strongest editing" |
| **新增：共用修手**（建议） | `chat_image_2.5_sunburst`，`quality: "high"`，`inputs: [T 姿势图, 吉祥物原图]` | 25 | 不加这一步就每套换装图各修一次 | sunburst "keeps untouched parts of the image closest to the original"；chat_image 最多收 16 张参考图 |
| costume（换装） | `chat_image_2.5_sunburst`，`quality: "high"`（出草稿用 `medium`），`inputs: [修好手的 T 姿势图, 原图]`，提示词 ≤1024 字符 | 25（草稿 10） | 第一个访客上同时试 `seedream_v5`（5）和 `banana_pro`（15） | 文档对「换装后身份保持」没有直接排名，见 1.3 |
| touchup（局部精修） | `chat_image_2.5_sunburst`，`quality: "high"`，`inputs: [换装图, 原图]` | 25 | 不行再试 `xhigh`（30）/ `max`（50） | 同上 |
| views（多视图，**建议四套都走**） | `image-to-multiview`，必要时用 `edit-multiview` 修背面 | 10（+5/张） | 单图路线 | P2 页："multiview gives precise control over the sides and back"；玩家多半从背后看访客 |
| model（3D） | **`P2-20260801` 三角面**，`face_limit: 13000`，`texture_version: "v3.5-20260815"`，`texture_quality: "detailed"`，`delight: true`，`pbr: true` | 120 | 第一个访客上同时试三种：H3.1 + `smart_low_poly`（50）、H3.1 `face_limit 12000`（40，现状）、H3.1 → Retopology v3.0（40+35） | 文档把 P 系列定位为 "Low-poly / game assets"，P2 定位为 "easier to edit, rig, and animate"；但 P2 是 Preview，见 2.6 |
| rig-check | — | 0 | — | — |
| rig | `v1.0-20240301`，`biped`，`spec: "mixamo"`（保持现状） | 25 | **另做一次 `v3.0-20260909` 绑骨对照**（25） | 只有 v1.0 有害怕 / 逃跑 / 张望类预设；文档说人形角色用 v3.0 绑得更好。无头球身哪个版本更好：未核实 |
| retarget | 一次 5 个：idle / walk / run / scared_01 / look_around，`animate_in_place: true` | 50 | — | 每次最多 5 个，每个 10 积分 |
| convert | **不用**（`scripts/blender/refine_visitor.py` 已经限 2048 贴图、15000 面、原地动画） | 0（要用就是 10） | — | 见 3.3 |

按推荐路线，每个访客 230 积分（加 touchup 是 255），四套共用的步骤另算 30 积分。详见第 7 节。

---

## 1. 图像编辑（问题 1）

### 1.1 现有模型对比（image-to-image）

| 模型 | 文档定位（原文） | `quality` | `background` | 多图 `inputs` 上限 | 尺寸 | 积分 ≤1K / 2K / 4K |
|---|---|---|---|---|---|---|
| `seedream_v5`（默认） | "strongest editing, style transfer, and multi-image fusion." | 不收（传了报错） | 不认（忽略） | 4 | 2K / 3K 档，或 WxH（3.69–10.40 MP） | 5 / 5 / 5 |
| `banana` | "fast editing." | 不收 | 不认 | 10 | 只有约 1 MP 的固定尺寸 | 5 / — / — |
| `banana_pro` | "higher quality editing." | 不收 | 不认 | 10 | 1K / 2K / 4K 或 WxH；另有 `aspect_ratio` | 15 / 15 / 20 |
| `banana2` | "latest fast editing." | 不收 | 不认 | 10 | 0.5K / 1K / 2K / 4K；另有 `aspect_ratio` | 10 / 10 / 15 |
| `chat_image_2` | "latest, best editing." | low / medium / high | 不认 | 16 | 预设 + 自定义 WxH | 10 / 10 / 15；high 20 / 25 / 40 |
| `chat_image_2.5_flare` | "2.5 speed tier; noticeably faster than sunburst at the same cost." | low / medium / high / xhigh / max | auto / opaque / transparent | 16 | 同上 | 10 / 10 / 15；high 20 / 25 / 40；xhigh 25 / 30 / 45；max 30 / 50 / 50 |
| `chat_image_2.5_sunburst` | "2.5 fidelity tier; keeps untouched parts of the image closest to the original." | 同 flare | 同 flare | 16 | 同上 | 同 flare |
| `chat_image_1` / `chat_image_1.5` | 分别在 2026-10-23 / 2026-12-01 退役 | — | — | — | — | 5 / 10（只有 ≤1K） |

来源：
- 模型定位、`quality`、`background`、`inputs`：https://developers.tripo3d.ai/en/docs/generation-image-to-image.md
- 尺寸和按模型分的 `inputs`：同一页面渲染后的标签页 https://developers.tripo3d.ai/en/docs/generation-image-to-image
- 价格：https://developers.tripo3d.ai/en/pricing

关键原文：
- 多图："Max: **4** (seedream), **10** (banana), **16** (chat_image)"，"Reference: `image[1]`, `image[2]`, etc."
- quality："Only `chat_image_2`, `chat_image_2.5_flare` and `chat_image_2.5_sunburst` accept this parameter; passing it with any other model returns an error." "Omitting it is equivalent to `low`." "`high`, `xhigh` and `max` cost more credits and take noticeably longer; `low` and `medium` are billed at the base price."
- background："Only `chat_image_2.5_flare` and `chat_image_2.5_sunburst` support it — one of `auto`, `opaque` or `transparent`." "`transparent` requires `output_format=png`."
- 尺寸（标签页）：
  - "seedream_v5: Pick exactly one of the two ways below — they cannot be combined. ... Total pixels 3.69–10.40 MP, aspect ratio [1:16, 16:1]."
  - "chat_image_2, chat_image_2.5_flare, chat_image_2.5_sunburst: presets 1024x1024, 1536x1024, 1024x1536, 2048x2048, 2048x1152, 3840x2160, 2160x3840, auto. Default: 2048x2048."
  - 自定义尺寸：每边 ≤3840 且是 16 的倍数，长边 ≤ 短边的 3 倍，总像素在 655,360 到 8,294,400 之间。
- 价目页："Omitting quality, or passing low / medium, is billed at the base price above. auto is not supported. When size is auto, the 2K tier applies."
- 更新日志对两个 2.5 模型的区别（https://developers.tripo3d.ai/en/docs/changelog.md）："They cost the same and differ in trade-off — flare is noticeably faster, sunburst preserves the untouched parts of an edited image more closely."
- 提供方（CLI 随包文档 https://cdn.jsdelivr.net/npm/tripo-cli@0.7.3/skill/commands/generate.md）：seedream 是 ByteDance，banana 是 Google，chat_image 是 OpenAI。

文档自己的说法不一致：https://developers.tripo3d.ai/en/docs/models-and-versions.md 的表里写 "`chat_image_2` | Best quality"，同一页的推荐却是 "**Highest quality**: ... choose `banana_pro` or `seedream_v5` for images depending on the scenario"。这条推荐很可能写在 chat_image 2 / 2.5（2026-09 上线）之前（未核实）。**文档没有给出「换装后身份保持」或「局部修改」的横向评测。**

### 1.2 (a) 精确局部修改（五指改成三指加拇指、删掉多出来的配件，其余不动）

**推荐：`chat_image_2.5_sunburst`，`quality: "high"`。把吉祥物原图作为 `image[2]` 一起传进去。**

- 文档里唯一明确写了「保留没改的部分」的模型就是 sunburst。原文见上表和更新日志："keeps untouched parts of the image closest to the original" / "preserves the untouched parts of an edited image more closely"。
- quality 档位：文档只说 high / xhigh / max 更贵、更慢，**没说各档具体提升什么，也没说局部修改该用哪一档（未核实）**。建议从 `high`（2K 25 积分）开始，修不好再升 `xhigh`（30）或 `max`（50）。注意 `max` 在 2K 和 4K 都是 50 积分。
- 原图当第二张参考图：API 支持，chat_image 最多 16 张，提示词里写 `image[1]` / `image[2]` 来指代。**模型会不会照着 image[2] 画出三指手套，未核实，要实测。**
- 尺寸用和原图一样的 `2048x2048`，以免重采样或裁切。这是建议，不是文档结论。

### 1.3 (b) 换装但保持吉祥物身份

**推荐：同样用 `chat_image_2.5_sunburst` + `high`，`inputs: [修好手的 T 姿势图, 吉祥物原图]`。** 理由：身份（球身、logo、腿、鞋、手）正是这一步「不该被改的部分」。

文档里还有两个说得通的候选，都没有和 sunburst 比过：
- `seedream_v5`："strongest editing, style transfer, and multi-image fusion."；文档的多图示例 "Use character from image[1] and outfit from image[2]." 用的就是 seedream_v5。只要 5 积分，但没有 quality / background 参数。
- `banana_pro`：models-and-versions 页的 "Highest quality" 推荐里点了它的名。2K 15 积分。

建议在第一个访客上三个都出一张对比，共 45 积分，再定。

### 1.4 多图、尺寸、背景、提示词长度

- **多图怎么传**：用 `inputs`（字符串数组）。文档的多图示例只传了 `inputs`，没有同时传 `input`。seedream 标签页写的是 "Single: input. Multiple: inputs, up to 4. Accepted: public URL, file_token, or image task output."。下面三点文档都没写：
  - `input` 和 `inputs` 能不能同时传（**未核实**）；
  - 同时传时 `input` 算不算 `image[1]`（**未核实**）；
  - chat_image 的 `inputs` 里能不能把 task_id 和 file_token 混着放（**未核实**）。

  最稳的做法是全部上传，传 file_token。流水线本来就会把结果下载到本地。`input` 的规则是 "**Choose exactly one** — do not pass multiple types simultaneously."
- **输入限制**：JPEG / PNG（"webp is rejected on some provider routes"），"Max file size: **20 MB**"，"Max total pixels: **6000 × 6000 = 36 MP**"，宽高比 "[1/3, 3]"。
- **background**：image-to-model 的文档只要求 "Subject should be clearly visible with a clean background and minimal occlusion."（https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard.md）。透明背景对建模更好还是更差，**未核实**。建议传 `opaque`（或不传），配合提示词里的浅灰纯色背景。
- **提示词长度**：
  - image-to-image 页面**没写上限（未核实）**。
  - text-to-image 页面只给了建议值："Recommended: ≤ 300 Chinese characters or ≤ 600 English words."（https://developers.tripo3d.ai/en/docs/generation-text-to-image.md）
  - CLI 随包文档写的是硬上限："| `prompt` | — | t2i (required), i2i | ≤1024 chars; i2i: required unless `template` is set |"。
  - 3D 的 text-to-model 页写 "Text prompt, up to 1024 characters."

  **现在清单里 4 条换装提示词有 3 条超过 1024 字符**：lantern-explorer 1087、vampire 1059、witch 1072，skeleton 987。skeleton 的 touchup 有 986 字符，也接近上限。下面 1.5 节给的模板套进现有服装描述后是 798–898 字符。
- **模板**：`t_pose`、`character_completion`、`3d_enhance`、`variants`、`figure`。原文 "Editing template. When set, `prompt` becomes optional."，也就是说模板和 prompt 可以一起给。下面两点文档都没写：
  - 加了 prompt 后模板会不会照着改（**未核实**）；
  - 哪些模型支持模板（**未核实**）。
- **并发**：图像类任务每个账号只有 1 个并发："| Image Generation | text-to-image, image-to-image, image-to-multiview, edit-multiview | 1 |"（https://developers.tripo3d.ai/en/docs/rate-limits.md）。

### 1.5 请求体（`POST https://openapi.tripo3d.ai/v3/...`，头 `Authorization: Bearer <key>`，`Content-Type: application/json`）

上传参考图：`POST /v3/files`，multipart 字段 `file`，返回 `file_token`。原文："Images: `JPEG`, `PNG`. Max **20 MB**."（https://developers.tripo3d.ai/en/docs/files.md）。价目页没有列上传费用（**未核实，按不收费处理**）。

**prep（共用，保持现状，5 积分）** `POST /v3/generation/image-to-image`
```json
{
  "input": "<file_token：assets-src/mascot/triboo-front.png>",
  "template": "t_pose",
  "model": "seedream_v5",
  "size": "2048x2048",
  "output_format": "png"
}
```
可选：加一句 `"prompt": "Keep both glove hands exactly as in the input: three fingers and one thumb."`。模板加 prompt 后效果如何，未核实。

**共用修手（建议新增，25 积分）** `POST /v3/generation/image-to-image`
```json
{
  "inputs": ["<file_token：prep 结果（下载后再上传）>", "<file_token：triboo-front.png>"],
  "prompt": "Edit image[1] only; image[2] is the original mascot, for reference. Make both translucent grey glove hands match image[2]: exactly three fingers plus one thumb, soft rounded fingertips, a small four-pointed sparkle on each palm. Keep the hand size, colour and translucency, and keep both arms straight out to the sides. Change nothing else: the round matte-black ball body, the yellow-and-white logo, the short black legs, the yellow sneakers, the pose, the framing, the plain light grey background and the lighting stay exactly as in image[1].",
  "model": "chat_image_2.5_sunburst",
  "quality": "high",
  "size": "2048x2048",
  "background": "opaque",
  "output_format": "png"
}
```
这条提示词 544 字符。

**costume（每个访客，25 积分；出草稿时 `quality` 改成 `medium` 就是 10 积分）** `POST /v3/generation/image-to-image`
```json
{
  "inputs": ["<file_token：修好手的 T 姿势图>", "<file_token：triboo-front.png>"],
  "prompt": "Dress the mascot in image[1] in this Halloween costume: {costume}. image[2] shows the same mascot; keep its identity: round matte-black ball body, yellow-and-white logo on the front still visible, no face, short black legs, translucent grey arms, glove hands with three fingers and a thumb, yellow sneakers. The costume sits on the ball like accessories on a vinyl toy. Keep the T-pose, camera angle and framing of image[1], full body visible. Restrained Victorian gothic, muted colours, no glow, no text, nothing in the hands, no accessories beyond those listed. Plain light grey background, soft even light.",
  "model": "chat_image_2.5_sunburst",
  "quality": "high",
  "size": "2048x2048",
  "background": "opaque",
  "output_format": "png"
}
```
模板本身 609 字符，套进现有四套服装描述后是 798–898 字符。用户描述的 logo 是「黄白」，清单里写的是 "gold-and-white"，gold 可能把 logo 带成金属感（推测）。

对照组（第一个访客上各出一张）：
```json
{ "inputs": ["<同上>", "<同上>"], "prompt": "<同上>", "model": "seedream_v5", "size": "2048x2048", "output_format": "png" }
```
```json
{ "inputs": ["<同上>", "<同上>"], "prompt": "<同上>", "model": "banana_pro", "size": "2K", "aspect_ratio": "1:1", "output_format": "png" }
```

**touchup（每个访客，按需，25 积分）** `POST /v3/generation/image-to-image`
```json
{
  "inputs": ["<file_token：costume 结果>", "<file_token：triboo-front.png>"],
  "prompt": "Edit image[1]; image[2] is the original mascot, for reference. Change only this: {fix} Everything else stays exactly as in image[1]: the ball body, the logo, the costume, the legs, the sneakers, the pose, the framing, the background and the lighting.",
  "model": "chat_image_2.5_sunburst",
  "quality": "high",
  "size": "2048x2048",
  "background": "opaque",
  "output_format": "png"
}
```
模板 250 字符。套进 skeleton 现有的删配件说明后是 654 字符。

---

## 2. 3D 生成（问题 2）

### 2.1 H3.1、P1、P2 是什么；P 和 H 代表什么

- `v3.1-20260211`："H3.1, latest high-precision model (default)"，推荐用途 "AAA production pipelines / 3D printing & flexible manufacturing"。
- `P1-20260311`："P1, best low-poly performance; 50–20,000 faces"，推荐用途 "Game pipelines / UGC generative gameplay / Mobile 3D assets"。
- `P2-20260801`："P2 Preview, native quad topology; 48–50,000 triangles or 48–25,000 quads"，推荐用途 "Game characters and props / Hard-surface assets / Real-time production pipelines"。

  以上三条来源：https://developers.tripo3d.ai/en/docs/models-and-versions.md
- P2 模型页（https://developers.tripo3d.ai/en/models/p2）："Tripo P2.0 Preview is the upgrade to P1, built for games and real-time production pipelines, and it generates meshes that are easier to edit, rig, and animate."
- 官方 Cookbook（https://developers.tripo3d.ai/en/cookbook/gpt-6-astra-3d-game-scene-workflow）把两条线叫作 "HD Model (H3.1)" 和 "Smart Mesh (P2.0)"：
  - "Smart Mesh (P2.0) generates low-poly models with clean topology, with native quad or triangle output, and a face count controllable between 500 and 50K. ... It is built for low-poly needs that go on to rigging and animation, and for prop assets."
  - "HD Model (H3.1) ... It is built for work that needs rich geometric detail — 3D printing and camera-grade static object rendering."
- **字母 P 和 H 到底代表什么，文档没写，「未核实」。** 能确认的只有：
  - P 这条线在文档里一直和「低面数、干净拓扑」绑在一起（Smart Mesh）；
  - ComfyUI 文档里 Smart low poly 节点（实际调用 Retopology 接口）的版本名也带 P："`P-v2.0-20251225` maps to `model` `v2.0`, and `P-v3.0-20260909` maps to `v3.0`."（https://developers.tripo3d.ai/en/docs/comfyui-nodes.md）；
  - 搜索结果里有一篇第三方新闻稿，标题是 "Tripo AI Launches Smart Mesh P1.0"。它不是文档，也没有解释字母。

### 2.2 参数支持矩阵

| 参数 | H3.1 `v3.1-20260211` | P1 `P1-20260311` | P2 `P2-20260801`（Preview） |
|---|---|---|---|
| `face_limit` | 支持。三角面上限 1,500,000，Ultra 模式 2,000,000；quad 150,000；开 smart_low_poly 时三角 500–20,000、quad 500–10,000 | 支持，50–20,000 | 支持，三角 48–50,000，quad 48–25,000 |
| `smart_low_poly` | 支持（+10） | 不支持 | 不支持 |
| `quad` | 支持（+5），强制输出 FBX | 不支持（传了返回 400） | 支持（P2 专属），输出 FBX |
| `pbr` | 支持 | 支持 | 支持 |
| `texture_alignment` | 支持（image / multiview） | 支持 | 支持 |
| `orientation` | 支持，只在 `texture=true` 时生效 | 支持 | 支持 |
| `generate_parts` | 支持（+20），必须 `texture=false` 且 `pbr=false` | 不支持 | 不支持 |
| `geometry_quality` | 支持（`detailed` +20） | 不支持 | 不支持 |
| `compress`（meshopt） | 支持 | P 系列页面没列（**未核实**） | 没列（**未核实**） |
| `texture_version` / `delight` | 支持 | 支持 | 支持 |

来源和原文：
- H 系列（https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard.md）：
  - "When `smart_low_poly: true`, face limits are fixed regardless of model version: Triangle **500 – 20,000**, Quad **500 – 10,000**."
  - quad："If `face_limit` is not set, the default face count will be 10,000.Enabling `quad` will force the output format to `FBX`."
  - generate_parts："Not compatible with `texture`, `pbr`, `quad`, or `smart_low_poly`"
  - orientation："Only effective when `texture` is `true`."
  - compress："`geometry` — meshopt compression for reduced file size."
- P 系列（https://developers.tripo3d.ai/en/docs/generation-image-to-model/p.md）：
  - "`P1-20260311`: **50 – 20,000**"
  - "`P2-20260801` triangle: **48 – 50,000**; with `quad=true`: **48 – 25,000**"
  - quad："**P2-20260801 only.**"
  - "Must be set to call the P Series; if omitted, the request runs on the default H Series model `v3.1-20260211`."
- 更新日志："P1 (`P1-20260311`) remains available; P1 does not support `quad`, `smart_low_poly`, `generate_parts`, or `geometry_quality`." 以及 "Sending `quad=true` with P1 returns `400`"。
- P2 模型页："Does NOT support: smart_low_poly, generate_parts, geometry_quality"。
- H3.1 模型页（https://developers.tripo3d.ai/en/models/v3-1）："face_limit Up to 1,500,000, or 2,000,000 with geometry_quality=detailed; up to 150,000 with quad=true"。
- P2 输出 FBX（https://developers.tripo3d.ai/en/docs/cli.md）："For quad low-poly output, add `-p quad=true`; quad output uses FBX, and P1 does not support quads."

### 2.3 各版本的输出能不能走 rig-check / rig

- rig 和 rig-check 对 `input` 的要求是 "task_id — The task ID returned by a previous 3D generation task (`text_to_model`, `image_to_model`, or `multiview_to_model`)"，也接受 file_token / URL，格式 "`GLB`, `FBX`, `OBJ`, `STL`"，"Max file size: **150 MB**"（https://developers.tripo3d.ai/en/docs/animations-rig.md 、https://developers.tripo3d.ai/en/docs/animations-rig-check.md）。P 系列用的就是这三个接口。**文档没有写哪个生成版本不能绑骨。**
- P2：模型页写 "Ready for rigging, animation, and editing"。
- P1：CLI 随包文档的游戏预设是 "`--for game-mobile` ... → P1, face_limit 15000, 2K textures, convert to FBX"；CLI README 示例 `make knight.png --for game-mobile --then texture,rig,convert:fbx` 在 P1 之后接了绑骨。
- quad 的 FBX 输出：rig-check 从 2026-10 起收 FBX（更新日志："rig-check ... now accepts GLB, FBX, OBJ, and STL (previously GLB only)"）。
- 还没确认的：`generate_parts`（多部件）的输出能否绑骨，**未核实**；`compress: "geometry"` 压缩过的输出能否当绑骨输入，**未核实**（建议不开）。
- 只要后面还有处理步骤，就不要设 `export_orientation`。原文："If the model will be used in post-processing tasks (texture, rig, retarget, convert, ...), it is recommended **not** to set this parameter." 设了的话 "post-processing the model may produce a wrongly-oriented result while the task still reports `status: success`"。

### 2.4 多视图路线（image-to-multiview → multiview-to-model）

- **推荐四套都走多视图**：
  - P2 页："multiview gives precise control over the sides and back."
  - multiview-to-model 页（https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard.md）："Multiple angles improve geometry accuracy and texture coverage."

  游戏里玩家经常贴近、从背后看访客，斗篷、披肩、帽子的背面和骷髅的背部花纹都直接露在镜头前（这是对本项目的判断）。
- **支持的版本**：
  - H 系列 `v3.1-20260211`（默认）、`v3.0-20250812`、`v2.5-20250123`（同上页）；
  - P 系列 `P1-20260311`、`P2-20260801`（https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p.md）；
  - multiview-to-model 没有 `enable_image_autofix` 参数，其他参数和单图版一样。
- **输入规则**：
  - "The front view **cannot be omitted**. You may omit other views, but at least 2 images are required."
  - "All images should depict the same object under consistent lighting."
  - 可以直接传 `[{"task_id":"<uuid>"}]`，前提是 "The source task must be `success` with type `generate_multiview_image` or `edit_multiview_image`."
- **image-to-multiview**（https://developers.tripo3d.ai/en/docs/generation-image-to-multiview.md）：
  - 只收 file_token / URL，不收 task_id；
  - 输出 `front_view_url` / `left_view_url` / `back_view_url` / `right_view_url`；
  - 没有模型和尺寸参数。用的哪个模型、输出多大，**未核实**。
- **edit-multiview**：用它修背面，比如去掉被镜像到背面的 logo。原文 "Edit existing multiview images. Apply consistent changes across all views."，`prompts` 是 `{prompt, view}` 的数组（https://developers.tripo3d.ai/en/docs/generation-edit-multiview.md）。
- **价格**："Image to Multiview 10"，"Edit Multiview 5 / edited image"。multiview-to-model 和 image-to-model 同价（见下）。

### 2.5 价格（image-to-3D 和 multiview-to-3D 同价；text-to-3D 另有价目）

| 型号 | 无纹理 | 标准纹理 | HD 纹理 `detailed` | 8K `extreme` | 加项 |
|---|---|---|---|---|---|
| H3.1 | 20 | 30 | 40 | 50 | HD 几何 +20，quad +5，smart_low_poly +10，分件 +20 |
| P1 | 40 | 50 | 60（推算，未核实） | 70（推算，未核实） | 不支持上述加项 |
| P2 | 100 | 110 | 120 | 130 | quad 是否加价：**未核实** |

来源：
- H：价目页 "Image to 3D 20 30"，"Add-ons (stacked on base credits) HD Texture +10 8K Ultra Texture +20 HD Geometry Quality +20 Quad Mesh +5 Smart Low-poly +10 Generate Parts +20"；H3.1 模型页 "Image to 3D 20 30 40 50"。
- P1 / P2：价目页 P Series 标签页（页面脚本 `PricingPage-BaJjD9rg.js`）的数据原文 `{task:t("pricing.image_to_3d"),noTexP1:40,noTexP2:100,stdTexP1:50,stdTexP2:110,...}`，附注 "P1 does not support quad, smart_low_poly, generate_parts, or geometry_quality. P2 base is 100 credits; texture add-ons match P1 (standard +10)."
- P2 的四档价格：P2 模型页 "Image to 3D 100 110 120 130"。
- P1 的 HD / 8K 价格是推算的。依据是更新日志 "(same texture add-ons as P1)" 加上 P2 的 110 / 120 / 130，文档没有直接列出。

### 2.6 推荐与请求体

**首选：`P2-20260801`，三角面输出，`face_limit: 13000`**（是上限，给 Blender 精修留 2k 面余量），走多视图。
- 依据：
  - 文档对 "Low-poly / game assets" 的建议是 "Use the P Series for 3D — cleaner topology and more precise face-count control: `P2-20260801` (Preview, native quads and a higher face budget) or `P1-20260311`"；
  - P2 页 "easier to edit, rig, and animate"、"mesh density is allocated where detail is needed"；
  - Cookbook 的换装游戏案例："brute-force decimation lost detail and left surfaces coarse"，"P2 then raised low-poly detail and edge-flow quality further"（https://developers.tripo3d.ai/en/cookbook/ai-tailor-dressup-game）。
- 风险：P2 是 Preview（"The upcoming official release will further improve mesh stability and add more fine-grained controls."），价格是 H3.1 的 3 倍。
- **文档没有 P2 和 H3.1 在风格化角色上的直接对比，所以「P2 最好」只是按文档定位推出的结论，要在第一个访客上实测（未核实）。**
- 纹理用 `texture_version: "v3.5-20260815"` + `delight: true`：
  - 贴图模型页（https://developers.tripo3d.ai/en/models/texture）："Lighting control (delight, on by default): keep it on for realistic games — clean base color under Unity, Unreal or Godot lighting; turn it off for rendering, VFX and CG to preserve stylized lighting"。本游戏全靠手电和月光实时打光，属于前一种情况。
  - `texture_quality: "detailed"`（+10）。文档只写了 `extreme` 是 8K，**standard 和 detailed 的输出分辨率没写（未核实）**。反正最终会在 Blender 里压到 2048，所以不选 8K。

`POST /v3/generation/multiview-to-model`（P2，120 积分）
```json
{
  "inputs": [{ "task_id": "<image-to-multiview 或 edit-multiview 的 task_id>" }],
  "model": "P2-20260801",
  "face_limit": 13000,
  "texture": true,
  "pbr": true,
  "texture_version": "v3.5-20260815",
  "texture_quality": "detailed",
  "delight": true,
  "texture_alignment": "original_image"
}
```
单图路线：`POST /v3/generation/image-to-model`，参数相同，把 `inputs` 换成 `"input": "<touchup 或 costume 的 task_id>"`（input 可以填 "The task ID from a previous image generation task (`text_to_image` or `image_to_image`)"）。

**第一个访客上的对照组**（同一张图做输入；想对比同一几何的不同贴图时，可以固定 `model_seed`，原文 "Using the same seed with the same input will produce an identical 3D mesh."）：

H3.1 + smart_low_poly（30 + 10 + 10 = 50 积分）：
```json
{
  "input": "<task_id>",
  "model": "v3.1-20260211",
  "smart_low_poly": true,
  "face_limit": 12000,
  "texture": true,
  "pbr": true,
  "texture_version": "v3.5-20260815",
  "texture_quality": "detailed",
  "delight": true
}
```
H3.1 只限面数（现在的做法加上 v3.5 HD 纹理，40 积分）：
```json
{ "input": "<task_id>", "model": "v3.1-20260211", "face_limit": 12000, "texture": true, "pbr": true, "texture_version": "v3.5-20260815", "texture_quality": "detailed", "delight": true }
```
P1 备选（GA 版，50 / 60 积分）：
```json
{ "input": "<task_id>", "model": "P1-20260311", "face_limit": 12000, "texture": true, "pbr": true, "texture_version": "v3.5-20260815", "texture_quality": "detailed", "delight": true }
```
`enable_image_autofix` 保持默认 `false`。原文："the system will enhance low-resolution or low-quality images"。我们的输入是 2K 干净图，开了反而可能改动手指之类的细节（推测）。`auto_size` 不开，游戏会自己归一到 1.1 m。

---

## 3. 在 12–15k 三角面以内拿到干净网格（问题 3）

### 3.1 几种做法

| 做法 | 文档怎么说 | 积分（含 HD 纹理） |
|---|---|---|
| A. H3.1 + `face_limit` | 只写了 "Maximum polycount for the output mesh"，以及 "Web/mobile: **10,000 – 50,000**"。低面数时拓扑质量如何，没写 | 40 |
| B. H3.1 + `smart_low_poly` | "hand-crafted, clean topology style. Best suited for simple, non-complex inputs. Complex models may occasionally fail." | 50 |
| C. P1 | "best low-poly performance"；"For best quality: simple models start from **150** faces, complex models start from **250** faces." | 60（推算） |
| D. **P2 三角面** | 见 2.6 | 120 |
| E. P2 quad，`face_limit` 6000–7500 | 输出 FBX，三角化后约 12k–15k 三角面（见 3.2） | 120（加不加价未核实） |
| F. H3.1 高精度（可加 `geometry_quality: "detailed"` +20）→ `POST /v3/mesh/decimate` v3.0 | "Use model=v3.0 for the newest retopology, which can also unwrap UVs in the same task (smart_uv)"；v3.0 标签页 "Triangle: 500–20,000. Quad: 500–10,000."；`bake`："Bake textures onto the low-poly model." | 40（或 60）+ 35 |
| G. `POST /v3/models/convert` 带 `face_limit` | 只写了 "Maximum polycount for the output mesh. If omitted, the original face count is preserved." 没有任何关于质量的说明 | +10（高级转换） |

Retopology 来源：https://developers.tripo3d.ai/en/docs/mesh-decimate （版本标签页）。v2.0 的说法是 "Smart Retopology — rebuilds clean topology with edge preservation and detail retention."。价格："Retopology (v3.0 Triangle) 35"，"Retopology (v3.0 Quad) 40"，"Retopology (v2.0 Smart) 30"，"Retopology (v1.0 Basic) 10"。

CLI 随包文档说 decimate 默认会烘焙，适合做 LOD："`bake` (default true — bake textures onto the low-poly, right for LODs)"（https://cdn.jsdelivr.net/npm/tripo-cli@0.7.3/skill/commands/process.md）。示例里写的是 "bakes normals by default"，会不会烘出法线贴图，**未核实**。

### 3.2 四边面三角化后有多少三角面

文档给的换算是 **1 个四边面 = 2 个三角面**：
- Smart UV 页（https://developers.tripo3d.ai/en/docs/mesh-uv.md）："The input model must not exceed **80,000 equivalent triangles** (a quad counts as two)."
- CLI 页："one quad counts as two triangles"。
- P2 的上限也是这个比例：三角 50,000 对应 quad 25,000。

所以 12–15k 三角面的预算对应 `quad: true` 时 `face_limit` 设 6,000–7,500。注意 H 系列开 quad 但不给 face_limit 时默认 10,000 面，三角化后约 2 万，超出预算。
- GLB 里不能存四边面，输出会是 FBX："quad mesh; **forces FBX output** (quads cannot live in GLB)"（CLI 随包文档 generate.md）。
- 输出里是不是全是四边面（会不会夹着三角面或多边形），**未核实**。所以实际三角面数要以 Blender 里看到的为准。

### 3.3 绑过骨的结果还能不能走 convert

- **能连**：ComfyUI 文档的第 8 个工作流原文 "Convert and Export: connect the final MODEL_INFO from Generate, Import, processing, Rig, or Retarget to Convert and choose the output format."，数据流图里也有 `A -->|MODEL_INFO| C["Convert model"]`（A 是 Retarget）。convert 自己也有动画相关参数：`with_animation` "Include skeleton and animation data."（默认 true），`animate_in_place` "In-place animation (no root displacement)."（https://developers.tripo3d.ai/en/docs/models-convert.md）。
- **但 convert 的 API 页**列的 task_id 来源只有 "`text_to_model`, `image_to_model`, or `multiview_to_model`"。直接把 retarget 的 task_id 传进去行不行，API 页没写（**未核实**，ComfyUI 是这样用的）。另一种办法是传 file_token，GLB / FBX 都收。
- 给绑过骨的网格设 `face_limit` 后蒙皮权重还在不在，**未核实**。`texture_size` 的原文是 "Diffuse texture size in pixels."，法线和粗糙度贴图会不会一起缩，**未核实**。
- 计费：价目页 "any non-default value for the following = 10 credits"，触发项包括 `quad face_limit flatten_bottom flatten_bottom_threshold texture_size texture_format pivot_to_center_bottom scale_factor`。

### 3.4 推荐

- 首选：生成时就把面数控制在预算内（D：P2，`face_limit: 13000`），不要绑骨之后再用 API 减面。
- 想走 H3.1 高精度路线（F），就在**绑骨之前**做 Retopology v3.0，参数 `smart_uv: true`、`bake: true`。
  - decimate 的结果能不能直接接 rig：ComfyUI 的数据流 `G --> P(Model processing) --> R(Rig)` 说明可以；但 rig 的 API 页只列了生成类任务（**未核实**）。
  - 关于 rig：Smart UV 页明说会保留绑骨（"remap the existing textures, rigging and animation"），decimate 页**没有**这样写（**未核实**），所以不要拿已绑骨的模型去 decimate。
- 最后兜底在 Blender 里做：仓库里正在写的 `scripts/blender/refine_visitor.py` 已经有 `--max-tris 15000` 和 `--max-texture 2048`。

`POST /v3/mesh/decimate`（只在 F 路线用，35 积分）：
```json
{ "input": "<H3.1 生成任务的 task_id>", "model": "v3.0", "face_limit": 13000, "smart_uv": true, "bake": true }
```

---

## 4. 绑骨（问题 4）

### 4.1 三个版本（https://developers.tripo3d.ai/en/docs/animations-rig.md）

- `v1.0-20240301`（服务端默认）："biped (humanoid) only. Supports 90+ animation presets."
- `v2.5-20260210`："non-humanoid creatures (quadruped, hexapod, octopod, serpentine, aquatic, avian). Bipeds are also supported but not recommended; use v3.0 for humanoids."
- `v3.0-20260909`："recommended for humanoid characters: faster, higher-quality humanoid rigging; other rig types keep v2.5 quality and speed. Supports `rig_type` `others` and the `actorcore` / `unity` / `unreal` / `vrm` skeleton conventions, and uses the same animation presets as v2.5. The default is unchanged; v3.0 must be requested explicitly."
- 三个版本都是 25 积分。更新日志："Credits are unchanged."；价目页 "Auto Rig 25"，"Rig Check Free"。
- **文档对「球形身体、没有头和脖子」这种非标准人形一句都没提，哪个版本处理得最好，「未核实」。** 能参考的只有以下几条：
  - v3.0 被定为人形首选；
  - CLI 随包文档 animation.md："the v3.0 rig (CLI default) is best for humanoids and covers every body type (avian / others have no preset animations)"；
  - ComfyUI 排错表："Model cannot be rigged | Try a suitable character model or set rig_type explicitly"。也就是说 rig-check 判为不可绑时，可以手动指定 `rig_type: "biped"` 再试。

### 4.2 rig_type 和 spec

- `rig_type`：`biped`（默认）、`quadruped`、`hexapod`、`octopod`、`avian`、`serpentine`、`aquatic`、`others`（"skeletons that match none of the named topologies"，只有 v3.0 有）。翠宝两条腿两只手，用 `biped`。`others` 没有预设动作（见上面 CLI 那句）。
- `spec`："Rigging specification. Only takes effect when `rig_type` is `biped`."
  - "`tripo` — Tripo native bone naming."（默认）
  - "`mixamo` — Mixamo-compatible bone naming."
  - 还有 `actorcore` / `unity` / `unreal` / `vrm`，都要 v3.0。CLI 随包文档 process.md："(actorcore/unity/unreal/vrm need v3.0)"；ComfyUI："unity, unreal, and vrm do not work with v1.0-20240301"；rig 模型页："Tripo (default) or mixamo; v3.0 adds actorcore, unity, unreal, vrm. Applies to biped only"。
- **mixamo 和 tripo 的区别，文档只写了骨骼命名不同。** 下面这些都**未核实**：骨骼数量、层级、有没有手指骨（三指手套会怎么绑）、没有头的角色会不会照样生成 Neck / Head 骨。
- 选 mixamo 的实际好处：convert 的 `fbx_preset` 里有 "`mixamo` — compatible with Mixamo rigging."；Blender 精修脚本默认让身体跟着 `Spine2` 走，这是 Mixamo 的命名，脚本也有 `auto` 自动识别。

### 4.3 rig-check 的返回字段（https://developers.tripo3d.ai/en/docs/animations-rig-check.md）

- `riggable`（boolean，必有）："Whether the model is riggable."
- `rig_type`（string，必有）："Recommended rig type."，取值是上面的前 7 种。CLI 随包文档："(one of the 7 types below, never `others`)"。
- 结果示例：`"output": {"riggable": true, "rig_type": "biped"}, "credits_consumed": 0.00`。
- 输入格式："`GLB`, `FBX`, `OBJ`, `STL`"，≤150 MB。没有置信度之类的字段。

### 4.4 各版本有没有需要的预设动作（https://developers.tripo3d.ai/en/docs/animations-retarget.md）

| 需要的动作 | v1.0-20240301（`preset:biped:*`） | v2.5-20260210 / v3.0-20260909（`preset:*`） |
|---|---|---|
| idle | `idle`、`standing_relax`、`wait` | `preset:idle` |
| walk | `walk`（还有 `swagger`） | `preset:walk` |
| run | `run`（还有 `run_upstairs`） | `preset:run` |
| scared（害怕） | `scared_01`、`scared_02`、`afraid`、`frightened` | **没有** |
| flee（逃跑） | `flee_01`、`flee_02` | **没有** |
| cower（蜷缩） | **没有叫这个名字的预设** | **没有** |
| look around（张望） | `look_around` | **没有** |
| 其他可能用到的 | `turn`、`hurt`、`fall`、`fold_arms`、`sit` | `preset:turn`、`hurt`、`fall`、`jump`、`dive`、`climb`、`slash`、`shoot` |

- **v3.0 没有新增预设**：
  - 绑骨页 "uses the same animation presets as v2.5"；
  - 动画模型页（https://developers.tripo3d.ai/en/models/animation）："v3.0-20260909 (rig) Same 16 presets as v2.5"；
  - 16 个是人形 11 个，加上 `preset:quadruped:walk`、`hexapod:walk`、`octopod:walk`、`serpentine:march`、`aquatic:march`。
- **每个预设具体是什么动作、多长、循不循环，文档都没写（未核实）**。scared_01 和 frightened 哪个更「收着演」，要看了才知道。
- 文档之间有矛盾：retarget 页说 v2.5 / v3.0 的人形可以用 `preset:walk` 等；ComfyUI 文档却会拦下这种组合："`v2.5-20260210` (including `v2.0-20250506`, which runs as it) | Humanoid presets without a skeleton prefix, such as `preset:walk`"。我们不用 v2.5，不受影响。

### 4.5 推荐与请求体

- **首选 `v1.0-20240301` + `biped` + `mixamo`（保持现状）**。游戏要的 scared / flee / look_around 只有 v1.0 有，球身的权重本来就要在 Blender 里重新分。
- **对照**：在第一个通过的访客上再做一次 `v3.0-20260909` 绑骨（+25 积分），在 Blender 里比较关节位置和手臂、腿的权重。
  - 如果 v3.0 明显更好，有两条路，都超出了文档范围：一是只用它的 11 个预设，害怕类动作另找来源；二是两次都用 `spec: "mixamo"`，骨骼名就会一致，可以在 Blender 里把 v1.0 结果上的动作挪到 v3.0 的骨架上（这只是一个想法，没验证过）。

`POST /v3/animations/rig-check`（0 积分）
```json
{ "input": "<model（或 decimate）任务的 task_id>" }
```
`POST /v3/animations/rig`（25 积分）
```json
{ "input": "<model 任务的 task_id>", "model": "v1.0-20240301", "rig_type": "biped", "spec": "mixamo", "out_format": "glb" }
```
对照组：
```json
{ "input": "<model 任务的 task_id>", "model": "v3.0-20260909", "rig_type": "biped", "spec": "mixamo", "out_format": "glb" }
```

---

## 5. 动作重定向（问题 5）

字段（https://developers.tripo3d.ai/en/docs/animations-retarget.md）：

| 字段 | 类型 / 默认 | 原文 |
|---|---|---|
| `input` | string，必填 | "task_id of the rigged model, starting with `task_`."（只能填 rig 任务的 task_id，不收文件。CLI 随包文档："retarget needs a rig task"） |
| `animation` | string，和 `animations` 二选一 | "Single preset animation identifier." |
| `animations` | string[]，和 `animation` 二选一 | "List of multiple preset animation identifiers, up to 5. Sending more than 5 returns an error." |
| `out_format` | `glb`（默认）/ `fbx` | — |
| `bake_animation` | 已废弃 | "**Deprecated and ignored.**" |
| `export_with_geometry` | 默认 `true` | "Export with geometry included." |
| `animate_in_place` | 默认 `false` | "Play animation in place without displacement." |

- **每次最多 5 个动作，每个 10 积分**。价目页 "Animation Retarget 10 / animation"；动画模型页 "Single animation 10 Batch animation 10 × count"。
- **根运动**：默认**不是**原地，要传 `animate_in_place: true`。动画模型页："an in-place mode is available to remove root displacement for game engine locomotion systems."。下面几点**未核实**：
  - 它只去掉水平位移还是连上下起伏一起去掉；
  - 批量请求里的每个动作是不是都生效。

  Blender 精修脚本里另有一道「去掉水平位移」，可以兜底。
- **新功能**：2026-10 换了重定向算法，原文 "The retargeting algorithm has been replaced in place with a faster, higher-quality version — there is no new version number and no request change is required."；更新日志 "much better humanoid quality and speed"。新算法是否也用于 v1.0 的 90 多个预设：文档没有区分，**未核实**。
- **自定义动作上传、文字生成动作**：所有 API 页面都**没有**这类接口。Cookbook 里提到过 "giving AI a reference video together with a rigged model is enough for it to retarget the motion onto the new model"，说的是借助 AI 的一般工作流，不是 Tripo 的接口。
- 一次请求多个动作时，结果只有一个 `model_url`。是不是一个 GLB 里含多段动画、每段叫什么名字，**未核实**。现有流水线和 `glb.mjs --inspect` 可以在本地检查。

`POST /v3/animations/retarget`（v1.0 骨架，5 个动作，50 积分）
```json
{
  "input": "<rig 任务的 task_id>",
  "animations": ["preset:biped:idle", "preset:biped:walk", "preset:biped:run", "preset:biped:scared_01", "preset:biped:look_around"],
  "animate_in_place": true,
  "export_with_geometry": true,
  "out_format": "glb"
}
```
想比较几种害怕动作，就再发一次，30 积分，会生成另一个 GLB：`"animations": ["preset:biped:scared_02", "preset:biped:afraid", "preset:biped:frightened"]`。

v3.0 对照骨架（30 积分）：`"animations": ["preset:idle", "preset:walk", "preset:run"]`，其余字段同上。

---

## 6. 可选的后处理

- **convert**（基础 5 积分，高级 10 积分）：本项目建议**不用**，贴图尺寸和面数都交给 Blender 精修脚本。真要用的话：
  ```json
  { "input": "<retarget 的 task_id（API 页没列，见 3.3）或 file_token>", "format": "GLTF", "texture_size": 2048, "with_animation": true, "animate_in_place": true }
  ```
  `format: "GLTF"` 返回的是 `.glb` 还是 `.gltf`，**未核实**。示例回包写的是 `model_pbr.glb`，但那是通用示例。
- **Smart UV**：`POST /v3/mesh/uv`，20 积分，"remap the existing textures, rigging and animation onto the new layout"，输入 ≤80,000 等效三角面。Blender 清理把 UV 弄乱了可以用它。
- **重新贴图**：`POST /v3/models/texture`，fast / standard 10，HD 20，8K 30。如果 Blender 清理后贴图坏了，可以上传清理后的 GLB，用 `model: "v3.5-20260815"` 加 `texture_prompt.images`（多视图）重新生成。原文："When initiating a texture task based on an existing task_id, it is **strongly recommended** to re-supply the reference image in this request."（https://developers.tripo3d.ai/en/docs/models-texture.md）
- **用文件当输入时的缩放**：rig、texture、convert 用 file_token / URL 当输入时，结果会带 `normalize_scale`。原文："`final size = original size × normalize_scale`"（https://developers.tripo3d.ai/en/docs/task-query.md）。游戏会自己归一到 1.1 m，影响不大。

---

## 7. 每个访客要花多少积分（1 积分 = $0.01）

| 项目 | 推荐路线 | 现在清单的做法 |
|---|---|---|
| 共用：prep + 修手 | 5 + 25 = 30（四套分摊） | 5 |
| costume | 25（每张 medium 草稿另加 10） | 10（medium） |
| touchup（按需） | 25 | 25（high） |
| image-to-multiview（+ edit） | 10（+5/张） | 0（走单图） |
| model | 120（P2 HD 纹理） | 30（H3.1 标准纹理） |
| rig-check + rig | 0 + 25 | 0 + 25 |
| retarget | 50（5 个） | 40（4 个） |
| **每个访客合计** | **230，加 touchup 是 255** | **130** |

- 四套合计 950–1050 积分，约 $9.5–10.5，不含重抽。
- 把 P2 换成 H3.1 + smart_low_poly，每个访客是 160 / 185。
- 第一个访客的对照测试比推荐路线多花 220 积分：三种 H3.1 对照建模 50 + 40 + 75 = 165，v3.0 对照绑骨 25，v3.0 骨架上的 3 个动作 30。再做换装图的三模型对照（seedream_v5 5 + banana_pro 15），再加 20。
- 价格对照：今天的价目页和 `catalog.mjs`（10-27 读的）逐项比过，**一致，没有变动**。P1 的价格 catalog 里写的是「未核实」，现在能确定是 image / multiview 40（无纹理）/ 50（标准纹理）。

---

## 8. 更新日志：2025–2026（问题 6）

来源：https://developers.tripo3d.ai/en/docs/changelog.md （中文版 `/zh/docs/changelog.md` 条目相同）。另有标注的除外。

| 时间 | 变化 |
|---|---|
| **2026-10** 绑骨 | 新增 Rigging v3.0（`v3.0-20260909`），要显式指定，积分不变。新增 `rig_type=others`，`spec` 加入 `actorcore` / `unity` / `unreal` / `vrm`。rig-check 输入从只收 GLB 改为 GLB / FBX / OBJ / STL。rig 的文件和 URL 输入"no longer list GLTF"。 |
| **2026-10** 重定向 | 换成新算法："much better humanoid quality and speed. There is no new version number and no request change."。`bake_animation` 不再起作用，传了也忽略（见 retarget 页）。 |
| **2026-10** 网格 | 新增 Retopology v3.0：三角面 35 积分、四边面 40 积分，face_limit 三角 500–20,000、四边 500–10,000，新参数 `smart_uv` 免费（v1.0 / v2.0 传了返回 1004）。v2.0 仍是默认，价格 30 不变。新接口 Smart UV `POST /v3/mesh/uv`，20 积分，输入 ≤80,000 等效三角面。 |
| 2026-10-15 | ComfyUI-Tripo 2.0.0 改用 v3 API，Refine 和 Stylize 停用，删掉 `v2.0-20240919`（"API v3 no longer accepts"）。来源：comfyui-nodes 页。SDK 页："Refine and stylize are retired"。 |
| 2026-10-23 | `chat_image_1` 退役。文档里还列着这个模型。 |
| 2026-10-31 | v2 API 计划关停："The v2 API is scheduled to shut down on 2026-10-31"（https://developers.tripo3d.ai/en/docs/sdk.md）。本流水线用的已经是 v3，不受影响。 |
| 2026-12-01 | `chat_image_1.5` 退役。 |
| **2026-09** 贴图 | 新贴图模型 `v3.5-20260815`。生成接口新增 `texture_version` 参数。新增 `texture_quality=fast`："Output texture size and credit cost are both identical to `standard`"，用在别的版本上返回 1004。新增 `delight`，默认 true。 |
| **2026-09** 图像 | 新增 `chat_image_2.5_flare` / `chat_image_2.5_sunburst`（另有 `chat_image_2`）。新增 `quality` 参数，high / xhigh / max 加价。2.5 系列新增 `background`。新增自定义尺寸规则。公布 chat_image_1 / 1.5 的退役日期。 |
| **2026-08** | 新增 `P2-20260801`（Preview），`quad` 只有 P2 能用，face_limit 三角 48–50,000、四边 48–25,000，价格 100 / 110 / 120 / 130。P1 继续可用，不支持 quad / smart_low_poly / generate_parts / geometry_quality。文档更正：`credits_consumed` / `balance` / `frozen` 是最多两位小数的数字。 |
| 2026-04 | API v3：每种能力一个专用端点，统一用 `input` 字段，base URL 改成 `/v3/`，文生图和图生图拆成两个端点。 |
| 2026-10-22 → 10-28 | 本地镜像和线上逐个比对：只有 task-query 页多了 `normalize_scale` 的说明。 |
| 2025 到 2026-03 | **更新日志页里没有这段时间的条目（未核实）。** 只能从型号里的日期推测发布时间：`v2.5-20250123`、`v3.0-20250812`、`v3.1-20260211`、rig `v2.5-20260210`、`P1-20260311`；ComfyUI 文档里还有 segment `v1.0-20250506`、rig `v2.0-20250506`（现在按 v2.5 跑）、Retopology `P-v2.0-20251225`。这些型号具体改了什么、哪天上线，都**未核实**。 |

价格变动：除了上面列出的新增项，没有看到已有项目改价。

---

## 9. 文档里关于风格化 / 非人形角色和绑骨的限制与建议（问题 7）

1. **先做 T 姿势**：CLI 随包文档 animation.md 的小标题就是 "T-pose image first (better rigging on tricky subjects)"；generate.md 写 "`template=t_pose` is the golden pre-step for the animation pipeline"。
2. **先 rig-check 再绑骨**：rig 页 "Run rig-check first to verify compatibility."；rig 模型页 "Always run Rig Check first to verify model compatibility and get recommended rig type"。rig-check 判为不可绑时，可以手动指定 `rig_type` 再试（ComfyUI 排错表）。
3. **选版本**：人形用 v3.0；动物等非人形用 v2.5；`others` 只有 v3.0 有，而且没有预设动作。**球身、无头这种情况文档没讲（未核实）。**
4. **后面还要处理的模型不要设 `export_orientation`**：设了会转错方向，而且任务照样报成功，没有任何报错。
5. **宽松的服装要单独绑骨链**（Cookbook 换装游戏）：原文 "Tight clothing inherits body weights directly; skirts and bunny ears go onto an independent bone chain solved per frame with spring and damping, plus capsule colliders on the thighs to stop clipping — cloth simulation is too heavy for real-time web rendering." 对应到本项目，就是吸血鬼斗篷、女巫流苏披肩这类东西：
   - 要么像清单 notes 写的那样不垂到腿边；
   - 要么在 Blender 里单独绑一条骨链。
6. **拿到模型先校准**（同一篇 Cookbook）："Model calibration: once you have the model, confirm its proportions against the base model and adjust orientation and origin to sensible values."
7. **smart_low_poly 只适合简单输入**："Best suited for simple, non-complex inputs. Complex models may occasionally fail."
8. **P 系列面数别设太低**：简单物体至少 150 面，复杂的至少 250 面，再低质量会差。
9. **输入图要求**："Subject should be clearly visible with a clean background and minimal occlusion."，分辨率至少 256×256。多视图要 "same object under consistent lighting"。
10. **实时打光的游戏开 `delight`**（见 2.6）。
11. **结果链接很快过期**：CLI 随包文档 common-errors.md "Output URLs expire in ~5 minutes — never cache them"。现有流水线是拿到就下载，没问题。
12. **图像任务只有 1 个并发**，四张换装图只能排队跑。

---

## 10. 对现有清单和脚本的观察（没有改任何文件）

1. **costume 提示词有 3 条超过 1024 字符**：1059–1087（见 1.4）。CLI 随包文档写的上限是 1024，网站页面没写，可能会被截断或拒绝（未核实）。
2. **修手的位置**：touchup 现在是每个访客各修一次，每次 25 积分。手是在共用的 T 姿势那一步被画成五指的，在那张共用图上修一次（25）更省，而且四套换装都会从正确的手出发。costume 用 sunburst，本来就应该保留没改的部分。修完一次之后，四套是否都能保住正确的手，未核实。
3. **costume 和 touchup 只传了一张 `input`**：可以改用 `inputs`，把原图当 `image[2]` 给模型对照。
4. **`route` 现在是 `single`**：建议改成 `multiview`。每个访客 +10 积分（必要时再加 edit-multiview 每张 5），换来更准的背面。
5. **model 步骤没设 `texture_version`**：没设就用 v3.0 贴图。建议用 v3.5 + `delight`，`texture_quality` 用 `detailed`。
6. **`catalog.mjs` 可以补的价格**：P1 价格（40 / 50）、Retopology（35 / 40 / 30 / 10）、Smart UV（20）、edit-multiview（5 / 张）。P2 quad 是否加价还不知道。
7. **convert 步骤可以一直关着**：`scripts/blender/refine_visitor.py`（另一个会话正在写）已经负责 2048 贴图上限、15000 面上限和原地动画。
8. **logo 颜色的写法不一致**：用户描述的是「黄白」logo，提示词写的是 "gold-and-white"。

---

## 11. 还没核实 / 不确定的事项

1. P1 / P2 / H3.1 里的字母 P 和 H 代表什么。
2. image-to-image 提示词的硬上限。网站没写，只有 CLI 随包文档写了 ≤1024 字符；超了会不会被截断或拒绝。
3. `input` 和 `inputs` 能不能一起传、一起传时谁是 `image[1]`；chat_image 的 `inputs` 里能不能混放 task_id 和 file_token。
4. 哪些图像模型支持 `template`（t_pose 等）；模板加 prompt 之后会不会照着改。
5. quality（low / medium / high / xhigh / max）具体提升什么，局部修改用哪一档最合适。
6. 自定义尺寸（例如 2880×2880）按 1K / 2K / 4K 的哪一档计费。
7. 3D 纹理 standard 和 detailed 的输出分辨率。文档只写了 extreme 是 8K。
8. P2 开 quad 要不要另加 5 积分；P1 detailed / extreme 的价格（60 / 70 是推算的）。
9. P 系列支不支持 `compress`；`compress` 过的模型能不能当 rig 的输入；`generate_parts` 的输出能不能绑骨。
10. P2 Preview 现在稳不稳定；P2 的三角面模式是否也有四边面模式那样的干净布线。
11. P2 和 H3.1（含 smart_low_poly、Retopology v3.0）在风格化玩具角色上谁更好。文档没有对比。
12. 低 face_limit 时开 `geometry_quality: "detailed"` 有没有用。
13. 球身、无头的角色 rig-check 会不会判成可绑；v1.0 和 v3.0 在这种身体上谁的关节放得更准；mixamo spec 会不会生成 Neck / Head 骨、有没有手指骨。
14. tripo spec 和 mixamo spec 除了命名还有什么区别。
15. 各预设动作的内容、时长、是否循环；批量重定向的 GLB 里动画段怎么命名；`animate_in_place` 管不管上下起伏，是否对批量请求里的每个动作都生效；新重定向算法是否也用于 v1.0 的预设。
16. 文档冲突：retarget 页说 v2.5 人形可以用 `preset:walk`，ComfyUI 文档却会拦下。
17. convert 的 API 页能不能直接收 retarget 的 task_id（ComfyUI 是这么连的）；convert 设 `face_limit` 后蒙皮还在不在；`texture_size` 是不是只缩漫反射贴图；`format: "GLTF"` 返回 .glb 还是 .gltf。
18. decimate 会不会保留绑骨（Smart UV 明说会，decimate 没说）；decimate 的结果能不能直接当 rig 的输入（ComfyUI 的数据流说可以，rig 的 API 页没写）。
19. Tripo 输出的 GLB 会不会用 Draco 或 KTX2。文档只提到可选的 meshopt（`compress: "geometry"`）。可以用本地的 `glb.mjs --inspect` 检查。
20. image-to-multiview 用的是哪个图像模型、输出多大；生成的背面会不会照抄正面的 logo。
21. 透明背景对建模好还是坏。
22. 文件上传是否收费（价目页没列）；file_token 的有效期。
23. 2025 年到 2026-03 的更新内容和具体日期（更新日志页没有）。
24. models-and-versions 页里「chat_image_2 = Best quality」和「Highest quality 选 banana_pro 或 seedream_v5」两种说法冲突，哪种是现在的官方推荐。

---

## 12. 来源

- 文档索引：https://developers.tripo3d.ai/llms.txt
- 图像：
  - https://developers.tripo3d.ai/en/docs/generation-image-to-image.md （按模型分的尺寸和 inputs 标签页只在渲染页 https://developers.tripo3d.ai/en/docs/generation-image-to-image 里）
  - https://developers.tripo3d.ai/en/docs/generation-text-to-image.md
- 型号与价格：
  - https://developers.tripo3d.ai/en/docs/models-and-versions.md
  - https://developers.tripo3d.ai/en/pricing （P Series 标签页的数据在 https://developers.tripo3d.ai/assets/PricingPage-BaJjD9rg.js ，2026-10-28 抓取，文件名会随部署变化）
- 更新日志：https://developers.tripo3d.ai/en/docs/changelog.md
- 3D 生成：
  - https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard.md
  - https://developers.tripo3d.ai/en/docs/generation-image-to-model/p.md
  - https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/standard.md
  - https://developers.tripo3d.ai/en/docs/generation-multiview-to-model/p.md
  - https://developers.tripo3d.ai/en/docs/generation-image-to-multiview.md
  - https://developers.tripo3d.ai/en/docs/generation-edit-multiview.md
- 动画：
  - https://developers.tripo3d.ai/en/docs/animations-rig-check.md
  - https://developers.tripo3d.ai/en/docs/animations-rig.md
  - https://developers.tripo3d.ai/en/docs/animations-retarget.md
- 模型处理：
  - https://developers.tripo3d.ai/en/docs/models-convert.md
  - https://developers.tripo3d.ai/en/docs/mesh-decimate （版本标签页）
  - https://developers.tripo3d.ai/en/docs/mesh-uv.md
  - https://developers.tripo3d.ai/en/docs/models-texture.md
- 其他文档页：
  - https://developers.tripo3d.ai/en/docs/task-query.md
  - https://developers.tripo3d.ai/en/docs/files.md
  - https://developers.tripo3d.ai/en/docs/rate-limits.md
  - https://developers.tripo3d.ai/en/docs/sdk.md
  - https://developers.tripo3d.ai/en/docs/comfyui-nodes.md
  - https://developers.tripo3d.ai/en/docs/cli.md
- 模型详情页：
  - https://developers.tripo3d.ai/en/models/p2
  - https://developers.tripo3d.ai/en/models/v3-1
  - https://developers.tripo3d.ai/en/models/rig
  - https://developers.tripo3d.ai/en/models/animation
  - https://developers.tripo3d.ai/en/models/texture
- Cookbook：
  - https://developers.tripo3d.ai/en/cookbook/gpt-6-astra-3d-game-scene-workflow
  - https://developers.tripo3d.ai/en/cookbook/ai-tailor-dressup-game
- CLI 随包文档（tripo-cli 0.7.3）：https://cdn.jsdelivr.net/npm/tripo-cli@0.7.3/skill/ 下的 `commands/generate.md`、`commands/process.md`、`commands/make.md`、`examples/animation.md`、`examples/game-asset.md`、`common-errors.md`；以及包里的 README：https://cdn.jsdelivr.net/npm/tripo-cli@0.7.3/README.md
- 本地镜像（2026-10-22，已和线上比对）：`Desktop/Tripo API网站/docs/research/2026-10-22/tripo-docs/`
