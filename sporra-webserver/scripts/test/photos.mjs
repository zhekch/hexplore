// What the photo overlay has to be true of to work at all.
//
//   node scripts/test/photos.mjs
//
// This layer has a failure mode nothing else in the app has: **its other half is
// in another language.** The page asks `sporraPhotos` for `points`, `photo`
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
  CLUSTER_MAX_ZOOM, PHOTO_COLOR, STRIP_CHUNK, forgetPhotos, installPhotos, isVideo,
  loadPhotos, photoCount, photoGeoJson, photoLayerIds, photoLayers, photoLeaves,
  photosAvailable, photosLimited, videoCount,
} from '../../src/photos.js';
import { groupTitle, groupWhen } from '../../src/photo-info.js';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// The other half of this layer is in a sibling of the webserver, not inside it:
// the two apps and the server are three folders under one repo root.
const REPO = path.resolve(ROOT, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const readApp = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

const bridgeSwift = readApp('sporra-ios/Sporra/PhotoBridge.swift');
const librarySwift = readApp('sporra-ios/Sporra/PhotoLibrary.swift');
const gallerySwift = readApp('sporra-ios/Sporra/PhotoGallery.swift');
const playbackSwift = readApp('sporra-ios/Sporra/VideoPlayback.swift');
const syncSwift = readApp('sporra-ios/Sporra/PhotoSync.swift');
const webPanelSwift = readApp('sporra-ios/Sporra/WebPanel.swift');
const plist = readApp('sporra-ios/Info.plist');
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
  check(asked.length >= 2, 'the page asks for the points and for a photo', asked.join(', '));
  check(!unanswered.length, 'and the app answers every one of them', unanswered.join(', '));
  const unasked = answered.filter((a) => !asked.includes(a));
  check(!unasked.length, 'with nothing left over that nobody asks', unasked.join(', '));

  // The reply's own keys. `photos` carrying the wrong name is an overlay that
  // draws nothing while every other part of the exchange looks healthy.
  for (const key of ['scan', 'photos', 'limited']) {
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

console.log('\nAnd only the ones taken while the day on the chip was happening');
{
  // The window is what the map narrows to while a day or a trip is being shown
  // — every picture from every other August is noise over one Tuesday.
  const DAY = [1_693_699_200, 1_693_785_600]; // 3 Sep 2023, UTC
  const library = [
    [47.37, 8.54, 1_693_742_400],       // that afternoon
    [47.38, 8.55, 1_600_000_000],       // two years earlier
    [47.39, 8.56, 1_693_785_600],       // the first second of the next day
    [47.40, 8.57, 0],                   // no time on it at all
  ];
  const fc = photoGeoJson(library, DAY);
  check(fc.features.length === 1, 'one of the four is inside the day', `${fc.features.length}`);
  // The one that matters, and the reason this is a filter over an index rather
  // than a filtered list: `i` is what every later question about a photograph is
  // asked by — fetch it, play it, open it full screen — so renumbering the
  // survivors would answer all three about a different picture.
  check(fc.features[0].properties.i === 0, 'and it keeps its index into the library');
  check(photoGeoJson(library.slice(1), DAY).features.length === 0,
    'the end of the window is exclusive, and an undated photograph is out');
  check(photoGeoJson(library).features.length === 4, 'with no window, the whole library stands');
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
  check(ids.every((id) => id.startsWith('sporra-')), 'all namespaced, so a basemap cannot own one', ids.join(', '));

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

// Both libraries, because they answer this call in two different shapes and the
// difference is silent. MapLibre returns a promise; Mapbox GL JS takes a
// callback and returns the source. Awaiting the call was written against
// MapLibre, so on the 3D basemap it received a GeoJSONSource, `.map` was not a
// function, and every group of photographs opened an empty card — which from the
// outside is a tap that did nothing. Single photographs kept working, because
// they never go through here, and that is exactly what made it hard to see.
console.log('\nA tap on a group opens all of it, whichever library drew it');
{
  // Deliberately out of order: supercluster answers in index order, and the
  // strip in the card is a morning rather than a shuffle.
  const leaves = (held, limit) => Array.from({ length: Math.min(limit, held) }, (_, n) => ({
    properties: { i: n, t: 1_700_000_000 + ((n * 37) % 900) },
  }));

  const maplibre = (held) => ({
    getSource: () => ({ getClusterLeaves: async (id, limit) => leaves(held, limit) }),
  });
  const mapbox = (held) => {
    const source = {
      getClusterLeaves: (id, limit, offset, cb) => {
        Promise.resolve().then(() => cb(null, leaves(held, limit)));
        return source; // the library's own answer, and not a thenable
      },
    };
    return { getSource: () => source };
  };

  for (const [name, map] of [['MapLibre', maplibre], ['Mapbox', mapbox]]) {
    // The cap used to be 48, which made a card of 4,000 photographs quietly a
    // card of 48 — the group is the answer to the tap, and keeping most of it
    // back is the card misreporting what is there.
    const big = await photoLeaves(map(4000), 1, 4000);
    check(big.length === 4000, `${name}: a group of four thousand comes back whole`, String(big.length));
    // Newest first, because the card opens on the first of them: a group of
    // photographs is a place you have been back to, and the one you want is
    // almost always the last time rather than the first.
    check(big.every((l, n) => n === 0 || big[n - 1].t >= l.t), `${name}: and comes back newest first`);
  }

  check(STRIP_CHUNK > 0 && STRIP_CHUNK < 4000,
    'the strip renders it in chunks rather than all at once', String(STRIP_CHUNK));
  check((await photoLeaves({ getSource: () => undefined }, 1, 10)).length === 0,
    'a group asked for after the layer went away is not an error');
  // The callback's error argument is the only way Mapbox has of reporting one,
  // and an unopenable group must stay a card that does not open rather than a
  // rejection nobody is waiting on.
  const failing = {
    getSource: () => ({
      getClusterLeaves: (id, limit, offset, cb) => {
        Promise.resolve().then(() => cb(new Error('index is gone')));
      },
    }),
  };
  check((await photoLeaves(failing, 1, 10)).length === 0, 'nor is one the index cannot answer for');
}

console.log('\nOpening one opens the group it was part of');
{
  // The viewer is a gallery, and the app cannot work out what the group *is*:
  // clustering happens in the page, on a map the app cannot see. So the card
  // sends the whole list and the bridge reads it — one more pair of strings
  // written in two languages that no compiler checks.
  check(/ask: 'view', scan, i, group/.test(photosJs) && /ask: 'play', scan, i, group/.test(photosJs),
    'the page sends the group with both of the messages that open something');
  check(photoInfoJs.includes('groupIndices()'), 'the card builds it out of what was tapped');
  check(/viewPhoto\(item\.i, groupIndices\(\)\)/.test(photoInfoJs)
    && /playVideo\(item\.i, groupIndices\(\)\)/.test(photoInfoJs),
    'and passes it to both');
  check(/body\["group"\] as\? \[Int\]/.test(bridgeSwift), 'and the app reads it under that name');

  // Indices into a list the app owns, arriving from a page. Out of range has to
  // be a photograph missing from the gallery, never a crash.
  check(/\.filter \{ snapshot\.indices\.contains\(\$0\) \}/.test(bridgeSwift),
    'every index is checked against the scan it claims to belong to');
  check(/wanted\.isEmpty \? \[i\] : wanted/.test(bridgeSwift),
    'and a page too old to send one still gets the photograph it asked for');

  // The whole group, not a window around the tap. A viewer that quietly holds
  // less than what you tapped is the strip's old 48-item cap all over again.
  check(!/prefix\(|suffix\(|\.dropFirst|maxGroup|GROUP_LIMIT/.test(bridgeSwift),
    'and nothing silently trims it on the way in');

  check(/UIPageViewController/.test(gallerySwift), 'the gallery pages rather than replaces');
  check(/isVideo/.test(gallerySwift),
    'and a video is a page of it, so a holiday of stills and clips is one thing');
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
  // The strip is newest first, so the list arrives descending — a span read off
  // the first and last entries would be printed backwards.
  check(groupWhen([...across].reverse()) === groupWhen(across),
    'and reads the same span whichever way round the list is',
    `${groupWhen([...across].reverse())} vs ${groupWhen(across)}`);
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

console.log('\nA video is a point you can play, and never a photograph that will not');
{
  // The first cut left videos off the map, because `requestImage` gives a poster
  // frame and a video that looks like a photograph and will not play is worse
  // than one that is absent. They are back because there turned out to be a
  // right way to show one — not by moving it into the page, which is impossible
  // at any size, but by putting a native player in front of the page.
  check(/isVideo: Bool/.test(librarySwift), 'the reader says which assets move');
  check(/mediaType == \.video/.test(librarySwift), 'read from the asset rather than guessed');
  check(/requestPlayerItem/.test(librarySwift), 'and one is asked for as a player item, not a download');
  check(/AVPlayerViewController/.test(playbackSwift) && /AVPlayer\(playerItem:/.test(gallerySwift),
    'which is handed to the system player');
  // The silent-video bug, which was never a Photos bug: an app that sets no
  // category gets `.soloAmbient`, and the ring switch silences that by design.
  check(/AVAudioSession/.test(playbackSwift) && /\.playback/.test(playbackSwift),
    'and the sound is asked for out loud, or the ring switch silences it');
  check(/notifyOthersOnDeactivation/.test(playbackSwift),
    'and given back, or the music you were playing never comes back');
  check(/\$0\.isVideo \? 1 : 0/.test(bridgeSwift), 'the flag travels with each point');
  check(/case "play"/.test(bridgeSwift), 'and the bridge answers a play message');
  // The reason this is not streamed into the page is the expensive thing to
  // re-derive, so it is pinned where the next person will look.
  check(/Content-Security-Policy|CSP/i.test(librarySwift) && /base64/.test(librarySwift),
    'why it is not handed to the page is written down');

  // The page's half: the flag has to survive into the features and back out of
  // a cluster, or the play button never appears on a grouped video.
  const fc = photoGeoJson([[47.37, 8.54, 1_693_742_400, 1], [47.37, 8.54, 1_693_742_401, 0]]);
  check(fc.features[0].properties.v === 1 && fc.features[1].properties.v === 0,
    'a feature knows whether it moves', JSON.stringify(fc.features.map((f) => f.properties.v)));
  check(!isVideo(0), 'and nothing is a video before a library has been read');
  check(videoCount() === 0, 'nor counted as one');
}

console.log('\nThe card calls things what they are');
{
  const still = [{ i: 0, t: 1_693_731_600, v: false }];
  const video = [{ i: 1, t: 1_693_731_600, v: true }];
  check(groupTitle(still) === 'Photo', 'one photograph is a photo', groupTitle(still));
  check(groupTitle(video) === 'Video', 'and one video is a video', groupTitle(video));
  check(groupTitle([...video, { i: 2, t: 1, v: true }]) === '2 videos', 'two videos are videos');
  check(groupTitle([...still, { i: 2, t: 1, v: false }]) === '2 photos', 'two photos are photos');
  // Calling forty videos "40 photos" is the small lie that made them feel broken
  // in the first place.
  check(groupTitle([...still, ...video]) === '2 photos and videos', 'and a mixture is neither',
    groupTitle([...still, ...video]));
}

console.log('\nThere is no "Open in Photos", and nothing left of it');
{
  // Removed after a real phone showed what it did: iOS has no public way to
  // open one asset, so the button opened the Photos app at whatever was last on
  // screen — a control that lies about what it does, exactly when you pressed it
  // because you wanted that photograph.
  check(!plist.includes('LSApplicationQueriesSchemes'), 'the query scheme is gone from Info.plist');
  check(!/UIApplication\.shared\.open|canOpenURL/.test(librarySwift), 'and nothing opens a URL any more');
  check(!/"open"/.test(bridgeSwift), 'the bridge no longer answers an open message');
  check(!/openPhotosApp|canOpenPhotos/.test(photosJs + photoInfoJs), 'and the page no longer asks');
  check(!/Open in Photos/.test(html), 'the button is out of the markup');
  // The reasoning is worth more than the button was: without it somebody adds it
  // back in a year, from the same first principles, and ships the same lie.
  check(/no public way/i.test(librarySwift), 'the reason it cannot exist is written where it would go back');

  const usage = plist.match(/<key>NSPhotoLibraryUsageDescription<\/key>\s*<string>([^<]*)</)?.[1] ?? '';
  check(!/never opens the photographs/i.test(usage), 'the permission text does not promise otherwise');
  check(/no image is ever uploaded/i.test(usage), 'and still promises the thing that is true', usage);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
