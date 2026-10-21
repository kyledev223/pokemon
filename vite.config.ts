import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const API = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace('http', 'ws'), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 1000, // three.js alone is ~600 kB
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        admin: resolve(import.meta.dirname, 'admin.html'),
      },
    },
  },
});
