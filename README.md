# Hexplore

An interactive world map covered in a hexagonal grid, where you mark the places
you've been. Cells are hexagons in storage but never look like it — they're
blurred and re-cut into soft blobs that flow together, so a map of your life
reads as spilled ink rather than a spreadsheet.

Point it at your location history and it fills itself in.

---

## What it does

- **Click to mark.** Turn on editing and paint cells. The base cell is about
  900 m across; marks roll up, so a single visited cell lights its whole
  country when you zoom out.
- **Soft blobs, not tiles.** Marked areas are drawn as discs, blurred, and cut
  at a fixed alpha — neighbouring cells merge and blend their colours.
- **Import your history.** GPX, KML, TCX, FIT, GeoJSON, CSV, Google Timeline,
  Snapchat, Apple Photos, or a whole Strava ZIP. Parsed **in your browser** —
  the files never leave your machine, only the cells they resolve to.
- **Sync automatically.** Home Assistant (polled by the server on a schedule),
  Strava (after a one-time sign-in), Komoot (one tour at a time).
- **Saved routes.** Tracks from your imports are kept as lines, named after
  where they went and what sport they look like.
- **Four basemaps** — dark, terrain, light, satellite. Colour the map with a
  single accent, or shade each cell by **visits**, by **first seen**, or by
  **type** (a colour per app the data came from).
- **Ask any area what it knows.** Tap a blob for when you were there, how many
  visits, and which app it came from.
- **Undo and redo**, with a line naming what it just took back — worth having
  when the thing that changed is off-screen.
- **Backups.** The server copies the database on a schedule — nightly at 04:00
  by default, keeping the last 14 copies.
- **Private by default.** Accounts, sessions, and registration that closes
  itself after the first user.

## Requirements

