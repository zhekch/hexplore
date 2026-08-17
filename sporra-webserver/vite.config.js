import { defineConfig } from 'vite';

// In dev, the front-end is served by Vite (5173) while the auth/cells API runs
// as a separate Node process (server/index.js, port 3001). Proxy /api to it so
// the browser makes same-origin requests and the session cookie just works.
// `npm run dev` starts both together (scripts/dev.mjs).
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: false,
      },
    },
  },
});
