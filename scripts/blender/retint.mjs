// 访客 GLB 底色贴图的后处理：用本机 Blender 无头跑 retint.py（手套重涂成参考访客的颜色和材质、按色相提亮某类颜色），
// 网格、骨骼、动作原样不动（只换贴图的字节）。Tripo 流水线的 export 步骤在 Blender 精修之后调这里（visitors.json 的 retint）。
//
//   node scripts/blender/retint.mjs <输入.glb> <输出.glb> --config <cfg.json> [--report <r.json>] [--preview <前缀>]
//   cfg.json 的写法见 retint.py 文件头；里面的相对路径（gloves.reference）按项目根目录解析
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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

/** retint 里有没有要做的事（defaults 里只有说明、没有规则时跳过） */
export function hasRetint(cfg) {
  return Boolean(cfg && (cfg.gloves || (Array.isArray(cfg.lift) && cfg.lift.length)));
}

/**
 * 跑一次后处理。src / out / report / preview 都要绝对路径。返回 { ok, report, lines, error }；不抛错
 */
export async function retintGlb({ src, out, config, report, preview = null, root = ROOT, log = () => {} }) {
  const blender = findBlender();
  if (!blender) return { ok: false, error: '找不到 Blender：装好之后设环境变量 BLENDER_PATH 指向 blender.exe', lines: [] };
  mkdirSync(dirname(out), { recursive: true });
  mkdirSync(dirname(report), { recursive: true });
  const cfgFile = `${report}.config.json`;
  writeFileSync(cfgFile, `${JSON.stringify(absConfig(config, root), null, 2)}\n`);
  const argv = ['-b', '--factory-startup', '--python-exit-code', '1', '-P', join(HERE, 'retint.py'), '--', '--in', src, '--out', out, '--config', cfgFile, '--report', report, ...(preview ? ['--preview', preview] : [])];
  const r = spawnSync(blender, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split(/\r?\n/).filter((l) => /^\[retint\]|Error|Traceback|^\s+File "|Exception|SystemExit/.test(l));
  for (const l of lines) log(l);
  if (r.status !== 0 || !existsSync(out) || !existsSync(report)) return { ok: false, error: `Blender 退出码 ${r.status ?? r.error?.message}，没有生成后处理结果`, lines };
  return { ok: true, report: JSON.parse(readFileSync(report, 'utf8')), lines };
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
    root: process.cwd(), log: (s) => console.log(s),
  });
  if (!res.ok) {
    console.error(`\n${res.error}`);
    process.exit(1);
  }
  if (res.report.warnings?.length) console.log(`警告：\n  ${res.report.warnings.join('\n  ')}`);
}
