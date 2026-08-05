// What the built train-tracks overlay has to be true of to work at all.
//
//   node scripts/test/rail-style.mjs
//
// `scripts/build-rail-style.mjs` takes OpenRailwayMap's published style apart
// and puts it back together against a basemap that is not theirs. Every check
// here is one of the four assumptions that stops being true in the move — their
// fonts, their sprites, their ids, their tile URLs — and the failure mode of
// each is silence: a label that does not draw, an icon that resolves to nothing,
// a layer quietly overwritten by the basemap's own. None of them throws.
//
// This runs against the committed rail-style.json, so it is also the thing that
// notices when a rebuild against a changed upstream has broken something.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  describeRailFeature, loadRailStyle, mergeRouteDirections, railGroups, railLayerIds, railUrl, splitRouteLabel,
} from '../../src/rail.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const style = JSON.parse(readFileSync(path.join(ROOT, 'src', 'rail-style.json'), 'utf8'));
await loadRailStyle(style);

const IMAGE_PROPS = ['icon-image', 'fill-pattern', 'line-pattern', 'background-pattern'];
const spriteIds = style.sprites.map((s) => s.id);

/** Every string literal an expression can contribute, `literal` data aside. */
function literals(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value) && value[0] !== 'literal') for (const v of value) literals(v, out);
  return out;
}

console.log('\nTheir ids are theirs; ours carry our namespace');
{
  const bad = style.layers.filter((l) => !l.id.startsWith('hexplore-orm-'));
  check(!bad.length, 'every layer id is namespaced', bad.slice(0, 3).map((l) => l.id).join(', '));
  const badSrc = Object.keys(style.sources).filter((s) => !s.startsWith('hexplore-orm-'));
  check(!badSrc.length, 'every source id is namespaced', badSrc.join(', '));
  const dangling = style.layers.filter((l) => !style.sources[l.source]);
  check(!dangling.length, 'no layer names a source that was dropped', dangling.slice(0, 3).map((l) => l.id).join(', '));
  check(style.layers.length > 200, 'the overlay is the whole of their railways', `${style.layers.length} layers`);
}

console.log('\nTheir glyph server is not ours to ask');
{
  const fonts = new Set();
  for (const l of style.layers) {
    const f = l.layout?.['text-font'];
    if (f) fonts.add(JSON.stringify(f));
  }
  check(fonts.size === 1, 'exactly one fontstack survives the build', [...fonts].join(' '));
  check(
    [...fonts][0] === JSON.stringify([style.fontToken]),
    'and it is the token the client swaps for the basemap\'s own',
    [...fonts][0],
  );
  const stillTheirs = JSON.stringify(style.layers).includes('OpenRailwayMap-');
  check(!stillTheirs, 'no layer still asks for a font only their server has');
}

console.log('\nTheir sprites cannot be the default one');
{
  check(spriteIds.length === 2, 'two sprites, both named', spriteIds.join(', '));
  check(
    !spriteIds.includes('default'),
    'neither claims the id whose images are referenced bare — the basemap owns that',
  );

  // Anything that survived as a bare name would silently resolve against the
  // basemap's sprite, which does not have a level crossing in it.
  let refs = 0;
  const unnamespaced = [];
  for (const layer of style.layers) {
    for (const prop of IMAGE_PROPS) {
      const value = layer.layout?.[prop] ?? layer.paint?.[prop];
      if (value === undefined) continue;
      // A plain string is the whole image name; inside an expression only the
      // literals that carry a sprite prefix are, and a `concat` stem is one.
      if (typeof value === 'string') {
        refs++;
        if (!spriteIds.some((id) => value.startsWith(`${id}:`))) unnamespaced.push(`${layer.id}: ${value}`);
        continue;
      }
      // Every image-producing branch must contribute a prefix from somewhere.
      const all = literals(value);
      const prefixes = all.filter((s) => spriteIds.some((id) => s.startsWith(`${id}:`)));
      refs++;
      if (!prefixes.length) unnamespaced.push(`${layer.id}: ${JSON.stringify(value).slice(0, 80)}`);
      if (all.some((s) => s.startsWith('sdf:'))) unnamespaced.push(`${layer.id}: raw sdf: survived`);
    }
  }
  check(refs > 0, 'the overlay does reference images', `${refs} properties`);
  check(!unnamespaced.length, 'every image reference is namespaced', unnamespaced.slice(0, 3).join(' | '));
}

