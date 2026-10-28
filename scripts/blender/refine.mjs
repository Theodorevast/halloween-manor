// 访客 GLB 精修：用本机 Blender 无头跑 refine_visitor.py（重分权重让球身不变形、清碎片、限面数和贴图、原地动画），
// 可选出预览图并拼成一张对比表。Tripo 流水线的 export 步骤也调用这里（visitors.json 的 refine）。
//
//   node scripts/blender/refine.mjs <输入.glb> <输出.glb> [--preview] [--report <r.json>] [refine_visitor.py 的其他参数…]
//   例：node scripts/blender/refine.mjs assets-src/visitors/vampire/animate.glb .logs/vampire.glb --preview --limb-scale 1.5
//
// Blender 路径：环境变量 BLENDER_PATH，没有就在 C:/Program Files/Blender Foundation/ 下找版本最新的。
// Blender 是 GPL 软件，这里只把它当离线工具跑，产物（GLB）不受影响；游戏里不打包任何 Blender 的代码。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function findBlender() {
  if (process.env.BLENDER_PATH) return existsSync(process.env.BLENDER_PATH) ? process.env.BLENDER_PATH : null;
  const base = 'C:/Program Files/Blender Foundation';
  if (!existsSync(base)) return null;
  const vers = readdirSync(base)
    .filter((d) => existsSync(join(base, d, 'blender.exe')))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  return vers.length ? join(base, vers[0], 'blender.exe') : null;
}

/**
 * 跑一次精修。路径都要绝对路径（Blender 的工作目录不一定是项目根，相对路径会写到别处去）。
 * 返回 { ok, report, sheet, lines, error }；不抛错
 */
export async function refineGlb({ src, out, report, preview = null, args = [], log = () => {} }) {
  const blender = findBlender();
  if (!blender) return { ok: false, error: '找不到 Blender：装好之后设环境变量 BLENDER_PATH 指向 blender.exe', lines: [] };
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  if (preview) mkdirSync(dirname(preview), { recursive: true });
  const argv = ['-b', '--factory-startup', '-P', join(HERE, 'refine_visitor.py'), '--', '--in', src, '--out', out, '--report', report, ...(preview ? ['--preview', preview] : []), ...args.map(String)];
  const r = spawnSync(blender, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^\[refine\]|Error|Traceback|^\s+File "|Exception/.test(l));
  for (const l of lines) log(l);
  if (r.status !== 0 || !existsSync(out) || !existsSync(report)) return { ok: false, error: `Blender 退出码 ${r.status ?? r.error?.message}，没有生成精修结果`, lines };
  const rep = JSON.parse(readFileSync(report, 'utf8'));
  let sheet = null;
  if (preview && rep.previews?.length) {
    sheet = `${preview}-sheet.png`;
    try {
      await tilePreviews(rep.previews, preview, sheet);
    } catch (e) {
      log(`预览表没拼成（${e.message}），单张预览图在 ${dirname(preview)}`);
      sheet = null;
    }
  }
  return { ok: true, report: rep, sheet, lines };
}

/** 预览图按「行 = 动作帧（含权重图）、列 = 视角」拼成一张 */
export async function tilePreviews(files, prefix, dest) {
  const { chromium } = await import('playwright-core');
  const rows = [];
  for (const f of files) {
    const m = /-([^-]+)\.png$/.exec(f);
    const tag = f.slice(prefix.length + 1, f.length - (m ? m[0].length : 4));
    let row = rows.find((x) => x.tag === tag);
    if (!row) rows.push((row = { tag, cells: [] }));
    row.cells.push({ view: m ? m[1] : '', url: 'data:image/png;base64,' + readFileSync(f).toString('base64') });
  }
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  try {
    const page = await browser.newPage();
    const data = await page.evaluate(async (rows) => {
      const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
      const S = 260, LABEL = 22, cols = Math.max(...rows.map((r) => r.cells.length));
      const c = document.createElement('canvas');
      c.width = cols * S;
      c.height = rows.length * (S + LABEL);
      const g = c.getContext('2d');
      g.fillStyle = '#1b1b1f';
      g.fillRect(0, 0, c.width, c.height);
      g.font = '14px "Microsoft YaHei", sans-serif';
      g.textBaseline = 'middle';
      for (const [ri, row] of rows.entries()) {
        for (const [ci, cell] of row.cells.entries()) {
          const im = await load(cell.url);
          const x = ci * S, y = ri * (S + LABEL);
          g.drawImage(im, x, y + LABEL, S, S);
          g.fillStyle = '#eee';
          g.fillText(`${row.tag} · ${cell.view}`, x + 6, y + LABEL / 2);
        }
      }
      return c.toDataURL('image/png');
    }, rows);
    writeFileSync(dest, Buffer.from(data.split(',')[1], 'base64'));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------- 命令行

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const [src, out] = argv;
  if (!src || !out || src.startsWith('--') || out.startsWith('--')) {
    console.error('用法：node scripts/blender/refine.mjs <输入.glb> <输出.glb> [--preview] [--report <r.json>] [其他参数]');
    process.exit(2);
  }
  const rest = argv.slice(2);
  const wantPreview = rest.includes('--preview');
  const pass = rest.filter((a) => a !== '--preview');
  const abs = (p) => resolve(process.cwd(), p);
  const inAbs = abs(src);
  const outAbs = abs(out);
  if (!existsSync(inAbs)) {
    console.error(`找不到 ${src}`);
    process.exit(2);
  }
  const ri = pass.indexOf('--report');
  const reportAbs = ri >= 0 ? abs(pass[ri + 1]) : join(dirname(inAbs), `${basename(outAbs, '.glb')}-refine.json`);
  if (ri >= 0) pass.splice(ri, 2);
  const preview = wantPreview ? join(dirname(inAbs), 'refine-preview', basename(outAbs, '.glb')) : null;
  const res = await refineGlb({ src: inAbs, out: outAbs, report: reportAbs, preview, args: pass, log: (s) => console.log(s) });
  if (!res.ok) {
    console.error(`\n${res.error}`);
    process.exit(1);
  }
  console.log(`\n三角面 ${res.report.tris_before} → ${res.report.tris_after}；报告 ${reportAbs}`);
  if (res.report.warnings?.length) console.log(`警告：\n  ${res.report.warnings.join('\n  ')}`);
  if (res.sheet) console.log(`预览表 ${res.sheet}`);
}
