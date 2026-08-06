// What the airports overlay has to be true of to work at all.
//
//   node scripts/test/airports.mjs
//
// The overlay is a **dataset** rather than a tile server, which removes every
// failure mode the railway test exists to catch and adds one of its own: the
// build and the client hold two halves of the same agreement — which letter means
// which kind, which kinds travel in which file, what the sixteen slots of a tuple
// are — and nothing at run time would say so if they drifted. A record read with
// the fields one place along is not an error, it is an airport whose elevation is
// its runway count.
//
// So most of this is the two halves checked against each other, and against the
// committed files, which makes it also the thing that notices when a rebuild
// against changed upstream data has broken something.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AIRPORT_FIELDS, AIRPORT_GROUPS, AIRPORT_KINDS, airportGeoJson, airportGroupOn,
  airportGroupsOn, airportLayerIds, airportLayers, countryName, describeAirportFeature,
  installAirports, loadAirports,
} from '../../src/airports.js';
import {
  GROUPS, KINDS, build, groupOf, normaliseSurface, parseCsv, runwaySummaries, wikiTitle,
} from '../../scripts/build-airports.mjs';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => JSON.parse(readFileSync(path.join(ROOT, 'src', name), 'utf8'));
const counts = read('airports-counts.json');
const files = Object.fromEntries(GROUPS.map(([key]) => [key, read(`airports-${key}.json`)]));

console.log('\nThe build and the client agree about what a record is');
{
  const letters = new Set(Object.values(KINDS));
  const known = new Set(Object.keys(AIRPORT_KINDS));
  const orphanBuild = [...letters].filter((l) => !known.has(l));
  const orphanClient = [...known].filter((l) => !letters.has(l));
  check(!orphanBuild.length, 'every letter the build writes, the client can read', orphanBuild.join(', '));
  check(!orphanClient.length, 'and the client claims no letter the build never writes', orphanClient.join(', '));

  const buildKeys = GROUPS.map(([k]) => k);
  const clientKeys = AIRPORT_GROUPS.map((g) => g.key);
  check(
    JSON.stringify(buildKeys) === JSON.stringify(clientKeys),
    'the same groups, in the same order, on both sides',
    `${buildKeys} vs ${clientKeys}`,
  );

  // A kind claimed by nobody is an airport that is silently never drawn, and a
  // kind claimed twice is one drawn twice over.
  const claims = Object.values(KINDS).map((l) => [l, GROUPS.filter(([, ks]) => ks.includes(l)).length]);
  check(claims.every(([, n]) => n === 1), 'exactly one group claims each kind',
    claims.filter(([, n]) => n !== 1).map(([l, n]) => `${l}×${n}`).join(', '));
}

console.log('\nThe tuple means what both sides think it means');
{
  check(AIRPORT_FIELDS.length === 16, 'sixteen fields', String(AIRPORT_FIELDS.length));
  for (const [key, file] of Object.entries(files)) {
    const bad = file.airports.filter((r) => r.length !== AIRPORT_FIELDS.length);
    check(!bad.length, `${key}: every record is ${AIRPORT_FIELDS.length} long`, `${bad.length} are not`);
  }
  // Field 0 is longitude and field 1 latitude, in that order, because that is
  // GeoJSON's order and swapping them is the bug that puts Zürich in Somalia.
  check(AIRPORT_FIELDS[0] === 'lng' && AIRPORT_FIELDS[1] === 'lat', 'longitude first, then latitude');
  for (const [key, file] of Object.entries(files)) {
    const bad = file.airports.filter(([lng, lat]) =>
      !Number.isFinite(lng) || !Number.isFinite(lat)
      || lat < -90 || lat > 90 || lng < -180 || lng > 180);
    check(!bad.length, `${key}: every coordinate is on Earth`, `${bad.length} are not`);
  }
}

console.log('\nEach file holds its own group and no other');
{
  for (const [key, kinds] of GROUPS) {
    const strays = files[key].airports.filter((r) => !kinds.includes(r[2]));
    check(!strays.length, `${key}: only ${kinds.join('/')}`, `${strays.length} strays`);
    check(files[key].group === key, `${key}: the file says which group it is`);
  }
  // The counts drive what the dialog tells you a switch will cost, so a count
  // that disagrees with its file is a lie about a download.
  for (const [key, file] of Object.entries(files)) {
    check(counts[key] === file.airports.length,
      `${key}: the counts manifest matches the file`, `${counts[key]} vs ${file.airports.length}`);
  }
  const ids = new Set();
  for (const file of Object.values(files)) for (const r of file.airports) ids.add(`${r[0]},${r[1]},${r[3]}`);
  const total = Object.values(files).reduce((n, f) => n + f.airports.length, 0);
  check(ids.size > total * 0.99, 'no group is a copy of another', `${ids.size} distinct of ${total}`);
}

