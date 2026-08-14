// Tiny auth + per-user cell-storage API for Visited Map.
//
// Built entirely on Node's standard library — no npm dependencies:
//   • node:http     — the server
//   • node:sqlite   — the database (data.db), stable enough here on Node 22+
//   • node:crypto   — scrypt password hashing + random session tokens
//
// Endpoints (all JSON, same-origin):
//   POST /api/register {username,password} → {username,version} + session cookie
//   POST /api/login    {username,password} → {username,version} + session cookie
//   POST /api/logout                       → {ok}        (clears cookie)
//   POST /api/account/delete {password}    → {ok,username,removed} | 401/403/429
//   GET  /api/me                           → {username,version} | 401
//   GET  /api/update                       → {version,latest,newer} | 401
//   GET  /api/airport?lat=&lng=            → {airport|null}     | 401  (the phone)
//   GET  /api/prefs                        → {prefs}            | 401
//   POST /api/prefs {prefs}                → {ok}               | 401
//   GET  /api/cells                        → {sources,rows}     | 401
//   POST /api/cells/mutate {add,remove}    → {ok,total}         | 401
//   POST /api/cells/restore {rows}         → {ok,restored}      | 401  (Undo)
//   POST /api/cells/import {source,cells}  → {ok,added,updated} | 401
//   GET  /api/routes[?geom=1]              → {routes}           | 401
//   POST /api/routes {routes}              → {ok,added,skipped} | 401
//   POST /api/routes/places {places}       → {ok,updated}       | 401
//   POST /api/routes/delete {id}           → {ok,route,total}   | 401
//   -- derived, read-only (server/derive.js): worked out here so two clients
//      signed into one account cannot answer differently.
//   GET  /api/trips                        → {trips,home}       | 401
//   GET  /api/stats                        → {cells,km2,countries,regions,days,…} | 401
//   GET  /api/days                         → {days:{"YYYY-MM-DD":{cells,routes}}} | 401
//   GET  /api/day/:YYYY-MM-DD              → {key,routes,cells,points,trip} | 401/400
//   GET  /api/ha                           → {link}             | 401
//   POST /api/ha {baseUrl,token,…}         → {link}             | 401
//   POST /api/ha/probe {baseUrl,token}     → {entities}         | 401
//   POST /api/ha/sync                      → {link,added,…}     | 401
//   POST /api/ha/delete                    → {ok}               | 401
//   GET  /api/strava                       → {link,callbackDomain} | 401
//   POST /api/strava {clientId,…}          → {link}             | 401
//   POST /api/strava/authorize             → {url}              | 401
//   GET  /api/strava/callback?code&state   → 302 /?strava=…
//   POST /api/strava/sync                  → {link,activities,…}| 401
//   POST /api/strava/delete                → {ok}               | 401
//   GET  /api/regions/:iso                 → {regions}          | 401
//   GET  /api/backup                       → {backup}           | 401/403
//   POST /api/backup {enabled,cron,keep}   → {backup}           | 401/403
//   POST /api/backup/run                   → {status,backup}    | 401/403
//   GET  /api/backup/download?name=…       → the file           | 401/403
//
// Cells are stored one row per (cell, source) in `cell_sources`, so a cell can
// carry provenance from several imports at once and re-importing a source just
// refreshes its own rows. See the table comment below.
//
// Saved routes (the line a GPX/KML track actually drew) live in their own
// `routes` table — they're drawn over the map, not folded into it, and a route
// is identified by a hash of its own geometry so a re-import is a no-op.
//
// Home Assistant is the one source the server fetches itself: it polls your own
// instance for `device_tracker`/`person` history and merges the fixes as source
// 'home-assistant'. Nothing is inferred between them — a fix is a fix.
//
// In dev, Vite (5173) serves the front-end and proxies /api here (3001). In
// production the server also serves the built dist/ folder, so one process
// hosts everything — run `npm run build` then `npm start`.
//
// Env: PORT (default 3001), DB_PATH (default ./data.db), COOKIE_SECURE=1 to add
// the Secure flag (set this behind HTTPS), IMPORT_OWNER=<username> to merge the
// baked-in imported history into that one account (default: unset — every new
// account starts empty and nobody gets it auto-filled), BACKUP_DIR (default
// ./backups) for where the timed copies of data.db are written,
// REGION_CACHE_DIR (default ./cache/regions) for the detailed boundary cache,
// RAIL_CACHE_DIR (default ./cache/rail) and RAIL_CACHE_BYTES (default 512 MB)
// for the OpenRailwayMap tile cache, TRAILS_CACHE_DIR (default ./cache/trails)
// and TRAILS_CACHE_BYTES (default 256 MB) for the Waymarked Trails one.

import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, scrypt as scryptCb, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { totalmem, freemem, loadavg, cpus } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLimiter, clientIp } from './rate-limit.js';
import * as derive from './derive.js';

// ┌──────────────────────────────────────────────────────────────────────────┐
// │  BUMP THIS ON EVERY CHANGE TO THE CODE.                                  │
// └──────────────────────────────────────────────────────────────────────────┘
//
// It is shown at the foot of Settings, and it exists for one question: *which
// build am I actually looking at*. Every confusing hour this project has spent
// so far has been some version of that — a browser replaying a year-old
// `immutable` response, a 304 served against a signature that could not see the
// dataset change underneath it, a service worker holding a shell from a build
// two deploys ago. In each of them the map looked merely *wrong*, and there was
// nothing on screen to say the code you were reading was not the code that was
// running.
//
// A number you can read out loud settles that in one message. It is only worth
// anything if it moves, so move it — a patch bump for a fix, a minor for
// anything a user would notice. Stale here is worse than absent: a version that
// lies is how you rule out the very thing that is wrong.
export const SERVER_VERSION = '0.78.0';

// --- …and whether somebody has published a newer one ------------------------------
//
// This is self-hosted, and there is no update mechanism and no wish for one: it
// is updated by pulling and restarting, deliberately, by the person who runs
// it. What there was no way to know is *that there is anything to pull* — a
// server left running for three months looks exactly like one that is current,
// and the number at the foot of Settings could only ever describe itself.
//
// So the server asks, and the whole answer is the same constant read off the
// published copy. There are no releases and no tags to compare against; the
// version that means anything in this project is the one above, and the
// authoritative copy of it is the one on `main`.
//
// Three things keep it honest:
//
//   • **The server asks, not the page.** One machine, one cache, one address
//     seen by GitHub — rather than every browser and every phone that opens
//     Settings announcing itself.
//   • **Sixteen kilobytes, not the file.** The constant is at the top, so the
//     request carries a `Range` header. A CDN that ignores it costs the whole
//     file and still works; one that honours it costs 16 KB.
//   • **It can be switched off**, and it is the only outbound request this
//     server makes that nobody configured. `UPDATE_CHECK=0` and it never runs.
//
// Env:
//   UPDATE_CHECK=0       never ask
//   UPDATE_SOURCE=<url>  ask somewhere else — a fork's raw URL, or a file
const UPDATE_CHECK = !/^(0|false|no|off)$/i.test(String(process.env.UPDATE_CHECK ?? ''));
const UPDATE_SOURCE = process.env.UPDATE_SOURCE
  || 'https://raw.githubusercontent.com/zhekch/hexplore/main/HexPlore-webserver/server/index.js';

/** How long an answer stands. Nobody publishes twice in an afternoon. */
const UPDATE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * …and how long a *failure* stands, which is much shorter but not nothing.
 *
 * A server that is offline must not ask again on every press of Settings, and a
 * server that has just come back should not be six hours behind knowing it.
 */
const UPDATE_RETRY_MS = 15 * 60 * 1000;

/** Enough to reach the constant, which is at the top of this file by design. */
const UPDATE_BYTES = 16 * 1024;

/** And how long to wait for it. There is a person on the other end of this. */
const UPDATE_TIMEOUT_MS = 6000;

// The last answer, and when it was got. `ok` is false for "asked and could not
// tell", which is a different thing from "asked and there is nothing newer".
let updateHeld = { at: 0, ok: false, latest: null };

/**
 * Compare two `x.y.z` strings. Numeric, part by part, because `'0.10.0'` sorts
 * before `'0.9.0'` as text and that is exactly the release where it would
 * matter.
 *
 * @returns {boolean} whether `a` is a later version than `b`
 */
