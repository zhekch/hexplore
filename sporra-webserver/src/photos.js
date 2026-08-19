// Your photographs, as places on the map.
//
// A photo carries the coordinate it was taken at, which the app already reads —
// that is where the `apple-photos` cells come from. This is the other half of
// the same fact: not "colour in the ground a camera has been over" but "there is
// a picture here, and here is what it was".
//
// **It exists only inside the iOS app, and cannot be made to work anywhere
// else.** A photo library is on a phone. The page cannot open one, and the
// server has never held anything but the coordinates — the whole point of how
// the sync is built. So the picture has to come from the host the page is
// running in, over the message channel `PhotoBridge.swift` answers, and in a
// browser there is no such channel and no such switch. That is the reason the
// row is *absent* from the menu rather than present and disabled: a control
// whose precondition is "be a different application" is not a control.
//
// **A photograph is named by its index, never by its identity.** The bridge
// sends `[lat, lng, t]` per photo and keeps the asset identifiers on its own
// side; everything here refers to a photo by where it sat in the array. Each
// answer is stamped with a scan number, and asking about a scan that has been
// replaced fails cleanly rather than quietly answering about a different
// picture — see the note on `PhotoBridge`.

// The handler's name, and the whole of how this detects the app. Changing it
// means changing `PhotoBridge.name` in the Swift.
const HOST = 'sporraPhotos';

// Namespaced like the railway and airport overlays, and for the same reason: a
// basemap is somebody else's style and its layer names are as ordinary as
// `rail`. Ours are ours beyond doubt.
const NS = 'sporra-photo';
const SOURCE = `${NS}-src`;

// Violet, and chosen by elimination. The visited wash is the accent, which the
// viewer picks and could be anything; a saved route is orange and a shown trip
// is amber. This has to be none of those at a glance on five basemaps, and it
// has to survive being drawn over a satellite photograph, where a warm colour is
// the one thing a photograph is guaranteed to contain.
export const PHOTO_COLOR = '#c07bff';

// How many thumbnails the card puts in the strip at a time. **Not a cap on the
// group**: a tap on a cluster of four thousand opens a card with four thousand
// in it, and the strip appends the next chunk as you reach the end of it. This
// used to be a hard ceiling of 48 and that was simply wrong — the group is the
// answer to the tap, and silently keeping nine tenths of it back is a card that
// misreports what is there.
//
// Chunked rather than rendered whole because a strip of forty thousand buttons
// is forty thousand elements on a phone, and because a thumbnail costs a request
// each. See `mountPhotoInfo`.
export const STRIP_CHUNK = 60;

// --- Talking to the app ----------------------------------------------------------

/** The message handler, or null anywhere that is not the app. */
export const photoHost = () => globalThis.webkit?.messageHandlers?.[HOST] ?? null;

/** Whether this build of the app can answer at all — the switch hangs on it. */
export const photosAvailable = () => !!photoHost();

/**
 * Ask the host something and get its answer.
 *
 * Every reply is `{ok: true, …}` or `{ok: false, error}` — a refusal is a state
 * to report, not an exception to throw, because every one of them is a sentence
 * somebody has to read: permission not granted, an original still in iCloud, an
 * app too old to know the question.
 */
async function ask(body) {
  const host = photoHost();
  if (!host) return { ok: false, error: 'nohost' };
  try {
    return (await host.postMessage(body)) ?? { ok: false, error: 'empty' };
  } catch (e) {
    console.warn('The photo library could not be reached.', e);
    return { ok: false, error: 'bridge' };
  }
}

// What the last scan said. Held here rather than in main.js because an index is
// meaningless without the scan it belongs to, and keeping the two together is
// what stops them being passed around separately and drifting apart.
let scan = 0;
let points = [];
let limited = false;

export const photoPoints = () => points;
export const photoCount = () => points.length;
/** How many of them move. Said separately in the menu, because "photos" is then a lie. */
export const videoCount = () => points.reduce((n, p) => n + (p[3] ? 1 : 0), 0);
/** Whether iOS is only letting the app see *some* of the library. */
export const photosLimited = () => limited;
/** When one photograph was taken, in unix seconds. */
export const photoTime = (i) => points[i]?.[2] ?? null;
/** Whether one of them is a video. */
export const isVideo = (i) => !!points[i]?.[3];

/**
 * Read the library.
 *
 * Every call is a fresh scan, which is the right cost: a scan is a metadata
 * query over the library — the same one the uploader does — and a cached list
 * would be a map that quietly stopped including this afternoon.
 *
 * @returns {Promise<{ok: boolean, count: number, error?: string}>}
 */
export async function loadPhotos() {
  const reply = await ask({ ask: 'points' });
  if (!reply.ok) {
    points = [];
    return { ok: false, count: 0, error: reply.error };
  }
  scan = reply.scan;
  points = Array.isArray(reply.photos) ? reply.photos : [];
  limited = !!reply.limited;
  return { ok: true, count: points.length };
}

/** Nothing on the map, and nothing remembered about a library we have stopped drawing. */
export function forgetPhotos() {
  points = [];
  scan = 0;
}

