// 冒烟测试：构建 → vite preview → 用本机 Chrome 打开 ?debug → 点开场 → 逐项断言，截图放 shots/
//   node scripts/smoke.mjs            先构建再测
//   node scripts/smoke.mjs --no-build 直接测现有的 dist/
//   node scripts/smoke.mjs --webgl    强制走 WebGL2 回退路径（地址加 ?webgl）
// 四段：娃娃屋俯视（?dollhouse，原有的各项检查）· 第三人称鬼魂（有鼠标的桌面默认走这条）·
// 一夜（2026-10-30：前门、天亮、收夜、登记簿、Keep haunting）· 手机竖屏（触屏自动走俯视，也收一次夜）
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PORT = 5738;
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const VITE = 'node_modules/vite/bin/vite.js';
const WEBGL = process.argv.includes('--webgl');
const QS = WEBGL ? '&webgl' : '';
mkdirSync('shots', { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const up = async () => {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
};

// 这台机器上几个会话共用 5738：别人的冒烟测试还占着端口时先等它结束，不然会连到别人的预览服务器上去测
for (let i = 0; await up(); i++) {
  if (i === 0) console.log(`${PORT} 端口被占着（可能是别的会话在跑冒烟测试），等它结束…`);
  if (i >= 120) {
    console.error(`${PORT} 端口一直被占着，稍后再试`);
    process.exit(2);
  }
  await sleep(1000);
}

if (!process.argv.includes('--no-build')) {
  const b = spawnSync(process.execPath, [VITE, 'build'], { stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

// 直接用 node 跑 vite.js（不经过 .bin 里的 sh 脚本），这样 kill() 能结束它
const server = spawn(process.execPath, [VITE, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore' });
let serverExited = false;
server.on('exit', () => { serverExited = true; });
const stop = () => server.kill();
process.on('exit', stop);

for (let i = 0; ; i++) {
  if (await up()) break;
  if (i > 50) throw new Error(`preview 没在 ${PORT} 端口起来`);
  await sleep(200);
}
// 端口在构建期间被别人抢走时，我们的预览起不来（--strictPort），上面连上的是别人的
await sleep(300);
if (serverExited) {
  console.error(`自己的预览没起来（${PORT} 端口被占？），稍后再试`);
  process.exit(2);
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

/** 收集页面报错：JS 异常、console.error、任何 4xx / 5xx 响应（正式首页带 favicon，404 也算错） */
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}

/** 等加载完、开场按钮可用，和真实玩家一样 */
const waitReady = (page) =>
  page.waitForFunction(() => Boolean(window.__haunt) && !document.querySelector('.hud-begin')?.disabled, null, { timeout: 30000 });
// 点了开始之后：后台预编译还没编完时开场遮罩会先留着（main.ts 的 begin），等它开始淡出，再等开场镜头走完
const waitStarted = async (page) => {
  const t0 = Date.now();
  await page.waitForFunction(() => { const s = document.querySelector('[data-start]'); return !s || s.hidden || s.classList.contains('is-leaving'); }, null, { timeout: 30000 });
  const held = Date.now() - t0;
  await sleep(3500);
  return held;
};
/** 一夜（2026-10-30）：等到 __haunt.night() 满足 pred（真实时间，最多 ms 毫秒），返回最后一次读到的状态 */
const waitNight = async (page, pred, ms) => {
  const t0 = Date.now();
  let n = null;
  while (Date.now() - t0 < ms) {
    n = await page.evaluate(() => window.__haunt.night());
    if (n && pred(n)) return n;
    await sleep(100);
  }
  return n;
};
/** 左下播报里现在有的几行 */
const tickerLines = (page) => page.evaluate(() => [...document.querySelectorAll('.hud-ticker li')].map((l) => l.textContent));
/** 收夜那一页上的按钮（文案和 STRINGS.register 一致）：点真的按钮；没有就记一笔失败，再走调试口，后面几项照样能测 */
const clickRegister = async (page, name, what) => {
  const b = page.getByRole('button', { name });
  const ok = await b.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
  check(`一夜：登记簿上有「${name}」按钮（${what}）`, ok);
  if (ok) await b.click();
  else if (name === 'Keep haunting') await page.evaluate(() => window.__haunt.keepHaunting());
  return ok;
};

try {
  // ── 娃娃屋俯视（?dollhouse）：原有的各项检查 ─────────────────────────
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = watchErrors(page);

  await page.goto(`${BASE}?debug&dollhouse${QS}`, { waitUntil: 'networkidle' });
  await page.locator('[data-start]').waitFor({ timeout: 15000 });
  await page.screenshot({ path: 'shots/smoke-0-start.png' });
  await waitReady(page);
  check('?dollhouse 走娃娃屋俯视', await page.evaluate(() => window.__haunt.ghost === null));
  await page.locator('[data-start]').click();
  const heldDoll = await waitStarted(page);
  check('开场遮罩点击后消失（后台预编译编完才收起，最多等 15 秒）', heldDoll < 15000, `等了 ${heldDoll} ms`);
  check('开场遮罩点击后消失', !(await page.locator('[data-start]').isVisible().catch(() => false)));
  check('俯视有旋转按钮', await page.locator('[data-act="left"]').isVisible());
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

  // 4 个镜头方位下逐个点每个物件的屏幕位置：附身的必须是它自己（点击盒互相遮挡时会附身到旁边的物件）。
  // 冻结模拟：附身是同步生效的（冷却马上开始），惊吓要等模拟往前走才落下
  await page.evaluate(() => window.__haunt.setTimeScale(0));
  const misses = [];
  for (let q = 0; q < 4; q++) {
    if (q > 0) {
      await page.evaluate(() => window.__haunt.rotate(1));
      await sleep(800);
    }
    if (q === 1) await page.screenshot({ path: 'shots/smoke-2-rotated.png' });
    const ids = await page.evaluate(() => window.__haunt.raw().objects.map((o) => o.id));
    for (const id of ids) {
      await page.evaluate(() => window.__haunt.step(25000)); // 等所有冷却走完
      const pt = await page.evaluate((x) => window.__haunt.screenOf(x), id);
      await page.mouse.move(pt.x, pt.y);
      await page.mouse.down();
      await page.mouse.up();
      await sleep(50);
      const fired = await page.evaluate(() => window.__haunt.raw().objects.filter((o) => o.cooldown > 0).map((o) => o.id));
      if (fired.length !== 1 || fired[0] !== id) misses.push(`q${q} ${id} → ${fired.join('+') || '没反应'}`);
    }
  }
  check('4 个方位下点每个物件都附身到它自己', misses.length === 0, misses.join('；'));
  await page.evaluate(() => window.__haunt.setTimeScale(1));
  console.log(await page.evaluate(() => window.__haunt.state()));
  check('没有页面报错', errors.length === 0, errors.slice(0, 5).join(' | '));
  await page.close();

  // ── 第三人称鬼魂：有鼠标的桌面默认走这条 ───────────────────────────
  // 无头 Chrome 里指针锁定一般锁得上，但不保证：先按真实情况检查界面，之后用 ghost.fakeLock(true) 走同一条路，不依赖它
  const gp = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const gErrors = watchErrors(gp);
  await gp.goto(`${BASE}?debug${QS}`, { waitUntil: 'networkidle' });
  await waitReady(gp);
  check('桌面默认走第三人称', await gp.evaluate(() => window.__haunt.ghost !== null));
  // 鼠标放在画面正中，之后的点击都原地按下：锁定指针后移动鼠标就是转镜头
  await gp.mouse.move(640, 400);
  await gp.locator('[data-start]').click();
  const heldGhost = await waitStarted(gp);
  check('第三人称：开场遮罩等后台预编译编完就收起（最多等 15 秒）', heldGhost < 15000, `等了 ${heldGhost} ms`);
  check('第三人称：开场遮罩点击后消失', !(await gp.locator('[data-start]').isVisible().catch(() => false)));
  check('第三人称：旋转按钮藏起来', !(await gp.locator('[data-act="left"]').isVisible()));
  // 操作说明开场 4.5 秒才淡入（hud.ts 的 KEYS.delay，2026-10-30 上手那一路），等它出来再读（最多 10 秒）
  await gp.waitForFunction(() => document.querySelector('.hud-keys')?.classList.contains('is-on'), null, { timeout: 10000 }).catch(() => {});
  const hint = await gp.evaluate(() => ({ on: document.querySelector('.hud-keys').classList.contains('is-on'), text: document.querySelector('.hud-keys').textContent }));
  check('第三人称：开场后有操作提示', hint.on && hint.text.includes('WASD'), hint.text);
  // 墙上多一个影子（2026-10-30）的接线：带了 model（和鬼魂共用同一个几何体，不多编管线），带了 rig（只放在玩家看得见的墙上）
  const other = await gp.evaluate(() => {
    const o = window.__otherShadow, g = window.__ghostView;
    if (!o || !g) return { shared: false, hidden: 0, why: '没有调试口' };
    let shared = false;
    g.root.traverse((x) => { if (x.geometry && x.geometry === o.mesh.geometry) shared = true; });
    return { shared, hidden: Object.values(o.inView()).filter((v) => !v).length };
  });
  check('第三人称：墙上多一个影子和鬼魂共用外形、只放在看得见的墙上（model、rig 都接上了）', other.shared && other.hidden > 0, JSON.stringify(other));
  const lockUi = await gp.evaluate(() => ({
    real: document.pointerLockElement !== null,
    aim: document.querySelector('.hud-aim').classList.contains('is-on'),
    resume: document.querySelector('.hud-resume').classList.contains('is-on'),
  }));
  check('第三人称：准星 /「点一下继续」和指针锁定一致', lockUi.real ? lockUi.aim && !lockUi.resume : !lockUi.aim && lockUi.resume, JSON.stringify(lockUi));
  await gp.evaluate(() => window.__haunt.ghost.fakeLock(true));
  await sleep(100);
  check('第三人称：锁定时显示准星', await gp.evaluate(() => document.querySelector('.hud-aim').classList.contains('is-on') && !document.querySelector('.hud-resume').classList.contains('is-on')));
  const gs = () => gp.evaluate(() => window.__haunt.ghost.state());
  const g0 = await gs();
  check('第三人称：鬼魂离地约 1.4 米、镜头在天花板和地板之间', Math.abs(g0.y - 1.4) < 0.1 && g0.cam.y <= 2.25 + 1e-6 && g0.cam.y >= 0.3 - 1e-6, `鬼魂 ${g0.y.toFixed(2)} 米，镜头 ${g0.cam.y.toFixed(2)} 米`);

  // 冻结模拟（访客不走动、不触发惊吓），只测鬼魂和镜头：主循环照常每帧更新它们
  await gp.evaluate(() => window.__haunt.setTimeScale(0));

  // 鼠标左右移动转朝向（真锁定或假装锁定都一样，靠 movementX）：右移 100 像素约右转 0.22 弧度，移回来转回原处
  const yaw0 = (await gs()).yaw;
  await gp.mouse.move(740, 400, { steps: 4 });
  await sleep(250);
  const yawR = (await gs()).yaw;
  await gp.mouse.move(640, 400, { steps: 4 });
  await sleep(250);
  const yaw1 = (await gs()).yaw;
  check('第三人称：鼠标左右转向', yawR - yaw0 > 0.15 && Math.abs(yaw1 - yaw0) < 0.02, `右移后 +${(yawR - yaw0).toFixed(3)}，移回后差 ${(yaw1 - yaw0).toFixed(3)} 弧度`);

  // WASD：走廊中段朝东，按住 W 一秒往东飘，松开后平滑停下；D 往右（南）
  await gp.evaluate(() => window.__haunt.ghost.place(8, 6, 0));
  await gp.keyboard.down('KeyW');
  await sleep(1000);
  await gp.keyboard.up('KeyW');
  const w1 = await gs();
  await sleep(1500);
  const w2 = await gs();
  check('第三人称：按住 W 朝前飘', w1.x - 8 > 0.6 && Math.abs(w1.z - 6) < 0.05, `前进 ${(w1.x - 8).toFixed(2)} 米，侧移 ${(w1.z - 6).toFixed(2)} 米`);
  check('第三人称：松开后滑一小段停下', w2.speed < 0.05 && w2.x - w1.x > 0.05 && w2.x - w1.x < 1.2, `又滑了 ${(w2.x - w1.x).toFixed(2)} 米，速度 ${w2.speed.toFixed(3)}`);
  await gp.keyboard.down('KeyD');
  await sleep(600);
  await gp.keyboard.up('KeyD');
  const d1 = await gs();
  check('第三人称：D 往右边飘', d1.z - w2.z > 0.3 && Math.abs(d1.x - w2.x) < 0.05, `右移 ${(d1.z - w2.z).toFixed(2)} 米`);
  // 边界：从西墙边朝西一直飘，停在房子外 0.6 米处
  await gp.evaluate(() => window.__haunt.ghost.place(0.6, 6, Math.PI));
  await gp.keyboard.down('KeyW');
  await sleep(1300);
  await gp.keyboard.up('KeyW');
  const b1 = await gs();
  check('第三人称：飘不出房子外一圈边距', b1.x >= -0.6 - 1e-6 && b1.x < -0.5, `x = ${b1.x.toFixed(2)}`);
  // 穿墙：墙格里 inWall，走廊中间不是
  const inWall = await gp.evaluate(() => {
    const g = window.__haunt.ghost;
    g.place(6.25, 4.75);
    const a = g.state().inWall;
    g.place(6.25, 6);
    const b = g.state().inWall;
    g.place(8, 4.75); // 客厅门洞
    const c = g.state().inWall;
    return [a, b, c];
  });
  check('第三人称：在墙里时 inWall，走廊和门洞里不是', inWall[0] && !inWall[1] && !inWall[2], JSON.stringify(inWall));
  // 镜头不穿天花板、不穿地板（俯仰到头、拉到最远）
  const camYs = await gp.evaluate(() => {
    const g = window.__haunt.ghost;
    g.zoom(4);
    g.place(8, 6, 0, 0.87);
    const hi = g.state().cam.y;
    g.place(8, 6, 0, -0.52);
    const lo = g.state().cam.y;
    g.zoom(2.4);
    g.place(8, 6, 0, 0.07);
    return [hi, lo];
  });
  check('第三人称：镜头不穿天花板和地板', camYs[0] <= 2.25 + 1e-6 && camYs[1] >= 0.3 - 1e-6, camYs.map((y) => y.toFixed(2)).join(' / '));
  // 滚轮：往后滚拉远（最远 4 米），往前滚推近（最近 1 米）
  for (let i = 0; i < 6; i++) await gp.mouse.wheel(0, 300);
  await sleep(150);
  const far = (await gs()).dist;
  for (let i = 0; i < 12; i++) await gp.mouse.wheel(0, -300);
  await sleep(150);
  const near = (await gs()).dist;
  await gp.evaluate(() => window.__haunt.ghost.zoom(2.4));
  check('第三人称：滚轮调远近 1–4 米', Math.abs(far - 4) < 1e-6 && Math.abs(near - 1) < 1e-6, `${far.toFixed(2)} / ${near.toFixed(2)}`);

  // 准星对准每个物件（站在它正面 2.2 米处），点一下：附身的必须是它自己，悬停标签要出来
  const gMisses = [];
  const ids = await gp.evaluate(() => window.__haunt.raw().objects.map((o) => o.id));
  for (const id of ids) {
    await gp.evaluate(() => window.__haunt.step(25000)); // 等所有冷却走完
    await gp.evaluate((x) => window.__haunt.ghost.aimAt(x, { from: 2.2 }), id);
    await sleep(120); // 拾取器每帧更新一次悬停
    const aimed = await gp.evaluate(() => window.__haunt.ghost.aimed());
    const tip = await gp.evaluate(() => document.querySelector('.ov-tip').classList.contains('is-on'));
    await gp.mouse.down();
    await gp.mouse.up();
    await sleep(50);
    const fired = await gp.evaluate(() => window.__haunt.raw().objects.filter((o) => o.cooldown > 0).map((o) => o.id));
    if (aimed !== id || !tip || fired.length !== 1 || fired[0] !== id) gMisses.push(`${id}：准星 ${aimed}，标签 ${tip ? '有' : '无'}，附身 ${fired.join('+') || '没反应'}`);
  }
  check('第三人称：准星对准每个物件、点击附身到它自己', gMisses.length === 0, gMisses.join('；'));
  await gp.screenshot({ path: `shots/smoke-4-ghost${WEBGL ? '-webgl' : ''}.png` });
  // 床（2026-10-28）、衣柜（2026-10-29）在场：物件 7 → 9，上面那项也对准、附身过它们
  check('第三人称：床、衣柜在场（9 个物件）', ids.length === 9 && ids.includes('bed') && ids.includes('wardrobe'), ids.join(', '));

  // 现身（2026-10-29）：F 现身，蓄力 0.6 秒后落下，准星外面出现冷却环；冷却中右键不理，冷却完右键能现身
  const twoFrames = () => gp.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await gp.evaluate(() => {
    const h = window.__haunt;
    h.step(25000);
    h.ghost.place(9.3, 10.1, Math.PI / 2);
    h.events();
  });
  await twoFrames(); // 主循环把鬼魂交给模拟（setGhost）
  await gp.keyboard.press('KeyF');
  const byF = await gp.evaluate(() => {
    const h = window.__haunt;
    h.step(800);
    return h.events().filter((e) => e.type === 'manifest').map((e) => e.phase);
  });
  await twoFrames();
  const ringOn = await gp.evaluate(() => document.querySelector('.hud-cool').classList.contains('is-on'));
  check('第三人称：F 现身（蓄力、落下），准星外面出现冷却环', byF.includes('windup') && byF.includes('drop') && ringOn, `${byF.join(' → ') || '没有事件'}，冷却环 ${ringOn ? '有' : '无'}`);
  await gp.mouse.down({ button: 'right' });
  await gp.mouse.up({ button: 'right' });
  const busy = await gp.evaluate(() => {
    const h = window.__haunt;
    h.step(100);
    return h.events().filter((e) => e.type === 'manifest' && e.phase === 'windup').length;
  });
  await gp.evaluate(() => window.__haunt.step(25000)); // 停留、冷却走完
  await gp.mouse.down({ button: 'right' });
  await gp.mouse.up({ button: 'right' });
  const byRight = await gp.evaluate(() => {
    const h = window.__haunt;
    h.step(800);
    return h.events().filter((e) => e.type === 'manifest').map((e) => e.phase);
  });
  check('第三人称：冷却中右键不理，冷却完右键现身', busy === 0 && byRight.includes('windup') && byRight.includes('drop'), `冷却中 ${busy} 次蓄力，冷却完 ${byRight.join(' → ') || '没有事件'}`);
  await gp.evaluate(() => window.__haunt.step(25000));

  // 按住设机关（2026-10-28）：对准肖像按住 0.6 秒 → 设下（armed > 0、trap armed 事件），这一下不附身
  await gp.evaluate(() => {
    const h = window.__haunt;
    h.ghost.aimAt('portrait', { from: 2.2 });
    h.events();
  });
  await sleep(150); // 拾取器每帧更新一次准星对着的物件
  await gp.mouse.down();
  await sleep(700);
  await gp.mouse.up();
  await sleep(100);
  const trap = await gp.evaluate(() => {
    const h = window.__haunt;
    const o = h.raw().objects.find((x) => x.id === 'portrait');
    return { armed: Number(o.armed.toFixed(1)), cooldown: o.cooldown, ev: h.events().filter((e) => e.type === 'trap').map((e) => e.phase) };
  });
  check('第三人称：按住 0.6 秒设机关，不附身', trap.armed > 0 && trap.cooldown === 0 && trap.ev.includes('armed'), JSON.stringify(trap));
  await gp.screenshot({ path: `shots/smoke-4b-trap${WEBGL ? '-webgl' : ''}.png` });
  // 等机关到期（或被路过的人触发）、冷却走完，免得下面「点了也不附身」那几项把它算进去
  await gp.evaluate(() => {
    const h = window.__haunt;
    h.step(61000);
    h.step(40000);
  });

  // 够不着的不算：离得太远（同一个房间里约 5 米），或者隔着墙（走廊里看卧室的八音盒，中间是墙）
  const reach = await gp.evaluate(async () => {
    const h = window.__haunt;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    h.step(25000);
    h.ghost.place(5.8, 4.2, -Math.PI / 2); // 同在客厅，离落地灯约 5 米：看得见，但够不着
    h.ghost.aimAt('lamp-living');
    await frame();
    const far = h.ghost.aimed();
    h.ghost.place(2, 6.2, Math.PI / 2);
    h.ghost.aimAt('music-box');
    await frame();
    const walled = h.ghost.aimed();
    return { far, walled };
  });
  await gp.mouse.down();
  await gp.mouse.up();
  await sleep(50);
  const reachFired = await gp.evaluate(() => window.__haunt.raw().objects.filter((o) => o.cooldown > 0).map((o) => o.id));
  check('第三人称：太远、隔墙的物件够不着，点了也不附身', reach.far === null && reach.walled === null && reachFired.length === 0, `${JSON.stringify(reach)} 附身 ${reachFired.join('+') || '无'}`);

  // 名牌：前面看得见的照常，镜头背后的、隔着墙的不显示
  const plates = await gp.evaluate(async () => {
    const h = window.__haunt;
    h.ghost.place(8, 3.2, -Math.PI / 2); // 客厅，朝北；镜头在身后走廊里
    h.spawn({ pos: { x: 6.6, z: 2.4 }, lookDir: 0, name: 'Ahead' });
    h.spawn({ pos: { x: 8.3, z: 6.4 }, lookDir: 0, name: 'Behind' }); // 走廊里、镜头背后（经门洞看得见）
    h.spawn({ pos: { x: 12.5, z: 2.6 }, lookDir: 0, name: 'Walled' }); // 厨房，隔着墙
    await new Promise((r) => setTimeout(r, 400));
    const op = (name) => {
      const p = [...document.querySelectorAll('.ov-plate.is-on')].find((x) => x.querySelector('.ov-name')?.textContent === name);
      return p ? p.firstElementChild.style.opacity || '1' : 'none';
    };
    return { ahead: op('Ahead'), behind: op('Behind'), walled: op('Walled') };
  });
  check('第三人称：名牌只给看得见的人（镜头背后、隔墙的不显示）', plates.ahead === '1' && plates.behind === '0' && plates.walled === '0', JSON.stringify(plates));

  // 丢了指针锁定：提示「Click to resume」，准星收起；在画布上点一下重新锁定，这一下不附身
  const resume = await gp.evaluate(async () => {
    const h = window.__haunt;
    h.step(25000);
    h.ghost.aimAt('lamp-living', { from: 2.2 }); // 准星正对着物件：这时候点一下也只是继续
    h.ghost.fakeLock(false);
    if (document.pointerLockElement) document.exitPointerLock();
    await new Promise((r) => setTimeout(r, 300));
    return { resume: document.querySelector('.hud-resume').classList.contains('is-on'), aim: document.querySelector('.hud-aim').classList.contains('is-on') };
  });
  check('第三人称：丢了锁定提示继续、准星收起', resume.resume && !resume.aim, JSON.stringify(resume));
  await gp.mouse.down();
  await gp.mouse.up();
  await sleep(500);
  const resumed = await gp.evaluate(() => ({
    fired: window.__haunt.raw().objects.filter((o) => o.cooldown > 0).map((o) => o.id),
    real: document.pointerLockElement !== null,
    resume: document.querySelector('.hud-resume').classList.contains('is-on'),
  }));
  check('第三人称：点一下继续不附身', resumed.fired.length === 0, `附身 ${resumed.fired.join('+') || '无'}，重新锁定 ${resumed.real}`);
  if (resumed.real) check('第三人称：点一下重新锁定', !resumed.resume);

  await gp.evaluate(() => window.__haunt.setTimeScale(1));
  await gp.evaluate(() => window.__haunt.ghost.place(9.3, 10.1, Math.PI / 2));
  await sleep(600);
  const gShot = await gp.screenshot({ path: `shots/smoke-5-ghost-foyer${WEBGL ? '-webgl' : ''}.png` });
  const gLit = await litRatio(gp, gShot);
  check('第三人称：画面不是一片黑', gLit > 0.01, `亮像素 ${(gLit * 100).toFixed(1)}%`);
  check('第三人称：没有页面报错', gErrors.length === 0, gErrors.slice(0, 5).join(' | '));
  await gp.close();

  // ── 一夜（2026-10-30）：前门、天亮、收夜、登记簿、Keep haunting ─────────────────────
  // 收尾的静、光收回走真实时间（NIGHT.closing 一共 5.5 秒），模拟用 step 快进
  const np = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const nErrors = watchErrors(np);
  await np.goto(`${BASE}?debug${QS}`, { waitUntil: 'networkidle' });
  await waitReady(np);
  await np.mouse.move(640, 400);
  await np.locator('[data-start]').click();
  await waitStarted(np);
  // 前门：放一个人进门，2.5 秒内门开到一半以上（两下敲门之后推开，人进来以后才慢慢合上）
  await np.evaluate(() => window.__haunt.spawn());
  let doorMax = 0;
  for (let t0 = Date.now(); Date.now() - t0 < 2500; await sleep(100)) doorMax = Math.max(doorMax, (await np.evaluate(() => window.__haunt.night().door)));
  check('一夜：有人进门时前门推开', doorMax > 0.5, `最大开度 ${doorMax.toFixed(2)}`);
  // 天亮：屋里没被吓走的人自己出门（模拟快进），走光、门关上以后静一会儿、光收回前门、翻开登记簿
  await np.evaluate(() => window.__haunt.dawn());
  const dawnSaid = (await tickerLines(np)).some((l) => l === 'The sky is growing pale.');
  let left = -1;
  for (let i = 0; i < 24 && left !== 0; i++) left = await np.evaluate(() => { window.__haunt.step(5000); return window.__haunt.raw().npcs.length; });
  const afterDawn = await waitNight(np, (n) => n.phase === 'register' && n.register, 12000);
  check('一夜：天亮后屋里的人都走掉、登记簿翻开', dawnSaid && left === 0 && afterDawn?.phase === 'register' && afterDawn.register,
    `播报 ${dawnSaid ? '有' : '无'}，屋里还剩 ${left} 人，${JSON.stringify(afterDawn)}`);
  await np.screenshot({ path: `shots/smoke-6-register-dawn${WEBGL ? '-webgl' : ''}.png` });
  // 第三人称：翻开时把鼠标还给玩家（无头浏览器锁不上指针时这项不算数）
  check('一夜：登记簿翻开时指针锁定放开', await np.evaluate(() => document.pointerLockElement === null));
  // Keep haunting：合上登记簿、这一夜重新计时、照常补人（几秒后有人敲门）
  await clickRegister(np, 'Keep haunting', '收夜那一页');
  const kept = await waitNight(np, (n) => n.phase === 'night' && !n.register, 3000);
  const reopened = await np.evaluate(() => {
    const h = window.__haunt;
    h.events();
    h.step(20000);
    return h.events().filter((e) => e.type === 'spawn').length;
  });
  check('一夜：Keep haunting 以后登记簿合上、又有人进门', kept?.phase === 'night' && !kept.register && reopened > 0, `${JSON.stringify(kept)}，20 秒内进门 ${reopened} 人`);
  // 中途翻开登记簿（右下角的本子）：鬼魂不收输入（main.ts 的 onToggle → rig.hold）——翻开之前就按住的 W 也不再推它；
  // 合上（Back to the manor）以后视角回到翻开那一刻
  const ngs = () => np.evaluate(() => window.__haunt.ghost.state());
  await np.evaluate(() => window.__haunt.ghost.place(2, 6, 0)); // 走廊西段，朝东
  await np.keyboard.down('KeyW');
  await sleep(500);
  const pushing = await ngs();
  await np.evaluate(() => document.querySelector('.rg-book').click());
  await sleep(1500);
  const held1 = await ngs();
  await sleep(800);
  const held2 = await ngs();
  const midOpen = await np.evaluate(() => window.__haunt.night().register);
  const back = np.getByRole('button', { name: 'Back to the manor' });
  const backOk = await back.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
  if (backOk) await back.click();
  await np.keyboard.up('KeyW');
  await sleep(200);
  const after = await ngs();
  const drift = Math.hypot(held2.x - held1.x, held2.z - held1.z);
  check('一夜：中途翻开登记簿时按住的 W 不再推鬼魂，合上后视角回到翻开那一刻', pushing.speed > 1 && midOpen && drift < 0.03 && held2.speed < 0.05 && backOk && Math.abs(after.yaw - pushing.yaw) < 1e-3,
    `翻开前 ${pushing.speed.toFixed(2)} 米/秒，翻开着 0.8 秒挪了 ${drift.toFixed(3)} 米、${held2.speed.toFixed(3)} 米/秒，Back to the manor ${backOk ? '有' : '无'}，朝向差 ${(after.yaw - pushing.yaw).toFixed(4)}`);
  // 立刻收夜（调试口：不等屋里的人走光）：播报 lastCall，静、光收回以后翻开登记簿
  await np.evaluate(() => window.__haunt.endNight());
  const lastCall = (await tickerLines(np)).some((l) => l === 'No one else is coming tonight.');
  const ended = await waitNight(np, (n) => n.phase === 'register' && n.register, 12000);
  check('一夜：收夜以后登记簿翻开', lastCall && ended?.phase === 'register' && ended.register, `播报 ${lastCall ? '有' : '无'}，${JSON.stringify(ended)}`);
  await np.screenshot({ path: `shots/smoke-7-register-close${WEBGL ? '-webgl' : ''}.png` });
  await clickRegister(np, 'Keep haunting', '收夜那一页，第二夜');
  check('一夜：没有页面报错', nErrors.length === 0, nErrors.slice(0, 5).join(' | '));
  await np.close();

  // ── 手机竖屏（触屏）：自动走俯视；不出横向滚动条；轻点开场能开始，轻点物件能附身 ──────────
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  await phone.goto(`${BASE}?debug${QS}`, { waitUntil: 'networkidle' });
  await waitReady(phone);
  check('触屏自动走娃娃屋俯视', await phone.evaluate(() => window.__haunt.ghost === null));
  const sw = await phone.evaluate(() => document.documentElement.scrollWidth);
  check('390 px 宽没有横向滚动', sw <= 390, `scrollWidth=${sw}`);
  await phone.locator('[data-start]').tap();
  await waitStarted(phone); // 等开场遮罩收起、开场镜头落定，物件的屏幕位置才稳定
  const pt = await phone.evaluate(() => window.__haunt.screenOf('lamp-living'));
  await phone.touchscreen.tap(pt.x, pt.y);
  await sleep(300);
  const cd = await phone.evaluate(() => window.__haunt.raw().objects.find((o) => o.id === 'lamp-living').cooldown);
  check('触屏轻点物件能附身', cd > 0, `点 (${pt.x.toFixed(0)}, ${pt.y.toFixed(0)})，冷却 ${cd.toFixed(1)} 秒`);
  await phone.screenshot({ path: 'shots/smoke-3-phone.png' });
  // 触屏、俯视也能收夜、翻登记簿（2026-10-30「一夜」）；Keep haunting 用手指点
  await phone.evaluate(() => window.__haunt.endNight());
  const phoneEnd = await waitNight(phone, (n) => n.phase === 'register' && n.register, 12000);
  check('触屏：收夜以后登记簿翻开', phoneEnd?.phase === 'register' && phoneEnd.register, JSON.stringify(phoneEnd));
  await phone.screenshot({ path: 'shots/smoke-8-phone-register.png' });
  const keepBtn = phone.getByRole('button', { name: 'Keep haunting' });
  if (await keepBtn.isVisible().catch(() => false)) await keepBtn.tap();
  const phoneKept = await waitNight(phone, (n) => n.phase === 'night' && !n.register, 3000);
  check('触屏：点 Keep haunting 合上登记簿', phoneKept?.phase === 'night' && !phoneKept.register, JSON.stringify(phoneKept));
} catch (e) {
  check('冒烟流程跑完', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
  stop();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
