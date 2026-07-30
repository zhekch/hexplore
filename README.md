# Hexplore

An interactive world map covered in a hexagonal grid, where you mark the places
you've been. Cells are hexagons in storage but never look like it — they're
blurred and re-cut into soft blobs that flow together, so a map of your life
reads as spilled ink rather than a spreadsheet.

Point it at your location history and it fills itself in.

Working on it rather than using it? [ARCHITECTURE.md](ARCHITECTURE.md) is the
long version — why the grid is what it is, how the blobs are drawn, and a
number of approaches that were tried and abandoned.

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
| `REGION_CACHE_DIR` | `./cache/regions` | Where detailed region boundaries are cached |
| `COOKIE_SECURE` | auto | Forces the `Secure` cookie flag; already automatic over HTTPS |
| `ALLOW_REGISTRATION` | off | Reopens registration after the first account |
| `REGISTRATION_CODE` | — | Keeps registration open, behind an invite code |
| `MIN_PASSWORD_LEN` | `10` | Minimum password length |
| `IMPORT_OWNER` | — | Account the offline importer's cells belong to |
| `HA_BLOCK_PRIVATE` | off | Restricts Home Assistant to public addresses only |
| `HA_ALLOWED_HOSTS` | — | Comma-separated allowlist of Home Assistant hosts |

## Getting your data in

Menu → **Import & sync**. Four ways in, and you can mix them:

| | |
| --- | --- |
| **Files** | Drop in GPX, KML, TCX, FIT, GeoJSON, CSV, a `.gz`, or a whole Strava ZIP — as many at a time as you like. Parsed **in your browser**: the file never leaves your machine, only the cells it resolves to. Google Timeline, Snapchat and Apple Photos exports are recognised too |
| **Home Assistant** | Paste your address and a long-lived token, tick the devices to follow, and the server keeps the map current on its own. It reads history your recorder already wrote — it never wakes your phone |
| **Strava** | One-time sign-in, then your activities come across on a schedule |
| **Komoot** | Paste a tour link; your browser fetches it |

Before anything is saved you get a preview: what each file was recognised as,
how many fixes it holds, how many cells that is, **how many are new**, the dates
they cover, and how many routes it found.

**Re-importing is the point.** Cells are stored per source, so importing the
same export again refreshes its dates and counts in place rather than
duplicating anything, and importing a *newer* export adds only what's new. Drop
your old files back in whenever you like.

**A visit is not a fix.** Fixes in the same cell less than an hour apart count
once, so an hour of 1 Hz workout recording doesn't drown out everywhere else
you've been. Coming back the next day counts again.

**No files at all?** Turn on editing in the menu and paint cells by hand.
Ctrl-drag sweeps.

## What you get

**Saved routes.** Any track you import can keep the line it drew, not just the
ground it covered. Routes are named after where they went ("Bern → Thun",
"Thunersee loop"), get their activity worked out from the file — or from their
pace and climb when the file doesn't say — and are listed with a little drawing
of their own shape, which is how you actually recognise one. Tap a line on the
map for its card.

