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
// **What this buys, in order of how much it matters.**
//
// The geography. `places.json`, `regions.json` and `countries.json` are 8.5 MB
// raw and about 3 MB gzipped, they are content-hashed, and they never change
// between deploys — but the browser's own cache is a best-effort store that is
// evicted under pressure, and on a phone it is evicted often. Held here they
// survive, so searching for a town costs nothing on the second day.
//
// The airports are the same deal with one extra property worth keeping: they
// ship as one file per group, and because nothing here is pre-fetched, a group
// left switched off is never requested and never stored. Switching one on pays
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
const SHELL = `hexplore-shell-${VERSION}`; // index.html
const ASSETS = `hexplore-assets-${VERSION}`; // /assets/* — content-hashed
const DATA = `hexplore-data-${VERSION}`; // /api/* GETs

const OURS = [SHELL, ASSETS, DATA];

self.addEventListener('install', (event) => {
  // Nothing is pre-fetched. Everything this caches, it caches because the page
  // asked for it — which means the cache can never hold a file the running
  // build does not use, and there is no list to keep in step with the build.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      // Only ours. A cache belonging to something else served from this origin
      // is not this file's to delete.
      if (name.startsWith('hexplore-') && !OURS.includes(name)) await caches.delete(name);
    }
    await self.clients.claim();
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
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
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
    const hit = await caches.match(fallback ?? request, { cacheName });
    if (hit) return hit;
    throw new Error('offline and nothing cached');
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Someone else's server: tiles, the IP lookup, a Komoot tour. Left alone.
  if (url.origin !== self.location.origin) return;

  // A navigation is a request for the app itself, whatever path it carries.
  // The fallback is the shell rather than the URL asked for, because offline
  // there is only ever one page to give.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL, request, '/'));
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
