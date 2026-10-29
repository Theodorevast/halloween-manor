// 访客造型边玩边加载的卡顿探针：开场按钮可用后在标题页停 --wait 秒再点开始（0 = 一能点就点），之后正常玩 --play 秒，记下
//   · 每个超过 50 ms 的帧（rAF 间隔）和主线程长任务，从页面一打开就记
//   · 开始以后同步新建的 WebGPU 渲染管线（第一次画到时现编，会卡；异步的是 compileAsync，不卡）
//   · 其余几套造型加入轮换的时刻（characters.ts 打的「加入轮换」）、每个访客进门（第一次出现在模拟里）的时刻
//   · characters.ts 打的警告（预编译对不上、材质没有底色贴图、WebGL2 开局以后不再加新造型等）
//
// ！！升级 three 以后一定要重跑！！characters.ts 的 compileOutfit 靠 three r186 的内部接口（RenderContexts.get 的 callDepth、
// Renderer._getShadowNodes）和 renderObject 给阴影材质赋值的顺序，换了版本可能悄悄对不上：不报错，只是开局以后加进来的造型，
// 第一个穿它的访客进门时同步现编管线、卡一下。最后一行是结论：
//   通过 = 加入轮换前后、访客进门前后 1 秒内都没有超过 50 ms 的帧；加入轮换前后 1 秒内没有同步新建的管线；
//          页面没有打出「预编译可能对不上」「没有底色贴图」「预编译失败」这几条警告。不通过时退出码是 1。
//   别的时刻零星的长帧（这台机器同时开着很多浏览器时常有）照样列出来，不算不通过。零星的长帧偶尔也会正好撞上访客进门：
//   「要看」时先多跑一两次；还拿不准，就用改动之前的构建（git worktree / git stash 出来另起一个预览）照同样的参数跑一遍比一比
//
// 先构建、起预览（脚本不自己起服务器）：
//   ./node_modules/.bin/vite build
//   ./node_modules/.bin/vite preview --port 4173 --strictPort --host 127.0.0.1      （npm run preview 也是 4173）
//   node scripts/stall-outfits.mjs                       4 Mbps、一能点就点开始：其余几套在开局以后才加进轮换，最要紧的一种
//   node scripts/stall-outfits.mjs --wait 12 --net 0     不限速、标题页停 12 秒：其余几套在标题页上就加完了
//   node scripts/stall-outfits.mjs --webgl               WebGL2 后端（地址加 ?webgl）：开局以后不再加新造型，剩下的不下载
//   --no-parallel-compile   （WebGL2）假装浏览器没有 KHR_parallel_shader_compile：着色器链接变成同步的，看编到一半开局会不会卡
//   --net 50 / 10 / 4 / 0   限速档（同 scripts/loadtime.mjs：50 Mbps / 20 ms、10 Mbps / 40 ms、4 Mbps / 80 ms；0 = 不限速），默认 4
//   --port 4173  --play 30  --query nobgcompile（地址后面再加的参数，不带 ?）
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const PORT = opt('--port', '4173');
const WAIT = Number(opt('--wait', '0'));
const PLAY = Number(opt('--play', '30'));
const NET = opt('--net', '4');
const WEBGL = argv.includes('--webgl');
const NO_PARALLEL = argv.includes('--no-parallel-compile');
const QUERY = [WEBGL ? 'webgl' : '', opt('--query', '')].filter(Boolean).map((q) => `&${q}`).join('');
const NETS = { 50: [50, 20], 10: [10, 40], 4: [4, 80] };
/** 加入轮换、访客进门前后多少毫秒内的长帧算到它们头上 */
const NEAR = 1000;
/** 这几条警告说明预编译对不上，进门会卡 */
const BAD_WARN = /预编译可能对不上|没有底色贴图|预编译失败/;

const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
const warns = [];
const boot = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') errs.push(t.slice(0, 200));
  if (m.type() === 'warning' && t.startsWith('[characters]')) warns.push(t.slice(0, 200));
  if (t.startsWith('[boot]')) boot.push(t.replace('[boot] ', ''));
});
if (NETS[NET]) {
  const [mbps, latency] = NETS[NET];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: (mbps * 1e6) / 8, uploadThroughput: (mbps * 1e6) / 8 });
}
await page.addInitScript((noParallel) => {
  if (noParallel) {
    // three 的 WebGLBackend 用 getExtension 拿这个扩展（拿不到时 compileAsync 里也是当场链接着色器）
    const P = WebGL2RenderingContext.prototype;
    const getExt = P.getExtension;
    P.getExtension = function (name) { return name === 'KHR_parallel_shader_compile' ? null : getExt.call(this, name); };
    const getSup = P.getSupportedExtensions;
    P.getSupportedExtensions = function () { return (getSup.call(this) ?? []).filter((n) => n !== 'KHR_parallel_shader_compile'); };
  }
  const pipes = (window.__pipes = []);
  const wrap = (name, sync) => {
    const orig = GPUDevice.prototype[name];
    GPUDevice.prototype[name] = function (d) {
      const fmts = (d.fragment?.targets ?? []).map((t) => t?.format).join('+');
      pipes.push({ t: Math.round(performance.now()), sync, label: d.label ?? '', fmt: `${fmts}|${d.depthStencil?.format ?? '-'}|x${d.multisample?.count ?? 1}` });
      return orig.call(this, d);
    };
  };
  if (window.GPUDevice) {
    wrap('createRenderPipeline', true);
    wrap('createRenderPipelineAsync', false);
  }
  const long = (window.__long = []);
  let last = performance.now();
  const f = (t) => {
    if (t - last > 50) long.push([Math.round(last), Math.round(t - last)]);
    last = t;
    requestAnimationFrame(f);
  };
  requestAnimationFrame(f);
  const lt = (window.__lt = []);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true });
  } catch {}
  window.__joins = [];
  const log = console.log;
  console.log = (...a) => {
    if (typeof a[0] === 'string' && a[0].includes('加入轮换')) window.__joins.push([Math.round(performance.now()), a[0].replace(/^\[characters\] /, '').split('，')[0]]);
    return log.apply(console, a);
  };
}, NO_PARALLEL);

