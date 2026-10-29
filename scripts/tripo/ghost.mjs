// 主角鬼魂的新模型（路 G，2026-10-29）：Tripo 文生图出概念图 → 用户挑一张 →（第二段）图生模型 → Blender 清理 → public/assets/ghost/ghost.glb。
// 现在只有第一段：四张概念图（POST /v3/generation/text-to-image，seedream_v5，每张 5 积分）。第二段等用户挑好图再加。
//
//   node scripts/tripo/ghost.mjs --dry-run                  打印要发的请求（key 打码）和积分估算。不联网、不写文件、不花钱
//   node scripts/tripo/ghost.mjs --run concepts --yes       真跑（会扣积分）：四张概念图，各放在 assets-src/ghost/concept-<n>/ 下（.jpg）
//        --only 1,2                                         只做这几张
//   node scripts/tripo/ghost.mjs --status                   看状态文件（不联网）
//   node scripts/tripo/ghost.mjs --balance | --usage        查余额 / 最近的扣费记录（免费接口）
//   node scripts/tripo/ghost.mjs --reroll 2,3               丢掉这几张的记录，下次 --run 重新出（每张再扣 5 积分，花掉的照样算进上限）
//
// 接口：developers.tripo3d.ai/en/docs/generation-text-to-image（2026-10-28 抓的副本在主工作区 .logs/tripo-docs-live-2026-10-28/）：
//   seedream_v5 "latest quality, stronger prompt following"；size 写 WxH（seedream_v5 总像素 3.69–10.40 MP）；不要的东西写在提示词的
//   --no 后面；结果在 output.generated_image_url。图像类任务每个账号只有 1 个并发，所以一张一张来。价格见 catalog.mjs（seedream_v5 各档都是 5）
// 状态：assets-src/ghost/state.json（自己的文件；访客流水线的 assets-src/tripo-state.json 不碰）。每张图的 task_id 一建好就记下，
//   重跑只补没做完的、接着等没等完的，不会重复建任务；建任务时断线（任务可能已经建好、冻结了积分）会留记号，重跑停在那里等人查
// key：client.mjs 从 .env.local 读，只放在发给 API 的请求头里；打印的东西都过 mask()，状态文件里的链接去掉签名
// 积分：用户批给 G 路 70，这一段最多 BUDGET.concepts（20）。建每个任务之前按估算查一遍，会超就停；实扣比估算多也停
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { imageCredits } from './catalog.mjs';
import { BASE_URL, TERMINAL, TripoError, apiKeyStatus, createClient, download, mask, readApiKey, shortUrl } from './client.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

export const DEFAULT_PATHS = {
  root: ROOT,
  env: join(ROOT, '.env.local'),
  dir: join(ROOT, 'assets-src', 'ghost'),
  state: join(ROOT, 'assets-src', 'ghost', 'state.json'),
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

const HELP = `主角鬼魂的新模型（路 G）· 第一段：四张概念图（Tripo 文生图 seedream_v5，每张约 5 积分，这一段最多 ${BUDGET.concepts}）
  node scripts/tripo/ghost.mjs --dry-run [--only 1,2]          打印请求（key 打码）和积分估算。不联网、不写文件、不花钱
  node scripts/tripo/ghost.mjs --run concepts --yes [--only 1,2]   真跑（会扣积分）。重跑只补没做完的，不会重复建任务
  node scripts/tripo/ghost.mjs --status                        看状态（不联网）
  node scripts/tripo/ghost.mjs --balance | --usage             查余额 / 最近的扣费记录（免费接口）
  node scripts/tripo/ghost.mjs --reroll 2,3                    丢掉这几张的记录，下次 --run 重新出
状态 assets-src/ghost/state.json · 图 assets-src/ghost/concept-<n>/ · key 读 .env.local 的 TRIPO_API_KEY`;

const COMMANDS = ['--dry-run', '--run', '--status', '--balance', '--usage', '--reroll', '--help'];
const BAD_END = new Set(['failed', 'banned', 'expired', 'cancelled']);

// ---------------------------------------------------------------- 小工具

const now = () => new Date().toISOString();
const isObj = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const errText = (e) => (e instanceof TripoError ? e.describe() : mask(e?.message ?? e));
const slots = () => Array.from({ length: CONCEPT_COUNT }, (_, i) => i + 1);
/** 请求的指纹：状态里记下每张用的是哪个请求（改过提示词以后，旧图照样留着，只是能看出来） */
const hashOf = (endpoint, body) => createHash('sha256').update(JSON.stringify({ endpoint, body })).digest('hex').slice(0, 16);

/** 状态文件里不留签名链接（只留站点 + 路径） */
function sanitize(v) {
  if (typeof v === 'string') return /^https?:\/\//.test(v) ? shortUrl(v) : v;
  if (Array.isArray(v)) return v.map(sanitize);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sanitize(x)]));
  return v;
}

