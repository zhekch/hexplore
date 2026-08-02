// The "Sources" dialog: everything that has put something on the map, and how
// to take one back off.
//
// Every other way of removing something works a cell or a route at a time,
// which is exactly right when you disagree with a *place* and no use at all when
// you disagree with a *method*. Re-importing an export you have stopped trusting
// refreshes its rows and never drops the ones it has quietly stopped claiming,
// so a source that had once put something on the map could not be taken back
// off it.
//
// The distinction the dialog has to make plain is that this is not the same
// action as clearing a cell. Clearing says *I was never here*, whoever said
// otherwise, and drops every source's claim. This says *stop trusting this way
// of finding out* — so a cell another source also vouches for keeps that claim
// and stays exactly where it is.

import { auth } from './auth.js';
import { sourceLabel } from './locations.js';
import { whenAgo } from './device-ui.js';

const n = (v) => v.toLocaleString();
const plural = (count, word, suffix = 's') => `${n(count)} ${word}${count === 1 ? '' : suffix}`;

// Sources whose rows are re-derivable by asking again, and which therefore lose
// nothing permanent when they are removed. Everything else — a file you imported,
// a cell you marked by hand — is gone for good, and the button says so.
const REPLACEABLE = new Set(['apple-photos', 'apple-health', 'home-assistant', 'strava', 'komoot']);

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]   called when the dialog is dismissed with Back
 * @param {() => Promise<void>} opts.onChanged  the map has to be re-read after a removal
 */
export function mountSources({ onClose, onChanged } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('sources-overlay');
  const listEl = $('sources-list');
  const errEl = $('sources-error');

  let sources = [];
  let busy = false;
  // Which row is one press from being removed. Two presses rather than a
  // confirmation dialog, for the same reason the Home Assistant one does it that
  // way: a modal on top of a modal reads as an error message.
  let arming = null;

  const showErr = (m) => {
    errEl.textContent = m ?? '';
    errEl.hidden = !m;
  };

  function render() {
    listEl.replaceChildren();
    if (!sources.length) {
      const empty = document.createElement('div');
      empty.className = 'ha-devices-note';
      empty.textContent = 'Nothing on the map yet.';
      listEl.append(empty);
      return;
    }

    for (const s of sources) {
      const row = document.createElement('div');
      row.className = 'ha-device';

      const text = document.createElement('span');
      const name = document.createElement('b');
      name.textContent = sourceLabel(s.key);
      const detail = document.createElement('small');
      const bits = [plural(s.cells, 'cell')];
      if (s.routes) bits.push(plural(s.routes, 'route'));
      if (s.lastAt) bits.push(`newest ${whenAgo(s.lastAt)}`);
      detail.textContent = bits.join(' · ');
      text.append(name, detail);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'modal-btn danger';
      remove.textContent = arming === s.key ? 'Really remove?' : 'Remove';
      remove.disabled = busy;
      remove.addEventListener('click', () => {
        if (arming !== s.key) {
          arming = s.key;
          render();
          return;
        }
        drop(s);
      });

      row.append(text, remove);
      listEl.append(row);

      if (arming === s.key) {
        const warn = document.createElement('div');
        warn.className = 'ha-devices-note';
        warn.textContent = REPLACEABLE.has(s.key)
          ? `Takes ${plural(s.cells, 'cell')} off the map. This one can be read again — sync it and it comes back.`
          : `Takes ${plural(s.cells, 'cell')} off the map for good. Nothing here can put them back; only the file or the marks they came from can.`;
        listEl.append(warn);
      }
    }
  }

  async function load() {
    if (busy) return;
    busy = true;
    showErr(null);
    try {
      sources = await auth.getSources();
      arming = null;
      render();
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      busy = false;
    }
  }

  async function drop(source) {
    busy = true;
    render();
    try {
      await auth.deleteSource(source.key);
      arming = null;
      sources = await auth.getSources();
      render();
      // The map is now wrong by however many cells just went, and nothing else
      // is going to notice on its own.
      await onChanged?.();
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      busy = false;
      render();
    }
  }

  const close = () => {
    overlay.hidden = true;
    arming = null;
  };

  const open = () => {
    overlay.hidden = false;
    load();
  };

  $('sources-back').addEventListener('click', () => {
    close();
    onClose?.();
  });
  $('sources-done').addEventListener('click', close);
  $('sources-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close, refresh: load };
}
