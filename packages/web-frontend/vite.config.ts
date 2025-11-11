import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    base: env.VITE_BASE_PATH ?? '/',
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY ?? 'http://localhost:4000',
          changeOrigin: true,
          ws: true
        }
      }
    }
  };
});
