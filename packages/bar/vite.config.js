import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The edit bar ships as one self-contained script that a host injects into
// the page: a hosted preview's nginx, the browser extension, or a dev-server
// plugin. It never enters a site's own build.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    lib: {
      entry: 'src/main.jsx',
      formats: ['iife'],
      name: 'LiveEditsBar',
      fileName: () => 'bar.js',
    },
  },
});
