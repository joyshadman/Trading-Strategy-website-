import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'



// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Resolve @trading/shared to its TypeScript source so Vite compiles it directly.
  resolve: {
    conditions: ['source', ...defaultClientConditions],
  },
  // Dev-time proxy to avoid browser CORS issues when calling third-party APIs.
  // Use `/api/frankfurter/latest?...` from the frontend.
  server: {
    proxy: {
      '/api/frankfurter': {
        target: 'https://api.frankfurter.app',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/frankfurter/, ''),
      },
      // Our own backend (apps/server). Same origin in the browser, so no CORS in dev.
      '/api': {
        target: 'http://127.0.0.1:4000',
      },
      '/ws': {
        target: 'ws://127.0.0.1:4000',
        ws: true,
      },
    },
  },
})
