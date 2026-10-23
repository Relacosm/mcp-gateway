import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy the API to the gateway running in the local cluster.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://gateway.localtest.me', changeOrigin: true },
    },
  },
});
