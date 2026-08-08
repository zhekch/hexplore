// The policy the page is served under, and the one directive in it that decides
// whether the 3D basemap has buildings in it.
//
// This file exists because of a bug that could not be seen from the code that
// looked wrong. Mapbox Standard's landmarks — the modelled station roofs,
// churches and parliaments — arrive as batched meshes that Mapbox GL JS decodes
// in **WebAssembly**. `script-src 'self' blob:` blocks that: no wasm source
// means `WebAssembly.instantiate` throws, and what the map does about it is
// nothing anyone would trace back to a header. The tiles are fetched, the layer
// stays visible, no error reaches the page, and every landmark falls back to the
// plain extrusion — which is a perfectly good building and gives nobody a reason
// to suspect there was anything else on offer.
//
// **And it is invisible in development.** Vite's dev server sends no CSP at all,
// so localhost:5173 draws the models correctly and the bug does not exist until
// it is deployed. Two attempts at a fix went into src/mapbox.js — the file that
// asks Standard what to draw — because that is where a missing building looks
// like it comes from. Neither could have worked.
//
// So this checks the header itself, on a real response from a real server:
//
//   • wasm is allowed, which is the whole story above
//   • `eval()` is still **not** allowed, because 'wasm-unsafe-eval' is worth
//     having only for as long as it stays narrower than 'unsafe-eval'. A future
//     hand widening it to make some library work would take the app's main
//     defence against an injected string with it, and should trip this instead.
//   • the rest of the policy is still there, so "add a source" never quietly
//     becomes "replace the policy"
//
//   node scripts/test/csp.mjs

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const dir = await mkdtemp(path.join(tmpdir(), 'visited-map-csp-'));
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DB_PATH: path.join(dir, 'test.db') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverErr = '';
server.stderr.on('data', (b) => {
  serverErr += b.toString();
});

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${BASE}/api/me`);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

/** The directives, as a map of name → sources. */
function directives(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) out[name] = sources;
  }
  return out;
}

try {
  if (!(await waitForServer())) throw new Error(`server did not start — ${serverErr}`);

  // The page itself. `/` is a navigation and gets the full document policy;
  // this is the response an actual visitor is served.
  const res = await fetch(`${BASE}/`);
  const header = res.headers.get('content-security-policy');

  console.log('\nThe page is served with a policy at all');
  check(!!header, 'index.html carries a Content-Security-Policy', `got ${header}`);
  const d = directives(header ?? '');

  console.log('\nThe directive the landmarks depend on');
  {
    const script = d['script-src'] ?? [];
    check(script.includes("'wasm-unsafe-eval'"),
      "script-src allows WebAssembly, without which Standard's landmarks are plain extrusions",
      script.join(' '));
    check(script.includes("'self'"), 'and still serves scripts from this origin only');
    check(script.includes('blob:'), "and still allows the map libraries' blob worker");
  }

  console.log('\nAnd what it must not have become on the way');
  {
    // The reason 'wasm-unsafe-eval' is an acceptable thing to add: it compiles
    // WebAssembly and nothing else. The moment 'unsafe-eval' appears beside it,
    // an injected string can run as JavaScript and the directive above has
    // stopped being a defence.
    const script = d['script-src'] ?? [];
    check(!script.includes("'unsafe-eval'"),
      'script-src does not allow eval(), which is the line wasm-unsafe-eval exists to stay behind');
    check(!script.includes("'unsafe-inline'"),
      'nor inline script, which is what makes an injected string harmless');

    // A policy is only as good as the parts nobody remembered to keep. These
    // are the ones that would be silently lost by rewriting the list.
    for (const [name, want] of [
      ['default-src', "'self'"],
      ['base-uri', "'self'"],
      ['object-src', "'none'"],
      ['frame-ancestors', "'none'"],
      ['form-action', "'self'"],
      ['worker-src', 'blob:'],
    ]) {
      check((d[name] ?? []).includes(want), `${name} still ${want}`, (d[name] ?? []).join(' ') || 'missing');
    }
  }

  console.log('\nThe same policy on the assets, not only the page');
  {
    // sendStatic serves both, and a hashed asset that arrived under a weaker
    // policy would be a hole shaped exactly like the one just closed.
    const asset = await fetch(`${BASE}/sw.js`);
    const theirs = asset.headers.get('content-security-policy');
    check(!!theirs, 'a static file carries the policy too', `got ${theirs}`);
    check(theirs === header, 'and it is the same one the page got');
  }
} catch (e) {
  check(false, 'test run', e.message);
} finally {
  server.kill();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
