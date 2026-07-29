// The "Home Assistant" dialog: point the server at your own instance, pick
// which devices to follow, and let it keep the map current on a schedule.
//
// Unlike the file importer, nothing is parsed here — the server does the
// fetching, because it's the thing that's still running when this tab isn't.
// The access token goes one way only: it's sent when you connect and never
// comes back, so an existing connection shows an empty token field rather than
// a fake one.
//
// Only fixes Home Assistant actually recorded become cells. The path between
// two fixes an hour apart is not filled in, guessed at or drawn — a gap in the
// data stays a gap on the map.

import { auth } from './auth.js';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const n = (v) => v.toLocaleString();

// "just now" / "14:20" / "3 Jun" — enough to tell at a glance whether the
// schedule is actually running.
function when(sec) {
  if (!sec) return 'never';
  const ms = sec * 1000;
  const ago = Date.now() - ms;
  if (ago < 90 * 1000) return 'just now';
  if (ago < 22 * 3600 * 1000) return timeFmt.format(new Date(ms));
  return dayFmt.format(new Date(ms));
}

/**
 * @param {object} opts
 * @param {() => Promise<void>} opts.onSynced called after a sync that may have added cells
 * @param {(link:object|null) => void} [opts.onLink] called whenever the link changes
 * @param {() => void} [opts.onClose] called when the dialog is dismissed with Back
 */
