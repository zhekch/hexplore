// What the photo overlay has to be true of to work at all.
//
//   node scripts/test/photos.mjs
//
// This layer has a failure mode nothing else in the app has: **its other half is
// in another language.** The page asks `hexplorePhotos` for `points`, `photo`
// and `open`; a Swift file two directories away switches on those exact strings,
// and neither compiler nor bundler has ever seen both. Rename one and the app
// still builds, still runs, and answers every question with "unknown" — which
// looks like a phone that has no photographs on it.
//
// So most of this is the two halves read against each other. The rest is the
// handful of things that are wrong in a way you cannot see: a swapped
// coordinate pair puts a summer in Zürich off the coast of Somalia, a card whose
// element ids have drifted from the markup fills in nothing at all, and a
// browser that somehow believed it could answer would offer a switch that does
// nothing.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUSTER_MAX_ZOOM, GROUP_MAX, PHOTO_COLOR, forgetPhotos, installPhotos, loadPhotos,
  photoCount, photoExpansion, photoGeoJson, photoLayerIds, photoLayers, photoLeaves,
  photosAvailable, photosLimited,
} from '../../src/photos.js';
import { groupTitle, groupWhen } from '../../src/photo-info.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const bridgeSwift = read('HexPlore-IOS/HexPlore/PhotoBridge.swift');
const librarySwift = read('HexPlore-IOS/HexPlore/PhotoLibrary.swift');
const webPanelSwift = read('HexPlore-IOS/HexPlore/WebPanel.swift');
const plist = read('HexPlore-IOS/Info.plist');
const photosJs = read('src/photos.js');
const photoInfoJs = read('src/photo-info.js');
const html = read('index.html');
const css = read('src/style.css');

console.log('\nThe page and the app agree about what to call each other');
{
  // The name the page reaches for, and the name the app registers under. One
  // string, written twice, in two languages.
  const jsName = photosJs.match(/const HOST = '([^']+)'/)?.[1];
  const swiftName = bridgeSwift.match(/static let name = "([^"]+)"/)?.[1];
  check(!!jsName && jsName === swiftName, 'the message handler has one name', `${jsName} vs ${swiftName}`);
  check(
    webPanelSwift.includes('addScriptMessageHandler(') && webPanelSwift.includes('PhotoBridge.name'),
    'and the web view actually registers it',
  );

  // Every question the page asks, against every question the bridge answers.
  const asked = [...photosJs.matchAll(/ask: '([a-z]+)'/g)].map((m) => m[1]);
  const answered = [...bridgeSwift.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
  const unanswered = asked.filter((a) => !answered.includes(a));
  check(asked.length >= 3, 'the page asks for points, a photo and a way out', asked.join(', '));
  check(!unanswered.length, 'and the app answers every one of them', unanswered.join(', '));
  const unasked = answered.filter((a) => !asked.includes(a));
  check(!unasked.length, 'with nothing left over that nobody asks', unasked.join(', '));

  // The reply's own keys. `photos` carrying the wrong name is an overlay that
  // draws nothing while every other part of the exchange looks healthy.
  for (const key of ['scan', 'photos', 'limited', 'canOpen']) {
    check(bridgeSwift.includes(`"${key}"`) && photosJs.includes(`reply.${key}`),
      `the scan's \`${key}\` is written on one side and read on the other`);
  }
  check(
    bridgeSwift.includes('"src"') && photoInfoJs.includes('reply.src'),
    'and a picture arrives under the name the card reads',
  );
}

console.log('\nA photograph is named by its index, never by its identity');
{
  // The whole privacy argument for the bridge in one assertion: the asset
  // identifier is read on the Swift side and never put in a reply.
  check(librarySwift.includes('asset.localIdentifier'), 'the app knows which asset is which');
  // Every dictionary the bridge hands back, read as one blob. Checked for
  // length first: a regex that quietly matched nothing would make the assertion
  // below true of a file that sends the whole library's identifiers.
  const replies = [...bridgeSwift.matchAll(/return \[([\s\S]*?)\]\n/g)].map((m) => m[1]).join('\n');
  check(replies.includes('"ok"') && replies.includes('"photos"'), 'the replies were found to look at');
  check(!/localIdentifier|"id"/.test(replies), 'and never send it to the page');
  check(photosJs.includes('scan,'), 'every question quotes the scan it belongs to');
  check(bridgeSwift.includes('"stale"'), 'and one against a replaced scan is refused');
}

