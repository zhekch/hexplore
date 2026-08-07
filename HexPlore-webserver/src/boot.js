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

import { MAPBOX, MAPLIBRE, engineForBasemap, loadEngine, savedStyleKey } from './gl-engine.js';

const wanted = engineForBasemap(savedStyleKey());

// The document is hidden until its stylesheet is — see the inline rule in the
// head of index.html. main.js imports the stylesheet before its own first line
// runs, so by the time that import resolves the page is styled and safe to
// show. Called on both paths: a page that could not load a map still has to be
// able to say so.
const reveal = () => document.documentElement.classList.remove('booting');

loadEngine(wanted)
  .catch((e) => {
    if (wanted === MAPLIBRE) throw e; // nothing left to fall back to
    console.warn('Mapbox GL JS could not be loaded; falling back to MapLibre.', e);
    return loadEngine(MAPLIBRE);
  })
  .then(() => import('./main.js'))
  .then(reveal)
  .catch((e) => {
    reveal();
    // Neither library loaded, which means there is going to be no map at all.
    // Said out loud rather than left as a blank page: the alternative is a
    // window that looks like the app is simply broken, with nothing in it that
    // says the download failed.
    console.error('No map library could be loaded.', e);
    const el = document.getElementById('map');
    if (el) el.textContent = 'The map library could not be loaded. Check the connection and reload.';
  });
