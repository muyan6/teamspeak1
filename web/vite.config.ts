import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// The dev proxy target was hardcoded to localhost:3000, so anyone running the
// backend on a non-default webPort (or a remote dev host) silently got proxy
// errors instead of a connection to their server. Allow an override via
// DSH_DEV_API / VITE_DEV_API while keeping the old default.
const apiTarget = process.env.VITE_DEV_API ?? process.env.DSH_DEV_API ?? 'http://localhost:3000';
const wsTarget = apiTarget.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': apiTarget,
      '/ws': {
        target: wsTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