**Trips.** *Routes and statistics → Trips* groups your history into the runs of
days you didn't come home: `Zermatt, Switzerland · Aug 10 – Aug 16, 2024 ·
36 cells`. Tap one and the map flies there and draws it — a dot everywhere you
were, threaded in the order you were there, so a trip comes back as the shape of
its days rather than as a patch of ground. A bar at the top says which trip you
are looking at until you stop showing it. Where the dates don't say what came
first — a whole afternoon imported under one timestamp — you get the dots
without the thread, rather than a line joining them in whatever order they were
stored. Trips are worked out from the dates your cells and routes already carry,
so they appear on their own — which also means they can't be renamed, and that a
week somewhere with your phone off is a week that didn't happen.

Coming home ends a trip, so going away, spending a day at home and leaving again
is two trips and not one. And a day whose ground is mostly around home is a day
at home however far you also drove — which is why an hour's drive out and back,
every day for a fortnight, is no longer one long trip to the next canton.

Each one is named after **where you actually spent the days**, and after the
best-known place there: a fortnight in Rome with a day out to Florence is
*Rome*, not the hill town halfway between them, and a week in a village near a
city keeps the village's name.

Everything in that tab is measured from **home**, which the map guesses from the
cells you go back to most. If it guesses wrong, the row at the top of the tab
lets you set it — by name, or by pointing the map at the right spot.

**Statistics.** How much ground you've actually covered, as a share of Earth's
land and of every country you've touched. **Open a country** to see the same for
each of its **regions** — states, provinces, cantons, départements. Countries
move once a year; cantons move on a weekend. Every bar is that place's own share,
so 7% of Switzerland looks like 7%, and the list sorts by ground covered or by
share. Plus how many days your history actually carries and your longest
unbroken run of them, where your cells came from, and how much new ground each
year added.

**Search** (the magnifier, or **⌘K**). One field over places, your routes, your
trips, and whole regions and countries. Type a date — `2024-08-12`,
`12.08.2024`, `August 2024` — and a **calendar** opens on that month with a dot
on every day something was recorded, green when a route ran. The days of one
trip join into a single bar, so a fortnight away reads as one journey instead of
a scatter of dots. Pick any day to see what happened on it, and to put that day
on the map. Place names are looked up on your own machine; nothing is sent
anywhere.

**Undo.** ⌘Z / Ctrl-Z, and ⌘⇧Z / Ctrl-⇧Z to redo. It covers marking, painting,
clearing and deleting or renaming a route, and each one says what it just took
back — worth having when the thing that changed is off-screen. Undoing a clear
restores everything the cells knew, not just the fact that they were lit.

**Ask an area what it knows.** In view mode, tap any coloured blob: when you
were there, when it landed on the map, how many visits, and which app each
claim came from. Zoomed out, it aggregates everything inside the hexagon you
tapped.

**Backups.** Menu → **Export & settings → Backups**. The server copies the whole
database on a schedule — nightly at 04:00 by default, keeping the last 14 — and
**only when something has changed**, so an untouched map leaves one copy rather
than one a day. Pick a schedule from the list or type a cron expression; the
line underneath always says what it means in English. Every copy can be
downloaded, because a backup that never leaves the machine isn't one. They
belong to the account that made the map.

**Zooming out** goes from hexagons to shapes you recognise: at about z5 the grid
gives way to **regions** — cantons, states, départements — and one step further
out to whole countries. *Detail* pins any of those: the finest grid, Region, or
Country.

Pinned to Region and zoomed in, the outlines sharpen: the shipped boundaries are
simplified to about a kilometre, and past that zoom the app fetches the real
survey boundaries for **just the countries on your screen** (from
[geoBoundaries](https://www.geoboundaries.org/), a few hundred KB each) so a
canton edge follows the lake it actually follows. Nothing is fetched on Auto, or
before you zoom in, and the request says only which country — never anything
about your map.

Your server does the fetching and keeps a copy on disk, so each country is only
ever downloaded once — across restarts too — however many times you look at it,
and a small spinner sits at the top of the map while one is on its way. Zoom back
out and the map returns to the light geometry rather than drawing detail smaller
than a pixel, which is what keeps it smooth on an older device.

A few countries stay at the shipped resolution, because the detailed source
divides them differently than this map does — Hungary is one: it counts city
counties separately here and folds them into counties there, so about half of it
sharpens and the rest doesn't. The map declines rather than drawing you a shape
that isn't the one it counted.

**Looks.** Four basemaps (dark, terrain, light, satellite), one accent colour or
a shading by **visits**, **first seen**, or **type** — a colour per app the data
came from. Every colour has an **opacity** slider under the hue strip, so you
can turn the visited wash down until the map underneath reads through it, or
fade one activity's routes back without hiding them. Terrain and Satellite are
kept to the same label and road density as Light, and roads on all of them fade
out as you zoom away rather than shouting over the map.

## Rebuilding the map data

Committed, so a clone runs without network. Re-run only to refresh it:

```sh
npm run build:countries   # Natural Earth boundaries
npm run build:places      # GeoNames towns + Natural Earth lakes
npm run build:regions     # Natural Earth states, provinces and cantons
```

## Tests

```sh
npm test
```

Covers the parts where being wrong is quiet: the hex maths, visit counting,
activity guessing, the route API, preference syncing, the backup scheduler and
its skip logic, undo's restore path, trip derivation and naming, search, colour
parsing, and the coverage arithmetic.

## Keeping it yours

- **Registration closes itself.** The first account on an empty database can
  always be made; after that the endpoint answers 403. `ALLOW_REGISTRATION=1`
  reopens it, `REGISTRATION_CODE=…` keeps it open behind an invite code.
- **Sign-in is rate limited**, passwords are at least 10 characters, and
  sessions expire after 90 days.
- **Put it behind HTTPS.** `tailscale serve` in front of `npm start` gives you
  an HTTPS URL reachable only from your own devices — and "my location" needs
  HTTPS to work at all.
- **Your data is yours.** `data.db`, `import/` and any backups are gitignored.
  Files you import are parsed in the browser and never uploaded.

The reasoning behind all of the above — the security model, what the server is
allowed to connect to, and why each limit is where it is — is in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

- [MapLibre GL JS](https://maplibre.org/) — vector map rendering
- [Vite](https://vite.dev/) — dev server / bundler
- Basemaps: [CARTO](https://carto.com/basemaps/), [OpenFreeMap](https://openfreemap.org/), Esri World Imagery
- Boundaries and lakes: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Detailed region boundaries, fetched per country on demand:
  [geoBoundaries](https://www.geoboundaries.org/) (CC BY 4.0, compositing national survey data)
- Town names: [GeoNames](https://www.geonames.org/) `cities5000` (CC BY 4.0)

Built with no runtime dependencies beyond MapLibre and a polygon-clipping
library; the server has none at all.
