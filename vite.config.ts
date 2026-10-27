import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { AI_HTTP_TIMEOUT_MS } from './shared/ai-runtime';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        timeout: AI_HTTP_TIMEOUT_MS,
        proxyTimeout: AI_HTTP_TIMEOUT_MS,
      },
    },
  },
});
