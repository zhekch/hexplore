import './style.css';
import {
  MAX_LEVEL,
  SQRT3,
  mercX,
  mercY,
  project,
  radiusOf,
  colsOf,
  normCol,
  cellCenter,
  pointToCell,
  parentOf,
  parseCellId,
  wrapLng,
} from './hexgrid.js';
import {
  loadCountries,
  countriesLoaded,
  countryNear,
  countryIdAt,
  mergeCountries,
  countryGeometry,
} from './countries.js';
import { auth, connection, mountAuth, serverBuild, serverUpdate } from './auth.js';
import { derived } from './derived.js';
import { installOffline, forgetAccountOffline, clearOfflineCaches } from './offline.js';
import { mountCellInfo } from './cell-info.js';
import { mountRouteInfo } from './route-info.js';
import { mountImport } from './import.js';
import { mountStats } from './stats-ui.js';
import { mountHomeAssistant } from './home-assistant-ui.js';
import { sourceLabel } from './locations.js';
import { mountColorPicker, hexAlpha, hexOpaque } from './color-picker.js';
import {
  HEAT_MODES, HEAT_NEIGHBOURHOOD, TYPE_COLORS, TYPE_MAX, TYPE_OTHER_COLOR, UNDATED_COLOR,
  ageStopsOf, cellColorOf, cellStats, heatMetric, hotOf, isHeatMode as isHeatColoring,
} from './coloring.js';
import { terrainStyle, satelliteStyle, washAnchorIn } from './basemap.js';
import {
  AUTO_LIGHT, BASEMAP_IMPORT, LIGHT_CHOICES, STANDARD_STYLE, configureStandard, hasMapboxToken,
  lightChoice, lightPreset, mapboxToken, presetTheme, refreshAutoLight, setLightChoice,
  setMapboxToken,
} from './mapbox.js';
import { rememberSunSite } from './sun.js';
import { installGlide } from './glide.js';
import {
  LABEL_SLOT_ID, MAPBOX, STYLE_KEY, WASH_SLOT_ID, ctrlClass, ctrlSelector, engineForBasemap, engineNow,
  geolocateStateOf, installAddLayerSlots, installGlobalStateShim, installSpriteShim, isSlot, loadEngine,
  matchMapboxRotation,
} from './gl-engine.js';
import { applySnow, isSnowMode, setSnowMode, snowMode, snowWanted } from './snow.js';
import {
  bannerMode, forgetSnapshot, isBannerMode, lastSnapshot, mergeSnapshots, readSnapshot,
  rememberSnapshot, setBannerMode,
} from './whats-new.js';
import { mountWhatsNew } from './whats-new-ui.js';
import { HEALTH_SOURCE } from './whats-new.js';
import { LOCALES, applyTranslations, locale, setLocale, t } from './i18n.js';

// The markup ships in English and is rewritten here, once, before anything is
// on screen. Done at the top of the module rather than on DOMContentLoaded
// because the document is still hidden at this point (see `booting` in
// src/boot.js) — a page that painted first would flash English at somebody who
// asked for something else.
applyTranslations();
// The theme is not handed over separately: it only ever changes by switching
// basemap, which replaces the style and rebuilds the overlay from scratch.
import {
  describeRailFeature, forgetRailHover, installRail, loadRailStyle, railDetail, railDetailChanged,
  railFeature, railLayerIds, removeRail, setRailGroup, setRailHover, setRailTechnical,
  splitRouteLabel,
} from './rail.js';
// The airports overlay is a dataset rather than a tile server, so unlike the
// railways above there is no proxy, no detail ceiling and no outage to report —
// see the note at the top of src/airports.js. The group *data* is still a lazy
// import, which is what these functions arrange between them.
import {
  airportGroupsOn, airportLayerIds, describeAirportFeature,
  installAirports, loadAirports, removeAirports,
} from './airports.js';
// The waymarked trails, which are pixels where the railways are vectors — see
// the head of src/trails.js for what that changes and what it costs. Not a lazy
// import: the whole module is a source spec, five names and a fetch, where the
// railway's is a 315 KB style.
import {
  TRAIL_THEMES, bboxAround, describeTrail, installTrails, removeTrails,
  setTrailTheme, tapCorners, trailTheme, trailThemeLabel, trailsNear,
} from './trails.js';
// Your photographs as points, which only the iOS app can draw: a photo library
// is on a phone, and the server has never held anything but the coordinates. In
// a browser `photosAvailable()` is false and the switch is not in the menu at
// all — see the note at the top of src/photos.js.
import {
  forgetPhotos, installPhotos, loadPhotos, photoCount, photoLayerIds, photoLeaves,
  photosAvailable, photosLimited, removePhotos, videoCount,
} from './photos.js';
import { mountPhotoInfo } from './photo-info.js';
import { mountKomoot } from './komoot-ui.js';
import { mountDevices, whenAgo } from './device-ui.js';
import { mountSources } from './sources-ui.js';
import { setClock, clockMode, refreshClock } from './clock.js';
import { mountStrava } from './strava-ui.js';
import { mountSync } from './sync-ui.js';
import { mountSettings } from './settings-ui.js';
import { mountExport } from './export-ui.js';
import { mountPersonal } from './personal-ui.js';
import { mountRail } from './rail-ui.js';
import { mountAirports } from './airports-ui.js';
import { mountMapbox } from './mapbox-ui.js';
import { mountSearch } from './search-ui.js';
import { mountHome } from './home-ui.js';
import { mountIntro } from './intro-ui.js';
import { INTRO_SEEN_KEY, INTRO_VERSION, hostKind, shouldIntro } from './intro.js';
import { activeDays, findHome, TRIP_NAME_MAX } from './trips.js';
import {
  loadRegions, regionsLoaded, regionAt, regionNear, regionGeometry, mergeRegions, regionsInCountry,
  loadFineRegions, fineRegionsLoaded, fineCountryKnown, countriesInView, fineCountryOutline,
  regionById, regionTerm, fineRegionsVersion,
} from './regions.js';
import { geometryAreaM2 } from './regions.js';
import { countryAreaKm2, countryIso } from './countries.js';
import {
  continentOf, continentGeometry, continentAreaKm2, continentAnchor,
  countriesInContinent, mergeContinents, forgetContinents,
} from './continents.js';
import { cellAreaKm2, areaOfCell, WHOLE_COUNTRY } from './stats.js';
import { asMulti, unionGeometries } from './polygon.js';
import { mountBackup } from './backup-ui.js';
import { createHistory, plural } from './history.js';
import { showToast } from './toast.js';
import { busy } from './busy.js';
import { routesToFC, totalLength, formatDistance, canonicalSport, duplicateRoutes } from './routes.js';
import { reconcilePrefs, remoteToken } from './prefs.js';
import { loadPlaces, describeRoute, nearestTown } from './places.js';
import { createBlobLayer, blobsSupported, BLOB_ALPHA, BLOB_HEAT_ALPHA } from './blob-canvas.js';
// The one place that asks the map where its camera is, and the only arithmetic
// that knows a camera can be turned or leaned. Everything downstream still
// receives a rectangle of Mercator metres.
import { boxArea, boxContains, cameraOf, groundBox, lngLatBox, mercPerPixel } from './view.js';
import { installScrollChain } from './scroll-chain.js';
import { installCardLift } from './card-lift.js';

// Every panel in the app is a scrolling column with scrolling lists inside it,
// and on a phone the inner list is a dead end unless the hand-off is written by
// hand. Installed once, for the whole document.
installScrollChain();

// And on a phone an open card covers the button cluster in the corner, so the
// cluster moves above it — by however tall the card actually is. Installed once
// too, and it watches the cards rather than being told about them.
installCardLift();

// Past the finest hex levels (0..MAX_LEVEL), one more zoom-out step swaps the
// hex regions for whole-country fills — and one more after that dissolves those
// into continents, each labelled with how many of its countries you have been
// to. That last one is Auto-only: there is a Detail button for the two ends of
// the useful range and for regions, and a continent is not a *detail* anyone
// pins a valley to.
const COUNTRY_LEVEL = MAX_LEVEL + 1;
const CONTINENT_LEVEL = COUNTRY_LEVEL + 1;

// --- View tuning ---------------------------------------------------------------
// Grid geometry (cell size, levels, mercator math) lives in src/hexgrid.js —
// shared with the import scripts so both always agree on cell ids.
//
// Each level is 3× wider than the previous, and every big-cell center lands
// exactly on a small-cell center, so crossfades look concentric.
const LEVEL_STEP = Math.log2(3); // ≈ 1.585 zoom levels per grid level
// Zoom at which the finest level takes over. Every coarser level switches
// LEVEL_STEP zooms below this, so lowering it makes the grid stay on smaller
// cells longer — you have to zoom out further before cells enlarge.
const LEVEL0_ZOOM = 10;

const VIEW_PAD = 0.35; // extra region coverage around the viewport, per side

// --- Which way the camera may point --------------------------------------------
// The map turns. It did not, for a long time, and the reason was never that
// anybody wanted a map you could only look at from the south: it was that every
// renderer here asks the same question — *what ground can the camera see* — and
// the only code that answered it read `map.getBounds()` and padded a north-up
// rectangle by a third. Turn the map and that rectangle is the wrong ground.
// src/view.js answers it from the camera instead, so this is now a switch
// rather than a rewrite.
//
// What a rotation costs: the smallest north-up box around a turned viewport is
// larger than the viewport — nothing at all at each quarter turn, and
// (W+H)²/2WH of it on the diagonal, which is exactly 2 for a square window and
// a little more the longer the window is. The blob sheet is painted into that
// box, so a map held on the diagonal pays about twice the pixels — bounded, as
// ever, by the caps in src/blob-canvas.js, which is why the worst case is a
// slightly softer wash rather than a slower one.
const ROTATE_ENABLED = true;

// ...and it leans. **Ctrl** (or the right button) and drag: sideways turns,
// up and down tilts, which is one gesture because they are one camera. Two
// fingers dragging vertically does the same on a touch screen. The compass that
// appears for a turn appears for a tilt too, and puts both back.
//
// Everything underneath it is the same machinery as the rotation: the blob
// sheet is a georeferenced quad, so it is drawn in perspective — and draped
// over terrain — by the same matrix that draws the basemap, and src/view.js
// computes the trapezoid of ground a leaning camera sees rather than pretending
// it is a rectangle.
//
// **60°, and the number is not a taste.** The horizon comes on screen when
// `cot(pitch) < tan(fov/2)`, which for the field of view both MapLibre and
// Mapbox ship is 71.6°. Below that there is ground everywhere the camera looks
// and nothing has to be invented to fill the top of the window; above it the
// map needs a sky, and a basemap that has not been given one draws its
// background colour up there instead. 60 keeps the horizon comfortably off
// screen at every zoom. `?pitch=` overrides it either way — `?pitch=0` for the
// old flat camera, `?pitch=80` to see what the sky would have to cover.
//
// What a lean costs is sharpness, not speed. The sheet is one flat raster over
// the whole visible ground, and the far edge of a perspective view is wider as
// well as further: measured, a 60° lean asks for **6.1× the ground** through
// the same window. The caps in blob-canvas.js then bind — `MAX_SIDE` even on
// Chrome, `JS_BLUR_MAX_PX` harder on WebKit — so the wash comes out about 1.7×
// softer there and 2.5× on WebKit, for exactly as long as the camera is tilted.
// Levelling restores the original sheet to the pixel; `coverageTooLoose` is
// what makes sure it actually does. The real fix is a tiled sheet rather than a
// viewport-sized one; see ARCHITECTURE.md.
// 60 on the four basemaps that have no sky. **85 on 3D, which has one** — and
// that is the whole of the difference. The rule above is not "60 is a good
// number", it is "do not let the horizon on screen unless something is drawing
// what is above it", and Standard draws a sky, a haze and a sun that moves with
// the light preset. Leaning past the horizon there is the view the basemap was
// made for; leaning past it on CARTO Dark fills the top of the window with
// #0e0e0e.
//
// What it costs is at the far edge, and it is the cost `PITCH_REACH` already
// bounds: past three screen heights the visited wash simply is not painted, so a
// hard lean shows the basemap running to its own horizon with no colour on it.
// That was true at 60 and is more visible at 85; it is not new, and the fix for
// it is the tiled sheet ARCHITECTURE.md describes.
const MAX_PITCH_FLAT = 60;
const MAX_PITCH_SKY = 85;
// `?pitch=` overrides either, and still clamps to 85 — above that the camera is
// under the ground.
const PITCH_ASKED = (() => {
  const asked = new URLSearchParams(location.search).get('pitch');
  if (asked === null) return null;
  const n = Number(asked);
  return Number.isFinite(n) ? Math.min(MAX_PITCH_SKY, Math.max(0, n)) : null;
})();
const maxPitch = () => PITCH_ASKED ?? (engine === MAPBOX ? MAX_PITCH_SKY : MAX_PITCH_FLAT);
const TILE_INSET = 0.92; // unvisited tiles shrink to leave a glass gap
// Vector region smoothing — used for the selection ring, and for regions only
// on browsers that can't run the blob canvas (src/blob-canvas.js does the real
// thing). Repeated corner-cutting (Chaikin) converges on a smooth quadratic
// B-spline; each round doubles the point count.
const SMOOTH_ROUNDS = 4;
// How far each cut moves in from the corner (0.25 = classic Chaikin).
const SMOOTH_CUT = 0.28;
// false renders visited regions as fill only; true restores the outline + glow.
const SHOW_REGION_BORDERS = false;

// Edit-mode tile spotlight: tiles render only near the cursor and fade out
// toward the rim, so zoomed-out views never build a viewport full of cells.
const SPOT_PX = 300; // spotlight radius in screen px
const SPOT_FADE_START = 0.5; // fraction of the radius where the fade begins
const SPOT_MAX_CELLS = 2200; // shrink the spotlight when cells get tiny

// Level changes cross-dissolve rather than cut. Long enough to read as one
// shape relaxing into another, short enough not to lag behind a zoom gesture.
const LEVEL_FADE_MS = 620;

// Saved routes are drawn over the regions in their own color rather than the
// accent: they have to stay legible whatever the visited areas underneath them
// are painted, in every heat mode and on both basemaps. A soft wide glow under
// a crisp core keeps the same glass look as everything else.
const ROUTE_COLOR = '#ff9147';
// Zoom → width of the crisp core line, in screen px. The glow is a multiple of
// it, and the route you have open is drawn thicker still.
const ROUTE_WIDTH_STOPS = [
  [3, 0.9],
  [10, 2],
  [16, 3.4],
];
const ROUTE_GLOW_SCALE = 3.4;
const ROUTE_SELECTED_SCALE = 1.7;
// How much the glow grows under the pointer. Well short of the selected bump,
// because hovering is not choosing: this only has to say *this one*, and it says
// it against four other routes that are not doing it.
const ROUTE_HOVER_SCALE = 1.45;
// How long the glow takes to come up and go down. Long enough to read as a
// light coming on rather than a redraw, short enough that sweeping across a
// dozen tracks does not leave a trail of them still fading.
const ROUTE_HOVER_MS = 160;
// How much of a wiggle is worth drawing, in screen pixels — the whole of the
// fix for the spikes that kept coming out of the glow at bends.
//
// A recorded track is a sampled thing with a few metres of noise on every fix,
// so at anything below street zoom its vertices are a pixel apart and every
// other one doubles back. The core line is a hairline and nearly opaque, so it
// swallows that: overlapping opaque geometry looks like geometry. The glow is
// the same line up to *twenty pixels* wide and half transparent, and there each
// fold composites twice — a hard-edged wedge, brighter than either the glow or
// the line, in the shape of an arrowhead. It reads as a rendering fault in the
// track and is a property of the track.
//
// No `line-join` fixes it, and that is worth writing down because it looks like
// a join problem: `bevel` and `round` were both tried against it and both show
// the same shredded ribbon, because the overlap is between whole *segments*,
// not at the corner between two.
//
// Both libraries take this option in **screen pixels** and apply it per zoom
// (`_pixelsToTileUnits` in MapLibre, `EXTENT / tileSize` in Mapbox GL JS), which
// is exactly the shape of the problem: detail finer than a pixel or two is noise
// at every zoom, and zooming in brings the real shape back untouched. It has to
// live on the source rather than on the glow, so the crisp line and its halo are
// drawn from the same geometry — a glow simplified on its own would leave the
// line wandering outside its own halo at every switchback.
//
// The default is 0.375 px, which is fine for a drawn polygon and far too fine
// for a walked line.
const ROUTE_SIMPLIFY_PX = 2;
// How much of the glow is edge, as a fraction of its whole width — and the
// second half of the same fix.
//
// This used to be a **count of pixels** (4 flat, 9 on the 3D basemap) against a
// width that runs from 5 px to 35 px depending on the zoom, the basemap and
// whether the route is the one you have open. Both libraries fade a blurred line
// from full strength at the centre to nothing at the outer edge over exactly
// this many pixels, so a blur of 9 on a glow 20 px wide leaves a *single pixel*
// of it at full strength: not a band with a soft edge, which is what a glow is,
// but a bright thread with a gradient hung off it. A track wobbles by a couple
// of pixels, so the thread wobbles with it and crosses itself, and every
// crossing composites twice — which is the shape the spikes actually had.
//
// And at the other end the count was larger than the glow: 9 px of falloff on a
// glow 5.4 px wide at country zoom, which is a halo drawn at a third of the
// opacity it was given, fading out before it ever reached full strength.
//
// A fraction has neither problem. It is the same softness at every zoom, in both
// states and on both basemaps, and it always leaves a body — at 0.3 the middle
// 40% of the glow is solid and only the outer 30% either side is gradient.
const ROUTE_GLOW_EDGE = 0.3;

// The trip or day being shown, drawn as a track of dots. Warm amber so it can
// never be mistaken for a saved route (orange) or the visited wash (the accent,
// which the viewer chooses), and dark enough not to disappear into a snowfield
// on the satellite basemap.
const TRACK_COLOR = '#ffcf4d';
// Zoom → dot radius in screen px. Generous at the bottom: a whole trip seen
// from country height is a dozen dots, and a 2 px dot at that size is the
// subtlety this replaced.
const TRACK_DOT_RADIUS = ['interpolate', ['linear'], ['zoom'], 2, 2.4, 6, 3.6, 11, 5.5, 16, 8];
const TRACK_LINK_WIDTH = ['interpolate', ['linear'], ['zoom'], 2, 1.4, 11, 2.2, 16, 3];

const HOME_ICON = 'home-marker';

/**
 * The little house, drawn once into an image the style owns.
 *
 * A sprite would mean shipping and loading one; a symbol layer with no image
 * draws nothing and says nothing about why. This is 26 device pixels of canvas,
 * rebuilt whenever the style is (`map.setStyle` throws every image away).
 *
 * Stroked twice: a wide white pass, then a dark one over it. That is the same
 * trick the basemap's own labels use, and it is what lets one thin outline read
 * on a dark map, a light one, and a photograph — without a coloured disc behind
 * it to guarantee contrast by shouting.
 */
function addHomeImage() {
  if (map.hasImage(HOME_ICON)) return;
  const px = 26;
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const c = document.createElement('canvas');
  c.width = px * dpr;
  c.height = px * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const house = () => {
    // Roof, then the walls under it — the same shape as the toggle beside it.
    ctx.beginPath();
    ctx.moveTo(5, 12.5);
    ctx.lineTo(13, 5.5);
    ctx.lineTo(21, 12.5);
    ctx.moveTo(7.4, 11.5);
    ctx.lineTo(7.4, 20);
    ctx.lineTo(18.6, 20);
    ctx.lineTo(18.6, 11.5);
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 4.5;
  house();
  ctx.strokeStyle = '#1b2431';
  ctx.lineWidth = 2;
  house();
  map.addImage(HOME_ICON, { width: px * dpr, height: px * dpr, data: ctx.getImageData(0, 0, px * dpr, px * dpr).data }, { pixelRatio: dpr });
}

// --- Chrome contrast ----------------------------------------------------------
// How dark the ground under the controls has to get before white text is
// readable again, and how bright before it isn't. Two thresholds, not one: a
// single one makes the chrome flicker between colours while you pan along a
// shoreline, which is worse than either colour would have been.
const CHROME_LIGHT_ENTER = 0.60; // perceived luminance, 0..1
const CHROME_LIGHT_LEAVE = 0.48;
// A square this many CSS pixels across, sampled at the middle of each control.
// Big enough to survive one bright roof, small enough to stay a cheap read.
const CHROME_SAMPLE_PX = 36;
// How long a newly chosen basemap's own word is protected from being read over.
// `idle` normally lifts it far sooner; this is only the backstop for a basemap
// that never finishes loading, which never sends one — and a stuck tile must
// not be able to switch the reading off for the rest of the session.
const CHROME_PRESUME_MS = 4000;

const PLACE_ICON = 'place-marker';

/**
 * The pin dropped where a searched-for place is, drawn the same way the house
 * is and for the same reason: one image the style owns, stroked twice so a thin
 * outline reads on a dark map, a light one and a photograph alike.
 *
 * A teardrop rather than a house — it answers a different question. The house
 * says "this is where you live"; the pin says "this is the Venice you asked
 * for", and it goes away as soon as you look at something else.
 */
function addPlaceImage() {
  if (map.hasImage(PLACE_ICON)) return;
  const px = 30;
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const c = document.createElement('canvas');
  c.width = px * dpr;
  c.height = px * dpr;
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const pin = () => {
    // A drop with its point at the bottom, so the tip marks the spot rather
    // than the middle of the shape doing it.
    ctx.beginPath();
    ctx.moveTo(15, 27);
    ctx.bezierCurveTo(15, 27, 24, 17.5, 24, 11.5);
    ctx.arc(15, 11.5, 9, 0, Math.PI, true);
    ctx.bezierCurveTo(6, 17.5, 15, 27, 15, 27);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(15, 11.5, 3.3, 0, Math.PI * 2);
    ctx.stroke();
  };
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.lineWidth = 4.5;
  pin();
  ctx.strokeStyle = '#1b2431';
  ctx.lineWidth = 2;
  pin();
  map.addImage(PLACE_ICON, { width: px * dpr, height: px * dpr, data: ctx.getImageData(0, 0, px * dpr, px * dpr).data }, { pixelRatio: dpr });
}

const EMPTY = { type: 'FeatureCollection', features: [] };

// Whether the chrome is currently wearing dark text, and whether a read is due.
let chromeLight = false;
let chromeDue = false;
// A basemap that has been chosen but is not on screen yet. `chromePresumed`
// says the chrome is wearing that basemap's own word and no reading may argue
// with it; `chromeStyleSeen` says the basemap in question has at least parsed,
// because the map also sits idle in the gap before a built style has been
// fetched and that idle is still the outgoing map. See the `idle` handler.
let chromePresumed = false;
let chromeStyleSeen = false;
let chromePresumeTimer = 0;

/**
 * Read the frame under the map controls and decide whether white text still
 * works over it.
 *
 * The pixels have to be taken *during* a render: the drawing buffer is only
 * valid inside that callback unless the map is built with
 * `preserveDrawingBuffer`, which costs a full copy of every frame to serve a
 * question asked a few times a minute. So this schedules a read and the render
 * hook performs it. Everything about it is best-effort — a WebGL context that
 * won't give up its pixels leaves the chrome exactly as the basemap's own theme
 * set it, which is the answer that was right before any of this existed.
 */
function readChromeLuminance() {
  const gl = map.painter?.context?.gl;
  const canvas = map.getCanvas();
  if (!gl || !canvas) return null;
  // Every surface that is glass rather than paint, so all of them agree. The
  // palette earns its place here now that it is a veil over the map like the
  // menu: it covers the middle of the screen, and a bright valley there under a
  // dark corner up by the buttons would otherwise leave it wearing white text
  // on a pale card.
  const boxes = ['layers-cluster', 'layers-menu', 'search-card']
    .map((id) => document.getElementById(id))
    .filter((el) => el && !el.hidden && el.offsetParent)
    .map((el) => el.getBoundingClientRect());
  if (!boxes.length) return null;
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / Math.max(1, rect.width);
  const side = Math.max(2, Math.round(CHROME_SAMPLE_PX * dpr));
  let total = 0;
  let n = 0;
  for (const b of boxes) {
    // WebGL's origin is bottom-left; the page's is top-left.
    const cx = Math.round((b.left + b.width / 2 - rect.left) * dpr);
    const cy = Math.round((rect.bottom - (b.top + b.height / 2)) * dpr);
    const x = Math.max(0, Math.min(canvas.width - side, cx - side / 2));
    const y = Math.max(0, Math.min(canvas.height - side, cy - side / 2));
    const px = new Uint8Array(side * side * 4);
    try {
      gl.readPixels(x, y, side, side, gl.RGBA, gl.UNSIGNED_BYTE, px);
    } catch {
      return null;
    }
    // Every 4th pixel: the answer is an average, and a quarter of them is
    // plenty of one.
    for (let i = 0; i < px.length; i += 16) {
      // Rec. 709 luma — green carries most of what the eye calls brightness,
      // so a plain mean would call a saturated blue lake as bright as a beach.
      total += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
      n++;
    }
  }
  return n ? total / n : null;
}

/**
 * Put the current decision on the document.
 *
 * Written against what is there rather than against the last decision:
 * returning early on "nothing changed" leaves no way back if the attribute and
 * the flag ever disagree, and then the chrome stays as it is for good.
 */
function writeChrome() {
  const on = document.documentElement.getAttribute('data-chrome') === 'light';
  if (on === chromeLight) return;
  if (chromeLight) document.documentElement.setAttribute('data-chrome', 'light');
  else document.documentElement.removeAttribute('data-chrome');
}

/**
 * Take the new basemap's word for it, immediately.
 *
 * Sampling cannot answer this quickly: the pixels only mean something once the
 * new map has painted, which is a couple of seconds of tiles away, and until
 * then the menu sat in the old basemap's colours. But the basemap already
 * declares whether it is light or dark — that is where `data-theme` comes from,
 * and it flips on the same tick you click. So the chrome flips with it and the
 * reading that follows only has to *correct* the guess, which it does for the
 * one case the declaration cannot cover: imagery, which is nominally dark and
 * is a snowfield often enough to matter.
 *
 * The guess also has to be protected until the basemap it is a guess about is
 * the one being drawn, or the correction arrives before the thing it is meant
 * to correct — see applyChromeContrast.
 */
function presumeChrome() {
  chromeLight = STYLES[styleKey]?.theme === 'light';
  chromePresumed = true;
  chromeStyleSeen = false;
  clearTimeout(chromePresumeTimer);
  chromePresumeTimer = setTimeout(trustChrome, CHROME_PRESUME_MS);
  writeChrome();
}

/**
 * Let readings speak again.
 *
 * Called from `idle`, which is the honest signal — every tile that was coming
 * has come, so what is on screen is the basemap the guess was about. The
 * deadline behind it exists because a basemap that never finishes loading never
 * sends one, and satellite is the basemap most likely to hang *and* the one
 * that needs the reading most. Protecting the guess for good would turn one
 * stuck tile into imagery with no contrast correction at all.
 */
function trustChrome() {
  clearTimeout(chromePresumeTimer);
  if (!chromePresumed) return;
  chromePresumed = false;
  refreshChrome();
}

/**
 * A reading is only worth having once the basemap it is a reading *of* is on
 * screen. Between choosing one and its first painted frame the map still shows
 * the outgoing basemap, and `styledata` fires squarely inside that window: the
 * new style has parsed, none of its tiles have arrived, and the pixels under
 * the menu are still the old map's. Switching from Light to Dark took the
 * chrome dark on the click and a reading of the departing light map put it
 * straight back, where it stayed until the settled reading a second later —
 * which is the lag this whole mechanism was built to remove, arriving by its
 * own hand. So while a presumption stands the declaration is simply left alone.
 */
function applyChromeContrast() {
  if (chromePresumed) return;
  const lum = readChromeLuminance();
  if (lum == null) return;
  chromeLight = chromeLight ? lum > CHROME_LIGHT_LEAVE : lum > CHROME_LIGHT_ENTER;
  writeChrome();
}

/** Ask for a fresh reading at the next frame the map draws anyway. */
function refreshChrome() {
  chromeDue = true;
  map.triggerRepaint();
}


// --- Startup view --------------------------------------------------------------
// Priority: last saved view (if REMEMBER_VIEW) → IP-based location (city
// level) → world view.
const REMEMBER_VIEW = false; // true → resume the last camera position on load
const VIEW_KEY = 'visited-map:view:v1';
const IP_ZOOM = 10.5; // zoom used when landing on the IP-based location

function savedView() {
  if (!REMEMBER_VIEW) return null;
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null');
    if (v && Number.isFinite(v.lng) && Number.isFinite(v.lat) && Number.isFinite(v.zoom)) {
      // Which way the camera was pointing is part of where it was. A view
      // written before the map could turn has neither, and 0 is what it meant.
      return {
        ...v,
        bearing: Number.isFinite(v.bearing) ? v.bearing : 0,
        pitch: Number.isFinite(v.pitch) ? v.pitch : 0,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

const initialView = savedView();

// --- Basemap styles & overlays -----------------------------------------------
// The basemaps on offer. `theme` picks a legible tile colour for edit mode and
// decides how routes and the visited wash are lifted for contrast.
//
// Two kinds of entry: a `url`, which MapLibre fetches itself, or a `build()`
// that returns a style object — used where the published style needs changing
// before it is usable (see src/basemap.js). To add a basemap, add a line here.
const STYLES = {
  dark: {
    label: 'Dark',
    url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
    theme: 'dark',
    cellAlpha: 1,
    heatAlpha: 1,
  },
  terrain: {
    label: 'Terrain',
    build: terrainStyle,
    theme: 'dark',
    // Tune the visited wash for this basemap here — see regionOpacity().
    cellAlpha: 1,
    heatAlpha: 1,
    // Only if OpenFreeMap is unreachable — the plain dark basemap beats a blank
    // screen.
    fallback: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
  voyager: {
    label: 'Light',
    url: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
    theme: 'light',
    cellAlpha: 1,
    heatAlpha: 1,
  },
  // Mapbox Standard, and the only entry that is not MapLibre's to draw.
  //
  // Two things follow from `engine`, and they are the whole reason this basemap
  // is different in kind from the other four. It is loaded by a different
  // library, so choosing it or leaving it **reloads the page** — see
  // `setStyleKey` and src/gl-engine.js. And it can be *unavailable*: Mapbox
  // serves nothing without an account, this app does not have one, and the
  // viewer's own token is what switches it on. `needsToken` is what lets the
  // picker say so rather than leaving a button that silently does nothing.
  //
  // No `build`. Standard is a style *import* and Mapbox GL JS resolves it —
  // there is nothing here to fetch and rewrite, which is most of what made the
  // MapLibre version of this basemap a worse copy of it.
  mapbox: {
    label: '3D',
    url: STANDARD_STYLE,
    needsToken: hasMapboxToken,
    // Alone among the five, this one's theme is not a constant: Standard's light
    // preset turns the whole map dark at dusk and at night, and everything the
    // app decides from a theme — chrome colour, how the wash and the routes are
    // lifted for contrast — has to follow it. See LIGHT_PRESETS in src/mapbox.js.
    get theme() {
      return presetTheme();
    },
    // How hard Standard's atmosphere eats what we draw over it — see vivid().
    // Mapbox GL JS fogs the whole scene, ours included, and the haze it mixes
    // toward is a pale grey by day and a dark desaturated blue after dark. A
    // route and a visited region were coming out the colour of the sky.
    //
    // Two numbers, `[saturation ×, lightness lift]`, and night gets much more of
    // both: at day the haze is bright enough that lifting further would only
    // wash the colour out, and at night nothing survives without it.
    // Much gentler than it was. This started as the whole answer to "the routes
    // and the regions vanish at night", and it was treating a symptom: the cause
    // was that our layers were being *lit* by the scene, which `selfLit()` in
    // src/gl-engine.js now refuses on their behalf. What is left for this to do
    // is the fog, which emissive strength does not touch — a little more
    // saturation so a colour still reads as itself across a hazy distance.
    lift: () => (presetTheme() === 'dark' ? [1.2, 0.05] : [1.15, 0.02]),
    // The wash is a layer opacity on top of that, and the same argument applies
    // — a colour fogged toward the night sky needs to be laid on thicker before
    // it reads as a colour at all.
    get cellAlpha() {
      return presetTheme() === 'dark' ? 1.1 : 1;
    },
    get heatAlpha() {
      return presetTheme() === 'dark' ? 1.1 : 1;
    },
    // Only reached if Mapbox GL JS itself cannot be loaded, which puts us back
    // on MapLibre with no Mapbox style to give it. Light, because that is the
    // theme the chrome has already been painted in by then.
    fallback: 'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  },
  satellite: {
    label: 'Satellite',
    build: satelliteStyle,
    // Imagery is dark enough that the dark-theme contrast rules are the right
    // ones — a light wash over aerial photography disappears.
    theme: 'dark',
    // Tune the visited wash over imagery here — see regionOpacity().
    cellAlpha: 1.3,
    heatAlpha: 1.3,
    fallback: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },
};

// Something valid to open on while a built style is being fetched. Just a
// background, in the tone the finished style will have, so the swap doesn't
// flash.
const placeholderStyle = (theme) => ({
  version: 8,
  sources: {},
  layers: [
    {
      id: 'placeholder',
      type: 'background',
      paint: { 'background-color': theme === 'light' ? '#eae7e1' : '#333f33' },
    },
  ],
});

// Which library has to draw a given basemap. The answer lives in gl-engine.js
// rather than on the STYLES entries below, because boot.js has to ask it before
// this module can be parsed — see the comment on MAPBOX_BASEMAPS there.
const engineOf = engineForBasemap;

/**
 * What to hand the map library for a basemap: a URL straight through, or the
 * built style object. A build that fails falls back rather than leaving no map.
 */
async function resolveStyle(key) {
  const entry = STYLES[key];
  if (!entry?.build) return entry?.url;
  try {
    return await entry.build();
  } catch (e) {
    console.warn(`Basemap "${key}" could not be built; falling back.`, e);
    return entry.fallback;
  }
}

// Which parts of the train-tracks overlay are switched on. The overlay itself
// is session-only (see `railOn` below) but these are a shape of the thing rather
// than a state of this visit: someone who never wants the kilometre posts never
// wants them, and having to switch them off again each morning would be its own
// small annoyance. Anything not named here falls back to RAIL_GROUP_DEFAULTS.
const RAIL_GROUPS_KEY = 'visited-map:rail-groups:v1';
let railGroupsOn = (() => {
  try {
    return JSON.parse(localStorage.getItem(RAIL_GROUPS_KEY)) ?? {};
  } catch {
    return {};
  }
})();

// Whether the sidings, the yard roads, the lifted line and the junction-and-site
// "stations" are drawn. Off, because they are the difference between a station
// you can read and a knot of grey.
const RAIL_TECHNICAL_KEY = 'visited-map:rail-technical:v1';
let railTechnicalOn = localStorage.getItem(RAIL_TECHNICAL_KEY) === 'on';

// Whether a tap on a railway does anything.
//
// Off, and that is the point of it: the overlay's first job is to show where the
// railways are, and while it is on, every tap on the map has to go through a hit
// test across 288 layers before it can be about the ground. Someone reading the
// tracks over their own map wants the second thing; someone reading the railway
// wants the first, and says so once.
const RAIL_INTERACTIVE_KEY = 'visited-map:rail-interactive:v1';
let railInteractive = localStorage.getItem(RAIL_INTERACTIVE_KEY) === 'on';

// Which kinds of airfield the airports overlay draws. Same reasoning as the rail
// groups above — a shape of the thing rather than a state of this visit — with
// one addition of its own: a group here is also a download, so a choice that did
// not survive a reload would re-fetch a file the browser already holds.
// Anything not named falls back to the group's own default in src/airports.js.
const AIRPORT_GROUPS_KEY = 'visited-map:airport-groups:v1';
let airportGroupsChosen = (() => {
  try {
    return JSON.parse(localStorage.getItem(AIRPORT_GROUPS_KEY)) ?? {};
  } catch {
    return {};
  }
})();

let styleKey = localStorage.getItem(STYLE_KEY) ?? 'dark';
if (!STYLES[styleKey]) styleKey = 'dark';
// A basemap that needs a token, remembered from a visit when there was one.
// Left alone it would open the map on the placeholder background and stay
// there, because the build throws before it can fall back. Light rather than
// the default Dark: 3D is a light basemap, and coming back to a map that has
// changed colour as well as provider reads as two things having gone wrong.
if (STYLES[styleKey].needsToken && !STYLES[styleKey].needsToken()) styleKey = 'voyager';
// Apply the matching chrome colors before the map initializes to avoid a
// white-on-light flash when the saved basemap is Voyager.
document.documentElement.dataset.theme = STYLES[styleKey].theme;
presumeChrome();

// --- The map library ----------------------------------------------------------
// Already loaded, by src/boot.js, which is the only route into this module and
// awaits the library before importing it. Read synchronously here because the
// whole of the rest of this file is written against `gl`, and a map built inside
// a `.then()` would put seven thousand lines into a callback.
// Both `let`, because switchEngine() replaces them: the library and the map
// built from it change together, and everything below reads whichever pair is
// current rather than the one this page opened on.
let { gl, engine } = engineNow();
// Standard is the only style MapLibre cannot draw, so if boot.js had to fall
// back to it the basemap has to give up too — otherwise the map opens on a
// placeholder background that never resolves into anything.
if (engineOf(styleKey) !== engine) {
  styleKey = 'voyager';
  document.documentElement.dataset.theme = STYLES[styleKey].theme;
  presumeChrome();
}
// Train tracks are deliberately session-only and always start disabled after
// a page reload. Their state still survives basemap switches within the page.
let railOn = false;

// Airports, on the other hand, are remembered. The tracks start off because
// switching them on is a conversation with somebody else's tile server — 2.25 MB
// of sprite atlas and a per-zoom health check — and a layer that expensive should
// be asked for rather than assumed. The airports are a file this app already
// ships, cached by the service worker, drawn from one GeoJSON source; there is
// nothing to spare anyone by forgetting the answer overnight.
const AIRPORTS_KEY = 'visited-map:airports:v1';
let airportsOn = localStorage.getItem(AIRPORTS_KEY) === 'on';

// The trails are remembered too, which puts them on the airports' side of that
// argument rather than the railways'. They are somebody else's tile server, so
// the first half of the railway's reasoning applies — but not the half that
// decides it: there is no sprite atlas, no style to fetch and no health check,
// only PNGs of a kilobyte or two for the tiles already on screen, and this
// app's own server holds them so a second look costs nobody anything. Somebody
// who walks with this map open wants the paths on it, and being asked again
// every morning is the wrong question.
const TRAILS_KEY = 'visited-map:trails:v1';
let trailsOn = localStorage.getItem(TRAILS_KEY) === 'on';

// Whether a tap asks the trails what runs past instead of asking the ground.
//
// Off unless switched on, like the railway's equivalent and for a sharper
// version of the same reason. A raster overlay cannot tell whether the tap
// landed on a route at all — there is nothing in a picture to hit-test — so
// unlike the railways, this cannot answer when it has something and stand aside
// when it does not. While it is on it takes *every* tap that reaches it. That is
// a real trade rather than a free affordance, so it is asked for.
const TRAIL_TAP_KEY = 'visited-map:trails-tap:v1';
let trailsInteractive = localStorage.getItem(TRAIL_TAP_KEY) === 'on';
// Which of their five renderings. Read once here so the seg and the layer agree
// from the first frame; `setTrailTheme` is what writes it back.
let trailThemeOn = trailTheme();

// And the photographs, remembered for the same reason as the airports: the cost
// of switching them on is a metadata query against a library that is already on
// this phone, so there is nothing to spare anyone by forgetting the answer
// overnight. The key is read on a laptop too and simply never used — the row
// that would set it is not in the menu there.
const PHOTOS_KEY = 'visited-map:photos:v1';
let photosOn = localStorage.getItem(PHOTOS_KEY) === 'on';

// Whether a tap on the ground opens a card about it.
//
// On unless it has been switched off, which is the opposite default from the
// railway's equivalent and for the opposite reason: asking a cell what it knows
// is what this map is *for*, where a railway is somebody else's reference data
// laid over it. What it costs is that reading the map with a finger opens a card
// every other tap, and this is the way to say "I am just looking".
//
// It governs the ground only — cells, regions, countries, continents. A route,
// a photograph, an airport and a railway are all things you aimed at rather than
// the ground you happened to touch, and they keep answering.
const CELLS_TAP_KEY = 'visited-map:cells-tap:v1';
let cellsInteractive = localStorage.getItem(CELLS_TAP_KEY) !== 'off';
// Whether the home marker is drawn. A way of looking at the map rather than a
// fact about it, so it lives beside `railOn` in localStorage and not in the
// account preferences — where *home is* follows the account, whether you are
// currently looking at it does not.
//
// Three states, not two: 'on', 'off', and **never asked**. Left alone, the
// marker follows whether a home has actually been set — which is the answer
// somebody who has just pointed at their own house expects, and the one that
// keeps a map nobody has told anything from carrying a pin at a guess it has
// not explained. The switch, once touched, wins over both.
const HOME_SHOWN_KEY = 'visited-map:home-shown:v1';
let homeShownChoice = localStorage.getItem(HOME_SHOWN_KEY);
const homeShown = () => (homeShownChoice === null ? !!homePlace : homeShownChoice === 'on');

// Edit-mode glass tiles need a light fill on dark maps and a dark fill on light
// maps to stay visible.
const tileColors = () =>
  STYLES[styleKey].theme === 'light'
    ? { fill: 'rgb(30, 41, 59)', line: 'rgb(51, 65, 85)' }
    : { fill: 'rgb(240, 246, 255)', line: 'rgb(235, 243, 255)' };

// --- Map -----------------------------------------------------------------------
//
// The map is **rebuilt in place** when the basemap crosses between the two map
// libraries — see switchEngine(). That is the whole reason for the shape of
// what follows: a factory rather than one `new`, a `let` rather than a `const`,
// and a registry rather than a run of statements.
//
// `onMapBuilt(fn)` runs `fn` now and remembers it. Everything below that has
// something to say to a map object — a control to add, a handler to register, a
// DOM element of the library's own to go looking for — says it inside one of
// those, and `rewireMap()` says all of it again, in the same order, to a map
// that has just replaced the last one. The order is the point: handlers for one
// event fire in the order they were registered, and `installGrid` has to run
// after the handler that sets `chromeStyleSeen`.
//
// The alternative was collecting three hundred lines into one function at the
// bottom of the file, which would have moved every one of them away from the
// comment that explains it.
const mapWirers = [];
let map = null;

function onMapBuilt(fn) {
  mapWirers.push(fn);
  fn();
}

function rewireMap() {
  for (const fn of mapWirers) fn();
}

/**
 * @param {object|null} view where to point the camera, defaulting to the one
 *   this visit opened on. A rebuild passes the camera the outgoing map had, so
 *   swapping libraries does not also move the map.
 */
function createMap(view = initialView) {
  return new gl.Map({
    container: 'map',
    // A built style can't be awaited here. Rather than load a *different* basemap
    // and throw it away — a wasted fetch and a visible flash of the wrong map —
    // the map comes up on a bare background in roughly the right colour, and the
    // real style is set once it has been fetched and rewritten (see below).
    style: STYLES[styleKey].url ?? placeholderStyle(STYLES[styleKey].theme),
    center: view ? [view.lng, view.lat] : [15, 30],
    zoom: view?.zoom ?? 2.2,
    bearing: view?.bearing ?? 0,
    pitch: Math.min(maxPitch(), view?.pitch ?? 0),
    // Both stated rather than left to their defaults, because "the camera may not
    // lean" has to be true of the gesture as well as of the camera: a
    // right-button drag pitches as it rotates unless it is told not to.
    maxPitch: maxPitch(),
    pitchWithRotate: maxPitch() > 0,
    // Two, not 1.8, and not the 1 this briefly was. MapLibre asks for tiles at
    // floor(zoom), so anything below 2 is drawn on a basemap's z1 tiles, whose
    // coastlines are generalised far coarser than our own — see CONTINENT_ZOOM,
    // which is what gives the continent level room without going down there.
    // The old 1.8 had the same problem and nobody had looked: it floors to 1 too.
    minZoom: 2,
    maxZoom: 17.5,
    // Added by hand below so it can sit top-right, out of the geolocate button's
    // corner.
    attributionControl: false,
    // Flat, and stated rather than assumed. Mapbox GL JS v3 draws a **globe**
    // below about z6 unless told otherwise, and everything this app puts on the
    // map is built for a rectangle of Mercator metres — `groundBox` in
    // src/view.js is closed-form Mercator arithmetic, and the blob sheet is a
    // canvas pinned to four lng/lat corners. On a globe the sheet would be
    // stretched across a curved surface it was not painted for, at exactly the
    // zooms where it covers a continent. MapLibre defaults to Mercator and
    // accepts the same option, so this is said once for both.
    projection: 'mercator',
  });
}

/** Build the map and put the Mapbox-only `addLayer` wrapper on it. */
function freshMap(view) {
  const built = createMap(view);
  if (engine === MAPBOX) {
    // The two anchors this app inserts by — under the streets, under the labels
    // — are slots rather than layer ids, because Standard's layers live inside
    // an import and `getStyle().layers` comes back empty. One wrapper here
    // rather than a branch at each of the seventeen `addLayer` calls.
    installAddLayerSlots(built);
    // Then the global style state the railway style consults 1,529 times, which
    // wraps addLayer again — after the slots, so a resolved layer still gets its
    // anchor translated on the way through.
    installGlobalStateShim(built);
    // And the multi-sprite API the train tracks are built on. All three in
    // src/gl-engine.js, with the reasoning.
    installSpriteShim(built);
  } else {
    // MapLibre turns the map around its centre and Mapbox turns it by the
    // distance dragged, so the same gesture goes opposite ways on two basemaps
    // of one map. Mapbox's is the one this keeps.
    matchMapboxRotation(built);
  }
  return built;
}

map = freshMap();

// The place names that title imported routes come from GeoNames, which is
// CC BY 4.0 — the credit is required whether or not any route is on screen.
// (Natural Earth, used for the country level and the lake names, is public
// domain and asks for nothing.)
onMapBuilt(() => map.addControl(
  new gl.AttributionControl({
    compact: true,
    customAttribution: '<a href="https://www.geonames.org/">GeoNames</a>',
  }),
  'top-right',
));
// Right-button (or ctrl-) drag on a pointer, two fingers twisting on a touch
// screen, shift-arrows on a keyboard. MapLibre enables all of these by default;
// what this file used to do was turn them off.
//
// Tilting rides on the same handlers — `pitchWithRotate` above is what puts it
// on the vertical axis of the turn gesture, and `touchPitch` is its two-finger
// equivalent. Asked for by name rather than left to the default so that a
// `maxPitch()` of 0 really does mean the camera cannot lean, by any route.
onMapBuilt(() => {
  if (!ROTATE_ENABLED) {
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
  }
  if (maxPitch() > 0) map.touchPitch?.enable();
  else map.touchPitch?.disable();
  window.map = map; // handy in devtools
});

// Any user-initiated movement (or a geolocate flight) cancels the pending
// IP fly-in.
let userInteracted = false;
onMapBuilt(() => map.on('movestart', (e) => {
  if (e.originalEvent) userInteracted = true;
}));

// "My location" button — browser geolocation (works on localhost; production
// needs HTTPS). Clicking it pans to the viewer and shows the blue dot.
//
// Rebuilt with the map rather than handed to the new one: a control belongs to
// the map that made its element, and that element goes with `map.remove()`.
let geolocate = null;
// Where the browser last put you, so a second press can return there. Survives
// a rebuild, because where you are is not a fact about the map library.
let lastFix = null;
onMapBuilt(() => {
  geolocate = new gl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    fitBoundsOptions: { maxZoom: 14 },
    trackUserLocation: true,
  });
  geolocate.on('geolocate', (e) => {
    userInteracted = true;
    if (Number.isFinite(e?.coords?.longitude)) {
      lastFix = [e.coords.longitude, e.coords.latitude];
      // The best answer there is to "where is the client", which is the place
      // the 3D basemap's sun is put over when it is left on Auto. Written down
      // coarsely and re-read at the next load, so the map after this one opens
      // lit correctly before any of this has happened again — see src/sun.js.
      if (rememberSunSite(e.coords.latitude, e.coords.longitude)) refreshLightNow();
    }
  });
  // A fix is a report of where you were a second ago, not an instruction to
  // teleport. src/glide.js is what makes the dot walk to it — and what stops
  // the camera flying to each one while it is locked on you.
  installGlide(geolocate, map);
});

// Both libraries' tracking control is a three-state toggle: off → locked → (pan
// away) → background → off. That means pressing it twice without moving turns
// tracking *off* and takes the blue dot with it, which is never what "show me
// where I am" is asking for — the button appears to delete your own location.
//
// Only the locked→off step is intercepted. Background→locked is the control's
// own re-centre and is exactly right, so it is left alone.
//
// **Listened for on the document, not on the button, because the button may not
// exist yet.** MapLibre builds its control's UI inside `onAdd` and only checks
// the permission afterwards, so a `querySelector` in the same tick as
// `addControl` finds it. Mapbox GL JS does it the other way round — `onAdd`
// returns an empty container and `_setupUI` runs behind an async permissions
// check — so the same query found nothing at all, this bailed out on `!btn`,
// and the 3D basemap kept the exact behaviour this exists to remove. Delegating
// asks nothing about when the button was made, which is the only part of it
// either library ever promised.
//
// Capture, and `stopPropagation` rather than `stopImmediatePropagation`: the
// control's own handler is on the button itself, and stopping the event on the
// way down keeps it from reaching the target at all.
//
// Registered once for the page rather than per map, for the same reason: it is
// bound to nothing a rebuild replaces.
function keepGeolocateOn() {
  document.addEventListener(
    'click',
    (e) => {
      const btn = e.target?.closest?.(ctrlSelector('ctrl-geolocate'));
      // First press, or re-centring from background: both are the button doing
      // what it says. `geolocateStateOf` is the table of which classes mean
      // which state, and it reads both libraries' names for them.
      if (!btn || geolocateStateOf(btn) !== 'locked') return;
      e.stopPropagation();
      e.preventDefault();
      if (lastFix) map.easeTo({ center: lastFix, duration: 500 });
    },
    true,
  );
}
keepGeolocateOn();

// Zooming away from yourself should let go of you, and MapLibre's control does
// not: `_onMoveStart` drops ACTIVE_LOCK to BACKGROUND for any movement the user
// made — except one where `map.isZooming()` is true, which it exempts so that
// zooming in on yourself keeps you centred.
//
// On this map that exemption is wrong more often than it is right, because zoom
// is how you navigate here: zoom out to the country level to look at where you
// have been, and the button stays lit and still tracking. Nothing shows it,
// either — until the next fix arrives, minutes later, and flies the camera back
// to your street with no gesture anywhere near it to explain why.
//
// So do for a zoom exactly what the control already does for a pan, in the same
// order and leaving the same state behind. Reaching for `_watchState` is
// reaching inside the library, so it is read before it is written: a MapLibre
// that has renamed it leaves the control alone rather than breaking the button.
// The button is looked up inside the handler rather than beside the `map.on`,
// for the reason `keepGeolocateOn` is delegated: on Mapbox GL JS it does not
// exist yet when the control is added, and asking too early left the 3D basemap
// tracking you through every zoom with nothing on screen saying so.
function dropLockOnZoom() {
  map.on('zoomstart', (e) => {
    // A gesture, not the control's own fly-to and not one of ours.
    if (!e.originalEvent || geolocate._watchState !== 'ACTIVE_LOCK') return;
    const btn = document.querySelector(`.${ctrlClass('ctrl-geolocate')}`);
    if (btn) dropToBackground(btn);
  });
}

/**
 * Keep the blue dot, let go of the camera — the state the control itself lands
 * in when you pan away from yourself, reached by hand. Reaching for
 * `_watchState` is reaching inside the library, so every caller reads it before
 * writing it: a MapLibre that has renamed it leaves the control alone.
 */
function dropToBackground(btn) {
  geolocate._watchState = 'BACKGROUND';
  btn.classList.add(ctrlClass('ctrl-geolocate-background'));
  btn.classList.remove(ctrlClass('ctrl-geolocate-active'));
  geolocate.fire('trackuserlocationend');
  geolocate.fire('userlocationlostfocus');
}

/**
 * Whichever of the control's states the button is currently showing.
 *
 * Found under **both** libraries' class names, unlike everything else here,
 * because this is the one call made while the two disagree about which of them
 * is live: `switchEngine` reads it after the incoming library has loaded and
 * before the outgoing map is taken down. Asking `ctrlClass` there returns the
 * arriving library's prefix and matches nothing at all.
 *
 * Reading the classes it finds is `geolocateStateOf` in src/gl-engine.js, which
 * is where the note about BACKGROUND is — the second and larger half of why
 * this kept answering "off" for a control that was tracking.
 */
function geolocateState() {
  return geolocateStateOf(document.querySelector(ctrlSelector('ctrl-geolocate')));
}

/**
 * Turn "my location" back on after the map underneath it was replaced.
 *
 * Switching between the two map libraries replaces the map object, and a control
 * belongs to the map that made its element — so the new one comes up in its OFF
 * state and the blue dot is simply gone. Nothing said so: the button looked
 * exactly as it does before you have ever pressed it, and the only way to find
 * out was to press it again. Where you are is not a fact about which library is
 * drawing the ground.
 *
 * Two things make this awkward enough to be worth the words. The control sets
 * itself up behind an async permissions check and `trigger()` before that is a
 * no-op with a console warning — but it *returns false*, so asking until it
 * takes needs no private state and stops on its own. And a plain re-trigger
 * would fly the camera to you, which is right if you were locked on and wrong if
 * you had panned away: BACKGROUND is set before the first fix arrives, and the
 * control only moves the camera while ACTIVE_LOCK.
 */
function restoreGeolocate(was) {
  if (was === 'off') return;
  let tries = 0;
  const ask = () => {
    if (!geolocate || tries++ > 60) return;
    if (!geolocate.trigger()) {
      setTimeout(ask, 50);
      return;
    }
    if (was !== 'background') return;
    const btn = document.querySelector(`.${ctrlClass('ctrl-geolocate')}`);
    if (btn) dropToBackground(btn);
  };
  ask();
}

// Its own corner, so the attribution can have the top-right one to itself.
onMapBuilt(() => {
  map.addControl(geolocate, 'bottom-right');
  dropLockOnZoom();
});

// --- The compass ---------------------------------------------------------------
// Turning a map is easy to do by accident — a two-finger pinch that twists a
// few degrees, a right-drag meant for a context menu — and very hard to undo by
// hand, because "back to exactly north" is not a thing a gesture can hit. So
// the one control the rotation needs is the one that puts it back.
//
// It is in the cluster rather than a corner of its own, and it is only there at
// all while there is something to say: on a map facing north the button would
// be a permanent statement that north is up, which the map is already making.
const compassBtn = document.getElementById('compass-btn');
const compassNeedle = compassBtn?.querySelector('svg');

function refreshCompass() {
  if (!compassBtn) return;
  const bearing = map.getBearing();
  const pitch = map.getPitch();
  // Half a degree, not zero: `easeTo` lands on 1e-14 often enough, and a button
  // that will not go away after being pressed is worse than one that never
  // appeared.
  const turned = Math.abs(bearing) > 0.5 || pitch > 0.5;
  compassBtn.hidden = !turned;
  // North is at −bearing on screen, bearing being the direction that is up.
  // Set whether or not the button is showing: a needle left pointing where the
  // map used to face is one frame of wrong on the way back in.
  if (compassNeedle) compassNeedle.style.transform = `rotate(${-bearing}deg)`;
}

compassBtn?.addEventListener('click', () => {
  userInteracted = true;
  releaseCameraLock();
  map.easeTo({ bearing: 0, pitch: 0, duration: 400 });
});
onMapBuilt(() => {
  map.on('rotate', refreshCompass);
  map.on('pitch', refreshCompass);
  refreshCompass();
});

// Show the dot without being asked.
//
// Pressing the button was the only way to find out where you were, on a map
// whose entire subject is where you have been — and the answer was one tap away
// every single time. So the control is triggered once the map is up.
//
// It costs nothing this page was not already spending: the startup camera falls
// back to an *IP-based* guess (see "Startup view"), which is a worse answer to
// the same question, arrives over the network, and is replaced by this the
// moment a real fix lands. There is no saved camera to argue with, because
// REMEMBER_VIEW is off.
//
// Two things it deliberately does not do. It does not ask for permission a
// second time if the browser has already refused — `trigger()` on a denied
// permission fires `error`, the control puts itself back in its off state, and
// that is the end of it. And it does not fight you: the first fix moves the
// camera, but `userInteracted` is set by any pan or zoom before then, and the
// tracking control drops to background the moment you move the map yourself.
// Only ever once per visit, which is why the flag is not inside the handler's
// own scope: a rebuilt map fires `load` again, and re-triggering would fly the
// camera back to your street in the middle of a basemap switch.
let geolocateTriggered = false;
onMapBuilt(() => map.on('load', () => {
  // A permission already granted resolves without a prompt; one still
  // undetermined shows the browser's own, which is the same dialog the button
  // would have raised. On iOS the app has usually settled this at launch
  // already — see WebViewController.requestLocationIfNeeded.
  if (!navigator.geolocation || geolocateTriggered) return;
  geolocateTriggered = true;
  try {
    geolocate.trigger();
  } catch {
    // Triggering before the control has finished setting itself up throws
    // rather than warning. Nothing here is worth an unhandled error at boot.
  }
}));

// On a phone that corner is where the layers button lives too, and two glass
// pills stacked a gap apart read as clutter. Below the same breakpoint the
// bottom sheet uses (560px), move the geolocate button into the layers cluster
// so the two share one container; above it, put it back in the map's corner.
// The control doesn't care where its element sits — it talks to the map, not
// to its parent.
// Found again on every build rather than held: these are the map library's own
// elements, and `map.remove()` takes them with it.
let geoGroup = null;
let geoCorner = null;
const layersCluster = document.getElementById('layers-cluster');
const phoneMq = window.matchMedia('(max-width: 560px)');

function placeGeolocate() {
  if (!geoGroup || !geoCorner) return;
  const host = phoneMq.matches ? layersCluster : geoCorner;
  if (geoGroup.parentElement !== host) host.append(geoGroup);
}
phoneMq.addEventListener('change', placeGeolocate);
onMapBuilt(() => {
  geoGroup = document.querySelector(`.${ctrlClass('ctrl-bottom-right')} .${ctrlClass('ctrl-group')}`);
  geoCorner = geoGroup?.parentElement ?? null;
  placeGeolocate();
});

// Persist the camera so the next visit can resume where you left off
// (only used when REMEMBER_VIEW is on).
// The chrome's contrast is read inside a render, because that is the only
// moment the drawing buffer is valid — see readChromeLuminance. Panning changes
// what is underneath; so does a new basemap, and so does opening the menu.
onMapBuilt(() => map.on('render', () => {
  if (!chromeDue) return;
  chromeDue = false;
  applyChromeContrast();
}));

// A reading taken the moment the basemap changes is a reading of the *old*
// basemap: `styledata` fires while the new one is still tiles-in-flight, so
// switching from Light to Dark left the menu wearing its light colours until
// something else happened to ask again — reopening it, usually, which is how
// this was noticed. So each change also owes one more reading once the map has
// settled, and `idle` is exactly that moment.
//
// The flag is what stops it spinning: refreshChrome() calls triggerRepaint(),
// a repaint ends in another `idle`, and an unguarded handler would ask forever.
// One change, one settled reading.
let chromeSettleDue = false;
const askChromeAgain = () => {
  chromeSettleDue = true;
  refreshChrome();
};
onMapBuilt(() => map.on('styledata', askChromeAgain));
// Which basemap the presumption is about. Reset by presumeChrome and set here,
// so an idle that lands in the gap before a chosen style has even been fetched
// cannot be mistaken for the chosen style having been drawn.
onMapBuilt(() => map.on('style.load', () => {
  chromeStyleSeen = true;
}));
onMapBuilt(() => map.on('idle', () => {
  // Idle means every tile that was coming has come, so the basemap the chrome
  // presumed about is the one on screen and a reading may finally argue with
  // its declaration. Until then applyChromeContrast leaves the guess alone.
  if (chromePresumed && chromeStyleSeen) {
    chromeSettleDue = false;
    trustChrome();
    return;
  }
  if (!chromeSettleDue) return;
  chromeSettleDue = false;
  refreshChrome();
}));

/**
 * Write the camera down, so the next load opens where this one left off.
 *
 * Its own function because a basemap that changes the map *library* has to
 * reload the page, and the reload has to take the view with it — see
 * setStyleKey(). `moveend` alone would nearly always do, since it fires after
 * every gesture, but "nearly always" here means the one press that reloads
 * catching the camera mid-flight.
 */
function rememberView() {
  if (!REMEMBER_VIEW) return;
  try {
    const c = map.getCenter();
    localStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        lng: +c.lng.toFixed(5),
        lat: +c.lat.toFixed(5),
        zoom: +map.getZoom().toFixed(2),
        bearing: +map.getBearing().toFixed(1),
        pitch: +map.getPitch().toFixed(1),
      }),
    );
  } catch {
    /* storage unavailable */
  }
}

// Whether snow is on the map right now, so a camera move that changed the
// answer can be told from the thousand that did not. `null` means "nothing has
// been decided yet", which is distinct from "decided, and the answer was no" —
// and it is what a fresh style resets it to, since a style swap takes the snow
// with it and the renderer must be told again even though the answer is the same.
let snowOn = null;

/**
 * Put the snow on, or take it off, when that has changed.
 *
 * Called from two places, neither of which is the setting: after a style parses,
 * because a style swap drops the snow, and after a camera move, because "in
 * winter" is a question about *where the map is looking* (see src/snow.js) and
 * the answer flips at the equator.
 *
 * The comparison is the point. `setSnow` rebuilds the particle system, so
 * calling it on every `moveend` would restart the fall from an empty sky each
 * time somebody let go of the map — a snowfall that visibly begins again after
 * every pan. Working the answer out is arithmetic on one latitude and a month;
 * only a change reaches the renderer.
 */
function refreshSnow() {
  if (engine !== MAPBOX) return;
  const want = snowWanted(snowMode(), map.getCenter?.()?.lat ?? NaN);
  if (want === snowOn) return;
  snowOn = applySnow(map);
}

/**
 * The setting itself changed. Forces the re-apply that `refreshSnow` skips,
 * because the stored answer it compares against is exactly what has moved.
 */
function snowModeChanged(mode) {
  setSnowMode(mode);
  snowOn = null;
  refreshSnow();
  touchPrefs();
}

onMapBuilt(() => map.on('moveend', () => {
  askChromeAgain();
  rememberView();
  refreshSnow();
}));

// Tracks whether the basemap has become visible yet — before that, the
// IP landing can be instant (no animation on a blank screen).
let mapShown = false;
onMapBuilt(() => map.once('load', () => {
  mapShown = true;
}));

// First visit: aim the camera at the viewer's approximate location. The
// lookup runs in the browser (the API sees the viewer's public IP), so it
// works when the site is served from localhost too. VPNs resolve to the
// VPN's city; failures just leave the world view.
async function flyToIpLocation() {
  const providers = [
    ['https://get.geojs.io/v1/ip/geo.json', (d) => [+d.longitude, +d.latitude]],
    ['https://ipwho.is/', (d) => (d.success === false ? null : [+d.longitude, +d.latitude])],
  ];
  for (const [url, pick] of providers) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(url, { signal: ctl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const center = pick(await res.json());
      if (!center || !center.every(Number.isFinite)) continue;
      // Remembered whether or not the camera is allowed to move: where the
      // viewer is is a fact about them and not about the map. On a first visit
      // this is the earliest thing that knows it — the 3D basemap's Auto sun
      // wants a latitude and has been making do with a time zone until now.
      if (rememberSunSite(center[1], center[0])) refreshLightNow();
      if (!userInteracted && !savedView()) {
        if (mapShown) {
          // The map is already on screen: snap the center under the target
          // while still at world zoom (imperceptible), then zoom straight
          // down into it — no sideways pan at high zoom.
          map.jumpTo({ center });
          map.easeTo({ zoom: IP_ZOOM, duration: 1600 });
        } else {
          // Nothing rendered yet — just open the map at the target.
          map.jumpTo({ center, zoom: IP_ZOOM });
        }
      }
      return;
    } catch {
      /* try the next provider */
    }
  }
}
if (!initialView) flyToIpLocation();

// Keep the canvas in sync with the container even when the window itself
// doesn't fire a resize (embedded panes, dev tools, split views).
new ResizeObserver(() => map.resize()).observe(map.getContainer());

// ============================================================================
// >>> EDIT TOGGLE <<<  Flip this to true to bring editing back on.
// ----------------------------------------------------------------------------
// false → view-only map: the pencil button is hidden and clicks can never
//         modify cells (visited cells come from your imported history).
// true  → the pencil button appears; entering edit mode lets you click/paint
//         cells to mark them visited.
// The "Visited color" picker lives in the base-map menu regardless of this.
// ============================================================================
const EDIT_ENABLED = true;

// --- Mode & accent color -----------------------------------------------------
// 'view' (default): a normal map with only the colored regions visible.
// 'edit': a tile spotlight follows the cursor and clicks toggle cells.
const MODE_KEY = 'visited-map:mode:v1';
// One colour for both basemaps — what this was before the two were told apart.
// Still written, so rolling back to a build that only reads this one doesn't
// reset anybody's choice.
const COLOR_KEY = 'visited-map:color:v1';
const COLORS_KEY = 'visited-map:colors:v1';
const DEFAULT_ACCENT = '#60acff';

const isAccent = (v) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(v ?? ''));

let mode = EDIT_ENABLED && localStorage.getItem(MODE_KEY) === 'edit' ? 'edit' : 'view';
let tileVis = mode === 'edit' ? 1 : 0; // 0..1, tweened on mode change

/** Which of the two colours the basemap on screen calls for. */
const themeNow = () => (STYLES[styleKey]?.theme === 'light' ? 'light' : 'dark');

// The visited colour is picked *against the map underneath it* — that is the
// whole reason the picker repaints on every drag frame rather than showing a
// swatch. But "the map underneath it" is two different maps: a wash that reads
// as a confident blue over Dark is a pale wash over Voyager, and a colour with
// enough weight for the light basemap glares over imagery. One value could only
// ever be right for one of them, so there are two, and the basemap chooses.
//
// Only the single-colour mode uses them. The heat maps derive every cell's
// colour from its own history and never touch the accent (see accentAlpha),
// so there is nothing for them to keep two of.
const accents = savedAccents();
let accent = accents[themeNow()];

function savedAccents() {
  const out = { light: DEFAULT_ACCENT, dark: DEFAULT_ACCENT };
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(COLORS_KEY) ?? 'null');
  } catch {
    /* fine */
  }
  if (stored && typeof stored === 'object') {
    for (const k of ['light', 'dark']) if (isAccent(stored[k])) out[k] = String(stored[k]).toLowerCase();
    return out;
  }
  // A colour chosen before there were two of them. It was picked against
  // whichever basemap happened to be on, and nothing records which — so it
  // stands for both rather than being kept on a guess and reset on the other.
  const one = localStorage.getItem(COLOR_KEY);
  if (isAccent(one)) out.light = out.dark = String(one).toLowerCase();
  return out;
}

function saveAccents() {
  try {
    localStorage.setItem(COLORS_KEY, JSON.stringify(accents));
    localStorage.setItem(COLOR_KEY, accents.dark); // see COLOR_KEY
  } catch {
    /* fine */
  }
}

/**
 * Point `accent` at the colour for the basemap now on screen, and repaint if it
 * actually moved.
 *
 * Everything that draws the wash reads `accent` rather than the pair, so this
 * one assignment is the whole switch — and the guard matters: three of the four
 * basemaps are dark, so most basemap changes must not cost a re-raster of the
 * blob canvas.
 */
function syncAccent() {
  const next = accents[themeNow()];
  if (next === accent) return false;
  accent = next;
  colorPicker?.set(accent); // the swatch, and the panel behind it
  applyColors();
  // The opacity half of a colour lands on the layers rather than in them, so
  // the fades have to be re-pinned — the same reason the picker does it.
  applyFade(fade.cur);
  applyPrevFade(fade.prev);
  repaintAccent();
  return true;
}

// --- Coloring modes -----------------------------------------------------------
// The modes themselves — their labels, their ramps and the arithmetic that
// turns one rolled-up cell into a color — live in src/coloring.js, because the
// image export paints the same cells in the same modes and a second copy of the
// ramps would be a second answer to the same question. What stays here is what
// is genuinely the map's: the MapLibre expression built from those ramps, and
// the roll-up that produces the stats they read.
const HEAT_KEY = 'visited-map:heat:v1';
let heatMode = localStorage.getItem(HEAT_KEY) ?? 'flat';
if (!HEAT_MODES[heatMode]) heatMode = 'flat';

// Whether the visited areas are drawn at all. Pressing the coloring mode that
// is already on takes them off the map — the one thing the panel could not do
// was get out of the way, and "what does this valley actually look like" is a
// fair question to ask of a map you have painted over. `heatMode` is left
// alone, so bringing them back returns to the mode you had.
const CELLS_KEY = 'visited-map:cells:v1';
let cellsOn = localStorage.getItem(CELLS_KEY) !== 'off';

// Sources switched off in the Type legend. A filter over the view, not a
// deletion — Settings → Sources is where a source is actually taken off the map
// (see forgetSource) — so nothing is stored differently and switching one back
// on puts the map back exactly as it was.
//
// A cell is hidden by its *dominant* source, the one that speaks for it in the
// Type mode, so what disappears is precisely what was painted in that colour; a
// cell two sources vouch for stays as long as the louder one is on.
//
// **It applies in every mode, not only in Type.** The legend is the only place
// it can be set, which argued for scoping it there — but the roll-up it filters
// is a single shared thing, and the image export rebuilds that roll-up in
// whatever mode *it* is drawing. A filter that switched itself on and off with
// the mode would therefore change the map underneath you when the export dialog
// asked for a Type picture over a map showing First seen. One set of cells,
// always, is the only version of this with no such seam in it.
const HIDDEN_KEY = 'visited-map:hidden-sources:v1';
const hiddenSources = new Set(readHiddenSources());

function readHiddenSources() {
  try {
    const stored = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]');
    return Array.isArray(stored) ? stored.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveHiddenSources() {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...hiddenSources]));
  } catch {
    /* private mode, quota — the filter still applies for this session */
  }
}

// The value function for whichever mode is on, or null when regions are flat.
const heatMetricNow = () => heatMetric(heatMode);

// --- Blob canvas --------------------------------------------------------------
// Hex levels are painted into a canvas and blurred (src/blob-canvas.js) so the
// lattice dissolves and neighbouring colors bleed together. The country level
// keeps the vector path — those are real borders, not cells — and so does any
// browser without canvas filters.
const BLOBS = blobsSupported();
// The one module in the app that holds the map it was made for, so a rebuild
// makes a new one. Nothing is lost that installGrid does not repaint.
let blobCur = createBlobLayer(map, 'blob');
// Which side of a transition the blob canvas is on. Hex→hex level changes
// dissolve inside the canvas itself, so the layer just sits at full opacity
// ('none'); only a crossing to or from the vector country level makes the
// whole layer fade.
// 'off' is for a crossing the canvas has no part in — vector → vector, where
// both sides are polygons. Without it the incoming ramp drives the canvas back
// up to full strength underneath them, which is only invisible because it
// happens to have been cleared.
let blobRole = 'none'; // 'none' | 'in' | 'out' | 'off'

// There are two vector sources, `hex` and `hex-prev`, and either of them can be
// the live one. That is what lets two *vector* levels hand over to each other —
// regions giving way to countries — the same way a hex level and a vector level
// already do. `hex-prev` used to be a permanently empty scaffold: the outgoing
// side was always either the canvas or `hex` itself, and copying geometry onto
// the second source re-parsed and re-tiled what the map had already drawn, at
// the exact moment it was supposed to be fading out smoothly.
//
// It still isn't copied. On a vector → vector crossing the outgoing level stays
// exactly where it is and the *incoming* one is built on the other source —
// which has to be parsed either way — and the two swap places. Nothing is
// re-tiled that was already on screen.
//
// Each source carries its own role:
//   'in'    the live level, or the one fading in
//   'out'   the level fading out
//   'warm'  geometry pre-tiled for a crossing that hasn't happened yet, pinned
//           invisible until it is genuinely the incoming side
//   'idle'  empty
const vecRole = { '': 'in', '-prev': 'idle' };
let vecLive = ''; // the suffix whose source holds the live level
const vecIdle = () => (vecLive === '' ? '-prev' : '');
// The layer the vector trios are inserted before, so they can be re-stacked
// without being re-added. Set by installGrid.
let vecInsertBefore = undefined;

// What each source actually holds, so a repeat of the same data can be skipped
// (see setVecData). Declared up here because the fade helpers below reach for
// it before updateGrid's state block is evaluated.
const vecHeld = { '': EMPTY, '-prev': EMPTY };

// Per-cell color for the canvas painter, against this level's own range.
const blobColorOf = (level) => cellColorOf(heatMode, accent, litRange[level] ?? {});

// MapLibre expression that turns `v` into a color for the active ramp.
function heatColorExpr() {
  const heat = HEAT_MODES[heatMode];
  // Categorical: `v` is a palette slot, so pick, don't interpolate.
  if (heat?.categorical) {
    return [
      'match',
      ['number', ['get', 'v'], TYPE_MAX],
      ...TYPE_COLORS.flatMap((c, i) => [i, lifted(c)]),
      lifted(TYPE_OTHER_COLOR),
    ];
  }
  const ramp = heat?.ramp;
  // Opaque: what the accent's own opacity means is how strong the wash is, and
  // that is applied once, as layer opacity (see accentAlpha). Handing MapLibre
  // a translucent colour *as well* would apply it twice.
  if (!ramp) return lifted(hexOpaque(accent));
  const stops = ramp.flatMap((c, i) => [i / (ramp.length - 1), lifted(c)]);
  return [
    'case',
    ['<', ['number', ['get', 'v'], 0], 0], UNDATED_COLOR,
    ['interpolate', ['linear'], ['number', ['get', 'v'], 0], ...stops],
  ];
}

/**
 * `[r, g, b]` from either notation this file passes around.
 *
 * It used to be `parseInt(hex.slice(1, 7), 16)` in two places, which was true
 * for as long as everything here started life as `#rrggbb`. `vivid()` returns
 * `rgb(…)`, and its whole point is to be applied *before* the per-theme mix — so
 * the mixes had to learn to read their own output.
 */
function channelsOf(color) {
  if (color.startsWith('#')) {
    const n = parseInt(color.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = color.match(/-?\d+(\.\d+)?/g) ?? [];
  return [+m[0] || 0, +m[1] || 0, +m[2] || 0];
}

function mixWithWhite(color, t) {
  const mix = (c) => Math.round(c + (255 - c) * t);
  return `rgb(${channelsOf(color).map(mix).join(', ')})`;
}

function mixWithBlack(color, t) {
  const mix = (c) => Math.round(c * (1 - t));
  return `rgb(${channelsOf(color).map(mix).join(', ')})`;
}

/**
 * Push a colour away from grey and toward light, for a basemap that is eating it.
 *
 * Standard is the reason this exists. Mapbox GL JS applies the style's own
 * atmosphere to **everything in the scene**, ours included: at a lean, a route
 * a few hundred metres out is already being mixed toward the haze colour, and at
 * dusk and night that haze is a dark desaturated blue. The line is still exactly
 * the colour it was told to be — it is being fogged, which is correct for
 * anything that is part of the ground and wrong for a route, which is an
 * annotation drawn *on* the map rather than a thing standing in it.
 *
 * There is no per-layer way to opt out of it, so the answer is to hand the layer
 * a colour with enough saturation and light in it to survive the trip. Done in
 * HSL because that is the pair of words the problem is stated in: `sat`
 * multiplies the saturation, `lift` moves the lightness that fraction of the way
 * toward white.
 *
 * @param {string} color `#rrggbb` or `rgb(r, g, b)`
 * @param {number} sat   1 leaves saturation alone; 1.4 is a noticeable lift
 * @param {number} lift  0..1, the fraction of the remaining headroom to take
 */
function vivid(color, sat, lift) {
  const [r255, g255, b255] = channelsOf(color);
  const r = r255 / 255;
  const g = g255 / 255;
  const b = b255 / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let l = (max + min) / 2;
  let s = 0;
  let h = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  s = Math.min(1, s * sat);
  l += (1 - l) * lift;
  // Back again. The standard HSL→RGB, written out rather than imported because
  // this is the only place in the app that needs it.
  const hue = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t) => Math.round((s === 0 ? l : hue(t)) * 255);
  return `rgb(${ch(h + 1 / 3)}, ${ch(h)}, ${ch(h - 1 / 3)})`;
}

/**
 * How hard this basemap eats the colours drawn over it.
 *
 * `[saturation multiplier, lightness lift]`, applied by `vivid()`. Only the 3D
 * basemap asks for anything: its atmosphere is the only one in the app that
 * touches our layers, and it is much heavier once the sun is down.
 */
function colorLift() {
  const lift = STYLES[styleKey]?.lift;
  return typeof lift === 'function' ? lift() : (lift ?? null);
}

/** A colour as this basemap needs it to be to come through legibly. */
const lifted = (color) => {
  const l = colorLift();
  return l ? vivid(color, l[0], l[1]) : color;
};

// A route line lightened toward white reads beautifully on the dark basemap and
// vanishes on the pale one, so the core takes the opposite treatment per theme
// and the glow, which is haze either way, pulls back a little on light.
// The core line is the activity's colour lifted toward the basemap's own
// contrast; the glow underneath is that colour untouched.
const routeLineColor = () =>
  routeColorExpr((hex) => (STYLES[styleKey].theme === 'light'
    ? mixWithBlack(lifted(hex), 0.3)
    : mixWithWhite(lifted(hex), 0.35)));
const routeGlowColor = () => routeColorExpr((hex) => lifted(hex));
const routeGlowOpacity = () => {
  const strong = STYLES[styleKey].theme === 'light' ? 0.5 : 0.6;
  const soft = STYLES[styleKey].theme === 'light' ? 0.26 : 0.35;
  // Under the pointer, most of the way to the selected strength but not all of
  // it — a hover that looked identical to a selection would be answering the
  // question before it was asked.
  const lit = soft + (strong - soft) * 0.75;
  return ['*', routeAlphaExpr(), ['case', ROUTE_SELECTED, strong, ROUTE_HOVERED, lit, soft]];
};
// The core line is nearly solid, and an activity you have made translucent
// scales that down rather than replacing it.
const routeLineOpacity = () => ['*', routeAlphaExpr(), 0.95];

// --- Routes on a map with buildings in it -------------------------------------
//
// Two things the 3D basemap needs and the flat four do not.
//
// **A wider glow.** On a flat basemap the glow is haze around a crisp line and
// 3.4× the core is plenty. Standard puts the route in a lit scene with texture
// and shadow under it, and at that busy a background the same halo disappears
// into the ground. Widening it is what makes the line read as *drawn on* the map
// rather than as one more thing in it — which is the whole job of the glow, done
// harder because the background got harder.
const ROUTE_GLOW_SCALE_3D = 6;
const glowScale = () => (engine === MAPBOX ? ROUTE_GLOW_SCALE_3D : ROUTE_GLOW_SCALE);

// **And a route you can still see behind a building.** A line is drawn on the
// ground, so a tower between it and the camera hides it completely — which on a
// leaning 3D map means a walk through a city is a dotted line of the gaps
// between blocks.
//
// `line-occlusion-opacity` is Mapbox's answer — the opacity of the part of a
// line that is behind something — and it comes with a restriction that is easy
// to miss and silent when broken:
//
//   "The property is not supported when `line-opacity` has data-driven styling."
//
// Both route layers have exactly that. `routeLineOpacity()` scales by the
// activity's own alpha and the glow's also asks whether the route is the
// selected one, so both are data-driven and both had the property quietly
// ignored. It was set, it read back correctly, and it did nothing.
//
// So the route gets a **third layer on this basemap only**: the same geometry
// and the same per-activity colour — colour may be data-driven, only opacity may
// not — at a flat opacity, with `line-occlusion-opacity: 1` so that the part
// behind a building is drawn at exactly the same strength as the part in front
// of one. On open ground the two crisp layers cover it and it is not visible as
// anything of its own; behind a block it is all that is left, which is the
// point. It sits under both, so it can never dull the line it is standing in
// for.
//
// Deliberately faint. A route drawn through a city at full strength puts the
// walk in front of the buildings and throws away the depth that makes this
// basemap worth having; this is enough to follow a line through a block and
// know that it continues.
const ROUTE_GHOST_OPACITY = 0.45;
const ROUTE_GHOST_ID = 'route-ghost';

// --- Paint expressions -----------------------------------------------------
// Region features: k=1 fill polygons, k=2 outline. Tile features carry a
// per-cell spotlight fade in property `f` (0..1).
const HOVER = ['number', ['feature-state', 'hoverT'], 0];
const F = ['number', ['get', 'f'], 1];

const tileLineWidth = ['interpolate', ['linear'], ['zoom'], 2, 0.8, 17, 1.3];
const boundLineWidth = ['interpolate', ['linear'], ['zoom'], 2, 1.5, 17, 2.2];
const boundGlowWidth = ['interpolate', ['linear'], ['zoom'], 2, 5, 17, 10];

const tileFillOpacity = () => ['*', tileVis, F, ['+', 0.05, ['*', 0.1, HOVER]]];
const tileLineOpacity = () => ['*', tileVis, F, ['+', 0.22, ['*', 0.32, HOVER]]];

// Route widths. MapLibre only accepts ["zoom"] as the input of a TOP-LEVEL
// step/interpolate, so both the glow's scale and the selected-route bump have
// to be baked into the stop values — wrapping an interpolate in ['*', …] is
// rejected outright when the layer is added.
const ROUTE_SELECTED = ['boolean', ['feature-state', 'sel'], false];
const ROUTE_HOVERED = ['boolean', ['feature-state', 'hov'], false];
// `hover` is the multiplier under the pointer, and only the glow passes one: a
// core line that thickened as well would be the route moving rather than
// lighting up, and the two read completely differently at a hairline.
const routeWidth = (scale, hover = 1) => [
  'interpolate',
  ['linear'],
  ['zoom'],
  ...ROUTE_WIDTH_STOPS.flatMap(([zoom, w]) => [
    zoom,
    ['case',
      ROUTE_SELECTED, w * scale * ROUTE_SELECTED_SCALE,
      ROUTE_HOVERED, w * scale * hover,
      w * scale],
  ]),
];

function applyTileVis() {
  map.setPaintProperty('tile-fill', 'fill-opacity', tileFillOpacity());
  map.setPaintProperty('tile-line', 'line-opacity', tileLineOpacity());
}

// f = uniform fade factor (0..1) used for crossfading regions between levels.
// The vector layers and the blob canvas fade as one: only one of them holds
// the current level at any moment, so driving both keeps the crossfade working
// across the hex → country boundary too.
function setVectorFade(suffix, f) {
  // The outlines are the accent too, so they fade with it — a wash you have
  // made barely-there ringed by a full-strength border would be neither.
  const a = accentAlpha();
  map.setPaintProperty(`hex-fill${suffix}`, 'fill-opacity', regionOpacity() * f);
  map.setPaintProperty(`hex-bound-glow${suffix}`, 'line-opacity', SHOW_REGION_BORDERS ? 0.35 * a * f : 0);
  map.setPaintProperty(`hex-bound-line${suffix}`, 'line-opacity', SHOW_REGION_BORDERS ? 0.9 * a * f : 0);
  // Text, not wash: it takes `accentAlpha` — so switching the visited areas off
  // takes the counts with them, and an accent you made translucent doesn't
  // leave a label floating over a shape that has gone — but never
  // `regionOpacity`, which is the strength of a tint over a basemap and would
  // make a number that has to be read a 60% one.
  if (map.getLayer(`hex-label${suffix}`)) {
    map.setPaintProperty(`hex-label${suffix}`, 'text-opacity', a * f);
  }
}

// The vector half of the incoming ramp. Separate because a crossfade that has
// just landed needs the layers re-pinned *without* touching the canvas: the
// canvas has finished fading out under a vector level and must stay out, and
// driving it back up here is how the blob ends up drawn underneath the
// countries at full strength.
function pinVectors(f) {
  for (const sfx of ['', '-prev']) {
    if (vecRole[sfx] === 'in') setVectorFade(sfx, f);
    else if (vecRole[sfx] !== 'out') setVectorFade(sfx, 0);
  }
}

// The incoming ramp: whichever layers hold the level being faded in.
function applyFade(f) {
  for (const sfx of ['', '-prev']) {
    if (vecRole[sfx] === 'in') setVectorFade(sfx, f);
    // 'warm' means the source is holding geometry purely so the map has it
    // tiled before a crossing — it must stay invisible until it is genuinely
    // the incoming side, and every path through here has to keep pinning it
    // down. 'idle' is empty, but pinning it costs nothing and means an
    // abandoned fade can never leave a stale layer half lit.
    else if (vecRole[sfx] !== 'out') setVectorFade(sfx, 0);
  }
  if (blobRole !== 'out' && blobRole !== 'off') blobCur.setOpacity(regionOpacity() * f);
}
// The outgoing ramp. Drives whichever source is on the way out — `hex` handing
// over to the canvas, or either source handing over to the other.
function applyPrevFade(f) {
  for (const sfx of ['', '-prev']) {
    if (vecRole[sfx] === 'out') setVectorFade(sfx, f);
  }
  if (blobRole === 'out') blobCur.setOpacity(regionOpacity() * f);
}

// applyColors() only moves paint properties, but in single-color mode the
// accent is *baked into the blob canvas* — so changing it also needs a
// re-raster, or the wash keeps its old color until the map next moves. Heat
// modes don't care: their cell colors don't come from the accent at all.
// Coalesced to one repaint per frame so dragging the picker stays smooth.
let accentRepaint = 0;
function repaintAccent() {
  if (accentRepaint || isHeatMode()) return;
  accentRepaint = requestAnimationFrame(() => {
    accentRepaint = 0;
    updateGrid(true);
  });
}

function applyColors() {
  if (!map.getLayer('hex-fill')) return;
  const lineColor = mixWithWhite(accent, 0.45);
  const fill = heatColorExpr();
  const label = labelColors();
  for (const s of ['', '-prev']) {
    map.setPaintProperty(`hex-fill${s}`, 'fill-color', fill);
    map.setPaintProperty(`hex-bound-glow${s}`, 'line-color', hexOpaque(accent));
    map.setPaintProperty(`hex-bound-line${s}`, 'line-color', lineColor);
    if (!map.getLayer(`hex-label${s}`)) continue;
    for (const [prop, value] of Object.entries(label)) {
      map.setPaintProperty(`hex-label${s}`, prop, value);
    }
  }
  if (map.getLayer('route-line')) {
    map.setPaintProperty('route-line', 'line-color', routeLineColor());
    map.setPaintProperty('route-line', 'line-opacity', routeLineOpacity());
    map.setPaintProperty('route-glow', 'line-color', routeGlowColor());
    map.setPaintProperty('route-glow', 'line-opacity', routeGlowOpacity());
    // Its opacity never moves — only its colour, which follows the activity.
    if (map.getLayer(ROUTE_GHOST_ID)) {
      map.setPaintProperty(ROUTE_GHOST_ID, 'line-color', routeLineColor());
    }
  }
}

// Whether the active coloring mode is a heat map (per-cell colors from a ramp)
// rather than the single-color wash. The two are tuned separately — opacity
// here, edge softness in src/blob-canvas.js.
const isHeatMode = () => isHeatColoring(heatMode);

// Heat-map cells are opaque enough to read as data; flat regions stay a
// translucent wash over the basemap. Both live in src/blob-canvas.js.
// How strong the visited wash is, per basemap. The same alpha does not read the
// same over a near-black basemap, a green one and a photograph — over imagery a
// light wash vanishes, over Terrain the default drowns the landcover. Each
// STYLES entry can carry `cellAlpha` (single-colour) and `heatAlpha` (the heat
// maps) as multipliers of the defaults in src/blob-canvas.js; 1 = unchanged.
// …and on top of that, whatever opacity the accent itself carries. The colour
// you pick for the visited areas can now be a translucent one, and the only
// place that can mean anything is here: the wash is drawn by cutting blurred
// discs at a fixed alpha, so transparency has to be applied to the finished
// layer rather than to the ink. Only in the single-colour mode — a heat map
// doesn't draw the accent at all, so it has no business honouring its opacity.
//
// Zero when the visited areas are switched off, which is the same lever pulled
// all the way: every surface that draws them reads this, so there is one place
// to turn them off rather than four.
const accentAlpha = () => (!cellsOn ? 0 : isHeatMode() ? 1 : hexAlpha(accent));

const regionOpacity = () => {
  const style = STYLES[styleKey] ?? {};
  const base = isHeatMode() ? BLOB_HEAT_ALPHA : BLOB_ALPHA;
  const scale = (isHeatMode() ? style.heatAlpha : style.cellAlpha) ?? 1;
  return Math.max(0, Math.min(1, base * scale * accentAlpha()));
};

function setHeatMode(next) {
  if (!HEAT_MODES[next]) return;
  // Pressing the mode that is already on is the way out: it hides the visited
  // areas rather than doing nothing, which is what it used to do.
  if (next === heatMode) {
    setCellsOn(!cellsOn);
    return;
  }
  const wasType = !!HEAT_MODES[heatMode]?.categorical;
  cellsOn = true; // picking a mode is asking to see it
  heatMode = next;
  try {
    localStorage.setItem(HEAT_KEY, heatMode);
  } catch {
    /* fine */
  }
  // The per-source tally is only built while Type is on, so switching into or
  // out of it is the one mode change that has to redo the roll-up.
  if (wasType !== !!HEAT_MODES[heatMode]?.categorical) recomputeLit();
  markAreasDirty(); // countries render dissolved or per-country by mode
  applyColors();
  applyFade(fade.cur);
  applyPrevFade(fade.prev);
  updateLayersUi();
  updateGrid(true);
}

/** Draw the visited areas, or don't. Everything else about them is unchanged. */
function setCellsOn(on) {
  if (on === cellsOn) return;
  cellsOn = on;
  try {
    localStorage.setItem(CELLS_KEY, cellsOn ? 'on' : 'off');
  } catch {
    /* fine */
  }
  applyFade(fade.cur);
  applyPrevFade(fade.prev);
  updateLayersUi();
}

/**
 * Take one source's cells off the map, or put them back. See hiddenSources.
 *
 * A full roll-up rather than anything cleverer: which source speaks for a cell
 * is only decided while the whole set is being walked, and this is a press of a
 * legend entry rather than something that happens as you pan.
 */
function toggleSource(src) {
  if (!src) return;
  if (!hiddenSources.delete(src)) hiddenSources.add(src);
  saveHiddenSources();
  recomputeLit();
  updateLayersUi();
  updateGrid(true);
  updateTiles();
  updateHud(currentLevel);
}

// --- Visited cells & upward propagation -------------------------------------
// Cells are stored per user on the server (see server/index.js and src/auth.js),
// not in localStorage. `visited` starts empty and is hydrated once the user's
// session resolves (hydrateVisited, below). The baked-in import history from
// `npm run import` is merged into each account server-side, once per import run.
const visited = new Set(); // ids "L/col/row" at the level they were clicked
// Provenance, one entry per source that vouches for a cell:
//   id → [{ source, addedAt, firstAt, lastAt, hits, fixes }, …] (epoch s, 0 = unknown)
// A cell you walked through with Timeline on *and* painted by hand has two.
const cellMeta = new Map();
let authed = false; // true once a session is active; gates server saves
// Who that session belongs to. Only read by the account-deletion confirmation,
// which names the account it is about to close — the browser is the one thing
// here that several people share, and "this account" is not specific enough to
// stake a map on.
let username = null;

const nowSec = () => Math.floor(Date.now() / 1000);

// litSets[L] = "col/row" → rolled-up stats for every cell lit at level L: each
// stored cell plus all of its ancestors, so coloring a small hexagon colors the
// big ones around it. The stats are what the heat maps read:
//   hits — separate stays in the cell (see VISIT_GAP_SEC in locations.js;
//          everything up to a day's silence is one visit, however often it
//          was sampled and however many times you came and went inside it)
//   time — most recent evidence (falls back to when it was added)
//   age  — earliest evidence
//   ids  — the stored cell ids rolled up into this one, so clearing a cell can
//          find what to delete with a lookup instead of a sweep of `visited`
let litSets = [];
// Cells painted since the last roll-up, waiting to be folded in incrementally
// (see rollUpPainted). Declared here because recomputeLit() below runs at module
// load, before anything further down has been initialized.
const paintQueue = [];
// Per-level ranges, so a heat map's colors mean the same thing while you pan.
let litRange = [];
// Sources present on the map, most cells first — the order the Type mode hands
// out its palette in, so the biggest source gets the most distinct color and a
// source keeps its color as long as its standing doesn't change.
let sourceOrder = [];
// Whether that tally is missing anything. It is only built while the Type mode
// is the one on screen, so the image export — which can ask for Type over a map
// showing something else — needs to know when what is in `litSets` predates a
// cell, or was never built at all. See exportRollUp.
let typeRollUpStale = true;
// The cells that are actually drawn: `visited` minus whatever a hidden source
// speaks for (see hiddenSources). Literally the same Set when nothing is hidden,
// which is the usual case and costs nothing — only a live filter allocates a
// second one. Everything that draws cells or counts what is on the map reads
// this; `visited` stays the answer to "what have I got", which is what the
// statistics, the saves and the search read.
let visibleCells = visited;

// Tally one source's visits onto a rolled-up cell. Nearly every cell only ever
// sees a single source, so the Map is only allocated once a second turns up.
function addSource(e, src, hits) {
  if (e.srcMap) {
    e.srcMap.set(src, (e.srcMap.get(src) ?? 0) + hits);
  } else if (e.src1 === undefined) {
    e.src1 = src;
    e.n1 = hits;
  } else if (e.src1 === src) {
    e.n1 += hits;
  } else {
    e.srcMap = new Map([[e.src1, e.n1], [src, hits]]);
  }
}

/**
 * How busy the area around one rolled-up cell is: arrivals per cell across the
 * hex `HEAT_NEIGHBOURHOOD` levels above it. Read beside the cell's own count so
 * that being seen once in the middle of a city and being seen once on a
 * motorway are not the same answer — which, before this, they were.
 *
 * Falls back to the cell's own density at the coarsest level, where there is
 * nothing further out to ask.
 */
function neighbourhoodOf(level, key) {
  const up = Math.min(MAX_LEVEL, level + HEAT_NEIGHBOURHOOD);
  const own = (e) => (e ? e.hits / e.cells : 0);
  if (up === level) return own(litSets[level].get(key));
  const sep = key.indexOf('/');
  let col = +key.slice(0, sep);
  let row = +key.slice(sep + 1);
  for (let l = level; l < up; l++) [col, row] = parentOf(l, col, row);
  return own(litSets[up].get(`${col}/${row}`)) || own(litSets[level].get(key));
}

function attachNeighbourhoods(level) {
  for (const [key, e] of litSets[level]) e.near = neighbourhoodOf(level, key);
}

// Which source speaks for this cell: the one that saw you there most often.
// Ties go to the alphabetically first, so the map doesn't shuffle between loads.
function dominantSource(e) {
  if (!e.srcMap) return e.src1;
  let best;
  let bestN = -1;
  for (const [src, n] of e.srcMap) {
    if (n > bestN || (n === bestN && src < best)) {
      best = src;
      bestN = n;
    }
  }
  return best;
}

// One stored cell's contribution to any roll-up, read off its provenance. The
// arithmetic lives in src/coloring.js, beside the ramps that consume it.
const cellStatsOf = (id, byType) => cellStats(cellMeta.get(id) ?? [], byType);

/**
 * Roll every stored cell up through the levels above it.
 *
 * @param {boolean} [byType] also build the per-source tally. It is an extra
 *   pass and an extra field on every rolled-up cell, so it defaults to whether
 *   the *map* is going to read one — the image export passes true to colour by
 *   Type over a map that is showing something else.
 */
function recomputeLit(byType = HEAT_MODES[heatMode]?.categorical) {
  // A full rebuild already accounts for anything sitting in the queue.
  paintQueue.length = 0;
  litSets = Array.from({ length: MAX_LEVEL + 1 }, () => new Map());
  const sourceCells = new Map();
  // Which source speaks for a cell is normally only worth working out for the
  // mode that colours by it — but with something hidden it is also what says
  // whether the cell is drawn at all, so the pass is paid for either way.
  const filtering = hiddenSources.size > 0;
  const shown = filtering ? new Set() : null;

  for (const id of visited) {
    let [L, col, row] = parseCellId(id);
    // Stored at a level that no longer exists. It draws no hexagon, but it is
    // not *hidden* either — it still lights the country it is in, which is what
    // it did before there was anything to hide.
    //
    // Written as the negation so an id that did not parse — NaN, which fails
    // every comparison it is put through — lands here as well, rather than
    // walking up the lattice as NaN and lighting a cell called "NaN/NaN".
    if (!(L <= MAX_LEVEL)) {
      shown?.add(id);
      continue;
    }

    const { hits, time, age, own, ownN } = cellStatsOf(id, byType || filtering);
    // Tallied before it is skipped, and deliberately: the palette is handed out
    // in this order, so counting only what is drawn would reshuffle everyone
    // else's colour every time a source was switched off. A hidden source keeps
    // its slot and its place in the legend, which is also what makes the legend
    // the way back.
    if (byType && own) sourceCells.set(own, (sourceCells.get(own) ?? 0) + 1);
    if (filtering && hiddenSources.has(own)) continue;
    shown?.add(id);

    for (let l = L; l <= MAX_LEVEL; l++) {
      if (l > L) [col, row] = parentOf(l - 1, col, row);
      const key = `${col}/${row}`;
      let e = litSets[l].get(key);
      if (e) {
        e.hits += hits;
        e.cells++;
        e.ids.push(id);
        if (time > e.time) e.time = time;
        if (age && (!e.age || age < e.age)) e.age = age;
      } else {
        litSets[l].set(key, (e = { hits, time, age, cells: 1, ids: [id] }));
      }
      if (byType && own) addSource(e, own, ownN);
    }
  }

  if (byType) {
    // Hand out palette slots by how much of the map each source accounts for.
    sourceOrder = [...sourceCells.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([src]) => src);
    // Forget anything hidden that no cell claims any more. A source removed for
    // good in Settings → Sources while it happened to be switched off would
    // otherwise stay in the list for ever, and it is not a harmless entry: it
    // keeps `filtering` true, which costs every roll-up the extra pass and
    // permanently disables the paint shortcut in rollUpPainted, invisibly and
    // for nothing. Only when there is a tally to check against — an empty one
    // means the cells have not arrived yet, not that the sources are gone.
    if (hiddenSources.size && sourceOrder.length) {
      const present = new Set(sourceOrder);
      let dropped = false;
      for (const src of hiddenSources) {
        if (!present.has(src)) dropped = hiddenSources.delete(src) || dropped;
      }
      if (dropped) saveHiddenSources();
    }
    const slot = new Map(sourceOrder.map((src, i) => [src, i]));
    for (const lit of litSets) {
      for (const e of lit.values()) {
        e.src = slot.get(dominantSource(e)) ?? TYPE_MAX;
        // The tally has done its job; drop it so the entries stay small.
        delete e.srcMap;
        delete e.src1;
        delete e.n1;
      }
    }
  } else {
    sourceOrder = [];
  }

  for (let l = 0; l <= MAX_LEVEL; l++) attachNeighbourhoods(l);

  litRange = litSets.map((lit) => {
    const r = { maxHits: 1, hotHits: 2, minTime: 0, maxTime: 0, minAge: 0, maxAge: 0 };
    r.hotHits = hotOf(lit);
    // What the dates on this level actually look like, for the same reason
    // `hotHits` exists: the ends of the range do not describe the middle.
    r.ageStops = ageStopsOf(lit);
    for (const e of lit.values()) {
      if (e.hits > r.maxHits) r.maxHits = e.hits;
      if (e.time) {
        if (!r.minTime || e.time < r.minTime) r.minTime = e.time;
        if (e.time > r.maxTime) r.maxTime = e.time;
      }
      if (e.age) {
        if (!r.minAge || e.age < r.minAge) r.minAge = e.age;
        if (e.age > r.maxAge) r.maxAge = e.age;
      }
    }
    return r;
  });

  visibleCells = shown ?? visited;
  typeRollUpStale = !byType;
  markAreasDirty(); // the set of lit countries may have changed
}

// Fold ONE newly stored cell into litSets/litRange without rebuilding them.
// Returns false — having changed nothing — when only a full rebuild would be
// exact, so the caller can fall back.
//
// The catch is litRange: `minTime` is a minimum over entry times and `maxAge` a
// maximum over entry ages, and adding a cell can *raise* an entry's time or
// *lower* its age. Neither composes incrementally, and `ageStops` — the whole
// distribution of dates, not just its ends — composes even less. Cells painted
// by hand carry no dates at all (markCell stores firstAt/lastAt as 0), so all of
// them stay untouched and the shortcut is exact, which is the only case this is
// used for. Anything dated takes the slow path.
function rollUpPainted(id) {
  // Whether a cell is drawn at all depends on which source speaks for it, and
  // that is only settled by the pass over the whole set. Rare enough — a filter
  // is on, and you are painting — to be worth a rebuild rather than a second
  // answer to the same question here.
  if (hiddenSources.size) return false;
  let [L, col, row] = parseCellId(id);
  if (!(L <= MAX_LEVEL)) return true; // same skip as recomputeLit()

  let hits = 0;
  let time = 0;
  let age = 0;
  for (const m of cellMeta.get(id) ?? []) {
    if (m.source !== 'manual' && m.source !== 'unknown') hits += m.hits || 0;
    if (m.lastAt > time) time = m.lastAt;
    if (m.firstAt && (!age || m.firstAt < age)) age = m.firstAt;
  }
  if (!hits) hits = 1;
  if (!age) age = time;
  if (time || age) return false; // dated — litRange would need the full pass

  const touched = [];
  for (let l = L; l <= MAX_LEVEL; l++) {
    if (l > L) [col, row] = parentOf(l - 1, col, row);
    const key = `${col}/${row}`;
    let e = litSets[l].get(key);
    if (e) {
      e.hits += hits;
      e.cells++;
      e.ids.push(id);
    } else {
      litSets[l].set(key, (e = { hits, time: 0, age: 0, cells: 1, ids: [id] }));
    }
    touched.push([l, key]);
    if (e.hits > litRange[l].maxHits) litRange[l].maxHits = e.hits;
  }
  // Only the chain this cell sits in can have moved, so the neighbourhoods are
  // refreshed rather than rebuilt. `hotHits` is left alone on purpose: it is a
  // 98th percentile over tens of thousands of cells, and one hand-painted cell
  // worth a single visit cannot move it anywhere the next full pass won't.
  for (const [l, key] of touched) {
    const e = litSets[l].get(key);
    if (e) e.near = neighbourhoodOf(l, key);
  }
  // This path never works out a source slot — it is only taken when the map is
  // in a mode that would not read one. So any tally built earlier for the image
  // export is now one cell short of the truth, and says so.
  typeRollUpStale = true;
  markAreasDirty();
  return true;
}

// --- Area levels: which countries (or regions) are lit, merged into one shape --
// The three coarsest steps of the map are not hexagons at all. Zoom out past the
// finest levels and the grid gives way to the shapes people actually think in:
// cantons, states and départements first, then whole countries, then continents.
// The merge (a polygon union) is only recomputed when the lit set changes AND
// that level is actually on screen, so painting hexes never pays for it.
//
// All three are resolved from the stored cells themselves — see buildAreaFC.
// There is no roll-up in between, because a roll-up means one hexagon's centre
// deciding for every cell under it, and there is no size of hexagon that is
// honest about a canton of 37 km².
//
// Handing over between them is what `hex-prev` is for: two sources are enough
// however many polygon levels there are, because a crossing has exactly two
// sides. See **Two vector levels** in ARCHITECTURE.md.

// The three coarsest steps are not hexagons. Level 4's cells are ~73 km across,
// which says nothing a canton doesn't say better — and "which cantons have I
// been to" is a question with an answer, where "which 73 km squares" is not.
const REGION_LEVEL = MAX_LEVEL;
const FIRST_VECTOR_LEVEL = REGION_LEVEL;

/** True for the levels drawn as real polygons rather than as a blurred sheet. */
const isVectorLevel = (L) => L >= FIRST_VECTOR_LEVEL;
/** Which dataset a vector level draws. */
const vectorKindOf = (L) =>
  L === CONTINENT_LEVEL ? 'continent' : L === COUNTRY_LEVEL ? 'country' : 'region';
/** Is that dataset in memory yet? Continents are the countries dissolved. */
const areaReady = (kind) => (kind === 'region' ? regionsLoaded() && countriesLoaded() : countriesLoaded());

// The vector level a zoom is heading towards from `level`, or null when the
// next step is a hex level (the blob warm-up handles that side).
//
// Each level's band runs from levelBoundary(L) up to levelBoundary(L - 1), so
// "within 1.2 of my own lower boundary" means the zoom-out crossing is the one
// coming — and every level but the coarsest has a different neighbour each way.
function neighbourVectorLevel(level, zoom) {
  if (level === REGION_LEVEL) {
    // Zooming out towards countries; zooming in leads to a blob level, which
    // needs no vector geometry at all.
    return zoom < levelBoundary(REGION_LEVEL) + 1.2 ? COUNTRY_LEVEL : null;
  }
  if (level === COUNTRY_LEVEL) {
    // Which half of its own band the zoom is in, rather than "within 1.2 of the
    // bottom". The country band is 0.91 wide now that continents take their
    // room out of it, and a fixed 1.2 margin covers all of it — so the region
    // level would never be warmed and every zoom-in would start by parsing
    // instead of fading.
    const mid = (levelBoundary(COUNTRY_LEVEL) + levelBoundary(REGION_LEVEL)) / 2;
    return zoom < mid ? CONTINENT_LEVEL : REGION_LEVEL;
  }
  if (level === CONTINENT_LEVEL) return COUNTRY_LEVEL;
  return null;
}

// Four caches, not three: the regions are held at both resolutions, because the
// coarse geometry is the right thing to tile when you are looking at a
// continent and the wrong thing when you are looking at a valley.
const areaFC = { region: EMPTY, regionFine: EMPTY, country: EMPTY, continent: EMPTY };
// The region ids the last build lit, so considerFineRegions() knows which
// countries are worth asking about.
let litRegionIds = null;

// Past this zoom, region outlines are being read rather than glanced at, and the
// overview set's ~1 km simplification starts to show — a canton border cutting
// a straight line across the lake it actually follows. Only reachable with
// Detail pinned to Region: on Auto, this level never survives past ~z5.
//
// A whole zoom level earlier than it was (7). At z6 a canton already fills
// enough of the screen that the straight line across the lake is the thing you
// notice, and waiting for z7 meant zooming past the view the outlines were
// worth having in. The cost is real and is the reason it was ever set high: the
// wider view holds more countries, so more of them are fetched, and there is
// more geometry to tile at once.
const REGION_FINE_ZOOM = 6;
// …and back to the overview geometry below this. The gap is deliberate: swapping
// resolution re-tiles the source, so a zoom that hovers on the threshold would
// re-tile on every wobble. Same idea as LEVEL_HYSTERESIS, for the same reason —
// and it is the zoom-out that matters on an older device, where the point of
// dropping back to a few hundred points is that the map stays smooth.
const REGION_COARSE_ZOOM = 5.4;

// Boundary credits. Natural Earth is public domain and asks for nothing;
// geoBoundaries composites national survey data (swisstopo for Switzerland) and
// asks to be credited under CC BY 4.0.
const REGION_ATTRIB =
  '<a href="https://www.geoboundaries.org/" target="_blank" rel="noopener noreferrer">geoBoundaries</a>';

// Whether the fine geometry should be used *right now*. It has to be both
// fetched and worth using: at world zoom it would cost a great deal of tiling to
// draw detail far smaller than a pixel. Sticky between the two thresholds, so
// nudging the zoom around the boundary doesn't re-tile the source repeatedly.
let fineActive = false;
// Whether the live source is currently holding the detailed region geometry.
let fedFine = false;
function useFineRegions() {
  if (!fineRegionsLoaded()) {
    fineActive = false;
    return false;
  }
  const zoom = map.getZoom();
  if (zoom >= REGION_FINE_ZOOM) fineActive = true;
  else if (zoom < REGION_COARSE_ZOOM) fineActive = false;
  return fineActive;
}

// Which cache a request lands in.
const areaCacheKey = (kind) => (kind === 'region' && useFineRegions() ? 'regionFine' : kind);
let countryDirty = true;
// Bumped alongside it, for readers that must not *consume* the flag.
// `countryDirty` is a message to `ensureAreaFC` and is cleared by it; the image
// export needs the same news without taking it off the map's doorstep.
let areaGen = 0;

/** The lit set, the colouring or the boundary data moved. Anything built from
 *  them is now out of date. */
function markAreasDirty() {
  countryDirty = true;
  areaGen++;
}
// Keyed by stored cell id, and never invalidated by an edit: a cell's centre
// never moves, so the answer for "L/col/row" is the same every time it is
// asked. Only a dataset arriving late clears them (see ensureAreaFC).
const cellCountryMemo = new Map(); // "L/col/row" -> country id
const cellRegionMemo = new Map(); //  "L/col/row" -> region id

/**
 * Which area of `kind` one stored cell belongs to, memoised.
 *
 * The memo is never invalidated by an edit: a cell's centre never moves, so the
 * answer for "L/col/row" is the same every time it is asked. Only a dataset
 * arriving late clears it (see ensureAreaFC).
 *
 * Named rather than inlined because the image export asks the same question of
 * the same rows — which countries are lit, which cantons — and a second memo
 * would mean a second run of twenty thousand point-in-polygon tests for an
 * answer already sitting in this one.
 */
function areaOfCellMemo(kind, id) {
  const memo = kind === 'region' ? cellRegionMemo : cellCountryMemo;
  let at = memo.get(id);
  if (at === undefined) memo.set(id, (at = areaOfCell(kind === 'continent' ? 'country' : kind, id)));
  if (kind !== 'continent') return at;
  return at ? continentOf(at) : null;
}

// One area's geometry, whichever dataset it came from.
//
// A country asked for `fine` is its own regions dissolved (trimmed back to the
// country proper — see fineCountryOutline). That matters for the *export* far
// more than for the map: picking Countries as the detail while the picture is
// of one country draws a shape four pixels per vertex across, and the seam
// against the mask around it is the first thing you see.
function areaGeometry(kind, id, fine) {
  if (kind === 'continent') return continentGeometry(id);
  const country = id.startsWith(WHOLE_COUNTRY) ? id.slice(WHOLE_COUNTRY.length) : null;
  if (country) return sharpCountry(country, fine);
  return kind === 'region' ? regionGeometry(id, fine) : sharpCountry(id, fine);
}

const sharpCountry = (id, fine) =>
  (fine ? fineCountryOutline(countryIso(id)) : null) ?? countryGeometry(id);

// Dissolve the lit areas into one shape. Countries and continents go straight to
// their own merge; regions may include whole-country stand-ins, so those are
// collected separately and unioned with the rest.
function mergeAreas(kind, litIds, fine) {
  if (kind === 'continent') return mergeContinents(litIds);
  if (kind !== 'region') {
    if (!fine) return mergeCountries(litIds);
    // Same dissolve, over the sharper outlines where they have been fetched.
    // Done here rather than inside mergeCountries so that countries.js does not
    // have to know that regions exist.
    const geoms = [];
    for (const id of litIds) {
      const g = sharpCountry(id, true);
      if (g) geoms.push(asMulti(g));
    }
    return geoms.length ? unionGeometries(geoms) : { fill: [], rings: [] };
  }
  const plain = new Set();
  const extra = [];
  for (const id of litIds) {
    if (id.startsWith(WHOLE_COUNTRY)) {
      const g = countryGeometry(id.slice(WHOLE_COUNTRY.length));
      if (g) extra.push(asMulti(g));
    } else {
      plain.add(id);
    }
  }
  if (!extra.length) return mergeRegions(plain, fine);
  const merged = mergeRegions(plain, fine);
  return unionGeometries([...(merged.fill.length ? [merged.fill] : []), ...extra]);
}

/**
 * @param {'region'|'country'|'continent'} kind
 * @param {object} [o]
 * @param {boolean} [o.fine]  prefer the detailed region boundaries
 * @param {string} [o.mode]   colour by this mode rather than the one on screen —
 *   the image export paints these same areas in a mode of its own choosing
 * @param {boolean} [o.record] let the build update the map's own state. False
 *   for a build nobody is about to draw on the map: `litRegionIds` decides
 *   which countries get their detailed boundaries fetched, and an export of one
 *   canton must not be what answers that.
 */
function buildAreaFC(kind, { fine = false, mode = heatMode, record = true } = {}) {
  // Resolved from each stored cell, at the level it was stored — not from a
  // rolled-up hexagon.
  //
  // Both kinds used to resolve from a 9 km hex, whose *centre* decided for
  // every cell inside it. For countries that is nearly always harmless. For
  // regions it is not, because plenty of regions are smaller than the hexagon
  // deciding for them: a real map lit Appenzell Innerrhoden with "3 visits"
  // off seven cells that were all in Sankt Gallen, and Liechtenstein's Mauren
  // and the Aosta Valley the same way — three places the owner had never been,
  // coloured in and counted, while the statistics panel (which has always read
  // the cells themselves) correctly listed none of them. Reading the same
  // cells here is what makes the two agree, and agreeing is the point: they
  // are answering the same question about the same rows.
  //
  // The cost is the reason it was ever a roll-up — twenty-odd thousand
  // point-in-polygon tests rather than two thousand. That reason is gone. The
  // note it came from predates both the region tile index and passing the
  // country into the region lookup, which together drop all but a couple of
  // dozen of the 4,553 shapes before any geometry is touched. Measured on a
  // 23k-cell map: 115 ms for the first build at the region level, and 1.1 ms
  // for every build after it, because a cell centre never moves and the answer
  // is memoised per cell id. The polygon union below costs more than either.
  const isRegionKind = kind === 'region';
  const isContinentKind = kind === 'continent';
  // Continents read the *country* memo and map its answer on rather than
  // resolving a third time against their own outline. The outline is those
  // countries dissolved, so a separate lookup would be the same test run over a
  // shape with more points in it — and one that could still disagree with the
  // level below at a coast the union left a seam along.
  const byType = HEAT_MODES[mode]?.categorical;
  const slotOf = byType ? new Map(sourceOrder.map((src, i) => [src, i])) : null;
  const litIds = new Set();
  // Continent → the countries in it you have been to. The count is the whole
  // point of the level; the set is what makes it a count of countries rather
  // than of cells that happen to be in them.
  const countriesIn = isContinentKind ? new Map() : null;
  const perArea = new Map(); // id → rolled-up stats, for the heat maps
  // `visibleCells`, not `visited`: a source switched off in the Type legend is
  // off the whole map, so it cannot be what lights a region either — a country
  // nothing visible remains in is a country you have not been to as far as this
  // picture is concerned. The two are the same Set unless something is hidden.
  for (const id of visibleCells) {
    const cid = areaOfCellMemo(kind, id);
    if (!cid) continue;
    if (isContinentKind) {
      const country = areaOfCellMemo('country', id);
      let seen = countriesIn.get(cid);
      if (!seen) countriesIn.set(cid, (seen = new Set()));
      seen.add(country);
    }
    litIds.add(cid);
    const stat = cellStatsOf(id, byType);
    let e = perArea.get(cid);
    // `near` stays 0: a whole region is its own neighbourhood, so it is read on
    // its own count rather than against the ring of hexes around it.
    if (!e) perArea.set(cid, (e = { hits: 0, time: 0, age: 0, near: 0, srcN: new Map() }));
    e.hits += stat.hits;
    if (stat.time > e.time) e.time = stat.time;
    if (stat.age && (!e.age || stat.age < e.age)) e.age = stat.age;
    // A whole country is colored by whichever app covers the most of it — by
    // ground, not by visits, which is the question the country level answers.
    if (byType && stat.own) {
      const src = slotOf.get(stat.own) ?? TYPE_MAX;
      e.srcN.set(src, (e.srcN.get(src) ?? 0) + 1);
    }
  }
  for (const e of perArea.values()) {
    let best = TYPE_MAX;
    let bestN = -1;
    for (const [src, n] of e.srcN ?? []) {
      if (n > bestN || (n === bestN && src < best)) {
        best = src;
        bestN = n;
      }
    }
    e.src = best;
  }

  // Recorded before the heat branch, which returns without reaching the merge:
  // considerFineRegions() needs this whichever colouring mode is on.
  if (isRegionKind && record) litRegionIds = litIds;

  const labels = isContinentKind ? continentLabels(countriesIn) : [];

  // In a heat mode each country is its own feature so it can carry its own
  // color; otherwise they dissolve into one borderless shape.
  const heat = heatMetric(mode);
  if (heat) {
    const range = {
      maxHits: 1,
      hotHits: hotOf(perArea),
      // Areas get their own ladder: a country's first-seen is the earliest of
      // everything inside it, so a hundred countries spread quite differently
      // from the twenty thousand cells they are made of.
      ageStops: ageStopsOf(perArea),
      minTime: 0, maxTime: 0, minAge: 0, maxAge: 0,
    };
    for (const e of perArea.values()) {
      if (e.hits > range.maxHits) range.maxHits = e.hits;
      if (e.time) {
        if (!range.minTime || e.time < range.minTime) range.minTime = e.time;
        if (e.time > range.maxTime) range.maxTime = e.time;
      }
      if (e.age) {
        if (!range.minAge || e.age < range.minAge) range.minAge = e.age;
        if (e.age > range.maxAge) range.maxAge = e.age;
      }
    }
    const features = [];
    for (const [id, stat] of perArea) {
      const geometry = areaGeometry(kind, id, fine);
      if (geometry) {
        features.push({ type: 'Feature', properties: { k: 1, v: heat(stat, range) }, geometry });
      }
    }
    return { type: 'FeatureCollection', features: [...features, ...labels] };
  }

  const { fill, rings } = mergeAreas(kind, litIds, fine);
  const features = [];
  if (fill.length) {
    features.push({ type: 'Feature', properties: { k: 1 }, geometry: { type: 'MultiPolygon', coordinates: fill } });
  }
  if (rings.length) {
    features.push({ type: 'Feature', properties: { k: 2 }, geometry: { type: 'MultiLineString', coordinates: rings } });
  }
  return { type: 'FeatureCollection', features: [...features, ...labels] };
}

/**
 * One label per lit continent: its name, and how many of its countries you have
 * been to. `k = 3`, so the fill and outline layers — which both filter on `k` —
 * leave them alone and one source can carry all three.
 *
 * Rides the level's own crossfade for free by living on that source, which is
 * the reason it isn't a layer of its own: a count that stayed on screen while
 * the shape under it dissolved into countries would be the one thing on the map
 * that didn't belong to a level.
 *
 * Only lit continents are labelled. "Africa · 0 countries" is not a fact about a
 * map, it is the absence of one, and the empty shape underneath already says it.
 */
function continentLabels(countriesIn) {
  const features = [];
  for (const [name, seen] of countriesIn) {
    const at = continentAnchor(name);
    if (!at) continue;
    features.push({
      type: 'Feature',
      properties: { k: 3, name, count: plural(seen.size, 'country', 'countries') },
      geometry: { type: 'Point', coordinates: at },
    });
  }
  return features;
}

// Cached country FeatureCollection. If the data hasn't loaded yet, kick off the
// (one-time) fetch and refresh once it arrives; show nothing until then.
function ensureAreaFC(kind) {
  const ready = kind === 'region' ? regionsLoaded() && countriesLoaded() : countriesLoaded();
  if (!ready) {
    // Both, for regions: a region is only ever looked up inside the country the
    // cell already resolved to.
    Promise.all(kind === 'region' ? [loadRegions(), loadCountries()] : [loadCountries()]).then(() => {
      cellCountryMemo.clear();
      cellRegionMemo.clear();
      // The continent index and its dissolved outlines were built from whatever
      // the country dataset held a moment ago, which was nothing.
      forgetContinents();
      markAreasDirty();
      updateGrid(true);
    });
    return EMPTY;
  }
  if (countryDirty) {
    areaFC.region = EMPTY;
    areaFC.regionFine = EMPTY;
    areaFC.country = EMPTY;
    areaFC.continent = EMPTY;
    countryDirty = false;
  }
  const slot = areaCacheKey(kind);
  // Built on demand and then held: setVecData() tells "same data" from "rebuilt"
  // by identity, and re-feeding a source it already holds re-tiles the world.
  if (areaFC[slot] === EMPTY) areaFC[slot] = buildAreaFC(kind, { fine: slot === 'regionFine' });
  return areaFC[slot];
}

// --- What the image export reads ------------------------------------------------
// The export (src/export-image.js) draws the same cells, coloured by the same
// modes, cut to the same boundaries — but at a size and in a mode that need have
// nothing to do with what is on screen. So it is handed accessors rather than
// state: everything below answers "as things stand", and none of it lets the
// export change what the map is doing.

/**
 * The roll-up to paint one mode from.
 *
 * The per-source tally behind the Type mode is only built while Type is the mode
 * on screen, because it costs a pass and a field per cell that nothing else
 * reads. Exporting a Type-coloured picture from a map showing First seen is a
 * perfectly reasonable thing to ask for, so the tally is built on demand — once,
 * and then left alone until something invalidates it, or every drag of the
 * strength slider would pay for a full rebuild.
 */
function exportRollUp(mode) {
  if (HEAT_MODES[mode]?.categorical && typeRollUpStale && visited.size) recomputeLit(true);
  return { litSets, litRange };
}

// Held, but never in the map's own slots. `ensureAreaFC` holds one answer per
// kind for the mode the map is in, and an export asking for a different mode
// must not evict it — the next pan would rebuild and re-tile the level under the
// user's hand. So this is a cache of its own, keyed by kind *and* mode, and
// dropped whenever anything it was built from moves.
//
// It has to be a cache because **Single color is the expensive one**. Every heat
// mode gives each area its own feature carrying its own value, which is a walk
// over the cells and nothing else. The flat mode dissolves them instead — and
// dissolving a hundred regions of several thousand points each is polygon
// clipping measured in seconds, not milliseconds. Rebuilt per call, that ran
// again on every frame of every slider drag, so the panel was unusable in the
// mode it opens in while every other mode felt fine. Nothing about the union
// changes while a slider moves; it is the same shapes redrawn at a different
// size.
//
// Capped rather than trusted: three detail levels times four modes is twelve
// answers, each potentially a country's worth of geometry, and an export panel
// left open should not quietly hold all of them.
const EXPORT_CACHE_MAX = 8;
const exportCache = new Map();
let exportCacheGen = '';

// What the answers were built from: the lit set and the colouring (`areaGen`),
// and the resolution of the boundaries themselves (`fineRegionsVersion`).
//
// The second half is the one that is easy to miss and was missed. The export
// fetches its own detailed boundaries — `ensureSharpBoundaries` calls
// `loadFineRegions` directly, for every country in the frame, and does not go
// through the map's path at all. So a cache invalidated on the map's signal
// alone went on serving the shapes it had built *before* the sharpening it had
// just asked for and waited on. The poster came out drawn from the overview
// geometry with the detailed set sitting in memory beside it.
const exportStamp = () => `${areaGen}/${fineRegionsVersion()}`;

// Always `fine`, which the map only asks for past z6: a poster is looked at far
// closer than a map ever is, and the overview boundaries' ~1 km simplification
// is what puts a straight line across a lake. Where the detailed set has not
// been fetched, `regionGeometry` falls back to the overview one on its own.
function exportAreaFC(kind, mode, fine = true) {
  const stamp = exportStamp();
  if (exportCacheGen !== stamp) {
    exportCache.clear();
    exportCacheGen = stamp;
  }
  // `fine` is in the key, not just in the build: the export asks for the blunt
  // shapes while its frame holds a country whose detail has not arrived, and for
  // the sharp ones the moment it has. Both answers are worth keeping — that is a
  // slider drag either side of a fetch landing.
  const key = `${kind}|${mode}|${fine ? 'fine' : 'coarse'}`;
  const held = exportCache.get(key);
  if (held) return held;
  if (exportCache.size >= EXPORT_CACHE_MAX) exportCache.clear();
  const fc = buildAreaFC(kind, { mode, fine, record: false });
  exportCache.set(key, fc);
  return fc;
}

// Initial (empty) light-up so litSets/countryDirty exist before the map draws;
// hydrateVisited() re-runs this once the user's cells arrive from the server.
recomputeLit();

// --- Saving ------------------------------------------------------------------
// Edits go to the server as incremental add/remove batches, debounced so a
// Ctrl-paint sweep sends one request instead of one per cell. No-ops when
// signed out.
const pendingAdd = new Set();
const pendingRemove = new Set();
let saveTimer = null;

let saving = false;

function queueSave() {
  if (!authed) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushPending, 500);
}

// Send what's queued, and only clear it once the server has actually taken it.
// It used to be emptied before the request went out, so a save that failed —
// server down, tunnel dropped — threw the edits away without telling anyone.
// Holding them means the Retry button has something to send.
async function flushPending() {
  if (!authed || saving) return;
  const add = [...pendingAdd];
  const remove = [...pendingRemove];
  if (!add.length && !remove.length) return;
  saving = true;
  try {
    await auth.mutateCells(add, remove);
    // Delete by id rather than clearing: a cell re-marked while this request
    // was in flight has already moved to the other set, and that newer intent
    // must survive.
    for (const id of add) pendingAdd.delete(id);
    for (const id of remove) pendingRemove.delete(id);
  } catch (e) {
    console.warn('Saving cells failed, keeping the edits queued:', e);
  } finally {
    saving = false;
  }
}

// Mark a cell by hand. Cells that arrived from an import keep their existing
// provenance — the server does the same, so a manual tap over imported history
// never overwrites where it came from.
function markCell(id) {
  visited.add(id);
  if (!cellMeta.has(id)) {
    cellMeta.set(id, [{ source: 'manual', addedAt: nowSec(), firstAt: 0, lastAt: 0, hits: 1, fixes: 0 }]);
  }
  pendingRemove.delete(id);
  pendingAdd.add(id);
  queueSave();
}

// Clearing a cell means "I was never here" — it drops every source's claim.
function unmarkCell(id) {
  visited.delete(id);
  cellMeta.delete(id);
  pendingAdd.delete(id);
  pendingRemove.add(id);
  queueSave();
}

// --- Undo / redo ---------------------------------------------------------------
// Every edit below records how to take itself back. The stack lives in
// src/history.js; what it needs from here is the two halves of an edit and a
// phrase for the toast.
const history = createHistory();

// Undo doesn't go through the debounced queue — it sends the inverse itself —
// so anything already queued has to land first. Otherwise a clear that hasn't
// been sent yet flushes *after* the restore that undid it, and the cells go
// again half a second later.
async function settleSaves() {
  clearTimeout(saveTimer);
  for (let i = 0; i < 40; i++) {
    if (!pendingAdd.size && !pendingRemove.size) return;
    if (saving) await new Promise((r) => setTimeout(r, 40));
    else await flushPending();
  }
  // Still holding edits means the server isn't taking them. Undoing on top of
  // that would show a change on screen that nothing has recorded.
  throw new Error("the server isn't answering");
}

// What a cell knows, deep-copied so a later edit to the live map can't reach
// into an entry sitting in the undo stack.
function snapshotCells(ids) {
  return ids.map((id) => [id, (cellMeta.get(id) ?? []).map((e) => ({ ...e }))]);
}

// Put snapshots back — on the map and on the server, with their provenance.
// This is why POST /api/cells/restore exists: re-adding the ids would bring
// them back as bare manual marks, having quietly thrown away the dates, the
// visit counts and which app they came from.
async function restoreCells(snapshot) {
  await settleSaves();
  const rows = [];
  const at = nowSec();
  for (const [id, entries] of snapshot) {
    const list = entries.length ? entries : [{ source: 'manual', addedAt: at, firstAt: 0, lastAt: 0, hits: 1, fixes: 0 }];
    visited.add(id);
    cellMeta.set(id, list.map((e) => ({ ...e })));
    // It's going back on the map, so a queued "remove it" is no longer true.
    pendingRemove.delete(id);
    for (const e of list) rows.push([id, e.source, e.addedAt, e.firstAt, e.lastAt, e.hits, e.fixes]);
  }
  await auth.restoreCells(rows);
  recomputeLit();
  updateGrid(true);
  updateTiles();
}

// The other direction: clear these again.
async function clearCells(ids) {
  for (const id of ids) unmarkCell(id);
  recomputeLit();
  updateGrid(true);
  updateTiles();
  await settleSaves();
}

// Mark these again, as they were. Same call as restoring a clear, because a
// mark *is* a row — the manual one.
async function remarkCells(snapshot) {
  await restoreCells(snapshot);
}

// Pull the signed-in user's cells (and their provenance) and light them up.
// Runs after login, after the initial session check and after an import; safe
// to call before or after the map style loads (updateGrid no-ops until the
// sources exist, then installGrid renders).
async function hydrateVisited() {
  visited.clear();
  cellMeta.clear();
  try {
    const { sources = [], rows = [] } = (await auth.getCells()) ?? {};
    for (const [id, srcIdx, addedAt, firstAt, lastAt, hits, fixes = 0] of rows) {
      visited.add(id);
      const entry = { source: sources[srcIdx] ?? 'unknown', addedAt, firstAt, lastAt, hits, fixes };
      const list = cellMeta.get(id);
      if (list) list.push(entry);
      else cellMeta.set(id, [entry]);
    }
  } catch (e) {
    console.warn('Loading cells failed:', e);
    visited.clear();
    cellMeta.clear();
  }
  closeCellInfo();
  closeRouteInfo();
  recomputeLit();
  updateGrid(true);
  updateTiles();
  updateHud(currentLevel);
  // The guessed home is read off the cells, so it only exists once they do.
  syncHomeMarker();
}

// Ancestor of a stored cell at a coarser level (identity at the same level).
function ancestorAt(L, col, row, targetL) {
  while (L < targetL) {
    [col, row] = parentOf(L, col, row);
    L++;
  }
  return [col, row];
}

// Every stored cell that sits inside (or is) the cell (L, col, row).
// recomputeLit() already walks each stored cell up to every ancestor, so it
// records the ids on the way past — this is that index, read back. It used to
// re-split and re-walk all ~20k stored ids on every tap.
function storedUnder(L, col, row) {
  return litSets[L]?.get(`${col}/${row}`)?.ids ?? [];
}

function toggleCell(id) {
  clearTripHighlight();
  const [L, col, row] = parseCellId(id);
  if (litSets[L].has(`${col}/${row}`)) {
    // Clear everything stored beneath (or at) this cell. Iterate a copy: the
    // array belongs to litSets now, and unmarkCell is removing its contents.
    const ids = [...storedUnder(L, col, row)];
    // Taken *before* the clear — this is everything those cells knew, and in a
    // moment it will only exist here.
    const snapshot = snapshotCells(ids);
    for (const vid of ids) unmarkCell(vid);
    // Zoomed out, one tap can clear a country's worth of cells, which is
    // exactly the edit you most want back.
    history.push(
      `clearing ${plural(ids.length, 'cell')}`,
      () => restoreCells(snapshot),
      () => clearCells(ids),
    );
  } else {
    markCell(id);
    const snapshot = snapshotCells([id]);
    history.push('marking a cell', () => clearCells([id]), () => remarkCells(snapshot));
  }
  recomputeLit();
  updateGrid(true);
  updateTiles();
}
// Debug hooks — handy in devtools for poking at cells and their provenance.
window.visitedMap = {
  toggle: toggleCell,
  // The two vector levels, on demand — handy for asking why a zoom-out is
  // showing nothing without having to reason about the crossfade state machine.
  areas: (kind = 'region') => ensureAreaFC(kind),
  state: () => ({
    level: currentLevel,
    asBlob: currentAsBlob,
    live: vecLive,
    roles: { ...vecRole },
    held: { '': vecHeld[''] !== EMPTY, '-prev': vecHeld['-prev'] !== EMPTY },
    litRegions: litRegionIds?.size ?? null,
    fine: fineRegionsLoaded(),
  }),
  // Why a zoom-in is (or isn't) asking for detailed boundaries.
  fineDebug: () => {
    const view = lngLatBox(viewMerc());
    return {
      level: currentLevel,
      zoom: map.getZoom(),
      bearing: +map.getBearing().toFixed(1),
      pitch: +map.getPitch().toFixed(1),
      lit: litRegionIds ? [...litRegionIds] : null,
      view: view.map((n) => +n.toFixed(2)),
      candidates: litRegionIds ? countriesInView(litRegionIds, view) : null,
    };
  },
  visited,
  cellMeta,
  idAt: (lng, lat) => cellIdAt({ lng, lat }),
  info: (lng, lat) => showCellInfoAt({ lng, lat }),
};

// Clicks/hovers resolve to a cell mathematically — no hit-testing, so gaps
// between tiles, boundary lines and merged fills all behave the same.
function cellIdAt(lngLat) {
  const [c, r] = pointToCell(currentLevel, mercX(lngLat.lng), mercY(lngLat.lat));
  return `${currentLevel}/${normCol(c, colsOf(currentLevel))}/${r}`;
}

// --- View-mode cell info ------------------------------------------------------
// Tapping a colored area in view mode answers "when was I here, and how does
// the map know?". The clicked cell is whatever the current zoom is showing, so
// zoomed out you get the aggregate of everything inside it.
let cellInfo = null; // set by mountCellInfo() once the DOM is wired
let selection = null; // { L, col, row } of the highlighted cell, or { area }
let lastInfoLngLat = null; // where you tapped, so zooming can re-resolve it

// Ground size of a cell at the current latitude (Mercator cells shrink as you
// go north). Shared by the HUD readout and the info card.
function cellSizeKm(level) {
  const cosLat = Math.cos((map.getCenter().lat * Math.PI) / 180);
  const km = (SQRT3 * radiusOf(level) * cosLat) / 1000; // flat-to-flat, ground
  if (km >= 10) return `≈ ${Math.round(km)} km`;
  if (km >= 1) return `≈ ${km.toFixed(1)} km`;
  return `≈ ${Math.round(km * 1000)} m`;
}
const cellSizeLabel = (level) =>
  level == null || level === COUNTRY_LEVEL
    ? 'country'
    : level === CONTINENT_LEVEL
      ? 'continent'
      : level === REGION_LEVEL
        ? 'region'
        : `${cellSizeKm(level)} cell`;

// Roll the dates and counts of a set of stored cells into one summary. Taken by
// the cell card and by the region/country card, which differ only in how they
// decide which cells to ask about.
function rollUpIds(ids) {
  let addedAt = 0;
  let firstAt = 0;
  let lastAt = 0;
  let hits = 0;
  const earlier = (a, b) => (b && (!a || b < a) ? b : a); // 0 means "unknown"
  for (const id of ids) {
    for (const m of cellMeta.get(id) ?? []) {
      // Only imported data has a meaningful count — a hand-marked cell carries
      // a placeholder 1 that would be nonsense to show.
      if (m.source !== 'manual' && m.source !== 'unknown') hits += m.hits || 0;
      addedAt = earlier(addedAt, m.addedAt);
      firstAt = earlier(firstAt, m.firstAt);
      lastAt = Math.max(lastAt, m.lastAt || 0);
    }
  }
  // Neither `fixes` nor the per-source breakdown is rolled up. Both are still
  // stored — the import, sync and Sources screens report them — but as facts
  // about a place they answer questions about the recording rather than about
  // where you were: how often a recorder sampled, and which app was running.
  return { cellCount: ids.length, hits, addedAt, firstAt, lastAt };
}

function gatherInfo(L, col, row) {
  const ids = storedUnder(L, col, row);
  if (!ids.length) return null;
  const [lng, lat] = project(cellCenter(L, col, row));
  return {
    ...rollUpIds(ids),
    lat,
    lng: wrapLng(lng),
    sizeLabel: cellSizeLabel(L),
  };
}

// The selection outline — one cell's ring or a whole region's border. Drawn in
// nothing the map means anything else by: white over near-black, owing nothing
// to the accent. See the `sel-halo` / `sel-line` layers in installGrid.
const SEL_COLOR = '#ffffff';
const SEL_CASING = 'rgba(8, 10, 16, 0.85)';

// The highlight ring around the inspected cell — same rounded outline the
// regions use, so it reads as part of the same language.
function selectionFC() {
  if (!selection || !map.getSource('sel')) return EMPTY;
  // A selected region is outlined by its own border rather than by a ring, so
  // the highlight says which shape was picked instead of merely where.
  if (selection.area) {
    // Always the sharpest boundary in memory, whatever the zoom. The map's own
    // shapes drop back to the overview set when zoomed out, because tiling
    // 7,000-point cantons to draw them four pixels across is waste — but this is
    // one shape, drawn because someone asked to look at it, and a border that
    // cuts a straight line across the lake it actually follows is the thing they
    // would be looking at. `sharpenSelection` fetches it if it isn't here yet.
    const g = areaGeometry(selection.area.kind, selection.area.id, true);
    return g
      ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: g }] }
      : EMPTY;
  }
  const { L, col, row } = selection;
  const [cx, cy] = cellCenter(L, col, row);
  const ring = fullHexOffsets(radiusOf(L)).map(([dx, dy]) => [cx + dx, cy + dy]);
  ring.push([...ring[0]]);
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: smoothLoop(ring).map(project) } },
    ],
  };
}

function updateSelection() {
  map.getSource('sel')?.setData(selectionFC());
}

function closeCellInfo() {
  selection = null;
  updateSelection();
  cellInfo?.hide();
}

/**
 * Which region or country is under a point, at the level that is on screen.
 * Resolved from the point itself rather than from the hex it falls in, so a
 * click near a border gets the shape it actually landed on.
 *
 * The same two questions in the same order as `areaOfCell` in src/stats.js —
 * which country, then which of its regions — because the fill was built from
 * that and the two have to agree about what was clicked. This one goes on to
 * name the shape, which is the only reason it isn't a call to it.
 */
function areaAt(lngLat) {
  if (!isVectorLevel(currentLevel)) return null;
  const kind = vectorKindOf(currentLevel);
  const lng = wrapLng(lngLat.lng);
  const country = countryNear(lng, lngLat.lat);
  if (!country) return null;
  if (kind === 'continent') {
    const name = continentOf(country.id);
    return name ? { kind, id: name, name, of: null } : null;
  }
  if (kind !== 'region') return { kind, id: country.id, name: country.id, of: null };
  const region = regionNear(lng, lngLat.lat, country.iso);
  if (region) return { kind, id: region.id, name: region.name, of: country.id };
  // A country the dataset never subdivided stands in as its own region — the
  // same stand-in the fill was built from, so the two agree about what was
  // clicked. See buildAreaFC.
  if (regionsInCountry(country.iso) === 0) {
    return { kind, id: `${WHOLE_COUNTRY}${country.id}`, name: country.id, of: null };
  }
  return null;
}

/**
 * Every stored cell inside one area, found through the same per-cell lookup the
 * fill was built from — so what the card counts is exactly what is painted, and
 * every cell it counts is genuinely inside the shape it names.
 *
 * Over `visited` rather than over the memo, which are the same walk once the
 * level has been drawn and are not the same walk before it. The memo is filled
 * by building a vector level's shapes, so reading it back only ever worked for
 * an area you were already looking at — and a region picked out of the search
 * box is usually one you are not: the card came up saying you had never been to
 * the canton you live in. `areaOfCellMemo` answers from the memo when it can and
 * fills it when it cannot, so the first search pays the ~100 ms sweep the level
 * would have paid anyway and every one after it is a map lookup per cell.
 *
 * `visited` also decides which cells count at all. A cell's answer is memoised
 * forever — its centre never moves — so an erased cell keeps its entry, and the
 * card must not go on counting it.
 */
function storedInArea(kind, id) {
  const out = [];
  for (const cellId of visited) {
    if (areaOfCellMemo(kind, cellId) === id) out.push(cellId);
  }
  return out;
}

/**
 * The countries inside one continent that the map has cells in.
 *
 * The country memo, not a fresh sweep: the continent fill was built by mapping
 * exactly these answers onto their continents, so the count on the card and the
 * count on the shape can never come out different.
 */
function countriesVisitedIn(name) {
  const seen = new Set();
  for (const [cellId, cid] of cellCountryMemo) {
    if (cid && visited.has(cellId) && continentOf(cid) === name) seen.add(cid);
  }
  return seen.size;
}

/** Ground area of a set of cells, each measured at its own latitude. */
function groundKm2(ids) {
  let km2 = 0;
  for (const id of ids) {
    const [L, col, row] = parseCellId(id);
    if (!Number.isFinite(L)) continue;
    km2 += cellAreaKm2(L, project(cellCenter(L, col, row))[1]);
  }
  return km2;
}

/** How big the region or country itself is, for the share of it you have been to. */
function areaKm2(area) {
  if (area.kind === 'continent') return continentAreaKm2(area.id);
  if (area.kind !== 'region' || area.id.startsWith(WHOLE_COUNTRY)) {
    return countryAreaKm2(area.id.startsWith(WHOLE_COUNTRY) ? area.id.slice(WHOLE_COUNTRY.length) : area.id);
  }
  const g = regionGeometry(area.id);
  return g ? geometryAreaM2(g) / 1e6 : 0;
}

/**
 * The card for a whole region, country or continent. Same shape as the cell
 * card because it is the same question asked of more ground — "when was I here,
 * how often, and where does that come from" — with the answers only an area can
 * give: how much of it you have been to, how much of it there is, and at the
 * continent level how many of the countries in it you have set foot in.
 *
 * **An area with nothing in it still gets a card.** It used to fall through to
 * the cell card, which found nothing and closed — the reasoning being that an
 * empty fill already says "you have not been here". It doesn't say the rest.
 * How big Kazakhstan is, and that you have been to none of it, is an answer;
 * a tap that does nothing is indistinguishable from a tap that missed. The
 * fall-through is still there for the sea, where there is no shape to describe.
 */
function showAreaInfoAt(lngLat) {
  const area = areaAt(lngLat);
  if (!area) return false;
  lastInfoLngLat = lngLat; // remembered so a zoom can re-resolve the same spot
  showAreaInfo(area);
  return true;
}

/**
 * A whole region or country picked out of the search box rather than tapped.
 *
 * The same card and the same outline, because it is the same question — the
 * only difference is that nothing was tapped, so there is no point on the map
 * for a later zoom to re-resolve against. A stale one left over from an earlier
 * tap would answer that zoom with a different shape than the one on screen.
 *
 * It used to be answered with a pin at the middle of the area's bounding box,
 * which is what the search box had to give: a coordinate. For anything that is
 * not a rectangle that coordinate is not in the area — the middle of the United
 * States' box is in Puget Sound and Hawaii's is open ocean — so the answer to
 * "where is this" was a marker somewhere near it and nothing about it.
 *
 * @param {{kind:string, id:string, name:string, of:string|null, bbox:Array<number>}} area
 */
function showSearchedArea(area) {
  showPlacePin(null); // the pin answers a different question; only one at a time
  lastInfoLngLat = null;
  showAreaInfo(area);
  fitBboxOnMap(area.bbox);
}

/**
 * The ISO3 code of the country an area belongs to — the key the detailed
 * boundaries are fetched by. Null for a continent, which is not one country's
 * worth of fetching.
 */
function isoOfArea(area) {
  if (area.kind === 'continent') return null;
  if (area.kind === 'region' && !area.id.startsWith(WHOLE_COUNTRY)) {
    return regionById(area.id)?.iso ?? null;
  }
  return countryIso(area.id.startsWith(WHOLE_COUNTRY) ? area.id.slice(WHOLE_COUNTRY.length) : area.id);
}

/** The card and the outline for one area, however it was arrived at. */
function showAreaInfo(area) {
  const ids = storedInArea(area.kind, area.id);
  closeRouteInfo(); // the cards all share the same spot on screen
  closePhotoInfo();
  const covered = groundKm2(ids);
  const whole = areaKm2(area);
  selection = { area };
  updateSelection();
  // "Canton in Switzerland", not "Region in Switzerland" — the same word the
  // search box puts in front of the name, so the row you picked and the card it
  // opened are describing the thing with the same noun. A country standing in as
  // its own region says so; it is not a region of anything.
  const term = area.id.startsWith(WHOLE_COUNTRY) ? 'Country' : regionTerm(isoOfArea(area));
  const what =
    area.kind === 'continent'
      ? 'Continent'
      : area.kind === 'region'
        ? (area.of ? `${term} in ${area.of}` : term)
        : 'Country';
  cellInfo?.show({
    ...rollUpIds(ids),
    title: area.name,
    sizeLabel: [what, whole ? `${Math.round(whole).toLocaleString()} km²` : null].filter(Boolean).join(' · '),
    covered,
    coveredPct: whole ? (covered / whole) * 100 : 0,
    coveredOf: area.name,
    // Two answers, not one dressed as a subtitle. The countries used to sit
    // beside "Continent" in the line under the title, where it read as what
    // kind of thing had been clicked rather than as a measurement of it — and
    // where it could not be compared with the ground covered underneath it.
    // They are different questions: crossing the top of Africa by road covers
    // ground in four countries, and living in Luxembourg covers one.
    inside:
      area.kind === 'continent'
        ? { label: 'Countries visited', n: countriesVisitedIn(area.id), of: countriesInContinent(area.id) }
        : null,
  });
  // Drawn from whatever is in memory, and then again from the national survey's
  // own outline when it arrives. Natural Earth cannot supply this at any
  // tolerance — its 10m geometry gives Solothurn 276 points where swisstopo
  // gives 6,951 — so a shape somebody is looking at deliberately is worth the
  // one request. See loadFineRegions.
  fetchFineRegions(isoOfArea(area), area.name);
}

/**
 * Answer a spot with whichever card the level has to give: an area, a cell, or
 * nothing.
 *
 * **A vector level never answers with a cell.** There are no hexagons on screen
 * at the region, country or continent levels, so a tap is about the shape it
 * landed on — and where there is no shape, the honest answer is nothing. It
 * used to fall through to the cell card, which resolves the tap against the
 * coarsest hex level: a tap on open sea could open a card about an 83 km
 * hexagon lit by a coastline somewhere off the far side of it, and draw a hex
 * ring around a patch of ocean. Neither the card nor the ring described
 * anything that was on screen.
 *
 * The fall-through is still right below a vector level, where the hexagons are
 * what you are looking at.
 */
function showInfoAt(lngLat) {
  if (showAreaInfoAt(lngLat)) return;
  if (isVectorLevel(currentLevel)) {
    closeCellInfo();
    return;
  }
  showCellInfoAt(lngLat);
}

function showCellInfoAt(lngLat) {
  if (currentLevel == null) return;
  closeRouteInfo(); // the cards all share the same spot on screen
  closePhotoInfo();
  lastInfoLngLat = lngLat; // remembered so a zoom can re-resolve the same spot
  // At the country level there are no hexes to inspect — fall back to the
  // coarsest hex level, which is what the country fill is derived from.
  const L = Math.min(currentLevel, MAX_LEVEL);
  const [c, r] = pointToCell(L, mercX(lngLat.lng), mercY(lngLat.lat));
  const col = normCol(c, colsOf(L));
  if (!litSets[L]?.has(`${col}/${r}`)) {
    closeCellInfo();
    return;
  }
  const info = gatherInfo(L, col, r);
  if (!info) {
    closeCellInfo();
    return;
  }
  selection = { L, col, row: r };
  updateSelection();
  cellInfo?.show(info);
}

// --- Saved routes -------------------------------------------------------------
// An imported track can keep its actual line as well as the cells it lit up
// (src/routes.js). Routes are a layer of their own over the regions and a table
// of their own on the server: clearing a cell never touches them, and they
// never feed the heat maps — they're a record of one journey, not of coverage.
const ROUTES_KEY = 'visited-map:routes:v1';
// The two that answer a click. The ghost is deliberately not among them: it is
// the part of a route you can see *through a building*, and a click that landed
// on a wall should be about the wall.
const ROUTE_LAYERS = ['route-glow', 'route-line'];
/** Everything drawn for a route, ghost included, for showing and hiding. */
const routeDrawLayers = () =>
  (map.getLayer(ROUTE_GHOST_ID) ? [ROUTE_GHOST_ID, ...ROUTE_LAYERS] : ROUTE_LAYERS);

let routesOn = localStorage.getItem(ROUTES_KEY) === 'on';
let routeList = []; // newest first; carries `geom` only once routeGeom is true
// Copies of one outing, folded away: hidden route id → the id standing in for
// it. Derived from the list every time it changes rather than stored, because
// it is a fact about the data and not a judgement about it — a tour imported
// next year folds against what is already here without anyone deciding again.
let dupeOf = new Map();
let showDupes = false; // "show me both anyway", for the length of this visit

/** The routes worth listing: one row per outing, whichever copy speaks for it. */
const listedRoutes = () => (showDupes ? routeList : routeList.filter((r) => !dupeOf.has(r.id)));
/** How many rows the fold is currently holding back. */
const foldedCount = () => dupeOf.size;

function refoldRoutes() {
  dupeOf = duplicateRoutes(routeList);
}
let routeGeom = false; // whether the lines themselves have been fetched
let routeInfo = null; // set by mountRouteInfo() once the DOM is wired
let photoInfo = null; // set by mountPhotoInfo(), and only used inside the app
let homeAssistant = null; // set by mountHomeAssistant()
let colorPicker = null; // set by mountColorPicker()
let stravaUi = null; // set by mountStrava()
let deviceUi = null; // set by mountDevices()
let statsUi = null; // set by mountStats()
let whatsNewUi = null; // set by mountWhatsNew()
let backupUi = null; // set by mountBackup()
let homeUi = null; // set by mountHome()
let introUi = null; // set by mountIntro()
// Whether this load is somebody's first. Read by the "what's new" banner, which
// has nothing to say to a map that has only just appeared and would be saying it
// over the top of the introduction anyway.
let introShowing = false;
let selectedRoute = null;
let hoveredRoute = null;

function saveRoutesPref() {
  try {
    localStorage.setItem(ROUTES_KEY, routesOn ? 'on' : 'off');
  } catch {
    /* fine */
  }
}

// --- Routes by activity ------------------------------------------------------
// With the activity worked out for nearly every route, "show me only the rides"
// and "make the ski days white" become answerable. Both are per-activity and
// both live in the browser: they're a way of looking at the map, not a fact
// about it, so nothing here is sent to the server.
//
// The key is the activity string exactly as stored ('' for one that was never
// worked out); ROUTE_NO_SPORT stands in for the blank so it can be a real entry
// in a map and a real row in the menu.
const ROUTE_VIEW_KEY = 'visited-map:route-view:v1';
const HIDDEN_TRIPS_KEY = 'visited-map:hidden-trips:v1';
const TRIP_NAMES_KEY = 'visited-map:trip-names:v1';
// The clock convention belongs to the account, not to this browser — but it is
// mirrored here like everything else in the payload, and for a sharper reason
// than the others. Without a local copy this browser boots on the default
// ('auto') and holds it until the account answers; anything you touch in that
// window stamps the preferences as *newer than the account*, and the push that
// follows sends the default up over the 24-hour you picked on the phone. A
// setting that quietly reverts itself is the exact failure the stamps exist to
// prevent, and it was reachable here by dragging a colour on a slow connection.
const CLOCK_KEY = 'visited-map:clock:v1';
const ROUTE_NO_SPORT = '\u0000none';

let hiddenSports = new Set(); // activities switched off
let sportColors = new Map(); // activity → hex, only where it differs

// Both halves are keyed by activity name, and those names have been tidied at
// least once (Road ride → Cycling, Hike → Hiking). A stored key that predates a
// rename would silently match nothing — the colour would just stop applying —
// so everything read back goes through the same canonicaliser the routes did.
// ROUTE_NO_SPORT is the sentinel for "activity not set" and is left alone.
const canonKey = (key) => (key === ROUTE_NO_SPORT ? key : canonicalSport(key));

function adoptRouteView(raw) {
  const hidden = Array.isArray(raw?.hidden) ? raw.hidden : [];
  hiddenSports = new Set(hidden.filter((k) => typeof k === 'string').map(canonKey));
  sportColors = new Map(
    Object.entries(raw?.colors ?? {})
      .filter(([, v]) => /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(String(v)))
      .map(([k, v]) => [canonKey(k), v]),
  );
}

function loadRouteView() {
  try {
    adoptRouteView(JSON.parse(localStorage.getItem(ROUTE_VIEW_KEY) || '{}'));
  } catch {
    /* defaults are fine */
  }
  try {
    const put = JSON.parse(localStorage.getItem(HIDDEN_TRIPS_KEY) || '[]');
    if (Array.isArray(put)) hiddenTripIds = new Set(put.filter((id) => typeof id === 'string'));
  } catch {
    /* defaults are fine */
  }
  // Mirrored locally for the same reason the hidden ids are, and it is not
  // about being offline: on a load where this browser's stamp is the newer one,
  // `prefsPayload()` is sent back as it stands — so anything the payload can
  // carry and this cannot rebuild is a preference that gets *erased* by the
  // recovery that exists to save it.
  try {
    const named = JSON.parse(localStorage.getItem(TRIP_NAMES_KEY) || '{}');
    if (named && typeof named === 'object') {
      tripNames = new Map(Object.entries(named).filter(([, n]) => typeof n === 'string' && n));
      derived.setTripNames(tripNames);
    }
  } catch {
    /* defaults are fine */
  }
  // Straight in, with no repaint: nothing has been drawn yet. setClock() checks
  // the value itself and falls back to following the device.
  setClock(localStorage.getItem(CLOCK_KEY));
}

const routeViewJson = () => ({ hidden: [...hiddenSports], colors: Object.fromEntries(sportColors) });

// --- Preferences that follow the account -------------------------------------
// Every colour you choose — the visited wash and one per activity — plus which
// activities are switched off. Written to localStorage on every change (instant,
// and it still works with no server) and pushed to the account debounced, so the
// phone and the laptop agree.
//
// Reconciled by timestamp, and that is the part that used to be wrong. The old
// rule was "on load, the server wins", which quietly undid any change whose push
// had not landed — a tab closed inside the 600 ms debounce, a flaky connection,
// a failed request that nothing retried. The colour looked right until the next
// reload and then vanished, with nothing anywhere saying a save had failed.
// Now each copy carries when it was last touched and the newer one wins; if it
// is the local one, it is pushed back rather than thrown away.
//
// Both stamps come from client clocks, so two devices editing while offline are
// resolved by whichever *thinks* it is later. For one person's colour choices
// that is a fair trade against the machinery real conflict resolution needs.
const PREFS_STAMP_KEY = 'visited-map:prefs-stamp:v1';

let prefsStamp = Number(localStorage.getItem(PREFS_STAMP_KEY)) || 0;
let prefsDirty = false; // a local change the server has not acknowledged
let pushViewTimer = null;

// Where you live. Worked out from the cells that get visited most (src/trips.js)
// until you say otherwise, and then it's whatever you said — a guess about
// something this personal should be correctable, and everything about the trip
// list is measured from it.
let homePlace = null; // { lng, lat, name } | null = use the guess

// Which introduction this person has already been through, as its version
// number. Read from this browser to begin with and raised by whatever the
// account turns out to know — see `seenVersion` in src/intro.js.
let introSeen = 0;

// Trips you put away. They are derived, not stored, so there is nothing to
// delete — the list skips them and can be told to stop. It follows the account
// rather than the device, because a trip you decided was a commute is a
// judgement about your history, not about this laptop. Ids are `trip-<start>`
// and stable across rebuilds, so one stays hidden as more history arrives.
let hiddenTripIds = new Set();

// Trips you named yourself, by id. Trips are derived rather than stored, so
// there is no row with a name column in it to edit — which was the standing
// reason a trip could not be renamed at all. What there is instead is a stable
// id and somewhere to keep an opinion about it, which is the same shape as
// `hiddenTripIds` above and follows the account for the same reason: "the week
// I broke my wrist" is a fact about your history, not about this laptop.
//
// An empty string is not a name, it is a deletion: the derived name comes back.
// That is why nothing is ever stored empty here, and why the map is the whole
// truth — an id absent from it is a trip called what the server called it.
let tripNames = new Map();

/** What an id from `buildTrips` looks like, for anything read off the network. */
const TRIP_ID = /^trip-\d+$/;

const prefsPayload = () => ({
  v: 1,
  updatedAt: prefsStamp,
  // Both colours, and the dark one again under the old key. `accent` is what a
  // build from before this change reads, and it must not be *this device's*
  // current colour — that would make the account's copy depend on which basemap
  // the last laptop to sync happened to be on. Dark is the default basemap and
  // so the better single answer.
  accent: accents.dark,
  accents: { ...accents },
  routeView: routeViewJson(),
  home: homePlace,
  hiddenTrips: [...hiddenTripIds],
  tripNames: Object.fromEntries(tripNames),
  // Whether a time reads 14:20 or 02:20 PM. In the account rather than in this
  // browser because it is a fact about you, not about the machine you happen to
  // be sitting at — picking 24-hour on the laptop should mean the phone agrees
  // without being told twice.
  clock: clockMode(),
  // Whether it snows, by the same argument: an easter egg you switched on is a
  // thing you decided, not a thing about the laptop you decided it at. It costs
  // one short string and it means the phone is already snowing when you pick it
  // up, which is the entire point of an easter egg you had to go and find.
  snow: snowMode(),
  // How often the map says what has changed since you last looked. In the
  // account for the same reason as the clock: it is a thing about how much you
  // want to be told, not about which browser you are being told in.
  //
  // The *snapshot* it is measured against goes with it, and used to be kept
  // locally on the argument that the phone and the laptop have seen different
  // banners. What that produced was one ride announced on both of them, which
  // is the same news twice. Both copies are kept — this one is written on every
  // banner and works with no server — and they are merged rather than
  // reconciled: see `mergeSnapshots` in src/whats-new.js.
  whatsNew: bannerMode(),
  whatsNewSeen: lastSnapshot(),
  // Which language. In the account for the plainest reason of all: the language
  // you read is not a fact about a browser, and picking English again on the
  // phone after choosing it on the laptop is the kind of thing that makes a
  // setting feel like it did not take.
  locale: locale(),
  // The 3D basemap's Mapbox token, for exactly the same reason and with a
  // stronger case: it is a thing you signed up for once, and pasting it again on
  // every device was the whole of what stood between them and the basemap. Sent
  // even when it is `''`, because the key's presence is what tells a device the
  // account has an opinion at all — see remoteToken() in src/prefs.js.
  mapboxToken: mapboxToken(),
  // Which introduction has been sat through. In the account because it is a
  // fact about a *person* — what a trip is does not become news again on a
  // second device — with this browser's own copy beside it only to survive a
  // push that never landed. The two are merged rather than reconciled, and the
  // higher number wins: see `seenVersion` in src/intro.js.
  intro: introSeen,
});

// Called here rather than beside its own definition: it fills in `hiddenTripIds`
// and `tripNames` too, and both are declared above — a `let` read before its
// declaration runs is a temporal-dead-zone throw, on the module's very first
// line of work.
loadRouteView();

/** Put a trip away, or (with a null id) bring every one of them back. */
async function setTripHidden(id, hide) {
  if (id === null) hiddenTripIds = new Set();
  else if (hide) hiddenTripIds.add(id);
  else hiddenTripIds.delete(id);
  touchPrefs();
  await pushPrefs();
}

/**
 * Call a trip something. An empty name gives it its derived one back.
 *
 * Straight out rather than on the debounce, like the other two deliberate
 * single acts here: typing a name and closing the tab is one gesture, and a
 * name still sitting in a 600 ms timer when that happens is a name that was
 * never given.
 */
async function setTripName(id, name) {
  const clean = String(name ?? '').trim().slice(0, TRIP_NAME_MAX);
  if (clean) tripNames.set(id, clean);
  else tripNames.delete(id);
  derived.setTripNames(tripNames);
  touchPrefs();
  await pushPrefs();
}

/**
 * Rebuild what is on screen after the clock convention changes.
 *
 * Nearly every surface that shows a time — the cell card, a route, the sync
 * dialogs — is built the moment it is opened, so it picks the new setting up on
 * its own and needs nothing here. The statistics panel is the exception: it can
 * be standing open with a list of routes in it while you change this, so it is
 * asked to draw itself again.
 */
function redrawClocks() {
  statsUi?.redraw();
}

// The host saying what a clock reads on this device — a fact the page cannot
// work out for itself, pushed the way the safe-area insets are (`pushClock()` in
// HexPlore-IOS/HexPlore/WebPanel.swift). It arrives before any of this runs on
// the first load and again once the page has finished, which is the one that
// needs catching. Nothing fires it in a browser.
window.addEventListener('hexplore:clock', () => {
  if (refreshClock()) redrawClocks();
});

/** Note a local change: stamp it, mirror it locally, and schedule the push. */
function touchPrefs() {
  prefsStamp = Date.now();
  prefsDirty = true;
  try {
    localStorage.setItem(PREFS_STAMP_KEY, String(prefsStamp));
    localStorage.setItem(ROUTE_VIEW_KEY, JSON.stringify(routeViewJson()));
    localStorage.setItem(HIDDEN_TRIPS_KEY, JSON.stringify([...hiddenTripIds]));
    localStorage.setItem(TRIP_NAMES_KEY, JSON.stringify(Object.fromEntries(tripNames)));
    localStorage.setItem(CLOCK_KEY, clockMode());
  } catch {
    /* private mode, quota — the server copy is still attempted */
  }
  // Both colour keys, through the one writer that keeps them agreeing — this
  // used to mirror `accent`, which is now whichever of the two the basemap on
  // screen calls for and so the wrong thing to put under the single-value key.
  saveAccents();
  clearTimeout(pushViewTimer);
  // Debounced because dragging a colour fires on every frame.
  pushViewTimer = setTimeout(pushPrefs, 600);
}

const saveRouteView = touchPrefs;

async function pushPrefs() {
  clearTimeout(pushViewTimer);
  if (!prefsDirty || !authed) return;
  const sending = prefsStamp;
  try {
    await auth.setPrefs(prefsPayload());
    // Only clear the flag if nothing changed while the request was in flight.
    if (prefsStamp === sending) prefsDirty = false;
  } catch {
    // Not worth interrupting anyone over — but it must not be forgotten either,
    // which is what made a lost colour look like the app's own doing. Retry, and
    // leave the flag set so the unload flush and the next load both catch it.
    clearTimeout(pushViewTimer);
    pushViewTimer = setTimeout(pushPrefs, 5000);
  }
}

// The page going away is the likeliest moment for an unsaved change to exist,
// so it gets a send that survives it. `pagehide` covers closing and navigating;
// `visibilitychange` covers a phone being locked or the app switched away from,
// which on iOS is often the last event a page ever sees.
function flushPrefsOnExit() {
  if (!prefsDirty || !authed) return;
  clearTimeout(pushViewTimer);
  auth.sendPrefs(prefsPayload());
  // Assumed sent. Nothing here can learn otherwise — the page may not be alive
  // to hear the answer — and leaving the flag up would re-send the same blob on
  // every tab switch. If it really did fail, the stamp in localStorage is still
  // ahead of the account's and the next load pushes it again; that comparison,
  // not this flag, is what actually guarantees the change is not lost.
  prefsDirty = false;
}
window.addEventListener('pagehide', flushPrefsOnExit);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushPrefsOnExit();
});

/** Adopt a set of preferences wholesale — from the server, or from a reset. */
function adoptPrefs(prefs) {
  if (prefs.routeView && typeof prefs.routeView === 'object') adoptRouteView(prefs.routeView);
  hiddenTripIds = new Set(
    (Array.isArray(prefs.hiddenTrips) ? prefs.hiddenTrips : [])
      .filter((id) => typeof id === 'string' && TRIP_ID.test(id)),
  );
  // Same shape of check as the hidden ids above, on both halves: the blob comes
  // off the network, and an id that is not one names no trip while a name that
  // is not a string is a `textContent` of "[object Object]".
  tripNames = new Map(
    Object.entries(prefs.tripNames && typeof prefs.tripNames === 'object' ? prefs.tripNames : {})
      .filter(([id, name]) => TRIP_ID.test(id) && typeof name === 'string' && name.trim())
      .map(([id, name]) => [id, name.trim().slice(0, TRIP_NAME_MAX)]),
  );
  derived.setTripNames(tripNames);
  const h = prefs.home;
  homePlace = h && Number.isFinite(+h.lng) && Number.isFinite(+h.lat)
    ? { lng: +h.lng, lat: +h.lat, name: String(h.name ?? '').slice(0, 80) }
    : null;
  // Repaint only if the formatters actually changed, since every list that
  // shows a time has to be rebuilt to pick it up.
  if (setClock(prefs.clock)) redrawClocks();
  // Only when the account actually names one. An account whose preferences were
  // written before snow existed has no key, and reading that as `off` would take
  // the snow off a device that had just been asked to switch it on — the same
  // trap the Mapbox token below is careful about, for the same reason.
  if (isSnowMode(prefs.snow) && prefs.snow !== snowMode()) {
    setSnowMode(prefs.snow);
    snowOn = null;
    refreshSnow();
  }
  // Nothing to redraw: the banner has already been decided for this load, and a
  // frequency adopted mid-session is for the next one.
  if (isBannerMode(prefs.whatsNew)) setBannerMode(prefs.whatsNew);
  // Only ever upwards. An account that has seen the introduction and a browser
  // that has must not be able to un-see it for each other — which is exactly
  // what a plain assignment would do to a device whose push has not landed yet.
  introSeen = Math.max(introSeen, Number(prefs.intro) || 0);
  // Adopted, but never acted on mid-session: `setLocale` would reload the page,
  // and a page that reloads itself because a *sync* landed is a page that threw
  // away whatever you were in the middle of. Stored now, in force next time —
  // which is what the reload on the deciding device already did for that one.
  if (prefs.locale && prefs.locale !== locale()) setLocale(prefs.locale, false);
  // The pair if the account has it; the single value if it was saved before
  // there were two, in which case it stands for both — the same reading
  // savedAccents() gives the old localStorage key, for the same reason.
  const pair = prefs.accents;
  let movedAccent = false;
  if (pair && typeof pair === 'object' && (isAccent(pair.light) || isAccent(pair.dark))) {
    for (const k of ['light', 'dark']) {
      if (isAccent(pair[k])) {
        accents[k] = String(pair[k]).toLowerCase();
        movedAccent = true;
      }
    }
  } else if (isAccent(prefs.accent)) {
    accents.light = String(prefs.accent).toLowerCase();
    accents.dark = accents.light;
    movedAccent = true;
  }
  if (movedAccent) {
    accent = accents[themeNow()];
    colorPicker?.set(accent); // the swatch, and the panel behind it
    applyColors();
    repaintAccent();
  }
  saveAccents();
  try {
    localStorage.setItem(ROUTE_VIEW_KEY, JSON.stringify(routeViewJson()));
    localStorage.setItem(HIDDEN_TRIPS_KEY, JSON.stringify([...hiddenTripIds]));
    localStorage.setItem(TRIP_NAMES_KEY, JSON.stringify(Object.fromEntries(tripNames)));
    localStorage.setItem(CLOCK_KEY, clockMode());
  } catch {
    /* fine */
  }
  renderedSports = ''; // the per-activity rows must be rebuilt against the new state
  repaintRouteColors();
  syncRoutes();
  syncHomeMarker();

  // Last, and after the rows above have been reset rather than before: the
  // Mapbox token is the one preference here that redraws the layers menu, and on
  // an account that has taken it off it can also take the map off 3D entirely.
  // Neither is a thing to do halfway through adopting the rest.
  //
  // Only when it has actually moved — `remoteToken` returns null for an account
  // that has never held one, which must leave this device's own copy alone.
  const token = remoteToken(prefs);
  if (token !== null && token !== mapboxToken()) {
    setMapboxToken(token);
    mapboxTokenChanged();
  }
}

/**
 * Reconcile this browser's preferences with the account's. Runs on every load,
 * after the routes are known — the rows it rebuilds are built from what the
 * account actually has.
 */
async function syncPrefs() {
  let remote;
  try {
    remote = await auth.getPrefs();
  } catch {
    return; // offline: the local copy stands, and stays flagged if it is dirty
  }
  const verdict = reconcilePrefs({ localStamp: prefsStamp, dirty: prefsDirty, remote });

  if (verdict === 'adopt') {
    prefsStamp = Number(remote?.updatedAt) || 0;
    prefsDirty = false;
    try {
      localStorage.setItem(PREFS_STAMP_KEY, String(prefsStamp));
    } catch {
      /* fine */
    }
    // Three of these, all "the account is behind what this browser has, so send
    // it up rather than reset". The visited colour only started being synced
    // after the activity colours were, so an account can hold the second and
    // not the first; an account written before the light and dark washes were
    // told apart holds one colour where there are now two; and an account
    // written before the Mapbox token was synced at all holds no token beside a
    // browser that has one, which is the only copy of it in existence. Either
    // way the local copy goes up, which is the answer the person meant.
    const migrate =
      (!isAccent(remote.accent) && accent !== DEFAULT_ACCENT)
      || (!remote.accents && isAccent(remote.accent))
      || (remoteToken(remote) === null && hasMapboxToken());
    adoptPrefs(remote);
    if (migrate) touchPrefs();
  } else if (verdict === 'push') {
    prefsDirty = true;
    pushPrefs();
  }
  // Both of these read `remote` rather than the adopted state, and for the same
  // reason: this is the first moment anything knows what the *account* has
  // already been told, and the 'push' branch above never fills that in.
  //
  // The banner's baseline is merged in before the banner is decided — `onAuthed`
  // awaits this and shows it afterwards — so a ride the phone already announced
  // is not announced again here. And when the merge comes out ahead of what the
  // account holds, the account is the one that is behind: that is a browser
  // whose own banner never got pushed, and an account left holding the lower
  // number would let the *other* device announce it a second time.
  const seen = mergeSnapshots(lastSnapshot(), remote?.whatsNewSeen);
  if (seen) {
    rememberSnapshot(seen);
    if (JSON.stringify(seen) !== JSON.stringify(readSnapshot(remote?.whatsNewSeen))) touchPrefs();
  }
  // Awaited by nothing: the deck is a curtain over a map that is still drawing,
  // and holding the sign-in open until it has decided would be a blank screen
  // for the sake of a screen that covers it anyway.
  offerIntro(remote);
}

/**
 * Show the introduction, if this person has not had it.
 *
 * Both copies count, and the higher one wins — a browser that has seen it and
 * could not push says so locally, a second browser hears it from the account.
 * `shouldIntro` is the whole of that argument and it is tested; this is the
 * part that knows about the deck.
 */
function offerIntro(remote) {
  introSeen = Math.max(introSeen, introSeenLocally());
  if (!shouldIntro({ remote, local: introSeen })) return;
  // The banner about what has changed since last time is suppressed for this
  // load, not skipped: `whats-new` still moves its baseline (see `onAuthed`), so
  // tomorrow reports what happened today rather than reporting the whole map as
  // news. What it must not do is greet a first-ever sign-in with a summary of
  // changes since a map that did not exist, over the top of the introduction.
  introShowing = true;
  introUi?.open();
}

const sportKey = (route) => route.sport || ROUTE_NO_SPORT;
const sportLabel = (key) => (key === ROUTE_NO_SPORT ? 'Not set' : key);
const sportColor = (key) => sportColors.get(key) ?? ROUTE_COLOR;

/** Every activity present in the list, most-used first. */
function sportsPresent() {
  const counts = new Map();
  for (const r of listedRoutes()) counts.set(sportKey(r), (counts.get(sportKey(r)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => (a[0] === ROUTE_NO_SPORT) - (b[0] === ROUTE_NO_SPORT) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, n]) => ({ key, n }));
}

// Isolating a route: while set, only this one is drawn. It deliberately beats
// the per-activity filter rather than intersecting with it — you asked to see
// *this* route, and having it stay invisible because its activity happens to be
// switched off would be obtuse.
let soloRoute = null;

const visibleRoutes = () => {
  if (soloRoute != null) return routeList.filter((r) => r.id === soloRoute);
  // The fold applies here too, or the second copy would still be drawn — two
  // lines over one road, one of which nothing in the list admits to.
  return listedRoutes().filter((r) => !hiddenSports.has(sportKey(r)));
};

/** Draw only this route, or (with null) go back to everything. */
function setSoloRoute(id) {
  soloRoute = id ?? null;
  updateSoloChip();
  syncRoutes();
}

// The chip is the only way out of isolation that doesn't mean opening a menu,
// so it lives on the map rather than in one.
function updateSoloChip() {
  const chip = document.getElementById('route-solo');
  if (!chip) return;
  const route = soloRoute == null ? null : routeList.find((r) => r.id === soloRoute);
  // The isolated route can vanish under us — deleted, or the list reloaded
  // after a sync. Left set, `visibleRoutes()` would return nothing and the chip
  // that undoes it would be hidden: a map with no routes and no way back.
  if (soloRoute != null && !route) soloRoute = null;
  chip.hidden = !route;
  if (!route) return;
  document.getElementById('route-solo-text').textContent =
    `Showing only ${route.name || 'one route'}`;
}

// One `match` over the feature's own `sport`, so a thousand routes are still one
// paint property rather than a layer each. Only activities actually recoloured
// get a branch; everything else falls through to the default.
function routeMatchExpr(of) {
  const entries = [...sportColors].filter(([, hex]) => hex && hex.toLowerCase() !== ROUTE_COLOR.toLowerCase());
  if (!entries.length) return of(ROUTE_COLOR);
  const expr = ['match', ['coalesce', ['get', 'sport'], '']];
  for (const [key, hex] of entries) {
    // The blank activity is stored under a sentinel; on the feature it is ''.
    expr.push(key === ROUTE_NO_SPORT ? '' : key, of(hex));
  }
  expr.push(of(ROUTE_COLOR));
  return expr;
}

// The colour of a route line, never its opacity: an activity colour can carry
// one, and a translucent *colour* would be composited under the glow and the
// selected-route bump as well, which is two more multiplications than anyone
// asked for. It comes back as a factor on the line's opacity instead.
const routeColorExpr = (mix) => routeMatchExpr((hex) => mix(hexOpaque(hex)));
const routeAlphaExpr = () => routeMatchExpr(hexAlpha);

// Pull the route list. Metadata only by default — the lines are a much bigger
// payload, and there's no point fetching them until they're on screen.
async function loadRoutes(withGeom = routesOn) {
  if (!authed) {
    routeList = [];
    refoldRoutes();
    routeGeom = false;
    syncRoutes();
    return;
  }
  try {
    routeList = await auth.getRoutes(withGeom);
    refoldRoutes();
    routeGeom = withGeom;
  } catch (e) {
    console.warn('Loading routes failed:', e);
    routeList = [];
    refoldRoutes();
    routeGeom = false;
  }
  syncRoutes();
  if (routeGeom) namePlaces();
}

// Routes saved before place naming existed have no place. Working one out needs
// the geometry and the (lazy, ~2 MB) place dataset, so it happens here rather
// than at load: whenever the lines are in memory anyway, anything still blank
// gets named and sent back once.
let namingPlaces = false;
async function namePlaces() {
  const blank = routeList.filter((r) => !r.place && r.geom?.length);
  if (!blank.length || namingPlaces) return;
  namingPlaces = true;
  try {
    await loadPlaces();
    const named = [];
    for (const route of blank) {
      const place = describeRoute(route);
      if (!place) continue;
      route.place = place;
      named.push([route.id, place]);
    }
    if (named.length) await auth.setRoutePlaces(named);
  } catch (e) {
    console.warn('Naming routes failed:', e);
  } finally {
    namingPlaces = false;
  }
}

// Push the current list at the map and keep the menu's count honest.
function syncRoutes() {
  updateSoloChip();
  updateRoutesUi();
  const src = map.getSource('routes');
  if (!src) return;
  src.setData(routesOn && routeGeom ? routesToFC(visibleRoutes()) : EMPTY);
  for (const id of routeDrawLayers()) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', routesOn ? 'visible' : 'none');
  }
  // Feature state doesn't survive setData, and a basemap switch rebuilds the
  // source from scratch — so the highlight is re-applied here, not once.
  if (selectedRoute != null && routeGeom) {
    map.setFeatureState({ source: 'routes', id: selectedRoute }, { sel: true });
  }
  // The pointer has not moved, so whatever it was on it is still on.
  if (hoveredRoute != null && routesOn && routeGeom) {
    map.setFeatureState({ source: 'routes', id: hoveredRoute }, { hov: true });
  } else hoveredRoute = null;
}

function setRoutesOn(on) {
  if (on === routesOn) return;
  routesOn = on;
  saveRoutesPref();
  if (!on) {
    closeRouteInfo();
    soloRoute = null;
    updateSoloChip();
  }
  // First time they're switched on, the geometry still has to be fetched.
  if (on && !routeGeom) loadRoutes(true);
  else syncRoutes();
}

function setSelectedRoute(id) {
  if (selectedRoute === id) return;
  const src = map.getSource('routes');
  if (selectedRoute != null && src) map.removeFeatureState({ source: 'routes', id: selectedRoute }, 'sel');
  selectedRoute = id;
  if (id != null && src) map.setFeatureState({ source: 'routes', id }, { sel: true });
}

/**
 * Which route the pointer is on. One feature state, and the glow's own paint
 * expressions do the rest — the same trade the railway hover makes, where the
 * highlight costs nothing of ours because the style already answers it.
 *
 * The early return matters more than it looks: this is called from every
 * mousemove, and a `setFeatureState` on the route already lit would re-evaluate
 * the layer's paint on every one of them.
 */
function setHoveredRoute(id) {
  if (hoveredRoute === id) return;
  const src = map.getSource('routes');
  if (hoveredRoute != null && src) map.removeFeatureState({ source: 'routes', id: hoveredRoute }, 'hov');
  hoveredRoute = id;
  if (id != null && src) map.setFeatureState({ source: 'routes', id }, { hov: true });
}

function closeRouteInfo() {
  setSelectedRoute(null);
  routeInfo?.hide();
}

// Which saved route is under the pointer, if any. A line a couple of pixels
// wide is hard to hit, so the query gets some slack around the point — and the
// glow layer, being wider, does most of the catching.
function routeAt(point) {
  if (!routesOn || !routeGeom || !map.getLayer('route-line')) return null;
  const pad = 8;
  const hit = map.queryRenderedFeatures(
    [
      [point.x - pad, point.y - pad],
      [point.x + pad, point.y + pad],
    ],
    { layers: ROUTE_LAYERS },
  )[0];
  if (!hit) return null;
  return routeList.find((r) => r.id === hit.properties?.id) ?? null;
}

// A tap on a route wins over the cell underneath it: you aimed at the line.
function showRouteInfo(route) {
  closeCellInfo();
  closePhotoInfo();
  setSelectedRoute(route.id);
  routeInfo?.show(route);
}

// MapLibre's tracking control hands the camera back when it sees a move it
// didn't cause — but it deliberately ignores one that arrives mid-zoom, so that
// a pinch doesn't drop the lock. A programmatic flight *starts* as a zoom, so
// it is ignored too, and the next position update snaps the map back: tap a
// trip while "my location" is locked on and the view leaves and returns, which
// reads as the map refusing to go. Telling the control the camera is about to
// move for someone else's reasons is precisely what a drag tells it. It falls
// to its background state — the blue dot stays and keeps updating, only the
// camera is let go.
function releaseCameraLock() {
  const btn = document.querySelector(`.${ctrlClass('ctrl-geolocate')}`);
  const locked = btn?.classList.contains(ctrlClass('ctrl-geolocate-active'))
    && !btn.classList.contains(ctrlClass('ctrl-geolocate-background'));
  if (!locked) return;
  // Stopped first, because that guard is "is the camera moving right now" and
  // the answer is yes for a good while after the last flight — measured at
  // still-true 600 ms after a 300 ms fitBounds. Picking a second trip while
  // the first was still settling would otherwise leave the lock on. We are
  // about to command a camera move of our own, so cancelling the one in the
  // air is what we wanted anyway.
  map.stop();
  map.fire('movestart');
}

// The box around a set of points, for framing a day. A trip carries its own,
// worked out when it was derived; a day is assembled on demand and doesn't.
function bboxOfPoints(points) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of points ?? []) {
    if (!Number.isFinite(p?.lng) || !Number.isFinite(p?.lat)) continue;
    b[0] = Math.min(b[0], p.lng);
    b[1] = Math.min(b[1], p.lat);
    b[2] = Math.max(b[2], p.lng);
    b[3] = Math.max(b[3], p.lat);
  }
  return b.every(Number.isFinite) ? b : null;
}

// The furthest north or south a Web Mercator map can show at all.
const MERC_LAT = 85.051129;

// Frame a [w, s, e, n] box with the same padding a route gets. Trips and
// searched-for lakes are both "here is an area, look at it" — the only thing
// zoomToRoute does that this doesn't is read the box off a route.
function fitBboxOnMap(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return;
  releaseCameraLock();
  // A box that crosses the antimeridian comes out of the boundary datasets with
  // its east edge *west* of its west edge — Russia's is [19.6 … 180], Fiji's and
  // Chukotka's the same shape. Read literally that is the whole globe minus the
  // country, and fitBounds obligingly frames it the long way round. Carrying the
  // east edge past 180° is the short way, which is the way anyone meant.
  const e = b[2] < b[0] ? b[2] + 360 : b[2];
  // A single-cell trip has no extent at all; give it something to fit.
  const pad = Math.max(0.02, (e - b[0]) * 0.08, (b[3] - b[1]) * 0.08);
  // 8 % of Russia is fourteen degrees of latitude, which puts the padded north
  // edge at 95° — a coordinate that does not exist, and `fitBounds` throws on
  // it rather than clamping. The whole flight was then skipped and the map sat
  // exactly where it was, which reads as a search result that does nothing.
  const lat = (v) => Math.max(-MERC_LAT, Math.min(MERC_LAT, v));
  map.fitBounds(
    [
      [b[0] - pad, lat(b[1] - pad)],
      [e + pad, lat(b[3] + pad)],
    ],
    { padding: 60, maxZoom: 13, duration: 800 },
  );
}

// --- The trip (or day) you picked ----------------------------------------------
// Showing one is the whole answer to "which of this is the trip?": the blob
// underneath is every cell you have ever lit, and twelve scattered patches of
// it do not say *Iceland, last August*.
//
// Drawn as the track it was, not as a wash over the ground it covered. Every
// cell the trip touched becomes a dot at its centre, and the dots are threaded
// in the order they were first seen — which the stored dates already know, so
// the shape of the days comes back for free. A translucent tint over the same
// hexagons said "somewhere in here"; a line through them says where you went
// and which way round.
// What the chip is naming, and the points behind it. The points are kept
// because a basemap switch rebuilds the whole style: installGrid re-creates the
// `trip` source empty, and without them there is nothing to put back — the
// highlight vanished while the chip went on claiming to be showing it.
let shownTrack = null; // { kind, id, label, points }

/** Longer a silence than this and the thread is cut rather than drawn across. */
const TRACK_LINK_GAP_SEC = 36 * 3600;

/**
 * Points in time order → dots, plus the thread between them.
 *
 * One source, two geometry types: a circle layer ignores the lines and a line
 * layer ignores the points, so this stays a single setData.
 */
function trackFC(points) {
  const features = [];
  let run = [];
  let prev = 0;
  const cut = () => {
    if (run.length > 1) {
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: run } });
    }
    run = [];
  };
  for (const p of points ?? []) {
    if (!Number.isFinite(p?.lng) || !Number.isFinite(p?.lat)) continue;
    features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } });
    // Nothing to thread them with, and the dots stand on their own. Three
    // reasons a point doesn't join the one before it:
    //
    //   no time at all      — it can't be placed in the order
    //   the *same* time     — neither can it. A whole afternoon's worth of
    //                         ground imported from one photo album carries one
    //                         timestamp on every cell of it, and joining those
    //                         in the order they happen to come out of storage
    //                         draws a zigzag and calls it a route
    //   a long gap          — a day out and the next day out are two threads,
    //                         not one line drawn across the night between them
    if (!p.at || (prev && p.at <= prev)) {
      cut();
      if (p.at) run.push([p.lng, p.lat]);
      prev = p.at || 0;
      continue;
    }
    if (prev && p.at - prev > TRACK_LINK_GAP_SEC) cut();
    run.push([p.lng, p.lat]);
    prev = p.at;
  }
  cut();
  return { type: 'FeatureCollection', features };
}

/**
 * Put a track on the map and name it in the chip.
 *
 * @param {{kind:string, id:string, label:string, points:Array}|null} what
 */
// The pin dropped by a place search. It is an answer to one question, so it
// lasts exactly as long as that question does: the next tap on the map takes it
// away, and takes nothing else with it.
let placePin = null;

function showPlacePin(lngLat) {
  placePin = lngLat ? { lng: lngLat.lng, lat: lngLat.lat } : null;
  const src = map.getSource('place');
  if (!src) return;
  src.setData(placePin
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [placePin.lng, placePin.lat] } }] }
    : EMPTY);
  if (placePin) syncHomeMarker(); // keeps home above the pin
}

const TRACK_LAYERS = ['trip-glow', 'trip-link', 'trip-dot'];

function showTrack(what) {
  shownTrack = what
    ? { kind: what.kind, id: what.id, label: what.label, points: what.points ?? [] }
    : null;
  const src = map.getSource('trip');
  if (src) src.setData(what ? trackFC(what.points) : EMPTY);
  // Raised on every showing rather than positioned once: a saved route sits
  // above it in the stack the rest of the time, and it should — a route is
  // something you switched on and left on. But while a day or a trip is being
  // shown it is the question on screen, so it goes over everything except home.
  if (what && map.getLayer('trip-dot')) {
    for (const id of TRACK_LAYERS) map.moveLayer(id);
    syncHomeMarker(); // puts home back on top of the three we just raised
  }
  updateTrackChip();
}

const showTripOnMap = (trip) =>
  showTrack(trip && { kind: 'trip', id: trip.id, label: trip.name, points: trip.spots ?? [] });

/** One calendar day, drawn the same way a trip is. Both calendars land here. */
function showDayOnMap(key, detail) {
  showTrack({ kind: 'day', id: key, label: detail.label, points: detail.points });
  fitBboxOnMap(bboxOfPoints(detail.points));
}

// The chip is the way back out that doesn't mean reopening a panel, so it lives
// on the map — the same bargain the isolated-route chip makes.
function updateTrackChip() {
  const chip = document.getElementById('trip-chip');
  if (!chip) return;
  chip.hidden = !shownTrack;
  if (!shownTrack) return;
  document.getElementById('trip-chip-text').textContent = `Showing ${shownTrack.label}`;
}

// Any edit or a new look at the map drops it — it marks one answer to one
// question, and it should not still be sitting there afterwards.
function clearTripHighlight() {
  if (shownTrack) showTrack(null);
}

// --- Home, on the map ----------------------------------------------------------
// Two jobs that share a source: marking where home is, and choosing where it
// should be. Choosing borrows the marker, so the pin you are about to confirm
// looks exactly like the thing it is about to become.

/**
 * Draw the home marker, or don't. Lives beside the home row that sets it.
 *
 * Writing the answer down is what takes this browser out of the "never asked"
 * state for good — including when the switch is set to what it was already
 * showing, which is a person agreeing with the default and is not the same thing
 * as never having looked.
 */
function setHomeShown(on) {
  homeShownChoice = on ? 'on' : 'off';
  try {
    localStorage.setItem(HOME_SHOWN_KEY, homeShownChoice);
  } catch {
    /* fine */
  }
  syncHomeMarker();
}

/** Where home actually is right now — what you set, or failing that the guess. */
function homePoint() {
  if (homePlace) return homePlace;
  const guess = findHome(cellMeta);
  return guess ? { lng: guess.lng, lat: guess.lat, name: '' } : null;
}

function syncHomeMarker() {
  const src = map.getSource('home');
  if (!src) return;
  // A pin being placed replaces the marker rather than joining it — two homes
  // on one map is a question, not an answer. Until one is placed the current
  // home stays put if it was showing, which is the useful thing to see while
  // deciding whether to move it.
  const at = homePick.at ?? (homeShown() ? homePoint() : null);
  src.setData(at
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [at.lng, at.lat] } }] }
    : EMPTY);
  // Belt and braces for the top of the stack: anything that ever gets added
  // without an anchor would otherwise land over it, and this is the one layer
  // whose whole job is to be the thing you can see.
  if (at && map.getLayer('home-icon')) map.moveLayer('home-icon');
}

// --- Asking where you live -------------------------------------------------------
//
// There used to be a banner here, shown once ever, offering to correct the guess
// the Trips tab measures everything from. It is gone: the question is now the
// second-to-last card of the introduction (see src/intro-ui.js), which is a
// better place for it in every respect. It is asked while the map already has
// somebody's attention rather than across the top of whatever they were doing;
// it can hand over the whole screen instead of competing with a menu; and it is
// asked *before* there is any history for the answer to be wrong about, rather
// than after a banner has had to wait for enough cells to justify itself.
//
// What is left here is the machinery it hands to: `beginHomePick` below, which
// both the dialog and the introduction drive, and `introHomePick` which is the
// introduction's own bare version of it.

/**
 * What this browser remembers about who has been through the introduction.
 *
 * **Keyed by account, not stored as a single flag.** This is a map several
 * people can share a browser for — the account deletion warning a few hundred
 * lines down says so out loud — and a bare flag here would mean the second
 * person to register on a laptop is silently never introduced to anything. The
 * key is a fact about a person, so the copy of it has to be too.
 *
 * It exists beside the account's own copy to survive a push that never landed:
 * without it a browser that finished the deck offline would be handed it again
 * on the next load, which is the one thing an introduction must never do. See
 * `seenVersion` in src/intro.js for how the two are merged.
 */
function introSeenLocally() {
  try {
    const held = JSON.parse(localStorage.getItem(INTRO_SEEN_KEY) ?? '{}');
    return Number(held?.[username ?? '']) || 0;
  } catch {
    return 0;
  }
}

/** Note that it has been seen, in both places at once. */
function rememberIntroSeen() {
  introSeen = INTRO_VERSION;
  try {
    const held = JSON.parse(localStorage.getItem(INTRO_SEEN_KEY) ?? '{}') ?? {};
    held[username ?? ''] = INTRO_VERSION;
    localStorage.setItem(INTRO_SEEN_KEY, JSON.stringify(held));
  } catch {
    /* private mode: the account's copy below is the one that has to hold */
  }
  touchPrefs();
  pushPrefs();
}

// Picking a home by pointing at it. "The middle of the map" was a guess about a
// guess — it asked you to aim the whole viewport at your own house and then
// took its centre — and it produced a home called "The middle of the map",
// which is not a place. Now the dialog steps out of the way, the next tap drops
// a pin you can move, and confirming names it after whatever is nearest.
//
// Two bars ask it, and which one is on screen is the whole of `bare`. The
// dialog's version shares the map with a menu, a search button and a layers
// panel, so it has to say which of them you are meant to ignore. The
// introduction's has the map to itself — its own chrome is hidden for the
// duration — so it can ask the question and nothing else. Everything below the
// bar is the same code either way: the same tap, the same pin, the same naming
// off the nearest town.
const homePick = { on: false, at: null, done: null, bare: false };

/** The three elements of whichever bar is asking. */
const pickEls = () => {
  const ns = homePick.bare ? 'intro-pick' : 'home-pick';
  return {
    bar: document.getElementById(ns),
    ok: document.getElementById(`${ns}-ok`),
    text: document.getElementById(`${ns}-text`),
  };
};

/**
 * @param {(home: object|null) => void} onDone
 * @param {{bare?: boolean}} [how] `bare` is the introduction's version: the
 *   map's own chrome goes away with the deck, so there is exactly one thing on
 *   screen to do and no menu inviting you to do something else.
 */
function beginHomePick(onDone, { bare = false } = {}) {
  homePick.on = true;
  homePick.at = null;
  homePick.done = onDone ?? null;
  homePick.bare = bare;
  const { bar, ok, text } = pickEls();
  bar.hidden = false;
  ok.hidden = true;
  text.textContent = bare ? t('intro-pick-text.tap-where-you-live') : t('home-pick-text.tap-the-map-to-put');
  if (bare) document.body.classList.add('intro-picking');
  map.getCanvas().style.cursor = 'crosshair';
  syncHomeMarker();
}

/**
 * The introduction's home step: lift the map's chrome, go to where the person
 * actually is, and ask.
 *
 * Flying there first is most of what makes this answerable. "Point at your
 * house" on a map showing the whole of Europe is a minute of pinching; on a map
 * already centred within a few hundred metres of it, it is one tap. A browser
 * that will not say where it is (refused, or plain http — `navigator.geolocation`
 * needs a secure context) simply gets the map it already had, which is a slower
 * version of the same question rather than a broken one.
 */
function introHomePick(onDone) {
  beginHomePick(async (picked) => {
    // Saved here rather than by the deck. The introduction is a screen, not a
    // second owner of the account's preferences — and this is the same three
    // lines the Settings dialog's own picker runs, for the same reason: home is
    // what every trip is measured from, so it has to reach the server before
    // anything asks for a trip list again.
    if (picked) {
      homePlace = picked;
      syncHomeMarker();
      touchPrefs();
      await pushPrefs();
    }
    onDone?.(picked);
  }, { bare: true });
  const to = (lng, lat) => map.flyTo({ center: [lng, lat], zoom: 13.5, duration: 1400 });
  if (lastFix) {
    to(lastFix[0], lastFix[1]);
    return;
  }
  navigator.geolocation?.getCurrentPosition(
    (p) => {
      lastFix = [p.coords.longitude, p.coords.latitude];
      // Checked again on the way back: the fix can arrive after the question
      // has been cancelled, and flying the map somewhere on behalf of a dialog
      // that has closed is the map moving on its own.
      if (homePick.on) to(p.coords.longitude, p.coords.latitude);
    },
    () => {
      /* no position: the map stays where it is, which is still an answerable map */
    },
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
  );
}

async function endHomePick(confirmed) {
  const at = homePick.at;
  const done = homePick.done;
  const { bar } = pickEls();
  homePick.on = false;
  homePick.at = null;
  homePick.done = null;
  homePick.bare = false;
  bar.hidden = true;
  document.body.classList.remove('intro-picking');
  map.getCanvas().style.cursor = '';
  syncHomeMarker();
  if (!confirmed || !at) {
    done?.(null);
    return;
  }
  // Named after what is nearest, because a home called by its own town is the
  // thing the Trips tab shows back to you. The place dataset is a lazy chunk
  // and may not be in yet; a home without a name still works.
  let name = '';
  try {
    await loadPlaces();
    name = nearestTown(at.lng, at.lat)?.name ?? '';
  } catch {
    /* a nameless home is still a home */
  }
  done?.({ lng: at.lng, lat: at.lat, name });
}

function placeHomePin(lngLat) {
  homePick.at = { lng: lngLat.lng, lat: lngLat.lat };
  const { ok, text } = pickEls();
  ok.hidden = false;
  text.textContent = homePick.bare
    ? t('intro-pick-text.this-spot-tap-again')
    : t('home-pick-text.home-here-tap-again');
  syncHomeMarker();
}

function zoomToRoute(route) {
  const b = route.bounds ?? [];
  if (b.length !== 4 || !b.every(Number.isFinite)) return;
  releaseCameraLock();
  map.fitBounds(
    [
      [b[0], b[1]],
      [b[2], b[3]],
    ],
    { padding: 70, maxZoom: 15.5, duration: 700 },
  );
}

// Returns whether it actually went: the routes dialog closes the route it was
// showing on the strength of this, and closing it after a failed delete would
// be telling the user something that isn't so.
async function removeRoute(route) {
  let removed = null;
  try {
    // The answer carries the whole row away with it, geometry included. That
    // copy is the only one there is — the map may never have loaded this line
    // — and it's what Undo puts back.
    ({ route: removed } = await auth.deleteRoute(route.id));
  } catch (e) {
    console.warn('Removing the route failed:', e);
    return false;
  }
  dropRouteLocally(route.id);
  if (removed) {
    // Restoring gives it a new row id, so redo can't close over the old one.
    const at = { id: route.id };
    history.push(
      `deleting ${route.name ? `“${route.name}”` : 'a route'}`,
      async () => {
        const before = new Set(routeList.map((r) => r.id));
        await auth.saveRoutes([removed]);
        await loadRoutes(routesOn);
        const again = routeList.find((r) => !before.has(r.id));
        if (again) at.id = again.id;
        updateRoutesUi();
      },
      async () => {
        await auth.deleteRoute(at.id);
        dropRouteLocally(at.id);
      },
    );
  }
  return true;
}

// Forget a route here, without telling the server — the caller has already
// done that, or is about to.
function dropRouteLocally(id) {
  if (selectedRoute === id) setSelectedRoute(null);
  if (soloRoute === id) soloRoute = null; // nothing left to isolate
  routeList = routeList.filter((r) => r.id !== id);
  refoldRoutes();
  updateSoloChip();
  syncRoutes();
}

function updateRoutesUi() {
  const box = document.getElementById('routes-toggle');
  const note = document.getElementById('routes-note');
  if (!box || !note) return;
  box.checked = routesOn;
  // Nothing to show is not a failure — it's an invitation.
  box.disabled = !routeList.length;
  const shown = visibleRoutes();
  // Counted against the folded list, not the raw one: a route imported twice is
  // one route, and saying "81" beside 70 lines is the bug this fold exists to
  // stop. The same goes for the distance — the second copy was adding its
  // kilometres to the total as if you had ridden them again.
  const listed = listedRoutes();
  note.textContent = listed.length
    ? (shown.length === listed.length
        ? `${listed.length === 1 ? '1 route' : `${listed.length} routes`} · ${formatDistance(totalLength(listed))}`
        : `${shown.length} of ${listed.length} shown · ${formatDistance(totalLength(shown))}`)
    : 'Import a GPX or KML track to save one';
  renderRouteOptions();
}

// Static markup, no interpolation — an eye, or an eye with a line through it.
const EYE_ON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_OFF_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.4 0 10 6.5 10 6.5a17 17 0 0 1-3.3 4"/><path d="M6.5 7.9A16.6 16.6 0 0 0 2 12s3.6 6.5 10 6.5a9.9 9.9 0 0 0 4-.8"/></svg>';

// A touch device is where the menu is a full-width sheet on top of the map.
const coarsePointer = window.matchMedia('(pointer: coarse)');
// Set when a tap's only job was to dismiss the menu, so the map can let the same
// tap go by. Decided on `pointerdown` and re-decided on every one after it —
// see wireLayersControl for why it cannot be decided when the click resolves.
let dismissedMenuOnTap = false;

// --- The per-activity panel --------------------------------------------------
// Behind a chevron, because it is one row per activity and there can be a dozen
// of them; always-open it would push everything below it off the menu.
let routeOptionsOpen = false;
// One picker (and one panel) per activity row. Both are torn down before a
// re-render — see destroy() in src/color-picker.js.
let routePickers = [];
// Which activities the rows currently show, so a state change can be told from
// a list change.
let renderedSports = '';

// Eye state and dimming, without touching the rest of the row.
function refreshRouteOptionStates() {
  const box = document.getElementById('routes-options');
  if (!box) return;
  for (const row of box.querySelectorAll('.route-option')) {
    const shown = !hiddenSports.has(row.dataset.sport);
    const eye = row.querySelector('.route-option-eye');
    eye.classList.toggle('off', !shown);
    eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
    eye.title = shown ? 'Hide these on the map' : 'Show these on the map';
    eye.innerHTML = shown ? EYE_ON_SVG : EYE_OFF_SVG;
  }
  const reset = box.querySelector('.route-option-reset');
  if (reset) reset.hidden = !sportColors.size && !hiddenSports.size;
}

function dropRoutePickers() {
  for (const { picker, panel } of routePickers) {
    picker.destroy();
    panel.remove();
  }
  routePickers = [];
}

function renderRouteOptions() {
  const toggle = document.getElementById('routes-options-toggle');
  const box = document.getElementById('routes-options');
  if (!toggle || !box) return;

  const sports = sportsPresent();
  // Nothing to sort by until there are at least two kinds of thing — and
  // nothing to sort at all while the routes are switched off. Every control
  // inside this fold changes how the tracks are drawn, so with them hidden it
  // is a chevron over an empty question.
  const worthShowing = routesOn && routeList.length > 0 && sports.length > 1;
  toggle.hidden = !worthShowing;
  if (!worthShowing) {
    dropRoutePickers();
    renderedSports = '';
    box.replaceChildren();
    box.hidden = true;
    routeOptionsOpen = false;
    toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  toggle.setAttribute('aria-expanded', routeOptionsOpen ? 'true' : 'false');
  toggle.classList.toggle('open', routeOptionsOpen);
  box.hidden = !routeOptionsOpen;
  if (!routeOptionsOpen) {
    dropRoutePickers();
    renderedSports = '';
    box.replaceChildren();
    return;
  }

  // Toggling an activity changes one row's state, not which rows exist — and
  // rebuilding the list would throw away the colour pickers (and the element
  // under the cursor) for nothing. Only rebuild when the set of activities
  // actually differs.
  const signature = sports.map((x) => `${x.key}:${x.n}`).join('|');
  if (signature === renderedSports && box.childElementCount) {
    refreshRouteOptionStates();
    return;
  }
  renderedSports = signature;
  dropRoutePickers();
  box.replaceChildren();
  for (const { key, n } of sports) {
    const row = document.createElement('div');
    row.className = 'route-option';
    row.dataset.sport = key;

    const shown = !hiddenSports.has(key);
    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = `route-option-eye${shown ? '' : ' off'}`;
    eye.setAttribute('aria-pressed', shown ? 'true' : 'false');
    eye.title = shown ? 'Hide these on the map' : 'Show these on the map';
    eye.innerHTML = shown ? EYE_ON_SVG : EYE_OFF_SVG;
    eye.addEventListener('click', () => {
      if (hiddenSports.has(key)) hiddenSports.delete(key);
      else hiddenSports.add(key);
      saveRouteView();
      syncRoutes();
    });

    const name = document.createElement('span');
    name.className = 'route-option-name';
    name.textContent = sportLabel(key);
    const count = document.createElement('i');
    count.textContent = String(n);

    // The app's own picker, not the browser's — same panel, same presets and
    // same live-repaint-while-dragging as the visited colour above it.
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch route-option-color';
    swatch.style.setProperty('--swatch', sportColor(key));
    swatch.setAttribute('aria-label', `Color for ${sportLabel(key)}`);
    swatch.title = `Color for ${sportLabel(key)}`;

    const panel = document.createElement('div');
    panel.className = 'menu-popover color-panel';
    panel.hidden = true;
    document.body.append(panel);

    const picker = mountColorPicker({
      button: swatch,
      panel,
      value: sportColor(key),
      place: () => placeBesideMenu(swatch, panel),
      onInput: (hex) => {
        swatch.style.setProperty('--swatch', hex);
        sportColors.set(key, hex);
        saveRouteView();
        repaintRouteColors();
      },
    });
    routePickers.push({ picker, panel });

    row.append(eye, name, count, swatch);
    box.append(row);
  }

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'route-option-reset';
  reset.textContent = 'Reset colors and show all';
  reset.hidden = !sportColors.size && !hiddenSports.size;
  reset.addEventListener('click', () => {
    sportColors.clear();
    hiddenSports.clear();
    saveRouteView();
    for (const row of box.querySelectorAll('.route-option')) {
      row.querySelector('.route-option-color')?.style.setProperty('--swatch', ROUTE_COLOR);
    }
    repaintRouteColors();
    syncRoutes();
  });
  box.append(reset);
}

// Beside the menu where there's room, above it when there isn't (phones, where
// the menu is a full-width sheet) — the same rule the ⓘ note uses. Shared by the
// visited-colour picker and every per-activity one.
function placeBesideMenu(button, panel) {
  const menuBox = document.getElementById('layers-menu').getBoundingClientRect();
  const btnBox = button.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();
  const left = menuBox.right + 10;
  if (left + panelBox.width <= window.innerWidth - 10) {
    // Never off the top or bottom: a row near the end of a long menu would
    // otherwise open its panel past the edge of the window.
    const top = Math.max(10, Math.min(btnBox.top - 12, window.innerHeight - panelBox.height - 10));
    return { left, top };
  }
  return {
    left: menuBox.left + (menuBox.width - panelBox.width) / 2,
    top: menuBox.top - panelBox.height - 10,
  };
}

function repaintRouteColors() {
  if (!map?.getLayer('route-line')) return;
  map.setPaintProperty('route-line', 'line-color', routeLineColor());
  map.setPaintProperty('route-line', 'line-opacity', routeLineOpacity());
  map.setPaintProperty('route-glow', 'line-color', routeGlowColor());
  map.setPaintProperty('route-glow', 'line-opacity', routeGlowOpacity());
  // Its opacity never moves — only its colour, which follows the activity.
  if (map.getLayer(ROUTE_GHOST_ID)) {
    map.setPaintProperty(ROUTE_GHOST_ID, 'line-color', routeLineColor());
  }
}

// --- Ctrl-paint: hold Ctrl and sweep the cursor to mark cells ----------------
// Purely additive (never erases), so sweeping back over a cell is a no-op —
// use single-click to clear. Panning is suspended while Ctrl is held so a
// drag paints instead of moving the map. Cells are added immediately but the
// (heavier) relight + re-render is batched to one per frame.
let ctrlPaint = false;
let paintDirty = false;

// Sweeping with Ctrl held paints a cell per frame, and re-deriving all five
// levels from all ~20k stored cells each time was more work than a frame has.
// Fold the new cells in instead, and only fall back to the full pass when the
// shortcut can't be exact (see rollUpPainted).
function flushPaint() {
  paintDirty = false;
  const ids = paintQueue.splice(0);
  // Type mode re-ranks the sources and reassigns palette slots on every add, so
  // it always takes the full pass.
  let incremental = !HEAT_MODES[heatMode]?.categorical;
  if (incremental) {
    for (const id of ids) {
      if (!rollUpPainted(id)) {
        incremental = false;
        break;
      }
    }
  }
  if (!incremental) recomputeLit(); // discards the partial roll-up and redoes it
  updateGrid(true);
  updateTiles();
}

// Every cell a single Ctrl-sweep lit. One drag is one thing you did, so it's
// one entry in the history — undoing a sweep across half a canton should not
// mean four hundred presses of Ctrl-Z.
let sweptCells = [];

function paintAt(lngLat) {
  if (currentLevel == null) return;
  const id = cellIdAt(lngLat);
  if (visited.has(id)) return; // already lit — nothing to do
  markCell(id);
  sweptCells.push(id);
  paintQueue.push(id);
  if (!paintDirty) {
    paintDirty = true;
    requestAnimationFrame(flushPaint);
  }
}

function startPaint() {
  if (ctrlPaint || mode !== 'edit') return;
  ctrlPaint = true;
  sweptCells = [];
  setHover(null);
  // Disabling dragPan drops the handler but not MapLibre's inertia buffer: a
  // pan that was already under way still gets its fling, so the map carries on
  // coasting underneath the sweep and paints a smear of cells the cursor never
  // passed over. Only reachable when the button went down before the modifier.
  const wasMoving = map.isMoving() || map.isEasing();
  map.dragPan.disable();
  if (wasMoving) {
    map.stop();
    // map.stop() suppresses the moveend it would otherwise have fired, so the
    // work that handler does has to happen here instead or the grid and the
    // tiles are left showing the camera we just cancelled.
    updateGrid();
    updateTiles();
  }
  if (lastLngLat) paintAt(lastLngLat); // catch the cell already under the cursor
}

function stopPaint() {
  if (!ctrlPaint) return;
  ctrlPaint = false;
  map.dragPan.enable();
  // The gesture is over, so now it's one edit with a size. A sweep that lit
  // nothing new (dragging back over cells already on the map) isn't an edit at
  // all and doesn't go on the stack.
  if (sweptCells.length) {
    const ids = sweptCells;
    const snapshot = snapshotCells(ids);
    sweptCells = [];
    history.push(
      `painting ${plural(ids.length, 'cell')}`,
      () => clearCells(ids),
      () => remarkCells(snapshot),
    );
  }
}

let lastLngLat = null;

// --- Level / coverage logic ----------------------------------------------------
// Level L owns every zoom below LEVEL0_ZOOM - L·LEVEL_STEP, so that expression
// is the boundary between L and L+1.
// Where the continent level takes over, and the one place the 3× ladder is
// overridden. The ladder would put this at levelBoundary(5) = 2.075, which is
// below MapLibre's z2 tile boundary — and a basemap serves *generalised*
// geometry at z1, far coarser than our own 1 km outlines. Our sharp fill over
// the basemap's blunt one shows as dark jagged rims all along every coast, and
// it is worst in the Arctic, where Mercator stretches the mismatch 4.8×. It
// cures itself the instant the zoom crosses 2.0 and the basemap sharpens,
// which is exactly how it was caught: two state dumps identical in every field
// but the zoom, one either side of the line.
//
// So the level takes its room out of the country level's band instead of out
// of the bottom of the map. Continents get (2, 2.75] and countries (2.75,
// 3.66] — both narrower than a full step, both entirely above z2 tiles, and
// both still wide enough for LEVEL_HYSTERESIS to sit inside.
const CONTINENT_ZOOM = 2.75;
// The lower end of a level's band; a level owns (levelBoundary(L),
// levelBoundary(L - 1)].
const levelBoundary = (L) => (L === COUNTRY_LEVEL ? CONTINENT_ZOOM : LEVEL0_ZOOM - L * LEVEL_STEP);

// Once a level is on screen it keeps the map until the zoom is this far past
// the boundary. Without the margin, the wobble at the end of a scroll- or
// pinch-zoom (it overshoots and settles back) crosses the threshold two or
// three times, and every crossing repaints and crossfades the regions — which
// is the flicker you get on the way in or out of a level.
const LEVEL_HYSTERESIS = 0.28;

// --- Pinned detail -------------------------------------------------------------
// By default the level follows the zoom (levelForZoom, below). The Detail
// control in the menu pins it instead: the map then keeps drawing that cell
// size however far you zoom. `null` = auto, which is the default.
//
// Only the two ends are offered. The in-between levels were five buttons that
// all did the same kind of thing, and the honest answer to "which one" was
// "let the zoom decide" — so the choice is now Tiniest (the grid as stored),
// Auto, or Country. Pinning the finest one at world zoom costs no more than it
// does zoomed in: regions are built by iterating the marked cells, not the
// viewport, so the only thing it asks for is what you have already marked.
const DETAIL_KEY = 'visited-map:detail:v1';
// Region joins the two ends now that it is a real thing to look at rather than
// one of the in-between hex sizes: "which cantons have I been to" is a question
// with an answer, where "which 73 km squares" was not.
const DETAIL_CHOICES = [0, null, REGION_LEVEL, COUNTRY_LEVEL];

function savedDetail() {
  const raw = localStorage.getItem(DETAIL_KEY);
  if (!raw || raw === 'auto') return null;
  const L = raw === 'country' ? COUNTRY_LEVEL : Number(raw);
  // A level pinned before the middle of the range was retired has no button to
  // un-pin it any more, so it would sit there unreachable. Auto is what those
  // levels were approximating anyway.
  return DETAIL_CHOICES.includes(L) ? L : null;
}

let detailLevel = savedDetail();
// Set when the pin is released. The level being left behind is one the zoom
// never chose, so the hysteresis below has nothing real to hold on to — asking
// it to decide would keep the pinned size until the map was nudged. One
// pass without it lands straight on the zoom's own level.
let skipHysteresis = false;

// The menu speaks in tokens ('auto', '1'…'4', 'country'); everything else in
// levels, with null for auto.
const detailToken = (L) =>
  L == null ? 'auto' : L === COUNTRY_LEVEL ? 'country' : L === REGION_LEVEL ? 'region' : String(L);
const detailFromToken = (t) =>
  t === 'auto' ? null : t === 'country' ? COUNTRY_LEVEL : t === 'region' ? REGION_LEVEL : Number(t);

function setDetailLevel(next) {
  if (next === detailLevel) return;
  skipHysteresis = next == null;
  detailLevel = next;
  try {
    localStorage.setItem(DETAIL_KEY, detailToken(next));
  } catch {
    /* fine */
  }
  updateLayersUi();
  // A pinned level ignores the zoom, so nothing else would ever ask for the
  // rebuild — force it.
  updateGrid(true);
}

function levelForZoom(zoom, current = null) {
  // The continent boundary is off the ladder (see CONTINENT_ZOOM), so it is
  // tested before the ladder is inverted rather than clamped afterwards.
  const raw =
    zoom <= CONTINENT_ZOOM
      ? CONTINENT_LEVEL
      : Math.min(COUNTRY_LEVEL, Math.max(0, Math.ceil((LEVEL0_ZOOM - zoom) / LEVEL_STEP - 1e-9)));
  // A jump of more than one level means a deliberate leap, not wobble.
  if (current === null || Math.abs(raw - current) !== 1) return raw;
  // Coarsening (zooming out) crosses the current level's own boundary;
  // refining (zooming in) crosses the one below it.
  const boundary = levelBoundary(raw > current ? current : current - 1);
  const held = raw > current ? zoom > boundary - LEVEL_HYSTERESIS : zoom < boundary + LEVEL_HYSTERESIS;
  return held ? current : raw;
}

// What the renderers are built for: a rectangle of Mercator metres, padded so
// a small pan has something already drawn to move into.
//
// The arithmetic is in src/view.js because a turned or leaning camera does not
// see a north-up rectangle and `map.getBounds()` cannot say so. On a map nobody
// has touched the compass on, this returns exactly what the four-line version
// it replaced returned.
const paddedMerc = () => groundBox(cameraOf(map), VIEW_PAD);

/** The same, unpadded: what is actually on screen. */
const viewMerc = () => groundBox(cameraOf(map));

// --- Geometry builders -------------------------------------------------------
// Unvisited tiles: plain inset hexagons (sharp corners) — precomputed once
// per level as offsets from the cell center.
function tileOffsets(R) {
  const hh = (SQRT3 / 2) * R;
  const pts = [
    [R, 0], [R / 2, hh], [-R / 2, hh], [-R, 0], [-R / 2, -hh], [R / 2, -hh],
  ].map(([x, y]) => [x * TILE_INSET, y * TILE_INSET]);
  pts.push([...pts[0]]);
  return pts;
}

// Exact (full-size) hex corner offsets — used for the region boundary edges
// so adjacent visited cells merge seamlessly.
function fullHexOffsets(R) {
  const hh = (SQRT3 / 2) * R;
  return [
    [R, 0], [R / 2, hh], [-R / 2, hh], [-R, 0], [-R / 2, -hh], [R / 2, -hh],
  ];
}

// The six neighbors of (col,row) with the CCW-directed edge shared with each:
// dc = column delta, dr(parity) = row delta, a/b index fullHexOffsets.
const EDGES = [
  { dc: 0, dr: () => 1, a: 1, b: 2 }, // top
  { dc: 1, dr: (p) => p, a: 0, b: 1 }, // NE
  { dc: 1, dr: (p) => p - 1, a: 5, b: 0 }, // SE
  { dc: 0, dr: () => -1, a: 4, b: 5 }, // bottom
  { dc: -1, dr: (p) => p - 1, a: 3, b: 4 }, // SW
  { dc: -1, dr: (p) => p, a: 2, b: 3 }, // NW
];

// Chain directed boundary segments into closed loops. Lit cells emit their
// edges CCW, so outer boundaries come out CCW and holes CW.
function chainSegments(segs) {
  const key = (x, y) => `${Math.round(x)}|${Math.round(y)}`;
  const byStart = new Map();
  segs.forEach((s, i) => {
    const k = key(s[0][0], s[0][1]);
    const arr = byStart.get(k);
    if (arr) arr.push(i);
    else byStart.set(k, [i]);
  });
  const used = new Array(segs.length).fill(false);
  const chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const pts = [segs[i][0], segs[i][1]];
    for (;;) {
      const last = pts[pts.length - 1];
      const candidates = byStart.get(key(last[0], last[1]));
      let next = -1;
      if (candidates) {
        for (const j of candidates) {
          if (!used[j]) {
            next = j;
            break;
          }
        }
      }
      if (next === -1) break;
      used[next] = true;
      pts.push(segs[next][1]);
    }
    chains.push(pts);
  }
  return chains;
}

// Relax a closed loop into a blob. One Chaikin round replaces every corner
// with two points cut in from it; repeating converges on a smooth curve that
// bulges through the middle of each edge and never overshoots the hull, so
// neighbouring regions still flow together exactly where their cells touch.
function smoothLoop(loop, rounds = SMOOTH_ROUNDS) {
  let pts = loop.slice(0, -1); // drop the closing point; the ring is implicit
  if (pts.length < 3) return loop;
  for (let r = 0; r < rounds; r++) {
    const out = new Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      out[i * 2] = [ax + (bx - ax) * SMOOTH_CUT, ay + (by - ay) * SMOOTH_CUT];
      out[i * 2 + 1] = [ax + (bx - ax) * (1 - SMOOTH_CUT), ay + (by - ay) * (1 - SMOOTH_CUT)];
    }
    pts = out;
  }
  pts.push([...pts[0]]);
  return pts;
}

const ringArea = (ring) => {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  }
  return a / 2; // >0 = CCW in mercator (y up)
};

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Turn the emitted boundary edges into rounded fill polygons (with holes)
// plus one outline feature. buildGrid counts everything outside the built
// window as unlit, so every loop is closed by construction — regions that
// extend past coverage close along the padded, off-screen rim.
function regionFeatures(boundary) {
  const closed = (pts) =>
    pts.length > 3 &&
    Math.round(pts[0][0]) === Math.round(pts[pts.length - 1][0]) &&
    Math.round(pts[0][1]) === Math.round(pts[pts.length - 1][1]);
  const loops = chainSegments(boundary).filter(closed).map((l) => smoothLoop(l));
  // Each loop's signed area decides which way round it runs, and the smallest
  // enclosing outer is what a hole belongs to — the same number, asked twice.
  // Kept from the first pass rather than recomputed inside the second, where it
  // was being taken again for every outer ring against every hole: a walk of the
  // whole ring, which after smoothing is four times the points it started with.
  const outers = [];
  const outerAreas = [];
  const holes = [];
  for (const lp of loops) {
    const a = ringArea(lp);
    if (a > 0) {
      outers.push(lp);
      outerAreas.push(a);
    } else {
      holes.push(lp);
    }
  }

  const polys = outers.map((o) => [o]);
  for (const h of holes) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      // Cheap compare first: it short-circuits most of the point-in-ring tests.
      if (outerAreas[i] < bestArea && pointInRing(h[0], outers[i])) {
        best = i;
        bestArea = outerAreas[i];
      }
    }
    if (best >= 0) polys[best].push(h);
  }

  const features = polys.map((rings) => ({
    type: 'Feature',
    properties: { k: 1 },
    geometry: { type: 'Polygon', coordinates: rings.map((r) => r.map(project)) },
  }));
  if (loops.length) {
    features.push({
      type: 'Feature',
      properties: { k: 2 },
      geometry: {
        type: 'MultiLineString',
        coordinates: loops.map((r) => r.map(project)),
      },
    });
  }
  return features;
}

// Region geometry for the padded viewport. Iterates only the LIT cells (not
// the whole window), so cost stays proportional to the number of marked
// cells no matter how far out the map is zoomed.
function buildGrid(bb, L) {
  if (isVectorLevel(L)) return ensureAreaFC(vectorKindOf(L));
  const R = radiusOf(L);
  const colSp = 1.5 * R;
  const rowSp = SQRT3 * R;
  const N = colsOf(L);
  const lit = litSets[L];
  const hexOffs = fullHexOffsets(R);
  // The closed ring, built once: the heat branch below draws one polygon per lit
  // cell and every one of them wants the same six corners with the first repeated.
  const hexRing = [...hexOffs, hexOffs[0]];

  let colMin = Math.floor((bb.xMin - R) / colSp);
  let colMax = Math.ceil((bb.xMax + R) / colSp);
  let wholeWorld = false;
  if (colMax - colMin + 1 > N) {
    colMin = 0;
    colMax = N - 1;
    wholeWorld = true;
  }
  const rowMin = Math.floor(bb.yMin / rowSp) - 2;
  const rowMax = Math.ceil(bb.yMax / rowSp) + 2;

  // Lit cells outside the built window count as unlit, so region outlines
  // close along the (padded, off-screen) coverage rim instead of fragmenting
  // when a region extends past coverage.
  const litInWindow = (col, row) =>
    row >= rowMin &&
    row <= rowMax &&
    (wholeWorld || (col >= colMin && col <= colMax)) &&
    lit.has(`${normCol(col, N)}/${row}`);

  // Heat maps need one shape per cell to carry its own value, so the blob
  // merge is off in those modes and cells tile as flat hexagons instead —
  // which is what makes the mosaic readable as data rather than a shape.
  const heat = heatMetricNow();
  const features = [];
  const boundary = [];

  for (const [key, stat] of lit) {
    const sep = key.indexOf('/');
    const nc = +key.slice(0, sep);
    const row = +key.slice(sep + 1);
    if (row < rowMin || row > rowMax) continue;
    // Every world-copy instance of this canonical column inside the window.
    // N is even, so parity (and the odd-column offset) survives the wrap.
    const kMin = Math.ceil((colMin - nc) / N);
    const kMax = Math.floor((colMax - nc) / N);
    for (let k = kMin; k <= kMax; k++) {
      const col = nc + k * N;
      const p = col & 1;
      const cx = col * colSp;
      const cy = (row + (p ? 0.5 : 0)) * rowSp;
      if (heat) {
        features.push({
          type: 'Feature',
          properties: { k: 1, v: heat(stat, litRange[L]) },
          geometry: {
            type: 'Polygon',
            coordinates: [hexRing.map(([dx, dy]) => project([cx + dx, cy + dy]))],
          },
        });
        continue;
      }
      // Emit boundary edges facing unlit neighbors; shared edges between
      // two lit cells cancel, merging them into one region.
      for (const e of EDGES) {
        if (!litInWindow(col + e.dc, row + e.dr(p))) {
          const [ax, ay] = hexOffs[e.a];
          const [bx, by] = hexOffs[e.b];
          boundary.push([[cx + ax, cy + ay], [cx + bx, cy + by]]);
        }
      }
    }
  }
  if (heat) return { type: 'FeatureCollection', features };
  return { type: 'FeatureCollection', features: regionFeatures(boundary) };
}

// --- Edit-mode tile spotlight ------------------------------------------------
let cursorPx = null; // last pointer position in screen px

function buildTiles() {
  if (currentLevel == null || !cursorPx) return EMPTY;
  const L = currentLevel;
  const R = radiusOf(L);
  const colSp = 1.5 * R;
  const rowSp = SQRT3 * R;
  const N = colsOf(L);
  const lit = litSets[L];
  const offs = tileOffsets(R);

  const c = map.unproject(cursorPx);
  const cxm = mercX(c.lng);
  const cym = mercY(c.lat);
  // Spotlight radius: SPOT_PX on screen, capped so tiny cells can't flood it.
  //
  // Straight from the zoom rather than by unprojecting a point SPOT_PX to the
  // right of the cursor and measuring how far east it landed. That measurement
  // is the same number only while north is up: turn the map a quarter turn and
  // a step to the right of the cursor is a step *north*, its easting is zero,
  // and the spotlight closes to nothing with the grid still switched on. A CSS
  // pixel is a fixed number of Mercator metres at a given zoom whatever the
  // compass says, so the conversion never needed the map at all.
  const hexArea = ((3 * SQRT3) / 2) * R * R;
  const radius = Math.min(
    SPOT_PX * mercPerPixel(map.getZoom()),
    Math.sqrt((SPOT_MAX_CELLS * hexArea) / Math.PI),
  );

  const features = [];
  const colMin = Math.floor((cxm - radius - R) / colSp);
  const colMax = Math.ceil((cxm + radius + R) / colSp);
  for (let col = colMin; col <= colMax; col++) {
    const cx = col * colSp;
    const p = col & 1;
    const off = p ? 0.5 : 0;
    const nc = normCol(col, N);
    const rowLo = Math.floor((cym - radius) / rowSp - off) - 1;
    const rowHi = Math.ceil((cym + radius) / rowSp - off) + 1;
    for (let row = rowLo; row <= rowHi; row++) {
      const cy = (row + off) * rowSp;
      const dist = Math.hypot(cx - cxm, cy - cym);
      if (dist > radius) continue;
      if (lit.has(`${nc}/${row}`)) continue;
      const t = dist / radius;
      let fade = 1;
      if (t > SPOT_FADE_START) {
        const u = (t - SPOT_FADE_START) / (1 - SPOT_FADE_START);
        fade = 1 - u * u * (3 - 2 * u); // smoothstep falloff
      }
      if (fade < 0.03) continue;
      features.push({
        type: 'Feature',
        properties: { id: `${L}/${nc}/${row}`, k: 0, f: Math.round(fade * 100) / 100 },
        geometry: {
          type: 'Polygon',
          coordinates: [offs.map(([dx, dy]) => project([cx + dx, cy + dy]))],
        },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function updateTiles() {
  // Keep the last tile set while fading out of edit mode; it's cleared when
  // the mode tween lands.
  if (mode !== 'edit' && tileVis === 0) return;
  map.getSource('tiles')?.setData(mode === 'edit' ? buildTiles() : EMPTY);
}

// --- Crossfade -------------------------------------------------------------
const fade = { cur: 1, prev: 0, raf: null, timeout: null };

// Outgoing opacity for a true cross-dissolve. Ramping both layers linearly
// looks wrong: the incoming one is composited *over* the outgoing one, so the
// visible density is `cur + prev·(1 − cur)`, which sags in the middle of the
// transition — at heat-map opacity that dip is the "flash" you see when the
// level changes. Deriving prev from cur holds the composite at exactly the
// mode's alpha the whole way across.
function crossPrev(f) {
  const A = regionOpacity();
  return Math.max(0, Math.min(1, (1 - f) / (1 - A * f)));
}

// Hex → hex level change: dissolve the two levels together inside the blob
// canvas. The layer's opacity is untouched, so the visible density is constant
// by construction and there is only ever one texture to keep in sync.
const blobFade = { raf: null, timeout: null };

// Land any canvas dissolve still in flight on its end state. A fast zoom can
// reach the country boundary while a hex → hex dissolve is only halfway: left
// running, the blob would keep morphing between two old levels *while* the
// layer fades out, which reads as a second change inside the same gesture.
function stopBlobFade() {
  if (blobFade.raf) cancelAnimationFrame(blobFade.raf);
  if (blobFade.timeout) clearTimeout(blobFade.timeout);
  blobFade.raf = null;
  blobFade.timeout = null;
  if (blobCur.inTransition()) blobCur.setFade(1);
}

function dissolveBlob(duration = 320) {
  stopVectorFade();
  if (blobFade.raf) cancelAnimationFrame(blobFade.raf);
  if (blobFade.timeout) clearTimeout(blobFade.timeout);
  const t0 = performance.now();
  const finish = () => {
    blobFade.raf = null;
    blobCur.setFade(1);
    // The sheet this dissolve landed on was painted mid-gesture and is probably
    // the reduced one. Nothing else will ask again — moveend has usually already
    // been and gone by now — so ask here, and let updateGrid decide whether
    // anything is actually owed.
    updateGrid();
  };
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / duration));
    blobCur.setFade(1 - Math.pow(1 - t, 3)); // easeOutCubic
    if (t < 1) blobFade.raf = requestAnimationFrame(tick);
    else finish();
  };
  blobFade.raf = requestAnimationFrame(tick);
  // rAF is throttled in a hidden tab; make sure the dissolve always lands.
  blobFade.timeout = setTimeout(() => {
    if (blobFade.raf) {
      cancelAnimationFrame(blobFade.raf);
      finish();
    }
  }, duration + 120);
}

// Drop any layer crossfade still in flight and settle the layers where a
// steady state expects them.
function stopVectorFade() {
  if (fade.raf) cancelAnimationFrame(fade.raf);
  if (fade.timeout) clearTimeout(fade.timeout);
  fade.raf = null;
  fade.timeout = null;
  fade.cur = 1;
  fade.prev = 0;
  // Abandoning a crossfade leaves the outgoing side at a partial opacity that
  // neither ramp would touch again. Settle every source that was on its way
  // out: the live one keeps its geometry and goes back to being warm (the next
  // level may cross straight back), the other is emptied, or an aborted fade
  // leaves real geometry tiled on a source nothing will ever clear.
  settleOutgoing();
  pinVectors(1);
  applyPrevFade(0);
}

// Put every 'out' source somewhere a steady state can live with. Both ways out
// of a crossing end here, and both want the same thing — keep the geometry
// tiled and pinned invisible rather than dropping it:
//
//   - Vector → blob, where the source is the live one: it has finished fading
//     out where it stood, and the map is now one level from crossing straight
//     back. Re-parsing it at that moment is exactly the stall this avoids.
//   - Vector → vector, where it is the other one: it has handed over, and what
//     it is holding is precisely the level one step back the way we came.
//     Emptying it now and warming the same geometry a moment later is two
//     re-tiles for no gain.
//
// warmVector() is what releases either of them, once the zoom is clear of the
// boundary it was warmed for.
function settleOutgoing() {
  for (const sfx of ['', '-prev']) {
    if (vecRole[sfx] === 'out') vecRole[sfx] = 'warm';
  }
}

function animateFade(curFrom, curTo, prevFrom, prevTo, duration = 480, cross = false) {
  if (fade.raf) cancelAnimationFrame(fade.raf);
  if (fade.timeout) clearTimeout(fade.timeout);
  const t0 = performance.now();
  const finish = () => {
    fade.raf = null;
    fade.cur = curTo;
    fade.prev = prevTo;
    applyFade(curTo);
    applyPrevFade(prevTo);
    if (prevTo === 0) {
      // A blob that was fading out has handed over to the vector level.
      if (blobRole === 'out') blobCur.clear();
      blobRole = isVectorLevel(currentLevel) ? 'off' : 'none';
      // warmVector() lets a warmed source go once the zoom is clear of the
      // boundary it was warmed for.
      settleOutgoing();
      pinVectors(curTo); // re-pins whatever just became 'warm' or 'idle'
    }
  };
  const tick = (now) => {
    // rAF timestamps can precede the performance.now() taken at schedule
    // time — clamp from below or the eased value goes negative.
    const t = Math.min(1, Math.max(0, (now - t0) / duration));
    const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
    fade.cur = curFrom + (curTo - curFrom) * e;
    fade.prev = cross ? crossPrev(fade.cur) : prevFrom + (prevTo - prevFrom) * e;
    applyFade(fade.cur);
    applyPrevFade(fade.prev);
    if (t < 1) fade.raf = requestAnimationFrame(tick);
    else finish();
  };
  fade.raf = requestAnimationFrame(tick);
  // rAF can be throttled in hidden/embedded tabs; make sure the fade lands.
  fade.timeout = setTimeout(() => {
    if (fade.raf) {
      cancelAnimationFrame(fade.raf);
      finish();
    }
  }, duration + 120);
}

// --- Grid updates ----------------------------------------------------------
let currentLevel = null;
let currentAsBlob = false; // whether the live level is on the canvas or vector
let paintedZoom = 0; // zoom the blob canvas was last rasterized at
// Whether that rasterization was the reduced one a moving camera gets, and so
// still owes a full-resolution repaint once everything is still.
let blobCoarse = false;
let coverage = null;

const WORLD_COVERAGE = { xMin: -Infinity, xMax: Infinity, yMin: -Infinity, yMax: Infinity };

// Re-feeding a GeoJSON source data it already holds is not free: MapLibre ships
// it to a worker and re-tiles every tile in the cache. The country level used to
// do that on *every move frame* of a zoom-out — country geometry is detailed and
// viewport-independent, so it was both heavy and pure waste, landing right on top
// of the crossfade it was competing with. ensureCountryFC() hands back a stable
// object while nothing has changed, so identity tells "same data" from "rebuilt".
function setVecData(sfx, fc) {
  if (fc === vecHeld[sfx]) return;
  vecHeld[sfx] = fc;
  map.getSource(`hex${sfx}`).setData(fc);
}

/** Put geometry on whichever source is currently live. */
const setHexData = (fc) => setVecData(vecLive, fc);

// The vector layers of one source, bottom to top. The label is only ever
// populated at the continent level, and only exists at all on a basemap whose
// style names a glyph server — see installGrid.
const VEC_LAYERS = ['hex-fill', 'hex-bound-glow', 'hex-bound-line', 'hex-label'];
// The first layer that must stay *above* the visited wash. See
// raiseVectorLayers().
const VEC_ANCHOR = 'trip-glow';

// Put one source's layers above the other's. crossPrev() derives the outgoing
// opacity on the assumption that the incoming layer composites *over* the
// outgoing one; when the two swap places that assumption has to be re-seated or
// the composite sags in the middle of every region ↔ country crossing — the
// exact flash crossPrev exists to remove. moveLayer only reorders, it never
// re-tiles.
function raiseVectorLayers(sfx) {
  // Anchored to the trip track rather than to the wash anchor. Everything added
  // at `washBefore` after the two vector trios — the trip track, and the
  // selection ring above it — has to stay above the visited wash; moving the
  // wash to `washBefore` would lift it over both, and the trip you just clicked
  // would disappear under the countries.
  // The fallback is only reachable before `trip-glow` exists, and on Mapbox it
  // would be a slot name rather than a layer id — which `moveLayer` would throw
  // on, because a slot is a place to insert *into* and not a layer to sit
  // before. Nothing to reorder at that point anyway.
  const fallback = isSlot(vecInsertBefore) ? null : vecInsertBefore;
  const anchor = map.getLayer(VEC_ANCHOR) ? VEC_ANCHOR : fallback;
  if (!anchor) return;
  for (const id of VEC_LAYERS) {
    if (map.getLayer(`${id}${sfx}`)) map.moveLayer(`${id}${sfx}`, anchor);
  }
}

// Crossing into the country level has to ramp opacity on geometry the map has
// already tiled. Handing `hex` ~800 KB of boundaries at the moment the fade
// starts costs ~60 ms of worker time before a single country can be drawn, and
// by then crossPrev has already pulled the blob down — so the countries arrive
// late and one gesture reads as level → nothing → country. Feeding the same
// data in a zoom level early, pinned invisible, makes the crossing pure ramp.
// The other direction never had this problem: there the countries are already
// on `hex` and simply fade out where they stand, which is why zoom-in looked
// right while zoom-out did not.
const VECTOR_WARM_ZOOM = levelBoundary(FIRST_VECTOR_LEVEL - 1) + 1.2;
// Releasing the tiles again needs its own, much higher threshold. Anything
// close to the warm one churns: zooming around a boundary would drop and
// re-parse 800 KB every time it was crossed. Keep it clear of the L3 ↔ L4
// boundary too, so ordinary zooming between those levels never touches it.
const VECTOR_COOL_ZOOM = levelBoundary(FIRST_VECTOR_LEVEL - 2) + 1;

// Zoomed in far enough that region outlines are being read rather than glanced
// at, and the overview geometry's straight lines across real borders start to
// show. Fetch the detailed boundaries — for the countries actually on screen,
// one at a time, once each — and rebuild as they land.
//
// Only reachable with Detail pinned to Region: on Auto this level never survives
// past ~z5, where the overview geometry is the right thing to draw anyway.
function considerFineRegions(level) {
  if (level !== REGION_LEVEL || map.getZoom() < REGION_FINE_ZOOM) return;
  if (!regionsLoaded() || !litRegionIds) return;
  const view = lngLatBox(viewMerc());
  for (const { iso, country } of countriesInView(litRegionIds, view)) fetchFineRegions(iso, country);
}

/**
 * One country's detailed boundaries, fetched once and drawn wherever they show.
 *
 * Shared by the zoom that sharpens the map and by picking a single region out of
 * the search box, because the fetch, the ring at the top of the screen and the
 * redraw afterwards are the same three things either way. Never fetched twice —
 * `fineCountryKnown` remembers failures as well as successes, so a country
 * nobody has boundaries for at our granularity is asked for once.
 *
 * @param {string} iso ISO3 country code
 * @param {string} label what to call it while it is on its way
 */
function fetchFineRegions(iso, label) {
  if (!iso || fineCountryKnown(iso)) return;
  // The ring at the top of the map, so a zoom that is about to sharpen doesn't
  // look like one that isn't going to.
  const done = busy(`Loading ${label} boundaries…`);
  loadFineRegions(iso)
    .then((paired) => {
      if (!paired) return;
      areaFC.regionFine = EMPTY; // rebuild at the new resolution
      updateGrid(true);
      updateSelection(); // and the outlined shape, if one is being looked at
    })
    .finally(done);
}

function warmVector(level, asBlob) {
  const zoom = map.getZoom();
  // Pinned to a hex level, no crossing can happen — there is nothing to prepare
  // for, so don't parse any boundaries at all.
  if (detailLevel != null) return;

  if (asBlob) {
    // On a blob level, approaching the first vector level. Pre-tile it on the
    // live vector source, which is idle while the canvas carries the map.
    if (zoom >= VECTOR_WARM_ZOOM) {
      // Far enough away to give the tiles back — but only the data goes. The
      // role stays 'warm': the source is not the live surface at a blob level
      // either way, and raising its opacity here is a flash waiting to happen,
      // because setVecData() returns as soon as the worker has been *told*
      // about the new data while the tiles on screen are still the old ones for
      // a frame or two.
      if (zoom > VECTOR_COOL_ZOOM) {
        for (const sfx of ['', '-prev']) {
          if (vecRole[sfx] === 'warm') setVecData(sfx, EMPTY);
        }
      }
      return;
    }
    // Only ever borrow a source when it is idle — mid-crossfade it is holding a
    // level that is still on screen.
    if (vecRole[vecLive] === 'out') return;
    const kind = vectorKindOf(FIRST_VECTOR_LEVEL);
    if (!areaReady(kind)) return;
    const fc = ensureAreaFC(kind);
    if (fc === vecHeld[vecLive]) return;
    // Pin the layer down *before* handing it the geometry, never after.
    vecRole[vecLive] = 'warm';
    setVectorFade(vecLive, 0);
    setVecData(vecLive, fc);
    return;
  }

  // On a vector level, approaching the *other* vector level. Its geometry has
  // to be tiled on the idle source before the crossing, or the crossing spends
  // its first frames parsing instead of fading — the same stall the blob →
  // vector warm-up above exists to remove.
  const next = neighbourVectorLevel(level, zoom);
  const idle = vecIdle();
  if (vecRole[idle] === 'out') return; // it is still fading; leave it alone
  if (next == null) {
    if (vecRole[idle] === 'warm') {
      setVecData(idle, EMPTY);
      vecRole[idle] = 'idle';
    }
    return;
  }
  const kind = vectorKindOf(next);
  if (!areaReady(kind)) return;
  const fc = ensureAreaFC(kind);
  if (fc === vecHeld[idle] && vecRole[idle] === 'warm') return;
  vecRole[idle] = 'warm';
  setVectorFade(idle, 0);
  setVecData(idle, fc);
}

// Whether what was last built still covers what is on screen. A rotation
// changes the box exactly as a pan does — the ground the camera sees is
// different ground — so turning the map re-runs the build through this test
// rather than through one of its own.
function coverageContainsView() {
  return !!coverage && boxContains(coverage, viewMerc());
}

// How much larger than the box it would paint now the last painted box may be
// before it is worth painting again.
//
// Every other test in updateGrid asks whether coverage has run *out*. None of
// them asks whether it has gone slack, and until the camera could lean, none of
// them needed to: panning and zooming out both leave coverage behind, and
// zooming in is caught by the zoom drift. Levelling a tilted view does neither.
// It cuts the ground the camera sees to a fraction while staying comfortably
// inside the box painted for the lean — so `coverageContainsView()` says yes,
// nothing rebuilds, and the map keeps a sheet that is spending most of its
// pixels off screen and under-sampling the part that is on it. The wash stayed
// soft after being levelled, with no gesture left to blame.
//
// 2.5, against a padded box that is 2.89× the viewport by construction: well
// clear of the ordinary case, so an ordinary pan or zoom never trips it, and
// comfortably under the ~6× a full lean produces.
const COVERAGE_SLACK = 2.5;

function coverageTooLoose(bb) {
  if (!coverage || coverage === WORLD_COVERAGE) return false;
  const now = boxArea(bb);
  return now > 0 && boxArea(coverage) > COVERAGE_SLACK * now;
}

// Set while the country boundaries are being fetched, so a zoom gesture doesn't
// queue one callback per frame.
let countryLoadPending = false;
let fineLoadPending = false;

// Load with ?debuglevels to have every committed level change logged with the
// zoom it happened at. A single zoom gesture should produce exactly one line;
// two or three means the level decision itself is oscillating (LEVEL_HYSTERESIS
// too tight) rather than the crossfade misbehaving.
const DEBUG_LEVELS = new URLSearchParams(location.search).has('debuglevels');
const levelName = (L) => (isVectorLevel(L) ? vectorKindOf(L) : `L${L}`);

// Set across the sign-in sequence, while the cells are known and the colour
// they should be drawn in is not.
//
// `onAuthed` loads the cells before it reconciles preferences, and it has to:
// the rows `adoptPrefs` rebuilds are built from what the account actually has,
// so the routes must be in first. But the visited colour is a preference, and a
// browser that has never seen this account has only `DEFAULT_ACCENT` to paint
// with — so the map came up blue, held it for as long as the round trip took,
// and then turned white. On a fresh sign-in that is the first thing you see.
//
// Painting nothing for those few hundred milliseconds is the honest version:
// the basemap is already there, and one appearance is better than two. Released
// in a `finally`, so a preferences fetch that throws still ends with a map.
let paintHeldForPrefs = false;

function updateGrid(force = false) {
  // The hex sources briefly don't exist while a new basemap style loads.
  if (!map.getSource('hex')) return;
  if (paintHeldForPrefs) return;
  const bb = paddedMerc();
  // Edit mode always works on the smallest cells: display, spotlight and
  // painting all lock to level 0 so what you see is what gets marked. Outside
  // it, a pinned Detail level wins over the zoom.
  let level;
  if (mode === 'edit') level = 0;
  else if (detailLevel != null) level = detailLevel;
  else {
    level = levelForZoom(map.getZoom(), skipHysteresis ? null : currentLevel);
    skipHysteresis = false;
  }

  // The country level draws from a lazily-fetched 1.4 MB boundary file. Handing
  // over before it lands would dissolve the hexes into an empty map and then
  // pop the countries in a beat later — two visible changes for one zoom. Hold
  // the coarsest hex level until the data is there; the fetch re-runs this.
  if (isVectorLevel(level) && !areaReady(vectorKindOf(level))) {
    if (!countryLoadPending) {
      countryLoadPending = true;
      Promise.all([loadCountries(), loadRegions()]).then(() => {
        countryLoadPending = false;
        updateGrid(true);
      });
    }
    // Hold the finest thing that is definitely drawable — a hex level, never
    // another vector one, or a zoom-out with cold data would sit on a level
    // that cannot render either.
    level = currentLevel != null && !isVectorLevel(currentLevel) ? currentLevel : FIRST_VECTOR_LEVEL - 1;
  }

  updateHud(level);
  setBasemapContinents(level !== CONTINENT_LEVEL);
  // Hex levels go through the blob canvas; the country level stays vector.
  const asBlob = BLOBS && !isVectorLevel(level) && blobCur.isInstalled();
  // Before the early-outs: the whole point is to have this done well ahead of
  // the crossing, and a zoom that never leaves its level still approaches one.
  warmVector(level, asBlob);
  // Before the early-outs, so panning into a country whose detail isn't loaded
  // still asks for it even when nothing else about the view changed.
  considerFineRegions(level);
  const levelChanged = level !== currentLevel;
  // The blob canvas is a raster: zooming inside one level stretches it, so
  // repaint once the zoom has drifted enough for that to show — but never in
  // the middle of a gesture. Rasterizing costs tens of milliseconds, and doing
  // it repeatedly while the user is still zooming is both a stutter and a
  // visible pop; the existing image scales with the map perfectly well until
  // they let go.
  const zoomDrift = currentAsBlob && Math.abs(map.getZoom() - paintedZoom) > 0.3;
  // The region level draws at two resolutions and swaps between them on zoom —
  // and it claims the whole world as its coverage, so without this the early-out
  // below swallows the swap: zooming in after anything else had fed the coarse
  // geometry left the map coarse for good, whatever you did to the camera. It is
  // a change of what should be on screen, exactly like a level change, so it
  // belongs in the same test.
  const wantFine = level === REGION_LEVEL && useFineRegions();
  const resolutionChanged = level === REGION_LEVEL && wantFine !== fedFine;
  // A level change during a gesture paints a reduced sheet (see MOVING_MAX_PX),
  // so the map owes itself a sharp one. It is a difference between what is on
  // screen and what should be, exactly like a drifted zoom, and it waits for the
  // same quiet: not while the camera is moving, and not while the dissolve that
  // asked for it is still running, because a repaint mid-dissolve would put the
  // full-size sheet back into every remaining frame of it.
  const owedSharp = currentAsBlob && blobCoarse;
  // A sheet painted for far more ground than the camera now wants — levelling a
  // lean is the case that put this here. Treated exactly like a drifted zoom:
  // worth repainting, not worth repainting mid-gesture.
  const slackCoverage = currentAsBlob && coverageTooLoose(bb);
  const settled = !map.isMoving() && !blobCur.inTransition();
  if (
    !force && !levelChanged && !resolutionChanged &&
    !zoomDrift && !owedSharp && !slackCoverage && coverageContainsView()
  )
    return;
  if (
    !force &&
    !levelChanged &&
    !resolutionChanged &&
    (zoomDrift || owedSharp || slackCoverage) &&
    coverageContainsView() &&
    !settled
  )
    return;

  const fc = asBlob ? EMPTY : buildGrid(bb, level);

  const paintBlob = () => {
    blobCoarse = blobCur.paint({
      bb,
      level,
      cells: litSets[level],
      colorOf: blobColorOf(level),
      heat: isHeatMode(),
      moving: map.isMoving(),
    });
  };

  if (DEBUG_LEVELS && levelChanged && currentLevel !== null) {
    const how = asBlob && currentAsBlob ? 'canvas dissolve' : 'layer crossfade';
    console.log(
      `[levels] ${levelName(currentLevel)} → ${levelName(level)} (${how})` +
        ` at zoom ${map.getZoom().toFixed(3)}, t=${Math.round(performance.now())}ms`,
    );
  }

  if (levelChanged && currentLevel !== null && asBlob && currentAsBlob) {
    // Hex → hex, the common case. The dissolve happens inside the canvas: the
    // outgoing level is frozen, the new one is painted over it, and the layer
    // opacity never moves. Nothing here depends on a texture arriving at the
    // right moment, which is what used to make a single zoom look like two
    // level changes in a row.
    blobCur.beginTransition();
    if (vecRole[vecLive] === 'in') setHexData(fc); // 'warm' is holding the next level ready
    paintBlob(); // composes at t = 0 — still showing the outgoing level
    blobRole = 'none';
    applyFade(1);
    applyPrevFade(0);
    dissolveBlob(LEVEL_FADE_MS);
  } else if (levelChanged && currentLevel !== null) {
    // Crossing the hex ↔ country boundary: the two sides live on different
    // layers, so this one really is a layer crossfade. Whichever side is
    // outgoing already holds a valid texture — nothing is copied, so there is
    // no frame where the old level is missing.
    stopBlobFade();
    // Vector → vector: neither side is the canvas. The outgoing level stays
    // exactly where it is and the incoming one is built on the other source,
    // then the two swap places — nothing already on screen is re-tiled.
    if (!asBlob && !currentAsBlob) {
      const from = vecLive;
      const to = vecIdle();
      // The canvas sits this one out — and is put away, in case a stale
      // texture is still on it.
      blobRole = 'off';
      blobCur.setOpacity(0);
      blobCur.clear();
      setVecData(to, fc); // a warmed source already holds it; this is then free
      // The incoming layer has to composite *over* the outgoing one, or
      // crossPrev's derivation sags in the middle of the crossing.
      raiseVectorLayers(to);
      vecLive = to;
      vecRole[to] = 'in';
      vecRole[from] = 'out';
      applyFade(0);
      applyPrevFade(1);
      animateFade(0, 1, 1, 0, LEVEL_FADE_MS, true);
      currentAsBlob = asBlob;
      paintedZoom = map.getZoom();
      currentLevel = level;
      coverage = WORLD_COVERAGE;
      if (selection && lastInfoLngLat) showInfoAt(lastInfoLngLat);
      return;
    }
    blobRole = currentAsBlob ? 'out' : 'in';
    // Blob → country: the countries are new data and have to be loaded onto
    // `hex` as the incoming side. Country → blob: the incoming side is the
    // canvas, so `hex` keeps the countries it has already tiled and fades them
    // out in place — nothing is re-parsed, so nothing blinks.
    vecRole[vecLive] = currentAsBlob ? 'in' : 'out';
    applyFade(0);
    applyPrevFade(1);
    if (vecRole[vecLive] === 'in') setHexData(fc);
    if (asBlob) paintBlob();
    animateFade(0, 1, 1, 0, LEVEL_FADE_MS, true);
  } else {
    // While the live source is 'out' its layers are showing the outgoing level;
    // feeding them the new level's (empty) data would erase them mid-fade.
    // animateFade's finish() takes care of it.
    if (vecRole[vecLive] === 'in') setHexData(fc);
    // A vector level that was arrived at without a crossing — Detail pinned to
    // Region or Country, which is also what a reload restores — never ran the
    // hand-over that puts the canvas away, so it sat at full opacity underneath
    // the polygons. Empty, so invisible; but a stale texture there would show,
    // and "invisible because it happens to be blank" is not a state to rely on.
    if (!asBlob && blobRole !== 'out' && blobRole !== 'off') {
      blobRole = 'off';
      blobCur.setOpacity(0);
      blobCur.clear();
    }
    if (asBlob) paintBlob();
    // A blob that is mid-fade-out is still on screen: clearing its canvas here
    // would erase it instantly and turn the hand-over to the country level into
    // a pop. The fade's own finish() clears it once it has actually gone.
    else if (blobRole !== 'out') blobCur.clear();
  }

  // Again, now that the region shapes have actually been built. The call above
  // runs before buildGrid, so on the *first* pass at this level there is no list
  // of lit regions yet and it has nothing to ask about — which is why switching
  // Detail to Region while already zoomed in used to do nothing until the camera
  // was nudged. Idempotent: a country already asked for is skipped.
  considerFineRegions(level);

  currentAsBlob = asBlob;
  paintedZoom = map.getZoom();
  currentLevel = level;
  // What the source is actually holding, which is the thing the early-out above
  // has to compare against. Tracking the *cache* instead would be the same
  // mistake in a different place: the fine geometry can be built and cached
  // while the map is still showing the coarse shape.
  fedFine = wantFine;
  // Country geometry is global — it doesn't depend on where the viewport is,
  // so nothing about a pan or zoom can invalidate it. Claiming the whole world
  // as covered keeps the move handler from re-running this at all.
  // Both vector levels draw viewport-independent geometry, so they claim the
  // whole world as their coverage and a pan never rebuilds them.
  coverage = isVectorLevel(level) ? WORLD_COVERAGE : bb;

  // The info card describes a cell at a particular level, so a zoom that
  // changes the level re-resolves it against the bigger (or smaller) hex.
  if (levelChanged && selection && lastInfoLngLat) showInfoAt(lastInfoLngLat);
}

// --- Hover (tweened via feature-state for a soft glass highlight) ----------
const hoverAnim = new Map(); // cellId -> { v, target }
let hoveredId = null;
let hoverRaf = null;

function hoverLoop() {
  let active = false;
  for (const [id, s] of hoverAnim) {
    s.v += (s.target - s.v) * 0.18;
    if (Math.abs(s.target - s.v) < 0.01) {
      s.v = s.target;
      if (s.v === 0) hoverAnim.delete(id);
    } else {
      active = true;
    }
    map.setFeatureState({ source: 'tiles', id }, { hoverT: s.v });
  }
  hoverRaf = active ? requestAnimationFrame(hoverLoop) : null;
}

function setHover(id) {
  if (id === hoveredId) return;
  if (hoveredId) {
    const s = hoverAnim.get(hoveredId) ?? { v: 1 };
    hoverAnim.set(hoveredId, { ...s, target: 0 });
  }
  hoveredId = id;
  if (id) {
    const s = hoverAnim.get(id) ?? { v: 0 };
    hoverAnim.set(id, { ...s, target: 1 });
  }
  if (!hoverRaf) hoverRaf = requestAnimationFrame(hoverLoop);
}

// --- Mode switching ----------------------------------------------------------
let modeRaf = null;

function setMode(next) {
  if (!EDIT_ENABLED) next = 'view';
  if (next === mode) return;
  mode = next;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* fine */
  }
  if (mode !== 'edit') stopPaint();
  setHover(null);
  // Edit mode never asks which route is under the pointer, so one lit on the way
  // in would stay lit until something else happened to clear it.
  setHoveredRoute(null);
  closeCellInfo(); // the cards belong to view mode; clicks now paint
  closeRouteInfo();
  closePhotoInfo();
  updateModeUi();
  // Re-lock the region level: edit mode pins to level 0 (smallest cells),
  // view mode returns to the zoom-appropriate level. Crossfades either way.
  updateGrid(true);
  if (mode === 'edit') updateTiles();

  // Tween the tile spotlight in/out.
  if (modeRaf) cancelAnimationFrame(modeRaf);
  const from = tileVis;
  const to = mode === 'edit' ? 1 : 0;
  const t0 = performance.now();
  const D = 280;
  const tick = (now) => {
    const t = Math.min(1, Math.max(0, (now - t0) / D));
    const e = 1 - Math.pow(1 - t, 3);
    tileVis = from + (to - from) * e;
    applyTileVis();
    if (t < 1) {
      modeRaf = requestAnimationFrame(tick);
    } else {
      modeRaf = null;
      if (to === 0) map.getSource('tiles')?.setData(EMPTY);
    }
  };
  modeRaf = requestAnimationFrame(tick);
}

// --- HUD ---------------------------------------------------------------------
const hud = document.getElementById('hud');
const hudPanel = document.getElementById('hud-panel');
const hudSize = document.getElementById('hud-size');
const hudRes = document.getElementById('hud-res');
const hudVisited = document.getElementById('hud-visited');
const colorInput = document.getElementById('hud-color');
const hudPencil = document.getElementById('hud-pencil');
const hudDone = document.getElementById('hud-done');

// Editing is opt-in: the pencil only exists once you switch it on in the menu,
// so the default map is a clean view-only surface you can't scribble on.
const EDIT_UI_KEY = 'visited-map:editui:v1';
let editUi = EDIT_ENABLED && localStorage.getItem(EDIT_UI_KEY) === 'on';

function setEditUi(on) {
  editUi = EDIT_ENABLED && on;
  try {
    localStorage.setItem(EDIT_UI_KEY, editUi ? 'on' : 'off');
  } catch {
    /* fine */
  }
  if (!editUi && mode === 'edit') setMode('view'); // also calls updateModeUi
  else updateModeUi();
}

function updateModeUi() {
  hud.hidden = !EDIT_ENABLED || !editUi;
  const editing = mode === 'edit';
  hudPencil.hidden = editing;
  hudPanel.hidden = !editing;
  document.body.classList.toggle('editing', editing);
  const box = document.getElementById('edit-toggle');
  if (box) box.checked = editUi;
  // One cursor for the whole of edit mode. It used to swap to a crosshair while
  // a paint sweep was armed, and macOS draws the pointing hand from its
  // fingertip but the crosshair from its centre — so arming and disarming
  // shifted the visible pointer by several pixels and back, without anything
  // having actually moved.
  map.getCanvas().style.cursor = editing ? 'crosshair' : '';
}

function updateHud(level) {
  if (level == null) return;
  if (level === COUNTRY_LEVEL || level === CONTINENT_LEVEL) {
    hudSize.textContent = level === CONTINENT_LEVEL ? 'Continents' : 'Countries';
    hudRes.textContent = '—';
  } else {
    hudSize.textContent = cellSizeKm(level);
    hudRes.textContent = String(level);
  }
  // What is on the map, which is not the same as what you have the moment a
  // source is switched off in the Type legend. See hiddenSources.
  hudVisited.textContent = String(visibleCells.size);
  updateDetailNow(level);
}

// The Detail buttons are bare numbers, and a cell's ground size depends on the
// latitude you're looking at — so the section says what is actually on screen.
// Outside edit mode this is the only place that shows it.
const detailNow = document.getElementById('detail-now');

function updateDetailNow(level = currentLevel) {
  if (level == null) return;
  detailNow.textContent =
    level === CONTINENT_LEVEL
      ? 'Showing whole continents'
      : level === COUNTRY_LEVEL
        ? 'Showing whole countries'
        : level === REGION_LEVEL
          ? 'Showing whole regions'
          : `Showing ${cellSizeKm(level)} cells`;
}

// --- Basemap / overlay controls ----------------------------------------------
const layersBtn = document.getElementById('layers-btn');
const layersMenu = document.getElementById('layers-menu');
const railToggle = document.getElementById('rail-toggle');
const trailsToggle = document.getElementById('trails-toggle');
const trailsTapToggle = document.getElementById('trails-tap-toggle');
const airportsToggle = document.getElementById('airports-toggle');
const photosRow = document.getElementById('photos-row');
const photosToggle = document.getElementById('photos-toggle');
const cellsTapToggle = document.getElementById('cells-interactive-toggle');
// `setStyle()` rebuilds MapLibre's entire style asynchronously. Keep the
// checkbox as the source of truth while that happens, then reconcile the
// actual layer once our custom sources/layers are ready again.
let styleReady = false;

// Has the current style finished *parsing* — which is the only thing a second
// setStyle() has to wait for.
//
// Deliberately not `map.isStyleLoaded()`. That is Style.loaded(), which also
// insists every tile manager has finished and the image manager is loaded, so
// it stays false long after `style.load` has fired — for as long as any tile is
// in flight, which over a slow connection or a raster overlay is most of the
// time. The code then waited on `map.once('style.load')`, an event that only
// fires when a style loads: the very thing it was waiting to start. A basemap
// switch could sit unapplied for ten seconds and then land on whichever key had
// been chosen *first*, because the pending promise finally resolved on somebody
// else's style load.
let styleParsed = false;

/** Resolves once the style in place has parsed. Never waits on tiles. */
const styleSettled = () =>
  (styleParsed ? Promise.resolve() : new Promise((r) => map.once('style.load', r)));

/** Swap the basemap, marking the style unparsed for the duration. */
function swapStyle(style) {
  styleParsed = false;
  map.setStyle(style);
}

// The 3D basemap's token dialog, mounted with the rest of the UI far below.
// Declared up here because the basemap picker reaches for it: pressing a
// basemap that has no token is how you are asked for one.
let mapboxUi = null;

function setStyleKey(key) {
  if (!STYLES[key] || key === styleKey) return;
  // A basemap nobody has given a token to. Pressing it opens the dialog that
  // asks for one rather than doing nothing: the button is the only place the
  // 3D map is mentioned, so it has to be the way to find out what it wants.
  if (STYLES[key].needsToken && !STYLES[key].needsToken()) {
    setMenuOpen(false);
    mapboxUi?.open();
    return;
  }
  // Crossing between the two map libraries, which no `setStyle` can do: the map
  // object itself has to be replaced. Everything else about the switch — the
  // key, the chrome, the UI — is the same as any other, so switchEngine() does
  // only the replacing and this function goes on being the one place a basemap
  // changes.
  if (engineOf(key) !== engine) {
    switchEngine(key);
    return;
  }
  styleKey = key;
  presumeChrome(); // before anything is fetched, let alone painted
  // Immediately, not once the new style lands: the wash on screen belongs to
  // the basemap being left, and holding it until the style resolves would show
  // the light colour over the dark map for as long as the fetch takes. A
  // no-op between two basemaps of the same theme.
  syncAccent();
  try {
    localStorage.setItem(STYLE_KEY, key);
  } catch {
    /* fine */
  }
  // setStyle() drops our layers; the 'style.load' handler (installGrid)
  // rebuilds them, re-adds the rail overlay if on, and restores opacities.
  styleReady = false;
  updateLayersUi();
  // Built styles are fetched and rewritten before they can be handed over, so
  // this is async — but the key and the UI have already moved, and a slow fetch
  // must not be able to apply over a basemap the user has since switched away
  // from.
  Promise.all([resolveStyle(key), styleSettled()]).then(([style]) => {
    if (style && styleKey === key) swapStyle(style);
  });
}

// A switch is in flight. Two presses in quick succession — 3D, then Light
// before the first has finished — would otherwise tear down a map the first one
// is still standing up.
let switching = false;

/**
 * Change basemap *and* map library, by replacing the map rather than the page.
 *
 * The page reload this replaces was correct and much too slow: it threw away
 * the session's cells, routes, boundaries and photographs and fetched every one
 * of them again, to change which library was drawing the ground underneath.
 * Nothing above the basemap needed to move.
 *
 * What makes it possible is `onMapBuilt` — everything this file has to say to a
 * map object is remembered as it is said, so it can be said again to the next
 * one. What makes it *safe* is that `installGrid` already rebuilds every layer
 * this app draws on `style.load`, because an ordinary basemap switch has always
 * dropped them; a new map fires that event exactly as a new style does, so the
 * restoring path is the one that has been exercised on every switch since.
 *
 * The order matters in one respect: the library is fetched **before** anything
 * is torn down, so a failed download leaves the map that is on screen alone.
 */
async function switchEngine(key) {
  if (switching) return;
  switching = true;
  setMenuOpen(false);
  try {
    const next = engineOf(key);
    let loadedGl;
    try {
      ({ gl: loadedGl } = await loadEngine(next));
    } catch (e) {
      console.warn(`Map engine "${next}" could not be loaded.`, e);
      showToast('The 3D map library could not be loaded. Check the connection.');
      return;
    }

    // From here the old map is going. Everything that has to survive is read
    // off it first.
    const tracking = geolocateState();
    const c = map.getCenter();
    const view = {
      lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
    };
    // Leaving 3D lands flat. `createMap` already clamps 85° down to the 60° the
    // other four allow, which is the arithmetic answer and the wrong one to look
    // at: a lean is worth having over a city with buildings standing in it, and
    // over CARTO Dark it is a foreshortened flat map with nothing up there to
    // justify it. The camera is levelled rather than merely legalised.
    if (next !== MAPBOX) view.pitch = 0;
    styleKey = key;
    try {
      localStorage.setItem(STYLE_KEY, key);
    } catch {
      /* the basemap simply will not be remembered next visit */
    }
    // Before the fetch, not after: the wash on screen belongs to the basemap
    // being left, and on a switch into 3D at night the whole map changes tone.
    presumeChrome();
    syncAccent();
    styleReady = false;
    styleParsed = false;
    updateLayersUi();

    // Popups hold the map that made them, and their elements are inside the
    // container about to be emptied.
    airportPopup?.remove();
    railPopup?.remove();
    airportPopup = null;
    railPopup = null;
    // The blob layer leaves an `idle` handler and a 2.5-second timer
    // outstanding, both of which reach back for their source. A style swap
    // survives that; a map that no longer exists does not, and the timer throws
    // into a torn-down style seconds after the switch looked finished.
    blobCur.dispose();
    // Everything the map owns: its canvas, its controls, its sources, its
    // handlers. Ours go with them, which is why they are all replayable.
    map.remove();

    gl = loadedGl;
    engine = next;
    map = freshMap(view);
    // Holds the map it was made for, so it cannot outlive one — see its
    // declaration. The sheet it had is dropped and installGrid repaints it.
    blobCur = createBlobLayer(map, 'blob');
    // ...and forget everything that described the *old* one. This bookkeeping
    // lives at module scope and so survives a map that does not: `coverage` is
    // the patch of ground the sheet was painted for, `currentLevel` which level
    // it holds, `paintedZoom` the zoom it was rasterised at. Left alone, they
    // describe a canvas that has just been thrown away — and `updateGrid` reads
    // them to decide whether a repaint is owed, so it concluded the view was
    // already covered and never painted the new sheet at all. The wash then
    // froze exactly where the old basemap left it and stayed there through
    // every pan, until something forced a repaint by another route: changing
    // the colouring mode, which is how this was reported.
    //
    // A style swap never needed this — the sheet and its layer survive one.
    // Replacing the map is the case that does.
    coverage = null;
    currentLevel = null;
    currentAsBlob = false;
    paintedZoom = 0;
    blobCoarse = false;
    blobRole = 'none';
    fedFine = false;
    rewireMap();
    // The new map's control is a new control, in its off state. See
    // restoreGeolocate — the blue dot is not something a basemap switch decides.
    restoreGeolocate(tracking);
    // A basemap that needs building is fetched and applied the same way it is
    // for any other switch. Standard is a URL, so this is usually a no-op.
    if (STYLES[key].build) {
      const style = await resolveStyle(key);
      if (style && styleKey === key) swapStyle(style);
    }
  } finally {
    switching = false;
  }
}

function setRail(on) {
  railOn = on;
  updateLayersUi();
  syncRailLayer();
}

/**
 * One group of the overlay — the kilometre posts, the platforms — on or off.
 *
 * Deliberately does not redraw the list it was called from: re-rendering would
 * replace the checkbox whose own change event we are inside, which works but
 * throws away the focus a keyboard user was holding.
 */
function setRailGroupOn(key, on) {
  railGroupsOn = { ...railGroupsOn, [key]: on };
  try {
    localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify(railGroupsOn));
  } catch {
    /* fine */
  }
  if (styleReady && railOn) setRailGroup(map, key, on);
}

/** The sidings, the yards, the lifted lines and the junctions, or none of them. */
function setRailTechnicalOn(on) {
  railTechnicalOn = on;
  try {
    localStorage.setItem(RAIL_TECHNICAL_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  if (styleReady && railOn) setRailTechnical(map, on);
}

/** Whether a tap on a railway opens a card, and the cursor says it would. */
function setRailInteractive(on) {
  railInteractive = on;
  try {
    localStorage.setItem(RAIL_INTERACTIVE_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  if (on) return;
  // Everything interaction put on screen goes with it, or an overlay that no
  // longer answers a tap is left holding the last card it opened.
  railPopup?.remove();
  clearRailHover();
}

function syncRailLayer() {
  // A click during initial load or a basemap switch is intentionally deferred;
  // installGrid() calls this again for the newly loaded style.
  if (!styleReady) return;
  if (!railOn) {
    removeRail(map);
    railPopup?.remove();
    clearRailHover();
    stopRailDetailPolling();
    showRailTrouble(null);
    return;
  }
  // The style is 315 KB and a session that never asks for the overlay never
  // fetches it, so the first switch-on is asynchronous. By the time it resolves
  // the basemap may have changed underneath, or the toggle may have been
  // switched off again — `styleReady && railOn` is asked once more on the far
  // side rather than trusted from before the await.
  // The detail ceiling is asked for *alongside* the style, not after the layers
  // are up. The server remembers what it learned before this page was reloaded,
  // so on a reload during an outage it already knows which zooms are answerable
  // — installing uncapped first would spend a round of requests on tiles known
  // to fail and show nothing until the rebuild caught up.
  Promise.all([loadRailStyle(), railDetail()]).then(([, { detail, degraded, lang }]) => {
    if (!styleReady || !railOn) return;
    railDetailCeilings = detail;
    railTileLang = lang;
    addRailLayer();
    updateLayersUi();
    showRailTrouble(degraded);
    startRailDetailPolling();
  }).catch((e) => {
    console.warn('Train tracks could not be loaded.', e);
  });
}

// --- Trails -----------------------------------------------------------------------

function setTrails(on) {
  trailsOn = on;
  try {
    localStorage.setItem(TRAILS_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  updateLayersUi();
  syncTrailLayer();
}

/** One of their five renderings. Switching it replaces the source — see installTrails. */
function setTrailThemeNow(key) {
  trailThemeOn = setTrailTheme(key);
  // A card about hiking routes, still open over a map that is now showing ski
  // slopes, is a card about a different question.
  trailPopup?.remove();
  updateLayersUi();
  if (trailsOn) syncTrailLayer();
}

/** Whether a tap asks the trails rather than the ground. */
function setTrailsInteractive(on) {
  trailsInteractive = on;
  try {
    localStorage.setItem(TRAIL_TAP_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  updateLayersUi();
  // An overlay that no longer answers a tap should not be left holding the last
  // card it opened.
  if (!on) trailPopup?.remove();
}

function syncTrailLayer() {
  // A click during initial load or a basemap switch is intentionally deferred;
  // installGrid() calls this again for the newly loaded style.
  if (!styleReady) return;
  if (!trailsOn) {
    removeTrails(map);
    trailPopup?.remove();
    return;
  }
  installTrails(map, {
    theme: trailThemeOn,
    // Which way round the map underneath is, which is the only thing about the
    // basemap this overlay reacts to — see OPACITY in src/trails.js.
    basemap: STYLES[styleKey].theme,
    before: TRAILS_BEFORE(),
  });
}

// --- Airports -------------------------------------------------------------------

function setAirports(on) {
  airportsOn = on;
  try {
    localStorage.setItem(AIRPORTS_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  updateLayersUi();
  syncAirportLayer();
}

/**
 * One group of airfields on or off.
 *
 * Unlike the railway's equivalent this may have to *fetch* before it can draw —
 * the groups are separate files and a group that has never been on has never
 * been downloaded. `syncAirportLayer` is the one path that knows how to wait, so
 * this defers to it rather than growing a second copy of the same await.
 */
function setAirportGroupOn(key, on) {
  airportGroupsChosen = { ...airportGroupsChosen, [key]: on };
  try {
    localStorage.setItem(AIRPORT_GROUPS_KEY, JSON.stringify(airportGroupsChosen));
  } catch {
    /* fine */
  }
  if (styleReady && airportsOn) syncAirportLayer();
}

// Which install this is, so a slow fetch cannot apply over a basemap the map has
// since switched away from — the same guard `setStyleKey` uses, and needed for
// the same reason: `loadAirports` awaits, and the world moves while it does.
let airportInstall = 0;

function syncAirportLayer() {
  // A switch during initial load or a basemap switch is intentionally deferred;
  // installGrid() calls this again for the newly loaded style.
  if (!styleReady) return;
  const mine = ++airportInstall;
  if (!airportsOn) {
    removeAirports(map);
    airportPopup?.remove();
    pointerOnAirport = false;
    syncPointer();
    return;
  }
  loadAirports(airportGroupsOn(airportGroupsChosen)).then(() => {
    // The basemap may have changed underneath, the overlay may have been
    // switched off again, or a second group may have been ticked while this one
    // was in flight — in which case a later call owns the map and this one is
    // stale. Asked on the far side of the await rather than trusted from before.
    if (mine !== airportInstall || !styleReady || !airportsOn) return;
    // One call whether this is a first install, a basemap rebuild or a group
    // being ticked — `installAirports` is idempotent precisely so this does not
    // have to ask which, and so the source's id stays inside the module that
    // owns it.
    installAirports(map, {
      // Whatever upright stack the basemap's own glyph server serves; a
      // fontstack it has never heard of is a label that silently never draws.
      font: styleFont(),
      theme: STYLES[styleKey].theme,
      before: AIRPORT_BEFORE(),
      groups: airportGroupsChosen,
    });
  }).catch((e) => {
    console.warn('Airports could not be loaded.', e);
  });
}

// --- What an airport says about itself --------------------------------------------
//
// Everything is already in the feature that drew the icon — no request, no
// second door, nothing that can be down. That is the dividend of shipping the
// dataset instead of proxying somebody's API, and it is why this half is a
// hundred lines rather than the railway's four hundred.
let airportPopup = null;

/** Scoped to our own layer ids: a basemap draws airports too, and reporting its
 *  idea of one while the overlay is showing OurAirports' would be the same
 *  mistake the rail hit test exists to avoid. */
function airportFeatureAt(point) {
  const ids = airportLayerIds().filter((id) => map.getLayer(id));
  if (!ids.length) return null;
  // A padded box rather than the bare point: an icon is about 14 px across and a
  // finger is not, so a tap that visibly landed on the plane should open it.
  const pad = 6;
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  return map.queryRenderedFeatures(box, { layers: ids })[0] ?? null;
}

/** Open a card about whatever airport was clicked, and say whether there was one. */
function showAirportInfo(e) {
  const hit = airportFeatureAt(e.point);
  const info = hit && describeAirportFeature(hit);
  if (!info) return false;

  const card = document.createElement('div');
  card.className = 'feature-popup';
  const h = document.createElement('h4');
  h.textContent = info.title;
  card.append(h);
  if (info.subtitle) {
    const sub = document.createElement('div');
    sub.className = 'feature-popup-kind';
    sub.textContent = info.subtitle;
    card.append(sub);
  }
  if (info.rows.length) {
    const dl = document.createElement('dl');
    for (const [label, value] of info.rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    card.append(dl);
  }
  // textContent and an href, never innerHTML: these are strings out of a
  // community-edited dataset, which is to say strings anyone can write.
  for (const link of info.links) {
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = link.label;
    card.append(a);
  }

  airportPopup?.remove();
  airportPopup = new gl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(hit.geometry.coordinates.slice(0, 2))
    .setDOMContent(card)
    .addTo(map);
  return true;
}

// --- Photographs -------------------------------------------------------------------
//
// The one overlay that draws something the server has never seen. Everything
// else on this map arrives over HTTP; this arrives over a message channel to the
// app hosting the page, because a photo library is on a phone. Outside the app
// there is no channel, `photosAvailable()` is false, and the row is left out of
// the menu — see the note at the top of src/photos.js.

/** Whether a tap on the ground opens a card about it. */
function setCellsInteractive(on) {
  cellsInteractive = on;
  try {
    localStorage.setItem(CELLS_TAP_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  updateLayersUi();
  // Whatever the ground has already put on screen goes with it, or switching
  // this off leaves the last card it opened sitting there with no way to have
  // opened it. The route and photo cards stay: those still answer.
  if (!on) closeCellInfo();
}

function setPhotos(on) {
  photosOn = on;
  try {
    localStorage.setItem(PHOTOS_KEY, on ? 'on' : 'off');
  } catch {
    /* fine */
  }
  updateLayersUi();
  syncPhotoLayer();
}

// Which install this is: `loadPhotos` awaits the phone, and the world moves
// while it does. The same guard as the airports', for the same reason.
let photoInstall = 0;
// Whether the library has been read since the switch was last turned on, whether
// a read is in the air, and what the last one had to say for itself. The last
// two are only ever shown in the menu row — a layer waiting on a permission
// dialog looks exactly like one that is broken, unless it says so.
let photoScanned = false;
let photoScanning = false;
let photoTrouble = null;

/** Draw the photographs, reading the library first if we have not already. */
function syncPhotoLayer() {
  // A switch during initial load or a basemap switch is intentionally deferred;
  // installGrid() calls this again for the newly loaded style.
  if (!styleReady) return;
  const mine = ++photoInstall;
  if (!photosOn) {
    removePhotos(map);
    // The list goes with the layer. It is the phone's, not ours, and holding a
    // copy of where somebody has taken eighty thousand photographs after they
    // have switched the overlay off is not a cache, it is a leftover.
    forgetPhotos();
    closePhotoInfo();
    photoScanned = false;
    photoScanning = false;
    photoTrouble = null;
    pointerOnPhoto = false;
    syncPointer();
    return;
  }

  // Installed even when the last answer was a refusal: the call is idempotent,
  // an empty source draws nothing, and the layer then exists and is empty
  // rather than half-existing in a way the next basemap switch has to reason
  // about.
  const draw = () => {
    installPhotos(map, {
      before: PHOTO_BEFORE(),
      theme: STYLES[styleKey].theme,
      font: styleFont(),
    });
    updateLayersUi();
  };

  // A basemap switch rebuilds the style and lands here again with the same
  // library already in hand, and re-reading it would be a second walk over
  // eighty thousand assets to arrive at the list we are holding. The scan
  // belongs to the switch being turned on, not to the style being rebuilt —
  // which is also the moment somebody would expect this afternoon's photographs
  // to appear.
  if (photoScanned) {
    draw();
    return;
  }
  photoScanning = true;
  updateLayersUi();
  loadPhotos().then((report) => {
    // The basemap may have changed underneath, or the switch may have been
    // turned off again while the library was being read. Asked on the far side
    // of the await rather than trusted from before it.
    if (mine !== photoInstall || !styleReady || !photosOn) return;
    photoScanning = false;
    photoScanned = report.ok;
    photoTrouble = report.ok ? null : report.error;
    draw();
  }).catch((e) => {
    if (mine !== photoInstall) return;
    photoScanning = false;
    photoTrouble = 'bridge';
    updateLayersUi();
    console.warn('The photo library could not be read.', e);
  });
}

/** What the menu row says under "Photos". */
function photoNote() {
  if (!photosOn) return 'Where your pictures were taken';
  if (photoScanning) return 'Reading your library…';
  switch (photoTrouble) {
    case 'denied':
    case 'unasked':
      // The way out is in iOS Settings, not here — nothing in this page can
      // reopen a permission that has been refused.
      return 'Allow photo access in iOS Settings';
    case null:
      break;
    default:
      return 'Your photos could not be read';
  }
  if (!photoCount()) return 'No photos with a location';
  // Videos counted apart from photographs, because with both on the map
  // "12,481 photos" is a number that is not true of what you are looking at.
  const videos = videoCount();
  const stills = photoCount() - videos;
  const parts = [];
  if (stills) parts.push(`${stills.toLocaleString()} ${stills === 1 ? 'photo' : 'photos'}`);
  if (videos) parts.push(`${videos.toLocaleString()} ${videos === 1 ? 'video' : 'videos'}`);
  // A limited library is not a smaller map, it is a wrong one, and this is the
  // only place that would ever say so.
  if (photosLimited()) parts.push('only the ones you picked');
  return parts.join(' · ');
}

/** Scoped to our own layer ids, and padded: a dot is small and a finger is not. */
function photoFeatureAt(point) {
  const ids = photoLayerIds().filter((id) => map.getLayer(id));
  if (!ids.length) return null;
  const pad = 8;
  const box = [[point.x - pad, point.y - pad], [point.x + pad, point.y + pad]];
  return map.queryRenderedFeatures(box, { layers: ids })[0] ?? null;
}

/** Open a card about whatever photograph was tapped, and say whether there was one. */
function showPhotoInfo(e) {
  const hit = photoFeatureAt(e.point);
  if (!hit) return false;
  const p = hit.properties ?? {};
  if (p.cluster) {
    openPhotoCluster(p.cluster_id, p.point_count);
    return true;
  }
  showPhotos([{ i: p.i, t: p.t, v: !!p.v }]);
  return true;
}

/**
 * A tap on a group opens it. Always, whatever size it is.
 *
 * It used to zoom in whenever zooming would break the group up, which is what a
 * map conventionally does and is wrong here. Photographs cluster again as fast
 * as you can separate them — a handful taken a few metres apart re-forms at
 * every zoom on the way in, so getting to the pictures took ten taps and each
 * one moved the map somewhere you had not asked to go. And the case it was
 * meant to serve is not real: nobody taps a group of photographs wanting a
 * different camera position, they tap it wanting the photographs.
 *
 * Zooming is what the map's own gestures are for, and they are still there.
 */
async function openPhotoCluster(clusterId, count) {
  // `getClusterLeaves` insists on a limit, so it is given the group's own size
  // — the card holds all of them and renders the strip in chunks.
  const items = await photoLeaves(map, clusterId, count);
  if (items.length) showPhotos(items);
}

/** The card, and the two it shares the bottom of the screen with. */
function showPhotos(items) {
  closeCellInfo();
  closeRouteInfo();
  photoInfo?.show(items);
}

function closePhotoInfo() {
  photoInfo?.hide();
}

// --- What a railway says about itself ------------------------------------------
// The reason the overlay is vector rather than pixels. Everything shown here is
// already in the tile that drew the line: OpenRailwayMap's own app answers this
// with a request to a feature API and a formatting catalogue per click, which is
// a lot to ask of a server this map is otherwise trying to ask less of.
let railPopup = null;

/**
 * The way back to the original.
 *
 * Built with textContent and an href, never innerHTML: these are OSM tag values,
 * which is to say strings anyone on the internet can edit.
 */
function addOsmLink(card, osm) {
  const a = document.createElement('a');
  a.href = osm.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `View this ${osm.type} on OpenStreetMap`;
  card.append(a);
}

/**
 * The topmost thing the overlay drew under a point, or nothing.
 *
 * Scoped to our own layer ids: the basemap draws railways too, and reporting
 * CARTO's idea of a line when the overlay is showing OpenRailwayMap's is the
 * same mistake the layer ordering was fixed for.
 */
function railFeatureAt(point) {
  const ids = railLayerIds().filter((id) => map.getLayer(id));
  if (!ids.length) return null;
  return map.queryRenderedFeatures(point, { layers: ids })[0] ?? null;
}

/** Open a card about whatever railway was clicked, and say whether there was one. */
function showRailInfo(e) {
  const hit = railFeatureAt(e.point);
  const info = hit && describeRailFeature(hit);
  if (!info) return false;

  const card = document.createElement('div');
  card.className = 'feature-popup';
  const h = document.createElement('h4');
  h.textContent = info.title;
  card.append(h);
  if (info.subtitle) {
    const sub = document.createElement('p');
    sub.className = 'feature-popup-kind';
    sub.textContent = info.subtitle;
    card.append(sub);
  }
  // One `dl` for both halves. What the tile knew is written now; what their
  // feature API adds — who runs the station, the code in the timetable, what is
  // on the platform — is appended to the same list when it arrives, so the card
  // grows rather than sprouting a second table under the first.
  const dl = document.createElement('dl');
  const addRows = (rows) => {
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dl.append(dt, dd);
    }
    dl.hidden = !dl.childElementCount;
  };
  addRows(info.rows);
  card.append(dl);

  // The services that run over it. Not in the tile, so the card opens without
  // them and fills the list in when the answer arrives — a click should not wait
  // on a network round trip to show what it already knows. Guarded by the popup
  // it was opened for, so a fast second click cannot land its routes in the
  // first one's card.
  //
  // A line's tile carries `route_count` and so knows to leave the room; a
  // station's and a platform's do not, so those ask on spec and the section is
  // built only if the answer has something in it.
  if (info.routeCount || info.mayHaveRoutes) {
    const routes = document.createElement('div');
    routes.className = 'popup-list';
    const heading = document.createElement('h5');
    const plural = (n) => (n === 1 ? '1 route' : `${n} routes`);
    // The tile's own count until the names arrive, then the count of what is
    // actually listed — the two differ because a there-and-back pair is two
    // relations and one line.
    heading.textContent = info.routeCount ? plural(info.routeCount) : 'Routes';
    routes.append(heading);
    // A station in a city centre is on twenty services and the list is taller
    // than the map. Its own scroller, so the card stays the size of a card and
    // everything above it — the name, the operator, the code — stays on screen.
    const list = document.createElement('div');
    list.className = 'popup-list-items';
    routes.append(list);
    routes.hidden = !info.routeCount;
    card.append(routes);
    const mine = card;
    railFeature(info).then(({ rows, routes: found, osm }) => {
      if (railPopup?.getElement()?.contains(mine) !== true) return;
      addRows(rows);
      if (osm && !info.osm) addOsmLink(card, osm);
      routes.hidden = !found.length;
      if (found.length) heading.textContent = plural(found.length);
      for (const route of found) {
        const line = document.createElement('div');
        line.className = 'popup-list-row';
        // The dot is always there, coloured or not. Plenty of OSM route
        // relations carry no `colour` tag — their API hands those back as an
        // empty string — and only drawing it for the ones that do left the
        // labels on a ragged edge, which reads as a rendering fault rather than
        // as missing data. A hollow dot says "no colour recorded" and keeps the
        // column straight.
        const dot = document.createElement('span');
        dot.className = 'popup-list-dot';
        if (route.color) dot.style.background = route.color;
        else dot.classList.add('unknown');
        line.append(dot);
        // Two spans so the break lands after the service name rather than
        // wherever the edge of the card happens to fall — see splitRouteLabel.
        // textContent throughout: these are OSM relation names, which is to say
        // strings anyone on the internet can edit.
        const { name, ends } = splitRouteLabel(route.label);
        const text = document.createElement('span');
        text.className = 'popup-list-text';
        if (name) text.append(`${name} `);
        const label = document.createElement('span');
        label.className = 'popup-list-tail';
        label.textContent = ends;
        text.append(label);
        line.append(text);
        list.append(line);
      }
    });
  }
  if (info.osm) addOsmLink(card, info.osm);

  railPopup?.remove();
  railPopup = new gl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(hit.geometry?.type === 'Point' ? hit.geometry.coordinates.slice() : e.lngLat)
    .setDOMContent(card)
    .addTo(map);
  return true;
}

// --- What runs past here ---------------------------------------------------------
//
// The trails card, and the one place where being a raster overlay is visible to
// somebody using the app rather than only to somebody reading the code.
//
// The railway card above opens on a *feature*: the tile that drew the line
// carries the line, so the tap knows what it hit before it asks anyone. There is
// no equivalent here. A PNG under the finger proves that some route passes
// through the neighbourhood and cannot say which, so this asks their API what
// runs near the point and lists the answers — and the heading says "near here",
// because that is the question that was actually answered.
//
// It therefore opens *before* the answer arrives and fills in, which the railway
// card only does for its secondary rows. A card that waited would be a tap with
// half a second of nothing after it, on the one overlay that cannot show you
// something instantly.
let trailPopup = null;

/** Open a card listing whatever waymarked routes run near the tap. */
function showTrailInfo(e) {
  const card = document.createElement('div');
  card.className = 'feature-popup';
  const h = document.createElement('h4');
  h.textContent = t('trails.trails-near-here');
  card.append(h);
  const kind = document.createElement('p');
  kind.className = 'feature-popup-kind';
  kind.textContent = trailThemeLabel(trailThemeOn);
  card.append(kind);

  const list = document.createElement('div');
  list.className = 'popup-list';
  // Hidden until there is something in it. The class carries a top rule, and an
  // empty one under the theme name is a divider with nothing on the far side of
  // it — which is what the card would show for the whole time it is asking, and
  // for good if the answer comes back empty.
  list.hidden = true;
  const items = document.createElement('div');
  items.className = 'popup-list-items';
  list.append(items);
  card.append(list);

  // What it says while it is asking. Replaced whichever way the answer goes, so
  // there is no state in which this is the last word.
  const status = document.createElement('p');
  status.className = 'feature-popup-note';
  status.textContent = t('trails.looking');
  card.append(status);

  trailPopup?.remove();
  trailPopup = new gl.Popup({ closeButton: true, maxWidth: '280px' })
    .setLngLat(e.lngLat)
    .setDOMContent(card)
    .addTo(map);

  // The box the finger covers, on the ground. Unprojected here rather than
  // computed from a radius in metres, because the map can be turned and leaned:
  // the four screen corners are what a fingertip actually covers, and only the
  // map knows where they land.
  const corners = tapCorners(e.point).map((p) => map.unproject(p));
  const mine = card;
  trailsNear(trailThemeOn, bboxAround(corners)).then((routes) => {
    // Guarded by the card it was opened for, so a fast second tap cannot land
    // its answer in the first one's popup.
    if (trailPopup?.getElement()?.contains(mine) !== true) return;
    const found = routes.map((r) => describeTrail(r, trailThemeOn)).filter(Boolean);
    if (!found.length) {
      status.textContent = t('trails.nothing-here');
      return;
    }
    status.remove();
    list.hidden = false;
    for (const route of found) {
      const row = document.createElement('div');
      row.className = 'popup-list-row';
      const text = document.createElement('span');
      text.className = 'popup-list-text';
      // An anchor rather than plain text: the relation on OpenStreetMap is the
      // rest of the answer, and a list of twenty routes has no room for twenty
      // "view this on OpenStreetMap" lines under it.
      const a = document.createElement('a');
      a.href = route.osm;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // textContent throughout — every string here is an OSM tag value, which is
      // to say something anyone on the internet can edit.
      a.textContent = route.title;
      text.append(a);
      // The kind, where it runs and what is on the post, after the name and in
      // the muted colour: the name is what you are scanning for, and twenty
      // routes' worth of detail at full weight is a wall.
      if (route.notes.length) {
        const tail = document.createElement('span');
        tail.className = 'popup-list-tail muted';
        tail.textContent = ` ${route.notes.join(' · ')}`;
        text.append(tail);
      }
      row.append(text);
      items.append(row);
    }
  });
  return true;
}

// --- Which railway the cursor is on --------------------------------------------
//
// This used not to exist, and the reason it did not is still the reason it is
// shaped the way it is: a `queryRenderedFeatures` across 288 layers on every
// mousemove is a real cost to pay for an affordance. What changed is that the
// cost is now opted into. Interaction is off by default, so a session that is
// reading the tracks over its own map never runs a single one of these; a
// session that has asked for the railways to answer questions gets an answer to
// "which of these twenty parallel lines am I about to click".
//
// Throttled to one query per frame, and skipped mid-gesture, where the answer
// would be both wasted and wrong by the time it was drawn.
//
// **The highlight itself costs nothing of ours.** 171 of the 288 layers already
// paint a hovered feature differently — that styling came with them and had
// never been switched on — so what this does is write one feature state and let
// their style answer it. See setRailHover.
let railHoverPending = false;
let railHoverPoint = null;

// Two things can make the cursor a pointer and they do not know about each
// other: a saved route answers synchronously on the mousemove, a railway a frame
// later. One place decides, so the later answer cannot clear the earlier one's.
let pointerOnRoute = false;
let pointerOnRail = false;
// And an airport, which answers on the mousemove like a route rather than a
// frame later like a railway: this is one query over six layers of a point
// source, not 288 layers of somebody else's style, so there is nothing here to
// throttle away.
let pointerOnAirport = false;
// And a photograph, on the same terms — three layers over one point source. It
// only ever matters on a laptop pointed at a phone's server, which is to say
// almost never, and costing nothing is what makes that fine.
let pointerOnPhoto = false;
const syncPointer = () => {
  map.getCanvas().style.cursor =
    pointerOnRoute || pointerOnRail || pointerOnAirport || pointerOnPhoto ? 'pointer' : '';
};

function railHoverAt(point) {
  if (!railInteractive || !railOn || !styleReady || map.isMoving()) return;
  railHoverPoint = point;
  if (railHoverPending) return;
  railHoverPending = true;
  requestAnimationFrame(() => {
    railHoverPending = false;
    if (!railInteractive || !railOn || !styleReady) return;
    const hit = railFeatureAt(railHoverPoint);
    setRailHover(map, hit);
    pointerOnRail = !!hit;
    syncPointer();
  });
}

/** Whatever is lit, unlit — and without asking a map that may no longer hold it. */
function clearRailHover() {
  if (styleReady && railOn) setRailHover(map, null);
  else forgetRailHover();
  pointerOnRail = false;
  syncPointer();
}

const dateShort = new Intl.DateTimeFormat(undefined, { month: 'short', year: 'numeric' });
const legendEndLabel = (sec) => (sec ? dateShort.format(new Date(sec * 1000)) : '');

// The Settings row for the 3D basemap, which is the only door in that list
// whose subtitle is a *state* rather than a description: whether there is a
// token is the whole question behind it, and someone who has already answered it
// should not have to open the dialog to be told so.
function updateMapboxNote() {
  const note = document.getElementById('settings-mapbox-note');
  if (note) note.textContent = hasMapboxToken() ? 'Mapbox token saved to your account' : 'Needs a Mapbox token';
}

/**
 * Everything that follows from the token changing, from wherever it changed —
 * the dialog on this device, or another device pushing one into the account.
 *
 * The basemap picker is the visible half: 3D stops being dimmed, or goes back to
 * being so. The invisible half is `gl.accessToken`, which Mapbox GL JS reads out
 * of a module global when it resolves the `mapbox://` URLs in Standard.
 * `loadEngine` sets it, and that only runs when the library is first reached
 * for — so replacing a revoked token while looking at the 3D map would otherwise
 * go on requesting tiles with the dead one.
 */
function mapboxTokenChanged() {
  if (engine === MAPBOX) gl.accessToken = mapboxToken();
  updateLayersUi(); // which calls updateMapboxNote() itself
  // …unless what just happened is that the token holding the basemap on screen
  // was taken away. Then there is nothing left to draw and the map has to be
  // moved off it — which, from 3D, is a rebuild onto the other library.
  if (!hasMapboxToken() && STYLES[styleKey]?.needsToken) setStyleKey('voyager');
}

// The time-of-day row under the basemap picker, which exists only while 3D is
// the basemap: it is Standard's own light preset, and no other basemap has a
// sun to move. Built once from LIGHT_CHOICES — auto and then the four suns —
// and shown or hidden by updateLayersUi().
const lightHead = document.getElementById('light-head');
const lightSeg = document.getElementById('light-seg');
// What Auto currently resolves to, in words, on the line under the row. The
// same idea as `detail-now` under the detail row and for the same reason: a
// choice that answers for itself has to say what it answered, or the button is
// a promise with no way to check it.
const lightNow = document.getElementById('light-now');

function buildLightRow() {
  if (!lightSeg) return;
  lightSeg.replaceChildren(...LIGHT_CHOICES.map((choice) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.light = choice.key;
    btn.textContent = choice.label;
    btn.addEventListener('click', () => setLightPresetNow(choice.key));
    return btn;
  }));
}
buildLightRow();

// Which of Waymarked Trails' five renderings is drawn, in the same shape as the
// light row above and for the same reason: it exists only while the thing it
// configures is on screen.
//
// **In the layers menu rather than in Settings**, which is the opposite of where
// the railway's eight controls ended up. That decision was about how the
// controls are *used*: you set what the railway draws once and then read the map,
// so a column of checkboxes in the middle of a menu you flick through was in the
// way. This is the other kind. Switching from hiking to cycling is a question
// about the view you ask while looking at it — the same kind of question as
// Detail or Color by, both of which are a segmented row here — and burying it two
// dialogs deep would mean closing the map to change what the map is showing.
const trailsSeg = document.getElementById('trails-seg');

function buildTrailsRow() {
  if (!trailsSeg) return;
  trailsSeg.replaceChildren(...TRAIL_THEMES.map((theme) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'seg-btn';
    btn.dataset.trail = theme.key;
    btn.textContent = theme.label;
    btn.addEventListener('click', () => setTrailThemeNow(theme.key));
    return btn;
  }));
}
buildTrailsRow();

/**
 * Move the sun, and everything that follows from where it is.
 *
 * Takes a *choice* rather than a preset — one of Standard's four, or `auto` —
 * and asks `lightPreset()` what that means, because auto is not a value the
 * renderer has ever heard of.
 */
function setLightPresetNow(choice) {
  setLightChoice(choice);
  const key = lightPreset();
  if (engine === MAPBOX && styleKey === 'mapbox') {
    try {
      map.setConfigProperty(BASEMAP_IMPORT, 'lightPreset', key);
    } catch (e) {
      console.warn('Mapbox light preset could not be applied.', e);
    }
    presumeChrome();
    // `syncAccent` first, for the case the theme flipped and the viewer keeps a
    // different accent for light and dark — and then the repaint by hand,
    // because it is not enough on its own here. It returns early when the accent
    // itself has not changed, which is exactly what happens when only the sun
    // moved: the colour is the same hex, and everything derived from it —
    // `lifted()`, the wash's alpha, the route's contrast mix — is not. Left to
    // syncAccent, dusk repainted nothing and the wash stayed at its daylight
    // strength on a map that had just gone dark.
    syncAccent();
    applyColors();
    applyFade(fade.cur);
    applyPrevFade(fade.prev);
    repaintAccent();
  }
  updateLayersUi();
}

/**
 * The word on the button, for a choice or for a preset.
 *
 * A declaration rather than a `const` arrow because `updateLayersUi` reads it
 * and is called from a great many places, some of which run while this module
 * is still being evaluated. A hoisted function is defined for all of them.
 */
function labelOfLight(key) {
  return LIGHT_CHOICES.find((c) => c.key === key)?.label ?? key;
}

// How often an app that is simply left open re-asks where the sun is.
//
// Ten minutes is well under the shortest thing being watched for: even at the
// equator, where twilight is quickest, `dusk` lasts about twenty-five minutes.
// The check itself is a dozen lines of trigonometry and reaches the renderer
// only when the answer has actually moved, so the cost of it running all
// evening is nothing at all — see `refreshAutoLight` in src/mapbox.js.
const SUN_CHECK_MS = 10 * 60 * 1000;

/**
 * Ask again what Auto means, and relight the map if the sky moved.
 *
 * Three things can change the answer and each of them calls this: the client's
 * position becoming known (which turns a time zone into a real latitude — see
 * `sunSite` in src/sun.js), the app being brought back to the front, and time
 * simply passing. On a viewer who chose a sun by hand it is a no-op, which is
 * why nothing here checks first.
 *
 * It goes through `setLightPresetNow` rather than setting the config property
 * itself, because half of what "the sun moved" means is not the sun: dusk turns
 * the whole map dark and the chrome, the wash and the routes all have to follow.
 */
function refreshLightNow() {
  if (refreshAutoLight().changed) setLightPresetNow(AUTO_LIGHT);
}

// Coming back to the app *is* opening it, on the two platforms this is mostly
// used on: a phone's browser tab is never closed and the Mac app is left
// running for weeks, so `visibilitychange` is the only event that means "here
// again" for either of them.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshLightNow();
});
setInterval(refreshLightNow, SUN_CHECK_MS);

function updateLayersUi() {
  updateMapboxNote();
  if (lightSeg && lightHead) {
    // Hidden rather than disabled on the other four: a control for a thing that
    // is not on the map is not a control, it is a question nobody asked.
    const on = styleKey === 'mapbox';
    lightHead.hidden = !on;
    lightSeg.hidden = !on;
    if (on) {
      const chosen = lightChoice();
      for (const btn of lightSeg.querySelectorAll('[data-light]')) {
        btn.classList.toggle('active', btn.dataset.light === chosen);
      }
    }
    if (lightNow) {
      // Only under Auto. Beside a sun somebody chose by hand the same sentence
      // would be reading the button back to them.
      const auto = on && lightChoice() === AUTO_LIGHT;
      lightNow.hidden = !auto;
      if (auto) lightNow.textContent = `${labelOfLight(lightPreset())} where you are, right now`;
    }
  }
  for (const btn of layersMenu.querySelectorAll('[data-style]')) {
    btn.classList.toggle('active', btn.dataset.style === styleKey);
    // Dimmed while it has no token, so the one basemap that can be unavailable
    // looks it before it is pressed.
    const gate = STYLES[btn.dataset.style]?.needsToken;
    btn.classList.toggle('needs-token', !!gate && !gate());
  }
  for (const btn of layersMenu.querySelectorAll('[data-heat]')) {
    btn.classList.toggle('active', cellsOn && btn.dataset.heat === heatMode);
  }
  document.getElementById('cells-off').hidden = cellsOn;
  const token = detailToken(detailLevel);
  for (const btn of layersMenu.querySelectorAll('[data-detail]')) {
    btn.classList.toggle('active', btn.dataset.detail === token);
  }
  updateDetailNow();
  railToggle.checked = railOn;
  trailsToggle.checked = trailsOn;
  // The theme row and the tap switch both belong to a layer that may not be
  // drawn, so they follow it on and off rather than sitting there greyed —
  // the same call the light row makes above.
  if (trailsSeg) {
    trailsSeg.hidden = !trailsOn;
    for (const btn of trailsSeg.querySelectorAll('[data-trail]')) {
      btn.classList.toggle('active', btn.dataset.trail === trailThemeOn);
    }
  }
  const trailsTapRow = document.getElementById('trails-tap-row');
  if (trailsTapRow) trailsTapRow.hidden = !trailsOn;
  trailsTapToggle.checked = trailsInteractive;
  airportsToggle.checked = airportsOn;
  updateRoutesUi();
  // Absent rather than disabled anywhere the host cannot answer, which is every
  // browser — see the note at the top of src/photos.js.
  photosRow.hidden = !photosAvailable();
  if (!photosRow.hidden) {
    photosToggle.checked = photosOn;
    document.getElementById('photos-note').textContent = photoNote();
  }
  cellsTapToggle.checked = cellsInteractive;

  // The picker only means anything in single-color mode, and nothing at all
  // while the cells are hidden — the note takes that slot instead.
  const heat = HEAT_MODES[heatMode];
  const colorRow = document.getElementById('color-row');
  colorRow.hidden = isHeatMode() || !cellsOn;
  // The swatch changes when you change basemap, and without a word for it that
  // reads as the colour having been lost rather than as the other one arriving.
  // A label rather than a tooltip: a phone has no hover, and this is the only
  // place the two are visible at all.
  colorRow.firstElementChild.textContent =
    themeNow() === 'light' ? 'Visited color · light map' : 'Visited color · dark maps';

  // Type has categories rather than a range: one swatch per source, ordered
  // the way the palette was handed out, so the list matches the map.
  const typeLegend = document.getElementById('type-legend');
  typeLegend.hidden = !heat.categorical || !cellsOn;
  if (heat.categorical && cellsOn) {
    typeLegend.replaceChildren();
    if (!sourceOrder.length) {
      const empty = document.createElement('span');
      empty.className = 'legend-empty';
      empty.textContent = 'Nothing on the map yet';
      typeLegend.append(empty);
    }
    const labels = sourceOrder.map(sourceLabel);
    // Two columns unless a name would be clipped to nothing in one; then give
    // every entry the full width rather than truncating half of them.
    typeLegend.classList.toggle('wide', labels.some((l) => l.length > 16));
    for (const [i, label] of labels.entries()) {
      const src = sourceOrder[i];
      const off = hiddenSources.has(src);
      // A button, because each entry is a switch — see toggleSource.
      const key = document.createElement('button');
      key.type = 'button';
      key.className = off ? 'legend-key off' : 'legend-key';
      key.dataset.source = src;
      // The title was already carrying the full name, which a narrow column
      // clips; what it does is on the end of it, because a swatch and a name
      // read as a legend and nothing else here says they can be pressed.
      key.title = off ? `${label} — hidden. Click to show` : `${label} — click to hide`;
      key.setAttribute('aria-pressed', String(!off));
      const dot = document.createElement('i');
      // A custom property rather than `background`, so the stylesheet can spend
      // the colour on an outline instead of a fill for a source that is off.
      dot.style.setProperty('--key-color', TYPE_COLORS[i] ?? TYPE_OTHER_COLOR);
      const name = document.createElement('span');
      name.textContent = label;
      key.append(dot, name);
      typeLegend.append(key);
    }
  }

  // A source stays off the map in every mode, and the legend above is the only
  // way back — so in the other three the button that leads to it is the only
  // sign that the map is not showing everything. A dot in its corner rather
  // than anything wider: the four of them already fill the row, and a control
  // that changes width when a filter is on moves under the hand reaching for it.
  const typeBtn = layersMenu.querySelector('[data-heat="type"]');
  typeBtn.dataset.baseTitle ??= typeBtn.title;
  typeBtn.classList.toggle('has-filter', hiddenSources.size > 0);
  typeBtn.title = hiddenSources.size
    ? `${typeBtn.dataset.baseTitle} · ${hiddenSources.size} source${hiddenSources.size === 1 ? '' : 's'} hidden, and this is the list`
    : typeBtn.dataset.baseTitle;

  // Legend: the ramp itself, plus what its ends stand for right now.
  const legend = document.getElementById('heat-legend');
  legend.hidden = !heat.ramp || !cellsOn;
  if (heat.ramp && cellsOn) {
    // background-image, not the `background` shorthand: the shorthand resets
    // background-repeat to `repeat`, and a tiled gradient wraps its ends around
    // into the bar's edges.
    document.getElementById('legend-bar').style.backgroundImage =
      `linear-gradient(90deg, ${heat.ramp.join(', ')})`;
    const r = litRange[Math.min(currentLevel ?? 0, MAX_LEVEL)] ?? {};
    let [lo, hi] = heat.legend;
    if (heatMode === 'visits') hi = `${(r.maxHits ?? 1).toLocaleString()} visits`;
    if (heatMode === 'oldest' && r.maxAge) {
      lo = legendEndLabel(r.minAge);
      hi = legendEndLabel(r.maxAge);
    }
    document.getElementById('legend-min').textContent = lo;
    document.getElementById('legend-max').textContent = hi;
  }
  // Let the CSS restyle the glass panels for light basemaps (dark text/glass)
  // so they don't become white-on-white.
  document.documentElement.dataset.theme = STYLES[styleKey].theme;
  // Rows just came and went — the legend, the Type list, the per-activity
  // controls. Whether the menu still fits is a different answer than it was.
  refreshMenuOverflow();
}

// Things that must be dismissed when the menu closes (the colour picker).
const menuClosers = [];

/**
 * Tell the menu whether it is currently taller than the room it has, and how
 * close to the bottom it is scrolled.
 *
 * The panel's height is worked out from the space that is free (see
 * `--menu-chrome` in style.css), so on any current phone the whole menu fits
 * and nothing scrolls. On a short screen — an SE, a laptop window dragged
 * small, a Type legend with a dozen sources — it genuinely cannot, and the clip
 * lands wherever it lands: usually part-way down a row, which reads as a
 * rendering fault rather than as "there is more below". The fade this drives is
 * the difference between those two readings, and it is only worth drawing when
 * there is really something under it.
 */
function refreshMenuOverflow() {
  // Looked up on the spot rather than held in a module-scope const. This is
  // called from updateLayersUi(), which is defined a hundred lines further up;
  // a const down here would sit in its temporal dead zone the moment anything
  // called that during start-up, and the failure would be a blank menu.
  const box = document.querySelector('.menu-scroll');
  if (!box) return;
  // Whichever way it actually runs off the edge. Downwards, normally — and
  // sideways on a screen that is short and wide, where the menu is laid out in
  // columns instead of one long strip (see the landscape block in style.css).
  // Measured rather than asked of the layout, so this cannot drift from the
  // breakpoint that decides it.
  const down = box.scrollHeight - box.clientHeight;
  const across = box.scrollWidth - box.clientWidth;
  const room = Math.max(down, across);
  const at = across > down ? box.scrollLeft : box.scrollTop;
  // A pixel of slack: sub-pixel layout leaves fractional remainders that would
  // otherwise keep the fade on a menu already scrolled to the end.
  box.classList.toggle('is-overflowing', room > 1);
  box.classList.toggle('is-at-end', room <= 1 || at >= room - 1);
}

const menuScroll = document.querySelector('.menu-scroll');
menuScroll?.addEventListener('scroll', refreshMenuOverflow, { passive: true });
// The box itself only resizes when the viewport does — it is capped, so rows
// arriving inside it change `scrollHeight` and nothing this could observe.
// `updateLayersUi()` is the other half, and it runs on every change that adds
// or removes a row.
if (menuScroll) new ResizeObserver(refreshMenuOverflow).observe(menuScroll);

function setMenuOpen(open) {
  layersMenu.hidden = !open;
  refreshChrome();
  if (!open) for (const close of menuClosers) close();
  // On phones the menu becomes a bottom sheet and the buttons underneath it
  // get out of the way.
  document.body.classList.toggle('menu-open', open);
  if (open) {
    updateLayersUi();
    refreshMenuOverflow();
  }
}

function wireLayersControl() {
  layersBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(layersMenu.hidden);
  });
  // Click-away closes the menu — but "away" has to be decided when the press
  // lands, not when the click resolves. A control inside the menu that redraws
  // its own row (the per-activity eye) detaches the very element that was
  // clicked, so by the time this handler runs `e.target` is an orphan and
  // `contains()` says false: the menu closed itself every time you toggled an
  // activity. Recording it on pointerdown, while the element is still in the
  // tree, is what makes that impossible.
  let pressedInsideMenu = false;
  document.addEventListener(
    'pointerdown',
    (e) => {
      pressedInsideMenu = layersMenu.contains(e.target) || layersBtn.contains(e.target);
      // And whether this press is spent closing the menu, which has to be
      // settled here for a second and less obvious reason: **MapLibre's click
      // fires first.** It listens on the canvas container, which is a
      // descendant of the document, so the map had already marked a cell by the
      // time the handler below could raise the flag — and the flag then ate the
      // *next* tap instead. One tap did the wrong thing and the one after it did
      // nothing, which is what "sometimes you can still select a cell" is.
      //
      // Assigned rather than only set, so a press that never resolves into a
      // click — a pan, a pinch, a tap on the sheet itself — cannot leave it
      // standing for whatever comes later.
      dismissedMenuOnTap = !layersMenu.hidden
        && !pressedInsideMenu
        && coarsePointer.matches
        && map.getCanvasContainer().contains(e.target);
    },
    true,
  );
  document.addEventListener('click', (e) => {
    if (layersMenu.hidden || pressedInsideMenu) return;
    if (layersMenu.contains(e.target) || layersBtn.contains(e.target)) return;
    setMenuOpen(false);
  });
  for (const btn of layersMenu.querySelectorAll('[data-style]')) {
    btn.addEventListener('click', () => setStyleKey(btn.dataset.style));
  }
  for (const btn of layersMenu.querySelectorAll('[data-heat]')) {
    btn.addEventListener('click', () => setHeatMode(btn.dataset.heat));
  }
  for (const btn of layersMenu.querySelectorAll('[data-detail]')) {
    btn.addEventListener('click', () => setDetailLevel(detailFromToken(btn.dataset.detail)));
  }
  // Delegated, unlike the three above: the Type legend's entries are rebuilt
  // every time the menu is refreshed, so a listener per entry would be wired
  // again on every pan that changes the detail level.
  document.getElementById('type-legend').addEventListener('click', (e) => {
    const key = e.target.closest('[data-source]');
    if (key) toggleSource(key.dataset.source);
  });
  railToggle.addEventListener('change', () => setRail(railToggle.checked));
  trailsToggle.addEventListener('change', () => setTrails(trailsToggle.checked));
  trailsTapToggle.addEventListener('change', () => setTrailsInteractive(trailsTapToggle.checked));
  airportsToggle.addEventListener('change', () => setAirports(airportsToggle.checked));
  photosToggle.addEventListener('change', () => setPhotos(photosToggle.checked));
  cellsTapToggle.addEventListener('change', () => setCellsInteractive(cellsTapToggle.checked));
  document.getElementById('home-pick-cancel').addEventListener('click', () => endHomePick(false));
  document.getElementById('home-pick-ok').addEventListener('click', () => endHomePick(true));
  // The introduction's own bar. The same two answers to the same question — it
  // is `endHomePick` that knows which bar to put away.
  document.getElementById('intro-pick-cancel').addEventListener('click', () => endHomePick(false));
  document.getElementById('intro-pick-ok').addEventListener('click', () => endHomePick(true));
  document.getElementById('route-solo-clear').addEventListener('click', () => {
    setSoloRoute(null);
    routeInfo?.setSolo(false);
  });
  document.getElementById('trip-chip-clear').addEventListener('click', () => showTrack(null));
  document.getElementById('routes-toggle').addEventListener('change', (e) => setRoutesOn(e.target.checked));
  document.getElementById('routes-options-toggle').addEventListener('click', () => {
    routeOptionsOpen = !routeOptionsOpen;
    renderRouteOptions();
  });
  document.getElementById('rail-bar-dismiss').addEventListener('click', () => {
    railTroubleDismissed = true;
    showRailTrouble(null);
  });
  document.getElementById('edit-toggle').addEventListener('change', (e) => setEditUi(e.target.checked));

  // The menu used to carry an "i" beside almost every row, each opening a
  // paragraph in a floating popover. Eleven of them made a short panel look
  // like documentation, and the one that was actually worth reading — what
  // importing does to your files — is now in the import dialog itself, where
  // the question comes up. The rest were explaining controls that say what
  // they do.
  //
  // The colour picker still floats, and it is still anchored to a row inside
  // the scroll area, so a scroll would leave it pointing at nothing.
  layersMenu.querySelector('.menu-scroll')?.addEventListener('scroll', () => colorPicker?.close());
  menuClosers.push(() => colorPicker?.close());

  updateLayersUi();
}

// --- Layer setup (re-runs on every style load) -------------------------------
// setStyle() replaces the whole style, dropping our sources/layers, so this
// runs again after each basemap switch to rebuild them and restore state.
// Above the basemap's own railways, which is the whole point of the overlay:
// OpenRailwayMap draws the sidings, yards and freight-only lines a basemap
// leaves out, and underneath CARTO's `rail` it was answering a question with the
// less detailed answer on top of it. It used to anchor to `tile-fill`, which put
// it under the visited wash as well.
//
// Not all the way up, though: it lands exactly where a saved route lands, and
// then under the routes themselves — a line you actually travelled beats
// reference geometry about where a line exists. `labelStart()` is the same
// anchor they use, so switching the overlay on cannot reorder anything relative
// to them; it only fills the gap directly beneath.
//
// Both therefore draw over the basemap's own labels, which on CARTO are all
// below this point. That is already true of every route on the map, and an
// overlay you switched on is meant to be the thing you are reading.
const RAIL_BEFORE = () => (map.getLayer('route-glow') ? 'route-glow' : labelStart());

// The same slot, and therefore above the railways rather than below them —
// `addLayer(l, before)` inserts immediately beneath `before`, so whichever
// installs last sits on top of the other, and `syncAirportLayer` runs after
// `syncRailLayer`. That is the right way round: an airport is one icon standing
// for a place, a railway is a network of lines, and a line drawn over a symbol
// is what makes the symbol unreadable rather than the other way about. Both
// still go under the saved routes, for the reason the railways do — a line you
// actually travelled beats reference geometry about what exists.
const AIRPORT_BEFORE = () => (map.getLayer('route-glow') ? 'route-glow' : labelStart());

// The trails take the same anchor as both, and land *under* them — `syncTrailLayer`
// runs before the other two in installGrid, and `addLayer(l, before)` inserts
// immediately beneath `before`, so whichever installs last sits on top.
//
// That is the order these three want, and the reason is what each one is made
// of. This is a **sheet of pixels**: it covers what it is drawn over rather than
// threading between it, so an airport icon or a station symbol underneath it is
// simply gone. The other two are lines and symbols with transparent ground
// between them, and they lose nothing by being on top of a picture. Put the
// other way round, the rule is: the opaque thing goes at the bottom.
const TRAILS_BEFORE = () => (map.getLayer('route-glow') ? 'route-glow' : labelStart());

// The photographs, on the other hand, go *above* the saved routes — the only
// overlay that does. The reasoning that keeps the other two underneath is that a
// line you actually travelled beats reference geometry about what exists; a
// photograph is not reference geometry, it is the same kind of fact as the
// route, and it is a dot. A 7 px dot under a 12 px glow is a dot you cannot see
// and cannot tap, and the tap order in the click handler agrees: smallest target
// first.
//
// Anchored on the **place pin** rather than on `labelStart()`, which is what
// everything else here anchors on and is the wrong question for this one.
// `labelStart()` is where the *basemap's* place names begin, and above that
// point sit the trip track, the place pin, the home marker and the selection
// ring — all of them ours, none of them something a photograph should cover.
// Measured, not reasoned about: anchored on the labels, every photograph was
// drawn over the marker you navigate by and over the ring around the cell you
// had just clicked.
//
// Those markers are precisely what this has to stay under, so naming the first
// of them says it directly and cannot drift. It lands immediately above the
// saved routes, which is where it was always meant to be.
const PHOTO_BEFORE = () => (map.getLayer('place-pin') ? 'place-pin' : labelStart());
let firstInstall = true;

// How deep the server says each of OpenRailwayMap's sources can currently be
// asked for. Empty means "whatever the style says", which is the answer
// whenever they are healthy.
let railDetailCeilings = {};
// The language the proxy is asking OpenRailwayMap for, as the proxy reports it.
// Held only to be put back in the tile URL — see the note in installRail: it is
// the browser's HTTP cache this is for, not the server's.
let railTileLang = null;
// While the overlay is on, ask again on this cadence: a ceiling that dropped
// during an outage has to be able to climb back on its own, and the only way to
// notice is to look. Slow enough to be free, quick enough that the detail
// returns within a few minutes of their server doing so.
const RAIL_DETAIL_POLL_MS = 3 * 60 * 1000;
let railDetailTimer = null;

// **And ask straight away when tiles start failing.** The poll above is for
// noticing that things got *better*, which nothing on this side can predict. It
// is far too slow for the other direction: their cache coverage is geographic,
// so panning into a valley whose tiles nobody has warmed turns the railways off
// instantly, and waiting three minutes for the ceiling to catch up is
// indistinguishable from it not working. MapLibre reports every failed tile, so
// a failure on one of our sources schedules a check — debounced, because a
// viewport fails a dozen tiles at once, and rate-limited so a sustained outage
// cannot turn this into its own poll.
// The ceiling can only ever step down one zoom per check, because it is only
// ever as good as the evidence, and the evidence for "z12 is bad too" does not
// exist until z12 has been asked for. Somewhere like Frutigen — where their
// cache has nothing below z11 — that is three steps, so the gap between checks
// is what decides whether the railways come back in four seconds or a minute.
// `railLastFailureCheck` is reset whenever a check actually moved the ceiling,
// so a descent runs at the short interval and only settles to the long one once
// it has found a zoom that works.
const RAIL_FAILURE_CHECK_MS = 1200;
const RAIL_FAILURE_MIN_GAP_MS = 15000;
let railFailureTimer = null;
let railLastFailureCheck = 0;

function noteRailTileFailure() {
  if (!railOn || railFailureTimer) return;
  const wait = Math.max(RAIL_FAILURE_CHECK_MS, RAIL_FAILURE_MIN_GAP_MS - (Date.now() - railLastFailureCheck));
  railFailureTimer = setTimeout(() => {
    railFailureTimer = null;
    railLastFailureCheck = Date.now();
    syncRailDetail().catch(() => {});
  }, wait);
}

function addRailLayer() {
  // Our own ids, asked for by our own names — not "does a source called rail
  // exist". CARTO's styles ship a layer *called* `rail` (their own railway
  // lines, drawn from the basemap's transportation source), so on any basemap
  // built from them `getLayer('rail')` answered yes about somebody else's
  // layer and this returned having added nothing. The overlay simply stopped
  // existing when you switched to Light or Dark, while every check said it was
  // fine. Namespacing ours puts the question beyond doubt.
  installRail(map, {
    // Whatever upright stack the basemap's own glyph server serves. Their style
    // asks for fonts only their glyph server has, and a style has one glyphs
    // URL — see the note in src/rail.js.
    font: styleFont(),
    theme: STYLES[styleKey].theme,
    before: RAIL_BEFORE(),
    // The fast path reaches past Map.addLayer, and on Mapbox that is where the
    // slot translation and the global-state resolution live. See addLayers().
    fastAdd: engine !== MAPBOX,
    groups: railGroupsOn,
    technical: railTechnicalOn,
    detail: railDetailCeilings,
    lang: railTileLang,
  });
}

/**
 * Keep the overlay's detail in step with what their server can actually serve.
 *
 * A ceiling only ever arrives from evidence — tiles that were asked for and
 * failed — so the first pass after switching on is uncapped, and a cap appears a
 * moment later if the deeper zooms turn out to be unavailable. When it changes
 * in either direction the overlay is rebuilt, because a source's `maxzoom` is
 * fixed once MapLibre has it.
 */
async function syncRailDetail() {
  if (!railOn) return;
  const { detail, degraded, lang } = await railDetail();
  if (!railOn) return;
  showRailTrouble(degraded);
  // The language is in the tile URL, so a server that has changed it needs the
  // sources rebuilt exactly as a moved ceiling does — a live source's tile
  // template is no more settable than its `maxzoom`.
  const langMoved = lang !== railTileLang;
  if (!langMoved && !railDetailChanged(railDetailCeilings, detail)) return;
  railDetailCeilings = detail;
  railTileLang = lang;
  if (!styleReady) return;
  // Rebuilt rather than adjusted: `maxzoom` is not settable on a live source.
  // The sprites stay — see removeRail for why taking them out here blanks the
  // entire map for as long as the atlases take to come back.
  removeRail(map, { keepSprites: true });
  addRailLayer();
  // Still descending. The layers just re-added will ask at the new ceiling, and
  // if that fails too the next check should follow immediately rather than
  // waiting out the rate limit meant for a steady state.
  railLastFailureCheck = 0;
}

// --- "OpenRailwayMap is having trouble" ----------------------------------------
// The same shape as the offline banner and deliberately not the same colour:
// that one is red because your edits are not being saved, and this one is not,
// because nothing of yours is at risk. A third-party layer you switched on is
// incomplete, and the only thing worth saying is that the gap is theirs and not
// a bug in your map. Dismissible, and it stays dismissed for the session — being
// told twice about somebody else's outage is worse than not being told.
let railTroubleDismissed = false;

function showRailTrouble(degraded) {
  const bar = document.getElementById('rail-bar');
  if (!bar) return;
  if (!degraded || railTroubleDismissed || !railOn) {
    bar.hidden = true;
    return;
  }
  document.getElementById('rail-bar-detail').textContent =
    `OpenRailwayMap is not answering for ${degraded.share}% of the map right now.`;
  bar.hidden = false;
}

function startRailDetailPolling() {
  if (railDetailTimer) return;
  railDetailTimer = setInterval(() => { syncRailDetail().catch(() => {}); }, RAIL_DETAIL_POLL_MS);
}

function stopRailDetailPolling() {
  clearInterval(railDetailTimer);
  railDetailTimer = null;
  clearTimeout(railFailureTimer);
  railFailureTimer = null;
}

// Every tile MapLibre could not load says which source it belonged to.
onMapBuilt(() => map.on('error', (e) => {
  if (String(e?.sourceId ?? '').startsWith('hexplore-orm-')) noteRailTileFailure();
}));

// Where the basemap's labels begin — the layer to sit *under* if you want to be
// above every road, water and boundary but still let the place names win.
//
// `washAnchorIn()` is not that place: it lands below every street, which is
// exactly right for the visited wash — tinted ground with the streets drawn on
// top of it — and exactly wrong for a route, which came out chopped into dashes
// wherever a road casing crossed it.
//
// **Read before a single layer of ours goes in, and held for that style.** The
// scan below looks for the bottom of the topmost run of symbol layers, which is
// a question about the *basemap*, and `map.getStyle()` answers it about whatever
// is on the map right now. The trip track is added on top of the whole style on
// purpose, and its topmost layer is a circle — so a scan run after it stopped at
// the first layer from the top, found no symbol, and answered "nowhere at all".
// Everything anchored on it then went above the place names instead of below
// them, which is how the saved routes came to be drawn straight across BERN.
// Only on the MapLibre basemaps: Standard answers with a slot and never scans.
let basemapLabelStart;

function readLabelStart() {
  // Standard keeps its layers inside an import, so there is nothing to scan and
  // nothing to name. It answers the same question with a slot instead, which is
  // the better answer: a promise about position that survives Mapbox reordering
  // the style, where a `beforeId` is a guess that a layer id still means what it
  // meant. See src/gl-engine.js.
  if (engine === MAPBOX) return LABEL_SLOT_ID;
  const layers = map.getStyle().layers;
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].type !== 'symbol') return layers[i + 1]?.id;
  }
  return undefined;
}

const labelStart = () => basemapLabelStart;

/** The same question for the visited wash — see washAnchorIn() in basemap.js. */
function washAnchor() {
  return engine === MAPBOX ? WASH_SLOT_ID : washAnchorIn(map.getStyle().layers);
}

// Whatever fontstack the basemap already asks its own glyph server for.
// Hardcoding one breaks half the basemaps — CARTO serves Open Sans and
// OpenFreeMap serves Noto Sans, and a fontstack the server has never heard of
// is a label that silently never draws.
//
// Not simply the first one: CARTO's first symbol layer is a waterway name, so
// taking it handed the continent counts an *italic* stack. Water and terrain
// labels are the ones styles set in italic, and there is always an upright
// stack further down the list.
// Standard's fontstack. Named rather than discovered for the same reason
// labelStart() is: there are no layers to read it off. This is the stack every
// published Mapbox style asks for, and their glyph server is the one being
// asked, so it is not the guess it would be against anybody else's.
const MAPBOX_FONT = ['DIN Pro Regular', 'Arial Unicode MS Regular'];

function styleFont() {
  if (engine === MAPBOX) return MAPBOX_FONT;
  const stacks = [];
  for (const l of map.getStyle().layers) {
    const font = l.layout?.['text-font'];
    if (Array.isArray(font) && font.every((f) => typeof f === 'string')) stacks.push(font);
  }
  const upright = stacks.find((s) => !s.some((f) => /italic|oblique/i.test(f)));
  return upright ?? stacks[0] ?? ['Open Sans Regular'];
}

// The basemap's own continent names, so they can be switched off at the level
// where ours replace them. Cached per style rather than looked up each time:
// map.getStyle() serializes every layer, and this is asked on a zoom crossing.
// CARTO calls the layer `place_continent` and OpenFreeMap `continent`, so the
// match is on the substring.
let continentLabelLayers = [];
let basemapContinentsOn = true;

/**
 * At the continent level the counts *are* the continent labels — they carry the
 * name and the number both — so the basemap's own are taken off rather than
 * drawn a centimetre away saying half as much. Collision alone doesn't do it:
 * ours only pushes out a label it actually overlaps, and "AFRICA" sitting just
 * above "Africa · 1 country" overlaps nothing.
 */
function setBasemapContinents(on) {
  if (on === basemapContinentsOn || !continentLabelLayers.length) return;
  basemapContinentsOn = on;
  for (const id of continentLabelLayers) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}

// The continent counts, in the accent lifted toward whichever end of the
// contrast the basemap leaves free — the same treatment the selection ring
// gets, so the two read as the same ink. The halo is the basemap's own tone
// rather than the accent's: it is there to cut the text out of a coastline, and
// a coloured halo would tint the shape underneath.
const labelColors = () =>
  STYLES[styleKey].theme === 'light'
    ? { 'text-color': mixWithBlack(accent, 0.55), 'text-halo-color': 'rgba(255, 255, 255, 0.85)', 'text-halo-width': 1.6 }
    : { 'text-color': mixWithWhite(accent, 0.8), 'text-halo-color': 'rgba(10, 12, 18, 0.75)', 'text-halo-width': 1.6 };

function installGrid() {
  styleParsed = true; // whatever is in place now has parsed; see styleSettled
  // Where the sun is, and whether the ground has shape. Both are Standard's own
  // config rather than anything this app draws, so they are set before a single
  // layer of ours goes in — a light preset arriving after the wash would relight
  // the map underneath a colour already chosen for the old one.
  if (engine === MAPBOX) configureStandard(map);
  // A style swap takes the snow with it, so this is asked again on every parse
  // rather than once at startup — and the remembered answer is cleared first,
  // because what it describes is a map that no longer exists.
  snowOn = null;
  refreshSnow();
  // Both anchors are read here, before anything of ours is on the map, because
  // both are questions about the basemap and both are asked of the live style.
  // Over the ground, under the streets and rooftops — see washAnchor().
  const washBefore = washAnchor();
  basemapLabelStart = readLabelStart(); // …and under the place names — see labelStart().
  const lineLayout = { 'line-join': 'round', 'line-cap': 'round' };
  // The glow is the same line six times as wide, and a round join is the one
  // thing that does not scale with it. A round join fills the outside of a
  // corner with a fan of triangles that overlap each other and the two segments
  // meeting there; on an opaque stroke that is invisible, and on a translucent
  // one every overlap composites twice. At a switchback — where a track doubles
  // back on itself and the fan sweeps most of a half-circle — the doubled
  // coverage reads as a hard-edged wedge sticking out of the route, in a colour
  // neither the glow nor the line has. A bevel is one triangle and overlaps
  // nothing, so the corner is chamfered instead: invisible inside a blur, where
  // the spike was not.
  const glowLayout = { ...lineLayout, 'line-join': 'bevel' };
  const isRegion = ['==', ['get', 'k'], 1];
  const isBoundary = ['==', ['get', 'k'], 2];
  const isLabel = ['==', ['get', 'k'], 3];
  const boundLineColor = mixWithWhite(accent, 0.45);
  const tc = tileColors();
  // Text needs glyphs, and the placeholder style the map opens on while a built
  // basemap is being fetched has none. Adding the layer anyway would ask a
  // glyph server that isn't there for a font it doesn't have, once per label.
  // Standard declares no `glyphs` of its own — the import carries it — but its
  // glyph server is Mapbox's and MAPBOX_FONT is what it serves, so labels are
  // always available there.
  const canLabel = engine === MAPBOX || !!map.getStyle().glyphs;
  // A new style brings its own continent names back, visible. Empty on Standard:
  // the layers are inside the import and cannot be addressed, so at the
  // continent level its names and our counts are both drawn. Ours collide-and-
  // win where they overlap, which leaves the basemap's showing beside them —
  // untidy, and the only thing lost by not owning the layer list.
  continentLabelLayers = canLabel && engine !== MAPBOX
    ? map.getStyle().layers.filter((l) => l.type === 'symbol' && /continent/i.test(l.id)).map((l) => l.id)
    : [];
  basemapContinentsOn = true;

  // Tile spotlight (below the region layers).
  map.addSource('tiles', { type: 'geojson', data: EMPTY, promoteId: 'id', tolerance: 0 });
  map.addLayer({
    id: 'tile-fill', type: 'fill', source: 'tiles',
    paint: { 'fill-color': tc.fill, 'fill-opacity': tileFillOpacity(), 'fill-antialias': true },
  }, washBefore);
  map.addLayer({
    id: 'tile-line', type: 'line', source: 'tiles', layout: lineLayout,
    paint: { 'line-color': tc.line, 'line-opacity': tileLineOpacity(), 'line-width': tileLineWidth, 'line-blur': 0.4 },
  }, washBefore);

  // Blob canvases sit between the tiles and the vector region layers; only one
  // of the two paths carries the current level at a time.
  if (BLOBS) {
    blobCur.install(washBefore, 0);
  }

  // Where the vector layers are inserted, kept for raiseVectorLayers().
  vecInsertBefore = washBefore;
  for (const suffix of ['-prev', '']) {
    const src = `hex${suffix}`;
    // A style swap recreates the sources empty, so forget what the old ones
    // held — including any pre-warmed country geometry, which is gone with them.
    if (suffix === '') {
      // A style swap recreates every source empty, so forget what they held —
      // including any pre-warmed geometry, which is gone with them. blobRole
      // has to go back too: a basemap change mid-crossfade would otherwise
      // leave it stale, and both ramps branch on it.
      vecHeld[''] = EMPTY;
      vecHeld['-prev'] = EMPTY;
      vecRole[''] = 'in';
      vecRole['-prev'] = 'idle';
      vecLive = '';
      blobRole = 'none';
      fedFine = false;
    }
    // The attribution control reads this off the source, which is also the only
    // safe place to set it — poking the live source object and firing a
    // synthetic 'data' event to make the control re-read it corrupts MapLibre's
    // internal state and throws on the next jumpTo.
    //
    // Credited unconditionally rather than only once detailed boundaries are on
    // screen: they are a source this map draws from, and a credit that appears
    // and disappears with the zoom is worse than one that is simply always
    // there.
    map.addSource(src, {
      type: 'geojson',
      data: EMPTY,
      tolerance: 0,
      attribution: REGION_ATTRIB,
    });
    map.addLayer({
      // Fill layers render LineStrings too (implicitly closed) — filter to
      // the k=1 polygons or the k=2 outline gets double-filled per tile.
      id: `hex-fill${suffix}`, type: 'fill', source: src, filter: isRegion,
      paint: { 'fill-color': heatColorExpr(), 'fill-opacity': 0, 'fill-antialias': true },
    }, washBefore);
    map.addLayer({
      id: `hex-bound-glow${suffix}`, type: 'line', source: src, filter: isBoundary, layout: lineLayout,
      paint: { 'line-color': hexOpaque(accent), 'line-opacity': 0, 'line-width': boundGlowWidth, 'line-blur': 5 },
    }, washBefore);
    map.addLayer({
      id: `hex-bound-line${suffix}`, type: 'line', source: src, filter: isBoundary, layout: lineLayout,
      paint: { 'line-color': boundLineColor, 'line-opacity': 0, 'line-width': boundLineWidth, 'line-blur': 0.4 },
    }, washBefore);
    // How many countries of each continent — the whole reason that level is
    // there.
    //
    // No `beforeId`, unlike the three layers above it: at this zoom the basemap
    // writes its own "EUROPE" a few hundred kilometres from ours, and the two
    // landed on top of each other. MapLibre places symbols from the top layer
    // down, so being above the basemap's labels is what lets ours go first —
    // and `ignore-placement: false` is what then pushes the basemap's own
    // continent name out of the way. `allow-overlap: true` on top of that means
    // ours is never the one dropped: it is the answer the level exists to give,
    // and there are at most seven of them.
    //
    // It lands under the trip track and home, which are added after it — and
    // raiseVectorLayers puts it back in exactly this spot after a crossing,
    // because VEC_ANCHOR is that same trip track.
    if (canLabel) {
      map.addLayer({
        id: `hex-label${suffix}`, type: 'symbol', source: src, filter: isLabel,
        layout: {
          // Two sizes rather than two fontstacks: the name is the heading and
          // the count is the reading, and one stack means one glyph fetch.
          'text-field': [
            'format',
            ['get', 'name'], {},
            '\n', {},
            ['get', 'count'], { 'font-scale': 0.85 },
          ],
          'text-font': styleFont(),
          'text-size': ['interpolate', ['linear'], ['zoom'], 1, 13, 2.5, 17],
          'text-line-height': 1.35,
          'text-letter-spacing': 0.02,
          'text-allow-overlap': true,
          'text-ignore-placement': false,
        },
        paint: { 'text-opacity': 0, ...labelColors() },
      });
    }
  }

  // The trip (or day) you picked, drawn over everything else as the track it
  // was: a dot per cell, threaded in the order they were first seen. This used
  // to be a 16% wash over the same hexagons, which was legible only against a
  // dark basemap and said nothing about direction. Solid dots with a dark rim
  // read on all five basemaps, including a photograph.
  //
  // No `beforeId` on any of the three: what a day or a trip actually was is the
  // one thing on screen you asked to see, so it goes over the basemap's own
  // buildings and labels rather than under them. Home is added after this and
  // so stays above it — the marker you navigate by should not be buried under
  // the answer to a different question.
  map.addSource('trip', { type: 'geojson', data: EMPTY, tolerance: 0 });
  map.addLayer({
    id: 'trip-glow', type: 'line', source: 'trip', layout: glowLayout,
    paint: { 'line-color': TRACK_COLOR, 'line-opacity': 0.4, 'line-width': 9, 'line-blur': 7 },
  });
  map.addLayer({
    id: 'trip-link', type: 'line', source: 'trip', layout: lineLayout,
    paint: { 'line-color': TRACK_COLOR, 'line-opacity': 0.85, 'line-width': TRACK_LINK_WIDTH },
  });
  map.addLayer({
    id: 'trip-dot', type: 'circle', source: 'trip',
    paint: {
      'circle-color': TRACK_COLOR,
      'circle-radius': TRACK_DOT_RADIUS,
      // A rim, not a halo: at the zoom where a day's cells are 900 m apart the
      // dots are separate and the rim gives them an edge over pale ground; at
      // the zoom where a fortnight fits on screen they overlap into a bead
      // chain and the rim is what stops it reading as one smear.
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 0.8, 12, 1.6],
      'circle-stroke-color': 'rgba(14, 16, 22, 0.75)',
    },
  });

  // Saved routes go above the regions *and* above the basemap's own lines: a
  // line you actually walked reading as if it ran under the streets looks like
  // a bug. `promoteId` makes the route's own id the feature id, so the selected
  // one can be widened through feature-state instead of a second layer.
  const beforeLabels = labelStart();
  // `tolerance` rather than the 0.375 px default, and it is the one thing
  // standing between the glow and a row of spikes — see ROUTE_SIMPLIFY_PX.
  map.addSource('routes', {
    type: 'geojson', data: EMPTY, promoteId: 'id', tolerance: ROUTE_SIMPLIFY_PX,
  });
  // Under both of the real ones, and only where there are buildings to hide
  // behind — see ROUTE_GHOST_OPACITY.
  if (engine === MAPBOX) {
    map.addLayer({
      id: ROUTE_GHOST_ID, type: 'line', source: 'routes',
      layout: { ...lineLayout, visibility: routesOn ? 'visible' : 'none' },
      paint: {
        'line-color': routeLineColor(),
        // Flat, and that is the whole reason this layer exists.
        'line-opacity': ROUTE_GHOST_OPACITY,
        'line-occlusion-opacity': 1,
        'line-width': routeWidth(1),
      },
    }, beforeLabels);
  }
  map.addLayer({
    id: 'route-glow', type: 'line', source: 'routes',
    layout: { ...glowLayout, visibility: routesOn ? 'visible' : 'none' },
    paint: {
      'line-color': routeGlowColor(),
      'line-opacity': routeGlowOpacity(),
      'line-width': routeWidth(glowScale(), ROUTE_HOVER_SCALE),
      // The same ramp as the width, scaled down — so the edge stays the same
      // share of the glow however wide the glow currently is. See
      // ROUTE_GLOW_EDGE.
      'line-blur': routeWidth(glowScale() * ROUTE_GLOW_EDGE, ROUTE_HOVER_SCALE),
      // The whole of the hover animation. Both properties are feature-state
      // expressions, so writing `hov` is enough to start them — nothing here
      // steps a value or holds a timer.
      'line-opacity-transition': { duration: ROUTE_HOVER_MS },
      'line-width-transition': { duration: ROUTE_HOVER_MS },
    },
  }, beforeLabels);
  map.addLayer({
    id: 'route-line', type: 'line', source: 'routes',
    layout: { ...lineLayout, visibility: routesOn ? 'visible' : 'none' },
    paint: {
      'line-color': routeLineColor(),
      'line-opacity': routeLineOpacity(),
      'line-width': routeWidth(1),
    },
  }, beforeLabels);

  // Where the trips are measured from. Off by default, and on top of the whole
  // stack when it is on — no `beforeId`, unlike everything else here. It is one
  // point on a map that may have a country's worth of ink and a basemap's worth
  // of labels on it, and a marker you have to hunt for is not a marker. Only the
  // selection ring goes above it, and a ring you asked for around a cell you
  // just clicked is not something home needs to win against.
  addHomeImage();
  map.addSource('home', { type: 'geojson', data: EMPTY, tolerance: 0 });
  // Just the house. It used to sit on a coloured disc, which made a marker you
  // could not miss and also could not see past — on a map this is one point
  // among a country's worth of ink, and it only has to be findable, not loud.
  // The pin for a searched place. Below home for the same reason the highlight
  // is: home is where you navigate from, and it should never be the thing that
  // disappeared under an answer.
  addPlaceImage();
  map.addSource('place', { type: 'geojson', data: EMPTY, tolerance: 0 });
  map.addLayer({
    id: 'place-pin', type: 'symbol', source: 'place',
    layout: {
      'icon-image': PLACE_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.75, 12, 1],
      'icon-anchor': 'bottom',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  map.addLayer({
    id: 'home-icon', type: 'symbol', source: 'home',
    layout: {
      'icon-image': HOME_ICON,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 12, 1],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
  });

  // Highlight ring for the cell being inspected in view mode. No `beforeId`, so
  // it is added last and sits over everything — the basemap's buildings and
  // labels included.
  //
  // It used to anchor inside the basemap alongside the visited wash, which meant
  // the ring around the cell you had just clicked ran *under* the rooftops in
  // it, and in a dense town there was nothing left of the ring to see. A 2 px
  // ring occludes almost nothing, and it only exists while you are looking at
  // that one cell.
  map.addSource('sel', { type: 'geojson', data: EMPTY, tolerance: 0 });
  // Two lines, dark under light, for the same reason the house and the place pin
  // are stroked twice: nothing one colour can be seen against both this map's own
  // ink and a basemap of pale green fields.
  //
  // It was one line, tinted 75 % toward white from the accent — and the tint was
  // the problem rather than the fix. A selection is not a colour the map is
  // saying something with; it is the answer to "this one", and it has to read
  // over the accent-coloured wash, over pale green fields and over a photograph.
  // Following the accent meant it disagreed with the wash by a few percent of
  // lightness and vanished into it, and pinning it near-white so it wouldn't
  // left a hairline nothing could see over bright terrain. White over near-black
  // owes nothing to either, and the casing is what buys the visibility — so the
  // white line itself stays as fine as it ever was. A canton's border traced in
  // a 4 px rope is a different kind of wrong from one you cannot find.
  map.addLayer({
    id: 'sel-halo', type: 'line', source: 'sel', layout: lineLayout,
    paint: {
      'line-color': SEL_CASING,
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 3.6, 17, 5.4],
    },
  });
  map.addLayer({
    id: 'sel-line', type: 'line', source: 'sel', layout: lineLayout,
    paint: {
      'line-color': SEL_COLOR,
      'line-width': ['interpolate', ['linear'], ['zoom'], 2, 1.7, 17, 2.7],
    },
  });

  styleReady = true;
  // First of the three reference overlays, which is what puts it underneath the
  // other two — see TRAILS_BEFORE for why a sheet of pixels belongs at the
  // bottom of them.
  syncTrailLayer();
  syncRailLayer();
  // After the railways, which is what puts the airports above them — see
  // AIRPORT_BEFORE.
  syncAirportLayer();
  // And the photographs above the routes, which is a different anchor rather
  // than a matter of order — see PHOTO_BEFORE.
  syncPhotoLayer();
  syncHomeMarker();
  // A style rebuild dropped the sources above and re-created them empty, so
  // anything the page was already showing has to be put back. The chip never
  // went away, and a chip that says "Showing Arth" over an empty map is worse
  // than no chip at all.
  if (shownTrack) showTrack(shownTrack);
  if (placePin) showPlacePin(placePin);

  // Repopulate geometry for the new style and restore the current opacities.
  applyColors();
  applyTileVis();
  updateGrid(true);
  updateTiles();
  updateSelection();
  syncRoutes();
  if (firstInstall) {
    firstInstall = false;
    animateFade(0, 1, 0, 0, 800); // gentle first reveal
  } else {
    applyFade(fade.cur);
    applyPrevFade(fade.prev);
  }
}

// 'style.load' fires as soon as the style JSON is ready — before every tile —
// and again after each setStyle().
onMapBuilt(() => map.on('style.load', installGrid));

// The saved basemap may be one that has to be built (fetched and recoloured),
// which the constructor above could not wait for.
//
// Both waits matter. The build has to finish, obviously — but so does the
// placeholder's own load: calling setStyle() while a style is still loading
// makes MapLibre log "Unable to perform style diff … Rebuilding the style from
// scratch" and land in a state where the new sources are registered but nothing
// draws. The map came up as a single flat colour with no tiles and no routes.
if (STYLES[styleKey].build) {
  const wanted = styleKey;
  Promise.all([
    resolveStyle(wanted),
    styleSettled(),
  ]).then(([style]) => {
    if (style && styleKey === wanted) {
      styleReady = false;
      swapStyle(style);
    }
  });
}

// --- Interaction wiring --------------------------------------------------------
//
// This block used to be headed "bound once; map + DOM persist across setStyle",
// and that was true for as long as there was only ever one map. It stopped being
// true when the 3D basemap arrived: switching between the two map libraries
// **replaces the map object**, and a handler bound to the old one goes with it.
//
// The DOM half is still bound once — those elements outlive any map. The map
// half goes through `onMapBuilt`, which says it again to whichever map is
// current. Missing that cost two bugs that looked unrelated: routes stopped
// answering a click after a basemap switch, and the visited wash froze where it
// was, because `updateGrid` is driven from `move` and `moveend` and neither was
// being called any more.
const isCtrl = (e) => e.ctrlKey || e.metaKey;

{
  onMapBuilt(() => map.on('click', (e) => {
      // On a phone the menu is a sheet over the map, so the tap that dismisses it
      // is aimed at the sheet, not at the ground behind it — marking a cell or
      // opening an info card there is never what was meant. The menu is closed by
      // the click-away handler; this only makes sure the map ignores the same tap.
      // Desktop is left alone: there the menu sits beside the map, so a click on
      // the map really is a click on the map.
      //
      // This runs *before* the click-away handler, which is why the flag is raised
      // on pointerdown rather than there — see wireLayersControl.
      if (dismissedMenuOnTap) {
        dismissedMenuOnTap = false;
        return;
      }
      // Placing the home pin takes the map over: while it is on, a tap is an
      // answer to the question on screen and nothing else.
      if (homePick.on) {
        placeHomePin(e.lngLat);
        return;
      }
      // Putting the pin away is the whole of that tap. Answering "where is Venice"
      // and then opening a card about the ground beside it would be two answers
      // to a question you asked once. Panning never lands here — MapLibre tells a
      // drag from a click — so the pin survives being looked around.
      if (placePin) {
        showPlacePin(null);
        return;
      }
      if (currentLevel == null) return;
      if (mode !== 'edit') {
        // Photographs first, ahead of even the routes: this is the smallest target
        // on the map and the only one drawn *over* them, so a dot sitting on a
        // line you rode is a dot you aimed at. Guarded by the switch so a tap on a
        // map with no photographs on it does no work at all.
        const photo = photosOn && styleReady && showPhotoInfo(e);
        // A tap that landed on a saved route is about the route, not the ground
        // under it; otherwise view mode inspects the cell.
        const route = photo ? null : routeAt(e.point);
        if (photo) { /* the card is the whole of the tap */ }
        else if (route) showRouteInfo(route);
        // Then the train tracks, in the same order they are drawn in: a line you
        // travelled beats reference geometry about where a line exists, and both
        // beat the ground underneath. Only when the overlay is on *and* has been
        // asked to answer — a hit test across 288 layers is not worth running
        // otherwise, and an overlay switched on to look at should not be quietly
        // taking taps away from the ground it is drawn over.
        else if (railOn && railInteractive && showRailInfo(e)) { /* the card is the whole of the tap */ }
        // Then an airport, in the order these are drawn. No switch guarding it,
        // unlike the railway above: that one is off by default because a hit test
        // across 288 layers on every tap is a real cost, and this is one query
        // over six layers of a point source. An icon you can see and cannot tap
        // is the worse answer when tapping it is nearly free.
        else if (airportsOn && showAirportInfo(e)) { /* the card is the whole of the tap */ }
        // Then the trails, last of the three and for a reason that is not about
        // drawing order: this one cannot be asked whether it was hit. The other
        // two answer "nothing there" and stand aside; a raster overlay has no
        // features to query, so `showTrailInfo` always claims the tap and always
        // returns true. That is why it is behind a switch that is off by
        // default — see `trailsInteractive` — and why it sits below everything
        // that *can* say no.
        else if (trailsOn && trailsInteractive && showTrailInfo(e)) { /* the card is the whole of the tap */ }
        // At the three vector levels there are no hexes on screen, so a tap is
        // about the shape it landed on — whether or not you have been to it — and
        // where there is no shape, about nothing. See showInfoAt.
        //
        // Unless the ground has been told not to answer, in which case the tap is
        // spent closing whatever is open — which is still the useful half of it,
        // and better than a tap that does nothing at all.
        else if (cellsInteractive) showInfoAt(e.lngLat);
        else { closeCellInfo(); closeRouteInfo(); closePhotoInfo(); }
        return;
      }
      if (isCtrl(e.originalEvent)) return; // Ctrl gesture is handled as painting
      toggleCell(cellIdAt(e.lngLat));
    }));

  let hoverPending = false;
  onMapBuilt(() => map.on('mousemove', (e) => {
      cursorPx = [e.point.x, e.point.y];
      lastLngLat = e.lngLat;
      // View mode: show that the line under the cursor is tappable. Skipped
      // mid-gesture, where a hit test would be both wasted and misleading.
      if (mode !== 'edit' && !map.isMoving()) {
        if (routesOn && routeGeom) {
          const under = routeAt(e.point);
          pointerOnRoute = !!under;
          // The hit test was already being paid for, for the cursor. The glow
          // is the same answer said in the picture instead of on the pointer.
          setHoveredRoute(under?.id ?? null);
          syncPointer();
        }
        // And the railway under it, if the overlay has been asked to answer. A
        // frame behind, and its own half of the cursor — see railHoverAt.
        railHoverAt(e.point);
        // And an airport, answered here and now: six layers over a point source is
        // the same order of work as the route test above it, not the railway's.
        if (airportsOn && styleReady) {
          pointerOnAirport = !!airportFeatureAt(e.point);
          syncPointer();
        }
        // And a photograph, on the same terms and for the same money.
        if (photosOn && styleReady) {
          pointerOnPhoto = !!photoFeatureAt(e.point);
          syncPointer();
        }
      }
      if (mode !== 'edit' || currentLevel == null) return;
      // Keep the paint gesture in sync with the live modifier state (covers the
      // case where Ctrl is pressed/released without a separate key event, e.g.
      // after an OS shortcut stole focus).
      if (isCtrl(e.originalEvent)) startPaint();
      else stopPaint();
      if (ctrlPaint) {
        paintAt(e.lngLat); // painting schedules its own re-render
        return;
      }
      // While the map is panning/zooming, leave the spotlight where it is: it's
      // anchored to the map, so it rides along and stays under the cursor (the
      // grabbed point follows the cursor during a drag). Rebuilding here would
      // use a mid-drag camera and make it swim. moveend re-anchors it.
      if (map.isMoving()) return;
      setHover(cellIdAt(e.lngLat));
      if (hoverPending) return;
      hoverPending = true;
      requestAnimationFrame(() => {
        hoverPending = false;
        updateTiles();
      });
    }));
  map.getCanvas().addEventListener('mouseleave', () => {
    setHover(null);
    clearRailHover();
    setHoveredRoute(null);
  });

  // The modifier state carried on the button-press itself, checked before
  // MapLibre sees it.
  //
  // Everything else here learns about Ctrl/Cmd from a keydown or from a later
  // mousemove, and both can miss: the page only gets a keydown if it had focus
  // when the key went down — Cmd-Tabbing back into the window and dragging
  // straight away never produces one — and once MapLibre has started a pan it
  // stops emitting `mousemove`, so the check in that handler never runs again.
  // The gesture then panned the map instead of painting, which read as the map
  // jerking sideways before a single cell finally got colored on release.
  //
  // Capture phase, because MapLibre's own mousedown listener is on this element
  // and starting the pan is exactly what has to be pre-empted.
  map.getCanvasContainer().addEventListener(
    'mousedown',
    (e) => {
      if (mode !== 'edit' || !isCtrl(e)) return;
      // Paint from where the button actually went down rather than wherever the
      // pointer was last seen moving, which may be stale or somewhere else.
      const box = map.getCanvasContainer().getBoundingClientRect();
      lastLngLat = map.unproject([e.clientX - box.left, e.clientY - box.top]);
      startPaint();
    },
    true,
  );

  // Ctrl held while stationary should still start/stop the paint gesture.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') startPaint();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Control' || e.key === 'Meta') stopPaint();
  });
  window.addEventListener('blur', stopPaint);

  hudPencil.addEventListener('click', () => setMode('edit'));
  hudDone.addEventListener('click', () => setMode('view'));
  // The accent picker. Repainting on every drag frame is the point — you pick
  // the color against the map itself, not against a swatch.
  colorPicker = mountColorPicker({
    button: colorInput,
    panel: document.getElementById('color-panel'),
    value: accent,
    place: () => placeBesideMenu(colorInput, document.getElementById('color-panel')),
    onInput: (hex) => {
      accent = hex;
      // Against the basemap it was picked on, and only that one. The other
      // stays where its own owner put it.
      accents[themeNow()] = hex;
      saveAccents();
      // Stored the same way as the activity colours, and for the same reason:
      // the visited colour is a choice about the account, not about this
      // laptop. It used to be localStorage only, so picking it here left the
      // phone on the old one for good.
      touchPrefs();
      applyColors();
      // The opacity half of the colour lands on the layers rather than in
      // them, so the fades have to be re-pinned or dragging the alpha strip
      // changes nothing until the map next moves.
      applyFade(fade.cur);
      applyPrevFade(fade.prev);
      repaintAccent();
    },
  });

  wireLayersControl();

  cellInfo = mountCellInfo({ onClose: () => closeCellInfo() });
  routeInfo = mountRouteInfo({
    onClose: () => closeRouteInfo(),
    onZoom: zoomToRoute,
    // Everything that changes a route lives in one place now; the card hands
    // over to it rather than being a second editor.
    onMore: (route) => {
      closeRouteInfo();
      stats.openRoute(routeList.find((r) => r.id === route.id) ?? route);
    },
    // Toggle: a second press on an already-isolated route puts the rest back.
    onOnly: (route) => {
      setSoloRoute(soloRoute === route.id ? null : route.id);
      routeInfo?.setSolo(soloRoute === route.id);
    },
    isSolo: (route) => soloRoute === route.id,
  });
  // Mounted whether or not this is the app: the markup is in the page either
  // way, and a card nothing can open costs one query per element. Making it
  // conditional would mean every call site asking first.
  photoInfo = mountPhotoInfo({ onClose: () => closePhotoInfo() });

  // The file importer, first entry behind "Import & sync": parses the file in
  // the browser, previews what it found, then merges the cells server-side.
  const importer = mountImport({
    onKomoot: () => komootUi.open(),
    onClose: () => sync?.open(),
    knownCells: () => visited,
    knownSources: () => [...new Set([...cellMeta.values()].flat().map((m) => m.source))],
    onImported: async ({ routes = false } = {}) => {
      await hydrateVisited();
      // Saving a track and not seeing it would just be confusing, so the first
      // import that carries one switches the layer on.
      if (routes && !routesOn) {
        routesOn = true;
        saveRoutesPref();
      }
      await loadRoutes(routesOn);
      updateLayersUi();
    },
  });
  // Two doors, split by which way the data is going: everything that brings it
  // in behind one, everything that takes it back out behind the other. Each
  // entry hands off to its own dialog and comes back to its hub on Back.
  let sync = null;
  let settings = null;
  let personalUi = null;
  homeAssistant = mountHomeAssistant({
    onSynced: () => hydrateVisited(),
    onClose: () => sync?.open(),
    onLink: (link) => {
      let text;
      if (!link) text = 'Not connected';
      else if (!link.enabled) text = 'Connected · paused';
      else if (link.lastError) text = 'Connected · last sync failed';
      else {
        const every = link.intervalMin >= 60 ? `${link.intervalMin / 60} h` : `${link.intervalMin} min`;
        text = `Syncing every ${every}`;
      }
      sync?.setHaStatus(text);
    },
  });
  // Komoot is a one-off import, not a connected account that polls on a timer,
  // so it lives behind "Import locations" with the files rather than in Sync
  // alongside Home Assistant and Strava. Back therefore returns to the importer.
  const komootUi = mountKomoot({
    knownCells: () => visited,
    onClose: () => importer?.open(),
    onImported: async ({ routes = false } = {}) => {
      await hydrateVisited();
      if (routes && !routesOn) {
        routesOn = true;
        saveRoutesPref();
      }
      await loadRoutes(routesOn);
      updateLayersUi();
    },
  });
  const afterActivities = async () => {
    await hydrateVisited();
    if (!routesOn) {
      routesOn = true;
      saveRoutesPref();
    }
    await loadRoutes(routesOn);
    updateLayersUi();
  };
  stravaUi = mountStrava({
    onSynced: afterActivities,
    onClose: () => sync?.open(),
    onLink: (l) => {
      let text;
      if (!l) text = 'Not connected';
      else if (!l.connected) text = 'Set up · not signed in';
      else if (!l.enabled) text = 'Connected · paused';
      else if (l.lastError) text = 'Connected · last sync failed';
      else {
        const every = l.intervalMin >= 60 ? `${l.intervalMin / 60} h` : `${l.intervalMin} min`;
        text = `Syncing every ${every}`;
      }
      sync?.setStravaStatus(text);
    },
  });
  // Backups are the one entry in Sync that goes the other way: everything else
  // pulls data in, this writes the whole database out on a schedule.
  backupUi = mountBackup({
    onClose: () => settings?.open(),
    onStatus: () => settings?.setBackupStatus(backupUi.summary()),
  });
  // Nothing to configure and nothing to poll — the phone decides both. This is
  // only here so "is it working?" has an answer on a laptop.
  deviceUi = mountDevices({
    onClose: () => sync?.open(),
    onDevices: (devices) => {
      let text;
      if (!devices.length) text = 'No phone syncing';
      else if (devices.length === 1) {
        text = `${devices[0].name || 'A phone'} · ${whenAgo(devices[0].lastSeen)}`;
      } else text = `${devices.length} phones syncing`;
      sync?.setDeviceStatus(text);
    },
  });
  sync = mountSync({ homeAssistant, strava: stravaUi, device: deviceUi, files: importer });
  // Before the dialog that opens it. Back goes to Settings rather than to the
  // hub, because Settings is where Sources is now reached from — a Back that
  // lands somewhere you did not come from is how you lose your place.
  //
  // Removing a source is the only action in here that changes the map, so it is
  // the only one that has to say so afterwards.
  const sourcesUi = mountSources({
    onClose: () => personalUi?.open(),
    onChanged: async () => {
      await hydrateVisited();
      await loadRoutes(routesOn);
      updateLayersUi();
    },
  });
  const railUi = mountRail({
    onClose: () => personalUi?.open(),
    groups: () => railGroupsOn,
    onGroup: (key, on) => setRailGroupOn(key, on),
    technical: () => railTechnicalOn,
    onTechnical: (on) => setRailTechnicalOn(on),
    interactive: () => railInteractive,
    onInteractive: (on) => setRailInteractive(on),
  });
  const airportsUi = mountAirports({
    onClose: () => personalUi?.open(),
    groups: () => airportGroupsChosen,
    onGroup: (key, on) => setAirportGroupOn(key, on),
  });
  mapboxUi = mountMapbox({
    onClose: () => personalUi?.open(),
    // The token is a preference now, so a change to it is pushed to the account
    // like any other — which is what puts it on the phone without being pasted
    // there. `pushPrefs` rather than waiting out the debounce: this one is worth
    // a request of its own, because the next thing somebody does after pasting a
    // token is pick up the other device.
    onToken: () => {
      mapboxTokenChanged();
      touchPrefs();
      pushPrefs();
    },
    // Done with a working token means *show me the map I just paid for*. This
    // used to be deliberately not done — the dialog can be reached from Settings
    // by somebody who only wanted to paste a token, and switching under them
    // looked presumptuous — but that reading had it backwards: the only reason
    // to be in this dialog at all is the basemap on the other side of it.
    onUse: () => setStyleKey('mapbox'),
  });
  personalUi = mountPersonal({
    onClose: () => settings?.open(),
    home: () => homePlace,
    onSetHome: () => homeUi.open(homePlace),
    homeShown,
    onShowHome: (on) => setHomeShown(on),
    clock: () => clockMode(),
    onClock: (mode) => {
      if (!setClock(mode)) return;
      redrawClocks();
      touchPrefs();
      pushPrefs();
    },
    snow: () => snowMode(),
    onSnow: (mode) => {
      snowModeChanged(mode);
      // Straight out rather than on the debounce, for the reason the token
      // above goes straight out: the next thing somebody does after switching
      // this on is look at the other device.
      pushPrefs();
    },
    snowPossible: () => engine === MAPBOX,
    whatsNew: () => bannerMode(),
    onWhatsNew: (mode) => {
      setBannerMode(mode);
      touchPrefs();
      pushPrefs();
    },
    locales: () => LOCALES,
    locale: () => locale(),
    // Pushed *before* the reload rather than after it. `setLocale` takes the
    // page down, and a preference still sitting in the debounce when that
    // happens is a preference that never left — the same trap the unload flush
    // exists for, arrived at deliberately rather than by accident.
    onLocale: async (key) => {
      if (key === locale()) return;
      setLocale(key, false);
      touchPrefs();
      await pushPrefs();
      location.reload();
    },
    sources: sourcesUi,
    rail: railUi,
    airports: airportsUi,
    mapbox: mapboxUi,
    // On request, and it is a real replay rather than a recording: every step
    // reads the map first, so it says "home is already Zurich" instead of
    // asking again. See `drawPerms` and `drawHome` in src/intro-ui.js.
    onReplayIntro: () => introUi?.open(),
    onClearCache: () => clearOfflineCaches(),
    version: () => serverBuild(),
    update: () => serverUpdate(),
    onReload: () => location.reload(),
    username: () => username,
    onDeleteAccount: async (password) => {
      const out = await auth.deleteAccount(password);
      // The server has already dropped the session and cleared the cookie, so
      // there is nothing to log out of — but every teardown logging out does
      // still has to happen, and the offline caches most of all: they are filed
      // under URLs that say nothing about whose account they describe, and the
      // account they describe no longer exists.
      authState?.signedOut();
      // The backups are the one thing deleting an account cannot reach, so the
      // answer says so here rather than leaving it to be discovered later.
      showToast(out?.backupsKept
        ? `${out.username} deleted. Snapshots taken before now still hold a copy.`
        : `${out?.username ?? 'Account'} deleted.`);
      return out;
    },
  });
  // Nothing about the export is stored on the server and nothing it draws is
  // sent anywhere: it reads the map that is already in this tab and writes a
  // PNG the browser saves. Which is why it takes accessors and not a copy —
  // there is only one set of cells and it belongs up here.
  const exportUi = mountExport({
    onClose: () => settings?.open(),
    data: {
      // What the map is drawing, so a picture of it is a picture of it: the
      // frame it fits to and the numbers in the caption agree with the cells
      // the same accessors' roll-up paints. See hiddenSources.
      cells: () => visibleCells,
      meta: () => cellMeta,
      // Not the map's accent. The picture's wash belongs to the look it is
      // printed in — see `accentOf` in src/export-image.js — and the map's
      // colour was chosen against a live basemap this poster does not have.
      rollUp: exportRollUp,
      areaFC: exportAreaFC,
      areaOf: areaOfCellMemo,
    },
  });
  settings = mountSettings({ personal: personalUi, backup: backupUi, exportImage: exportUi });
  document.getElementById('sync-open').addEventListener('click', () => {
    setMenuOpen(false);
    sync.open();
  });
  document.getElementById('settings-open').addEventListener('click', () => {
    setMenuOpen(false);
    settings.open();
  });

  // Search: one field over the map for the three things it holds — a place to
  // go and look at, a route you remember the name of, and a day you remember
  // the date of.
  // Cmd/Ctrl-K is handled inside the palette (it has to be, to toggle itself
  // closed); this is the same job for every other way in.
  const search = mountSearch({
    trips: () => stats.trips() ?? [],
    routes: () => listedRoutes(),
    days: () => activeDays(cellMeta, listedRoutes()),
    meta: () => cellMeta,
    onPlace: (lngLat, { bounds } = {}) => {
      // The pin is the whole answer to "where is this", and an outlined canton
      // left over from the last search sitting underneath it is a second one.
      closeCellInfo();
      showPlacePin(lngLat);
      if (bounds?.length === 4) fitBboxOnMap(bounds);
      else {
        releaseCameraLock();
        map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: 11, duration: 900 });
      }
    },
    // A canton or a country is a shape, not a spot — so it is outlined and
    // described rather than pinned. See showSearchedArea.
    onArea: showSearchedArea,
    onTrip: (trip) => {
      showTripOnMap(trip);
      fitBboxOnMap(trip.bbox);
    },
    hiddenTrips: () => hiddenTripIds,
    onHideTrip: setTripHidden,
    onNameTrip: setTripName,
    // A day with a dot on it is a day you should be able to look at, and until
    // now the calendar could only tell you it existed. Same treatment as a
    // trip — the ground it covered, threaded in the order you covered it.
    onDay: showDayOnMap,
    onRoute: async (route) => {
      if (!routesOn) setRoutesOn(true);
      if (!routeGeom) await loadRoutes(true);
      setSoloRoute(route.id);
      zoomToRoute(route);
      showRouteInfo(routeList.find((r) => r.id === route.id) ?? route);
    },
    // However it was opened — the button or Cmd-K — the trips fill in behind
    // the field rather than in front of it. Deriving them is a sweep of the map
    // and a 2 MB dataset, and making you wait to type is the wrong way round.
    onOpen: () => {
      // The palette is glass over the map, so opening it changes what the
      // contrast reading is being taken across.
      refreshChrome();
      stats.ensureTrips().then(() => search.refresh()).catch(() => {});
    },
  });
  document.getElementById('search-btn').addEventListener('click', () => {
    setMenuOpen(false);
    search.open();
  });

  // Setting home re-derives every trip, so the panel is reopened on the tab it
  // came from rather than left to go stale behind the dialog.
  homeUi = mountHome({
    onPick: beginHomePick,
    onSet: async (home) => {
      homePlace = home;
      syncHomeMarker();
      touchPrefs();
      await pushPrefs();
    },
    onClose: () => search.open(),
  });

  // Apple Health's channel, or null anywhere that is not an iPhone app new
  // enough to have one. Its absence is answered rather than assumed away: on a
  // Mac there is no HealthKit at all, and an older build of the app simply
  // predates the handler — both get the directions the card used to give.
  //
  // Inline rather than a module of its own, unlike `photoHost()` in
  // src/photos.js. That one is the front door to a whole overlay; this is two
  // messages, neither of which carries any data.
  const healthHost = () => globalThis.webkit?.messageHandlers?.hexploreHealth ?? null;

  // The introduction. Everything it needs is a question about the map that
  // something else here already answers — which is the point: the deck reads
  // the state of the app rather than keeping its own idea of it, so a replay
  // from Settings knows that home is set and that the photo library has already
  // been read.
  introUi = mountIntro({
    host: hostKind,
    home: () => homePlace,
    // What has actually put something on this map. Better evidence of a
    // permission than any flag, because it is the permission having already
    // produced the thing it was asked for — see `alreadyGranted` in src/intro.js.
    sources: () => [...new Set([...cellMeta.values()].flat().map((m) => m.source))],
    routes: () => routeList,
    loadStats: () => derived.loadStats(),
    loadTrips: () => derived.loadTrips(),

    // --- The three asks ---
    //
    // Two of them raise a real system prompt and the third is the browser's own.
    // None of them is a "request permission" call as such: the way to ask for a
    // photo library is to ask it a question, and iOS puts the sheet up in front
    // of the answer.

    /**
     * Photographs. `loadPhotos` is the scan the overlay uses, and asking for it
     * is what makes `PhotoLibrary.authorize()` run on the other side of the
     * bridge — so the sheet appears, and what comes back is either a library or
     * the reason there isn't one.
     */
    askPhotos: async () => {
      if (!photosAvailable()) return { ok: false, error: 'nohost' };
      const report = await loadPhotos();
      // Read, and then drawn. Somebody who has just said yes to this should see
      // what they said yes to rather than have to find the switch — and the
      // switch is left on afterwards, because it is now a true description of
      // what the map is showing.
      if (report.ok && report.count > 0) {
        photosToggle.checked = true;
        setPhotos(true);
      }
      return report;
    },

    /**
     * Where you are. The standard call, which is the right one in all three
     * hosts: in a browser it is the only one there is; on the iPhone WebKit
     * raises the app's own prompt behind it; on the Mac the app has replaced
     * `navigator.geolocation` with a shim onto CoreLocation (see
     * `LocationBridge` there), so this reaches the same place by a different
     * road and neither side needs to know.
     */
    askLocation: () =>
      new Promise((resolve) => {
        if (!navigator.geolocation) return resolve({ ok: false, error: 'nohost' });
        navigator.geolocation.getCurrentPosition(
          (p) => {
            // Kept, so the home step a card later already knows where to fly.
            lastFix = [p.coords.longitude, p.coords.latitude];
            resolve({ ok: true });
          },
          (err) => resolve({ ok: false, error: err?.code === 1 ? 'denied' : 'unavailable' }),
          { enableHighAccuracy: true, timeout: 10_000 },
        );
      }),

    /**
     * Workouts. The one permission with no web equivalent at all — there is no
     * standard way to raise HealthKit's sheet, so the iPhone app answers a
     * message of its own (`HealthBridge` there) by throwing the same switch its
     * Settings tab throws, which is what makes iOS ask.
     *
     * `settings` is the answer everywhere else, and it is a real answer rather
     * than a failure: on a Mac there is no HealthKit to ask, and in an older
     * build of the app there is no handler — so the row goes back to being the
     * directions it used to be instead of a button that quietly does nothing.
     *
     * A `true` here means the sheet was raised, not that it was accepted:
     * HealthKit never reports read permission either way. See the note on
     * `HealthBridge`.
     */
    askHealth: async () => {
      const host = healthHost();
      if (!host) return { ok: false, error: 'settings' };
      try {
        return (await host.postMessage({ ask: 'authorize' })) ?? { ok: false, error: 'settings' };
      } catch (e) {
        console.warn('Apple Health could not be reached.', e);
        return { ok: false, error: 'settings' };
      }
    },

    /**
     * Whether location has already been granted, without asking for it.
     *
     * The only one of the three with a real answer available. Photos and Health
     * are inferred from what is on the map instead, which is coarser and cannot
     * be queried any other way.
     *
     * On a Mac the Permissions API is not merely unhelpful, it is wrong. It
     * reports on WebKit's geolocation permission, and this host does not use
     * it — `navigator.geolocation` there is a shim onto CoreLocation (see
     * `LocationBridge` in HexPlore-macOS) — so it answered "prompt" for an
     * account whose Mac had been happily giving out positions for months, and
     * the replay offered to ask for something it already had. The bridge is the
     * only thing that can say, so on that host it is asked first.
     */
    geolocationState: async () => {
      const bridge = globalThis.webkit?.messageHandlers?.hexploreLocation ?? null;
      if (bridge) {
        try {
          const reply = await bridge.postMessage({ ask: 'state' });
          if (reply?.ok && reply.state) return reply.state;
          // An app built before this question existed answers "unknown
          // request", which is not an answer — so fall through and let the
          // browser have its guess rather than reporting a refusal.
        } catch (e) {
          console.warn('The Mac could not say whether location is granted.', e);
        }
      }
      try {
        return (await navigator.permissions?.query({ name: 'geolocation' }))?.state ?? null;
      } catch {
        // Safari answered `TypeError` for an unsupported descriptor for years,
        // and a browser that will not say is not the same as a refusal.
        return null;
      }
    },

    /**
     * Whether the app's workout sync is already on — asked without asking, so a
     * replay can say "already done" rather than raising a second sheet at
     * somebody who answered the first one.
     *
     * Better evidence than a source on the map, and available sooner: this is
     * true from the moment the sheet is accepted, where `apple-health` only
     * appears once a ride has actually synced.
     */
    healthState: async () => {
      const host = healthHost();
      if (!host) return null;
      try {
        const reply = await host.postMessage({ ask: 'state' });
        return reply?.ok ? !!reply.on : null;
      } catch {
        return null;
      }
    },

    onPickHome: introHomePick,

    // Skipping counts, the same as finishing. Somebody who threw the deck away
    // on the first card has answered the question "do you want this", and
    // asking it again every morning until they sit through it is the behaviour
    // of a pop-up rather than of an introduction. Settings ▸ Replay is where it
    // lives from then on.
    //
    // Nothing is re-read here. Home is pushed by `onSet` as it is chosen, and
    // both derived readings carry an ETag over the rows behind them, so the
    // next thing to ask for a trip list gets one measured from the new house
    // without anything having to remember to invalidate.
    onFinish: () => {
      introShowing = false;
      rememberIntroSeen();
    },
  });

  const stats = statsUi = mountStats({
    routes: () => listedRoutes(),
    foldedRoutes: () => foldedCount(),
    showFolded: () => showDupes,
    isFolded: (r) => dupeOf.has(r.id),
    onShowFolded: (on) => {
      showDupes = on;
      syncRoutes();
      updateRoutesUi();
    },
    // Picking a route in the list opens it in the dialog; "Show on map" is the
    // one that closes the panel, switches the layer on and flies there.
    onShowRoute: async (route) => {
      stats.close();
      if (!routesOn) setRoutesOn(true);
      if (!routeGeom) await loadRoutes(true);
      // Isolated by default: coming from the list you picked one route out of
      // eighty-two, and dropping it into all eighty-two is not showing it to
      // you. The chip on the map puts the others back.
      setSoloRoute(route.id);
      zoomToRoute(route);
      showRouteInfo(routeList.find((r) => r.id === route.id) ?? route);
    },
    // A trip is ground, not a line: there is nothing to select, so showing one
    // means drawing its track and framing it. The chip names it, because the
    // map itself can't — twelve scattered blobs don't say "Iceland, last
    // August" — and it stays up, which a toast can't: the name is not an event
    // that happened two seconds ago, it is what you are currently looking at.

    // The dialog edits the same objects routeList holds, so only the drawn
    // labels need refreshing — same as the card on the map.
    onRouteEdited: (route, before) => {
      updateRoutesUi();
      if (!before) return;
      const after = { name: route.name, sport: route.sport, source: route.source, sportGuessed: route.sportGuessed };
      // Applying a set of values *is* the same operation in both directions, so
      // undo and redo are one function pointed at two snapshots.
      const apply = async (vals) => {
        await auth.updateRoute(route.id, { name: vals.name, sport: vals.sport, source: vals.source });
        Object.assign(route, vals);
        updateRoutesUi();
      };
      // Say which edit it was: "renaming" is wrong for a route you only refiled
      // under a different app, and a toast that describes the wrong change is
      // worse than one that says nothing.
      const title = before.name ? `“${before.name}”` : 'a route';
      const what = before.name !== after.name
        ? `renaming ${title}`
        : before.sport !== after.sport
          ? `changing the activity of ${title}`
          : before.source !== after.source
            ? `refiling ${title}`
            : `editing ${title}`;
      history.push(what, () => apply(before), () => apply(after));
    },
    onRouteDeleted: async (route) => {
      if (!(await removeRoute(route))) throw new Error('Could not remove that route.');
    },
    knownSources: () => [...new Set(routeList.map((r) => r.source))],
  });
  document.getElementById('stats-open').addEventListener('click', () => {
    setMenuOpen(false);
    stats.open();
  });

  // "Your map has grown" — and the one press it offers goes to the panel that
  // says by how much, which is the only thing anybody would want next.
  whatsNewUi = mountWhatsNew({
    stats: () => derived.stats(),
    routes: () => routeList,
    // "Show me" means show me the thing the sentence was about. When that is a
    // single workout there is somewhere specific to go, and stopping at the list
    // to make you pick the only entry in it is a step that answers nothing. Any
    // more than one and the list *is* the answer, so it opens as it always did.
    //
    // routeList is newest first, which is what makes finding the one worth
    // opening a search rather than a comparison: a workout that has just arrived
    // is the latest one the phone recorded.
    onOpenStats: (newWorkouts) => {
      setMenuOpen(false);
      const only = newWorkouts === 1 ? routeList.find((r) => r?.source === HEALTH_SOURCE) : null;
      if (only) stats.openRoute(only);
      else stats.open();
    },
    // Straight up rather than on the debounce. The point of a shared baseline is
    // that the device you pick up *next* stays quiet, and next can be a minute
    // away — a push still sitting in a timer when the phone comes out of a
    // pocket is the duplicate this exists to stop.
    onSeen: () => {
      touchPrefs();
      pushPrefs();
    },
  });

  let pending = false;
  onMapBuilt(() => map.on('move', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        updateGrid();
        // Don't rebuild the spotlight mid-move — it rides with the map so it
        // stays under the cursor while dragging; moveend re-anchors it.
      });
    }));
  onMapBuilt(() => map.on('moveend', () => {
      updateGrid();
      updateTiles();
    }));
  onMapBuilt(() => map.on('resize', () => {
      updateGrid();
      updateTiles();
    }));

  // Until the pointer moves, anchor the spotlight to the viewport center.
  const el = map.getContainer();
  cursorPx = [el.clientWidth / 2, el.clientHeight / 2];

  // A saved 'edit' mode only survives if editing is still switched on.
  if (mode === 'edit' && !editUi) {
    mode = 'view';
    tileVis = 0;
  }
  updateModeUi();
  // Geometry, colors and the first reveal are set up in installGrid() when the
  // style finishes loading (and again after every basemap switch).
}

// --- Undo / redo, from the keyboard -------------------------------------------
// Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z (Ctrl-Y too, which is what Windows hands
// tell their fingers). Every one of them says out loud what it just did — on a
// map the change is often off screen, or a cell too small to see move, and a
// silent undo is indistinguishable from one that did nothing.
function isTypingIn(el) {
  if (!el) return false;
  const tag = el.tagName;
  // Renaming a route keeps its own undo. Taking Ctrl-Z away from a text field
  // to undo something on the map behind it would be the wrong answer twice.
  return el.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

window.addEventListener('keydown', async (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  if (isTypingIn(e.target)) return;
  e.preventDefault();
  const forward = key === 'y' || e.shiftKey;
  if (!authed) {
    showToast('Sign in to change the map', { tone: 'quiet' });
    return;
  }
  try {
    const label = forward ? await history.redo() : await history.undo();
    if (label) showToast(`${forward ? 'Redid' : 'Undid'} ${label}`);
    // Nothing on the stack is an answer, not a failure — said quietly.
    else showToast(forward ? 'Nothing to redo' : 'Nothing to undo', { tone: 'quiet' });
  } catch (err) {
    // The entry stays on the stack (see src/history.js), so this is worth
    // trying again once the server is back.
    showToast(`Couldn't ${forward ? 'redo' : 'undo'} that — ${err.message ?? err}`);
  }
});

// --- "the server has gone" banner ---------------------------------------------
// Every API call reports whether it got an answer (src/auth.js), so this only
// has to react. It matters because the map goes on working perfectly when the
// server is unreachable — cells still light up under the cursor, routes still
// draw — and without a word said, that looks exactly like a map that is saving.
function mountOfflineBanner() {
  const bar = document.getElementById('offline-bar');
  const detail = document.getElementById('offline-detail');
  const retry = document.getElementById('offline-retry');
  let checking = false;

  const show = (reason) => {
    detail.textContent =
      reason === 'error'
        ? 'The server answered with an error. Recent changes may not have been saved.'
        : "Anything you change now won't be saved.";
    bar.hidden = false;
  };

  connection.watch((ok, reason) => {
    if (ok) bar.hidden = true;
    else show(reason);
  });

  retry.addEventListener('click', async () => {
    if (checking) return;
    checking = true;
    retry.disabled = true;
    retry.textContent = 'Checking…';
    const ok = await connection.check();
    // Back up: push whatever the map has been holding on to, then reload the
    // authoritative copy so the two agree again.
    if (ok) {
      flushPending();
      await hydrateVisited();
      await loadRoutes(routesOn);
    }
    checking = false;
    retry.disabled = false;
    retry.textContent = 'Retry';
  });

  // The browser knows before we do when the machine drops off the network.
  window.addEventListener('offline', () => show('offline'));
  window.addEventListener('online', () => connection.check());
}
mountOfflineBanner();

// --- Auth gate ---------------------------------------------------------------
// Resolve the session on load: if signed in, pull the user's cells; otherwise
// show the login/register overlay. Logging out clears the map and re-shows it.
const authState = mountAuth({
  onAuthed: async (name) => {
    authed = true;
    username = name ?? null;
    // Nothing is drawn until the account's colours are in — see
    // `paintHeldForPrefs`. The cells still load, the routes still load; it is
    // only the paint that waits, so this costs a fetch rather than a render.
    paintHeldForPrefs = true;
    try {
      await hydrateVisited();
      await loadRoutes(routesOn);
      // After the routes, because it re-renders the per-activity rows and those
      // are built from what the account actually has.
      await syncPrefs();
    } finally {
      paintHeldForPrefs = false;
      // The first paint, now in the right colour. The same tail
      // `hydrateVisited` runs, because its own call was the one held —
      // `recomputeLit` included, since adopting preferences can change the
      // colour *mode* and the ranges are computed per mode.
      recomputeLit();
      updateGrid(true);
      updateTiles();
      updateHud(currentLevel);
    }
    // Only for the menu's status line — the sync itself runs on the server
    // whether or not this page is open.
    homeAssistant?.refresh();
    // Same, for the phones reporting in. Nothing here drives them — the app on
    // the phone does — this only fills in the status line.
    deviceUi?.refresh();
    // Coming back from Strava's OAuth redirect reopens the dialog on the result.
    if (!(await stravaUi?.handleReturn())) stravaUi?.refresh();
    // …and the backup schedule, for the row in Sync. Only the account that made
    // the map may read it; anyone else's row says so.
    backupUi?.refresh();

    // What changed since this last said anything.
    //
    // Last, and deliberately not awaited by anything above it: the coverage
    // sweep is the one reading here that can take a moment on a large map, and
    // the banner is the least urgent thing on the screen. Nothing waits for it,
    // and a map that has finished drawing before the line appears is the right
    // order — the map is what you came for.
    //
    // The failure is silence. `loadStats` throws where the other readings
    // swallow (see src/derived.js), because the Statistics panel has somewhere
    // to put the reason and this does not: a banner that cannot be computed
    // simply does not appear, and the baseline stays where it was so the next
    // open can still report whatever happened in between.
    try {
      await derived.loadStats();
      // Quiet on a first run: the introduction is on screen, and a line saying
      // how much the map has grown is a strange thing to tell somebody who has
      // not yet been told what the map is. The baseline still moves — see the
      // note on `show` — so tomorrow reports today rather than everything.
      whatsNewUi?.show({ quiet: introShowing });
    } catch {
      /* no coverage answer, no banner, and no baseline moved */
    }
    // Whatever was on the stack was somebody else's map, or this one before it
    // was re-read from the server. Either way there is nothing here to take
    // back any more.
    history.clear();
  },
  onLoggedOut: () => {
    authed = false;
    username = null;
    // Undo history belongs to the account that just left too, and every entry
    // in it is an instruction to change *their* map.
    history.clear();
    // The server's readings of their map — their trips, their coverage.
    derived.clear();
    // …and the baseline the "what's new" banner measures against, which
    // describes their map and would otherwise make the next account's first
    // open report the difference between two strangers' maps.
    forgetSnapshot();
    whatsNewUi?.hide();
    // …and the copies the service worker keeps of the same answers, which are
    // filed under URLs that say nothing about whose account they describe.
    forgetAccountOffline();
    // These belong to the account that just left, not to this browser.
    hiddenSports = new Set();
    sportColors = new Map();
    renderedSports = '';
    homePlace = null;
    // Back to following the device, since whose clock this was has left.
    if (setClock('auto')) redrawClocks();
    // Preferences belong to the account too, so the next person to sign in on
    // this browser gets their own colours rather than inheriting these — and
    // the stamp has to go with them, or their (older) copy would look stale and
    // be overwritten by the ghost of this one.
    prefsStamp = 0;
    prefsDirty = false;
    clearTimeout(pushViewTimer);
    accents.light = DEFAULT_ACCENT;
    accents.dark = DEFAULT_ACCENT;
    accent = DEFAULT_ACCENT;
    colorPicker?.set(accent);
    applyColors();
    try {
      localStorage.removeItem(ROUTE_VIEW_KEY);
      localStorage.removeItem(PREFS_STAMP_KEY);
      localStorage.removeItem(CLOCK_KEY);
      localStorage.removeItem(COLOR_KEY);
      localStorage.removeItem(COLORS_KEY);
    } catch {
      /* fine */
    }
    // The Mapbox token goes with them too, and this one is not a matter of
    // tidiness: it is billed to the account that just left, and leaving it here
    // would hand the next person to sign in on this browser somebody else's
    // meter. It comes back from their own account when they sign in again.
    if (hasMapboxToken()) {
      setMapboxToken('');
      mapboxTokenChanged();
    }
    homeAssistant?.clear();
    stravaUi?.clear();
    deviceUi?.clear();
    visited.clear();
    cellMeta.clear();
    pendingAdd.clear();
    pendingRemove.clear();
    closeCellInfo();
    closeRouteInfo();
    // The overlay itself is left alone: your photo library belongs to the phone,
    // not to the account that has just been signed out of. The card goes because
    // it is a card, and nothing else on screen survived.
    closePhotoInfo();
    routeList = [];
    refoldRoutes();
    routeGeom = false;
    syncRoutes();
    // Their house, off a map that is no longer theirs — and the marker's own
    // default reads `homePlace`, which has just gone.
    syncHomeMarker();
    // The introduction belongs to whoever was being introduced. Someone signing
    // out halfway through should not hand the next person a deck half-read —
    // and it is dismissed rather than closed, because closing *records* having
    // seen it, against an account that has just left.
    introUi?.dismiss();
    introShowing = false;
    introSeen = 0;
    recomputeLit();
    updateGrid(true);
    updateTiles();
    updateHud(currentLevel);
  },
});

// The offline shell. Last, and after the page has finished loading, because
// everything above is what someone is waiting to look at — see src/offline.js.
installOffline();