export function isNewerVersion(a, b) {
  const parts = (v) => String(v ?? '').split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

/**
 * The published version, or null for "cannot tell".
 *
 * Null rather than the running version, and that distinction is the whole
 * point: a check that cannot get through must not be able to say "you are up
 * to date". Settings says nothing at all in that case.
 */
async function publishedVersion() {
  if (!UPDATE_CHECK) return null;
  const age = Date.now() - updateHeld.at;
  if (age < (updateHeld.ok ? UPDATE_TTL_MS : UPDATE_RETRY_MS)) return updateHeld.latest;
  try {
    const res = await fetch(UPDATE_SOURCE, {
      headers: {
        Range: `bytes=0-${UPDATE_BYTES - 1}`,
        'User-Agent': `hexplore/${SERVER_VERSION}`,
      },
      signal: AbortSignal.timeout(UPDATE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // Sliced as well as ranged: a source that ignores the header sends the
    // whole file, and the constant is either in the first 16 KB or this is not
    // the file we asked for. Bounding the regex is also what stops a large or
    // hostile answer costing anything to search.
    const found = /SERVER_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/
      .exec((await res.text()).slice(0, UPDATE_BYTES))?.[1] ?? null;
    updateHeld = { at: Date.now(), ok: !!found, latest: found };
  } catch {
    // Offline, blocked by a firewall, timed out, or answering with something
    // that is not this file. All of them are "cannot tell".
    updateHeld = { at: Date.now(), ok: false, latest: null };
  }
  return updateHeld.latest;
}

const scrypt = promisify(scryptCb);
// The same folding the browser importer uses, so a fix from Home Assistant and
// a fix from a GPX file land in the same cell and count the same way.
import { pointsToCells, VISIT_GAP_SEC } from '../src/locations.js';
import { probe, ping, pullFixes, normalizeBaseUrl, isFollowableEntity, FIRST_SYNC_DAYS } from './home-assistant.js';
import * as strava from './strava.js';
import { userMessage } from './user-error.js';
// Routes saved by the poller are built with the same helpers the browser uses,
// so a Strava ride and an imported GPX are keyed and simplified identically.
// Their *names* are left blank: the place-name dataset is a 2 MB browser chunk,
// and POST /api/routes/places already exists to fill them in from the page.
import { buildRoutes, guessSport, canonicalSport, routeThumb, splitOnGaps, trackName } from '../src/routes.js';
import { isKomootTourUrl } from '../src/komoot.js';
// Everything above is about getting data *in*. This is the one thing that
// copies it back out again, on a schedule, without being asked.
import { createBackups, isBackupName } from './backup.js';
// Detailed region boundaries, fetched once per country and cached on disk. The
// browser can't fetch these itself — see the module for why.
import { createFineRegions } from './regions-fine.js';
// The train-tracks overlay's vector tiles, cached here rather than fetched by
// every browser separately. Read the policy note at the top of that module
// before touching how often it asks upstream.
import { createRailTiles } from './rail-tiles.js';
// The trails overlay's raster tiles, and the lookup behind the card a tap
// opens. Both proxied rather than fetched from the page — the note at the top
// of that module is about why, and one of the three reasons is that a tile
// request from this app is a coordinate somebody visited.
import { createTrailTiles } from './trail-tiles.js';
import { loadRegions } from '../src/regions.js';
import { airportAt } from './airport-at.js';
import { describeCron } from '../src/cron.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 3001;
const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data.db');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true';
const IMPORT_OWNER = process.env.IMPORT_OWNER || null;
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(ROOT, 'backups');
const REGION_CACHE_DIR = process.env.REGION_CACHE_DIR || path.join(ROOT, 'cache', 'regions');
const RAIL_CACHE_DIR = process.env.RAIL_CACHE_DIR || path.join(ROOT, 'cache', 'rail');
const TRAILS_CACHE_DIR = process.env.TRAILS_CACHE_DIR || path.join(ROOT, 'cache', 'trails');
const DIST = path.join(ROOT, 'dist');
const SERVE_STATIC = existsSync(DIST);
// Sessions are checked against this server-side now, not just handed to the
// browser as a cookie lifetime. 90 days still means you stay logged in on your
// phone for a season; a year of a token that could never expire did not.
const SESSION_MAX_AGE = 60 * 60 * 24 * 90;
const MIN_PASSWORD_LEN = Number(process.env.MIN_PASSWORD_LEN) || 10;

// Registration is open, and closing it is a choice you make rather than the
// default.
//
// It was the other way round — open until somebody signed up, then shut — on the
// argument that a session is what stands between a stranger and the importer,
// the saved routes and the Home Assistant connector. That argument is still
// true, and it is worth reading before leaving this alone on a host anyone can
// reach: an account is not access to *your* map, since every row is per account,
// but it is a share of your disk and your server's outbound reach.
//
// What it weighs against is that a map like this is worth having more than one
// person on, and "make an account" failing with a 403 for everybody but the
// first is a bad first impression that has to be debugged from the server side.
// Registration stays rate limited either way — five an hour per address.
//
// ALLOW_REGISTRATION=0 restores the old behaviour: the first account can always
// be made, and the door shuts behind it. REGISTRATION_CODE=… is the middle
// ground, open to anyone holding an invite code.
const ALLOW_REGISTRATION = !/^(0|false|no|off)$/i.test(String(process.env.ALLOW_REGISTRATION ?? ''));
const REGISTRATION_CODE = process.env.REGISTRATION_CODE || '';

function registrationRefusal() {
  if (ALLOW_REGISTRATION || REGISTRATION_CODE) return null;
  const n = db.prepare('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
  return n === 0 ? null : 'This map is not accepting new accounts.';
}

// Windows sized so a person who mistypes their password a few times never
// notices, and a script trying a wordlist gets nowhere.
const loginIpLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
const loginUserLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
const registerLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
// Closing an account checks a password, so it is a password oracle like the
// login is — and a slower one to be caught at, since nothing about a failed
// attempt shows up on the map. Tighter than login: nobody deletes their account
// five times in an hour, and the one person who is trying already knows the
// password.
const deleteAccountLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
// Everything an admin can do *to somebody else* — reset a password, open their
// account, end their sessions — shares one window, keyed by the admin. Not a
// guessing defence: the caller has already proved who they are. It is a ceiling
// on a loop that has got loose, in the one part of this file where a loop
// rewrites other people's passwords.
const adminActionLimiter = makeLimiter({ windowMs: 5 * 60 * 1000, max: 40 });

const nowISO = () => new Date().toISOString();
const nowSec = () => Math.floor(Date.now() / 1000);

// --- Database ----------------------------------------------------------------
const db = new DatabaseSync(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    pass       TEXT NOT NULL,           -- "salt:scryptHash", both hex
    created_at TEXT NOT NULL,
    -- Whoever runs the server. Granted to the first account to register and
    -- never inferred from anything else — see bootstrapAdmin().
    is_admin   INTEGER NOT NULL DEFAULT 0,
    -- The two halves of "is this account still in use". A login is somebody
    -- typing a password; a sighting is any request a live session made, which
    -- is the one that keeps moving on a phone nobody has signed out of.
    last_login TEXT NOT NULL DEFAULT '',
    last_seen  TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    -- Set only on a session an admin opened *as* somebody else, and holding the
    -- admin's own id. It is what "return to your own account" reads, and it is
    -- deliberately not consulted for anything else: while it is set, the session
    -- is the other account in every respect, permissions included.
    admin_id   INTEGER NOT NULL DEFAULT 0
  );
  -- Legacy single-blob storage. Kept as a backup of the pre-provenance data;
  -- nothing writes to it any more (see migrateCellSets).
  CREATE TABLE IF NOT EXISTS cell_sets (
    user_id      INTEGER PRIMARY KEY,
    data         TEXT NOT NULL,         -- JSON array of visited cell ids
    import_stamp TEXT,
    updated_at   TEXT NOT NULL
  );
  -- One row per (cell, source): a cell you both walked through with Google
  -- Timeline on and painted by hand has two rows, and re-importing a source
  -- only ever rewrites that source's own rows.
  CREATE TABLE IF NOT EXISTS cell_sources (
    user_id  INTEGER NOT NULL,
    cell_id  TEXT NOT NULL,             -- "L/col/row"
    source   TEXT NOT NULL,             -- 'manual' | 'google-timeline' | …
    added_at INTEGER NOT NULL,          -- epoch s: when this row entered the map
    first_at INTEGER NOT NULL DEFAULT 0,-- epoch s of the earliest fix (0 = unknown)
    last_at  INTEGER NOT NULL DEFAULT 0,-- epoch s of the latest fix
    hits     INTEGER NOT NULL DEFAULT 1,-- separate visits to the cell
    fixes    INTEGER NOT NULL DEFAULT 0,-- raw location fixes behind them (0 = unknown)
    PRIMARY KEY (user_id, cell_id, source)
  );
  CREATE INDEX IF NOT EXISTS cell_sources_user ON cell_sources(user_id);
  -- One row per saved route: the simplified line, plus what it measures out to.
  -- The key is a hash of the geometry and its dates, so importing the same
  -- track file twice is a no-op instead of a second copy on the map.
  CREATE TABLE IF NOT EXISTS routes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id  INTEGER NOT NULL,
    key      TEXT NOT NULL,
    name     TEXT NOT NULL,
    place    TEXT NOT NULL DEFAULT '', -- where it went, from src/places.js ('' = not worked out)
    sport    TEXT NOT NULL DEFAULT '', -- what the file called the activity ('' = it didn't say)
    sport_guessed INTEGER NOT NULL DEFAULT 0, -- 1 = worked out from pace, not read from the file
    thumb    TEXT NOT NULL DEFAULT '', -- tiny normalised outline for the list (src/routes.js)
    link     TEXT NOT NULL DEFAULT '', -- back to the tour it came from (Komoot only, so far)
    elev_up  REAL NOT NULL DEFAULT 0,  -- total ascent in metres (0 = no elevation in the file)
    source   TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    first_at INTEGER NOT NULL DEFAULT 0,
    last_at  INTEGER NOT NULL DEFAULT 0,
    length_m REAL NOT NULL DEFAULT 0,
    points   INTEGER NOT NULL DEFAULT 0,
    min_lng  REAL NOT NULL DEFAULT 0,
    min_lat  REAL NOT NULL DEFAULT 0,
    max_lng  REAL NOT NULL DEFAULT 0,
    max_lat  REAL NOT NULL DEFAULT 0,
    geom     TEXT NOT NULL,             -- JSON [[ [lng,lat], … ], …] (one array per segment)
    UNIQUE (user_id, key)
  );
  CREATE INDEX IF NOT EXISTS routes_user ON routes(user_id);
  -- One Home Assistant instance per account. The server polls it on a timer and
  -- folds whatever it finds into cells, so this row holds both the connection
  -- and where the last poll got to.
  CREATE TABLE IF NOT EXISTS ha_links (
    user_id      INTEGER PRIMARY KEY,
    base_url     TEXT NOT NULL,
    token        TEXT NOT NULL,       -- long-lived access token, as given
    entities     TEXT NOT NULL,       -- JSON array of entity_ids to follow
    max_accuracy INTEGER NOT NULL DEFAULT 250, -- metres; 0 = take every fix
    interval_min INTEGER NOT NULL DEFAULT 15,
    enabled      INTEGER NOT NULL DEFAULT 1,
    cursor       INTEGER NOT NULL DEFAULT 0,  -- epoch s: history is read in past this
    last_run     INTEGER NOT NULL DEFAULT 0,
    last_ok      INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT NOT NULL DEFAULT '',
    last_fixes   INTEGER NOT NULL DEFAULT 0,
    last_cells   INTEGER NOT NULL DEFAULT 0,
    total_fixes  INTEGER NOT NULL DEFAULT 0,
    fails        INTEGER NOT NULL DEFAULT 0   -- consecutive failures, for backoff
  );
  -- One Strava connection per account. The id and secret are the user's own
  -- API application (strava.com/settings/api); the tokens come from the OAuth
  -- round trip and are refreshed in place as they expire.
  CREATE TABLE IF NOT EXISTS strava_links (
    user_id       INTEGER PRIMARY KEY,
    client_id     TEXT NOT NULL,
    client_secret TEXT NOT NULL,
    access_token  TEXT NOT NULL DEFAULT '',
    refresh_token TEXT NOT NULL DEFAULT '',
    expires_at    INTEGER NOT NULL DEFAULT 0,
    athlete       TEXT NOT NULL DEFAULT '',
    save_routes   INTEGER NOT NULL DEFAULT 1,
    interval_min  INTEGER NOT NULL DEFAULT 60,
    enabled       INTEGER NOT NULL DEFAULT 1,
    cursor        INTEGER NOT NULL DEFAULT 0, -- epoch s of the newest activity taken in
    last_run      INTEGER NOT NULL DEFAULT 0,
    last_ok       INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT NOT NULL DEFAULT '',
    last_count    INTEGER NOT NULL DEFAULT 0,
    total_count   INTEGER NOT NULL DEFAULT 0,
    fails         INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT ''    -- one-shot CSRF token for a pending sign-in
  );
  -- One row per phone that reports its own position, from the iOS app.
  --
  -- Nothing here is a connection: Home Assistant and Strava are addresses the
  -- server can go and read, and a phone is not. It pushes when it has something
  -- and is asleep the rest of the time, so this row holds no credentials and no
  -- schedule — only what the last push said, which is what makes "is my phone
  -- actually logging?" answerable from a laptop.
  CREATE TABLE IF NOT EXISTS device_links (
    user_id        INTEGER NOT NULL,
    device_id      TEXT NOT NULL,       -- a UUID the app makes once and keeps
    name           TEXT NOT NULL DEFAULT '',
    platform       TEXT NOT NULL DEFAULT '',
    first_seen     INTEGER NOT NULL DEFAULT 0,
    last_seen      INTEGER NOT NULL DEFAULT 0,
    last_fixes     INTEGER NOT NULL DEFAULT 0,
    last_cells     INTEGER NOT NULL DEFAULT 0,
    total_fixes    INTEGER NOT NULL DEFAULT 0,
    -- The newest fix this device has sent. Fixes at or before it are dropped,
    -- which is what makes re-sending a batch harmless — see /api/device/fixes.
    cursor         INTEGER NOT NULL DEFAULT 0,
    last_workout   INTEGER NOT NULL DEFAULT 0,
    total_workouts INTEGER NOT NULL DEFAULT 0,
    last_photo_scan INTEGER NOT NULL DEFAULT 0,
    total_photos   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id)
  );
  -- Which Apple Health workouts have already been folded in.
  --
  -- The cells a workout lights up are *added* to whatever is there, so taking
  -- the same one twice counts it twice. Strava leans on a cursor for this;
  -- Health cannot, because it hands back an edited old workout as readily as a
  -- new one, and because the phone's query anchor is lost whenever the app is
  -- reinstalled. Remembering the ids is the only exact answer.
  CREATE TABLE IF NOT EXISTS device_workouts (
    user_id    INTEGER NOT NULL,
    workout_id TEXT NOT NULL,           -- HKWorkout.uuid
    taken_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, workout_id)
  );
  -- How this account likes to *look* at its map — which activities are shown and
  -- what colour each is. Not data about where anyone went, which is why it's a
  -- single JSON blob rather than a schema: it changes shape as the UI does, and
  -- nothing else ever queries inside it.
  CREATE TABLE IF NOT EXISTS user_prefs (
    user_id    INTEGER PRIMARY KEY,
    prefs      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Columns added after the first release: CREATE TABLE IF NOT EXISTS leaves an
// existing table exactly as it was, so widen it here instead.
for (const [table, column, decl] of [
  ['cell_sources', 'fixes', 'INTEGER NOT NULL DEFAULT 0'],
  ['routes', 'place', "TEXT NOT NULL DEFAULT ''"],
  ['routes', 'sport', "TEXT NOT NULL DEFAULT ''"],
  ['routes', 'elev_up', 'REAL NOT NULL DEFAULT 0'],
  ['routes', 'sport_guessed', 'INTEGER NOT NULL DEFAULT 0'],
  ['routes', 'thumb', "TEXT NOT NULL DEFAULT ''"],
  ['routes', 'link', "TEXT NOT NULL DEFAULT ''"],
  ['device_links', 'last_photo_scan', 'INTEGER NOT NULL DEFAULT 0'],
  ['device_links', 'total_photos', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'last_login', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'last_seen', "TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'admin_id', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    console.log(`[visited-map] added ${table}.${column}`);
    // `users.last_login` starts empty on every account that already existed,
    // which the admin panel would report as "signed in never" for people who
    // are demonstrably signed in. A session row is created by a login and
    // records when — so the newest one is the honest answer, and it is
    // available for free. Only ever fills a blank: from here on the column is
    // written by the login itself.
    if (table === 'users' && column === 'last_login') {
      const filled = db.prepare(`
        UPDATE users SET last_login = COALESCE(
          (SELECT MAX(created_at) FROM sessions WHERE sessions.user_id = users.id), '')
        WHERE last_login = ''
      `).run().changes;
      if (filled) console.log(`[visited-map] dated ${filled} accounts from their sessions`);
    }
  }
}

// Timed copies of the file all of the above lives in. It owns its own settings
// table and its own timer; the server only has to start it and answer for it.
const backups = createBackups({
  db,
  dbPath: DB_PATH,
  dir: BACKUP_DIR,
  log: (msg) => console.log(`[visited-map] ${msg}`),
});

// Detailed region boundaries. The dataset the pairing works against is the same
// file the browser ships with; Node needs it handed over rather than imported,
// because a JSON import here would want an attribute Vite dislikes.
const fineRegions = createFineRegions({
  dir: REGION_CACHE_DIR,
  log: (msg) => console.log(`[visited-map] regions: ${msg}`),
});
try {
  loadRegions(JSON.parse(readFileSync(path.join(ROOT, 'src', 'regions.json'), 'utf8')));
} catch (e) {
  console.warn(`[visited-map] no region dataset (${e.message}) — detailed boundaries are off`);
}

// The train-tracks tile cache. Its allowlist of upstream source lists is read
// out of the built overlay rather than written twice: the style is the only
// thing that decides which of OpenRailwayMap's sources this map ever asks for,
// and a second copy of that list here is a second thing to keep in step. No
// overlay file, no proxy — the route answers 404 and the toggle stays off.
const railSources = (() => {
  try {
    const style = JSON.parse(readFileSync(path.join(ROOT, 'src', 'rail-style.json'), 'utf8'));
    return new Set(
      Object.values(style.sources)
        .map((s) => /^\/api\/rail\/tile\/(.+)\/\{z\}\/\{x\}\/\{y\}\.pbf$/.exec(s.tiles?.[0] ?? '')?.[1])
        .filter(Boolean),
    );
  } catch (e) {
    console.warn(`[visited-map] no rail overlay (${e.message}) — train tracks are off`);
    return new Set();
  }
})();
// `source/sourceLayer` for every layer the overlay draws — the allowlist for
// their feature API, which the click popup asks for a line's route relations.
// Their source ids as MapLibre sees them are ours with the namespace stripped,
// which is the form their API expects.
const railFeatureViews = (() => {
  try {
    const style = JSON.parse(readFileSync(path.join(ROOT, 'src', 'rail-style.json'), 'utf8'));
    return new Set(
      style.layers
        .filter((l) => l['source-layer'])
        .map((l) => `${l.source.replace(/^hexplore-orm-/, '')}/${l['source-layer']}`),
    );
  } catch {
    return new Set();
  }
})();
const railTiles = createRailTiles({
  dir: RAIL_CACHE_DIR,
  sources: railSources,
  featureViews: railFeatureViews,
  log: (msg) => console.log(`[visited-map] rail: ${msg}`),
});

// No allowlist argument, unlike the railways above: their five themes are five
// path segments on somebody else's server, not a style this app builds and can
// be read for what it uses. The list lives in the module and is pinned to the
// client's copy by scripts/test/trails.mjs.
const trailTiles = createTrailTiles({
  dir: TRAILS_CACHE_DIR,
  log: (msg) => console.log(`[visited-map] trails: ${msg}`),
});

const q = {
  insUser: db.prepare('INSERT INTO users(username, pass, created_at) VALUES(?, ?, ?)'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  delUser: db.prepare('DELETE FROM users WHERE id = ?'),
  insSession: db.prepare('INSERT INTO sessions(token, user_id, created_at, admin_id) VALUES(?, ?, ?, ?)'),
  session: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),

  // --- Who runs this server ---------------------------------------------------
  users: db.prepare('SELECT id, username, created_at, is_admin, last_login, last_seen FROM users ORDER BY id'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countAdmins: db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  adminByName: db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?'),
  setPassword: db.prepare('UPDATE users SET pass = ? WHERE id = ?'),
  // Two clocks, written from two places: one when a password is checked, one on
  // any request a live session makes. See the columns' own note.
  sawLogin: db.prepare('UPDATE users SET last_login = ?, last_seen = ? WHERE id = ?'),
  sawUser: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  countSessions: db.prepare('SELECT user_id, COUNT(*) AS n FROM sessions GROUP BY user_id'),

  prefs: db.prepare('SELECT prefs FROM user_prefs WHERE user_id = ?'),
  setPrefs: db.prepare(`
    INSERT INTO user_prefs(user_id, prefs, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET prefs = excluded.prefs, updated_at = excluded.updated_at
  `),
  getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

  rows: db.prepare('SELECT cell_id, source, added_at, first_at, last_at, hits, fixes FROM cell_sources WHERE user_id = ? ORDER BY cell_id'),
  countCells: db.prepare('SELECT COUNT(DISTINCT cell_id) AS n FROM cell_sources WHERE user_id = ?'),
  // What the derived endpoints key their cache on. Aggregates rather than a
  // counter this file has to remember to bump: six separate paths write cells
  // (the map's edits, undo's restore, the importer, the Home Assistant poller,
  // the Strava poller) and a signature read from the rows cannot be forgotten
  // by any of them. SUM(hits) is here because a re-import changes visit counts
  // in place without touching the row count or any timestamp.
  // Which sources are on the map and how many cells each accounts for. Part of
  // what /api/cells *answers*, and invisible to every aggregate below — see
  // cellsSignature.
  sourceCounts: db.prepare(
    'SELECT source, COUNT(*) AS n FROM cell_sources WHERE user_id = ? GROUP BY source ORDER BY source',
  ),
  cellSignature: db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(MAX(added_at), 0) AS added, COALESCE(MAX(last_at), 0) AS last,
           COALESCE(SUM(hits), 0) AS hits
    FROM cell_sources WHERE user_id = ?
  `),
  routeSignature: db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(MAX(added_at), 0) AS added, COALESCE(SUM(length_m), 0) AS len
    FROM routes WHERE user_id = ?
  `),
  // The rest of a route — everything you can change without changing any of the
  // three numbers above. Renaming one, filing it under a different app, setting
  // its activity or backfilling its place leaves the count, the newest date and
  // the total length exactly where they were, so an aggregate signature cannot
  // see the edit at all: the routes list would answer 304 with the old name on
  // it, and a day's detail would keep reporting one.
  //
  // Read and hashed rather than summed, because the sum of anything here
  // collides on the case that matters — two routes swapping names, a rename to
  // a title of the same length. It is one small row per route on a map that has
  // dozens, next to a cells read that walks tens of thousands, so the honest
  // answer costs less than the shortcut would save. `geom` is deliberately not
  // in it: it cannot change without changing `key`, which changes the count.
  routeEdits: db.prepare(`
    SELECT id, name, place, sport, sport_guessed, source, elev_up, link, LENGTH(thumb) AS thumb
    FROM routes WHERE user_id = ? ORDER BY id
  `),
  hasCell: db.prepare('SELECT 1 FROM cell_sources WHERE user_id = ? AND cell_id = ? LIMIT 1'),
  // Adding an existing (cell, source) keeps its original added_at — the row is
  // only refreshed with whatever the new import knows.
  upsertRow: db.prepare(`
    INSERT INTO cell_sources(user_id, cell_id, source, added_at, first_at, last_at, hits, fixes)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, cell_id, source) DO UPDATE SET
      first_at = excluded.first_at, last_at = excluded.last_at,
      hits = excluded.hits, fixes = excluded.fixes
  `),
  // Manual marks never clobber richer info a re-import may have added.
  touchRow: db.prepare(`
    INSERT INTO cell_sources(user_id, cell_id, source, added_at, first_at, last_at, hits, fixes)
    VALUES(?, ?, ?, ?, 0, 0, 1, 0)
    ON CONFLICT(user_id, cell_id, source) DO NOTHING
  `),
  // Like upsertRow, but for a source that arrives a slice at a time (the Home
  // Assistant poller) instead of as one whole file: counts add up rather than
  // being replaced, and the date span only ever widens.
  //
  // The subtraction is the seam between two polls. pointsToCells() counts a
  // visit per gap *within* its batch, so a stay that straddles a poll boundary
  // would otherwise be counted once on each side; if this batch's first fix in
  // the cell follows the stored last one by less than the visit gap, it's the
  // same visit carrying on and the batch's opening visit is dropped.
  mergeRow: db.prepare(`
    INSERT INTO cell_sources(user_id, cell_id, source, added_at, first_at, last_at, hits, fixes)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, cell_id, source) DO UPDATE SET
      first_at = CASE WHEN first_at = 0 THEN excluded.first_at
                      WHEN excluded.first_at = 0 THEN first_at
                      ELSE MIN(first_at, excluded.first_at) END,
      last_at  = MAX(last_at, excluded.last_at),
      hits     = hits + excluded.hits
                 - (CASE WHEN last_at > 0 AND excluded.first_at > 0
                          AND excluded.first_at - last_at <= ? THEN 1 ELSE 0 END),
      fixes    = fixes + excluded.fixes
  `),
  delCell: db.prepare('DELETE FROM cell_sources WHERE user_id = ? AND cell_id = ?'),
  delSourceCell: db.prepare('DELETE FROM cell_sources WHERE user_id = ? AND source = ? AND cell_id = ?'),
  // Does anything that actually recorded fixes vouch for this cell? See
  // PLACEHOLDER_SOURCES — the two names excluded here are the two non-answers.
  realSourceCell: db.prepare(`
    SELECT 1 FROM cell_sources
    WHERE user_id = ? AND cell_id = ? AND source NOT IN ('unknown', 'manual') LIMIT 1
  `),

  // Routes. Newest first — by when the track happened, falling back to when it
  // was imported for files that carried no dates.
  routes: db.prepare(`
    SELECT id, name, place, sport, sport_guessed, elev_up, source, added_at, first_at, last_at, length_m, points,
           min_lng, min_lat, max_lng, max_lat, thumb, link
    FROM routes WHERE user_id = ?
    ORDER BY (CASE WHEN first_at > 0 THEN first_at ELSE added_at END) DESC, id DESC
  `),
  routesGeom: db.prepare(`
    SELECT id, name, place, sport, sport_guessed, elev_up, source, added_at, first_at, last_at, length_m, points,
           min_lng, min_lat, max_lng, max_lat, thumb, link, geom
    FROM routes WHERE user_id = ?
    ORDER BY (CASE WHEN first_at > 0 THEN first_at ELSE added_at END) DESC, id DESC
  `),
  // Re-importing a file you already imported used to do nothing at all, which
  // was right about not duplicating and wrong about everything else: a route
  // saved before elevation was recorded stayed at 0 m forever, even when you
  // handed it the very file the climb could be read from.
  //
  // So the second import fills gaps — and *only* gaps. Anything you can change
  // in the dialog is something you might have deliberately changed, so:
  //
  //   • elev_up  — taken when the row has none and the file has some. A climb
  //                already worked out is not re-derived.
  //   • sport    — taken when the row has none, or when what it has was only
  //                guessed from the pace and the file actually says. A value
  //                you typed in (sport_guessed = 0) always wins.
  //   • place    — taken when blank; the browser works these out lazily.
  //   • name     — only when the stored one is a placeholder ('Route' or a bare
  //                ISO date), never over a real title, and never over one you
  //                renamed by hand.
  //   • source   — never. Re-filing a route under a different app is an edit.
  //
  // The geometry, dates and length are what the key is built from, so they are
  // identical by definition and there is nothing to update.
  insRoute: db.prepare(`
    INSERT INTO routes(user_id, key, name, place, sport, sport_guessed, elev_up, source, added_at, first_at, last_at,
                       length_m, points, min_lng, min_lat, max_lng, max_lat, thumb, link, geom)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET
      elev_up = CASE WHEN elev_up = 0 AND excluded.elev_up > 0 THEN excluded.elev_up ELSE elev_up END,
      -- A guess is a placeholder, so re-importing the file replaces it outright:
      -- with what the file states, or failing that with the guess the file's own
      -- contents produce. The second case matters because the two guesses are
      -- not equally informed — the backfill that filled these in had only the
      -- length, the clock and the name to go on, while parsing the file itself
      -- also has the elevation track, which is what tells a hike from a walk.
      -- Only a value that is *not* a guess (read from a file, or typed in) is
      -- left alone.
      sport = CASE
                WHEN excluded.sport = '' THEN sport
                WHEN sport = '' THEN excluded.sport
                WHEN sport_guessed = 1 THEN excluded.sport
                ELSE sport END,
      sport_guessed = CASE
                WHEN excluded.sport = '' THEN sport_guessed
                WHEN sport = '' THEN excluded.sport_guessed
                WHEN sport_guessed = 1 THEN excluded.sport_guessed
                ELSE sport_guessed END,
      place = CASE WHEN place = '' THEN excluded.place ELSE place END,
      thumb = CASE WHEN thumb = '' THEN excluded.thumb ELSE thumb END,
      link = CASE WHEN link = '' THEN excluded.link ELSE link END,
      name = CASE
               WHEN excluded.name = '' OR excluded.name = 'Route' THEN name
               WHEN name = 'Route' OR name GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                 THEN excluded.name
               ELSE name END
  `),
  // Backfill for routes stored before place names existed. Only ever fills a
  // blank in: a place already worked out is not second-guessed.
  setRoutePlace: db.prepare(`
    UPDATE routes SET place = ? WHERE user_id = ? AND id = ? AND place = ''
  `),
  // Editing a saved route after the fact. COALESCE so a null leaves the column
  // alone — the dialog can change just the name without resending everything.
  // Setting the activity by hand makes it a fact, so the "we worked this out
  // from the pace" flag comes off with it.
  updRoute: db.prepare(`
    UPDATE routes SET name = COALESCE(?, name), source = COALESCE(?, source),
                      sport = COALESCE(?, sport), place = COALESCE(?, place),
                      sport_guessed = CASE WHEN ? IS NULL THEN sport_guessed ELSE 0 END
    WHERE user_id = ? AND id = ?
  `),
  // Routes stored before the activity was worked out at all. Only ever fills a
  // blank: anything a file actually said is left alone.
  blankSport: db.prepare(`
    SELECT id, name, length_m, first_at, last_at, elev_up FROM routes WHERE sport = ''
  `),
  setGuessedSport: db.prepare(`
    UPDATE routes SET sport = ?, sport_guessed = 1 WHERE id = ? AND sport = ''
  `),
  // ON CONFLICT DO UPDATE always reports a change, so "was this new?" has to be
  // asked before the insert rather than read off its result.
  hasRoute: db.prepare('SELECT 1 FROM routes WHERE user_id = ? AND key = ? LIMIT 1'),
  // Read whole (geometry included) before a delete, so the answer can carry
  // the row away with it — see POST /api/routes/delete.
  routeById: db.prepare('SELECT * FROM routes WHERE user_id = ? AND id = ?'),
  delRoute: db.prepare('DELETE FROM routes WHERE user_id = ? AND id = ?'),
  countRoutes: db.prepare('SELECT COUNT(*) AS n FROM routes WHERE user_id = ?'),

  // Home Assistant links.
  haLink: db.prepare('SELECT * FROM ha_links WHERE user_id = ?'),
  insHaLink: db.prepare(`
    INSERT INTO ha_links(user_id, base_url, token, entities, max_accuracy, interval_min, enabled, cursor)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updHaLink: db.prepare(`
    UPDATE ha_links SET base_url = ?, token = ?, entities = ?, max_accuracy = ?,
                        interval_min = ?, enabled = ?
    WHERE user_id = ?
  `),
  delHaLink: db.prepare('DELETE FROM ha_links WHERE user_id = ?'),
  // A run that worked: the cursor moves on and the failure streak resets.
  haOk: db.prepare(`
    UPDATE ha_links SET cursor = ?, last_run = ?, last_ok = ?, last_error = '',
                        last_fixes = ?, last_cells = ?, total_fixes = total_fixes + ?, fails = 0
    WHERE user_id = ?
  `),
  haFail: db.prepare(`
    UPDATE ha_links SET last_run = ?, last_error = ?, fails = MIN(fails + 1, 99) WHERE user_id = ?
  `),
  // Due for a poll. Repeated failures back off (×2, ×4, ×8) so an instance
  // that's off, moved or holding a stale token isn't hammered every interval.
  haDue: db.prepare(`
    SELECT * FROM ha_links
    WHERE enabled = 1 AND last_run + interval_min * 60 * (1 << MIN(fails, 3)) <= ?
  `),
  // How far this source has already reached, so reconnecting can't rewind into
  // history it has already counted.
  sourceLastAt: db.prepare(
    'SELECT MAX(last_at) AS t FROM cell_sources WHERE user_id = ? AND source = ?',
  ),

  // Strava links.
  stravaLink: db.prepare('SELECT * FROM strava_links WHERE user_id = ?'),
  insStravaLink: db.prepare(`
    INSERT INTO strava_links(user_id, client_id, client_secret, save_routes, interval_min, enabled, cursor)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `),
  updStravaApp: db.prepare(`
    UPDATE strava_links SET client_id = ?, client_secret = ?, save_routes = ?,
                            interval_min = ?, enabled = ?
    WHERE user_id = ?
  `),
  // Signing in again with different credentials invalidates the old tokens.
  clearStravaTokens: db.prepare(`
    UPDATE strava_links SET access_token = '', refresh_token = '', expires_at = 0, athlete = ''
    WHERE user_id = ?
  `),
  setStravaState: db.prepare('UPDATE strava_links SET state = ? WHERE user_id = ?'),
  stravaByState: db.prepare("SELECT * FROM strava_links WHERE state = ? AND state <> ''"),
  setStravaTokens: db.prepare(`
    UPDATE strava_links SET access_token = ?, refresh_token = ?, expires_at = ?, athlete = ?,
                            state = '', last_error = '', fails = 0
    WHERE user_id = ?
  `),
  refreshStravaTokens: db.prepare(`
    UPDATE strava_links SET access_token = ?, refresh_token = ?, expires_at = ? WHERE user_id = ?
  `),
  delStravaLink: db.prepare('DELETE FROM strava_links WHERE user_id = ?'),
  stravaOk: db.prepare(`
    UPDATE strava_links SET cursor = ?, last_run = ?, last_ok = ?, last_error = '',
                            last_count = ?, total_count = total_count + ?, fails = 0
    WHERE user_id = ?
  `),
  stravaFail: db.prepare(`
    UPDATE strava_links SET last_run = ?, last_error = ?, fails = MIN(fails + 1, 99) WHERE user_id = ?
  `),
  stravaDue: db.prepare(`
    SELECT * FROM strava_links
    WHERE enabled = 1 AND refresh_token <> ''
      AND last_run + interval_min * 60 * (1 << MIN(fails, 3)) <= ?
  `),

  // Phones that report their own position. There is no poller here — these rows
  // are written by the pushes themselves.
  devices: db.prepare('SELECT * FROM device_links WHERE user_id = ? ORDER BY last_seen DESC'),
  device: db.prepare('SELECT * FROM device_links WHERE user_id = ? AND device_id = ?'),
  // A push arriving. The name is refreshed every time because a phone gets
  // renamed and the old one would sit in the list forever; first_seen is only
  // ever taken from the insert, so "syncing since June" stays true.
  seenDevice: db.prepare(`
    INSERT INTO device_links(user_id, device_id, name, platform, first_seen, last_seen,
                             last_fixes, last_cells, total_fixes, cursor)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      name        = excluded.name,
      platform    = excluded.platform,
      last_seen   = excluded.last_seen,
      last_fixes  = excluded.last_fixes,
      last_cells  = excluded.last_cells,
      total_fixes = total_fixes + excluded.total_fixes,
      cursor      = MAX(cursor, excluded.cursor)
  `),
  // A push that carried no fixes — a Health sync, or a logger with nothing new
  // to say. It still means the phone is awake and talking, which is what the
  // status line is asked for; what it must not do is overwrite what the last
  // *location* push reported, so those columns are left alone.
  touchDevice: db.prepare(`
    INSERT INTO device_links(user_id, device_id, name, platform, first_seen, last_seen)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id) DO UPDATE SET
      name = excluded.name, platform = excluded.platform, last_seen = excluded.last_seen
  `),
  tookWorkouts: db.prepare(`
    UPDATE device_links SET last_workout = MAX(last_workout, ?),
                            total_workouts = total_workouts + ?
    WHERE user_id = ? AND device_id = ?
  `),
  delDevice: db.prepare('DELETE FROM device_links WHERE user_id = ? AND device_id = ?'),
  hasWorkout: db.prepare('SELECT 1 FROM device_workouts WHERE user_id = ? AND workout_id = ? LIMIT 1'),
  tookWorkout: db.prepare(`
    INSERT INTO device_workouts(user_id, workout_id, taken_at) VALUES(?, ?, ?)
    ON CONFLICT(user_id, workout_id) DO NOTHING
  `),
  countWorkouts: db.prepare('SELECT COUNT(*) AS n FROM device_workouts WHERE user_id = ?'),
  rewindDevices: db.prepare('UPDATE device_links SET cursor = 0, total_fixes = 0 WHERE user_id = ?'),
  sourceCells: db.prepare('SELECT cell_id FROM cell_sources WHERE user_id = ? AND source = ?'),
  hasSourceCell: db.prepare(
    'SELECT 1 FROM cell_sources WHERE user_id = ? AND source = ? AND cell_id = ? LIMIT 1',
  ),
  sourceRowsFull: db.prepare(
    'SELECT cell_id, added_at, first_at, last_at, hits, fixes FROM cell_sources WHERE user_id = ? AND source = ?',
  ),
  renameRoutes: db.prepare('UPDATE routes SET source = ? WHERE user_id = ? AND source = ?'),
  setPhotoScan: db.prepare(`
    UPDATE device_links SET last_photo_scan = ?, total_photos = ? WHERE user_id = ? AND device_id = ?
  `),
  // What is on the map and who put it there. The same tally the statistics panel
  // shows, asked for directly because removing a source needs the list to be
  // current rather than as of whenever that panel last ran.
  sourceTally: db.prepare(`
    SELECT source, COUNT(*) AS cells, MIN(NULLIF(first_at, 0)) AS first, MAX(last_at) AS last
    FROM cell_sources WHERE user_id = ? GROUP BY source ORDER BY cells DESC
  `),
  sourceRoutes: db.prepare(
    'SELECT source, COUNT(*) AS n FROM routes WHERE user_id = ? GROUP BY source',
  ),
  // Undoing a source wholesale. Only ever for Apple Health, and only when asked
  // — see /api/device/health/reset for why a re-read needs the old copy gone
  // rather than merged with.
  delSourceRows: db.prepare('DELETE FROM cell_sources WHERE user_id = ? AND source = ?'),
  delSourceRoutes: db.prepare('DELETE FROM routes WHERE user_id = ? AND source = ?'),
  delWorkouts: db.prepare('DELETE FROM device_workouts WHERE user_id = ?'),
  clearWorkoutCount: db.prepare(
    'UPDATE device_links SET last_workout = 0, total_workouts = 0 WHERE user_id = ?',
  ),

  // --- What the admin panel counts --------------------------------------------
  // One query per column rather than one per account: a GROUP BY over the whole
  // table costs the same for one account as for twenty, and the panel wants
  // every account at once. Read into maps keyed by user id — see `adminUsers`.
  cellsPerUser: db.prepare(
    'SELECT user_id, COUNT(DISTINCT cell_id) AS n, MAX(added_at) AS newest FROM cell_sources GROUP BY user_id',
  ),
  routesPerUser: db.prepare('SELECT user_id, COUNT(*) AS n FROM routes GROUP BY user_id'),
  sourcesPerUser: db.prepare(
    'SELECT user_id, COUNT(DISTINCT source) AS n FROM cell_sources GROUP BY user_id',
  ),
  workoutsPerUser: db.prepare('SELECT user_id, COUNT(*) AS n FROM device_workouts GROUP BY user_id'),
  // `total_photos` is a running tally the phone reports, so a sum over a user's
  // phones is how many pictures it has offered — not how many rows are stored,
  // which the map does not keep separately.
  devicesPerUser: db.prepare(`
    SELECT user_id, COUNT(*) AS n, COALESCE(SUM(total_photos), 0) AS photos,
           COALESCE(SUM(total_fixes), 0) AS fixes, COALESCE(MAX(last_seen), 0) AS seen
    FROM device_links GROUP BY user_id
  `),
  haPerUser: db.prepare('SELECT user_id, enabled, last_ok, last_error FROM ha_links'),
  stravaPerUser: db.prepare('SELECT user_id, enabled, last_ok, last_error, refresh_token FROM strava_links'),
};

// The two sources that are not really sources: 'unknown', the placeholder the
// pre-provenance migration left on every cell it carried over, and 'manual', the
// one you get for tapping a cell on the map. Neither knows anything — no dates,
// no visit count, a `hits` of 1 that is a stand-in rather than a number — and
// every reader in the app already treats them as the same non-answer, skipping
// both when it totals visits.
//
// So a source that actually recorded fixes in the cell takes their place rather
// than sitting beside them: "I was here" and "here is when I was here, and how
// often" are the same claim, and only one of them is worth keeping. Leaving both
// would file the cell under two sources at once in Settings → Sources, which
// counts rows, so a place your phone has tracked for a year would go on being
// counted as somewhere you once marked by hand.
//
// `keep` is the source doing the recording, so an import that *is* one of these
// two does not delete the row it just wrote.
const PLACEHOLDER_SOURCES = ['unknown', 'manual'];
function clearPlaceholders(userId, cellId, keep) {
  for (const source of PLACEHOLDER_SOURCES) {
    if (source !== keep) q.delSourceCell.run(userId, source, cellId);
  }
}

// Run `fn` inside one transaction — the bulk import writes thousands of rows
// and SQLite is an order of magnitude faster (and atomic) this way.
function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Walk a big list in transaction-sized bites, letting the event loop run in
// between. node:sqlite is synchronous, so a single transaction over a few
// hundred thousand rows pins the only thread we have for seconds at a time —
// the map stops answering, the pollers stop firing, everything waits.
//
// The trade is atomicity: an import that fails halfway leaves the batches that
// already committed. Every write here is an upsert keyed by (user, cell,
// source), so running the import again finishes the job rather than doubling
// it, which is the property that makes chunking safe to do at all.
const CHUNK_ROWS = 2000;
const yieldToLoop = () => new Promise((r) => setImmediate(r));

async function chunked(items, onChunk) {
  for (let i = 0; i < items.length; i += CHUNK_ROWS) {
    const slice = items.slice(i, i + CHUNK_ROWS);
    tx(() => onChunk(slice));
    if (i + CHUNK_ROWS < items.length) await yieldToLoop();
  }
}

// Only so many heavyweight bodies in flight at once. Each one can be tens of
// megabytes of JSON held in memory while it parses, and this runs on a Pi.
const BIG_BODY_LIMIT = 32 * 1024 * 1024;
let bigRequestsInFlight = 0;
const MAX_BIG_REQUESTS = 2;

// --- One-time migration off the JSON blob ------------------------------------
// Pre-provenance cells have no source or date, so they land as 'unknown'. Re-
// importing the original exports from the app upgrades them in place, which is
// exactly what the importer's re-import path is for.
function migrateCellSets() {
  if (q.getMeta.get('cells_migrated_v1')) return;
  const legacy = db.prepare('SELECT user_id, data, updated_at FROM cell_sets').all();
  tx(() => {
    let n = 0;
    for (const row of legacy) {
      const added = Math.floor(Date.parse(row.updated_at || '') / 1000) || nowSec();
      let ids = [];
      try {
        ids = JSON.parse(row.data);
      } catch {
        /* unreadable blob — skip that user */
      }
      for (const id of Array.isArray(ids) ? ids : []) {
        if (typeof id !== 'string') continue;
        q.touchRow.run(row.user_id, id, 'unknown', added);
        n++;
      }
      if (row.import_stamp) q.setMeta.run(`import_stamp:${row.user_id}`, row.import_stamp);
    }
    q.setMeta.run('cells_migrated_v1', nowISO());
    if (n) console.log(`[visited-map] migrated ${n} cells into cell_sources (source: unknown)`);
  });
}
migrateCellSets();

// Routes saved before the activity was recorded have a blank sport, and there
// is no file left to re-read — but the length and the clock are already in the
// row, and that is all guessSport needs. One pass, once, so an existing map
// stops asking to be told what every ride was.
function migrateRouteSports() {
  if (q.getMeta.get('route_sports_v1')) return;
  tx(() => {
    let n = 0;
    for (const r of q.blankSport.all()) {
      const seconds = r.last_at > r.first_at ? r.last_at - r.first_at : 0;
      const sport = guessSport({ name: r.name, lengthM: r.length_m, seconds, elevUp: r.elev_up });
      if (sport) n += q.setGuessedSport.run(sport, r.id).changes;
    }
    q.setMeta.run('route_sports_v1', nowISO());
    if (n) console.log(`[visited-map] worked out the activity for ${n} saved route(s)`);
  });
}
migrateRouteSports();

// Activities used to be recorded in whatever words their source used — Komoot's
// "Road ride" and "Bike tour", a GPX's lower-case "cycling", the guesser's
// "Walk" — which meant one activity could occupy three categories in the list
// and the colour menu. canonicalSport() is now the single vocabulary; this
// brings rows written before it into line. Idempotent, but flagged anyway so it
// isn't re-run over a database that has already been through it.
function migrateSportNames() {
  if (q.getMeta.get('route_sport_names_v2')) return;
  tx(() => {
    let n = 0;
    for (const r of db.prepare("SELECT id, sport FROM routes WHERE sport <> ''").all()) {
      const canon = canonicalSport(r.sport);
      if (canon && canon !== r.sport) {
        db.prepare('UPDATE routes SET sport = ? WHERE id = ?').run(canon, r.id);
        n++;
      }
    }
    q.setMeta.run('route_sport_names_v2', nowISO());
    if (n) console.log(`[visited-map] tidied the activity on ${n} route(s)`);
  });
}
migrateSportNames();

// Routes saved before the list showed their shape. The geometry is already in
// the row, so the outline can simply be derived — no re-import needed.
function migrateRouteThumbs() {
  if (q.getMeta.get('route_thumbs_v1')) return;
  tx(() => {
    let n = 0;
    for (const r of db.prepare("SELECT id, geom FROM routes WHERE thumb = ''").all()) {
      let geom;
      try {
        geom = JSON.parse(r.geom);
      } catch {
        continue;
      }
      const thumb = routeThumb(geom);
      if (thumb) {
        db.prepare('UPDATE routes SET thumb = ? WHERE id = ?').run(thumb, r.id);
        n++;
      }
    }
    q.setMeta.run('route_thumbs_v1', nowISO());
    if (n) console.log(`[visited-map] drew an outline for ${n} saved route(s)`);
  });
}
migrateRouteThumbs();

// The owner's location history, baked in by `npm run import`. Read fresh on each
// merge so re-importing while the server runs still takes effect. `detail` rows
// ([id, source, first, last, hits, fixes]) carry provenance; older files without
// it fall back to plain ids with an unknown source.
function loadImported() {
  try {
    const j = JSON.parse(readFileSync(path.join(ROOT, 'src', 'imported-cells.json'), 'utf8'));
    const detail = Array.isArray(j.detail)
      ? j.detail
      : (Array.isArray(j.cells) ? j.cells : []).map((id) => [id, 'unknown', 0, 0, 1, 0]);
    return { stamp: j.generatedAt || null, detail };
  } catch {
    return { stamp: null, detail: [] };
  }
}

// --- Passwords & sessions ----------------------------------------------------
// scrypt is deliberately expensive, and it used to be the *synchronous* one —
// which on a single-threaded server meant every login held up every other
// request for the duration, and unauthenticated callers could stack that up on
// purpose. The async form does the same work on the threadpool instead.
async function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(pw, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = await scrypt(pw, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
// A login for a username that doesn't exist used to return before doing any
// hashing at all, so "no such user" answered in a millisecond and "wrong
// password" took ~100 ms — which is a perfectly good way to enumerate accounts.
// Hashing against a fixed dummy record costs the same as the real path.
const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;
const burnPasswordTime = (pw) => verifyPassword(pw, DUMMY_HASH).catch(() => false);

const newToken = () => randomBytes(32).toString('hex');

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// True when this request arrived over HTTPS. Behind the Cloudflare tunnel the
// hop into this process is plain HTTP, so the socket says nothing — the proto
// header is what carries it.
function isHttps(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
  return proto === 'https' || req.socket?.encrypted === true;
}

// The Secure flag used to depend entirely on COOKIE_SECURE being set in the
// environment, and in the deployment it wasn't: the live site handed out a
// session cookie over HTTPS with no Secure flag, so any plain-HTTP request to
// the same host would put it on the wire in the clear. Deriving it from the
// request means it's right by default and the env var only has to force it on.
function sessionCookie(req, token, maxAge) {
  const bits = [`sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (COOKIE_SECURE || isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

// How coarsely `users.last_seen` is kept. The admin panel reads it as "an hour
// ago", so a minute is already finer than anything asks for, and it is what
// makes writing it on every request affordable.
const SEEN_GRANULARITY_SEC = 60;

// Sessions had no server-side lifetime at all: the row lived forever and the
// cookie asked for a year. Now the row's age is checked on use and expired ones
// are dropped as they're found, with a sweep for the ones nobody comes back to.
function currentUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const s = q.session.get(token);
  if (!s) return null;
  const started = Math.floor(Date.parse(s.created_at || '') / 1000) || 0;
  if (started && nowSec() - started > SESSION_MAX_AGE) {
    q.delSession.run(token);
    return null;
  }
  const u = q.userById.get(s.user_id);
  if (!u) return null;
  // When this account was last *used*, which is a different question from when
  // somebody last typed its password — a phone signed in six months ago and
  // syncing every hour has a stale login and a fresh sighting, and the admin
  // panel wants both. Written at most once a minute: this runs on every
  // authenticated request, and a write per request would turn every read of the
  // map into a write of the database.
  const seen = Math.floor(Date.parse(u.last_seen || '') / 1000) || 0;
  if (nowSec() - seen >= SEEN_GRANULARITY_SEC) q.sawUser.run(nowISO(), u.id);
  // Whoever opened this session, when it is not the account it belongs to. The
  // permissions are read off `u` and not off this: an admin looking at somebody
  // else's map *is* that person for the length of the visit, which is the only
  // version of "log in as" worth having — one that cannot quietly do admin
  // things while wearing their name.
  const asAdmin = s.admin_id ? q.userById.get(s.admin_id) : null;
  return {
    id: u.id,
    username: u.username,
    admin: !!u.is_admin,
    asAdmin: asAdmin ? { id: asAdmin.id, username: asAdmin.username } : null,
  };
}

// --- Who runs this server -----------------------------------------------------
//
// One flag on the account, granted to the first person to register and to
// anybody named in ADMIN_USERS. It is deliberately *not* "the lowest user id",
// which is what backups used to test for: an id is an accident of insertion
// order, it cannot be handed to a second person, and it cannot be taken back
// from the first — all three of which the person running a map for a household
// eventually wants.
//
// What it is for: the instance-wide things, which are the things no per-account
// permission can express. A backup file is the whole database — every account's
// cells, every password hash, the Home Assistant token — so it belongs to
// whoever runs the machine rather than to whoever is signed in. Same for how
// much disk is left, and for resetting the password of somebody who has locked
// themselves out.
const ADMIN_USERS = String(process.env.ADMIN_USERS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Make sure somebody can administer this server.
 *
 * Run once at boot, and it is what carries an existing install over: a database
 * made before this flag existed has nobody marked, and the first account in it
 * is the person who set the server up. Beyond that first grant it stays out of
 * the way — an admin taken off in the panel is not put back on the next restart
 * unless ADMIN_USERS names them.
 */
function bootstrapAdmin() {
  for (const name of ADMIN_USERS) {
    if (q.adminByName.run(name).changes) console.log(`[visited-map] ${name} is an admin (ADMIN_USERS)`);
  }
  if ((q.countAdmins.get()?.n ?? 0) > 0) return;
  const first = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
  if (!first) return; // an empty server: the first registration takes it
  q.setAdmin.run(1, first.id);
  console.log(`[visited-map] ${first.username} is the admin of this server`);
}
bootstrapAdmin();

const isAdmin = (user) => !!user?.admin;

// --- Cells (with one-time import merge, owner account only) -----------------
// New accounts start empty. The imported-cells.json history (from `npm run
// import`) only ever merges into the account named by IMPORT_OWNER — set it in
// your env to attach your own location history to your own account. Leave it
// unset and no account gets auto-filled. Everyone else imports from inside the
// app instead (POST /api/cells/import).
function mergeBakedImport(user) {
  if (!IMPORT_OWNER || IMPORT_OWNER !== user.username) return;
  const imported = loadImported();
  if (!imported.stamp) return;
  const key = `import_stamp:${user.id}`;
  if (q.getMeta.get(key)?.value === imported.stamp) return;
  const at = nowSec();
  tx(() => {
    for (const [id, source, first, last, hits, fixes] of imported.detail) {
      if (typeof id !== 'string') continue;
      q.upsertRow.run(user.id, id, String(source || 'unknown'), at, +first || 0, +last || 0, +hits || 1, +fixes || 0);
    }
    q.setMeta.run(key, imported.stamp);
  });
  console.log(`[visited-map] merged ${imported.detail.length} baked-in cells into ${user.username}`);
}

// Wire format: a source dictionary plus one compact row per (cell, source) —
// [cellId, sourceIndex, addedAt, firstAt, lastAt, hits, fixes]. Tens of thousands
// of rows stay a manageable payload, and the client can answer "who marked this
// cell, and when" without another round trip.
function userCellRows(user) {
  mergeBakedImport(user);
  const sources = [];
  const index = new Map();
  const rows = q.rows.all(user.id).map((r) => {
    let i = index.get(r.source);
    if (i === undefined) {
      i = sources.length;
      index.set(r.source, i);
      sources.push(r.source);
    }
    return [r.cell_id, i, r.added_at, r.first_at, r.last_at, r.hits, r.fixes];
  });
  return { sources, rows };
}

const cellCount = (user) => q.countCells.get(user.id)?.n ?? 0;

// --- Derived reads --------------------------------------------------------------
// Trips, coverage and the calendar are worked out here rather than in each
// client, so two devices signed into one account cannot disagree about them.
// See server/derive.js for why.

/**
 * Everything the derivations need, read at most once per request and not at all
 * on a cache hit — which is the common case, since the inputs change only when
 * you import something or edit the map.
 */
function derivedInput(user, home) {
  let held = null;
  return () => {
    if (held) return held;

    mergeBakedImport(user);

    const cellMeta = new Map();
    const cellIds = [];
    for (const r of q.rows.all(user.id)) {
      const entry = {
        source: r.source,
        addedAt: r.added_at,
        firstAt: r.first_at,
        lastAt: r.last_at,
        hits: r.hits,
        fixes: r.fixes ?? 0,
      };
      const list = cellMeta.get(r.cell_id);
      if (list) {
        list.push(entry);
      } else {
        cellMeta.set(r.cell_id, [entry]);
        cellIds.push(r.cell_id);
      }
    }

    return (held = { cellMeta, cellIds, routes: q.routes.all(user.id).map(routeOut), home });
  };
}

/**
 * Where this account says it lives, or null for "work it out from the cells".
 *
 * Preferences are otherwise opaque to this server, and this one key is not: a
 * derived home that ignored the answer you gave when the guess was wrong would
 * be worse than no derivation at all, and the alternative — every client
 * passing its own home up with each request — is exactly the disagreement these
 * endpoints exist to remove.
 */
function storedHome(user) {
  try {
    const stored = JSON.parse(q.prefs.get(user.id)?.prefs ?? '{}')?.home;
    if (stored && Number.isFinite(+stored.lng) && Number.isFinite(+stored.lat)) {
      return { lng: +stored.lng, lat: +stored.lat, name: String(stored.name ?? '') };
    }
  } catch {
    /* unreadable preferences are the same as unset ones */
  }
  return null;
}

/**
 * A stamp for the boundary and place datasets the derivations read.
 *
 * They are inputs, in exactly the sense the note below says home is: rebuilding
 * `regions.json` changes how much of which region you have covered while
 * touching no row any aggregate can see. Italy's 110 provinces became 20
 * regioni and the statistics went on reporting 110 — the browser held a copy,
 * revalidated it, and the server answered 304 without ever recomputing, through
 * every restart, because the rows behind the signature had not moved.
 *
 * Hashed from the bytes rather than from mtimes, so re-running a build that
 * produces the same file does not invalidate every client's copy. Read once, at
 * startup: ~8.5 MB of JSON is about 20 ms, and it can only change by restarting
 * anyway.
 */
const GAZETTEER_STAMP = (() => {
  const h = createHash('sha1');
  for (const name of ['countries.json', 'regions.json', 'places.json']) {
    try {
      h.update(readFileSync(path.join(ROOT, 'src', name)));
    } catch {
      h.update(`missing:${name}`); // no dataset is still a state worth keying on
    }
  }
  return h.digest('base64url').slice(0, 8);
})();

/**
 * What a cached derivation is keyed on — and, since the answer is the same
 * whenever the signature is, what its ETag is built from too.
 *
 * Aggregates read from the rows rather than a counter this file has to remember
 * to bump on all six write paths. A counter can be forgotten; `COUNT(*)` cannot.
 *
 * Home is in it because home is an *input*, not a row: moving it changes which
 * days count as away and therefore which trips exist at all, while touching
 * nothing the aggregates can see. Leaving it out meant setting your home and
 * being handed back the trips of the old one until the next time you imported
 * something — quietly, and for as long as that took.
 *
 * Only the coordinates, not the name: renaming your home does not move it, and
 * every trip is measured from where it is.
 */
function derivedSignature(user, home) {
  const routes = q.routeSignature.get(user.id) ?? {};
  const edits = createHash('sha1')
    .update(JSON.stringify(q.routeEdits.all(user.id)))
    .digest('base64url')
    .slice(0, 12);
  return [
    cellsSignature(user),
    routes.n, routes.added, routes.len, edits,
    // The gazetteers, for the same reason home is here — see GAZETTEER_STAMP.
    GAZETTEER_STAMP,
    // Slash, not comma. This string becomes an ETag, and `If-None-Match` is a
    // comma-separated list — a coordinate pair written the natural way splits
    // itself in half on the way back and matches nothing, so every read is a
    // full one and the caching quietly does nothing at all.
    home ? `${home.lng}/${home.lat}` : '-',
  ].join(':');
}

/**
 * The cell rows and nothing else — what `/api/cells` is an answer about.
 *
 * Split out rather than reusing the whole signature, because the whole
 * signature moves when a route is renamed and the cells are a megabyte. Sending
 * that again to say something about a route's title is exactly the waste this
 * is meant to remove.
 */
function cellsSignature(user) {
  const c = q.cellSignature.get(user.id) ?? {};
  return [c.n, c.added, c.last, c.hits, sourceStamp(user)].join(':');
}

/**
 * Which sources the map holds, and how many cells each accounts for.
 *
 * This is in the signature because the *source* of a cell is part of the answer
 * `/api/cells` gives — it is what the cell card names and what "Colour by type"
 * paints — and not one of the four aggregates above can see it move. Renaming a
 * source deletes a row and writes it back under another name: the count is the
 * same, the dates are the same, the visit total is the same. So the tag matched,
 * the server answered 304, and the map went on saying *Unknown* about cells that
 * had been filed under *Marked by hand* minutes earlier.
 *
 * The routes signature learned the same lesson earlier and for the same reason —
 * a route's title changes without a single cell moving — which is why this is a
 * hash of a small `GROUP BY` rather than another counter to remember to bump.
 * `derivedSignature` gets it for free by building on this one, which it needs:
 * the statistics carry a "where the cells came from" breakdown.
 */
function sourceStamp(user) {
  return createHash('sha1')
    .update(JSON.stringify(q.sourceCounts.all(user.id)))
    .digest('base64url')
    .slice(0, 12);
}

/** Likewise the routes, which change without the cells moving at all. */
function routesSignature(user, withGeom) {
  const r = q.routeSignature.get(user.id) ?? {};
  const edits = createHash('sha1')
    .update(JSON.stringify(q.routeEdits.all(user.id)))
    .digest('base64url')
    .slice(0, 12);
  // The list and the list-with-lines are two different bodies at two URLs that
  // differ only by a query string. Caches key on the whole URL so they cannot
  // be confused — but a tag that says which one it is costs a character and
  // removes the question.
  return [withGeom ? 'g' : 'm', r.n, r.added, r.len, edits].join(':');
}

/**
 * The signature and the input side by side, so a handler cannot take one with
 * a home the other never saw.
 */
function derivedFor(user) {
  const home = storedHome(user);
  return { signature: derivedSignature(user, home), supply: derivedInput(user, home) };
}

// --- Routes ------------------------------------------------------------------
// Geometry arrives from the browser already thinned out (src/routes.js), but
// it's still client input: rebuild it here from numbers we've checked, so what
// lands in the database is always a well-formed set of line segments.
const MAX_ROUTE_POINTS = 20000;
const MAX_ROUTES_PER_REQUEST = 5000;
// A real Google Timeline export lands in the tens of thousands of cells, so
// these are still far above anything an honest import sends — they exist to
// bound the work one request can ask for, not to get in the way.
const MAX_CELLS_PER_IMPORT = 200000;
const MAX_CELLS_PER_MUTATE = 50000;

function cleanGeom(geom) {
  if (!Array.isArray(geom)) return null;
  const out = [];
  let points = 0;
  for (const seg of geom) {
    if (!Array.isArray(seg)) continue;
    const line = [];
    for (const p of seg) {
      if (!Array.isArray(p)) continue;
      const lng = +p[0];
      const lat = +p[1];
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue;
      line.push([Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
      if (++points >= MAX_ROUTE_POINTS) break;
    }
    if (line.length >= 2) out.push(line);
    if (points >= MAX_ROUTE_POINTS) break;
  }
  return out.length ? out : null;
}

function routeBounds(geom) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const seg of geom) {
    for (const [lng, lat] of seg) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return [minLng, minLat, maxLng, maxLat];
}

function routeOut(r) {
  const out = {
    id: r.id,
    name: r.name,
    place: r.place ?? '',
    sport: r.sport ?? '',
    sportGuessed: !!r.sport_guessed,
    thumb: r.thumb ?? '',
    link: r.link ?? '',
    elevUp: r.elev_up ?? 0,
    source: r.source,
    addedAt: r.added_at,
    firstAt: r.first_at,
    lastAt: r.last_at,
    lengthM: r.length_m,
    points: r.points,
    bounds: [r.min_lng, r.min_lat, r.max_lng, r.max_lat],
  };
  if (r.geom !== undefined) {
    try {
      out.geom = JSON.parse(r.geom);
    } catch {
      out.geom = [];
    }
  }
  return out;
}

const routeCount = (user) => q.countRoutes.get(user.id)?.n ?? 0;

// --- Home Assistant ----------------------------------------------------------
// The only source the server goes and gets by itself. A poll asks HA what the
// chosen entities did since the cursor, folds the answer into cells exactly the
// way an imported file would be, and moves the cursor to the end of the window
// it read — so nothing is fetched twice and a gap is filled by the next run
// rather than lost.
const HA_SOURCE = 'home-assistant';
const HA_INTERVALS = [5, 15, 30, 60, 180];
const HA_ACCURACIES = [0, 100, 250, 500, 1000];
const HA_MAX_ENTITIES = 12;
const HA_POLL_TICK_MS = 60 * 1000;

// What the browser is allowed to know about the link. The token is write-only:
// it goes in from the dialog and never comes back out.
function haOut(row) {
  if (!row) return null;
  let entities = [];
  try {
    entities = JSON.parse(row.entities);
  } catch {
    /* leave it empty — the dialog will ask for a pick again */
  }
  return {
    baseUrl: row.base_url,
    entities: Array.isArray(entities) ? entities : [],
    maxAccuracy: row.max_accuracy,
    intervalMin: row.interval_min,
    enabled: !!row.enabled,
    cursor: row.cursor,
    lastRun: row.last_run,
    lastOk: row.last_ok,
    lastError: row.last_error,
    lastFixes: row.last_fixes,
    lastCells: row.last_cells,
    totalFixes: row.total_fixes,
    source: HA_SOURCE,
  };
}

const haConn = (row) => ({ baseUrl: row.base_url, token: row.token });

function haEntities(row) {
  try {
    const list = JSON.parse(row.entities);
    return Array.isArray(list) ? list.filter(isFollowableEntity) : [];
  } catch {
    return [];
  }
}

/**
 * Run one poll for a link row. Returns what it took in; throws what went wrong.
 * Both outcomes are recorded on the row so the dialog can show the last result.
 */
async function haSync(row, { verify = false } = {}) {
  const now = nowSec();
  const since = row.cursor > 0 ? row.cursor : now - FIRST_SYNC_DAYS * 86400;
  // A cursor that's already current leaves no window to read, so a poll can
  // finish without ever contacting Home Assistant. That's fine on a timer, but
  // "Sync now" is also how you check the connection — it should not report
  // success for an address that no longer answers.
  if (verify) await ping(haConn(row));
  const { points, through, caughtUp } = await pullFixes(
    { ...haConn(row), entities: haEntities(row) },
    { since, now, maxAccuracyM: row.max_accuracy },
  );

  const cells = points.length ? pointsToCells(points) : [];
  const at = nowSec();
  tx(() => {
    for (const c of cells) {
      q.mergeRow.run(row.user_id, c.id, HA_SOURCE, at, c.first, c.last, c.hits, c.fixes, VISIT_GAP_SEC);
      // Same as an imported file: a real reading beats a placeholder.
      clearPlaceholders(row.user_id, c.id, HA_SOURCE);
    }
    // last_run = 0 when there's still history to walk through, so a link
    // catching up after an outage comes round again on the next tick instead
    // of waiting out its whole interval.
    q.haOk.run(through, caughtUp ? at : 0, at, points.length, cells.length, points.length, row.user_id);
  });
  return { fixes: points.length, cells: cells.length, through, caughtUp };
}

// --- The poller --------------------------------------------------------------
// One timer for every account. It wakes each minute, takes whichever links are
// due, and runs them one at a time — this is a personal server, not a fleet.
const haRunning = new Set();

async function haRunLink(row) {
  if (haRunning.has(row.user_id)) return null;
  haRunning.add(row.user_id);
  try {
    const out = await haSync(row);
    if (out.fixes) {
      console.log(`[visited-map] home-assistant: ${out.fixes} fixes → ${out.cells} cells (user ${row.user_id})`);
    }
    return out;
  } catch (e) {
    // `last_error` is handed back as `lastError` on every later GET of the
    // link, so what is stored here is as public as what is sent below.
    const why = userMessage(e, 'The sync did not finish.', `home-assistant sync failed (user ${row.user_id})`);
    q.haFail.run(nowSec(), why.slice(0, 200), row.user_id);
    console.warn(`[visited-map] home-assistant sync failed (user ${row.user_id}): ${why}`);
    return null;
  } finally {
    haRunning.delete(row.user_id);
  }
}

async function haPollTick() {
  let due = [];
  try {
    due = q.haDue.all(nowSec());
  } catch (e) {
    console.error('[visited-map] home-assistant poll query failed:', e);
    return;
  }
  for (const row of due) await haRunLink(row);
}

// --- Strava ------------------------------------------------------------------
// Same shape as the Home Assistant poller — a cursor that only moves forward,
// accumulating merges, backoff on failure — but the unit is an *activity*, not
// a window of time, and each one also lands as a saved route.
const STRAVA_SOURCE = 'strava';
const STRAVA_INTERVALS = [15, 30, 60, 180, 720];
const STRAVA_POLL_TICK_MS = 60 * 1000;

function stravaOut(row) {
  if (!row) return null;
  return {
    clientId: row.client_id,
    connected: !!row.refresh_token,
    athlete: row.athlete,
    saveRoutes: !!row.save_routes,
    intervalMin: row.interval_min,
    enabled: !!row.enabled,
    cursor: row.cursor,
    lastRun: row.last_run,
    lastOk: row.last_ok,
    lastError: row.last_error,
    lastCount: row.last_count,
    totalCount: row.total_count,
    source: STRAVA_SOURCE,
  };
}

// Strava's tokens last six hours and the refresh token rotates with them, so
// the new pair is written back every time.
async function stravaToken(row) {
  if (row.access_token && row.expires_at > nowSec() + 120) return row.access_token;
  if (!row.refresh_token) throw new Error('Strava is not connected.');
  const t = await strava.refreshToken({
    clientId: row.client_id,
    clientSecret: row.client_secret,
    refresh: row.refresh_token,
  });
  q.refreshStravaTokens.run(t.accessToken, t.refreshToken, t.expiresAt, row.user_id);
  return t.accessToken;
}

/** One poll: take in whatever has been recorded since the cursor. */
async function stravaSync(row) {
  const token = await stravaToken(row);
  const after = row.cursor > 0 ? row.cursor : nowSec() - strava.FIRST_SYNC_DAYS * 86400;
  const activities = await strava.listActivities({ token, after });

  const at = nowSec();
  let cells = 0;
  let taken = 0;
  let cursor = row.cursor || after;

  for (const activity of activities) {
    const points = await strava.activityPoints({ token, activity });
    // An activity whose streams have been stripped still counts as seen — the
    // cursor has to pass it or every poll would stop on the same one forever.
    if (points.length) {
      const folded = pointsToCells(points);
      const routes = row.save_routes
        ? buildRoutes([{ name: activity.name, segments: [points], firstAt: activity.startedAt, lastAt: 0 }], {
            source: STRAVA_SOURCE,
            fileName: activity.name,
          })
        : [];
      tx(() => {
        for (const c of folded) {
          q.mergeRow.run(row.user_id, c.id, STRAVA_SOURCE, at, c.first, c.last, c.hits, c.fixes, VISIT_GAP_SEC);
          clearPlaceholders(row.user_id, c.id, STRAVA_SOURCE);
        }
        for (const r of routes) {
          const geom = cleanGeom(r.geom);
          if (!geom) continue;
          const [minLng, minLat, maxLng, maxLat] = routeBounds(geom);
          q.insRoute.run(
            row.user_id,
            String(r.key).slice(0, 64),
            String(r.name || activity.name || 'Route').slice(0, 120),
            '', // named from geography by the browser, later
            String(activity.sport ?? '').slice(0, 40),
            0, // Strava says what it was; nothing to guess
            Math.max(0, Math.round(+activity.elevUp || 0)),
            STRAVA_SOURCE,
            at,
            Math.max(0, Math.trunc(r.firstAt || 0)),
            Math.max(0, Math.trunc(r.lastAt || 0)),
            Math.max(0, +r.lengthM || 0),
            geom.reduce((n, s) => n + s.length, 0),
            minLng,
            minLat,
            maxLng,
            maxLat,
            routeThumb(geom),
            '',
            JSON.stringify(geom),
          );
        }
      });
      cells += folded.length;
      taken++;
    }
    cursor = Math.max(cursor, activity.startedAt);
  }

  // More waiting than one run will take: come back on the next tick.
  const caughtUp = activities.length < strava.MAX_ACTIVITIES_PER_RUN;
  q.stravaOk.run(cursor, caughtUp ? at : 0, at, taken, taken, row.user_id);
  return { activities: taken, cells, caughtUp };
}

const stravaRunning = new Set();

async function stravaRunLink(row) {
  if (stravaRunning.has(row.user_id)) return null;
  stravaRunning.add(row.user_id);
  try {
    const out = await stravaSync(row);
    if (out.activities) {
      console.log(`[visited-map] strava: ${out.activities} activities → ${out.cells} cells (user ${row.user_id})`);
    }
    return out;
  } catch (e) {
    // Stored, and therefore shown: see the note on the Home Assistant poller.
    const why = userMessage(e, 'The sync did not finish.', `strava sync failed (user ${row.user_id})`);
    q.stravaFail.run(nowSec(), why.slice(0, 200), row.user_id);
    console.warn(`[visited-map] strava sync failed (user ${row.user_id}): ${why}`);
    return null;
  } finally {
    stravaRunning.delete(row.user_id);
  }
}

async function stravaPollTick() {
  let due = [];
  try {
    due = q.stravaDue.all(nowSec());
  } catch (e) {
    console.error('[visited-map] strava poll query failed:', e);
    return;
  }
  for (const row of due) await stravaRunLink(row);
}

// --- The phone itself --------------------------------------------------------
// Home Assistant and Strava are addresses this server can go and read. A phone
// is not one: it moves, it sleeps, and it is behind whatever network it happens
// to be on. So this connector is the only one that *pushes* — the iOS app
// records where it has been and posts batches when it gets a moment of runtime.
//
// Everything past the front door is deliberately identical to a Home Assistant
// poll: plain {lat, lng, t} fixes, folded by the same pointsToCells, merged with
// the same seam arithmetic. A cell does not care which of them put it there, and
// a visit means the same thing either way. What differs is only who moves first.
//
// Two things live on the phone rather than here, and both for the same reason —
// it is the only side that knows the answer:
//
//   • **How often to record.** A schedule stored here could not make a sleeping
//     phone wake up; the app's own settings are what the timer runs from.
//   • **Which fixes are too vague to trust.** Horizontal accuracy is a property
//     of the fix as iOS hands it over and is gone by the time it is a pair of
//     numbers. Home Assistant needs a server-side threshold because the server
//     is the thing doing the reading; here that would be a second, weaker copy
//     of a rule the app can simply apply.
const DEVICE_SOURCE = 'iphone';
const HEALTH_SOURCE = 'apple-health';
// A day of one-a-minute logging is 1,440 fixes, so a phone catching up after a
// fortnight offline still fits in one push.
const MAX_FIXES_PER_PUSH = 50000;
const MAX_WORKOUTS_PER_PUSH = 200;
const PHOTO_SOURCE = 'apple-photos';
// A library arrives whole (see /api/device/photos), so this is a ceiling on a
// decade of photography rather than on a batch: ~6 MB of JSON at three numbers
// each, well inside BIG_BODY_LIMIT.
const MAX_PHOTO_FIXES = 200000;
// Clocks disagree. A fix stamped slightly ahead of ours is ordinary; one stamped
// next year is a bug or a lie, and it would poison the cell's date range forever.
const CLOCK_SLACK_SEC = 300;
const MIN_FIX_SEC = Date.UTC(1990, 0, 1) / 1000;

/** What the app tells us about itself, trimmed to something storable. */
function deviceOf(body) {
  const d = body?.device ?? {};
  const id = String(d.id ?? '').trim().slice(0, 64);
  // A device id is the key rows are written under, so it has to be something
  // the app generated rather than anything a URL could smuggle in.
  if (!/^[A-Za-z0-9._-]{8,64}$/.test(id)) return null;
  return {
    id,
    name: String(d.name ?? '').trim().slice(0, 60),
    platform: String(d.platform ?? '').trim().slice(0, 40),
  };
}

/**
 * [lat, lng, t] triples → the {lat, lng, t} fixes pointsToCells expects.
 *
 * `after` is the device's cursor and is exclusive: a batch the app sent, whose
 * 200 never made it back, is re-sent from the front of its queue and has to be
 * a no-op rather than a second helping of visits. That makes the push idempotent
 * without the app having to reason about it, and it is safe because the queue is
 * FIFO — fixes leave the phone oldest first, so "already seen" and "older than
 * the cursor" are the same set.
 */
function deviceFixes(list, { after, now }) {
  const out = [];
  const ceiling = now + CLOCK_SLACK_SEC;
  for (const f of Array.isArray(list) ? list : []) {
    const [lat, lng, t] = Array.isArray(f) ? f : [f?.lat, f?.lng, f?.t];
    const y = +lat;
    const x = +lng;
    const at = Math.trunc(+t);
    if (!Number.isFinite(y) || !Number.isFinite(x) || !Number.isFinite(at)) continue;
    if (Math.abs(y) > 90 || Math.abs(x) > 180) continue;
    // The null island: what a broken fix looks like, and nowhere anyone stands.
    if (y === 0 && x === 0) continue;
    if (at <= after || at < MIN_FIX_SEC || at > ceiling) continue;
    out.push({ lat: y, lng: x, t: at });
  }
  // pointsToCells reads its input as one timeline — a stay is a run of fixes in
  // the same cell — so order is not cosmetic here.
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * One Apple Health workout → the track shape buildRoutes takes.
 *
 * Returns null for anything with no usable line in it, which is most of the
 * point: the app only offers workouts that carry an HKWorkoutRoute, and this is
 * the second half of the same rule. A workout with no geography is not a place
 * anyone went, it is a number of press-ups.
 */
function healthWorkout(w) {
  const id = String(w?.id ?? '').trim().slice(0, 64);
  if (!id) return null;
  const clean = [];
  let budget = MAX_ROUTE_POINTS;
  for (const seg of Array.isArray(w.segments) ? w.segments : []) {
    const line = [];
    for (const p of Array.isArray(seg) ? seg : []) {
      const lng = +p?.[0];
      const lat = +p?.[1];
      const t = Math.trunc(+p?.[2]) || 0;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      if (Math.abs(lng) > 180 || Math.abs(lat) > 90) continue;
      if (lng === 0 && lat === 0) continue;
      line.push({ lng, lat, t });
      if (line.length >= budget) break;
    }
    if (!line.length) continue;
    clean.push(line);
    budget -= line.length;
    if (budget <= 0) break;
  }

  // Cut where the recording stopped, then take the cells from what is left.
  //
  // Both halves matter. A Health route is one series across every pause in the
  // workout, so without the cut a paused ride is drawn — and measured — straight
  // across the gap. And the cells have to come from the runs that survive rather
  // than from everything that arrived, because a run of one point is a fix with
  // nothing either side of it: a stale position from before the watch had a GPS
  // lock, which is enough on its own to put a place you have never been on the
  // map. `splitOnGaps` drops those, and this is what makes that count for cells
  // and not only for the line.
  const segments = splitOnGaps(clean);
  const points = [];
  for (const line of segments) {
    for (const p of line) points.push({ lat: p.lat, lng: p.lng, t: p.t });
  }
  if (!points.length) return null;
  return {
    id,
    points,
    track: {
      // Health workouts carry no name — you do not title a run — and the date
      // buildRoute falls back to made a Routes list read as a column of ISO
      // dates. "Morning walk" is what Health puts at the top of its own screen,
      // and `trackName` is the one place that decides it. Still blank when the
      // activity type says nothing, because inventing "Morning other" is worse
      // than the date.
      name: trackName(canonicalSport(w.sport), Math.max(0, Math.trunc(+w.start) || 0)),
      segments,
      sport: canonicalSport(w.sport),
      firstAt: Math.max(0, Math.trunc(+w.start) || 0),
      lastAt: Math.max(0, Math.trunc(+w.end) || 0),
      // Health knows the ascent from the barometer, which is a better number
      // than one derived from GPS altitude; when it says nothing, buildRoute
      // works it out from the line like every other source.
      elevUp: Number.isFinite(+w.elevUp) ? Math.max(0, +w.elevUp) : undefined,
    },
  };
}

/**
 * Take one source off the map entirely: its cells, its routes, and whatever
 * bookkeeping was keeping track of what it had already sent.
 *
 * The last part is why this is a function rather than two DELETEs. A source is
 * not only rows — some of them have a *memory* somewhere of how far they got,
 * and leaving that behind turns "remove this and start again" into "remove this
 * and watch nothing come back". Apple Health remembers workout ids; the phone's
 * logger remembers a cursor past which it will not re-send; the photo library
 * remembers nothing, because every sync is the whole library.
 *
 * Provenance is per source, so a cell another source also vouches for keeps that
 * row and stays on the map. Only what this source claimed on its own disappears.
 */
function forgetSource(user, source) {
  const out = tx(() => {
    const cells = q.delSourceRows.run(user.id, source).changes;
    const routes = q.delSourceRoutes.run(user.id, source).changes;
    let workouts = 0;
    if (source === HEALTH_SOURCE) workouts = q.delWorkouts.run(user.id).changes;
    return { cells, routes, workouts };
  });
  if (source === HEALTH_SOURCE) q.clearWorkoutCount.run(user.id);
  // The logger's cursor is the seam that stops a re-sent batch counting twice.
  // Once its cells are gone there is nothing to count twice, and a cursor left
  // in the future would silently swallow everything the phone still holds.
  if (source === DEVICE_SOURCE) q.rewindDevices.run(user.id);
  console.log(
    `[visited-map] forgot ${source} for user ${user.id}: ${out.cells} cell rows, `
    + `${out.routes} routes${out.workouts ? `, ${out.workouts} remembered workouts` : ''}`,
  );
  return out;
}

// --- Closing an account -------------------------------------------------------
//
// Every table that files rows under a `user_id`, written out by hand rather
// than discovered from the schema at runtime. There are no foreign keys in this
// database, so nothing cascades and nothing complains: a table added later and
// forgotten here would simply leave its rows behind, attached to a user id that
// no longer exists and ready to be handed to whoever is issued that id next.
//
// So it is a list, and `scripts/test/account-delete.mjs` reads the live schema
// and fails if any table carrying a user_id is missing from it. That test is
// the actual guarantee; this list is just what it checks.
const USER_TABLES = [
  'sessions',
  'cell_sets',
  'cell_sources',
  'routes',
  'ha_links',
  'strava_links',
  'user_prefs',
  'device_links',
  'device_workouts',
];
const delUserRows = USER_TABLES.map((t) => [t, db.prepare(`DELETE FROM ${t} WHERE user_id = ?`)]);

/**
 * Delete an account and everything filed under it.
 *
 * One transaction, so a failure halfway through leaves the account intact
 * rather than half-erased — a map with its cells gone and its routes still
 * drawn is worse than one that refused.
 *
 * What this does **not** touch, deliberately: the snapshots in BACKUP_DIR. They
 * are whole-database copies covering every account, so deleting them to close
 * one would destroy everybody else's only way back — and keeping them means a
 * copy of this account survives in them until they age out. The API says so in
 * its answer rather than leaving it to be discovered.
 */
function deleteAccount(user) {
  const removed = tx(() => {
    const counts = {};
    for (const [table, stmt] of delUserRows) counts[table] = stmt.run(user.id).changes;
    counts.users = q.delUser.run(user.id).changes;
    return counts;
  });
  // The server's own readings of a map that no longer exists. Keyed by user id,
  // and ids are handed out by AUTOINCREMENT — but a cache that outlives its
  // account is a bug waiting for the reuse that proves it.
  derive.forget(user.id);
  const rows = Object.values(removed).reduce((a, b) => a + b, 0);
  console.log(`[visited-map] deleted account ${user.id} (${user.username}): ${rows} rows`);
  return removed;
}

/** What the sync screen shows for one phone. */
function deviceOut(row) {
  return {
    id: row.device_id,
    name: row.name,
    platform: row.platform,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastFixes: row.last_fixes,
    lastCells: row.last_cells,
    totalFixes: row.total_fixes,
    cursor: row.cursor,
    lastWorkout: row.last_workout,
    totalWorkouts: row.total_workouts,
    lastPhotoScan: row.last_photo_scan,
    totalPhotos: row.total_photos,
  };
}

// --- What an admin is shown ---------------------------------------------------
//
// Two answers, and the line between them is the one this whole panel is built
// around: **the shape of an account, never its contents.** How many cells, when
// its phone last spoke, whether its Strava is failing — those are what somebody
// answering "is it working for them?" needs, and none of them says where anybody
// went. Nothing in here reads a cell id, a route geometry or a coordinate; the
// way to see somebody's map is to open it as them, which leaves a line in the
// log and a bar across the top of the page saying so.

/** Every account, with the tallies that answer "is this one working". */
function adminUsers() {
  const by = (rows) => new Map(rows.map((r) => [r.user_id, r]));
  const cells = by(q.cellsPerUser.all());
  const routes = by(q.routesPerUser.all());
  const sources = by(q.sourcesPerUser.all());
  const workouts = by(q.workoutsPerUser.all());
  const devices = by(q.devicesPerUser.all());
  const ha = by(q.haPerUser.all());
  const strava = by(q.stravaPerUser.all());
  const sessions = by(q.countSessions.all());
  const sec = (iso) => Math.floor(Date.parse(iso || '') / 1000) || 0;

  return q.users.all().map((u) => {
    const d = devices.get(u.id);
    const h = ha.get(u.id);
    const s = strava.get(u.id);
    return {
      id: u.id,
      username: u.username,
      admin: !!u.is_admin,
      createdAt: sec(u.created_at),
      lastLogin: sec(u.last_login),
      lastSeen: sec(u.last_seen),
      sessions: sessions.get(u.id)?.n ?? 0,
      cells: cells.get(u.id)?.n ?? 0,
      routes: routes.get(u.id)?.n ?? 0,
      sources: sources.get(u.id)?.n ?? 0,
      photos: d?.photos ?? 0,
      workouts: workouts.get(u.id)?.n ?? 0,
      devices: d?.n ?? 0,
      fixes: d?.fixes ?? 0,
      // When location data last *arrived*, whichever way in it took. The three
      // are genuinely different failures — a phone that has stopped pushing, a
      // Home Assistant that has stopped answering, a Strava token that has
      // expired — so the newest of them is what says "this account is still
      // being fed", and the connectors below say which one has stopped.
      lastData: Math.max(d?.seen ?? 0, h?.last_ok ?? 0, s?.last_ok ?? 0, cells.get(u.id)?.newest ?? 0),
      ha: h ? { enabled: !!h.enabled, lastOk: h.last_ok, error: h.last_error || '' } : null,
      strava: s
        ? { enabled: !!s.enabled, connected: !!s.refresh_token, lastOk: s.last_ok, error: s.last_error || '' }
        : null,
    };
  });
}

/** How big something on disk is, and how many files it took. */
async function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, bytes: 0, files: 0, missing: true };
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const inner = await dirSize(full);
      bytes += inner.bytes;
      files += inner.files;
    } else {
      try {
        bytes += (await stat(full)).size;
        files += 1;
      } catch {
        /* a file removed between the listing and the stat is simply not there */
      }
    }
  }
  return { dir, bytes, files };
}

/**
 * The machine, rather than anybody's map.
 *
 * The database's own size is three files, not one: SQLite in WAL mode keeps the
 * journal and the shared-memory index beside it, and a `-wal` that has grown to
 * a gigabyte is exactly the kind of thing somebody opens this panel to find.
 */
async function adminOverview() {
  const dbFiles = await Promise.all(
    ['', '-wal', '-shm'].map(async (suffix) => {
      try {
        return { name: path.basename(DB_PATH) + suffix, bytes: (await stat(DB_PATH + suffix)).size };
      } catch {
        return null;
      }
    }),
  );
  const caches = await Promise.all([
    dirSize(BACKUP_DIR).then((d) => ({ ...d, name: 'Backups' })),
    dirSize(REGION_CACHE_DIR).then((d) => ({ ...d, name: 'Region boundaries' })),
    dirSize(RAIL_CACHE_DIR).then((d) => ({ ...d, name: 'Railway tiles' })),
    dirSize(TRAILS_CACHE_DIR).then((d) => ({ ...d, name: 'Trail tiles' })),
  ]);
  // Free space on the filesystem the database is on, which is the one that runs
  // out. `statfs` is not in every Node this might run under, and a panel that
  // throws is worse than one that leaves a line out.
  let free = null;
  try {
    const fs = await statfs(path.dirname(DB_PATH));
    free = { free: fs.bsize * fs.bavail, total: fs.bsize * fs.blocks };
  } catch {
    /* not every platform and not every Node */
  }
  const mem = process.memoryUsage();
  return {
    server: {
      version: SERVER_VERSION,
      startedAt: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
      uptime: Math.floor(process.uptime()),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      pid: process.pid,
      registration: ALLOW_REGISTRATION ? 'open' : REGISTRATION_CODE ? 'invite' : 'closed',
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      systemTotal: totalmem(),
      systemFree: freemem(),
      load: loadavg().map((n) => Math.round(n * 100) / 100),
      cpus: cpus().length,
    },
    disk: {
      db: dbFiles.filter(Boolean),
      dbBytes: dbFiles.filter(Boolean).reduce((a, f) => a + f.bytes, 0),
      caches,
      free,
    },
    totals: {
      users: q.countUsers.get()?.n ?? 0,
      admins: q.countAdmins.get()?.n ?? 0,
      cells: q.cellsPerUser.all().reduce((a, r) => a + r.n, 0),
      routes: q.routesPerUser.all().reduce((a, r) => a + r.n, 0),
      devices: q.devicesPerUser.all().reduce((a, r) => a + r.n, 0),
      photos: q.devicesPerUser.all().reduce((a, r) => a + r.photos, 0),
      workouts: q.workoutsPerUser.all().reduce((a, r) => a + r.n, 0),
    },
  };
}

// Where Strava sends the browser back to. Built from the request rather than
// configured, so it matches whatever host this is actually being used on — and
// it's always our own origin, so it can't be turned into an open redirect.
function selfOrigin(req) {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    || (COOKIE_SECURE ? 'https' : 'http');
  return host ? `${proto}://${host}` : null;
}

// --- HTTP helpers ------------------------------------------------------------
// Nothing here was compressed before, and the payloads are not small: a full
// cell list is ~1 MB of JSON that gzips to ~120 KB. Over a LAN that only cost
// time; over tailscale from a phone it was most of the page load. zlib is part
// of Node, so this keeps the no-npm-dependencies rule.
//
// Small bodies are left alone — below about a kilobyte the header and the CPU
// cost more than the saving.
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(req) {
  return /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
}

// The negotiated encoding is stashed on the response by the request handler, so
// none of the existing send() call sites have to change.
// Headers every response carries. The API answers are per-account data — a
// shared cache holding one is a way for the wrong person to be handed it — and
// nosniff/frame-ancestors cost nothing to state.
const BASE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // Deliberately not `no-referrer`. That was the first choice and it broke the
  // train-tracks overlay: OpenRailwayMap's tile server refuses a request that
  // carries no Referer (403), so stripping it entirely made every tile fail.
  // `strict-origin-when-cross-origin` sends the bare origin — "maps.pi3.run",
  // never a path — to other sites, and nothing at all when leaving HTTPS for
  // HTTP. Tile hosts get what they ask for; no URL of yours goes anywhere.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(res, status, body, headers = {}) {
  const text = body == null ? '' : JSON.stringify(body);
  // Caller headers first: Set-Cookie and friends must survive, and the
  // transport headers below are ours to set last.
  const head = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...BASE_SECURITY_HEADERS,
    ...headers,
  };
  if (res.wantsGzip && text.length >= GZIP_MIN_BYTES && !head['Content-Encoding']) {
    const buf = gzipSync(text);
    head['Content-Encoding'] = 'gzip';
    head.Vary = head.Vary ? `${head.Vary}, Accept-Encoding` : 'Accept-Encoding';
    head['Content-Length'] = String(buf.length);
    res.writeHead(status, head);
    return res.end(buf);
  }
  const buf = Buffer.from(text, 'utf8');
  head['Content-Length'] = String(buf.length);
  res.writeHead(status, head);
  res.end(buf);
}

/**
 * Send bytes we are holding on somebody else's behalf: a tile, a sprite sheet.
 *
 * Not `send`, which speaks JSON and gzips on the way out. A railway tile arrives
 * already compressed from its cache — see the storage note in
 * server/rail-tiles.js — so the encoding is passed straight through to the
 * ~every client that accepts it and undone for the one that does not. A trails
 * tile is a PNG and arrives uncompressed for the reason given there, so it takes
 * the `out.gzip === false` path and is sent as it is; gzipping a PNG on the way
 * out would be work for nothing.
 *
 * **`private`, and cached hard.** The route is session-gated, so no shared cache
 * may keep a copy; the browser's own is exactly where these belong, and it is
 * the layer that stops a pan back over the same ground from reaching this
 * process at all. The ETag is over the bytes, so a revalidation after the
 * max-age is a 304 rather than a tile.
 */
function sendTileBytes(req, res, out, extra = {}) {
  const head = { ...BASE_SECURITY_HEADERS, ...extra };
  if (out.status === 204 || !out.body?.length) {
    res.writeHead(204, { ...head, 'Cache-Control': 'private, max-age=86400' });
    return res.end();
  }
  const etag = `W/"${createHash('sha1').update(out.body).digest('base64url')}"`;
  const maxAge = Math.floor((out.ttl ?? 86400000) / 1000);
  head['Cache-Control'] = `private, max-age=${maxAge}`;
  head.ETag = etag;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, head);
    return res.end();
  }
  head['Content-Type'] = out.type || 'application/octet-stream';
  const wantsGz = out.gzip && acceptsGzip(req);
  const body = out.gzip && !wantsGz ? gunzipSync(out.body) : out.body;
  if (wantsGz) {
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
  }
  head['Content-Length'] = String(body.length);
  res.writeHead(200, head);
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * A conditional GET for the reads that belong to one account.
 *
 * These are the expensive answers. A real map is 25,000 cell rows — 1.1 MB of
 * JSON, 136 KB gzipped — and it was sent in full on every load, every reload
 * and every device, while changing only when you edit or import something.
 * `derivedSignature` already says exactly when that happened, in aggregates no
 * write path can forget to bump, so it is also the right validator: two
 * responses with the same signature are the same answer.
 *
 * Call it before doing the work. It answers 304 and returns null when the
 * caller already has this version, and otherwise hands back the headers to pass
 * to `send`.
 *
 *   const head = conditional(req, res, tag);
 *   if (!head) return;                       // 304, already sent
 *   return send(res, 200, body, head);
 *
 * **The validator is weak**, and that is not a compromise. `send` gzips a large
 * body and leaves a small one alone, so one signature can legitimately go out
 * as two different byte strings; `W/` says "the same resource, possibly a
 * different representation", which is precisely true. `If-None-Match` compares
 * weakly, so it still matches.
 *
 * **`private, no-cache`, not `no-store`.** No shared cache may keep one
 * account's map, and nothing here may be *used* without asking first — but it
 * must be allowed to be *stored*, because a stored copy is the entire reason
 * the next ask can be answered with 304 instead of a megabyte. `no-store` says
 * the opposite, and that is what the API was sending.
 */
function conditional(req, res, tag) {
  const etag = `W/"${tag}"`;
  const head = { ETag: etag, 'Cache-Control': 'private, no-cache' };
  const known = req.headers['if-none-match']?.trim();
  // A browser sends back exactly what it was given, so try that whole first —
  // splitting on commas only makes sense for the list a proxy may send, and a
  // tag that contained one would be torn in half by it. (Ours never do; see
  // `derivedSignature`. This order means it would not matter if one did.)
  // `*` means "any version you have", which for a validated read is a match.
  if (known && (known === etag || known.split(',').some((v) => v.trim() === etag || v.trim() === '*'))) {
    res.writeHead(304, { ...BASE_SECURITY_HEADERS, ...head });
    res.end();
    return null;
  }
  return head;
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s) return resolve({});
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new Error('bad json'));
      }
    });
    req.on('error', reject);
  });
}

