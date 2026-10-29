import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { AI_HTTP_TIMEOUT_MS } from './shared/ai-runtime';
const apiPort = process.env.PORT || '3001';
const webPort = process.env.WEB_PORT || '5173';
if (!/^\d+$/.test(apiPort) || Number(apiPort) < 1 || Number(apiPort) > 65535)
  throw new Error('PORT 必须是 1 至 65535 的端口号。');
if (!/^\d+$/.test(webPort) || Number(webPort) < 1 || Number(webPort) > 65535)
  throw new Error('WEB_PORT 必须是 1 至 65535 的端口号。');
export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(webPort),
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${Number(apiPort)}`,
        timeout: AI_HTTP_TIMEOUT_MS,
        proxyTimeout: AI_HTTP_TIMEOUT_MS,
      },
    },
  },
});
