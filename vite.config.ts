import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 联名皮肤（src/config/character.ts 的 COLLAB_SPECS）。2026-10-30 起默认构建也带（用户定），下面这些只在 COLLAB=0 构建时生效：
 * - 模型：`?collab` 只是页面上的开关，文件放在 public/ 里照样会被复制进 dist、能被直接下载，所以构建完从 dist 里删掉；
 * - 地址：构建期常量 __COLLAB__（下面的 define）在 COLLAB=0 构建里是 false，character.ts 并入 COLLAB_SPECS 的那一句成了死代码，
 *   COLLAB_SPECS 整个被摇掉，两个 GLB 的地址不会出现在 JS 里。
 * 默认构建、开发服务器：__COLLAB__ 为 true，默认并进访客轮换（地址带 ?nocollab 不并）
 */
// 2026-10-30 用户定：公开构建也带联名（授权由用户负责），默认带上；COLLAB=0 构建才去掉（下面的插件、define）
const COLLAB = process.env.COLLAB !== '0';
const COLLAB_FILES = ['assets/visitors/jotaro.glb', 'assets/visitors/dio.glb'];
/** 流水线的记录，运行时没人读，里面有 assets-src 的内部路径：任何构建都不进 dist */
const PIPELINE_FILES = ['assets/visitors/manifest.json'];

function stripCollab(): Plugin {
  let outDir = 'dist';
  return {
    name: 'strip-collab',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      for (const f of COLLAB ? PIPELINE_FILES : [...PIPELINE_FILES, ...COLLAB_FILES]) rmSync(join(outDir, f), { force: true });
    },
  };
}

// base 用相对路径：构建结果放到任何子路径下都能直接打开（GitHub Pages、Cloudflare Pages 等）
export default defineConfig(({ command }) => ({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  // watch.ignored：开发服务器默认监视整个目录，.logs、.superpowers 里写一个 .html / .ts，所有打开的游戏页面都会整页刷新（2026-10-30 一小时 183 次）
  server: { host: '127.0.0.1', watch: { ignored: ['**/.logs/**', '**/.superpowers/**', '**/assets/**', '**/assets-src/**', '**/shots/**', '**/dist/**'] } },
  // 开发服务器、COLLAB=1 构建时为 true，默认构建为 false（见上面）；类型声明在 src/env.d.ts，vitest.config.ts 另给一份
  define: { __COLLAB__: JSON.stringify(command === 'serve' || COLLAB) },
  plugins: [stripCollab()],
}));
