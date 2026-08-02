// Turning the service worker on, and telling it when to forget things.
//
// The worker itself is `public/sw.js`, and everything about *what* it caches is
// explained there. This file is only the two decisions that belong to the page.
//
// **Production only.** A cache that answers before the server does is exactly
// what you want shipped and exactly what you do not want while editing: a stale
// shell served to a dev server you have just changed looks like a bug in the
// change. `npm run build && npm start` is where this is exercised, which is
// also where it matters. A worker left registered from an earlier production
// build on the same origin is actively unregistered in dev rather than merely
// not installed, because localhost is one origin and a laptop that once ran
// `npm start` would otherwise keep it forever.
//
// **iOS gets this for free.** The Map tab of the iOS app is a `WKWebView` with
// `websiteDataStore = .default()`, and WebKit has supported service workers in
// a web view since iOS 14 — registration, Cache Storage and all, persisted
// across launches by that store. So the app's shell, its 3 MB of gazetteer and
// its last view of the map are cached by the same code that does it in Safari,
// with nothing native to write and nothing bundled into the IPA. Bundling would
// have been the obvious alternative and is the worse one: a copy of the web app
// inside the app is a second copy that can disagree with the server's, which is
// the trade this whole project keeps refusing.

const SW_URL = '/sw.js';

/** @returns {ServiceWorkerContainer|null} */
const container = () => (typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null);

export function installOffline() {
  const sw = container();
  if (!sw) return;

  if (!import.meta.env.PROD) {
    sw.getRegistrations?.()
      .then((regs) => regs.forEach((r) => r.scope.startsWith(location.origin) && r.unregister()))
      .catch(() => {});
    return;
  }

  // After load rather than during it. Registering competes with the map's own
  // first tiles for the connection, and an app that is slower to draw so that
  // it can be faster next time has the trade backwards.
  const start = () => sw.register(SW_URL).catch(() => {
    // Refused (an insecure origin, a browser with it switched off, private
    // browsing). Everything still works; it just works online.
  });
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

/**
 * Throw away the cached answers about the account that just signed out.
 *
 * The worker holds one account's cells, routes and trips under URLs that say
 * nothing about whose they are, so the next person to sign in on this device
 * would be shown them for as long as their own request took to arrive. Fired
 * and not waited on: signing out must not be able to fail because a cache did.
 */
export function forgetAccountOffline() {
  container()?.controller?.postMessage({ type: 'forget-account' });
}
