// The Strava fold of Settings → Sync: set up your own Strava app, sign in once,
// then let the server bring rides across on a schedule.
//
// It was a dialog until the three connectors became headings that open
// downwards; see src/sync-ui.js for why. Every control kept its id.
//
// The client secret and the tokens live on the server and are never sent back
// here — this dialog only ever posts them outward and reads status. Signing in
// is a full-page trip to Strava and back (`/api/strava/callback`), because
// that's the only way an OAuth redirect can work.

import { auth } from './auth.js';
import { formatTime } from './clock.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const n = (v) => v.toLocaleString();

function when(sec) {
  if (!sec) return 'never';
  const ms = sec * 1000;
  const ago = Date.now() - ms;
  if (ago < 90 * 1000) return 'just now';
  if (ago < 22 * 3600 * 1000) return formatTime(ms);
  return dayFmt.format(new Date(ms));
}

// What came back on ?strava=… after the round trip to Strava and back.
const RESULTS = {
  ok: null,
  denied: 'You turned Strava down — nothing was connected.',
  scope: 'Strava needs permission to read your activities. Try again and leave that box ticked.',
  badstate: 'That sign-in did not match this session. Start it again from here.',
  nocode: 'Strava sent the browser back without a code.',
  failed: 'Strava would not complete the sign-in — check the client secret.',
};

/**
 * @param {object} opts
 * @param {() => Promise<void>} opts.onSynced called after a sync that added anything
 * @param {(link:object|null) => void} [opts.onLink]
 * @param {() => Promise<void>} [opts.onReveal] show this fold — the OAuth round
 *   trip comes back to a page that has no idea it was in the middle of one
 */
