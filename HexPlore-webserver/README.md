# Hexplore

An interactive world map covered in a hexagonal grid, where you mark the places
you've been. Cells are hexagons in storage but never look like it — they're
blurred and re-cut into soft blobs that flow together, so a map of your life
reads as spilled ink rather than a spreadsheet.

Point it at your location history and it fills itself in.

Working on it rather than using it? [ARCHITECTURE.md](../ARCHITECTURE.md) is the
long version — why the grid is what it is, how the blobs are drawn, and a
number of approaches that were tried and abandoned.

---

## What it does

- **Click to mark.** Turn on editing and paint cells. The base cell is about
  900 m across; marks roll up, so a single visited cell lights its whole
  country when you zoom out — and its whole continent one step further.
- **Soft blobs, not tiles.** Marked areas are drawn as discs, blurred, and cut
  at a fixed alpha — neighbouring cells merge and blend their colours.
- **Import your history.** GPX, KML, TCX, FIT, GeoJSON, CSV, Google Timeline,
  Snapchat, Apple Photos, or a whole Strava ZIP. Parsed **in your browser** —
  the files never leave your machine, only the cells they resolve to.
- **Sync automatically.** Home Assistant (polled by the server on a schedule),
  Strava (after a one-time sign-in), Komoot (one tour at a time).
- **Or let your phone do it.** The iOS app records where you have been with the
  screen off — you pick how often, from every minute to only-when-you-go-
  somewhere — and brings in the Apple Health workouts that carry a route.
- **There is a Mac app too.** The same site in a window, with the same photo
  import. It records where a laptop has been if you ask it to — off by default,
  because unlike a phone a Mac only records while the app is running. No Apple
  Health, because macOS has none.
- **Saved routes.** Tracks from your imports are kept as lines, named after
  where they went and what sport they look like.
- **Your photos on the map** (in the apps, not a browser). A point wherever you
  have taken one, grouped where they pile up; tap for the picture and the time
  it was taken. No photo is ever uploaded — the app reads them off the device it
  is running on, which is also why this switch is not in the menu in a browser.
- **Four basemaps** — dark, terrain, light, satellite. Colour the map with a
  single accent, or shade each cell by **visits**, by **first seen**, or by
  **type** (a colour per app the data came from).
- **Ask any area what it knows.** Tap a blob for when you were there, how many
  visits, and which app it came from — or switch **Tap for details** off in the
  layers menu when you would rather just look at the map. Routes, photos and the
  reference overlays still answer; they are things you aimed at.
- **Train tracks.** Every line, siding and yard OpenRailwayMap knows about, laid
  over the map in the basemap's own light or dark. Switch it on in the layers
  menu; choose what it draws in Settings → Train tracks — tracks, stations,
  platforms, line numbers, signals and crossings, kilometre posts, and the
  sidings, yards and disused track that are off until you ask for them. Turn on
  **Interactable** and the railway answers the pointer: whatever is under it
  lights up, and a tap opens a card with the track number, the operator, the
  voltage, the platform, and every service that calls there.
- **Airports.** Every airport, airfield and helipad on Earth, from the
  public-domain OurAirports dataset — built into the app, so there is no key to
  get, nothing to sign up for, and it works offline. Switch it on in the layers
  menu. Out of the box it shows the five thousand airports airlines actually fly
  to; Settings → Airports adds the small airfields and glider strips, the
  helipads, and the ones that have closed. Codes when you are zoomed out, names
  when you are in, and a tap says the IATA and ICAO codes, the town, the
  elevation, how many runways there are and how long the longest one is, what it
  is made of and whether it is lit — with links to Wikipedia and the airport's
  own site.
- **Export a picture.** A place cut out of the world — one canton, three
  countries, a whole continent — with your ground inside it and a caption saying
  how much of it you have covered. Drag the preview to frame it, click it to pick
  places, and save it vertical, horizontal or square at up to 4×, in the colours
  you choose.
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

To pick up new changes on a machine that is already serving:

```sh
npm run restart   # pull, install, build, then swap the running server for a new one
```

