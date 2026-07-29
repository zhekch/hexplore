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

Before anything is saved you get a preview: what each file was recognised as,
how many fixes it holds, how many cells that is, how many are new, the dates
they cover, and how many routes were found.

A cell's **visit count is not its fix count** — fixes in the same cell less
than an hour apart count as one visit, so an hour of 1 Hz workout recording
counts once, and so does a night at home.

**Re-importing is the point.** Cells are stored per source, so importing the
same export again refreshes it in place instead of duplicating it, and a newer
export adds only what's new.

There's also an offline path for seeding your own account on first run: drop
files into `import/`, set `IMPORT_OWNER`, and run `npm run import`.

**Menu → Sync** covers the apps you don't export by hand — Home Assistant,
Strava and Komoot.

## Rebuilding the map data

`src/countries.json` and `src/places.json` are committed so that a fresh clone
runs without network access, but you can rebuild them:

```sh
npm run build:countries   # Natural Earth boundaries
npm run build:places      # GeoNames towns + Natural Earth lakes
```

## Tests

```sh
npm test
```

## How it works

The implementation notes — the hex grid maths, the blob rendering pipeline, the
crossfade between zoom levels, the security model, the basemap rewriting — live
in **[ARCHITECTURE.md](ARCHITECTURE.md)**. It's long, and it explains the *why*
behind most of the non-obvious code.

## Attribution

Map data and imagery belong to the people who made them:

| Source | Used for | Terms |
| --- | --- | --- |
| [GeoNames](https://www.geonames.org/) `cities5000` | Town and city names | **CC BY 4.0** |
| [Natural Earth](https://www.naturalearthdata.com/) | Country boundaries, named lakes, shaded relief | Public domain |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors | Terrain and satellite basemap vectors, via [OpenFreeMap](https://openfreemap.org/) | **ODbL** |
| [CARTO](https://carto.com/basemaps/) | Dark Matter and Voyager basemaps | Free tier, attribution required |
| [Esri](https://www.esri.com/) World Imagery | Satellite basemap | Esri terms |
| [geojs.io](https://www.geojs.io/) / [ipwho.is](https://ipwho.is/) | Approximate location on first load | Free tier |

Built with [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause),
[polygon-clipping](https://github.com/mfogel/polygon-clipping) (MIT) and
[Vite](https://vite.dev/) (MIT).

These credits also appear in the map's own attribution control, as their
licences require.

## Licence

[Apache-2.0](LICENSE).

The licence covers the code. The bundled map data carries its own terms — see
**Attribution** above. In particular, the GeoNames data baked into
`src/places.json` is CC BY 4.0 and requires attribution wherever it goes.
