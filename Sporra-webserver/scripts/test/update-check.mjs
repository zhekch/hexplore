// Whether anybody has published a newer version than the one running.
//
//   node scripts/test/update-check.mjs
//
// This is the only outbound request the server makes that nobody configured, so
// what it does when the answer is unhelpful matters more than what it does when
// the answer is good. Every one of these is a way it could be wrong in a way
// nobody would notice for months:
//
//   - **`0.10.0` is newer than `0.9.0`.** As text it is not, and that is exactly
//     the release where a string comparison would quietly stop reporting
//     updates.
//   - **"cannot tell" is not "up to date".** A firewall, a timeout, a fork with
//     a different layout — none of those mean the server is current, and a line
//     in Settings claiming it is would be worse than no line.
//   - **It asks once.** The answer is cached, or every press of Settings by
//     every device is a request to somebody else's server.
//   - **It can be switched off**, and then it never asks at all.
//
// The upstream is a stand-in served from here, so none of this touches the
// network — which is also the only way to test "the source is down".

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 3191;
const UPSTREAM_PORT = 3192;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// --- The published copy, as far as this is concerned ------------------------------
//
// A whole `server/index.js` is not needed and would not prove anything the
// constant does not: what the server reads is one line out of the first 16 KB.
// The padding is here to check the Range header is actually sent — the stub
// answers 416 to a request without one, so a build that stopped ranging would
// fail rather than quietly download megabytes for ever.

let upstreamVersion = '9.9.9';
let upstreamMode = 'ok'; // 'ok' | 'down' | 'wrong'
let upstreamAsked = 0;

const upstream = createServer((req, res) => {
  upstreamAsked++;
  if (upstreamMode === 'down') {
    res.writeHead(503).end('nope');
    return;
  }
  const body = upstreamMode === 'wrong'
    ? `<!doctype html>\n<title>Not this file</title>\n${'x'.repeat(4000)}`
    : `// a comment, as the real file opens with\nexport const SERVER_VERSION = '${upstreamVersion}';\n${'/'.repeat(60_000)}`;
  const range = /^bytes=0-(\d+)$/.exec(req.headers.range ?? '');
  if (!range) {
    res.writeHead(416).end('a range was expected');
    return;
  }
  const slice = body.slice(0, Number(range[1]) + 1);
  res.writeHead(206, { 'Content-Type': 'text/plain' }).end(slice);
});
await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

// --- …and the server that asks it -------------------------------------------------

const dir = await mkdtemp(path.join(tmpdir(), 'visited-update-test-'));
let server = null;
let serverOut = '';
let serverErr = '';

async function startServer(env = {}) {
  serverOut = '';
  serverErr = '';
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_PATH: path.join(dir, 'test.db'),
      BACKUP_DIR: path.join(dir, 'backups'),
      ALLOW_REGISTRATION: '1',
      UPDATE_SOURCE: `http://127.0.0.1:${UPSTREAM_PORT}/index.js`,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (b) => { serverOut += b.toString(); });
  server.stderr.on('data', (b) => { serverErr += b.toString(); });
  // Wait for *our* server, not for something answering on that port — a
  // forgotten dev server would otherwise answer every request below.
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) {
      throw new Error(`the test server exited (${server.exitCode}) — is port ${PORT} in use?\n${serverErr}`);
    }
    if (serverOut.includes(`localhost:${PORT}`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the test server never announced itself:\n${serverOut}\n${serverErr}`);
}

async function stopServer() {
  if (!server) return;
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  server = null;
}

let jar = '';
async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(jar ? { Cookie: jar } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jar = setCookie.split(';')[0];
  return { status: res.status, body: await res.json().catch(() => null) };
}

try {
  await startServer();

  console.log('\nIt belongs to somebody with an account');
  {
    const out = await api('GET', '/api/update');
    check(out.status === 401, 'a stranger is told no', String(out.status));
    // The version alone is public, because a phone has to be able to check an
    // address before it has an account.
    const health = await api('GET', '/api/health');
    check(health.status === 200 && health.body.app === 'sporra',
      'while the plain health check still answers anybody');
  }

  await api('POST', '/api/register', { username: 'ada', password: 'correct-horse-9' });

  console.log('\nA newer published version is reported as one');
  {
    const out = await api('GET', '/api/update');
    check(out.status === 200, 'the check answers', String(out.status));
    check(out.body.latest === '9.9.9', 'with what was published', String(out.body.latest));
    check(out.body.newer === true, 'and says it is newer than what is running');
    check(typeof out.body.version === 'string' && out.body.version !== out.body.latest,
      'beside what is running, which the page needs for its own comparison',
      JSON.stringify(out.body));
    check(upstreamAsked === 1, 'having asked exactly once', String(upstreamAsked));
  }

  console.log('\nAnd it is asked once, not once per press');
  {
    const before = upstreamAsked;
    await api('GET', '/api/update');
    await api('GET', '/api/update');
    await api('GET', '/api/update');
    check(upstreamAsked === before, 'three more presses cost no more requests',
      String(upstreamAsked - before));
  }

  console.log('\nNumbers, not text');
  {
    // The release this is really about. `'0.100.0' < '0.49.0'` as text, because
    // `'1'` sorts before `'4'` — so a string comparison stops reporting updates
    // for ever at exactly the point the project has had a hundred minors, and
    // does it silently.
    await stopServer();
    upstreamVersion = '0.100.0';
    await startServer();
    await api('POST', '/api/login', { username: 'ada', password: 'correct-horse-9' });
    const out = await api('GET', '/api/update');
    check(out.body.newer === true,
      'a hundredth minor is newer than a forty-ninth, whatever the alphabet says',
      JSON.stringify(out.body));
  }

  console.log('\nAn older published version is not an update');
  {
    await stopServer();
    upstreamVersion = '0.0.1';
    await startServer();
    await api('POST', '/api/login', { username: 'ada', password: 'correct-horse-9' });
    const out = await api('GET', '/api/update');
    check(out.body.latest === '0.0.1', 'it is still reported', String(out.body.latest));
    check(out.body.newer === false, 'and it is not newer');
  }

  console.log('\nCannot tell is not up to date');
  {
    await stopServer();
    upstreamMode = 'down';
    await startServer();
    await api('POST', '/api/login', { username: 'ada', password: 'correct-horse-9' });
    const down = await api('GET', '/api/update');
    check(down.status === 200, 'the endpoint still answers', String(down.status));
    check(down.body.latest === null && down.body.newer === false,
      'with no opinion at all, rather than with "you are current"',
      JSON.stringify(down.body));

    await stopServer();
    upstreamMode = 'wrong';
    await startServer();
    await api('POST', '/api/login', { username: 'ada', password: 'correct-horse-9' });
    const wrong = await api('GET', '/api/update');
    check(wrong.body.latest === null,
      'and something that is not this file at all is the same answer',
      JSON.stringify(wrong.body));
  }

  console.log('\nAnd it can be switched off');
  {
    await stopServer();
    upstreamMode = 'ok';
    upstreamVersion = '9.9.9';
    const before = upstreamAsked;
    await startServer({ UPDATE_CHECK: '0' });
    await api('POST', '/api/login', { username: 'ada', password: 'correct-horse-9' });
    const out = await api('GET', '/api/update');
    check(out.body.latest === null && out.body.newer === false,
      'nothing is reported', JSON.stringify(out.body));
    check(upstreamAsked === before, 'and nothing is asked', String(upstreamAsked - before));
    check(typeof out.body.version === 'string',
      'though the running version is still answered, which is the half that is local');
  }
} finally {
  await stopServer();
  upstream.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