// --- API ---------------------------------------------------------------------
// --- What a borrowed session may not do ----------------------------------------
//
// **The phone in your pocket must never write into the account you are looking
// at.** The apps have no login of their own: `SyncClient` copies the web view's
// cookies into the shared jar after every page load and pushes with whatever is
// in it (see HexPlore-IOS/HexPlore/SyncClient.swift). So an admin who opens
// somebody else's map *from inside the app* has just pointed their own
// background location logging, their Apple Health workouts and their entire
// photo library at that person's map — silently, minutes later, from a
// background wake, with nothing on screen at the time.
//
// Everywhere else, being the other account is exactly the point of the feature.
// Here it is the one thing it must not mean, because these three routes are the
// only ones in this server whose caller is not the person reading the page.
//
// Nothing is lost by refusing: the fix queue only drops a batch the server has
// taken, unsent workouts are simply not marked as taken, and the photo library
// is re-read from scratch on every scan. It all arrives on the next push, once
// the admin is back in their own account. The message is written to be read on
// a phone's Settings tab, which is where it will surface.
const WEARING_SOMEBODY_ELSE = 'You are viewing another account on this device. '
  + 'Leave it on the Map tab before this phone syncs again.';
const borrowed = (user) => !!user?.asAdmin;

async function handleApi(req, res, pathname, query = new URLSearchParams()) {
  try {
    // Is this a Hexplore server, and is it up? Unauthenticated, because the one
    // asking has not signed in yet — the iOS app checks the address you typed
    // *before* it will have a session, and "wrong address" and "signed out" are
    // different problems that used to look identical.
    //
    // It answers a name as well as a version, and that is the whole point of it:
    // a bare 200 proves something is listening, which on a home network is as
    // likely to be a router as a map. The app treats a 200 whose body does not
    // say `hexplore` as a *different* answer — reachable, but not this — and
    // says so in a different colour.
    //
    // Deliberately empty of anything else. It is the one route anybody on the
    // network can reach, so it says nothing about who has an account, how much
    // is on the map, or whether registration is open; the version is already
    // public to every signed-in page and is what makes "which build am I looking
    // at" answerable from the phone.
    if (req.method === 'GET' && pathname === '/api/health') {
      return send(res, 200, { app: 'hexplore', version: SERVER_VERSION });
    }

    // What this is running, and whether anything newer has been published.
    //
    // Signed in, unlike `/api/health`: the version is public because a phone
    // has to be able to check an address before it has an account, and *this*
    // answers a question only the person who runs the server has — with a
    // request to the outside world behind it. Two answers in one because
    // Settings asks two questions at once: `version` is what the server is
    // running *now*, which the page compares against the build it signed in
    // with, and `latest` is what is published.
    if (req.method === 'GET' && pathname === '/api/update') {
      if (!currentUser(req)) return send(res, 401, { error: 'not authenticated' });
      const latest = await publishedVersion();
      return send(res, 200, {
        version: SERVER_VERSION,
        latest,
        // Worked out here rather than in the page, so the comparison is written
        // once and tested once — see `isNewerVersion`.
        newer: !!latest && isNewerVersion(latest, SERVER_VERSION),
      });
    }

    if (req.method === 'POST' && pathname === '/api/register') {
      const ip = clientIp(req);
      const gate = registrationRefusal();
      // Rate-limited before the gate check so a closed server can't be used to
      // measure anything either.
      const limited = registerLimiter.take(ip);
      if (!limited.ok) {
        return send(res, 429, { error: 'Too many attempts. Try again shortly.' }, { 'Retry-After': String(limited.retryAfter) });
      }
      const { username, password, code } = await readBody(req);
      if (gate) return send(res, 403, { error: gate });
      if (REGISTRATION_CODE && String(code ?? '') !== REGISTRATION_CODE) {
        return send(res, 403, { error: 'That invite code is not right.' });
      }
      const u = String(username ?? '').trim();
      const pw = String(password ?? '');
      if (u.length < 2 || u.length > 40) return send(res, 400, { error: 'Username must be 2–40 characters.' });
      if (pw.length < MIN_PASSWORD_LEN) {
        return send(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
      }
      if (pw.length > 512) return send(res, 400, { error: 'That password is too long.' });
      if (q.userByName.get(u)) return send(res, 409, { error: 'That username is taken.' });
      // The first account to register runs the server. Read *before* the insert,
      // because after it the count is one either way.
      const first = (q.countUsers.get()?.n ?? 0) === 0;
      const info = q.insUser.run(u, await hashPassword(pw), nowISO());
      const id = Number(info.lastInsertRowid);
      if (first || ADMIN_USERS.includes(u)) {
        q.setAdmin.run(1, id);
        console.log(`[visited-map] ${u} is the admin of this server`);
      }
      q.sawLogin.run(nowISO(), nowISO(), id);
      const token = newToken();
      q.insSession.run(token, id, nowISO(), 0);
      return send(res, 200, {
        username: u,
        version: SERVER_VERSION,
        admin: first || ADMIN_USERS.includes(u),
      }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MAX_AGE) });
    }

    if (req.method === 'POST' && pathname === '/api/login') {
      const { username, password } = await readBody(req);
      const u = String(username ?? '').trim();
      const pw = String(password ?? '');
      // Two windows: one so a single address can't grind through a dictionary,
      // one so a distributed attempt still can't grind through *this account*.
      const ip = clientIp(req);
      for (const [limiter, key] of [
        [loginIpLimiter, ip],
        [loginUserLimiter, u.toLowerCase()],
      ]) {
        const hit = limiter.take(key);
        if (!hit.ok) {
          return send(
            res,
            429,
            { error: 'Too many sign-in attempts. Try again in a moment.' },
            { 'Retry-After': String(hit.retryAfter) },
          );
        }
      }
      const row = q.userByName.get(u);
      // Hash either way — see burnPasswordTime. Skipping the work for an unknown
      // username is what made the two cases tell themselves apart.
      const ok = row ? await verifyPassword(pw, row.pass) : await burnPasswordTime(pw);
      if (!row || !ok) {
        return send(res, 401, { error: 'Wrong username or password.' });
      }
      loginIpLimiter.reset(ip);
      loginUserLimiter.reset(u.toLowerCase());
      const token = newToken();
      q.insSession.run(token, row.id, nowISO(), 0);
      q.sawLogin.run(nowISO(), nowISO(), row.id);
      return send(res, 200, {
        username: row.username,
        version: SERVER_VERSION,
        admin: !!row.is_admin,
      }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MAX_AGE) });
    }

    if (req.method === 'POST' && pathname === '/api/logout') {
      const token = parseCookies(req).sid;
      if (token) q.delSession.run(token);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    // Close the account and take the map with it.
    //
    // **The password is asked for again**, and a live session is not accepted
    // as consent on its own. Every other destructive thing here takes back one
    // source or one route and is undoable from a file you still have; this one
    // is the whole map, it is not undoable, and the session it would ride in on
    // is a 90-day cookie sitting on an unlocked laptop. Re-entering the password
    // is the difference between someone deciding to do this and someone finding
    // the button.
    if (req.method === 'POST' && pathname === '/api/account/delete') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const hit = deleteAccountLimiter.take(`${user.id}:${clientIp(req)}`);
      if (!hit.ok) {
        return send(res, 429, { error: 'Too many attempts. Try again later.' }, { 'Retry-After': String(hit.retryAfter) });
      }
      const { password } = await readBody(req);
      const row = q.userById.get(user.id);
      // Timing here says nothing an authenticated caller doesn't already know —
      // they hold a session for this account — but it costs nothing to keep the
      // comparison constant-time, and verifyPassword is that already.
      const ok = row ? await verifyPassword(String(password ?? ''), row.pass) : false;
      if (!ok) return send(res, 403, { error: 'That password is not right.' });
      const removed = deleteAccount(user);
      // The cookie goes in the same answer. The session row is already gone, so
      // it points at nothing — but a browser left holding a dead cookie retries
      // with it on every request and gets a 401 it has no way to explain.
      return send(res, 200, {
        ok: true,
        username: user.username,
        removed,
        // Said rather than left to be found out. A snapshot taken before this
        // still holds the account, and only the owner can reach or delete those.
        backupsKept: existsSync(BACKUP_DIR),
      }, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      // The build comes back with the session rather than from an endpoint of
      // its own: it is only ever read by a signed-in page, and a version number
      // an unauthenticated caller can ask for is a fingerprint for free.
      //
      // `admin` decides whether the page draws two extra tabs, and nothing else
      // — every route behind them checks for itself. `asAdmin` is the one the
      // page cannot do without: an admin who has opened somebody else's map has
      // a session that is theirs in every way, and the only thing standing
      // between that and an editing accident is a bar across the top saying so.
      return send(res, 200, {
        username: user.username,
        version: SERVER_VERSION,
        admin: user.admin,
        asAdmin: user.asAdmin?.username ?? null,
      });
    }

    // Which airport a point is standing in. Asked by the phone, and only by the
    // phone: it has no copy of the dataset and wants to know whether the ten
    // minutes somebody has spent standing still were spent in a departure hall.
    //
    // Behind the session like everything else. The dataset is public and the
    // answer gives nothing away about the account, but the *question* does —
    // an unauthenticated endpoint taking a coordinate is somewhere to leak a
    // position to, and there is no reason to have one.
    if (req.method === 'GET' && pathname === '/api/airport') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const lat = Number(query.get('lat'));
      const lng = Number(query.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return send(res, 400, { error: 'lat and lng are required' });
      }
      // `null` rather than a 404: "you are not at an airport" is a successful
      // answer to the question, and the caller has to treat it as one.
      return send(res, 200, { airport: airportAt(ROOT, lat, lng) });
    }

    // Display preferences, so the same account sees the same map on the phone
    // and the laptop. Deliberately opaque to the server: it stores the blob the
    // browser hands it and gives it back, with a size cap so it can't be used
    // as free storage.
    if (req.method === 'GET' && pathname === '/api/prefs') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      let prefs = {};
      try {
        prefs = JSON.parse(q.prefs.get(user.id)?.prefs ?? '{}');
      } catch {
        /* unreadable is the same as unset */
      }
      return send(res, 200, { prefs: prefs && typeof prefs === 'object' ? prefs : {} });
    }

    if (req.method === 'POST' && pathname === '/api/prefs') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req, 256 * 1024);
      const prefs = body?.prefs;
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) {
        return send(res, 400, { error: 'prefs must be an object' });
      }
      const text = JSON.stringify(prefs);
      if (text.length > 64 * 1024) return send(res, 413, { error: 'preferences too large' });
      q.setPrefs.run(user.id, text, nowSec());
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/cells') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      // Before the signature, not after: the baked-in import writes rows, and a
      // tag taken ahead of it would describe a map this answer doesn't hold.
      // It short-circuits on every load but the first, so this costs nothing.
      mergeBakedImport(user);
      const head = conditional(req, res, cellsSignature(user));
      if (!head) return;
      return send(res, 200, userCellRows(user), head);
    }

    // Incremental edits from the map: marking cells adds a 'manual' row,
    // clearing one drops every source's row for it (clearing means "I was
    // never here", whoever put it on the map).
    if (req.method === 'POST' && pathname === '/api/cells/mutate') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      // Count the raw arrays before filtering: the cap used to be applied to
      // what survived the filter, so a caller could send any number of entries
      // as long as most were junk and still make the server walk all of them.
      const rawCount = (Array.isArray(body.add) ? body.add.length : 0)
        + (Array.isArray(body.remove) ? body.remove.length : 0);
      if (rawCount > MAX_CELLS_PER_MUTATE) return send(res, 400, { error: 'too many cells' });
      const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length <= 40) : []);
      const add = ids(body.add);
      const remove = ids(body.remove);
      const source = typeof body.source === 'string' && body.source ? body.source.slice(0, 40) : 'manual';
      const at = nowSec();
      await chunked(remove, (slice) => {
        for (const id of slice) q.delCell.run(user.id, id);
      });
      await chunked(add, (slice) => {
        for (const id of slice) {
          // The other half of the rule above: a hand mark on a cell something
          // already recorded adds nothing but a second row saying less. The page
          // has always believed this — markCell() leaves existing provenance
          // alone and says so — but the server wrote the placeholder anyway, and
          // that is how a cell came to be filed under both its real source and
          // "Marked by hand" at once. Only guarded for the placeholder sources;
          // a caller naming a real one is recording something.
          if (PLACEHOLDER_SOURCES.includes(source) && q.realSourceCell.get(user.id, id)) continue;
          q.touchRow.run(user.id, id, source, at);
        }
      });
      return send(res, 200, { ok: true, total: cellCount(user) });
    }

    // Putting back exactly what was cleared — this is what Undo sends.
    //
    // It can't go through /mutate: clearing a cell drops every source's claim
    // on it, dates, visit counts and all, and re-adding the id would bring it
    // back as a bare 'manual' mark with none of that. So the page keeps the
    // rows it had (it already holds them, to draw the card) and hands them back
    // whole. Nothing here is trusted beyond its shape — this writes provenance,
    // so a row is only ever written for the account that sent it.
    if (req.method === 'POST' && pathname === '/api/cells/restore') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (rows.length > MAX_CELLS_PER_MUTATE) return send(res, 400, { error: 'too many cells' });
      const at = nowSec();
      let restored = 0;
      await chunked(rows, (slice) => {
        for (const r of slice) {
          const [id, source, addedAt, firstAt, lastAt, hits, fixes] = Array.isArray(r)
            ? r
            : [r.id, r.source, r.addedAt, r.firstAt, r.lastAt, r.hits, r.fixes];
          if (typeof id !== 'string' || !id || id.length > 40) continue;
          const src = String(source ?? 'manual').slice(0, 40) || 'manual';
          // added_at is restored as it was: a cell that has been on the map
          // since March should not read as new because it spent a minute
          // deleted.
          q.upsertRow.run(
            user.id, id, src,
            Math.max(0, Math.trunc(+addedAt) || at),
            Math.max(0, Math.trunc(+firstAt) || 0),
            Math.max(0, Math.trunc(+lastAt) || 0),
            Math.max(1, Math.trunc(+hits) || 1),
            Math.max(0, Math.trunc(+fixes) || 0),
          );
          restored++;
        }
      });
      return send(res, 200, { ok: true, restored, total: cellCount(user) });
    }

    // Bulk import from a parsed file. Re-importing the same source refreshes its
    // rows in place — that's how imported cells get their dates and counts
    // updated. An import only ever adds: there was once a "replace" mode that
    // also dropped cells the new file no longer contained, but its scope was the
    // whole source rather than the file, which is not what anyone reading the
    // checkbox expected. Clearing a cell you don't want is the honest way.
    if (req.method === 'POST' && pathname === '/api/cells/import') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      if (bigRequestsInFlight >= MAX_BIG_REQUESTS) {
        return send(res, 503, { error: 'Busy importing something else — try again in a moment.' });
      }
      bigRequestsInFlight++;
      try {
        // A full Google Timeline export can reach tens of thousands of cells.
        const body = await readBody(req, BIG_BODY_LIMIT);
        const source = String(body.source ?? '').trim().slice(0, 40) || 'other';
        if (!Array.isArray(body.cells)) return send(res, 400, { error: 'cells must be an array' });
        if (body.cells.length > MAX_CELLS_PER_IMPORT) return send(res, 400, { error: 'too many cells' });

        const at = nowSec();
        let added = 0;
        let updated = 0;
        await chunked(body.cells, (slice) => {
          for (const c of slice) {
            const [id, first, last, hits, fixes] = Array.isArray(c)
              ? c
              : [c.id, c.first, c.last, c.hits, c.fixes];
            if (typeof id !== 'string' || !id || id.length > 40) continue;
            if (q.hasCell.get(user.id, id)) updated++;
            else added++;
            q.upsertRow.run(user.id, id, source, at, +first || 0, +last || 0, +hits || 1, +fixes || 0);
            // Cells carried over from the pre-provenance storage have a
            // placeholder 'unknown' row, and one you tapped on the map has a
            // 'manual' one. A real import knows strictly more about them, so it
            // takes their place instead of sitting beside them — this is what
            // re-importing your old exports is for.
            clearPlaceholders(user.id, id, source);
          }
        });
        return send(res, 200, { ok: true, added, updated, total: cellCount(user) });
      } finally {
        bigRequestsInFlight--;
      }
    }

    // Saved routes. The list is metadata only unless ?geom=1 — the map holds
    // off on the (much larger) geometry until the routes layer is switched on.
    if (req.method === 'GET' && pathname === '/api/routes') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const withGeom = query.get('geom') === '1';
      const head = conditional(req, res, routesSignature(user, withGeom));
      if (!head) return;
      const rows = withGeom ? q.routesGeom.all(user.id) : q.routes.all(user.id);
      return send(res, 200, { routes: rows.map(routeOut) }, head);
    }

    // --- Derived, read-only -----------------------------------------------------
    // The map's own readings of the rows: which trips the history implies, how
    // much ground is covered, and which days have anything on them. Worked out
    // once here so a phone and a laptop cannot answer differently — see
    // server/derive.js.
    //
    // All four are cached against a signature of the rows, so the cost is paid
    // on the first request after something changes and never again. The first
    // of them also parses 8.1 MB of geography, which is why an untouched map
    // answers in a millisecond and the first one after an import does not.

    if (req.method === 'GET' && pathname === '/api/trips') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const { signature, supply } = derivedFor(user);
      const head = conditional(req, res, signature);
      if (!head) return;
      return send(res, 200, await derive.trips(user.id, signature, supply), head);
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const { signature, supply } = derivedFor(user);
      const head = conditional(req, res, signature);
      if (!head) return;
      return send(res, 200, await derive.stats(user.id, signature, supply), head);
    }

    if (req.method === 'GET' && pathname === '/api/days') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const { signature, supply } = derivedFor(user);
      const head = conditional(req, res, signature);
      if (!head) return;
      return send(res, 200, { days: derive.days(user.id, signature, supply) }, head);
    }

    if (req.method === 'GET' && pathname.startsWith('/api/day/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const key = pathname.slice('/api/day/'.length);
      // The key is a calendar day and nothing else. Checked rather than trusted
      // because it reaches dayBounds, which will happily parse a surprise.
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return send(res, 400, { error: 'expected a YYYY-MM-DD day' });
      const { signature, supply } = derivedFor(user);
      // The day is part of what this answer is about, so it is part of the tag:
      // one URL per day, and the same map answering for two of them must not
      // hand back one validator.
      const head = conditional(req, res, `${signature}:${key}`);
      if (!head) return;
      return send(res, 200, await derive.day(user.id, signature, supply, key), head);
    }

    if (req.method === 'POST' && pathname === '/api/routes') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      if (bigRequestsInFlight >= MAX_BIG_REQUESTS) {
        return send(res, 503, { error: 'Busy importing something else — try again in a moment.' });
      }
      bigRequestsInFlight++;
      try {
        const body = await readBody(req, BIG_BODY_LIMIT);
        if (!Array.isArray(body.routes)) return send(res, 400, { error: 'routes must be an array' });
        if (body.routes.length > MAX_ROUTES_PER_REQUEST) return send(res, 400, { error: 'too many routes' });

        const at = nowSec();
        let added = 0;
        let updated = 0;
        let skipped = 0;
        // Each route carries its own geometry to clean, measure and serialise,
        // so these chunks are much smaller than the cell ones.
        await chunked(body.routes, (slice) => {
          for (const r of slice) {
            const geom = r && cleanGeom(r.geom);
            const key = String(r?.key ?? '').slice(0, 64);
            if (!geom || !key) {
              skipped++;
              continue;
            }
            const [minLng, minLat, maxLng, maxLat] = routeBounds(geom);
            const points = geom.reduce((n, s) => n + s.length, 0);
            const existed = !!q.hasRoute.get(user.id, key);
            q.insRoute.run(
              user.id,
              key,
              String(r.name ?? '').slice(0, 120) || 'Route',
              String(r.place ?? '').slice(0, 120),
              String(r.sport ?? '').slice(0, 40),
              r.sportGuessed ? 1 : 0,
              Math.max(0, Math.round(+r.elevUp || 0)),
              String(r.source ?? 'other').slice(0, 40),
              at,
              Math.max(0, Math.trunc(+r.firstAt || 0)),
              Math.max(0, Math.trunc(+r.lastAt || 0)),
              Math.max(0, +r.lengthM || 0),
              points,
              minLng,
              minLat,
              maxLng,
              maxLat,
              String(r.thumb ?? '') || routeThumb(geom),
              isKomootTourUrl(r.link) ? String(r.link).slice(0, 300) : '',
              JSON.stringify(geom),
            );
            // A route already here is refreshed rather than duplicated — see
            // insRoute — so it counts as updated, not as skipped.
            if (existed) updated++;
            else added++;
          }
        });
        return send(res, 200, { ok: true, added, updated, skipped, total: routeCount(user) });
      } finally {
        bigRequestsInFlight--;
      }
    }

    // Backfill: routes stored before place names existed get one worked out in
    // the browser (the dataset lives there) and sent back here.
    if (req.method === 'POST' && pathname === '/api/routes/places') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      if (!Array.isArray(body.places)) return send(res, 400, { error: 'places must be an array' });
      if (body.places.length > MAX_ROUTES_PER_REQUEST) return send(res, 400, { error: 'too many routes' });
      const updated = tx(() => {
        let n = 0;
        for (const entry of body.places) {
          const [id, place] = Array.isArray(entry) ? entry : [entry?.id, entry?.place];
          const rowId = Math.trunc(+id);
          const text = String(place ?? '').slice(0, 120);
          if (!Number.isFinite(rowId) || rowId <= 0 || !text) continue;
          n += q.setRoutePlace.run(text, user.id, rowId).changes;
        }
        return n;
      });
      return send(res, 200, { ok: true, updated });
    }

    // --- Home Assistant ------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/ha') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      return send(res, 200, { link: haOut(q.haLink.get(user.id)) });
    }

    // Check an address and token, and list the entities that could be followed.
    // Called with a token typed into the dialog, or with none once a link is
    // saved (then the stored token is used and never leaves the server).
    if (req.method === 'POST' && pathname === '/api/ha/probe') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const stored = q.haLink.get(user.id);
      const baseUrl = normalizeBaseUrl(body.baseUrl ?? stored?.base_url ?? '');
      const token = String(body.token ?? '') || stored?.token || '';
      if (!baseUrl) return send(res, 400, { error: 'That does not look like a server address.' });
      if (!token) return send(res, 400, { error: 'Paste a long-lived access token.' });
      try {
        const { entities } = await probe({ baseUrl, token });
        return send(res, 200, { baseUrl, entities });
      } catch (e) {
        return send(res, 502, { error: userMessage(e, 'That did not work.', 'home-assistant probe failed') });
      }
    }

    // Save (or update) the link. Every field is optional on an update — the
    // dialog can toggle "sync automatically" without re-sending the token,
    // which it doesn't have.
    if (req.method === 'POST' && pathname === '/api/ha') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const existing = q.haLink.get(user.id);

      const baseUrl = body.baseUrl === undefined && existing
        ? existing.base_url
        : normalizeBaseUrl(body.baseUrl);
      if (!baseUrl) return send(res, 400, { error: 'That does not look like a server address.' });

      const token = String(body.token ?? '').trim() || existing?.token || '';
      if (!token) return send(res, 400, { error: 'Paste a long-lived access token.' });

      let entities = body.entities === undefined && existing
        ? haEntities(existing)
        : (Array.isArray(body.entities) ? body.entities : []).filter(isFollowableEntity);
      entities = [...new Set(entities)].slice(0, HA_MAX_ENTITIES);
      if (!entities.length) return send(res, 400, { error: 'Pick at least one device to follow.' });

      const pick = (value, allowed, fallback) =>
        (allowed.includes(Math.trunc(+value)) ? Math.trunc(+value) : fallback);
      const intervalMin = pick(body.intervalMin, HA_INTERVALS, existing?.interval_min ?? 15);
      const maxAccuracy = pick(body.maxAccuracy, HA_ACCURACIES, existing?.max_accuracy ?? 250);
      const enabled = body.enabled === undefined ? (existing?.enabled ?? 1) : (body.enabled ? 1 : 0);

      if (existing) {
        q.updHaLink.run(baseUrl, token, JSON.stringify(entities), maxAccuracy, intervalMin, enabled, user.id);
      } else {
        // Never rewind into history this source has already counted — otherwise
        // disconnecting and reconnecting would fold the same days in twice.
        const seen = q.sourceLastAt.get(user.id, HA_SOURCE)?.t ?? 0;
        const cursor = Math.max(seen || 0, nowSec() - FIRST_SYNC_DAYS * 86400);
        q.insHaLink.run(user.id, baseUrl, token, JSON.stringify(entities), maxAccuracy, intervalMin, enabled, cursor);
      }
      return send(res, 200, { link: haOut(q.haLink.get(user.id)) });
    }

    // "Sync now". Runs the same poll the timer would, and reports what it took.
    if (req.method === 'POST' && pathname === '/api/ha/sync') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const row = q.haLink.get(user.id);
      if (!row) return send(res, 400, { error: 'No Home Assistant is connected.' });
      if (haRunning.has(user.id)) return send(res, 409, { error: 'A sync is already running.' });
      haRunning.add(user.id);
      try {
        const out = await haSync(row, { verify: true });
        return send(res, 200, { link: haOut(q.haLink.get(user.id)), ...out });
      } catch (e) {
        const why = userMessage(e, 'The sync did not finish.', `home-assistant sync failed (user ${user.id})`);
        q.haFail.run(nowSec(), why.slice(0, 200), user.id);
        return send(res, 502, { error: why, link: haOut(q.haLink.get(user.id)) });
      } finally {
        haRunning.delete(user.id);
      }
    }

    // Forgetting the link drops the token and the schedule. The cells it already
    // brought in stay on the map — they're yours, and they came from real fixes.
    if (req.method === 'POST' && pathname === '/api/ha/delete') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      q.delHaLink.run(user.id);
      return send(res, 200, { ok: true, link: null });
    }

    // --- Strava --------------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/strava') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      return send(res, 200, {
        link: stravaOut(q.stravaLink.get(user.id)),
        // The dialog shows this so it can be pasted into Strava's own settings.
        callbackDomain: (selfOrigin(req) ?? '').replace(/^https?:\/\//, '').split(':')[0],
      });
    }

    // Save the API application. Changing its credentials drops any tokens they
    // were issued against — they'd be rejected anyway.
    if (req.method === 'POST' && pathname === '/api/strava') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const existing = q.stravaLink.get(user.id);
      const clientId = String(body.clientId ?? existing?.client_id ?? '').trim();
      const clientSecret = String(body.clientSecret ?? '').trim() || existing?.client_secret || '';
      if (!/^\d{1,12}$/.test(clientId)) return send(res, 400, { error: 'That is not a Strava client ID.' });
      if (!clientSecret) return send(res, 400, { error: 'Paste the client secret from your Strava app.' });

      const intervalMin = STRAVA_INTERVALS.includes(Math.trunc(+body.intervalMin))
        ? Math.trunc(+body.intervalMin)
        : (existing?.interval_min ?? 60);
      const saveRoutes = body.saveRoutes === undefined ? (existing?.save_routes ?? 1) : (body.saveRoutes ? 1 : 0);
      const enabled = body.enabled === undefined ? (existing?.enabled ?? 1) : (body.enabled ? 1 : 0);

      if (existing) {
        q.updStravaApp.run(clientId, clientSecret, saveRoutes, intervalMin, enabled, user.id);
        if (clientId !== existing.client_id || clientSecret !== existing.client_secret) {
          q.clearStravaTokens.run(user.id);
        }
      } else {
        const seen = q.sourceLastAt.get(user.id, STRAVA_SOURCE)?.t ?? 0;
        const cursor = Math.max(seen || 0, nowSec() - strava.FIRST_SYNC_DAYS * 86400);
        q.insStravaLink.run(user.id, clientId, clientSecret, saveRoutes, intervalMin, enabled, cursor);
      }
      return send(res, 200, { link: stravaOut(q.stravaLink.get(user.id)) });
    }

    // Hand back the URL to send the browser to. The `state` is a one-shot token
    // checked on the way back, so somebody else's callback can't attach their
    // Strava account to this one.
    if (req.method === 'POST' && pathname === '/api/strava/authorize') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const row = q.stravaLink.get(user.id);
      if (!row) return send(res, 400, { error: 'Save your Strava app details first.' });
      const origin = selfOrigin(req);
      if (!origin) return send(res, 400, { error: 'Could not work out this server’s address.' });
      const state = randomBytes(16).toString('hex');
      q.setStravaState.run(state, user.id);
      return send(res, 200, {
        url: strava.authorizeUrl({
          clientId: row.client_id,
          redirectUri: `${origin}/api/strava/callback`,
          state,
        }),
      });
    }

    // Strava sends the browser here. This is a navigation, not a fetch, so it
    // answers with a redirect back to the map either way.
    if (req.method === 'GET' && pathname === '/api/strava/callback') {
      const back = (result) => {
        res.writeHead(302, { Location: `/?strava=${result}` });
        res.end();
      };
      const state = query.get('state') ?? '';
      const row = state && q.stravaByState.get(state);
      if (!row) return back('badstate');
      if (query.get('error')) {
        q.setStravaState.run('', row.user_id);
        return back('denied');
      }
      const code = query.get('code') ?? '';
      if (!code) {
        q.setStravaState.run('', row.user_id);
        return back('nocode');
      }
      if (!strava.scopeIsEnough(query.get('scope'))) {
        q.setStravaState.run('', row.user_id);
        return back('scope');
      }
      try {
        const t = await strava.exchangeCode({
          clientId: row.client_id,
          clientSecret: row.client_secret,
          code,
        });
        if (!t.refreshToken) throw new Error('no refresh token');
        q.setStravaTokens.run(t.accessToken, t.refreshToken, t.expiresAt, t.athlete, row.user_id);
        return back('ok');
      } catch (e) {
        // The state is one-shot on every outcome, not just the happy one — a
        // failed exchange used to leave it in the row, still valid, still
        // usable by whoever could replay the callback.
        q.setStravaState.run('', row.user_id);
        const why = userMessage(e, 'Connecting did not finish.', `strava callback failed (user ${row.user_id})`);
        q.stravaFail.run(nowSec(), why.slice(0, 200), row.user_id);
        return back('failed');
      }
    }

    if (req.method === 'POST' && pathname === '/api/strava/sync') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const row = q.stravaLink.get(user.id);
      if (!row) return send(res, 400, { error: 'No Strava app is set up.' });
      if (!row.refresh_token) return send(res, 400, { error: 'Connect your Strava account first.' });
      if (stravaRunning.has(user.id)) return send(res, 409, { error: 'A sync is already running.' });
      stravaRunning.add(user.id);
      try {
        const out = await stravaSync(row);
        return send(res, 200, { link: stravaOut(q.stravaLink.get(user.id)), ...out });
      } catch (e) {
        const why = userMessage(e, 'The sync did not finish.', `strava sync failed (user ${user.id})`);
        q.stravaFail.run(nowSec(), why.slice(0, 200), user.id);
        return send(res, 502, { error: why, link: stravaOut(q.stravaLink.get(user.id)) });
      } finally {
        stravaRunning.delete(user.id);
      }
    }

    if (req.method === 'POST' && pathname === '/api/strava/delete') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      q.delStravaLink.run(user.id);
      return send(res, 200, { ok: true, link: null });
    }

    // --- The phone itself ----------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/device') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      return send(res, 200, {
        devices: q.devices.all(user.id).map(deviceOut),
        // What the app needs to know before it starts: which of its workouts
        // this account has already taken in. Its own query anchor is the fast
        // path; this is what makes a reinstall — or a second phone — not re-send
        // a year of rides.
        workouts: q.countWorkouts.get(user.id)?.n ?? 0,
      });
    }

    // A batch of positions from the app's own logger. See "The phone itself"
    // above for why this pushes where everything else pulls.
    if (req.method === 'POST' && pathname === '/api/device/fixes') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      if (borrowed(user)) return send(res, 409, { error: WEARING_SOMEBODY_ELSE });
      // The default 8 MB rather than BIG_BODY_LIMIT, and so no place in the
      // heavyweight queue: MAX_FIXES_PER_PUSH of `[lat, lng, t]` is about 2 MB,
      // and a fix is three numbers however many of them there are. The workout
      // endpoint below is the one that carries geometry and takes the queue.
      const body = await readBody(req);
      const device = deviceOf(body);
      if (!device) return send(res, 400, { error: 'device.id must be 8–64 characters of [A-Za-z0-9._-]' });
      if (!Array.isArray(body.fixes)) return send(res, 400, { error: 'fixes must be an array' });
      if (body.fixes.length > MAX_FIXES_PER_PUSH) return send(res, 400, { error: 'too many fixes' });

      const now = nowSec();
      const known = q.device.get(user.id, device.id);
      const points = deviceFixes(body.fixes, { after: known?.cursor ?? 0, now });
      const cells = points.length ? pointsToCells(points) : [];
      const cursor = points.length ? points[points.length - 1].t : (known?.cursor ?? 0);

      await chunked(cells, (slice) => {
        for (const c of slice) {
          q.mergeRow.run(user.id, c.id, DEVICE_SOURCE, now, c.first, c.last, c.hits, c.fixes, VISIT_GAP_SEC);
          // As for an imported file: a real reading beats a placeholder. The
          // phone having been somewhere is the answer a hand mark was standing
          // in for.
          clearPlaceholders(user.id, c.id, DEVICE_SOURCE);
        }
      });
      // Outside the cell loop, and unconditional: a push that landed entirely
      // behind the cursor still says the phone is alive and syncing, which is
      // most of what the status line is for.
      q.seenDevice.run(
        user.id, device.id, device.name, device.platform,
        now, now, points.length, cells.length, points.length, cursor,
      );
      return send(res, 200, {
        ok: true,
        fixes: points.length,
        // How many were dropped for being behind the cursor, so a phone that is
        // somehow re-sending everything shows up as that rather than as silence.
        skipped: body.fixes.length - points.length,
        cells: cells.length,
        cursor,
        total: cellCount(user),
      });
    }

    // Workouts out of Apple Health — the ones that went somewhere.
    //
    // Same shape as a Strava activity on the way in, and for the same reason:
    // an activity is a line as well as a set of cells, so it lands as a saved
    // route too. What it is not is a second copy of Strava — Health is where a
    // Watch ride, a Fitness+ walk and a third-party app all end up, and a phone
    // that already has them does not need the round trip through anyone's API.
    if (req.method === 'POST' && pathname === '/api/device/workouts') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      if (borrowed(user)) return send(res, 409, { error: WEARING_SOMEBODY_ELSE });
      if (bigRequestsInFlight >= MAX_BIG_REQUESTS) {
        return send(res, 503, { error: 'Busy importing something else — try again in a moment.' });
      }
      bigRequestsInFlight++;
      try {
        const body = await readBody(req, BIG_BODY_LIMIT);
        const device = deviceOf(body);
        if (!device) return send(res, 400, { error: 'device.id must be 8–64 characters of [A-Za-z0-9._-]' });
        if (!Array.isArray(body.workouts)) return send(res, 400, { error: 'workouts must be an array' });
        if (body.workouts.length > MAX_WORKOUTS_PER_PUSH) return send(res, 400, { error: 'too many workouts' });

        const now = nowSec();
        let taken = 0;
        let known = 0;
        let skipped = 0;
        let cells = 0;
        let routes = 0;
        let newest = 0;

        for (const raw of body.workouts) {
          const w = healthWorkout(raw);
          if (!w) {
            skipped++;
            continue;
          }
          // Cells are *added* to what is already there, so a workout taken
          // twice is a place visited twice. This is the only guard against it
          // and it has to come before any write.
          if (q.hasWorkout.get(user.id, w.id)) {
            known++;
            continue;
          }
          const folded = pointsToCells(w.points);
          const built = buildRoutes([w.track], { source: HEALTH_SOURCE });
          tx(() => {
            for (const c of folded) {
              q.mergeRow.run(user.id, c.id, HEALTH_SOURCE, now, c.first, c.last, c.hits, c.fixes, VISIT_GAP_SEC);
              clearPlaceholders(user.id, c.id, HEALTH_SOURCE);
            }
            for (const r of built) {
              const geom = cleanGeom(r.geom);
              // A workout shorter than a route's minimum still counted as
              // cells above; there is simply no line worth drawing.
              if (!geom) continue;
              const [minLng, minLat, maxLng, maxLat] = routeBounds(geom);
              q.insRoute.run(
                user.id,
                String(r.key).slice(0, 64),
                String(r.name || 'Workout').slice(0, 120),
                '', // named from geography by the browser, later
                String(r.sport ?? '').slice(0, 40),
                r.sportGuessed ? 1 : 0,
                Math.max(0, Math.round(+r.elevUp || 0)),
                HEALTH_SOURCE,
                now,
                Math.max(0, Math.trunc(r.firstAt || 0)),
                Math.max(0, Math.trunc(r.lastAt || 0)),
                Math.max(0, +r.lengthM || 0),
                geom.reduce((n, s) => n + s.length, 0),
                minLng,
                minLat,
                maxLng,
                maxLat,
                routeThumb(geom),
                '',
                JSON.stringify(geom),
              );
              routes++;
            }
            q.tookWorkout.run(user.id, w.id, now);
          });
          cells += folded.length;
          newest = Math.max(newest, w.track.lastAt || w.track.firstAt || 0);
          taken++;
          // node:sqlite is synchronous and a workout is thousands of points, so
          // a fortnight of them in one push would pin the only thread there is.
          await yieldToLoop();
        }

        q.touchDevice.run(user.id, device.id, device.name, device.platform, now, now);
        q.tookWorkouts.run(newest, taken, user.id, device.id);
        return send(res, 200, {
          ok: true, taken, known, skipped, cells, routes, total: routeCount(user),
        });
      } finally {
        bigRequestsInFlight--;
      }
    }

    // Throw away everything Apple Health has put here, so it can be read again
    // from the beginning.
    //
    // This is the one destructive call in the connector, and it exists because
    // of what the other guards make impossible. Workout ids are remembered so a
    // re-send cannot double-count, which also means a workout stored from a bad
    // reading can never be corrected — the phone offers it, the server says
    // "known", and the wrong line stays for ever. And cells are merged rather
    // than replaced, so re-taking the same workouts on top of the old ones would
    // count every visit twice.
    //
    // So a re-read needs the old copy gone rather than merged with, and that is
    // exactly what this does: the `apple-health` cells, the `apple-health`
    // routes, and the memory of which workouts have been seen. Nothing else is
    // touched — a cell that another source also vouches for keeps that source's
    // row and stays on the map, because provenance is per source.
    //
    // The phone drives it, not the browser: this clears the server's half, and
    // the phone has to clear its query anchor in the same breath or it would
    // have nothing to send back.
    if (req.method === 'POST' && pathname === '/api/device/health/reset') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const out = forgetSource(user, HEALTH_SOURCE);
      return send(res, 200, { ok: true, ...out });
    }

    // --- What is on the map, and taking one of them off ----------------------
    // Every other way of removing something works a cell or a route at a time,
    // which is right when you disagree with a place and useless when you
    // disagree with a *method*. Re-importing an export you no longer trust
    // refreshes its rows and never removes the ones it has stopped claiming, so
    // until now a source that had once put something on the map could never be
    // taken back off it.
    if (req.method === 'GET' && pathname === '/api/sources') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const routes = new Map(q.sourceRoutes.all(user.id).map((r) => [r.source, r.n]));
      return send(res, 200, {
        sources: q.sourceTally.all(user.id).map((s) => ({
          key: s.source,
          cells: s.cells,
          routes: routes.get(s.source) ?? 0,
          firstAt: s.first ?? 0,
          lastAt: s.last ?? 0,
        })),
      });
    }

    // Filing what is already on the map under a different name.
    //
    // The case it exists for is `unknown`, which is not really a source at all:
    // it is the placeholder the pre-provenance migration left on every cell that
    // predates the map knowing where anything came from. The intended way out is
    // for a real import to cover those cells and take their place — every import
    // path deletes the `unknown` row for a cell it claims — but that only ever
    // reaches the cells some export still remembers. Whatever is left was
    // genuinely put there by hand, and had no way of ever saying so.
    //
    // A rename is not an UPDATE, because (user, cell, source) is a primary key
    // and a cell may already hold both names. So each row is merged into the
    // target with the same arithmetic a poll uses — the span widens, the counts
    // add up — rather than colliding with it or quietly overwriting it.
    if (req.method === 'POST' && pathname === '/api/sources/rename') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const from = String(body?.from ?? '').trim().slice(0, 40);
      const to = String(body?.to ?? '').trim().slice(0, 40);
      if (!from || !to) return send(res, 400, { error: 'from and to are both needed' });
      if (from === to) return send(res, 400, { error: 'that is already what it is called' });
      if (!/^[a-z0-9][a-z0-9-]*$/.test(to)) return send(res, 400, { error: 'that is not a source name' });
      const rows = q.sourceRowsFull.all(user.id, from);
      if (!rows.length) return send(res, 404, { error: 'nothing on the map came from there' });

      let merged = 0;
      await chunked(rows, (slice) => {
        for (const r of slice) {
          // Delete first: the merge below would otherwise be inserting a row
          // that already exists under the old name, and the old one has to go
          // whether or not the target was already there.
          q.delSourceCell.run(user.id, from, r.cell_id);
          if (q.hasSourceCell.get(user.id, to, r.cell_id)) merged++;
          q.mergeRow.run(
            user.id, r.cell_id, to, r.added_at,
            r.first_at, r.last_at, r.hits, r.fixes, VISIT_GAP_SEC,
          );
        }
      });
      // Routes carry a source too, and a rename that left them behind would
      // split one name across two. No collision to worry about: a route's key is
      // a hash of its geometry, which has nothing to do with what filed it.
      const routes = q.renameRoutes.run(to, user.id, from).changes;
      console.log(
        `[visited-map] renamed ${from} → ${to} for user ${user.id}: `
        + `${rows.length} cell rows (${merged} merged into existing), ${routes} routes`,
      );
      return send(res, 200, { ok: true, from, to, cells: rows.length, merged, routes });
    }

    if (req.method === 'POST' && pathname === '/api/sources/delete') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const source = String(body?.source ?? '').trim().slice(0, 40);
      if (!source) return send(res, 400, { error: 'which source?' });
      // Named back rather than taken on trust. This deletes by a string the
      // client chose, and a typo that matches nothing should say so instead of
      // reporting a cheerful zero.
      const known = q.sourceTally.all(user.id).some((s) => s.source === source);
      if (!known) return send(res, 404, { error: 'nothing on the map came from there' });
      const out = forgetSource(user, source);
      return send(res, 200, { ok: true, source, ...out, total: cellCount(user) });
    }

    // Where the photo library says you have been.
    //
    // The one connector that **replaces** rather than adds, and the only one for
    // which that is the honest thing to do. Every other source is a partial
    // account of a period — a file covers the dates it covers, a poll covers
    // since it last looked — so folding it in is right and dropping what it no
    // longer mentions would be wrong. A photo library is not a period. It is the
    // whole answer to "where have I taken a picture", it is on the phone in its
    // entirety, and a photo deleted from it is a claim withdrawn.
    //
    // So this arrives in one request rather than in batches, which is not a
    // shortcut: visits are counted across the whole set, so a library split into
    // ten uploads would be ten independent counts merged into a wrong one, and
    // there would be no moment at which "what it no longer mentions" was
    // knowable. 200,000 coordinates is about 6 MB of JSON and roughly a decade
    // of enthusiastic photography.
    //
    // **No photograph is read.** `PHAsset` carries the coordinate and the date
    // as metadata; the app never opens the image, and nothing but those two
    // numbers and a timestamp is sent.
    if (req.method === 'POST' && pathname === '/api/device/photos') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      if (borrowed(user)) return send(res, 409, { error: WEARING_SOMEBODY_ELSE });
      if (bigRequestsInFlight >= MAX_BIG_REQUESTS) {
        return send(res, 503, { error: 'Busy importing something else — try again in a moment.' });
      }
      bigRequestsInFlight++;
      try {
        const body = await readBody(req, BIG_BODY_LIMIT);
        const device = deviceOf(body);
        if (!device) return send(res, 400, { error: 'device.id must be 8–64 characters of [A-Za-z0-9._-]' });
        if (!Array.isArray(body.photos)) return send(res, 400, { error: 'photos must be an array' });
        if (body.photos.length > MAX_PHOTO_FIXES) return send(res, 400, { error: 'too many photos' });

        const now = nowSec();
        // `after: 0` — a photo library has no cursor and wants none. The same
        // sanity checks as a location fix otherwise: the null island, the
        // impossible coordinate, the clock a year out.
        const points = deviceFixes(body.photos, { after: 0, now });
        const cells = points.length ? pointsToCells(points) : [];

        // A library that reads as empty is refused rather than obeyed. Permission
        // granted for zero photos, a scan that failed halfway, a phone still
        // indexing after a restore — all arrive here as an empty list, and
        // treating that as "you have been nowhere" would take a decade of
        // geotags off the map on the strength of it.
        if (!cells.length) {
          return send(res, 400, {
            error: 'No photos with a location came through, so nothing was changed.',
          });
        }

        const keep = new Set(cells.map((c) => c.id));
        let removed = 0;
        const before = q.sourceTally.all(user.id).find((s) => s.source === PHOTO_SOURCE)?.cells ?? 0;
        await chunked(cells, (slice) => {
          for (const c of slice) {
            // upsertRow, not mergeRow: this is a re-reading of the same library
            // rather than a new slice of time, so the counts are replaced the
            // way re-importing a file replaces them.
            q.upsertRow.run(user.id, c.id, PHOTO_SOURCE, now, c.first, c.last, c.hits, c.fixes);
            clearPlaceholders(user.id, c.id, PHOTO_SOURCE);
          }
        });
        // And the withdrawal half of "replace": rows this library no longer
        // accounts for. Scoped to this one source, so a cell some other source
        // also vouches for stays on the map.
        const stale = q.sourceCells.all(user.id, PHOTO_SOURCE).filter((r) => !keep.has(r.cell_id));
        await chunked(stale, (slice) => {
          for (const r of slice) {
            q.delSourceCell.run(user.id, PHOTO_SOURCE, r.cell_id);
            removed++;
          }
        });

        q.touchDevice.run(user.id, device.id, device.name, device.platform, now, now);
        q.setPhotoScan.run(now, points.length, user.id, device.id);
        console.log(
          `[visited-map] photos: ${points.length} geotagged → ${cells.length} cells `
          + `(${removed} no longer claimed) for user ${user.id}`,
        );
        return send(res, 200, {
          ok: true,
          photos: points.length,
          skipped: body.photos.length - points.length,
          cells: cells.length,
          removed,
          before,
          total: cellCount(user),
        });
      } finally {
        bigRequestsInFlight--;
      }
    }

    // Forget a phone. Only the status row goes: the cells it sent came from
    // real fixes and stay, exactly as disconnecting Home Assistant leaves its.
    if (req.method === 'POST' && pathname === '/api/device/forget') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const id = String(body?.id ?? '').slice(0, 64);
      if (!id) return send(res, 400, { error: 'which device?' });
      q.delDevice.run(user.id, id);
      return send(res, 200, { ok: true, devices: q.devices.all(user.id).map(deviceOut) });
    }

    // Editing a saved route: rename it, refile it under a different app, or set
    // what kind of activity it was. Only the keys present are touched.
    if (req.method === 'POST' && pathname === '/api/routes/update') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const body = await readBody(req);
      const rowId = Math.trunc(+body.id);
      if (!Number.isFinite(rowId) || rowId <= 0) return send(res, 400, { error: 'bad route id' });
      // null means "leave it"; a trimmed empty string is a real value for the
      // two fields that are allowed to be blank.
      const text = (v, max) => (v === undefined ? null : String(v).slice(0, max));
      const name = body.name === undefined ? null : String(body.name).trim().slice(0, 120);
      if (name !== null && !name) return send(res, 400, { error: 'A route needs a name.' });
      const sport = text(body.sport, 40);
      const info = q.updRoute.run(
        name,
        body.source === undefined ? null : String(body.source).trim().slice(0, 40) || 'other',
        sport,
        text(body.place, 120),
        sport, // same value again, for the flag-clearing CASE
        user.id,
        rowId,
      );
      if (!info.changes) return send(res, 404, { error: 'No such route.' });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/routes/delete') {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const { id } = await readBody(req);
      const rowId = Math.trunc(+id);
      if (!Number.isFinite(rowId) || rowId <= 0) return send(res, 400, { error: 'bad route id' });
      // Read the whole row — geometry and all — before dropping it, and hand it
      // back. That copy is what Undo puts back: the map may never have loaded
      // the line (the routes layer is lazy), so if the answer doesn't carry it,
      // the only place it existed was the row that just went.
      const row = q.routeById.get(user.id, rowId);
      const info = q.delRoute.run(user.id, rowId);
      const route = row ? { ...routeOut(row), key: row.key } : null;
      return send(res, 200, { ok: true, removed: info.changes, route, total: routeCount(user) });
    }

    // Detailed boundaries for one country, worked out and cached server-side.
    // Session-gated: it is a small proxy onto a public dataset, and an open one
    // would be someone else's bandwidth to spend.
    if (req.method === 'GET' && pathname.startsWith('/api/regions/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const iso = pathname.slice('/api/regions/'.length).toUpperCase();
      const out = await fineRegions.get(iso);
      if (!out) return send(res, 400, { error: 'bad country code' });
      // Immutable *for this pair of inputs*, which is what the `?r=` the client
      // appends is for: the geoBoundaries commit is pinned, so their half cannot
      // change, and the tag changes whenever our region ids do. Caching it for a
      // year on the ISO code alone was wrong in a way that took a long time to
      // find — browsers replayed Italy's pre-dissolve province answer through
      // every rebuild, restart and reload, because `immutable` means the browser
      // will not even ask.
      return send(res, 200, out, { 'Cache-Control': 'public, max-age=31536000, immutable' });
    }

    // --- Train tracks -----------------------------------------------------------
    // A caching proxy onto OpenRailwayMap's vector tiles. Session-gated for the
    // same reason the boundaries above are: it spends somebody else's bandwidth,
    // and an open one would let anyone spend it. See server/rail-tiles.js for
    // what their usage policy asks of this and how far this departs from it.
    if (req.method === 'GET' && pathname.startsWith('/api/rail/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const rest = pathname.slice('/api/rail/'.length);
      // Doubles as the Referer sent upstream — this map's own origin, which is
      // the true answer to what the header asks and the one their server
      // insists on. See server/rail-tiles.js.
      const origin = selfOrigin(req);
      if (!origin) return send(res, 400, { error: 'no host' });

      // How deep it is currently worth asking each source for. The client caps
      // its `maxzoom` at this so MapLibre overzooms a parent tile rather than
      // drawing nothing where their CDN has no cached copy — see the note on
      // HEALTH_WINDOW_MS in server/rail-tiles.js. Never cached: the whole value
      // of it is being current.
      if (rest === 'detail') {
        return send(
          res,
          200,
          // `lang` rides along because the client has to stamp it onto the tile
          // URLs it asks for — not for us to read back, but so that the
          // *browser's* cache is keyed on it. See TILE_LANG in
          // server/rail-tiles.js.
          { detail: railTiles.detail(), degraded: railTiles.degraded(), lang: railTiles.lang },
          { 'Cache-Control': 'no-store' },
        );
      }

      let out = null;
      if (rest.startsWith('tile/')) {
        // `<source list>/<z>/<x>/<y>.pbf`. The source list is matched against the
        // style's own allowlist inside the module, so nothing here can be talked
        // into proxying an arbitrary path on their origin.
        const m = /^tile\/(.+)\/(\d+)\/(\d+)\/(\d+)\.pbf$/.exec(rest);
        if (m) out = await railTiles.tile(decodeURIComponent(m[1]), m[2], m[3], m[4], origin);
      } else if (rest.startsWith('sprite/') || rest.startsWith('sdf-sprite/')) {
        out = await railTiles.sprite(rest, origin);
      } else if (rest.startsWith('feature/')) {
        // `<source>/<sourceLayer>/<id>` — what runs over a line the person just
        // clicked. Both path parts are matched against the style's own layers
        // inside the module.
        const m = /^feature\/([^/]+)\/([^/]+)\/(.+)$/.exec(rest);
        if (m) {
          // Named rather than spread. `...m.slice(1, 4)` is an array of length
          // only a human can see is three, so `origin` — which comes off the
          // Host header — reads as though it could land in any parameter,
          // including the ones that become the upstream path. That is what
          // CodeQL's js/request-forgery was pointing at, and it was right to.
          const [source, sourceLayer, id] = m.slice(1, 4).map(decodeURIComponent);
          out = await railTiles.feature(source, sourceLayer, id, origin);
        }
      }

      if (!out) return send(res, 404, { error: 'no such tile' });
      return sendTileBytes(req, res, out);
    }

    // --- Trails -----------------------------------------------------------------
    // A caching proxy onto Waymarked Trails' raster tiles, and the lookup behind
    // the card a tap opens. Session-gated like the railways: it spends somebody
    // else's bandwidth, and an open one would let anyone spend it.
    //
    // No Referer is sent upstream, and none is needed — unlike OpenRailwayMap,
    // their server answers a bare request. `selfOrigin` is therefore not asked
    // for here, which also means this route works when the Host header does not
    // survive whatever is in front of it.
    if (req.method === 'GET' && pathname.startsWith('/api/trails/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      const rest = pathname.slice('/api/trails/'.length);

      // Which routes run near a box, for a tap. Not cached — see the note on
      // `near` in server/trail-tiles.js — and `no-store` for the same reason it
      // is not cached: the box is where somebody just put their finger.
      if (rest === 'near') {
        const found = await trailTiles.near(query.get('theme') ?? '', query.get('bbox') ?? '');
        if (!found) return send(res, 400, { error: 'no such theme, or not a bbox' });
        return send(res, 200, found, { 'Cache-Control': 'no-store' });
      }

      // `symbol/<theme>/<id>.svg` — the drawing of one waymark, which the card
      // shows where it used to print their sentence about it.
      //
      // **Served under a CSP of its own**, which nothing else here needs. An SVG
      // is a document: loaded in an `<img>` it can no more run a script than a
      // PNG can, but *navigated to* — a copied link, a right-click "open image"
      // — it would be somebody else's markup running on this origin, next to
      // this session's cookie. The bytes are theirs and the drawing is why we
      // fetched it, so the answer is to say what the document may do rather than
      // to trust that a symbol generator will never emit a `<script>`.
      const sym = /^symbol\/([a-z]+)\/([A-Za-z0-9_.-]{1,120})\.svg$/.exec(rest);
      if (sym) {
        const drawn = await trailTiles.symbol(sym[1], sym[2]);
        if (!drawn) return send(res, 404, { error: 'no such symbol' });
        return sendTileBytes(req, res, drawn, {
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        });
      }

      // `route/<theme>/<id>` — how far one route runs and how much of it is up
      // and down. Three numbers, extracted here from a record that is the whole
      // geometry; see `oneDetail` in server/trail-tiles.js.
      const one = /^route\/([a-z]+)\/(\d{1,12})$/.exec(rest);
      if (one) {
        const about = await trailTiles.details(one[1], one[2]);
        if (!about) return send(res, 404, { error: 'nothing known about that route' });
        // Cacheable by the browser, unlike `near` above: this is a fact about a
        // route rather than about where somebody put their finger.
        return send(res, 200, about, { 'Cache-Control': 'private, max-age=86400' });
      }

      // `tile/<theme>/<z>/<x>/<y>.png`. The theme is matched against the
      // module's own list and the coordinates are three integers checked
      // against the zoom, so nothing here can be talked into proxying an
      // arbitrary path on their origin.
      const m = /^tile\/([a-z]+)\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(rest);
      const out = m ? await trailTiles.tile(m[1], m[2], m[3], m[4]) : null;
      if (!out) return send(res, 404, { error: 'no such tile' });
      return sendTileBytes(req, res, out);
    }

    // --- Administering the server -----------------------------------------------
    //
    // Everything behind one prefix and one gate, so there is exactly one place
    // to read to know who can reach any of it. Three rules hold across the lot:
    //
    //   - **The gate is the effective account.** `currentUser` resolves an
    //     impersonated session to the account being visited, so an admin who has
    //     opened somebody else's map cannot reach these at all until they come
    //     back — which is the point of `/api/admin/return` being the exception.
    //   - **Nothing here reads anybody's map.** Counts, dates and error strings;
    //     no cell, no coordinate, no route. Seeing somebody's map means opening
    //     it as them, which is loud in three places at once.
    //   - **It is all logged.** Resetting a password and opening an account are
    //     the two things here that a person could later dispute, so both leave a
    //     line in the server log naming who did what to whom.
    if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });

      // The way back out of somebody else's account, and the one route here an
      // impersonated session may use — it is checked against the session rather
      // than against the account's permissions, because the account being worn
      // has none of the admin's.
      if (req.method === 'POST' && pathname === '/api/admin/return') {
        const back = user.asAdmin;
        if (!back) return send(res, 400, { error: 'This session is your own account.' });
        const token = parseCookies(req).sid;
        if (token) q.delSession.run(token);
        const fresh = newToken();
        q.insSession.run(fresh, back.id, nowISO(), 0);
        console.log(`[visited-map] ${back.username} left ${user.username}'s account`);
        return send(res, 200, { username: back.username, admin: true }, {
          'Set-Cookie': sessionCookie(req, fresh, SESSION_MAX_AGE),
        });
      }

      // **An impersonated session never gets past here, whoever it is wearing.**
      //
      // `isAdmin` alone would be enough for the ordinary case — the account
      // being worn is not an admin, so it is refused. It is not enough when an
      // admin opens *another admin's* account: the effective user is then an
      // admin, everything below would open, and every line this file logs would
      // name the wrong person. The `asAdmin` half closes that outright, and
      // costs nothing anybody wants: coming back to your own account is one
      // press, and it is the press that makes the log true.
      if (!isAdmin(user) || user.asAdmin) {
        return send(res, 403, { error: 'This is only for whoever runs this server.' });
      }

      // The machine: how long it has been up, what it is running on, and what is
      // using the disk. Answered fresh every time — it is a page somebody opens
      // *because* they suspect something has changed.
      if (req.method === 'GET' && pathname === '/api/admin/overview') {
        return send(res, 200, {
          ...(await adminOverview()),
          backup: await backups.status().then((s) => ({ ...s, description: describeCron(s.cron) })).catch(() => null),
        });
      }

      if (req.method === 'GET' && pathname === '/api/admin/users') {
        return send(res, 200, { users: adminUsers(), me: user.username });
      }

      // Everything below changes somebody else's account, so it is rate limited
      // as a set. Not because any of it is guessable — the caller is already an
      // admin — but because a loop that has got loose here rewrites passwords.
      if (req.method === 'POST') {
        const hit = adminActionLimiter.take(String(user.id));
        if (!hit.ok) {
          return send(res, 429, { error: 'Too many changes at once. Try again shortly.' }, { 'Retry-After': String(hit.retryAfter) });
        }
      }

      // A new password for somebody who cannot sign in. Their sessions go with
      // it: a password reset that leaves the old cookies working has not
      // actually locked anybody out, which is half of why it gets reset.
      if (req.method === 'POST' && pathname === '/api/admin/password') {
        const { id, password } = await readBody(req);
        const row = q.userById.get(Number(id));
        if (!row) return send(res, 404, { error: 'No such account.' });
        const pw = String(password ?? '');
        if (pw.length < MIN_PASSWORD_LEN) {
          return send(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
        }
        if (pw.length > 512) return send(res, 400, { error: 'That password is too long.' });
        q.setPassword.run(await hashPassword(pw), row.id);
        const dropped = q.delUserSessions.run(row.id).changes;
        console.log(`[visited-map] ${user.username} reset ${row.username}'s password (${dropped} sessions ended)`);
        return send(res, 200, { ok: true, username: row.username, sessionsEnded: dropped });
      }

      // Handing the server over, or taking it back. The last admin cannot be
      // demoted and nobody can demote themselves: both are one press from a
      // server with nobody able to administer it, and the only way back from
      // that is a text editor and the database file.
      if (req.method === 'POST' && pathname === '/api/admin/grant') {
        const { id, admin } = await readBody(req);
        const row = q.userById.get(Number(id));
        if (!row) return send(res, 404, { error: 'No such account.' });
        const want = !!admin;
        if (!want && row.id === user.id) {
          return send(res, 400, { error: 'You cannot take your own admin away.' });
        }
        if (!want && (q.countAdmins.get()?.n ?? 0) <= 1) {
          return send(res, 400, { error: 'Somebody has to be able to administer this server.' });
        }
        q.setAdmin.run(want ? 1 : 0, row.id);
        console.log(`[visited-map] ${user.username} ${want ? 'made' : 'unmade'} ${row.username} an admin`);
        return send(res, 200, { ok: true, username: row.username, admin: want });
      }

      // Opening somebody else's account, to see what they are seeing.
      //
      // A whole new session rather than a flag on this one, for two reasons:
      // every route in this file reads the account off the session and would
      // otherwise each have to remember to ask a second question, and the way
      // back is then simply *another* session rather than an unwinding. The
      // admin's own session is dropped in the same breath — leaving it alive
      // would mean two valid cookies for one browser, only one of which it is
      // holding.
      if (req.method === 'POST' && pathname === '/api/admin/impersonate') {
        const { id } = await readBody(req);
        const row = q.userById.get(Number(id));
        if (!row) return send(res, 404, { error: 'No such account.' });
        if (row.id === user.id) return send(res, 400, { error: 'That is your own account.' });
        const token = parseCookies(req).sid;
        if (token) q.delSession.run(token);
        const fresh = newToken();
        q.insSession.run(fresh, row.id, nowISO(), user.id);
        console.log(`[visited-map] ${user.username} opened ${row.username}'s account`);
        return send(res, 200, { username: row.username, asAdmin: user.username }, {
          'Set-Cookie': sessionCookie(req, fresh, SESSION_MAX_AGE),
        });
      }

      // Closing somebody else's account, and taking their map with it.
      //
      // **The admin's own password is asked for**, which is the same bar
      // `/api/account/delete` sets for closing your own and for the same
      // reason, one step stronger: a 90-day session cookie on an unlocked
      // laptop is what would otherwise stand as consent, and here it is not
      // even the consent of the person whose map goes. Every other thing an
      // admin can do to an account is recoverable — a password can be reset
      // again, an admin flag put back, a session simply made again. This one
      // is not, by anybody, ever.
      //
      // **You cannot delete yourself from here.** Not because it would break
      // anything, but because there is already a door for that — Settings →
      // Other — and it is the one that says out loud what you are about to
      // lose. A list of accounts with your own name in it is a place to
      // mis-click, not a place to close your account from.
      if (req.method === 'POST' && pathname === '/api/admin/users/delete') {
        const { id, password } = await readBody(req);
        const row = q.userById.get(Number(id));
        if (!row) return send(res, 404, { error: 'No such account.' });
        if (row.id === user.id) {
          return send(res, 400, { error: 'Close your own account from Settings → Other.' });
        }
        const me = q.userById.get(user.id);
        const ok = me ? await verifyPassword(String(password ?? ''), me.pass) : false;
        if (!ok) return send(res, 403, { error: 'That password is not right.' });
        const removed = deleteAccount({ id: row.id, username: row.username });
        console.log(`[visited-map] ${user.username} deleted ${row.username}'s account`);
        return send(res, 200, {
          ok: true,
          username: row.username,
          removed,
          // Said rather than left to be found out, the same as the self-delete:
          // a snapshot taken before now still holds the whole account, and the
          // person reading this is the only one who can reach those.
          backupsKept: existsSync(BACKUP_DIR),
        });
      }

      // Signing every one of somebody's devices out, without changing anything
      // they know. The gentler half of the reset above: a phone that was lost
      // is a session to end, not a password to change.
      if (req.method === 'POST' && pathname === '/api/admin/sessions/end') {
        const { id } = await readBody(req);
        const row = q.userById.get(Number(id));
        if (!row) return send(res, 404, { error: 'No such account.' });
        const dropped = q.delUserSessions.run(row.id).changes;
        console.log(`[visited-map] ${user.username} ended ${dropped} of ${row.username}'s sessions`);
        // Their own session may have been one of them.
        const gone = row.id === user.id;
        return send(res, 200, { ok: true, username: row.username, sessionsEnded: dropped, signedOut: gone });
      }
    }

    // --- Backups --------------------------------------------------------------
    // Instance-wide, so admin-only. A backup file is the whole database — every
    // account's cells, the password hashes, the Home Assistant token — which is
    // also why the download below is the most sensitive route in here.
    //
    // This used to test for the *first* account by id, which was the right idea
    // with the wrong handle on it: an id cannot be granted to a second person or
    // taken back from the first, and both are things a household map needs. See
    // `bootstrapAdmin` — the first account still has it, it is simply a flag now.
    if (pathname === '/api/backup' || pathname.startsWith('/api/backup/')) {
      const user = currentUser(req);
      if (!user) return send(res, 401, { error: 'not authenticated' });
      // The same two-part gate as /api/admin, and for the same reason: a
      // snapshot pulled off the machine while wearing somebody else's name is
      // the worst version of that hole, because the file is every account.
      if (!isAdmin(user) || user.asAdmin) {
        return send(res, 403, { error: 'Backups belong to whoever runs this server.' });
      }

      const withDescription = async () => {
        const s = await backups.status();
        return { backup: { ...s, description: describeCron(s.cron) } };
      };

      if (req.method === 'GET' && pathname === '/api/backup') {
        return send(res, 200, await withDescription());
      }

      if (req.method === 'POST' && pathname === '/api/backup') {
        const body = await readBody(req);
        try {
          backups.save({ enabled: body.enabled, cron: body.cron, keep: body.keep });
        } catch (e) {
          // The cron parser's messages are written for a person to read and are
          // marked as such in backups.save(); a failure to *store* the settings
          // is not, and says only that.
          const why = userMessage(e, 'That schedule could not be saved.', 'backup settings rejected');
          return send(res, 400, { error: why.slice(0, 200) });
        }
        return send(res, 200, await withDescription());
      }

      // "Back up now". Deliberately not forced: if nothing has changed it says
      // so instead of writing another identical copy, which is the whole point
      // of the feature and worth seeing work.
      if (req.method === 'POST' && pathname === '/api/backup/run') {
        const out = await backups.run();
        return send(res, 200, { ...out, ...(await withDescription()) });
      }

      // Taking a copy off this machine is the only thing that makes a backup a
      // backup, so it can be downloaded. Only names this server wrote are
      // accepted, and the pattern has no slash or dot in it — there is no path
      // to traverse to.
      if (req.method === 'GET' && pathname === '/api/backup/download') {
        const name = query.get('name') ?? '';
        if (!isBackupName(name)) return send(res, 400, { error: 'no such backup' });
        const file = path.join(BACKUP_DIR, name);
        let size;
        try {
          size = (await stat(file)).size;
        } catch {
          return send(res, 404, { error: 'no such backup' });
        }
        res.writeHead(200, {
          ...BASE_SECURITY_HEADERS,
          'Content-Type': 'application/vnd.sqlite3',
          'Content-Length': String(size),
          'Content-Disposition': `attachment; filename="${name}"`,
          'Cache-Control': 'no-store',
        });
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy());
        return stream.pipe(res);
      }
    }

    return send(res, 404, { error: 'not found' });
  } catch (e) {
    if (e.message === 'bad json') return send(res, 400, { error: 'invalid JSON' });
    if (e.message === 'too large') return send(res, 413, { error: 'payload too large' });
    console.error('API error:', e);
    return send(res, 500, { error: 'server error' });
  }
}