console.log('\nA point lands where the photograph was taken');
{
  // The wire is [lat, lng, t] because that is the shape every other fix in this
  // app takes; GeoJSON is [lng, lat]. Getting this backwards is a bug that looks
  // like bad data.
  const fc = photoGeoJson([[47.37, 8.54, 1_693_742_400], [-33.87, 151.21, 1_600_000_000]]);
  check(fc.type === 'FeatureCollection' && fc.features.length === 2, 'one feature per photograph');
  const [zurich] = fc.features;
  check(
    zurich.geometry.coordinates[0] === 8.54 && zurich.geometry.coordinates[1] === 47.37,
    'longitude first, latitude second',
    JSON.stringify(zurich.geometry.coordinates),
  );
  check(zurich.properties.i === 0 && fc.features[1].properties.i === 1,
    'each carries its index into the list the app sent');
  check(zurich.properties.t === 1_693_742_400, 'and when it was taken');
  check(photoGeoJson([]).features.length === 0, 'an empty library is an empty collection, not a throw');
}

console.log('\nThe layers say what they draw');
{
  const layers = photoLayers({ theme: 'dark', font: ['Open Sans Regular'] });
  const ids = layers.map((l) => l.id);
  check(
    JSON.stringify(ids) === JSON.stringify(photoLayerIds()),
    'the ids the map removes are the ids the map adds',
    `${ids} vs ${photoLayerIds()}`,
  );
  check(ids.every((id) => id.startsWith('hexplore-')), 'all namespaced, so a basemap cannot own one', ids.join(', '));

  // A feature is a cluster or it is a photograph. Anything drawn by both layers
  // is drawn twice; anything drawn by neither is invisible.
  const single = layers.find((l) => l.id.endsWith('-point'));
  const cluster = layers.find((l) => l.id.endsWith('-cluster'));
  const count = layers.find((l) => l.id.endsWith('-count'));
  check(JSON.stringify(single.filter) === JSON.stringify(['!', ['has', 'point_count']]),
    'the point layer draws what is not a group');
  check(JSON.stringify(cluster.filter) === JSON.stringify(['has', 'point_count']),
    'the cluster layer draws what is');
  check(JSON.stringify(count.filter) === JSON.stringify(cluster.filter),
    'and the count is drawn on exactly the discs that exist');
  check(ids.indexOf(count.id) > ids.indexOf(cluster.id), 'the number goes on top of its disc');
  check(count.layout['text-allow-overlap'] === true,
    'and cannot be pushed off it by somebody else’s label');
  check(count.layout['text-font'][0] === 'Open Sans Regular',
    'the label uses the basemap’s own fontstack, which is the only one its glyph server has');

  // One mark, two places: the map draws the points and the card outlines the
  // chosen thumbnail. A drift here is a card that no longer looks related to
  // what was tapped.
  const cssColor = css.match(/--photo:\s*([^;]+);/)?.[1]?.trim();
  check(cssColor === PHOTO_COLOR, 'the map’s violet and the chrome’s are one colour',
    `${PHOTO_COLOR} vs ${cssColor}`);
  check(single.paint['circle-color'] === PHOTO_COLOR, 'and it is what a point is drawn in');
}

console.log('\nInstalling is idempotent, and clusters to the bottom of the map');
{
  const sources = new Map();
  const layers = new Map();
  let setData = 0;
  const map = {
    getSource: (id) => sources.get(id),
    addSource: (id, spec) => sources.set(id, { ...spec, setData: () => { setData++; } }),
    removeSource: (id) => sources.delete(id),
    getLayer: (id) => layers.get(id),
    addLayer: (l) => layers.set(l.id, l),
    removeLayer: (id) => layers.delete(id),
    getMaxZoom: () => 17.5,
  };

  installPhotos(map, { before: 'labels', theme: 'dark', font: ['Open Sans Regular'] });
  check(sources.size === 1 && layers.size === 3, 'one source, three layers');
  const source = [...sources.values()][0];
  check(source.cluster === true, 'the source groups its points');
  check(source.clusterMaxZoom === CLUSTER_MAX_ZOOM, 'to the top of the map’s range', String(source.clusterMaxZoom));
  // The convention is one zoom below the maximum, so that the last zoom shows
  // individual points. That is right for shops and wrong for photographs: forty
  // pictures of one dinner are forty points at one coordinate, and separating
  // them at z17 replaces a group you can open with a pile you cannot count.
  check(CLUSTER_MAX_ZOOM >= 17, 'which is deliberately not one below it', String(CLUSTER_MAX_ZOOM));
  check(
    !!source.clusterProperties?.first && !!source.clusterProperties?.last,
    'and a group knows its own span without being asked for its contents',
  );

  installPhotos(map, { before: 'labels', theme: 'dark', font: ['Open Sans Regular'] });
  check(sources.size === 1 && layers.size === 3, 'installing again adds nothing');
  check(setData === 1, 'it hands the existing source new data instead', String(setData));
}