- **Node 24 or newer.** The database is the built-in `node:sqlite`, which needs
  no flag from Node 24 on (on Node 22 you'd have to add `--experimental-sqlite`).
- Nothing else. No external database, no API keys to start, and no build step
  for the map data — it's committed.

## Quick start

```sh
npm install
npm run dev
```

Open <http://localhost:5173> and register an account. **The first account on an
empty database is always allowed**, and registration closes itself afterwards.

To reach it from your phone on the same network:

```sh
npm run dev -- --host
```

`npm run dev` runs the Vite dev server and the API together (ports 5173 and
3001); Vite proxies `/api` to the API, so you only ever open the one URL.

## Running it for real

```sh
npm run build     # production bundle → dist/
npm start         # one process serving dist/ + the API on port 3001
```

The app needs the Node server — static hosting isn't enough, since accounts,
cells and routes live in SQLite (`data.db`) and the Home Assistant poller runs
server-side.

For a private personal deployment, putting `tailscale serve` in front of
`npm start` gives you an HTTPS URL reachable only from your own devices. HTTPS
is worth having: the **my location** button needs it anywhere but localhost.

### Configuration

All optional — every one has a working default.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3001` | Port for `npm start` |
| `DB_PATH` | `./data.db` | Where the database lives |
| `BACKUP_DIR` | `./backups` | Where scheduled backups are written |
| `COOKIE_SECURE` | auto | Forces the `Secure` cookie flag; already automatic over HTTPS |
| `ALLOW_REGISTRATION` | off | Reopens registration after the first account |
| `REGISTRATION_CODE` | — | Keeps registration open, behind an invite code |
| `MIN_PASSWORD_LEN` | `10` | Minimum password length |
| `IMPORT_OWNER` | — | Account the offline importer's cells belong to |
| `HA_BLOCK_PRIVATE` | off | Restricts Home Assistant to public addresses only |
| `HA_ALLOWED_HOSTS` | — | Comma-separated allowlist of Home Assistant hosts |

## Getting your data in

**Menu → Import locations**, then drop your export files — any number, in any
combination, added a few at a time until you're ready. Formats are detected
from the contents rather than the extension, and each file keeps its own
provenance, so the map can tell you later which app a cell came from.

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
- **Modes**: the map is view-only until you switch **Editing** on in the menu,
  which reveals the glass **pencil button**; tapping that expands the edit panel
  and enters edit mode, where a glass tile **spotlight around the cursor** shows
  the grid — tiles render only near the pointer and fade out toward the rim
  (`SPOT_PX`, `SPOT_MAX_CELLS`), so even a zoomed-out map never builds more
  than a couple thousand cells. In view mode a tap opens the **info card** for
  that area instead. Set `EDIT_ENABLED = false` in `src/main.js` to ship a
  fully view-only build (no pencil, no editing, at all).
- **Menu**: one glass button (bottom left on desktop) opens sections for the
  base map, coloring, and your map (saved routes, editing, statistics, and two
  doors split by which way the data is going — **Import & sync** for everything
  that puts where you've been on the map, **Export & settings** for getting it
  back out and the schedule that does so).
  The **ⓘ**
  buttons open a floating note beside the menu — nothing expands inline, and
  swapping coloring modes swaps the color picker for the legend inside a
  fixed-height slot, so the panel never resizes under the pointer. The geolocate
  button sits bottom right. On phones the controls stack in that same corner —
  geolocate, menu, pencil — and opening the menu tucks them away behind a bottom
  sheet.
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
  levels apart) and regions **crossfade** concentrically. **Detail** in the
  menu pins that choice instead, at either end: *Tiniest* holds level 0 — the
  grid exactly as stored — at every zoom, *Country* holds whole-country fills,
  and *Auto* (the default) follows the zoom. The in-between levels used to have
  buttons of their own; they were five ways of asking for what Auto already
  picks, so a level pinned before they were retired now falls back to Auto
  rather than sitting there with no way to un-pin it.
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
  The blur runs on `ctx.filter` where the browser has it and in JS where it
  doesn't — **Safari has never shipped `CanvasRenderingContext2D.filter`**, and
  the obvious feature test says otherwise (assigning it there just makes an
  ordinary property), so iOS was quietly drawing bare discs. Support is probed
  by behaviour instead, and the fallback is three separable box passes over
  premultiplied RGBA.
  The canvas is pinned to the padded viewport as a MapLibre canvas source (the
  map never rotates or pitches, so the rectangle maps linearly and stays
  registered while panning) and repaints on level changes, zoom drift and
  moveend — never mid-gesture, where the existing image simply scales with the
  map until you let go.
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
  between two old levels while it fades out. The country geometry is also
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
  whichever covers the most of its ground). At the country level all four apply
  per country. Single-color mode's swatch opens the app's **own color picker**
  (`src/color-picker.js`) rather than the OS one, and the map repaints as you
  drag.
- **Saved routes**: track files can keep the line they drew, not just the ground
  it covered — see [Saved routes](#saved-routes) below.
- **Region borders**: `SHOW_REGION_BORDERS` in `src/main.js` toggles the crisp
  outline and glow around visited regions. It defaults to `false` for a
  fill-only appearance; edit-mode tile guides are unaffected.
- **Statistics**: the menu's *Statistics* panel has two tabs. **Cells** measures
  actual ground covered — each cell's area is its Mercator hex area × cos²φ — as
  a share of Earth's land and of every country it touches (attributed by the
  country under each cell's center, with country areas computed from the
  boundary polygons), sortable by share or by ground covered, plus where the
  cells came from and how much new ground each year added. **Routes** is the
  list of saved tracks: totals, distance by year, and every route sorted by date
  or length, or grouped **by app** (Komoot, Strava, Garmin…) with each app's own
  count and distance — tap one and the panel closes, the map flies to it and its
  card opens.
- **Glass tiles**: unvisited cells draw as slightly inset, sharp-cornered
  glass tiles with a whisper-thin stroke — tuned by `TILE_INSET`.

## Import location history

Open the menu (bottom left) → **Import & sync** → **Files**, then pick or drop
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

A cell's visit count is **not** how many location fixes landed in it. Fixes in
the same cell less than an hour apart (`VISIT_GAP_SEC` in `src/locations.js`)
are one visit, so an hour of 1 Hz workout recording counts once instead of
thousands of times, and a night at home counts once however often the source
sampled it. Coming back the next day counts again. Files with no timestamps
fall back to run-length: each unbroken pass through a cell counts once, and
re-entering it later in the file counts again.

The raw fix count is still kept (`fixes` in `cell_sources`) and the cell card
shows it underneath the visit count when the two differ. Older imports predate
the column and show visits only; re-importing fills it in.

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

## Import & sync

Menu → **Import & sync** is the one door in front of everything that puts where
you've been onto the map. Both halves are behind it because from the outside
they are one question — *how does my history get in?* — and whether the answer
is a file you picked or a server that fetches it every quarter of an hour is an
implementation detail you shouldn't need to know to find the button:

| | |
| --- | --- |
| **Files** | Anything you export by hand — GPX, KML, TCX, FIT, a Strava ZIP, a Google Timeline dump. Parsed in the browser; see [Import location history](#import-location-history) |
| **Komoot** | One tour at a time, from a share link, fetched by your browser — inside the file importer, since it also imports once rather than staying connected |
| **Home Assistant** | Followed on a schedule by the server, so the map keeps filling in on its own |
| **Strava** | Your activities, brought across on a schedule after a one-time sign-in |

What goes the *other* way — backups, and eventually an export — lives behind the
second door, [Export & settings](#export--settings).

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

Import & sync → **Home Assistant**: paste the address you open Home Assistant at and a
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

## Export & settings

Menu → **Export & settings** is the other door. **Export** is listed and
disabled: there is nothing behind it yet, and a row that says so is more honest
than a menu that quietly grows one later — it points at the backup below, which
is the way out today. **Backups** is the rest of this section.

### Backups

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

This happens **on this device**. `src/places.json` (2.2 MB, built by
`npm run build:places`) ships with the app and is dynamic-imported as its own
chunk the first time a route needs a name, so no coordinate is ever sent to a
geocoder. It holds:

- **69.5k towns** from [GeoNames](https://www.geonames.org/) `cities5000`
  (CC BY 4.0 — hence the GeoNames credit in the map's attribution). Coarser sets
  are far smaller but only know cities, and a hike above Interlaken then comes
  out named after somewhere 40 km away, which is worse than no name at all.
- **~2k named lakes** from Natural Earth (public domain). The global file barely
  names any — in Switzerland it knows Lake Geneva and Bodensee and nothing else
  — so the Europe and North America supplements are merged in on top.

Two rules keep the names honest: nothing more than 30 km away is claimed as
where you were, and a lake has to be within 6× the route's own size in either
direction, so a 2 km walk is never "Lake Geneva" and a 150 km drive is never
named after a pond it passed. Size buys a place a head start over distance
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
  as tinted ground beneath the streets. CARTO's styles put a few label layers
  *before* the roads, so the usual "insert before the first symbol layer" trick
  lands underneath every street and chops the route into dashes; `labelStart()`
  in `src/main.js` aims past the last non-symbol layer instead.

## What a cell knows

Tap any colored area in view mode and a card shows what's inside it: when you
were there (from the dates in the imported data), when it landed on the map,
how many visits (and, if different, how many raw location fixes) it came from,
and the breakdown by source. Zoomed out, the card aggregates every stored cell
inside the hexagon you tapped. Cells, their sources and their dates live in
SQLite on the server (`cell_sources`), per account; saved routes live beside
them in `routes`.


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

## Run & host

```sh
npm run build:countries   # Natural Earth boundaries
npm run build:places      # GeoNames towns + Natural Earth lakes
```

## Tests

```sh
npm test
```

Accounts and cells live in SQLite (`data.db`, via `node:sqlite` — no npm
dependencies), so the app needs the Node server, not just static hosting. Env:
`PORT`, `DB_PATH`, `BACKUP_DIR` (default `./backups`), `COOKIE_SECURE=1`
behind HTTPS, `IMPORT_OWNER` for the
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

**Registration closes itself.** The first account on an empty database can
always be made — that's how you get started — and once one exists the endpoint
answers 403. `ALLOW_REGISTRATION=1` reopens it, or `REGISTRATION_CODE=…` keeps
it open behind an invite code. This matters more than it looks: a session is
what stands between a stranger and the importer, the saved routes and the Home
Assistant connector, and the instance is on the public internet.

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

Four, picked in the menu: **Dark** (CARTO Dark Matter), **Terrain**, **Light**
(CARTO Voyager) and **Satellite**. Two of them are built at load time rather
than fetched as a URL — `src/basemap.js` takes somebody else's style JSON and
rewrites the parts that are wrong, which MapLibre accepts anywhere it accepts a
style URL.

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
- Town names: [GeoNames](https://www.geonames.org/) `cities5000`
  (CC BY 4.0, credited in the map attribution)
