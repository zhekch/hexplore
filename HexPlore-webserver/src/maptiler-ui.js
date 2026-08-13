// The "MapTiler key" dialog: somewhere to put the second credential.
//
// A near-copy of src/mapbox-ui.js, and deliberately so — this is the same
// question asked about a different account, and answering it in a different
// shape would make two dialogs to learn instead of one. Read that file's header
// for why a credential gets a dialog rather than a row; every word of it holds.
//
// **What is different is what happens after Done.** A Mapbox token is used from
// the page, so storing it is enough. This key is used *by the server*, which
// reads it off the account — so a key that has been typed into a device and not
// yet pushed is a key the map cannot draw with. `onKey` is therefore not a
// notification, it is the thing that makes the key work, and main.js pushes the
// preferences on it rather than waiting for the next sync.
//
// The check is not decoration here either, and it has one more failure mode than
// Mapbox does: the free tier has a monthly ceiling, so a key that worked all
// month can stop. That comes back as the same 403 as a wrong key, which is why
// the sentence names all four possibilities instead of guessing — see `whyFrom`
// in src/maptiler.js.

import { checkMaptilerKey, keyComplaint, maptilerKey, setMaptilerKey } from './maptiler.js';
import { onBackdropClick } from './dismiss.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose] Cancel was pressed — nothing was changed
 * @param {(key: string) => void} [opts.onKey] a key was saved or cleared. The
 *   caller must push preferences: the server cannot fetch a tile until it can
 *   read this off the account.
 * @param {() => void} [opts.onUse] there is a working key and Done was pressed:
 *   put the trails overlay on the provider it pays for
 */
export function mountMaptiler({ onClose, onKey, onUse } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('maptiler-overlay');
  const input = $('maptiler-key');
  const doneBtn = $('maptiler-done');
  const note = $('maptiler-note');

  // Bumped on every dismissal, so an answer that arrives after the dialog was
  // closed is dropped — the same guard as the Mapbox dialog, and for the same
  // reason: pressing Done and then Escape would otherwise switch the overlay
  // over a second later, under somebody who had just left.
  let generation = 0;

  const say = (text, kind) => {
    note.textContent = text ?? '';
    note.hidden = !text;
    note.classList.toggle('ok', kind === 'ok');
    note.classList.toggle('bad', kind === 'bad');
  };

  function draw() {
    const held = maptilerKey();
    input.value = held;
    // Not re-checked on every opening: a network request for a question nobody
    // asked, whose answer was given when the key went in.
    say(held ? 'A key is saved to your account.' : '', held ? 'ok' : null);
  }

  async function done() {
    const typed = input.value.trim();
    const held = maptilerKey();

    // An empty box is how a key is taken off, and it is the only thing an empty
    // box can mean — so it must not be answered with a complaint about shape.
    if (!typed) {
      if (held) {
        setMaptilerKey('');
        onKey?.('');
      }
      return close();
    }

    if (typed === held) {
      close();
      onUse?.();
      return;
    }

    const complaint = keyComplaint(typed);
    if (complaint) return say(complaint, 'bad');

    const mine = generation;
    doneBtn.disabled = true;
    say('Asking MapTiler…');
    const { ok, why } = await checkMaptilerKey(typed);
    if (mine !== generation) return; // dismissed while we were asking
    doneBtn.disabled = false;
    // Left open on purpose: the box still holds what was typed, which is what
    // makes the complaint worth printing.
    if (!ok) return say(why ?? 'That key did not work.', 'bad');

    setMaptilerKey(typed);
    onKey?.(typed);
    close();
    onUse?.();
  }

  const open = () => {
    draw();
    overlay.hidden = false;
    if (!matchMedia('(hover: none)').matches) input.focus();
  };
  const close = () => {
    generation++;
    doneBtn.disabled = false;
    overlay.hidden = true;
  };

  doneBtn.addEventListener('click', done);
  $('maptiler-cancel').addEventListener('click', () => {
    close();
    onClose?.();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      done();
    }
  });
  input.addEventListener('input', () => say(''));

  $('maptiler-close').addEventListener('click', close);
  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
