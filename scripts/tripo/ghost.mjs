// 主角鬼魂的新模型（路 G，2026-10-29）：Tripo 文生图出概念图 → 用户挑一张 → 图生模型 → Blender 清理 → public/assets/ghost/ghost.glb。
//
// 第一段（已做完）：四张概念图（POST /v3/generation/text-to-image，seedream_v5，每张 5 积分）
// 第二段：用户挑了第 MODEL_FROM 张 → 图生模型（POST /v3/generation/image-to-model，H3.1、不要贴图）→ Blender 清理（scripts/blender/ghost_cleanup.py）
//
//   node scripts/tripo/ghost.mjs --dry-run                  打印要发的请求（key 打码）和积分估算。不联网、不写文件、不花钱
//   node scripts/tripo/ghost.mjs --run concepts --yes       四张概念图（会扣积分），各放在 assets-src/ghost/concept-<n>/ 下（.jpg）
//        --only 1,2                                         只做这几张
//   node scripts/tripo/ghost.mjs --run model --yes          图生模型（会扣积分）→ assets-src/ghost/model/model.glb
//   node scripts/tripo/ghost.mjs --cleanup [清理脚本的参数…]  Blender 无头清理（不联网、不花钱）→ public/assets/ghost/ghost.glb，
//                                                          报告和预览图在 assets-src/ghost/cleanup/
//   node scripts/tripo/ghost.mjs --status                   看状态文件（不联网）
//   node scripts/tripo/ghost.mjs --balance | --usage        查余额 / 最近的扣费记录（免费接口）
//   node scripts/tripo/ghost.mjs --reroll 2,3 | model       丢掉这几个任务的记录，下次 --run 重新做（再扣费，花掉的照样算进上限）
//
// 接口（2026-10-28 抓的副本在主工作区 .logs/tripo-docs-live-2026-10-28/）：
// - text-to-image：seedream_v5 "latest quality, stronger prompt following"；size 写 WxH；不要的东西写在提示词的 --no 后面；
//   结果在 output.generated_image_url。图像类任务每个账号只有 1 个并发，所以一张一张来
// - image-to-model：input 可以直接填 text_to_image 的 task_id；texture、pbr 都写 false 是不带贴图的白模（鬼魂用自己的材质，贴图用不上）；
//   默认朝 +x 导出（export_orientation，文档建议不改），转到游戏的 +z 由清理脚本做；结果在 output.model_url
// - 价格见 catalog.mjs：seedream_v5 各档 5；H 系列不带贴图 20（face_limit 不加价）
// 状态：assets-src/ghost/state.json（自己的文件；访客流水线的 assets-src/tripo-state.json 不碰）。task_id 一建好就记下，
//   重跑只补没做完的、接着等没等完的，不会重复建任务；建任务时断线（任务可能已经建好、冻结了积分）会留记号，重跑停在那里等人查
// key：client.mjs 从 .env.local 读，只放在发给 API 的请求头里；打印的东西都过 mask()，状态文件里的链接去掉签名
// 积分：用户批给 G 路 BUDGET.total（70），第一段最多 BUDGET.concepts（20）。建每个任务之前按估算查一遍，会超就停；实扣比估算多也停
// 下载来的文件各放在自己的目录里（concept-<n>/、model/、model-preview/），不和脚本、状态文件混在一起
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBlender } from '../blender/refine.mjs';
import { imageCredits, model3dCredits } from './catalog.mjs';
import { BASE_URL, TERMINAL, TripoError, apiKeyStatus, createClient, download, mask, readApiKey, shortUrl } from './client.mjs';
import { inspectGlb } from './glb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export const DEFAULT_PATHS = {
  root: ROOT,
  env: join(ROOT, '.env.local'),
  dir: join(ROOT, 'assets-src', 'ghost'),
  state: join(ROOT, 'assets-src', 'ghost', 'state.json'),
  out: join(ROOT, 'public', 'assets', 'ghost', 'ghost.glb'),
  cleanupPy: join(ROOT, 'scripts', 'blender', 'ghost_cleanup.py'),
};

/** 用户批给 G 路的 Tripo 积分（2026-10-29）：两段合计 total，第一段（概念图）最多 concepts */
export const BUDGET = { total: 70, concepts: 20 };

