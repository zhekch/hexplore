// The "Strava" dialog: set up your own Strava app, sign in once, then let the
// server bring rides across on a schedule.
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
 * @param {() => void} [opts.onClose] called when dismissed with Back
 */
export function mountStrava({ onSynced, onLink, onClose }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('strava-overlay');
  const scroller = overlay.querySelector('.ha-scroll');
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
  const backBtn = $('strava-back');
  const closeBtn = $('strava-close');

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
    requestAnimationFrame(() => {
      const over = scroller.scrollHeight - scroller.clientHeight;
      scroller.classList.toggle('more', over > 4);
      scroller.classList.toggle('at-end', scroller.scrollTop >= over - 4);
    });
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
  async function open() {
    showErr('');
    overlay.hidden = false;
    render();
    try {
      const out = await auth.getStravaLink();
      if (out.callbackDomain) domainEl.textContent = out.callbackDomain;
      adopt(out.link);
    } catch (e) {
      showErr(e.message || 'Could not load your connection.');
    }
  }

  function close(silent = true) {
    overlay.hidden = true;
    confirmForget = false;
    secretEl.value = '';
    showErr('');
    if (!silent) onClose?.();
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
    close();
    link = null;
    idEl.value = '';
    onLink?.(null);
  }

  // Coming back from Strava: the URL carries the outcome. Open the dialog on it
  // so the result is seen where it was started, and tidy the address bar.
  async function handleReturn() {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('strava');
    if (result === null) return false;
    params.delete('strava');
    const rest = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (rest ? `?${rest}` : ''));
    await open();
    if (RESULTS[result]) showErr(RESULTS[result]);
    else if (result === 'ok') await syncNow(); // bring the first batch in right away
    return true;
  }

  // --- Wiring -------------------------------------------------------------------
  scroller.addEventListener('scroll', render, { passive: true });
  saveBtn.addEventListener('click', save);
  syncBtn.addEventListener('click', syncNow);
  forgetBtn.addEventListener('click', forget);
  backBtn.addEventListener('click', () => close(false));
  closeBtn.addEventListener('click', () => close());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !busy) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden && !busy) close();
  });
  for (const el of [idEl, secretEl]) {
    el.addEventListener('input', renderButtons);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
  }

  return { open, close: () => close(true), refresh, clear, handleReturn };
}