/**
 * One photograph, as a data URL.
 *
 * `px` is the longest side wanted. A stale scan is reported rather than
 * retried here: the caller knows whether the card it would fill is still open.
 *
 * @returns {Promise<{ok: boolean, src?: string, w?: number, h?: number, error?: string}>}
 */
export const photoImage = (i, px) => ask({ ask: 'photo', scan, i, px: Math.round(px) });

/**
 * Play a video, natively, in front of the page.
 *
 * The one call here that moves no data at all. A video is hundreds of megabytes
 * and every way of getting it *into* the page is worse than not — see the note
 * on `PhotoLibrary.playerItem`. So the app puts a player over the web view, and
 * this asks it to.
 */
export const playVideo = (i, group) => ask({ ask: 'play', scan, i, group });

/**
 * Show a photograph full screen, at its own size, in the app's own viewer.
 *
 * The same bargain as the video above and for a smaller version of the same
 * reason: the card already holds a copy scaled to the card, and the only thing
 * full screen is worth doing for is the original — which is several megabytes it
 * would then be holding twice. So the app puts a zoomable viewer over the page
 * and the page gets a yes.
 *
 * **`group` is the rest of what was tapped**, as indices into the last scan, in
 * the order the card's strip shows them. The viewer is a gallery and swipes
 * through the lot — and it has to be told what the lot *is*, because the
 * grouping happens here: clustering is the map's, and which forty photographs
 * were under that dot is a fact only this side holds. Sent for `play` as well
 * as `view`, so a holiday of stills and clips is one thing you swipe through
 * rather than two.
 */
export const viewPhoto = (i, group) => ask({ ask: 'view', scan, i, group });

// --- The layer -------------------------------------------------------------------

/**
 * The features, from the rows the bridge sent.
 *
 * A row is `[lat, lng, t, video]` — the first three because that is the shape a
 * location fix takes everywhere else in this app and a photograph is not worth a
 * second convention, and the fourth because the card needs a play button on the
 * ones that move.
 *
 * Note the swap: GeoJSON is `[lng, lat]`. Getting this backwards puts a summer
 * in Zürich somewhere off the coast of Somalia, which is a bug that looks like a
 * data problem.
 *
 * `i` travels as a property rather than as the feature id: with clustering on,
 * the id belongs to the cluster index, and a leaf's is not ours to rely on.
 */
export function photoGeoJson(photos, window = null) {
  const features = [];
  photos.forEach((p, i) => {
    // `i` is the index into the *library*, not into what is drawn. It has to
    // stay that way through the filter: it is what every later question about
    // this photograph is asked by — fetch it, play it, open it full screen —
    // and renumbering the survivors would answer all three about a different
    // picture. Hence the loop rather than the `map` this was.
    if (window && !inWindow(p[2], window)) return;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p[1], p[0]] },
      properties: { i, t: p[2], v: p[3] ? 1 : 0 },
    });
  });
  return { type: 'FeatureCollection', features };
}

/**
 * Was this taken while that was happening?
 *
 * A photograph with no time at all is *out* when a window is asked for, and in
 * when none is. It cannot be placed in the day being looked at, and a picture
 * that might be from any year is not an answer to "what did I see on Tuesday" —
 * whereas on the map as a whole it is still somewhere you have been.
 */
const inWindow = (at, [from, to]) => !!at && at >= from && at < to;

const CLUSTER = `${NS}-cluster`;
const COUNT = `${NS}-count`;
const POINT = `${NS}-point`;

/** Bottom first, which is also the order they are added in. */
export const photoLayerIds = () => [POINT, CLUSTER, COUNT];

/**
 * How the source clusters.
 *
 * `clusterMaxZoom` is deliberately at the top of the map's range rather than the
 * usual "one below the maximum". The convention exists so that the last zoom
 * shows individual points, which is right for shops and wrong for photographs:
 * forty pictures of one dinner are forty points at the same coordinate, and
 * un-clustering them at z17 replaces a group you can open with a pile you cannot
 * count. So a group stays a group all the way in, and a tap on one opens it.
 */
export const CLUSTER_MAX_ZOOM = 17;
const CLUSTER_RADIUS = 44;

/**
 * The layer specs, as data, so a test can read them without a map.
 *
 * @param {{theme: 'light'|'dark', font: string[]}} opts
 */
