// The offline shell, and the reason the geography is only ever downloaded once.
//
// This is not a framework's generated file. There is no build step, no manifest
// of hashed filenames baked in at compile time, and nothing here has to be
// regenerated when the bundle changes — which is deliberate, because a
// precache manifest is a fourth place that has to agree with the build and the
// first one to go stale breaks the app rather than the cache.
//
// Instead every request is matched by *what kind of thing it is*, and each kind
// gets the strategy its own HTTP headers already claim:
//
//   /assets/…      content-hashed, served `immutable`  → cache first, forever
//   /api/… (GET)   per-account, revalidated by ETag    → network first, fall
//                                                        back to the last copy
//   a navigation   index.html, revalidated by ETag     → network first, fall
//                                                        back to the shell
//   anything else  someone else's server               → not ours to cache
//
// With one addition to "because the page asked for it", and it is the only
// place this file goes looking for something: the assets the **cached shell
// names** are made sure of after every navigation. That list is read out of the
// HTML that is already here rather than written at build time, so it is still
// not a manifest to keep in step with anything — see `primeShellAssets`, and
// the failure that put it there.
//
// **What this buys, in order of how much it matters.**
//
// The geography. `places.json`, `regions.json` and `countries.json` are 8.5 MB
// raw and about 3 MB gzipped, they are content-hashed, and they never change
// between deploys — but the browser's own cache is a best-effort store that is
// evicted under pressure, and on a phone it is evicted often. Held here they
// survive, so searching for a town costs nothing on the second day.
//
// The airports are the same deal with one extra property worth keeping: they
// ship as one file per group, and because nothing outside the shell is
// pre-fetched, a group left switched off is never requested and never stored. Switching one on pays
// for it once — see "The airports, from a file rather than an API" in
// ARCHITECTURE.md.
//
// Then the shell: the app opens with no server. And then the map itself, which
// is the point of the whole thing — the last answer `/api/cells` gave is still
// in the cache, so an aeroplane still shows you where you have been.
//
// **What it deliberately does not do.**
//
// *Basemap tiles.* They come from CARTO, OpenFreeMap and Esri, and squirrelling
// away someone else's tiles for offline use is their bandwidth and their terms,
// not a technical question. Offline you get your own cells and routes over an
// empty background, which is honest about what is yours.
//
// *Anything but GET.* A cached POST is not a cache, it is a lie about a write.
//
// *Anything that failed.* Only a 200 is kept — a 401 held in a cache is how a
// signed-out session becomes permanent, and an error page held in one is how a
// bad deploy becomes permanent.
//
// **Offline is view-only, and the app already knew how to say so.** Edits are
// queued and the "cannot reach the server" banner appears, exactly as they do
// when the tunnel drops with the tab already open. Nothing here pretends a save
// happened.

// Bumped when the strategies below change. Old caches are dropped on activate,
// so this is also the switch that clears everything after a bad one.
const VERSION = 'v1';
const SHELL = `sporra-shell-${VERSION}`; // index.html
const ASSETS = `sporra-assets-${VERSION}`; // /assets/* — content-hashed
const DATA = `sporra-data-${VERSION}`; // /api/* GETs

const OURS = [SHELL, ASSETS, DATA];

// The app was called HexPlore, and its caches were named after it. The sweep
// below only deletes what it recognises as ours, so renaming the prefix would
// have stranded those caches in every browser that had already installed a
// worker — invisible, never served from, and never collected. Keep this until
// no such worker can plausibly still be out there.
const PREFIXES = ['sporra-', 'hexplore-'];

self.addEventListener('install', (event) => {
  // Nothing is pre-fetched *here*, where there is nothing to go on: a worker
  // being installed has no shell yet, so a fetch at this point would be a
  // guess at filenames — exactly the baked-in manifest this file refuses to
  // carry. The making-sure happens once there is a cached shell to read it out
  // of, on activate and after each navigation.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      // Only ours. A cache belonging to something else served from this origin
      // is not this file's to delete.
      if (PREFIXES.some((p) => name.startsWith(p)) && !OURS.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
    // A worker that has just taken over is the first chance to notice that the
    // shell it is holding names files nobody has here.
    await primeShellAssets();
  })());
});

// Signing out has to take the map with it. The API cache holds one account's
// cells, routes and trips, and the next person to sign in on this device must
// not be handed them while their own request is still in flight.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'forget-account') {
    event.waitUntil(caches.delete(DATA));
  }
});

/** Keep it only if it is a real answer. See the note about 401 above. */
async function keep(cacheName, request, response) {
  if (!response || response.status !== 200 || response.type !== 'basic') return response;
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch {
    // A cache that will not take it — a device with no room, an origin over its
    // quota — must not also cost you the response. This function's rejection is
    // `respondWith`'s rejection, which is a script tag that failed rather than a
    // cache entry that was missed: the app would break *online* because it could
    // not be made to work offline, which is exactly backwards. The file is
    // simply not kept, and the next load asks for it again.
  }
  return response;
}

/**
 * Content-hashed and declared `immutable`: the filename changes when the bytes
 * do, so a hit is correct by construction and there is nothing to revalidate.
 * This is the one strategy that never touches the network on a hit.
 */
async function cacheFirst(request) {
  const hit = await caches.match(request, { cacheName: ASSETS });
  if (hit) return hit;
  return keep(ASSETS, request, await fetch(request));
}

