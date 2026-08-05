// The train-tracks overlay: OpenRailwayMap's own style, grafted onto whichever
// basemap is showing.
//
// The overlay used to be one raster layer — `standard/{z}/{x}/{y}.png` from
// openrailwaymap.org, drawn at 85% opacity and switched on or off as a single
// thing. That is all a raster overlay can be: by the time the level crossings,
// the kilometre posts and the switch numbers arrive they are pixels, and
// nothing on this side can filter them, recolour them or say what one of them
// is. This module is the same content as vector tiles, which makes all three
// possible and costs a style of our own to carry.
//
// **The style is built, not fetched.** `scripts/build-rail-style.mjs` takes
// their published style apart and emits `rail-style.json`; read the note at the
// top of that file for what has to be rewritten and why. What arrives here is
// 288 layers that are ready to add except for two things only the running map
// knows — the basemap's fontstack, and which theme it is.
//
// **It is a dynamic import**, like the gazetteer and the boundaries: 315 KB that
// a session which never switches the overlay on should not pay for. The tiles
// behind it come from `/api/rail/*`, which is a caching proxy — see
// server/rail-tiles.js, and read its policy note before making the map ask for
// more than it does.

// The `hexplore-orm-` namespace every id in the overlay carries is baked into
// rail-style.json by the build, not repeated here: one place decides it, and it
// is the place that writes the ids.

/**
 * A path from the built style, as a URL MapLibre will accept.
 *
 * Both the sprites and the tile templates have to be absolute — see the notes
 * where each is used — and the build cannot write them that way because the
 * origin is not a thing a build knows. Deliberately string concatenation and
 * not `new URL(path, origin)`: `URL` normalises, and normalising a tile template
 * percent-encodes the placeholders into `%7Bz%7D/%7Bx%7D/%7By%7D`, which
 * MapLibre then cannot substitute — every tile is requested with the braces
 * still in the path and every one of them 404s.
 */
export const railUrl = (path, origin = location.origin) =>
  (/^https?:\/\//.test(path) ? path : origin + path);

/**
 * A number, without the decimals nobody asked for.
 *
 * `16.700000762939453` is a float32 that came out of a database as 16.7, and
 * printing it in full is a way of telling someone their railway is imprecise
 * rather than that our arithmetic is.
 */
const round = (n, dp) => String(Number(Number(n).toFixed(dp)));

/**
 * Whatever shape the value arrived in, as a list.
 *
 * Their tiles carry arrays as **PostgreSQL array literals** — `{BLS}`, or
 * `{SBB,BLS}` for a shared line — which is what put the braces on screen. Their
 * feature API hands back real JSON arrays for the same fields. Both are answered
 * here so a value reads as "SBB, BLS" whichever door it came through.
 */
function asList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const text = String(value);
  if (/^\{.*\}$/.test(text)) {
    return text.slice(1, -1).split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
  }
  if (/^\[.*\]$/.test(text)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* not JSON after all */ }
  }
  return text ? [text] : [];
}

// Which properties are worth putting in a popup, in the order they read best,
// and how to say each one. The tiles carry thirty-odd keys and most of them are
// rendering hints — `rank`, `way_length`, `operator_color`, `speed_label` — so
// this is a curated list, and every entry that is a quantity carries its unit.
// `usage` ("main", "branch") is deliberately absent: it duplicates what the line
// weight is already saying and is jargon besides.
const POPUP_FIELDS = [
  ['name', 'Name', String],
  // `primary_operator` is the plain string; `operator` is the array of all of
  // them. Preferring the array keeps a shared line honest, and asList strips the
  // braces either way.
  ['operator', 'Operator', (v) => asList(v).join(', ')],
  ['primary_operator', 'Operator', String],
  ['railway', 'Type', String],
  ['service', 'Service', String],
  ['state', 'State', String],
  // 15000 → "15 kV", 1500 → "1.5 kV", 750 → "750 V".
  ['voltage', 'Voltage', (v) => (Number(v) >= 1000 ? `${round(Number(v) / 1000, 2)} kV` : `${round(v, 0)} V`)],
  // 16.700000762939453 → "16.7 Hz"; 0 means direct current, not "0 Hz".
  ['frequency', 'Frequency', (v) => (Number(v) === 0 ? 'DC' : `${round(v, 2)} Hz`)],
  ['gauges', 'Gauge', (v) => `${asList(v).join(', ')} mm`],
  ['maxspeed', 'Max speed', (v) => `${round(v, 0)} km/h`],
];

