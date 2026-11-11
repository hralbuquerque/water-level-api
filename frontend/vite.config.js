import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI calls the backend through /api, proxied to the Express
// server (cd backend && npm run dev). Set VITE_API_BASE to call a deployed API instead.
const apiProxy = {
  '/api': {
    target: process.env.API_TARGET ?? 'http://localhost:3000',
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
});
