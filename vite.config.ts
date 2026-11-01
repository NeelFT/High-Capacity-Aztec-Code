import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import basicSsl from '@vitejs/plugin-basic-ssl';

const lanAddresses = Object.values(networkInterfaces())
  .flatMap((addresses) => addresses ?? [])
  .filter((address) => !address.internal && (address.family === 'IPv4' || address.family === 4))
  .map((address) => address.address);
const certificateDomains = [...new Set(['localhost', '127.0.0.1', ...lanAddresses])];
const certificateId = createHash('sha256').update(certificateDomains.join(',')).digest('hex').slice(0, 12);

export default defineConfig({
  base: process.env.GITHUB_ACTIONS === 'true' ? '/high-capacity-aztec-code/' : '/',
  plugins: [basicSsl({
    domains: certificateDomains,
    certDir: resolve(import.meta.dirname, 'node_modules', '.vite', `basic-ssl-${certificateId}`),
  })],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      input: {
        sender: resolve(import.meta.dirname, 'index.html'),
      },
    },
  },
});