It runs from any directory, keeps the old server up until the build has
succeeded, stops it by port rather than by killing every `node` on the machine,
and waits for the new one to answer before claiming it worked. `--no-pull`
skips the `git pull`; `PORT` picks a different port.

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
| `ALLOW_REGISTRATION` | on | `0` closes registration once the first account exists |
| `REGISTRATION_CODE` | — | Keeps registration open, behind an invite code |
| `MIN_PASSWORD_LEN` | `10` | Minimum password length |
| `IMPORT_OWNER` | — | Account the offline importer's cells belong to |
| `HA_BLOCK_PRIVATE` | off | Restricts Home Assistant to public addresses only |
| `HA_ALLOWED_HOSTS` | — | Comma-separated allowlist of Home Assistant hosts |

## Getting your data in

Menu → **Import & sync**. Five ways in, and you can mix them:

| | |
| --- | --- |
| **Files** | Drop in GPX, KML, TCX, FIT, GeoJSON, CSV, a `.gz`, or a whole Strava ZIP — as many at a time as you like. Parsed **in your browser**: the file never leaves your machine, only the cells it resolves to. Google Timeline, Snapchat and Apple Photos exports are recognised too |
| **Home Assistant** | Paste your address and a long-lived token, tick the devices to follow, and the server keeps the map current on its own. It reads history your recorder already wrote — it never wakes your phone |
| **Strava** | One-time sign-in, then your activities come across on a schedule |
| **Komoot** | Paste a tour link; your browser fetches it |
| **Your phone** | [Hexplore for iOS](../HexPlore-IOS/README.md) records where you have been in the background and sends it here, with no other app in the middle. It also brings across the Apple Health workouts that went somewhere — a ride, a walk, a run outdoors — as cells and as saved lines, and reads the locations your **photo library** already knows. Set up on the phone; this page shows you whether it is working |

Before anything is saved you get a preview: what each file was recognised as,
how many fixes it holds, how many cells that is, **how many are new**, the dates
they cover, and how many routes it found.

**Re-importing is the point.** Cells are stored per source, so importing the
same export again refreshes its dates and counts in place rather than
duplicating anything, and importing a *newer* export adds only what's new. Drop
your old files back in whenever you like.

**A visit is a stay, not a fix and not an arrival.** Fixes in the same cell go
on counting as one visit until a whole day passes with none, so an hour of 1 Hz
workout recording counts once, a morning and an evening in the same place count
once, and a week living there counts once. Going back next month counts again.

**No files at all?** Turn on editing in the menu and paint cells by hand.
Ctrl-drag sweeps.

**Changed your mind about a whole source?** Menu → Export & settings →
**Sources** lists everything that has put something on your map and takes one
back off wholesale. That is a different question from clearing a cell: clearing
says *I was never here*, whoever said otherwise, while this says *stop trusting
this way of finding out* — so a cell another source also vouches for stays.

**Done with the whole thing?** Menu → Export & settings → **Settings** → **Delete
this account**, at the bottom. It takes the map, the saved routes, your
preferences and any Home Assistant or Strava connection with it, and asks for
your password first because none of it comes back. One thing it cannot reach:
a backup taken before you did it still holds a copy until it ages out.

## What you get

**Saved routes.** Any track you import can keep the line it drew, not just the
ground it covered. Routes are named after where they went ("Bern → Thun",
"Thunersee loop"), get their activity worked out from the file — or from their
pace and climb when the file doesn't say — and are listed with a little drawing
of their own shape, which is how you actually recognise one. Tap a line on the
map for its card. The list sorts by **newest or longest** and groups by **app or
activity**, and the two are independent — so "the longest ride, and the longest
hike" is one question you can ask.

**Your photographs, on the map.** In the iPhone and Mac apps, *Photos* in the
layers menu puts a point wherever you have taken one. Where they pile up they gather into a
group with a count on it, and tapping one opens it — however many are in there.
One picture at a time — the most recent first, with the rest as a strip along
the bottom — and it says when each was taken. Zooming is still the map's own gestures; a tap
is always about the photographs.

Nothing is uploaded and nothing is shared. The app reads the photographs off the
device it is running on, one at a time, only when you tap one, and only to show
it to you — which is exactly why the switch is not there in a browser.

