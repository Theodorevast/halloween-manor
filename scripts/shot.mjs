// 视觉自查：用本机 Chrome 打开页面截图，并收集页面里的 JS 报错
//   node scripts/shot.mjs <url> <out.png> [--wait 1500] [--eval "js 表达式"] [--key 3] [--sleep 450] [--eval-wait 800] [--width 1280] [--height 800]
// 例：node scripts/shot.mjs http://127.0.0.1:5180/dev/props.html shots/props.png --wait 2000 --key 5
// --eval / --key / --sleep 都可以给多次，按出现顺序执行；--eval 和 --key 之后各等 --eval-wait 毫秒（全局一个值）
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from 'playwright-core';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('用法：node scripts/shot.mjs <url> <out.png> [--wait ms] [--eval js] [--key k]');
  process.exit(2);
}
const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
const all = (k) => rest.flatMap((v, i) => (v === k ? [rest[i + 1]] : []));

// 打开 WebGPU（无头 Chrome 默认关闭）；拿不到 GPU 时 three.js 会自动退回 WebGL2
const browser = await chromium.launch({ executablePath: CHROME, args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: Number(opt('--width') ?? 1280), height: Number(opt('--height') ?? 800) } });
const errors = [];
const logs = [];
page.on('pageerror', (e) => errors.push(e.message));
// 「Failed to load resource」由下面的 response 监听带上网址记录；favicon 404 不算错
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
  else if (m.type() !== 'error') logs.push(`[${m.type()}] ${m.text()}`);
});
page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/favicon.ico')) errors.push(`${r.status()} ${r.url()}`); });

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(Number(opt('--wait') ?? 1500));
// 按参数顺序执行：--key 按键、--eval 执行 JS、--sleep 等待指定毫秒。
// --key / --eval 之后默认再等 --eval-wait（默认 800）毫秒；给了 --sleep 时用 --eval-wait 0 精确控制节奏
const stepWait = Number(opt('--eval-wait') ?? 800);
for (let i = 0; i < rest.length; i++) {
  const [flag, val] = [rest[i], rest[i + 1]];
  if (flag === '--sleep') {
    await page.waitForTimeout(Number(val));
  } else if (flag === '--key') {
    await page.keyboard.press(val);
    await page.waitForTimeout(stepWait);
  } else if (flag === '--eval') {
    try {
      const r = await page.evaluate(val);
      if (r !== undefined) console.log('eval →', typeof r === 'string' ? r : JSON.stringify(r));
    } catch (e) {
      errors.push(`--eval 失败：${val}\n  ${e.message.split('\n')[0]}`);
    }
    await page.waitForTimeout(stepWait);
  } else continue;
  i++;
}
mkdirSync(dirname(out), { recursive: true });
await page.screenshot({ path: out });
await browser.close();

if (logs.length) console.log(logs.slice(-15).join('\n'));
if (errors.length) {
  console.log(`页面报错 ${errors.length} 条：\n` + errors.join('\n'));
  process.exitCode = 1;
} else console.log(`截图已保存：${out}（无报错）`);