// How OpenRailwayMap spells the three OSM element types in its tiles.
const OSM_TYPES = { N: 'node', W: 'way', R: 'relation' };

let STYLE = null;
let loading = null;

/**
 * Kick off (or reuse) the one-time load of the built overlay style.
 *
 * `data` is for callers without a bundler, exactly as in loadCountries and
 * loadRegions: plain Node needs an import attribute to read JSON that Vite does
 * not want, so a test parses rail-style.json itself and hands it over.
 */
export function loadRailStyle(data) {
  if (!loading) {
    loading = (data ? Promise.resolve({ default: data }) : import('./rail-style.json')).then((m) => {
      STYLE = m.default;
      return STYLE;
    });
  }
  return loading;
}

export const railStyleLoaded = () => STYLE !== null;
export const railGroups = () => STYLE?.groups ?? [];

/**
 * How deep it is worth asking each source for, as the server currently sees it.
 *
 * Never fatal: if this cannot be reached the overlay installs at the style's own
 * zoom ranges, which is what it did before any of this existed.
 */
export async function railDetail() {
  try {
    const res = await fetch('/api/rail/detail', { credentials: 'same-origin' });
    if (!res.ok) return { detail: {}, degraded: null };
    const body = await res.json();
    return { detail: body.detail ?? {}, degraded: body.degraded ?? null };
  } catch {
    return { detail: {}, degraded: null };
  }
}

/** Whether two detail reports differ, and so whether a rebuild is warranted. */
export function railDetailChanged(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a ?? {})[k] !== (b ?? {})[k]) return true;
  return false;
}

/**
 * Every layer id the overlay owns, whether or not it is currently visible.
 * Used to scope `queryRenderedFeatures` to us — a click must not report the
 * basemap's own railways, which are the less detailed answer this whole overlay
 * exists to draw over.
 */
export const railLayerIds = () => (STYLE?.layers ?? []).map((l) => l.id);

/**
 * Add the overlay's layers, without validating what a build already validated.
 *
 * 288 layers took **1.7 seconds** to add, and 92% of that was MapLibre checking
 * each one against the style spec — 995 ms with validation, 79 ms without,
 * measured on the real overlay. That check is worth having for a layer somebody
 * typed; these are generated by `scripts/build-rail-style.mjs` from a transform
 * that `npm test` exercises on every run, and re-proving it in the browser on
 * every switch-on and every basemap change is the same answer bought at the cost
 * of a visible wait.
 *
 * `Style.addLayer` takes the flag and `Map.addLayer` does not pass one on, hence
 * reaching past it — the one place in this file that touches MapLibre's
 * internals. Both are feature-detected and the supported path is still there
 * underneath, so a future version that renames either is slow rather than
 * broken. `_update(true)` at the end is not optional: without it `_styleDirty`
 * stays false, `Style.update()` never runs, and the sources sit paused with
 * their tiles unrequested.
 */
function addLayers(map, layers, before) {
  const style = map.style;
  if (typeof style?.addLayer !== 'function' || typeof map._update !== 'function') {
    for (const layer of layers) map.addLayer(layer, before);
    return;
  }
  try {
    for (const layer of layers) style.addLayer(layer, before, { validate: false });
  } catch (e) {
    // Half a style is not a state to leave a map in; finish on the slow path.
    console.warn('Rail overlay: fast layer install failed, falling back.', e);
    for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer, before);
  }
  map._update(true);
}

/**
 * Substitute the basemap's fontstack for the token the build left behind.
 *
 * Their style asks for `OpenRailwayMap-Regular` and friends from their own
 * glyph server, and a style has one `glyphs` URL which the basemap owns — so a
 * label in their font is a label that silently never draws. `styleFont()` in
 * main.js answers what the basemap does serve; the bold and italic variants are
 * lost with nowhere to get them from.
 */
function withFont(layer, font) {
  if (!layer.layout?.['text-font']) return layer;
  return { ...layer, layout: { ...layer.layout, 'text-font': font } };
}

/**
 * Put the overlay on the map.
 *
 * @param {maplibregl.Map} map
 * @param {object} opts
 * @param {string[]} opts.font what styleFont() returned for this basemap
 * @param {'light'|'dark'} opts.theme the basemap's theme, handed to the style's
 *   own `theme` switch so the railways recolour with the map under them
 * @param {string|undefined} opts.before the layer to insert beneath
 * @param {Record<string, boolean>} opts.groups which groups are switched on
 * @param {Record<string, number>} [opts.detail] the deepest zoom worth asking
 *   each Martin source list for, from `/api/rail/detail`
 */
