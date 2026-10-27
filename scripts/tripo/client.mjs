// Tripo API v3 的小客户端：从 .env.local 读 key、上传图片、建任务、轮询、下载结果。只用 Node 24 自带的 fetch / FormData / Blob。
//
// 接口出处：本地 Desktop/Tripo API网站/docs/research/2026-10-22/tripo-docs/*.md，缺的页面（files、image-to-image、image-to-model、
// rate-limits、sdk）在 https://developers.tripo3d.ai/en/docs/<页面>.md（2026-10-27 读取）。
//
// 安全约定：
// - key 只从项目根目录的 .env.local 读，不读系统环境变量（这台机器上同时跑着别的项目，环境变量里可能是别的账号的 key）
// - key 只出现在发往 API 的 Authorization 头里；任何要打印的文字都先过 mask()
// - 下载结果文件（签名链接）时不带 Authorization：key 只发给 API 本身，不发给存储 / CDN（SDK 文档也是这么做的）
// - 建任务的 POST 只在 429（限流 / 并发满，任务肯定没建）时重试；网络错误或 5xx 不重试，因为任务可能已经建好并冻结了积分
//   （CLI 文档原话：Network error or HTTP 5xx during submission: the task may already exist on the server）
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { imageInfo } from './glb.mjs';

export const BASE_URL = 'https://openapi.tripo3d.ai/v3';
/** 任务的终态（task-lifecycle.md） */
export const TERMINAL = new Set(['success', 'failed', 'banned', 'expired', 'cancelled']);

// ---------------------------------------------------------------- key 与打码

const SECRETS = new Set();

