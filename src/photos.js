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
const HOST = 'hexplorePhotos';

// Namespaced like the railway and airport overlays, and for the same reason: a
// basemap is somebody else's style and its layer names are as ordinary as
// `rail`. Ours are ours beyond doubt.
const NS = 'hexplore-photo';
const SOURCE = `${NS}-src`;

// Violet, and chosen by elimination. The visited wash is the accent, which the
// viewer picks and could be anything; a saved route is orange and a shown trip
// is amber. This has to be none of those at a glance on four basemaps, and it
// has to survive being drawn over a satellite photograph, where a warm colour is
// the one thing a photograph is guaranteed to contain.
export const PHOTO_COLOR = '#c07bff';

// How many photographs one card will show. A cluster can hold thousands, and a
// card that tried to be a photo library would be a worse photo library than the
// one already on the phone — this is a glance at what is here, with a way
// through to Photos for the rest.
export const GROUP_MAX = 48;

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
let canOpen = false;

export const photoPoints = () => points;
export const photoCount = () => points.length;
/** Whether iOS is only letting the app see *some* of the library. */
export const photosLimited = () => limited;
/** Whether the card should offer a way through to the Photos app. */
export const canOpenPhotos = () => canOpen;
/** When one photograph was taken, in unix seconds. */
export const photoTime = (i) => points[i]?.[2] ?? null;

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
  canOpen = !!reply.canOpen;
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

/** Open the Photos app. It has no way to be told which photograph — see PhotoLibrary.swift. */
export const openPhotosApp = () => ask({ ask: 'open' });

// --- The layer -------------------------------------------------------------------

/**
 * The features, from the triples the bridge sent.
 *
 * Note the swap: the wire order is `[lat, lng, t]`, because that is the shape a
 * location fix takes everywhere else in this app and a photograph is not worth
 * a second convention — and GeoJSON is `[lng, lat]`. Getting this backwards puts
 * a summer in Zürich somewhere off the coast of Somalia, which is a bug that
 * looks like a data problem.
 *
 * `i` travels as a property rather than as the feature id: with clustering on,
 * the id belongs to the cluster index, and a leaf's is not ours to rely on.
 */
export function photoGeoJson(photos) {
  return {
    type: 'FeatureCollection',
    features: photos.map((p, i) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p[1], p[0]] },
      properties: { i, t: p[2] },
    })),
  };
}

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
 * count. So a group that cannot be broken up stays a group, and tapping it opens
 * the card instead of zooming — see `photoExpansion`.
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
 */
export function installPhotos(map, { before, theme, font }) {
  const data = photoGeoJson(points);
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
 * The zoom at which a cluster would break apart, or null if nothing would.
 *
 * Null is the interesting answer and the reason this is not called inline: a
 * group of photographs taken in one room has no zoom at which it separates, and
 * supercluster says so by naming a zoom past the end of its index. Flying there
 * would land at the map's own ceiling with the same cluster still under the
 * finger, twice, which is how a map teaches somebody that tapping does nothing.
 */
export async function photoExpansion(map, clusterId) {
  const source = map.getSource(SOURCE);
  if (!source) return null;
  try {
    const zoom = await source.getClusterExpansionZoom(clusterId);
    return zoom > map.getMaxZoom() ? null : zoom;
  } catch {
    return null;
  }
}

/**
 * What is inside a cluster, oldest first, capped at `limit`.
 *
 * Sorted here rather than left in supercluster's order, which is the order the
 * index happens to hold them in. A group of photographs is a stretch of time and
 * reads as one — the strip in the card is a morning, not a shuffle.
 */
export async function photoLeaves(map, clusterId, limit = GROUP_MAX) {
  const source = map.getSource(SOURCE);
  if (!source) return [];
  try {
    const leaves = await source.getClusterLeaves(clusterId, limit, 0);
    return leaves
      .map((f) => ({ i: f.properties.i, t: f.properties.t }))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}
