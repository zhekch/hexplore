import { defineConfig } from 'vite';
import { banner } from './server/banner.js';

// In dev, the front-end is served by Vite (5173) while the auth/cells API runs
// as a separate Node process (server/index.js, port 3001). Proxy /api to it so
// the browser makes same-origin requests and the session cookie just works.
// `npm run dev` starts both together (scripts/dev.mjs).
// What a build produces is a dist/ that some server will serve later, possibly
// on another machine and possibly much later — so the one moment the version is
// certain is now, while the source that carries it is on disk in front of us.
// Announcing it at the *start* is deliberate: a build that then fails has still
// told you which version failed.
const stamp = () => ({
  name: 'sporra-banner',
  apply: 'build',
  buildStart() {
    console.log(banner('build'));
  },
});

export default defineConfig({
  plugins: [stamp()],
  server: {
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3001}`,
        changeOrigin: false,
      },
    },
  },
});