**Tap the picture** and it opens full screen at its original size, where you can
pinch and double-tap to zoom. **Videos are there too**, marked with a play
button: pressing it opens the phone's own player over the map — full quality,
with scrubbing and AirPlay, and nothing copied or uploaded to make it happen.
Either way, closing it puts you back on the map exactly where you were, card and
all. An original that lives in iCloud has to come down first, so the button
spins while it does.

One thing it does not do: there is **no "Open in Photos"**. iOS gives no app a
way to open one particular photo, so such a button would open the Photos app at
something else entirely — and the card is showing you the picture anyway.

**An image of a place.** *Export & settings → Export an image* makes a picture
rather than a screenshot: pick any number of regions, countries or continents and
everything outside them is cut away along their real boundaries — fetched at
national-survey detail for the countries in the picture, so a canton has the
coastline it actually has. **Drag the preview to frame it and click it to pick
places**, which beats finding "Valais" in a list of twenty-six. Choose the shape
(vertical, horizontal or square, each with its own proportions, up to 4× or an
exact pixel size), how the visited ground is drawn (the blobs themselves, or
filled regions, countries or continents), what it is coloured by, and the palette
— including a transparent background, if you want to drop it onto something else.
Then add a caption: pick a corner for it, pick which numbers it carries — land
covered, regions visited, first seen, longest streak — and set the type, the size
and the colour. It is drawn from the map already in your browser and saved
straight to your machine; nothing is uploaded.

**Trips.** The search panel groups your history into the runs of
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

**Somewhere you keep going back to isn't a trip, it's your week.** A day run to
a city you visit half a dozen times a year stops counting, because a list you
opened to remember holidays by shouldn't be six rows of the same errand. Two
things override that: a night away is always a trip, and so is any day you
bothered to record a route on. And you can put any trip away by hand — one press
on the row, and one press on the row underneath the list brings them all back.

**Trips live in the search panel** (the magnifier, or ⌘K). Open it with nothing
typed and it *is* the trip list: sort by **newest, longest or furthest from
home**, **group by country** — the sort holds inside each group — put one away
with the ×, and set where home is. Start typing and it narrows, on anywhere a
trip went rather than only its name, with your routes and any place on Earth
underneath.

Each one is named after **where you actually spent the time** — measured from
the gaps between your own fixes, so a day out is named after the four hours in
the village and not the twenty minutes through the bigger town on the way. A
fortnight in Rome with a day out to Florence is *Rome*, not the hill town
halfway between them, and a week in a village near a city keeps the village's
name. Somewhere too small for the map to have heard of it hands the name to the
region instead, which is the honest answer rather than a town you drove past.

You can also **find a trip by anywhere it went**, not only by what it is called:
searching a town it passed through, or the canton it crossed, will turn it up.

Everything here is measured from **home**, which the map guesses from the
cells you go back to most. If it guesses wrong, the row above the list
lets you set it — search for a town, or **point at it on the map**: the dialog
steps aside, you tap where you live, and confirm. Tick **Map** on the same row
and a little house appears where it thinks you live, which is the quickest way
to see that the guess is off.

**Statistics.** How much ground you've actually covered, as a share of Earth's
land and of every country you've touched. **Open a country** to see the same for
each of its **regions** — states, provinces, cantons, départements. Countries
move once a year; cantons move on a weekend. Every bar is that place's own share,
so 7% of Switzerland looks like 7%, and the list sorts by ground covered or by
share. Plus how many days your history actually carries and your longest
unbroken run of them, where your cells came from, and how much new ground each
year added.

**Search** (the magnifier, or **⌘K**). One field over places, your routes, your
trips, and whole regions and countries. Every place is listed with its country,
because four of the answers to "paris" are in the United States. Type a date —
`2024-08-12`,
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

**Works with the server off.** A production build installs a small service
worker, so after you have opened the map once it keeps the app itself, the town
and boundary data, and the last answer the server gave about your map. Open it
on a plane and you get your cells, your routes and your trips, with a banner
saying the server can't be reached — reads come back, edits don't pretend to
save. Basemap and railway tiles aren't kept there (they're someone else's to
serve), so offline your map sits on an empty background. Signing out throws the
whole cached copy away.

