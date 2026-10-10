import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  server: {
    host: true,
  },
  build: {
    rollupOptions: {
      input: {
        sender: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});