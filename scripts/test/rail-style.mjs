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
  describeRailFeature, loadRailStyle, mergeRouteDirections, railGroupOn, railGroups, railLayerIds,
  railUrl, splitRouteLabel, technicalFilter, RAIL_GROUP_DEFAULTS,
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
  check(row('Track') === '712', 'the track number in a station is the row that says which line was clicked', row('Track'));

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
  for (const gone of ['Usage', 'Reference', 'Loading gauge', 'Electrification']) {
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
  check(node.title === 'Level crossing', 'something unnamed is headed by what it is', node.title);
  check(node.subtitle === null, 'and does not then repeat it underneath', node.subtitle);
  check(node.osm.type === 'node', 'a node links as a node');
  const named = describeRailFeature({
    geometry: { type: 'Point' },
    properties: { name: 'Spiez', feature: 'station', osm_id: 7, osm_type: 'N' },
  });
  check(named.title === 'Spiez' && named.subtitle === 'station', 'a named one keeps both', `${named.title} / ${named.subtitle}`);

  // The tiles are asked for in English (see TILE_LANG in server/rail-tiles.js),
  // so a station in Tokyo is labelled "Tokyo" on the map — and a card headed
  // 東京 over it would be the two disagreeing about the same station.
  const rowOf = (card, label) => card.rows.find(([l]) => l === label)?.[1];
  const tokyo = describeRailFeature({
    geometry: { type: 'Point' },
    properties: { name: '東京', localized_name: 'Tokyo', feature: 'station', osm_id: 7, osm_type: 'N' },
  });
  check(tokyo.title === 'Tokyo', 'a card is headed by the name the map drew', tokyo.title);
  check(rowOf(tokyo, 'Local name') === '東京', 'and keeps what is written on the platform', rowOf(tokyo, 'Local name'));
  const bern = describeRailFeature({
    geometry: { type: 'Point' },
    properties: { name: 'Bern', localized_name: 'Bern', feature: 'station', osm_id: 7, osm_type: 'N' },
  });
  check(bern.title === 'Bern', 'a place with one name is headed by it', bern.title);
  check(!rowOf(bern, 'Local name') && !rowOf(bern, 'Name'), 'and does not print it twice');

  const implied = describeRailFeature({ geometry: { type: 'Point' }, properties: { osm_id: 9 } });
  check(implied.osm.type === 'node', 'a missing osm_type falls back to the geometry', implied.osm?.type);

  console.log('\n  …and their tiles carry no osm_id at all');
  // The pair above is their *feature API's*; a tile carries the feature's own
  // `id`, which is the same fact spelled two ways. Reading only osm_id meant the
  // link could never appear — and, far worse, that a platform whose relation is
  // unnamed and unnumbered had nothing to say and so opened no card. Thun's
  // platforms are named "Thun" and opened one; Spiez's are named nothing and the
  // tap fell straight through to the ground.
  const spiez = describeRailFeature({
    source: 'hexplore-orm-openrailwaymap_standard',
    sourceLayer: 'standard_railway_platforms',
    id: 'relation-9068328',
    geometry: { type: 'Polygon' },
    properties: { id: 'relation-9068328', feature: 'platform' },
  });
  check(!!spiez, 'an unnamed, unnumbered platform still opens a card');
  check(spiez?.title === 'Platform', 'headed by what it is', spiez?.title);
  check(spiez?.osm?.url === 'https://www.openstreetmap.org/relation/9068328', 'and linked from its own id', spiez?.osm?.url);
  check(spiez?.mayHaveRoutes === true, 'and asks their API which services call there');
  const segmented = describeRailFeature({
    source: 'hexplore-orm-high',
    sourceLayer: 'railway_line_high',
    id: '988282659-0',
    geometry: { type: 'LineString' },
    properties: { id: '988282659-0', feature: 'rail' },
  });
  check(segmented?.osm?.url === 'https://www.openstreetmap.org/way/988282659', 'a track drops the segment suffix and links to its way', segmented?.osm?.url);
  check(segmented?.title === 'Railway', 'and "rail" is still called a railway', segmented?.title);
  // A kilometre post's id has exactly the same shape and is a node, so the bare
  // form is only read where the element type is a fact about the source layer.
  const post = describeRailFeature({
    sourceLayer: 'railway_text_km',
    geometry: { type: 'Point' },
    properties: { id: '12572209414-1', feature: 'milestone' },
  });
  check(post?.osm == null, 'a kilometre post is not guessed to be a way', JSON.stringify(post?.osm));

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

console.log('\nAnd "and then" is not always spelled `=>`');
{
  // Both real, and both used to print as one undivided run of text with no
  // arrows in it at all, because `=>` was the only separator this knew.
  const dashed = mergeRouteDirections([{ label: 'TGV 511: Paris -- Toulon -- Hyères', color: null }]);
  check(dashed[0].label === 'TGV 511: Paris → Toulon → Hyères', 'a double dash is a journey', dashed[0].label);
  const single = mergeRouteDirections([{ label: 'TER Morez - Saint-Claude - (Lyon)', color: null }]);
  check(single[0].label === 'TER Morez → Saint-Claude → (Lyon)', 'and so is a single one', single[0].label);

  // The whole of what keeps that from cutting place names in half is the
  // whitespace either side, so this is the check that matters most here.
  check(
    single[0].label.includes('Saint-Claude'),
    'a hyphen inside a name is not a separator',
    single[0].label,
  );
  for (const name of ['Baden-Baden', 'Aix-en-Provence', 'Villeneuve-Saint-Georges']) {
    const kept = mergeRouteDirections([{ label: `TER: ${name} - Paris`, color: null }]);
    check(kept[0].label === `TER: ${name} → Paris`, `${name} survives intact`, kept[0].label);
  }

  const arrowed = mergeRouteDirections([{ label: 'S1: Bern -> Thun', color: null }]);
  check(arrowed[0].label === 'S1: Bern → Thun', 'an ASCII arrow is one too', arrowed[0].label);
  // A dash and its return working still fold, which is the point of doing this
  // in the parser rather than in the renderer.
  const both = mergeRouteDirections([
    { label: 'TER: Morez - Saint-Claude', color: null },
    { label: 'TER: Saint-Claude - Morez', color: null },
  ]);
  check(both.length === 1 && both[0].label === 'TER: Morez ↔ Saint-Claude', 'and fold with their return working', JSON.stringify(both));
}

console.log('\nWhat is drawn before anybody chooses');
{
  // The overlay draws six kinds of thing over a map that already has a map on
  // it, and three of them are for reading a railway rather than seeing where one
  // is. An absent key used to mean "on", which meant switching the overlay on
  // for the first time buried the basemap under labels.
  for (const group of style.groups) {
    check(group.key in RAIL_GROUP_DEFAULTS, `${group.key} has a stated default`, JSON.stringify(RAIL_GROUP_DEFAULTS));
  }
  check(railGroupOn({}, 'linenumbers') === false, 'the line numbers stay off until asked for');
  check(railGroupOn({}, 'milestones') === false, 'and so do the kilometre posts');
  // The 1.5 MB full-colour sprite atlas is read by a single expression in this
  // group and nothing else, so its default is also two thirds of the first load.
  check(railGroupOn({}, 'symbols') === false, 'and the signals, which are what the big sprite atlas is for');
  check(railGroupOn({}, 'tracks') && railGroupOn({}, 'stations') && railGroupOn({}, 'platforms'), 'where the railways are is on');
  check(railGroupOn({ tracks: false }, 'tracks') === false, 'a choice beats the default');
  check(railGroupOn({ linenumbers: true }, 'linenumbers') === true, 'in both directions');
}

console.log('\nThe technical infrastructure is a filter, not a group');
{
  // A siding and the through line beside it are drawn by the same layer off the
  // same source, so "hide the sidings" cannot be a visibility. It is one
  // global-state key written into the filters at install — the way their own
  // style is written — so the switch is one property rather than a re-parse of
  // every tile, once per layer, 253 times over.
  const track = technicalFilter('railway_line_high');
  const station = technicalFilter('standard_railway_text_stations');
  check(!!track && !!station, 'tracks and stations each get one');
  check(technicalFilter('standard_railway_platforms') === null, 'and a platform is left alone — it has a group of its own');
  check(technicalFilter('railway_text_km') === null, 'as is a kilometre post');
  const reads = JSON.stringify(track);
  check(reads.includes('hexploreTechnical'), 'the switch is a global-state key', reads.slice(0, 60));
  check(reads.startsWith('["any",["to-boolean",["global-state"'), 'and switching it on lets everything through', reads.slice(0, 48));
  // `match` on an absent property evaluates its input to null, which is neither
  // a label nor the fallback — it is a type error, and a filter that throws
  // draws nothing at all. Every property read here goes through coalesce.
  for (const [what, filter] of [['track', track], ['station', station]]) {
    const bare = JSON.stringify(filter).match(/\["get","[a-z_]+"\]/g) ?? [];
    const coalesced = JSON.stringify(filter).match(/\["coalesce",\["get","[a-z_]+"\],""\]/g) ?? [];
    check(bare.length === coalesced.length, `every ${what} property is read through coalesce`, `${bare.length} reads, ${coalesced.length} coalesced`);
  }
  check(JSON.stringify(station).includes('junction'), 'a junction is not somewhere to catch a train');
  check(JSON.stringify(track).includes('disused'), 'and disused track is not track you can travel on');
}

console.log('\nAnd it is put through MapLibre\'s own parser, not eyeballed');
{
  // Everything above checks the shape of the expression. This checks that
  // MapLibre agrees, using the same expression compiler the map does — which is
  // the only way to know, because the failure mode of a filter it dislikes is
  // not an error. It is a layer that silently draws nothing, and these are the
  // filters on every track and every station in the overlay.
  //
  // `@maplibre/maplibre-gl-style-spec` is maplibre-gl's own dependency rather
  // than one of ours, so it is asked for rather than assumed: no compiler, no
  // checks, and the rest of the file still runs.
  let featureFilter = null;
  try {
    ({ featureFilter } = await import('@maplibre/maplibre-gl-style-spec'));
  } catch {
    console.log('  --   @maplibre/maplibre-gl-style-spec not resolvable; skipped');
  }
  if (featureFilter) {
    const evaluate = (filter, properties, globalState) =>
      featureFilter(filter).filter({ zoom: 16, globalState }, { type: 2, properties });
    const track = technicalFilter('railway_line_high');
    const station = technicalFilter('standard_railway_text_stations');
    const off = { hexploreTechnical: false };
    const on = { hexploreTechnical: true };

    check(evaluate(track, { state: 'present' }, off) === true, 'a through line is drawn with the switch off');
    check(evaluate(track, { state: 'present', service: 'yard' }, off) === false, 'a yard road is not');
    check(evaluate(track, { state: 'present', service: 'siding' }, off) === false, 'nor a siding');
    check(evaluate(track, { state: 'disused' }, off) === false, 'nor track nobody uses any more');
    check(evaluate(track, { state: 'present', service: 'yard' }, on) === true, 'and with the switch on, all of it is');
    check(evaluate(track, {}, off) === true, 'a feature with neither property is not a type error');
    check(evaluate(station, { feature: 'station' }, off) === true, 'a station is drawn with the switch off');
    check(evaluate(station, { feature: 'halt' }, off) === false, 'a halt is not');
    check(evaluate(station, { feature: 'junction' }, off) === false, 'nor a junction');
    check(evaluate(station, { feature: 'junction' }, on) === true, 'and with the switch on, both are');

    // The sharp edge: `global-state` evaluates to null for a key nobody set, and
    // an `any` given null throws — which does not show up as an error, it shows
    // up as every railway on the map disappearing. Coerced, it reads as "off".
    check(evaluate(track, { state: 'present' }, {}) === true, 'and an unset switch reads as off rather than emptying the map');
    check(evaluate(station, { feature: 'station' }, undefined) === true, 'however unset it is');

    // Ours is ANDed onto theirs, and theirs is 288 generated expressions.
    const broken = [];
    for (const layer of style.layers) {
      const extra = technicalFilter(layer['source-layer']);
      if (!extra) continue;
      const combined = layer.filter ? ['all', layer.filter, extra] : extra;
      try {
        featureFilter(combined).filter({ zoom: 16, globalState: off }, { type: 2, properties: { state: 'present' } });
      } catch (e) {
        broken.push(`${layer.id}: ${e.message}`);
      }
    }
    check(!broken.length, 'and every layer it lands on still compiles', broken.slice(0, 2).join(' | '));
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