console.log('\nThe layers cover the groups, and their filters compile');
{
  const layers = airportLayers();
  check(new Set(airportLayerIds()).size === layers.length, 'every layer id is distinct');
  check(layers.every((l) => l.id.startsWith('hexplore-air-')), 'every layer id is namespaced');
  const covered = new Set(layers.flatMap((l) => l.kinds));
  const missing = Object.values(KINDS).filter((k) => !covered.has(k));
  check(!missing.length, 'every kind has a layer that draws it', missing.join(', '));
  for (const group of AIRPORT_GROUPS) {
    check(layers.some((l) => l.group === group.key), `${group.key} has at least one layer`);
  }

  // Compiled with the same expression compiler the map uses — eyeballing a
  // filter is exactly what this class of bug survives. The package is
  // maplibre-gl's own dependency rather than one of ours, so it is asked for
  // rather than assumed: no compiler, no checks, and the rest of the file runs.
  let featureFilter = null;
  try {
    ({ featureFilter } = await import('@maplibre/maplibre-gl-style-spec'));
  } catch {
    console.log('  --   style-spec not installed; filters not compiled');
  }
  if (featureFilter) {
    const ctx = { zoom: 10 };
    for (const layer of layers) {
      const compiled = featureFilter(layer.filter);
      check(!compiled.needGeometry, `${layer.id}: filter needs no geometry`);
      const drawn = Object.values(KINDS).filter((k) =>
        compiled.filter(ctx, { type: 1, properties: { k } }));
      check(
        JSON.stringify(drawn.sort()) === JSON.stringify([...layer.kinds].sort()),
        `${layer.id}: draws exactly ${layer.kinds.join('/')}`,
        drawn.join('/'),
      );
      // The property missing altogether must not throw — a filter that throws
      // does not fail loudly, it draws nothing at all.
      let threw = false;
      try { compiled.filter(ctx, { type: 1, properties: {} }); } catch { threw = true; }
      check(!threw, `${layer.id}: a feature with no kind does not throw`);
    }
  }
}

console.log('\nThe important airports are installed last, and so place first');
{
  // The bug this catches was found on a real map and is invisible in the code:
  // `symbol-sort-key` decides who wins a collision *within* a layer and says
  // nothing across two, and MapLibre places symbols from the top of the stack
  // down — so the layer added **last** places first. Installed in declaration
  // order, Zürich Airport lost its label to Dübendorf Air Base eight kilometres
  // away. Nothing throws, nothing warns; the busiest airport in the country is
  // simply not drawn, which reads as missing data.
  const added = [];
  const stub = {
    hasImage: () => true, // stops addIcon reaching for a document Node has not got
    addImage: () => {},
    getSource: () => null,
    addSource: () => {},
    getLayer: () => null,
    addLayer: (layer) => added.push(layer.id),
    setLayoutProperty: () => {},
  };
  installAirports(stub, { font: ['x'], theme: 'dark', before: undefined, groups: {} });

  const declared = airportLayers().map((l) => l.id);
  check(added.length === declared.length, 'every declared layer is installed', `${added.length}/${declared.length}`);
  check(
    JSON.stringify(added) === JSON.stringify([...declared].reverse()),
    'installed in reverse of the declared order',
    added.join(' → '),
  );
  check(added.at(-1) === 'hexplore-air-large', 'so the large airports end up top-most', String(added.at(-1)));
  check(declared[0] === 'hexplore-air-large', 'and are declared first, which is what makes them most important');

  // The two orderings have to agree, or one of them is decoration: the layer
  // table ranks kinds across layers and `symbol-sort-key` ranks them within one.
  const byLayer = airportLayers().flatMap((l) => l.kinds);
  check(
    JSON.stringify(byLayer) === JSON.stringify(['L', 'M', 'S', 'W', 'B', 'H', 'X']),
    'the layer order ranks kinds the same way symbol-sort-key does',
    byLayer.join(','),
  );
}

