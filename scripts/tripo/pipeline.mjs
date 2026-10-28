// 访客角色流水线（Tripo API v3）。命令行入口是 visitors.mjs，这里是全部逻辑（selftest.mjs 也直接调 main）。
//
//   吉祥物参考图 →（可选）image-to-image 模板摆成 T 姿势 → image-to-image 换装（参考图 + 服装提示词）
//   → image-to-model（input 直接填换装图的 task_id）→ rig-check（免费）→ rig（v1.0 人形，spec=mixamo）
//   → retarget 预设动作（原地，一次最多 5 个，动作多了分批：animate、animate2…）
//   → 下载到 public/assets/visitors/<id>.glb（后面几批的动作由 Blender 精修并进第一批的骨架），写 manifest.json（含动画片段名）
//
// 为什么先换装成图片再建模：image-to-model 只有 input（图片）没有 prompt；但它的 input 可以填 text_to_image /
// image_to_image 任务的 task_id，而 image-to-image 收「参考图 + 编辑提示词」（generation-image-to-model/standard.md、
// generation-image-to-image.md）。/models/texture 只重画贴图不改形状，帽子、斗篷加不上去。
//
// 能续跑、不重复扣费：
// - 每一步的 task_id 和请求指纹记在 assets-src/tripo-state.json（已被 git 忽略），重跑只补没做完的步骤
// - 建任务前先在状态里留「正在建」的记号；建任务时断线（任务可能已经建好）会停下来，先对账再 --adopt / --reroll
// - 清单改了（提示词、参数），建过的步骤不会悄悄重做，而是停下来提示 --reroll
// - 草稿（status: draft）只跑到换装图（2D 预览，每个约 10 积分），改成 approved 才做 3D
// - 状态文件加锁：这台机器上同时跑着别的会话，两个进程不能同时改它
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as C from './catalog.mjs';
import { BASE_URL, DownloadError, TripoError, apiKeyStatus, createClient, download, mask, readApiKey, shortUrl } from './client.mjs';
import { GAME_LIMITS, checkForGame, formatInspection, imageInfo, inspectGlb } from './glb.mjs';
import { refineGlb } from '../blender/refine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export const DEFAULT_PATHS = {
  root: ROOT,
  manifest: join(HERE, 'visitors.json'),
  env: join(ROOT, '.env.local'),
  state: join(ROOT, 'assets-src', 'tripo-state.json'),
  raw: join(ROOT, 'assets-src', 'visitors'),
  out: join(ROOT, 'public', 'assets', 'visitors'),
};

/** 一次 retarget 最多 5 个动作，动作多了分批建任务：animate、animate2…（最多这么多批） */
const MAX_BATCHES = 4;
/** 第 i 批（从 0 起）动作任务的步骤名：animate、animate2、animate3… */
const animStep = (i) => (i === 0 ? 'animate' : `animate${i + 1}`);
const ANIMATE_STEPS = Array.from({ length: MAX_BATCHES }, (_, i) => animStep(i));

export const STEPS = ['upload', 'prep', 'costume', 'touchup', 'costume-upload', 'views', 'model', 'rigcheck', 'rig', ...ANIMATE_STEPS, 'convert', 'export'];
/** 草稿也能跑的步骤（便宜的 2D 预览）；从 model 起要 status: approved */
const PREVIEW = new Set(['upload', 'prep', 'costume', 'touchup', 'costume-upload', 'views']);
/** file_token 的有效期文档没写；上传免费，超过 30 分钟就重新传（presign 链接也是 30 分钟） */
const UPLOAD_MAX_AGE_MS = 30 * 60_000;
const BAD_END = new Set(['failed', 'banned', 'expired', 'cancelled']);

const HELP = `Tripo 访客流水线：吉祥物换装 → 3D 模型 → 绑骨 → 预设动作 → public/assets/visitors/

  node scripts/tripo/visitors.mjs --dry-run [id ...]          打印每个请求（key 打码）和积分估算。不联网、不写文件、不花钱
  node scripts/tripo/visitors.mjs --run <id ...|all> --yes     真跑（会扣积分）。重跑只补没做完的步骤，不会重复建任务
        --until <步骤>       跑到这一步为止，比如 --until costume 只出换装图，--until touchup 出到修过的图
        --max-credits <数>   这一次最多花多少积分（默认 = 估算值）
  node scripts/tripo/visitors.mjs --status                     本地状态：每一步的 task_id、实扣积分、文件（不联网）
  node scripts/tripo/visitors.mjs --balance | --usage          查余额 / 最近的扣费记录（免费接口，也能确认 key 好不好用）
  node scripts/tripo/visitors.mjs --reroll <id> <步骤>         作废这一步和它的下游，下次 --run 重新生成（会再扣费）
  node scripts/tripo/visitors.mjs --adopt <id> <步骤> <task_id>  把已经建好的任务记进状态（建任务时断线后对账用）
  node scripts/tripo/visitors.mjs --inspect <文件.glb>         检查 GLB 符不符合游戏要求

步骤：upload → prep → costume → [touchup] → [costume-upload → views] → model → rigcheck → rig → animate → [animate2…] → [convert] → export
清单 scripts/tripo/visitors.json · 状态 assets-src/tripo-state.json · key 读 .env.local 的 TRIPO_API_KEY`;

// ---------------------------------------------------------------- 小工具

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const now = () => new Date().toISOString();
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
const fmt = (c) => (c == null ? '未核实' : String(c));
const usd = (c) => (c * C.USD_PER_CREDIT).toFixed(2);
const slug = (s) => String(s).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
const errText = (e) => (e instanceof TripoError ? e.describe() : mask(e?.message ?? e));

/** .env.local 里 key 的情况，给人看的一句话（不含 key 本身） */
function keyProblem(ctx) {
  const env = ctx.rel(ctx.paths.env);
  return {
    ok: null,
    'no-file': `${env} 还不存在：在项目根目录建这个文件，写一行 TRIPO_API_KEY=<你的 key>`,
    'no-line': `${env} 里没有 TRIPO_API_KEY 这一行`,
    empty: `${env} 里的 TRIPO_API_KEY 还是空的，填上 key 再真跑`,
  }[apiKeyStatus(ctx.paths.env)];
}

/** 深合并：对象逐层合并，数组和标量整体替换；值写 null 表示删掉这个键；$ 开头的键是注释 */
function merge(a, b) {
  const out = {};
  for (const [k, v] of Object.entries(a ?? {})) if (!k.startsWith('$')) out[k] = isObj(v) ? merge({}, v) : v;
  for (const [k, v] of Object.entries(b ?? {})) {
    if (k.startsWith('$')) continue;
    if (v === null) delete out[k];
    else if (isObj(v)) out[k] = merge(isObj(out[k]) ? out[k] : {}, v);
    else out[k] = v;
  }
  return out;
}
/** 请求体：去掉注释键和空值 */
const requestOf = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => !k.startsWith('$') && v != null));
const clipsOf = (cfg) => Object.entries(cfg.animate?.clips ?? {}).filter(([k, v]) => !k.startsWith('$') && v);

/**
 * 动作分批：一次 retarget 最多 C.MAX_CLIPS_PER_RETARGET（5）个，批数取最少的，再把动作平均分到各批（前面的批不比后面的少）。
 * 8 个 = 4 + 4，不是 5 + 3：原来的 4 个动作仍然是第一批，已经建过的 animate 任务指纹不变，不会被判成「配置改过」，第二批只补新的 4 个
 */
export function batchClips(clips) {
  const n = Math.ceil(clips.length / C.MAX_CLIPS_PER_RETARGET);
  const out = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const size = Math.floor(clips.length / n) + (i < clips.length % n ? 1 : 0);
    out.push(clips.slice(at, at + size));
    at += size;
  }
  return out;
}

// ---------------------------------------------------------------- 清单、参考图、状态

