// What the service worker does when the network is gone, which is the one thing
// about it nobody can see by using the app.
//
// This file exists because the offline shell was verified by killing the server
// and reloading, and that test passes for the wrong reason. `/assets/…` is
// served `immutable, max-age=1y`, so the browser's *own* HTTP cache hands those
// files back offline without consulting any of the code below — a desktop keeps
// them for a year and looks fine either way. A phone evicts them, and then the
// only copy left is the one this worker was supposed to be keeping. When it
// turned out not to have kept all of it, what the iOS app showed was a blank
// grey rectangle: the shell loaded, its stylesheet did not, and a page with no
// CSS in a web view that is transparent over a near-black background has
// nothing on it anybody can see.
//
// So the worker is run here with no browser at all — `caches`, `fetch` and
// `self` are stubs — and asked the questions a browser cannot be made to ask
// reliably:
//
//   • a navigation offline is answered from the cache, including when the app
//     is deployed at a path rather than at the root (it was not: the shell was
//     stored under `/trips` and the fallback only ever asked for `/`)
//   • a cache that refuses a write costs the cache entry and not the response,
//     because `respondWith` rejecting is a script tag that failed
//   • the assets the shell *names* are fetched even when no page asked for
//     them, which is what makes an incomplete offline copy repair itself
//
//   node scripts/test/offline-shell.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGIN = 'https://sporra.example';

/** A response as this worker uses one: a status, a type, headers, clone, text. */
function makeResponse(body, { status = 200, type = 'basic', headers = {} } = {}) {
  return {
    status,
    type,
    headers: new Headers(headers),
    clone: () => makeResponse(body, { status, type, headers }),
    text: async () => body,
    body,
  };
}

const makeRequest = (url, { mode = 'no-cors', method = 'GET' } = {}) => ({
  url: new URL(url, ORIGIN).href,
  mode,
  method,
});

const keyOf = (r) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);

class FakeCache {
  constructor() {
    this.entries = new Map();
    /** Set to make every write fail, the way a device with no room does. */
    this.refuseWrites = false;
  }

  async put(request, response) {
    if (this.refuseWrites) throw new Error('QuotaExceededError');
    this.entries.set(keyOf(request), response);
  }

  async match(request) {
    return this.entries.get(keyOf(request));
  }

  async keys() {
    return [...this.entries.keys()].map((url) => makeRequest(url, { mode: 'navigate' }));
  }

  async delete(request) {
    return this.entries.delete(keyOf(request));
  }
}

function makeCacheStorage() {
  const store = new Map();
  return {
    store,
    async open(name) {
      if (!store.has(name)) store.set(name, new FakeCache());
      return store.get(name);
    },
    async keys() {
      return [...store.keys()];
    },
    async delete(name) {
      return store.delete(name);
    },
    async match(request, { cacheName } = {}) {
      const cache = store.get(cacheName);
      return cache ? cache.match(request) : undefined;
    },
  };
}

/** Load public/sw.js into a context with the handful of globals it uses. */
async function loadWorker({ fetch }) {
  const source = await readFile(path.join(ROOT, 'public/sw.js'), 'utf8');
  const listeners = new Map();
  const caches = makeCacheStorage();
  const self = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    location: { origin: ORIGIN },
  };
  const context = vm.createContext({
    self, caches, fetch, URL, Headers, Error, Promise, console,
  });
  vm.runInContext(source, context, { filename: 'sw.js' });
  return { listeners, caches, self };
}

/** Fire one event at a listener and wait for everything it started. */
async function dispatch(listeners, type, event = {}) {
  const pending = [];
  const wrapped = {
    ...event,
    waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})),
    respondWith: (p) => { wrapped.responded = Promise.resolve(p); },
  };
  await listeners.get(type)?.(wrapped);
  await Promise.all(pending);
  return wrapped;
}

const SHELL_HTML = `<!doctype html>
<html lang="en" class="booting">
  <head>
    <script type="module" crossorigin src="/assets/index-AAA.js"></script>
    <link rel="modulepreload" crossorigin href="/assets/maplibre-BBB.js" />
    <link rel="stylesheet" crossorigin href="/assets/main-CCC.css" />
  </head>
  <body></body>
</html>`;

const shellResponse = (etag = '"shell-1"') =>
  makeResponse(SHELL_HTML, { headers: { ETag: etag, 'Content-Type': 'text/html' } });

let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
};

// --- A navigation offline is answered from the cache ---------------------------

await check('a navigation is served from the cache when the network is gone', async () => {
  let online = true;
  const { listeners, caches } = await loadWorker({
    fetch: async (input) => {
      if (!online) throw new Error('offline');
      return typeof input === 'string' ? makeResponse('asset') : shellResponse();
    },
  });

  const request = makeRequest('/', { mode: 'navigate' });
  const first = await dispatch(listeners, 'fetch', { request });
  assert.equal((await first.responded).status, 200, 'the online navigation should answer');

  online = false;
  const offline = await dispatch(listeners, 'fetch', { request });
  const response = await offline.responded;
  assert.equal(response.status, 200, 'the offline navigation should answer from the cache');
  assert.match(await response.text(), /class="booting"/);
});