/**
 * 概念图的方向（路 G 简报原话）：高瘦的兜帽人形幽灵，厚重的长斗篷、深兜帽把脸完全藏住（没有脸），手藏在长袖里贴着身体，
 * 下摆破成一条条的（像烟），站直、头微微低着，全身、正面偏一点、浅灰背景、哑光、不发光、写实克制，不要卡通床单鬼。
 * 照这个写成英文（和 visitors.json 的提示词一样；文档：最要紧的放前面，不要的写在 --no 后面）。
 * 简报没定的两处：斗篷写成深灰（浅灰背景上轮廓清楚，第二段图生模型好抠）；「不要卡通床单鬼」放进 --no，不写进正文
 * （正文里写「不要 X」反而容易把 X 画出来）
 */
export const CONCEPT_PROMPT = [
  'A tall, thin, hooded humanoid ghost, full body, standing upright with its head slightly bowed.',
  'A heavy, long cloak of thick, opaque, matte cloth falls in deep vertical folds.',
  'A deep hood pulled forward hides the face completely; inside the hood there is only shadow, no face at all.',
  'Both hands stay hidden inside long sleeves, held close against the body.',
  'The bottom of the cloak is torn into long ragged strips that taper and fray like wisps of smoke; no feet.',
  'Front view, turned slightly to one side.',
  'The whole figure is in frame, centred on a plain, seamless light grey background, soft even studio light.',
  'Dark grey cloth, nothing glows. Realistic and restrained, not stylised.',
  '--no face, eyes, skull, skin, visible hands, feet, glow, rim light, cartoon, bedsheet ghost, cute, scythe, weapon, chains, text, watermark',
].join(' ');

export const CONCEPT_COUNT = 4;
export const CONCEPT_ENDPOINT = '/generation/text-to-image';
/**
 * 四张用同一个请求（文档没有 seed 参数；2026-10-29 实测同一个提示词四次出的图都不一样）。
 * output_format 写的 png，实际回来的是 JPEG（2026-10-29 实测，四张都是）：download() 按文件头认格式，存成 .jpg
 */
export const conceptBody = () => ({ prompt: CONCEPT_PROMPT, model: 'seedream_v5', size: '2048x2048', output_format: 'png', watermark: false });

/** 用户挑的概念图（2026-10-29：第 4 张，高瘦、低着头、斗篷拖地、下摆破成条） */
export const MODEL_FROM = 4;
export const MODEL_ENDPOINT = '/generation/image-to-model';
/**
 * 图生模型：H3.1（默认版本），texture、pbr 都关 = 不带贴图（20 积分，最便宜；鬼魂用自己的材质）。
 * face_limit 50000（文档：网页 / 手机 10,000–50,000），细的下摆布条留得住；最后由清理脚本减到 ≤ 8000。
 * 不开 smart_low_poly（+10，文档说复杂的模型偶尔会失败，下摆这种碎布条正是复杂的）；不加 export_orientation（文档建议不改）
 */
export const modelBody = (input) => ({ input, model: 'v3.1-20260211', texture: false, pbr: false, face_limit: 50000 });

const HELP = `主角鬼魂的新模型（路 G）：概念图（文生图 seedream_v5，每张约 5 积分）→ 图生模型（H3.1 不带贴图，约 20 积分）→ Blender 清理
  node scripts/tripo/ghost.mjs --dry-run                       打印请求（key 打码）和积分估算。不联网、不写文件、不花钱
  node scripts/tripo/ghost.mjs --run concepts --yes [--only 1,2]   四张概念图（会扣积分）
  node scripts/tripo/ghost.mjs --run model --yes               图生模型（会扣积分），从第 ${MODEL_FROM} 张概念图出发
  node scripts/tripo/ghost.mjs --cleanup [参数…]               Blender 清理 → public/assets/ghost/ghost.glb（不联网、不花钱）
  node scripts/tripo/ghost.mjs --status                        看状态（不联网）
  node scripts/tripo/ghost.mjs --balance | --usage             查余额 / 最近的扣费记录（免费接口）
  node scripts/tripo/ghost.mjs --reroll 2,3 | model            丢掉这几个任务的记录，下次 --run 重新做
积分上限：G 路一共 ${BUDGET.total}，概念图最多 ${BUDGET.concepts} · 状态 assets-src/ghost/state.json · key 读 .env.local 的 TRIPO_API_KEY`;

const COMMANDS = ['--dry-run', '--run', '--cleanup', '--status', '--balance', '--usage', '--reroll', '--help'];
const BAD_END = new Set(['failed', 'banned', 'expired', 'cancelled']);
/** 清理后的上限（简报：一个网格、≤ 8000 三角面） */
export const CLEANUP_LIMITS = { triangles: 8000, meshes: 1 };