// --- Static (production) -----------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};
// Already-compressed formats gain nothing from another pass.
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.map']);

// dist/ is a build output: it only changes when `npm run build` runs, and the
// bundle is a few megabytes. Read it once, gzip it once, and keep both — the
// alternative was re-reading and (with compression) re-gzipping every file on
// every page load. Keyed on size+mtime so a rebuild is picked up without a
// restart, which is what makes this safe to leave on in dev.
const staticCache = new Map();

async function loadStatic(file) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  if (!info.isFile()) return null;
  const tag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const hit = staticCache.get(file);
  if (hit && hit.etag === tag) return hit;
  const body = await readFile(file);
  const entry = {
    etag: tag,
    body,
    type: MIME[path.extname(file)] || 'application/octet-stream',
    gz: COMPRESSIBLE.has(path.extname(file)) && body.length >= GZIP_MIN_BYTES ? gzipSync(body) : null,
  };
  staticCache.set(file, entry);
  return entry;
}

// The page itself. script-src without 'unsafe-inline'/'unsafe-eval' is the part
// that matters: it means an injected string can't become running script, which
// is the difference between a defacement and an account takeover. blob: is there
// because MapLibre builds its worker from one. Styles keep 'unsafe-inline' —
// the colour picker writes style="background:…" into markup — and connect/img
// stay open to https: because the map legitimately talks to tile, geocoder and
// Komoot hosts, none of which are dangerous the way script execution is.
//
// **'wasm-unsafe-eval' is why Standard's landmarks are buildings and not sheds.**
// Mapbox GL JS decodes the batched meshes behind `mapbox-3dbuildings-v1` — the
// modelled station roofs, churches and parliaments — in WebAssembly, and a
// script-src without a wasm source blocks `WebAssembly.instantiate` outright.
// What that looks like is *not* an error anyone would connect to this line: the
// tiles are fetched, the layer stays visible, and every landmark draws as the
// plain extrusion it falls back to. It cost a long afternoon of reading
// Standard's config schema, because the map is only ever wrong **behind this
// server** — Vite's dev server sends no CSP, so localhost:5173 renders the
// models perfectly and the bug does not exist until it is deployed.
//
// Despite the name it is far narrower than 'unsafe-eval': it permits compiling
// WebAssembly and nothing else. `eval()`, `new Function` and friends stay
// refused, so a string injected into this page still cannot become running
// JavaScript, which is the whole point of the directive above. A browser too old
// to know the token ignores it and is back to plain extrusions — the same map it
// draws today, and no worse.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' https:",
].join('; ');

