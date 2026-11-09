import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// The edit bar ships as one self-contained script that the preview nginx
// injects into every page (LIVE-EDITS.md §2.1). It never enters the site build.
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
