import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: 'src/renderer',
  // Vite's default .env lookup is relative to `root` above (src/renderer),
  // not the repo root — but .env.example/envConfig.ts's own documented
  // convention (and the main process's real .env loading) both put .env at
  // the repo root. Without this, a real .env at the repo root is silently
  // never read by Vite, and VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY stay on
  // their placeholder fallback in every build no matter what .env contains.
  envDir: path.resolve(__dirname),
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
  },
});
