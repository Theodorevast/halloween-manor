// 访客 GLB 贴图的后处理：用本机 Blender 无头跑 retint.py（手套换成配置里直接写的颜色、粗糙度、金属度；按色相提亮某类颜色），
// 网格、骨骼、动作原样不动（只换改了的那几张贴图的字节）。Tripo 流水线的 export 步骤在 Blender 精修之后调这里（visitors.json 的 retint）。
//
//   node scripts/blender/retint.mjs <输入.glb> <输出.glb> --config <cfg.json> [--report <r.json>] [--preview <前缀>]
//   cfg.json 的写法见 retint.py 文件头；里面的相对路径（只有旧写法 gloves.reference 用得到）按项目根目录解析。
//   输入和输出不能是同一个文件（会先删输出，免得失败时把旧文件当成这次的结果）；经目录联接、符号链接、硬链接的别名也算同一个
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from './refine.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

/** 配置里要用的文件路径换成绝对路径（Blender 的工作目录不一定是项目根） */
function absConfig(cfg, root) {
  const out = JSON.parse(JSON.stringify(cfg ?? {}));
  if (out.gloves?.reference && !isAbsolute(out.gloves.reference)) out.gloves.reference = resolve(root, out.gloves.reference);
  return out;
}

/**
 * 两个路径是不是同一个文件（复审 2）：只比路径文字的话，经目录联接（worktree 里的 assets-src 就是）、符号链接、硬链接
 * 写成的别名会漏过去，下面先删输出时就把输入删了。所以：存在的路径按 realpath 展开（联接、符号链接）；
 * 还不存在的输出按它所在目录的 realpath 拼上文件名；两个都存在时再比 dev + ino（硬链接）。Windows 不分大小写
 */
export function sameFile(a, b) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const real = (p) => {
    try {
      return realpathSync.native(p);
    } catch {
      try {
        return join(realpathSync.native(dirname(p)), basename(p));
      } catch {
        return resolve(p);
      }
    }
  };
  if (norm(real(a)) === norm(real(b))) return true;
  try {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false; // 有一个不存在：不可能是同一个文件的硬链接
  }
}

/** retint 里有没有要做的事（defaults 里只有说明、没有规则时跳过） */
export function hasRetint(cfg) {
  return Boolean(cfg && (cfg.gloves || (Array.isArray(cfg.lift) && cfg.lift.length)));
}

/**
 * 跑一次后处理。src / out / report / preview 都要绝对路径。返回 { ok, report, lines, error }；不抛错
 */
export async function retintGlb({ src, out, config, report, preview = null, root = ROOT, log = () => {} }) {
  // 原地改（输入、输出是同一个文件，包括经联接、硬链接的别名）不支持：下面会先删输出，那就把输入删了（复审、复审 2）
  if (sameFile(src, out)) return { ok: false, error: `输入和输出是同一个文件（${src} / ${out}）：贴图后处理要写到另一个文件`, lines: [] };
  const blender = findBlender();
  if (!blender) return { ok: false, error: '找不到 Blender：装好之后设环境变量 BLENDER_PATH 指向 blender.exe', lines: [] };
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const cfgFile = `${report}.config.json`;
  writeFileSync(cfgFile, `${JSON.stringify(absConfig(config, root), null, 2)}\n`);
  const argv = ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(HERE, 'retint.py'), '--', '--in', src, '--out', out, '--config', cfgFile, '--report', report, ...(preview ? ['--preview', preview] : [])];
  // 先删掉上一次的输出：失败时不能把旧文件当成这次的结果
  rmSync(out, { force: true });
  const r = spawnSync(blender, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^\[retint\]|Error|Traceback|^\s+File "|Exception|SystemExit/.test(l));
  for (const l of lines) log(l);
  // retint.py 停下时打「[retint] ✗ 原因」：把原因直接带出去，流水线日志里一眼看得到
  const why = lines.find((l) => l.startsWith('[retint] ✗'))?.replace('[retint] ✗ ', '');
  if (r.status !== 0 || !existsSync(out)) return { ok: false, error: why ? `贴图后处理停下了：${why}` : `Blender 退出码 ${r.status ?? r.error?.message}，没有生成后处理结果`, lines };
  let rep;
  try {
    rep = JSON.parse(readFileSync(report, 'utf8'));
  } catch (e) {
    return { ok: false, error: `后处理报告 ${report} 读不懂：${e.message}`, lines };
  }
  return { ok: true, report: rep, lines };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [src, out, ...rest] = process.argv.slice(2);
  const opt = (k) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (!src || !out || !opt('--config')) {
    console.error('用法：node scripts/blender/retint.mjs <输入.glb> <输出.glb> --config <cfg.json> [--report <r.json>] [--preview <前缀>]');
    process.exit(2);
  }
  const abs = (p) => resolve(process.cwd(), p);
  const config = JSON.parse(readFileSync(abs(opt('--config')), 'utf8'));
  const res = await retintGlb({
    src: abs(src), out: abs(out), config, report: abs(opt('--report') ?? `${out}.retint.json`), preview: opt('--preview') ? abs(opt('--preview')) : null,
    root: ROOT, log: (s) => console.log(s),
  });
  if (!res.ok) {
    console.error(`\n${res.error}`);
    process.exit(1);
  }
  if (res.report.warnings?.length) console.log(`警告：\n  ${res.report.warnings.join('\n  ')}`);
}
