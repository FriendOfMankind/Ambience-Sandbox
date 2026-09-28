import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // AudioWorklet modules must be ES modules.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        rainBakeoff: resolve(import.meta.dirname, 'spikes/rain-bakeoff/index.html'),
      },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
