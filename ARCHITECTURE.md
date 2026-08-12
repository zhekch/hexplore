# Hexplore — architecture notes

How the map is built and why it is built that way: the reasoning behind the
non-obvious code, the constraints that shaped it, and the dead ends that are
worth not walking down twice.

For what the app does and how to run it, see [README.md](README.md).

An interactive world map covered by a hexagonal grid tied to real geographic
coordinates, rendered with MapLibre GL on a dark basemap with a visionOS-style
glass look. Click hexagons to mark places you've visited.

## How it works

- **Startup view**: the viewer's approximate **IP-based location** (fetched
  client-side from geojs.io / ipwho.is, so it works from localhost too; VPNs
  resolve to the VPN's city) → world view. If the location arrives before
  the basemap has rendered, the map simply opens there; otherwise it
  recenters at world zoom and zooms straight down (no sideways pan). Set
  `REMEMBER_VIEW = true` in `src/main.js` to instead resume the last saved
  camera position on load.
- **My location**: the round button (bottom right) uses browser geolocation to
  pan to you and show the usual blue dot — works on localhost, needs HTTPS
  in production. The map attribution sits top right, out of its way.
- **The map turns, and tilts.** Ctrl-drag (or right-drag) turns it sideways and
  leans it up and down — one gesture, because they are one camera — and two
  fingers do both on a touch screen. A **compass** appears in the button cluster
  while it is turned or tilted and puts both back; there is nothing there while
  north is up and the view is level. The lean is capped at 60°, which is where
  the horizon stops being a question. See [Turning the map](#turning-the-map).
- **Modes**: the map is view-only until you switch **Editing** on in the menu,
  which reveals the glass **pencil button**; tapping that expands the edit panel
  and enters edit mode, where a glass tile **spotlight around the cursor** shows
  the grid — tiles render only near the pointer and fade out toward the rim
  (`SPOT_PX`, `SPOT_MAX_CELLS`), so even a zoomed-out map never builds more
  than a couple thousand cells. In view mode a tap opens the **info card** for
  that area instead. Set `EDIT_ENABLED = false` in `src/main.js` to ship a
  fully view-only build (no pencil, no editing, at all).
- **Menu**: one glass button opens sections for the base map, coloring, and your
  map (saved routes, editing, statistics, import, sync). The **ⓘ**
  buttons open a floating note beside the menu — nothing expands inline, and
  swapping coloring modes swaps the color picker for the legend inside a
  fixed-height slot, so the panel never resizes under the pointer.
- **Where the controls sit.** On a wide screen the menu and search share one
  glass pill at the **top left** — the two things reached for most, next to each
  other rather than stacked, in the corner a pointer starts from — the geolocate
  button keeps the bottom right, and the pencil takes the bottom left, where it
  is only present at all when editing is switched on. On phones everything
  stacks in the bottom-right corner instead (geolocate, menu, pencil), and
  opening the menu tucks them away behind a bottom sheet. Both sizes build the
  cluster the same way: the glass belongs to the container and the buttons
  inside go flat, because two backdrop-filtered pills touching show a doubled
  seam.
- **A phone held sideways gets the wide layout and a menu turned on its side.**
  Landscape is 844px across and 390px down, so every width the stylesheet asks
  about says "wide screen" and is right to; what there is none of is height. The
  menu is a *column* of eleven rows in 266px, which was a peephole with 600
  unused pixels beside it. Below `max-height: 560px` the panel widens and
  `.menu-scroll` becomes multi-column — a `column-width` with no count, a
  definite height, and `overflow-x: auto`, so sections fill the height and then
  start again to the right. On a current phone the whole menu is three columns
  and nothing scrolls at all. Asked as *height* rather than
  `orientation: landscape`: a short desktop window has the same problem, and a
  tablet in landscape has 768px of it and wants the column.
- **The iOS position overrides are corrections to the phone stack, and are
  scoped to it.** `html[data-client='ios']` lifts the cluster clear of the tab
  bar. Written without a media query it also reached the landscape layout, which
  sets `bottom: auto` to anchor the cluster at the *top* — so `.layers` ended up
  with both edges pinned, which is not a box that hugs its content but one
  stretched the height of the screen. Its reversed column then dropped the menu
  and search pill into the bottom-left corner, on top of the attribution the
  same block had just moved there. Anything that overrides a position inside the
  app has to say which layout it is correcting; `scripts/test/card-lift.mjs`
  guards the neighbouring version of this trap.
- **Grid**: flat-top hexagons defined in Web Mercator space, so every cell
  renders as a perfect, identically-oriented hexagon at any location and zoom
  (no rotation or pentagon artifacts). The base (finest) cell is **~0.9 km**
  flat-to-flat near the equator — change the `BASE_COLS` multiplier in
  `src/main.js` to resize (must stay even; double it to halve the cell).
  Being a Mercator grid, ground size shrinks with latitude (×cos φ);
  on-screen size is constant everywhere.
- **Zoom steps**: each grid level is exactly **3×** wider than the previous
  (5 levels, 0–4), and every big-cell center lands on a small-cell center. As
  you zoom out the grid snaps to the next coarser level (~1.585 map-zoom
  levels apart) and regions **crossfade** concentrically. Past the hexagons come
  three polygon levels — regions, countries, continents. **Detail** in the
  menu pins that choice instead, at either end: *Tiniest* holds level 0 — the
  grid exactly as stored — at every zoom, *Country* holds whole-country fills,
  and *Auto* (the default) follows the zoom. The in-between levels used to have
  buttons of their own; they were five ways of asking for what Auto already
  picks, so a level pinned before they were retired now falls back to Auto
  rather than sitting there with no way to un-pin it. Continents have no button
  either, for the opposite reason: *Detail* answers "how fine", and the coarsest
  step is not a fineness anyone pins a valley to — see [Continents](#continents).
- **Antimeridian**: the column count is integer and even at every level, so
  the grid wraps seamlessly at ±180°; cell ids are canonicalized so the same
  cell matches across world copies.
- **Performance**: colored regions are built by iterating only the marked
  cells (not the viewport), so region rendering stays proportional to what
  you've marked at any zoom; the tile spotlight lives in its own source, so
  mouse movement never rebuilds region geometry.
- **Visited cells**: clicks resolve to a cell mathematically (hex
  point-location), so toggling works at any zoom, on boundaries and gaps.
  Marks **propagate upward** — a coarse cell lights up if it contains any
  visited cell. Clicking a lit cell clears everything stored beneath it.
- **Blobs**: cells are hexagons in storage but never look like it. Every lit
  cell is painted as a disc into an offscreen canvas, the sheet is blurred
  (`BLOB_BLUR` in `src/blob-canvas.js`), and the shape is then **re-cut at a
  fixed alpha level** (`BLOB_LEVEL`, `BLOB_EDGE`) — a level-set smoothing step,
  repeated `BLOB_ROUNDS` times. The blur merges cells and blends their colors;
  taking the half-alpha contour afterwards keeps the blob the size it should be
  while every dent narrower than the blur fills in and every corner sharper than
  the blur rounds off. That's what lets the shapes flow together without the
  cells being drawn any bigger: raise `BLOB_BLUR` for a looser pour, raise
  `BLOB_LEVEL` toward 0.5 for a tighter fit to the cells underneath, and raise
  `BLOB_EDGE` for a more gradual dissolve in the alpha domain (only the final
  cut uses it, and its ramp is clamped away from zero so a wide edge can't tint
  the canvas rectangle and show its straight border). Everything up to that
  point is measured in cells, and a cell's on-screen size swings 3× within a
  zoom level — so a last **`BLOB_FEATHER_PX`** blur, measured in screen pixels,
  gives the same softness at every zoom instead of crisp edges when zoomed out.
  **Edge softness is tuned per coloring mode**: `BLOB_EDGE`/`BLOB_FEATHER_PX`
  apply to the single-color wash, `BLOB_HEAT_EDGE`/`BLOB_HEAT_FEATHER_PX` to the
  heat maps, which want a tighter rim — there every pixel of ramp is also a fade
  toward transparent, so a wide edge makes the outermost cells read as a lower
  value than they hold.
  **For a long time the heat pair was set the other way round**, at 0.6 and 5px
  against the wash's 0.3 and 1px, and that is worth writing down because the
  symptom did not look like a tuning mistake. The cut's band runs from
  `BLOB_LEVEL - edge` to `BLOB_LEVEL + edge`, so an edge of 0.6 against a level
  of 0.3 clamps to `[ALPHA_FLOOR, 0.9]` — very nearly the whole alpha range,
  mapped almost linearly. That is not a cut at all: nothing was firmed up, every
  pixel came out about as opaque as the blur left it, and the blur only leaves
  full alpha in the middle of something large. Measured across the zoom ladder, a
  seven-cell cluster peaked at alpha 0.25 in a heat map where the same cluster
  peaked at 1.00 in the wash. The feather compounded it: a cell's on-screen
  radius is between 2.2 and 6.7 CSS pixels at every level (that is what the zoom
  ladder is for), so a 5px feather was wider than the cell it was feathering, and
  it runs *after* the last cut with nothing left to re-firm it. Both are now what
  the paragraph above always claimed: 0.2 and 1px, tighter than the wash.
  **A cell with nothing around it is a special case, and it used to be erased.**
  The level-set cut cannot keep a feature narrower than the blur, and one cell is
  narrower than the blur: a disc of `CELL_RADIUS`·R blurred by a sigma of
  `BLOB_BLUR`·R peaks at about a third of full alpha, which is barely over
  `BLOB_LEVEL`, and the second round then finishes it off. Measured over the
  whole zoom ladder and every display density, a lone cell came out between alpha
  0.00 and 0.08 while *any* cluster came out at 1.00 — so an isolated cell was
  never faint, it was gone, at every zoom, and tuning the cut does not rescue it:
  lowering `BLOB_LEVEL` enough to save one cell inflates every blob on the map.
  It is the *ratio* of disc to blur that decides it, which is why the failure did
  not change with zoom.
  So cells the blur would eat are drawn at the size the cut can hold rather than
  at their own — `SPARSE_GROW` cell radii, floored at `SPARSE_MIN_PX` for the
  coarse sheets where a multiple of almost nothing is still almost nothing. What
  keeps that from being a global inflation is the test for *which* cells:
  **at most `SPARSE_NEIGHBOURS` lit neighbours**, and every cell along the edge of
  a real blob has at least two, so no blob anywhere changes shape. What grows is
  a cell on its own, both halves of a pair, and the tip of a one-cell-wide trail,
  where a rounder cap is the whole of the difference. It is the bargain
  `MIN_CELL_PX` already makes: past the point where a thing is too small to draw
  honestly, drawing it slightly too big beats drawing nothing.
  The neighbour test needs the lattice, so it lives in the paint loop rather than
  in the shaping: it is six `Map` lookups, asked once per canonical cell and only
  when one of its world copies is actually on the sheet. Column counts are even at
  every level by construction (see `BASE_COLS`), so a world copy never changes a
  column's parity and the canonical column can be asked directly.
  The blur runs on `ctx.filter` where the browser has it and in JS where it
  doesn't — **WebKit has never shipped `CanvasRenderingContext2D.filter`**, and
  the obvious feature test says otherwise (assigning it there just makes an
  ordinary property), so iOS was quietly drawing bare discs. Support is probed
  by behaviour instead, and the fallback is three separable box passes over
  premultiplied RGBA.
  **This is still true as of the WebKit in macOS 27**, measured rather than
  assumed: in a `WKWebView` there,
  `'filter' in CanvasRenderingContext2D.prototype` is `false`. So every WebKit
  client — mobile Safari, both native apps — takes the JS path, and Chrome
  never does. That difference is the whole reason zooming can feel fine in one
  browser and heavy in another on the same machine.
  Because that path costs six CPU passes per pixel, the sheet is bounded by
  **area** as well as density: **`JS_BLUR_MAX_PX`** (300k) caps the pixel count
  whenever the blur is in JS. The dpr cap alone bounds *sharpness*, and a
  desktop window changes *size* — measured on a retina Mac, an iPhone-sized
  sheet is 131k pixels and ~9 ms a repaint where a 1440×900 window asks for
  514k and ~35 ms, four times the work for the same code at the same density.
  A level change pays that, and the crossfade after it recomposites a canvas of
  the same size every frame, so a big window was the one place blobs felt slow.
  The cap never binds on a phone or a small window, and is lifted entirely for
  the image export (`maxPixels: Infinity` in `paintBlobSheet`), which paints
  once and wants every pixel.
  Four more things keep that path off the critical one, all of them measured in
  a real `WKWebView` against the previous code and all producing byte-identical
  sheets. **The blur only runs over the ink**: the sheet covers the padded
  viewport — nearly three times the area on screen — while the lit cells often
  occupy a corner of it, so `paintBlobSheet` tracks the bounds of the discs it
  drew, grows them by every round's box reach, and hands that one rectangle to
  each pass. A window with a single cluster in it went from ~150 ms a paint to
  ~15 ms; a window lit corner to corner is unchanged, which is the right shape
  for the trade. A sheet with nothing lit at all returns before the first blur.
  **The float planes are kept between calls** rather than allocated per blur —
  at the cap that is two 4.8 MB arrays three times a paint, ~29 MB of garbage
  per repaint, and removing it is what took the occasional 107 ms paint back
  down to the median. **The three canvases are only resized when the size really
  changed**, which is almost never: `mercW · pxPerMerc` is the padded viewport
  measured in canvas pixels and the zoom cancels out of it, so a window that
  isn't being resized paints the same `w×h` at every level and every zoom.
  Assigning `canvas.width` was being used to clear, and it also discards the
  backing store. And a level change **during** a gesture paints to
  **`MOVING_MAX_PX`** (120k) instead — the one repaint the never-mid-gesture
  rule can't refuse, since the dissolve has nothing to dissolve into without it
  — with `main.js` repainting at the full budget once the camera has stopped
  *and* the dissolve has landed. A 620 ms crossfade of a smaller sheet is
  cheaper on every frame, not just at the paint.
  The canvas is pinned as a MapLibre canvas source to a rectangle of *ground* —
  four lng/lat corners covering the padded viewport — rather than to the window,
  which is what lets the map be turned: the sheet is drawn by the same matrix as
  the basemap, so it rotates with it and would foreshorten under a pitch without
  anything in `blob-canvas.js` knowing. Which rectangle to ask for is
  `src/view.js`'s answer and no longer a north-up assumption — see
  [Turning the map](#turning-the-map). It repaints on level changes, zoom drift
  and moveend — never mid-gesture, where the existing image simply scales with
  the map until you let go.
- **Level changes** cross-dissolve over `LEVEL_FADE_MS` *inside* the blob
  canvas: the outgoing level is frozen into a buffer with its own Mercator
  rectangle, the new one is painted over it, and only the mix changes while the
  layer's opacity stays put. Handing over between two canvas layers does not
  work — a canvas source uploads to the GPU asynchronously, so the incoming
  layer shows whatever texture it was still holding (usually the cleared one)
  for a frame or two, which makes a single zoom look like the level changed,
  reverted, then changed again. Crossing to the country level *is* a layer
  crossfade, since the two sides live on different layers; nothing is copied
  there, and the outgoing opacity is derived from the incoming one rather than
  ramped independently (two linear ramps sag to ~0.51 of a 0.6 alpha halfway
  across, which reads as a flash). A canvas dissolve still running when the
  gesture reaches that boundary is landed first, so the blob can't keep morphing
  between two old levels while it fades out.
  Each frame of that dissolve recomposites the sheet, so what the frame does
  *not* do matters as much: the mapped rectangle is only pushed to MapLibre when
  it has actually changed (`setCoordinates` recomputes the source's tile, walks
  every zoom for overlaps and fires a `content` event, which makes MapLibre
  reload and re-evaluate the tile cache — and the rectangle is fixed for the
  whole dissolve), the canvas source is played once and paused when the pixels
  stop changing rather than paused and replayed per frame (`pause()` runs
  `prepare()`, so the old shape uploaded the whole texture twice a frame), and
  the composite canvas is cleared in place instead of being resized to the size
  it already was. The country geometry is also
  **pre-warmed**: ~800 KB of boundaries takes a MapLibre worker ~60 ms to parse
  and tile, and feeding it to the source at the moment the fade starts means the
  countries simply aren't drawable for the first chunk of it — the blob is
  already dimming by then, so one zoom-out reads as level → nothing → country.
  A zoom level before the crossing the data is loaded onto `hex` and pinned
  invisible (`hexRole = 'warm'`), so the crossing itself only ramps opacity, and
  it stays tiled until the zoom is well clear of the boundary. Zoom-in never had
  the problem — there the countries are already on `hex` and fade out where they
  stand. Two rules keep the warm layer from becoming its own glitch: the opacity
  is pinned to 0 **before** the geometry is handed over and is never raised
  again while a hex level is live (`setData` returns as soon as the worker has
  been *told* about the new data, so the tiles on screen are still the old ones
  for a frame or two — raising the opacity next to that is a flash), and
  releasing the tiles uses a much higher threshold than warming them
  (`COUNTRY_COOL_ZOOM`, clear of the L3 ↔ L4 boundary) so zooming around a
  boundary can't drop and re-parse 800 KB on every crossing. Load with `?debuglevels` to log every committed level change with its
  zoom; one gesture should print exactly one line. Two rules keep the vector side out
  of the way: country geometry is viewport-independent, so the level claims the
  whole world as its coverage and a pan or zoom never rebuilds it; and the
  outgoing countries fade **where they already are** rather than being copied to
  the `-prev` layer, because re-feeding a GeoJSON source re-tiles it — which is
  the last thing that should happen to a layer mid-crossfade.
- **Vector fallback**: the country level always renders as real polygons, and
  so does everything else on a browser without canvas filters — the hex union
  is chained into closed loops and relaxed with Chaikin corner-cutting
  (`SMOOTH_ROUNDS`/`SMOOTH_CUT` in `src/main.js`). Cells outside the built
  window count as unlit so loops always close, and holes nest correctly.
- **Coloring**: *Single* paints everything in the accent color. The other three
  color each cell from its own rolled-up history. **Visits** (separate visits,
  log scale) and **First seen** (earliest date) run along a ramp and let the
  shades flow together; cells with no date at all stay grey instead of being
  parked at one end of it, and the legend says what the ends mean at the current
  zoom. **Type** is categorical instead — a color per app the cells came from,
  so the legend is a list of swatches rather than a gradient, and a cell several
  sources cover goes to whichever saw you there most often (a whole country, to
  whichever covers the most of its ground). Each of those swatches is also a
  switch — see [A legend you can press](#a-legend-you-can-press). At the country
  level all four apply per country. Single-color mode's swatch opens the app's
  **own color picker**
  (`src/color-picker.js`) rather than the OS one, and the map repaints as you
  drag. Every colour it produces can carry an **opacity** — see
  [Colours with an opacity](#colours-with-an-opacity).
  **There are two of them, one per basemap theme** (`accents.light` /
  `accents.dark`, with `accent` pointing at whichever the basemap on screen
  calls for). The colour is chosen *against the map underneath it* — that is why
  the picker repaints on every drag frame instead of showing a swatch — and that
  map is two different maps: a confident blue over Dark is a pale wash over
  Voyager, and a weight that reads on the light basemap glares over imagery. One
  value could only ever be right for one of them. `syncAccent()` does the swap
  on a basemap change and is a no-op between two basemaps of the same theme,
  which is most of them, so the blob canvas is not re-rastered for nothing. Only
  single-colour mode has two: the heat maps never touch the accent. Stored under
  `visited-map:colors:v1` and in the account as `accents`, with the old
  single-value key and the old `accent` field still written so a rollback — or a
  phone on an older build — keeps working; a copy of either that predates the
  split is read as "this colour stands for both", since nothing records which
  basemap it was picked against. Pressing whichever mode
  is already on takes the visited areas off the map altogether: the panel could
  do everything except get out of the way, and "what does this valley actually
  look like" is a fair question to ask of a map you have painted over. One flag
  (`cellsOn`), read through `accentAlpha()`, so every surface that draws the
  wash — the blob raster, the region fills, the region outlines — goes with it,
  and `heatMode` is left alone so coming back returns to the mode you had.
- **Reference overlays**: two, switched on from the layers menu and configured in
  Settings. **Train tracks** are OpenRailwayMap's vector tiles through a caching
  proxy — see [The train tracks, in vector](#the-train-tracks-in-vector).
  **Airports** are the opposite arrangement: a public-domain dataset built into
  the app, one file per group so a switch that is off costs nothing, and no
  server involved at all — see
  [The airports, from a file rather than an API](#the-airports-from-a-file-rather-than-an-api).
- **Saved routes**: track files can keep the line they drew, not just the ground
  it covered — see [Saved routes](#saved-routes) below.
- **Photographs**: a point wherever you have taken one, grouped where they pile
  up, and the picture itself when you tap it. The only layer that draws
  something the server has never seen — the pictures come from the phone the
  page is running on, so the switch is in the menu **only inside the iOS app**.
  See [The photographs themselves, from the phone in your
  hand](#the-photographs-themselves-from-the-phone-in-your-hand).
- **Region borders**: `SHOW_REGION_BORDERS` in `src/main.js` toggles the crisp
  outline and glow around visited regions. It defaults to `false` for a
  fill-only appearance; edit-mode tile guides are unaffected.
- **Statistics**: *Routes and statistics* has two tabs, Routes and Statistics —
  trips live in the search panel (see [Search](#search)), which is where the one
  list of them is. **Cells** measures
  actual ground covered — each cell's area is its Mercator hex area × cos²φ — as
  a share of Earth's land and of every country it touches (attributed by the
  country under each cell's center, with country areas computed from the
  boundary polygons), sortable by ground covered or by share, plus how many days
  the history carries and the longest unbroken run of them, where the cells came
  from, and how much new ground each year added. Each country **opens to show
  its own regions** — see [Coverage](#coverage) for why the bar is always a
  share and why the regions are nested. **Routes** is the
  list of saved tracks: totals, distance by year, and every route — tap one and
  the panel closes, the map flies to it and its card opens.
- **Ordering and grouping are two controls**, in both the routes list and the
  trips list. They used to be one, which quietly made them exclusive: picking "By
  app" threw away whatever order you had, and there was no way to ask for the
  longest ride *of each activity*, which is the question a grouped list is
  usually opened with. Now the sort holds *within* each block. Routes sort by
  newest or longest and group by app or activity; trips sort by newest, longest
  (in days) or furthest from home, and group by country. Both lists put the
  blocks that say nothing — an activity never worked out, a trip with no country
  under it — at the bottom rather than the top.
- **Glass tiles**: unvisited cells draw as slightly inset, sharp-cornered
  glass tiles with a whisper-thin stroke — tuned by `TILE_INSET`.

## Import location history

Open the base-map menu → **Import locations**, then pick or drop
your export files. **Any number at once, and a few at a time** — select a
folder's worth of GPX, drop a mixed pile of KML and FIT one by one as you find
them, or hand it a whole Strava ZIP and it expands the archive itself. Files
*add up* across drops until you import or clear them (a second drop used to
replace the first, which read as "it lost my file"); dropping the same file
twice is noticed and said out loud rather than counted twice. Each file keeps its own provenance rather than being flattened
into one blob: three GPX files written by Komoot, Garmin and something anonymous
arrive as three separate sources, so the map can still tell you later which app
a cell came from. Everything is parsed in the browser — the file itself never
leaves your machine, only the hex cells it resolves to. Before anything is
saved you get a preview: which format each file was recognized as, how many
location fixes it holds, how many cells that is, how many are new, the date
range they cover, and how many routes it found.

Recognized formats (detected from the contents, not the extension):

| Format | Notes |
| --- | --- |
| **GPX** | `trkpt` / `rtept` / `wpt`, with `<time>` per point; each `<trk>`/`<rte>` is also a route. A file that names its writer (`<gpx creator="komoot.de">`, a `<metadata><author>`) is filed under that app — Komoot, Strava, Garmin, Wahoo, Polar, Suunto, Runkeeper, AllTrails, Ride with GPS — instead of plain "GPX track" |
| **KML** | `<coordinates>` blocks and `gx:Track` `<when>` / `<gx:coord>` pairs (KMZ isn't supported — unzip it first); a Placemark's LineString or gx:Track is also a route |
| **TCX** | Garmin's activity XML — Laps and Tracks become route segments, so a pause isn't drawn as a straight jump |
| **FIT** | Garmin's binary activity format (`src/fit.js`); the `record` messages only — position and time |
| **ZIP / .gz** | containers, expanded in the browser — see [Strava without the API](#strava-without-the-api) |
| **GeoJSON** | every coordinate of every geometry; dates from `properties`; Line/MultiLineString features are also routes |
| **CSV / TSV** | a header row naming latitude/longitude (+ an optional time column) |
| **Google Timeline** | `geo:lat,lng` semantic timeline and older `latitudeE7` Takeout records |
| **Snapchat** | Location History rows, inferred home/work, daily top locations |
| **Apple Photos** | geotag dumps (`latitude` / `longitude` / `timestamp`) |
| anything else JSON | the parser still walks the whole tree for coordinates |

### Visits, not fixes

A cell's visit count is **not** how many location fixes landed in it, and it is
not how many times you *arrived* either. **A visit is a stay.** Fixes in the same
cell go on counting as one visit until a whole day passes with none of them
(`VISIT_GAP_SEC` in `src/locations.js`), so an hour of 1 Hz workout recording
counts once, a morning and an evening in the same place count once, and a week
living there counts once. Going back next month counts again. Files with no
timestamps fall back to run-length: each unbroken pass through a cell counts
once, and re-entering it later in the file counts again.

**The gap was an hour, and an hour measured arrivals.** That is a real question,
but it is not the one the word "visits" asks, and the difference fell hardest on
exactly the places you know best — one cell of a real map held **1,837 arrivals
against 103 stays**, because a coffee run out and back counted twice and a night
at home counted again every time the phone woke up after an hour's silence.
Across a whole Google Timeline export the totals moved 112,492 → 28,738. A day
is the shortest gap that swallows the silences *inside* a stay (a night's sleep,
a working day indoors, a phone on the charger) while staying shorter than any
real absence.

The obvious worry is a cell you pass through daily, which never sees a day-long
gap and would read as one endless visit. Measured across 6,953 cells of real
history the longest single stay is 30 days and the 99th percentile is 3, so it
does not happen. If it ever does, the fix is to break a stay on a calendar day
with no fixes rather than on a rolling 24 hours — which costs a timezone to be
right about, and is why it isn't done that way now.

**Changing the rule does not change stored history.** `hits` is computed when a
file is read, and the fixes behind an existing row were never kept — only their
first date, their last date and their count. `scripts/recount-visits.mjs`
(`npm run recount:visits`) re-reads the exports in `./import` and writes the
recount over the rows those same files put there; it shows the difference and
writes nothing without `--apply`. Sources the server fetches for itself are left
alone and converge on their own, because `mergeRow` subtracts a shared visit
using whatever the current gap is.

The raw fix count is still kept (`fixes` in `cell_sources`) and the import and
sync screens still report it, because "this file held 40,000 points" is a fact
about the file. The cell card used to show it underneath the visit count
whenever the two differed, which was nearly always and never meant anything: it
says how often a recorder happened to sample, so an hour parked with a workout
app running outranked a week somewhere. It is no longer shown as a fact about a
place — `rollUpIds` doesn't even total it.

**Re-importing is the point.** Cells are stored per source, so importing the
same export again refreshes its dates and visit counts in place rather than
duplicating anything, and importing a *newer* export adds only what's new. Use
**Record as** to relabel a file (a generic KML that's really a Google Maps
export), and **Replace earlier import from this source** when the new file
should be the whole truth for that source — cells it no longer contains lose
that source's claim, and only disappear from the map if nothing else vouches
for them. Cells that predate provenance tracking show up as *Unknown* until an
import covers them, at which point the real source takes over.

### Offline import (optional)

`npm run import` does the same thing from the command line: drop the files in
`import/`, run it, and it writes `src/imported-cells.json`, which the server
merges **once** (keyed by the file's timestamp) into the account named by the
`IMPORT_OWNER` env var. It's there to seed your own account on first run; the
in-app importer is the normal path — and the only one that saves routes, since
routes belong to an account rather than to the repo.

## Sync

Menu → **Sync** is the door in front of every app the map can pull from, as
opposed to files you export by hand:

| | |
| --- | --- |
| **Home Assistant** | Followed on a schedule by the server, so the map keeps filling in on its own |
| **Komoot** | One tour at a time, from a share link, fetched by your browser |
| **Strava** | Your activities, brought across on a schedule after a one-time sign-in |
| **Your phone** | The iOS app recording where it has been, and the workouts in Apple Health that went somewhere |

### Strava

> **Since 1 June 2026 the Strava API needs a paid Strava subscription.** The
> OAuth sync below still works if you have one. If you don't, use the **bulk
> export** instead — it is free, it brings your whole history in one go, and
> the importer reads it directly. See [Strava without the API](#strava-without-the-api).

Strava only talks to *registered* apps, so you register one of your own:
[strava.com/settings/api](https://www.strava.com/settings/api). Set its
**Authorization Callback Domain** to the host you use this map on (the dialog
tells you what to put), then paste the Client ID and Client Secret in and sign
in once.

A brand-new Strava app is limited to a single athlete until you ask them to
raise it — which is exactly one more than this needs.

Unlike Komoot, this half runs on the **server**, for two reasons: the token
exchange needs the client secret, which must not ship inside a page anyone can
view-source; and the schedule has to survive the tab being closed. The secret
and both tokens live in `data.db` and are never sent back to the browser.

- Each poll lists activities started after the cursor, then fetches the
  `latlng` + `time` streams for each new one — the recorded line, not the
  simplified `summary_polyline`. Cells and a saved route both come from it.
- **Indoor work is skipped**: `VirtualRide`/`VirtualRun`, anything flagged
  `trainer`, and anything with no GPS at all. Zwift is not ground you covered.
- Routes come in unnamed and are given their geographic name by the browser on
  next load, through the same backfill the file importer uses — the place-name
  dataset is a 2 MB browser chunk and doesn't belong on the server.
- At most 25 activities per run, so importing years of history catches up over
  a few polls instead of spending the whole rate limit at once (200 requests /
  15 min, 2,000 / day for a personal app).
- The cursor only moves forward, and `state` on the OAuth round trip is
  one-shot — a replayed or forged callback can't attach an account.

Strava's API terms restrict what you may do with *other people's* data; your
own activities on your own map is the case this is built for.

### Strava without the API

There is no paste-a-link route for Strava the way there is for Komoot, and it
isn't for want of trying: `strava-embeds.com` sends no `Access-Control-Allow-Origin`
header, so a browser can't read it, and a public activity page now answers a
logged-out request with a 307 to `/register/free`. Everything is behind either
the login or the paywall.

The **bulk export** is the way in, and it is free and complete:
*Settings → My Account → Download or Delete Your Account → Request Your Archive*.
Strava emails a ZIP; drop the whole thing on the importer. It reads:

| | |
| --- | --- |
| **ZIP** | walked without inflating the whole archive — only `activities/` is opened, so the media folder and the hundred CSVs cost nothing |
| **gzip** | `.gpx.gz` / `.fit.gz` / `.tcx.gz`, which is how Strava stores most entries |
| **FIT** | Garmin's binary format — what every phone and bike computer actually uploads, so most of the archive |
| **TCX** | Garmin's XML format |

All of it runs in your browser on `DecompressionStream`, with no new
dependency and nothing sent to the server. Everything under `activities/` is
filed as **Strava**, so it groups with the API-synced rides rather than landing
as a pile of anonymous tracks.

The archive is checked as it is read: entry checksums are verified, so a
truncated or damaged download is refused with a readable message rather than
quietly lighting up a hexagon from corrupt bytes. FIT coordinates carrying the
"invalid" sentinel are dropped rather than plotted at the north pole, and a fix
whose clock is obviously wrong (a dead backup battery, a GPS week rollover)
keeps its position but loses its date instead of pinning a cell's "last seen"
decades into the future.

### Komoot

Paste **as many tour links as you like** — one per line, or separated by spaces
or commas, or buried in a sentence you copied out of a chat; anything that looks
like a tour URL is pulled out and anything else is ignored. They're read
**straight from this tab**: the server never sees the links and never makes the
requests, so pasting a hundred tours costs it nothing.

Tours are fetched one at a time rather than all at once — a burst of parallel
requests at somebody else's undocumented API is how a personal integration gets
itself rate limited — and the button counts down as it goes. A tour that can't
be read (private without its share token, or a mistyped id) is reported on its
own line and **skipped**, so one bad link out of ten doesn't cost you the other
nine. The points of every tour are folded into cells in a single pass over the
combined timeline rather than tour by tour, which is what keeps two rides
through the same cell on the same afternoon counting as one visit rather than
two. Komoot has no documented public API, but the one its own site uses
(`/api/v007`) answers a plain GET and sends `Access-Control-Allow-Origin: *`,
which is what makes a browser-side fetch possible at all.

Two calls: the tour (name, date, sport, distance) and its coordinates, which
come back as `{lat, lng, alt, t}` with `t` in milliseconds from the start — so
the tour's own date turns the list into real timestamps, and the usual cell
folding and visit counting apply unchanged. **No GPX download is involved**;
this is the same data one step earlier. Private tours need the share link (the
one carrying `share_token`); without it Komoot answers 403.

Being undocumented, that API can change without notice — everything fails with
a readable message rather than assuming a shape.

### Home Assistant

Every other source is a file you remember to export. Home Assistant is the one
the server goes and fetches by itself, so the map keeps filling in on its own.

Sync → **Home Assistant**: paste the address you open Home Assistant at and a
long-lived access token (your profile → Security → bottom of the page), press
**Connect**, and tick the devices to follow. From then on the server asks your
instance what those `device_tracker` / `person` entities did since it last
looked, and folds the answer into cells as source *Home Assistant* — same hex
grid, same visit counting as an imported file.

- **It reads history, it never asks for a position.** Every poll is a
  `/api/history/period` read of what the recorder *already* wrote down. Nothing
  here calls `homeassistant.update_entity`, `device_tracker.see` or anything
  else that would wake a device — syncing every 5 minutes costs your phone's
  battery exactly as much as syncing every 3 hours, which is nothing. How often
  fixes appear is decided entirely by the companion app's own settings.
- **It pulls, it doesn't listen.** Nothing has to reach *this* server from the
  outside; it only has to be able to reach Home Assistant. If the map is down
  for a day, the next poll asks for a longer window and catches up, because
  Home Assistant's recorder still has it. (That recorder keeps ~10 days by
  default, which is also how far back a fresh connection backfills.)
- **Nothing is inferred.** Only fixes Home Assistant actually recorded become
  cells. Two fixes an hour apart leave a gap, and the gap stays — the ground
  between them is not filled in, guessed at, or drawn. A sparse day looks
  sparse, which is the honest answer for a map whose whole claim is *I was
  here*.
- **Vague fixes are skipped.** A cell is about 900 m across, so a fix the phone
  itself calls loose (cell-tower fallback, indoors) can land in the wrong one.
  Anything reported as worse than the *Skip vague fixes* threshold — 250 m by
  default — is dropped. Trackers that report no accuracy are taken at their word.
- **The cursor only moves forward.** Each poll records how far it read, so
  nothing is fetched or counted twice. Adding a device later starts it from now
  rather than re-reading history, and disconnecting and reconnecting can't
  rewind into days already counted.
- **Pick one entry per device.** A `person` mirrors the tracker it follows, so
  ticking both counts every fix twice.

The access token is stored in `data.db` and never sent back to the browser —
the dialog shows an empty field for a connection that already has one.
Disconnecting throws the token away and leaves the cells it brought in, since
those came from real fixes. Setting `COOKIE_SECURE=1` and putting the whole
thing behind HTTPS/Tailscale is the sane way to host this.

### The phone itself

Home Assistant is an address the server can go and read. A phone is not one: it
moves, it sleeps, and it is behind whatever network it happens to be on. So this
is the one connector that **pushes** — the iOS app records where it has been and
posts batches when iOS grants it a moment of runtime.

It is also the only source that needs no other app in the middle. Home Assistant
exists in that story as a place your phone already reports to; here the phone
reports to the map directly, and the answer to "how do I get my location history
in" stops being "first, install a home automation platform".

Everything past the front door is deliberately identical to a Home Assistant
poll: plain `{lat, lng, t}` fixes, folded by the same `pointsToCells()`, merged
with the same `mergeRow` seam arithmetic. A cell does not care which of them put
it there and a visit means the same thing either way — see
[Visits, not fixes](#visits-not-fixes). What differs is only who moves first.

- **Two settings live on the phone, and both for the same reason: it is the only
  side that knows the answer.** *How often to record* could not be a server
  setting, because a schedule stored here cannot wake a sleeping phone — the
  timer runs there or it does not run. *Which fixes are too vague to trust* is a
  property of the fix as CoreLocation hands it over and is gone by the time it is
  a pair of numbers; Home Assistant needs a server-side threshold only because
  the server is the thing doing the reading.
- **Sending the same batch twice is the normal case, not the pathological one.**
  A push has a failure the pollers cannot have: the app does not know whether it
  landed. A 200 lost on the way back is indistinguishable from a timeout, and the
  queue is retried. So `device_links.cursor` records the newest fix each phone has
  sent and anything at or before it is dropped — which makes a retry a no-op
  without the app having to reason about it. It is safe because the queue is
  FIFO: fixes leave the phone oldest first, so "already seen" and "older than the
  cursor" are the same set.
- **Nothing is inferred, exactly as for Home Assistant.** Two fixes an hour apart
  leave a gap and the gap stays. A sparse day looks sparse.
- **The status row is the point of the web dialog.** There is nothing to
  configure from a browser, and Sync → *Your phone* exists anyway, because a
  logger whose output you cannot see is indistinguishable from one that stopped a
  fortnight ago. Forgetting a phone drops that row and leaves its cells, which
  came from real fixes.
- **The app's own status survives a relaunch, and had to be taught to.**
  `TrackingSettings.SyncStatus` was memory-only, so "Last checked" answered
  *Never* after every cold launch however diligently the thing had been running
  — and Photos reads at most once every six hours, which the app is relaunched
  far more often than, so the honest answer was on screen approximately never.
  The dates and counts are written through to `UserDefaults`; `pending` is not,
  because the queue is on disk and counts itself, and neither are `lastError`
  and `signedOut`, because both are claims about *now* and a stale one shown at
  launch describes a failure that may already have mended.
- **Everything that runs on a timer has to be started at launch, not only when
  its switch is thrown.** `LocationLogger.resume()` and `HealthSync.apply()`
  were called from the app delegate and `PhotoSync` was not, so on a phone that
  had had the photo switch on for months there was no library change observer
  registered and no scan — the screen said *Never* and was telling the truth.
  `PhotoSync.resume()` joins them, and seeds its six-hour gap from the persisted
  date so a cold launch is not automatically due: a photo scan sends the library
  whole, and is the one thing here that is not cheap to repeat.

**Is that address a Hexplore server?** `GET /api/health` is the only route that
answers before anybody has signed in, and it exists for the Settings tab: you
type an address there and, until now, the only way to find out whether it was
right was to open the Map tab and see whether a web view stayed white. A typo, a
server that is down, a tailnet you are not on and something else answering on
that port all looked identical, and none of them looked different from being
signed out.

A 200 is not enough to say yes. On a home network an address with the *wrong*
thing behind it is commoner than one with nothing — a router's admin page, a NAS,
another container on the same box — and all of them answer 200 to something. So
the route names itself, `{app: 'hexplore', version}`, and the phone reports three
different states in three colours: green for a Hexplore server and its build,
**orange** for something that answered and is not one, red for no answer, with
the HTTP status or the `URLError` code, which is the part that can be searched
for.

It says nothing else, deliberately. It is the one route anybody who can reach the
port can call, so it reveals nothing about who has an account, what is on the map
or whether registration is open. The version is already public to every
signed-in page and is what makes "which build am I looking at" answerable from
the phone.

Cells arrive under the source **`iphone`**, which is a *kind* of source rather
than a particular handset — two phones both say "iPhone", and which one it was is
in the device list. That matches how every other source works and is the reason
`device_links` is a separate table from `cell_sources` rather than a column on it.

#### And a Mac, pushing through the same door

`HexPlore-macOS/` is the same client for a machine that is not a phone, and it
posts to the same `/api/device/fixes` with the same `{device, fixes}` body. The
server does not distinguish them and should not: the contract above — FIFO
queue, forward-only cursor, retries that are no-ops — is about how a *pushing*
client behaves, not about what it is running on.

What is genuinely different is what the client can promise, and it is worth
recording because it is invisible from this side. **macOS does not relaunch an
app for a location event and does not wake a sleeping machine to take a fix.**
The significant-change monitor exists there, but the job it does on iOS — being
the one service that resurrects a terminated app — it cannot do. So a Mac
records while HexPlore is running and not otherwise, which makes it a real
source for a laptop that travels and close to a dead weight on a desktop. The
setting therefore starts *off*, and the sparse days that result are honest in
the same way every other gap here is honest.

Two consequences worth knowing:

- **`allowsBackgroundLocationUpdates` is not set on the Mac, and must not be.**
  CoreLocation documents setting it without `UIBackgroundModes` as *a fatal
  error*, and there is no such key on macOS. It is the one line of the phone's
  logger that would crash the port.
- **Its cells are still filed as `iphone`**, because `DEVICE_SOURCE` is a
  constant on the shared endpoint. The device list is right — it carries the
  machine's name and `platform: "macOS …"` — so this is a label on the cells and
  nothing more. Making it its own source means teaching this endpoint to choose
  one from the platform and giving it a name in `src/locations.js`; that is a
  change to the path the phone's logger runs through, and it is worth making
  deliberately rather than as a side effect.

### Workouts out of Apple Health

Health is where everything ends up. A ride recorded on a Watch, a walk from
Fitness+, a run from a third-party app that also writes there — they are all
already on the phone, already finished, already carrying their route. Fetching
them through somebody's API would be a round trip to collect what is in the next
process along.

They land as source **`apple-health`**, and like a Strava activity each one is
both a set of cells and a saved route, built with the same `buildRoutes()` the
browser importer uses.

- **Only the ones with geography.** Most workouts are not places: a gym session,
  a pool swim, twenty minutes on a rowing machine. The filter is not a heuristic
  about the activity type — it is whether the workout carries an
  `HKWorkoutRoute`, which is Health's own answer to the same question and is
  right about the cases a type list gets wrong. An indoor cycle has no route; an
  open-water swim does.
- **The ids are remembered, not a cursor.** A workout's cells are *added* to
  what is already there, so taking one twice is a place visited twice. Strava can
  lean on a monotonic cursor for this and Health cannot: it hands back an edited
  old workout as readily as a new one, and the app's query anchor is lost on
  reinstall. `device_workouts` holds the `HKWorkout.uuid`s instead, which is what
  makes a first sync of eight years of rides safe to give up halfway through.
- **The barometer's ascent is kept.** `HKMetadataKeyElevationAscended` is a
  better number than anything derivable from GPS altitude. When Health does not
  offer one, `buildRoute` works it out from the line like every other source.
- **The activity name is sent as a lower-case synonym**, not a finished label, so
  `canonicalSport` in `src/routes.js` stays the single place that decides how an
  activity is spelled — the same door a Komoot "racebike" and a Strava "Ride" go
  through.

#### A route is not one line

A workout's route arrives as a single undifferentiated stream of locations,
however many times the recording stopped. Taking it at face value drew two
things that never happened, and both were reported on the same afternoon:

- **A 16.7 km line from Thun across a 1.17 km walk in Gümligen.** One fix from
  before the watch had a GPS lock — the last place it knew about — with an
  accuracy in the kilometres. It also dragged the route's start time back with
  it, because `buildRoute` takes `firstAt` from the earliest point it is given,
  so a fourteen-minute walk reported thirty-seven.
- **A straight line across a pause**, joining two ends of a ride ten kilometres
  apart. Apple's own Fitness app draws that stretch **dotted**, which is the
  whole argument in one design decision: it knows it did not record that part.

**And it was never only Health.** Strava hands back one flat stream of points
however many times you stopped, and Komoot the same; both were drawn straight
across too, and nobody had noticed because nobody had looked. The formats that
arrive as *files* were fine all along, because the file says where the breaks
are — a GPX puts each in its own `<trkseg>`, TCX has laps, KML has separate
coordinate blocks.

So the cut lives in **`splitOnGaps` in `src/routes.js`**, called by `buildRoute`
on every track from every source on the way in, rather than three times in three
parsers with three sets of numbers:

| | |
| --- | --- |
| **Pause** | A gap of more than `TRACK_GAP_SEC` (60 s) **and** more than `TRACK_GAP_M` (150 m) starts a new line |
| **Teleport** | Over `TRACK_MAX_SPEED_MS` (30 m/s ≈ 108 km/h) between two fixes, whatever the clock says |

**It takes two measurements to call something a pause**, and that is the whole
subtlety. Time alone would cut a track every time somebody stood still — which
after thinning is most tracks, since five minutes outside a café is one long gap
between two points six metres apart. Distance alone would cut one on every
descent, which covers 150 m in under ten seconds. Only both together mean the
recorder was not watching for the part in between.

A run of a single point is dropped, which is what removes the stale fix: it has
nothing either side of it. That also keeps it out of the **cells**, because
`healthWorkout()` takes a workout's points from the runs that survive rather than
from everything that arrived — one bad fix is otherwise enough to put a place you
have never been on the map.

Cut before simplify, not after: Douglas–Peucker keeps the points furthest from
everything else, so the two either side of a gap survive while the run they
belong to may not, and it would in any case be thinning a line that had already
been joined up. Ascent is measured on the runs too — a pause that ends 300 m up
a hillside is not 300 m you climbed.

**What stays on the phone is accuracy**, and only that, because it is the one
thing that cannot travel: `horizontalAccuracy` is a property of the fix as
CoreLocation hands it over and is gone by the time the point is a pair of numbers
on the wire. `HealthSync` drops anything worse than 100 m. The logger has a
*setting* for the same idea and this has a constant, deliberately — a phone in a
pocket genuinely does spend the day on cell-tower fixes, but a watch recording a
walk has GPS lock, so a 1,500 m reading in the middle of one is a glitch rather
than a coarse answer.

All of which is the rule the rest of the map already follows, applied where it
had not been: nothing is inferred, and the ground between two fixes is not filled
in, guessed at or drawn.

#### Named after the time of day

A file names its tracks and Komoot and Strava name their activities. Apple Health
does not — you do not title a run — so the date was the only thing left to call
one, and a Routes list built from Health read as a column of ISO dates: accurate,
and no help at all in finding the ride you were looking for.

`trackName` in `src/routes.js` gives "Morning walk", "Evening ride" — what Strava
and Health itself put at the top of the same screen, and better for the reason it
is unremarkable: the two things anyone remembers about an outing are roughly when
in the day it was and what they were doing. The date is still in the row beside
it and the place name the browser works out later replaces neither. It sits next
to `SPORT_SYNONYMS` because it needs the same one vocabulary — `sportNoun` turns
the label back into the noun, since "Cycling" is how the app spells the activity
and "ride" is what you call the thing you did.

The hour is read in the server's own timezone, which for a self-hosted map is the
machine in the next room. That is right often enough to be worth having and wrong
only for a workout recorded abroad, where the cost is a ride at 7 p.m. filed as
an afternoon one.

#### Reading it again

`POST /api/device/health/reset` is the one destructive call in the connector, and
the guards above are what make it necessary. Workout ids are remembered so a
re-send cannot double-count — which also means a workout stored from a bad
reading can never be corrected, because the phone offers it and the server
answers "known". And cells are merged rather than replaced, so re-taking the same
workouts on top of the old ones would count every visit twice.

It drops the `apple-health` cell rows, the `apple-health` routes and the
remembered ids. Nothing else: a cell another source also vouches for keeps that
source's row and stays on the map, because provenance is per source. The phone
drives it from Settings → Apple Health → *Re-read from the start*, and clears its
own query anchor in the same breath — clearing only one side leaves either a
phone that thinks it is caught up or a server that recognises everything it is
offered.

### The session it uploads with

There is no native login and there should not be one: a second session to keep in
step with the first is the bug, not the feature. The app borrows the web view's —
after every page load it copies the site's cookies into `HTTPCookieStorage`,
which is the jar `URLSession` reaches for unasked.

That this survives a relaunch is a property of the *server*: `sessionCookie()`
sets `Max-Age`, so `sid` is a dated cookie rather than a session one, and a phone
relaunched into the background at 4 a.m. by a location event still has it. Had it
been a session cookie, background syncing would have quietly never worked — which
is the sort of thing that looks like a networking bug for a week.

### Filing one under a different name

`unknown` is not really a source: it is the placeholder the pre-provenance
migration left on every cell from before the map knew where anything came from.
The intended way out is for a real import to cover those cells and take their
place — every import path deletes the `unknown` row for a cell it claims — but
that only ever reaches the cells some export still remembers. Whatever is left
was genuinely put there by hand and had no way of ever saying so.

**`manual` is the other one**, and it is treated the same way, because it is the
same kind of non-answer: a cell you tapped on the map carries no dates, no visit
count, and a `hits` of 1 that is a stand-in rather than a number. Every reader
already skipped both when totalling visits; what they did *not* do was stop the
two rows coexisting. So `PLACEHOLDER_SOURCES` in `server/index.js` names both,
and `clearPlaceholders()` is what the six recording paths call — the phone, Apple
Health, Apple Photos, Home Assistant, Strava and a file import. A source that
recorded actual fixes in a cell takes the placeholder's place instead of sitting
beside it: *I was here* and *here is when I was here, and how often* are the same
claim, and only one of them is worth keeping.

The other direction is guarded too, and it is the one that made the pair happen.
`POST /api/cells/mutate` wrote its `manual` row unconditionally, so a brush drawn
across ground your phone had already tracked filed those cells under both names —
even though the page had always believed otherwise (`markCell()` leaves existing
provenance alone and says so in a comment). It now declines to add a placeholder
to a cell a real source already vouches for. This matters because
**Settings → Sources counts rows, not cells** (`sourceTally`, a `GROUP BY
source`), so a cell claimed twice was counted twice, and somewhere your phone had
tracked for a year went on being reported as somewhere you once marked by hand.

The trade is that a hand mark is genuinely given up rather than kept in reserve:
delete that source afterwards — Settings → Sources can — and the cells go with
it, where before the hand mark would have held them. That is the same bargain
`unknown` has always made here, and the reason it is the right one is that the
placeholder was never the better record of the two.

`POST /api/sources/rename` says it. It is not an `UPDATE`, because
`(user, cell, source)` is a primary key and a cell may already hold both names,
so each row is merged into the target with the same arithmetic a poll uses —
the span widens, the counts add up — rather than colliding with it or quietly
overwriting it. Routes carry a source too and are renamed with it; there is no
collision to worry about there, since a route's key is a hash of its geometry.

### Photographs

A photo carries the coordinate it was taken at, so a library is a record of
everywhere you have been with a camera in your hand — which for most people is a
better account of the last decade than anything they deliberately kept. Getting
at it used to mean running a command over an export and importing the file that
produced; the iOS app now reads the library directly, because the library is on
the phone and there was never a reason to go via a file.

**Nothing but two numbers and a date is read.** `PHAsset` carries `location` and
`creationDate` as metadata, so the app never opens an image, never asks for image
data, and never touches iCloud. A library of eighty thousand photographs is read
in a second or two because it is a database query rather than a file walk.

**It replaces rather than adds, and it is the only source that does.** Every
other one is a partial account of a period — a file covers the dates it covers, a
poll covers since it last looked — so folding it in is right and dropping what it
no longer mentions would be wrong. A library is not a period. It is the whole
answer to "where have I taken a picture", and a photo deleted from it is a claim
withdrawn. So `/api/device/photos` upserts every cell the library accounts for
and deletes the `apple-photos` rows it no longer does, scoped to that one source
so a cell another source vouches for stays.

That is also why the library arrives in **one request** rather than in batches.
Visits are counted across the whole set, so ten uploads would be ten independent
counts merged into a wrong one — and there would be no moment at which "what it
no longer mentions" was knowable. 200,000 coordinates is about 6 MB.

**An empty library is refused, not obeyed.** Permission granted for no photos, a
scan that failed halfway, a phone still indexing after a restore: all three
arrive as an empty list, and taking one at its word would wipe a decade of
geotags on the strength of it.

**Seeing them is a separate feature, and a separate decision.** The same library
is read again by the map's photo overlay — a point per photograph, and the
picture when you tap one. It is switched on in the layers menu rather than here,
it asks for permission on its own account rather than leaning on the switch
above, and no image it opens is ever uploaded. See [The photographs themselves,
from the phone in your
hand](#the-photographs-themselves-from-the-phone-in-your-hand).

**The file import is deprecated.** `apple-photos` is gone from `IMPORT_SOURCES`
— the only source ever removed from it — because a file relabelled *Apple Photos*
would be adopted and then silently wiped by the next scan from the phone.
Detection is left alone, so an old export dropped in still lands under the right
source for anyone who has not moved over.

### Taking a source back off the map

Clearing a cell says *I was never here*, whoever put it there, and drops every
source's claim on it. That is the right question to answer when you disagree with
a **place**, and no use at all when you disagree with a **method** — an export
you have stopped trusting, a connector you have replaced. Re-importing refreshes
rows and never removes the ones a source has quietly stopped claiming, so until
now anything that had once put something on the map could not be taken back off
it.

Export & settings → Settings → **Sources** lists everything that has, with its
cells and its routes,
and removes one wholesale: `POST /api/sources/delete` → `forgetSource()`. A cell
another source also vouches for keeps that row and stays on the map, because
provenance is per source.

`forgetSource` is a function rather than two DELETEs because some sources have a
**memory** of how far they got, and leaving it behind turns "remove this and
start again" into "remove this and watch nothing come back":

| | |
| --- | --- |
| `apple-health` | the remembered workout ids, and the phone's query anchor |
| `iphone` | the per-device cursor, which would otherwise swallow everything the phone still holds |
| `apple-photos` | nothing — every scan is the whole library |

The dialog arms the button before it fires it, rather than raising a
confirmation: a modal on top of a modal reads as an error message. It also says
which kind of loss it is — a source that can be read again says so, and one that
cannot says that instead.

### Closing the account

Export & settings → Settings, last row and set apart by a rule: **Delete this
account**, `POST /api/account/delete` → `deleteAccount()`. Every cell, every
saved route, the preferences, the Home Assistant and Strava links, the remembered
workouts, the device rows and the sessions — then the account itself.

**There are no foreign keys in this database**, so nothing cascades and nothing
complains. `DELETE FROM users` on its own leaves every one of those rows behind,
attached to a user id that belongs to nobody, and ids are handed out by
`AUTOINCREMENT` — which makes an orphan a row waiting for the day it is
inherited. So the tables are a written-out list, `USER_TABLES`, and the delete is
one transaction over it: a failure halfway through leaves the account intact
rather than half-erased, because a map with its cells gone and its routes still
drawn is worse than one that refused.

A hand-written list has one failure mode, and it is silent: a table added later
that nobody adds to the list. So `scripts/test/account-delete.mjs` reads the live
schema, finds every table carrying a `user_id`, and fails if the server would
have missed one. It also fills each of them for a real account, closes it through
the HTTP API, and checks that nothing survives — including `cell_sets`, the
pre-provenance blob that nothing has written in years and that an old database
still has a row in. That test is the guarantee; the list is only what it checks.

**The password is asked for again**, and this is the one place here that asks.
Everything else destructive takes back one source or one route, is scoped, and is
recoverable from a file you still have. This is the whole map, it is not
undoable, and what would otherwise stand as consent is a 90-day session cookie —
which is a fact about a browser, not about who is sitting at it. The endpoint is
rate limited like a login for the same reason logins are: it verifies a password,
so unlimited attempts is unlimited guessing.

Two things it deliberately does **not** do:

- **Delete the backups.** They are whole-database snapshots covering every
  account, so deleting them to close one would destroy everybody else's only way
  back. A snapshot taken before now still holds the account until it ages out,
  and the answer carries `backupsKept` so the app can say so rather than leave it
  to be discovered.
- **Reserve the username.** It goes back in the pool. A name held forever by an
  account that no longer exists is a worse answer on a personal server than one
  that can be taken again.

On the client the answer is treated as a sign-out that has already happened: the
session is gone before the response arrives, so `mountAuth` exposes `signedOut()`
— every teardown logging out does, without asking the server anything. The
offline caches matter most of the four, because the service worker files an
account's cells and routes under URLs that say nothing about whose they are.

## Export an image

Export & settings → **Export an image**. A picture of where you have been, cut
to the shape of a place: Switzerland with your blobs inside it and two lines
saying how much of it you have covered.

**It is not a screenshot, and the whole design follows from that.** A screenshot
is the window you happened to have open — an aspect ratio the browser decided, a
frame decided by where you last dragged, and a basemap that is somebody else's
tiles with somebody else's licence attached. Reading pixels back out of the live
map would also need `preserveDrawingBuffer` on the WebGL context, which is a cost
paid by every frame of every session for the sake of a button most people press
twice. So `src/export-image.js` draws the picture itself, on a plain 2D canvas,
from the same cells and the same boundaries the map draws from. An export is
therefore the same image on any machine at any resolution, and needs no map
instance at all — which is also what makes most of it testable
(`scripts/test/export-image.mjs`).

Four choices, and the order matters:

| | |
| --- | --- |
| **Shape** | Vertical, Horizontal or Square, each with its own proportions (4:5, 9:16, A4…), at 1× to 4× — or an exact pixel size typed in. Sets the canvas, and through it the camera, the type scale and the blob level |
| **What is in it** | Any number of regions, countries or continents — or everywhere. This is the *cut*: the selection's outline is the clip, and nothing outside it is painted |
| **Detail** | How the visited ground is generalised: blobs, or filled regions, countries or continents |
| **Color by** | The same four modes the map has |

**Shape is two levels, not one.** "Vertical" is the decision; "4:5 or 9:16" is a
detail of it, and a flat list of eleven ratios is a list nobody reads. The first
preset of each family is what that word means if you do not go looking. Quality
is a separate multiplier so the same ratio can be a post or something you put
through a printer without either being the default — and an exact size typed in
pixels bypasses it, because if you named the pixels there is nothing left for a
quality setting to say.

Sizes are **clamped, and the dialog says so**. A canvas has a hard area limit and
it is not the same one everywhere — Safari has historically refused anything over
about 16 MP and hands back a blank bitmap rather than an error. 4× of the widest
preset is 43 MP, which is a real thing to ask for and a real way to get an empty
file. `MAX_PIXELS` shrinks both sides by the same factor, so a clamp changes the
file's size and never its proportions.

**"What is in it" and "Detail" are two controls because they are two questions.**
"Show me Switzerland" and "colour it by canton" have nothing to do with each
other — you can have a picture of one canton coloured by whole countries (a flat
fill, which is the honest answer) or a picture of Europe coloured cell by cell.
Folding them into one control is how a map ends up claiming a resolution it does
not have.

**The list only offers places you have been.** All 4,553 admin-1 regions behind
a search box would mostly be places the export would draw as an empty shape. The
picker sweeps the visited cells through the same memoised
`areaOfCell` the map's own region level uses (`areaOfCellMemo` in `src/main.js`,
handed over as an accessor) and lists what comes back, biggest first.

### The preview is the camera

Fitting the frame to the selection is the right answer often enough to be the
default and never the right answer for a *composition*: half the reason to export
a country is to put it off-centre with the caption in the space beside it. So the
preview can be dragged, wheeled and pinched, and the framing is stored as a
Mercator centre and a **multiple of the fitted scale** rather than an absolute one
— which is what lets it survive switching from a 4:5 post to a 16:9 slide, and
survive the preview being drawn at a third of the size of the file.

**Pinch is not an extra; it was the only way to zoom at all on a phone.** The
picture understood a one-finger pan and a wheel, and a phone has no wheel, so the
preview was the one map in the app that could not be zoomed on the device most
likely to be looking at it. Two fingers now pan by their midpoint and zoom by
their spread, in that order — a pinch that only scales feels pinned to the middle
of the frame rather than to the fingers doing it — and both share `zoomAbout`
with the wheel, so whatever is under the anchor stays under it either way.

The second finger landing **drops the drag** rather than joining it, and lifting
one finger ends the gesture rather than resuming a drag from the other. Both are
the same bug avoided twice: carrying the gesture across a change in the number of
fingers jumps the picture by half the span between them. It also means a
two-finger tap cannot toggle a country, which a one-finger tap deliberately does.

**And it can be clicked.** Pointing at Valais is a far better way of picking it
than finding "Valais" in a list of twenty-six, and it is the reason this is the
preview rather than a separate map. A click resolves through `areaAtPoint` — the
same lookup the coverage sweep uses — so clicking a canton and having a cell in
that canton can never disagree about which canton it is.

Two rules that are not symmetrical, on purpose:

- Ticking a place **in the list** re-frames on it. Clicking one **on the picture**
  does not: you are already looking at it, and moving the camera out from under
  the cursor is the one thing that would make picking a second one hard.
- The picture's box is sized from JS rather than from `aspect-ratio`, because
  CSS will not do it: with a definite height and `max-width: 100%`, a ratio wider
  than its container has its *width* clamped and its height left alone, so a 21:9
  export came out squashed into the height of a 4:5 one. `fitBox` is the two
  lines of arithmetic that are exact for every ratio; `fitFrame` is the part that
  knows what space there is to give it. A `ResizeObserver` on the column re-fits
  it, so nothing that changes the space — the window, the card, a section folding
  open — has to remember to.

**On a phone it takes the screen including the parts that are not rectangular.**
The overlay's padding carries the `--safe-*` insets, so the title clears the
dynamic island and the buttons clear the app's own tab bar; the card's `100%`
then resolves against what is left. The controls scroll inside their own row
rather than growing — letting them grow put the rest of them past the bottom of a
fixed-height card with nothing able to scroll to them, so the list simply ended
halfway through the caption settings. And the margins shrink, because on a phone
the margin *is* the map: 24px of overlay padding and 22px of card padding either
side is a fifth of the screen spent on nothing.

**Stacked, the picture's row is sized to the picture.** It was a flat `46vh`,
which is the right row for exactly one shape — every other one sat in the middle
of it. A 16:9 export was a third the height of its own hole, and the two empty
bars above and below it pushed the controls off the bottom of the phone, so the
dialog looked like four settings and a lot of nothing. Now `fitFrame` fits to the
*width*, and tells the shell what height that came to; the row is `auto` and
follows. An `auto` row on its own is not enough and was tried: the stage's content
is a shell that says `flex: 1 1 auto; min-height: 0`, which is perfectly happy to
be nothing, and the preview came out 70px tall. The height has to be stated.

`STAGE_MAX_SHARE` is the other end of the same problem — left alone, a 9:16 poster
takes the screen and leaves the controls a letterbox. It is a half, and the number
matters: the `46vh` row it replaced was about 54% of the dialog's body, so
anything above that would have made the *tall* shapes bigger and the controls
smaller, which is the opposite of the complaint. At a half, every shape has at
least as much room to scroll in as it had, and 16:9 has 140px more.

**The dialog takes the screen.** It was 940px wide, which is the right size for a
form and the wrong one for something you *look* at: the picture came out a
postcard beside a column of controls and the two were fighting over the same 400
pixels. It now fills the overlay up to 1460×960.

The size is set in viewport units rather than `100%`, and that is not a
preference. The overlay is a grid whose rows are `auto`, so a percentage has
nothing definite to resolve against: `height: min(960px, 100%)` made the row size
to the card's content and the card size to the row, and what Chrome settled on
was an 1813px row inside an 853px window — a dialog centred mostly below the
fold. `calc(100vh - 48px)` is the same intent with a definite answer.
- A click can land on somewhere you have never been, and that is allowed — a
  poster of your valley and the one next door is a composition, not a mistake.
  But it then appears in the list marked *not been*, because a selection holding
  something the list cannot show is a selection you can only undo by finding the
  same pixel again.

**Nothing picked means everywhere, in the numbers as well as in the picture.**
The picture already worked that way — an empty selection has no outline to cut
with — and the numbers did not: an empty id set matched no cell, and the caption
reported a map of nothing with complete confidence. `settleScope` normalises it
once, and everything that reads a scope goes through it.

### The seam

Mercator has one join in it and every framing decision has to know where it is.
Taking the minimum and maximum longitude of a selection frames Fiji as the entire
Pacific and Chukotka as the northern hemisphere.

`circularSpan` answers by looking at what is *not* covered: union the arcs, find
the widest hole, and the frame is everything else. One hole nobody selected is
the difference between "New Zealand" and "a planet". Rings are put back together
by `unwrapRing`, which follows the ±180° jumps and accumulates a whole-world
offset, so a ring stored as +179, −179 comes back as +179, +181 — past the line
rather than snapped back across the world. Everything is then drawn in the **world copy** nearest the middle of the frame,
so a frame straddling the line gets its shapes on the side they belong to and
neither half is cut.

**Exactly one copy, which is where a picture parts company with a map.** A map
draws every repeat that reaches the screen, because you can pan into them. Zoom a
16:9 export out far enough to fit the globe vertically and the frame is 1.8
worlds wide — so the Americas appeared twice, with New Zealand tucked in beside
Alaska. A picture of the Earth has one Earth in it; past that the frame is empty,
which is the honest answer. For any frame narrower than the world this is the
same copy the old loop found, seam-straddling frames included: there was only
ever one candidate.

That leaves `circularSpan` free to answer with an origin anywhere on the circle —
a frame over France legitimately comes back as 358°…375°, and every path here
would render it correctly. `frameFor` slides the centre back into [−180, 180)
anyway, without touching the width: a rectangle a world east of the geometry it
frames is a trap for whoever next reads a number out of it. (It was, for an hour.)

### Boundaries good enough to print

The map ships Natural Earth simplified to about a kilometre, which is right for a
level that normally lives at z4–5 and is not right for a poster. At 1080 px
across one country that is four pixels per vertex, and it shows twice over:
coastlines come out as visible straight runs, and — worse — every admin-1 unit is
simplified against *itself* rather than against its neighbours, so adjacent
cantons overlap by slivers all along their shared borders.

The app already has the answer for its own sharpest zoom: geoBoundaries, fetched
per country through our own server (see [How sharp a region is](#how-sharp-a-region-is)).
`ensureSharpBoundaries` asks for the same thing for the countries in the picture
— which took the canton of Bern from 49 points to 977. It is bounded to a handful
of countries: a continent is fifty-odd national surveys to fetch and a polygon
union each to dissolve, and at continent scale none of it is visible because the
extra vertices are a fraction of a pixel apart.

It is **started, not waited for**. The overview outlines are already a picture,
and a preview that goes blank for a second while a coastline is fetched reads as
a bug rather than as an improvement arriving. It lands, and the picture sharpens.

The country silhouette is then the **union of its own fine regions** rather than
the coarse national outline. It has to be: a sharp canton drawn inside a blunt
border shows the disagreement between the two datasets as a rim of land the
cantons do not reach, and the outline stroke traces the wrong shape. The map's
own country level takes the same outline when it is asked for `fine`, for the
same reason — picking *Countries* as the detail while the picture is of one
country otherwise draws a shape four pixels per vertex across.

**And the union has to be trimmed, or France gets French Guiana back.**
`src/countries.json` ships with far-detached territories already filtered out
(see [Which pieces of a country are the country](#which-pieces-of-a-country-are-the-country));
the region set deliberately keeps them, so that a cell in Cayenne lights Guyane
rather than the mainland. Dissolving them is therefore not the same shape, and
the difference is a piece of South America in the frame of a poster of France.
`stripDetachedTerritories` moved from `scripts/lib/` to `src/geo-filter.js` and
runs on the union at run time, so both answers to "what is the shape of France"
come from the same rule at the same thresholds.

**The neighbours have to be as sharp as the subject.** The area levels draw every
lit region in the world and let the mask do the cutting, so a picture of one
canton still has its neighbours' regions painted underneath the clip — and until
this was noticed, the ones over the border came from countries nobody had fetched
detail for. That is not merely inconsistent: the blunt outlines are simplified
*outwards* in places, so they spilled over the sharp ones as a ragged fringe
along the border. `ensureSharpBoundaries` now also asks for every country whose
lit regions fall inside the frame (`countriesInView`), bounded to ten.

**The subject's own silhouette was the one shape that never asked.** Every place
in `src/export-image.js` that draws a country edge reaches for the sharp geometry
first — the surroundings, the borders, the divisions, `scopeGeometry` — except
`landGeoms`, which took `c.geometry` flat. That is the shape *Draw the outline*
strokes, so on a picture of everywhere the world's silhouette came out at the
overview set's kilometre while the borders drawn on top of it were the national
survey's: a coastline in visible straight runs, under a border that followed
every inlet. And `spec.outline` was missing from `wantsNeighbours`, so a picture
with nothing but its own outline turned on never fetched a sharp boundary at all.
Both halves had to move; either alone leaves the outline blunt.

**Single color is the expensive mode, and it is now cached.** Every heat mode
gives each area its own feature carrying its own value, which is a walk over the
cells and nothing else. The flat mode dissolves them — and dissolving a hundred
regions of several thousand points each is polygon clipping measured in seconds.
`exportAreaFC` was uncached on purpose, so that ran again on every frame of every
slider drag: the panel was unusable in the mode it opens in while every other
mode felt fine. It has a cache of its own now, keyed by kind *and* mode so it can
never evict the map's own answer, dropped whenever `areaGen` moves, and capped at
`EXPORT_CACHE_MAX` because three detail levels times four modes is twelve
answers and an export panel left open should not quietly hold all of them.

`areaGen` exists because `countryDirty` is a message to `ensureAreaFC` that
`ensureAreaFC` *clears*. A second reader cannot take it off the doorstep, so
`markAreasDirty` bumps a counter alongside it and the export compares generations.

**And the stamp has a second half, which is the half that was missed.**
`ensureSharpBoundaries` calls `loadFineRegions` **directly**, for every country
in the frame, and never goes through the map's path — the fetch has two callers
who do not know about each other. So a cache keyed on `areaGen` alone went on
serving the shapes it had built *before* the sharpening it had just asked for and
waited on: the poster came out drawn from the overview geometry with the detailed
set sitting in memory beside it, and the dialog said `Sharpening…` while it
happened. `fineRegionsVersion()` in `src/regions.js` is bumped by
`addFineRegions` whenever the detailed set actually grows, and the export's cache
key is `${areaGen}/${fineRegionsVersion()}`. A version rather than a callback,
because the thing that changed and the thing holding a stale answer have no
reason to know about each other.

**Past the country limit the picture goes uniformly blunt, not partly sharp.**
`FINE_COUNTRY_LIMIT` was written as an all-or-nothing bail — "a sharp border
beside a blunt one is worse than two blunt ones" — and it is not one. It can
decline to *fetch* past the limit; it cannot un-fetch what the map already pulled
in while somebody was zooming around. So a preview past the limit drew whichever
arbitrary subset happened to be in memory: Germany and France at national-survey
detail beside a Belgium nobody had visited, at a kilometre, along the border they
share. Two blunt neighbours look like a map; one blunt neighbour looks like a bug.
`frameSharp` is set once per render by `frameIsSharp(spec, data, cam)`, and
`fineCountryGeometry`, the division lines and the area fills all read it.
`scopeGeometry` is exempt — the subject is always fetched first, and blunting it
because a neighbour drawn at 30% behind it has not arrived would be the tail
wagging the dog.

**What the flag asks is the hard part, and the first two answers were both
wrong.** It began as *is every country in the frame already sharp*, and no frame
in Europe can answer yes. Hungary can never be sharp — its detailed set pairs 11
of our 43 regions and the rest would seam, so `loadFineRegions` correctly keeps
the overview one — and a frame around Bern contains Hungary. One such country
anywhere held the whole picture back. Meanwhile the *count* came from each
country's own bounding box, and Russia's spans every longitude there is: a
picture of the ground around Bern contained Russia, along with Spain and a dozen
others whose land is nowhere near it. Twenty-two countries by that measure, so
the fetch bailed and fetched nothing, so nothing was ever sharp, so the picture
was drawn from the one dataset that **cannot dissolve cleanly** — and every
border two cantons share came out ruled twice with a bay of bare land between
them. Waiting for perfect uniformity bought a guaranteed defect.

Both halves are fixed by asking a smaller question. `inFrame` tests the bounding
box of each *piece* of a country, which drops Russia and Guyane from a frame
neither is in — the Bern picture holds seven countries, not twenty-two.
`frameIsSharp` then asks only *has the fetch taken responsibility for this frame*:
the scale is one where the detail shows (`DETAIL_KM_PX`), and the frame is small
enough that `ensureSharpBoundaries` asked for all of it. Both are decided from
the camera, and both read the same list — `boundaryIsos`, which is the fetch's
own list — so the render cannot veto detail the fetch collected. Everything then
draws at the best resolution it has, and a country that will never have one
carries the seam at its own border instead of exporting it to the rest of the
map. `FINE_COUNTRY_LIMIT` is thirty because ten was chosen for the frame around a
country and the frame around a *canton* holds twenty.

`DETAIL_KM_PX` is where the two decisions meet: below half a pixel to the
kilometre the overview set and the detailed one are the same picture, so nothing
is fetched and nothing is drawn sharp; above it they are not, and not merely in
sharpness — `build-regions.mjs` thins each region as a fraction of *its own*
size, so two neighbours thin the border they share to different vertices and the
dissolve opens a bay at every crossing. That is a defect in the overview data
which no amount of drawing can repair, and the only cure is the detailed set.

**The outline only counts frame countries for a picture of everywhere.** That is
the one scope whose outline is traced around `allCountries()`; every other scope
strokes the selection's own shapes, which are asked for separately.

Two rendering bugs live next door to this, and both of them looked like data
problems:

- **The drop shadow that was not a shadow.** Setting `globalAlpha` and then
  filling region after region looks identical to compositing once, right up until
  two of them overlap — and with per-unit simplification they overlap constantly.
  Every sliver got painted twice and came out darker, which reads as a bevel along
  one edge of every region on the map. The fills now go onto a layer of their own
  at full opacity and that layer is composited once, so an overlap is
  indistinguishable from the ground it overlaps, which is what it is.
- **The hairlines between them.** Two fills sharing an edge do not meet on it:
  each is antialiased against nothing, so half a pixel of background survives
  between them and every border reads as a pale line. Each shape is stroked in
  its own colour at 0.7 px, which closes it over its own edge without growing it.

### Blobs, off the map

The blobs are the same pipeline, not a second one. `paintBlobSheet` was lifted out
of `createBlobLayer` in `src/blob-canvas.js` and takes what the map used to read
off itself — pixels per Mercator metre, the feather scale, the buffers to work
in — as arguments. The map passes its zoom and display density; the export passes
the camera it just computed and its own canvas as the size cap, so the sheet is
rendered at poster resolution rather than at the 0.3× the map can afford.

The feather is the one knob that could not simply come along. `BLOB_FEATHER_PX`
is measured in *screen* pixels, so that the rim looks the same at every zoom —
and an image has no screen. It is scaled against a reference height instead
(`FEATHER_REF_PX`), so a poster twice as tall gets twice the feather and the
softness reads the same at any resolution.

…**and then capped at half a cell radius** (`MAX_FEATHER_CELLS`). Scaling with
the image is right while a cell is comfortably bigger than the feather and
catastrophic when it is not: at the finest level a poster's cells are about a
pixel across against a feather of fifteen, so every blob was smeared below the
threshold of being visible at all — at exactly the setting that asked for the
most detail. The map has no use for the cap, because its cells are always several
screen pixels wide.

**Two softnesses, and only one of them belongs here.** `BLOB_BLUR` is the blur
that merges neighbouring cells and bleeds their colours together — the thing that
makes a honeycomb read as poured ink — and the export leaves it exactly as the
map has it. What the export overrides is the *rim*: how gradually a blob stops
being a blob and becomes nothing. The map wants that wide, because the wash is a
hint you read the basemap through and a hard edge would look pasted on. An image
has nothing behind the blob for it to dissolve into, so the same setting reads as
a smear with no shape, and the finer the cells the more of the picture the smear
eats. `BLOB_RIM` and `BLOB_RIM_FEATHER_PX` at the top of `src/export-image.js`
are the two knobs; `paintBlobSheet` takes them as `edge` and `featherPx`, which
default to the map's own when nobody overrides them.

### A cell size has to name a size

*Cell size* pins a grid level, and it used to pin an *offset* from whatever the
frame could carry — so the base moved as you zoomed and a size you had chosen
quietly changed under you. It reads the level straight now (`blobLevelFor`), and
the options are named by the ground a cell covers (0.9 km, 2.7 km, 8 km, …)
rather than by an adjective: "8 km" is a fact about the grid, "Medium" is a fact
about the list it appears in. *Auto* is still there and still means the finest
level the picture can honestly draw.

A level pinned finer than the picture can really draw is still drawn — the sheet
floors a cell at `MIN_CELL_PX` rather than letting the level-set cut erase it,
which is the same bargain the map makes for a pinned Detail level.

Which grid level to draw is decided by the picture rather than by a zoom:
`blobLevelFor` takes the finest level whose cells are still at least
`MIN_BLOB_PX` across on this canvas. Below about a pixel a disc rasterizes at
partial alpha and the level-set cut erases it — the same floor `MIN_CELL_PX`
holds on the map. *Cell size* offers two steps coarser than that, for a picture
that wants to read as a shape rather than as a mosaic.

### One vocabulary, two renderers

The moment there were two things painting the same cells, the ramps had to stop
living inside `src/main.js`. `src/coloring.js` now holds the four modes, their
ramps, the categorical palette, the roll-up arithmetic (`cellStats`, `hotOf`) and
the two functions that turn a rolled-up cell or an area's `v` into a colour. The
map keeps what is genuinely its own — the MapLibre `interpolate` expression built
from those ramps, since an expression is a thing you hand a GPU and not a colour.
A second copy of the ramps would have been a second answer to "what colour is a
cell you were at twice", and the two would have drifted the first time either was
tuned. `formatKm2` and `formatPct` moved into `src/stats.js` for the same reason:
a poster rounding 1.24 % to "1%" beside a panel saying "1.2%" reads as two
measurements of the same ground.

**Colouring by Type from a map that is not showing Type** is the one case that
needs work rather than a lookup. The per-source tally costs a pass and a field on
every rolled-up cell, so it is only built while Type is the mode on screen.
`exportRollUp` builds it on demand and `typeRollUpStale` says when what is in
`litSets` predates a cell or was never built — otherwise every drag of the
strength slider would pay for a full rebuild, and a cell painted afterwards would
quietly render as *Other*.

### The caption

The lines are a list, not a template: `CAPTION_FIELDS` in `src/export-image.js`
is where a new one is added, and the dialog builds its checkboxes from it.
Whatever is ticked is drawn in the order the fields are *declared*, not the order
they were ticked — a caption reads top to bottom and the title belongs at the top
whenever it was chosen.

**A field with no honest answer is left out.** A poster that says "First seen —"
is telling you about the software. `value` returns null and the line does not
appear.

The **title** field's placeholder is the title the picture would use if you typed
nothing — the names of the places, kept current as you pick them — and **Tab,
Space or →** takes it as editable text rather than making you retype it. All
three are free: the field is empty, so none of them had anything else to do.

The **shadow** follows the text unless you give it a colour: dark type on a pale
palette with a black shadow under it does not separate from anything, it just
looks smudged, so the default is a halo of the opposite lightness. Colour and
strength are both there for when the default is not what a particular picture
wants.

### The ready-made palettes

`PALETTES` in `src/export-image.js` is twelve complete answers rather than twelve
background colours. Each names all five — `background`, `land`, `edge`, `text`
and `accent` — because those five are picked *against* each other, and five
independent colour wells is a machine for producing a poster nobody can read.
Choosing one clears whatever was overridden on top of the last, so "Paper" never
arrives still wearing a dark land somebody nudged an hour ago.

**The four under the wash are all quiet, and that is a constraint rather than a
taste.** The subject of the picture is the visited wash. Anything underneath
competing for the same attention turns the poster into two maps arguing with each
other, so `background`, `land` and `edge` are each a near-neutral or a single
desaturated tone, and the distance between `background` and `land` is
deliberately small — enough to read as *there is ground there*, never enough to
read as data. That is why there is no palette here whose *paper* has a hue you
would call bright, and why adding one would be a mistake rather than an
improvement.

**`accent` is the exception, and the reason the rest hold back.** It is the one
saturated colour on the page, and it is part of the look rather than a separate
decision — picking "Sepia" moves the wash to verdigris the same press that turns
the paper brown. Three rules decide it:

- *Against the temperature of the ground.* Warm paper takes a cool or deep ink —
  Prussian blue on cream, verdigris on the sepia atlas — and a cool or dark
  ground takes a warm luminous one: gold on navy, sand on the cyanotype. The wash
  then separates by hue as well as by lightness, which is what stops it reading
  as a darker patch of land rather than as the subject.
- *Past 3:1 against `land`.* A real contrast ratio this time, at the threshold
  for a shape rather than for type.
- *One hue each.* Twelve looks that all resolved to gold would be one look.

`chart` is the one that breaks the other assumption: its land is *lighter* than
its background, the way a sea chart's is. The coastline is legible because those
two are close rather than because they are far apart, which is the same
restraint applied from the other side. Its wash is magenta for the same reason —
that is the overprint colour a real chart uses.

`none` is not a colour scheme. It is a transparent background with the land and
the outline carried at low alpha, for dropping the shape onto something else — so
it is the one palette whose caption contrast cannot be checked, because what the
type will land on is decided by whatever the file is put on. Its accent is the
one colour here picked by arithmetic rather than by eye: `#8a5cd6` sits where
white and black are exactly as far away as each other, 4.6:1 in both directions,
which is the most a colour can promise about ground it cannot see.

**The wash used to follow the map's own accent**, on the argument that a poster
of a map you had coloured teal should not open blue. That was the right answer
when the dialog had one hard-coded hue and no opinion about paper; it is the
wrong one now, because the colour the look proposes was chosen against the paper
it will be printed on and the map's was chosen against a live basemap this
picture does not have. `accentOf(spec)` is where the two answers meet: a blank
`accent` means "whatever the look says", a hex means somebody picked it, and the
swatch shows the resolved colour with *Follows the look* or *Chosen* under it —
the same arrangement the caption's shadow already used. Picking any look clears
the override, which is what makes the look a look rather than four fifths of one.

`colorBy` defaults to *Single color* for the same reason, where it used to open
on *Most visited*. A heat ramp is seven colours the paper had no say in, and it
overrules the one colour the look was built around; the ramps are one press away
and carry a legend, so nothing is hidden by making the first picture a shape in a
colour that belongs to the page. *Regions* rather than blobs is the one export
default that still parts company with the map, and that one has not changed.

Four of those rules are pinned by `scripts/test/export-image.mjs`: the caption is
always the opposite lightness to the paper, the outline never disappears into the
land, every wash clears 3:1 against the ground it is drawn on, and the
transparent one clears 4:1 against both black and white. None of them is visible
from reading the hex values, and all of them are one typo away in a list this
long.

### Six colours, one picker

Every colour here opens the app's **own** picker (`src/color-picker.js`) rather
than the OS one, for the reason the map uses it: a colour is chosen *against* the
thing it will sit on, so it has to repaint the picture as you drag rather than
hand back an answer when you dismiss a modal. It also means transparency is a
value you can pick, which for the background is a real answer.

What is new is that the swatch row is a parameter. The map has one colour and one
row of ten bright hues, which is right for a wash you read a map through and no
help at all when you are picking type — nothing in that row is a text colour, and
a hue wheel is how a poster ends up as #000000 on #FFFFFF. `SWATCH_PRESETS` has
three rows by what the colour is *for*: `accent` (the map's own), `ink` (type and
its halo — near-blacks that are not black, papers that are not white) and
`surface` (the tones a map is printed on). The panels are appended to the overlay
rather than to the card, because the card scrolls and clips and a fixed panel
inside a scrolling column drifts away from the swatch that opened it.

Which is also what made the pickers, briefly, mount themselves on each other.
The three palette swatches were found with `[data-color]` — and a picker's own
preset buttons carry `data-color` too, so by the time that selector ran, three
panels' worth of them were already children of the overlay. Thirty-six pickers
instead of six, one on every preset: clicking a preset opened *its* picker,
which closed the one you were using and placed a new panel against a 14 px
button near the edge of the screen. It read as the panel jumping to the corner.
The selector is scoped to `.export-swatch >` now.

A swatch is also a `<div class="menu-row">` rather than a `<label>`, matching the
map's own. `<button>` is a labelable element, so a `<label>` around one treats it
as its control and sends it a second, synthetic click — which opens the picker
and shuts it again in one gesture.

Two controls, because they are two questions again: the **anchor** is where the
block sits on the picture (nine cells laid out the way they sit, so picking a
corner is pointing at it), and the **alignment** is how the lines sit within the
block. Sizes are all fractions of the image's own height, which is what lets a
300 px preview be the same picture as a 2560 px file rather than a picture of one.

And it **fits rather than clips**. Three continents on one line with the size
dragged to the top of its range will not fit any frame, and there are only two
honest answers: run the title off the edge, or set it smaller. `drawCaption`
measures, and re-lays-out once at whatever scale makes the block fit inside the
margins. A caption that has quietly shrunk still says what it says.

Typefaces are stacks, never webfonts. Nothing is fetched, so an export works
offline and cannot render half-drawn while a font arrives.

### What it does not do

- **No basemap.** The picture is a silhouette of the selection with your ground
  inside it, not a photograph with a hole cut in it. *The rest of the world* draws
  the surrounding countries behind the cut, which is enough to place a canton
  without turning the export into a tile-licence question. It is a **strength**
  rather than a switch, because the right answer depends entirely on how much of
  the frame the subject occupies: a continent leaves a thin rim of neighbours and
  wants them faint, one canton leaves the whole frame and at the same setting
  reads as a shape floating in nothing. Each neighbour is drawn as its own path
  so it can carry its border: without them they dissolve into a single grey
  continent, which places the subject on a landmass but not in a country — and
  "which one is Germany" is most of what the context is for. **The land and the
  borders are two sliders**, because they are two things: borders alone over the
  background is a good-looking map, and so is undifferentiated land with no lines
  on it, and one control meant you could have neither. Both are drawn from the
  sharp outline wherever it has been fetched — a blunt national border cuts
  visibly across the detailed regions on the other side of it, which is the same
  mismatch as the fringe above wearing a different hat.
- **And one slider for the lines the picture is made of, with a choice of where
  they go.** A solid fill is one shape, and one shape says one thing: colour a
  poster by regions and every canton you have been to dissolves into its
  neighbours. That is right — it is what `mergeAreas` is for, and it is how a
  whole corner of a country reads at a glance — but it is also the whole of what
  the picture then says. Twenty-six cantons with a flat wash over eleven of them
  carry the same ink and the same amount of information. Drawing the seams back
  over the fill is what gives it structure again, at a strength that depends
  entirely on the picture: a hairline that gives a country-sized fill some shape
  turns a poster of one canton into a diagram of it.

  *Borders* is that strength, and *Regions / Countries / Both* is which borders
  it buys. They were two controls, a switch for the outline and a slider for the
  seams, which is one question ("how much line do you want") asked twice and
  answerable inconsistently: the outline could not be softened and the seams
  could, so a faint diagram of a canton still wore a hard black edge.
  `lineAlphas(spec)` is the one place that reads the pair, and `spec.lines` /
  `spec.lineScope` replace `spec.outline` / `spec.divisions`.

  **The silhouette is not one of the choices.** It is the edge of the picture
  rather than a border in it — what the mask cut the subject out along, and the
  one line whose absence reads as unfinished rather than as a decision — so it
  comes at the slider's strength with all three settings.

  **And which borders is asked, not inherited.** These followed *Detail* on the
  grounds that they were the fill's own seams, which is one good picture and only
  one: a poster coloured by region wants the national borders in it as often as
  it wants the cantonal ones, and neither was reachable while the lines were
  whatever the fill happened to be made of. *Both* is one stroke rather than two,
  because a country the region set does not subdivide stands in for itself at
  that level and would otherwise be traced twice — at a flat alpha with no fill,
  nobody can tell. *Blobs* are the exception: nothing lies between two blobs, so
  the selector is hidden there rather than answering a question nobody asked —
  the same call the *Cell size* row makes in the other direction — and
  `lineAlphas` reads the same detail, so at that setting the slider means the
  silhouette rather than meaning nothing.

  Every unit the frame reaches is traced, not only the lit ones: the empty half
  of the subject is part of the composition too, and lines that stop where the
  colour stops draw the boundary of your own travel twice over. The clip does the
  cutting, as it does for everything else here.

  Two vocabularies of stored spec therefore have to be read. `spec.outline` /
  `spec.divisions` came first; then `lineScope` said *where* (`outline` /
  `inside` / `both`); it now says *which*. The silhouette becoming unconditional
  is what makes the second migration lossless in the direction that matters — a
  spec that asked for the outline alone keeps it, and gains the national borders,
  which are the fewest lines that change the picture at all.

  `divisionGeoms` culls on bounding boxes before it touches geometry — a frame
  over the Alps asks for six countries and 69 regions rather than 250 and 4,553
  — and it is one `Path2D` for all of them rather than one per unit, since
  nothing is filled and every line is the same colour. Shared edges are
  therefore stroked twice, which at a flat alpha is invisible; it is `fill` that
  would show an overlap, and there is no fill. A country the admin-1 set does
  not subdivide stands in for itself, the same rule `WHOLE_COUNTRY` encodes for
  the level that colours these — without it Luxembourg is the one shape in the
  frame with no line around it, which reads as missing data rather than as a
  country that is one region.
- **Nothing leaves the tab.** The dialog reads the cells already in memory and
  writes a PNG the browser saves. There is no server call and no upload; the
  accessors it is handed (`cells()`, `meta()`, `rollUp()`, `areaFC()`) are read-only
  views of the map's own state, so an export can never change what is on screen.
- **The places you picked are not remembered between sessions.** Everything else
  in the spec is (`visited-map:export:v1`), because it is a look. The places are a
  fact about the map that may have changed since, and an id with no cell under it
  would draw an empty shape with no way of saying why.

## Backups

Everything behind the other door pulls data in. This writes it out: on a schedule,
the server takes a copy of `data.db` — every account's cells and their
provenance, the saved routes, the Home Assistant token — and keeps the last few
beside it. Until now the only way that file existed twice was if you thought to
copy it.

**It only copies when something changed.** A map nobody edited for a week
should leave one file behind, not seven identical ones, so two separate tests
stand between a tick and a new file:

- **The source file's size and mtime.** Nothing written since the last look
  means nothing to copy. One `stat()`, and it's the usual answer.
- **The hash of the copy itself.** `VACUUM INTO` rebuilds a database from its
  logical contents, so two vacuums of the same data produce byte-identical
  files — even after a write that added a row and deleted it again. A copy that
  hashes the same as the newest kept one is thrown away and counted as
  *skipped*, not kept. The dialog shows both counts, which is the feature
  explaining itself: "12 kept · 39 skipped as unchanged".

The bookkeeping — when it last ran, what the last copy hashed to — lives in a
`.backup-state.json` beside the backups rather than in a table. That is not
tidiness: writing "I took a backup at 04:00" *into* `data.db` is itself a change
to `data.db`, so the next tick would see a modified file, copy it, write that
down, and never skip anything again. The test caught exactly that.

Nothing touches the bytes directly. `VACUUM INTO` asks SQLite for a consistent,
compacted copy while the server is still running, which is the difference
between a file that opens and a file that opens missing half a transaction. It
is synchronous — the one place this server blocks on purpose — because SQLite
has to see a stable database to write a copy of one. A few megabytes is a few
milliseconds, and it runs at 04:00 by default for the day it isn't.

**The schedule is a cron expression, whichever way you set it.** The picker
(*every day at 04:00*, *every week on Sunday*) composes one; *Custom* takes one
typed, five fields, `*/15` and `mon-fri` and `@daily` included. There is only
ever one string in the database, and the line under the field says what it means
in English — *"At 03:00 on Mondays, Tuesdays, Wednesdays, Thursdays and
Fridays — next tomorrow at 03:00 AM"* — worked out by the same parser
(`src/cron.js`) the server schedules from. An expression it cannot phrase
honestly is shown back as itself rather than as a guess: a wrong description is
worse than none. Times are local, and the day the clocks go forward still gets
its backup rather than silently missing one.

A missed run is taken. If the machine was asleep or the server was down at
04:00, the first tick after boot notices that the last run predates the last
firing and takes one then — the same catching-up the Home Assistant poller does.

Retention is by count (3 to 90, default 14). Pruning only ever removes files the
server itself wrote — the names are matched against a pattern, so pointing
`BACKUP_DIR` at a directory with other things in it can't eat them.

Each copy can be **downloaded**, because a backup that never leaves the machine
it's a copy of is not a backup. That link is the most sensitive route in the
app — the file is the whole database — so backups belong to the account that
made the map (the first one), and every other account is refused in words.

`npm test` covers the parser (leap days, the `13th or Friday` rule, the clock
change), and the engine: that the copy opens as a database with all the cells in
it, that an untouched map produces no second file, that a write which changed
nothing produces no second file either, and that retention counts.

## Saved routes

The visited map is about *ground covered*, which throws away the shape of the
journey. A route keeps that shape: import an activity (a run, a ride, a flight,
a Timeline day) with **Save routes** ticked and the line itself is stored
alongside the cells it lit up, drawn over your colored map. **Saved routes** in
the menu toggles them; the count and total distance sit under the switch.

Tapping a route line on the map opens a small card — what it was, how far, how
long — with two ways on: **Zoom to route**, or **More info**, which hands over
to the full entry in the routes dialog. The card used to carry Edit and Remove
too, which made it a second place that knew how to change a route; everything
that changes one now lives in exactly one place.

Every route in the list carries a **small drawing of its own shape**, which is
how you actually recognise one — you know the Frutigen loop by its outline long
before you read its name. The list can't afford the real geometry (82 routes of
3,000 points is megabytes, and metadata-only is the whole reason it loads fast),
so each route stores a 28-point normalised outline worked out once when it is
saved: ~200 bytes each, about 16 KB for a map of 82. Routes saved before this
had theirs derived from the geometry already in the row.

Under **Saved routes** in the menu, a chevron opens per-activity controls: an
eye to hide an activity from the map, and a colour for each one. These follow
the **account**, not the browser — they are written to `user_prefs` and read
back at sign-in, so the phone and the laptop agree — with a `localStorage` copy
kept alongside so dragging a colour is instant and works offline. Keys are run
through `canonicalSport()` on the way in, so a colour set under an old name
(`Hike`, `Road ride`) still applies after the vocabulary was tidied. The route
count says "34 of 82 shown" while anything is hidden, so a filtered map never
reads as a broken one.
It stays folded away by default: it is one row per activity and a map can easily
have a dozen.

A route imported from Komoot keeps **a link back to the tour**, shown in its
details as *Open on Komoot*. The link is rebuilt from the tour id and the share
token rather than stored as pasted: a copied share URL trails `ref=profile`,
`t_s=referral`, `t_cid=route_share` and `t_ref_username=…`, which record who
shared what with whom and are nobody's business once the tour is on your map.
The share token is kept, because it is the only thing that opens a private tour.
It is the one stored field that becomes an `href`, so it is checked against
Komoot's own domain on the way in *and* again at render — `javascript:` in an
`href` runs, and a lookalike host like `komoot.com.evil.io` must not read as
Komoot's.

Tap a route in *Routes and statistics → Routes* and it **opens the activity**
rather than jumping the map to it: name, where it went, activity, distance,
climb, date, start time, duration, average speed, which app it came from and
how many points it kept. **Edit** renames it, files it under a different app or
sets the activity; **Delete** asks twice; **Show on map** is the one that closes
the panel, switches the routes layer on and flies there. Tapping the line on the
map still opens the same card it always did.

An import only ever **adds**. There was once a "Replace earlier import from this
source" option that also dropped cells the new file no longer contained; its
scope was the whole source rather than the file, which is not what anyone
reading the checkbox expected, so it is gone. Clearing a cell you don't want is
the honest way to remove one.

**Re-importing a file you already imported updates it rather than duplicating
it.** A route is identified by a hash of its own geometry and dates, so the
second import finds the same row — and now fills in what that row is missing:
a climb where it had none, a place, and a name if the stored one was still a
placeholder like a bare date. **An activity that was only ever a guess is
replaced outright** — by what the file states, or failing that by the guess the
file's own contents produce, because the two guesses are not equally informed:
the one-time backfill had only the length, the clock and the name to work from,
while parsing the file also reads the elevation track, which is what tells a
hike from a walk. It never overwrites something *you* set: rename a route, pick its
activity, and re-importing the source file leaves both alone. That is what makes
it safe to drop your old GPX files back in to pick up the elevation they were
carrying all along.

Ascent is summed from the elevation track with a 3 m noise gate (Strava's own
total is used where the API gives it), so a flat ride doesn't accumulate into a
mountain from GPS jitter. A route whose file carried no elevation shows no climb
rather than 0 m. Removing a route leaves its cells alone — you were still there.

### Working out the activity

Nothing has to be typed in. Most files say what they were — a GPX's
`<trk><type>`, a TCX `Sport` attribute, a FIT sport message, Komoot's own sport
key, Strava's `sport_type` — and that always wins.

Whatever it says arrives through `canonicalSport()` first, which is the one
place that decides the vocabulary. Five sources name the same thing five ways —
a GPX writes `<type>cycling</type>` in lower case, Komoot calls a road bike
"racebike" and a trekking bike a "Bike tour", Strava says "Ride" — and left
alone that fills the list and the colour menu with near-duplicate categories
that all mean one activity. Everything on the road is **Cycling**, everything
off it is **Mountain cycling**, and **Walking** and **Hike** stay separate
because they are separate. An activity it doesn't recognise is kept rather than
forced into a bucket; only its capitalisation is tidied.

When none of them does, `guessSport()` in `src/routes.js` works it out from two
signals, in order of how much they can be trusted. First the **name**, because
apps write the activity into it (Slopes exports are all called "Slopes - A day
skiing at …") and it is the only thing that identifies a sport the numbers
cannot: a day on the pistes averages about 10 km/h, which is exactly the pace of
a run, and guessing from speed alone filed both of the author's real ski days as
"Run". Then the **average pace**, in deliberately wide bands — walking under
7 km/h, running to 13, riding to 32, driving above that — with a walk that
climbed over 400 m promoted to a hike.

A worked-out activity is stored as a guess (`routes.sport_guessed`) and the
dialog shows it as *"Cycling (estimated)"*; typing one in clears the flag,
because then it is a fact. Routes saved before any of this existed are filled in
once at startup from the length and clock already in the row — on the author's
own map that took 1 of 21 routes with an activity to 19. Only blanks are
touched: the one route Komoot had labelled kept its own label even where the
guess disagreed. Elevation cannot be backfilled the same way — the stored
geometry is flat, so a climb figure needs the file re-importing.

`npm test` covers both, including the ski-day case and the place names
("Brunnen") that must not be read as a sport.

### Named after where they went

A track file rarely says anything useful about itself: its name is often a bare
date, or missing, and then only the filename is left. So every route also gets a
**place** worked out from the ground it covered — `Bern → Thun`,
`Thunersee loop`, `Interlaken`. A name the file *did* carry ("Morning Run" off a
watch) is kept as the title and the place is shown beside it; only a generic one
(a date, `Track`, `Untitled`, a filename) is replaced.

This happens **on this device**. `src/places.json` (3.0 MB, built by
`npm run build:places`) ships with the app and is dynamic-imported as its own
chunk the first time a route needs a name, so no coordinate is ever sent to a
geocoder. It holds:

- **94k towns** from [GeoNames](https://www.geonames.org/) `cities1000`, thinned
  (CC BY 4.0 — hence the GeoNames credit in the map's attribution). Coarser sets
  are far smaller but only know cities, and a hike above Interlaken then comes
  out named after somewhere 40 km away, which is worse than no name at all.
- **~2k named lakes** from Natural Earth (public domain). The global file barely
  names any — in Switzerland it knows Lake Geneva and Bodensee and nothing else
  — so the Europe and North America supplements are merged in on top.

**Thinned, because the two obvious cuts are both wrong.** Everything over 5,000
people (the old `cities5000`) leaves whole valleys with no name in them at all:
the upper Engadin has no settlement that size, so a day in St. Moritz — 4,952
people — was named after Chur, an hour's drive away. Everything over 1,000 is
161k places and 1.9 MB gzipped, more than twice today's download, nearly all of
it villages that already have a town speaking for them. So the ≥5,000 set is
kept whole and the rest fills in **only where nothing bigger is within
`FILL_GAP_M` (15 km)**: a village that is the only name for miles earns its
thirty bytes, one in a city's shadow does not. 94k places, 1.2 MB gzipped.

GeoNames' **PPLX** entries — "section of a populated place" — are dropped
outright. They are city districts carrying their own population, so they compete
with the city they are part of, and an afternoon in Zürich used to answer
"Zürich (Kreis 9) / Altstetten".

**A place in the shadow of a much bigger one takes its name.** The gazetteer has
no idea which places contain which, and not every district is filed as one:
Lisbon's parishes are plain `PPL` rows, so a week there landed a couple of hours
on each of Lumiar, Alvalade, Benfica and Marvila and came out named after
whichever won. A place with a neighbour `ABSORB_RATIO` (5×) its size within
`ABSORB_M` (12 km) is a piece of that neighbour and answers as it. Distance *and*
ratio, because either alone is wrong — ratio alone would let a city claim a
separate town forty kilometres off, distance alone would swallow the independent
suburb next door — and between them they leave Zermatt and St. Moritz alone.

Two more rules keep the names honest: nothing more than 30 km away is claimed as
where you were, and a lake has to be within 6× the route's own size in either
direction, so a 2 km walk is never "Lake Geneva" and a 150 km drive is never
named after a pond it passed. Size also buys a place a head start over distance
(`prominence()` in `src/places.js`) — otherwise a run through central Bern gets
named after whichever 5,000-person suburb the start line happened to fall in.
Routes stored before this existed are named the next time their lines are
loaded, and the result is sent back once.

- **Thinned on import** (`src/routes.js`): Douglas–Peucker at `ROUTE_EPSILON_M`
  (6 m) turns an hour of 1 Hz recording into a couple of hundred points — about
  4 KB — without losing a corner it actually turned. The tolerance doubles until
  a route fits under `ROUTE_MAX_POINTS`, and lines shorter than
  `ROUTE_MIN_LENGTH_M` aren't routes at all.
- **Re-import safe**: a route's key is a hash of its own (simplified) geometry
  and dates, so importing the same file twice stores it once.
- **Lazy**: the map fetches route *metadata* on load and the geometry only once
  the layer is switched on.
- **Drawn above the basemap's own lines**, unlike the visited wash which reads
  as tinted ground beneath the streets. The wash's own anchor (`washAnchorIn()`,
  see [Basemaps](#basemaps)) lands underneath every street, which is right for
  tinted ground and chops a route into dashes wherever a road casing crosses it;
  `labelStart()` in `src/main.js` aims past the last non-symbol layer instead.

## Taking it back

**Ctrl-Z / ⌘-Z undoes, Ctrl-Shift-Z / ⌘-Shift-Z redoes** (and Ctrl-Y, which is
what Windows hands tell their fingers). It covers the edits that change what the
map holds: marking a cell, a whole Ctrl-sweep of painting, clearing an area, and
deleting or renaming a saved route.

**Every one of them says what it did** — *"Undid clearing 80 cells"*, *"Redid
deleting “Thunersee loop”"* — in a small line at the bottom of the map. This is
not decoration. On a map the thing that changed is often off screen, or a cell
too small to watch move, so an undo that says nothing looks exactly like an undo
that did nothing, and the natural response is to press it again. One slot, not a
stack: holding the shortcut down reads as one message counting backwards rather
than twelve notifications piling up.

**Undoing a clear puts the rows back, not the cells.** Clearing drops every
source's claim on a cell — the dates, the visit counts, which app it came from —
and re-adding the id would bring it back as a bare manual mark having quietly
thrown away all of it. So the page keeps what those cells knew (it already holds
it, to draw the card) and hands it back whole to `POST /api/cells/restore`,
`added_at` included: a cell that has been on the map since March does not come
back reading as new. Deleting a route is the same problem in a different shape —
the routes layer is lazy, so the line may never have been loaded — which is why
`POST /api/routes/delete` answers with the whole row, geometry and all, and Undo
posts that copy straight back.

A sweep is one entry, not four hundred. A gesture that lit nothing new isn't an
edit and doesn't go on the stack at all.

Anything queued is sent first. Edits are debounced (a Ctrl-sweep is one request,
not one per cell), and an undo that raced its own queue would restore cells that
a stale delete then removed half a second later — so the queue is flushed and
acknowledged before the inverse goes out. If the server can't be reached the
undo doesn't happen, says so, and stays on the stack to try again.

The stack is in memory, and it belongs to this page and this account: signing out
or reloading starts again with nothing to undo. One that outlived the page would
be offering to undo an edit against a map that may have changed on your phone
since, and *undo* has to mean the thing it says. Typing in a field keeps its own
undo — the shortcut is left alone there.

## Trips

The object between a cell and a route: a run of days spent well away from where
you usually are. Derived in `src/trips.js`, never stored — it costs no import
path, no schema and no migration, and it re-derives itself the moment new
history arrives. The price used to be that a trip could not be renamed, because
it isn't a row, it's a reading of the rows — see
[Calling one something else](#calling-one-something-else) for what pays it now.

- **Home is where you keep going back to**, taken as the centre of gravity of
  the cells with the most visits rather than the single most-visited one — which
  of the three hexagons around your flat wins is decided by GPS drift, and the
  weighted centre of the top twelve stays put as more history arrives. Averaged
  **around the circle**, because a cell centre projects to an unwrapped
  longitude (351 for Lisbon, not −9) and a plain mean of those puts the home of
  anyone with a well-visited cell in the western hemisphere in the middle of
  Europe.
- **…and it is correctable, by pointing at it.** A guess this personal has to be
  visible and changeable, so the Trips tab shows which home it is using and
  offers the change. Picking one used to mean "use the middle of the map", which
  is a guess about a guess — it asked you to aim the whole viewport at your own
  house — and produced a home called *The middle of the map*, which is not a
  place. Now the dialog steps aside, a chip takes over the map, the next tap
  drops a pin you can move, and confirming names it after the nearest town.
  Cancelling puts the dialog back rather than leaving you on a map wondering
  what just happened. It can also be **drawn on the map** — a house outline, not
  a dot, because a dot on a map of dots is one more cell. Stroked twice, a wide
  white pass under a dark one, which is the trick the basemap's own labels use:
  it is what lets one thin outline read on a dark map, a light one and a
  photograph without a coloured disc behind it guaranteeing contrast by
  shouting. It is added with no `beforeId`, which puts it on top of the whole
  stack — above the basemap's own labels, not merely above the blobs. The only
  other thing drawn that high is the day/trip highlight, and `syncHomeMarker`
  raises home again whenever that is shown, because a marker you have to hunt
  for is not a marker. Everything we add to the map carries a `hexplore-`
  prefix where a collision is possible: CARTO's styles ship a layer of their own
  called `rail`, and for as long as ours had that name too, switching to Light
  or Dark left `getLayer('rail')` answering yes about somebody else's layer
  while the train-track overlay quietly stopped existing. Setting home, and the switch that draws it, live in
  **Export & settings** under *Settings*, beside the Editing switch — three
  surfaces each opened for another reason used to hold one setting about you
  apiece. The tick for it sits on the home card itself, because "is this the
  right home" is a question you answer by looking at where it is — it started
  four sections away in the appearance menu. It gets a line of its own under the
  home rather than a seat beside it: two controls in one row left the switch
  competing with *Change* for the width, and it lost badly enough to be labelled
  "Map", which reads as a noun rather than as something you can turn on. Where
  home *is* follows the account; whether you are currently looking at it is a
  way of looking at the map, so it stays in localStorage beside the rail
  overlay.
- **That switch has three states, not two.** `visited-map:home-shown:v1` is
  `on`, `off`, or absent — and absent means *nobody has said*, which is not the
  same as "no". Left alone, the marker follows whether a home has actually been
  set: somebody who has just pointed at their own house expects to see it
  without hunting for a second control, and a map nobody has told anything
  should not be carrying a pin at a guess it has not explained. Touching the
  switch writes the answer down and that answer wins from then on, including
  when it agrees with the default — agreeing with something is not the same as
  never having looked at it.
- **And the offer to set one is made once, ever.** Home is the origin of every
  number in this section and the only one that is guessed, so the guess is worth
  correcting — but four taps into a settings panel is not where anybody finds
  that out. A banner in the shape of the offline one, in neither of its colours
  because nothing is wrong, says what home is for and offers to set it.
  `askHomeOnce` runs after the preferences have been reconciled, which is the
  first moment anything knows the answer, and reads it off the **account's own
  copy** rather than off `homePlace` — the reconcile's `push` branch never fills
  that in, and a browser whose local copy won would otherwise announce that an
  account with a home does not have one. It stays quiet on an account with no
  cells yet, where there are no trips for a home to be the origin of.

  The flag is spent on being *shown*, not on being answered, and it lives in
  this browser rather than in the account. Both halves are the same judgement:
  a banner that comes back until it gets the answer it wants is a nag, and "no"
  is a complete answer. A flag in the preferences would also be a fifth thing
  for the reconcile to lose.
- **Home has to be earned.** Somewhere needs `HOME_MIN_HITS` repeat visits
  before it can claim the title. Without that rule, an account holding one
  imported holiday decides the holiday is home, every cell in it is "not away",
  and the trip vanishes from the list it exists to be in. A map that has never
  seen you come back has no home yet and is all trip.
- **A day that began and ended near home is a day out, not a day away.** The
  share rule alone cannot see this: it counts cells, and driving across a canton
  lights far more of them than walking around your own village, so the morning
  and evening at either end were outvoted by the middle of the day and five
  separate Saturdays fused into one seven-day trip. Such a day still *counts* as
  a day away — a Saturday spent 130 km from home is somewhere you went — but it
  stands alone rather than joining the days either side, and whether it is worth
  listing is left to `dropRoutine`, which is the part that knows the difference
  between St. Moritz and the drive you make every other weekend. Both ends have
  to be near home, so the day you leave and the day you come back are untouched:
  those really are half a day away each, and they belong to the trip.
- **A trip is a run of days you did not come home** — not a run of events far
  from home, which is a different question and the one that used to be asked.
  Away is `HOME_RADIUS_KM` (55 km); each day is then weighed as a whole, and a
  day counts as away only if at least `AWAY_DAY_SHARE` (half) of the ground it
  touched was out there.

  Someone who drives an hour out and back every day produces evidence beyond the
  radius on every one of those days. Read as events that is one unbroken run,
  and it came out as a **77-day "trip" to the next canton**. Read as days, each
  one also has evidence *at* home, so none of them is a night away and there is
  no trip at all — while a fortnight in Portugal has eight days with no home
  evidence whatsoever. Half, because both sides are counted in cells and the day
  you fly out legitimately touches a few near home on the way to the airport.
- **Coming home ends a trip**, at any gap. Going to Portugal, home for one day,
  then away again to Slovakia used to be a single 58-day trip: nothing in a list
  of away-events says you were ever back. One home day in the middle now ends
  the first and starts the second.
- **Silence doesn't.** Nothing recorded says nothing either way, so a gap of up
  to `TRIP_GAP_DAYS` (2) carries the trip on.
- **A stay is read across its own silence, one row at a time.** A row records
  when a cell was first and last seen and nothing in between, so a week in one
  village arrives as a crowd of arrival dates, a crowd of departure dates and
  six days of nothing. A row whose two ends are within `TRIP_STAY_DAYS` (16) is
  therefore read as one continuous stay and *holds* the days between them open —
  they carry a day that has nothing else on it, and never outvote a day that
  has, because an inference about time is not a sighting. The bound is what
  keeps first-seen-in-August, last-seen-in-December as two visits rather than a
  four-month residency.

  This replaced a rule that merged whole **clusters** near each other in space
  and time (`TRIP_MERGE_DAYS`/`TRIP_MERGE_KM`). That rule could chain: each
  merge moved the cluster's centre, which brought the next one within range. On
  real data five individually-reasonable merges — 142 km apart, then 125, 87,
  118, 17 — glued a fortnight in Portugal, a week in Slovakia and every day trip
  in between into one trip. A row can only ever imply its own span, so it cannot
  chain.
- **Both ends of a cell's span are events**, not just the first. Emitting only
  the far-apart ones (the first attempt) made every short stay exactly one day
  long, because a Friday-to-Sunday cell never produced its Sunday.
- **A stray cell is not a journey**: `MIN_TRIP_CELLS` (3), or one route, is the
  floor. A cell with no date at all cannot be placed in time and makes no trip
  rather than a guessed one.
- **Somewhere you keep going back to isn't a trip, it's your week.** "Away from
  home" is a distance, and distance alone cannot tell a holiday from a commute:
  someone who drives to the same city a dozen times a year got a dozen rows in a
  list they opened to remember holidays by. The signal is sitting in the list
  itself — a place that turns up in it over and over is not somewhere you went,
  it is somewhere you go — so a day run is dropped when `FAMILIAR_TRIPS` (3)
  other day runs landed within `FAMILIAR_KM` (25 km) of it. Symmetric, so it is
  all of them or none: the fourth visit is not more routine than the first, and
  keeping three of twelve would be arbitrary. On real data this took 63 trips to
  41, and every one it removed was a repeat.

  Two things override it, because both say this one was different: **it lasted
  more than a day** (you slept somewhere else, and a weekend in a city you often
  visit is still a weekend away), and **you recorded a route on it** — bothering
  to save the track is a statement that the day was worth keeping, and no
  derived rule should overrule it. `familiarTrips: 0` turns the whole thing off.
- **A trip you put away stays away.** They are derived, so there is no row to
  delete; the list skips a set of ids kept in the account preferences
  (`hiddenTrips`), and one press on the row does it. Reversible in one press
  from the row under the list, which is why it doesn't ask twice — a confirm
  step for something undoable is just a second press. Ids are `trip-<start>` and
  stable across rebuilds, so one stays hidden as more history arrives.
- **…and a trip you named stays named**, by exactly the same mechanism — see
  [Calling one something else](#calling-one-something-else).
- **Named after where it mostly was, not after its middle.** Naming is a
  separate pass (`nameTrips`) because the place data is a 2 MB lazy chunk and the
  trips are complete without it. It gets the trip's `spots` — one entry per cell
  and route, carrying which days it was seen on and how many visits it records —
  and picks:
  1. **the region with the most evidence in it**, by days first, then by time.
     Six days in Rome outrank one day's drive through nearly seven times as much
     of Abruzzo; and within the same number of days, a day spent driving right
     across one canton to sit for six hours in the next is a trip to the second
     one, though the first has twice the cells in it.
  2. **the best-known settlement inside that region**, scoring √(time spent) ×
     a factor that grows with population (`1 + log₁₀(1 + pop)`). Nobody calls a
     week in Rome "Fiumicino", and a city of half a million is worth about twice
     a village — so it takes the name when the time spent is comparable, and
     loses it when you actually slept in the village all week.

  **Time, measured — not days, and not ground covered.** This is what the second
  rewrite of naming was for. The measure used to be *days plus a bounded
  fraction of the region's visits*, which has a floor of one whole day under
  every place a trip touched at all: within a single day every candidate scores
  1.0-something, a 3× difference in the hours actually spent compresses into 15%,
  and population decides everything. A day out to St. Moritz came back named
  *Chur* — five cells of motorway in a town of 35,000 beating four hours in a
  village of 5,000, because the four hours were worth 0.27 and being three times
  larger was worth 1.23.

  A spot now carries `secs`, from the only thing the stored history can say about
  duration: **the gap to the next sighting anywhere else**. Bounded at both ends
  (`STAY_CAP_SEC` 6 h, `STAY_FLOOR_SEC` 5 min). The cap, because a gap can be a
  fortnight — phone off, or a stay held across its own silence — and a fortnight
  credited to whichever hexagon happened to be last would settle a whole trip's
  name from one arbitrary cell. The floor, because plenty of imports carry one
  timestamp for a whole afternoon of cells: with every gap zero the measure
  would collapse, and instead it degrades to "how much ground did you cover
  here", which is the old proxy.

  **Square-rooted**, because raw seconds have too much range for the other half
  of the question. Size is meant to break near-ties, and against unbounded time
  it never could: the place you sleep always holds more hours than the place you
  go, so a week in Lisbon came out named after the parish the flat was in. The
  root leaves a 5× difference in time worth 2.2× — enough to beat any size gap
  that matters — while a 1.8× difference is worth 1.3× and loses to a city ten
  times the size.

  **A town has to beat the ground nothing can name.** The gazetteer stops
  somewhere, so a whole valley can have no settlement in it, and the time spent
  in one is still time spent. When more of a trip's time went to unnamed ground
  than to any place that *can* be named, the name is the region — "Graubünden"
  is a worse label than "St. Moritz" and a much better one than the town it
  drove through.

  Then a landmark (the lake it sat on), then the region, then the country, and
  only a trip with none of those anywhere in it falls through to *"At sea or off
  the map"*. The old rule — the place under the geometric centre of the trip —
  named six days in Rome with a day out to Florence after Montefiascone, the
  hill town halfway between them, and that case is now a test.
- **A country you are beside counts as a country you are in.** The outlines are
  rounded to ~1 km, which is fine for drawing and wrong for asking: anywhere the
  coast is intricate falls outside every polygon. Venice is the case that showed
  it — the historic city is lagoon in the boundary data, so is Murano, so is the
  Giudecca, and so is the gazetteer's own coordinate for Venice. Every cell of a
  week there had no country, therefore no region, therefore no vote at all, and
  the trip was named after the five cells recorded during a coffee stop in
  Luzern on the way. `countryNear` (`src/countries.js`) looks `NEAR_KM` (5 km)
  around a miss before giving up; a hit costs exactly what it did before, and
  thirty kilometres out to sea still finds nothing, which is what keeps *at sea*
  an honest answer rather than the name of the nearest coast.
- **Ground the datasets can't place doesn't get a vote.** The country outlines
  are rounded to ~1 km, so cells just off a coast fall outside every country —
  the same ones the statistics book as offshore. Pooling them made a single
  nameless "region" holding *every* countryless day of the trip, which then
  out-dayed the city the trip was actually in: a week in Athens with four days'
  sailing came out as "At sea or off the map", with no country left on it for
  the search box to match. They are skipped now, and a trip that is nothing but
  such ground still ends up there by finding no region at all and falling back
  to its centre.
- **Every place it went is kept, not just the one it is called after.** `tags`
  holds every town, region and country the naming pass looked up — it asks about
  each cell anyway — and the search box matches them. Otherwise a trip named
  after a canton, because the valley it sat in has no town on the map, is
  unfindable by anywhere you actually remember being.
- **Naming asks about every cell, so the answers are cached** at ~1 km
  (`src/stats-ui.js`). Being a kilometre out cannot change which country or town
  a cell belongs to often enough to matter, and it turns ~1,500 lookups into
  ~500: the whole derivation is ~30 ms for 1,400 cells, against 6 MB of shapes.

### Calling one something else

The derived name is a good guess and a guess is what it stays. "Zermatt,
Switzerland" is what a gazetteer can work out; what you remember is "the week
the lift broke", and a list you browse by memory should be able to say so.

There is still no row to edit, and that is not worked around — it is used. A
trip has a stable id and the account already has somewhere to keep an opinion
about one, which is what `hiddenTrips` is. Renaming is the second entry in the
same drawer: **`tripNames`**, an id → name map in the account preferences, with
a local mirror under `visited-map:trip-names:v1`.

- **The mirror is not about being offline.** On a load where this browser's
  stamp is the newer one, `prefsPayload()` is sent back as it stands — so
  anything the payload carries and the browser cannot rebuild is a preference
  *erased* by the recovery that exists to save it. That is the same reason the
  hidden ids are mirrored, and it is the whole reason for the key.
- **Applied in one place**: `derived.setTripNames`, which edits the trips **in
  place**. The palette holds trip objects as the keys of its relevance map and
  the calendar compares them by identity, so handing back renamed copies would
  be two lists of the same holidays that do not match. It also means a trip is
  called the same thing in the palette, the calendar and the Trips tab, which is
  the point of `src/derived.js` being the single reading.
- **Re-applied on every read**, because `/api/trips` is asked on every opening
  and the server knows nothing about your names: a fresh 200 arrives calling
  your holiday whatever the gazetteer calls it.
- **The derived name is kept beside the new one** (`derivedName`). Clearing a
  name means *call it what you worked out again*, which is unanswerable if the
  answer has been overwritten — and re-deriving is a round trip and a 2 MB
  gazetteer away.
- **An empty name is a deletion, not a name.** Nothing is ever stored empty, so
  an id absent from the map is a trip called what the server called it.
- **Bounded at `TRIP_NAME_MAX` (80)** in `src/trips.js`. Long enough for a
  sentence; short enough that a list of them still reads as a list; and it
  bounds the preferences blob, which has a 64 KB cap of its own and would
  otherwise be one paste away from refusing every later save.
- **Edited in the row**, not in a dialog. Everything you need while choosing a
  name — when it was, how long, how far — is on the row, and a dialog would
  cover it with a box asking what to call it. Return commits, Escape cancels,
  and leaving the field commits too: it is one line in a scrolling list, so the
  usual way out is to touch something else, and a name lost to that is a name
  typed twice. The field stops its own keys from reaching the palette, which
  reads Return as "open the highlighted row" and Escape as "close".

`scripts/test/trip-names.mjs` pins the three that are invisible when broken: the
same array is edited rather than replaced, a fresh answer from the server keeps
the name, and clearing gives back the derived one.

### Showing one

Picking a trip draws it as **the track it was**, not as a wash over the ground
it covered: a dot at the centre of every cell it touched, threaded in the order
those cells were first seen (`showTrack`/`trackFC` in `src/main.js`,
`TRACK_COLOR` and the two width ramps beside it).

- **The order is free.** Each spot already carries `at`, the first moment that
  place was reached, so the shape of the days comes back without storing
  anything. A translucent tint over the same hexagons said *somewhere in here*;
  a line through them says where you went and which way round.
- **The thread is cut where there is nothing to thread with.** No timestamp, the
  *same* timestamp as the point before it, or a gap over `TRACK_LINK_GAP_SEC`
  (36 h). The middle one is the case that matters: an afternoon imported from
  one photo album carries a single timestamp on every cell of it, and joining
  those in whatever order they came out of storage draws a zigzag and calls it a
  route. Dots with no line is the honest answer, and it is what that data gets.
- **Solid dots with a dark rim**, because the highlight has to read on four
  basemaps including a photograph. The old 16% fill was legible on the dark one
  and nearly invisible on Satellite.
- **The chip names it** (`#trip-chip`, sharing `.route-solo`'s styling), and
  stays up until you stop it. A toast couldn't: the name is not an event that
  happened two seconds ago, it is what you are currently looking at. Both chips
  live in one `.map-chips` column so an isolated route inside a shown trip
  stacks under it rather than landing on top of it.
- **A day is shown the same way** — `dayCells()` places and dates the cells one
  calendar day recorded, and the map draws them with the same code. Until then
  a dot in the calendar was the end of the road: it said the day had ground on
  it and gave you no way to look at it.
- **Framing a trip lets go of "my location" first** (`releaseCameraLock`).
  MapLibre's tracking control hands the camera back when it sees a move it
  didn't cause, but deliberately ignores one that arrives mid-zoom so a pinch
  doesn't drop the lock — and a programmatic flight *starts* as a zoom, so it
  was ignored too and the next position update snapped the map back. Telling the
  control the camera is about to move for someone else's reasons is exactly what
  a drag tells it, and it falls to its background state: the blue dot stays and
  keeps updating, only the camera is let go. `map.stop()` has to come first,
  because that guard asks whether the camera is moving *right now* and the
  answer is still yes a good while after the last flight — measured true 600 ms
  after a 300 ms `fitBounds`.

### In the calendar

A trip is drawn as **one shape across the month grid** (`tripDays()` +
`.cal-day.trip` in `src/style.css`): the dots of the days in it grow into a bar
joining them. Five loose dots describe five errands; the bar says you were away
from the 4th to the 8th, which is what anyone is actually looking for in a month
grid.

Every day between the first and last thing that happened is marked, **including
the quiet ones** — you didn't come home on the Wednesday just because the phone
recorded nothing. The bar is one colour along its whole length for the same
reason; which days have evidence is already said by the lit cell behind the
number.

**One pill per day, inset on every side.** A run reads as one journey because
the pills line up, not because they touch. Two earlier attempts are why: reaching
3 px past each edge to cross the grid gap put marks outside their own day and
needed a special case at the end of every week, and running them flush edge to
edge read as a rule drawn under the month rather than as marks belonging to
days. Nothing overhangs now, so the end of a row and the end of a month need no
handling at all — the run simply stops and picks up again.

A day with no neighbour in the same trip stays a **dot**; the pill grows only
towards a neighbour that is in it, which is what makes the first and last day of
a run read as its ends.

`scripts/test/trips.mjs` covers the decisions rather than the plumbing: that
home is where the visits are and not where the trip was, that a week is one trip
and two weekends are two, that a weekend away lasts two days, that twice in a
year is twice, that an undated cell invents nothing, that a day at home between
two trips makes them two while one continuous absence stays one, that twenty
days of driving out and back is not a trip at all while a single day away still
is, and — with a pretend
gazetteer of longitude bands, so the argument under test is which places a trip
weighs most rather than which shapes are where — that the week beats the drive,
that the city beats the village only when the time is comparable, that four days
at sea don't outvote three days in the city, and that a stored row's visits are
counted once and not at both of its ends. It also covers what the map is drawn
from: that a day's cells come back placed, dated and in time order *however they
come out of storage*, that a place is dated by when it was first reached rather
than last, and that a trip marks every day of its span in the calendar including
the silent ones. `scripts/test/stats.mjs` runs the same naming case against the
real datasets.

## Language

`src/i18n.js` holds the machinery, `src/locales/en.js` holds English, and
English is both the source language and the fallback every other one is measured
against.

### `t()` is synchronous, and `src/boot.js` is why it can be

A great many strings in this app live in module-level constants — the palette
labels in `src/export-image.js`, the source names in `src/locations.js`, the
cadence titles, the caption fields. Those are evaluated the moment their module
is imported, long before any promise could resolve. So either every one of them
becomes a lazy `labelKey` read at render time — a very large refactor of code
that is not otherwise wrong — or `t()` answers immediately.

It answers immediately. `src/boot.js` already exists to `await` something before
importing `main.js`: the map library, because Safari 14 has no top-level await
and `main.js` builds its map at module scope. The locale is awaited in the same
place, by the same trick, in parallel with the library — a few kilobytes against
a megabyte, so it costs nothing. By the time any other module is evaluated the
strings are in hand, and nothing else in the app has to know this happened.

**Changing language therefore reloads the page**, for the same reason: a
constant read at import time cannot be re-read. Half the app in the new language
and half in the old is worse than a reload, and there is precedent a few files
over — switching to a basemap that needs the other map library reloads too, and
for the same underlying reason, which is that some decisions are made before the
app runs.

### Five ways to key a string in markup

`data-i18n` sets an element's text; `data-i18n-placeholder`,
`data-i18n-aria-label` and `data-i18n-title` set the attributes a string can
hide in. The fifth earns its existence: **`data-i18n-text` writes only the first
text node**, leaving element children alone.

Most rows here are shaped `<span>Clock<small>Times follow this
device</small></span>` — a label and its own note in one element — and
`textContent` on that would delete the note. The obvious alternative is to wrap
the label in a `<span>`, and that breaks the layout: `.import-row span` is a flex
column, so a nested span inherits the rule and stacks the label's own letters.
Writing the text node in place changes nothing about the tree.

Everything is set with `textContent` and `nodeValue`, never `innerHTML`. A
translation is a string in a file, a file can be edited by somebody who is not
thinking about script tags, and nothing here needs markup.

### The keys were generated, and that is the point

`<where>.<what>`, where *where* is the nearest enclosing element with an id and
*what* is a slug of the English text. Not elegant; the property that matters is
that a key can be found from the string on screen *and* from the markup that
holds it, with no lookup table in between. They were extracted from the markup
mechanically because 391 hand-written keys is 391 chances to file one under the
wrong dialog — and the extraction was verified by stripping the added attributes
back out and checking the result matched the original byte for byte.

### Plurals come from `Intl`, not from a rule in the code

Two keys per phrase — `whatsNew.places.one`, `whatsNew.places.other` — with the
*category* chosen by `Intl.PluralRules` for the active locale. English has two
forms, Russian has three and picks on the last digit, Japanese has one. A
language needing `few` or `many` adds those keys and they are found without any
code moving; a missing category falls back to `other`, which every language
defines.

For the same reason `{name}` placeholders are named rather than positional: a
count and its noun do not come in the same order in every language, and a `%s`
that has to stay put is a sentence the translation cannot fix. Even the list
joiner is a string — a French locale wants different spacing and a Chinese one a
different comma.

### What the test enforces

`scripts/test/i18n.mjs` is what makes this safe to extend, because keys are
referred to by name from two places no compiler checks. It fails on markup asking
for a key nobody defined, on a key defined and no longer used, on a translation
defining keys English has dropped, and on a `{placeholder}` that survives in
English and not in a translation. The last two are vacuous while English is the
only file — written now so the first translation to land is checked by a test
that already existed, rather than by somebody noticing a raw key in a screenshot.

A missing key renders as the key itself. That is deliberate: a key on screen is a
bug and should look like one.

### Where it is not done yet

The markup is fully keyed. The strings still written in JavaScript — the route
sport names, the import messages, the statistics panel's labels — are not, and
they are the larger half. The machinery and the guard are in place, so each is a
mechanical change: move the string into `src/locales/en.js`, call `t()`, and the
test says whether anything was missed. **A language picker is only offered when
more than one locale exists**, so nothing claims to be translated while that is
still true.

## The first five minutes

`src/intro.js` decides; `src/intro-ui.js` is the deck of cards.

A map with nothing on it is the one screen here that cannot explain itself.
Every other empty state has a heading above it saying what would be there — no
routes yet, no trips yet — but the map's empty state *is the product*: a grey
world somebody is apparently meant to know what to do with. The two questions
people actually arrive with are "what is this for" and "where does the data come
from", and neither is answerable from a grid of hexagons.

So they are answered once, in front of the map, across seven cards
(`INTRO_PAGES`): what it is, what it reads out of your history, where that comes
from, whose machine it is on — and only then does it ask for anything.

**It is not an interface tour.** Nothing in it points at a button and says "this
is the menu". You already know how a map works. What is worth saying is the part
no amount of poking will tell you: that a *trip* is derived and has a definition,
that workouts arrive from four different places, that the server it is talking to
is yours.

### Three hosts, one deck

The whole of the difference between a browser, the iPhone app and the Mac app is
**what can be asked for**. A page cannot open a photo library or a health store,
and there is no HealthKit on a Mac at all, so `permissionsFor()` hands back three
rows, two, or one. Both wordings for the two cards that differ are written out in
`index.html` and the stylesheet hides the wrong one — a sentence assembled at
runtime is a sentence no translator ever sees (see [Language](#language)).

`hostKindOf()` reads two signals the app already had:

- `data-client="ios"` on the document, stamped by the server for a User-Agent
  carrying `HexploreiOS` (`indexForClient` in `server/index.js`).
- the `hexploreLocation` message handler, which **only the Mac app registers** —
  the iPhone's WebKit delivers positions perfectly well and needs no shim (see
  [The button that says where you are](#the-button-that-says-where-you-are)).

The Mac is therefore identified by its geolocation bridge rather than by the
`HexploreMac` tag it also sets, because the server does not rewrite the document
for that tag and there is nothing on the page to read.

### Asking is done by asking

None of the three rows calls a "request permission" API, because for two of them
no such thing exists on this side of the bridge.

- **Photographs.** The way to ask for a library is to ask it a question:
  `loadPhotos()` is the same scan the overlay uses, and answering it runs
  `PhotoLibrary.authorize()` in the app, so iOS puts its sheet up in front of the
  answer. What comes back is either a library — and the row then says how many of
  your photographs turned out to know where they were, which is the first
  evidence anybody gets that the idea works — or the reason there isn't one.
- **Position.** `navigator.geolocation`, which is right in all three hosts: in a
  browser it is the only one there is, on the iPhone WebKit raises the app's
  prompt behind it, and on the Mac the app has already replaced the API with a
  shim onto CoreLocation. The fix is kept, and the fix stays where it is.
- **Apple Health.** The one with no web equivalent at all: there is no standard
  way to raise HealthKit's sheet, so the iPhone app answers a message of its own
  (`HealthBridge`) by throwing the same switch its Settings tab throws — and
  that `didSet` is where `requestAuthorization` lives. The page and the switch
  therefore cannot disagree afterwards, because there is only one of them. No
  workout crosses that bridge; only the question does.

  **`ok` there means asked, not granted.** HealthKit read permission never
  reports itself — Health answers a query identically whether you said yes or no
  — so a refusal shows up later as a sync that finds nothing, which is what
  `HealthSync.apply()` already had to live with.

  A Mac has no HealthKit and an older build of the app has no handler. Both are
  answered rather than assumed away: the row goes back to being the directions it
  used to be, and pressing it is not reported as a refusal, because being told
  where to go is not the same as saying no.

### A replay is a fresh reading, not a recording

Settings ▸ Replay the introduction exists for the person who skipped it on the
first morning, or who has just been handed an account by whoever set the server
up. Every actionable step re-reads the world on the way in, so it says "home is
already Zurich" instead of asking again.

`alreadyGranted()` weighs two kinds of evidence, and the second is the better
one: what this device remembers answering, and **what is on the map**. A source
named `apple-photos` means photographs have already become cells. That is not a
permission check, it is better than one — it is the permission having produced
the thing it was for.

Position is the one that can simply be asked, and on a Mac it has to be asked of
the right thing. `navigator.permissions.query({name: 'geolocation'})` reports on
*WebKit's* permission, and the Mac app does not use WebKit's permission — the
page's `navigator.geolocation` is a shim onto CoreLocation. So the browser
answered `prompt` for a machine that had been giving out positions for months,
and a replay offered to ask for something it already had. `LocationBridge` now
answers `{ask: "state"}` with the CoreLocation status in the Permissions API's
own three words, and is consulted first wherever that handler exists. An app
built before the question existed replies "unknown request", which is not an
answer and is not treated as one: it falls through to the browser's guess rather
than being reported as a refusal.

Each of the three rows also says its own thing once it is settled. One "Already
done" across all of them is what a form writes; a screen claiming to have been
paying attention has to sound like it, and the truthful version differs for a
library it has already read, a map that already knows where you are, and a ride
that turned up on its own. The resting sentence is restated from its key rather
than remembered, so a row whose grant was revoked in iOS Settings goes back to
explaining itself instead of keeping the note from last time.

### One gesture, one card

A deck is a pile you are working through, and the two directions are not
symmetrical. Leftwards is the front card being **thrown away**, and it is the
card that moves. Rightwards is not that card sliding back: it is the *previous*
one coming home over the top of it, which is what putting one down on a pile
looks like from above. So `paint()` chooses its element from the direction of
travel, and the returning card is dragged out of the `done` state it is parked in
(`RETURN_X`, `RETURN_DEG` — both of which have to agree with the stylesheet,
because that is the position it is being dragged *from*). Dragging the front card
rightwards instead would be a carousel, and it also pushes the card you are
trying to reach further behind the one covering it.

Two locks stop one gesture turning several cards, and only one of them is
obvious.

- **A trackpad does not stop when the fingers do.** The kinetic tail of a single
  two-finger flick is a hundred more `wheel` events, so resetting the accumulator
  on commit merely let the momentum earn the next hundred and ten pixels, and the
  next: one shove ran the deck from the first card to the last. `wheelLocked` is
  set on commit and cleared only by the stream going quiet for `WHEEL_IDLE_MS`,
  and the idle timer is pushed by *every* event including the ignored ones — a
  gesture is its events and its tail, and the pause is the only honest end of it.
- **`TURN_LOCK_MS` after any turn**, for every other way in. Shorter than the
  flight, so a deliberate second swipe still lands.

`visibility` is in the card's transition list on purpose, and its timing is the
trick. A discarded card has to end up `visibility: hidden` so it cannot be tabbed
into or read out, but visibility does not animate — declared plainly it applied on
the first frame, and the 520ms flight happened to an already-invisible element.
The `done`/`deep` states delay it by exactly the length of the flight; the base
rule leaves it at zero, so a card coming *back* is visible on the frame it starts.

### One scene, and it is not the map's

Everything else here follows `data-theme`, which describes the **basemap**. The
introduction cannot: it is a curtain drawn completely across the map, so there is
no basemap left for it to be legible against — and on a first run nobody has
chosen a style anyway, so `data-theme` at that moment is a default rather than a
preference. It follows `prefers-color-scheme` instead, which is the only
statement of taste available before the app has been used. Every colour therefore
goes through a token declared on `.intro` and redeclared once in the light block,
so a rule added later inherits the theme by construction rather than by somebody
remembering to go and add one. `.intro-pick` is the exception, and it proves the
rule: that one appears with the curtain *lifted*, and does have a map underneath.

The illustrations are `currentColor` at three strengths and nothing else. An
earlier set coloured them by role — violet for photographs, amber for routes,
matching the map — and seven cards each carrying a small bright object read as a
sticker sheet competing with its own words. One colour, and the drawings sit down
and let the sentence be the thing you look at.

### Seen once, per person

`shouldIntro()` takes the higher of two copies (`seenVersion`), because they
disagree in both directions: a browser that finished the deck offline says so
locally, and a second browser that has never seen anything hears it from the
account. The account's copy rides in the preferences (`intro`); the local mirror
is keyed **by account name**, because a browser is not a person and a bare flag
would mean the second person to register on a shared laptop is silently never
introduced to anything.

Skipping counts the same as finishing. Somebody who threw the deck away on the
first card has answered the question, and asking every morning until they sit
through it is the behaviour of a pop-up.

A version rather than a flag, so that rewriting the cards can decide for itself
whether it is worth showing again — the same trade the service worker's cache
name makes.

### Two things it takes over

**The map, for one card.** Choosing home needs somewhere to point at, and the map
is behind all this. The curtain lifts — the whole deck scales up and out, which
reads as the map arriving rather than the cards leaving — `beginHomePick(…, {bare:
true})` runs the pick with the map's own chrome hidden, and the curtain comes back
down on the answer. Hiding the menu and the search button is the point: there is
exactly one thing to do on that screen, and a menu is an invitation to do
something else. Cancelling is a whole answer and is acknowledged rather than
argued with. This replaced a banner that used to make the same offer across the
top of the map, which had to wait for enough cells to justify itself and then
interrupted whatever you were doing.

**The "what's new" banner, for one load.** On a first-ever sign-in it is asked to
move its baseline and say nothing (`show({quiet: true})`). A line about how much
the map has grown is a strange thing to tell somebody who has not yet been told
what the map is — and the baseline still has to move, or the *next* open reports
the whole map as news. See the section below for why that distinction matters.

## What changed while you were not looking

`src/whats-new.js` is the arithmetic; `src/whats-new-ui.js` is the banner.

The map is filled in by things that are not you — a phone in your pocket, a
watch that saved a ride, Home Assistant noticing you came home, a Strava sync at
four in the morning. So opening it is the interesting moment: the ground has
moved and nothing on screen says so, because **a map that has grown looks exactly
like a map that has not**.

### Since when, and why it is not "since last time you opened it"

Since the last time a banner was *shown*. That distinction is the whole of why
the middle setting works. If the baseline moved on every open, four days of one
cell each would each be too small to mention and the fifth would report one cell
— and a week would pass without a word. Holding the baseline until something is
actually said lets small changes accumulate until they are worth saying.

Two consequences, both deliberate:

- **The first open ever shows nothing.** There is no baseline, so there is no
  change. A banner announcing that you have 12,000 places is not news, it is the
  map. The baseline is recorded and the next visit is the first that can report
  anything.
- **`never` moves the baseline anyway.** Otherwise switching it on after a year
  would open on "+38,000 places", which is a number nobody can feel and not what
  anybody meant by turning the setting on.

**Only growth is reported**, and that is not laziness. Cells go *down* when you
take a source off the map or undo an import — both things you just did on
purpose — and being told about them on the next open is the app reading your own
action back to you. There is no honest "you lost 300 km²" that is also welcome.

### Both the frequency and the baseline follow the account

The setting rides in the account's preferences beside the clock: how much you
want to be told is a fact about you. So does the **snapshot** it is measured
against, and that is a reversal.

It used to stay in this browser's localStorage, on the argument that it answers
*since you last saw this banner* and the laptop and the phone have seen
different banners at different times. What that produced in practice was one
ride announced twice — on the phone when it was picked up, and again on the
laptop an hour later — and news you have already had is not news. The banner is
about what changed, not about which machine you are reading it on.

Both copies are still written. The local one is what makes the banner work with
no server and what survives a push that never landed; the account's is what the
other device reads. They are **merged rather than reconciled**, field by field,
taking the larger of the two (`mergeSnapshots`). A snapshot is a set of counters
that only ever grow, so the higher number is the one that has already been
reported — which makes the merge the safe direction: it can suppress a line and
it cannot cause one to be shown twice. A timestamp comparison could not promise
that. A phone that showed the banner while the laptop was asleep would still
lose to the laptop's older, lower baseline the moment the laptop pushed a colour
change, and the news would come round again.

The merge happens in `syncPrefs`, off the account's own copy rather than off the
adopted state — the same place and the same reason as `offerIntro`, because the
"push" branch never fills the adopted state in. It runs *before* the banner is
decided, since `onAuthed` awaits the sync and shows the banner after it. And
when the merge comes out ahead of what the account holds, the account is the
copy that is behind, so it is pushed back: that is a browser whose own banner
never got sent, and leaving the lower number on the account would let the other
device announce the same thing again.

The baseline moving is now a *write*, so it is pushed straight out rather than
on the 600 ms debounce (`onSeen`). The whole point is that the device you pick
up next stays quiet, and next can be a minute away.

### Workouts are the exception, at every setting

A new workout out of Apple Health is the one change here that came from something
you *did*: you went for a ride, and a watch and two syncs later it is on the map.
That is worth saying whatever the frequency says, so it is counted separately —
routes whose source is `apple-health` — and reported unconditionally. On `never`
you get the workout and none of the coverage, which is what `never` means.

The thresholds for "substantial" are constants at the top of `src/whats-new.js`
and they are two different kinds of thing. A country or a region is
*categorical* — there is no such thing as a slightly new country — so one of
either is always a line. Ground is continuous and needs a number: 20 cells or
400 km², which is more than a walk to the shops and less than a day out. A record
streak counts at any length, being the one figure that can only be beaten rather
than accumulated.

`scripts/test/whats-new.mjs` pins all four of the decisions above, because every
one of them is the sort of thing a later reader would "fix" back.

**"Show me" goes where the sentence pointed.** The banner is told how many
workouts it is about, and hands that number back when it is pressed: one, and it
opens that route directly (`stats.openRoute`, the same door the route card on the
map uses); more than one, and the Routes tab is the answer, because a list is what
several of anything looks like. Stopping at the list to make you pick its only
entry is a step that answers nothing. Which route is *the* new one needs no
bookkeeping — `routeList` is newest first, so the first `apple-health` entry in it
is the workout that just arrived. The count is read at press time rather than
captured on the button, because the button outlives the sentence: a banner
replaced by a later one must not open what the earlier one was about.

## Coverage

Countries and their regions in one list (`coverageList` in `src/stats-ui.js`),
each opening to show the regions inside it.

**The bar is always the share of that place**, whichever way the list is sorted.
It used to be the share of the biggest number on the list when sorted by ground
covered, which made the leader's bar full whether you had covered 7% of it or
90% — it read as *done*. Sorting now only reorders; both numbers are on every
row, the one you sorted by in full and the other dimmed after it, because a list
ordered by ground covered next to bars showing share otherwise looks mis-sorted.

**Ground covered is the default**, and sits on the left. It answers "where have
I been", which is the question the panel is opened with; share answers "how much
of it is left", which is the one asked second.

**Regions are nested, not a second list.** Ranking every region in the world
against every other put "Valais 22%" between two other countries' provinces —
a row you have to decode — when the question after seeing Switzerland at 7% is
*which parts*. A country says how many of its regions you have been to (`5 of
26`), opens to the leaders, and unrolls the rest on request; a country the
dataset doesn't subdivide isn't pressable at all.

## Regions

Admin-1 boundaries — states, provinces, cantons, départements — counted in the
same sweep as countries, because the expensive part is projecting each cell's
centre and that is paid once either way. `12 of 4,484` is a number nobody can
feel, so the denominator is the regions of the countries you have actually
visited.

**The dataset has to be the 1:10m set.** Natural Earth's 50m admin-1 file covers
nine large countries (Russia, the USA, China, Brazil, India…) and has nothing at
all for Europe, which makes it useless for the one country most maps of a life
are mostly about. The 10m file is a 40 MB download, so `scripts/build-regions.mjs`
simplifies it hard.

**Simplification is per region, as a fraction of its own size** (2%, clamped to
0.003–0.06°), not one tolerance for everything. A flat 5 km of slack is nothing
to Krasnoyarsk Krai and it deletes Basel-Stadt outright: at a fixed tolerance the
build lost 329 small regions, every one of them a place you can visit and would
then never be credited for. Sized per region, all 4,484 survive in 4.0 MB —
dynamic-imported, like the countries and the place names. Douglas–Peucker runs
*before* rounding, or it would be measuring the 1 km lattice the rounding just
made rather than the coastline underneath.

**Sizing it per region is also why the dissolve leaks, and the dissolve is
cleaned up rather than the build.** Two adjacent cantons thin the border they
share to different vertices, because each is sized against its own bbox. The two
polylines then cross back and forth along the whole border, and the union opens
a thin triangle at every crossing: dissolving Switzerland's 26 cantons produced
one outer ring and **110 holes**.

That is wrong on its own terms — solid Switzerland is what dissolving its
cantons means — and it also broke the renderer, which is how it surfaced. A near
zero-width hole tessellates into a fan that reaches the far side of the polygon,
so a map of Zurich grew two translucent wedges spanning nineteen degrees of
longitude. Three properties made it very hard to read as a geometry bug: it came
and went with the zoom (the fan follows wherever the tile clip falls), it was
absent in the heat modes (which draw each region separately and never dissolve
anything), and the geometry behind it was byte-identical either way. Those last
two are what finally pinned it on the union.

`unionGeometries` therefore drops holes that are gaps rather than places, and
**vertex count is what tells them apart**. Over a nine-country dissolve, 1,643
of 1,666 holes had six vertices or fewer — triangles and quads, none above
69 km². Everything above that was real and had to stay a hole: Luxembourg (35
vertices), Andorra (16), San Marino (14), the Caspian Sea (386). A few lenses
reach seven or eight vertices, so Polsby–Popper compactness catches the tail —
a border gap is long and thin where an enclave is compact, and San Marino, the
least compact real one, still scores 3× the threshold. Area alone would not
work: the largest artifact is bigger than San Marino. The test is only ever
applied to *holes*; an outer ring may be as thin as it likes, and a barrier
island or a fjord's far shore is exactly that.

The country and continent levels never had this, and the reason is worth
keeping: `countries.json` rounds every coordinate to a shared 0.01° grid, so
neighbours land on the same lattice and agree about the border between them.
Rounding to a common grid is a cruder tool than Douglas–Peucker and it is the
one that preserves topology.

**Regions are the finest of the polygon levels.** Level 4's hexagons were ~73 km
across, which says nothing a canton doesn't say better — "which cantons have I
been to" is a question with an answer where "which 73 km squares" is not. So the
coarsest steps of the map are polygons: cantons, then countries, then continents.
*Detail → Region* pins that level the way *Country* pins the one above it.

That needed the crossfade machinery to grow a second vector level, which is what
had blocked it before (see **Two vector levels**, below).

**Detailed boundaries are fetched per country, at view time.** The committed set
is Natural Earth, simplified to ~1 km, which is right for a level that normally
lives at z4–5 and visibly wrong when Detail is pinned to Region and you zoom into
a valley: the boundary cuts a straight line across the lake it actually follows.

Simplifying our own copy less does not fix that, because **the detail was never in
the source**. Natural Earth's raw 10m geometry gives the canton of Solothurn 276
points; the national survey gives 6,951. A first attempt shipped an 8 MB "fine"
build of the same data and it still looked wrong, which is the useful part of the
story — the tolerance was never the problem.

So when the region level is live and the zoom is past `REGION_FINE_ZOOM` (6),
`considerFineRegions()` asks geoBoundaries for the ADM1 boundaries of **the
countries whose lit regions are actually on screen**, one at a time, once each,
and rebuilds as they land. Switzerland is 0.42 MB and takes Solothurn to 520
points; the drawn union of two cantons goes from 255 points to 2,985. Zooming
back out returns to the overview geometry rather than tiling detail smaller than
a pixel. On Auto this is unreachable — that level never survives past ~z5 — so an
ordinary session fetches nothing.

**It happens on the server** (`server/regions-fine.js`), which was not the first
attempt and is the right one for three reasons, each learned by getting it wrong:

- **The browser cannot do it.** geoBoundaries' API answers a level that doesn't
  exist with an error page carrying no CORS headers, so probing for one prints
  "blocked by CORS policy" on a real origin. It worked from localhost and failed
  on the deployed site.
- **One machine fetching each country once is politer than every browser doing
  it**, and the answers are cached on disk (`REGION_CACHE_DIR`, default
  `./cache/regions`). The upstream commit is pinned, so the data cannot change
  and the cache never expires: a repeat request is 2–15 ms.

  **But only their side of it is pinned.** A cached answer is a map from *our*
  region ids to their geometry, and our ids move whenever `regions.json` is
  rebuilt. When Italy's 110 provinces became its 20 regioni, the cached file —
  keyed by `Italy/Vercelli` and 105 others — went on being served to a map whose
  regions are now named `Italy/Veneto`. Every id missed, nothing gained detail,
  and Italy alone sat on the overview geometry for good, while every other
  country was fine because no other country's regions had moved. A cache that
  never expires has to be invalidated by *something*, and "the upstream cannot
  change" is only half the inputs.

  So each payload carries a `fingerprint`: a hash of our sorted region ids for
  that country, checked on read. The ids and not the count, because a rebuild
  that renames a region without changing how many there are strands the cache
  the same way and is far harder to notice. A file written before the
  fingerprint existed is kept if the ids it is keyed by are still ids we have,
  so introducing this did not throw away every country's answer at once.
- **Choosing the level takes several small requests** and the answer is the same
  for everyone.

The browser therefore asks `GET /api/regions/:ISO` and gets back
`{ level, regions: { "<our id>": geometry } }` — session-gated, because an open
proxy onto someone else's dataset is their bandwidth to spend.

**The level is chosen by unit count, and it is not off by a constant.** "Admin-1"
means something different in each dataset *per country*: France's départements
are our admin-1 and their **ADM2**,
Switzerland's cantons are admin-1 in both, and Italy's regioni are ours and their
**ADM2**. So every level is a candidate, each is
asked its `admUnitCount`, and they are tried closest-count-first. Getting this
wrong is not subtle — pairing Italy against their five ADM1
macro-regions put a fifth of the country under one unit, and it looked like a
renderer bug: geometrically it *matched*, because their polygon really does
contain our unit's centre.

**Italy is dissolved to its twenty regioni at build time.** Natural Earth files
the 110 *province* as Italy's admin-1, which is a level below the one the
country is organised into and a level below what anyone means by "which parts of
Italy have I been to" — nobody counts provinces. Natural Earth already records
the regione on every province (`region`, ISO code in `region_cod`), so
`DISSOLVE_BY_REGION` in `scripts/build-regions.mjs` unions them together.

The dissolve runs on the **raw** geometry, before any simplification, which is
the whole reason it is clean: Natural Earth's provinces share exact vertices
along the borders between them, so nothing opens up. Thinning first and
dissolving after is precisely the failure described above under
`unionGeometries`. The one hole that survives is Natural Earth's own — its five
Marche provinces already fail to meet at the Umbria–Toscana tripoint, an 11 km²
gap across 15 points in the source.

It fixes the detailed boundaries at the same time, which is the other half of
the reason. geoBoundaries' Italian hierarchy is ADM1 = 5 macro-regions, ADM2 =
the 20 regioni, ADM3 = 107 province. At 110 units the chooser landed on ADM3 and
paired 106; at 20 it matches ADM2 exactly and pairs **20 of 20**, by name rather
than by geometry, because geoBoundaries names them in Italian and so do we
(Natural Earth gives two of the twenty in English — `REGION_NAME_OVERRIDES`
puts Puglia and Sicilia back). Italy's drawn detail goes from 1,015 points to
28,836.

One country, by explicit ISO code, rather than "dissolve wherever `region` is
set": that field is populated for plenty of countries where admin-1 is already
the level being asked about.

**Partial answers are kept.** Natural Earth counts Hungary's 23 city-counties as
admin-1 units and geoBoundaries folds them into their counties, so 17 of our 43
pair and the rest keep the overview shape. Every drawn shape is still the right
shape for what it represents, which is the test that matters — a level is only
rejected when it pairs less than 40% of the smaller count, meaning it is
describing something else entirely.

**Pairing is by name, then geometry, then size.** The two datasets agree on 24 of
26 Swiss cantons and disagree on Luzern/Lucerne and St. Gallen/Sankt Gallen, so a
name miss falls back to the geometry. Then every pair must be within 0.3×–3.2× on
area and each detailed shape may claim only one of our regions — the guard that
makes a wrong level harmless rather than catastrophic.

**The geometry path is a vote, not one point, and Kyiv is why.** It is easy to
read that fallback as a rare tidy-up for two Swiss cantons. It is the *only* path
for whole countries: not a single Ukrainian name pairs, because geoBoundaries
calls every unit "<name> Oblast" where Natural Earth calls it "<name>". All 25
fell through to geometry, 24 landed correctly, and one did not — Kyiv oblast is a
ring around the capital, both datasets cut the hole, and the average of a ring's
vertices is its centre, which is the hole. That single sample came down in the
sliver where the two disagree about where Kyiv ends: inside their oblast and
inside *our* Kyiv City. The lookup answered "Kyiv City", the size guard correctly
refused 28,105 km² against 1,649, and the oblast kept the overview shape while
all 24 of its neighbours sharpened. One region, low detail, no reason visible
from the map — which is exactly how it was reported.

`regionUnder` now tallies every interior point instead of taking the first. The
answer was already in the data: a walk across the same polygon lands in our Kyiv
oblast thirty times and in Kyiv City twice. Ukraine goes 24 → 25, no other
country's count moves, and every capital-inside-a-province in the world is the
same shape of problem. `scripts/test/region-pairing.mjs` builds that geometry
from scratch — a round province, its capital cut out, and the two datasets
disagreeing about where the capital is — and fails on a single-sample rule.

**Improving the pairing has to invalidate the cache.** `server/regions-fine.js`
caches per country and never expires it, because the upstream commit is pinned.
A better `pairFineRegions` is a third thing that changes the answer while leaving
no trace in either dataset, so `PAIRING_VERSION` goes into the fingerprint beside
our region ids. Without it, every country already cached would have gone on being
served the worse answer forever — the same failure mode as the Italian province
ids, which is what put the fingerprint there in the first place.

**Two resolutions cannot tile, so a country takes them or it doesn't.**
`pairFineRegions` is right to keep a partial answer — every shape it returns is
the right shape for what it names — but that is a different question from whether
a set of shapes can be laid down beside each other. Where a detailed region meets
an overview one they disagree about their shared border by up to a kilometre, so
the border is drawn twice a hairline apart and the union of the two leaves a
sliver of unfilled ground running between them. Hungary is the case that showed
it: 11 of 43 pair, each of them wrapped in one that did not, and a poster came
out double-ruled and full of holes.

**A coverage ratio is the wrong test for that, and it was the first one written.**
"Nine tenths of the country paired" sounds like the same question and is not. The
Netherlands pairs 12 of 15, and the three it misses are Bonaire, St. Eustatius
and Saba — eight thousand kilometres away, sharing a border with nothing. A 90%
threshold threw the country's whole detail away over them, so a poster of the
Netherlands came out with blunt provinces inside a sharp coastline and orange
spilling over the German border. `seamedRegion` asks the question that matters
instead: does any unpaired region *touch* a paired one? Bounding boxes rather
than geometry — two regions that share a border always have overlapping boxes, so
it cannot miss a seam; it can invent one, and that costs a country its detail
rather than costing the picture its integrity, which is the right way round to be
wrong. France's five overseas départements pass for the same reason as the Dutch
islands; Hungary's city-counties, which sit inside their counties, do not.

**Nothing is *resolved* against the detailed set.** Which region a cell belongs to
is decided once, on the overview geometry, so the answer cannot change under you
when the fine one lands and the per-cell memo stays valid.

What this buys, measured: Switzerland 26 of 26 regions, Italy 20 of 20, France
96 of 101 (their file simply has no overseas départements in it), Ukraine 25 of
25, Spain 52 of 52, Liechtenstein 11 of 11, Hungary 17 of 43. The drawn union of two
Italian provinces goes from 342 points to 4,158.

**The two datasets are joined on ISO code, never on the country name.** Natural
Earth's admin-0 file and its own admin-1 file disagree on twelve names — this one
says "Czechia" where the other says "Czech Republic", and the same for eSwatini,
North Macedonia, Cabo Verde, Guinea-Bissau, Palestine, São Tomé and Príncipe,
South Sudan, Vatican, Macao, Tuvalu and the Pitcairn Islands. Matching on the
name meant the region lookup found *nothing* for those countries, fell through to
"this country has no regions at all", and drew the whole of Czechia as one flat
country-shaped blob with a straight line where its border should be — and, because
the stand-in has no country code, it could never fetch detail either. Both
datasets now carry `adm0_a3` and every region lookup takes a code.

**A resolution change has to defeat the early-out.** `updateGrid` returns early
when nothing about the view changed, and the region level claims the whole world
as its coverage — so a zoom that crossed the resolution threshold was swallowed
entirely. Whatever had last fed the coarse geometry (a basemap swap at low zoom,
a colouring change, the first pass at the level) left the map coarse *for good*,
and no amount of zooming brought the detail back. The swap is a change in what
should be on screen, exactly like a level change, so it belongs in the same test:
`resolutionChanged` compares what the source is actually **holding** (`fedFine`)
against what the zoom now wants.

Tracking the *cache* instead would be the same mistake one level down — the fine
geometry can be built and cached while the map is still showing the coarse shape,
which is precisely how an earlier verification of this convinced itself the swap
worked. Measure the source.

**The detail fetch runs twice per pass, on purpose.** `considerFineRegions()` is
called before the early-outs, so panning into a country whose detail isn't loaded
still asks for it; and again after the geometry is built, because on the *first*
pass at this level there is no list of lit regions yet and the earlier call has
nothing to ask about. Without the second call, switching Detail to Region while
already zoomed in did nothing until the camera was nudged.

**Resolution is sticky between two thresholds.** The detailed geometry comes in
at `REGION_FINE_ZOOM` (6) and is dropped again below `REGION_COARSE_ZOOM` (5.4),
rather than both happening at one number. Swapping resolution re-tiles the
source, so a zoom that hovers on a single threshold would re-tile on every
wobble; the gap is the same trick as `LEVEL_HYSTERESIS`, for the same reason.
Dropping back matters most on an older device — the point of returning to a few
hundred points when zoomed out is that the map stays smooth.

**Border slivers snap; only genuinely unsubdivided countries stand in for
themselves.** The country outlines are rounded to ~1 km and each region is
simplified relative to its own size, so along coastlines and national borders
the two datasets disagree by a sliver: a sweep of Italy finds 1.5% of inland
points inside no region at all, Switzerland 4%. `regionNear()` snaps those to
the region they are a sliver outside of. An earlier version treated any miss as
"this country has no regions" and stood the whole country in — so a single cell
in a 1 km gap off the Ligurian coast coloured in the entire of Italy underneath
its cantons, while Spain looked fine because none of its cells happened to land
in one. The whole-country stand-in now fires only when
`regionsInCountry(country) === 0`, which is the microstates and a few
dependencies.

**Lookups are indexed**: fourteen times as many shapes as the country set is too
many to scan per cell. A 5° grid buckets them, and `regionAt()` is handed the
country the cell already resolved to, which drops all but a couple of dozen
candidates before any geometry is touched. `src/polygon.js` holds the
point-in-polygon and area maths both datasets share — answering the same two
questions twice in two files is how they slowly stop agreeing about which side
of a border a cell is on.


**The highlight is drawn over the basemap, not under it.** The three `trip-*`
layers take no `beforeId`, so a day's dots sit above buildings, road casings and
labels — what you asked to see should not be interrupted by street names. They
sit *below* a saved route the rest of the time, because a route is something you
switched on and left on, and `showTrack` raises them past it only while a day or
a trip is actually being shown. Home is re-raised immediately after, so the
order from the top is always home, then the highlight, then everything else.

## Continents

The last step out, below `CONTINENT_ZOOM` (2.75). Each lit continent is filled like a country and
carries a label saying **how many of its countries you have been to** — which is
the whole reason the level exists. "Which continents have I set foot on" has a
seven-item answer a world map already gives you; "how many countries of each" is
the one worth zooming out to ask, and it is the one number on the map that no
other level can show.

**It is Auto-only, deliberately.** *Detail* answers "how fine do you want the
cells", and its four buttons are a range: the grid as stored, Auto, Region,
Country. A continent is not a fineness — pinning one would mean looking at a
valley through a shape the size of Africa. The zoom is the only way there.

**There is no continent boundary file.** A continent is its countries dissolved
(`mergeContinents` in `src/continents.js`), so the two coarsest steps of the map
are cut from the same coastline. A second outline set would disagree with
`countries.json` somewhere along every coast, and that shows as a sliver of ocean
at one zoom level and land at the next. Only the membership is committed —
`src/continent-map.js`, 2 KB, built by `scripts/build-continents.mjs` from the
same Natural Earth admin-0 file the countries come from and joined on `ADM0_A3`
for the same reason (the names disagree).

It is a `.js` module rather than the `.json` every other dataset is, because it
is 2 KB rather than 4 MB: it belongs in the bundle answering synchronously, not
behind a dynamic import — and plain Node reads a `.js` module without the import
attribute JSON needs and Vite doesn't want. It is grouped by continent so a
re-run's diff says which country moved rather than reflowing 240 lines.

**A cell reaches its continent through its country.** `buildAreaFC` reads the
*country* memo and maps the answer on rather than resolving a third time against
the dissolved outline — which would be the same test over a shape with more
points in it, and one that could still disagree with the level below wherever the
union left a seam. So the two levels cannot light different places for the same
cell, by construction rather than by two implementations agreeing.
`scripts/test/continents.mjs` pins that from both ends, including through the
tap path (`countryNear`), which is a different lookup than the fill uses.

**A country belongs to one continent whole.** Natural Earth — and the UN's M49
scheme — put all of Russia in Europe and all of Turkey in Asia, so Europe is
23M km² here rather than the 10M an atlas prints. Splitting a country would break
both the shape and the count: the fill is its countries dissolved, and the count
would have to place Russia twice or nowhere. The label says "12 countries", not
"12 of 50" — the denominator would be Natural Earth's admin-0 list, which counts
Jersey and the Vatican, and this map has no business settling what a country is.

**The eight countries Natural Earth files under "Seven seas (open ocean)" are
placed by hand** in the build script. Three of them — Mauritius, Seychelles, the
Maldives — are sovereign states somebody can spend a fortnight in, and a country
with no continent is drawn at the country level and then *vanishes* one zoom out,
which reads as a hole in a landmass. The polar leftovers go to Antarctica.

**The label rides the level's own source.** It is a `k = 3` point feature on
`hex`/`hex-prev` beside the `k = 1` fill and `k = 2` outline, so it crossfades
with the level for free. A count that stayed on screen while the shape under it
dissolved into countries would be the one thing on the map not belonging to a
level. Three details it took a look at the real map to get right:

- **The fontstack is read off the basemap** (`styleFont`), not hardcoded: CARTO
  serves Open Sans and OpenFreeMap serves Noto Sans, and a stack the glyph server
  has never heard of is a label that silently never draws. Not simply the *first*
  stack in the style, either — CARTO's first symbol layer is a waterway name, and
  taking it drew the continent counts in italic.
- **The basemap's own continent names are switched off** while this level is live
  (`setBasemapContinents`). Ours carry the name and the number both, and MapLibre's
  collision only removes a label ours actually overlaps — "AFRICA" sitting just
  above "Africa · 1 country" overlaps nothing. The layer is `place_continent` on
  CARTO and `continent` on OpenFreeMap, so the match is on the substring.
- **The label layer takes no `beforeId`**, unlike the three under it. MapLibre
  places symbols from the top layer down, so being above the basemap's labels is
  what lets ours go first; `ignore-placement: false` then pushes colliding
  basemap labels out of the way, and `allow-overlap: true` means ours is never
  the one dropped. `raiseVectorLayers` puts it back in the same spot after a
  crossing, because `VEC_ANCHOR` is the trip track that was added just above it.

**It is the one boundary off the 3× ladder, and `minZoom` is 2.** The ladder
puts the country → continent crossing at `levelBoundary(5)` = z2.075, which
`LEVEL_HYSTERESIS` (0.28) makes unreachable from a floor of 1.8 — the level had
no room at all. The obvious fix was to drop `minZoom` to 1 and take the room
from the bottom of the map. That was wrong, and the way it was wrong is worth
keeping:

MapLibre requests tiles at `floor(zoom)`, so **anything below z2 draws on a
basemap's z1 tiles**, and a basemap generalises its coastlines hard at z1 —
much coarser than our own ~1 km outlines. Our sharp fill over the basemap's
blunt one leaves the basemap's land poking out all along every coast as dark
jagged rims, and it is worst in the Arctic, where Mercator stretches the
mismatch 4.8×. Almost the whole of the (1, 2.075] band was down there.

It reads exactly like a level-of-detail bug in our own data, and it isn't one:
`countries.json` has a single resolution, the source is created with
`tolerance: 0`, and geojson-vt's quantisation works out to ⅛ of a pixel at
every zoom. Three separate measurements chased the wrong thing — the region
dataset is no *finer* than the country one (539 points for Svalbard against
567), the polygon union is byte-clean around the artifact, and the jagged view
was at *lower* zoom than the clean one, where the same polygons must look
smoother. What settled it was two `visitedMap.state()` dumps identical in every
field but the zoom, one either side of 2.0.

So `CONTINENT_ZOOM` (2.75) overrides `levelBoundary(COUNTRY_LEVEL)` and the
level takes its room out of the country band instead: continents own (2, 2.75]
and countries (2.75, 3.66]. Both are narrower than a full 1.585 step and both
are wide enough for the hysteresis to sit inside, and every zoom either level
can be at is on z2 tiles or finer. `neighbourVectorLevel` reads the *midpoint*
of the country band rather than "within 1.2 of the bottom", because 1.2 now
covers the whole of it — which would warm continents on every zoom and leave
the region level to be parsed from cold on the way in.

The cost is that the map no longer zooms out quite as far as it did (2 rather
than 1.8), and that the default first view — zoom 2.2 — now lands on continents
rather than countries.

**The union is the cost, and it is paid before the crossing.** Dissolving Europe
and Africa together is ~200 ms of main thread — the same order as the region
level's first build, and the reason `warmVector` pre-tiles the neighbour a zoom
early applies here unchanged. It is held in `areaFC.continent` afterwards, and
each continent's own outline is memoised separately in `src/continents.js` for
the heat maps (one feature per continent) and the selection ring.

## Which pieces of a country are the country

`stripDetachedTerritories` (`src/geo-filter.js`) trims a country's
outline to the parts that are the country proper, so that one cell in French
Guiana doesn't light the whole of France at the country level and mainland Spain
isn't tied to the Canaries. It is a proximity flood-fill from the largest
polygon, keeping anything that chains within `OVERSEAS_GAP_DEG` (6°) of a piece
already kept — which holds Japan, Indonesia, the UK and Malaysia's two halves
together while dropping the colonies.

**Distance alone was deciding it, and it got Alaska wrong.** Alaska's bounding
box is 7.6° from the contiguous United States; the Canaries' is 8.6° from
Andalusia. There is no single distance that keeps a state and drops an
archipelago when the two are the same distance away, and the answer for a long
time was to drop both.

That was not a cosmetic loss. The filter deletes geometry, so Alaska was not
merely unlit — it was **not in the dataset**. `countryAt` returned null across
the whole state, which meant an Alaskan cell was in no country, so it was
counted as *ocean* by the coverage sweep, got no region either (the region
lookup is only ever run inside the country a cell already resolved to, and the
admin-1 file had Alaska all along), was named "at sea or off the map" by the
trip-naming pass, and left a bite out of North America at the continent level.
The continent level is only where it became obvious: a hole in a country reads
as somewhere you have not been, and a hole in a continent reads as a bug.

**Size is the second reason to keep a piece**, because size is what the question
was always about. Alaska is 18% of the contiguous United States; the Canaries
are 0.4% of mainland Spain, the Galápagos 1.9% of Ecuador, Hawaii 0.13%. So a
polygon is also kept when it is at least `MAJOR_PART_SHARE` (10%) of the
mainland *and* within `MAJOR_PART_GAP_DEG` (10°) — large, and still on the same
side of the world. French Guiana is 16% of France and would pass the size test;
it is 59° away and never gets asked.

Every bound has an order of magnitude of slack on the cases it decides, except
Alaska's own distance, which has a third. Measured against Natural Earth 1:50m,
exactly three countries change: the United States gains Alaska, and Micronesia
and French Polynesia gain the far halves of their own archipelagos. The share is
measured as real spherical area rather than the flat shoelace that used to pick
the seed — a share of the mainland has to mean the same thing at 65°N as at
25°N, and in degrees² Alaska reads three times its size.

**What is still dropped is dropped knowingly.** A cell in Tenerife, Honolulu or
Cayenne resolves to no country and is counted as ocean, which is the price of
not letting a remote holding light a mainland. `scripts/test/area-attribution.mjs`
pins both halves — Alaska in, those three out — so that widening the gap to
rescue somewhere else has to face what it costs.

One genuine gap remains: the **western Aleutians**, past 180°. `bboxGap` is flat
lng/lat arithmetic, so a polygon at +173° reads as 300° from Alaska rather than
7°, and no threshold reaches it. Attu is a few hundred square kilometres and a
hundred and fifty people; measuring the gap the short way round the world is the
fix, and it has not been worth doing.

## Turning the map

For most of this project's life the map could not be turned, and the reason was
never that anybody wanted a map you may only look at from the south. It was one
function.

Everything drawn over the basemap is built for **a rectangle of Mercator
metres**: the blob sheet is painted into one, the hex geometry is generated
inside one, the country and region loaders are told which countries fall in one,
and `coverage` — the thing that decides whether a pan needs a rebuild at all —
is one. All of them came from `paddedMerc()`, four lines that read
`map.getBounds()` and grew it by a third. That is the correct rectangle for
exactly one camera: north up, looking straight down. Turn the map and it
describes the wrong ground; lean it and it describes a rectangle where there is
a trapezoid.

So the question is asked once now, in `src/view.js`, from the camera itself
rather than from the shape of its bounding box. Nothing downstream changed —
`groundBox()` still returns `{xMin, xMax, yMin, yMax}` in Mercator metres, and
every renderer still consumes one. `ROTATE_ENABLED` in `src/main.js` is
therefore a switch rather than a rewrite.

**At bearing 0 and pitch 0 it returns precisely the box the old code did**, and
`scripts/test/view.mjs` opens by reimplementing the old four lines and
comparing. The unturned map is not a special case inside `view.js`; it is what
the general formula collapses to. A feature nobody switched on must not be able
to reframe the map by rounding.

Two facts about Web Mercator carry the whole file. **It is linear in screen
space** — one CSS pixel is the same number of Mercator metres everywhere on
screen at a given zoom, at every latitude — which is what makes the arithmetic
exact rather than an approximation, and what lets a margin measured in pixels
become one measured in metres by a multiply. And the **canvas source is
georeferenced**: the blob sheet is handed to MapLibre as four lng/lat corners,
so it is drawn by the same matrix as the basemap. It rotates because the
basemap does, not because anything in `blob-canvas.js` was taught to.

### What a rotation costs, exactly

The smallest north-up box around a turned viewport is bigger than the viewport,
and the blob sheet is painted into that box. The factor is `(W+H)²/2WH` on the
diagonal and 1 at each quarter turn — exactly 2 for a square window, 2.11 for
16:10, 2.67 for 3:1. So a map held on the diagonal asks for about twice the
pixels, bounded by the same `JS_BLUR_MAX_PX` / `MAX_SIDE` caps as everything
else, which is why the worst case is a slightly softer wash rather than a slower
map. A wide window is the one that finds those caps first, and that is worth
knowing before someone measures a rotation on a 21:9 monitor and concludes the
rotation is slow.

The **pad is a margin around the window**, not a share of the box. Charging 35%
of the *diagonal* box would compound with the rotation and make the sheet grow
faster than the ground it covers, so the padded rectangle is the padded
*window*, turned — which at bearing 0 is the same number as before.

### The compass, and why it only sometimes exists

Turning a map is easy to do by accident — a pinch that twists a few degrees, a
right-drag meant for a context menu — and very hard to undo by hand, because
"back to exactly north" is not a target a gesture can hit. So the one control
rotation needs is the one that puts it back.

It lives in the button cluster rather than a corner of its own, and it is only
there while there is something to say: on a map facing north the button would be
a permanent statement that north is up, which the map is already making. The
needle is set from JS on every rotate frame and deliberately has no CSS
transition — one would put it a fraction of a second behind the ground it is
describing, and the whole point is that the two agree.

Its appearing and disappearing is why the cluster's hairline rule reads
`.layers-btn:not([hidden]) + .layers-btn`. A plain `+` still matches the button
after a hidden one, so the pill drew a hairline down its own outside edge
whenever the map was facing north.

### What was actually broken besides the box

Almost nothing, and that is the point of the canvas source being georeferenced.
The saved routes, the trip track, the photographs, the airports, the train
tracks, the country and region fills, the edit-mode tiles and the two markers
are all MapLibre layers; they turn because the camera does.

One thing was genuinely wrong. The **edit-mode spotlight** converted its radius
from screen pixels to ground by unprojecting a point `SPOT_PX` to the right of
the cursor and measuring how far *east* it had landed. That is the same number
only while north is up: at a quarter turn a step to the right of the cursor is a
step north, its easting is zero, and the spotlight closed to nothing with the
grid still switched on. It reads `SPOT_PX × mercPerPixel(zoom)` now, which never
needed the map at all.

The **train tracks** deserve a specific mention because OpenRailwayMap's own
style has two camera keys in its state block, `bearing` and `pitched`. We set
their defaults once and never update them, which is harmless for exactly as long
as nothing draws from them — and nothing does, across all 288 grafted layers.
`scripts/test/rail-style.mjs` now walks every layout, paint and filter
expression looking for a `global-state` read of either, so a future rebuild that
grafts a layer consulting one says so, rather than the overlay quietly drawing
itself for a north-up map on a map that has been turned. The line-placement
`icon-rotate` expressions are not that: they orient an arrow along its own
railway and are camera-independent.

The **image export is not affected at all**, and should not be. It has its own
camera — a Mercator centre and a multiple of the fitted scale, see
[The preview is the camera](#the-preview-is-the-camera) — and a poster is drawn
north-up because that is what a poster is.

### Pitch, and the 3D basemaps after it

`MAX_PITCH` is 60 and `?pitch=` overrides it in either direction. The lean rides
on the turn gesture rather than one of its own — ctrl-drag sideways turns, the
same drag up and down tilts — because they are two axes of one camera and
MapLibre's `pitchWithRotate` already says so. `touchPitch` is the two-finger
version. Both are asked for by name rather than left to their defaults, so that
a `MAX_PITCH` of 0 really does mean the camera cannot lean by any route.

**60° is not a taste.** The horizon comes on screen when `cot(pitch) <
tan(fov/2)`, which for the field of view both libraries ship is 71.6°. Below
that there is ground everywhere the camera looks and nothing has to be invented
to fill the top of the window; above it the map needs a sky, and a basemap that
has not been given one draws its background colour up there instead. 60 keeps
the horizon off screen at every zoom, so none of these basemaps needs a sky
layer it does not have.

`groundBox` computes the trapezoid a leaning camera actually sees, in closed
form, from the ray through each screen corner —

    scale(y)   = d·cos θ / (d·cos θ − y·sin θ)
    forward(y) = d·y     / (d·cos θ − y·sin θ)

where `d = 0.5·height / tan(fov/2)` is the camera-to-centre distance in pixels
and the denominator vanishing is the horizon. At θ = 0 the two collapse to `1`
and `y`, which is the rectangle, which is why there is no separate unpitched
path to keep in step. A useful thing the formula says and intuition does not: a
lean pushes the **near** edge away from the centre too, not just the far one —
the camera pulls up and back, so the foreground widens rather than crops.

`PITCH_REACH` is the part that has to exist. The far edge runs to infinity as
the pitch approaches the horizon, and the sheet painted for it would be a
continent rendered at the density of a street, so the ground is painted for
three screen heights in front of the camera and no further. Past that the
basemap continues to the horizon on its own.

**What a lean costs is sharpness, not speed.** The sheet is one flat raster
spread over the whole visible ground, and the far edge of a perspective view is
wider as well as further away — so the growth is not the modest one intuition
offers. Measured in a 1710×986 window at z9: level, the sheet is 1745×1006 over
6.27 square degrees; at 60° it is 2800×1341 over 38.16, which is **6.1× the
ground through the same window**. The caps then bind — `MAX_SIDE` even on
Chrome, and `JS_BLUR_MAX_PX` considerably harder on WebKit — and density falls
by the square root of the area: about **1.7× softer on Chrome, 2.5× on WebKit**,
for exactly as long as the camera is tilted.

Levelling restores the original sheet to the pixel, and that took a fix of its
own. Every other test in `updateGrid` asks whether coverage has run *out*, and
none of them fires here: levelling cuts the ground the camera sees to a sixth
while staying comfortably inside the box painted for the lean, so
`coverageContainsView()` said yes and nothing rebuilt. The wash stayed soft with
no gesture left to blame it on. `coverageTooLoose` is the missing question —
*is the sheet now spending most of its pixels off screen* — and it is handled
exactly like a drifted zoom: worth repainting, not worth repainting mid-gesture.
`COVERAGE_SLACK` is 2.5 against a padded box that is 2.89× the viewport by
construction, so an ordinary pan or zoom never trips it.

The real fix is a tiled sheet rather than a viewport-sized one: blob tiles per
Mercator tile at a zoom chosen per tile, so the near field keeps its density
whatever the far field is doing. That is also what would make a level change a
raster crossfade MapLibre already knows how to do, and would retire the "two
canvas layers cannot hand over" problem the current in-canvas dissolve exists to
avoid. It is the next thing to do here, and the reason `PITCH_REACH` exists in
the meantime — three screen heights of ground and no more, so a hard lean cannot
ask for a continent.

Terrain needs nothing further from this side. MapLibre drapes raster layers over
a terrain source, and the blob layer is a raster layer.

**For Mapbox, `cameraOf(map)` is the seam.** It is the only place in the app
that asks a map object where its camera is, and it is duck-typed on six getters
both libraries agree about. `view.js` imports nothing but `hexgrid.js`; it has
no DOM and no MapLibre, which is why `scripts/test/view.mjs` can check the
geometry in Node.

### The 3D basemap, and the two libraries

The fifth basemap is **3D**: Mapbox **Standard**, with the modelled landmarks,
the trees, and a sun that can be put in four places — or left to follow the one
outside the viewer's own window, which is what it does unless told otherwise. It
is the only entry in the picker that another library draws, the only one that can
be *unavailable*, and the only one whose theme is not a constant.

**Standard cannot be rendered by MapLibre**, and everything below follows from
that. It is published as a style *import*:

    { "imports": [ { "id": "basemap", "url": "mapbox://styles/mapbox/standard" } ] }

Style imports are a Mapbox GL JS v3 feature; MapLibre 5.24 has no implementation
and renders that document as a style with zero layers and a blank screen. The
trees and the landmarks are not layers in a style you can borrow — they are
Standard.

**What was tried first.** The original 3D basemap ran on MapLibre and imitated
Standard by hand: it fetched `mapbox/streets-v12`, which is a classic flat spec-v8
style MapLibre renders fine, rewrote every `mapbox://` URL to https, extruded the
`building` layer itself with a `fill-extrusion` filtered on `extrude == 'true'`
(the string, not the boolean — against the boolean it matches nothing and the
city comes out flat with no error anywhere), added a `raster-dem` for terrain and
a sky above it, and put the token on each request through a `transformRequest`.
It worked, and Mapbox documents that path. It was replaced because it could only
ever be a worse copy of a thing that already exists — and because keeping it
meant maintaining an extrusion pipeline whose entire job was to approximate one
config value.

**So the engine is chosen at boot, per basemap.** `src/gl-engine.js` holds the
decision, `src/boot.js` acts on it, and both libraries are dynamic imports — a
viewer who never picks 3D never downloads Mapbox GL JS (520 KB gz) and one who
does never downloads MapLibre (284 KB gz).

Why not simply run Mapbox GL JS for all five and delete the seam: it is
proprietary since v2, and it is billed **per map load** rather than per tile, so
every time the app opened to look at CARTO Dark it would spend one of Mapbox's
50,000 monthly loads on a map Mapbox had nothing to do with. Loading it only when
it is the thing being looked at keeps both the licence and the meter where they
belong.

**Crossing between the two rebuilds the map, not the page.** Reloading was the
first answer and it was too slow to live with: it threw away the session's
cells, routes, boundaries and photographs and fetched every one of them again,
to change which library was drawing the ground underneath. Nothing above the
basemap needed to move.

`switchEngine()` replaces the map object instead. What makes that possible is
the **`onMapBuilt` registry**: everything main.js has to say to a map — a
control to add, a handler to register, one of the library's own DOM elements to
go looking for — is said inside `onMapBuilt(fn)`, which runs `fn` now and
remembers it, and `rewireMap()` says all of it again to the next map in the same
order. Order is load-bearing: handlers for one event fire in registration order,
and `installGrid` has to run after the handler that sets `chromeStyleSeen`.

**Everything means everything, and missing five of them cost two bugs that
looked unrelated.** `click`, `mousemove`, `move`, `moveend` and `resize` were
registered in a block headed *"bound once; map + DOM persist across setStyle"* —
which was true for as long as there was only ever one map, and stopped being
true the moment there were two libraries. Bound to the map that had just been
thrown away, they left a map that answered no clicks (so a route could not be
selected) and called `updateGrid` on no camera movement (so the visited wash
froze where the old basemap left it and stayed there through every pan, until
something forced a repaint by another route — changing the colouring mode, which
is how it was reported).

Neither threw, which is what made them slow to find: a handler that was never
registered is not an error anywhere, and the layers it would have driven were
all present and correct. The check that finds them is *"which `map.on` calls are
at module scope and not inside an `onMapBuilt`"* — worth re-running after any
change here, because the failure mode is silence.

What makes it *safe* is that `installGrid` already rebuilds every layer this app
draws on `style.load`, because an ordinary basemap switch has always dropped
them. A new map fires that event exactly as a new style does, so the restoring
path is the one that has been exercised on every switch since the app had two
basemaps.

Three things the rebuild has to do by hand, each for its own reason. The
library is fetched **before** anything is torn down, so a failed download leaves
the map on screen alone. The popups are closed and forgotten, because they hold
the map that made them and their elements live in the container about to be
emptied. And `blobCur` is **disposed and then rebuilt**, because
`createBlobLayer(map, …)` is the one module in the app that captures a map. The
rebuild is obvious; the dispose was not, and it threw. `upload()` leaves an
`idle` handler and a 2.5-second timer outstanding, both of which reach back for
the source — which a map changing *style* survives, because the lookup finds the
new one, and a map being **removed** does not. The timer fired a couple of
seconds after the switch already looked finished, into a torn-down `map.style`.

`boot.js` exists for a smaller reason and it is worth stating, because the code
looks like it wants to be one line shorter than it is. The library has to be in
hand before `main.js` is *evaluated*, and the natural way to say that — a
top-level `await` at the head of main.js — does not build: the target is Safari
14, which is the WebKit inside the iOS app, and top-level await arrived in Safari
15. Raising the floor to buy one `await` would drop the app off the phones it was
written for. So boot.js awaits and then imports main.js, which reads
`engineNow()` synchronously and cannot be wrong, because the only path to main.js
runs through that import.

**That await is also why the page starts hidden.** The stylesheet is imported by
main.js, and main.js is behind a map library fetched over the network — so
between first paint and then, the browser drew index.html with no CSS on it at
all: every inline SVG at its natural size, every panel meant to be a dismissed
sheet stacked down the page, white behind all of it. It lasted a fraction of a
second and read as a broken page. `<html class="booting">` and two rules inline
in the head hide the body and paint the stylesheet's own background; boot.js
removes the class after `import('./main.js')` resolves, by which point the
stylesheet is in force, and on the failure path too — a page that cannot load its
map still has to be able to say so. Inline and in the head because it is the one
rule that must be in force before first paint, which is exactly what an external
stylesheet cannot promise; `visibility` rather than `display` so nothing is laid
out twice; and a `<noscript>` override, because a permanently blank window is a
worse answer than an ugly one.

That class is also why the server's iOS rewrite matches `<html lang="en"` rather
than the whole tag. It matched the whole tag, and adding an attribute to
index.html silently stopped it matching anything at all — which shows up as the
iOS chrome sitting under the tab bar and nowhere else.

**Both MapLibre anchors are read before a single layer of ours is added.**
`labelStart()` looks for the bottom of the topmost run of symbol layers, which is
a question about the *basemap* — and `map.getStyle()` answers it about whatever
is on the map at the moment it is asked. The trip track goes on top of the whole
style on purpose, and the topmost of its three layers is a circle, so a scan run
after it stopped at the first layer from the top, found no symbol, and answered
`undefined`. `addLayer` reads that as "the very top", so every saved route was
inserted above the place names: green tracks drawn straight across *BERN*. Both
anchors are now read once at the head of `installGrid`, which runs on every
`style.load` and so is always the current basemap and never anything else. It was
already known one call site down — `PHOTO_BEFORE` names the place pin explicitly
rather than asking — but as a local workaround rather than as the bug it was.

**The visited colour goes in a slot, not before a layer.** On the four MapLibre
basemaps the anchors are layer ids worked out by reading `map.getStyle().layers`
— `washAnchorIn()` for the wash, `labelStart()` for the railways, airports and
photographs. On Standard `getStyle().layers` comes back **empty**, because the
layers are inside the import; there is no id to insert before. Standard answers
this with slots, and it is the better mechanism: `middle` is a promise that a
layer sits above the ground and the roads and below the 3D buildings and every
label, and it survives Mapbox reordering the style underneath it, where a
`beforeId` is a guess that a layer id still means what it meant.

So the two anchors become sentinels and one wrapper on `map.addLayer` translates
them — `installAddLayerSlots`, ten lines, installed only on Mapbox. That is
deliberately not a branch at each of the seventeen `addLayer` call sites in
main.js and the three overlay modules: those all say `map.addLayer(spec, before)`
today and go on saying it. The wrapper copies the spec rather than writing `slot`
into it, because `installGrid` builds some specs once and adds them per level.

**The camera may lean to 85° there, and only there.** The 60° ceiling on the
other four is not a taste — the horizon comes on screen at 71.6° for the field
of view both libraries ship, and a basemap that has not been given a sky draws
its background colour above it. Standard *has* a sky, a haze and a sun that moves
with the light preset, so leaning past the horizon is the view it was made for.
`maxPitch()` is the whole of the difference; `createMap` clamps the camera on the
way back down, so returning to CARTO Dark from an 85° lean lands at 60. What it
costs is at the far edge and `PITCH_REACH` already bounded it: past three screen
heights the visited wash is not painted, so a hard lean shows the basemap running
to its own horizon with no colour on it.

**Terrain is set here, and deferring to Standard's own was a mistake worth
recording.** Standard publishes its own exaggeration:

    ["interpolate", ["linear"], ["zoom"], 6, 0, 7, 1, 12, 1, 13.7, 0]

— relief through the zooms where you are looking at a region, and **faded back to
flat by z13.7**, which is every zoom at which you are looking at a city. That was
briefly left alone, on the theory that Mapbox knew best. In Bern it is the
difference between a town on the side of a gorge and a town printed on a sheet of
paper: the Aare drops forty metres below the Bundesplatz and none of it was
there, and the buildings lost the ground they stand on with it. So `setTerrain`
is called with a flat exaggeration of 1 and Standard's ramp is overridden.

**What that costs is bridges, and there is no way to have both.** Terrain drapes
line layers onto the DEM, so the Kornhausbrücke — modelled elsewhere as a deck
forty metres above the water — sinks to river level and crosses the Aare as a
painted stripe. It is not a setting that was missed: all 45 of Standard's config
options were read looking for an exemption, and its own bridge layers
(`bridge-street`, `bridge-minor-case`, …) carry **no `elevation-reference` at
all** — zero of the 150 layers in the import do, so the `ElevatedStructures`
machinery that exists in GL JS 3.28 is not something this style opts into.
Bridges there are ordinary line layers, and ordinary line layers drape. Checked
both ways over that bridge, twice.

So it is a trade, and the relief is the side worth being on: it is everywhere and
all the time, where the flattened bridge is a handful of spans in a city.
`TERRAIN_EXAGGERATION = 0` takes the other side.

**Which way a drag turns the map** differs between the libraries, and that had to
be settled rather than left. Mapbox turns by the horizontal distance dragged and
nothing else. MapLibre turns the map around its centre like a wheel — grab above
the centre-line and drag right and it goes one way, grab below it and the same
drag goes the other. Both are defensible; having both in one app is not, because
the gesture is muscle memory and it should not change when the basemap does.
`matchMapboxRotation()` replaces MapLibre's move function with Mapbox's own line,
`(currentPoint.x - lastPoint.x) * 0.8`. It reaches inside the library, so it is
read before it is written, the same way `dropLockOnZoom` reaches for
`_watchState`.

### The sun follows the clock, unless it is told not to

The light preset is a choice of five and Standard only has four. **Auto** is the
default, and it means *the sun outside the viewer's own window*: `src/sun.js`
computes where the sun actually is and `lightPreset()` turns that into one of
dawn, day, dusk or night. Everything downstream — `standardConfig()`, the theme
the chrome is painted in, the wash's alpha, a route's contrast lift — goes on
seeing one of the four and never learns that `auto` exists.

**A table of hours would have been wrong for half the year, and wrongest where
this map is used.** Dawn at six and night at nine is right in March and absurd in
June: at 60°N the sun is still up at ten in the evening at midsummer and gone by
four in the afternoon at Christmas. So the sun's elevation is computed properly,
from the low-precision solar position in the Astronomical Almanac — forty lines
of trigonometry, accurate to 0.01° between 1950 and 2050, and no network. Day is
above **+6°**, night below **−6°** (civil twilight, the published one), and the
band between them is dawn or dusk according to the *sign of the hour angle*,
which is the only thing that distinguishes them: they are the same elevation on
opposite sides of noon. `scripts/test/sun.mjs` checks the arithmetic against the
one case that needs no second source — at the solstices the noon elevation is
90° − |latitude ± 23.44°|, on paper, everywhere on Earth — and against Tromsø,
where a rule made of clock hours produces night during the midnight sun.

**The awkward part is that the sun needs a place, and the place arrives late.**
The chrome is painted from `presetTheme()` before the map object exists, and
where the viewer is comes from an IP lookup or a GPS fix one round trip after
that. `sunSite()` answers in three steps, each better than the one under it: what
was stored last time anything knew, then the device's time zone — turned into a
*longitude* (`getTimezoneOffset` is minutes behind UTC, so ÷ 4 is the meridian
where the local clock is solar time) and paired with a latitude of zero. That
last pairing is what makes the fallback honest rather than a guess: at the
equator the arithmetic collapses to light between six and six, every day of the
year, which is exactly the naive answer — arrived at from the same formula, and
replaced the moment a real latitude is known.

**Whose place it is, and why that is the opposite of the snow's.** The site is
where the *viewer* is: a fix, or the IP landing, and never the map's centre. Snow
deliberately goes the other way — it falls where you are looking, because "is it
winter in Patagonia" is a question about Patagonia. The sun here is answering
"what does it look like outside", so panning to Tokyo does not turn the lights
off. Two features, opposite answers, both deliberate.

**When it is re-asked**: on the app opening, when the client's position becomes
known, on `visibilitychange` back to visible — which is what "opening the app"
means on a phone whose tab is never closed — and every ten minutes for a session
left running into the evening. `refreshAutoLight()` reports whether the answer
*moved*, and only a move reaches the renderer; the resolved value is held rather
than recomputed per call so that the dozen readers of `lightPreset()` in one
repaint cannot disagree with each other across a boundary. The row under the
basemap picker says which sun Auto picked, on the same line `detail-now` uses for
the same reason.

**What Standard is told to draw of itself** is `configureStandard()`, from the
list in `standardConfig()`: the light preset, and
`backgroundPointOfInterestLabels: 'none'` — the coloured discs behind every POI
icon are the loudest thing on a map whose subject is the ground under them, and
without them the icons keep their colour and their meaning. Transit labels are
off, because Standard names every tram stop it has and that is "Zytglogge" five
times over one junction.

**`show3dFacades` is on** — the intricate buildings, with modelled windows,
walls, roofs and entrance lights, which Mapbox documents as hidden by default and
says "must be toggled on". **`showLandmarkIcons` is off**, which is Standard's
own default: an icon standing *in front of* a landmark is a worse map than the
building, because it covers the thing with a claim that there is something here
worth seeing and then declines to show it. It also costs a round trip per tile to
`mapbox-landmark-pois-v1`, which answers 404 for this account's token.

**What the facades do not do is change Bern.** They exist in a list of cities —
Munich, Berlin, Stuttgart, San Francisco, New York, Las Vegas, Helsinki, Tokyo,
with more through 2026 — and the bespoke landmark models in a few dozen. A city
Mapbox has not modelled has nothing to switch on, and the switch is still right:
the alternative is finding out in Tokyo that it was there all along.

**The Bundeshaus drew as a plain brown extrusion for a long time, and none of the
above was why.** It was the server's own `script-src`, in `server/index.js` — see
[The landmarks needed a wasm
source](#the-landmarks-needed-a-wasm-source-and-the-bug-only-existed-once-deployed).
Two rounds of fixes went into `standardConfig()` first, because a missing
building looks exactly like a config property nobody set, and the second of them
switched the landmark icons on as a substitute for the models. Both were wrong,
and the shape of the mistake is worth more than the fix: **a feature that draws
nothing has a renderer between it and the screen, and the renderer runs inside
somebody's policy.** Ask what the deployed page is allowed to do before
re-reading what the style was asked to draw.

**`show3dLandmarks` follows the zoom, and is a plain boolean.** Standard
publishes `building-models` at minzoom **14** and every other building layer —
`3d-building`, `2d-building`, `procedural-buildings`, `building-underground` — at
**15**. In that one-zoom band the modelled landmarks stand on a city with no
buildings in it: a parliament and a cathedral floating over a bare street plan,
which reads as something half-loaded. Zooming in then brings the rest of the city
up *around* models that were already there, which is backwards — the landmark is
what you should arrive at last.

The layer's own minzoom cannot be moved from outside the import:
`setLayerZoomRange` resolves against the style's own layers and returns without a
word for an imported one, under the plain id or any scoped spelling of it. So
`gateLandmarks()` sets the config property again from a `zoom` handler, on a
crossing only, and `configureStandard()` sends the value for the zoom in force
every time a style parses.

**The version of this that does not work is an expression in the config value.**
`["step", ["zoom"], false, 15, true]` is accepted by `setConfigProperty` and
reads back intact from `getConfigProperty`, and it is inert: Standard gates the
layer through `layout.visibility`, which is resolved when the style is evaluated
and *not* re-resolved as the camera moves. The value is read once, at whatever
zoom the page loaded at, and frozen — so opening the map at z10 hides the
landmarks at every zoom thereafter. It fails as a plain extrusion with nothing in
the console, which is indistinguishable from the CSP bug it was written on top
of, and it survived being "verified" by flipping it at one zoom and looking.

**Nothing here reports a name it does not recognise.**
`Style.setConfigProperty` looks the key up in the style's own schema and returns
without a word if it is absent, so a renamed property and a misspelled one are
both invisible — the same plain extrusion, and an empty console. That is why
each property is set in its own `try` rather than the six sharing one (a
throw on one must not cost the map its sun), why the names are written exactly
as the Standard reference writes them, and why `scripts/test/mapbox.mjs` checks
that every one of them actually reaches the map. The schema itself cannot be
checked from a test: it arrives with the style, which needs a token and a
network.

### The landmarks needed a wasm source, and the bug only existed once deployed

Mapbox GL JS decodes the batched meshes behind `mapbox-3dbuildings-v1` — the
modelled station roofs, churches and parliaments — in **WebAssembly**. The
server's policy was `script-src 'self' blob:`, which has no wasm source, and
Chrome refuses `WebAssembly.instantiate` under it outright.

**What that looks like is nothing.** The style parses, the tiles are fetched, the
layer stays `visible`, no error reaches the page, and every landmark falls back to
the plain extrusion — which is a perfectly good building. The one visible symptom
is a building that is less interesting than it should be, in a city you may not
know well enough to say so.

**And it is invisible in development.** Vite's dev server sends no CSP, so
`localhost:5173` renders the models correctly and the bug does not exist until
`npm run build && npm start` puts `server/index.js` in front of them. Two rounds
of fixes went into `src/mapbox.js` on the strength of a map that was wrong only
in production and right on the machine it was being fixed on.

The policy now carries `'wasm-unsafe-eval'`. Despite the name it is far narrower
than `'unsafe-eval'`: it permits compiling WebAssembly and nothing else, so
`eval()` and `new Function` stay refused and an injected string still cannot
become running JavaScript — which is the whole reason `script-src` is tight here.
A browser too old to know the token ignores it and gets plain extrusions, the
same map it drew before.

`scripts/test/csp.mjs` checks the header on a real response from a real server:
that wasm is allowed, that `'unsafe-eval'` and `'unsafe-inline'` are still *not*
(the line the narrower token exists to stay behind), and that the rest of the
policy survived — so "add a source" cannot quietly become "replace the policy".
It checks a static file as well as the page, because `sendStatic` serves both.

### The train tracks on Mapbox, which took three shims

The railway overlay is 288 layers of somebody else's MapLibre style, and every
one of the three things it leans on is a MapLibre feature Mapbox has never had.
All three shims are in `src/gl-engine.js`, so `src/rail.js` is untouched.

- **Multiple sprites.** `map.addSprite(id, url)` fetches one atlas on demand and
  names its images `spriteId:name`; the overlay uses four, and only downloads the
  ones a switched-on group reads from — 2.25 MB that must not arrive for a layer
  nobody asked for. A Mapbox style has one sprite, declared up front, and
  `map.getSprite` is not a function, which is where `installRail` threw. The shim
  fetches the atlas and its JSON, cuts each icon out with a canvas, and hands the
  pieces to `addImage` under the keys the style already asks for. Two details it
  is worth having got wrong once: the atlases are behind this app's session
  cookie, so `credentials: 'omit'` gets a 401 and the icons silently never
  arrive; and `sdf` has to be carried through, or every icon draws flat black.
- **Global style state.** The style consults `["global-state", …]` **1,529
  times** — it is how one stylesheet draws a light railway and a dark one, and
  how a group is switched off without touching a layer. Mapbox cannot parse the
  expression, so the shim resolves it to the value it would have had as each
  layer is added, and remembers the layer as written so a later state change can
  resolve it again. That is the real cost: MapLibre re-evaluates one property
  where this walks every layer that mentions the key. Right for a group switched
  once in a while, wrong for anything that changed per frame.
- **`Style.addLayer` directly.** `addLayers()` in rail.js reaches past
  `Map.addLayer` to add 288 layers without validating each one, which is a
  visible wait either way it goes. On Mapbox that also reaches past the two
  wrappers above, so the layers arrive before an anchor that does not exist,
  reading an expression Mapbox cannot parse. Hence `fastAdd`, false on 3D.

### Being lit by a map, and refusing to be

Mapbox GL JS lights the whole scene from the style, and at dusk and night that
light is dim and blue. **Every layer type this app draws with is lit by
default** — `line`, `fill`, `circle` and `raster` all ship
`*-emissive-strength: 0`, meaning "take the scene's light". So the visited wash,
the routes and all 288 layers of the railway overlay were being *dimmed by the
sun going down*: correct for a road, which is a thing lying in the world, and
wrong for an annotation drawn on top of one.

Mapbox's own labels never had the problem, and the reason is the answer:
`icon-emissive-strength` and `text-emissive-strength` default to **1**, which is
the style spec admitting out loud that some things are drawn on a map rather
than lying in it. Ours say the same. `selfLit()` in `src/gl-engine.js` injects
the right property for the layer's type inside the same `addLayer` wrapper that
translates the slots — done there rather than written into twenty layer
definitions because it is a fact about the renderer, not about any of them, and
because it has to reach the railway overlay's layers too, which are somebody
else's style and not ours to annotate. A layer that sets its own is left alone.

**The colour lift is what is left over.** `vivid()` — saturation and lightness,
in HSL, because that is the pair of words the problem is stated in — was
originally the whole answer, and it was treating a symptom. Emissive strength
fixes the lighting; it does not touch the **fog**, which GL JS still applies to
everything in the scene, so a route a few hundred metres out at a lean is mixed
toward the haze whatever its emissive strength. That is all the `lift` on the
STYLES entry now does, and it is much gentler for it: `[1.15, 0.02]` by day,
`[1.2, 0.05]` after dark. Only the 3D entry has one.

**A glow joins its corners differently from the line it is a glow of.** Every
other line on the map takes `lineLayout`, which is `round`/`round`; the two glows
— `route-glow` and `trip-glow` — take `glowLayout`, which is the same with
`line-join: bevel`. A round join fills the outside of a corner with a fan of
triangles that overlap each other and the two segments meeting there. On an
opaque stroke that is invisible. On a translucent one every overlap composites
twice, and the glow is the same line up to six times as wide, so the overlap is
six times as large. A bevel is one triangle and overlaps nothing, so the corner
is chamfered instead. Only the glows: the line itself is a tenth as wide and
nearly opaque, and wants its corners round.

### The spikes, which were never the corners

That change was made against a row of hard-edged arrowheads sticking out of every
bend of a route, in a colour neither the glow nor the line has, and it did not fix
them. The corner was the wrong suspect. What follows is what it actually was,
worked out by drawing a synthetic track with a known amount of noise on it and
looking, rather than by reading the line bucket again.

**The centreline is noisy, and the glow was a thread rather than a band.** Both
libraries fade a blurred line from full strength at its centre to nothing at its
outer edge over exactly `line-blur` pixels. The blur was a *count of pixels* — 4
on the flat basemaps, 9 on Standard — against a width that runs from 5 px to
35 px depending on the zoom, the basemap, and whether the route is the one you
have open. Nine pixels of falloff on a glow twenty pixels wide leaves **one
pixel** of it at full strength: not a band with a soft edge, which is what a glow
is, but a bright thread with a gradient hung off it. A recorded track wobbles by
a couple of pixels at anything below street zoom, so the thread wobbled with it
and crossed itself, and every crossing composited twice. That is the shape the
spikes had, and it is why no `line-join` touched them — the overlap is between
whole *segments*, not at the corner between two. `bevel` and `round` were both
tried against it and both drew the same shredded ribbon.

At the other end the same count was larger than the glow it was blurring: 9 px of
falloff on a glow 5.4 px wide at country zoom, which is a halo drawn at a third of
the opacity it was given, fading out before it ever reached full strength. Nobody
had noticed, because the failure of a glow is that you cannot see it.

So the blur is a **fraction of the glow's own width** (`ROUTE_GLOW_EDGE`, 0.3),
carried on the same zoom ramp the width is — so it follows the zoom, the hover and
the selection, and the glow always keeps a body: the middle 40% solid, 30% of
gradient either side. The two basemaps still differ in how *wide* the glow is,
which is where that difference belongs; its softness now scales with it instead of
being stated twice.

**And the track is simplified per zoom** (`ROUTE_SIMPLIFY_PX`, 2 px). A GeoJSON
source takes a `tolerance` in **screen pixels** — `_pixelsToTileUnits` in
MapLibre, `EXTENT / tileSize` in Mapbox GL JS, both landing on geojson-vt — and
applies it at every zoom, so detail finer than two pixels is dropped and zooming
in brings the real shape back untouched. The default is 0.375 px, which is right
for a drawn polygon and far too fine for a walked one: a fix every second with
three metres of noise on it is a vertex per pixel at valley zoom, and half of them
double back.

It goes on the **source** rather than on the glow, so the crisp line and its halo
are drawn from one geometry — a glow simplified on its own would leave the line
wandering outside its own halo at every switchback. Two pixels because the core
line is 2–3.4 px wide: smoothing by less than the line is thick cannot be seen,
and there is nothing finer than that worth calling detail. The other sources here
set `tolerance: 0` for the opposite reason — a hexagon, a house and a trip's dots
are exact, and the `trip` source feeds a circle layer as well, where dropping a
vertex would delete a day.

**And the glow is the hover state.** `setHoveredRoute` writes one feature state,
`hov`, and both of the glow's paint expressions already branch on it —
`routeGlowOpacity` three-quarters of the way from its resting alpha to the
selected one, `routeWidth` by `ROUTE_HOVER_SCALE`. Both carry a
`ROUTE_HOVER_MS` transition, which is the whole of the animation: nothing here
steps a value or holds a timer. Short of the selected strength on purpose, since
a hover that looked like a selection would be answering the question before it
was asked, and only the glow moves — a core line that thickened as well would be
the route shifting rather than lighting up, and at a hairline the two read
completely differently.

The hit test is free. `routeAt(e.point)` was already being run on every mousemove
to decide whether the cursor is a pointer, so this is the same answer said in the
picture instead of on the pointer — the trade the railway hover makes, one line
up. What it costs instead is the bookkeeping: feature state does not survive
`setData`, so `syncRoutes` re-applies it, and the mousemove only asks in view
mode with the map still, so `setMode` and `mouseleave` have to clear it or a lit
route stays lit with nothing under it.

**Two things a route needs that only this basemap can give it.** Its glow is
wider and softer here — `ROUTE_GLOW_SCALE_3D`, `ROUTE_GLOW_BLUR_3D` — because
Standard puts the line in a lit scene with texture and shadow under it, and the
halo that reads as *drawn on* a flat basemap disappears into that one. And a route behind a
building is dimmed rather than gone — which took two goes and a line of the
style spec.

`line-occlusion-opacity` is Mapbox's property for it: the opacity of the part of
a line that is behind something. Setting it on the two route layers did nothing
at all, and the reason is one sentence in the spec — *"not supported when
`line-opacity` has data-driven styling"*. Both have exactly that:
`routeLineOpacity()` scales by the activity's own alpha, and the glow's asks
whether the route is the selected one. The property was accepted, read back
correctly, and silently ignored.

So there is a **third route layer on this basemap only**, `route-ghost`: the same
geometry and the same per-activity colour — colour may be data-driven, only
opacity may not — at a flat 0.45, with `line-occlusion-opacity: 1` so the part
behind a building draws at the same strength as the part in front. It sits under
both real layers, so on open ground they cover it entirely and it is invisible as
anything of its own; behind a block it is all that is left. Deliberately faint: a
route drawn through a city at full strength puts the walk in front of the
buildings and throws away the depth that makes this basemap worth having.

It is not among `ROUTE_LAYERS`, which is what a click is tested against — the
ghost is the part of a route you can see *through a wall*, and a click that
landed on the wall should be about the wall.

One trap, and it cost a round of "why is nothing changing": `syncAccent()`
returns early when the accent hex has not changed, which is exactly what happens
when only the sun moved. Everything *derived* from the accent has changed, so
`setLightPresetNow` repaints by hand rather than trusting it.

Three smaller things Standard's opacity costs:

- **The fontstack is named, not discovered.** `styleFont()` reads `text-font` off
  the style's layers, and there are none. `MAPBOX_FONT` is what every published
  Mapbox style asks for, and their glyph server is the one being asked.
- **Its continent labels cannot be switched off.** At the continent level ours
  carry the name and the count both, and on the other four basemaps the
  basemap's own are hidden. Here they are inside the import and cannot be
  addressed, so both are drawn; ours win where they actually overlap.
- **`projection: 'mercator'` is now stated on the map.** Mapbox GL JS v3 draws a
  globe below about z6 unless told otherwise, and everything this app puts on the
  map is built for a rectangle of Mercator metres — `groundBox` is closed-form
  Mercator arithmetic and the blob sheet is a canvas pinned to four lng/lat
  corners. MapLibre defaults to Mercator and takes the same option, so it is said
  once for both.

**A group of photographs opened empty here, and the two libraries disagreeing
quietly is why.** `photoLeaves` asks the clustered source for everything inside a
group. MapLibre answers with a promise — `getClusterLeaves(id, limit, offset)` —
and Mapbox GL JS takes a **fourth argument and calls it back**, returning the
source itself. So `await source.getClusterLeaves(…)` handed back a
`GeoJSONSource`, `.map` was not a function, the function's own catch swallowed it
and every cluster on the 3D basemap opened a card with nothing in it — which from
the outside is a tap that did not land. Single photographs were unaffected,
because they never go through that call, and that is what made it look like a
hit-testing problem rather than an API one.

It is asked both ways at once now: the callback is passed *and* the return value
is checked for a `then`. MapLibre ignores the extra argument, Mapbox ignores the
promise nobody reads, and whichever settles first wins. The test in
`scripts/test/photos.mjs` mocks both shapes, because a mock of one of them is
what let this ship.

**The class-name prefix**, answered in two places. The libraries build identical
control DOM and name it differently, `.maplibregl-ctrl-geolocate` against
`.mapboxgl-ctrl-geolocate`. *Styling* is `style.css`, where every one of those
selectors now names both prefixes through an `:is()` pair — no runtime cost, and
it cannot drift because there is still one copy of each rule. *Reading and
writing* is `ctrlClass()`, because main.js reaches for the geolocate button by
class in five places: MapLibre publishes its three-state toggle nowhere else, so
the state is read off the element and, in `dropLockOnZoom`, written back to it.

Mirroring the names onto the element with a `MutationObserver` was tried first
and is worse in two ways that both bite. A `querySelector` running in the same
tick as `addControl` — which is every one of those five — would not see a mirror
delivered as a microtask. And `dropLockOnZoom` *removes* a state class, which a
mirror puts straight back, because the library's own copy of it is still there.
One library is live per page, so the prefix is simply a lookup.

**Except for the one moment a basemap switch is made of**, and that moment is
where the prefix was read. `switchEngine` loads the incoming library *first*, so
a failed download leaves the map on screen alone — and `loadEngine` sets the
module's `loaded` as it resolves. From there until the new map is built,
`ctrlClass()` names the library that is arriving while every control in the DOM
still belongs to the one that is leaving, and any selector built from it matches
nothing at all.

`geolocateState()` is the only call inside that window, because reading the
outgoing control's state is the whole point of being there — and it read under
one prefix, matched nothing, and answered "off". `restoreGeolocate('off')`
returns immediately, so the fix below shipped and the blue dot went on
disappearing exactly as it had before. Reading now names both prefixes
(`ctrlClasses`, `ctrlSelector`, `hasCtrlClass`); *writing* still goes through
`ctrlClass`, because a class written under the wrong name is one the library
never looks at, which fails silently in the other direction. Pinned by
`scripts/test/mapbox.mjs`.

That was half of it. Which classes the button carries in each state was the other
half, and wrong in the same function — see *What a basemap switch takes with it*,
where `geolocateStateOf` now lives with the table it inverts.

**The token is the viewer's own, and it follows their account.** A **secret**
token (`sk.`) is refused by name: Mapbox will serve tiles with it, which is
exactly why it is worth catching, and GL JS's own refusal is an exception thrown
deep inside a URL builder mid-render, far too late to tell anyone which box was
wrong. The dialog also asks Mapbox whether a token works, because a token can be
wrong in four ways — mistyped, expired, scoped without `styles:read`, or
URL-restricted to somebody else's domain — that all look identical from the map.

It lived in localStorage under `visited-map:mapbox-token:v1` and nowhere else for
as long as the basemap has existed, on the argument that a credential belonging
to somebody else's account should never touch our server — a promise the dialog
made out loud. **That was the wrong trade for the only person it affects.** It
meant pasting the same token again on the phone, again on the laptop, and again
after every cache clear, to switch on a basemap they had already signed up for.
It is a preference like any other now, and the price is worth stating: it sits in
the `user_prefs` row in plain text and rides along in every backup file. For a
**public** token that is fair — `pk.` is designed to sit in a web page, it is
already in the query string of every tile the browser fetches, and anyone who can
read that database can read the map it draws. It is also why refusing `sk.`
matters more than it did.

localStorage stays, as the device's copy rather than the only one, and two things
need it: `boot.js` picks a map library from `hasMapboxToken()` synchronously,
long before `/api/prefs` has answered anything, and the basemap has to keep
working offline. **Logging out clears it**, which is the one part that is not
tidiness — the token is billed to the account that just left, and leaving it
behind would hand the next person to sign in on that browser somebody else's
meter.

**The dialog commits on Done and nowhere else.** There used to be a Save beside
the field, a Remove next to it and a Done underneath, which is three buttons for
one intention with nothing to say which was the real one. Done now asks Mapbox
and *either* closes onto the 3D map or stays open saying what was wrong — the
box still holding what was typed, which is the only state in which a complaint is
worth printing. Cancel leaves with nothing changed, and emptying the box and
pressing Done is what Remove was. An answer that arrives after the dialog was
dismissed is dropped rather than switching the basemap under somebody who left.

**And caching was considered and dropped.** It would buy nothing: GL JS is billed
per map load, and a map load includes unlimited tile requests, so a tile cache
would optimise the one thing that is not metered. On the MapLibre path it would
have helped — that is billed per tile — but Mapbox already sends
`Cache-Control: max-age=43200` on vector tiles, which is twelve hours of it for
free. A server-side cache like `server/rail-tiles.js` was not extended here
either: that file's whole justification is that OpenRailwayMap is a volunteer
service which caching *helps*, and Mapbox is a commercial vendor metering exactly
that.

### Snow, which is the only thing here that is not information

`src/snow.js`. Everything else the app draws answers a question — where you have
been, how often, what that ground is called. This answers none, which is why the
control is under a heading that says **Easter eggs** rather than sitting among
the preferences: a switch for weather on a map with no weather in it needs to
admit what it is, or it reads as a feature that is broken.

**It is Mapbox's, so it is the 3D basemap's alone.** `setSnow` renders inside the
same 3D scene as the terrain and the buildings. MapLibre has no equivalent and
cannot be given one from out here — precipitation is a renderer pass, not a layer
you can add — so the other four basemaps never snow whatever the setting says.
The Settings row is left working rather than disabled, and its subtitle says
which of the two situations you are in, because a control that demonstrably does
nothing is indistinguishable from one that is failing.

**Whose winter it is, is the interesting decision.** The obvious reading of "only
during winter" is the viewer's — their clock, their home. The better one is the
*subject's*: looking at Patagonia in July, it is winter there, and snowing on it
is the version of this that knows something. It also degrades better, since a map
centred on the equator has no winter to be in and no fact about the viewer would
have told you that. So the hemisphere comes from `map.getCenter().lat`, and the
answer is re-asked on `moveend`.

The months are meteorological — Dec–Feb north, Jun–Aug south — rather than
astronomical. A solstice-to-equinox winter would begin three weeks into December
and end in the third week of March, and nobody thinks of the year that way; whole
months are the version somebody can predict.

**The renderer validates before it applies, and that made the whole feature
nothing.** `direction` was written `[-40, 55]`, which is the bearing the snow
should blow along and the one way the style spec forbids writing it: its minimum
is 0. `Snow.set` runs the spec validator first and *returns* if there are errors,
so not one of the settings below it ever reached the renderer — no snow, on any
basemap, in any month, at any zoom. It fires an error on the map rather than
throwing, so the guard in `applySnow` had nothing to catch and went on reporting
snow as on. It is `[320, 55]` now, which is the same bearing.

The test that would have caught it is the one that was missing: everything in
`scripts/test/snow.mjs` was this app's opinion of its own constants. It now
validates `snowSpec()` against **Mapbox's own style spec**, out of the installed
package, so the next constant nudged past a limit fails there rather than on a
phone in December. Restating the vendor's limits in our own assertions would
have been the same mistake in a new place.

**Two things are guarded and both are real.** `refreshSnow` in `src/main.js`
compares against the last answer before touching the map, because `setSnow`
rebuilds the particle system — calling it on every `moveend` restarts the fall
from an empty sky, so the snow visibly begins again after every pan. And
`applySnow` swallows everything: a MapLibre map has no such method, a style that
has not parsed throws from inside it, and the whole feature is marked
experimental in Mapbox's own type definitions, which is them reserving the right
to rename these properties in a minor version. The failure mode is *no snow*,
silently. It is never a broken basemap.

There is a zoom ramp on the density, and it is a truthfulness decision rather
than a performance one: at z3 the frame holds a third of a hemisphere, and snow
across it is snow claimed for four climate zones at once. It fades in from
`SNOW_MIN_ZOOM`, roughly where the map has stopped showing everywhere and started
showing somewhere.

The setting rides in the account's preferences beside the clock, by the same
argument that put the clock there: an easter egg you went and found is a thing
you decided, not a fact about the laptop you decided it at.

## What a basemap switch takes with it

**"My location" is put back when the map itself is replaced.** Crossing between
the two map libraries replaces the map object, and a control belongs to the map
that made its element — its user-location markers are created in `_finishSetupUI`
and die with it. So the new control came up in its OFF state with the blue dot
simply gone, looking exactly as it does before you have ever pressed it, and the
only way to find out was to press it again. Where you are is not a fact about
which library is drawing the ground.

Two things make `restoreGeolocate` more than one line. The control sets itself up
behind an async permissions check and `trigger()` before that is a no-op — but it
*returns false*, so asking until it takes needs no private state and stops on its
own. And a plain re-trigger would fly the camera to you, which is right if you
were locked on and wrong if you had panned away: `dropToBackground` is applied
before the first fix arrives, and the control only moves the camera while
`ACTIVE_LOCK`.

**It then went on not working, twice, for reasons one line above it.** Both were
in `geolocateState()` — the call that reads the outgoing button — and neither was
in the restore, which is why the restore survived being read carefully twice.

*First*, the state is read while the incoming library has already been loaded and
the outgoing map is still on screen, the one window in which the class-name
prefix names the wrong library. See *The class-name prefix* above: the answer was
always "off", and "off" is the one value `restoreGeolocate` does nothing with.

*Second, and the one that outlived the fix for the first:* **`background` is not
a kind of `active`.** Both libraries keep the same table of state to class —

    OFF               (no classes)      ACTIVE_ERROR      waiting, active-error
    WAITING_ACTIVE    waiting, active   BACKGROUND        background
    ACTIVE_LOCK       active            BACKGROUND_ERROR  waiting, background-error

— and the reading was written as "not `active`, so off; `active` and
`background`, so background", which describes a control that adds `background` on
top of `active`. Neither does: both *remove* `active` on the way in
(`_onMoveStart` in MapLibre, the state table in Mapbox GL JS). So a control
sitting in BACKGROUND — tracking you perfectly well, just not holding the camera
— read as one that had never been switched on.

That made it the only state that mattered. BACKGROUND is where you land the
moment you pan or zoom away from yourself, and `dropLockOnZoom` puts you there
deliberately on any zoom gesture, so the dot survived a switch only for someone
who pressed the button and then touched nothing at all. The reading now lives in
`geolocateStateOf` in `src/gl-engine.js`, next to the table it inverts, and
`scripts/test/mapbox.mjs` pins all six states under both libraries' prefixes —
because this has now been the same bug twice and both times it read as nothing
happening.

`setStyle` replaces the whole style, and everything the app added goes with it —
sources, layers and images alike. `installGrid` rebuilds all of it on
`style.load`, and anything the page was already *showing* has to be put back by
hand, because the source it lived in is now a new and empty one. The trip
highlight and the searched-place pin are restored there; the chip naming the
highlight never went away, and a chip that says "Showing Arth" over an empty map
is worse than no chip at all. This is why `shownTrack` keeps the points and not
just the label.

**A second `setStyle` waits for the first to *parse*, and nothing more.**
`map.isStyleLoaded()` looks like the right question and is not: it is
`Style.loaded()`, which also requires every tile manager to have finished and the
image manager to be loaded, so it stays false for as long as any tile is in
flight. The code then waited on `map.once('style.load')` — an event that only
fires when a style loads, which is precisely the thing it was gating. A basemap
switch could sit unapplied for ten seconds and then land on whichever key had
been chosen *first*, because the pending promise finally resolved on somebody
else's style load. `styleParsed` answers the question that was actually being
asked, and `swapStyle` is the only place it is cleared.

**The palette's blur needed the overlay to stop filtering.** `.search-overlay`
carried `backdrop-filter: blur(2px)`, and an element with a backdrop-filter
becomes a *backdrop root* — so everything inside it can only filter what is
painted within, and all the card had behind it was a flat scrim. Blurring a flat
colour looks exactly like not blurring it, which is why the palette read as glass
with a sharp map behind it while the menu blurred properly. The scrim stays; the
filter is gone. `.modal-overlay` and `.auth-overlay` have the same arrangement
and are left alone: their 10px blurs the *whole* background on purpose, and
their cards' own filters are merely redundant.

The train tracks failed differently and more quietly. `addRailLayer` asked
"does a source called `rail` exist" and returned having added nothing — but
CARTO's styles ship a layer of their own called `rail`, so on Light and Dark the
question was being answered about somebody else's layer. Ours was namespaced
(`hexplore-rail` then, `hexplore-orm-…` since the vector rebuild below), and the
guard asks for our own layer by our own id. The general rule: a basemap is
somebody else's style and its ids are theirs to choose.

**Where the overlay sits** was the second half of that. It anchored to
`tile-fill`, which put it under the visited wash *and* under the basemap's own
`rail` — so the overlay whose whole reason for existing is that it draws the
sidings, yards and freight-only lines a basemap leaves out was rendering
underneath the less detailed answer. `RAIL_BEFORE` now returns `route-glow` if
the routes are there and `labelStart()` otherwise, which is the anchor a saved
route already uses: the overlay lands in the same place they do and directly
beneath them, since a line you actually travelled beats reference geometry about
where a line exists. Both draw over the basemap's own labels, which on CARTO all
fall below that point.

## The train tracks, in vector

The tiles used to be **raster** (`standard/{z}/{x}/{y}.png`), which is why the
overlay was all-or-nothing: the level crossings, the kilometre posts and the
switch numbers were pixels by the time they arrived, and nothing on this side
could filter them, recolour them, or say what one of them was. Since 2024
OpenRailwayMap has published the same content as vector tiles at
`openrailwaymap.app`, and the overlay is built from those now. Three things
follow that a raster layer could not have: the parts can be switched off
separately, the railways recolour with the basemap, and a tap on a siding can
say what it is.

What it costs is **carrying our own style rather than one URL**, and that turns
out to be the whole of the work. Their published style is 464 layers describing
a complete map — background, hillshade, OpenHistoricalMap geometry and all — and
288 of them are the railways. `scripts/build-rail-style.mjs` takes those out and
emits `src/rail-style.json`, because four of the style's assumptions stop being
true the moment its layers live in somebody else's:

**Its fonts.** The style asks for `OpenRailwayMap-Regular`, `-Bold`, `-Italic`
and `FiraCode-Bold` from its own glyph server. A MapLibre style has exactly one
`glyphs` URL and the basemap owns it, so those stacks would 404 and every label
would silently not draw — the same failure `styleFont()` already existed to
avoid. Every fontstack collapses to a token the client swaps for whatever
upright stack the basemap serves; bold and italic are lost with nowhere to get
them from. The half of this that is easy to miss is inside `text-field`: a
`format` expression takes per-section options, and three of their station-label
layers set `{"text-font": …}` on a section to give the second line its own face.
A section override survives a layer-level rewrite untouched, so it is deleted
rather than rewritten — a section without one inherits the layer's.

**Its sprites.** Images resolve as `spriteId:name`, *except* for the sprite whose
id is `default`, whose names are bare (`"default"===t?o:`${t}:${o}`` in
MapLibre's own image manager) — and a basemap's string-form sprite is already
that one. ORM's cannot be added under the same id, so both get a namespace and
every image reference is rewritten to match. Nine distinct shapes carry those
references, eight of them prefixed `sdf:` and one bare
(`["image",["get","feature"]]`), which cannot be spotted from a literal because
it has none. It is handled by its shape instead: an `image` operator whose
argument contributes no prefix is reading the default sprite.

**Its ids.** A basemap is somebody else's style and its layer ids are theirs to
choose. Sources and layers alike carry `hexplore-orm-`, for the same reason
`hexplore-rail` did.

**Its tile URLs.** Rewritten to the caching proxy below.

**The build is reproducible**: no timestamp, a hash of the upstream style
instead, so rebuilding an unchanged upstream reproduces the file byte for byte.
It is a lazily-imported chunk — 315 KB, 12 KB gzipped — so a session that never
switches the overlay on never pays for it.

### Both the sprites and the tiles must be absolute URLs

The built style stores paths — `/api/rail/sprite/symbols`, `/api/rail/tile/…` —
because the origin is not a thing a build can know. `railUrl()` turns them into
URLs at install, and skipping that fails in two different ways, neither of which
looks like what it is.

**A relative sprite URL blanks the whole map.** MapLibre refuses it ("must be
absolute") and refuses it by *firing an error rather than throwing*, so the
overlay installs completely: every source added, all 288 layers added, every
check green. But a sprite that never resolves leaves the image manager
permanently unready, and the renderer will not draw a frame until it is — so the
basemap goes too. The symptom is an empty dark rectangle with a working
attribution bar, and nothing in the code path admits to a failure.

**A relative tile template fails somewhere much quieter.** MapLibre builds the
tile `Request` inside a *web worker*, and a worker has no document to resolve a
relative URL against, so each one dies with "Failed to construct 'Request':
Failed to parse URL" — off the main thread, where the page's own error handling
never sees it. Meanwhile `transformRequest` still fires on the main thread and
the source still reports itself loaded, so every signal short of the console
says the overlay is working while not one tile is fetched.

**And the obvious fix has a trap of its own.** `new URL(path, origin)`
normalises, and normalising a tile template percent-encodes the placeholders
into `%7Bz%7D/%7Bx%7D/%7By%7D` — which MapLibre can no longer substitute, so
every tile is requested with the braces still in the path and every one of them
404s. `railUrl()` is deliberately string concatenation, and the test asserts both
that the result is absolute and that `{z}/{x}/{y}` survives it.

### Zoom ranges are worked out, not asked for

This was the single worst thing the first version did, and it is worth spelling
out because the mistake is an easy one to make again.

Their sources are declared in the style as TileJSON URLs, so the obvious thing
is to let MapLibre fetch them and learn each source's zoom range from the
authority. That endpoint is one of the flakiest things they serve, and the
fallback for when it fails — assume z0–20 — turned every one of their bad
afternoons into a flood of our own making: a source with data at z4–7 was then
requested at z14, where it can only answer with an error, for all six sources at
every zoom, on every pan. The overlay was generating far more failed requests
than it had any business generating, and every one of them was blamed on them.

**The style already knows.** Every layer carries the zooms it draws at, so the
union over a source's layers *is* that source's range, and a source with any
layer that has no `maxzoom` is open-ended. Against the three TileJSON documents
of theirs that were reachable this reproduces them exactly —
`…text_stations_low` z4–7, `…_med` z7–8, the standard composite from z8 — and it
costs no request, cannot go stale differently from the layers it is derived
from, and works while they are down. `rail-style.json` now carries a `tiles`
template and a zoom range per source, there is no TileJSON fetch at runtime at
all, and at a typical z12 view two sources are in range rather than six.

The upper bound for an open-ended source is `SOURCE_MAX_ZOOM`, which is
OpenRailwayMap's own `globalMaxZoom` of 20 rather than this map's 17.5. MapLibre
never asks above the zoom being displayed, so the larger number costs nothing
and stays correct if the map's own cap is ever raised.

### What survives is the part worth having

Their zoom ramps, their colour ramps, their filters, and — the useful surprise —
their **`global-state` switches**, which the style consults 1,529 times for its
own configuration. `theme` alone accounts for 748 of those, so handing it the
basemap's light or dark makes the railways recolour with the map under them
rather than sitting on it. `showConstructionInfrastructure`,
`showProposedInfrastructure`, `showAbandonedInfrastructure` and
`showRazedInfrastructure` are theirs too, and are configuration we get for free
rather than visibility hacks of our own.

A grafted layer has no stylesheet `state` block to read defaults from and an
unset key evaluates to null, so all fourteen defaults are set on the map at
install. For the 748 that consult `theme`, forgetting that is the difference
between railways and nothing at all.

The six **groups** — line numbers, tracks, stations, signals and crossings,
platforms, kilometre posts — are ours, assigned per source layer in `GROUPS` at
the top of the build script. The build fails rather than ships if upstream grows
a source layer that none of them claims: content with no way to switch it off is
exactly what this overlay was rebuilt to avoid. Switching a group off sets
`visibility` rather than removing layers, so switching it back on costs nothing
and cannot reorder the stack.

Three of them are **off to begin with**, which an absent key did not used to
mean. `RAIL_GROUP_DEFAULTS` in src/rail.js is the list. The overlay draws six
kinds of thing over a map that already has a map on it, and three of them are for
reading a railway rather than seeing where one is: the line-number shields are
the densest labels anything here puts on the screen, the kilometre posts are a
number every few hundred metres, and the signals are both dense and the only
reason the 1.5 MB full-colour sprite atlas is ever fetched. Switching the overlay
on for the first time should show where the tracks are.

### The stations are labelled in English

Their tiles carry two names for a station: `name`, which is what is written on
the platform, and `localized_name`, the name in a language you have to ask for.
Without asking, `localized_name` is simply absent — so their style, which reads
it, labelled a Tokyo suburban line in Japanese and a Greek branch in Greek, on
top of a basemap that had already labelled both in English.

The ask is `?lang=` on the tile, added upstream by the proxy (`TILE_LANG` in
`server/rail-tiles.js`). Being a query parameter it is part of *what a cached
entry is*, so it is in the cache key too: without that, changing it would go on
serving what was fetched under the old one until the last of it aged out. It is
one value for the whole map rather than something read off the browser, because
a cache multiplied by however many languages happened to visit is not a cache.

**The language is also in the URL the browser asks for, and that is not
redundant.** The proxy decides the language, keys its own cache on it and
ignores the parameter completely — `/api/rail/detail` reports the value and
`installRail` stamps it straight back onto the tile templates. It is there for
the *browser's* HTTP cache, which is keyed on the URL and is the one cache
nothing here can reach: the service worker deliberately passes `/api/rail/`
through to the network, `clearOfflineCaches` can only empty the Cache Storage
API, and a hard reload does not cover the tiles MapLibre's worker fetches on the
next pan. A rail tile is served a `max-age` of about a day — upstream sends
`max-age=86400` and `ttlFrom` honours it, so the seven-day `TILE_TTL_MS` is only
the fallback for an answer carrying no `Cache-Control` at all — and for that day
every tile anyone had already looked at went on being drawn in the old language,
on every device, with nothing in the app able to hurry it. Changing the URL
retires those entries instead of waiting them out.

This was left out at first, on the reasoning that the client would then hold a
second copy of a value whose only job is to invalidate a cache, and that a copy
which had drifted would fail silently at exactly that job. The reasoning was
sound and the conclusion was wrong: there is no second copy, because the value
travels with the detail ceiling from the server that owns it, and the thing
being avoided — a stale cache nobody can clear — turned out to be the failure
that actually happened.

**This change is server-side only, so the API process has to be restarted for it
to take effect at all** — a front end reloaded against an API still running the
old code shows every other change and none of this one, which is a confusing
thing to debug from the map.

**Asking is only half of it — the style has to be told to read the answer.**
Their layers use two different name properties either side of z10:
`localized_name` from z10 up, and below that whichever of `label` and
`localized_name` the `stationLowZoomLabel` global-state key names. `label` is the
station's own name and is never translated, and their default names it — so the
language landed on the close view and the far view stayed in the local script,
which looked exactly like a change that had not been deployed. `installRail`
sets that key to `name`. Safe, because `localized_name` is never empty: with no
`name:en` to offer it falls back to `name`, which is what `label` would have
been. Visible over Poland, where the same far view now reads "Krakow Main
Station" beside "Rzeszów Główny" — one has an English name in OSM and the other
does not, and neither is missing.

Nothing is lost by it. Their own style puts `name` on a second line wherever the
two differ, so the sign at the station is still on the map; where a place has no
name in the language asked for, `localized_name` is what `name` was and the
label is one line as before. The feature card follows the same rule — the
heading is the name the map drew, with the local spelling kept as a row — and
their feature API, which is where the card's list of services comes from,
ignores the parameter entirely: an OSM route relation is named once, in the
language it is named in.

### Technical infrastructure is a filter, not a group

The sidings and yard roads a train is only ever shunted along, the line that was
lifted in 1974, and the "stations" that are a junction, a site or a point where
two tracks cross. All of it is real and correctly mapped, and all of it roughly
doubles the ink around any station of any size — at Spiez, 38 of the 63 tracks in
one z16 tile carry a `service` tag. Off by default, and one switch.

It **cannot be a group**, because a siding and the through line beside it are
drawn by the same layer off the same source: it is a property of features, not of
layers. So it is a filter, and `technicalFilter()` builds it per source layer —
`service` and `state` on the two track layers, `feature` on the five station
ones, nothing anywhere else.

**One global-state key, not 253 `setFilter` calls.** MapLibre re-parses a
source's tiles when a filter that reads a changed global-state key changes
(`getLayoutAffectingGlobalStateRefs` includes the feature filter), and a
`setFilter` per layer would do that work once per layer. The filters are written
into the layers at install as `["any", ["global-state", "hexploreTechnical"], …]`
— exactly the shape their own style is written in — so the switch is one property
set. It is still five properties and so five reloads, because their four
`showXInfrastructure` switches follow the same toggle; only `Style.setGlobalState`
applies several at once and that is not on `Map`, which is not worth reaching
past `Map` for on a switch nobody flips twice.

Their four are used rather than reimplemented: the style consults them itself,
in 1,529 places. Their defaults disagree with each other — construction and
proposed are on out of the box, abandoned and razed are off — which is a fine
answer for a map *of* railways and the wrong one for an overlay on a map of
somewhere else. `disused` is the one state with no switch of theirs, and is the
only one filtered here directly.

**A filter that throws does not fail loudly — it draws nothing**, and these are
the filters on every track and every station in the overlay, so both places a
null can get in are closed. Every property read goes through `coalesce`, because
`match` on an absent property evaluates its input to null, which is neither a
label nor the fallback. And the switch itself is read through `to-boolean`,
because `global-state` evaluates to null for a key nobody has set and `any` wants
booleans: one ordering mistake that left the key unset would otherwise empty the
map of railways with no error worth the name. Coerced, it reads as "off", which
is the default anyway.

The test compiles all of it with `featureFilter` from
`@maplibre/maplibre-gl-style-spec` — the same expression compiler the map uses,
which is the only way to know, since eyeballing an expression is exactly what
this class of bug survives. It evaluates the switch in both positions, with the
key unset, and ANDed onto each of the 288 generated filters it lands on. The
package is maplibre-gl's own dependency rather than one of ours, so it is asked
for rather than assumed: no compiler, no checks, and the rest of the file runs.

### Asking their server as little as possible

`server/rail-tiles.js` is a caching proxy, and its module comment is the part to
read before changing how often it asks upstream. Their usage policy says tiles
may be used by third-party applications "available publicly and without
registration", that they "may not be downloaded using automated processes or in
bulk", and that requests must carry a header that is not faked. This map is
behind an account and a server-side cache is by definition an automated process
fetching tiles; both are a deliberate, informed departure, made because the
alternative — every browser on every device asking them directly, forever — is
worse for them. What it obliges the proxy to do is spelled out there: nothing is
ever fetched that a person did not just look at, there is no seeding or
prefetch, `MAX_UPSTREAM` caps concurrent upstream requests at six, entries
outlive their TTL and are revalidated with `If-None-Match` so a repeat costs a
304, and their outage serves a stale entry rather than a retry loop.

The one route that takes free text — `feature/<source>/<layer>/<id>` — passes
its three parts by name rather than spreading a match array into the call. The
spread was equivalent and read as though the fourth argument, which comes off
the `Host` header, could land in one of the parameters that becomes the upstream
path; a scanner reading it that way was not wrong to. `fromUpstream()` also
checks that the resolved URL still starts with the upstream origin before
asking, which costs a string comparison and means no combination of path pieces
can walk the request somewhere else.

### Remembering that they said no

The cache originally stored only successes, which meant a tile their server
could not answer was fetched again on every single pan across it — forever, at
full price, for as long as it stayed broken. That is the opposite of what a
cache is for, and it is the failure mode you actually meet, because upstream
failures are not rare.

A refusal is now stored like any other answer. `FAIL_TTL_MS` starts at thirty
seconds and doubles up to `FAIL_TTL_MAX_MS` for as long as the failures keep
coming, so a recovery is noticed almost immediately while a persistent outage
settles to a trickle. Panning back over ground that failed costs nothing;
ground nobody has looked at yet is still fetched at once.

**There is deliberately no circuit breaker**, and the story of the one that used
to be here is worth keeping. The idea — after twelve consecutive failures stop
calling a source for a minute — reads as obvious politeness. It went wrong twice.

Shared across sources it was actively harmful, because they do not fail as a
unit: `railway_line_high,railway_text_km` (the track geometry) answers requests
over Switzerland while the ten-source `standard` composite carrying stations and
signals answers 502 to all of them. One counter meant the dead source tripped
within a viewport and silenced the healthy one, so the tracks drew and vanished
a second later — sooner the further you zoomed in, because a denser viewport
reaches twelve failures faster. That read convincingly as a zoom threshold in the
style and was nothing of the kind; layer visibility is unbroken from z7 to z17.

Made per-source it still blanked the railways for a minute at a time during an
outage the per-tile backoff was already handling, and announced itself in the log
while doing it. A pause that makes the map worse without meaningfully sparing
their server is not politeness, it is just a pause. The backoff is the better
shape of the same idea and it is the only one left. A test still interleaves
thirty requests to a permanently-broken source with thirty to a healthy one and
asserts all thirty healthy ones draw, so that nothing global comes back.

**Only a 204 means "no railway here".** A 404 used to be filed as an empty tile
and kept for a day, which is wrong in the case that matters: Martin answers 404
for a source it does not recognise, so a redeploy that renamed one would have
read as empty ground for a day after it was fixed. A 404 is a failure with the
short backoff like any other.

The log needed the same restraint. One line per failing tile is not a log, it is
the reason nobody reads the log; failures are summarised at most once a minute
with a count of what was suppressed. Recovery is announced only if an outage was
announced first — otherwise the ordinary state of one source answering while
another does not alternates the counter and reports a recovery every other tile.

**What none of this fixes** is which tiles they can serve — and the reason is
worth writing down, because the symptom is very good at suggesting the wrong
cause.

Their failures look per-tile and deterministic: at z12 x=2145, y=1431–1435
return tiles while y=1430 and y=1436–1440 return 502 in a tenth of a second, the
same way every time. That reads like a data bug in particular tiles. It is not.
The response headers give it away — **every success is `cf-cache-status: STALE`
with an `age` of one to three days, and every failure is `cf-cache-status:
BYPASS`**. Their origin is down. Everything anyone is being served, on
openrailwaymap.app as much as here, is Cloudflare replaying copies it cached
before the outage; a tile works if and only if it is still in the edge cache.
The determinism is the CDN's, not their database's.

This also answers the obvious objection — "their own site works at the same
spot". It works because their users keep the popular tiles warm in the very same
shared cache, and we get those hits too. Ask for a tile nobody has requested
lately and both sites get the same 502.

So the overlay can be complete over one valley and missing its symbols over the
next, it will vary by how well-trodden the ground is rather than by anything
about the railways, and it will come right on its own when their origin does.
If waiting stops being acceptable, the fix is `RAIL_ORIGIN` and their SETUP.md,
not more cache.

### Asking for less detail rather than drawing nothing

One thing *can* be done about it, and it falls out of the same observation. Edge
cache coverage is not uniform across zooms: there are sixteen times as many
distinct tiles at z14 as at z12, so a deep tile is much less likely to have been
requested by anyone recently. Measured over Bern during the outage, the track
source answered 5 of 10 at z14, 6 of 10 at z13, 7 of 10 at z12 and 9 of 10 at
z11 — the same tiles, the same server, purely a function of how many distinct
tiles that zoom has.

A zoom that is failing is therefore worth *stepping down from* rather than
retrying. MapLibre will overzoom a parent tile quite happily — coarser, but
railways on the screen instead of a blank — and it does the rescaling itself and
correctly, because it knows the tile is a parent. It only has to be told, via
the source's `maxzoom`, not to ask for the deeper ones. This is also why the
fallback cannot live on the server: a vector tile's coordinates are relative to
its own bounds, so serving a z12 body in answer to a z14 request would render
the whole parent crammed into a quarter of it. Only the client knows it is
overzooming.

`detailCeiling` keeps a hit rate per source per zoom over `HEALTH_WINDOW_MS` and
names the deepest zoom still worth asking for: one below the shallowest zoom
that is failing more than `HEALTH_MIN_RATIO` of the time, floored at
`DETAIL_FLOOR`. `HEALTH_MIN_SAMPLES` stops a handful of misses over empty
countryside from costing anyone detail, and cached hits count as evidence too —
without that, a source served entirely from disk would look like it had no
evidence at all and could never climb back out of a cap.

The client reads it from `/api/rail/detail`, caps each source at it, and asks
again every `RAIL_DETAIL_POLL_MS`. **Both directions matter.** The cap descends
as deeper zooms prove unavailable, and it lifts on its own when the evidence
ages out of the window — so when their origin recovers, the detail returns
within a few minutes with nothing to restart and no cache to clear. A change in
either direction rebuilds the overlay, because `maxzoom` is not settable on a
source MapLibre already holds.

**The poll is only for the good news.** Their cache coverage is geographic, so
panning into a valley nobody has warmed turns the railways off *now*, and three
minutes is indistinguishable from broken. MapLibre reports every failed tile
with its `sourceId`, so a failure schedules a check on `RAIL_FAILURE_CHECK_MS` —
debounced, because a viewport fails a dozen tiles at once.

**A descent is several steps and they have to be quick.** The ceiling can only
move one zoom at a time, because the evidence for "z12 is bad too" does not
exist until z12 has been asked for. Simulated against their live server at
Frutigen, where their cache holds nothing below z12: z14 fails ten of ten and
caps to 13, z13 fails ten of ten and caps to 12, z12 answers five of ten and it
settles — railways on screen, overzoomed 4× at z14. That is three round trips,
so `railLastFailureCheck` is reset whenever a check actually moved the ceiling;
a descent runs at the short interval and only settles to `RAIL_FAILURE_MIN_GAP_MS`
once it has found a zoom that works.

**The rebuild keeps the sprites.** `removeRail` takes them out by default and
must not here: an image manager with a sprite in flight is not ready, MapLibre
draws no frame until it is, and 2.25 MB of atlas takes long enough that the whole
map — basemap included — blinks out. Since zooming in is exactly what moves the
ceiling, that read as "the railways disappear when I zoom in". A zoom range does
not change a sprite; leaving them alone makes the rebuild invisible.

**Their server requires a `Referer`,** which the policy does not say. Every
combination of `User-Agent` was tried — including none — and all of them answer
403; anything with a Referer gets through. So the policy's "or `User-agent`
header (automated processes)" is not what the server implements, and a
server-side proxy has no referring page to offer. What it sends is *this map's
own public origin*, resolved per request from the host the browser reached us
on, which is the honest answer to what the header asks. Claiming to be
openrailwaymap.app would clear the same gate and is precisely the faked header
the policy forbids.

Storage is one file per entry, a single-line JSON header followed by the body,
written through a temp name and renamed — the metadata travels with the bytes,
so there is no index to fall out of step with the directory. Bodies are stored
gzipped and passed through in that encoding. `RAIL_CACHE_BYTES` (512 MB) bounds
it, with a least-recently-used sweep down to 80%; recency is recorded by
touching mtime at most hourly, because a write per tile per pan is not worth
knowing the order precisely. An empty tile — ocean, desert, anywhere without a
railway — is 204 and is remembered too, since "still nothing" is the cheapest
request there is to eliminate.

Point `RAIL_ORIGIN` at a Martin running their stack per their SETUP.md and every
one of these concerns evaporates with no code change. That, not a bigger cache,
is the fix if the traffic ever stops being personal-scale.

### Switching it on should not take six seconds

It did, and almost all of it was one thing: **MapLibre validating 288 generated
layers against the style spec**, 995 ms of the 1 730 ms `addLayer` took, measured
on the real overlay. That check earns its keep for a layer somebody typed; these
come out of a transform `npm test` exercises on every run, so re-proving it in
the browser on every switch-on and every basemap change buys nothing and costs a
visible wait. `addLayers` passes `validate: false` — the one place in the client
that reaches past `Map` to `Style`, feature-detected, with the supported path
still underneath — and the install drops to about 80 ms of layer work.
`_update(true)` afterwards is not optional: without it `_styleDirty` stays false,
`Style.update()` never runs, and the sources sit paused with tiles unrequested.

The rest is first-load weight, which is why it only bit after a reload: 315 KB of
style (12 KB gzipped) and **2.25 MB of sprite atlas**. The atlases are now fetched
only if a switched-on group actually draws from them, worked out at build time
from the rewritten image references — and the full-colour one, 1.5 MB at 2x, is
read by a single expression in "Signals & crossings", so turning that group off
saves two thirds of it.

### A tap on a siding

The reason for all of it. `describeRailFeature` builds a card from the properties
**already in the tile that drew the line**, and says them the way a person reads
them rather than the way a database stores them: `15000` becomes 15 kV, a float32
`16.700000762939453` becomes 16.7 Hz, `0` frequency becomes DC rather than 0 Hz,
speeds and gauges carry their units, and `{BLS}` — a PostgreSQL array literal,
which is what put braces on screen — becomes BLS. Their feature API returns the
same fields as real JSON arrays, so `asList` answers both doors.

**The track number is what says which line was clicked.** A station is twenty
parallel lines and, without `track_ref`, twenty cards that describe themselves
identically — same operator, same voltage, same gauge. It is distinct from `ref`,
which is the number of the *line* the track belongs to and stays out.

**Their tiles carry no `osm_id` at all.** That pair of keys is their feature
API's; reading it off a tile was a link that could never appear, and the cost of
that was much higher than a missing link. `describeRailFeature` opens no card for
a feature with nothing to say, and a platform whose relation carries no `name`
and no `ref` — which is most of them, since the number is usually on the platform
*edge* — had nothing else. Thun's platform relations happen to be named "Thun"
and opened a card; Spiez's are named nothing, so the tap fell through to the
ground underneath. That read exactly as "platforms are clickable in Thun and not
in Spiez", and no amount of looking at the platform code would have found it.

What a tile does carry is the feature's own `id`, which is the same fact spelled
two ways: `relation-9068328` and `node-3080728389-train-train-station` where the
element type is not implied, and a bare `988282659-0` on the track layers, where
the suffix is the segment a long way was cut into and the element is always a way.
`osmRef()` reads the prefixed form anywhere and the bare form **only on the track
layers**, because a kilometre post's id has precisely the same shape and is a
node — guessing from the shape alone would link a third of them to somebody
else's way.

And a feature with a `feature` value now has a heading: "Platform" rather than
"Railway" over a subtitle reading "platform", which spent the heading on the one
word that is true of everything in the overlay.

**The routes are the one exception to "already in the tile".** Which services run
over something is a relation, and a vector tile carries `route_count` but not the
relations, so that is a request — one per click, on something somebody just asked
about, which is a very different thing from one per tile. It is answered by their
`api` container rather than their tile server, which is why it kept working right
through the outage that took the tiles down. The card opens without it and fills
the list in when it arrives.

**Their answer keys the routes by what was clicked** — `line_routes`,
`station_routes`, `platform_routes` — and reading only the first is why a station
used to list nothing. A station has no `route_count` in its tile either, so
unlike a line it cannot know to leave the room: it asks on spec, and the section
is built only if the answer has something in it. The same request brings back
what else their API knows — the operator, the network and what stops there for a
station; the platform numbers, the surface and what is on it for a platform —
appended to the same `dl` the tile's rows are in, so the card grows rather than
sprouting a second table under the first.

Their `references` block is deliberately not read. The UIC number and the
operating code — "8507483" and "SP" for Spiez — are both real and neither is
anything anyone does with a station: one is a booking system's primary key and
the other is on an operating diagram, and between them they filled two of the
card's five rows with numbers nobody looks up.

Every enum in their schema is lower case, because that is how an enum is spelled.
A card that reads "State present" over "Serves train" is printing the column
rather than the answer, so values go through `humanValue` — the same
underscore-stripping `featureLabel` the headings use, plus a capital. The label
beside it is already a capitalised phrase and a row where only one half is
formatted reads as a bug.

**A junction station is on twenty services**, which is a list taller than the
phone it is on — and it pushed the name, the operator and the platform number off
the top of the screen to make room for something you then had to scroll the *map*
to read. The list has its own scroller at about eight lines, so the card stays the
size of a card.

OSM models each direction as its own relation, so six of them are three services;
`mergeRouteDirections` folds a route and its return working into one line, keyed
on the service name plus the stop list taken whichever way round sorts first. Two
different services between the same towns keep their own lines. The label is
split on **every** separator rather than the first, because relations name their
via-points: "Grandson => Lausanne => Bex" is a journey, and treating it as a pair
would both read wrong and stop it matching its return working, whose stops are
the same list backwards. It is set with real arrows — `→` one way, `↔` when both
directions were found — since `=>` is how the tag is written, not how it should
be read.

**`=>` is nothing like universal.** "TGV 511: Paris -- Toulon -- Hyères" and "TER
Morez - Saint-Claude - (Lyon)" are both real relation names, and a separator the
parser did not know about printed as one undivided run of text with no arrows in
it at all. `STOP_SEPARATOR` takes `=>`, `<=>`, `->`, `<->` and the dashes — and
**every dash form requires whitespace on both sides**, which is the whole of what
keeps Saint-Claude, Aix-en-Provence and Baden-Baden in one piece. The test names
those three, because the failure is a place cut in half and it would look like a
data problem.

Plenty of relations carry no `colour` tag — their API returns an empty string —
so the dot is drawn hollow rather than omitted, because a missing dot puts the
labels on a ragged edge and reads as a rendering fault instead of as missing
data. And a label wider than the card is broken after the service name rather
than wherever the edge happens to fall: the journey is an `inline-block`, so it
moves down whole instead of stranding "Zweisimmen" on a line of its own.

**Platform numbers need z15 and are not always reachable.** `ref` means the route
number on a line and the platform number on a platform, so it is shown only for
the latter, keyed off what was clicked. Their platform geometry only exists from
z15, which during the outage was the one range with nothing in the CDN at all —
so the row is correct and simply has no data to show until their origin is back.

The hit test is scoped to our own layer ids: the basemap draws railways too, and
reporting CARTO's idea of a line while the overlay is showing OpenRailwayMap's
would be the same mistake the layer ordering was fixed for. In the click handler
a railway comes after a saved route and before the ground — the same order the
three are drawn in, and for the same reason.

### Whether a tap on a railway does anything at all

It used to always. That is the wrong default for an overlay whose first job is to
show *where* the railways are: every tap on the map then went through a hit test
across 288 layers before it could be about the ground, and the overlay quietly
took taps away from the map it was drawn over. **Interaction is a switch now, and
it is off** — someone reading the tracks over their own map never pays for it,
and someone reading the railway says so once.

That switch is also what paid for the hover, which this file used to argue
against: "there is deliberately no hover cursor: a `queryRenderedFeatures` across
288 layers on every mousemove is not worth an affordance". The cost was real and
the conclusion followed from it being unconditional. Opted into, it is a
different trade, and the hover is worth a great deal in a station where twenty
lines are three pixels apart.

**The highlight itself costs nothing of ours.** 171 of the 288 layers already
paint a hovered feature differently — a red platform edge, a red outline round a
station, a yellow track number — because their app is a map you point at, and
that styling came across with the layers and had simply never been switched on.
So `setRailHover` writes one `feature-state` and their own style answers it in
the colour its designer chose; there is no highlight layer of ours. `promoteId`
on every source, which was already there to make a clicked feature identifiable,
is what makes a feature state possible at all.

The query is throttled to one per animation frame and skipped while the map is
moving. The cursor is the one thing two things compete for — a saved route
answers synchronously on the mousemove, a railway a frame later — so one function
owns it and reads both, or the later answer would clear the earlier one's.

### Where the switches live

All of it except the on/off is in **Settings → Train tracks**. They were a
disclosure inside the layers menu, folded under the switch that turns the overlay
on, which was right for two checkboxes and wrong for eight: the layers menu is
something you flick through while looking at the map, and a column of railway
sub-options in the middle of it pushed everything below out of reach on a phone.
They are settings — set once, then read the map.

The overlay's own switch deliberately stays in the layers menu: "is this layer
drawn" is the same question as "is the heatmap drawn" and belongs beside it.

Opening the dialog **fetches the style**, because the group list is named from it
and the overlay may never have been switched on. It is a 315 KB lazy chunk and
opening this dialog is a clear enough statement of intent; the alternative was an
empty box until you had switched the overlay on first, which is a dialog that
looks broken for the one reason nobody could guess.

## The airports, from a file rather than an API

The other reference overlay, and deliberately not built the way the railways
are. `src/airports.js`, `scripts/build-airports.mjs`.

**It is a dataset, not a tile server, and everything else follows from that.**
Look at what the train tracks cost: a 584-line caching proxy, a usage policy to
read before changing anything, a per-zoom health monitor, a detail ceiling that
descends and climbs on its own, and a banner apologising for somebody else's
outage. All of it is correct, and all of it is the price of geometry too big to
ship — OpenRailwayMap is every siding on Earth. Airports are not that. There are
**85,835** of them including the closed ones, they are points rather than
geometry, and the whole set is smaller than `regions.json`, which this repo
already commits. Paying a permanent runtime dependency to avoid a one-off
download would be the wrong way round.

So the source is [OurAirports](https://ourairports.com/data/), which is public
domain — no key, no quota, no rate limit, and no terms to be careful about. The
build fetches `airports.csv` and `runways.csv`, trims them hard, and commits the
result, exactly as `build-places.mjs` and `build-countries.mjs` do. There is no
server code for this feature at all, and the overlay **works offline**, which no
proxied layer can.

### One file per group, because a group is a download

All 85,835 are 2.6 MB gzipped, and that is a great deal to spend on flipping a
switch. Measured field by field, none of it is trimmable — the bytes *are* the
names and the coordinates, and dropping the wikipedia links, the home pages and
the municipalities together saves under 15%. The saving has to come from not
fetching what is not drawn.

It is almost all the long tail. The five thousand airports an airline actually
flies to are **250 KB**; the other eighty thousand are 42,707 small airfields,
23,143 helipads on hospital roofs and oil platforms, and 13,378 that closed. So
the build emits one file per group and each is its own dynamic import:

| Group | What | Gzipped | On |
| --- | --- | --- | --- |
| **Airline airports** | large + medium | 250 KB | yes |
| **Airfields** | small, seaplane, balloon | 1.4 MB | no |
| **Helipads** | heliports | 640 KB | no |
| **Closed** | no longer operating | 360 KB | no |

Three of the four are off for the same reason three of the railway's six groups
are: switching an overlay on for the first time should answer the question you
switched it on to ask, and "where are the airports" is answered by the ones with
scheduled flights. The rest is aviation infrastructure — real, correctly mapped,
and between them several times as much ink as the thing you were looking for.
The service worker caches on demand and pre-fetches nothing, so a group left off
is never requested and a group switched on is kept.

**The dialog says the counts**, which the railway's does not, and the difference
is the point: the rail groups filter tiles that arrive anyway, so switching one
on is free. These are downloads. A cost you cannot see is a cost you cannot
weigh, and the numbers are written by the build into `airports-counts.json`
rather than typed into the dialog, so they cannot drift from the files they
describe.

### The two halves of one agreement

The build and the client each hold half of something neither can check at run
time: which letter means which kind, which kinds travel in which file, and what
the sixteen slots of a record are. A record read one field along is not an error
— it is an airport whose elevation is its runway count. So
`scripts/test/airports.mjs` checks the two against each other and against the
committed files, and the build **fails rather than ships** if OurAirports grows
a type no group claims.

The record is an array rather than an object because the keys would otherwise be
repeated 86,000 times, and the rows are sorted by kind and then by country — not
cosmetic, but because it puts the two lowest-cardinality columns into long runs
and gzip is much happier about `"L","L","L"` than the same letters scattered.

### Saying it the way a person reads it

The same job the railway card does for voltages and gauges. Runway surfaces
arrive as **650 distinct spellings of about eight materials** — `ASP`, `ASPH`,
`Asphalt`, `asp`, `ASPH-G`, `ASPH/ CONC` — typed by whoever filed the airport and
never normalised, which is fine for a database and no good on a card claiming to
say what the runway is made of. Unrecognised is left unsaid rather than printed
raw: "PIÇARRA" is a real surface and shows nothing to somebody asking whether it
is paved.

Elevations and runway lengths carry metres *and* feet, because aviation is feet
and this map is metric. A country code becomes a country through
`Intl.DisplayNames`, which every browser and Node already has — a 250-name table
would be bytes spent on something the platform knows, and it answers in the
reader's own language for free. (`countries.json` is no help: it is keyed by ISO
alpha-3 and OurAirports files by alpha-2.)

Only the longest runway's surface and lighting are kept. The full table is 47,000
rows and the questions a card answers are "how many" and "how big is the biggest"
— the longest runway is what decides whether a 737 can land, and a list of every
threshold identifier is an aviation chart rather than a map popup.

### Which airport wins a collision

**This is the one that was actually wrong on a real map, and it is invisible in
the code.** `symbol-sort-key` decides who wins a collision *within* a layer and
says nothing at all across two — and MapLibre places symbols from the **top of
the layer stack downwards**, so the layer added last places first.

There is a layer per kind class rather than per group, because the two things a
layer decides — which icon, and from which zoom — vary inside a group: a large
international airport is worth drawing where a continent fits on screen and the
regional field beside it is not. Installed in declaration order, that put
`medium` above `large`, and **Zürich Airport lost its label to Dübendorf Air Base
eight kilometres away**. Nothing threw and nothing warned; the busiest airport in
the country was simply not drawn, which reads as missing data rather than as a
z-order bug. The layers are declared most-important-first and installed in
reverse, so the most important kind is top-most, places first, and also draws on
top — the same answer to both questions. The test installs against a stub map and
asserts the order, because this cannot be seen by reading the layer table.

The zoom thresholds are the other half of keeping it legible. Much of the
American Midwest is a grid of small airfields; drawn from z4 they are a texture
rather than a map. Each threshold is roughly where that kind stops being clutter
and starts being an answer — large from z3, medium from z5.5, airfields from
z8.5, closed from z9, helipads from z9.5.

Helipads were the exception, at z11, and it was set against the wrong case. The
worry was a city centre where every other hospital roof has one — and that is
precisely the case `icon-allow-overlap: false` already answers, by not placing
what does not fit. What the threshold actually cost was the ordinary case: a
helipad that is the only aviation on the map for fifty kilometres, invisible
until you were nearly on top of it.

**The label is two different things at two zooms.** Zoomed out it is the code:
`ZRH` is shorter and more recognisable than "Zürich Airport", and at the zoom
where a country fits on screen the difference between a three-letter tag and a
forty-character name is whether the labels collide into nothing at all. From z9.5
it is the name, because by then you are looking at one airport rather than
counting them. An airfield with no IATA code — which is most of them — is named
at both ends.

### The icons, and what they are not

Drawn into images the style owns, the same way the house marker and the search
pin are: a sprite would mean shipping and loading one, and a symbol layer with no
image draws nothing while saying nothing about why. Stroked wide in white and
then filled dark, which is the trick the basemap's own labels use and the reason
one icon reads on a dark map, a light one and a photograph without a coloured
disc behind it guaranteeing contrast by shouting.

They are **not** in the accent colour, and that is a rule rather than an
oversight: the accent belongs to ground you have covered, and an airport is
reference data about somewhere you may never have been. A solid plane for the
airports an airline flies to, hollow for the small ones — which is how a map says
"the same kind of thing, less of it" without needing a legend — an H in a ring
for a helipad, and a ring with a stroke through it for a field that closed.

The seaplane icon took two goes. A full-size plane with a wave added underneath
was unreadable: the wave crossed the tailplane and the two stroked shapes merged
into one blob at the only size this is ever seen at. The plane is shrunk and
lifted instead, clear of the water. Two separated marks beat one clever one when
the whole icon is fourteen pixels across.

### A tap, with no switch in front of it

The railway's interaction is off by default because a hit test across 288 layers
on every tap is a real cost, and an overlay switched on to look at should not
quietly take taps away from the map underneath. Neither half of that argument
survives here: this is one query over six layers of a point source, about the
same work as the saved-route test that has always run unconditionally. An icon
you can see and cannot tap is the worse answer when tapping it is nearly free, so
airports answer a tap whenever the overlay is on, and there is no switch — copying
the railway's would be cargo-culting the conclusion without the reason.

In the click handler an airport comes after a saved route and after a railway,
the same order the three are drawn in. The query is a padded box rather than a
bare point, because an icon is fourteen pixels across and a finger is not.

**And the overlay is remembered across reloads**, where the train tracks
deliberately are not. Switching the tracks on is a conversation with somebody
else's tile server and 2.25 MB of sprite atlas, which should be asked for rather
than assumed. This is a file the app already ships, cached by the service worker,
drawn from one GeoJSON source — there is nothing to spare anyone by forgetting
the answer overnight.

## The photographs themselves, from the phone in your hand

[Photographs](#photographs) covers what the library does to the *map*: it
colours in the ground a camera has been over, as the `apple-photos` source, and
nothing but `[lat, lng, t]` ever leaves the phone. This is the other half of the
same fact — not "you have been here" but "there is a picture here, and here is
what it was". A point per photograph, grouped where they pile up, and the
picture itself when you tap one.

**It exists only inside the iOS app, and cannot be made to work anywhere else.**
A photo library is on a phone. A page cannot open one, and the server has never
held anything but the coordinates — which is the whole design of the sync, not an
omission to be fixed. So the picture comes from the host the page is running
inside, over a `WKScriptMessageHandlerWithReply` channel that `PhotoBridge.swift`
answers, and `src/photos.js` detects the app by asking whether that channel is
there. In a browser it is not, and the row is **absent from the menu** rather
than present and disabled: a control whose precondition is "be a different
application" is not a control.

### A photograph is named by its index, never by its identity

The bridge replies with `[lat, lng, t]` per photo and keeps every
`localIdentifier` on its own side. Afterwards the page names a photograph by
where it sat in that array — `{ask: 'photo', scan, i, px}` — and the app looks
the identifier back up.

That is not ceremony. A page is reloaded from a server, keeps storage a browser
hands around, and runs scripts this app did not write; handing it durable names
for eighty thousand photographs would build an index of somebody's library in the
one place here that is not private by construction. An index is meaningless
without the list that produced it, so every scan is numbered and every later
question quotes the number. A question against a replaced scan is answered
`stale` rather than answered about a different picture — which is exactly what
would otherwise happen the moment a screenshot landed at the top of the library.

### The picture crosses as base64, and that is the CSP's doing

The tidier shape would be a custom URL scheme — `WKURLSchemeHandler`, and an
`<img src="hexplore-photo://…">` the browser could fetch, cache and lazy-load on
its own. It does not survive contact with this app's own security headers:
`img-src` lists `'self' data: blob: https:`, and widening a real
Content-Security-Policy to make a nicer-looking image URL is the wrong way round.
So a picture is a JPEG the app base64-encodes into a `data:` URL, at the size the
card asks for and no larger. The card asks in device pixels of its own width,
which is why the photograph is sharp on a phone and why it is not 12 MB.

### Grouping, and why a tap never zooms

The source clusters, with one deliberate departure from the convention:
`clusterMaxZoom` sits at the **top** of the map's range rather than one below it.
The usual setting exists so the last zoom shows individual points, which is right
for shops and wrong for photographs — forty pictures of one dinner are forty
points at one coordinate, and separating them at z17 replaces a group you can
open with a pile you cannot count.

**A tap on a group opens it, whatever size it is.** This first shipped the other
way round — zoom in when zooming would break the group up, open the card only
when it would not — which is what a map conventionally does and was wrong twice
over on a real library. Photographs re-cluster as fast as you can separate them:
a handful taken a few metres apart re-forms at every zoom on the way in, so
reaching the pictures took up to ten taps, each of which moved the map somewhere
nobody had asked to go. And the case the zoom was serving is not a real one —
nobody taps a group of photographs wanting a different camera position. They want
the photographs. Zooming is what the map's own gestures are for, and they are
still there.

The card shows one picture with the rest as a strip along the bottom, **newest
first**, and it holds **all of them**. It was capped at 48, which made a tap on
four thousand photographs quietly a card of forty-eight: the group is the answer
to the tap, and keeping most of it back is a card misreporting what is there.

Newest first because the card opens on the first of them. A group of photographs
is a place you have been back to, and the one you want is almost always the last
time rather than the first — which is also the order every other list of
photographs anyone uses is in. `groupWhen` reads a span off the smallest and
largest timestamps rather than the ends of the list, so it cannot print a date
range backwards when the order changes again.

### How big the card is, which is a different answer per screen

The card is 360px wide, which is the width of a phone — and it followed the
phone onto every other screen there is. On a Mac that put the photograph in
about a ninth of the window with map on all four sides: the picture is the
entire content of this card and it was the smallest thing in the frame.

So on a viewport with room — `(min-width: 720px) and (min-height: 560px)`, the
same test the search palette makes about whether its calendar fits, so the two
agree about what "roomy" means — it is 680px wide, the picture may be 62vh tall
instead of 52vh, and the thumbnails go from 54px to 76px. The strip grows with
it because 54px squares under a 680px photograph read as a footnote rather than
as the rest of the group. `THUMB_PX` (120 CSS px, times the device ratio) still
covers the larger square without being asked for again.

The phone is untouched: at `calc(100vw - 32px)` the card was already edge to
edge there, and the picture's 52vh ceiling is what keeps the strip on screen
under it. And it is still a card over a map, not a viewer — it grows to a size a
photograph is worth looking at, not to the window.

### Swiping, because the strip answers the wrong question

The strip is a complete answer to *which one* and a poor answer to *the next
one*: forty pictures of a dinner are forty 54px squares, and picking along them
with a thumb is not how anybody looks at photographs. So the picture itself
takes a horizontal swipe, which is what every other photograph on the device
does — and the arrow keys, which is the same movement without a finger.

It is a gesture rather than two invisible buttons. The picture follows the
finger, is resisted to a quarter of the movement at the two ends of the group —
a photograph that will not move at all is indistinguishable from a card that has
stopped responding — and commits on **distance or speed**, 56px or 0.5px/ms,
because a slow deliberate pull and a quick flick are the same instruction.
Pointer events rather than touch events, so one implementation covers a phone, a
trackpad and a mouse, and the gesture is claimed only once it is plainly
sideways: the card is also dismissed by dragging, and a picture that swallows
every downward movement is a card you cannot get rid of.

Two things about it are not obvious and both were bugs. **A drag that ends where
it began still dispatches a click**, so swiping to the next photograph also
opened the one you had just swiped away from, full screen — the flag that eats
that click is cleared on the next `pointerdown` rather than only where it is
read, or a gesture the system cancels leaves it standing to eat a real tap
later. And **the strip renders in chunks**, so a swipe can ask for a thumbnail
whose button does not exist yet; `select()` renders as far as it needs to and
scrolls the strip to it, because a selection that has visibly left the screen is
not a selection. `scripts/test/photo-swipe.mjs` mounts the card against a
stand-in DOM and fires the events by hand: all of this is arithmetic, and none of
it is visible in the review that breaks it.

Four thousand is two problems, and the strip pays for each separately.
**Elements**: buttons are appended `STRIP_CHUNK` at a time, when a sentinel at
the end of the strip scrolls into view, so nothing below the fold exists.
**Requests**: a thumbnail is fetched when its button appears, not when it is
created, so a group you open and glance at costs the dozen you can see. Both hang
off one `IntersectionObserver` rooted on the strip, which is also what makes them
stop — closing the card disconnects it and whatever was queued never happens.

The first dozen are fetched outright rather than waiting to be told they are
visible. An `IntersectionObserver` cannot fire before the page has been laid out
and painted, so a card opened in a tab that is not being rendered is a row of
empty boxes with nothing to nudge it. That is measured rather than theorised, and
a screenful is cheap insurance against every other reason layout might not have
happened yet.

#### The trackpad is a third gesture, and it was answering the wrong element

Pointer events cover a finger, a mouse and a *dragged* trackpad. They do not
cover the two-finger swipe, which is the one anybody actually makes on a Mac:
that arrives as a stream of `wheel` events and reached nothing at all here. A
swipe over the photograph did nothing to it.

So the **picture** takes the horizontal wheel, and the rule is the Mac app's own
(`GalleryView.scrollWheel` in `HexPlore-macOS`): accumulate `deltaX`, step at
`WHEEL_STEP` (40px), and take only wheels that are plainly sideways — a
two-finger scroll down a trackpad drifts left and right the whole way, and a
card that changes picture because of that is unusable.

**Only the picture.** The strip below it is a scroller, and swiping it is how
you get along a group of four thousand without pressing four thousand times;
taking that gesture and rationing it to one photograph at a time makes the strip
useless for the one thing it is better at than the picture is. So the two halves
of the card answer a sideways swipe differently, and that is the point rather
than an inconsistency: over the picture it means *the next one*, over the strip
it means *along*. The tail of a flick is swallowed with `preventDefault` for the
same reason — otherwise a swipe the picture has already answered carries on and
scrolls the strip underneath it, which is one gesture with two answers.

Where one swipe ends and the next begins is the whole difficulty, and the
platform is no help: a `wheel` event does not say which part of a gesture it is.
A trackpad never reports the end of one; it reports **momentum**, and a firm
flick goes on delivering deltas for the best part of a second after the fingers
have gone. So the step is spent once per gesture — and the tail is swallowed
with `preventDefault` too, or the strip scrolls on the momentum of a swipe the
card has already answered.

Two things can begin the next gesture, and the second took three attempts to get
right. `WHEEL_GAP_MS` (120) is **silence**: fingers up, coasting over. On its own
it is too strict, and the symptom is a card that appears to be on a cooldown —
a second swipe made while the first is still coasting is swallowed for as long
as the momentum lasts.

So the other way in is the stream **winding down and then picking up again**.
The obvious version of that — "faster than the slowest event since the last
photograph" — is wrong, and wrong in a way that reads as the original bug
coming back: a swipe *accelerates* while the fingers are still on the glass, so
the photograph is spent a frame or two in and everything after it is faster than
the moment it was spent at. A firm throw came out as three or four pictures.

Hence two thresholds rather than one. The stream has to go quiet first — below
`WHEEL_LULL` (6) it has wound down, and coasting decays towards nothing and
cannot come back — and only then does anything above `WHEEL_WAKE` (12) mean a
hand. Absolute rather than relative to the peak, because a throw and a nudge
decay to the same place and it is the place that matters, not the distance
travelled to it. And the lull is only armed while the step is *spent*, so the
acceleration of the swipe being answered cannot arm the thing that ends it.

**The Mac app does not need any of that**, and does not use it. `NSEvent` has
`phase` and `momentumPhase`, so `GalleryView.scrollWheel` can simply drop
momentum outright, reset on `.began`, and spend the step for the rest of the
gesture — exact rather than inferred. It had the same runaway bug for the same
reason and this is the same fix with the platform's own answer in place of the
heuristic. One detail: the step is only *spent* when the event carries a phase
at all. A wheel with detents reports none, and each notch of one is already a
separate deliberate movement — locking on the first would mean a mouse could
turn one page and never another.

#### The arrow keys are caught at the window, not the document

They stepped the photograph and **panned the map underneath it**, which is a
listener-ordering bug rather than a missing `preventDefault`. MapLibre's
keyboard handler is on the map's own container, and the container is what holds
focus after the tap that opened the card — so the key reached the map, moved it,
and only then bubbled up to the document, where this used to be listening and
where `preventDefault` had nothing left to prevent.

The fix is the capture phase on the `window`, which is the one place that runs
before the container does, and `stopPropagation` rather than `preventDefault`, so
nothing below is asked at all. It catches **all four** arrows while the card is
open: up and down have no photograph to move to, and panning the map out from
under an open card is not a better thing for them to do. A closed card stops
nothing, and the arrows are the map's again.

### There is no way through to Photos, and there cannot be

This shipped with an **Open in Photos** button, and a real phone settled it: iOS
has no public way to open one particular asset. `photos-redirect://` opens the
Photos app — undocumented, but it works — and that is the whole of what it does,
landing wherever Photos was last rather than on the photograph you tapped. The
schemes that look like they take an identifier (`photos-navigation://…?assetUuid=`)
are private and do not answer one.

A button labelled "Open in Photos" that opens Photos at something else is a
button that lies about what it does, and on a real library that is worse than no
button: you press it *because* you want that picture in the Photos app, and you
arrive somewhere unrelated having lost your place on the map. So it is gone,
along with the `LSApplicationQueriesSchemes` entry that let `canOpenURL` answer
for it. The card shows the picture, which is what the button was mostly wanted
for.

The reasoning is kept in `PhotoLibrary.swift`, where the button would go back.
Without it somebody re-derives the idea from the same first principles in a year
and ships the same lie.

### Videos, which are played rather than transferred

A video knows where it was taken exactly as a photograph does, so it is a point
for the same reason and evidence for the uploader for the same reason. What
differs is only what tapping it does.

For one release it did nothing useful: `requestImage` on a video returns its
poster frame, so a video was a photograph that would not play, and they were cut
from the overlay rather than left lying about what they were. They are back
because there is a right way to show one — and it is not to get the video into
the page.

**Every way of transferring it is worse than not transferring it.** A minute of
4K is about 350 MB; base64 makes that 470 MB of JavaScript string, and no amount
of chunking makes that a good idea on a phone. A `WKURLSchemeHandler` could
stream it properly, range requests and all, and would then be refused by the
site's own Content-Security-Policy — so it also means widening `media-src` for
the app's benefit. A local HTTP server inside the app has the same policy problem
plus mixed content, because the page is https and `127.0.0.1` is not.
Transcoding to something small enough to inline spends seconds and disk to arrive
at a worse copy of a file that is already on the device.

So the video is not transferred at all. The card's play button sends one message
and the app puts an `AVPlayerViewController` in front of the web view with the
asset's own player item — which is what a native app would have done in the first
place. Full quality, no copy, the system's own controls, scrubbing, AirPlay and
picture-in-picture for free, and an iCloud original fetched by Photos itself
rather than by us. The player is *presented*, so dismissing it puts the map back
exactly as it was, card and all.

**The sound has to be asked for, and for a year it was not.** Every video played
silently and it looked like a Photos problem; it was a declaration problem. An
app that never sets an `AVAudioSession` category gets `.soloAmbient`, whose
defining property is that the ring switch silences it — correct for a game's
background music and wrong for something somebody has just pressed play on. The
audio was behaving exactly as declared, and what was declared was "incidental".
`VideoPlayerController` claims `.playback` with `.moviePlayback` on the way in
and gives the session back with `.notifyOthersOnDeactivation` on the way out;
the second half matters as much as the first, because `.playback` is not mixable
and without it the album you were listening to never comes back. Being a view
controller is the whole reason it is a subclass: the player is dismissed by a
swipe nobody here is told about, and a view controller does know when it has
gone.

The page's part is one message. It has no URL for the video, never sees a byte of
it, and cannot save one — the same bargain the rest of this bridge strikes.
A fourth field on each row says which points move, so the card knows where to put
a play button, and the menu row counts photographs and videos separately: with
both on the map, "12,481 photos" is a number that is not true of what you are
looking at.

**Tapping the picture does the same for a photograph**, and for a smaller version
of the same reason. The card is already showing a copy scaled to the card; the
only thing full screen is worth doing for is the original, which is several
megabytes the page would then be holding twice — once as bytes and once as
base64. So the viewer is presented over the page rather than handed to it.

### The viewer is a gallery, and there is no system dialog that would have been

It opened one photograph, which was the wrong unit from the start. A tap on the
map is a tap on a *group* — that is the entire reason the card has a strip along
its bottom — so looking at the forty pictures of one dinner meant closing the
viewer, finding the next 54px thumbnail, and opening it again. Forty times.

The obvious fix is to ask the system for the thing it obviously has, and it does
not have it. **`PHPickerViewController`** is a picker: it shows the library so
you can choose from it, hands back what you chose, and cannot be pointed at a
subset. **`QLPreviewController`** genuinely does page through a list with the
system's own gestures — and wants file URLs, which for a `PHAsset` means
exporting every item in the group to disk first: slow, several gigabytes for a
holiday, and it leaves the copies behind. And nothing public opens Photos.app at
a given asset, which is [settled elsewhere](#there-is-no-way-through-to-photos-and-there-cannot-be).
What the system would have given us was never the paging; it was the *fetching*,
and that is the part this already had.

So the gallery is ours and it is small: a `UIPageViewController` in `.scroll`
mode is the paging, and each page is the scroll-view-around-an-image the single
viewer already was — pinch, double-tap and drag for nothing. **A video is a page
of it too**, so a holiday of stills and clips is one thing you swipe through
rather than two. On the Mac the same idea is one reused window with ← and → and a
two-finger swipe, because a window is not modal and the singleton it already had
*is* a gallery once it can be told to show something else.

**The page has to send the group, because only it knows what the group is.**
Clustering happens in the map, which the app cannot see, so "the forty
photographs under that dot" is a fact this side holds and the other side cannot
derive. `view` and `play` therefore carry `group` — the strip's own indices, in
the strip's own order, so swiping in the card and swiping in the viewer walk the
same list the same way. Four thousand of them is about 24 KB of JSON, once per
opening; sending a window around the tapped one would be cheaper and would be the
strip's old 48-item cap all over again, which is to say a viewer that silently
holds less than what you tapped. The indices are filtered against the current
scan on arrival: they name a list the app owns, they come from a page, and one
out of range has to be a photograph missing from the gallery rather than a crash.

Two things inside it are not obvious. A page that is *built* is not a page that
is *seen* — `UIPageViewController` puts the neighbours in its own scroll view
ahead of the swipe that reaches them, so `view.window != nil` is true off screen
and a video keyed to it starts playing to nobody; the appearance callbacks are
the only thing that means "on screen". And the audio session is **counted**
rather than claimed and released in pairs, because paging from one clip to the
next overlaps two players and UIKit orders the callbacks new-appears before
old-disappears — an uncounted pair deactivates the session under a video that has
just started, which is the silent-video bug again and only on the second clip.

A failure is a page rather than a dismissal. The single viewer closed itself when
a picture could not be fetched, which was right when the viewer *was* the
photograph; in a gallery, closing forty because one of them is still in iCloud
throws away the other thirty-nine.

Getting it to feel native took three goes, and the two failures are the
interesting part. **`.fullScreen`** filled the screen and could not be swiped
away — and swiping down is how every photograph on this device is closed, which
the video player beside it was already giving. A **page sheet** swiped away and
was not full screen: inset at the top, rounded at the corners, with the map
showing through them, which around a photograph is a frame around a frame.

So it is both, which the system does not hand over: `.overFullScreen` keeps the
map behind rather than tearing it out, and a pan gesture moves the picture with
your finger, fades the black as it goes, and either dismisses past 120 pt (or a
flick) or springs back. It yields to the scroll view once the picture is zoomed
in, and only claims a drag that is downward and more down than sideways — which
was a nicety when the viewer held one photograph and is load-bearing now that
sideways is the paging. A gesture that follows the finger and can be changed of
mind about is the whole difference between this and a swipe that is really a
button.

It used to yield the whole of a video page, on the reasoning that the bottom of
one is the system player's own controls and a downward drag beginning on the
scrubber is a scrub. Only the bottom of it is: the transport bar is a pill down
there, and everything above it is video. So the refusal covers
`videoControlsBand` (180 pt, measured up from the bottom edge) rather than the
page, and a clip closes with the same swipe a photograph does. The band is
deliberately generous — too big costs a strip of video that has to be dragged
from slightly higher up, too small costs a scrub that closes the gallery and
loses your place in a group of three hundred.

**A sideways drag on a video is the gallery's, not the scrubber's.** iOS 26
reads a horizontal drag anywhere across a video as a **scrub**, which on a page
of a gallery is the paging gesture — so swiping towards the next clip seeked the
current one instead, and the further you swiped the further back you went. There
is no property that turns that off by itself: `requiresLinearPlayback` would,
and takes the scrubber and the skip buttons with it, which is a worse trade than
the bug.

What there is instead is the recognition graph. `seekBlock` is a pan attached to
the *player's own view* that does nothing at all. It begins only on a sideways
drag across the video itself — outside `videoChromeBand` (64pt at the top: close,
routing, volume) and `videoControlsBand` (180pt at the bottom: the transport
pill, where a horizontal drag really is a scrub) — and it declares through
`gestureRecognizer(_:shouldBeRequiredToFailBy:)` that every recognizer *inside
the player* must wait for it. On a sideways drag across the video the player's
gestures therefore never begin; on anything else this one fails immediately and
they behave exactly as before. It claims nothing outside the player, so the
paging scroll view and the gallery's own dismissal are never asked to wait, and
`shouldRecognizeSimultaneouslyWith` lets them run alongside — without that,
taking the drag off the player would take it off the paging too, which is the
whole thing this exists to allow. `cancelsTouchesInView` is false: only the
player's *recognizers* are held back, and a tap on the video goes on showing and
hiding the controls the way it always has.

**And the × in the corner is the player's on those pages, not ours.** iOS 26
gives `AVPlayerViewController` its own chrome — a close button top left, AirPlay
beside it, volume opposite — and ours was drawn in the same corner at a
different size, so a video opened in the gallery showed two overlapping × marks
that read as one drawn wrong. There is no way to ask for the system controls
without that button and no reason to want two of them, so the gallery's own
close button hides itself on a video page and comes back on the next
photograph (`refreshChrome`). The counter stays: the top middle is the one part
of that row the player does not use, and *8 of 320* is the thing a gallery has
to say that a single clip does not.

It also asked for
**`PHImageManagerMaximumSize`**, which on a recent iPhone is a 48-megapixel
photograph — a `UIImage` of about 190 MB once decoded, handed to a `UIImageView`
in the middle of a presentation animation. That was the "small preview at the
bottom for a few seconds, then full screen" it used to do. It asks for 3,000 px
now: nine megapixels, sharper than any phone screen at 1× and still sharp several
stops into the zoom, at about a twentieth of the memory.

It also **opens before the picture does**. Presenting only once the image had
arrived meant a tap did nothing at all for as long as an iCloud fetch took; now
the sheet comes up immediately with a spinner in it, which is the app responding
rather than thinking.

**Both hand-offs are one at a time, and say so.** An original that has been
offloaded to iCloud takes as long as its download takes, and until it arrives the
button looked like it had swallowed the tap — so it spins. A second tap while the
first is still fetching used to present a *second* player on top of the first,
which then had to be dismissed twice. The card refuses the second tap, and the
app refuses it again on its own side: `alreadyShowing` answers "yes, that is
done" rather than presenting again, because what was asked for is on screen.

The spinner also **outlives the reply by half a second**. The app answers at the
moment it presents, and a presentation is an animation: for a third of a second
the card is still what is on screen, so putting the play triangle back the
instant the reply landed made it flash once just before the player covered it.
There is nothing to wait for instead — a native view going up over the web view
is not an event the page receives.

The class for that state is `fetching`, and the name matters. It was `busy`
first, which is **already a global class in this stylesheet** — the map's own
top-centre spinner, `position: fixed; left: 50%; display: flex; pointer-events:
none`. The play button inherited every word of it: torn out of the card, pinned
to the viewport, and untappable while it was meant to be spinning. `src/style.css`
has a handful of single-word global classes (`.busy`, `.hud`, `.layers`,
`.legend`, `.seg`, `.toast`), so a component's state class has to carry the
component's prefix or accept what they say.

### Where it sits, and what it takes precedence over

Above the saved routes — the only overlay that goes there. The rule that keeps
the railways and the airports underneath is that a line you actually travelled
beats reference geometry about what exists; a photograph is not reference
geometry, it is the same kind of fact as the route, and it is a dot. A 7 px dot
under a 12 px glow is a dot you can neither see nor tap. The click handler agrees
and asks about photographs *first*, before the routes: smallest target wins,
because it is the one you must have been aiming at.

### Looking is not uploading

The overlay does not consult the sync switch in the app's Settings tab, and asks
for photo permission on its own account. Wanting to see where your photographs
were taken and wanting those places to become part of your map are two different
decisions, and only the second one is what that switch means.

The scan happens when the overlay is switched on, and not again — a basemap
switch rebuilds the whole style and lands back in `syncPhotoLayer` with the same
library already in hand, where re-reading it would be a second walk over eighty
thousand assets to arrive at the list we are holding. Switching the row off and
on again is the refresh, and switching it off drops the list: keeping a copy of
where somebody has photographed eighty thousand times after they have turned the
layer off is not a cache, it is a leftover.

## The cards, and the buttons behind them

On a phone an info card is a sheet across the bottom of the screen, and the
button cluster — search, the layers menu, "my location" — is in the corner
underneath it. Open any card and those three are behind it: still there, still
tappable in the few pixels that stick out, and to anyone using the app simply
gone. So while a card is open they step above it, and `src/card-lift.js` is what
makes that possible.

**The distance cannot be a constant**, which is the whole reason this is script
rather than three more lines of CSS. A cell card is a title and five rows; a
route card adds three buttons; a photo card is a photograph — and a photograph's
card *changes height while you are looking at it*, from a 116 px waiting frame to
whatever shape the picture turns out to be. One hardcoded offset would be wrong
for two of the three cards and wrong twice for the third.

So the height is measured and published as `--card-h`, with `body.card-open`
beside it, and the phone media query turns those into `--lift`. The lift carries
a `min()`: whatever is open, the cluster stays on screen rather than being pushed
off the top, because a control that has left the building is not an improvement
on one that is behind a card.

**Why a variable rather than a `body.card-open .layers` rule**, which is what
this was first written as and which worked everywhere except the place it was
written for. Three rules position the cluster — the base one, the phone media
query, and the iOS block at the end of the stylesheet — and
`html[data-client='ios'] .layers` has *exactly* the same specificity as
`body.card-open .layers`. It is also later in the file, so it won, and inside the
app the buttons never moved. Nothing said so: the class was applied, the height
was published, and the CSS quietly disagreed. A custom property inherits, so it
reaches all three wherever they are and in whatever order, and the pencil in the
other corner takes the same lift for the same reason. `scripts/test/card-lift.mjs`
now fails if any rule that positions either of them forgets it.

**Nothing calls it per card.** A dozen places open or close one — `showCellInfoAt`,
`closeRouteInfo`, the mode switch, signing out — and a notification hooked into
each is a notification somebody forgets to add to the thirteenth. It watches the
cards instead: a `ResizeObserver` for the height, a `MutationObserver` on
`hidden` for a card reopened at exactly the size it had before, and a capturing
`load` listener for the case that caught this out in testing. `ResizeObserver`
reports a picture arriving only when the browser next runs its rendering steps,
which in a tab that was not being painted left the published height 350 px stale;
an image saying it has loaded is not subject to that.

## The button that says where you are

MapLibre draws its geolocate control as a crosshair and a dot — a *target*, the
symbol for aiming at something. Every phone map draws an arrow instead, because
the question is which way you are pointing, and an arrow is the shape people
already read without being taught. So the icon is replaced: `background-image:
none` on the element that carries it, and the arrow supplied as a **mask** so one
shape can be filled or outlined and takes its colour from `currentColor` rather
than from the `invert()` filter the raster icons need.

**Hollow when the map is not following you, solid when it is.** That is the whole
signal and deliberately the only one — the colour stays the ink of the map
underneath, white on the dark basemaps and near-black on the light one. MapLibre's
own answer is to turn the icon blue, which across five basemaps is five different
amounts of legible, and which spends a colour on a control that is not about your
data. The three states are its classes: `-active` while the camera is locked to
your position, `-background` once it has let the camera go but is still watching
(hollow again — it is no longer following), and `-waiting` while it is asking.

**Pressing it while it is already following you must not delete you.** Both
libraries' tracking control is a three-state toggle — off → locked → (pan away) →
background → off — so two presses without moving turn tracking off and take the
blue dot with it. That is never what "show me where I am" was asking for, and on
screen it reads as the button erasing your own location. `keepGeolocateOn` takes
the locked→off press and re-centres instead; background→locked is the control's
own re-centre and is left alone.

**It listens on the document, because the button may not exist yet** — and that
sentence is the whole of why this was fixed once and was still broken on the 3D
basemap. MapLibre builds its control's UI inside `onAdd` and checks the
permission afterwards, so a `querySelector` in the same tick as `addControl`
finds the button. Mapbox GL JS does it the other way round: `onAdd` returns an
empty container and `_setupUI` runs behind an async permissions check. The
original version attached its listener to the button it had just looked up, found
nothing on Mapbox, and returned — silently, because "no button" is
indistinguishable from "nothing to do". Delegating from the document asks nothing
about when the button was made, which is the only part of it either library ever
promised. `dropLockOnZoom` had the same hole and is fixed the same way, by
looking the button up inside its handler rather than beside the `map.on`.

The press is stopped in the **capture** phase. The control's own handler sits on
the button itself, and `stopPropagation` on the way down keeps the event from
reaching the target at all — `stopImmediatePropagation` is not needed and would
be a claim about listener order this has no business making.

### The dot glides, because a fix is a report and not an instruction

Both libraries do the same thing with a fix: `_updateMarker` calls `setLngLat`
with it and the dot is somewhere else on the next frame. Standing still that is a
twitch — GPS in a city moves ten or twenty metres between fixes with the phone
face down on a table — and walking it is a hop a second, which describes walking
worse than a straight line would. `src/glide.js` treats the fix as what it is,
*where you were a moment ago*, and moves the dot towards it over the time the
next one is expected to take. It is the interpolation every multiplayer game does
with the positions it is sent, for the same reason: the samples are late, sparse
and truthful, and the thing on screen has to be continuous.

**The duration is the previous gap**, floored at 250 ms and capped at 2 s, so the
dot arrives as its successor lands and the motion never stops. The easing is
**linear**, deliberately: an ease-out decelerates into every fix and starts again
at the next, which turns a steady walk into a series of arrivals. Past a
**kilometre** it does not glide at all — a kilometre is an hour's walk, a
minute's drive and three seconds of a passenger jet, so nothing that is genuinely
travelling crosses it between two fixes, and the things that do (the first fix of
a session, a phone that has just found the satellites, a laptop that woke up in
another city) should appear where they are rather than sail across the map.

**The wrapper calls the original first and then undoes half of it.** The original
is what adds the markers, takes them off for a null fix, and re-sizes the
accuracy circle — all wanted. Only the position is overwritten, put back to where
the dot is currently drawn, *synchronously in the same tick*, so no frame is ever
painted with the jump in it. Both libraries' `Marker.setLngLat` writes the DOM
without deferring, which is what makes last-writer-wins enough.

**The camera is the other half, and it is not optional.** While the control is
locked on you it re-centres on every fix, and it does that with `fitBounds`,
which is a `flyTo`: a swoop, once a second, computed for a journey of fifteen
metres — and it re-fits the *zoom* to the accuracy of the fix each time, undoing
where you had zoomed to. A perfectly smooth dot under a lurching camera is not a
smooth dot. `smoothLocationCamera` eases linearly with the same duration instead,
so the ground slides under a dot that stays put, and leaves the zoom alone. The
one thing it must not swallow is the *arrival* — the press that re-centres on
you, and the first fix of a session — which is meant to be seen and is what
`fitBounds` is right for. Told apart by distance **in pixels**, against the
shorter side of the window: what makes a camera move feel like a jump is how far
across the window it went, which is a question about the zoom as much as about
the ground.

The move carries `{ geolocateSource: true }`, and that is load-bearing. Both
libraries watch their own map for movement and drop out of tracking when they see
some unless it carries that flag, so following you would otherwise switch
tracking off a second after it started.

Like `dropLockOnZoom` and `matchMapboxRotation`, this reaches inside the library
and so reads before it writes: a renamed `_updateMarker` costs the dot its
smoothing, which nobody will notice, and never the dot itself, which everybody
would. `scripts/test/glide.mjs` drives it with a hand-cranked clock and frame
queue.

## Asking the ground to be quiet

**Tap for details**, under the layers menu's Photos row, and on by default.
Tapping a cell or a region for what it knows is what this map is *for*, which is
the opposite default from the railway's equivalent switch and for the opposite
reason — the railway is somebody else's reference data laid over your map, and
this is your map.

What it costs is that reading the map with a finger opens a card every other tap,
and there was no way to say "I am just looking". Switched off, the ground stops
answering: no cell card, no region card. A tap there is spent closing whatever is
open, which is the useful half of it and better than a tap that does nothing.

It governs **the ground only**. A saved route, a photograph, an airport and a
railway all keep answering, because each of those is something you aimed at
rather than the ground you happened to touch.

## How sharp a region is

The overview boundary set is what gets drawn until the detailed per-country
boundaries arrive at `REGION_FINE_ZOOM`, and for a long time it was built for a
question rather than for a picture: a region is only ever asked "is this cell
inside you?", a cell is ~900 m across, so a kilometre of slack costs no
correctness. It costs a great deal of appearance. Two decimals put every vertex
on a ~1.1 km grid and `SIMPLIFY_MAX_DEG` allowed 6.6 km of deviation on top,
which is a bay missing from a coastline — and the clamp spent that budget
precisely on the large, familiar regions whose outlines anyone would recognise.

Three decimals (~110 m) and a 3.3 km clamp take a Swiss canton from 19–36 points
to 31–53, the whole set from 133k points to 207k, and the file from 2.5 MB to
4.0 MB. It is a lazily-loaded, immutably-cached chunk, which is what makes that
trade worth making; all three numbers are constants at the top of
`scripts/build-regions.mjs`, so the next person to disagree can rebuild.

The build is reproducible: at the old constants it reproduces the previous file
byte for byte.

## A clock left running

Both ends of a route's span are real timestamps, so nothing upstream can tell
they are wrong — but a recording that was never stopped keeps counting. Two real
Komoot tours claim 596 hours for 20 km and 163 hours for 11.5 km, and between
them they were contributing **759 of the 956 hours** the statistics said had been
recorded. "Time recorded: 916 h" is not an approximate answer, it is a wrong one.

`recordedSeconds` is the single answer to "how long did this take", used by the
route card, the route list and the total alike. It returns 0 — the same thing an
undated route returns — when the span implies moving slower than
`ROUTE_MIN_SPEED_KMH`. Covering twenty kilometres at 0.03 km/h is not slow, it is
stationary. The floor sits ten times below the slowest genuine outing on the same
map (a 1.2 km/h walk with stops) and seven times above the worst glitch, so
neither side is anywhere near it.

At import, Komoot's own `duration` is now preferred over the last coordinate's
offset. The duration is the tour's answer to the question; the last coordinate is
a guess at it, and one stray fix — a phone waking up days later — ruins the
guess. Nothing rewrites what is already stored, so the two bad rows keep their
timestamps and are simply not counted.

## The same ride, recorded twice

A route's identity is a hash of its own simplified geometry plus its dates. That
is exactly right for "you already imported this file" and no use at all when two
apps watch one afternoon: Komoot and Strava produce different point streams,
which simplify to different lines, which hash to different keys. Both rows are
legitimate, distinct data about one ride — so the map drew the line twice,
listed it twice, and counted its kilometres twice. On a real map, 81 rows were
70 outings and 342 km of the 1,779 km total had been ridden once.

**The start time carries it.** You cannot begin two rides in the same minute,
and in practice the two clocks agree to within seconds. `DUP_START_SEC`,
`DUP_LENGTH_TOL` and `DUP_BBOX_IOU` are set from what the real pairs look like
rather than from what felt safe, and are still nowhere near loose enough to fuse
two outings.

### A ski day is not a run

A *flat* start gate is the wrong shape, and the ski days are where that showed:
thirteen of them sat in the list twice, each as an Apple Health row beside a
Strava one, because the two starts were minutes apart rather than seconds. An
hour's run is two apps started with the same thumb — every such pair on the map
agrees to within thirteen seconds. Six hours on a mountain is a watch started at
the first lift and a phone remembered somewhere on the way up: six real pairs
start between 5 and 20 minutes apart, and two minutes hid all of them.

So the gate scales. Measured as a fraction of the *shorter* of the two
recordings, every duplicate on a real map lands under 5.9% and the closest thing
that must **not** fold — two walks round the same block on one afternoon, 2%
apart in length and in the same place — sits at 257%. `DUP_START_SPAN` is a
tenth: 1.7× clear of the first, 26× under the second, the widest margin any of
these numbers has.

It only ever loosens things for long outings, which is where it is safest — at a
tenth, two recordings that fold necessarily overlap by nine tenths of the shorter
one, and you cannot have been on two outings at once. The span comes from
`recordedSeconds`, which hands back 0 for a clock left running, so those rows
drop back to the flat floor instead of being granted a week of slack.

Three signals are deliberately *not* used to decide **whether** two rows are one
outing, each because the real data says so:

- **the end time**, and any overlap computed from it. One real Komoot row claims
  a 9,802-minute ride for what Strava recorded as 110 minutes. The end of a tour
  is not a clock. (`recordedSeconds` above is not an exception: it scores exactly
  those rows 0.)
- **the activity.** The same walk came back as *Walking* from one app and
  *Hiking* from the other.
- **the source.** The obvious duplicate is Komoot against Strava, but the same
  map holds Strava against Strava — gating on a difference would miss exactly
  the pair that prompted this.

**Which copy survives** is `preferredRoute`, ordered so the answer is identical
on every device and every reload. Which app it came from leads — `SOURCE_RANK`:
**Komoot, then Apple Health, then Strava**. Komoot because a Komoot route opens
on Komoot and no amount of Strava data turns into that; Health above Strava
because Health is the watch's own record of the day and Strava is a copy of it,
and because a Strava row can be edited after the fact while the workout it came
from cannot. Only those three are ranked: they are the ones that actually
produce duplicates, and a source this app has no opinion about should fall
through rather than be guessed at.

Below the source, deciding between two rows of the same app and between two
unranked sources: a link, then a recorded activity over one this app guessed from
the speed — which is what separates the two Strava rows that are the same run —
then known ascent, then more points, then the older row. On a real map of 393
routes that chain folds 78 rows away: 46 Apple Health rows over Strava, 11 Komoot
rows over Health.

**Folded flat, not into a chain.** Four copies of one ski day are matched
pairwise, and pairwise the second can land behind the third before the third
lands behind the fourth — which hides the right rows but records the first as
standing behind a row that is itself hidden. A pass at the end of
`duplicateRoutes` walks each answer through to the row still standing. There are
no cycles to guard against: a route is written into the map at most once and
skipped from then on, so every chain ends at a key that isn't there.

**Derived, never stored.** It is a fact about the data rather than a judgement
about it, so `duplicateRoutes` runs whenever the list changes; a tour imported
next year folds against what is already there without anyone deciding again.
The fold applies to the drawing as well as the list, or the second line would
still be on the map with nothing admitting to it — and the Routes tab says how
many are folded and offers them back, because silently dropping a route someone
remembers importing is the failure this dialog exists to avoid.

## A finger on a panel

Five things a phone does to a panel that a desktop does not, all fixed centrally
rather than per-dialog.

**A second press is not a double-tap.** Pressing any button twice quickly — the
arrows either side of a month, a segmented control being cycled through — zoomed
the whole app and left it zoomed, because a browser cannot tell an impatient
press from a request to magnify the page unless it is told. `touch-action:
manipulation` on `html` and `body` gives up that one gesture and nothing else:
panning and pinch-zoom are untouched, and it is intersected down the ancestor
chain, so one declaration covers every control on the page. The map keeps its own
double-tap zoom, because that one is MapLibre's handler rather than the browser's
— the canvas container sets `touch-action: none` and does the gesture itself.
Both `html` and `body` carry it: inside the iOS app this page is a web view whose
host can reach either.

**A dialog taller than the screen had nowhere to go.** `.modal-card` had a width
cap and no height one, and Settings is a dozen rows, a token field, a sources
list and a danger zone: on a phone it came out about 900px tall in 750px of
overlay. The overlay is `position: fixed`, so what hung off the top and bottom
could not be reached by scrolling the page either — the version line and the
delete button were not below the fold, they were unreachable.

The cap is `max-height: 100%`, which is the overlay's content box with its
padding already taken off, plus `overflow-y: auto` and the `min-height: 0` that
lets a grid item shrink below its content at all — the same clause, on the other
axis, as the `min-width: 0` that stopped the routes tab hanging off both edges.
It goes on **every** dialog rather than on Settings, because any of them can
outgrow a short window and a card that scrolls only when it has to is invisible
until it is needed. The rail is hidden, as it is on `.menu-scroll` and
`.ha-scroll`: a track down the inside edge of a glass card reads as a seam in it.
Inner lists still scroll first and hand over when they run out, which is the next
paragraph, and which needed nothing new — the walk up the tree simply finds one
more scroller now.

**A touch scroll belongs to the scroller it started in, for the whole gesture.**
That is iOS, and it has no `overscroll-behavior` to turn it off — reach the end of
an inner list and the finger simply stops working, because the panel behind it
does not take over the way a wheel does on a desktop or the way Android's
chaining does. Every settings panel here is a scrolling column with scrolling
lists inside it, so a list of two hundred countries was a wall: you could not get
past it without lifting your finger and finding one of the few pixels that were
not the list.

`src/scroll-chain.js` does the hand-off by hand. The inner scroller is left alone
for as long as it can still move — that is the browser's own gesture and it does
it better — and the moment it runs out, the same finger travel is applied to the
first ancestor that *can* move. The decision (`canScroll`, `pickHandoff`) is kept
out of the DOM so it can be tested without a phone; only the walk up the tree
needs a real element.

It arms **per gesture**, on `touchstart`, and only when the touch started inside a
scroller that has another scroller above it. A permanent non-passive `touchmove`
on the document would opt the whole page out of the browser's fast-path
scrolling — a real cost on every scroll, paid to fix the few that start inside a
list. The map is untouched by construction: its canvas has no scrollable
ancestors, so the chain is empty and nothing arms.

**A `<select>` is not a text field.** iOS zooms the page in when you focus a
control whose text is smaller than 16px and leaves you there, which is what made
the login field lurch as you typed; the usual answer, `maximum-scale=1`, kills
pinch-zoom permanently and on a map that is a much worse trade. So the controls
are sized at 16px on touch devices instead — but that list had `select` in it,
and a select opens the system's own picker rather than a keyboard and a caret, so
it never triggers the zoom in the first place. All it did was set every picker a
size larger than the label it answers to, which is what made them shout over the
rest of the panel. They are sized to their label now; the weight is what makes
them read as the answer rather than the question.

**The tap that closes the layers menu belongs to the menu.** On a phone the menu
is a sheet over the map, so tapping the ground beside it means "put this away"
and never "mark that cell" — the map is told to let that one tap go by. The
subtlety is *when* that is decided. MapLibre listens for `click` on its own
canvas container, which is a descendant of the document, so the map's handler
runs **before** the document-level click-away handler that was raising the flag:
the dismissing tap marked a cell, and the flag then sat there and swallowed the
*next* tap instead. One tap did the wrong thing and the one after it did nothing,
which is why it read as intermittent rather than as always broken.

It is decided on `pointerdown` now, in the same capture-phase listener that
already records whether the press landed inside the menu — before any of it, and
before the menu has had a chance to move under the finger. Assigned on every
press rather than only raised, so a gesture that never becomes a click (a pan, a
pinch, a tap on the sheet itself) cannot leave it standing for something later.

### Clicking away, and the drag that only looks like it

**A `click` is dispatched on the nearest common ancestor of the press and the
release**, not on whatever the pointer was over when the button came up. That one
line of the DOM spec closed every dialog in this app at the wrong moment: select
a sentence inside a card, run the cursor past its edge and let go, and the
browser reports a click on the *backdrop* — a click nobody made, on an element
nobody pressed. Sixteen dialogs read that as "you clicked away", shut, and took
the selection with it. The colour picker did the same thing to its hex box.

Two places had already met it and answered it locally, which is the tell that it
wanted a file rather than a third copy: the image export, whose sliders end their
drags outside the card, and the layers menu above. `src/dismiss.js` is that file.
`onClickAway(node, outside, dismiss)` records the verdict on a capture-phase
`pointerdown` and confirms it on the click — **both ends must be outside**, and
one end inside is enough to keep the thing open. That is not a heuristic about
intent; it is the only reading under which the press and the click describe the
same gesture. `onBackdropClick(overlay, close)` is the modal shape of it, and is
what all sixteen now call.

The flag is cleared on every click whatever the verdict, because a press left
standing would be answered by whatever came next — the same failure the layers
menu's `dismissedMenuOnTap` had to be assigned rather than raised to avoid. A
click with no `pointerdown` behind it (Enter on a focused button) dismisses
nothing, which is right: nobody pressed the backdrop.

The layers menu keeps its own copy deliberately. It settles a third thing in the
same listener — MapLibre's click ordering, above — that has nothing to do with
dismissal, and folding it in would make both harder to read than either.

`scripts/test/dismiss.mjs` covers it with a fake `EventTarget` rather than a DOM.
The rule is entirely about which of two events is trusted, and a real DOM would
not synthesise the common-ancestor behaviour for the test anyway — the test has
to state the sequence it is describing either way.

## Chrome over a photograph

Under a vector basemap the ground is a palette we chose, so one set of glass
colours works everywhere on it. Satellite imagery is whatever the satellite saw
— a lake, a forest, a snowfield — and white-on-glass reads on the first two and
disappears on the third. No fixed choice survives panning across all three, so
the map is asked what is underneath and the chrome answers.

**The basemap's own word comes first; the reading only corrects it.** Sampling
cannot answer quickly — the pixels mean nothing until the new map has painted,
which is a couple of seconds of tiles away, and until then the menu sat in the
old basemap's colours. That was the lag you could watch. But every basemap
already declares whether it is light or dark; that is where `data-theme` comes
from, and it flips on the same tick as the click. `presumeChrome` makes the
chrome flip with it — about a millisecond — and leaves the reading to correct
the guess for the one case a declaration cannot cover: imagery, which is
nominally dark and is a snowfield often enough to matter.

**The guess is protected until the basemap it is a guess about is on screen.**
Otherwise the correction arrives before the thing it is meant to correct.
`styledata` fires while the chosen basemap has parsed and none of its tiles have
landed, so a reading taken there is a reading of the map on its way out:
switching Light → Dark took the chrome dark on the click and a reading of the
departing light map put it straight back, where it stayed until the settled
reading a second later. Measured, that was `data-chrome` going dark at 0 ms,
light at +1052 ms and dark again at +4006 ms — the lag this mechanism exists to
remove, arriving by its own hand. So `applyChromeContrast` returns early while a
presumption stands, and `idle` lifts it: every tile that was coming has come, so
what is under the menu is what the guess was about. `CHROME_PRESUME_MS` is the
backstop, because a basemap that never finishes loading never sends an `idle` —
and satellite is both the likeliest to hang and the one that needs the reading
most, so protecting the guess for good would trade a one-second flicker for
imagery with no contrast correction at all. Two flags rather than one: `idle`
also fires in the gap before a *built* style has been fetched, and that idle is
still the outgoing basemap, so the lift also waits on the chosen style's
`style.load`.

**The pixels are read inside a render.** The drawing buffer is only valid within
that callback unless the map is built with `preserveDrawingBuffer`, which costs a
copy of every frame to serve a question asked a few times a minute. So
`refreshChrome()` marks a reading as due and the `render` hook takes it: a small
square at the middle of each floating control, every fourth pixel, weighted
Rec. 709 — a plain mean calls a saturated blue lake as bright as a beach.

**Two thresholds, not one.** `CHROME_LIGHT_ENTER` and `CHROME_LIGHT_LEAVE`
straddle the decision, because a single one makes the chrome flicker between
colours while you pan along a shoreline, which is worse than either colour would
have been on its own.

**The palette is the same glass as the menu.** It used to be its own material —
`rgba(24, 26, 32, 0.86)`, a near-opaque slab with more blue in it than red — so
opening it read as a colder, darker app arriving on top of the map rather than a
panel of the one already there. It is a white veil over the map now, exactly as
the menu is, and it joins the luminance sample when it is open: it covers the
middle of the screen, and a bright valley there under a dark corner by the
buttons would otherwise leave it wearing white text on a pale card.

**It reuses the light theme rather than inventing one.** `[data-chrome='light']`
mirrors the light basemap's own chrome values, scoped to the surfaces that float
over the map and to nothing else — a dialog has an opaque background of its own
and has never needed this, and the search palette is dark glass over a dark
scrim, which is why it was never the one that failed. Selectors shared with
dialogs (`.seg`, `.seg-btn`) are scoped under `.layers-menu` / `.hud-panel` so a
bright mountain cannot reach into the statistics dialog.

**Everything about it is best-effort.** A WebGL context that will not give up its
pixels leaves the chrome exactly as the basemap's own theme set it, which is the
answer that was right before any of this existed.

## Dates with no year in them

"October 15" is a question about every October 15 you have, not one arbitrary
one. `parseDateQuery` answers it with ISO 8601's own notation for a date without
a year — `--MM-DD`, and `--MM` for a bare month — and the palette lists the years
that have something on it rather than opening a calendar, because a calendar can
only stand on one month.

The strictness is the point. A month has to be spelled out: `10 15` stays
ambiguous forever and reading it as a date would swallow every text search that
contains two numbers. An abbreviation counts only when exactly one month starts
that way, so `ju` is no month at all rather than quietly meaning June. Order
does not matter — `october 15`, `15 october`, `2025 october 15` and
`October 15, 2025` are all read — because the thing that disambiguates is the
word, not the position.

**A bare month falls through to the rest of the search.** March is a town and
May is a name, so `--MM` lists its years *and* then searches places, routes and
trips as usual. `--MM-DD` does not: nothing is called "15 October".

## The pin a place search drops

Asking where Venice is and being shown a card about the ground beside it is two
answers to a question asked once. So the pin is the whole answer, and the next
tap on the map is the whole of putting it away — that tap selects nothing,
opens nothing, and falls through to nothing. Panning never reaches it, because
MapLibre tells a drag from a click, so the pin survives being looked around.

It is drawn like the house and for the same reasons — one image the style owns,
stroked white-then-dark so a thin outline reads on any basemap — but as a
teardrop anchored at its tip, because it answers a different question and points
at a spot rather than occupying one. It sits below home in the stack: home is
what you navigate *from*, and it should never be the thing that vanished under
an answer.

**A pin is for a place, and a region is not a place.** See below.

## Searching for a region

A canton picked out of the search box is outlined on the map and described in
the same card a tapped one gets — not marked with a pin. The difference is not
presentation. A pin needs a coordinate, and the only coordinate a region has for
free is the middle of its bounding box, which for anything that is not a
rectangle is *not inside the region at all*: the middle of the United States'
box is in Puget Sound, Hawaii's is open ocean between the islands, and Norway's
is dragged 300 km north by Svalbard. So the answer to "where is Zürich the
canton" was a marker somewhere near it and nothing whatever about it.

What made this a two-line change is that both halves already existed and neither
could be reached from here. `searchRegions` returned a name, a country and a
bbox, and deliberately dropped the `id` — so the caller held the only thing the
map cannot draw a shape from. It returns the id now, and `showSearchedArea` in
`src/main.js` hands it to the same `showAreaInfo` a tap goes through: same
outline, same card, same numbers.

Two things had to give way for that.

**`storedInArea` reads `visited`, not the memo.** The per-cell area memo is
filled as a side effect of *building a vector level's shapes*, so reading it back
only ever worked for an area you were already looking at. A region picked out of
a search box is usually one you are not — the card came up saying you had never
been to the canton you live in. It walks `visited` through `areaOfCellMemo`
instead, which answers from the memo when it can and fills it when it cannot: the
first search pays the ~100 ms sweep the level would have paid anyway, and every
one after it is a map lookup per cell. Same answers, and now they do not depend
on where the camera happens to be.

**The framed box carries its east edge past 180° when it has to.** A boundary
that crosses the antimeridian comes out of the dataset with its east edge *west*
of its west edge — Russia's is `[19.6 … 180]`, Chukotka's and Fiji's the same
shape. Read literally that is the whole globe minus the country, and `fitBounds`
frames exactly that, the long way round.

There is no `lastInfoLngLat` for a searched area, and that is deliberate: nothing
was tapped, so there is no point on the map for a later zoom to re-resolve
against, and a stale one left over from an earlier tap would answer that zoom
with a different shape than the one on screen.

**The shape is drawn at the highest resolution there is, and fetched if it isn't
here.** The map's own boundaries drop back to the overview set when zoomed out,
because tiling 7,000-point cantons to draw them four pixels across is waste. This
is one shape, drawn because somebody asked to look at it, and the straight line
the overview cuts across the lake the border actually follows is the thing they
would be looking at — so `selectionFC` always asks for the fine geometry, and
`showAreaInfo` calls `fetchFineRegions` for the country behind it and redraws
when it lands. That is the same one-country-at-a-time fetch the region zoom
already does (`considerFineRegions`), now shared: same request, same ring at the
top of the screen, same redraw. Never twice — `fineCountryKnown` remembers
failures as well as successes.

**Regions and countries are the first section, not the third.** They are the
answers most easily mistaken for something else in a list, and the smallest
section, so anywhere but the top buried them under a dozen trips. Order is now
regions and countries, trips, routes, places — places still last, because the
gazetteer is big enough to bury four real answers under eight villages. Enter
with nothing highlighted therefore opens the canton, which is the point.

**And each is labelled with what that country calls it: `Canton Zürich`.**
"Zürich" is a canton, a city, a lake and an airport, and the four are
indistinguishable in a list unless something says which is which — the grey line
underneath was saying it, and a caption you have to look for cannot be what
distinguishes two rows carrying the same word. The card agrees: `Canton in
Switzerland · 1,739 km²`.

`REGION_TERM` in `src/regions.js` is deliberately short, and the rule for being
in it is strict: the word has to be right for **every** unit the dataset holds
for that country. That is why the obvious entries are missing. Canada is ten
provinces and three territories, the United States fifty states and the District
of Columbia, Spain fifty provinces and two autonomous cities, and the United
Kingdom's 232 units are councils, districts and boroughs at once. Calling Nunavut
a province is a worse answer than calling it a region, so those countries take
the default — which is `Region`, and is also literally correct for a good many of
them: Italy's regioni, Chile's regiones, Czechia's kraje, Denmark's regioner.

## Tapping a region

At the three vector levels there are no hexagons on screen, so a tap is about the
shape it landed on rather than about the 83 km cell underneath it. The card is
the same one a cell gets, because it is the same question asked of more ground —
when was I here, how often, and where does that come from — with the two answers
only an area can give: how much of it you have been to, and how much of it there
is. A continent adds a third — **how many of its countries you have been to**,
`3 of 50` — as a row of its own above the ground covered, not as a decoration on
the line that names what was tapped. The two are different measurements and want
comparing: crossing the top of Africa by road is a rounding error of its ground
and four of its countries, and a year in Luxembourg is the other way round. It
was briefly in the subtitle beside the word "Continent", where it read as *what
kind of thing this is* rather than as a number about it.

**The area is resolved from the point, not from the hex.** `areaAt` runs
`countryNear`/`regionNear` on the tapped coordinate, so a tap near a border gets
the shape it actually landed on. The *cells* it counts come from
`cellRegionMemo`/`cellCountryMemo`, the same per-cell lookup the fill was built
from — so the card can never disagree with what is painted, and every cell it
counts is genuinely inside the shape it names. A country the dataset never
subdivided uses the same `WHOLE_COUNTRY` stand-in the fill does, for the same
reason.

`storedInArea` walks `visited` rather than the memo, filling the memo as it goes
(see [Searching for a region](#searching-for-a-region) for why). The memo is
never invalidated by an edit — a cell centre never moves, so its answer is good
forever — which means an erased cell keeps its entry, and `visited` is what must
decide whether it still counts.

**A shape you have never been to still gets a card.** It used to fall through to
the cell card, which found nothing and closed, on the reasoning that an empty
fill already says "you have not been here". It says that and nothing else. How
big Kazakhstan is, that you have been to none of it, and that Asia is 54
countries of which you have seen three are all answers, and the second is only
worth having next to the first. A tap that does nothing is also indistinguishable
from a tap that missed, which at this zoom — where a country can be four pixels
wide — is a real question the map was refusing to answer.

The fall-through survives for the **open sea**, where `areaAt` finds no shape at
all: there the cell card takes over, finds nothing, and closes. That is still
right, because there is nothing there to describe.

The card says `None yet` rather than `0.0 km² · 0%` for the ground covered.
Zero is the answer, but printed as a measurement it reads like a rounding of one.

**Ground covered is measured per cell, at its own latitude.** The grid is
Mercator, so a cell's ground area shrinks with `cos²(lat)`; summing a constant
would tell someone in Tromsø they have covered twice what they have. The share
is against the region's own polygon area, and the scale keeps adding decimals
until it runs out and then says `<0.01%` — a country you crossed once is a
fraction of itself, and "0%" is a wrong answer rather than a small one. The
first version refused to print any share under 0.05%, which is above the real
answer for most countries: France (0.031%) and Spain (0.014%) showed a number of
square kilometres and no share at all. `scripts/test/coverage-scale.mjs` pins
every band, including that each one is reachable — an unreachable threshold is
exactly how that got in.

**The selection highlight is the region's own border**, not the hex ring a cell
gets, so it says which shape was picked rather than merely where.

**Drawn in white over near-black, and in nothing the accent has a say in.** Both
selections — a cell's ring and a region's border — used to be tinted 75 % toward
white from the accent, and the tint was the problem rather than the fix. A
selection is not a colour the map is saying something with; it is the answer to
*this one*, and it has to read over the accent-coloured wash, over pale green
fields and over a photograph. Following the accent meant it disagreed with the
wash it was drawn on by a few percent of lightness and disappeared into it, and
pinning it near-white so it wouldn't left a hairline nothing could see over a
bright basemap. The casing (`sel-halo`) is what buys the visibility, so the white
line itself stays as fine as it ever was — the same trick, and the same reason,
as the house and the place pin being stroked white-then-dark.

## What "Most visited" is measuring

The ramp answers *how often were you around here*, and getting there took
undoing three separate ways it was answering something else.

**An area used to be decided by the centre of a hexagon it wasn't in.**
`buildAreaFC` resolves each visited cell to a country or a region with one
point-in-polygon test, and it used to run that test not on the cell but on the
hexagon the cell had been rolled up into — first `MAX_LEVEL` (83 km), then
`REGION_FROM_LEVEL` (9 km). Rolling up was a saving: two thousand tests instead
of twenty-three thousand.

It was also wrong, and going from 83 km to 9 km only made it wrong less often.
Whatever the size, one centre decides for every cell underneath it. At 83 km, of
1,774 arrivals recorded in Slovakia **exactly one** was painted onto Slovakia and
the rest onto Hungary and Austria, so a country visited five times rendered as
the emptiest place on the map; Switzerland leaked 2,347 arrivals into France the
same way. At 9 km the countries came good — 8,713 misattributed arrivals down to
176 — but regions did not, because plenty of regions are *smaller than the
hexagon deciding for them*. Appenzell Innerrhoden is 172 km²; a level-2 hexagon
is about 60 km² and its centre lands inside the canton while its cells sit in
Sankt Gallen. A real map lit it, and its card reported "3 visits", off seven
cells that were every one of them in Sankt Gallen. Liechtenstein's Mauren and
the Aosta Valley went the same way. The statistics panel — which has always
resolved per cell — listed none of the three, so the map and the panel gave two
answers about the same rows and the panel was the right one.

**So there is no roll-up any more, and one function answers for both.**
`areaOfCell` in `src/stats.js` takes a stored cell id and returns the country or
region it is in; `buildAreaFC` and `computeStats` both go through it, which is
what makes "lit on the map" and "counted in the panel" the same set by
construction rather than by two implementations agreeing. `scripts/test/area-attribution.mjs`
pins that, and pins the Appenzell case from both ends.

The saving that motivated the roll-up turned out not to be needed. The note it
came from predates both the region tile index and passing the already-resolved
country into the region lookup, which together drop all but a couple of dozen of
the 4,484 shapes before any geometry is touched. Measured on a 23k-cell map: 115
ms for the first build at the region level, 1.1 ms for every build after it,
because the answer is memoised per cell id and a cell centre never moves. The
polygon union in `mergeRegions` costs more than either.

The lookup is `countryNear` rather than `countryAt`, so a cell centred in a bay
belongs to the land beside it instead of to nowhere. `computeStats` keeps
`countryAt` for its own country tally, because it has a second question to
answer — how much of what you covered was *sea* — and "near land" is the wrong
answer to that one.

**A cell is read with its surroundings** — see `HEAT_NEIGHBOURHOOD`. `hits`
counts arrivals inside one 1 km hexagon, and going back to a city lands on a
different street rather than the same hexagon, so five visits produce five cells
seen once rather than one cell seen five times. 85% of a real map's cells sit at
exactly one arrival, and `log(1)` is zero however the scale is drawn: the finest
level was almost entirely floor. Reading a cell together with the average across
the hex two levels above it separates *seen once in the middle of a city* from
*seen once on a motorway*, which is the distinction the mode exists to make.

**The hot end is a percentile, not a maximum** — see `HEAT_HOT_PERCENTILE`. One
cell at home can hold four orders of magnitude more arrivals than anywhere else,
and measured against it the entire rest of the world sits in the bottom fifth of
the ramp. Pinning the top at the 98th percentile and clamping past it takes the
share of the map above the first third of the ramp from 2% to 18% at the finest
level. Everything above the pin is the hottest colour, which is the honest
answer — past a point, "more" stops being a distinction worth a shade.

**First seen had the same disease and needed a different cure.** It ran a
straight line from the earliest date on the map to the latest, and dates are not
spread evenly along their own span: one photograph from 2014 owned the far end of
a real map's scale, and **61% of its 7,631 dated cells landed in the last of the
seven ramp colours**. The middle half of the data covered 19% of the ramp, so two
cells a year apart were the same colour — a year being a twelfth of the span,
against four fifths of the ramp already spent on the 13% of cells older than 2023.

The obvious answer, bending the line with a logarithm the way `visits` does, is a
trap, and measuring it is what shows why: *how much* bend is right is a property
of one person's dates. Against the real map and six synthetic ones, scored by how
crowded the worst of the seven colours gets versus an even spread —

| | real map | uniform 5y | one summer | + ancient | two eras | growth | decade |
| --- | --- | --- | --- | --- | --- | --- | --- |
| straight line | 4.3 | 1.1 | 1.1 | 7.0 | 3.9 | 3.1 | 1.1 |
| logarithm, k=12 | 2.0 | 2.4 | 2.3 | 2.9 | 2.3 | 1.3 | 2.3 |
| rank (equalised) | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 | 1.0 |
| **rank 0.7 + line 0.3** | 1.4 | 1.0 | 1.0 | 1.4 | 1.3 | 1.3 | 1.0 |

— a fixed logarithm fixes the map it was fitted to and leaves evenly-spread maps
*worse than the straight line*, bending hardest where no bend was wanted. So the
scale is read off the dates themselves: `ageStopsOf` puts the distribution into
64 quantiles beside `hotOf`, and a cell's position is mostly its **rank** among
them (`HEAT_AGE_RANK`), which flattens any distribution by construction and needs
no constant. Where the dates are already even, rank and a straight line are the
same function — so this only acts where the straight line was failing.

It is not *all* rank because rank alone discards how far apart the dates are: a
map with an old import and a recent year would run smoothly across the six-year
hole between them as though the eras were adjacent. Keeping three tenths of the
straight line keeps a real gap looking like one. On the real map this takes the
worst colour from 4.3× to 1.4× and the middle half of the cells from 19% of the
ramp to 41%. The legend is unaffected: it labels the two ends with actual dates,
which is what lets the ramp between them be an order rather than a duration.
`scripts/test/heat-scale.mjs` pins the property rather than the numbers — no
distribution may end up worse than a straight line would have left it.

**It measures stays, and stays are what it should measure.** `hits` used to be
arrivals, so a weekend that recorded 1,700 fixes and five weekends that recorded
1,700 fixes looked the same. They no longer do: the five weekends are five
stays and the one weekend is one. What it still cannot separate is a long stay
from a short one — a fortnight somewhere and an afternoon somewhere both count
one — which is the question `fixes` would answer if `fixes` were trustworthy
across sources that sample at wildly different rates, and it isn't.

## A legend you can press

In the Type mode the legend is a list of every source on the map, which makes it
the one place where "what would this look like without Google Timeline" can be
asked. Each entry is a button: pressing it takes that source's cells off the map,
pressing it again puts them back (`toggleSource`, `hiddenSources`). A hidden
entry keeps its place in the list and its colour, drawn as a hollow ring instead
of a filled swatch — it is the only way back, so it cannot go anywhere.

It lives in `visited-map:hidden-sources:v1` and **not** in the account, unlike
the trips you put away. The two look alike and are not: putting a trip away is a
judgement about your history and should follow you to the phone, while this is a
way of looking at the map for a minute — the same kind of thing as which
colouring mode is on, which is also per browser. Move it into `prefsPayload` if
that turns out to be wrong; nothing else would have to change.

**It is not a deletion, and there is already one of those.** Export & settings →
Settings → Sources removes a source's rows for good — see [Taking a source back
off the map](#taking-a-source-back-off-the-map). This changes nothing that is
stored: the rows stay, the roll-up simply skips them.

**A cell is hidden by its dominant source** — the one that speaks for it in the
Type mode — so what disappears is exactly what was painted in that colour, and a
cell two sources vouch for stays as long as the louder one is on. `recomputeLit`
does the skip once and leaves the survivors in `visibleCells`, which is the same
Set as `visited` whenever nothing is hidden; `buildAreaFC`, the HUD's count and
the image export's accessors all read that rather than `visited`, so a country
nothing visible remains in is a country you have not been to as far as the
picture is concerned. `visited` stays the answer to *what have I got*, which is
what the statistics, the saves and the search read.

**The palette is handed out before the skip, not after.** `sourceOrder` is sorted
by how many cells each source accounts for, and if that tally counted only what
was drawn, switching one source off would renumber the slots and repaint every
*other* source a different colour. Counting first and skipping second is what
keeps the map still under the press.

**It applies in every mode, not only in Type**, and that is not the obvious
choice — the legend is the only place to set it, which argues for scoping it
there. The roll-up is what rules it out. `litSets` is one shared structure, and
`exportRollUp` rebuilds it in whatever mode the *export* is drawing: a filter
that switched itself on and off with the mode would then add or remove cells
from the live map the moment the export dialog asked for a Type picture over a
map showing First seen. One set of cells, always, is the only version of this
with no such seam in it. The cost is that in the other three modes nothing on
screen would say the map is incomplete, which is what the dot in the corner of
the **Type** button is for — it is also where the list to undo it lives.

The one shortcut that cannot survive a filter is `rollUpPainted`, which folds a
newly painted cell into the roll-up without redoing it: whether a cell is drawn
now depends on which source speaks for it, and that is only settled by the pass
over the whole set. It declines while anything is hidden, which is what its
return value is for.

**Editing with a filter on edits what you can see, and nothing else.**
`toggleCell` reads `litSets`, so a tap clears the cells stored under it that are
being drawn and leaves the hidden ones where they are — which is why they come
back when the source does. A tap on ground that *looks* empty but has a hidden
cell under it marks a new one rather than clearing the old, because it is
`litSets` that says the ground is empty. Neither loses anything, and the
alternative — clearing cells nobody can see — is the worse of the two.

## Two vector levels

Three of the levels are polygons rather than hexagons — regions, countries,
continents — and they have to hand over to each other. That is what `hex-prev` is
for, and two sources are all it takes however many such levels there are: a
crossing has exactly two sides. Until regions arrived `hex-prev` was a permanently
empty scaffold, because the outgoing side was always either the blob canvas or
`hex` itself. Adding continents on top of that cost one line —
`neighbourVectorLevel` learning that the country level has a different neighbour
each way, which is what the region level already had to know.

**Each vector source carries its own role**, and the two ramps read those rather
than assuming which surface is which:

| role | meaning |
| --- | --- |
| `in` | the live level, or the one fading in |
| `out` | the level fading out |
| `warm` | geometry pre-tiled for a crossing that hasn't happened, pinned invisible |
| `idle` | empty |

`applyFade` drives every `in` source and pins everything else; `applyPrevFade`
drives every `out` source. `blobRole` gained `off` for the crossing the canvas
has no part in — without it the incoming ramp drove the canvas back to full
strength underneath the polygons, which was only invisible because it happened
to have been cleared.

**Nothing is copied.** On a region → country crossing the outgoing level stays
exactly where it is and the *incoming* one is built on the other source — which
has to be parsed either way — and the two swap places. That is the whole reason
the old code refused to put geometry on `hex-prev`: copying the outgoing side
re-tiles what the map has already drawn, at the moment it is supposed to be
fading out smoothly.

**The live trio is restacked on top** (`raiseVectorLayers`), because `crossPrev`
derives the outgoing opacity on the assumption that the incoming layer
composites *over* the outgoing one. Swap the sources without re-seating that and
the composite sags in the middle of every crossing — the exact flash `crossPrev`
exists to remove. It is anchored to `trip-fill`, not to the first symbol layer:
everything inserted there after the two trios — the trip outline, the selection
ring — has to stay above the visited wash, and anchoring to `firstSymbol` lifted
the wash over both, so the trip you had just clicked disappeared under the
countries. `moveLayer` only reorders; it never re-tiles.

**Warming generalised.** `warmVector` pre-tiles the first vector level on the
live source while a blob level is showing (as before), and — new — pre-tiles the
*other* vector dataset on the idle source while a vector level is showing, so
the region ↔ country crossing is a pure opacity ramp rather than a fade racing a
parse. A source that has finished fading out keeps its geometry as `warm` rather
than being emptied: it is precisely the level one step back the way you came.

**What it is measured against.** A settled level must have something visible on
it, no level may have the blob drawn *under* its polygons, and the composite
must hold at the mode's alpha all the way across a crossing. Walking every
boundary in both directions gives 18 settled states; the composite through a
region ↔ country crossing holds at 0.30 from start to finish, in both
directions.

**One honest imperfection.** `crossPrev` holds the composite only where both
sides paint. Regions are a strict subset of their countries, so during a
crossing the ring where the country is lit and none of its regions are ramps
instead of holding. That is two genuinely different shapes arriving and leaving,
not a bug to be tuned out.

## Search

One field (`src/search-ui.js`, ⌘K) over three kinds of thing: a place to go and
look at, a route remembered by name, a day remembered by date. Place names come
from the dataset already shipped for naming routes, so nothing is sent anywhere.

**Ranking is one score, not position then size.** Ordering by where the match
sits in the name and only then by population puts a dozen Yorktons above New
York; ordering by size alone puts New York above York. So an exact name wins
outright, and after that each place scores its population with a
merely-contained match counted at a quarter — enough that eight million people
outrank a village that happens to start with the query, and not enough that
"bern" answers with Berlin.

**Every name is folded, by one function, in `src/fold.js`.** A search box is
typed on whatever keyboard is to hand and this map is full of names that want a
keyboard nobody has. Folding used to live inside `searchPlaces` and nowhere else,
which is a bug shaped exactly like a working feature: `zurich` found the town,
because the town dataset folded, and did not find the canton, the country, the
route or the fortnight you spent there, because none of the other four did. 659
of 4,484 regions carry a diacritic — Québec, São Paulo, Aqtöbe — and every one of
them was unreachable without typing the accent.

Two steps, and the second is the one that is easy to leave out. NFD strips the
accents off letters that *have* accents; it does nothing at all for the letters
that are their own letter rather than a marked-up one, so ß, ø, æ, ð, đ, ł, ı, ħ
and ə are spelled out by hand. Punctuation then collapses to a single space, so
`St.Moritz`, `St. Moritz` and `st moritz` are the same three syllables typed
three ways. Deliberately **not** ASCII-only: anything that is a letter or a digit
in any script survives, because a few dozen gazetteer names are Cyrillic or
Arabic and folding a script away entirely makes those places unreachable rather
than easier to type.

The folded gazetteer is built once and kept (`foldedNames` in `src/places.js`).
Folding is the expensive half of a search and the half whose answer never
changes — 96,000 calls to `normalize()` is a fifth of the frame budget, and it
was being paid again on every keystroke.

**Matching trips are ranked by relevance before anything else.** The trip list is
also the trips *browser*, so it has a sort of its own — newest, longest,
furthest — and when a query narrowed it that sort was still the only thing
deciding the order. A fortnight actually spent in Zürich came out below a weekend
in St. Moritz that had merely driven through it, and the list gave no clue why.
`tripRelevance` scores which field matched (the name it is called, then the town,
the region, the country, and last the tags recording everywhere it merely went)
and then how much of that field the query was. The chosen sort breaks the ties
underneath, and with nothing typed every trip scores 0, so it decides nothing.

**Dates are parsed strictly.** `2024-08-12`, `12.08.2024`, `August 2024` and a
bare year are read; `3/4` is not, because no amount of guessing fixes which
number is the day. A bare number that isn't a plausible year stays a text
search — reading it as a date would swallow every search containing a number.

**A month or a year is answered with its trips, not only with a grid.** Typing
`September 2023` used to open the calendar on that month and say *pick a day
below*, which is a complete answer only if you already know which day you want.
It is a poor one for a month and no answer at all for a bare year: a grid can
only stand on one month, and 2023 is twelve of them, so `2023` opened on January
and reported nothing. `addPeriod` now lists the trips inside the span, under the
same *Sort by* and *Filter by* controls the whole list carries — a year is
exactly the width at which "longest" and "furthest" become the interesting
questions.

`tripInPeriod` decides what "inside" means, and the answer is **overlap**: a trip
is a span, and the fortnight that started on the 28th of August belongs to
September as much as to August. Somebody typing a month is asking what they were
doing then, not which trips happened to begin in it. The comparison is on the
*prefix* of each end's day key, which is the whole reason dates are written
biggest-part-first — `"2023-08" <= "2023-09"` is true and `"2023-10" <=
"2023-09"` is not, with no arithmetic and no month lengths. Both ends go through
`dayKey`, the same function the grid keys its days with, so a trip cannot land in
one and not the other. `scripts/test/search.mjs` covers the fortnight that
crosses a month boundary and the New Year that crosses a year one, which are the
two cases a naive "which month is it in" gets wrong.

**The calendar is the app's own grid, not `<input type="date">`.** The native
picker is an opaque OS panel that cannot show which days have anything on them,
and that — *which weekend was that?* — is the only reason to open a calendar
here at all. Both ends of a cell's span light a day, since both are dates the
data actually carries; the days in between stay dark, because nothing says you
were there. A day separately reports how many cells were *recorded* and how many
were *new*, which are different questions.

**Every day leads somewhere.** Picking one lists the day itself as a row you can
follow onto the map, above whatever trip and routes it belongs to — see
[Showing one](#showing-one). Without that a dotted day was a dead end for
anything that wasn't part of a trip and didn't carry a route: the calendar could
tell you the day had ground on it and not show you the ground. Trips are drawn
across the grid as a single run of pills; see [In the calendar](#in-the-calendar).

**The grid itself lives in `src/calendar.js`, because it has two hosts.**
Browsing trips by name and browsing them by date is the same question asked
twice, and it used to be asked on two screens: the Trips tab listed trips, and
this palette listed them again with a calendar beside it. The Trips tab now
carries its own copy of both — a field that filters the list by anywhere a trip
went, and the same month grid. The palette keeps its own because it also answers
for places, routes and whole countries, which the trips list has no business
holding; what it no longer has is a monopoly on the calendar.

**Given the width, the two stop taking turns.** On a screen at least 720 px wide
and 560 px tall the palette is a row: the trips down the left, the month grid
standing permanently on the right, and the button that used to summon it gone —
a control that turns on something already on is a control that lies about what it
does. Narrower than that, nothing changes: the grid is a panel you open above the
answers, which is the only shape that fits a phone held upright.

Both dimensions are asked about, because two columns need both. Width alone hands
the layout to a phone held sideways, where the card is barely taller than the
month grid and the list beside it would have four rows in it.

The breakpoint is written twice, and that is the one thing to be careful of here:
`src/style.css` decides where the grid goes and `calPinned` in `src/search-ui.js`
decides whether it is open, and a palette whose two halves disagree shows either
an empty column or a grid nothing can reach. `openCalendar` therefore refuses to
close it in the wide layout rather than tracking a second flag, and `refresh`
stopped branching on the calendar being shut — in the wide layout it never is,
which quietly meant the list stopped re-rendering when the trips arrived.

**The list keeps two columns down each side, and a row moves between them.**
The outer one is the edge the section headings and the home card draw their
boxes on, 15 px in — the palette's gutter, which the magnifier, the close
button and the section headings stand on too; the inner one is 25 px, where the
home card's *text* sits. The card draws a 1 px edge of its own, so it is padded
9 px rather than 10 to land there. A heading sits on the outer column rather
than the inner one because it labels the block beneath it, and the block's own
edge is that column; indented to the inner one it floated between the two,
belonging to neither. At rest a row stands on the outer column at *both* ends; pointing at
one tucks the whole row in to meet the headings, and a trip's distance keeps
going past the inner column to make room for the × that puts the trip away. The
two ends carry mirrored values because they are measured from opposite edges.
All of it is transforms rather than padding, so nothing reflows.

That × is the reason any of this moves. In the flow it held a 34 px lane open on
*every* row to carry something invisible until you point at one, which pushed
every distance a third of an inch off the edge the rest of the list ends at. So
it is overlaid instead. Hidden, it also gives up `pointer-events`: an invisible
button lying across the tail of "1127 km away" is a thing you can plausibly aim
at and miss.

**The controls above the list are captioned, and grouping is one pill.** Two
rows of pills side by side are two questions, and which pill answers which is
not something a shape can say — so *Sort by* and *Filter by* say it. Grouping
lost its second side with the caption: "Flat" was only ever a name for the
absence of *By country*, and a segmented control containing its own off-switch
reads as two ways of grouping rather than one you can turn off.

## Colours with an opacity

Any colour the picker produces — the visited wash, and one per activity — can
carry an opacity, written as a fourth pair of hex digits (`#60acffcc`). Full
opacity is still written as six digits, so nothing already stored is rewritten
and nothing that hasn't been taught about opacity ever sees any.

**The opacity never travels as part of the colour.** Everything downstream takes
a colour *apart* — the blob painter's fill style, the route line mixes, the
region outline — and a fourth pair of digits read as one number shifts every
channel eight bits: blue silently becomes green. So `hexToRgb` reads six digits
whatever it is given, `hexAlpha` reads the fourth pair (defaulting to opaque),
and `hexOpaque` strips it. `scripts/test/colors.mjs` pins exactly that.

**It lands as layer opacity, never as ink.** Two reasons. The visited wash is
drawn by blurring discs and cutting the result at a fixed alpha — a translucent
fill would move that contour and *shrink* the blobs instead of fading them (see
[How it works](#how-it-works)). And a colour that is already translucent would
then be composited again by the layer opacity it is drawn with, applying the
same choice twice. So the accent's opacity multiplies `regionOpacity()` and the
region outlines, an activity's multiplies that activity's line opacity, and both
hand MapLibre an opaque colour.

**Only where the colour is used.** A heat map doesn't draw the accent at all, so
it doesn't honour the accent's opacity either — the rule is that an opacity
belongs to the colour it is part of, and a colour nothing is drawn in has
nothing to fade.

**The swatch is drawn over a checkerboard**, as a pseudo-element rather than a
background colour: a `background-color` paints *below* its own
`background-image`, which would put the board on top of the colour. Without the
board a half-transparent swatch just looks like a darker one.

## What a cell knows

Tap any colored area in view mode and a card shows what's inside it: when you
were there (from the dates in the imported data), how much ground you have
covered, and how many visits it came from. Zoomed out, the card aggregates every
stored cell inside the hexagon you tapped. Cells, their sources and their dates
live in SQLite on the server (`cell_sources`), per account; saved routes live
beside them in `routes`.

**Which apps put those cells there is not on the card.** It was, as a
per-source breakdown under the dates, and it is the same mistake the fix count
was: a fact about the recording rather than about the place. It also made the
card grow with the size of the area — a country card ran to a screenful of app
names before it reached the numbers anyone opened it for. The provenance is
still stored per source and still shown where it can be acted on: the statistics
panel totals it, and Settings → **Sources** lists every source with its dates and
can rename or remove one. `rollUpIds` therefore returns dates and counts only.

## Derived on the server, once

Trips, coverage and the calendar are readings of the rows rather than rows
themselves. Nothing stores them, and for as long as there was one client that
was plainly right: they cost no import path, no schema and no migration, and
they re-derive themselves the moment new history arrives.

A second client changes the arithmetic. Two implementations of an eight-hundred
line heuristic do not fail loudly when they disagree — they produce a phone and
a laptop that show different holidays, and you find out months later. So
`server/derive.js` works them out once and both clients render what they are
given.

**It is the same code, not a copy.** `src/trips.js` and `src/stats.js` are pure
ES modules with no DOM in them, so the server imports the very files the browser
uses. There is one definition of what a trip is, and it is the one with the
tests. A port to Swift would have been a second definition; this is not.

**The gazetteers are the only part that needed care.** In the browser they are
dynamic imports of JSON, which plain Node will not do without an import
attribute. Every loader already takes the parsed data as an argument for exactly
that reason — the note above `loadCountries` says so — so the server reads the
8.1 MB off disk and hands it over, and the argument-less `loadCountries()` inside
`computeStats` then finds it already loaded. Nothing had to change in `src/` to
make this work, which is the strongest evidence that those modules really were
pure.

**Lazily, and once.** The datasets are not read at boot: a server whose owner
never opens the statistics should not pay for them. The first derived request
spends about 60 ms parsing them and every later one spends none.

**The cache is keyed on a signature of the rows, not on a counter.** Six paths
write cells — the map's own edits, undo's restore, the file importer, the Home
Assistant poller, the Strava poller, a route delete — and a counter has to be
remembered at all six. Two cheap aggregates cannot be forgotten by any of them:
`COUNT(*)`, `MAX(added_at)`, `MAX(last_at)` and `SUM(hits)` over `cell_sources`,
plus count, newest and total length over `routes`. `SUM(hits)` is there because
re-importing a file changes visit counts in place without touching the row count
or any timestamp.

A cache hit never opens the database at all: the handlers pass a `supply`
callback rather than the data, and a hit never calls it. That is pinned by a
test which counts the calls.

**Two things the aggregates could not see, and both were wrong.**

*Renaming a route.* The count, the newest `added_at` and the total length are
all exactly what they were, so nothing in the signature moved — and a day's
detail went on reporting the old title. `routeEdits` therefore reads the small
mutable columns (name, place, sport, source, ascent, link) and hashes them. Read
and hashed rather than summed, because every sum collides on the case that
matters: two routes swapping names, or a rename to a title of the same length.
It is one short row per route on a map that has dozens, next to a cells read
that walks tens of thousands.

*Setting your home.* Home is an **input** to every trip and is not a row at all
— it lives in the preferences blob. Moving it changes which days count as away
and therefore which trips exist, while touching nothing any aggregate could
notice, so the answer you got back was the trips of the home you had *before*,
and it stayed that way until the next time you imported something. The
coordinates are in the signature now (the name is not: renaming your home does
not move it). `derivedFor` takes the signature and the input together, so a
handler cannot read one with a home the other never saw.

**One preference is about reading rather than about the map.** Every time on the
site used to be formatted with `new Intl.DateTimeFormat(undefined, …)`, and
`undefined` means "whatever locale this browser is set to" — a good default and a
bad only-option, since a phone set to US English shows a 09:09 walk as "09:09 AM"
whichever country it is standing in. `src/clock.js` is now the one place that
decides, the locale is still the default (that is the `auto` setting), and the
override is stored in the account's preferences rather than in `localStorage`. A
clock is a fact about *you*, not about the machine you are sitting at, so
choosing 24-hour on the laptop means the phone agrees without being told twice.

It is nonetheless mirrored into `localStorage` (`visited-map:clock:v1`) alongside
the route view and the hidden trips, and that mirror is doing more work than the
others. Without it a browser boots on `auto` and holds it until `/api/prefs`
answers — and anything touched in that window stamps the preferences as *newer
than the account*, so the push that follows sends the default up over the
24-hour that was chosen on the phone. A setting that reverts itself is the exact
failure the stamps exist to prevent, and dragging a colour on a slow connection
was enough to reach it.

**And `auto` cannot mean "this device" in a browser.** `Intl` knows the locale,
and a locale is a language and a region: `en-US` is 12-hour, `en-GB` is 24-hour,
and neither of them is the *24-Hour Time* switch in iOS Settings, which is an
override on top of the locale. WebKit folds that override into the locale it
hands a page, so mobile Safari is genuinely automatic — and inside the app's web
view the locale is the **app's**, which is English, so a phone that has written
13:05 everywhere for years was told 01:05 PM by this one screen. Asking `Intl`
more carefully does not help; there is nothing else to ask.

So it is a thing the host is asked to say, exactly like the safe-area insets:
`pushClock()` in `WebPanel.swift` reads the pattern behind the `j` skeleton (the
one reading that returns the user's *preference* rather than the region's
convention), writes `data-hour-cycle` on the root element and fires
`hexplore:clock`. It is injected at document start, so the very first timestamp
on screen is right, and pushed again on load, so a web view that reloads after
the switch was flipped is not repeating what was true at launch. In a browser
nothing writes it and the locale stands, which is what this has always done.

The note under the picker says which of the two `auto` resolved to **and where it
read it** — "24-hour" from a device that said so, "12-hour, from your browser's
language" from one that could not. "Automatic" being wrong is much easier to act
on when the row admits what it was reading.

**One preference can be lost for good, and it is the only one.** A colour picked
twice is a colour picked twice; the Mapbox token is copied out of somebody's
Mapbox account, and a device holding the only copy of it must not have that copy
wiped by an account that has simply never heard of the setting. Every other key
can be read as "absent means default" and `adoptPrefs` does exactly that. This
one cannot, because `''` is a real answer — it is what emptying the box and
pressing Done leaves behind, and a device syncing afterwards has to hear *that*
rather than go on drawing with a token that was taken off the account.

So the **key's presence**, not its value, is what says the account has an
opinion. `remoteToken()` in `src/prefs.js` is that one rule, kept beside
`reconcilePrefs` and tested with it: a string is an answer (including the empty
one), anything else — a missing key, a `null`, junk from a hand-edited row — is
silence. Silence beside a browser that *has* a token is the third case in
`syncPrefs`'s `migrate` check, which adopts the account's copy and then pushes
the token up, exactly as it does for an account written before the light and dark
washes were told apart.

**Preferences stopped being entirely opaque.** The server stored the preferences
blob and gave it back without reading it. It now reads one key — `home` — because
a derived home that ignored the answer you gave when the guess was wrong would be
worse than no derivation, and the alternative (every client sending its own home
up with each request) is precisely the disagreement this exists to remove.

### And the web app consumes them

It used to derive its own, from the same modules, so the two could not drift in
*code* — but they were still two computations over two sets of inputs, and that
is enough to disagree. `src/derived.js` is now the one door: the Statistics tab
and the trip list render what `/api/stats` and `/api/trips` return.

What that cost the browser was the gazetteer. Naming a trip wants the towns, the
regions and the countries; the coverage sweep wants two of the three. So opening
the search palette — which opens on the trip list — pulled `places.json` down
(3.0 MB, 1.24 MB gzipped) and swept 25,000 cells on the main thread, to arrive
at an answer the server had already worked out for the phone. Opening it now
costs one request.

**`activeDays`, `dayDetail` and `findHome` deliberately stayed in the browser.**
The rule is not "the server derives everything", it is *the gazetteer lives on
the server*. Those three are arithmetic over rows the page already holds: which
days have anything on them, what happened on one of them, and where the cells
cluster. None of them opens a dataset. Moving them would have bought nothing and
cost a round trip on every click of a calendar day — and `findHome` in
particular has to answer before the house can be drawn, which is well before a
request could come back. The trips they are given now come from the server, so
their inputs are the server's inputs.

**The palette's own datasets moved to the first keystroke.** Loading them when
it opened used to be free in the only sense that mattered: naming the trips
happened there and had pulled all three in anyway, so the prefetch merely moved
the cost earlier. With the naming gone it was a couple of megabytes spent every
time the panel was opened to look at a holiday. It also turned up an
accident — `searchRegions` and `searchCountries` answer `[]` when their dataset
is unloaded rather than loading it themselves, so searching for a canton had
been working only because the naming pass happened first. `warmGazetteers()`
asks for all three, on the first character typed, and the empty state says
*Looking up places…* rather than *Nothing matches* while they are on their way.

## Asking again, cheaply

Every read that belongs to one account now carries an ETag, and the validator is
the signature above (`conditional` in `server/index.js`). It is the same fact
being used twice: two responses with the same signature are the same answer, and
that is exactly what an ETag asserts.

The one this was written for is `/api/cells`. A real map is 25,000 rows — 1.07 MB
of JSON, 136 KB gzipped — and it went out in full on every load, every reload and
every device, under `Cache-Control: no-store`, while changing only when you edit
or import something. Measured on a 20,000-cell map through the browser's own
resource timings, a repeat read went from **123,531 bytes to 300**, and 68 ms to
5. `/api/trips` went from 226,988 to 300.

- **`private, no-cache`, not `no-store`.** No shared cache may keep one account's
  map, and nothing here may be *used* without asking first — but it must be
  allowed to be **stored**, because a stored copy is the whole reason the next
  ask can be answered with 304 instead of a megabyte. `no-store` says the
  opposite, which is what the API was saying.
- **The validator is weak (`W/"…"`).** `send` gzips a large body and leaves a
  small one alone, so one signature can legitimately go out as two different byte
  strings. `W/` means "the same resource, possibly a different representation",
  which is precisely true, and `If-None-Match` compares weakly, so it still
  matches.
- **The tag holds no comma.** `If-None-Match` is a comma-separated list, so a tag
  containing one is torn in half on the way back and matches nothing. The home
  coordinates were written `lng,lat` and every derived read silently stopped
  revalidating — 200 every time, no error anywhere, the feature simply absent.
  They are joined with a slash, and `scripts/test/etag.mjs` asserts the absence
  of a comma along with the behaviour, because the behaviour alone does not say
  why.
- **Three signatures, not one.** `/api/cells` is validated on the cell aggregates
  alone, `/api/routes` on the route ones, and only the derived reads use the
  whole thing. Sharing one tag would mean re-sending a megabyte of cells to say
  that a route had been renamed.
- **A day is part of its own tag.** `/api/day/2024-08-10` and `/api/day/2024-08-11`
  are two answers about one map, and one validator must not stand for both.

## The offline shell

`public/sw.js`, registered by `src/offline.js` in production builds only.

It is not a generated file and there is no precache manifest: a list of hashed
filenames baked in at build time is a fourth thing that has to agree with the
build, and the first one to go stale breaks the app rather than the cache.
Instead each request is matched by what kind of thing it is, and each kind gets
the strategy its own headers already claim — `/assets/*` is content-hashed and
served `immutable`, so cache-first; `/api/*` GETs and navigations are revalidated
by ETag, so network-first with the cache as the fallback.

What it buys, in order:

- **The geography is downloaded once, ever.** The three datasets are 8.5 MB raw
  and content-hashed, and the browser's own cache is a best-effort store that a
  phone evicts often. Held here they survive.
- **The app opens with no server**, and
- **it opens on your map**, because the last answer `/api/cells` gave is still
  there. Verified by killing the server and reloading: 20,385 cell rows and both
  trips came back, the account stayed signed in, the "cannot reach the server"
  banner appeared, and a write threw. Reads from the cache, writes not pretended
  — which is the whole of what view-only offline should mean, and the app already
  knew how to say it.

Three things it deliberately does not do. **Basemap tiles** are CARTO's,
OpenFreeMap's and Esri's, and keeping someone else's tiles for offline use is
their bandwidth and their terms rather than a technical question — so offline you
get your own cells and routes over an empty background, which is honest about
what is yours. **Anything but GET**: a cached POST is not a cache, it is a lie
about a write. **Anything that is not a 200**: a 401 held in a cache is how a
signed-out session becomes permanent.

Signing out sends the worker a `forget-account` message and it drops the whole
API cache. The URLs say nothing about whose account they describe, so without
that the next person to sign in on the device would be shown the last one's map
for as long as their own request took to arrive.

**iOS gets all of it for nothing.** The Map tab is a `WKWebView` with
`websiteDataStore = .default()`, and WebKit has supported service workers in a
web view since iOS 14 — registration and Cache Storage included, persisted by
that store across launches. So the shell, the gazetteer and the last view of the
map are cached by the same code that does it in Safari, with nothing native
written and nothing bundled into the IPA. Bundling the built site into the app
was the obvious alternative and is the worse one: a copy of the web app inside
the app is a second copy that can disagree with the server's, which is the trade
this project keeps refusing.

## The build number, and bumping it

**`SERVER_VERSION` at the top of `server/index.js` must be bumped on every
change to the code.** It rides along with the session (`/api/me`, and the login
and register responses, so a fresh sign-in knows it without a second round
trip), and it is printed at the foot of **Settings**.

It is one line of work and it earns its keep on the one question this codebase
keeps failing to answer quickly: *which build am I actually looking at*. Every
long debugging session here has turned out to be a version of it —

- a browser replaying a year-old `immutable` response for `/api/regions/:ISO`
  through twenty rebuilds and restarts,
- a `304` served against a signature that could not see a dataset change
  underneath it, so the statistics went on reporting 110 Italian provinces,
- a service worker holding a shell from two deploys ago.

In every one, the map looked merely *wrong*, and there was nothing on screen to
say that the code being read was not the code that was running. A number you can
read out settles it in one message, and rules out the whole class before anyone
measures anything.

Bump the patch for a fix, the minor for anything someone would notice. **A stale
version is worse than none at all**: the entire value is that it can be trusted
to rule the question out, and one that lies rules out the very thing that is
wrong.

### …and whether it is still the current one

*Which build am I looking at* and *is that the current one* are the same
question ten seconds apart, and only the first had an answer. The second is
really two, with different remedies, and `GET /api/update` answers both in one
request.

**Is this page behind its own server?** The number a page prints is the one it
was handed **when it signed in**, and a page keeps that for as long as it is
open. Update the server under a tab left on the map — on a phone the normal
case, not the unusual one — and the tab goes on running last fortnight's app and
reporting last fortnight's version. Fixed by reloading, so that one gets a
button.

**Is this server behind the project?** This is self-hosted and updated by
pulling and restarting, deliberately, by the person who runs it — and there was
no way to know there was anything to pull. A server left running three months
looks exactly like a current one. So the server reads `SERVER_VERSION` off the
published copy on `main` and compares. There are no releases and no tags to use
instead; the version that means anything here is that constant, and its
authoritative copy is the one in the repository. Nothing a web page can offer to
fix, so that one gets a sentence and no button.

The outbound request is the only one this server makes that nobody configured,
so:

- **The server asks, not the page.** One machine, one cache, one address seen by
  GitHub — rather than every browser and phone that opens Settings announcing
  itself. `UPDATE_TTL_MS` is six hours; a failure stands for `UPDATE_RETRY_MS`
  (fifteen minutes), because a server that has just come back online should not
  be six hours behind knowing it.
- **16 KB, not the file.** The constant is at the top of `server/index.js` by
  design, so the request carries a `Range` header and the answer is sliced
  before the regex runs. A source that ignores the header costs the whole file
  and still works.
- **It can be switched off.** `UPDATE_CHECK=0` and it never runs;
  `UPDATE_SOURCE` points it at a fork.
- **Numbers, not text.** `isNewerVersion` compares part by part, because
  `'0.10.0'` sorts before `'0.9.0'` as a string and that is precisely the
  release where a string comparison would silently stop reporting anything.
- **Silence is not "up to date".** A check that cannot get through — a firewall,
  a timeout, a fork with a different layout — answers `null`, and null is not a
  version to compare against, so nothing is claimed. `serverUpdate()` in
  `src/auth.js` is a plain `fetch` rather than going through `api()` for the
  same reason: a version check that fails is not a failed save and must not flip
  the "your changes are not being saved" banner.

The line reads *Server 0.49.0*, or *Server 0.49.0 · this page is on 0.48.0*
with a Reload, or *Server 0.49.0 · 0.50.0 available*, or both. The reload is a
plain one and clears no caches: navigations are network-first (`public/sw.js`)
and everything else lives under a hashed URL, so a new build is a new set of
URLs and the old ones simply stop being asked for. Throwing the offline copy
away as well would spend a 3 MB gazetteer on a problem this does not have —
that button exists separately, for when a cache really has gone wrong.

`scripts/test/update-check.mjs` runs the whole path against a stand-in upstream
served from the test, so "the source is down" and "the source is not this file"
are testable without touching the network.

## Run & host

```sh
npm install
npm run dev          # Vite + API together (http://localhost:5173)
npm run dev -- --host  # …and reachable from your phone on the same network
npm run build        # production bundle → dist/
npm start            # one process serving dist/ and the API (port 3001)
```

Accounts and cells live in SQLite (`data.db`, via `node:sqlite` — no npm
dependencies), so the app needs the Node server, not just static hosting. Env:
`PORT`, `DB_PATH`, `COOKIE_SECURE=1` behind HTTPS, `IMPORT_OWNER` for the
offline import above. For a private personal deployment, `tailscale serve` in
front of `npm start` gives you an HTTPS URL (which the "my location" button
requires) reachable only from your own devices.

`npm start` gzips every response over a kilobyte and serves `dist/` from an
in-memory cache — read once, compressed once, keyed on size+mtime so a rebuild
is picked up without a restart. Content-hashed `/assets/` files are sent
`immutable`; `index.html` revalidates with an ETag, so a deploy is still picked
up immediately. A cold load drops from ~5.9 MB to ~1.8 MB and a warm one to a
single 304. There's no reverse proxy doing this for you — `tailscale serve`
passes bodies through untouched.

If the server stops answering while the map is open, a banner says so and the
**Retry** button re-sends what's queued. Edits stay queued until the server has
actually taken them — previously a failed save dropped them silently, which
looked exactly like a map that had saved.

The server has to stay running for the Home Assistant sync to do anything —
that's the whole point of it living there rather than in the page. A restart is
harmless: the poller's first tick backfills whatever it missed.

### Who can get in

**Registration is open, and closing it is a choice.** It was the other way round
— open until somebody signed up, then shut — on the argument that a session is
what stands between a stranger and the importer, the saved routes and the Home
Assistant connector, and that the instance is on the public internet. That
argument has not stopped being true, and it is the one to read before leaving
this alone: an account is not access to anyone else's map, since every row is
stored per account, but it is a share of the disk and of the server's outbound
reach.

What it weighs against is that a map is worth putting more than one person on,
and that "make an account" answering 403 for everyone but the first is a bad
first impression which can only be debugged from the server side.
`ALLOW_REGISTRATION=0` restores the old behaviour, `REGISTRATION_CODE=…` is the
middle ground, and either way it stays rate limited to five an hour per address.

Sign-in is rate limited (20 attempts per IP and 10 per account in 15 minutes,
answering 429 with `Retry-After`), passwords are at least 10 characters
(`MIN_PASSWORD_LEN`), and a login for a username that doesn't exist hashes
against a dummy record so it takes the same time as a real one — otherwise the
two answer at visibly different speeds and that alone tells you which usernames
are real. Hashing is scrypt on the threadpool, not `scryptSync`: the
synchronous form blocked every other request for the duration, and eight
concurrent logins pushed unrelated requests from 11 ms to 158 ms.

Sessions expire after 90 days server-side, not just in the cookie, and expired
rows are swept daily. The cookie is `HttpOnly; SameSite=Lax` and gains `Secure`
automatically whenever the request arrived over HTTPS (`X-Forwarded-Proto`), so
`COOKIE_SECURE=1` is now only needed to force it on.

### Where the server is allowed to connect

Home Assistant is the one address you get to choose, and it used to go straight
into `fetch()` — which meant any account could aim the server at the router,
`localhost`, or a cloud metadata endpoint and read reachability off the reply.
`server/net-guard.js` now resolves the name, refuses link-local and reserved
ranges outright (169.254/16 is where metadata lives and is never a Home
Assistant), and **connects to the address it just checked** rather than
resolving a second time, which is what closes the DNS-rebinding gap.

Private addresses stay allowed on purpose: a self-hosted HA genuinely is at
`192.168.x.x`, `homeassistant.local` or `127.0.0.1`, and blocking those would
delete the feature. `HA_BLOCK_PRIVATE=1` tightens it to public addresses only
(for a Nabu Casa / DuckDNS setup), and `HA_ALLOWED_HOSTS=a,b` restricts it to an
explicit list.

### What a failure is allowed to say

The sync and probe routes report why they failed, and that is most of what makes
them usable: "Home Assistant rejected the access token." tells you to go and
paste a new one, where "something went wrong" starts a guessing game. The way
that was done was `String(e.message ?? e)`, which cannot tell the sentence
somebody wrote from a SQLite constraint violation, an `ENOENT` quoting the
database's path, or a `TypeError` naming a field of an internal row.

So the intent is recorded at the throw rather than guessed at in the `catch`.
`server/user-error.js` holds a `UserError` — an error whose message was written
to be read — and a `userMessage(e, fallback, where)` that returns the message
only for those, and otherwise logs the real error and returns a flat sentence.
Everything in `home-assistant.js`, `strava.js` and `net-guard.js` throws
`UserError`, because those three exist to talk to somebody else's server on your
behalf and every way that can fail is something you can act on. `backup.js`
relabels the cron parser's complaints the same way at the call, since
`src/cron.js` is shared with the dialog and cannot import a server module.

The leak was wider than the routes it was found in. The same string is written
to `last_error`, which `haOut()`/`stravaOut()` hand back as `lastError` on
**every later GET of the link** — so a message stored once by a background poll
kept being served long after the request that produced it. The pollers go
through `userMessage` for that reason, not only the routes that answer a person
directly.

### Bounded work per request

Imports write in 2,000-row transactions with a yield between them. `node:sqlite`
is synchronous, so one transaction over a few hundred thousand rows pinned the
only thread there is — the map stopped answering and the pollers stopped firing.
The trade is atomicity, which is safe here because every write is an upsert
keyed by (user, cell, source): re-running a half-finished import completes it
rather than doubling it. Bodies are capped at 32 MB with at most two large
requests in flight, and `dist/` is served only from inside `dist/` — the old
prefix check also matched a sibling directory whose name merely started with it.

### Basemaps

Five, picked in the menu: **Dark** (CARTO Dark Matter), **Terrain**, **Light**
(CARTO Voyager), **Satellite**, and **3D** (Mapbox Standard — see "The 3D
basemap, and the two libraries", which is where everything about it lives). Two
of them are built at load time rather than fetched as a URL: `src/basemap.js`
takes somebody else's style JSON and rewrites the parts that are wrong, which
MapLibre accepts anywhere it accepts a style URL.

3D is different in kind from the other four. It is drawn by **Mapbox GL JS**
rather than MapLibre, so choosing it or leaving it reloads the page; it can be
*unavailable*, because it runs on the viewer's own Mapbox token; and its theme
follows its light preset rather than being a constant. Everything below is about
the four MapLibre ones.

**All four stack the same way**, and it took two bugs in opposite directions to
get there. The map is three things: the basemap's ground, the visited wash over
it, and the basemap's streets, railways and rooftops over *that*. A town should
read as your colour with the streets still drawn through it.

Where the wash goes used to be "before the style's first symbol layer", which is
right about Light by luck. CARTO publishes Voyager and Dark Matter as the same
93 layers in the same order with one difference that decides this: Voyager puts
`waterway_label` at index 13, just before the tunnels, and Dark Matter puts it at
66 — after every road, rail and building it has. So the identical rule landed the
wash *under* the streets on Light and *over* them on Dark, where a town came out
a flat patch of colour with nothing drawn in it. OpenFreeMap has the same problem
mirrored — `water_name` at 8, `building` at 9 — and Terrain used to answer it by
moving the buildings *down*, which made Terrain agree with the broken map instead
of the right one.

`washAnchorIn()` in `src/basemap.js` is the one rule now: **whichever comes
first, the style's first label or the first layer it draws over the ground**
(`OVERLAY_LAYER` — tunnels, bridges, roads, highways, rails, buildings).
Deliberately not the aeroways: CARTO files a runway among the water fills, and
a runway there is ground the way a car park is. On Voyager the answer is still
index 13, so Light — the one that already looked right — does not move.
`scripts/test/layer-order.mjs` pins all three against the real layer order, and
`scripts/test/mapbox.mjs` does the same for Mapbox.

The **selection ring** is the one thing exempt from all of this. It takes no
`beforeId` at all, so it is added last and sits over everything the basemap and
this app draw, home marker included. It used to anchor beside the visited wash,
which meant the ring around the cell you had just clicked ran under the rooftops
in it and vanished in a dense town — and a 2 px ring that only exists while you
are inspecting that cell is not what home needs to win against.

**Terrain** is OpenFreeMap's dark style, recoloured. As published it is a
near-black monochrome (background `rgb(12,12,12)`, forest `rgb(32,32,32)`, water
`rgb(27,27,29)` — the blue channel two points above the others), which is the
look it exists to get away from. Land becomes a desaturated grey-green, forest
becomes green *and starts drawing at z4* instead of the published z10 gate that
left the map flat at every zoom this app is used at, water becomes properly
blue, and Natural Earth's shaded relief — declared as a source upstream and then
never used — is switched on underneath at low zoom. Labels lose the forced
`text-transform: uppercase` that shouts BURGDORF at a town of nine thousand.
Roads are deliberately darker than a stock basemap: this is background for the
visited cells, not the subject.

**Satellite** is Esri World Imagery with OpenFreeMap's labels and roads on top,
built from the same style Terrain uses. Every fill is dropped — a photograph is
the ground truth, and painting landcover over it would be drawing on the
evidence — leaving 27 layers: the imagery, faint white roads to orient by, and
place names with a hard halo. Note Esri's tile path is `{z}/{y}/{x}`, row before
column; the usual order yields blank tiles.

Both fall back to the plain dark basemap if their upstream can't be fetched, and
the map opens on a bare background in roughly the right colour while a built
style is being fetched — loading a *different* basemap first would be a wasted
request and a visible flash of the wrong map.

**Terrain and Satellite are on a zoom diet.** Both are built from OpenFreeMap's
style, which labels everything it has and gates almost none of it: every place
tier — hamlet, suburb, village, town, city — carries no `minzoom` at all, so
village names were drawn at world zoom, and `highway_minor` starts at z8, which
puts every lane in a canton on screen while you are looking at a country. Light
(CARTO Voyager) is the one that reads cleanly and it is disciplined about exactly
this, so `applyZoomDiet()` in `src/basemap.js` applies Voyager's gates to the
layers OpenFreeMap gives the same job to: hamlets at z13, villages at z11, towns
at z7, cities from z4 by rank, minor roads at z13, paths at z15. Street-name
labels and one-way markings go entirely — unreadable at the zooms this map is
used at, and OpenFreeMap gives them no gate either, so "A1" was being drawn from
halfway across the country. At z7.5 that takes Terrain from 20 labels to 48,
which is Voyager's own count to the label.

The one layer that needed more than a gate is `highway_major_subtle`, which draws
primary, secondary, tertiary *and* trunk from z6 in a single layer: 225 road
features on screen at z9 where Voyager draws 71. Voyager gets that number by
splitting the classes and gating each, so `gateRoadClasses()` does the same
inside the filter the layer already has — trunk early, primary at z8, secondary
at z11, tertiary at z13. Zoom in a filter is only evaluated at integer zooms,
which for a road appearing is the right granularity.

**Street names are gated, not deleted.** They were deleted, and the reasoning —
they are unreadable at the zooms this map is mostly used at, and OpenFreeMap gives
them no minzoom, so "A1" was drawn from halfway across the country — is an
argument for a `minzoom` and never was one for dropping the layer. It left Terrain
and Satellite with no street names at any zoom, including the zoom where you are
looking at one street, which on a photograph is exactly where they are most worth
having. They are back in `LABEL_GATES` on Light's own schedule: motorway shields
at z13, everything else at z15. The one-way arrows stay dropped — those are
markings for driving down a street, not for recognising one you walked along.

**Roads stop below `ROAD_MIN_ZOOM`, and arrive by `ROAD_FULL_ZOOM`.** Light
keeps its network on the map at world zoom but barely visible; Terrain and
Satellite now go one step further and draw none at all. Fading them was the
first answer and it was the wrong one — a whisper across the whole of Europe is
still a whisper across the whole of Europe, and on a photograph it is a grey
scribble over the thing you came to look at. The floor is applied with MAX, so
the tiers already held further in (`highway_minor` at z13, `highway_path` at
z15) keep their own; a layer whose upstream `maxzoom` ends before roads are
allowed back is dropped outright rather than left as a layer that can never
draw.

**Tuning the visited wash per basemap**: each entry in `STYLES` (`src/main.js`)
takes `cellAlpha` and `heatAlpha`, multipliers on the defaults in
`src/blob-canvas.js`. The same alpha does not read the same over black, over
green and over a photograph. All four ship at `1`; change the number next to the
basemap you want to adjust.

Attribution is set on the source object, not the style, so MapLibre's control
picks it up: `© OpenStreetMap contributors` for OpenFreeMap (ODbL), and Esri's
own string for the imagery.

## Stack

- [MapLibre GL JS](https://maplibre.org/) — vector map rendering
- [Vite](https://vite.dev/) — dev server / bundler
- Basemap tiles: [CARTO Dark Matter](https://carto.com/basemaps/) (free tier,
  attribution required)
- Boundaries and lakes: [Natural Earth](https://www.naturalearthdata.com/)
  (public domain) — `npm run build:countries`, `npm run build:places`
- Town names: [GeoNames](https://www.geonames.org/) `cities1000`, thinned
  (CC BY 4.0, credited in the map attribution)
