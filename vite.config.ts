import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 联名皮肤（src/config/character.ts 的 COLLAB_SPECS）的模型：授权确认之前不进公开的构建。
 * `?collab` 只是页面上的开关，文件放在 public/ 里照样会被复制进 dist、能被直接下载，所以构建完从 dist 里删掉；
 * 要带上它们（授权确认以后，或者本机看样）就用 COLLAB=1 构建。开发服务器（npm run dev）不受影响
 */
const COLLAB_FILES = ['assets/visitors/jotaro.glb', 'assets/visitors/dio.glb'];

function stripCollab(): Plugin {
  let outDir = 'dist';
  return {
    name: 'strip-collab',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      if (process.env.COLLAB === '1') return;
      for (const f of COLLAB_FILES) rmSync(join(outDir, f), { force: true });
    },
  };
}

// base 用相对路径：构建结果放到任何子路径下都能直接打开（GitHub Pages、Cloudflare Pages 等）
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
  plugins: [stripCollab()],
});