console.log('\nA group that cannot be broken up is opened rather than zoomed into');
{
  const map = (zoom) => ({
    getMaxZoom: () => 17.5,
    getSource: () => ({
      getClusterExpansionZoom: async () => zoom,
      getClusterLeaves: async (id, limit) => Array.from({ length: Math.min(limit, 60) }, (_, n) => ({
        // Deliberately out of order: supercluster answers in index order, and
        // the strip in the card is a morning rather than a shuffle.
        properties: { i: n, t: 1_700_000_000 + ((n * 37) % 60) },
      })),
    }),
  });
  check(await photoExpansion(map(12), 1) === 12, 'a cluster that would split names the zoom');
  check(await photoExpansion(map(18), 1) === null,
    'and one past the end of the map names nothing, which is what opens the card');

  const leaves = await photoLeaves(map(18), 1);
  check(leaves.length === GROUP_MAX, 'a group is capped at what the strip can show', String(leaves.length));
  check(leaves.every((l, n) => n === 0 || leaves[n - 1].t <= l.t), 'and comes back oldest first');
  check(await photoExpansion({ getMaxZoom: () => 17.5, getSource: () => undefined }, 1) === null,
    'a cluster asked for after the layer went away is not an error');
}

console.log('\nThe card says when, whether it is one photograph or forty');
{
  // 3 Sep 2023, 09:00 and 11:00 UTC. Formatted in the runner’s own locale and
  // timezone, so this checks the *shape* of the answer rather than its wording.
  const one = [{ i: 0, t: 1_693_731_600 }];
  const two = [...one, { i: 1, t: 1_693_738_800 }];
  check(groupTitle(one) === 'Photo', 'one is a photo', groupTitle(one));
  check(groupTitle(two) === '2 photos', 'and two are two', groupTitle(two));
  check(groupWhen(one).includes('·'), 'a single one gets the clock as well as the day', groupWhen(one));
  check(!groupWhen(two).includes('–'), 'a group inside one day says that day once', groupWhen(two));
  const across = [...one, { i: 2, t: 1_693_731_600 + 86_400 * 3 }];
  check(groupWhen(across).includes('–'), 'and one that spans days says both ends', groupWhen(across));
  check(groupWhen([]) === '', 'nothing said about nothing');
}

console.log('\nThe card is wired to markup that exists');
{
  // Every element the card reaches for, against the page it reaches into. A
  // renamed id is a card that opens and stays blank, and nothing throws.
  const wanted = [...photoInfoJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  check(wanted.length >= 8, 'the card knows what it needs', String(wanted.length));
  const missing = wanted.filter((id) => !html.includes(`id="${id}"`));
  check(!missing.length, 'and the page has every one of them', missing.join(', '));
  check(html.includes('id="photos-row"') && html.includes('id="photos-toggle"'), 'the switch is in the menu');
  check(/id="photos-row"[^>]*hidden/.test(html),
    'and starts hidden, because most of the world cannot use it');
}

console.log('\nOutside the app there is nothing to switch on');
{
  check(photosAvailable() === false, 'a browser cannot reach a photo library');
  const report = await loadPhotos();
  check(report.ok === false && report.error === 'nohost', 'asking anyway is a refusal, not a crash',
    JSON.stringify(report));
  check(photoCount() === 0 && photosLimited() === false, 'and leaves nothing behind');
  forgetPhotos();
  check(photoCount() === 0, 'forgetting an empty library is fine too');
}

console.log('\nThe app asks iOS for what it needs, and says why');
{
  check(plist.includes('<string>photos-redirect</string>') && plist.includes('LSApplicationQueriesSchemes'),
    'the Photos scheme is declared, or canOpenURL always answers no');
  check(librarySwift.includes('photos-redirect://'), 'and that is the scheme the app opens');
  // The usage string used to promise that no photograph is ever opened, which
  // stopped being true the moment tapping a point showed you one.
  const usage = plist.match(/<key>NSPhotoLibraryUsageDescription<\/key>\s*<string>([^<]*)</)?.[1] ?? '';
  check(!/never opens the photographs/i.test(usage), 'the permission text no longer promises otherwise');
  check(/no image is ever uploaded/i.test(usage), 'and still promises the thing that is true', usage);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
