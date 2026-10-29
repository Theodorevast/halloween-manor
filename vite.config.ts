import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 联名皮肤（src/config/character.ts 的 COLLAB_SPECS）：授权确认之前，公开的构建里不能有任何联名的东西。
 * - 模型：`?collab` 只是页面上的开关，文件放在 public/ 里照样会被复制进 dist、能被直接下载，所以构建完从 dist 里删掉；
 * - public/assets/visitors/manifest.json：流水线的记录，运行时没人读，里面有联名两套的名字（「联名：…（JOJO）」）和 assets-src 的内部路径，
 *   也一起删掉；
 * - 地址：构建期常量 __COLLAB__（下面的 define）在默认构建里是 false，character.ts 并入 COLLAB_SPECS 的那一句成了死代码，
 *   COLLAB_SPECS 整个被摇掉，两个 GLB 的地址不会出现在 JS 里。
 * 要带上它们（授权确认以后，或者本机看样）就用 COLLAB=1 构建。开发服务器（npm run dev）不受影响：__COLLAB__ 为 true，?collab 照常能用
 */
const COLLAB = process.env.COLLAB === '1';
const COLLAB_FILES = ['assets/visitors/jotaro.glb', 'assets/visitors/dio.glb', 'assets/visitors/manifest.json'];

function stripCollab(): Plugin {
  let outDir = 'dist';
  return {
    name: 'strip-collab',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      if (COLLAB) return;
      for (const f of COLLAB_FILES) rmSync(join(outDir, f), { force: true });
    },
  };
}

// base 用相对路径：构建结果放到任何子路径下都能直接打开（GitHub Pages、Cloudflare Pages 等）
export default defineConfig(({ command }) => ({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
  // 开发服务器、COLLAB=1 构建时为 true，默认构建为 false（见上面）；类型声明在 src/env.d.ts，vitest.config.ts 另给一份
  define: { __COLLAB__: JSON.stringify(command === 'serve' || COLLAB) },
  plugins: [stripCollab()],
}));
