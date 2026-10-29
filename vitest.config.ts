import { defineConfig } from 'vitest/config';

export default defineConfig({
  // 构建期常量（见 vite.config.ts、src/env.d.ts；vitest 不读 vite.config.ts，这里另给一份）：测试照开发服务器的样子跑。
  // node 里没有 location，联名两套照旧不并；要测带 ?collab 的情形，测试自己 stub location（tests/collab.test.ts）
  define: { __COLLAB__: JSON.stringify(true) },
  // 单条测试的超时：默认 5 秒不够。几条长模拟（几个种子 × 几分钟的一夜，逐帧比事件）空闲时就要 2–3 秒，这台机器上常有几个代理
  // 同时跑测试、冷编译，CPU 一挤就慢两倍多，偶尔超时（2026-10-30 集成时复现：三份全套测试同时跑，night.test.ts 的
  // 「整个世界：不给 openingGaps / …，事件和最后的状态逐个相同」跑了 5.4 / 6.4 秒，Test timed out in 5000ms；断言本身没错）。
  // 放到 30 秒：真卡死的测试照样会超时失败，只是不再因为机器忙而误报
  test: { include: ['tests/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
});
