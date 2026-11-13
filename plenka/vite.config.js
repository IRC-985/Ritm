import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  server: { host: '127.0.0.1', port: 5173 },
});