/**
 * Fresh when there is a network, and the last known answer when there is not.
 *
 * Not stale-while-revalidate, which would show yesterday's map for a moment on
 * every load and then redraw it. These reads are already cheap when nothing has
 * changed — the ETag makes a repeat a 304 of about three hundred bytes — so
 * asking first costs a round trip and buys never being wrong.
 */
async function networkFirst(cacheName, request, fallback) {
  try {
    return await keep(cacheName, request, await fetch(request));
  } catch {
    // What was asked for first, and only then what stands in for it. The other
    // order — which is what this did — has a hole in it: a navigation is stored
    // under the URL that was navigated to, so an app opened at `/somewhere`
    // filled the cache with `/somewhere` and then, offline, asked for `/` and
    // was told there was nothing there. Everything was there.
    const hit = (await caches.match(request, { cacheName }))
      ?? (fallback ? await caches.match(fallback, { cacheName }) : undefined);
    if (hit) return hit;
    throw new Error('offline and nothing cached');
  }
}

/**
 * The last shell that was read, and what it named.
 *
 * Only the *reading* is remembered, never the conclusion. A worker that had
 * recorded "this build is complete" would be blind to the eviction that happens
 * an hour later — which is the whole failure this exists to catch, so the one
 * thing it must not do is take its own word for it.
 */
let shellAssets = { etag: null, urls: [] };

/**
 * The shell names the files it cannot start without, so nothing else has to.
 *
 * Everything here is otherwise cached because the page asked for it, which is
 * what keeps this file free of a build-time manifest — and is also a promise
 * with a gap in it. A file the page asked for *once*, on a load this worker did
 * not see or on a device that later evicted it, is a file the app will look for
 * offline and not find. The shell survives that (it has its own cache, and it
 * is refreshed on every load), so what you get is a page that loads and then
 * cannot start: no stylesheet, no map, nothing on screen. That is the failure
 * this whole section exists to prevent, and it was reachable from the moment
 * anything fell out of the cache.
 *
 * So the shell is read for the `/assets/…` it references and each one is made
 * sure of. The list is derived from the *cached* HTML rather than from the
 * build, which keeps the rule this file is written around: there is no fourth
 * place that has to agree with anything, and a shell that has just been
 * replaced by a newer deploy names the newer files by construction.
 *
 * It does not reach for the lazily-loaded geography — those are megabytes each,
 * they are not in the shell, and a group of airports nobody switched on should
 * still cost nothing. Those keep the "cached once used" bargain they always had.
 */
async function primeShellAssets() {
  const cache = await caches.open(SHELL);
  const [key] = await cache.keys();
  if (!key) return;
  const shell = await cache.match(key);
  if (!shell) return;

  // The parse is what gets skipped when the shell has not moved — 150 KB of
  // HTML re-read on every launch to find the same three filenames is work with
  // nothing at the end of it. What is *not* skipped is the looking: the cache
  // is asked about every one of them, every time, because a file that was here
  // an hour ago is exactly the kind that is gone now.
  const etag = shell.headers.get('ETag');
  let urls = shellAssets.urls;
  if (!etag || etag !== shellAssets.etag) {
    const html = await shell.text();
    urls = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1]))];
    shellAssets = { etag, urls };
  }

  const assets = await caches.open(ASSETS);
  await Promise.all(urls.map(async (url) => {
    if (await assets.match(url)) return;
    try {
      const response = await fetch(url);
      if (response.status !== 200 || response.type !== 'basic') throw new Error(String(response.status));
      await assets.put(url, response);
    } catch {
      // Offline, or a cache that would not take it. Nothing to do about either
      // here, and the next load with a network tries again.
    }
  }));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Someone else's server: tiles, the IP lookup, a Komoot tour. Left alone.
  if (url.origin !== self.location.origin) return;

  // A navigation is a request for the app itself, whatever path it carries.
  // The fallback is the root, because offline there is only ever one page to
  // give — tried after the URL actually asked for, which is where this
  // navigation's own copy lives.
  if (request.mode === 'navigate') {
    const shell = networkFirst(SHELL, request, '/');
    event.respondWith(shell);
    // Afterwards, and only afterwards: the shell may have just been replaced by
    // a newer build, and it is the newer build's files that have to be here.
    // Behind `waitUntil` so the page is never waiting on it.
    event.waitUntil(shell.then(() => primeShellAssets()).catch(() => {}));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // The downloads are the exception: a backup is the whole database and has
    // no business sitting in a cache a page can read.
    if (url.pathname.startsWith('/api/backup/download')) return;
    // So are the train tracks. They are under /api/ because they are
    // session-gated, but they are not one account's data and none of the
    // reasoning above fits them: `networkFirst` is exactly backwards for a tile
    // (which does not change while you look at it), the volume is thousands of
    // entries rather than a handful, and `forget-account` would throw the lot
    // away on sign-out for no reason. They already have two caches that suit
    // them — the browser's own, driven by the `private, max-age` and ETag the
    // server sends, and the disk cache behind it in server/rail-tiles.js. A
    // third one here would be unbounded and redundant.
    if (url.pathname.startsWith('/api/rail/')) return;
    // And the trails, for the same reasons and one of its own. The tiles are
    // the argument above word for word. The lookup a tap makes is the extra
    // one: it is a box around a point somebody just touched, it is never asked
    // for twice, and the server sends it `no-store` precisely so that nothing
    // keeps a record of where the finger went. A cache here would be the one
    // place that did.
    if (url.pathname.startsWith('/api/trails/')) return;
    event.respondWith(networkFirst(DATA, request));
  }
});