export function mountHomeAssistant({ onSynced, onLink, onClose }) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('ha-overlay');
  const scroller = document.querySelector('.ha-scroll');
  const urlEl = $('ha-url');
  const tokenEl = $('ha-token');
  const devicesBox = $('ha-devices');
  const devicesList = $('ha-devices-list');
  const devicesNote = $('ha-devices-note');
  const intervalRow = $('ha-interval-row');
  const intervalSel = $('ha-interval');
  const accuracyRow = $('ha-accuracy-row');
  const accuracySel = $('ha-accuracy');
  const enabledRow = $('ha-enabled-row');
  const enabledBox = $('ha-enabled');
  const statusEl = $('ha-status');
  const errEl = $('ha-error');
  const saveBtn = $('ha-save');
  const syncBtn = $('ha-sync');
  const backBtn = $('ha-back');
  const forgetBtn = $('ha-forget');
  const closeBtn = $('ha-close');

  let link = null; // the saved connection, or null
  let entities = null; // what the last probe found, or null if we haven't asked
  let picked = new Set();
  let busy = false;
  let confirmForget = false;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  // --- Rendering ----------------------------------------------------------------
  function renderDevices() {
    devicesList.replaceChildren();
    devicesBox.hidden = !entities;
    if (!entities) return;

    if (!entities.length) {
      devicesNote.textContent =
        'No device trackers with coordinates. The Home Assistant companion app on your phone is what usually provides them.';
      return;
    }

    for (const e of entities) {
      const row = document.createElement('label');
      row.className = 'ha-device' + (e.lat === null ? ' dim' : '');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = picked.has(e.id);
      box.addEventListener('change', () => {
        if (box.checked) picked.add(e.id);
        else picked.delete(e.id);
        renderButtons();
      });
      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = e.name;
      const sub = document.createElement('small');
      // Where it is right now, so you can tell two identically named phones
      // apart — or spot the one that never reports a position.
      sub.textContent =
        e.lat === null
          ? `${e.id} · no position`
          : `${e.id} · ${e.state || 'away'}${e.accuracy === null ? '' : ` · ±${n(e.accuracy)} m`}`;
      text.append(name, sub);
      row.append(box, text);
      devicesList.append(row);
    }
    devicesNote.textContent =
      'Pick one entry per device — a person and their phone report the same position twice.';
  }

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
    parts.push(line(`Last sync <b>${when(link.lastOk)}</b>`));
    if (link.lastOk) {
      parts.push(
        line(
          link.lastFixes
            ? `Took in <b>${n(link.lastFixes)}</b> ${link.lastFixes === 1 ? 'fix' : 'fixes'} across <b>${n(link.lastCells)}</b> ${link.lastCells === 1 ? 'cell' : 'cells'}`
            : 'Nothing new that time',
        ),
      );
    }
    if (link.totalFixes) parts.push(line(`<b>${n(link.totalFixes)}</b> fixes since connecting`));
    // The cursor is the honest answer to "how current is this?" — history is
    // read forward from it and never re-read.
    if (link.cursor) parts.push(line(`Caught up to <b>${when(link.cursor)}</b>`));
    statusEl.append(...parts);
  }

  function renderButtons() {
    const connected = !!link;
    const canSave = urlEl.value.trim() && (connected || tokenEl.value.trim()) && picked.size > 0;
    saveBtn.textContent = connected ? 'Save' : 'Connect';
    saveBtn.disabled = busy || (entities ? !canSave : !urlEl.value.trim() || (!connected && !tokenEl.value.trim()));
    // Before anything has been probed the primary button is the probe.
    if (!entities) saveBtn.textContent = connected ? 'Check connection' : 'Connect';
    syncBtn.hidden = !connected;
    syncBtn.disabled = busy;
    forgetBtn.hidden = !connected;
    forgetBtn.disabled = busy;
    if (!confirmForget) forgetBtn.textContent = 'Disconnect';
    intervalRow.hidden = !entities && !connected;
    accuracyRow.hidden = intervalRow.hidden;
    enabledRow.hidden = intervalRow.hidden || !connected;
  }

  // Fade the bottom edge only while something is still hidden below it.
  function renderScrollHint() {
    const over = scroller.scrollHeight - scroller.clientHeight;
    scroller.classList.toggle('more', over > 4);
    scroller.classList.toggle('at-end', scroller.scrollTop >= over - 4);
  }

  function render() {
    renderDevices();
    renderStatus();
    renderButtons();
    // The rows above have just changed height; measure after layout settles.
    requestAnimationFrame(renderScrollHint);
  }

  function adoptLink(next) {
    link = next;
    if (link) {
      urlEl.value = link.baseUrl;
      picked = new Set(link.entities);
      intervalSel.value = String(link.intervalMin);
      accuracySel.value = String(link.maxAccuracy);
      enabledBox.checked = link.enabled;
    }
    tokenEl.value = '';
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
      // renderButtons() puts the label back to whatever the state now calls for.
      busy = false;
      renderButtons();
    }
  }

  // Ask the server to try the address and token and report back what it can see.
  async function probe() {
    await run('Checking…', async () => {
      const out = await auth.probeHa(urlEl.value.trim(), tokenEl.value.trim());
      urlEl.value = out.baseUrl;
      entities = out.entities;
      // First time through, tick the phones that are reporting a position —
      // usually exactly what you wanted. A `person` mirrors the tracker it
      // follows, so only fall back to those when no tracker has a position;
      // ticking both would count every fix twice.
      if (!link && !picked.size) {
        const positioned = entities.filter((e) => e.lat !== null);
        const trackers = positioned.filter((e) => e.id.startsWith('device_tracker.'));
        for (const e of trackers.length ? trackers : positioned) picked.add(e.id);
      }
      render();
    });
  }

  async function save() {
    // The button doubles as "check this" until there's a device list to save.
    if (!entities) return probe();
    await run('Saving…', async () => {
      const patch = {
        baseUrl: urlEl.value.trim(),
        entities: [...picked],
        intervalMin: +intervalSel.value,
        maxAccuracy: +accuracySel.value,
        enabled: enabledBox.checked,
      };
      const token = tokenEl.value.trim();
      if (token) patch.token = token;
      adoptLink(await auth.saveHaLink(patch));
    });
  }

  async function syncNow() {
    if (busy) return;
    busy = true;
    showErr('');
    syncBtn.textContent = 'Syncing…';
    renderButtons();
    try {
      const out = await auth.syncHa();
      adoptLink(out.link);
      if (out.fixes) await onSynced?.();
    } catch (e) {
      showErr(e.message || 'Sync failed.');
      // The failure is recorded on the link too; show what it says now.
      try {
        adoptLink(await auth.getHaLink());
      } catch {
        /* keep what we had */
      }
    } finally {
      busy = false;
      syncBtn.textContent = 'Sync now';
      renderButtons();
    }
  }

  // Two-step, like removing a route: disconnecting throws away the token.
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
      await auth.deleteHaLink();
      entities = null;
      picked = new Set();
      urlEl.value = '';
      tokenEl.value = '';
      link = null;
      onLink?.(null);
      render();
    });
  }

  // --- Opening ------------------------------------------------------------------
  async function open() {
    showErr('');
    entities = null;
    overlay.hidden = false;
    render();
    try {
      adoptLink(await auth.getHaLink());
      // A saved connection lists its devices straight away, using the token the
      // server already holds — so the field can stay empty.
      if (link) await probe();
    } catch (e) {
      showErr(e.message || 'Could not load your connection.');
    }
  }

  // `silent` closes the flow outright (the ✕, Escape, a click outside);
  // otherwise this is Back, and the Sync picker takes the screen again.
  function close(silent = true) {
    overlay.hidden = true;
    confirmForget = false;
    tokenEl.value = '';
    showErr('');
    if (!silent) onClose?.();
  }

  // Refresh the menu's status line without opening anything.
  async function refresh() {
    try {
      link = await auth.getHaLink();
      onLink?.(link);
    } catch {
      /* not signed in yet, or offline */
    }
  }

  // Logging out: forget what this account's connection looked like, without
  // touching the connection itself.
  function clear() {
    close();
    link = null;
    entities = null;
    picked = new Set();
    urlEl.value = '';
    onLink?.(null);
  }

  // --- Wiring -------------------------------------------------------------------
  scroller.addEventListener('scroll', renderScrollHint, { passive: true });
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
  // Editing the address or token means the device list may be stale: fall back
  // to "check this first".
  for (const el of [urlEl, tokenEl]) {
    el.addEventListener('input', () => {
      if (entities) {
        entities = null;
        render();
      } else {
        renderButtons();
      }
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
  }

  return { open, close, refresh, clear };
}
