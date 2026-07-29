// The "Backups" dialog: when the server copies data.db, how many copies it
// keeps, and what it has done so far.
//
// Everything the map knows is in one file, and until now the only way that file
// existed twice was if you thought to copy it. This is the other end of the
// importer — the one door that goes outwards.
//
// The schedule is a cron expression either way. The picker ("every day at
// 04:00") writes one and the text field takes one typed, but there is only ever
// one string, shown under the field in plain English by the same parser the
// server schedules from (src/cron.js). Nothing is stored that the two ends
// could read differently.

import { auth } from './auth.js';
import { describeCron, isValidCron, nextRun } from './cron.js';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Same shape as the Home Assistant dialog's clock, for the same reason: what
// you want to know is whether it is actually running, not the exact second.
function when(sec) {
  if (!sec) return 'never';
  const ms = sec * 1000;
  const ago = Date.now() - ms;
  if (ago < 90 * 1000) return 'just now';
  if (ago < 22 * 3600 * 1000) return timeFmt.format(new Date(ms));
  return dayFmt.format(new Date(ms));
}

function soon(sec) {
  if (!sec) return 'not scheduled';
  const ms = sec * 1000;
  const inMs = ms - Date.now();
  if (inMs < 60 * 1000) return 'in a moment';
  if (inMs < 22 * 3600 * 1000) return `at ${timeFmt.format(new Date(ms))}`;
  return dayTimeFmt.format(new Date(ms));
}

// Sizes are in the megabytes-to-gigabytes range and only ever glanced at.
function size(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const two = (n) => String(n).padStart(2, '0');

// --- The picker ⇄ the expression ---------------------------------------------
// Presets are shorthand for expressions, not a second way of storing a
// schedule. These two functions are inverses, so a schedule someone typed by
// hand still opens the picker on the right preset if it happens to be one.

function composeCron({ preset, time, weekday, dom }) {
  const [h, m] = (time || '04:00').split(':').map((v) => Number(v) || 0);
  switch (preset) {
    case 'hourly':
      return `${m} * * * *`;
    case 'six':
      return `${m} */6 * * *`;
    case 'daily':
      return `${m} ${h} * * *`;
    case 'weekly':
      return `${m} ${h} * * ${weekday}`;
    case 'monthly':
      return `${m} ${h} ${dom} * *`;
    default:
      return '';
  }
}

function decomposeCron(expr) {
  const parts = String(expr ?? '').trim().split(/\s+/);
  const fallback = { preset: 'custom', time: '04:00', weekday: '1', dom: '1' };
  if (parts.length !== 5) return fallback;
  const [mi, h, dom, mo, dow] = parts;
  const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
  const m = num(mi);
  if (m === null || mo !== '*') return fallback;
  const time = (hh) => `${two(hh)}:${two(m)}`;

  if (h === '*' && dom === '*' && dow === '*') return { ...fallback, preset: 'hourly', time: time(0) };
  if (h === '*/6' && dom === '*' && dow === '*') return { ...fallback, preset: 'six', time: time(0) };
  const hour = num(h);
  if (hour === null) return fallback;
  if (dom === '*' && dow === '*') return { ...fallback, preset: 'daily', time: time(hour) };
  if (dom === '*' && num(dow) !== null) return { ...fallback, preset: 'weekly', time: time(hour), weekday: String(num(dow) % 7) };
  if (dow === '*' && num(dom) !== null) return { ...fallback, preset: 'monthly', time: time(hour), dom: dom };
  return fallback;
}

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]  called when the dialog is dismissed with Back
 * @param {(status:object|null) => void} [opts.onStatus] called whenever the settings change
 */
