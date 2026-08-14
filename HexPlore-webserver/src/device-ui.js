// The "Your devices" fold of Settings → Sync: which devices are reporting their own
// position, and whether they are actually doing it.
//
// It is the only connector with nothing to configure, and that is not an
// oversight. Home Assistant and Strava are set up here because here is where the
// server can be told an address and handed a token. A device cannot be set up
// from here at all — a schedule stored on this server could not wake it — so the
// settings live in the app on it, and what is left for this page is the question
// they raise: *is it working?*
//
// Which is worth saying somewhere. A logger you cannot see the output of is
// indistinguishable from one that stopped a fortnight ago — and the heading's
// own status line answers it without the fold being opened at all.

import { auth } from './auth.js';
import { formatTime } from './clock.js';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const n = (v) => v.toLocaleString();
// "1 fix" / "90 fixes" / "1 workout". A status line that says "1 workouts" is a
// small thing that reads as nobody having looked at it.
const plural = (count, word, suffix = 's') => `${n(count)} ${word}${count === 1 ? '' : suffix}`;

// The same three answers the Home Assistant fold gives, for the same reason:
// they are what tells you at a glance whether a schedule is running. Exported
// because the heading above this says it too, and because the admin panel dates
// every account by it — three spellings of "just now" on one server is two too
// many.
export function whenAgo(sec) {
  if (!sec) return 'never';
  const ms = sec * 1000;
  const ago = Date.now() - ms;
  if (ago < 90 * 1000) return 'just now';
  if (ago < 22 * 3600 * 1000) return formatTime(ms);
  return dayFmt.format(new Date(ms));
}

/**
 * @param {object} opts
 * @param {(devices:Array) => void} [opts.onDevices] called whenever the list changes
 */
export function mountDevices({ onDevices } = {}) {
  const $ = (id) => document.getElementById(id);
  const listEl = $('device-list');
  const helpEl = $('device-help');
  const statusEl = $('device-status');
  const errEl = $('device-error');
  const refreshBtn = $('device-refresh');

  let devices = [];
  let busy = false;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  function render() {
    listEl.replaceChildren();
    // The setup note is only worth reading when there is nothing to look at;
    // once a device is listed, the list is the answer.
    helpEl.hidden = devices.length > 0;
    statusEl.hidden = devices.length === 0;

    for (const d of devices) {
      const row = document.createElement('div');
      row.className = 'ha-device';

      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = d.name || 'A device';
      const detail = document.createElement('small');
      const bits = [`last spoke ${whenAgo(d.lastSeen)}`];
      if (d.totalFixes) bits.push(plural(d.totalFixes, 'fix', 'es'));
      if (d.totalWorkouts) bits.push(plural(d.totalWorkouts, 'workout'));
      if (d.platform) bits.push(d.platform);
      detail.textContent = bits.join(' · ');
      text.append(name, detail);

      // Forgetting a device drops this row and nothing else. The cells it sent
      // came from real fixes and are no less true for the device being gone —
      // the same rule disconnecting Home Assistant follows.
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.className = 'modal-btn danger';
      forget.textContent = 'Forget';
      forget.addEventListener('click', () => forgetDevice(d));

      row.append(text, forget);
      listEl.append(row);
    }

    if (devices.length) {
      const newest = devices.reduce((t, d) => Math.max(t, d.lastSeen || 0), 0);
      statusEl.textContent = devices.length === 1
        ? `Last updated at ${whenAgo(newest)}.`
        : `${devices.length} devices · last updated at ${whenAgo(newest)}.`;
    }
    onDevices?.(devices);
  }

  async function load() {
    if (busy) return;
    busy = true;
    refreshBtn.disabled = true;
    showErr(null);
    try {
      devices = await auth.getDevices();
      render();
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      busy = false;
      refreshBtn.disabled = false;
    }
  }

  async function forgetDevice(device) {
    try {
      devices = await auth.forgetDevice(device.id);
      render();
    } catch (e) {
      showErr(e.message ?? String(e));
    }
  }

  refreshBtn.addEventListener('click', load);

  // Logging out: forget what this account's devices looked like, without
  // touching the devices themselves — they belong to whoever signs in next only
  // if that is the same person, and the server decides that, not this page.
  function clear() {
    devices = [];
    render();
  }

  // No `reset`: there is nothing here to fold away. Unlike the other two this
  // holds no secret and arms no button — the only destructive thing in it,
  // Forget, is per row and asks nothing, because it drops a status row and
  // leaves every cell the device ever sent.
  return { draw: load, refresh: load, clear, devices: () => devices };
}