/** 结果里的图片链接：先认文档写的 generated_image_url，没有再找任何一个路径以 png / jpg / webp 结尾的链接 */
function pickImageUrl(output) {
  if (!isObj(output)) return null;
  if (typeof output.generated_image_url === 'string' && /^https?:\/\//.test(output.generated_image_url)) return output.generated_image_url;
  for (const v of Object.values(output)) {
    if (typeof v !== 'string' || !/^https?:\/\//.test(v)) continue;
    try {
      if (/\.(png|jpe?g|webp)$/i.test(new URL(v).pathname)) return v;
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
 * 这一段已经花掉（或可能花掉）的积分，含 --reroll 挪进 history 的：有实扣用实扣；建了任务、还不知道扣多少的按估算；
 * 建任务时断线、不知道建没建成的也按估算算上（宁可少花）
 */
function spent(state) {
  let c = 0;
  for (const r of [...Object.values(state.concepts), ...state.history]) c += r.credits ?? r.estimate ?? 0;
  return c;
}

/** 一张图的状态：new 没建 / pending 建任务时断线 / running 在跑 / done 图在 / refetch 成功过但图不在了 / failed 失败、被拒、过期、取消 */
function slotState(ctx, n) {
  const r = ctx.state.concepts[String(n)];
  if (!r) return 'new';
  if (!r.task_id) return 'pending';
  if (r.status === 'success') return r.file && existsSync(ctx.abs(r.file)) ? 'done' : 'refetch';
  if (BAD_END.has(r.status)) return 'failed';
  return 'running';
}

function describeSlot(ctx, n, per) {
  const r = ctx.state.concepts[String(n)];
  const st = slotState(ctx, n);
  const changed = r && r.hash !== hashOf(CONCEPT_ENDPOINT, conceptBody()) ? '（用的是改之前的提示词）' : '';
  return {
    new: `还没出（--run 会新建，约 ${per} 积分）`,
    pending: `上次建任务时连接断了（${r?.pending_since}），任务可能已经建好。先 --usage 查；确认没有再 --reroll ${n}`,
    running: `进行中 ${r?.task_id}（${r?.status}），--run 接着等，不重建`,
    done: `✓ ${r?.file}（实扣 ${r?.credits ?? '未知'}，task ${r?.task_id}）${changed}`,
    refetch: `成功过（task ${r?.task_id}）但图不在了：--run 重新查任务再下，不扣费${changed}`,
    failed: `✗ ${r?.task_id} ${r?.status}${r?.error ? `：${r.error}` : ''}。重来：--reroll ${n}`,
  }[st];
}

// ---------------------------------------------------------------- 命令

function cmdDryRun(ctx, a) {
  const L = ctx.log;
  const body = conceptBody();
  const est = imageCredits(body);
  const per = est.credits ?? 5;
  L('主角鬼魂 · 第一段（四张概念图）· 演练（--dry-run）：不联网、不写文件、不花积分');
  L('');
  L(`POST ${ctx.baseUrl}${CONCEPT_ENDPOINT}`);
  L('Authorization: Bearer ***');
  L(JSON.stringify(body, null, 2));
  L(`提示词 ${body.prompt.length} 个字符（文档建议 ≤ 600 个英文词；CLI 随包文档写的上限是 1024 个字符）`);
  L(`每张约 ${est.credits ?? '未核实'} 积分（${est.note}）`);
  L('');
  const want = a.only ?? slots();
  let create = 0;
  for (const n of want) {
    if (slotState(ctx, n) === 'new') create++;
    L(`  概念图 ${n}：${describeSlot(ctx, n, per)}`);
  }
  const used = spent(ctx.state);
  L('');
  L(`现在执行 --run concepts --yes${a.only ? ` --only ${a.only.join(',')}` : ''} 会新建 ${create} 个任务，约 ${create * per} 积分；`
    + `这一段上限 ${BUDGET.concepts}，状态里已记下 ${used}`);
  if (used + create * per > BUDGET.concepts) L(`  ✗ 会超上限：--run 会在超之前停下`);
  L(`key：${apiKeyStatus(ctx.paths.env) === 'ok' ? '有' : keyProblem(ctx)}`);
  return 0;
}

function cmdStatus(ctx) {
  const L = ctx.log;
  const per = imageCredits(conceptBody()).credits ?? 5;
  L(`主角鬼魂 · 概念图（状态 ${ctx.rel(ctx.paths.state)}）`);
  for (const n of slots()) L(`  概念图 ${n}：${describeSlot(ctx, n, per)}`);
  if (ctx.state.history.length) L(`  另有 ${ctx.state.history.length} 条 --reroll 挪走的记录`);
  L(`这一段已记下 ${spent(ctx.state)} / ${BUDGET.concepts} 积分`);
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
  for (const n of a.list) {
    const r = ctx.state.concepts[String(n)];
    if (!r) {
      L(`  概念图 ${n}：没有记录，不用 reroll`);
      continue;
    }
    if (r.task_id && !TERMINAL.has(r.status)) {
      L(`  概念图 ${n}：✗ ${r.task_id} 还在进行中（${r.status}），先 --run 等它完`);
      return 1;
    }
    ctx.state.history.push({ ...r, slot: n, rerolled_at: now() });
    delete ctx.state.concepts[String(n)];
    L(`  概念图 ${n}：记录挪进 history（花掉的积分照样算进这一段的上限），下次 --run 重新出；旧图文件留着，会被新图盖掉`);
  }
  saveState(ctx);
  return 0;
}

/** 等任务、下载结果。task 是已经查到的终态（重新下载时）；没给就轮询到终态 */
async function finish(ctx, client, n, rec, task = null) {
  const L = ctx.log;
  const tag = `  [概念图 ${n}]`;
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
    L(`${tag} ✗ 任务 ${t.status}${rec.error ? `：${rec.error}` : ''}${t.status === 'banned' ? '（内容审核没过，改提示词）' : ''}。重来：--reroll ${n}，再 --run concepts --yes`);
    return false;
  }
  rec.credits = t.credits_consumed == null ? null : Number(t.credits_consumed);
  rec.completed_at = t.completed_at ?? now();
  rec.output = sanitize(t.output ?? {});
  saveState(ctx);
  const url = pickImageUrl(t.output);
  if (!url) {
    L(`${tag} ✗ 任务结果里没有图片链接（output 字段：${Object.keys(t.output ?? {}).join(', ') || '空'}）`);
    return false;
  }
  try {
    // 每张下载来的图放在自己的目录里，不和脚本、状态文件混在一起
    const got = await download(url, join(ctx.paths.dir, `concept-${n}`, `concept-${n}`));
    rec.file = ctx.rel(got.path);
    rec.bytes = got.bytes;
  } catch (e) {
    saveState(ctx);
    L(`${tag} ✗ 下载失败：${errText(e)}。任务已成功、task_id 已记下，重跑同一条命令会重新查任务再下，不扣费`);
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

async function ensureConcept(ctx, client, n) {
  const L = ctx.log;
  const tag = `  [概念图 ${n}]`;
  const st = slotState(ctx, n);
  const rec0 = ctx.state.concepts[String(n)];
  if (st === 'done') {
    L(`${tag} ✓ 已有：${rec0.file}`);
    return true;
  }
  if (st === 'pending' || st === 'failed') {
    L(`${tag} ✗ ${describeSlot(ctx, n, rec0?.estimate ?? 5)}`);
    return false;
  }
  if (st === 'running') {
    L(`${tag} … 接着等 ${rec0.task_id}`);
    return finish(ctx, client, n, rec0);
  }
  if (st === 'refetch') {
    L(`${tag} 图不在了，重新查 ${rec0.task_id} 拿链接再下（不扣费）`);
    try {
      return await finish(ctx, client, n, rec0, await client.getTask(rec0.task_id));
    } catch (e) {
      L(`${tag} ✗ 查任务出错：${errText(e)}`);
      return false;
    }
  }
  // 新建：先按估算查上限
  const body = conceptBody();
  const est = imageCredits(body);
  const cost = est.credits ?? 5;
  const used = spent(ctx.state);
  if (used + cost > BUDGET.concepts) {
    L(`${tag} ✗ 再建这张（约 ${cost} 积分）就超过这一段的上限 ${BUDGET.concepts} 了（已记下 ${used}），停下`);
    return false;
  }
  const rec = { endpoint: CONCEPT_ENDPOINT, hash: hashOf(CONCEPT_ENDPOINT, body), request: body, estimate: est.credits, pending_since: now() };
  ctx.state.concepts[String(n)] = rec;
  saveState(ctx);
  L(`${tag} → 新建：POST ${CONCEPT_ENDPOINT}（${est.note}，约 ${cost} 积分）`);
  try {
    rec.task_id = await client.createTask(CONCEPT_ENDPOINT, body);
  } catch (e) {
    if (e?.possiblyCreated) {
      rec.error = errText(e);
      saveState(ctx);
      L(`${tag} ✗ ${rec.error}`);
      L(`${tag}   任务可能已经在服务器上建好了（积分可能已冻结）。状态里留了记号，重跑会停在这里：先 --usage 查，确认没有再 --reroll ${n}`);
      return false;
    }
    delete ctx.state.concepts[String(n)];
    saveState(ctx);
    L(`${tag} ✗ ${errText(e)}（任务没建成，不扣费）`);
    return false;
  }
  rec.pending_since = null;
  rec.status = 'queued';
  rec.created_at = now();
  saveState(ctx);
  L(`${tag}   task ${rec.task_id}`);
  return finish(ctx, client, n, rec);
}

async function cmdRun(ctx, a) {
  const L = ctx.log;
  if (a.what !== 'concepts') {
    L('第一段只有 --run concepts（图生模型等用户挑好概念图再加）');
    return 2;
  }
  if (!a.yes) {
    cmdDryRun(ctx, a);
    L('');
    L('加 --yes 才会真的建任务、扣积分');
    return 2;
  }
  const key = readApiKey(ctx.paths.env);
  if (!key) {
    L(keyProblem(ctx));
    return 1;
  }
  const client = createClient({ apiKey: key, baseUrl: ctx.baseUrl, log: L, poll: ctx.poll });
  const want = a.only ?? slots();
  const per = imageCredits(conceptBody()).credits ?? 5;
  const create = want.filter((n) => slotState(ctx, n) === 'new').length;
  const before = await client.balance();
  ctx.state.balances.push({ at: now(), when: 'before', balance: before.balance, frozen: before.frozen });
  saveState(ctx);
  L(`余额 ${before.balance} 积分（冻结 ${before.frozen}）；这次最多新建 ${create} 张，约 ${create * per} 积分`);
  if (Number(before.balance) < create * per) {
    L('✗ 余额不够，停下');
    return 1;
  }
  let ok = true;
  for (const n of want) {
    if (!(await ensureConcept(ctx, client, n))) {
      ok = false;
      break;
    }
  }
  const after = await client.balance();
  ctx.state.balances.push({ at: now(), when: 'after', balance: after.balance, frozen: after.frozen });
  saveState(ctx);
  L(`余额 ${after.balance} 积分（冻结 ${after.frozen}）；这一段已记下 ${spent(ctx.state)} / ${BUDGET.concepts} 积分`);
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------- 入口

function parseArgs(argv) {
  const a = { cmd: null, yes: false, only: null, what: null, list: null };
  const list = (s, flag) => {
    const v = String(s ?? '').split(',').map((x) => Number(x.trim()));
    if (!v.length || v.some((x) => !Number.isInteger(x) || x < 1 || x > CONCEPT_COUNT)) throw new Error(`${flag} 后面写 1 到 ${CONCEPT_COUNT} 的编号，用逗号隔开`);
    return [...new Set(v)];
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--yes' || t === '-y') a.yes = true;
    else if (t === '--only') a.only = list(argv[++i], '--only');
    else if (t === '--run') {
      a.cmd = t;
      a.what = argv[++i];
    } else if (t === '--reroll') {
      a.cmd = t;
      a.list = list(argv[++i], '--reroll');
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
