// The Admin pane of Settings: the server, and the accounts on it.
//
// ## What this is for
//
// A self-hosted map that more than one person uses eventually needs somebody to
// be able to answer three questions that no per-account screen can:
//
//   - **Is the machine all right?** How long it has been up, how much disk the
//     database and the tile caches have taken, how much is left.
//   - **Is it working for them?** When each account last signed in, when it last
//     *received* anything, how much is on its map, and which of its connectors
//     has stopped.
//   - **Can I get them back in?** A password reset, and — for the things a
//     description will never settle — opening their map as them.
//
// ## What it deliberately does not show
//
// **The shape of an account, never its contents.** Every number here is a count
// or a date. Nothing in this pane, or in the routes behind it, reads a cell id,
// a route geometry or a coordinate — which is the difference between a panel
// that says "Bob's phone stopped pushing three weeks ago" and one that says
// where Bob was three weeks ago. Seeing somebody's map means opening it as them,
// and that is loud in three places at once: a line in the server log, a tinted
// chip across the top of the map that cannot be dismissed, and the account name
// in the Settings header.
//
// ## Impersonation
//
// The server hands back a whole new session belonging to the other account, with
// the admin's own id remembered on it (see `/api/admin/impersonate`). So the
// page really is that person in every respect — including *not being an admin*,
// which is why this pane disappears while it is going on. The only way back is
// the chip, which asks for a session of one's own again.
//
// The page reloads on both legs. Nothing here is worth the alternative: every
// cache, every derived reading, the routes, the trips, the preferences and the
// map itself are all keyed to whoever was signed in, and unpicking that in place
// is a great deal of code for a thing that happens twice a year.

import { auth } from './auth.js';
import { formatDayTime } from './clock.js';
import { whenAgo } from './device-ui.js';

const n = (v) => (v ?? 0).toLocaleString();

