// The train-tracks overlay, lifted out of OpenRailwayMap's own style.
//
//   node scripts/build-rail-style.mjs
//
// OpenRailwayMap publishes a complete MapLibre style at openrailwaymap.app —
// 464 layers describing a whole map, background and hillshade and historical
// geometry included. We want the railways out of it and nothing else, grafted
// onto whichever basemap the app happens to be showing. That is not a URL you
// can point at: a style is a self-contained thing, and four of its assumptions
// stop being true the moment its layers live in somebody else's.
//
//   1. **Its fonts.** The style asks for `OpenRailwayMap-Regular`, `-Bold`,
//      `-Italic` and `FiraCode-Bold` from its own glyph server. A MapLibre style
//      has exactly one `glyphs` URL and the basemap owns it, so those stacks
//      would 404 and every label would silently not draw. `text-font` is
//      replaced with a token the client swaps for `styleFont()` — whatever
//      upright stack the basemap already asks its own glyph server for. The
//      bold/italic distinction is lost because there is nowhere to get it from;
//      one stack is what a foreign glyph server can be relied on to have.
//
//   2. **Its sprites.** Images resolve as `spriteId:name`, *except* for the
//      sprite whose id is `default`, whose images are referenced bare — and the
//      basemap's own sprite is already that one. Adding ORM's under the same id
//      is both impossible and a collision waiting to happen, so both sprites get
//      a namespace here and every image reference is rewritten to match.
//
//   3. **Its ids.** A basemap is somebody else's style and its layer ids are
//      theirs to choose; ours all carry the `hexplore-` prefix so a future
//      basemap cannot quietly take one of our names. Sources and layers alike.
//
//   4. **Its tile URLs.** Relative to their origin, and rewritten to the
//      caching proxy in server/rail-tiles.js — see the usage policy note there.
//
// **Zoom ranges are worked out here rather than asked for.** Their sources are
// declared in the style as TileJSON URLs, and the first version of this fetched
// those at runtime to learn each source's zoom range. That endpoint is one of
// the flakiest things they serve, and the fallback — assume z0–20 — turned every
// outage into a flood: a source with data at z4–7 was then requested at z14,
// where it can only answer with an error, for all six sources at every zoom.
//
// The style already knows. Every layer carries the zooms it draws at, so the
// union over a source's layers *is* that source's range, and a source with any
// layer that has no `maxzoom` is open-ended. Checked against the three of their
// TileJSON documents that were reachable, this reproduces them exactly
// (`…text_stations_low` z4–7, `…_med` z7–8, the standard composite z8 and up).
// It costs no request, cannot go stale differently from the layers it is derived
// from, and works when they are down.
//
// **The build is reproducible.** Nothing here records a timestamp; the output
// carries a hash of the upstream style instead, so rebuilding an unchanged
// upstream reproduces the file byte for byte and `git status` stays quiet.
//
// **What survives untouched is the part worth having**: their zoom ramps, their
// colour ramps, their filters, and the `global-state` switches the style uses
// for its own configuration — construction, proposed, abandoned and razed
// infrastructure, and the light/dark theme, which the client drives from the
// basemap so the overlay recolours with it.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORM_ORIGIN = 'https://openrailwaymap.app';
// Of their several styles (speed, electrification, gauge, signals, operator)
// this is the one that answers "where are the railways" rather than "what is
// this railway like". The others are a picker's worth of work away: their
// sources are already declared in this same file.
const ORM_STYLE = 'standard';

const OUT = path.join(fileURLToPath(new URL('../src', import.meta.url)), 'rail-style.json');

// Everything we add to the map carries this. See note 3 above.
const NS = 'hexplore-orm';
// The two sprites, namespaced. `sdf` is their recolourable set — signals and
// symbols drawn as alpha masks so `icon-color` can tint them — and `default` is
// the full-colour one. Both are needed; the style uses each for different marks.
const SDF_SPRITE = `${NS}-sdf`;
const IMG_SPRITE = NS;
// Stands in for the basemap's own fontstack until the client resolves it. Not a
// plausible font name, because the failure mode of getting this wrong is a
// silently blank label rather than an error.
const FONT_TOKEN = '{basemap-font}';

// Their style describes a whole map. These sources are the rest of it: the
// historical geometry from OpenHistoricalMap, the terrain the hillshade reads,
// and the three empty GeoJSON sources their UI fills in for search results and
// route highlighting. None of it is railways.
const DROP_SOURCES = new Set(['openhistoricalmap', 'dem', 'search', 'route', 'route_stops']);

