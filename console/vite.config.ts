import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the console talks to the backend through this proxy.
    proxy: { '/v1': 'http://localhost:8080' },
  },
});
