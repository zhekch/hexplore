// Client for the auth + per-user cell API, plus the login/register gate UI.
// All requests are same-origin (Vite proxies /api to the server in dev; the
// server serves both in prod), so the HttpOnly session cookie rides along and
// you stay signed in across reloads without any token handling here.

// Whether the server is answering at all. Every call reports in here, so the
// page can say plainly that edits are not being saved rather than looking like
// it accepted them — the map keeps working when the server is gone, which is
// exactly what makes silent failure dangerous.
const watchers = new Set();
let reachable = true;

function setReachable(ok, reason) {
  if (ok === reachable) return;
  reachable = ok;
  for (const fn of watchers) fn(ok, reason);
}

export const connection = {
  ok: () => reachable,
  watch(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
  // Used by the retry button: a cheap request that settles the question.
  async check() {
    try {
      await fetch('/api/me', { cache: 'no-store' });
      setReachable(true);
    } catch {
      setReachable(false, 'offline');
    }
    return reachable;
  },
};

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // fetch only rejects when the request never got an answer: the server is
    // down, the network is gone, the tunnel dropped.
    setReachable(false, 'offline');
    throw new Error('Cannot reach the server — your changes are not being saved.');
  }
  // A 5xx means it answered but could not do the job; that is just as much a
  // failed save, and worth surfacing the same way.
  setReachable(res.status < 500, res.status >= 500 ? 'error' : undefined);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-JSON response */
  }
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

// The build the server reports, kept from the session check so Settings can
// show it without a request of its own. Null until that check has answered, and
// null forever if it never does — a version we do not know is not one to invent.
let serverVersion = null;

/** What the server said it was, or null if it has not said yet. */
export const serverBuild = () => serverVersion;

/** Stash the build off any response that carries one, and pass the name on. */
function keepVersion(d) {
  if (typeof d?.version === 'string') serverVersion = d.version;
  return d?.username;
}

