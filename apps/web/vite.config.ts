import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite proxies to the dev server that scripts/dev.mjs starts (its
// own port and state folder, apart from `pnpm start`); the server allows this
// origin only when started with --dev-origin.
const server = process.env.AGENTHOUSE_DEV_SERVER ?? 'http://127.0.0.1:7358';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server, changeOrigin: true },
      '/ws': { target: server, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    // Emptying dist is slow on Windows and trips Rolldown's timing report on every build.
    rolldownOptions: { checks: { bundlerTimings: false } },
  },
});
