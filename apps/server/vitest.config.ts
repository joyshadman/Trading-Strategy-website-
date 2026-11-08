import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Resolve @trading/shared to its TypeScript source, like tsx does with --conditions=source.
const conditions = ['source', ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
});