export function mountStrava({ onSynced, onLink, onReveal }) {
  const $ = (id) => document.getElementById(id);
  const setup = $('strava-setup');
  const domainEl = $('strava-domain');
  const idEl = $('strava-id');
  const secretEl = $('strava-secret');
  const intervalRow = $('strava-interval-row');
  const intervalSel = $('strava-interval');
  const routesRow = $('strava-routes-row');
  const routesBox = $('strava-routes');
  const enabledRow = $('strava-enabled-row');
  const enabledBox = $('strava-enabled');
  const statusEl = $('strava-status');
  const errEl = $('strava-error');
  const saveBtn = $('strava-save');
  const syncBtn = $('strava-sync');
  const forgetBtn = $('strava-forget');

  let link = null;
  let busy = false;
  let confirmForget = false;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  // --- Rendering ----------------------------------------------------------------
  function renderStatus() {
    if (!link) {
      statusEl.hidden = true;
      return;
    }
    statusEl.hidden = false;
    statusEl.replaceChildren();
    const line = (html) => {
      const el = document.createElement('div');
      el.innerHTML = html;
      return el;
    };
    const parts = [];
    if (link.lastError) {
      const bad = document.createElement('div');
      bad.className = 'bad';
      bad.textContent = link.lastError;
      parts.push(bad);
    }
    if (!link.connected) {
      parts.push(line('Saved, but not signed in to Strava yet.'));
    } else {
      // The athlete name comes back from Strava, so it is remote text, not ours
      // — it goes in as text rather than through the innerHTML helper.
      if (link.athlete) {
        const who = document.createElement('div');
        who.append('Signed in as ');
        const name = document.createElement('b');
        name.textContent = link.athlete;
        who.append(name);
        parts.push(who);
      }
      parts.push(line(`Last sync <b>${when(link.lastOk)}</b>`));
      if (link.lastOk) {
        parts.push(
          line(
            link.lastCount
              ? `Took in <b>${n(link.lastCount)}</b> ${link.lastCount === 1 ? 'activity' : 'activities'}`
              : 'Nothing new that time',
          ),
        );
      }
      if (link.totalCount) parts.push(line(`<b>${n(link.totalCount)}</b> activities since connecting`));
      if (link.cursor) parts.push(line(`Caught up to <b>${when(link.cursor)}</b>`));
    }
    statusEl.append(...parts);
  }

  function renderButtons() {
    const saved = !!link;
    const connected = !!link?.connected;
    // Before it's connected the primary action is the sign-in itself; the
    // fields above it are just what that needs.
    saveBtn.textContent = connected ? 'Save' : saved ? 'Connect to Strava' : 'Save app details';
    saveBtn.disabled = busy || !idEl.value.trim() || (!saved && !secretEl.value.trim());
    syncBtn.hidden = !connected;
    syncBtn.disabled = busy;
    forgetBtn.hidden = !saved;
    forgetBtn.disabled = busy;
    if (!confirmForget) forgetBtn.textContent = 'Disconnect';
    setup.hidden = connected;
    intervalRow.hidden = !saved;
    routesRow.hidden = !saved;
    enabledRow.hidden = !connected;
  }

  function render() {
    renderStatus();
    renderButtons();
  }

  function adopt(next) {
    link = next;
    if (link) {
      idEl.value = link.clientId;
      intervalSel.value = String(link.intervalMin);
      routesBox.checked = link.saveRoutes;
      enabledBox.checked = link.enabled;
    }
    secretEl.value = '';
    confirmForget = false;
    onLink?.(link);
    render();
  }

  // --- Actions ------------------------------------------------------------------
  async function run(label, fn) {
    if (busy) return null;
    busy = true;
    showErr('');
    saveBtn.textContent = label;
    renderButtons();
    try {
      return await fn();
    } catch (e) {
      showErr(e.message || 'Something went wrong.');
      return null;
    } finally {
      busy = false;
      renderButtons();
    }
  }

  async function save() {
    // Already signed in: this is just settings.
    const patch = {
      clientId: idEl.value.trim(),
      intervalMin: +intervalSel.value,
      saveRoutes: routesBox.checked,
      enabled: enabledBox.checked,
    };
    const secret = secretEl.value.trim();
    if (secret) patch.clientSecret = secret;

    const saved = await run('Saving…', () => auth.saveStravaLink(patch));
    if (!saved) return;
    adopt(saved);
    // Not signed in yet? Go and do that now — it's the only thing left.
    if (!saved.connected) await connect();
  }

  async function connect() {
    const out = await run('Opening Strava…', () => auth.authorizeStrava());
    if (!out?.url) return;
    // A full-page navigation, not a popup: popups get blocked, and the callback
    // has to land on this origin anyway.
    window.location.assign(out.url);
  }

  async function syncNow() {
    if (busy) return;
    busy = true;
    showErr('');
    syncBtn.textContent = 'Syncing…';
    renderButtons();
    try {
      const out = await auth.syncStrava();
      adopt(out.link);
      if (out.activities) await onSynced?.();
    } catch (e) {
      showErr(e.message || 'Sync failed.');
      try {
        adopt(await auth.getStravaLink().then((d) => d.link));
      } catch {
        /* keep what we had */
      }
    } finally {
      busy = false;
      syncBtn.textContent = 'Sync now';
      renderButtons();
    }
  }

  async function forget() {
    if (busy) return;
    if (!confirmForget) {
      confirmForget = true;
      forgetBtn.textContent = 'Sure?';
      setTimeout(() => {
        if (!confirmForget) return;
        confirmForget = false;
        forgetBtn.textContent = 'Disconnect';
      }, 4000);
      return;
    }
    confirmForget = false;
    await run('Disconnecting…', async () => {
      await auth.deleteStravaLink();
      link = null;
      idEl.value = '';
      secretEl.value = '';
      onLink?.(null);
      render();
    });
  }

  // --- Opening ------------------------------------------------------------------
  // Called by the fold when it unfolds. Awaited, so `handleReturn` below can put
  // its message on top of a form that has finished loading.
  async function draw() {
    showErr('');
    render();
    try {
      const out = await auth.getStravaLink();
      if (out.callbackDomain) domainEl.textContent = out.callbackDomain;
      adopt(out.link);
    } catch (e) {
      showErr(e.message || 'Could not load your connection.');
    }
  }

  // Folding away. The secret and the armed Disconnect are the two things that
  // must not survive it.
  function reset() {
    confirmForget = false;
    secretEl.value = '';
    showErr('');
  }

  async function refresh() {
    try {
      link = (await auth.getStravaLink()).link;
      onLink?.(link);
    } catch {
      /* not signed in yet, or offline */
    }
  }

  function clear() {
    reset();
    link = null;
    idEl.value = '';
    onLink?.(null);
  }

  // Coming back from Strava: the URL carries the outcome. Unfold this section on
  // it so the result is seen where it was started, and tidy the address bar.
  async function handleReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('strava');
    if (result === null) return false;
    params.delete('strava');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    // Awaited: it opens Settings on the Sync tab and unfolds this one, which
    // loads the connection. A message written before that lands underneath it.
    await onReveal?.();
    if (RESULTS[result]) showErr(RESULTS[result]);
    else if (result === 'ok') await syncNow(); // bring the first batch in right away
    return true;
  }

  // --- Wiring -------------------------------------------------------------------
  saveBtn.addEventListener('click', save);
  syncBtn.addEventListener('click', syncNow);
  forgetBtn.addEventListener('click', forget);
  for (const el of [idEl, secretEl]) {
    el.addEventListener('input', renderButtons);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
  }

  return { draw, reset, refresh, clear, handleReturn };
}
