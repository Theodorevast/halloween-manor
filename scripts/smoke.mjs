// 冒烟测试：构建 → vite preview → 用本机 Chrome 打开 ?debug → 点开场 → 逐项断言，截图放 shots/
//   node scripts/smoke.mjs            先构建再测
//   node scripts/smoke.mjs --no-build 直接测现有的 dist/
//   node scripts/smoke.mjs --webgl    强制走 WebGL2 回退路径（地址加 ?webgl）
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5738;
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VITE = 'node_modules/vite/bin/vite.js';
const WEBGL = process.argv.includes('--webgl');
mkdirSync('shots', { recursive: true });

if (!process.argv.includes('--no-build')) {
  const b = spawnSync(process.execPath, [VITE, 'build'], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

// 直接用 node 跑 vite.js（不经过 .bin 里的 sh 脚本），这样 kill() 能结束它
const server = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
const stop = () => server.kill();
process.on('exit', stop);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(BASE)).ok) break;
  } catch {}
  if (i > 50) throw new Error(`preview 没在 ${PORT} 端口起来`);
  await sleep(200);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'],
});

/** 截图里亮于 luminance 阈值的像素比例（在页面里用 2D canvas 解码 PNG） */
async function litRatio(page, png) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 30) lit++;
    return lit / (d.length / 4);
  }, png.toString('base64'));
}

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  // 正式首页带 favicon，任何 404 都算错（dev 沙盒页没有 favicon，那是 shot.mjs 的事）
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });

  await page.goto(`${BASE}?debug${WEBGL ? '&webgl' : ''}`, { waitUntil: 'networkidle' });
  await page.locator('[data-start]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'shots/smoke-0-start.png' });
  await page.waitForFunction(() => Boolean(window.__haunt), null, { timeout: 15000 });
  await page.locator('[data-start]').click();
  await sleep(3500);
  check('开场遮罩点击后消失', !(await page.locator('[data-start]').isVisible().catch(() => false)));
  const backend = await page.evaluate(() => window.__haunt.backend);
  check('渲染后端', !WEBGL || backend === 'WebGL2', backend);

  // 10 秒内（快进）至少 1 个访客
  await page.evaluate(() => window.__haunt.step(8000));
  const npcCount = await page.evaluate(() => window.__haunt.raw().npcs.length);
  check('10 秒内有访客进门', npcCount >= 1, `${npcCount} 人`);

  // 书房里放一个人，站在肖像正前方 2 米、面朝北看着它（肖像在北墙边 (3.75, 0.75)，朝南），附身肖像，恐惧值应上升
  const fear = await page.evaluate(() => {
    const h = window.__haunt;
    const n = h.spawn({ pos: { x: 3.75, z: 2.75 }, lookDir: -Math.PI / 2, personality: 'average', name: 'Smoke' });
    const ok = h.trigger('portrait');
    h.step(1200); // 肖像 0.94 秒才砸下来（SCARES.portrait.hitAt），之前不会有人受惊
    const after = h.raw().npcs.find((x) => x.id === n.id);
    return { ok, fear: after?.fear ?? -1 };
  });
  check('附身肖像能吓到看着它的人', fear.ok && fear.fear > 0, `trigger=${fear.ok} fear=${fear.fear}`);
  await sleep(600);
  const shot = await page.screenshot({ path: `shots/smoke-1-play${WEBGL ? '-webgl' : ''}.png` });
  const lit = await litRatio(page, shot);
  check('画面不是一片黑', lit > 0.01, `亮像素 ${(lit * 100).toFixed(1)}%`);

  await page.evaluate(() => window.__haunt.rotate(1));
  await sleep(800);
  await page.screenshot({ path: 'shots/smoke-2-rotated.png' });
  console.log(await page.evaluate(() => window.__haunt.state()));
  check('没有页面报错', errors.length === 0, errors.slice(0, 5).join(' | '));

  // 手机竖屏（触屏）：不出横向滚动条；轻点开场能开始，轻点物件能附身
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.goto(`${BASE}?debug${WEBGL ? '&webgl' : ''}`, { waitUntil: 'networkidle' });
  await phone.waitForFunction(() => Boolean(window.__haunt), null, { timeout: 15000 });
  const sw = await phone.evaluate(() => document.documentElement.scrollWidth);
  check('390 px 宽没有横向滚动', sw <= 390, `scrollWidth=${sw}`);
  await phone.locator('[data-start]').tap();
  await sleep(3500); // 等开场镜头落定，物件的屏幕位置才稳定
  const pt = await phone.evaluate(() => window.__haunt.screenOf('lamp-living'));
  await phone.touchscreen.tap(pt.x, pt.y);
  await sleep(300);
  const cd = await phone.evaluate(() => window.__haunt.raw().objects.find((o) => o.id === 'lamp-living').cooldown);
  check('触屏轻点物件能附身', cd > 0, `点 (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)})，冷却 ${cd.toFixed(1)} 秒`);
  await phone.screenshot({ path: 'shots/smoke-3-phone.png' });
} catch (e) {
  check('冒烟流程跑完', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
  stop();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