// ---------------------------------------------------------------- 小工具

const now = () => new Date().toISOString();
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const errText = (e) => (e instanceof TripoError ? e.describe() : mask(e?.message ?? e));
const slots = () => Array.from({ length: CONCEPT_COUNT }, (_, i) => i + 1);
/** 请求的指纹：状态里记下每个任务用的是哪个请求（改过提示词以后，旧图照样留着，只是能看出来） */
const hashOf = (endpoint, body) => createHash('sha256').update(JSON.stringify({ endpoint, body })).digest('hex').slice(0, 16);

/** 状态文件里不留签名链接（只留站点 + 路径） */
function sanitize(v) {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? shortUrl(v) : v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  return v;
}

/** 结果里的链接：先按 keys 的顺序认，没有再找任何一个路径符合 pattern 的 */
function pickUrl(output, keys, pattern) {
  if (!isObj(output)) return null;
  for (const k of keys) if (typeof output[k] === 'string' && /^https?:\/\//.test(output[k])) return output[k];
  for (const v of Object.values(output)) {
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
    try {
      if (pattern.test(new URL(v).pathname)) return v;
    } catch {}
  }
  return null;
}

function keyProblem(ctx) {
  const env = ctx.rel(ctx.paths.env);
  return {
    ok: null,
    'no-file': `${env} 还不存在：在项目根目录建这个文件，写一行 TRIPO_API_KEY=<你的 key>`,
    'no-line': `${env} 里没有 TRIPO_API_KEY 这一行`,
    empty: `${env} 里的 TRIPO_API_KEY 还是空的`,
  }[apiKeyStatus(ctx.paths.env)];
}

// ---------------------------------------------------------------- 状态

function loadState(ctx) {
  const p = ctx.paths.state;
  const s = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { version: 1 };
  s.concepts ??= {};
  s.model ??= null;
  s.history ??= [];
  s.balances ??= [];
  return s;
}

/** 先写临时文件再改名：中途被打断不会留下半截的状态 */
function saveState(ctx) {
  const p = ctx.paths.state;
  mkdirSync(dirname(p), { recursive: true });
  ctx.state.updated_at = now();
  writeFileSync(`${p}.tmp`, `${JSON.stringify(ctx.state, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

/**
 * 已经花掉（或可能花掉）的积分，含 --reroll 挪进 history 的；kind 只算概念图（'concept'）或模型（'model'），不给就全算。
 * 有实扣用实扣；建了任务、还不知道扣多少的按估算；建任务时断线、不知道建没建成的也按估算算上（宁可少花）
 */
function spent(state, kind = null) {
  const recs = [
    ...Object.values(state.concepts).map((r) => ({ kind: 'concept', ...r })),
    ...(state.model ? [{ kind: 'model', ...state.model }] : []),
    ...state.history.map((r) => ({ kind: 'concept', ...r })),
  ];
  return recs.filter((r) => !kind || r.kind === kind).reduce((s, r) => s + (r.credits ?? r.estimate ?? 0), 0);
}

/** 一个任务的状态：new 没建 / pending 建任务时断线 / running 在跑 / done 结果文件在 / refetch 成功过但文件不在了 / failed 失败、被拒、过期、取消 */
function taskState(ctx, rec) {
  if (!rec) return 'new';
  if (!rec.task_id) return 'pending';
  if (rec.status === 'success') return rec.file && existsSync(ctx.abs(rec.file)) ? 'done' : 'refetch';
  if (BAD_END.has(rec.status)) return 'failed';
  return 'running';
}

function describeTask(ctx, rec, { per, reroll, hash }) {
  const st = taskState(ctx, rec);
  const changed = rec && hash && rec.hash !== hash ? '（用的是改之前的请求）' : '';
  return {
    new: `还没做（--run 会新建，约 ${per} 积分）`,
    pending: `上次建任务时连接断了（${rec?.pending_since}），任务可能已经建好。先 --usage 查；确认没有再 --reroll ${reroll}`,
    running: `进行中 ${rec?.task_id}（${rec?.status}），--run 接着等，不重建`,
    done: `✓ ${rec?.file}（实扣 ${rec?.credits ?? '未知'}，task ${rec?.task_id}）${changed}`,
    refetch: `成功过（task ${rec?.task_id}）但文件不在了：--run 重新查任务再下，不扣费${changed}`,
    failed: `✗ ${rec?.task_id} ${rec?.status}${rec?.error ? `：${rec.error}` : ''}。重来：--reroll ${reroll}`,
  }[st];
}

// ---------------------------------------------------------------- 一个任务：建、等、下载

/**
 * job：tag 打印用；get() / put(rec | null) 读写状态里这个任务的记录；endpoint、body；est 估算 { credits, note }；
 *   room() 这一段还能花多少积分；reroll 提示里写的 --reroll 参数；collect(task) 下载结果、返回要记下的 { file, bytes, ... }
 * 返回 true = 结果文件在了，可以接着做下一个
 */
async function ensureTask(ctx, client, job) {
  const L = ctx.log;
  const rec0 = job.get();
  const st = taskState(ctx, rec0);
  if (st === 'done') {
    L(`${job.tag} ✓ 已有：${rec0.file}`);
    return true;
  }
  if (st === 'pending' || st === 'failed') {
    L(`${job.tag} ✗ ${describeTask(ctx, rec0, { per: job.est.credits, reroll: job.reroll })}`);
    return false;
  }
  if (st === 'running') {
    L(`${job.tag} … 接着等 ${rec0.task_id}`);
    return finishTask(ctx, client, job, rec0);
  }
  if (st === 'refetch') {
    L(`${job.tag} 结果文件不在了，重新查 ${rec0.task_id} 拿链接再下（不扣费）`);
    try {
      return await finishTask(ctx, client, job, rec0, await client.getTask(rec0.task_id));
    } catch (e) {
      L(`${job.tag} ✗ 查任务出错：${errText(e)}`);
      return false;
    }
  }
  // 新建：先按估算查上限（价目表里查不到的按 job.fallback 算）
  const cost = job.est.credits ?? job.fallback;
  const room = job.room();
  if (cost > room) {
    L(`${job.tag} ✗ 再建这个任务（约 ${cost} 积分）就超过上限了（这一段还剩 ${room}），停下`);
    return false;
  }
  const rec = { endpoint: job.endpoint, hash: hashOf(job.endpoint, job.body), request: job.body, estimate: job.est.credits ?? job.fallback, pending_since: now() };
  job.put(rec);
  saveState(ctx);
  L(`${job.tag} → 新建：POST ${job.endpoint}（${job.est.note}，约 ${cost} 积分）`);
  try {
    rec.task_id = await client.createTask(job.endpoint, job.body);
  } catch (e) {
    if (e?.possiblyCreated) {
      rec.error = errText(e);
      saveState(ctx);
      L(`${job.tag} ✗ ${rec.error}`);
      L(`${job.tag}   任务可能已经在服务器上建好了（积分可能已冻结）。状态里留了记号，重跑会停在这里：先 --usage 查，确认没有再 --reroll ${job.reroll}`);
      return false;
    }
    job.put(null);
    saveState(ctx);
    L(`${job.tag} ✗ ${errText(e)}（任务没建成，不扣费）`);
    return false;
  }
  rec.pending_since = null;
  rec.status = 'queued';
  rec.created_at = now();
  saveState(ctx);
  L(`${job.tag}   task ${rec.task_id}`);
  return finishTask(ctx, client, job, rec);
}

/** 等任务、下载结果。task 是已经查到的终态（重新下载时）；没给就轮询到终态 */
async function finishTask(ctx, client, job, rec, task = null) {
  const L = ctx.log;
  const tag = job.tag;
  let t = task;
  if (!t) {
    try {
      t = await client.waitForTask(rec.task_id, { onUpdate: (x) => L(`${tag} ${x.status}${x.progress != null ? ` ${x.progress}%` : ''}`) });
    } catch (e) {
      saveState(ctx);
      L(`${tag} ✗ 查任务出错：${errText(e)}。task_id 已记下，重跑同一条命令会接着查，不会重建`);
      return false;
    }
  }
  rec.status = t.status;
  rec.updated_at = now();
  if (t.timedOut) {
    saveState(ctx);
    L(`${tag} … 等了很久还没完（${t.status} ${t.progress ?? 0}%）。task_id 已记下，过会儿重跑同一条命令接着等，不会重建`);
    return false;
  }
  if (t.status !== 'success') {
    rec.error = [t.error_code, t.error_message].filter((x) => x != null).join(' ') || null;
    if (t.credits_consumed != null) rec.credits = Number(t.credits_consumed);
    saveState(ctx);
    L(`${tag} ✗ 任务 ${t.status}${rec.error ? `：${rec.error}` : ''}${t.status === 'banned' ? '（内容审核没过）' : ''}。重来：--reroll ${job.reroll}，再 --run`);
    return false;
  }
  rec.credits = t.credits_consumed == null ? null : Number(t.credits_consumed);
  rec.completed_at = t.completed_at ?? now();
  rec.output = sanitize(t.output ?? {});
  saveState(ctx);
  try {
    Object.assign(rec, await job.collect(t));
  } catch (e) {
    saveState(ctx);
    L(`${tag} ✗ 下载结果失败：${errText(e)}。任务已成功、task_id 已记下，重跑同一条命令会重新查任务再下，不扣费`);
    return false;
  }
  saveState(ctx);
  L(`${tag} ✓ ${rec.file}（${Math.round(rec.bytes / 1024)} KB，实扣 ${rec.credits ?? '未知'} 积分）`);
  if (rec.credits != null && rec.estimate != null && rec.credits > rec.estimate) {
    L(`${tag} ✗ 实扣 ${rec.credits} 比估算 ${rec.estimate} 多：价格可能变了，停下（先改 catalog.mjs 的估算再跑）`);
    return false;
  }
  return true;
}

/** 概念图第 n 张的任务 */
function conceptJob(ctx, n) {
  const body = conceptBody();
  return {
    tag: `  [概念图 ${n}]`,
    get: () => ctx.state.concepts[String(n)],
    put: (r) => { if (r) ctx.state.concepts[String(n)] = r; else delete ctx.state.concepts[String(n)]; },
    endpoint: CONCEPT_ENDPOINT,
    body,
    est: imageCredits(body),
    fallback: 5,
    room: () => BUDGET.concepts - spent(ctx.state, 'concept'),
    reroll: String(n),
    collect: async (t) => {
      const url = pickUrl(t.output, ['generated_image_url', 'image_url'], /\.(png|jpe?g|webp)$/i);
      if (!url) throw new Error(`任务结果里没有图片链接（output 字段：${Object.keys(t.output ?? {}).join(', ') || '空'}）`);
      const got = await download(url, join(ctx.paths.dir, `concept-${n}`, `concept-${n}`));
      return { file: ctx.rel(got.path), bytes: got.bytes };
    },
  };
}

/** 图生模型的任务（从挑中的那张概念图的 task_id 出发）；概念图还没好时返回 null */
function modelJob(ctx) {
  const src = ctx.state.concepts[String(MODEL_FROM)];
  if (!src?.task_id || src.status !== 'success') return null;
  const body = modelBody(src.task_id);
  return {
    tag: '  [模型]',
    get: () => ctx.state.model,
    put: (r) => { ctx.state.model = r; },
    endpoint: MODEL_ENDPOINT,
    body,
    est: model3dCredits(body),
    fallback: 30,
    room: () => BUDGET.total - spent(ctx.state),
    reroll: 'model',
    collect: async (t) => {
      const url = pickUrl(t.output, ['model_url', 'base_model_url', 'pbr_model_url'], /\.(glb|gltf|fbx|zip)$/i);
      if (!url) throw new Error(`任务结果里没有模型链接（output 字段：${Object.keys(t.output ?? {}).join(', ') || '空'}）`);
      const got = await download(url, join(ctx.paths.dir, 'model', 'model'));
      if (got.ext !== 'glb') throw new Error(`下下来的是 ${got.ext}，不是 GLB`);
      // 预览图下不到不要紧
      let preview = null;
      if (typeof t.output?.rendered_image_url === 'string') {
        try {
          preview = ctx.rel((await download(t.output.rendered_image_url, join(ctx.paths.dir, 'model-preview', 'preview'))).path);
        } catch {}
      }
      return { file: ctx.rel(got.path), bytes: got.bytes, preview };
    },
  };
}

// ---------------------------------------------------------------- 命令

function cmdDryRun(ctx, a) {
  const L = ctx.log;
  const cb = conceptBody();
  const ce = imageCredits(cb);
  const per = ce.credits ?? 5;
  L('主角鬼魂 · 演练（--dry-run）：不联网、不写文件、不花积分');
  L('');
  L(`第一段 · 概念图：POST ${ctx.baseUrl}${CONCEPT_ENDPOINT}（每张约 ${ce.credits ?? '未核实'} 积分，${ce.note}）`);
  L('Authorization: Bearer ***');
  L(JSON.stringify(cb, null, 2));
  L(`提示词 ${cb.prompt.length} 个字符（文档建议 ≤ 600 个英文词；CLI 随包文档写的上限是 1024 个字符）`);
  const want = a.only ?? slots();
  let create = 0;
  for (const n of want) {
    if (taskState(ctx, ctx.state.concepts[String(n)]) === 'new') create++;
    L(`  概念图 ${n}：${describeTask(ctx, ctx.state.concepts[String(n)], { per, reroll: String(n), hash: hashOf(CONCEPT_ENDPOINT, cb) })}`);
  }
  const usedC = spent(ctx.state, 'concept');
  L(`  --run concepts --yes${a.only ? ` --only ${a.only.join(',')}` : ''} 会新建 ${create} 个任务，约 ${create * per} 积分；上限 ${BUDGET.concepts}，已记下 ${usedC}`);
  if (usedC + create * per > BUDGET.concepts) L('  ✗ 会超上限：--run 会在超之前停下');
  L('');
  const job = modelJob(ctx);
  if (!job) {
    L(`第二段 · 图生模型：第 ${MODEL_FROM} 张概念图还没好，先 --run concepts`);
  } else {
    L(`第二段 · 图生模型：POST ${ctx.baseUrl}${MODEL_ENDPOINT}（从第 ${MODEL_FROM} 张概念图出发，约 ${job.est.credits ?? '未核实'} 积分，${job.est.note}）`);
    L('Authorization: Bearer ***');
    L(JSON.stringify(job.body, null, 2));
    L(`  模型：${describeTask(ctx, ctx.state.model, { per: job.est.credits, reroll: 'model', hash: hashOf(MODEL_ENDPOINT, job.body) })}`);
    const room = job.room();
    const will = taskState(ctx, ctx.state.model) === 'new' ? job.est.credits ?? job.fallback : 0;
    L(`  --run model --yes 会花约 ${will} 积分；G 路一共 ${BUDGET.total}，已记下 ${spent(ctx.state)}，还剩 ${room}`);
    if (will > room) L('  ✗ 会超上限：--run 会在超之前停下');
  }
  L('');
  L(`key：${apiKeyStatus(ctx.paths.env) === 'ok' ? '有' : keyProblem(ctx)}`);
  return 0;
}

function cmdStatus(ctx) {
  const L = ctx.log;
  const per = imageCredits(conceptBody()).credits ?? 5;
  L(`主角鬼魂（状态 ${ctx.rel(ctx.paths.state)}）`);
  for (const n of slots()) L(`  概念图 ${n}：${describeTask(ctx, ctx.state.concepts[String(n)], { per, reroll: String(n), hash: hashOf(CONCEPT_ENDPOINT, conceptBody()) })}`);
  const job = modelJob(ctx);
  L(`  模型（从第 ${MODEL_FROM} 张）：${job ? describeTask(ctx, ctx.state.model, { per: job.est.credits, reroll: 'model', hash: hashOf(MODEL_ENDPOINT, job.body) }) : '概念图还没好'}`);
  if (ctx.state.history.length) L(`  另有 ${ctx.state.history.length} 条 --reroll 挪走的记录`);
  L(`已记下：概念图 ${spent(ctx.state, 'concept')} / ${BUDGET.concepts}，一共 ${spent(ctx.state)} / ${BUDGET.total} 积分`);
  for (const b of ctx.state.balances.slice(-4)) L(`  ${b.at} ${b.when}：余额 ${b.balance}，冻结 ${b.frozen}`);
  return 0;
}

async function cmdAccount(ctx, which) {
  const L = ctx.log;
  const key = readApiKey(ctx.paths.env);
  if (!key) {
    L(keyProblem(ctx));
    return 1;
  }
  const client = createClient({ apiKey: key, baseUrl: ctx.baseUrl, log: L });
  if (which === 'balance') {
    const b = await client.balance();
    L(`余额 ${b.balance} 积分，冻结 ${b.frozen}（进行中的任务预扣的）`);
    return 0;
  }
  const u = await client.usage();
  const list = Array.isArray(u) ? u : u.list ?? u.items ?? u.records ?? [];
  L(`最近的扣费记录（${list.length} 条，最多列 30 条）：`);
  for (const r of list.slice(0, 30)) L(`  ${r.created_at ?? ''}  ${String(r.type ?? '').padEnd(22)} ${String(r.credits_consumed ?? '').padStart(7)}  ${r.task_id ?? ''}`);
  return 0;
}

function cmdReroll(ctx, a) {
  const L = ctx.log;
  const items = a.list === 'model' ? [['模型', () => ctx.state.model, () => { ctx.state.model = null; }, 'model']]
    : a.list.map((n) => [`概念图 ${n}`, () => ctx.state.concepts[String(n)], () => { delete ctx.state.concepts[String(n)]; }, 'concept']);
  for (const [name, get, drop, kind] of items) {
    const r = get();
    if (!r) {
      L(`  ${name}：没有记录，不用 reroll`);
      continue;
    }
    if (r.task_id && !TERMINAL.has(r.status)) {
      L(`  ${name}：✗ ${r.task_id} 还在进行中（${r.status}），先 --run 等它完`);
      return 1;
    }
    ctx.state.history.push({ ...r, kind, rerolled_at: now() });
    drop();
    L(`  ${name}：记录挪进 history（花掉的积分照样算进上限），下次 --run 重新做；旧文件留着，会被新的盖掉`);
  }
  saveState(ctx);
  return 0;
}

async function cmdRun(ctx, a) {
  const L = ctx.log;
  if (a.what !== 'concepts' && a.what !== 'model') {
    L('--run 后面写 concepts（四张概念图）或 model（图生模型）');
    return 2;
  }
  if (!a.yes) {
    cmdDryRun(ctx, a);
    L('');
    L('加 --yes 才会真的建任务、扣积分');
    return 2;
  }
  let jobs;
  if (a.what === 'concepts') jobs = (a.only ?? slots()).map((n) => conceptJob(ctx, n));
  else {
    const job = modelJob(ctx);
    if (!job) {
      L(`第 ${MODEL_FROM} 张概念图还没好，先 --run concepts --yes --only ${MODEL_FROM}`);
      return 1;
    }
    jobs = [job];
  }
  const key = readApiKey(ctx.paths.env);
  if (!key) {
    L(keyProblem(ctx));
    return 1;
  }
  const client = createClient({ apiKey: key, baseUrl: ctx.baseUrl, log: L, poll: ctx.poll });
  const need = jobs.filter((j) => taskState(ctx, j.get()) === 'new').reduce((s, j) => s + (j.est.credits ?? j.fallback), 0);
  const before = await client.balance();
  ctx.state.balances.push({ at: now(), when: 'before', balance: before.balance, frozen: before.frozen });
  saveState(ctx);
  L(`余额 ${before.balance} 积分（冻结 ${before.frozen}）；这次最多新建约 ${need} 积分的任务`);
  if (Number(before.balance) < need) {
    L('✗ 余额不够，停下');
    return 1;
  }
  let ok = true;
  for (const j of jobs) {
    if (!(await ensureTask(ctx, client, j))) {
      ok = false;
      break;
    }
  }
  const after = await client.balance();
  ctx.state.balances.push({ at: now(), when: 'after', balance: after.balance, frozen: after.frozen });
  saveState(ctx);
  L(`余额 ${after.balance} 积分（冻结 ${after.frozen}）；已记下：概念图 ${spent(ctx.state, 'concept')} / ${BUDGET.concepts}，一共 ${spent(ctx.state)} / ${BUDGET.total}`);
  return ok ? 0 : 1;
}

/**
 * Blender 无头清理（scripts/blender/ghost_cleanup.py）：assets-src/ghost/model/model.glb → public/assets/ghost/ghost.glb。
 * 路径一律绝对路径（Blender 的工作目录不是项目根，相对的输出路径会写到 C:\ 下面）。extra 原样传给清理脚本。
 * 清理完用 glb.mjs 量一遍：一个网格、三角面不超过 CLEANUP_LIMITS
 */
function cmdCleanup(ctx, extra) {
  const L = ctx.log;
  const rec = ctx.state.model;
  if (taskState(ctx, rec) !== 'done') {
    L('模型还没下下来：先 --run model --yes');
    return 1;
  }
  const blender = findBlender();
  if (!blender) {
    L('找不到 Blender：装好之后设环境变量 BLENDER_PATH 指向 blender.exe');
    return 1;
  }
  const src = ctx.abs(rec.file);
  const work = join(ctx.paths.dir, 'cleanup');
  const report = join(work, 'report.json');
  mkdirSync(work, { recursive: true });
  mkdirSync(dirname(ctx.paths.out), { recursive: true });
  const argv = ['-b', '--factory-startup', '--python-exit-code', '1', '-P', ctx.paths.cleanupPy, '--',
    '--in', src, '--out', ctx.paths.out, '--report', report, '--preview', join(work, 'preview'),
    '--max-tris', String(CLEANUP_LIMITS.triangles), ...extra];
  L(`Blender：${blender}`);
  const r = spawnSync(blender, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^\[ghost\]|Error|Traceback|^\s+File "|Exception/.test(l));
  for (const l of lines) L(l);
  if (r.status !== 0 || !existsSync(ctx.paths.out)) {
    L(`✗ Blender 退出码 ${r.status ?? r.error?.message}，没有生成 ${ctx.rel(ctx.paths.out)}`);
    return 1;
  }
  const info = inspectGlb(readFileSync(ctx.paths.out));
  const bytes = statSync(ctx.paths.out).size;
  const problems = [];
  if (info.meshes !== CLEANUP_LIMITS.meshes) problems.push(`网格 ${info.meshes} 个（要 ${CLEANUP_LIMITS.meshes} 个）`);
  if (info.triangles > CLEANUP_LIMITS.triangles) problems.push(`三角面 ${info.triangles} > ${CLEANUP_LIMITS.triangles}`);
  ctx.state.cleanup = { at: now(), out: ctx.rel(ctx.paths.out), bytes, triangles: info.triangles, meshes: info.meshes, primitives: info.primitives, report: ctx.rel(report), args: extra };
  saveState(ctx);
  L(`${problems.length ? '✗' : '✓'} ${ctx.rel(ctx.paths.out)}：${Math.round(bytes / 1024)} KB，三角面 ${info.triangles}，网格 ${info.meshes} 个 / 图元 ${info.primitives} 个${problems.length ? `；${problems.join('；')}` : ''}`);
  L(`  报告 ${ctx.rel(report)}，预览图 ${ctx.rel(work)}/preview-*.png`);
  return problems.length ? 1 : 0;
}

// ---------------------------------------------------------------- 入口

function parseArgs(argv) {
  const a = { cmd: null, yes: false, only: null, what: null, list: null, extra: [] };
  const list = (s, flag) => {
    const v = String(s ?? '').split(',').map((x) => Number(x.trim()));
    if (!v.length || v.some((x) => !Number.isInteger(x) || x < 1 || x > CONCEPT_COUNT)) throw new Error(`${flag} 后面写 1 到 ${CONCEPT_COUNT} 的编号，用逗号隔开`);
    return [...new Set(v)];
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (a.cmd === '--cleanup') a.extra.push(t); // --cleanup 后面的都交给清理脚本
    else if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--only') a.only = list(argv[++i], '--only');
    else if (t === '--run') {
      a.cmd = t;
      a.what = argv[++i];
    } else if (t === '--reroll') {
      a.cmd = t;
      a.list = argv[i + 1] === 'model' ? (i++, 'model') : list(argv[++i], '--reroll');
    } else if (COMMANDS.includes(t)) a.cmd = t;
    else throw new Error(`看不懂的参数：${t}`);
  }
  return a;
}

/**
 * @param {string[]} argv
 * @param {{ paths?: Partial<typeof DEFAULT_PATHS>, baseUrl?: string, log?: (s: string) => void, poll?: object }} [opts]
 *   baseUrl、paths 只给自测用（指向本地假服务、临时目录）；命令行不提供覆盖方式，免得 key 被发到别的地方
 * @returns {Promise<number>} 退出码：0 成功，1 出错或停下，2 用法不对 / 缺 --yes
 */
export async function main(argv, opts = {}) {
  const paths = { ...DEFAULT_PATHS, ...(opts.paths ?? {}) };
  const out = opts.log ?? ((s) => console.log(s));
  const ctx = {
    paths,
    baseUrl: opts.baseUrl ?? BASE_URL,
    poll: opts.poll,
    log: (s = '') => out(mask(s)),
    rel: (p) => relative(paths.root, p).split(sep).join('/'),
    abs: (p) => resolve(paths.root, p),
    state: null,
  };
  let a;
  try {
    a = parseArgs(argv);
  } catch (e) {
    ctx.log(e.message);
    ctx.log(HELP);
    return 2;
  }
  if (!a.cmd || a.cmd === '--help') {
    ctx.log(HELP);
    return a.cmd ? 0 : 2;
  }
  ctx.state = loadState(ctx);
  switch (a.cmd) {
    case '--dry-run': return cmdDryRun(ctx, a);
    case '--status': return cmdStatus(ctx);
    case '--run': return cmdRun(ctx, a);
    case '--cleanup': return cmdCleanup(ctx, a.extra);
    case '--balance': return cmdAccount(ctx, 'balance');
    case '--usage': return cmdAccount(ctx, 'usage');
    case '--reroll': return cmdReroll(ctx, a);
    default: return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof TripoError ? e.describe() : mask(e?.stack ?? e));
    process.exitCode = 1;
  }
}
