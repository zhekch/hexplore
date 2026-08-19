// The first thing the page runs, and the only thing it does is decide which map
// library to fetch before letting the app load.
//
// It exists for one reason. `main.js` builds its map at module scope, so the
// library has to be in hand before that module is *evaluated* — and the natural
// way to say that, a top-level `await` at the head of main.js, is not available
// here: the build targets Safari 14, which is the WebKit inside the iOS app, and
// top-level await arrived in Safari 15. Raising the floor to buy one `await`
// would drop the app off the phones it was written for.
//
// So the await happens here, in a module small enough that nothing depends on
// its ordering, and main.js is imported afterwards. It then reads `engineNow()`
// synchronously and cannot be wrong, because the only path to main.js runs
// through the line below.
//
// A failure is a browser that could not fetch Mapbox GL JS at all — an offline
// first load of the 3D basemap, most likely. MapLibre is loaded instead and
// main.js notices that it did not get the engine its basemap wanted, and moves
// the basemap rather than showing a background that never resolves.

// …and the same trick now carries a second passenger. `t()` in src/i18n.js is
// synchronous, because half the strings in this app are in module-level
// constants that are evaluated the moment their module is imported — so the
// language has to be in hand before anything below is. This is the one place
// that can wait for it, and it is already waiting.
import { MAPBOX, MAPLIBRE, engineForBasemap, loadEngine, savedStyleKey } from './gl-engine.js';
import { loadLocale } from './i18n.js';

const wanted = engineForBasemap(savedStyleKey());

// The document is hidden until its stylesheet is — see the inline rule in the
// head of index.html. main.js imports the stylesheet before its own first line
// runs, so by the time that import resolves the page is styled and safe to
// show. Called on both paths: a page that could not load a map still has to be
// able to say so.
const reveal = () => document.documentElement.classList.remove('booting');

// Both at once: they need nothing from each other, and the language file is a
// few kilobytes against a map library's megabyte — waiting for it in series
// would add its round trip to every load for no reason.
Promise.all([
  loadEngine(wanted)
    .catch((e) => {
      if (wanted === MAPLIBRE) throw e; // nothing left to fall back to
      console.warn('Mapbox GL JS could not be loaded; falling back to MapLibre.', e);
      return loadEngine(MAPLIBRE);
    }),
  // Never rejects — a language that will not load falls back to English inside
  // `loadLocale`, because a page in the wrong language beats no page at all.
  loadLocale(),
])
  .then(() => import('./main.js'))
  .then(reveal)
  .catch(showFailure);

/**
 * Say what went wrong, in a way that survives the thing that went wrong.
 *
 * Anything awaited above can be missing: a map library, the language file, and
 * — since `main.js` imports it — **the stylesheet**. That last one is what made
 * the previous version of this handler useless. It wrote its sentence into
 * `#map` and trusted the page's own CSS to make it legible, so on the one load
 * where the CSS was the casualty it drew default black text on an unstyled
 * page. In a browser that is ugly. In the iOS app, where the web view is
 * transparent over a near-black background, it is invisible: a phone in
 * airplane mode showed an empty grey rectangle, scrollable, with this message
 * on it the whole time.
 *
 * So every rule here is inline, and it says which piece was missing. That
 * detail is the difference between "it is broken" and "it is offline and the
 * offline copy has a hole in it", and only one of those tells you to reconnect
 * once and open it again.
 */
function showFailure(error) {
  reveal();
  console.error('Sporra could not finish loading.', error);

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2147483647',
    'display:flex', 'flex-direction:column', 'gap:12px',
    'align-items:center', 'justify-content:center',
    'padding:24px', 'box-sizing:border-box',
    'background:#0b0b10', 'color:#f2f2f7',
    'font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    'text-align:center',
  ].join(';');

  const headline = document.createElement('p');
  headline.textContent = 'Sporra could not finish loading.';
  headline.style.cssText = 'margin:0;font-size:19px;font-weight:600';

  const advice = document.createElement('p');
  advice.textContent = navigator.onLine
    ? 'Part of the app could not be downloaded. Check the connection and reload.'
    : 'This device is offline and part of the app was not in its offline copy. Connect once, open Sporra again, and it will repair itself.';
  advice.style.cssText = 'margin:0;max-width:32em;color:#b9b9c6';

  // The URL, where there is one. A failed dynamic import names the file it
  // could not get, and that file is the whole answer to what the cache is
  // missing — the one line worth reading off a screen and into a bug report.
  const detail = document.createElement('p');
  detail.textContent = String(error?.message ?? error);
  detail.style.cssText =
    'margin:0;max-width:36em;color:#7c7c8a;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all';

  const retry = document.createElement('button');
  retry.textContent = 'Reload';
  retry.style.cssText = [
    'margin-top:4px', 'padding:10px 22px', 'border:0', 'border-radius:10px',
    'background:#f2f2f7', 'color:#0b0b10', 'font:inherit', 'font-weight:600',
    'cursor:pointer',
  ].join(';');
  retry.addEventListener('click', () => location.reload());

  panel.append(headline, advice, detail, retry);
  document.body.append(panel);
}