export function installRail(map, { font, theme, before, groups, detail = {} }) {
  if (!STYLE || map.getLayer(STYLE.layers[0].id)) return;

  // Their sprites, under our namespace. Images resolve as `spriteId:name`
  // except for the sprite called `default`, whose names are bare — and the
  // basemap is already that one, so ORM's cannot be added under it and every
  // reference in the built style was rewritten to match these ids.
  //
  // **Absolute, and this matters far more than it looks.** MapLibre rejects a
  // relative sprite URL outright ("must be absolute"), and it rejects it by
  // firing an error rather than throwing — so the overlay installs, every layer
  // and source lands, every check says it worked, and the map goes completely
  // blank. Not just the railways: a sprite that never resolves leaves the image
  // manager permanently unready, and the renderer will not draw a frame until it
  // is, so the basemap disappears too. The built style stores the path, because
  // the origin is not a thing a build can know; this is where it becomes a URL.
  // Only the sprites something switched on will actually draw from. The
  // full-colour atlas is 1.5 MB at 2x and is read by a single expression in
  // "Signals & crossings"; with that group off it is 1.5 MB fetched, decoded and
  // uploaded to the GPU so that nothing can use it.
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE.sprites) {
    if (have.has(sprite.id)) continue;
    if (!sprite.groups?.some((g) => groups[g] !== false)) continue;
    map.addSprite(sprite.id, railUrl(sprite.url));
  }

  // Absolute here too, and for a stranger reason than the sprites above.
  // MapLibre builds the tile `Request` inside a **web worker**, and a worker has
  // no document to resolve a root-relative URL against — so `/api/rail/tile/…`
  // dies there with "Failed to construct 'Request': Failed to parse URL", one
  // line per tile, off the main thread. The main thread meanwhile reports the
  // source as loaded and `transformRequest` still fires, so every signal short
  // of the console says the overlay is working while not one tile is fetched.
  for (const [id, source] of Object.entries(STYLE.sources)) {
    if (map.getSource(id)) continue;
    map.addSource(id, {
      ...source,
      tiles: source.tiles.map((t) => railUrl(t)),
      // Capped to what the server says is currently answerable. MapLibre then
      // asks for the parent tile and overzooms it — coarser, but railways on
      // screen rather than a blank where their CDN has no cached copy. It does
      // the rescaling itself and correctly, which is why this is a `maxzoom`
      // and not something clever with the tile URLs.
      maxzoom: Math.min(source.maxzoom, detail[STYLE.sourceLists[id]] ?? Infinity),
    });
  }

  // A grafted layer has no stylesheet `state` block to read defaults from, and
  // every unset key evaluates to null — which for a style that consults `theme`
  // 748 times is the difference between railways and nothing at all.
  for (const [key, value] of Object.entries(STYLE.state)) {
    map.setGlobalStateProperty(key, value);
  }
  map.setGlobalStateProperty('theme', theme);

  // In their order, each beneath the same anchor, so the 288 layers keep the
  // relative order their style put them in.
  addLayers(map, STYLE.layers.map((layer) => {
    const on = groups[layer.metadata['hexplore:group']] !== false;
    const withVisibility = on
      ? layer
      : { ...layer, layout: { ...layer.layout, visibility: 'none' } };
    return withFont(withVisibility, font);
  }), before);
}

/**
 * Take it all off again.
 *
 * `keepSprites` is for the one caller that is putting the overlay straight back:
 * a source's `maxzoom` cannot be changed in place, so a new detail ceiling means
 * remove-and-re-add, and dropping the sprites in the middle of that is not a
 * detail. An image manager with a sprite in flight is not ready, and MapLibre
 * will not draw a *frame* until it is — so the whole map, basemap included,
 * blinks out for as long as 2.25 MB of atlas takes to fetch, decode and upload.
 * Zooming in is exactly what moves the ceiling, so that read as "the railways
 * disappear when I zoom in". The sprites are unchanged by a zoom range; leaving
 * them alone costs nothing and keeps the rebuild invisible.
 */
