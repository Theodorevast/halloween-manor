import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 构建期常量（见 vite.config.ts、src/env.d.ts；vitest 不读 vite.config.ts，这里另给一份）：测试照开发服务器的样子跑。
  // node 里没有 location，联名两套照旧不并；要测带 ?collab 的情形，测试自己 stub location（tests/collab.test.ts）
  define: { __COLLAB__: JSON.stringify(true) },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