export function mountBackup({ onClose, onStatus } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('backup-overlay');
  const enabledBox = $('backup-enabled');
  const presetSel = $('backup-preset');
  const timeRow = $('backup-time-row');
  const timeEl = $('backup-time');
  const weekdayRow = $('backup-weekday-row');
  const weekdaySel = $('backup-weekday');
  const domRow = $('backup-dom-row');
  const domSel = $('backup-dom');
  const cronRow = $('backup-cron-row');
  const cronEl = $('backup-cron');
  const whenEl = $('backup-when');
  const keepSel = $('backup-keep');
  const statusEl = $('backup-status');
  const filesEl = $('backup-files');
  const errEl = $('backup-error');
  const noteEl = $('backup-note');
  const saveBtn = $('backup-save');
  const nowBtn = $('backup-now');
  const backBtn = $('backup-back');
  const closeBtn = $('backup-close');

  let status = null;
  let busy = false;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  // Same shape as the Home Assistant dialog's status block, and the same
  // classes, so the two read as one thing in two places.
  const line = (html) => {
    const p = document.createElement('div');
    p.innerHTML = html;
    return p;
  };

  // The one place the dialog's controls turn into a schedule. Everything that
  // could change it calls this, so the sentence under the field can never
  // disagree with what Save would send.
  function currentCron() {
    const preset = presetSel.value;
    if (preset === 'custom') return cronEl.value.trim();
    return composeCron({
      preset,
      time: timeEl.value,
      weekday: weekdaySel.value,
      dom: domSel.value,
    });
  }

  function renderSchedule() {
    const preset = presetSel.value;
    // "Every hour" and "every 6 hours" have no time of day to pick, and a time
    // field that changes nothing is worse than no field.
    timeRow.hidden = preset === 'custom' || preset === 'hourly' || preset === 'six';
    weekdayRow.hidden = preset !== 'weekly';
    domRow.hidden = preset !== 'monthly';
    cronRow.hidden = preset !== 'custom';

    const expr = currentCron();
    const ok = isValidCron(expr);
    whenEl.classList.toggle('backup-when-bad', !ok);
    if (!expr) {
      whenEl.textContent = 'Type a schedule, five fields: minute hour day month weekday.';
      return;
    }
    if (!ok) {
      whenEl.textContent = "That isn't a schedule this can read.";
      return;
    }
    const at = nextRun(expr, new Date());
    // The description is what it *means*; the next firing is proof it means it.
    whenEl.textContent = enabledBox.checked
      ? `${describeCron(expr)} — next ${soon(at ? Math.floor(at.getTime() / 1000) : 0)}`
      : `${describeCron(expr)} — switched off`;
  }

  function renderStatus() {
    statusEl.replaceChildren();
    filesEl.replaceChildren();
    if (!status) {
      statusEl.hidden = true;
      filesEl.hidden = true;
      return;
    }
    statusEl.hidden = false;

    if (status.lastError) {
      const bad = document.createElement('div');
      bad.className = 'bad';
      bad.textContent = status.lastError;
      statusEl.append(bad);
    }
    statusEl.append(line(`Last backup <b>${when(status.lastOk)}</b>${status.lastSize ? ` · ${size(status.lastSize)}` : ''}`));
    if (status.enabled) statusEl.append(line(`Next <b>${soon(status.nextRun)}</b>`));
    // The skip count is the feature explaining itself: a week of unchanged days
    // is a week of ticks that deliberately wrote nothing.
    if (status.runs || status.skips) {
      statusEl.append(line(`${status.runs} kept · ${status.skips} skipped as unchanged`));
    }
    const where = document.createElement('div');
    where.className = 'backup-where';
    where.textContent = status.dir;
    statusEl.append(where);

    if (!status.files.length) return;
    filesEl.hidden = false;
    const head = document.createElement('div');
    head.className = 'ha-devices-head';
    head.textContent = status.files.length === 1 ? '1 backup' : `${status.files.length} backups`;
    filesEl.append(head);
    for (const f of status.files) {
      const row = document.createElement('div');
      row.className = 'backup-file';
      const name = document.createElement('span');
      name.className = 'backup-file-name';
      name.textContent = dayTimeFmt.format(new Date(f.at * 1000));
      const meta = document.createElement('span');
      meta.className = 'backup-file-size';
      meta.textContent = size(f.size);
      // A copy that never leaves the machine it's a copy of is not a backup, so
      // every one of these is a link you can pull off it.
      const get = document.createElement('a');
      get.className = 'backup-file-get';
      get.href = auth.backupUrl(f.name);
      get.setAttribute('download', f.name);
      get.textContent = 'Download';
      row.append(name, meta, get);
      filesEl.append(row);
    }
  }

  function fill(next) {
    status = next;
    if (status) {
      enabledBox.checked = status.enabled;
      keepSel.value = String(status.keep);
      const parts = decomposeCron(status.cron);
      presetSel.value = parts.preset;
      timeEl.value = parts.time;
      weekdaySel.value = parts.weekday;
      domSel.value = parts.dom;
      cronEl.value = status.cron;
    }
    renderSchedule();
    renderStatus();
    onStatus?.(status);
  }

  async function load() {
    showErr('');
    try {
      fill(await auth.getBackup());
    } catch (e) {
      // A second account on the same instance gets 403 here, which is not an
      // error so much as an answer: backups belong to whoever made the map.
      status = null;
      renderStatus();
      showErr(String(e.message ?? e));
    }
  }

  function setBusy(on, label) {
    busy = on;
    saveBtn.disabled = on;
    nowBtn.disabled = on;
    nowBtn.textContent = on && label ? label : 'Back up now';
  }

  async function save() {
    if (busy) return;
    const expr = currentCron();
    if (!isValidCron(expr)) {
      showErr("That isn't a schedule this can read — five fields: minute hour day month weekday.");
      return;
    }
    showErr('');
    setBusy(true);
    try {
      fill(await auth.saveBackup({ enabled: enabledBox.checked, cron: expr, keep: Number(keepSel.value) }));
      close();
    } catch (e) {
      showErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    if (busy) return;
    showErr('');
    setBusy(true, 'Backing up…');
    try {
      const out = await auth.runBackup();
      if (out.backup) fill(out.backup);
      // "Nothing changed" is a result, not a failure — and it's the behaviour
      // worth seeing, so it's said plainly rather than looking like a no-op.
      const said = out.status === 'saved'
        ? `Backed up — ${size(out.size)}${out.pruned ? `, ${out.pruned} older one${out.pruned === 1 ? '' : 's'} removed` : ''}.`
        : out.status === 'error'
          ? out.error
          : `Nothing to back up — ${out.reason ?? 'the map has not changed'}.`;
      noteEl.textContent = said;
      noteEl.hidden = false;
    } catch (e) {
      showErr(String(e.message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const open = async () => {
    overlay.hidden = false;
    noteEl.hidden = true;
    await load();
  };
  const close = () => {
    overlay.hidden = true;
  };

  for (const el of [presetSel, timeEl, weekdaySel, domSel, enabledBox]) {
    el.addEventListener('change', renderSchedule);
  }
  cronEl.addEventListener('input', renderSchedule);
  saveBtn.addEventListener('click', save);
  nowBtn.addEventListener('click', runNow);
  backBtn.addEventListener('click', () => {
    close();
    onClose?.();
  });
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return {
    open,
    close,
    /** Read the settings without opening anything — for the row in Sync. */
    refresh: load,
    /** One line for that row: what's scheduled, or that nothing is. */
    summary() {
      if (!status) return 'Not set up';
      if (!status.enabled) return 'Switched off';
      const kept = status.files?.length ?? 0;
      return `${describeCron(status.cron)} · ${kept} kept`;
    },
  };
}