/** Bytes, at whatever scale stops it being a wall of digits. */
function size(bytes) {
  const b = bytes ?? 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * How long the server has been up, in the two largest units that apply.
 *
 * "3 days 4 h" rather than "3 d" or "76 h 12 m 9 s": the first throws away the
 * part somebody is actually reading it for — whether the restart was this
 * morning — and the last is a stopwatch reading for a number nobody times.
 */
function uptime(sec) {
  const s = Math.max(0, Math.floor(sec ?? 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'} ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

/** A date somebody will read as "when", not "exactly when". Never a raw 0. */
const when = (sec) => (sec ? whenAgo(sec) : 'never');

/**
 * @param {object} opts
 * @param {() => void} [opts.onLeave] shut Settings — impersonation takes the
 *   page away, and a dialog left standing over a reload is a flash of the wrong
 *   account's map
 */
export function mountAdmin({ onLeave } = {}) {
  const $ = (id) => document.getElementById(id);
  const tilesEl = $('admin-tiles');
  const storageEl = $('admin-storage');
  const usersEl = $('admin-users');
  const errEl = $('admin-error');
  const noteEl = $('admin-note');
  const refreshBtn = $('admin-refresh');

  let overview = null;
  let users = [];
  let me = null;
  let busy = false;
  // Which account is showing its reset field, and which is one press from having
  // its map opened. One at a time, for the reason the Sources list does the
  // same: two open forms in a list of accounts is a page, not a row.
  let resetting = null;
  let arming = null;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };
  const say = (m) => {
    if (noteEl) noteEl.textContent = m ?? '';
  };

  // --- Drawing ------------------------------------------------------------------

  function tile(label, value, sub) {
    const el = document.createElement('div');
    el.className = 'admin-tile';
    const v = document.createElement('b');
    v.textContent = value;
    const l = document.createElement('span');
    l.textContent = label;
    el.append(v, l);
    if (sub) {
      const s = document.createElement('small');
      s.textContent = sub;
      el.append(s);
    }
    return el;
  }

  function drawOverview() {
    tilesEl.replaceChildren();
    storageEl.replaceChildren();
    if (!overview) return;
    const { server, memory, disk, totals } = overview;

    tilesEl.append(
      tile('Version', server.version, `${server.node} · ${server.platform}`),
      tile('Uptime', uptime(server.uptime), `since ${formatDayTime(server.startedAt * 1000)}`),
      tile('Accounts', n(totals.users), `${n(totals.admins)} admin${totals.admins === 1 ? '' : 's'} · registration ${server.registration}`),
      tile('Cells', n(totals.cells), `${n(totals.routes)} routes`),
      tile('Phones', n(totals.devices), `${n(totals.photos)} photos · ${n(totals.workouts)} workouts`),
      // Resident set rather than heap: what the machine has given this process
      // is the number that matters when something is being killed for using it,
      // and the heap is a detail inside it.
      tile('Memory', size(memory.rss), `${size(memory.systemFree)} free of ${size(memory.systemTotal)}`),
      tile('Load', memory.load.map((v) => v.toFixed(2)).join(' '), `${memory.cpus} cores · 1, 5, 15 min`),
    );

    // `bytes` of null is "there is no size to report", which is not the same
    // number as zero — a backup that has never been taken has no size, and
    // printing 0 B for it reads as one that was taken and came out empty.
    const row = (name, bytes, note) => {
      const el = document.createElement('div');
      el.className = 'admin-store-row';
      const label = document.createElement('span');
      label.className = 'admin-store-name';
      label.textContent = name;
      const value = document.createElement('b');
      value.textContent = bytes === null ? '—' : size(bytes);
      const sub = document.createElement('small');
      sub.textContent = note ?? '';
      el.append(label, value, sub);
      return el;
    };

    // The database first and by itself: it is the only one of these whose loss
    // is not recoverable by waiting.
    storageEl.append(row('Database', disk.dbBytes, disk.db.map((f) => f.name).join(' + ')));
    for (const c of disk.caches) {
      storageEl.append(row(c.name, c.bytes, c.missing ? 'not created yet' : `${n(c.files)} files`));
    }
    if (disk.free) {
      const pct = Math.round((1 - disk.free.free / disk.free.total) * 100);
      storageEl.append(row('Disk free', disk.free.free, `${pct}% of ${size(disk.free.total)} used`));
    }
    if (overview.backup) {
      const b = overview.backup;
      storageEl.append(row(
        'Last backup',
        b.lastOk ? b.lastSize ?? 0 : null,
        b.lastOk ? `${when(b.lastOk)} · ${b.files?.length ?? 0} kept` : 'never taken',
      ));
    }
  }

  /** One account, as a row plus whatever it has been asked to unfold. */
  function drawUser(u) {
    const row = document.createElement('div');
    row.className = 'admin-user';
    if (u.username === me) row.classList.add('is-me');

    const who = document.createElement('span');
    who.className = 'admin-user-who';
    const name = document.createElement('b');
    name.textContent = u.username;
    who.append(name);
    if (u.admin) {
      const badge = document.createElement('i');
      badge.className = 'admin-badge';
      badge.textContent = 'admin';
      who.append(badge);
    }
    const sub = document.createElement('small');
    // Three clocks, and they answer three different questions. Signed in is
    // when a password was last typed; seen is when a live session last spoke,
    // which on a phone nobody signs out of is the one that keeps moving; data
    // is when anything last actually arrived, which is the one that stops
    // moving when something has broken.
    sub.textContent = [
      `joined ${when(u.createdAt)}`,
      `signed in ${when(u.lastLogin)}`,
      `seen ${when(u.lastSeen)}`,
      `data ${when(u.lastData)}`,
    ].join(' · ');
    who.append(sub);

    const stats = document.createElement('span');
    stats.className = 'admin-user-stats';
    for (const [label, value] of [
      ['cells', n(u.cells)],
      ['routes', n(u.routes)],
      ['photos', n(u.photos)],
      ['workouts', n(u.workouts)],
      ['phones', n(u.devices)],
      // Raw fixes their phones have pushed, which is a different question from
      // cells: a phone logging every minute in one room adds fixes and no
      // cells, and that difference is what "is the logger actually running"
      // looks like from here.
      ['fixes', n(u.fixes)],
      ['sources', n(u.sources)],
      ['sessions', n(u.sessions)],
    ]) {
      const cell = document.createElement('span');
      const v = document.createElement('b');
      v.textContent = value;
      const l = document.createElement('small');
      l.textContent = label;
      cell.append(v, l);
      stats.append(cell);
    }

    const acts = document.createElement('span');
    acts.className = 'admin-user-acts';
    const button = (text, cls, onClick, disabled = false) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `modal-btn ${cls}`.trim();
      b.textContent = text;
      b.disabled = busy || disabled;
      b.addEventListener('click', onClick);
      acts.append(b);
      return b;
    };

    // Opening your own account is not a thing, and the button says so by not
    // being there rather than by being refused.
    if (u.username !== me) {
      button(arming === u.id ? 'Really open?' : 'Open as', '', () => {
        if (arming !== u.id) {
          arming = u.id;
          resetting = null;
          render();
          return;
        }
        impersonate(u);
      });
    }
    button(resetting === u.id ? 'Cancel' : 'Reset password', '', () => {
      resetting = resetting === u.id ? null : u.id;
      arming = null;
      render();
    });
    button(u.admin ? 'Remove admin' : 'Make admin', u.admin ? 'danger' : '', () => grant(u, !u.admin),
      // Both refusals the server would give, said by a button that cannot be
      // pressed instead of by an error after it: nobody may demote themselves,
      // and the last admin may not be demoted at all.
      u.admin && (u.username === me || users.filter((x) => x.admin).length <= 1));

    row.append(who, stats, acts);
    usersEl.append(row);

    // What has actually stopped, when something has. Only drawn for a connector
    // that exists and is unhappy — a paragraph per account saying everything is
    // fine is a paragraph nobody reads, and the point of this line is to be
    // noticed among rows that do not have one.
    const troubles = [];
    if (u.ha?.error) troubles.push(`Home Assistant: ${u.ha.error}`);
    else if (u.ha && !u.ha.enabled) troubles.push('Home Assistant is paused');
    if (u.strava?.error) troubles.push(`Strava: ${u.strava.error}`);
    else if (u.strava && !u.strava.connected) troubles.push('Strava is set up but not signed in');
    else if (u.strava && !u.strava.enabled) troubles.push('Strava is paused');
    if (troubles.length) {
      const bad = document.createElement('div');
      bad.className = 'admin-user-bad';
      bad.textContent = troubles.join(' · ');
      usersEl.append(bad);
    }

    if (arming === u.id) {
      const warn = document.createElement('div');
      warn.className = 'ha-devices-note';
      warn.textContent = `Opens ${u.username}'s map as ${u.username}. This page reloads as them, `
        + 'and everything you do while you are there is done by them. A bar across the top says so '
        + 'until you leave, and the server logs both ends.';
      usersEl.append(warn);
    }

    if (resetting === u.id) {
      usersEl.append(resetForm(u));
    }
  }

  /**
   * The password field, unfolded under one row.
   *
   * A `<form>` rather than a field and a button, so Return works and so the
   * browser understands what it is looking at. `new-password` on the
   * autocomplete because that is exactly what it is — and because
   * `current-password` here would invite a password manager to fill in the
   * *admin's own* password and hand it to somebody else.
   */
  function resetForm(u) {
    const form = document.createElement('form');
    form.className = 'admin-reset';
    const label = document.createElement('label');
    label.textContent = `New password for ${u.username}`;
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = 'new-password';
    input.className = 'auth-input';
    label.append(input);
    const go = document.createElement('button');
    go.type = 'submit';
    go.className = 'modal-btn primary';
    go.textContent = 'Set password';
    const note = document.createElement('div');
    note.className = 'ha-devices-note';
    note.textContent = 'Every device signed in as this account is signed out. '
      + 'Tell them the new one out of band — this is the only time it is shown.';
    form.append(label, go, note);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      resetPassword(u, input.value);
    });
    setTimeout(() => input.focus(), 60);
    return form;
  }

  function render() {
    drawOverview();
    usersEl.replaceChildren();
    if (!users.length) {
      const empty = document.createElement('div');
      empty.className = 'ha-devices-note';
      empty.textContent = 'No accounts.';
      usersEl.append(empty);
      return;
    }
    for (const u of users) drawUser(u);
  }

  // --- Talking to the server ------------------------------------------------------

  async function load() {
    if (busy) return;
    busy = true;
    showErr(null);
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const [o, u] = await Promise.all([auth.adminOverview(), auth.adminUsers()]);
      overview = o;
      users = u.users ?? [];
      me = u.me ?? null;
      arming = null;
      resetting = null;
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      // After `busy` is cleared, and not before: every button in a row is built
      // with `disabled = busy`, and drawing the list while the fetch that
      // produced it is still notionally in flight leaves the whole pane inert
      // with nothing left to render it again. Sources shipped exactly that bug.
      busy = false;
      if (refreshBtn) refreshBtn.disabled = false;
      render();
    }
  }

  /** Run one change, then re-read everything. Nothing here is worth patching. */
  async function act(fn, said) {
    if (busy) return;
    busy = true;
    showErr(null);
    say('Working…');
    render();
    try {
      const out = await fn();
      say(said(out));
    } catch (e) {
      say('');
      showErr(e.message ?? String(e));
    } finally {
      busy = false;
      await load();
    }
  }

  const grant = (u, admin) => act(
    () => auth.adminGrant(u.id, admin),
    (out) => `${out.username} is ${out.admin ? 'now an admin' : 'no longer an admin'}.`,
  );

  const resetPassword = (u, password) => act(
    () => auth.adminSetPassword(u.id, password),
    (out) => `${out.username}'s password is set. ${out.sessionsEnded} session${out.sessionsEnded === 1 ? '' : 's'} ended.`,
  );

  /**
   * Become somebody else, and reload.
   *
   * The reload is the whole point of doing it this way. Every cache in this app
   * — the cells, the derived trips, the routes, the preferences, the offline
   * copy — belongs to whoever was signed in, and there is no honest way to swap
   * the account under a running map. `location.reload()` starts the page again
   * with the cookie the server just handed back, which is the same path a
   * perfectly ordinary sign-in takes.
   */
  async function impersonate(u) {
    if (busy) return;
    busy = true;
    say(`Opening ${u.username}…`);
    render();
    try {
      await auth.adminImpersonate(u.id);
      onLeave?.();
      location.reload();
    } catch (e) {
      busy = false;
      say('');
      showErr(e.message ?? String(e));
      render();
    }
  }

  refreshBtn?.addEventListener('click', () => {
    say('');
    load();
  });

  return {
    /**
     * Read it all again on every visit. This is a page somebody opens *because*
     * they think something has changed, and every number on it is a fact about
     * a process that has been running while they were not looking.
     */
    draw() {
      say('');
      load();
    },
    leave() {
      arming = null;
      resetting = null;
      say('');
    },
  };
}