console.log('\nThree of the four groups are off, and the switch says so');
{
  check(airportGroupOn({}, 'airline') === true, 'the airline airports are on by default');
  const off = ['airfields', 'helipads', 'closed'].filter((k) => airportGroupOn({}, k));
  check(!off.length, 'and nothing else is', off.join(', '));
  check(airportGroupOn({ airfields: true }, 'airfields') === true, 'a choice overrides the default');
  check(airportGroupOn({ airline: false }, 'airline') === false, 'in both directions');
  check(JSON.stringify(airportGroupsOn({})) === '["airline"]', 'the default asks for one file');
  check(
    JSON.stringify(airportGroupsOn({ helipads: true })) === '["airline","helipads"]',
    'and ticking one asks for two, in the table\'s own order',
  );
}

console.log('\nSurfaces are said the way a person reads them');
{
  const cases = [
    ['ASP', 'Asphalt'], ['ASPH', 'Asphalt'], ['Asphalt', 'Asphalt'], ['ASPH-G', 'Asphalt'],
    ['ASPH/ CONC', 'Asphalt'], ['CON', 'Concrete'], ['CONC', 'Concrete'], ['Concrete', 'Concrete'],
    ['TURF', 'Grass'], ['GRS', 'Grass'], ['Grass', 'Grass'], ['GRASS / SOD', 'Grass'],
    ['GVL', 'Gravel'], ['GRVL', 'Gravel'], ['WATER', 'Water'], ['DIRT', 'Dirt'],
  ];
  for (const [raw, want] of cases) {
    check(normaliseSurface(raw) === want, `${raw} → ${want}`, String(normaliseSurface(raw)));
  }
  // Unrecognised is null rather than the raw string: "PIÇARRA" is a real surface
  // and printing it answers nothing anybody asked.
  check(normaliseSurface('PIÇARRA') === null, 'an unknown surface is left unsaid');
  check(normaliseSurface('') === null, 'and so is a blank one');
  check(normaliseSurface(undefined) === null, 'and a missing one');
}

console.log('\nThe CSV reader survives what OurAirports actually writes');
{
  const rows = parseCsv('a,b,c\n1,"two, and a half",3\n4,"say ""hi""",6\n7,"a\nnewline",9\n');
  check(rows.length === 3, 'three rows', String(rows.length));
  check(rows[0].b === 'two, and a half', 'a comma inside quotes', rows[0].b);
  check(rows[1].b === 'say "hi"', 'a doubled quote', rows[1].b);
  check(rows[2].b === 'a\nnewline', 'a newline inside quotes', JSON.stringify(rows[2].b));
  check(parseCsv('a,b\n1,2').length === 1, 'a file with no trailing newline');
}

console.log('\nThe runway summary answers what a card asks');
{
  const rows = [
    { airport_ident: 'X', closed: '0', length_ft: '3000', surface: 'ASP', lighted: '0' },
    { airport_ident: 'X', closed: '0', length_ft: '9000', surface: 'CONC', lighted: '1' },
    { airport_ident: 'X', closed: '1', length_ft: '12000', surface: 'ASP', lighted: '1' },
    { airport_ident: 'Y', closed: '0', length_ft: '', surface: 'TURF', lighted: '0' },
  ];
  const out = runwaySummaries(rows);
  check(out.get('X').count === 2, 'a closed runway is not a runway', String(out.get('X').count));
  check(out.get('X').longest === 9000, 'the longest is the longest open one');
  check(out.get('X').surface === 'Concrete', 'and its surface is the one reported', out.get('X').surface);
  check(out.get('X').lit === true, 'any lit runway makes the field lit');
  check(out.get('Y').count === 1 && out.get('Y').longest === 0, 'a runway with no length still counts');
}