console.log('\nTheir tiles come through the proxy');
{
  const urls = Object.values(style.sources).map((s) => s.tiles?.[0]);
  check(urls.every((u) => u?.startsWith('/api/rail/tile/')), 'every source points at the cache', urls.find((u) => !u?.startsWith('/api/rail/tile/')));
  check(
    !JSON.stringify(style.sources).includes('openrailwaymap.app'),
    'no source reaches their origin directly',
  );
  check(
    Object.values(style.sources).every((s) => !s.url),
    'and none of them asks for a TileJSON at runtime — that endpoint is the flakiest thing they serve',
  );
  check(
    Object.values(style.sources).every((s) => s.promoteId),
    'every source promotes its feature id — the click handler needs it',
  );
  check(
    style.sprites.every((s) => s.url.startsWith('/api/rail/')),
    'the sprites come through it too',
  );
  check(/OpenRailwayMap/.test(style.attribution), 'attribution names them', style.attribution);
}

console.log('\nNo source is asked for a zoom it has no data at');
{
  // The bug this replaced: with no zoom range, a source whose layers draw at
  // z4–7 was requested at z14, where upstream can only answer with an error —
  // for all six sources, at every zoom, on every pan.
  const bad = [];
  for (const [id, src] of Object.entries(style.sources)) {
    if (!Number.isInteger(src.minzoom) || !Number.isInteger(src.maxzoom)) {
      bad.push(`${id}: no range`);
      continue;
    }
    if (src.minzoom > src.maxzoom) bad.push(`${id}: ${src.minzoom} > ${src.maxzoom}`);
    // The range has to cover every layer that reads the source, or the layer is
    // asking for a tile the source says does not exist.
    for (const l of style.layers.filter((l) => l.source === id)) {
      const lo = l.minzoom ?? 0;
      const hi = l.maxzoom ?? Infinity;
      if (lo < src.minzoom) bad.push(`${l.id} draws from z${lo}, source starts at z${src.minzoom}`);
      if (hi !== Infinity && hi > src.maxzoom) bad.push(`${l.id} draws to z${hi}, source ends at z${src.maxzoom}`);
    }
  }
  check(!bad.length, 'every source declares a range that covers its own layers', bad.slice(0, 3).join(' | '));

  // Checked against the three TileJSON documents of theirs that were reachable.
  const range = (name) => {
    const s = style.sources[`hexplore-orm-${name}`];
    return s && `${s.minzoom}-${s.maxzoom}`;
  };
  check(range('standard_railway_text_stations_low') === '4-7', 'the low station source matches their TileJSON', range('standard_railway_text_stations_low'));
  check(range('standard_railway_text_stations_med') === '7-8', 'the med station source matches theirs', range('standard_railway_text_stations_med'));
  check(style.sources['hexplore-orm-openrailwaymap_standard']?.minzoom === 8, 'and the standard composite starts at z8');
}

console.log('\nEvery layer belongs to exactly one toggle');
{
  const grouped = new Map();
  for (const g of style.groups) for (const id of g.layers) grouped.set(id, (grouped.get(id) ?? 0) + 1);
  const missing = style.layers.filter((l) => !grouped.has(l.id));
  const twice = [...grouped.entries()].filter(([, n]) => n > 1);
  check(!missing.length, 'nothing is untoggleable', `${missing.length} orphans`);
  check(!twice.length, 'nothing is in two groups at once', twice.slice(0, 3).map(([id]) => id).join(', '));
  check(style.groups.every((g) => g.layers.length > 0), 'no group is empty', style.groups.filter((g) => !g.layers.length).map((g) => g.key).join(', '));
  check(style.groups.every((g) => g.label), 'every group has something to call it');

  // The "300"/"330" shields are carved out of the track geometry by name, since
  // they share its source layers — the one group that is not a source-layer list.
  const numbers = style.groups.find((g) => g.key === 'linenumbers');
  const inNumbers = new Set(numbers?.layers ?? []);
  check(inNumbers.size > 0, 'the line numbers are their own toggle', String(inNumbers.size));
  check(
    style.layers.filter((l) => /_text$/.test(l.id) && /railway_line_high|standard_railway_line_low/.test(l['source-layer'])).every((l) => inNumbers.has(l.id)),
    'and every ref label is in it',
  );
  check(
    [...inNumbers].every((id) => /_text$|track_numbers$/.test(id)),
    'and nothing that is not a label',
    [...inNumbers].find((id) => !/_text$|track_numbers$/.test(id)),
  );
  // The geometry must not have been dragged along with the labels.
  const tracks = style.groups.find((g) => g.key === 'tracks');
  check((tracks?.layers.length ?? 0) > 200, 'the track geometry stays in Tracks', String(tracks?.layers.length));
  check(railGroups().length === style.groups.length, 'the module reports them all');
  check(railLayerIds().length === style.layers.length, 'and every layer id for the hit test');
}