Both apps get this for free: each is the same site in a web view, and web views
have run service workers since iOS 14.

**Zooming out** goes from hexagons to shapes you recognise: at about z5 the grid
gives way to **regions** — cantons, states, départements — one step further out
to whole countries, and at the very end to **continents**, each labelled with
how many of its countries you have been to. *Detail* pins the first three: the
finest grid, Region, or Country. Continents are the end of the zoom rather than
a setting — there is nothing to pin a valley to.

A country belongs to one continent whole, which is why Russia lights up Europe
and Turkey lights up Asia: that is how Natural Earth files them, and how the UN
does too.

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
came from. Press whichever one is already on and the visited areas come off the
map entirely, for a look at the ground underneath. Every colour has an
**opacity** slider under the hue strip, so you can turn the visited wash down
until the map underneath reads through it, or fade one activity's routes back
without hiding them. Terrain and Satellite are
kept to the same label and road density as Light, and roads on all of them fade
out as you zoom away rather than shouting over the map.

## Rebuilding the map data

Committed, so a clone runs without network. Re-run only to refresh it:

```sh
npm run build:countries   # Natural Earth boundaries
npm run build:continents  # which continent each country is on
npm run build:places      # GeoNames towns + Natural Earth lakes
npm run build:regions     # Natural Earth states, provinces and cantons
npm run build:airports    # OurAirports airports and runways
```

## Tests

```sh
npm test
```

Covers the parts where being wrong is quiet: the hex maths, visit counting,
activity guessing, the route API, preference syncing, the backup scheduler and
its skip logic, undo's restore path, trip derivation and naming, search, colour
parsing, the coverage arithmetic, the framing and captioning behind the image
export — including whether a picture of Fiji comes out as Fiji or as the Pacific
— the request caching, including the two ways a cache can lie, by answering
"nothing changed" when something did and by never saying it when nothing has, and
the airports overlay, where the build and the browser hold two halves of one
agreement that nothing at run time would notice had drifted.

## Keeping it yours

- **Registration is open**, so a map is worth putting more than one person on.
  An account is not access to anyone else's map — every row is stored per
  account — but on a host anyone can reach it is a share of your disk and your
  server's outbound reach, so if that matters: `ALLOW_REGISTRATION=0` shuts the
  door behind the first account, and `REGISTRATION_CODE=…` keeps it open only to
  people holding an invite code. Either way it is rate limited to five an hour
  per address.
- **Sign-in is rate limited**, passwords are at least 10 characters, and
  sessions expire after 90 days.
- **Put it behind HTTPS.** `tailscale serve` in front of `npm start` gives you
  an HTTPS URL reachable only from your own devices — and "my location" needs
  HTTPS to work at all.
- **Your data is yours.** `data.db`, `import/` and any backups are gitignored.
  Files you import are parsed in the browser and never uploaded.

The reasoning behind all of the above — the security model, what the server is
allowed to connect to, and why each limit is where it is — is in
[ARCHITECTURE.md](../ARCHITECTURE.md).

## Stack

- [MapLibre GL JS](https://maplibre.org/) — vector map rendering
- [Vite](https://vite.dev/) — dev server / bundler
- Basemaps: [CARTO](https://carto.com/basemaps/), [OpenFreeMap](https://openfreemap.org/), Esri World Imagery
- Railways: [OpenRailwayMap](https://www.openrailwaymap.org/) vector tiles
  ([openrailwaymap.app](https://openrailwaymap.app/), ODbL via OpenStreetMap)
- Boundaries and lakes: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Detailed region boundaries, fetched per country on demand:
  [geoBoundaries](https://www.geoboundaries.org/) (CC BY 4.0, compositing national survey data)
- Town names: [GeoNames](https://www.geonames.org/) `cities1000`, thinned (CC BY 4.0)
- Airports and runways: [OurAirports](https://ourairports.com/data/) (public domain),
  built into the app rather than fetched

Built with no runtime dependencies beyond MapLibre and a polygon-clipping
library; the server has none at all.