await page.goto(`http://127.0.0.1:${PORT}/?debug${QUERY}`, { waitUntil: 'commit' });
await page.waitForFunction(() => window.__haunt && !document.querySelector('.hud-begin')?.disabled, null, { timeout: 180000, polling: 50 });
const readyAt = await page.evaluate(() => Math.round(performance.now()));
if (WAIT > 0) await page.waitForTimeout(WAIT * 1000);
const startAt = await page.evaluate(() => {
  document.querySelector('[data-start]').click();
  return Math.round(performance.now());
});
// 点了开始：后台预编译没编完时遮罩先留着（main.ts 的 begin），记下遮罩真正收起的时刻；访客第一次出现在模拟里的时刻（每 100 ms 看一次）
const leftAt = await page.waitForFunction(() => document.querySelector('[data-start]').classList.contains('is-leaving') && Math.round(performance.now()), null, { timeout: 90000, polling: 16 }).then((h) => h.jsonValue());
await page.evaluate(() => {
  const seen = (window.__entered = []);
  const ids = new Set();
  setInterval(() => {
    for (const n of window.__haunt.raw().npcs) {
      if (ids.has(n.id)) continue;
      ids.add(n.id);
      seen.push([Math.round(performance.now()), `${n.id}:${n.name}`]);
    }
  }, 100);
});
await page.waitForTimeout(PLAY * 1000);
const r = await page.evaluate(() => ({ pipes: window.__pipes, long: window.__long, lt: window.__lt, joins: window.__joins, entered: window.__entered }));
await browser.close();

const rel = (t) => t - leftAt;
const near = (t, marks) => marks.some((m) => Math.abs(t - m) <= NEAR);
const joinT = r.joins.map(([t]) => t);
const enterT = r.entered.map(([t]) => t);
const playLong = r.long.filter(([t]) => t >= leftAt);
const longNearJoin = playLong.filter(([t, d]) => near(t, joinT) || near(t + d, joinT));
const longNearEnter = playLong.filter(([t, d]) => near(t, enterT) || near(t + d, enterT));
const syncPlay = r.pipes.filter((p) => p.sync && p.t >= leftAt);
// 访客进门后 1 秒内同步建的是手电的阴影管线（第一次照到这个人），和加入轮换碰巧挨着时不算到加入轮换头上
const syncNearJoin = syncPlay.filter((p) => near(p.t, joinT) && !enterT.some((m) => p.t >= m && p.t - m <= NEAR));
const badWarns = warns.filter((w) => BAD_WARN.test(w));

console.log(`${WEBGL ? 'WebGL2' : 'WebGPU'}${NO_PARALLEL ? '（没有并行编译扩展）' : ''}，网速 ${NETS[NET] ? `${NET} Mbps / ${NETS[NET][1]} ms` : '不限'}；开场按钮可用 ${readyAt} ms，标题页停 ${WAIT} 秒，点开始 ${startAt} ms，遮罩收起 ${leftAt} ms（下面的时刻都从遮罩收起算）`);
console.log('启动：', boot.join('；'));
console.log('其余造型加入轮换 [离开始的毫秒, 造型]：', JSON.stringify(r.joins.map(([t, u]) => [rel(t), u])));
console.log('访客进门 [离开始的毫秒, 编号:名字]：', JSON.stringify(r.entered.map(([t, n]) => [rel(t), n])));
if (warns.length) console.log(`characters.ts 的警告：\n  ${warns.join('\n  ')}`);
if (r.pipes.length || !WEBGL) {
  console.log(`开始以后同步新建的管线 ${syncPlay.length} 条（访客进门时手电的阴影管线是正常的）：`);
  for (const p of syncPlay) console.log(`  +${rel(p.t)} ms ${p.label} ${p.fmt}`);
  console.log(`开始以后异步编的管线 ${r.pipes.filter((p) => !p.sync && p.t >= leftAt).length} 条`);
}
console.log(`开始以后 ${PLAY} 秒里的长帧 [离开始的毫秒, 时长]：`, JSON.stringify(playLong.map(([t, d]) => [rel(t), d])));
console.log('开始以后主线程的长任务 [离开始的毫秒, 时长]：', JSON.stringify(r.lt.filter(([t]) => t >= leftAt).map(([t, d]) => [rel(t), d])));
console.log(errs.length ? `页面报错：${errs.join(' | ')}` : '没有页面报错');
const problems = [
  longNearJoin.length ? `加入轮换前后 ${NEAR} ms 内有 ${longNearJoin.length} 个长帧` : '',
  longNearEnter.length ? `访客进门前后 ${NEAR} ms 内有 ${longNearEnter.length} 个长帧` : '',
  syncNearJoin.length ? `加入轮换前后 ${NEAR} ms 内同步新建了 ${syncNearJoin.length} 条管线` : '',
  badWarns.length ? `${badWarns.length} 条「预编译对不上」类的警告` : '',
  errs.length ? `${errs.length} 条页面报错` : '',
].filter(Boolean);
console.log(problems.length ? `结论：要看——${problems.join('；')}` : '结论：通过');
process.exit(problems.length ? 1 : 0);
