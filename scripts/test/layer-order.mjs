// Where the visited wash sits in the basemap's stack.
//
// The map is three things stacked: the basemap's ground, our colour over it,
// and the basemap's streets and rooftops over that. Get the middle one wrong and
// a town is either a flat patch of colour with no streets in it, or a swarm of
// dark rooftops punched through the colour.
//
// This has now been wrong in both directions, which is why it is pinned here.
// CARTO publishes Voyager and Dark Matter as the same 93 layers in the same
// order with one difference: Voyager puts `waterway_label` at index 13, just
// before the tunnels, and Dark Matter puts it at 66, after every road and
// building. Anchoring on "the first symbol layer" therefore landed the wash
// under the streets on Light and over them on Dark. OpenFreeMap has the same
// problem from the other side — `water_name` at 8, `building` at 9 — and
// terrainStyle() used to answer it by moving the buildings *down*, which made
// Terrain agree with the broken map instead of the right one.
//
// The fixtures below are the real layer ids in the real order, trimmed to the
// part that decides the question.
//
//   node scripts/test/layer-order.mjs

import { readFileSync } from 'node:fs';
import { washAnchorIn } from '../../src/basemap.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const fill = (id) => ({ id, type: 'fill' });
const line = (id) => ({ id, type: 'line' });
const sym = (id) => ({ id, type: 'symbol' });

// The bottom of both CARTO stacks, which are identical apart from where
// `waterway_label` falls.
const cartoGround = [
  fill('background'), fill('landcover'), fill('park_national_park'),
  fill('landuse_residential'), line('waterway'), line('boundary_county'),
  fill('water'), fill('water_shadow'), line('aeroway-runway'), line('aeroway-taxiway'),
];
const cartoOver = [
  line('tunnel_service_case'), line('tunnel_rail'), line('road_service_case'),
  line('road_minor_case'), line('rail'), fill('building'),
];

const voyager = [...cartoGround, sym('waterway_label'), ...cartoOver, sym('place_city')];
const darkMatter = [...cartoGround, ...cartoOver, sym('waterway_label'), sym('place_city')];
const openFreeMap = [
  fill('background'), fill('landcover_wood'), fill('water'), line('waterway'),
  sym('water_name'), fill('building'), line('aeroway-taxiway'), line('highway_path'),
  line('railway_transit'), sym('place_city'),
];

// The question every one of these is really asking.
const relation = (layers) => {
  const anchor = layers.findIndex((l) => l.id === washAnchorIn(layers));
  const where = (re) => {
    const i = layers.findIndex((l) => re.test(l.id));
    return i < 0 ? 'absent' : i >= anchor ? 'above' : 'below';
  };
  return { anchor, id: layers[anchor]?.id, where };
};

console.log('\nLight — the one that already looked right');
{
  const { id, where } = relation(voyager);
  check(id === 'waterway_label', 'the anchor does not move', `got ${id}`);
  check(where(/^building/) === 'above', 'rooftops draw over the colour');
  check(where(/^road_/) === 'above', 'so do the streets');
  check(where(/^rail$/) === 'above', 'and the railways');
  check(where(/^water$/) === 'below', 'water is ground, and stays under it');
  check(where(/^aeroway/) === 'below', 'and so is a runway, whatever its name starts with');
}

console.log('\nDark — the same stack with the label moved to the end');
{
  const { id, where } = relation(darkMatter);
  check(id === 'tunnel_service_case', 'anchors on the first thing drawn over the ground',
    `got ${id}`);
  check(where(/^building/) === 'above', 'rooftops draw over the colour');
  check(where(/^road_/) === 'above', 'so do the streets');
  check(where(/^rail$/) === 'above', 'and the railways');
  check(where(/^water$/) === 'below', 'water is still ground');
}

console.log('\nTerrain — OpenFreeMap, where a rooftop clears the label by one layer');
{
  const { id, where } = relation(openFreeMap);
  check(id === 'water_name', 'anchors on the label, which comes first here', `got ${id}`);
  check(where(/^building/) === 'above', 'and the buildings are left where they were published',
    'they used to be moved below the wash');
  check(where(/^highway/) === 'above', 'streets draw over the colour');
  check(where(/^railway/) === 'above', 'and the railways');
}

console.log('\nall three agree');
{
  const answer = (layers) => {
    const { where } = relation(layers);
    return [where(/^building/), where(/(^|_)rail/)].join(',');
  };
  check(answer(voyager) === answer(darkMatter) && answer(darkMatter) === 'above,above',
    'Light and Dark put buildings and rails in the same place', answer(darkMatter));
  check(answer(openFreeMap) === 'above,above', 'and so does Terrain', answer(openFreeMap));
}

console.log('\nnothing to go on');
check(washAnchorIn([]) === undefined, 'an empty style has no anchor');
check(washAnchorIn(undefined) === undefined, 'and neither does a missing one');
check(washAnchorIn([fill('background'), fill('water')]) === undefined,
  'a style that is nothing but ground puts our layers on top', 'no beforeId');

// The end-to-end half: terrainStyle() must not undo any of the above. Run
// against the real published style, offline, with fetch stubbed.
console.log('\nterrainStyle() end to end');
{
  const cached = new URL('./fixtures/ofm-dark.json', import.meta.url);
  let published = null;
  try {
    published = JSON.parse(readFileSync(cached, 'utf8'));
  } catch {
    console.log('  skip  no cached OpenFreeMap style at scripts/test/fixtures/ofm-dark.json');
  }
  if (published) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => structuredClone(published) });
    const { terrainStyle } = await import('../../src/basemap.js');
    const layers = (await terrainStyle()).layers;
    const { where } = relation(layers);
    check(where(/^building/) === 'above', 'the real style keeps its buildings over the wash',
      'the reorder that used to live here is gone');
    check(where(/^highway/) === 'above', 'and its streets');
    check(where(/^railway/) === 'above', 'and its railways');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