/** 把要打印的文字里的 key、Bearer 头、tsk_ 开头的串都换成 *** */
export function mask(text) {
  let s = String(text ?? '');
  for (const k of SECRETS) if (k && k.length >= 4) s = s.split(k).join('***');
  return s.replace(/Bearer\s+(?!\*\*\*)[^\s"',;）)]+/gi, 'Bearer ***').replace(/\btsk_[A-Za-z0-9_-]{4,}/g, 'tsk_***');
}

/** 只把签名链接的「站点 + 路径」拿来打印（查询串里是临时签名，没用也不该到处贴） */
export function shortUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`;
  } catch {
    return '(无效链接)';
  }
}

/** 读 .env.local 的文字。PowerShell 的 `echo ... > .env.local` 会写成 UTF-16，这里一并认 */
function readEnvText(envPath) {
  if (!existsSync(envPath)) return null;
  const b = readFileSync(envPath);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2)).swap16().toString('utf16le');
  return b.toString('utf8').replace(/^﻿/, '');
}

/** 找 TRIPO_API_KEY 这一行：undefined = 没有这一行，'' = 有但是空的 */
function findKey(text) {
  let found;
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?TRIPO_API_KEY\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[1].trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.lastIndexOf(q) > 0) v = v.slice(1, v.lastIndexOf(q));
    else v = v.replace(/(^|\s+)#.*$/, '').trim();
    if (v) return v;
    found = '';
  }
  return found;
}

/**
 * 从 .env.local 读 TRIPO_API_KEY；文件不存在、没有这一行或值是空的都返回 null。
 * 支持 `KEY=value`、`export KEY=value`、单 / 双引号、行尾 # 注释、BOM、CRLF、UTF-16
 */
export function readApiKey(envPath) {
  const text = readEnvText(envPath);
  const v = text == null ? undefined : findKey(text);
  if (!v) return null;
  SECRETS.add(v);
  return v;
}

/** key 的情况（不返回 key 本身）：ok / no-file / no-line / empty */
export function apiKeyStatus(envPath) {
  const text = readEnvText(envPath);
  if (text == null) return 'no-file';
  const v = findKey(text);
  return v === undefined ? 'no-line' : v ? 'ok' : 'empty';
}

// ---------------------------------------------------------------- 错误

/** error-handling.md 的错误码表（再加上文档里提到的 1004：参数组合不被接受） */
const CODE_HINTS = {
  1000: 'API key 无效或已删除',
  1001: '没带 Authorization 头',
  1004: '参数组合不被接受（比如 texture_quality=fast 没配 texture_version=v3.5-20260815）',
  1007: '请求太频繁，被限流',
  2000: '同类任务并发已满（图像生成类只有 1 个并发）',
  2002: '请求里有不支持的字段或取值',
  2003: '上传的文件是空的',
  2004: '文件类型不支持',
  2008: '内容审核没过，改提示词或图片',
  2010: '积分不够，去控制台充值',
  2015: '版本已废弃',
  2018: '模型太复杂',
};

export class TripoError extends Error {
  constructor({ message, httpStatus = null, code = null, suggestion = '', requestId = null, possiblyCreated = false, kind = 'api' }) {
    super(mask(message));
    this.name = 'TripoError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.suggestion = mask(suggestion);
    this.requestId = requestId;
    /** 建任务时出的错，而且任务可能已经在服务器上建好了（要先对账再重跑） */
    this.possiblyCreated = possiblyCreated;
    this.kind = kind;
  }

  describe() {
    const bits = [this.message];
    if (this.httpStatus) bits.push(`HTTP ${this.httpStatus}`);
    if (this.code != null) bits.push(`code ${this.code}${CODE_HINTS[this.code] ? `（${CODE_HINTS[this.code]}）` : ''}`);
    if (this.suggestion) bits.push(`建议：${this.suggestion}`);
    if (this.requestId) bits.push(`request_id ${this.requestId}`);
    return mask(bits.join(' · '));
  }
}

export class DownloadError extends Error {
  constructor(message, httpStatus = null) {
    super(mask(message));
    this.name = 'DownloadError';
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------- 等待

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 文档建议：1 秒起、每次翻倍、最多 32 秒（rate-limits.md / error-handling.md） */
const backoffMs = (attempt) => Math.min(32, 2 ** attempt) * 1000;

function retryWaitMs(res, attempt) {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.min(300, Math.max(1, s)) * 1000;
    const t = Date.parse(ra);
    if (Number.isFinite(t)) return Math.min(300_000, Math.max(1000, t - Date.now()));
  }
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.min(300_000, Math.max(1000, reset * 1000 - Date.now()));
  return backoffMs(attempt);
}

// ---------------------------------------------------------------- 客户端

/**
 * @param {object} o
 * @param {string} o.apiKey
 * @param {string} [o.baseUrl]  只给自测用（指向本地假服务）；命令行不提供覆盖方式，免得 key 被发到别的地方
 * @param {(s: string) => void} [o.log]
 * @param {{ firstMs?: number, factor?: number, maxMs?: number, timeoutMs?: number }} [o.poll]
 */
export function createClient({ apiKey, baseUrl = BASE_URL, log = () => {}, sleep = realSleep, requestTimeoutMs = 60_000, poll = {} }) {
  if (!apiKey) throw new Error('缺少 TRIPO_API_KEY');
  SECRETS.add(apiKey);
  // 轮询：文档建议 1–2 秒一次；生成 / 绑骨要几分钟，所以从 2 秒起慢慢放到 10 秒；单步最多等 20 分钟（SDK 示例同样是 20 分钟）
  const P = { firstMs: 2000, factor: 1.5, maxMs: 10_000, timeoutMs: 20 * 60_000, ...poll };

  async function call(method, path, { json, form, idempotent = method === 'GET', maxRetries = 6 } = {}) {
    for (let attempt = 0; ; attempt++) {
      const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
      let body;
      if (json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(json);
      } else if (form) body = form; // multipart 的边界让 fetch 自己生成
      let res;
      let text;
      try {
        res = await fetch(baseUrl + path, { method, headers, body, signal: AbortSignal.timeout(requestTimeoutMs) });
        text = await res.text();
      } catch (e) {
        const why = e?.name === 'TimeoutError' ? `${requestTimeoutMs / 1000} 秒没响应` : `网络错误（${e?.cause?.code ?? e?.cause?.message ?? e?.message ?? e}）`;
        if (idempotent && attempt < maxRetries) {
          const w = backoffMs(attempt);
          log(mask(`    ${method} ${path} ${why}，${w / 1000} 秒后重试`));
          await sleep(w);
          continue;
        }
        throw new TripoError({ kind: 'network', message: `${method} ${path} ${why}`, possiblyCreated: !idempotent });
      }
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {}
      if (res.ok && payload && payload.code === 0) return payload.data ?? {};
      if (res.status === 429 && attempt < maxRetries) {
        const w = retryWaitMs(res, attempt);
        log(`    ${method} ${path} 被限流（HTTP 429${payload?.code != null ? ` · code ${payload.code}` : ''}），${Math.round(w / 1000)} 秒后重试`);
        await sleep(w);
        continue;
      }
      if (res.status >= 500 && idempotent && attempt < maxRetries) {
        const w = backoffMs(attempt);
        log(`    ${method} ${path} 服务端出错（HTTP ${res.status}），${w / 1000} 秒后重试`);
        await sleep(w);
        continue;
      }
      throw new TripoError({
        httpStatus: res.status,
        code: payload?.code ?? null,
        message: `${method} ${path} 失败：${payload?.message ?? (String(text ?? '').slice(0, 300) || res.statusText)}`,
        suggestion: payload?.suggestion ?? '',
        requestId: payload?.request_id ?? res.headers.get('x-request-id'),
        // 5xx、408、或者 200 但回包看不懂：建任务的请求可能已经生效
        possiblyCreated: !idempotent && (res.status >= 500 || res.status === 408 || (res.ok && !payload)),
      });
    }
  }

  /** 上传一张参考图，返回 file_token。/v3/files 只收 JPEG / PNG（≤ 20 MB）；WebP 走 /v3/files/presign 直传 */
  async function upload(filePath) {
    const buf = await readFile(filePath);
    const info = imageInfo(buf);
    if (!info) throw new Error(`${basename(filePath)} 不是 PNG / JPEG / WebP 图片`);
    if (buf.length > 20 * 1024 * 1024) throw new Error(`${basename(filePath)} 超过 20 MB（图片接口的上限）`);
    if (info.mime === 'image/webp') {
      const d = await call('POST', '/files/presign', { json: { format: 'webp' }, idempotent: true });
      const put = await fetch(d.presigned_url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf, signal: AbortSignal.timeout(120_000) });
      if (!put.ok) throw new Error(`直传到存储失败：HTTP ${put.status}`);
      if (!d.file_token) throw new Error('presign 回包里没有 file_token');
      return d.file_token;
    }
    const form = new FormData();
    form.append('file', new Blob([buf], { type: info.mime }), basename(filePath));
    const d = await call('POST', '/files', { form, idempotent: true, maxRetries: 3 });
    if (!d.file_token) throw new Error('上传成功但回包里没有 file_token');
    return d.file_token;
  }

  /** 建任务（会冻结积分）。返回 task_id */
  async function createTask(path, body) {
    const d = await call('POST', path, { json: body, idempotent: false });
    if (typeof d.task_id !== 'string' || !d.task_id) {
      throw new TripoError({ message: `POST ${path} 的回包里没有 task_id`, possiblyCreated: true });
    }
    return d.task_id;
  }

  const getTask = (taskId) => call('GET', `/tasks/${encodeURIComponent(taskId)}`);

  /**
   * 轮询到终态。超过 timeoutMs 还没结束就返回 { ...task, timedOut: true }（任务还在服务器上跑，task_id 已记下，下次接着等）。
   * 不认识的状态（文档之外的）继续等
   */
  async function waitForTask(taskId, { onUpdate, timeoutMs = P.timeoutMs } = {}) {
    const start = Date.now();
    let wait = P.firstMs;
    let last = '';
    for (;;) {
      const t = await getTask(taskId);
      const sig = `${t.status}|${t.progress ?? ''}`;
      if (sig !== last) {
        last = sig;
        onUpdate?.(t);
      }
      if (TERMINAL.has(t.status)) return t;
      if (Date.now() - start > timeoutMs) return { ...t, timedOut: true };
      await sleep(wait);
      wait = Math.min(P.maxMs, Math.round(wait * P.factor));
    }
  }

  return {
    upload,
    createTask,
    getTask,
    waitForTask,
    balance: () => call('GET', '/account/balance'),
    usage: () => call('GET', '/account/usage'),
  };
}

// ---------------------------------------------------------------- 下载

/** 按文件头认格式（链接路径里的扩展名不一定可靠） */
export function sniffExt(buf) {
  if (buf.length >= 12 && buf.readUInt32LE(0) === 0x46546c67) return 'glb';
  const img = imageInfo(buf);
  if (img) return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[img.mime];
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  if (buf.length >= 18 && buf.toString('latin1', 0, 18) === 'Kaydara FBX Binary') return 'fbx';
  if (buf.length && buf[0] === 0x7b && buf.toString('utf8', 0, Math.min(buf.length, 4096)).includes('"asset"')) return 'gltf';
  return null;
}

/**
 * 下载签名链接到 destNoExt.<按文件头认出的扩展名>（先写 .part 再改名，半截文件不会冒充成品）。
 * 不带任何认证头。只接受 https（自测时允许 127.0.0.1）
 */
export async function download(url, destNoExt, { timeoutMs = 300_000 } = {}) {
  if (typeof url !== 'string' || !(/^https:\/\//i.test(url) || /^http:\/\/127\.0\.0\.1[:/]/.test(url))) {
    throw new DownloadError(`结果链接不是 https：${shortUrl(url)}`);
  }
  let res;
  try {
    res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new DownloadError(`下载 ${shortUrl(url)} 失败：${e?.cause?.code ?? e?.message ?? e}`);
  }
  if (!res.ok) throw new DownloadError(`下载 ${shortUrl(url)} 失败：HTTP ${res.status}（签名链接可能过期了）`, res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new DownloadError(`下载 ${shortUrl(url)} 得到的是空文件`);
  let ext = sniffExt(buf);
  if (!ext) {
    try {
      ext = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? 'bin';
    } catch {
      ext = 'bin';
    }
  }
  const dest = `${destNoExt}.${ext}`;
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(`${dest}.part`, buf);
  await rename(`${dest}.part`, dest);
  return { path: dest, bytes: buf.length, ext };
}