function loadManifest(ctx) {
  const p = ctx.paths.manifest;
  if (!existsSync(p)) throw new Error(`找不到清单 ${ctx.rel(p)}`);
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${ctx.rel(p)} 不是合法的 JSON：${e.message}`);
  }
}

function variantConfigs(manifest) {
  return (manifest.variants ?? []).map((v) => {
    const cfg = merge(manifest.defaults, v.overrides);
    return {
      id: v.id,
      label: v.label ?? v.id,
      status: v.status ?? 'draft',
      route: v.route ?? cfg.route ?? 'single',
      reference: v.reference ?? manifest.reference,
      costume: v.costume,
      /** 这个访客额外要修的地方（接在 touchup.promptTemplate 的 {extra} 处），没有就只做默认的修改 */
      touchup: v.touchup,
      cfg,
    };
  });
}

/** 参考图可以是文件，也可以是目录（目录里只能有一张图）。顺便按接口限制查一遍尺寸、大小、宽高比 */
function resolveReference(ctx, given) {
  const r = { given, key: String(given ?? '').replace(/[\\/]+$/, ''), exists: false, problems: [], warnings: [] };
  if (!given) {
    r.problems.push('visitors.json 里没写 reference（吉祥物参考图）');
    return r;
  }
  const p = ctx.abs(given);
  if (!existsSync(p)) {
    r.problems.push(`${given} 还不存在`);
    return r;
  }
  let file = p;
  if (statSync(p).isDirectory()) {
    const imgs = readdirSync(p).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort();
    if (imgs.length !== 1) {
      r.problems.push(imgs.length ? `${given} 里有 ${imgs.length} 张图（${imgs.join('、')}），在 visitors.json 的 reference 里写明用哪一张` : `${given} 里还没有图片（PNG / JPEG / WebP）`);
      return r;
    }
    file = join(p, imgs[0]);
  }
  const buf = readFileSync(file);
  Object.assign(r, { path: file, key: ctx.rel(file), bytes: buf.length, sha: sha256(buf), info: imageInfo(buf) });
  if (!r.info) {
    r.problems.push(`${r.key} 不是 PNG / JPEG / WebP 图片`);
    return r;
  }
  r.exists = true;
  if (buf.length > 20 * 1024 * 1024) r.problems.push(`${r.key} 超过 20 MB（图片接口的上限）`);
  const { width: w, height: h } = r.info;
  if (w && h) {
    if (Math.min(w, h) < 256) r.problems.push(`${r.key} 只有 ${w}×${h}，文档要求至少 256×256（建议 1024 以上）`);
    else if (Math.min(w, h) < 1024) r.warnings.push(`${r.key} 是 ${w}×${h}，能用；1024 以上的清楚原图效果更好`);
    if (w / h > 3 || h / w > 3) r.problems.push(`${r.key} 宽高比 ${w}:${h} 超出 image-to-image 的 1:3 ~ 3:1`);
    if (w * h > 36e6) r.problems.push(`${r.key} 超过 3600 万像素（image-to-image 的上限）`);
  }
  return r;
}

function loadState(ctx) {
  const p = ctx.paths.state;
  if (!existsSync(p)) return { version: 1, nodes: {}, history: [] };
  const s = JSON.parse(readFileSync(p, 'utf8'));
  s.nodes ??= {};
  s.history ??= [];
  return s;
}

function saveState(ctx) {
  const p = ctx.paths.state;
  mkdirSync(dirname(p), { recursive: true });
  ctx.state.updated_at = now();
  writeFileSync(`${p}.tmp`, `${JSON.stringify(ctx.state, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** 状态文件的锁：返回释放函数。上次被 Ctrl+C 打断留下的锁（进程已经不在）会被接管 */
function acquireLock(ctx) {
  const p = `${ctx.paths.state}.lock`;
  mkdirSync(dirname(p), { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(p, JSON.stringify({ pid: process.pid, at: now() }), { flag: 'wx' });
      return () => {
        try {
          unlinkSync(p);
        } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let info = {};
      try {
        info = JSON.parse(readFileSync(p, 'utf8'));
      } catch {}
      if (info.pid && info.pid !== process.pid && alive(info.pid)) {
        throw new Error(`另一个流水线进程（pid ${info.pid}，${info.at} 开始）正在用状态文件。等它结束；确定没有在跑的话删掉 ${ctx.rel(p)}`);
      }
      ctx.log(`· 上次留下的锁（pid ${info.pid ?? '?'}）已经没人用了，接管`);
      try {
        unlinkSync(p);
      } catch {}
    }
  }
  throw new Error(`拿不到锁 ${ctx.rel(p)}`);
}

// ---------------------------------------------------------------- 每个访客的步骤图

function fileOf(ctx, key, field) {
  const f = ctx.state.nodes[key]?.files?.[field];
  if (!f) return null;
  return localImage(ctx.abs(f));
}

/** 本地图片（不存在就是 null）：上传节点的 source 用 */
function localImage(p) {
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  return { path: p, sha: sha256(buf), info: imageInfo(buf), bytes: buf.length };
}

/**
 * 一个访客的全部步骤（按执行顺序）。共用步骤（上传参考图、预处理）的 key 带参考图路径，几个访客共用同一个任务。
 * body(r)：r(上游 key) 把上游换成具体值——真跑时是 task_id / file_token，演练时是占位文字，算指纹时上传换成文件的 sha256
 */
function planVariant(ctx, vc, ref) {
  const c = vc.cfg;
  const nodes = [];
  const refKey = `ref:${ref.key || '(没有参考图)'}`;
  const dir = join(ctx.paths.raw, vc.id ?? '_');
  const add = (n) => {
    nodes.push({ deps: [], variant: n.shared ? null : vc.id, ...n });
    return n.key;
  };

  let prev = add({
    key: `${refKey}:upload`,
    step: 'upload',
    shared: true,
    kind: 'upload',
    label: '上传参考图',
    source: () => (ref.exists ? { path: ref.path, sha: ref.sha, info: ref.info, bytes: ref.bytes } : null),
    sourceLabel: ref.key || '(没有参考图)',
  });

  const prepReq = requestOf(c.prep?.request);
  (c.prep?.templates ?? []).forEach((tmpl, i) => {
    const input = prev;
    prev = add({
      key: `${refKey}:prep${i + 1}`,
      step: 'prep',
      shared: true,
      kind: 'task',
      label: `参考图预处理 ${i + 1}（template=${tmpl}）`,
      endpoint: '/generation/image-to-image',
      deps: [input],
      body: (r) => ({ input: r(input), template: tmpl, ...prepReq }),
      estimate: (b) => C.imageCredits(b),
      out: { kind: 'image', dest: join(ctx.paths.raw, '_shared', `${slug(basename(ref.key).replace(/\.[^.]+$/, '')) || 'reference'}-prep${i + 1}-${tmpl}`) },
    });
  });

  const costumeReq = requestOf(c.costume?.request);
  const prompt = String(c.costume?.promptTemplate ?? '{costume}').replaceAll('{costume}', String(vc.costume ?? '').trim());
  const costumeInput = prev;
  const costume = add({
    key: `${vc.id}:costume`,
    step: 'costume',
    kind: 'task',
    label: '换装图（image-to-image）',
    endpoint: '/generation/image-to-image',
    deps: [costumeInput],
    body: (r) => ({ input: r(costumeInput), prompt, ...costumeReq }),
    estimate: (b) => C.imageCredits(b),
    out: { kind: 'image', dest: join(dir, 'costume') },
  });

  // 修图（可选，touchup.enabled）：在换装图上只改提示词点名的地方（手指数、多出来的配件），其余照旧。
  // 下游（建模、四视图）改用修过的图；换装图本身不动，不满意可以只 --reroll <id> touchup。
  // touchup.source = "local"：修图在别处做（比如公司素材中台 vmc），挑好的图放在 assets-src/visitors/<id>/touchup.png，
  // 这里只把它传上去（免费）给建模，不再调 image-to-image；换了图会按文件内容重新传，下游会提示 --reroll
  let look = costume;
  if (c.touchup?.enabled && c.touchup.source === 'local') {
    const file = join(dir, 'touchup.png');
    look = add({
      key: `${vc.id}:touchup-upload`,
      step: 'touchup',
      kind: 'upload',
      label: '上传修过的换装图（本地文件）',
      source: () => localImage(file),
      sourceLabel: `${ctx.rel(dir)}/touchup.png`,
    });
  } else if (c.touchup?.enabled) {
    const touchReq = requestOf(c.touchup.request);
    const touchPrompt = String(c.touchup.promptTemplate ?? '{extra}')
      .replaceAll('{extra}', String(vc.touchup ?? '').trim())
      .replace(/\s+/g, ' ')
      .trim();
    look = add({
      key: `${vc.id}:touchup`,
      step: 'touchup',
      kind: 'task',
      label: '修图（image-to-image）',
      endpoint: '/generation/image-to-image',
      deps: [costume],
      body: (r) => ({ input: r(costume), prompt: touchPrompt, ...touchReq }),
      estimate: (b) => C.imageCredits(b),
      out: { kind: 'image', dest: join(dir, 'touchup') },
    });
  }

  const modelReq = requestOf(c.model?.request);
  const modelOut = { kind: 'model', dest: join(dir, 'model'), preview: join(dir, 'model-preview') };
  let model;
  if (vc.route === 'multiview') {
    // image-to-multiview 的 input 只收 file_token / URL（不收 task_id），所以要把换装图下回来再传上去（本地修图本身就是上传，直接用）
    const lookNode = nodes.find((x) => x.key === look);
    const up = lookNode.kind === 'upload' ? look : add({
      key: `${vc.id}:costume-upload`,
      step: 'costume-upload',
      kind: 'upload',
      label: look === costume ? '上传换装图' : '上传修过的换装图',
      source: () => fileOf(ctx, look, 'image'),
      sourceLabel: `${ctx.rel(dir)}/${look === costume ? 'costume' : 'touchup'}.*`,
    });
    const views = add({
      key: `${vc.id}:views`,
      step: 'views',
      kind: 'task',
      label: '四视图（image-to-multiview）',
      endpoint: '/generation/image-to-multiview',
      deps: [up],
      body: (r) => ({ input: r(up), ...requestOf(c.views?.request) }),
      estimate: () => ({ credits: C.IMAGE_TO_MULTIVIEW_CREDITS, note: 'Image to Multiview' }),
      out: { kind: 'views', dest: join(dir, 'view') },
    });
    const { enable_image_autofix: _drop, ...mvReq } = modelReq; // multiview-to-model 没有这个参数
    model = add({
      key: `${vc.id}:model`,
      step: 'model',
      kind: 'task',
      label: '3D 模型（multiview-to-model）',
      endpoint: '/generation/multiview-to-model',
      deps: [views],
      body: (r) => ({ inputs: [{ task_id: r(views) }], ...mvReq }),
      estimate: (b) => C.model3dCredits(b),
      out: modelOut,
    });
  } else {
    model = add({
      key: `${vc.id}:model`,
      step: 'model',
      kind: 'task',
      label: '3D 模型（image-to-model）',
      endpoint: '/generation/image-to-model',
      deps: [look],
      body: (r) => ({ input: r(look), ...modelReq }),
      estimate: (b) => C.model3dCredits(b),
      out: modelOut,
    });
  }

  const rigcheck = add({
    key: `${vc.id}:rigcheck`,
    step: 'rigcheck',
    kind: 'task',
    label: '绑骨检查（rig-check）',
    endpoint: '/animations/rig-check',
    deps: [model],
    body: (r) => ({ input: r(model) }),
    estimate: () => ({ credits: C.RIG_CHECK_CREDITS, note: '免费' }),
    out: { kind: 'rigcheck' },
  });

  const rigReq = requestOf(c.rig?.request);
  const rig = add({
    key: `${vc.id}:rig`,
    step: 'rig',
    kind: 'task',
    label: `绑骨（${rigReq.model ?? 'v1.0-20240301'}，spec=${rigReq.spec ?? '默认'}）`,
    endpoint: '/animations/rig',
    deps: [model, rigcheck],
    body: (r) => ({ input: r(model), ...rigReq }),
    estimate: () => ({ credits: C.RIG_CREDITS, note: 'Auto Rig' }),
    out: { kind: 'model', dest: join(dir, 'rigged') },
  });

  // 动作：一批最多 5 个（animate），多了分到 animate2…（都从同一个绑骨结果出发，互不依赖）。
  // 只有一批时和以前一模一样（key、请求、指纹都不变）；后面几批的结果由 Blender 精修并进第一批的骨架（export 步骤）
  const animReq = requestOf(c.animate?.request);
  const batches = batchClips(clipsOf(c));
  if (!batches.length) batches.push([]); // 清单里没写动作：校验会报错，但步骤图里还是要有 animate
  const animates = batches.slice(0, MAX_BATCHES).map((batch, i) => {
    const presets = batch.map(([, p]) => p);
    return add({
      key: `${vc.id}:${animStep(i)}`,
      step: animStep(i),
      kind: 'task',
      label: `预设动作 ${presets.length} 个（retarget${batches.length > 1 ? `，第 ${i + 1}/${batches.length} 批：${batch.map(([role]) => role).join('、')}` : ''}）`,
      endpoint: '/animations/retarget',
      deps: [rig],
      body: (r) => ({ input: r(rig), ...(presets.length === 1 ? { animation: presets[0] } : { animations: presets }), ...animReq }),
      estimate: () => ({ credits: C.RETARGET_CREDITS_PER_CLIP * presets.length, note: `${presets.length} 个动作 × ${C.RETARGET_CREDITS_PER_CLIP}` }),
      out: { kind: 'model', dest: join(dir, i === 0 ? 'animated' : `animated${i + 1}`) },
    });
  });
  const animate = animates[0];

  let last = animate;
  if (c.convert?.enabled) {
    const convReq = requestOf(c.convert?.request);
    last = add({
      key: `${vc.id}:convert`,
      step: 'convert',
      kind: 'task',
      label: '格式转换（压贴图尺寸）',
      endpoint: '/models/convert',
      deps: [animate],
      body: (r) => ({ input: r(animate), ...convReq }),
      estimate: (b) => C.convertCredits(b),
      out: { kind: 'model', dest: join(dir, 'converted') },
    });
  }
  add({ key: `${vc.id}:export`, step: 'export', kind: 'local', label: `导出到 ${ctx.rel(join(ctx.paths.out, `${vc.id}.glb`))}`, deps: [last, ...animates.slice(1)] });
  return nodes;
}

/** 读清单、状态，给每个访客建步骤图 */
function prepare(ctx) {
  const manifest = loadManifest(ctx);
  const vcs = variantConfigs(manifest);
  ctx.state = loadState(ctx);
  ctx.nodeByKey = new Map();
  const refs = new Map();
  const plans = new Map();
  for (const vc of vcs) {
    const k = String(vc.reference ?? '');
    if (!refs.has(k)) refs.set(k, resolveReference(ctx, vc.reference));
    const nodes = planVariant(ctx, vc, refs.get(k));
    plans.set(vc.id, nodes);
    for (const n of nodes) if (!ctx.nodeByKey.has(n.key)) ctx.nodeByKey.set(n.key, n);
  }
  return { manifest, vcs, refs, plans };
}

function select(vcs, ids, { requireIds = false } = {}) {
  if (!ids.length) {
    if (requireIds) throw new Error('--run 后面要写访客 id（或 all）');
    return vcs;
  }
  if (ids.includes('all')) return vcs;
  const unknown = ids.filter((id) => !vcs.some((v) => v.id === id));
  if (unknown.length) throw new Error(`visitors.json 里没有：${unknown.join('、')}（有：${vcs.map((v) => v.id).join('、')}）`);
  return vcs.filter((v) => ids.includes(v.id));
}

// ---------------------------------------------------------------- 校验

function validate(vcs) {
  const errors = [];
  const warnings = [];
  const ids = new Set();
  if (!vcs.length) errors.push('visitors.json 里没有 variants');
  for (const vc of vcs) {
    const at = `访客 ${vc.id ?? '(没有 id)'}`;
    const c = vc.cfg;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(vc.id ?? '')) errors.push(`${at}：id 只能用小写字母、数字和 -（会用作文件名）`);
    if (ids.has(vc.id)) errors.push(`${at}：id 重复`);
    ids.add(vc.id);
    if (!['draft', 'approved'].includes(vc.status)) errors.push(`${at}：status 只能是 draft 或 approved`);
    if (!['single', 'multiview'].includes(vc.route)) errors.push(`${at}：route 只能是 single 或 multiview`);
    if (typeof vc.costume !== 'string' || !vc.costume.trim()) errors.push(`${at}：costume（服装描述）是空的`);
    if (!String(c.costume?.promptTemplate ?? '').includes('{costume}')) warnings.push(`${at}：costume.promptTemplate 里没有 {costume}，服装描述进不了提示词`);
    for (const t of c.prep?.templates ?? []) if (!C.IMAGE_TEMPLATES.includes(t)) errors.push(`${at}：prep.templates 里的 ${t} 不是文档里的模板（${C.IMAGE_TEMPLATES.join(' / ')}）`);
    if (c.touchup?.enabled && !String(c.touchup.promptTemplate ?? '').trim()) errors.push(`${at}：touchup 打开了，但 touchup.promptTemplate 是空的`);
    if (vc.touchup != null && !c.touchup?.enabled) warnings.push(`${at}：写了 touchup，但 touchup.enabled 没打开，不会修图`);
    const imageSteps = [['prep', c.prep?.request], ['costume', c.costume?.request], ...(c.touchup?.enabled ? [['touchup', c.touchup.request]] : [])];
    for (const [name, req] of imageSteps) {
      const model = req?.model ?? 'seedream_v5';
      if (!C.IMAGE_MODELS.includes(model)) warnings.push(`${at}：${name}.request.model = ${model} 不在价目表里，积分算不出来`);
      if (req?.quality != null && !C.QUALITY_MODELS.includes(model)) errors.push(`${at}：${name}.request.quality 只有 chat_image_2 / 2.5 收，${model} 会直接报错（在 overrides 里写 "quality": null 去掉）`);
      if (req?.background != null && !C.BACKGROUND_MODELS.includes(model)) warnings.push(`${at}：${name}.request.background 只有 chat_image_2.5 认，${model} 会忽略`);
      if (req?.aspect_ratio != null && !String(model).startsWith('banana')) warnings.push(`${at}：${name}.request.aspect_ratio 只有 banana 系列认`);
      if (req?.size != null && C.sizeTier(req.size) == null) errors.push(`${at}：${name}.request.size = ${req.size} 看不懂（写 2048x2048 或 2K 这种）`);
    }
    const m = c.model?.request ?? {};
    if (m.face_limit == null) warnings.push(`${at}：model.request 没写 face_limit，面数由模型自适应，可能远超游戏预算`);
    else if (m.face_limit > GAME_LIMITS.triangles) warnings.push(`${at}：face_limit ${m.face_limit} 超过游戏预算 ${GAME_LIMITS.triangles} 三角面`);
    if (m.quad) errors.push(`${at}：model.request.quad=true 会强制输出 FBX，这条流水线要 GLB`);
    if (m.generate_parts) errors.push(`${at}：model.request.generate_parts 和纹理不兼容`);
    if (m.export_orientation) warnings.push(`${at}：后面还要绑骨 / 动画时文档建议不设 export_orientation（可能转错方向却照样报 success）`);
    if (m.compress) warnings.push(`${at}：model.request.compress 会在绑骨前就做 meshopt 压缩，文档没说绑骨能不能吃（未核实），建议不设`);
    const rig = c.rig?.request ?? {};
    const rigModel = rig.model ?? 'v1.0-20240301';
    if (!C.RIG_MODELS.includes(rigModel)) errors.push(`${at}：rig.request.model = ${rigModel} 不是文档里的版本（${C.RIG_MODELS.join(' / ')}）`);
    if ((rig.rig_type ?? 'biped') !== 'biped') warnings.push(`${at}：rig_type 不是 biped（spec 只对 biped 生效）`);
    if (rig.spec !== 'mixamo') warnings.push(`${at}：rig.request.spec 不是 mixamo，以后从 Mixamo 补动作骨骼名会对不上`);
    if ((rig.out_format ?? 'glb') !== 'glb') errors.push(`${at}：rig.request.out_format 要 glb`);
    const clips = clipsOf(c);
    if (!clips.length) errors.push(`${at}：animate.clips 是空的`);
    const batches = batchClips(clips);
    if (batches.length > MAX_BATCHES) errors.push(`${at}：animate.clips 有 ${clips.length} 个动作，最多分 ${MAX_BATCHES} 批（每批最多 ${C.MAX_CLIPS_PER_RETARGET} 个）`);
    const dups = [...new Set(clips.map(([, p]) => p).filter((p, i, all) => all.indexOf(p) !== i))];
    if (dups.length) errors.push(`${at}：animate.clips 里有重复的预设 ${dups.join('、')}（同一个预设只要一次，GLB 里的片段名会冲突）`);
    if (batches.length > 1 && !c.refine?.enabled) errors.push(`${at}：动作有 ${clips.length} 个，要分 ${batches.length} 批 retarget；后面几批的动作只有 Blender 精修能并进同一个 GLB，refine.enabled 要打开`);
    if (batches.length > 1 && c.convert?.enabled) warnings.push(`${at}：动作分了 ${batches.length} 批，convert 只转第一批；后面几批用 retarget 原样的 GLB 并进来（贴图在精修里限到 2048，不受影响）`);
    const allowed = rigModel === 'v1.0-20240301' ? C.V1_BIPED_PRESETS : C.V25_BIPED_PRESETS;
    for (const [role, p] of clips) if (!allowed.includes(p)) errors.push(`${at}：animate.clips.${role} = ${p} 不在 ${rigModel} 的预设列表里`);
    const a = c.animate?.request ?? {};
    if (a.animate_in_place !== true) warnings.push(`${at}：animate.request.animate_in_place 不是 true，游戏要原地动画`);
    if ((a.out_format ?? 'glb') !== 'glb') errors.push(`${at}：animate.request.out_format 要 glb`);
    if (c.convert?.enabled) warnings.push(`${at}：convert 打开了。文档里 convert 的 task_id 输入只列了生成类任务，能不能吃 retarget 的结果、format=GLTF 回来是不是 .glb 都没核实；回来的不是 GLB 会退回用 retarget 的结果`);
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------- 状态判断、指纹

/** r(上游 key) 的三种取值方式：send（真发请求）、hash（算指纹）、show（演练里显示） */
function resolver(ctx, mode) {
  return (key) => {
    const n = ctx.nodeByKey.get(key);
    const rec = ctx.state.nodes[key];
    if (n.kind === 'upload') {
      if (mode === 'send') return rec?.file_token;
      if (mode === 'hash') {
        const s = n.source();
        return s ? `sha256:${s.sha}` : null;
      }
      return `<file_token：上传 ${n.sourceLabel} 得到>`;
    }
    if (mode === 'show') return rec?.task_id ?? `<task_id：${key} 完成后得到>`;
    return rec?.task_id ?? null;
  };
}

const hashOf = (ctx, n) => sha256(JSON.stringify(canon({ endpoint: n.endpoint, body: n.body(resolver(ctx, 'hash')) }))).slice(0, 16);

function depsReady(ctx, n) {
  return n.deps.every((d) => {
    const dn = ctx.nodeByKey.get(d);
    return dn.kind === 'upload' ? !!dn.source() : !!ctx.state.nodes[d]?.task_id;
  });
}

/** done / todo / running / pending（建任务时断线）/ failed / changed（请求变了）/ lazy（上传，用到时再传）/ local */
function nodeStatus(ctx, n) {
  if (n.kind === 'upload') return { s: 'lazy', rec: ctx.state.nodes[n.key] };
  if (n.kind === 'local') return { s: 'local' };
  const rec = ctx.state.nodes[n.key];
  if (!rec) return { s: 'todo' };
  if (!rec.task_id) return rec.pending_since ? { s: 'pending', rec } : { s: 'todo' };
  if (rec.hash && depsReady(ctx, n) && rec.hash !== hashOf(ctx, n)) return { s: 'changed', rec };
  if (rec.status === 'success') return { s: 'done', rec };
  if (BAD_END.has(rec.status)) return { s: 'failed', rec };
  return { s: 'running', rec };
}

const STATUS_TEXT = {
  done: '✓ 已完成',
  todo: '待做',
  running: '… 进行中',
  pending: '! 建任务时断线（可能已扣费，要对账）',
  failed: '✗ 失败 / 过期',
  changed: '! 配置改过（要 --reroll 才会重做）',
  lazy: '用到时再传',
  local: '本地',
};

/** 把选中访客的步骤排成一张表：每步的状态、估算，以及这次 --run 会不会新建它 */
function summarize(ctx, vcs, plans, { until } = {}) {
  const rows = [];
  const seen = new Set();
  const untilIdx = until ? STEPS.indexOf(until) : Infinity;
  for (const vc of vcs) {
    let stopped = false;
    for (const n of plans.get(vc.id)) {
      const st = nodeStatus(ctx, n);
      const beyond = STEPS.indexOf(n.step) > untilIdx;
      const gated = !PREVIEW.has(n.step) && vc.status !== 'approved';
      const blocked = beyond ? 'until' : gated ? 'draft' : stopped ? 'stop' : null;
      if (['pending', 'changed', 'failed'].includes(st.s)) stopped = true;
      if (seen.has(n.key)) continue; // 共用步骤只列一次
      seen.add(n.key);
      const est = n.estimate ? n.estimate(n.body(resolver(ctx, 'show'))) : { credits: 0, note: n.kind === 'upload' ? '价目表没列上传，按免费计（未核实）' : '本地' };
      rows.push({ n, vc, st, est, willRun: !blocked && st.s === 'todo' && n.kind === 'task', blocked });
    }
  }
  return rows;
}

function tally(rows) {
  const known = rows.reduce((s, r) => s + (r.est.credits ?? 0), 0);
  const unknown = rows.filter((r) => r.est.credits == null).length;
  return { known, unknown, count: rows.length };
}

// ---------------------------------------------------------------- 演练

function printRequest(ctx, n) {
  const L = ctx.log;
  if (n.kind === 'local') {
    L(`      （本地，不联网）把最后一步的 GLB 复制成 ${ctx.rel(join(ctx.paths.out, `${n.variant}.glb`))}，检查三角面 / 贴图 / 压缩 / 原地动画，`);
    L(`      把动画片段名写进 ${ctx.rel(join(ctx.paths.out, 'manifest.json'))}`);
    return;
  }
  if (n.kind === 'upload') {
    const s = n.source();
    const webp = s?.info?.mime === 'image/webp';
    L(`      POST ${ctx.baseUrl}${webp ? '/files/presign  {"format":"webp"}，再 PUT 到返回的 presigned_url（不带 key）' : '/files'}`);
    L('      Authorization: Bearer ***（.env.local 的 TRIPO_API_KEY，打码）');
    if (!webp) L('      Content-Type: multipart/form-data（边界由 fetch 生成）');
    L(`      file=@${s ? `${ctx.rel(s.path)}（${s.info?.mime}，${s.info?.width}×${s.info?.height}，${(s.bytes / 1024 / 1024).toFixed(2)} MB）` : `${n.sourceLabel}（文件还没有）`}`);
    return;
  }
  L(`      POST ${ctx.baseUrl}${n.endpoint}`);
  L('      Authorization: Bearer ***（.env.local 的 TRIPO_API_KEY，打码）');
  L('      Content-Type: application/json');
  for (const line of JSON.stringify(n.body(resolver(ctx, 'show')), null, 2).split('\n')) L(`      ${line}`);
}

function printEstimate(ctx, title, rows) {
  const L = ctx.log;
  const groups = new Map();
  for (const r of rows) {
    const k = `${r.n.step}|${r.est.note}|${r.est.credits}`;
    const g = groups.get(k) ?? { step: r.n.step, note: r.est.note, unit: r.est.credits, count: 0 };
    g.count++;
    groups.set(k, g);
  }
  const t = tally(rows);
  L(`\n${title}`);
  if (!rows.length) {
    L('  （没有要新建的任务）');
    return t;
  }
  L(`  ${'步骤'.padEnd(13)}${'次数'.padStart(4)}${'单价'.padStart(7)}${'小计'.padStart(7)}  说明`);
  for (const g of groups.values()) {
    const sub = g.unit == null ? '?' : String(g.unit * g.count);
    L(`  ${g.step.padEnd(15)}${String(g.count).padStart(4)}${fmt(g.unit).padStart(8)}${sub.padStart(8)}  ${g.note ?? ''}`);
  }
  L(`  合计：${t.count} 个任务，约 ${t.known} 积分 ≈ ${usd(t.known)} 美元${t.unknown ? `（另有 ${t.unknown} 项价格未核实）` : ''}`);
  return t;
}

function cmdDryRun(ctx, a) {
  const L = ctx.log;
  const { vcs, refs, plans } = prepare(ctx);
  const sel = select(vcs, a.rest);
  const { errors, warnings } = validate(vcs);
  const keyIssue = keyProblem(ctx); // 只判断有没有，不读出来打印
  const drafts = sel.filter((v) => v.status !== 'approved').length;
  L('Tripo 访客流水线 · 演练（--dry-run）：不联网、不写文件、不花积分');
  L(`  清单 ${ctx.rel(ctx.paths.manifest)}：${sel.length} 个访客（草稿 ${drafts} 个）${a.until ? `，--until ${a.until}` : ''}`);
  L(`  API key：${keyIssue ? `✗ ${keyIssue}` : '.env.local 里有 TRIPO_API_KEY（不显示）'}`);
  for (const r of new Set(sel.map((v) => refs.get(String(v.reference ?? ''))))) {
    L(`  参考图：${r.exists ? `${r.key}（${r.info.mime}，${r.info.width}×${r.info.height}）` : r.given ?? '(未设置)'}`);
    for (const p of r.problems) L(`    ✗ ${p}${r.exists ? '' : '（真跑前要放好）'}`);
    for (const w of r.warnings) L(`    · ${w}`);
  }
  L(`  状态文件：${existsSync(ctx.paths.state) ? `${ctx.rel(ctx.paths.state)}（已记录 ${Object.keys(ctx.state.nodes).length} 步）` : `${ctx.rel(ctx.paths.state)} 还没有（第一次真跑时创建）`}`);
  for (const e of errors) L(`  ✗ ${e}`);
  for (const w of warnings) L(`  · ${w}`);
  L(`\n每个任务建好后：GET ${ctx.baseUrl}/tasks/{task_id} 轮询（2 秒起、逐渐放到 10 秒一次，单步最多等 20 分钟），`);
  L('成功后立刻下载 output 里的签名链接（不带 key）到 assets-src/visitors/<id>/；链接过期就重新查一次任务拿新链接。');

  const rows = summarize(ctx, sel, plans, { until: a.until });
  let i = 0;
  let group = null;
  for (const row of rows) {
    const { n, vc, st, est } = row;
    const g = n.shared ? `共用 · 参考图 ${n.key.split(':').slice(1, -1).join(':')}` : `访客 ${vc.id}「${vc.label}」${vc.status === 'approved' ? '' : '（草稿：--run 只做到换装图）'}`;
    if (g !== group) {
      group = g;
      L(`\n── ${g}`);
    }
    const tid = st.rec?.task_id ? ` ${st.rec.task_id}` : '';
    const paid = st.rec?.credits != null ? `，实扣 ${st.rec.credits}` : '';
    const block = row.blocked && st.s === 'todo' ? { until: '（超出 --until）', draft: '（草稿，暂不做）', stop: '（前面有步骤要先处理）' }[row.blocked] : '';
    const price = n.kind === 'task' ? ` · 约 ${fmt(est.credits)} 积分（${est.note}）` : n.kind === 'upload' ? ` · ${est.note}` : '';
    L(`[${++i}] ${n.step} · ${n.label} — ${STATUS_TEXT[st.s]}${tid}${paid}${block}${price}`);
    printRequest(ctx, n);
  }

  const taskRows = rows.filter((r) => r.n.kind === 'task');
  L(`\n── 积分估算（价格：${C.PRICING_SOURCE}；1 积分 = ${C.USD_PER_CREDIT} 美元；先冻结，成功才扣，失败 / 取消退回）`);
  printEstimate(ctx, '全部访客走完整条流水线（还没做的步骤，按都已批准算）：', taskRows.filter((r) => !['done', 'running'].includes(r.st.s)));
  const now_ = printEstimate(ctx, `现在执行 --run ${a.rest.length ? a.rest.join(' ') : 'all'} --yes${a.until ? ` --until ${a.until}` : ''} 会新建的：`, taskRows.filter((r) => r.willRun));
  if (drafts) L(`  （${drafts} 个草稿只做到换装图；看过 assets-src/visitors/<id>/costume.png 满意后把 status 改成 approved，再 --run 做 3D）`);
  L(`\n真跑前要有：.env.local 的 TRIPO_API_KEY、${[...new Set(sel.map((v) => v.reference))].join('、')} 里的吉祥物参考图、账户里至少 ${now_.known} 积分。`);
  return errors.length ? 1 : 0;
}

// ---------------------------------------------------------------- 真跑

function pickUrl(output, keys, pattern) {
  if (!isObj(output)) return null;
  for (const k of keys) if (typeof output[k] === 'string' && /^https?:\/\//.test(output[k])) return output[k];
  const all = [];
  const walk = (o, depth) => {
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && /^https?:\/\//.test(v)) all.push(v);
      else if (isObj(v) && depth < 2) walk(v, depth + 1);
    }
  };
  walk(output, 0);
  return (
    all.find((u) => {
      try {
        return pattern.test(new URL(u).pathname);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** 存进状态文件的 output：签名链接只留站点 + 路径（签名几分钟到一天就过期，留着没用） */
function sanitize(v) {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? shortUrl(v) : v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  return v;
}

function filesPresent(ctx, rec, out) {
  const f = rec?.files ?? {};
  const has = (p) => !!p && existsSync(ctx.abs(p));
  if (out.kind === 'image') return has(f.image);
  if (out.kind === 'views') return has(f.front);
  if (out.kind === 'model') return has(f.model);
  return true;
}

async function downloadOutputs(ctx, n, output = {}) {
  const { kind, dest, preview } = n.out;
  const files = {};
  const keys = Object.keys(output ?? {}).join(', ') || '空';
  if (kind === 'image') {
    const url = pickUrl(output, ['generated_image_url', 'image_url', 'image'], /\.(png|jpe?g|webp)$/i);
    if (!url) throw new Error(`任务结果里没有图片链接（output 字段：${keys}）`);
    files.image = ctx.rel((await download(url, dest)).path);
  } else if (kind === 'views') {
    // 实测（2026-10-28）四个链接套在 output.generate_multiview_image 里；文档没写结构，直接放在 output 上的也认
    const nested = Object.values(output ?? {}).find((x) => x && typeof x === 'object' && typeof x.front_view_url === 'string');
    const src = typeof output?.front_view_url === 'string' ? output : nested ?? {};
    for (const v of ['front', 'left', 'back', 'right']) {
      const url = src[`${v}_view_url`];
      if (typeof url === 'string') files[v] = ctx.rel((await download(url, `${dest}-${v}`)).path);
    }
    if (!files.front) throw new Error(`四视图结果里没有 front_view_url（output 字段：${keys}）`);
  } else if (kind === 'model') {
    const url = pickUrl(output, ['model_url', 'pbr_model_url', 'pbr_model', 'model'], /\.(glb|gltf|fbx|zip)$/i);
    if (!url) throw new Error(`任务结果里没有模型链接（output 字段：${keys}）`);
    files.model = ctx.rel((await download(url, dest)).path);
    if (preview && typeof output.rendered_image_url === 'string') {
      try {
        files.preview = ctx.rel((await download(output.rendered_image_url, preview)).path);
      } catch {} // 预览图下不到不要紧
    }
  }
  return files;
}

/** 成功任务的结果文件下到 assets-src/ 里；签名链接过期就重新查一次任务拿新链接（查询免费） */
async function ensureFiles(ctx, n, rec, task = null) {
  if (!n.out || n.out.kind === 'rigcheck' || filesPresent(ctx, rec, n.out)) return true;
  const L = ctx.log;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!task || attempt > 0) {
      try {
        task = await ctx.client.getTask(rec.task_id);
      } catch (e) {
        L(`  [${n.step}] ✗ 查任务失败：${errText(e)}（重跑会再试，免费）`);
        return false;
      }
      if (task.status !== 'success') {
        rec.status = task.status;
        saveState(ctx);
        L(`  [${n.step}] ✗ 结果文件没下到，任务现在是 ${task.status}${task.status === 'expired' ? '：结果已过期，只能 --reroll 重做（会再扣费）' : ''}`);
        return false;
      }
    }
    try {
      rec.files = await downloadOutputs(ctx, n, task.output);
      saveState(ctx);
      for (const f of Object.values(rec.files)) L(`    ↓ ${f}`);
      return true;
    } catch (e) {
      if (attempt === 0 && e instanceof DownloadError) {
        L(`    下载失败（${e.message}），重新查任务拿新链接再试一次`);
        continue;
      }
      saveState(ctx);
      L(`  [${n.step}] ✗ ${errText(e)}。任务已经成功、task_id 已记下；重跑会重新拿链接再下（免费）`);
      return false;
    }
  }
  return false;
}

function verdict(ctx, vc, n, rec) {
  if (n.step !== 'rigcheck') return true;
  const o = rec.output ?? {};
  if (o.riggable === true && (o.rig_type == null || o.rig_type === 'biped')) {
    ctx.log(`    可以绑骨，推荐类型 ${o.rig_type ?? '（没给）'}`);
    return true;
  }
  ctx.log(`  [rigcheck] ✗ rig-check 的结论：riggable=${o.riggable}，rig_type=${o.rig_type ?? '?'}（这条流水线要 biped）`);
  ctx.log(`    多半是服装把腿或手臂糊住了。改 ${vc.id} 的 costume 后 --reroll ${vc.id} costume 重做（rig-check 本身免费）`);
  return false;
}

async function ensureUpload(ctx, n) {
  const src = n.source();
  if (!src) {
    ctx.log(`  [${n.step}] ✗ 没有可上传的文件：${n.sourceLabel}`);
    return false;
  }
  const rec = ctx.state.nodes[n.key];
  if (rec?.file_token && rec.sha === src.sha && Date.now() - Date.parse(rec.at) < UPLOAD_MAX_AGE_MS) return true;
  ctx.log(`  [${n.step}] → 上传 ${ctx.rel(src.path)}`);
  try {
    const token = await ctx.client.upload(src.path);
    ctx.state.nodes[n.key] = { step: n.step, variant: n.variant, kind: 'upload', sha: src.sha, file_token: token, at: now() };
    saveState(ctx);
    return true;
  } catch (e) {
    ctx.log(`  [${n.step}] ✗ 上传失败：${errText(e)}`);
    return false;
  }
}

async function waitAndFinish(ctx, vc, n, rec) {
  const L = ctx.log;
  let t;
  try {
    t = await ctx.client.waitForTask(rec.task_id, { onUpdate: (u) => L(`    ${u.status}${u.progress != null ? ` ${u.progress}%` : ''}`) });
  } catch (e) {
    saveState(ctx);
    L(`  [${n.step}] ✗ 查任务出错：${errText(e)}。task_id 已记下，重跑同一条命令会接着查，不会重建`);
    return false;
  }
  rec.status = t.status;
  rec.progress = t.progress ?? null;
  rec.updated_at = now();
  if (t.timedOut) {
    saveState(ctx);
    L(`  [${n.step}] … 等了很久还没完（${t.status} ${t.progress ?? 0}%）。task_id 已记下，过会儿重跑同一条命令接着等，不会重建`);
    return false;
  }
  if (t.status !== 'success') {
    rec.error = [t.error_code, t.error_message].filter((x) => x != null).join(' ') || null;
    saveState(ctx);
    L(`  [${n.step}] ✗ 任务 ${t.status}${rec.error ? `：${mask(rec.error)}` : ''}${t.status === 'banned' ? '（内容审核没过，改提示词或参考图）' : ''}`);
    L(`    ${t.status === 'failed' || t.status === 'cancelled' ? '这次不扣费（失败 / 取消会退回冻结的积分）。' : ''}重来：--reroll ${vc.id} ${n.step}，再 --run`);
    return false;
  }
  rec.credits = t.credits_consumed == null ? null : Number(t.credits_consumed);
  rec.completed_at = t.completed_at ?? now();
  rec.output = sanitize(t.output ?? {});
  saveState(ctx);
  L(`  [${n.step}] ✓ 完成${rec.credits != null ? `（实扣 ${rec.credits}）` : ''}`);
  if (!(await ensureFiles(ctx, n, rec, t))) return false;
  return verdict(ctx, vc, n, rec);
}

async function createAndFinish(ctx, vc, n) {
  const L = ctx.log;
  for (const d of n.deps) {
    const dn = ctx.nodeByKey.get(d);
    if (dn.kind === 'upload' && !(await ensureUpload(ctx, dn))) return false;
    if (dn.kind === 'task' && ctx.state.nodes[d]?.status !== 'success') {
      L(`  [${n.step}] ✗ 上游 ${dn.step} 还没成功`);
      return false;
    }
  }
  const body = n.body(resolver(ctx, 'send'));
  const est = n.estimate(body);
  const cost = est.credits ?? 50;
  if (ctx.budget.spent + cost > ctx.budget.cap) {
    L(`  [${n.step}] ✗ 再建这个任务（约 ${fmt(est.credits)} 积分）就超过这次的上限 ${ctx.budget.cap} 了，停下。要放宽加 --max-credits <数>`);
    return false;
  }
  const rec = { step: n.step, variant: n.variant, endpoint: n.endpoint, hash: hashOf(ctx, n), estimate: est.credits, pending_since: now() };
  ctx.state.nodes[n.key] = rec;
  saveState(ctx);
  L(`  [${n.step}] → 新建：POST ${n.endpoint}（${n.label}，约 ${fmt(est.credits)} 积分）`);
  try {
    rec.task_id = await ctx.client.createTask(n.endpoint, body);
  } catch (e) {
    if (e?.possiblyCreated) {
      rec.error = errText(e);
      saveState(ctx);
      L(`  [${n.step}] ✗ ${rec.error}`);
      L('    任务可能已经在服务器上建好了（积分可能已冻结）。状态里留了记号，重跑会先停在这里：');
      L(`    先 --usage 看最近的任务；有就 --adopt ${vc.id} ${n.step} <task_id> 接上，确认没有再 --reroll ${vc.id} ${n.step}`);
      return false;
    }
    delete ctx.state.nodes[n.key];
    saveState(ctx);
    L(`  [${n.step}] ✗ ${errText(e)}（任务没建成，不扣费）`);
    return false;
  }
  rec.pending_since = null;
  rec.status = 'queued';
  rec.created_at = now();
  ctx.budget.spent += cost;
  saveState(ctx);
  L(`    task ${rec.task_id}`);
  return waitAndFinish(ctx, vc, n, rec);
}

async function ensureTask(ctx, vc, n) {
  const L = ctx.log;
  const { s, rec } = nodeStatus(ctx, n);
  if (s === 'pending') {
    L(`  [${n.step}] ✗ 上次建这个任务时连接断了（${rec.pending_since}${rec.error ? `：${rec.error}` : ''}），任务可能已经建好并冻结了积分。`);
    L(`    先 --usage 看最近的任务：有就 --adopt ${vc.id} ${n.step} <task_id> 接上；确认没有，再 --reroll ${vc.id} ${n.step} 后重跑`);
    return false;
  }
  if (s === 'changed') {
    const est = n.estimate(n.body(resolver(ctx, 'show')));
    L(`  [${n.step}] ✗ 请求和建任务时（${rec.task_id}）不一样了：visitors.json 改过，或者上游重新生成过。`);
    L(`    要按新配置重做：--reroll ${vc.id} ${n.step}（这一步约 ${fmt(est.credits)} 积分，下游也要重做）；不想重做就把 visitors.json 改回去`);
    return false;
  }
  if (s === 'failed') {
    L(`  [${n.step}] ✗ ${rec.task_id} 的状态是 ${rec.status}${rec.error ? `：${mask(rec.error)}` : ''}`);
    L(`    重来：--reroll ${vc.id} ${n.step}，再 --run（failed / cancelled 没扣费；expired 是成功过但结果过期了，重做会再扣费）`);
    return false;
  }
  if (s === 'done') {
    if (!(await ensureFiles(ctx, n, rec))) return false;
    L(`  [${n.step}] ✓ 已完成（${rec.task_id}${rec.credits != null ? `，实扣 ${rec.credits}` : ''}）`);
    return verdict(ctx, vc, n, rec);
  }
  if (s === 'running') {
    L(`  [${n.step}] … 接着等 ${rec.task_id}`);
    return waitAndFinish(ctx, vc, n, rec);
  }
  return createAndFinish(ctx, vc, n);
}

/** 片段名对角色：先按预设名（walk、scared_01…）找，找不全而数量刚好相等时按请求顺序（未核实），都不行就留 null */
export function mapClips(names, roles) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const entries = Object.entries(roles);
  const out = {};
  const used = new Set();
  let hits = 0;
  for (const [role, preset] of entries) {
    const want = norm(String(preset).split(':').pop());
    const free = names.filter((x) => !used.has(x));
    const hit = free.find((x) => norm(x) === want) ?? free.find((x) => norm(x).endsWith(want)) ?? free.find((x) => norm(x).includes(want));
    out[role] = hit ?? null;
    if (hit) {
      used.add(hit);
      hits++;
    }
  }
  if (hits === entries.length) return { clips: out, by: 'name' };
  if (names.length === entries.length) return { clips: Object.fromEntries(entries.map(([role], i) => [role, names[i]])), by: 'order' };
  return { clips: out, by: 'partial' };
}

function writeVisitorManifest(ctx, entry, order) {
  const p = join(ctx.paths.out, 'manifest.json');
  let list = [];
  if (existsSync(p)) {
    try {
      list = JSON.parse(readFileSync(p, 'utf8')).visitors ?? [];
    } catch {
      ctx.log(`  · ${ctx.rel(p)} 读不懂，重写`);
    }
  }
  list = list.filter((v) => v.id !== entry.id);
  list.push(entry);
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  list.sort((a, b) => rank(a.id) - rank(b.id));
  const doc = {
    $comment: '由 scripts/tripo/visitors.mjs 生成，重跑 export 会覆盖对应条目。url 相对于 import.meta.env.BASE_URL；clips 的键对应 src/config/character.ts 的 clips，值是 GLB 里的片段原名（null = 没有）',
    updatedAt: now(),
    visitors: list,
  };
  writeFileSync(`${p}.tmp`, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

async function exportVariant(ctx, vc, nodes, order) {
  const L = ctx.log;
  const anims = nodes.filter((x) => ANIMATE_STEPS.includes(x.step));
  const anim = anims[0];
  const conv = nodes.find((x) => x.step === 'convert');
  let src = ctx.state.nodes[anim.key]?.files?.model;
  let via = 'animate';
  if (conv) {
    const cf = ctx.state.nodes[conv.key]?.files?.model;
    if (cf?.endsWith('.glb')) {
      src = cf;
      via = 'convert';
    } else if (cf) L(`  [export] · convert 回来的是 ${cf}（不是 GLB），改用 retarget 的结果`);
  }
  if (!src || !existsSync(ctx.abs(src))) {
    L(`  [export] ✗ 还没有动画模型文件（${src ?? '无'}）`);
    return false;
  }
  if (!src.endsWith('.glb')) {
    L(`  [export] ✗ ${src} 不是 GLB（retarget 的 out_format 要 glb）`);
    return false;
  }
  // 后面几批 retarget 的结果（animate2…）：不能直接放进游戏（一个 GLB 只带一批的动作），交给 Blender 并进第一批的骨架
  const extra = anims.slice(1).map((x) => ctx.state.nodes[x.key]?.files?.model);
  const lost = extra.findIndex((f) => !f || !existsSync(ctx.abs(f)));
  if (lost >= 0) {
    L(`  [export] ✗ 还没有第 ${lost + 2} 批动作的模型文件（${extra[lost] ?? '无'}）`);
    return false;
  }
  if (extra.length && !vc.cfg.refine?.enabled) {
    L(`  [export] ✗ 动作分了 ${anims.length} 批，后面几批只有 Blender 精修能并进同一个 GLB：visitors.json 里把 refine.enabled 打开，或者把动作减到 ${C.MAX_CLIPS_PER_RETARGET} 个以内`);
    return false;
  }
  // Blender 精修（refine.enabled）：球身整块跟着躯干、腿边配件不跟腿拉伸、清碎片、限面数和贴图；动作分了批的话在这里并到一起。
  // 精修失败就停下，不把没精修的模型放进游戏（要跳过就把 refine.enabled 写成 false）
  let refine = null;
  if (vc.cfg.refine?.enabled) {
    const dir = join(ctx.paths.raw, vc.id);
    const out = join(dir, 'refined.glb');
    L(`  [export] Blender 精修 ${src}${extra.length ? `（并入 ${extra.join('、')} 的动作）` : ''} …`);
    const res = await (ctx.refine ?? refineGlb)({
      src: ctx.abs(src),
      out,
      report: join(dir, 'refine.json'),
      preview: vc.cfg.refine.preview === false ? null : join(dir, 'refine-preview', vc.id),
      merge: extra.map((f) => ctx.abs(f)),
      args: ['--max-tris', GAME_LIMITS.triangles ?? 15000, '--max-texture', GAME_LIMITS.texture ?? 2048, ...(vc.cfg.refine.args ?? [])],
      log: (s) => L(`    ${s}`),
    });
    if (!res.ok) {
      L(`  [export] ✗ ${res.error}`);
      return false;
    }
    refine = { from: src, ...(extra.length ? { merged: extra } : {}), report: ctx.rel(join(dir, 'refine.json')), sheet: res.sheet ? ctx.rel(res.sheet) : null, warnings: res.report.warnings ?? [] };
    src = ctx.rel(out);
    via += `${extra.length ? ` + 并入第 ${anims.slice(1).map((_, i) => i + 2).join('、')} 批动作` : ''} + Blender 精修`;
    if (res.sheet) L(`    预览表 ${ctx.rel(res.sheet)}（第一行是权重分类：蓝 = 跟着身体，橙 = 跟着腿 / 手臂）`);
  }
  const buf = readFileSync(ctx.abs(src));
  let info;
  try {
    info = inspectGlb(buf);
  } catch (e) {
    L(`  [export] ✗ ${src} 解析失败：${e.message}`);
    return false;
  }
  const check = checkForGame(info);
  const roles = Object.fromEntries(clipsOf(vc.cfg));
  const { clips, by } = mapClips(info.animations.map((x) => x.name), roles);
  // 动作分了批：合并之后每个角色都要对上一个片段，对不上说明后面几批没并进来（骨骼名不一样之类）
  const unmatched = Object.entries(clips).filter(([, name]) => !name).map(([role]) => role);
  if (anims.length > 1 && unmatched.length) {
    check.problems.push(`动作没合齐：${unmatched.join('、')} 没有对上的片段（GLB 里有 ${info.animations.length} 段）`);
    check.ok = false;
  }
  mkdirSync(ctx.paths.out, { recursive: true });
  const outGlb = join(ctx.paths.out, `${vc.id}.glb`);
  copyFileSync(ctx.abs(src), `${outGlb}.tmp`);
  renameSync(`${outGlb}.tmp`, outGlb);
  const own = nodes.filter((x) => x.kind === 'task' && !x.shared);
  writeVisitorManifest(
    ctx,
    {
      id: vc.id,
      label: vc.label,
      url: `assets/visitors/${vc.id}.glb`,
      clips,
      clipMatch: by,
      presets: roles,
      stats: {
        bytes: info.bytes,
        triangles: info.triangles,
        textures: info.images.map((im) => `${im.width ?? '?'}x${im.height ?? '?'}`),
        maxTexture: info.maxTexture,
        compression: info.draco ? 'draco' : info.meshopt ? 'meshopt' : 'none',
        joints: info.joints,
        boneNaming: info.boneNaming,
        durations: Object.fromEntries(info.animations.map((x) => [x.name, x.duration])),
      },
      game: { ok: check.ok, problems: check.problems, notes: check.notes },
      refine,
      source: {
        from: via,
        tasks: Object.fromEntries(own.map((x) => [x.step, ctx.state.nodes[x.key]?.task_id ?? null])),
        credits: own.reduce((sum, x) => sum + (ctx.state.nodes[x.key]?.credits ?? 0), 0),
        exportedAt: now(),
      },
    },
    order,
  );
  L(`  [export] ${check.ok ? '✓' : '!'} ${ctx.rel(outGlb)}（来自 ${via}）`);
  L(formatInspection(info, check));
  const clipLine = Object.entries(clips).map(([r, c]) => `${r} = ${c ?? '（没对上）'}`).join('，');
  L(`    片段：${clipLine}${by === 'order' ? '（按请求顺序对上的，未核实，请在预览页确认）' : by === 'partial' ? '（有没对上的，按 GLB 里的片段名手动填）' : ''}`);
  L(`    预览 / 校准：/dev/characters.html?url=/assets/visitors/${vc.id}.glb&ambient=1.2&focus=0&fzoom=3&arrows，控制台 await __chars.calibrate()`);
  return true;
}

async function runVariant(ctx, vc, nodes, a, order) {
  const L = ctx.log;
  L(`\n── 访客 ${vc.id}「${vc.label}」${vc.status === 'approved' ? '' : '（草稿）'}`);
  const untilIdx = a.until ? STEPS.indexOf(a.until) : Infinity;
  for (const n of nodes) {
    if (STEPS.indexOf(n.step) > untilIdx) {
      L(`  到 --until ${a.until} 为止`);
      return 'until';
    }
    if (!PREVIEW.has(n.step) && vc.status !== 'approved') {
      const localTouch = join(ctx.paths.raw, vc.id, 'touchup.png');
      const touched = ctx.state.nodes[`${vc.id}:touchup`]?.files?.image ?? (vc.cfg.touchup?.source === 'local' && existsSync(localTouch) ? ctx.rel(localTouch) : undefined);
      const img = touched ?? ctx.state.nodes[`${vc.id}:costume`]?.files?.image;
      L(`  ⏸ 草稿到此为止。先看${touched ? '修过的' : ''}换装图${img ? ` ${img}` : ''}：满意就把 visitors.json 里 ${vc.id} 的 status 改成 "approved"，再 --run ${vc.id} --yes 做 3D；`);
      L(`    不满意就改 costume，然后 --reroll ${vc.id} costume 再出一张（约 10 积分）${touched ? `；只是修得不对就改 touchup，--reroll ${vc.id} touchup` : ''}`);
      return 'gated';
    }
    if (n.kind === 'upload') continue; // 用到时再传
    const ok = n.kind === 'local' ? await exportVariant(ctx, vc, nodes, order) : await ensureTask(ctx, vc, n);
    if (!ok) return 'stopped';
  }
  return 'done';
}

async function cmdRun(ctx, a) {
  const L = ctx.log;
  const release = acquireLock(ctx);
  try {
    const { vcs, refs, plans } = prepare(ctx);
    const sel = select(vcs, a.rest, { requireIds: true });
    const { errors, warnings } = validate(vcs);
    for (const v of sel) for (const p of refs.get(String(v.reference ?? '')).problems) errors.push(`参考图：${p}`);
    const key = readApiKey(ctx.paths.env);
    if (!key) errors.push(keyProblem(ctx));
    for (const w of warnings) L(`· ${w}`);
    if (errors.length) {
      for (const e of [...new Set(errors)]) L(`✗ ${e}`);
      return 1;
    }
    const rows = summarize(ctx, sel, plans, { until: a.until });
    const todo = rows.filter((r) => r.willRun);
    const t = tally(todo);
    const attention = rows.filter((r) => ['pending', 'changed', 'failed'].includes(r.st.s));
    L(`Tripo 访客流水线 · 真跑：${sel.map((v) => v.id).join('、')}${a.until ? `（--until ${a.until}）` : ''}`);
    if (todo.length) {
      L(`这次会新建 ${todo.length} 个任务，约 ${t.known} 积分 ≈ ${usd(t.known)} 美元${t.unknown ? `（另有 ${t.unknown} 项价格未核实）` : ''}：`);
      for (const r of todo) L(`  ${r.n.key} · ${r.n.label} · ${fmt(r.est.credits)}`);
    } else L('没有要新建的任务（只会接着等进行中的任务、补下载、重新导出）');
    for (const r of attention) L(`  ! ${r.n.key}：${STATUS_TEXT[r.st.s]}`);
    if (todo.length && !a.yes) {
      L('\n加 --yes 才会真的建任务、扣积分。先看清单和估算：--dry-run');
      return 2;
    }
    const client = createClient({ apiKey: key, baseUrl: ctx.baseUrl, log: L, poll: ctx.poll });
    ctx.client = client;
    ctx.budget = { cap: a.maxCredits ?? t.known + 50 * t.unknown, spent: 0 };
    if (todo.length) {
      const b = await client.balance();
      L(`余额 ${b.balance} 积分（冻结 ${b.frozen}）`);
      if (Number(b.balance) < t.known) {
        L(`✗ 余额不够这次的估算（${t.known}），先去控制台充值`);
        return 1;
      }
    }
    const order = vcs.map((v) => v.id);
    const results = [];
    for (const vc of sel) results.push([vc, await runVariant(ctx, vc, plans.get(vc.id), a, order)]);
    L('\n── 结果');
    const word = { done: '✓ 完成', gated: '⏸ 草稿，停在换装图', until: '⏸ 到 --until 为止', stopped: '✗ 停下了，见上面' };
    for (const [vc, r] of results) L(`  ${vc.id}：${word[r]}`);
    if (ctx.budget.spent) L(`这次新建的任务估算约 ${ctx.budget.spent} 积分（实扣以 --status 里记下的 credits_consumed 为准）`);
    if (todo.length) {
      try {
        const b = await client.balance();
        L(`余额 ${b.balance} 积分（冻结 ${b.frozen}）`);
      } catch {}
    }
    return results.every(([, r]) => r !== 'stopped') ? 0 : 1;
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- 其他命令

function cmdStatus(ctx) {
  const L = ctx.log;
  const { vcs, plans } = prepare(ctx);
  L(`Tripo 访客流水线 · 状态（本地，不联网）：${existsSync(ctx.paths.state) ? ctx.rel(ctx.paths.state) : '还没有状态文件'}`);
  const seen = new Set();
  for (const vc of vcs) {
    L(`\n── ${vc.id}「${vc.label}」${vc.status === 'approved' ? '' : '（草稿）'}`);
    for (const n of plans.get(vc.id)) {
      const { s, rec } = nodeStatus(ctx, n);
      const shared = seen.has(n.key) ? '（共用，见上）' : '';
      seen.add(n.key);
      if (n.kind === 'upload') {
        L(`  ${n.step.padEnd(15)}${rec?.file_token ? `已传过（${rec.at}）` : '· 用到时再传'}${shared}`);
        continue;
      }
      if (n.kind === 'local') {
        const f = join(ctx.paths.out, `${vc.id}.glb`);
        L(`  ${n.step.padEnd(15)}${existsSync(f) ? `✓ ${ctx.rel(f)}` : '· 还没导出'}`);
        continue;
      }
      const files = Object.values(rec?.files ?? {}).join(' ');
      L(`  ${n.step.padEnd(15)}${STATUS_TEXT[s]}${rec?.task_id ? ` ${rec.task_id}` : ''}${rec?.credits != null ? ` · 实扣 ${rec.credits}` : ''}${files ? ` · ${files}` : ''}${shared}`);
    }
  }
  const spent = Object.values(ctx.state.nodes).reduce((s, r) => s + (r.credits ?? 0), 0);
  const old = ctx.state.history.reduce((s, r) => s + (r.credits ?? 0), 0);
  L(`\n已记录的实扣：${spent} 积分${old ? `，另有作废（--reroll）掉的 ${old} 积分` : ''}`);
  return 0;
}

function findNode(ctx, plans, id, step) {
  const nodes = plans.get(id);
  if (!nodes) throw new Error(`visitors.json 里没有访客 ${id}`);
  if (!STEPS.includes(step)) throw new Error(`没有 ${step} 这一步（${STEPS.join(' / ')}）`);
  const n = nodes.find((x) => x.step === step);
  if (!n) throw new Error(`${id} 的流程里没有 ${step} 这一步（route 不对，或者 convert 没打开？）`);
  return { nodes, n };
}

function cmdReroll(ctx, a) {
  const L = ctx.log;
  const [id, step] = a.rest;
  if (!id || !step) throw new Error('用法：--reroll <id> <步骤>');
  const release = acquireLock(ctx);
  try {
    const { vcs, plans } = prepare(ctx);
    const { nodes, n } = findNode(ctx, plans, id, step);
    if (n.kind === 'local') throw new Error('export 是本地步骤，不用 reroll；重跑 --run 就会重新导出');
    let affected;
    if (n.kind === 'upload') affected = [n]; // 上传免费，指纹按文件内容算，作废它不影响下游
    else if (n.shared) {
      affected = [];
      for (const vc of vcs) {
        const ns = plans.get(vc.id);
        const i = ns.findIndex((x) => x.key === n.key);
        if (i >= 0) affected.push(...ns.slice(i));
      }
    } else affected = nodes.slice(nodes.indexOf(n));
    const keys = [...new Set(affected.filter((x) => x.kind !== 'local').map((x) => x.key))].filter((k) => ctx.state.nodes[k]);
    const busy = keys.filter((k) => ['queued', 'running'].includes(ctx.state.nodes[k].status));
    if (busy.length) throw new Error(`这些任务还在跑，等它们结束再作废：${busy.join('、')}`);
    if (!keys.length) {
      L(`${n.key} 和它的下游都还没有记录，不用作废`);
      return 0;
    }
    for (const k of keys) {
      ctx.state.history.push({ key: k, ...ctx.state.nodes[k], removed_at: now(), removed_by: `--reroll ${id} ${step}` });
      delete ctx.state.nodes[k];
    }
    saveState(ctx);
    L(`已作废 ${keys.length} 步（记录移到状态文件的 history 里，task_id 不会丢）：`);
    for (const k of keys) L(`  ${k}`);
    if (n.shared && n.kind !== 'upload') L(`注意：这是共用步骤，用同一张参考图的访客（${vcs.filter((v) => plans.get(v.id).some((x) => x.key === n.key)).map((v) => v.id).join('、')}）都要从这里重做`);
    L(`下一步：--dry-run 看重做要多少积分，然后 --run ${id} --yes`);
    return 0;
  } finally {
    release();
  }
}

function cmdAdopt(ctx, a) {
  const L = ctx.log;
  const [id, step, taskId] = a.rest;
  if (!id || !step || !taskId) throw new Error('用法：--adopt <id> <步骤> <task_id>');
  if (!/^[A-Za-z0-9_-]{6,}$/.test(taskId)) throw new Error(`task_id 看起来不对：${taskId}`);
  const release = acquireLock(ctx);
  try {
    const { plans } = prepare(ctx);
    const { n } = findNode(ctx, plans, id, step);
    if (n.kind !== 'task') throw new Error(`${step} 不是 API 任务`);
    const rec = ctx.state.nodes[n.key];
    if (rec?.task_id) throw new Error(`${n.key} 已经记着 ${rec.task_id}；要换先 --reroll ${id} ${step}`);
    if (!depsReady(ctx, n)) throw new Error(`${n.key} 的上游还没完成，接不上`);
    ctx.state.nodes[n.key] = { step: n.step, variant: n.variant, endpoint: n.endpoint, hash: hashOf(ctx, n), task_id: taskId, status: 'queued', adopted: true, created_at: now() };
    saveState(ctx);
    L(`已把 ${taskId} 记为 ${n.key}。下次 --run ${id} 会接着等它并下载结果（不会新建任务）`);
    return 0;
  } finally {
    release();
  }
}

async function cmdAccount(ctx, which) {
  const L = ctx.log;
  const key = readApiKey(ctx.paths.env);
  if (!key) throw new Error(keyProblem(ctx));
  const client = createClient({ apiKey: key, baseUrl: ctx.baseUrl, log: L });
  if (which === 'balance') {
    const b = await client.balance();
    L(`余额 ${b.balance} 积分（≈ ${usd(Number(b.balance))} 美元），冻结 ${b.frozen}（进行中的任务预扣的）`);
    return 0;
  }
  const u = await client.usage();
  const list = Array.isArray(u) ? u : u.list ?? u.items ?? u.records ?? [];
  L(`最近的扣费记录（${list.length} 条，最多列 30 条）：`);
  for (const r of list.slice(0, 30)) L(`  ${r.created_at ?? ''}  ${String(r.type ?? '').padEnd(22)} ${String(r.credits_consumed ?? '').padStart(7)}  ${r.task_id ?? ''}`);
  return 0;
}

function cmdInspect(ctx, a) {
  const f = a.rest[0];
  if (!f) throw new Error('用法：--inspect <文件.glb>');
  const info = inspectGlb(readFileSync(resolve(f)));
  ctx.log(`${f}：`);
  ctx.log(formatInspection(info));
  ctx.log(`  片段名：${JSON.stringify(info.animations.map((x) => x.name))}`);
  return 0;
}

// ---------------------------------------------------------------- 入口

const COMMANDS = ['--dry-run', '--run', '--status', '--balance', '--usage', '--reroll', '--adopt', '--inspect', '--help'];

function parseArgs(argv) {
  const a = { cmd: null, rest: [], yes: false, until: null, maxCredits: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i] === '-h' ? '--help' : argv[i];
    if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--until') a.until = argv[++i];
    else if (t === '--max-credits') a.maxCredits = Number(argv[++i]);
    else if (COMMANDS.includes(t)) {
      if (a.cmd) throw new Error(`一次只能用一个命令（${a.cmd} 和 ${t}）`);
      a.cmd = t;
    } else if (t.startsWith('-')) throw new Error(`不认识的参数 ${t}`);
    else a.rest.push(...t.split(',').filter(Boolean));
  }
  if (a.until != null && !STEPS.includes(a.until)) throw new Error(`--until 后面要写步骤名：${STEPS.join(' / ')}`);
  if (a.maxCredits != null && !(Number.isFinite(a.maxCredits) && a.maxCredits >= 0)) throw new Error('--max-credits 后面要写一个数');
  return a;
}

/**
 * @param {string[]} argv
 * @param {{ paths?: Partial<typeof DEFAULT_PATHS>, baseUrl?: string, log?: (s: string) => void, poll?: object, refine?: typeof refineGlb }} [opts]
 *   paths / baseUrl / poll / refine 只给自测用（refine：换掉真的 Blender 精修，假 GLB 进不了 Blender）；命令行永远用默认值（真的 API 地址）
 * @returns {Promise<number>} 退出码：0 成功，1 出错或停下，2 用法不对 / 缺 --yes
 */
export async function main(argv, opts = {}) {
  const paths = { ...DEFAULT_PATHS, ...opts.paths };
  const out = opts.log ?? ((s) => console.log(s));
  const ctx = {
    paths,
    log: (s) => out(mask(s)),
    baseUrl: opts.baseUrl ?? BASE_URL,
    poll: opts.poll,
    refine: opts.refine,
    rel: (p) => relative(paths.root, p).split(sep).join('/'),
    abs: (p) => resolve(paths.root, p),
  };
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    ctx.log(`✗ ${e.message}\n\n${HELP}`);
    return 2;
  }
  try {
    switch (a.cmd) {
      case '--dry-run':
        return cmdDryRun(ctx, a);
      case '--run':
        return await cmdRun(ctx, a);
      case '--status':
        return cmdStatus(ctx);
      case '--balance':
        return await cmdAccount(ctx, 'balance');
      case '--usage':
        return await cmdAccount(ctx, 'usage');
      case '--reroll':
        return cmdReroll(ctx, a);
      case '--adopt':
        return cmdAdopt(ctx, a);
      case '--inspect':
        return cmdInspect(ctx, a);
      default:
        ctx.log(HELP);
        return a.cmd === '--help' ? 0 : 2;
    }
  } catch (e) {
    ctx.log(`✗ ${errText(e)}`);
    return 1;
  }
}