await check('an app deployed at a path finds its own shell offline', async () => {
  let online = true;
  const { listeners } = await loadWorker({
    fetch: async (input) => {
      if (!online) throw new Error('offline');
      return typeof input === 'string' ? makeResponse('asset') : shellResponse();
    },
  });

  // The regression: this navigation is stored under `/trips`, and the fallback
  // asked only for `/`, so offline the worker reported having nothing at all.
  const request = makeRequest('/trips', { mode: 'navigate' });
  await dispatch(listeners, 'fetch', { request });

  online = false;
  const offline = await dispatch(listeners, 'fetch', { request });
  const response = await offline.responded;
  assert.ok(response, 'a path deployment should have its shell offline');
  assert.equal(response.status, 200);
});

await check('an unknown path offline still falls back to the root shell', async () => {
  let online = true;
  const { listeners } = await loadWorker({
    fetch: async (input) => {
      if (!online) throw new Error('offline');
      return typeof input === 'string' ? makeResponse('asset') : shellResponse();
    },
  });

  await dispatch(listeners, 'fetch', { request: makeRequest('/', { mode: 'navigate' }) });
  online = false;
  const offline = await dispatch(listeners, 'fetch', {
    request: makeRequest('/somewhere-nobody-visited', { mode: 'navigate' }),
  });
  assert.ok(await offline.responded, 'the root shell stands in for any path');
});

// --- A cache that will not take it ---------------------------------------------

await check('a refused cache write does not fail the request', async () => {
  const { listeners, caches } = await loadWorker({
    fetch: async () => makeResponse('console.log(1)'),
  });
  const assets = await caches.open('sporra-assets-v1');
  assets.refuseWrites = true;

  const event = await dispatch(listeners, 'fetch', {
    request: makeRequest('/assets/index-AAA.js'),
  });
  // Before the fix this rejected, which in a browser is a script tag that
  // failed to load — the app broken online because it could not be made to
  // work offline.
  const response = await event.responded;
  assert.equal(response.status, 200, 'the response survives a cache that refused it');
});

// --- The assets the shell names ------------------------------------------------

await check('the assets named by the shell are fetched without a page asking', async () => {
  const asked = [];
  const { listeners, caches } = await loadWorker({
    fetch: async (input) => {
      if (typeof input === 'string') {
        asked.push(input);
        return makeResponse(`/* ${input} */`);
      }
      return shellResponse();
    },
  });

  await dispatch(listeners, 'fetch', { request: makeRequest('/', { mode: 'navigate' }) });

  const assets = await caches.open('sporra-assets-v1');
  for (const url of ['/assets/index-AAA.js', '/assets/maplibre-BBB.js', '/assets/main-CCC.css']) {
    assert.ok(await assets.match(url), `${url} should have been made sure of`);
  }
  assert.equal(asked.length, 3, 'exactly the three the shell names, and nothing else');
});

await check('a shell that has not moved is not read twice', async () => {
  let assetFetches = 0;
  const { listeners } = await loadWorker({
    fetch: async (input) => {
      if (typeof input === 'string') {
        assetFetches += 1;
        return makeResponse('asset');
      }
      return shellResponse();
    },
  });

  const request = makeRequest('/', { mode: 'navigate' });
  await dispatch(listeners, 'fetch', { request });
  assert.equal(assetFetches, 3, 'the first navigation makes sure of all three');
  await dispatch(listeners, 'fetch', { request });
  await dispatch(listeners, 'fetch', { request });
  assert.equal(assetFetches, 3, 'later navigations of the same build ask for nothing');
});

await check('a new deploy makes sure of the new build’s files', async () => {
  let etag = '"shell-1"';
  const asked = [];
  const { listeners } = await loadWorker({
    fetch: async (input) => {
      if (typeof input === 'string') {
        asked.push(input);
        return makeResponse('asset');
      }
      return etag === '"shell-1"'
        ? shellResponse(etag)
        : makeResponse(SHELL_HTML.replace(/AAA/g, 'DDD'), {
          headers: { ETag: etag, 'Content-Type': 'text/html' },
        });
    },
  });

  const request = makeRequest('/', { mode: 'navigate' });
  await dispatch(listeners, 'fetch', { request });
  etag = '"shell-2"';
  await dispatch(listeners, 'fetch', { request });
  assert.ok(asked.includes('/assets/index-DDD.js'), 'the new entry chunk is fetched');
});

// --- An incomplete offline copy repairs itself ---------------------------------

await check('a hole in the offline copy is filled by the next load with a network', async () => {
  let online = true;
  const { listeners, caches } = await loadWorker({
    fetch: async (input) => {
      if (!online) throw new Error('offline');
      return typeof input === 'string' ? makeResponse('asset') : shellResponse();
    },
  });

  const request = makeRequest('/', { mode: 'navigate' });
  await dispatch(listeners, 'fetch', { request });

  // What a phone does under storage pressure, and what nothing in the app was
  // able to notice.
  const assets = await caches.open('sporra-assets-v1');
  assets.entries.delete(new URL('/assets/main-CCC.css', ORIGIN).href);
  assert.equal(await assets.match('/assets/main-CCC.css'), undefined);

  await dispatch(listeners, 'fetch', { request });
  assert.ok(
    await assets.match('/assets/main-CCC.css'),
    'the stylesheet is back without anyone having asked for it',
  );

  online = false;
  const offline = await dispatch(listeners, 'fetch', { request });
  assert.ok(await offline.responded, 'and the app opens with no network');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\noffline shell: all checks passed');
