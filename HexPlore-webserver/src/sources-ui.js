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
import { sourceLabel, IMPORT_SOURCES } from './locations.js';
import { whenAgo } from './device-ui.js';
import { onBackdropClick } from './dismiss.js';

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
  // Which row is showing its relabel control. Only one at a time: two open
  // dropdowns in a list of eight is a form, not a row.
  let naming = null;
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

      const relabel = document.createElement('button');
      relabel.type = 'button';
      relabel.className = 'modal-btn';
      relabel.textContent = 'Relabel';
      relabel.disabled = busy;
      relabel.addEventListener('click', () => {
        naming = naming === s.key ? null : s.key;
        arming = null;
        render();
      });

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

      row.append(text, relabel, remove);
      listEl.append(row);

      if (naming === s.key) {
        const pick = document.createElement('div');
        pick.className = 'source-relabel';
        const select = document.createElement('select');
        // `unknown` is offered as a target nowhere: it is what the map says when
        // it does not know, and choosing it on purpose is not a thing anyone
        // means. Everything the importer will file a file under is fair.
        for (const key of IMPORT_SOURCES) {
          if (key === s.key) continue;
          const opt = document.createElement('option');
          opt.value = key;
          opt.textContent = sourceLabel(key);
          select.append(opt);
        }
        select.value = s.key === 'unknown' ? 'manual' : select.options[0]?.value ?? 'manual';
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'modal-btn primary';
        apply.textContent = 'Apply';
        apply.disabled = busy;
        apply.addEventListener('click', () => rename(s, select.value));
        const note = document.createElement('div');
        note.className = 'ha-devices-note';
        note.textContent = s.key === 'unknown'
          ? 'Unknown is what the map says about cells that predate it knowing where anything came from. A later import would take their place; whatever is left was put there by hand.'
          : `Files ${plural(s.cells, 'cell')} under the new name. Nothing is added or removed — a cell that already has a row under it keeps one row, not two.`;
        pick.append(select, apply);
        listEl.append(pick, note);
      }

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
      naming = null;
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      // After `busy` is cleared, and not before. Every control in a row is
      // built with `disabled = busy`, so drawing the list while the fetch that
      // produced it is still notionally in flight makes every button in the
      // dialog inert — and nothing renders again to undo it. That shipped once:
      // the rows looked right and the buttons did nothing at all.
      busy = false;
      render();
    }
  }

  async function rename(source, to) {
    busy = true;
    render();
    try {
      await auth.renameSource(source.key, to);
      naming = null;
      sources = await auth.getSources();
      render();
      // Nothing moved on or off the map, but every cell's *colour* may have —
      // "Colour by type" paints each one by the source it mostly came from.
      await onChanged?.();
    } catch (e) {
      showErr(e.message ?? String(e));
    } finally {
      busy = false;
      render();
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
    naming = null;
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
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close, refresh: load };
}