export function removeRail(map, { keepSprites = false } = {}) {
  if (!STYLE) return;
  for (const layer of STYLE.layers) {
    if (map.getLayer(layer.id)) map.removeLayer(layer.id);
  }
  for (const id of Object.keys(STYLE.sources)) {
    if (map.getSource(id)) map.removeSource(id);
  }
  if (keepSprites) return;
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE.sprites) {
    if (have.has(sprite.id)) map.removeSprite(sprite.id);
  }
}

/**
 * Show or hide one group.
 *
 * Visibility rather than adding and removing the layers: the tiles are already
 * fetched and cached, so switching the kilometre posts back on should cost
 * nothing at all — and it keeps the group's layers in their original position
 * in the stack rather than re-adding them on top.
 */
export function setRailGroup(map, key, on) {
  for (const group of railGroups()) {
    if (group.key !== key) continue;
    for (const id of group.layers) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }
  if (!on) return;
  // A group whose sprite was skipped at install because it was switched off then
  // needs it now. Not removed on the way back down: the atlas is already paid
  // for, and dropping it would only make switching the group on again slow.
  const have = new Set((map.getSprite() ?? []).map((s) => s.id));
  for (const sprite of STYLE?.sprites ?? []) {
    if (!have.has(sprite.id) && sprite.groups?.includes(key)) {
      map.addSprite(sprite.id, railUrl(sprite.url));
    }
  }
}

/**
 * What a clicked railway feature says about itself, as plain data.
 *
 * Everything here is already in the tile that drew the line. The services that
 * run over it are not — see `railRoutes` — so they arrive separately and later.
 *
 * @returns {{title: string, subtitle: string|null, rows: [string, string][],
 *   osm: {type: string, id: string, url: string}|null,
 *   routeCount: number, source: string|null, sourceLayer: string|null,
 *   id: string|null}|null}
 */
export function describeRailFeature(feature) {
  const p = feature?.properties;
  if (!p) return null;

  const rows = [];
  const seen = new Set();
  for (const [key, label, format] of POPUP_FIELDS) {
    const value = p[key];
    if (value === undefined || value === null || value === '') continue;
    // Two keys can carry one label — `operator` and `primary_operator` both say
    // who runs it — and the first with a value wins.
    if (seen.has(label)) continue;
    let text;
    try {
      text = format(value);
    } catch {
      text = String(value);
    }
    if (!text || text === 'NaN' || /^\s*$/.test(text)) continue;
    seen.add(label);
    rows.push([label, text]);
  }

  // `name` is the heading rather than a row when it is there at all.
  const named = rows.findIndex(([label]) => label === 'Name');
  const title = named >= 0 ? rows.splice(named, 1)[0][1] : (p.localized_name ?? null);

  // On a platform, `ref` is the platform number — "4", "12A" — which is the one
  // thing anybody standing on one wants to read. It is the same OSM key that
  // carries a line's route number, and that one was asked to go, so this is
  // keyed off what was clicked rather than off the key alone.
  if (/platform/.test(feature.sourceLayer ?? '') && p.ref) {
    rows.unshift([/edges/.test(feature.sourceLayer) ? 'Platform edge' : 'Platform', String(p.ref)]);
  }

  const osmId = Array.isArray(p.osm_id) ? p.osm_id[0] : p.osm_id;
  const osmType = OSM_TYPES[Array.isArray(p.osm_type) ? p.osm_type[0] : p.osm_type]
    // Their tiles leave the type off when it is implied by the geometry.
    ?? (feature.geometry?.type === 'Point' ? 'node' : 'way');
  const osm = osmId
    ? { type: osmType, id: String(osmId), url: `https://www.openstreetmap.org/${osmType}/${osmId}` }
    : null;

  if (!title && !rows.length && !osm) return null;
  return {
    title: title || 'Railway',
    subtitle: p.feature ? String(p.feature).replace(/_/g, ' ') : null,
    rows,
    osm,
    // How many route relations run over this line. The tile knows the count but
    // not the names, which is what makes the request below worth making.
    routeCount: Number(p.route_count) || 0,
    // What `railRoutes` needs to ask for them.
    source: feature.source ? String(feature.source).replace(/^hexplore-orm-/, '') : null,
    sourceLayer: feature.sourceLayer ?? null,
    id: feature.id != null ? String(feature.id) : null,
  };
}

