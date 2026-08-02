import { fileURLToPath, URL } from 'node:url';

import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./ui', import.meta.url)),
  plugins: [preact()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4177',
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/ui', import.meta.url)),
    emptyOutDir: true,
  },
});
