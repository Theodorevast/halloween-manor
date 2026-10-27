// 性能测量：打开构建好的游戏，开场后放满访客，量帧时间，并看自动降档有没有生效。
//   node scripts/perf.mjs              本机显卡（WebGPU）
//   node scripts/perf.mjs --cpu        SwiftShader 纯 CPU 软件渲染（WebGL2），模拟「没有像样显卡」的最坏情况
//   node scripts/perf.mjs --low        开场后手动切到 Low 档再测
//   node scripts/perf.mjs --empty      对照组：没有访客，手电全部闲置
//   --seconds 8                        每段测多久（默认 6 秒）
// 先 npm run build；脚本自己起 vite preview（端口 5738）
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const PORT = 5738;
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argv = process.argv.slice(2);
const CPU = argv.includes('--cpu');
const LOW = argv.includes('--low');
// 没给 --seconds 时 indexOf 是 -1，argv[0] 会被当成秒数（比如 '--cpu' → NaN），所以要先判断
const SECONDS = argv.includes('--seconds') ? Number(argv[argv.indexOf('--seconds') + 1]) : 6;

const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
process.on('exit', () => server.kill());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {}
  if (i > 50) throw new Error(`preview 没在 ${PORT} 端口起来（先 npm run build）`);
  await sleep(200);
}

const args = CPU
  ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  : ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11'];
const browser = await chromium.launch({ executablePath: CHROME, args: [...args, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

/** 在页面里量 ms 毫秒的帧间隔：平均、p95、最大 */
// 起点取第一次 rAF 回调的时间戳（rAF 的时间戳是帧开始时刻，可能早于 performance.now()，直接相减会出负数）；
// 帧慢到一段时间里一帧都没有时，也照实报出来，不报假数
const measure = (ms) => page.evaluate((dur) => new Promise((resolve) => {
  const d = [];
  let last = -1;
  let end = Infinity;
  const tick = (now) => {
    if (last < 0) end = now + dur;
    else d.push(now - last);
    last = now;
    if (now < end) requestAnimationFrame(tick);
    else {
      d.sort((a, b) => a - b);
      const avg = d.reduce((s, x) => s + x, 0) / Math.max(1, d.length);
      resolve({ frames: d.length, fps: +(1000 / avg).toFixed(1), avg: +avg.toFixed(1), p95: +(d[Math.floor(d.length * 0.95)] ?? 0).toFixed(1), max: +(d[d.length - 1] ?? 0).toFixed(1) });
    }
  };
  requestAnimationFrame(tick);
}), ms);
const quality = () => page.evaluate(() => document.querySelector('[aria-label^="Quality"]')?.getAttribute('aria-label') ?? '?');

try {
  await page.goto(`${BASE}?debug`, { waitUntil: 'networkidle' });
  await page.locator('[data-start]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => Boolean(window.__haunt) && !document.querySelector('.hud-begin')?.disabled, null, { timeout: 30000 }); // 等加载完、开场按钮可用
  await page.locator('[data-start]').click();
  if (LOW) await page.locator('[aria-label^="Quality"]').click();
  if (argv.includes('--empty')) {
    // 对照组：冻结模拟、不放访客，手电全部闲置（不画阴影图）
    await page.evaluate(() => window.__haunt.setTimeScale(0));
  } else {
    // 放满 4 个访客，每人一支投影手电：这是最重的情况
    await page.evaluate(() => {
      const h = window.__haunt;
      h.step(16000);
      for (const p of [{ x: 3, z: 3 }, { x: 8, z: 6 }, { x: 13, z: 3 }]) if (h.raw().npcs.length < 4) h.spawn({ pos: p });
    });
  }
  console.log(`后端 ${await page.evaluate(() => window.__haunt.backend)}，访客 ${await page.evaluate(() => window.__haunt.raw().npcs.length)} 人`);
  console.log(`第 1 段（开场后，自动降档的测量窗口内）：`, await measure(SECONDS * 1000), await quality());
  await sleep(500);
  console.log(`第 2 段（降档判断之后）：`, await measure(SECONDS * 1000), await quality());
  if (errors.length) console.log('页面报错：\n' + errors.slice(0, 5).join('\n'));
} finally {
  await browser.close();
  server.kill();
}