/**
 * The services that run over a line — "IC 8: Brig => Romanshorn" and the rest.
 *
 * The only thing in the card that is not already in the tile. Route membership
 * is a relation, and a vector tile carries `route_count` but not the relations
 * themselves, so this is a request — one per click, on a line the person just
 * asked about, which is a very different thing from one per tile. It goes
 * through the same cache as everything else, and it is answered by their `api`
 * container rather than their tile server, which is why it kept working through
 * the outage that took the tiles down.
 *
 * Never fatal: no routes shown is the same card without a line in it.
 */
// Real arrows, not ASCII. `=>` is how the tag is written, not how it should be
// read — and a route with via-points reads as a journey when it is set with the
// right glyph: "R1: Grandson → Lausanne → Bex".
const ARROW_ONE_WAY = '→';
const ARROW_BOTH_WAYS = '↔';

/**
 * Tidy the spacing OSM put in the name.
 *
 * These labels are built from relation tags, and tags are typed by people:
 * "IC 1 : Stuttgart" and doubled spaces both turn up. Collapsing runs of
 * whitespace and closing the gap before a colon costs nothing and is the
 * difference between a card that looks composed and one that looks glitched.
 */
const tidyLabel = (s) => String(s).replace(/\s+/g, ' ').replace(/\s+([:,])/g, '$1').trim();

/**
 * A route label split where it should break: after the service name.
 *
 * "GoldenPass Express: Interlaken Ost <=> Zweisimmen" is wider than the card,
 * and left to itself the browser breaks at whichever space happens to fall at
 * the edge — usually mid-journey, stranding "Zweisimmen" or the arrow on a line
 * of its own. The two parts are rendered separately so the endpoints wrap as one
 * unit, which puts the break after the colon where a reader expects it.
 */
export function splitRouteLabel(label) {
  const m = /^(.*?:)\s*(.+)$/.exec(tidyLabel(label));
  return m ? { name: m[1], ends: m[2] } : { name: '', ends: tidyLabel(label) };
}

/**
 * A route label as a service name and the places it calls at.
 *
 * Split on every `=>`, not just the first: plenty of relations name their
 * via-points, and treating "Grandson => Lausanne => Bex" as a pair would both
 * read wrong and stop it matching its own return working, whose stops are the
 * same list backwards.
 */
export function parseRouteLabel(label) {
  const { name, ends } = splitRouteLabel(label);
  return { name, stops: ends.split(/\s*=>\s*/).map((s) => s.trim()).filter(Boolean) };
}

/**
 * Fold a route and its return working into one line.
 *
 * OSM models each direction as its own relation, so a line through a station
 * lists "IC 6: Brig => Basel SBB" and "IC 6: Basel SBB => Brig" — six entries
 * for what a passenger would call three services. Matched on the service name
 * plus the unordered pair of endpoints, so only a genuine there-and-back is
 * folded; two different services between the same towns keep their own lines.
 * The direction that was listed first sets the order, and `<=>` says it runs
 * both ways.
 */
export function mergeRouteDirections(routes) {
  const byKey = new Map();
  const out = [];
  for (const route of routes) {
    const label = tidyLabel(route.label);
    const { name, stops } = parseRouteLabel(label);
    if (stops.length < 2) { out.push({ ...route, label }); continue; }
    // Canonical either way round, so a journey and its return working land on
    // the same key however they were listed.
    const forward = stops.join(' ');
    const backward = [...stops].reverse().join(' ');
    const key = `${name}|${forward < backward ? forward : backward}`;
    const seen = byKey.get(key);
    if (seen) {
      seen.both = true;
      // A route with a colour beats one without; theirs is blank often enough.
      seen.color ??= route.color;
      continue;
    }
    const entry = { ...route, label, name, stops };
    byKey.set(key, entry);
    out.push(entry);
  }
  return out.map(({ name, stops, both, ...rest }) => {
    if (!stops) return rest;
    const arrow = both ? ARROW_BOTH_WAYS : ARROW_ONE_WAY;
    return { ...rest, label: `${name} ${stops.join(` ${arrow} `)}`.trim() };
  });
}

export async function railRoutes({ source, sourceLayer, id }) {
  if (!source || !sourceLayer || !id) return [];
  const path = [source, sourceLayer, id].map(encodeURIComponent).join('/');
  try {
    const res = await fetch(`/api/rail/feature/${path}`, { credentials: 'same-origin' });
    if (!res.ok) return [];
    const body = await res.json();
    return mergeRouteDirections(
      (body.line_routes ?? [])
        .map((r) => ({ label: String(r.label ?? '').trim(), color: r.color || null }))
        .filter((r) => r.label),
    );
  } catch {
    return [];
  }
}