/**
 * The chip that says you are wearing somebody else's account, and the way out.
 *
 * Separate from the pane above because it outlives it: the whole point is that
 * it is visible while an admin is doing something in a completely different
 * corner of the app, with Settings shut. It cannot be dismissed — the only thing
 * that makes it go away is leaving, which is what the button does.
 *
 * @param {object} opts
 * @param {() => string|null} opts.username the account being worn
 * @param {() => string|null} opts.asAdmin  the admin wearing it, or null
 */
export function mountAsUser({ username, asAdmin }) {
  const chip = document.getElementById('as-user-chip');
  const text = document.getElementById('as-user-text');
  const leave = document.getElementById('as-user-leave');
  if (!chip) return { draw() {} };

  let busy = false;

  function draw() {
    const admin = asAdmin?.();
    chip.hidden = !admin;
    if (!admin) return;
    text.textContent = `You are ${username?.() ?? 'somebody else'}, as ${admin}`;
  }

  leave?.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    leave.disabled = true;
    text.textContent = 'Going back…';
    try {
      await auth.adminReturn();
      // Same reload as the way in, for the same reason: everything in memory
      // belongs to the account being left.
      location.reload();
    } catch (e) {
      busy = false;
      leave.disabled = false;
      text.textContent = e.message ?? 'Could not go back.';
    }
  });

  return { draw };
}
