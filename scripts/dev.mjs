#!/usr/bin/env node
// Runs the front-end (Vite) and the API server together for local development,
// so `npm run dev` gives you both. Vite is what you open (http://localhost:5173);
// it proxies /api to the Node server (see vite.config.js). Killing this process
// (Ctrl-C) tears both down; if either exits, so does the other.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The API needs its own port, separate from Vite's (5173). Ignore any inherited
// PORT (the launcher may set it for the web server) and pin the API to API_PORT.
const apiPort = process.env.API_PORT || '3001';
const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

function run(label, args, env) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
  child.on('exit', (code) => {
    if (!shuttingDown) console.log(`[dev] ${label} exited (${code}) — shutting down`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// Anything after `npm run dev --` is meant for Vite, not for this launcher —
// `npm run dev -- --host` has to expose the dev server on the LAN exactly as
// `vite --host` would. Without this the flags were swallowed here and Vite kept
// listening on localhost only. (The API already binds every interface, and
// Vite proxies /api to it from the server side, so no second flag is needed.)
const viteArgs = process.argv.slice(2);

// API first (Vite's proxy tolerates it coming up a beat later). Force the API's
// PORT to apiPort; hand Vite API_PORT so its /api proxy targets the same port.
run('api', ['--watch', path.join('server', 'index.js')], { PORT: apiPort });
run('web', [path.join('node_modules', 'vite', 'bin', 'vite.js'), ...viteArgs], { API_PORT: apiPort });