// What each group of source layers is called in the layers menu, in the order
// they are offered. Every kept layer must land in exactly one of these — the
// test asserts it, so an upstream style that grows a new source layer fails the
// build rather than shipping an overlay with an untoggleable part.
const GROUPS = [
  {
    key: 'linenumbers',
    label: 'Line numbers',
    // The "300" and "330" shields along the track — the line's `ref`, plus the
    // track numbers within a station. They come off the same source layers as
    // the geometry, so they are picked out by name rather than by source: a
    // `match` is tried before `sourceLayers` for exactly this. Their own toggle
    // because they are the densest thing the overlay draws and the first thing
    // anyone wants gone when they are reading the map underneath.
    match: (layer, sourceLayer) =>
      ['railway_line_high', 'standard_railway_line_low'].includes(sourceLayer)
      && (/_text$/.test(layer.id) || layer.id === 'railway_text_track_numbers'),
    sourceLayers: [],
  },
  {
    key: 'tracks',
    label: 'Tracks',
    // The geometry itself, at all three levels of detail the style carries.
    sourceLayers: ['railway_line_high', 'standard_railway_line_low'],
  },
  {
    key: 'stations',
    label: 'Stations',
    sourceLayers: [
      'standard_railway_text_stations',
      'standard_railway_text_stations_low',
      'standard_railway_text_stations_med',
      'standard_railway_grouped_stations',
      'standard_railway_grouped_station_areas',
    ],
  },
  {
    key: 'symbols',
    label: 'Signals & crossings',
    sourceLayers: [
      'standard_railway_symbols',
      'standard_railway_switch_ref',
      'standard_railway_turntables',
      'standard_station_entrances',
      'standard_railway_stop_positions',
    ],
  },
  {
    key: 'platforms',
    label: 'Platforms',
    sourceLayers: ['standard_railway_platforms', 'standard_railway_platform_edges'],
  },
  {
    key: 'milestones',
    label: 'Kilometre posts',
    sourceLayers: ['railway_text_km'],
  },
];

// Required, and stated once per source: MapLibre's attribution control dedupes
// identical strings, so the bar reads "© OpenRailwayMap" however many of these
// are on the map.
const ATTRIBUTION =
  '© <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a>';

// The style properties that name an image in the sprite.
const IMAGE_PROPS = ['icon-image', 'fill-pattern', 'line-pattern', 'background-pattern'];

// Where a source with no upper bound stops. This is OpenRailwayMap's own
// `globalMaxZoom`, not ours — the map here is capped at 17.5, so MapLibre will
// never ask above z17 whatever this says, and pinning it to their number keeps
// the overlay correct if that cap is ever raised.
const SOURCE_MAX_ZOOM = 20;

// Politeness, and their policy's actual requirement: an automated process must
// identify itself and may not fake the header. A build script run by hand a few
// times a year is the least of their traffic, but it says who it is.
const USER_AGENT =
  'HexPlore/0.1 (+https://github.com/zhekch/hexplore; build-rail-style.mjs)';

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/**
 * Rewrite every image name in an expression to its namespaced form.
 *
 * Their style has nine distinct shapes for this and only two behaviours behind
 * them: a name already prefixed `sdf:`, or a bare name resolved against the
 * default sprite. Both appear as string literals *and* as the constant half of
 * a `concat` that builds the rest from a feature property, which is why this
 * walks the expression instead of matching on the whole value.
 *
 * The bare case cannot be spotted from a literal — `["image",["get","feature"]]`
 * has no literal at all — so it is handled by its shape: an `image` operator
 * whose argument contributes no `sdf:` prefix is reading the default sprite, and
 * gets one concatenated on.
 */
function namespaceImages(value) {
  const rewriteLiteral = (s) => (s.startsWith('sdf:') ? `${SDF_SPRITE}:${s.slice(4)}` : s);
  const mentionsSdf = (v) =>
    typeof v === 'string'
      ? v.startsWith('sdf:')
      : Array.isArray(v) && v.some(mentionsSdf);

  const walk = (v) => {
    if (typeof v === 'string') return rewriteLiteral(v);
    if (!Array.isArray(v)) return v;
    // `["literal", x]` is data, not an expression: its contents are never image
    // names to rewrite and recursing into them would corrupt the value.
    if (v[0] === 'literal') return v;
    if (v[0] === 'image' && v.length === 2 && !mentionsSdf(v[1])) {
      return ['image', ['concat', `${IMG_SPRITE}:`, walk(v[1])]];
    }
    return v.map(walk);
  };

  // A bare top-level string ("sdf:general/station-small", or an unprefixed name)
  // is the one case the walk cannot decide from shape alone.
  if (typeof value === 'string') {
    return value.startsWith('sdf:') ? rewriteLiteral(value) : `${IMG_SPRITE}:${value}`;
  }
  return walk(value);
}