function sendStatic(req, res, entry, immutable) {
  // Content-hashed filenames can be cached forever; index.html must be
  // revalidated or a deploy would never be picked up.
  const cache = immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
  const secure = {
    ...BASE_SECURITY_HEADERS,
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
  };
  if (isHttps(req)) secure['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, { ETag: entry.etag, 'Cache-Control': cache, ...secure });
    return res.end();
  }
  const head = { 'Content-Type': entry.type, ETag: entry.etag, 'Cache-Control': cache, ...secure };
  const gz = entry.gz && acceptsGzip(req);
  const body = gz ? entry.gz : entry.body;
  if (gz) {
    head['Content-Encoding'] = 'gzip';
    head.Vary = 'Accept-Encoding';
  } else if (entry.gz) {
    head.Vary = 'Accept-Encoding';
  }
  head['Content-Length'] = String(body.length);
  res.writeHead(200, head);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// --- Telling the iOS app apart ---------------------------------------------------
// The app appends this to its User-Agent (WebViewController.userAgentTag). It is
// the whole of the identification, and it buys one thing: the page can be served
// already knowing it is inside an app with a native tab bar over the bottom of
// the screen, so its chrome is laid out correctly on the first paint rather than
// jumping once a script has run.
//
// Nothing about the *data* changes — this marks a viewport, not an account.
const IOS_CLIENT = 'HexploreiOS';
const isIosApp = (req) => String(req.headers['user-agent'] ?? '').includes(IOS_CLIENT);

// One rewritten copy of index.html, rebuilt only when the real one changes. The
// etag carries a suffix so a browser and the app can never be handed each
// other's copy out of a cache in between.
let iosIndex = { from: null, entry: null };

function indexForClient(req, entry) {
  if (!entry || !isIosApp(req)) return entry;
  if (iosIndex.from !== entry.etag) {
    // Matched on the opening tag rather than the whole of it, so an attribute
    // added to index.html cannot silently stop the app being an app. It already
    // did once: `class="booting"` went on that tag and the exact-string replace
    // quietly matched nothing, which shows up as the iOS chrome sitting under
    // the tab bar and nowhere else.
    const html = entry.body
      .toString('utf8')
      .replace('<html lang="en"', '<html lang="en" data-client="ios"');
    const body = Buffer.from(html, 'utf8');
    iosIndex = {
      from: entry.etag,
      entry: {
        etag: `${entry.etag.slice(0, -1)}-ios"`,
        body,
        type: entry.type,
        gz: body.length >= GZIP_MIN_BYTES ? gzipSync(body) : null,
      },
    };
  }
  return iosIndex.entry;
}

async function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    // A stray '%' is not a path; decodeURIComponent throws on it, and this
    // function's rejection had nowhere to go.
    return send(res, 400, { error: 'bad path' });
  }
  // A NUL can truncate the name by the time it reaches the filesystem.
  if (rel.includes('\0')) return send(res, 400, { error: 'bad path' });
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(DIST, rel));
  // startsWith(DIST) alone also accepted siblings whose names merely began with
  // it — /…/dist-backup/secrets passes "starts with /…/dist". The separator is
  // what makes it mean "inside DIST".
  if (file !== DIST && !file.startsWith(DIST + path.sep)) {
    return send(res, 403, { error: 'forbidden' });
  }

  const entry = await loadStatic(file);
  // Vite writes content-hashed names into /assets/, so those URLs never point
  // at different bytes and can be cached indefinitely.
  if (entry) {
    const isIndex = rel === '/index.html' || rel.endsWith('/index.html');
    return sendStatic(req, res, isIndex ? indexForClient(req, entry) : entry, rel.startsWith('/assets/'));
  }

  // SPA fallback: serve index.html for unknown non-file routes.
  const fallback = await loadStatic(path.join(DIST, 'index.html'));
  if (fallback) return sendStatic(req, res, indexForClient(req, fallback), false);
  send(res, 404, { error: 'not found' });
}