export const auth = {
  // Resolves to the username if a valid session cookie exists, else null.
  me: () => api('GET', '/api/me').then(keepVersion).catch(() => null),
  // Both carry the build as well, so signing in fresh knows it without a second
  // round trip — `me()` is only called for an existing session.
  register: (username, password) => api('POST', '/api/register', { username, password }).then(keepVersion),
  login: (username, password) => api('POST', '/api/login', { username, password }).then(keepVersion),
  logout: () => api('POST', '/api/logout'),
  // Close the account: the map, the routes, the connections, the account row.
  // The password is sent again because the server asks for it again — a session
  // is not consent to this one. Answers with what it removed, and with whether
  // a backup still holds a copy.
  deleteAccount: (password) => api('POST', '/api/account/delete', { password }),

  // { sources: ['manual', …], rows: [[cellId, sourceIdx, addedAt, firstAt, lastAt, hits, fixes], …] }
  // Timestamps are epoch seconds; 0 means the source didn't carry a date.
  // `hits` counts separate visits, `fixes` the raw points behind them.
  getCells: () => api('GET', '/api/cells'),
  // Incremental map edits. Removing a cell clears it for every source.
  mutateCells: (add, remove, source = 'manual') =>
    api('POST', '/api/cells/mutate', { add, remove, source }),
  // Undo for a clear. Not the same call as mutateCells(add): clearing drops
  // every source's row for a cell, so putting it back means sending the rows
  // themselves — [id, source, addedAt, firstAt, lastAt, hits, fixes] — and not
  // just the ids, which would come back as bare manual marks.
  restoreCells: (rows) => api('POST', '/api/cells/restore', { rows }),
  // How this account likes to look at its map (route colours, hidden
  // activities). Synced so the phone and the laptop agree.
  getPrefs: () => api('GET', '/api/prefs').then((d) => d.prefs ?? {}),
  setPrefs: (prefs) => api('POST', '/api/prefs', { prefs }),
  // The same save, but allowed to outlive the page.
  //
  // A tab being closed or backgrounded cancels ordinary fetches, and that is
  // exactly the moment the last preference change is still sitting in its
  // debounce — which is how a colour could be picked, look right, and be gone
  // after a reload. `keepalive` hands the request to the browser to finish on
  // its own; its 64 KB body cap is far above anything this sends.
  //
  // Deliberately not routed through api(): a request issued while the page is
  // going away must not be able to flip the "cannot reach the server" banner on
  // the way out, and nothing is left to await its answer.
  sendPrefs(prefs) {
    try {
      fetch('/api/prefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs }),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* nothing useful left to do at this point in the page's life */
    }
  },

  // Bulk import: cells are [id, firstAt, lastAt, hits, fixes] tuples.
  importCells: (source, cells) => api('POST', '/api/cells/import', { source, cells }),

  // The server's readings of the rows — see src/derived.js for why they are not
  // worked out here. Each carries an ETag, so asking again after nothing has
  // changed costs a 304 rather than the answer.
  //
  // { trips: [...], home: { lng, lat, name } | null }
  getTrips: () => api('GET', '/api/trips'),
  // Ground covered, by country and by region, plus days, streak and sources.
  getStats: () => api('GET', '/api/stats'),

  // Saved routes. Without `geom` this is just the list (name, dates, length,
  // bounds) — the lines themselves are only worth fetching once they're shown.
  getRoutes: (geom = false) => api('GET', `/api/routes${geom ? '?geom=1' : ''}`).then((d) => d.routes ?? []),
  saveRoutes: (routes) => api('POST', '/api/routes', { routes }),
  // Fill in place names for routes stored before naming existed: [[id, place], …].
  setRoutePlaces: (places) => api('POST', '/api/routes/places', { places }),
  // Edit a saved route in place. Only the keys you pass are changed.
  updateRoute: (id, patch) => api('POST', '/api/routes/update', { id, ...patch }),
  // Answers with the row it removed, geometry included — that copy is the only
  // one there is once the row is gone, and it's what Undo puts back.
  deleteRoute: (id) => api('POST', '/api/routes/delete', { id }),

  // Home Assistant. The access token only ever travels one way: `getHaLink`
  // and `saveHaLink` never give it back, so the dialog shows a blank field for
  // a connection that already has one.
  getHaLink: () => api('GET', '/api/ha').then((d) => d.link ?? null),
  probeHa: (baseUrl, token) => api('POST', '/api/ha/probe', { baseUrl, token }),
  saveHaLink: (patch) => api('POST', '/api/ha', patch).then((d) => d.link ?? null),
  syncHa: () => api('POST', '/api/ha/sync'),
  deleteHaLink: () => api('POST', '/api/ha/delete'),

  // Strava. The client secret and the OAuth tokens stay on the server — this
  // only ever sends them out, and reads back status.
  getStravaLink: () => api('GET', '/api/strava'),
  saveStravaLink: (patch) => api('POST', '/api/strava', patch).then((d) => d.link ?? null),
  authorizeStrava: () => api('POST', '/api/strava/authorize'),
  syncStrava: () => api('POST', '/api/strava/sync'),
  deleteStravaLink: () => api('POST', '/api/strava/delete'),

  // Phones reporting their own position. There is nothing to save from here:
  // the settings are on the phone, because a schedule kept on the server could
  // not wake one. Forgetting a phone drops its status row and leaves its cells,
  // which came from real fixes.
  getDevices: () => api('GET', '/api/device').then((d) => d.devices ?? []),
  // Everything that has put something on the map, and taking one back off. The
  // delete is per *source*, which is a different question from clearing a cell:
  // a cell another source also vouches for keeps that claim and stays.
  getSources: () => api('GET', '/api/sources').then((d) => d.sources ?? []),
  deleteSource: (source) => api('POST', '/api/sources/delete', { source }),
  // File what is already on the map under a different name. Written for
  // `unknown`, the placeholder every pre-provenance cell carries.
  renameSource: (from, to) => api('POST', '/api/sources/rename', { from, to }),
  forgetDevice: (id) => api('POST', '/api/device/forget', { id }).then((d) => d.devices ?? []),

  // Timed copies of the whole database, taken by the server. These belong to
  // the account that made the map — every other account gets 403 — because a
  // backup file holds everyone's cells and the Home Assistant token with them.
  getBackup: () => api('GET', '/api/backup').then((d) => d.backup ?? null),
  saveBackup: (patch) => api('POST', '/api/backup', patch).then((d) => d.backup ?? null),
  runBackup: () => api('POST', '/api/backup/run'),
  backupUrl: (name) => `/api/backup/download?name=${encodeURIComponent(name)}`,
};

// Wires the auth overlay (markup in index.html) and the account row in the
// base-map menu. Calls onAuthed(username) after a successful session/login/
// register, and onLoggedOut() after logout.
//
// Returns `{ ready, signedOut }`: `ready` settles once the initial session check
// has resolved, and `signedOut()` puts the page back to the signed-out state
// without asking the server anything. Closing an account needs that second one —
// the session is already gone by the time the answer arrives, so there is
// nothing left to log out of, but the page still has to stop showing a map that
// no longer exists.
export function mountAuth({ onAuthed, onLoggedOut }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('auth-overlay');
  const form = $('auth-form');
  const userEl = $('auth-username');
  const passEl = $('auth-password');
  const errEl = $('auth-error');
  const submitEl = $('auth-submit');
  const subEl = $('auth-sub');
  const switchText = $('auth-switch-text');
  const switchBtn = $('auth-switch-btn');
  const accountBox = $('layers-account');
  const accountName = $('account-name');
  const logoutBtn = $('account-logout');

  let register = false; // false = log in, true = create account
  let busy = false;

  const showErr = (m) => {
    errEl.textContent = m;
    errEl.hidden = false;
  };
  const hideErr = () => {
    errEl.hidden = true;
  };

  function renderMode() {
    submitEl.textContent = register ? 'Create account' : 'Log in';
    subEl.textContent = register ? 'Pick a username and password to save your map' : 'Sign in to see your map';
    switchText.textContent = register ? 'Already have an account?' : 'New here?';
    switchBtn.textContent = register ? 'Log in' : 'Create an account';
    passEl.autocomplete = register ? 'new-password' : 'current-password';
    hideErr();
  }

  function showModal() {
    overlay.hidden = false;
    accountBox.hidden = true;
    setTimeout(() => userEl.focus(), 60);
  }

  function showAuthed(username) {
    overlay.hidden = true;
    accountBox.hidden = false;
    accountName.textContent = username;
    passEl.value = '';
  }

  switchBtn.addEventListener('click', () => {
    register = !register;
    renderMode();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const u = userEl.value.trim();
    const pw = passEl.value;
    if (!u || !pw) {
      showErr('Enter a username and password.');
      return;
    }
    busy = true;
    submitEl.disabled = true;
    hideErr();
    try {
      const username = register ? await auth.register(u, pw) : await auth.login(u, pw);
      showAuthed(username);
      await onAuthed?.(username);
    } catch (err) {
      showErr(err.message || 'Something went wrong.');
    } finally {
      busy = false;
      submitEl.disabled = false;
    }
  });

  // Everything logging out does to the page, with nothing said to the server.
  // Shared with account deletion, which has already been signed out by the time
  // it gets an answer.
  function signedOut() {
    register = false;
    renderMode();
    userEl.value = '';
    passEl.value = '';
    showModal();
    onLoggedOut?.();
  }

  logoutBtn.addEventListener('click', async () => {
    try {
      await auth.logout();
    } catch {
      /* clear the UI regardless */
    }
    signedOut();
  });

  renderMode();

  const ready = (async () => {
    const username = await auth.me();
    if (username) {
      showAuthed(username);
      await onAuthed?.(username);
    } else {
      showModal();
    }
  })();

  return { ready, signedOut };
}
