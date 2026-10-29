// 冷启动要多久（上线后玩家是从网上下载）：Chrome 用 CDP 的 Network.emulateNetworkConditions 限速，
// 量「开场按钮可用」的时刻、各类资源的字节数（开场按钮可用之前 / 之后分开算），还有其余几套访客造型全部加入轮换的时刻。
// 每次都是新开的浏览器（空的缓存，着色器也是冷的），和第一次来玩的人一样。
//
//   先构建、起预览（脚本不自己起服务器：改前改后各起一个，同一档里轮流量）：
//     ./node_modules/.bin/vite build --outDir .logs/dist-L
//     ./node_modules/.bin/vite preview --outDir .logs/dist-L --port 5736 --strictPort --host 127.0.0.1
//   node scripts/loadtime.mjs                                  量 http://127.0.0.1:5736/，三档各 3 次
//   node scripts/loadtime.mjs --url 改前=http://127.0.0.1:5735/ --url 改后=http://127.0.0.1:5736/
//                                                              给几个 --url 就在同一档、同一轮里挨个量（机器负载的起伏两边都吃到）
//   --runs 3            每档几次
//   --profiles 50,10,4  哪几档（Mbps）：50 = 50 Mbps / 20 ms，10 = 10 Mbps / 40 ms，4 = 4 Mbps / 80 ms（延迟是每个请求多出的往返）
//   --query webgl       地址后面加的参数（不带 ?）
//   --json 文件         明细存成 JSON（默认 .logs/loadtime-<时间>.json）
//
// vite preview 对 JS、CSS、HTML 做 gzip（JS 1.35 MB → 约 0.41 MB，和上线的静态托管差不多），GLB 原样传
// （GLB 里的贴图本来就是 WebP，托管压不压都差不多）。字节数是 CDP 记的实际传输量（含响应头）
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const urls = argv.flatMap((a, i) => (a === '--url' ? [argv[i + 1]] : [])).map((s) => {
  const eq = s.indexOf('=');
  return eq > 0 && !s.slice(0, eq).includes('/') ? { label: s.slice(0, eq), url: s.slice(eq + 1) } : { label: s, url: s };
});
if (!urls.length) urls.push({ label: '5736', url: 'http://127.0.0.1:5736/' });
const RUNS = Number(opt('--runs', 3));
const QUERY = opt('--query', '');
const PROFILES = {
  50: { mbps: 50, latency: 20 },
  10: { mbps: 10, latency: 40 },
  4: { mbps: 4, latency: 80 },
};
const profiles = opt('--profiles', '50,10,4').split(',').map((p) => {
  if (!PROFILES[p]) throw new Error(`没有 ${p} 这一档（有 ${Object.keys(PROFILES).join(' / ')}）`);
  return { name: `${p} Mbps`, ...PROFILES[p] };
});
const JSON_OUT = opt('--json', `.logs/loadtime-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
/** 等开场按钮最多多久；按钮可用以后，等其余几套造型下载完、加入轮换最多多久（毫秒） */
const TIMEOUT = { ready: 180000, rest: 120000 };

/**
 * 资源归类：GLB 按路径分——访客造型（public/assets/visitors/，最先请求的那一套是「第一套」，开场按钮只等它）、
 * 鬼魂模型（public/assets/ghost/，和第一套同时下载，见 main.ts 的 boot）、占位狐狸（mascot/）；其余按扩展名
 */
const isVisitorGlb = (url) => /\/visitors\/[^/]+\.glb$/i.test(new URL(url).pathname);
const kindOf = (url, firstVisitor) => {
  const path = new URL(url).pathname;
  if (/\.glb$/i.test(path)) {
    if (isVisitorGlb(url)) return url === firstVisitor ? 'glb 第一套造型' : 'glb 其余造型';
    if (path.includes('/ghost/')) return 'glb 鬼魂';
    if (path.includes('/mascot/')) return 'glb 占位狐狸';
    return 'glb 其他';
  }
  if (/\.js$/i.test(path)) return 'js';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.woff2?$/i.test(path)) return '字体';
  if (path.endsWith('/') || /\.html$/i.test(path)) return 'html';
  return '其他';
};
const MB = (b) => (b / 1e6).toFixed(2);

async function measure(target, profile) {
  const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    // 开场按钮从禁用变成可用的那一刻（页面自己的时钟：离导航开始多少毫秒）；其余造型加入轮换的消息（characters.ts 打的），
    // 还有一套造型落空的警告（加载失败跳过、WebGL2 开局以后不再加）：这些造型等不到「加入轮换」，不能干等
    await page.addInitScript(() => {
      window.__joins = [];
      window.__skips = 0;
      const log = console.log;
      console.log = (...a) => {
        const t = typeof a[0] === 'string' ? a[0] : '';
        if (t.includes('加入轮换')) window.__joins.push(Math.round(performance.now()));
        return log.apply(console, a);
      };
      const warn = console.warn;
      console.warn = (...a) => {
        const t = typeof a[0] === 'string' ? a[0] : '';
        if (t.startsWith('[characters]') && /加载失败|不再加进轮换/.test(t)) window.__skips++;
        return warn.apply(console, a);
      };
      const check = () => {
        const b = document.querySelector('.hud-begin');
        if (b && !b.disabled && window.__readyAt === undefined && window.__sawDisabled) window.__readyAt = Math.round(performance.now());
        if (b && b.disabled) window.__sawDisabled = true;
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const bps = (profile.mbps * 1e6) / 8;
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: profile.latency, downloadThroughput: bps, uploadThroughput: bps });
    const reqs = new Map();
    let navTs = null;
    cdp.on('Network.requestWillBeSent', (e) => {
      if (!/^https?:/.test(e.request.url)) return;
      if (navTs === null && e.type === 'Document') navTs = e.timestamp;
      reqs.set(e.requestId, { url: e.request.url, start: e.timestamp, end: null, bytes: 0 });
    });
    cdp.on('Network.loadingFinished', (e) => {
      const r = reqs.get(e.requestId);
      if (r) Object.assign(r, { end: e.timestamp, bytes: e.encodedDataLength });
    });
    cdp.on('Network.loadingFailed', (e) => {
      const r = reqs.get(e.requestId);
      if (r) Object.assign(r, { end: e.timestamp, failed: e.errorText });
    });
    await page.goto(target.url + (QUERY ? (target.url.includes('?') ? '&' : '?') + QUERY : ''), { waitUntil: 'commit' });
    await page.waitForFunction(() => window.__readyAt !== undefined, null, { timeout: TIMEOUT.ready, polling: 100 });
    const readyAt = await page.evaluate(() => window.__readyAt);
    // 按钮可用以后：等网络空下来，而且按钮可用之后才下载完的访客造型，每一套都有了着落（加入轮换，或者打了落空的警告）。
    // 网络层就失败、被 abort 的请求不算（它们不会走到加入轮换那一步）
    const t0 = Date.now();
    for (;;) {
      const late = [...reqs.values()].filter((r) => isVisitorGlb(r.url) && r.end !== null && !r.failed && (r.end - navTs) * 1000 > readyAt).length;
      const pending = [...reqs.values()].filter((r) => r.end === null).length;
      const settled = await page.evaluate(() => window.__joins.length + window.__skips);
      if (!pending && settled >= late) break;
      if (Date.now() - t0 > TIMEOUT.rest) {
        errors.push(`等其余造型超时（还有 ${pending} 个请求没完，有着落的 ${settled}/${late}）`);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const joins = await page.evaluate(() => window.__joins);
    const all = [...reqs.values()].filter((r) => r.end !== null && !r.failed);
    const firstVisitor = [...reqs.values()].filter((r) => isVisitorGlb(r.url)).sort((a, b) => a.start - b.start)[0]?.url;
    const bytes = { 开场前: {}, 开场后: {} };
    for (const r of all) {
      const when = (r.end - navTs) * 1000 <= readyAt ? '开场前' : '开场后';
      const k = kindOf(r.url, firstVisitor);
      bytes[when][k] = (bytes[when][k] ?? 0) + r.bytes;
    }
    return { label: target.label, profile: profile.name, readyAt, allJoinedAt: joins.length ? joins[joins.length - 1] : null, joins, bytes, errors };
  } finally {
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 5000))]);
  }
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const fmtBytes = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${MB(v)}`).join('，');
const results = [];
for (const profile of profiles) {
  for (let run = 1; run <= RUNS; run++) {
    for (const target of urls) {
      // 某一次超时、浏览器崩了也接着量下一次，这一次记成失败（不让整批结果和 JSON 都丢了）
      const r = await measure(target, profile).catch((err) => ({ label: target.label, profile: profile.name, readyAt: null, allJoinedAt: null, joins: [], bytes: { 开场前: {}, 开场后: {} }, errors: [String(err?.message ?? err).split('\n')[0]] }));
      results.push({ ...r, run });
      if (r.readyAt === null) {
        console.log(`${profile.name} 第 ${run} 次 [${r.label}] 失败：${r.errors.join(' | ')}`);
        continue;
      }
      const joined = r.allJoinedAt === null ? '' : `，其余造型全部加入轮换 ${r.allJoinedAt} ms`;
      console.log(`${profile.name} 第 ${run} 次 [${r.label}] 开场按钮可用 ${r.readyAt} ms${joined}`);
      console.log(`    开场前 ${MB(sum(r.bytes.开场前))} MB（${fmtBytes(r.bytes.开场前)}）；开场后 ${MB(sum(r.bytes.开场后))} MB${sum(r.bytes.开场后) ? `（${fmtBytes(r.bytes.开场后)}）` : ''}${r.errors.length ? `\n    错误：${r.errors.join(' | ')}` : ''}`);
    }
  }
}