// --- Server ------------------------------------------------------------------
const server = createServer((req, res) => {
  // Both handlers are async and neither was awaited, so anything that threw
  // outside their own try/catch became an unhandled rejection — which Node
  // turns into an uncaught exception, i.e. the whole server exits. A malformed
  // path was enough to do it. Catching here means the worst case is one 500.
  const fail = (e) => {
    console.error('request failed:', e);
    if (!res.headersSent) send(res, 500, { error: 'server error' });
    else res.end();
  };
  let parsed;
  try {
    parsed = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return send(res, 400, { error: 'bad request' });
  }
  const { pathname, searchParams } = parsed;
  // Negotiated once here so send() doesn't have to be handed the request.
  res.wantsGzip = acceptsGzip(req);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname, searchParams).catch(fail);
  if (SERVE_STATIC) return serveStatic(req, res, pathname).catch(fail);
  send(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`[visited-map] API on http://localhost:${PORT}` + (SERVE_STATIC ? ' (also serving dist/)' : ''));
  // Anything that happened while the server was down is still in Home
  // Assistant's recorder, so the first tick after a restart backfills it.
  setTimeout(haPollTick, 5000);
  setInterval(haPollTick, HA_POLL_TICK_MS);
  setTimeout(stravaPollTick, 8000);
  setInterval(stravaPollTick, STRAVA_POLL_TICK_MS);
  // Expired sessions are dropped when they're used, but nothing makes an
  // abandoned one come back — so sweep them out daily too.
  const sweepSessions = () => {
    const cutoff = new Date((nowSec() - SESSION_MAX_AGE) * 1000).toISOString();
    const gone = db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff).changes;
    if (gone) console.log(`[visited-map] cleared ${gone} expired session(s)`);
  };
  setTimeout(sweepSessions, 10000);
  setInterval(sweepSessions, 24 * 60 * 60 * 1000);
  // Timed backups. start() also takes one shortly after boot if the machine
  // was asleep or the server was down when the schedule last came round.
  const bs = backups.settings();
  backups.start();
  console.log(
    bs.enabled
      ? `[visited-map] backups: ${describeCron(bs.cron)} → ${BACKUP_DIR} (keeping ${bs.keep})`
      : '[visited-map] backups are switched off',
  );
});