/**
 * Collapse every fontstack to the token. See note 1 at the top of this file.
 *
 * `layout.text-font` is the obvious half. The other half hides inside
 * `text-field`: a `format` expression takes per-section options, and three of
 * their station-label layers set `{"text-font": ["literal", ["OpenRailwayMap-
 * Regular"]]}` on a section to give the second line its own face. A section
 * override survives a layer-level rewrite untouched and asks their glyph server
 * for a font it is the only one to have, so that half of the label draws as
 * nothing at all.
 *
 * They are deleted rather than pointed at the token, because a section with no
 * `text-font` inherits the layer's — which is the token — and we have one stack
 * to offer regardless. Restoring the distinction would take a second fontstack
 * the basemap's glyph server has no reason to carry.
 */
function rewriteFonts(layout) {
  if (!layout) return;
  const strip = (v) => {
    if (Array.isArray(v)) return v.forEach(strip);
    if (!v || typeof v !== 'object') return;
    delete v['text-font'];
    Object.values(v).forEach(strip);
  };
  // Every value except the layout's own `text-font`, which is set below.
  for (const [key, value] of Object.entries(layout)) {
    if (key !== 'text-font') strip(value);
  }
  if (layout['text-font']) layout['text-font'] = [FONT_TOKEN];
}

/**
 * Which toggle owns a layer. A `match` wins over a source-layer list, so a
 * group can carve a few layers out of a source that otherwise belongs to
 * another — the line-number shields out of the track geometry.
 */
function groupFor(layer, sourceLayer) {
  return GROUPS.find((g) => g.match?.(layer, sourceLayer))
    ?? GROUPS.find((g) => g.sourceLayers.includes(sourceLayer));
}