// 汇总：每档每个地址的中位数（最小–最大）
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.log('\n| 网速 | 版本 | 开场按钮可用（中位数，最小–最大，毫秒） | 其余造型全部加入轮换（中位数） | 开场前下载 | 开场后下载 |');
console.log('|---|---|---|---|---|---|');
for (const profile of profiles) {
  for (const target of urls) {
    const all = results.filter((r) => r.profile === profile.name && r.label === target.label);
    const rs = all.filter((r) => r.readyAt !== null);
    const failed = all.length - rs.length ? `，失败 ${all.length - rs.length} 次` : '';
    if (!rs.length) {
      console.log(`| ${profile.name} / ${profile.latency} ms | ${target.label} | —（${all.length} 次都失败） | — | — | — |`);
      continue;
    }
    const ready = rs.map((r) => r.readyAt);
    const joined = rs.map((r) => r.allJoinedAt).filter((x) => x !== null);
    console.log(`| ${profile.name} / ${profile.latency} ms | ${target.label} | ${Math.round(median(ready))}（${Math.min(...ready)}–${Math.max(...ready)}${failed}） | ${joined.length ? Math.round(median(joined)) : '—'} | ${MB(median(rs.map((r) => sum(r.bytes.开场前))))} MB | ${MB(median(rs.map((r) => sum(r.bytes.开场后))))} MB |`);
  }
}
mkdirSync('.logs', { recursive: true });
writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
console.log(`\n明细：${JSON_OUT}`);
