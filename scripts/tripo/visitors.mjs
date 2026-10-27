// 访客角色流水线的命令行入口（逻辑在 pipeline.mjs）。先看用法：node scripts/tripo/visitors.mjs --help
//   node scripts/tripo/visitors.mjs --dry-run            打印将要发出的每个请求（key 打码）和积分估算，不联网、不花钱
//   node scripts/tripo/visitors.mjs --run all --yes      真跑（草稿只做到换装图）；可以重跑，做过的步骤不会重复扣费
import { mask } from './client.mjs';
import { main } from './pipeline.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(mask(e?.stack ?? e));
  process.exitCode = 1;
}