async function main() {
  const styleUrl = `${ORM_ORIGIN}/style/${ORM_STYLE}.json`;
  process.stdout.write(`fetching ${styleUrl}\n`);
  const upstream = await fetchJson(styleUrl);

  const upstreamHash = createHash('sha256')
    .update(JSON.stringify(upstream))
    .digest('hex')
    .slice(0, 16);

  // Which sources are actually ours to keep — decided by the layers that use
  // them, so a source the standard style declares for one of the *other* styles
  // (speed, electrification, gauge…) is dropped rather than fetched for nothing.
  const kept = [];
  const usedSources = new Set();
  const ungrouped = new Set();

  for (const layer of upstream.layers) {
    if (!layer.source || DROP_SOURCES.has(layer.source)) continue;
    if (layer.type === 'background') continue;
    const sourceLayer = layer['source-layer'];
    const group = groupFor(layer, sourceLayer);
    if (!group) {
      ungrouped.add(`${layer.source} :: ${sourceLayer}`);
      continue;
    }

    const out = structuredClone(layer);
    out.id = `${NS}-${layer.id}`;
    out.source = `${NS}-${layer.source}`;
    usedSources.add(layer.source);

    for (const prop of IMAGE_PROPS) {
      if (out.layout?.[prop] !== undefined) out.layout[prop] = namespaceImages(out.layout[prop]);
      if (out.paint?.[prop] !== undefined) out.paint[prop] = namespaceImages(out.paint[prop]);
    }
    rewriteFonts(out.layout);

    // Which toggle owns this layer. In `metadata` because that is the one place
    // the style spec promises to leave alone.
    out.metadata = { ...(out.metadata ?? {}), 'hexplore:group': group.key };
    kept.push(out);
  }

  // Which groups read from each sprite, worked out from the rewritten
  // references rather than declared by hand, so it cannot drift from the style.
  const spriteGroups = { [IMG_SPRITE]: new Set(), [SDF_SPRITE]: new Set() };
  for (const layer of kept) {
    const group = layer.metadata['hexplore:group'];
    const seen = [];
    const walk = (v) => {
      if (typeof v === 'string') seen.push(v);
      else if (Array.isArray(v) && v[0] !== 'literal') v.forEach(walk);
    };
    for (const prop of IMAGE_PROPS) {
      if (layer.layout?.[prop] !== undefined) walk(layer.layout[prop]);
      if (layer.paint?.[prop] !== undefined) walk(layer.paint[prop]);
    }
    // Longest prefix first: every `hexplore-orm-sdf:` also starts with
    // `hexplore-orm`, and crediting the wrong sprite would load the wrong 1.5 MB.
    for (const s of seen) {
      if (s.startsWith(`${SDF_SPRITE}:`)) spriteGroups[SDF_SPRITE].add(group);
      else if (s.startsWith(`${IMG_SPRITE}:`)) spriteGroups[IMG_SPRITE].add(group);
    }
  }
  for (const id of Object.keys(spriteGroups)) spriteGroups[id] = [...spriteGroups[id]].sort();

  if (ungrouped.size) {
    // Loud, and fatal. A new source layer upstream is content that would ship
    // with no way to switch it off, which is exactly the thing this overlay was
    // rebuilt to avoid.
    throw new Error(
      `upstream has source layers this build does not group:\n  ${[...ungrouped].join('\n  ')}\n`
      + 'Add them to GROUPS at the top of this file.',
    );
  }

  const sources = {};
  // Which Martin source list each of ours reads, kept *beside* the sources
  // rather than inside them: a source object is validated against the style
  // spec, and an unknown key there is a validation error fired at runtime — the
  // same quiet class of failure as the sprite URLs. This is how the client
  // matches a source to what the server reports about its health.
  const sourceLists = {};
  for (const id of usedSources) {
    const src = upstream.sources[id];
    if (src?.type !== 'vector') throw new Error(`source ${id} is ${src?.type}, expected vector`);
    const mine = kept.filter((l) => l.source === `${NS}-${id}`);
    // The union of what its layers draw. An absent `maxzoom` on any one of them
    // means that layer keeps drawing all the way up, so the source does too.
    const minzoom = Math.min(...mine.map((l) => l.minzoom ?? 0));
    const openEnded = mine.some((l) => l.maxzoom === undefined);
    const maxzoom = openEnded ? SOURCE_MAX_ZOOM : Math.max(...mine.map((l) => l.maxzoom));

    sources[`${NS}-${id}`] = {
      type: 'vector',
      // The proxy, not their origin, and the template directly rather than a
      // TileJSON to go and fetch it from — see the note at the top of this file
      // about what asking them for that at runtime cost.
      tiles: [`/api/rail/tile/${src.url.replace(/^\//, '')}/{z}/{x}/{y}.pbf`],
      minzoom,
      maxzoom,
      // Their features carry a stable OSM-derived id, and promoting it is what
      // makes a clicked feature identifiable and `feature-state` work at all.
      promoteId: src.promoteId ?? 'id',
      attribution: ATTRIBUTION,
    };
    sourceLists[`${NS}-${id}`] = src.url.replace(/^\//, '');
  }

  // Their defaults, verbatim — the style's own answer to what its switches mean
  // when nobody has touched them. The client sets these on the map, because a
  // grafted layer has no stylesheet `state` block to read them from and every
  // unset key evaluates to null.
  const state = Object.fromEntries(
    Object.entries(upstream.state ?? {}).map(([k, v]) => [k, v?.default ?? null]),
  );

  const payload = {
    upstream: { origin: ORM_ORIGIN, style: ORM_STYLE, name: upstream.name, hash: upstreamHash },
    fontToken: FONT_TOKEN,
    // `groups` is which toggles actually reference each sprite, so the client
    // can skip fetching one nothing on screen will draw. It is not a
    // micro-optimisation: the full-colour atlas is 1.5 MB at 2x and exactly one
    // layer — a single expression in "Signals & crossings" — reads from it.
    sprites: [
      { id: IMG_SPRITE, url: '/api/rail/sprite/symbols', groups: spriteGroups[IMG_SPRITE] },
      { id: SDF_SPRITE, url: '/api/rail/sdf-sprite/symbols', groups: spriteGroups[SDF_SPRITE] },
    ],
    attribution: ATTRIBUTION,
    state,
    sources,
    sourceLists,
    layers: kept,
    groups: GROUPS.map(({ key, label }) => ({
      key,
      label,
      layers: kept.filter((l) => l.metadata['hexplore:group'] === key).map((l) => l.id),
    })),
  };

  await writeFile(OUT, JSON.stringify(payload));
  const size = (JSON.stringify(payload).length / 1024).toFixed(0);
  process.stdout.write(
    `wrote ${path.relative(process.cwd(), OUT)} — ${kept.length} layers, `
    + `${Object.keys(sources).length} sources, ${size} KB (upstream ${upstreamHash})\n`,
  );
  for (const g of payload.groups) {
    process.stdout.write(`  ${g.key.padEnd(11)} ${String(g.layers.length).padStart(3)} layers\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e.message ?? e}\n`);
  process.exit(1);
});
