import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // dev only — in production the server serves the built SPA itself
      '/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
