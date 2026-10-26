import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Edition is fixed at build time: VITE_EDITION=cloud|onprem (default cloud for dev).
 * Cloud builds to dist/, on-prem to dist-onprem/ (CI passes --outDir explicitly, which wins).
 * import.meta.env.VITE_EDITION is replaced statically, so `if (import.meta.env.VITE_EDITION === 'cloud')`
 * branches (and the promptplus/* chunks they lazy-load) are dropped from the on-prem bundle.
 */
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env };
  const edition = env.VITE_EDITION === 'onprem' ? 'onprem' : 'cloud';
  return {
    plugins: [react()],
    define: { 'import.meta.env.VITE_EDITION': JSON.stringify(edition) },
    build: { outDir: edition === 'onprem' ? 'dist-onprem' : 'dist', emptyOutDir: true, sourcemap: false },
    server: {
      port: 5173,
      proxy: { '/api': 'http://localhost:3000', '/pair': 'http://localhost:3000' },
    },
  };
});
