import { defineConfig } from 'vite';

// base 用相对路径：构建结果放到任何子路径下都能直接打开（GitHub Pages、Cloudflare Pages 等）
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { host: '127.0.0.1' },
});