export function photoLayers({ theme, font }) {
  const dark = theme !== 'light';
  // A rim in the map's own background, not in white: on the light basemap a
  // white rim around a violet dot is the dot with its edges eaten.
  const rim = dark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(17, 20, 28, 0.75)';
  return [
    {
      id: POINT,
      type: 'circle',
      source: SOURCE,
      filter: ['!', ['has', 'point_count']],
      paint: {
        'circle-color': PHOTO_COLOR,
        // Generous at the bottom for the reason the trip dots are: a decade of
        // photographs seen from continent height is a scattering, and a 2 px dot
        // at that size reads as dirt on the screen rather than as a place.
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 2, 2.8, 8, 4, 14, 5.5, 17, 7],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 2, 0.8, 12, 1.4],
        'circle-stroke-color': rim,
      },
    },
    {
      id: CLUSTER,
      type: 'circle',
      source: SOURCE,
      filter: ['has', 'point_count'],
      paint: {
        'circle-color': PHOTO_COLOR,
        // Stepped rather than interpolated on the count: the useful distinction
        // is "a few, a handful, a holiday, a decade", and a continuous radius
        // makes ten and eleven look meaningfully different while a hundred and a
        // thousand look the same.
        'circle-radius': [
          'step', ['get', 'point_count'],
          10, 10, 13, 50, 16, 250, 19, 1000, 23,
        ],
        'circle-stroke-width': 1.4,
        'circle-stroke-color': rim,
        // Slightly translucent, so a cluster over a town does not hide the town
        // it is a fact about.
        'circle-opacity': 0.88,
      },
    },
    {
      id: COUNT,
      type: 'symbol',
      source: SOURCE,
      filter: ['has', 'point_count'],
      layout: {
        'text-field': ['get', 'point_count_abbreviated'],
        'text-font': font,
        'text-size': ['step', ['get', 'point_count'], 11, 250, 12, 1000, 13],
        // The number is the label of the disc under it and must never be moved
        // off it by a collision with somebody else's label.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: {
        // White on violet in both themes: the disc is the background here, not
        // the map, so the map's ink is the wrong thing to follow.
        'text-color': '#fff',
        'text-halo-color': 'rgba(60, 20, 100, 0.55)',
        'text-halo-width': 1,
      },
    },
  ];
}

/**
 * Put the overlay on the map, or bring what is there up to date.
 *
 * Idempotent, like the airports': a basemap switch rebuilds the whole style and
 * needs a fresh install, a new scan needs only new data, and the caller should
 * not have to know which case it is in.
 *
 * `window` is `[from, to]` in unix seconds, and narrows the overlay to the
 * photographs taken inside it — the day or the trip the chip is showing. Every
 * picture from every other August is noise while you are looking at one
 * Tuesday, and the overlay is at its least useful exactly when the map is at
 * its most specific.
 */
export function installPhotos(map, { before, theme, font, window = null }) {
  const data = photoGeoJson(points, window);
  if (!map.getSource(SOURCE)) {
    map.addSource(SOURCE, {
      type: 'geojson',
      data,
      cluster: true,
      clusterRadius: CLUSTER_RADIUS,
      clusterMaxZoom: CLUSTER_MAX_ZOOM,
      // What the card can say about a group without fetching a single leaf:
      // when the first and last of them were taken. Everything else it shows is
      // a picture, and a picture has to be asked for one at a time anyway.
      clusterProperties: {
        first: ['min', ['get', 't']],
        last: ['max', ['get', 't']],
      },
      // Points: there is nothing to simplify away, and a dropped photograph is a
      // missing answer rather than a smoother line.
      tolerance: 0,
      buffer: 64,
    });
  } else {
    map.getSource(SOURCE).setData(data);
  }
  for (const layer of photoLayers({ theme, font })) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, before);
  }
}

/** Take it off again — the layers first, then the source they read. */
export function removePhotos(map) {
  for (const id of photoLayerIds()) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  if (map.getSource(SOURCE)) map.removeSource(SOURCE);
}

/**
 * Everything inside a cluster, **newest first**.
 *
 * All of it, however much there is: the card renders the strip in chunks, so a
 * group of four thousand costs four thousand small objects rather than four
 * thousand requests. `limit` exists because `getClusterLeaves` demands one —
 * pass the cluster's own `point_count`.
 *
 * Sorted here rather than left in supercluster's order, which is the order the
 * index happens to hold them in. Newest first because the card opens on the
 * first one: a group of photographs is a place you have been back to, and the
 * one you want is almost always the last time rather than the first. It also
 * matches every other list of photographs anyone uses.
 *
 * **The two libraries disagree about how this answers**, and the disagreement is
 * silent, which is what made it a bug rather than an error. MapLibre returns a
 * promise: `getClusterLeaves(id, limit, offset)`. Mapbox GL JS takes a fourth
 * argument, calls it back, and returns *the source* — so awaiting the call gave
 * back a GeoJSONSource, `.map` was not a function, the catch below swallowed it
 * and every group of photographs on the 3D basemap opened an empty card, which
 * looks exactly like a tap that did not land. Single photographs were fine, and
 * that is the tell: they never go near this function.
 *
 * So it is asked both ways at once. MapLibre ignores the extra argument and is
 * answered by the promise; Mapbox ignores the promise nobody reads and is
 * answered by the callback. Whichever settles first wins, and the other cannot
 * settle twice.
 */
export async function photoLeaves(map, clusterId, limit) {
  const source = map.getSource(SOURCE);
  if (!source) return [];
  try {
    const leaves = await new Promise((resolve, reject) => {
      const returned = source.getClusterLeaves(clusterId, limit, 0, (err, features) => {
        if (err) reject(err);
        else resolve(features ?? []);
      });
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
    });
    return leaves
      .map((f) => ({ i: f.properties.i, t: f.properties.t, v: !!f.properties.v }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
}
