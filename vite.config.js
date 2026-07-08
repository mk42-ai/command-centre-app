import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // v20: relative asset base so the built SPA works both at the domain root
  // and behind the OnDemand serverless path prefix (/apps/<app-name>/).
  base: './',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    // dev-only: forward API calls to the express proxy (prod serves dist/ from server.js itself)
    // v25 (B-09): server.js defaults to PORT 5173 (prod) — dev pairing runs the
    // API on 8787 via `PORT=8787 node server.js`; keep both mapped.
    proxy: { '/api': process.env.VITE_API_PROXY || 'http://localhost:8787' },
  },
});