console.log('\nA record survives the round trip from CSV to card');
{
  const csv = 'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,'
    + 'iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,'
    + 'wikipedia_link,keywords\n'
    + '1,LSZH,large_airport,"Zurich Airport",47.4647,8.5492,1416,EU,CH,CH-ZH,Zurich,yes,LSZH,ZRH,'
    + 'LSZH,,https://www.zurich-airport.com,https://en.wikipedia.org/wiki/Zurich_Airport,\n'
    + '2,XXXX,closed,"Old Field",0,0,0,EU,CH,CH-ZH,Nowhere,no,,,,,,,\n';
  const rw = 'id,airport_ref,airport_ident,length_ft,width_ft,surface,lighted,closed,le_ident,he_ident\n'
    + '1,1,LSZH,12139,197,ASP,1,0,14,32\n1,1,LSZH,10827,197,ASP,1,0,16,34\n';
  const { rows } = build(parseCsv(csv), parseCsv(rw));
  check(rows.length === 2, 'both records survive', String(rows.length));

  await loadAirports(['airline'], { airline: { airports: [rows.find((r) => r[2] === 'L')] } });
  const [zrh] = airportGeoJson(['airline']).features;
  check(zrh.geometry.coordinates[0] === 8.5492, 'longitude is longitude', String(zrh.geometry.coordinates[0]));
  check(zrh.id === 0, 'the feature carries an id, so a hover state has something to hang on');

  const card = describeAirportFeature(zrh);
  check(card.title === 'Zurich Airport', 'the title is the name', card.title);
  check(card.subtitle === 'Large airport', 'the subtitle is the kind', card.subtitle);
  const row = (label) => card.rows.find(([l]) => l === label)?.[1];
  check(row('Codes') === 'ZRH · LSZH', 'both codes, on one line', row('Codes'));
  check(row('Where') === 'Zurich, Switzerland', 'the country is named, not coded', row('Where'));
  check(/^432 m \(1,416 ft\)$/.test(row('Elevation') ?? ''), 'elevation in both units', row('Elevation'));
  check(/^2 runways, longest 3,700 m/.test(row('Runways') ?? ''), 'the runways add up', row('Runways'));
  check(row('Surface') === 'Asphalt, lit', 'the surface of the longest one', row('Surface'));
  check(row('Scheduled flights') === 'Yes', 'and whether an airline flies there');
  check(
    card.links.some((l) => l.url === 'https://en.wikipedia.org/wiki/Zurich_Airport'),
    'the wikipedia link is rebuilt from the title alone',
    JSON.stringify(card.links),
  );
  check(card.links.some((l) => l.label === 'Website'), 'and the airport\'s own page is offered');
}

console.log('\nThe cases that read as data bugs');
{
  // Sea level is an elevation. Testing it for falsiness drops the row for every
  // airport on a coast, which looks like missing data and is a missing `!= null`.
  const atSeaLevel = describeAirportFeature({ properties: { k: 'S', n: 'Sandy', e: 0, rn: 0 } });
  check(atSeaLevel.rows.some(([l, v]) => l === 'Elevation' && v.startsWith('0 m')),
    'an airport at sea level still reports its elevation');

  // A closed field is not one an airline does not fly to; it is one nothing
  // flies to, and the row would be an answer to a question nobody asked.
  const shut = describeAirportFeature({ properties: { k: 'X', n: 'Old Field' } });
  check(!shut.rows.some(([l]) => l === 'Scheduled flights'), 'a closed field is not asked about airlines');
  check(shut.subtitle === 'Closed', 'and says what it is', shut.subtitle);

  // A small strip files the same string as both codes; two identical rows would
  // read as a rendering fault.
  const same = describeAirportFeature({ properties: { k: 'S', n: 'Strip', c: 'ABC', i: 'ABC' } });
  check(same.rows.find(([l]) => l.startsWith('Code'))?.[1] === 'ABC', 'one code said once',
    JSON.stringify(same.rows));

  // No properties at all is a query that hit nothing, not a card with no rows.
  check(describeAirportFeature(null) === null, 'nothing clicked opens nothing');
  check(describeAirportFeature({}) === null, 'and a feature with no properties does too');

  // A field with no name falls back to its code rather than to an empty heading.
  const unnamed = describeAirportFeature({ properties: { k: 'S', n: '', c: 'QQQ' } });
  check(unnamed.title === 'QQQ', 'an unnamed field is titled by its code', unnamed.title);
}

console.log('\nThe odds and ends');
{
  check(wikiTitle('https://en.wikipedia.org/wiki/Heathrow') === 'Heathrow', 'a wikipedia title is taken out');
  check(wikiTitle('https://example.com/x') === null, 'and a link somewhere else is not mistaken for one');
  check(countryName('CH') === 'Switzerland', 'a country code is a country', countryName('CH'));
  check(countryName('') === null, 'an absent one is nothing');
  // `ZZ` is not a typo, it is CLDR's own code for "we do not know", and two real
  // records use it — so the readable phrase is the right answer rather than a
  // fallback to be avoided.
  check(countryName('ZZ') === 'Unknown Region', 'ZZ is a country code meaning no country', countryName('ZZ'));
  // A code that is genuinely unassigned falls back to itself rather than
  // throwing, which is what keeps one bad row from emptying a card.
  check(countryName('QQ') === 'QQ', 'and an unassigned one is itself rather than an error', countryName('QQ'));
  check(groupOf('L') === 'airline' && groupOf('H') === 'helipads', 'the build can place a kind');
  check(groupOf('?') === undefined, 'and knows when it cannot');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