console.log('\nThe switches their style reads for itself');
{
  // 748 of their expressions consult `theme`, and a grafted layer has no
  // stylesheet `state` block — an unset key evaluates to null, which for those
  // 748 is the difference between railways and nothing at all.
  check('theme' in style.state, 'the theme default is carried over');
  check('showConstructionInfrastructure' in style.state, 'and the infrastructure switches');
  check(Object.keys(style.state).length >= 10, 'along with the rest', `${Object.keys(style.state).length} keys`);
}

console.log('\nEvery URL handed to MapLibre is absolute');
{
  // Two separate ways this went wrong, both of which look fine from the outside.
  //
  // A relative *sprite* URL is refused on the main thread — and refused by
  // firing an error rather than throwing, so the overlay installs completely and
  // the map then goes blank, basemap included, because an unresolved sprite
  // leaves the image manager permanently unready and the renderer will not draw
  // a frame until it is.
  //
  // A relative *tile* template fails somewhere much quieter: MapLibre builds the
  // tile Request inside a web worker, which has no document to resolve against,
  // so every tile dies with "Failed to construct 'Request'" off the main thread
  // while every main-thread signal says the source is loaded.
  const origin = 'https://maps.example';
  for (const [id, src] of Object.entries(style.sources)) {
    const abs = railUrl(src.tiles[0], origin);
    check(/^https?:\/\//.test(abs), `${id.replace('hexplore-orm-', '')} becomes absolute`, abs);
  }
  for (const s of style.sprites) {
    check(/^https?:\/\//.test(railUrl(s.url, origin)), `sprite ${s.id} becomes absolute`);
  }

  // And the trap in the obvious fix: `new URL(path, origin)` normalises, which
  // percent-encodes the placeholders to %7Bz%7D and leaves MapLibre with a
  // template it cannot fill in — every tile then 404s with braces in the path.
  const tpl = railUrl(style.sources['hexplore-orm-high'].tiles[0], origin);
  check(tpl.includes('{z}/{x}/{y}'), 'the tile placeholders survive intact', tpl.slice(-24));
  check(!/%7B/i.test(tpl), 'and are not percent-encoded');
  check(
    new URL(style.sources['hexplore-orm-high'].tiles[0], origin).href.includes('%7B'),
    'which is exactly what URL() would have done — the reason this is concatenation',
  );
  check(railUrl('https://example.com/x/{z}.pbf', origin) === 'https://example.com/x/{z}.pbf', 'an already-absolute URL is left alone');
}

console.log('\nWhat a clicked feature says');
{
  // The real property shape, taken from a decoded tile over the Engstligentunnel.
  const line = describeRailFeature({
    source: 'hexplore-orm-high',
    sourceLayer: 'railway_line_high',
    id: '848948612-0',
    geometry: { type: 'LineString' },
    properties: {
      name: 'Engstligentunnel', ref: '330', track_ref: '712', usage: 'main',
      railway: 'rail', state: 'present', maxspeed: 200, voltage: 15000,
      frequency: 16.700000762939453, gauges: '1435', operator: '{BLS}',
      primary_operator: 'BLS', loading_gauge: 'EBV 1', electrification_state: 'present',
      route_count: 6, osm_id: 12345, osm_type: 'W', way_length: 9999, rank: 110,
      operator_color: '#ca9e40', speed_label: '200',
    },
  });
  const row = (label) => line.rows.find(([l]) => l === label)?.[1];
  check(line.title === 'Engstligentunnel', 'the name becomes the heading', line.title);
  check(!line.rows.some(([l]) => l === 'Name'), 'and is not repeated as a row');
  check(!line.rows.some(([l]) => /length|rank|colour|color|label/i.test(l)), 'the rendering hints do not come through');
  check(line.osm?.url === 'https://www.openstreetmap.org/way/12345', 'the OSM link is built from osm_id/osm_type', line.osm?.url);

  console.log('\n  …and says it in units a person reads');
  // Their tiles hand these over as a float32, a Postgres array literal and bare
  // numbers; none of that belongs on screen.
  check(row('Voltage') === '15 kV', '15000 V reads as 15 kV', row('Voltage'));
  check(row('Frequency') === '16.7 Hz', 'a float32 16.700000762939453 reads as 16.7 Hz', row('Frequency'));
  check(row('Max speed') === '200 km/h', 'speed carries its unit', row('Max speed'));
  check(row('Gauge') === '1435 mm', 'gauge carries its unit', row('Gauge'));
  check(row('Operator') === 'BLS', 'the Postgres array braces are gone', row('Operator'));
  check(line.routeCount === 6, 'the route count comes through for the lazy lookup', String(line.routeCount));
  check(line.source === 'high' && line.sourceLayer === 'railway_line_high', 'and what to ask the feature API with', `${line.source}/${line.sourceLayer}`);

  console.log('\n  …and leaves out what was asked to be left out');
  for (const gone of ['Usage', 'Reference', 'Track', 'Loading gauge', 'Electrification']) {
    check(row(gone) === undefined, `no ${gone} row`, row(gone));
  }

  console.log('\n  …except on a platform, where `ref` is the platform number');
  // The same OSM key that carries a line's route number, which was asked to go.
  // What it means depends on what was clicked, so it is keyed off the source
  // layer rather than off the key.
  const platform = describeRailFeature({
    sourceLayer: 'standard_railway_platforms',
    geometry: { type: 'Polygon' },
    properties: { ref: '3', name: 'Gleis 3', osm_id: 7, osm_type: 'W' },
  });
  check(platform.rows[0]?.[0] === 'Platform', 'a platform leads with its number', JSON.stringify(platform.rows[0]));
  check(platform.rows[0]?.[1] === '3', 'and it is the ref', platform.rows[0]?.[1]);
  const edge = describeRailFeature({
    sourceLayer: 'standard_railway_platform_edges',
    geometry: { type: 'LineString' },
    properties: { ref: '12A', osm_id: 7, osm_type: 'W' },
  });
  check(edge.rows[0]?.[0] === 'Platform edge', 'a platform edge says so', JSON.stringify(edge.rows[0]));
  check(line.rows.every(([l]) => !/^Platform/.test(l)), 'and a plain line still has no ref row');

  console.log('\n  …and the awkward values');
  const dc = describeRailFeature({ geometry: { type: 'LineString' }, properties: { voltage: 750, frequency: 0, osm_id: 1, osm_type: 'W' } });
  const dcRow = (l) => dc.rows.find(([x]) => x === l)?.[1];
  check(dcRow('Voltage') === '750 V', 'below a kilovolt it stays in volts', dcRow('Voltage'));
  check(dcRow('Frequency') === 'DC', '0 Hz is direct current, not "0 Hz"', dcRow('Frequency'));
  const many = describeRailFeature({ geometry: { type: 'LineString' }, properties: { operator: '{SBB,BLS}', gauges: '{1435,1000}', osm_id: 1, osm_type: 'W' } });
  const manyRow = (l) => many.rows.find(([x]) => x === l)?.[1];
  check(manyRow('Operator') === 'SBB, BLS', 'a shared line lists both operators', manyRow('Operator'));
  check(manyRow('Gauge') === '1435, 1000 mm', 'and a dual-gauge line both gauges', manyRow('Gauge'));

  const node = describeRailFeature({
    geometry: { type: 'Point' },
    properties: { feature: 'level_crossing', osm_id: 7, osm_type: 'N' },
  });
  check(node.title === 'Railway', 'something unnamed still gets a heading', node.title);
  check(node.subtitle === 'level crossing', 'the feature kind is readable', node.subtitle);
  check(node.osm.type === 'node', 'a node links as a node');

  const implied = describeRailFeature({ geometry: { type: 'Point' }, properties: { osm_id: 9 } });
  check(implied.osm.type === 'node', 'a missing osm_type falls back to the geometry', implied.osm?.type);

  const arrays = describeRailFeature({
    geometry: { type: 'LineString' },
    properties: { operator: '["SBB","BLS"]', osm_id: 1, osm_type: 'W' },
  });
  check(
    arrays.rows.some(([l, v]) => l === 'Operator' && v === 'SBB, BLS'),
    'a JSON array property reads as a list',
    JSON.stringify(arrays.rows),
  );

  check(describeRailFeature({ properties: {} }) === null, 'a feature with nothing to say opens no card');
  check(describeRailFeature(null) === null, 'and neither does no feature at all');
}

console.log('\nA route and its return working are one line');
{
  // Exactly what their API returned for the Engstligentunnel: six relations,
  // three services.
  const merged = mergeRouteDirections([
    { label: 'IC 8: Brig => Romanshorn', color: '#1a8fce' },
    { label: 'IC 8: Romanshorn => Brig', color: '#1a8fce' },
    { label: 'IC 6: Brig => Basel SBB', color: '#93c13e' },
    { label: 'IC 6: Basel SBB => Brig', color: '#93c13e' },
    { label: 'EC: Milano Centrale => Basel SBB', color: null },
    { label: 'EC: Basel SBB => Milano Centrale', color: null },
  ]);
  check(merged.length === 3, 'six relations become three services', String(merged.length));
  check(merged[0].label === 'IC 8: Brig \u2194 Romanshorn', 'and read as both directions, with a real arrow', merged[0].label);
  check(merged[2].label === 'EC: Milano Centrale \u2194 Basel SBB', 'including the unnumbered ones', merged[2].label);
  check(merged[1].color === '#93c13e', 'the colour survives the fold', merged[1].color);

  // Only a genuine there-and-back folds.
  const distinct = mergeRouteDirections([
    { label: 'IC 6: Brig => Basel SBB', color: null },
    { label: 'IR 15: Brig => Basel SBB', color: null },
  ]);
  check(distinct.length === 2, 'two services over the same pair stay separate', String(distinct.length));

  const oneWay = mergeRouteDirections([{ label: 'S1: Bern => Thun', color: null }]);
  check(oneWay[0].label === 'S1: Bern \u2192 Thun', 'one direction keeps a one-way arrow', oneWay[0].label);

  // Plenty of relations name their via-points. Splitting on only the first `=>`
  // would read wrong *and* stop the return working matching, since its stops are
  // the same list backwards.
  const via = mergeRouteDirections([
    { label: 'R1: Grandson => Lausanne => Bex', color: '#c00' },
    { label: 'R1: Bex => Lausanne => Grandson', color: '#c00' },
  ]);
  check(via.length === 1, 'a journey with via-points still folds with its return', String(via.length));
  check(via[0].label === 'R1: Grandson \u2194 Lausanne \u2194 Bex', 'and every leg gets an arrow', via[0].label);
  const viaOne = mergeRouteDirections([{ label: 'R1: Grandson => Lausanne => Bex', color: null }]);
  check(viaOne[0].label === 'R1: Grandson \u2192 Lausanne \u2192 Bex', 'one-way keeps its direction through the vias', viaOne[0].label);

  const odd = mergeRouteDirections([{ label: 'Gotthardbahn', color: null }]);
  check(odd[0].label === 'Gotthardbahn', 'and so is a label that is not a direction at all', odd[0].label);

  // Where a label too wide for the card should break.
  const long = splitRouteLabel('GoldenPass Express: Interlaken Ost \u2194 Zweisimmen');
  check(long.name === 'GoldenPass Express:', 'the service name is its own piece', long.name);
  check(long.ends === 'Interlaken Ost \u2194 Zweisimmen', 'and the journey stays whole', long.ends);
  const bare = splitRouteLabel('Gotthardbahn');
  check(bare.name === '' && bare.ends === 'Gotthardbahn', 'a label with no service name is all journey', JSON.stringify(bare));
  // OSM tags are typed by people.
  check(splitRouteLabel('IC 1 :  Bern  \u2194  Thun').name === 'IC 1:', 'stray spacing is tidied', splitRouteLabel('IC 1 :  Bern  \u2194  Thun').name);
  check(splitRouteLabel('IC 1 :  Bern  \u2194  Thun').ends === 'Bern \u2194 Thun', 'on both sides of the colon', splitRouteLabel('IC 1 :  Bern  \u2194  Thun').ends);

  const colourless = mergeRouteDirections([
    { label: 'RE: A => B', color: null },
    { label: 'RE: B => A', color: '#abc123' },
  ]);
  check(colourless[0].color === '#abc123', 'a colour on either direction is kept', colourless[0].color);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
