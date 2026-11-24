import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 子路径部署: VITE_APP_BASE=/pentad/ npm run build（经 nginx /pentad/ 访问）
// vite.config 运行在 node 环境, 项目未引入 @types/node, 这里做最小类型声明。
declare const process: { env?: Record<string, string | undefined> };
const appBase = process.env?.VITE_APP_BASE || '/';

export default defineConfig({
  base: appBase,
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8003',
        changeOrigin: true,
      },
    },
  },
});
