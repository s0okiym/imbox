import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { shellWorker } from './src/pwa/build-plugin.js';

export default defineConfig({
  plugins: [react(), shellWorker()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: process.env['IMBOX_API_PROXY_TARGET'] ?? 'http://localhost:4100',
        changeOrigin: false,
        ws: true,
      },
      '/healthz': {
        target: process.env['IMBOX_API_PROXY_TARGET'] ?? 'http://localhost:4100',
        changeOrigin: false,
      },
    },
  },
  build: { target: 'es2023', sourcemap: false },
});
