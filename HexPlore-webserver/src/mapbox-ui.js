// The "3D basemap" dialog: somewhere to put a Mapbox token.
//
// It is the only credential this app asks anyone for that is not its own, so it
// gets a dialog rather than a row: there is a paragraph's worth of *why am I
// being asked this* to answer, and a row in a list is not the place to answer
// it.
//
// **Only the token.** The light preset used to be here too, and it is not any
// more: it moved to the layers menu, under the basemap picker, where it is
// beside the map it changes and one press away rather than four. A control in
// two places is a control you have to keep in step, and the one you reach for
// is always the nearer one.
//
// **Done is the only button that commits.** There used to be a Save beside the
// field and a Done underneath it, which is two buttons for one intention and
// nothing to say which of them was the real one — and a Remove that did what an
// empty field already means. Now there are two: Done checks the token and either
// closes onto the 3D map or stays open saying what was wrong, and Cancel leaves
// with nothing changed. Emptying the box and pressing Done is how a token is
// taken off.
//
// The check is not decoration. A Mapbox token can be wrong in four ways that all
// look identical from the map — mistyped, expired, scoped without `styles:read`,
// or URL-restricted to somebody else's domain — and each of them shows up as a
// basemap that quietly falls back to Dark. Asking Mapbox before the dialog is
// allowed to close is the difference between "that token is restricted to other
// URLs" and half an hour of wondering why the button does nothing.

import { checkMapboxToken, mapboxToken, setMapboxToken, tokenComplaint } from './mapbox.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose]  Cancel was pressed — nothing was changed
 * @param {(token: string) => void} [opts.onToken] a token was saved or cleared
 * @param {() => void} [opts.onUse] there is a working token and Done was pressed:
 *   put the map on the basemap it pays for
 */
export function mountMapbox({ onClose, onToken, onUse } = {}) {
  const $ = (id) => document.getElementById(id);
  const overlay = $('mapbox-overlay');
  const input = $('mapbox-token');
  const doneBtn = $('mapbox-done');
  const note = $('mapbox-note');

  // Bumped on every dismissal, so an answer from Mapbox that arrives after the
  // dialog was closed is dropped. Without it, pressing Done and then Escape puts
  // the map on 3D a second later, under somebody who had just left.
  let generation = 0;

  /** Say something under the field, in one of three registers. */
  const say = (text, kind) => {
    note.textContent = text ?? '';
    note.hidden = !text;
    note.classList.toggle('ok', kind === 'ok');
    note.classList.toggle('bad', kind === 'bad');
  };

  function draw() {
    const held = mapboxToken();
    input.value = held;
    // Deliberately not re-checked on every opening: that is a network request
    // for a question nobody asked, and the answer was already given when the
    // token went in. It says what is *stored*, which is the thing the dialog is
    // about.
    say(held ? 'A token is saved to your account.' : '', held ? 'ok' : null);
  }

  async function done() {
    const typed = input.value.trim();
    const held = mapboxToken();

    // An empty box is how a token is taken off, and it is the only thing an
    // empty box can mean — so it must not be answered with "a Mapbox public
    // token starts with pk."
    if (!typed) {
      if (held) {
        setMapboxToken('');
        onToken?.('');
      }
      return close();
    }

    // Unchanged, and it was checked the moment it went in. Asking Mapbox again
    // would be a request for a question already answered and a slower Done.
    if (typed === held) {
      close();
      onUse?.();
      return;
    }

    const complaint = tokenComplaint(typed);
    if (complaint) return say(complaint, 'bad');

    const mine = generation;
    doneBtn.disabled = true;
    say('Asking Mapbox…');
    const { ok, why } = await checkMapboxToken(typed);
    if (mine !== generation) return; // dismissed while we were asking
    doneBtn.disabled = false;
    // Left open on purpose: the box is still there, still holding what was
    // typed, which is what makes the complaint worth printing.
    if (!ok) return say(why ?? 'That token did not work.', 'bad');

    setMapboxToken(typed);
    onToken?.(typed);
    close();
    onUse?.();
  }

  const open = () => {
    draw();
    overlay.hidden = false;
    // Not focused on a phone, where it would throw the keyboard up over the
    // paragraph explaining what the field is for.
    if (!matchMedia('(hover: none)').matches) input.focus();
  };
  const close = () => {
    generation++;
    doneBtn.disabled = false;
    overlay.hidden = true;
  };

  doneBtn.addEventListener('click', done);
  // Cancel goes back where the dialog was opened from; the X, Escape and the
  // backdrop dismiss it outright. Both leave the stored token exactly as it was.
  $('mapbox-cancel').addEventListener('click', () => {
    close();
    onClose?.();
  });
  // A token is one long line pasted from somewhere else; Return is the natural
  // way to finish it.
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      done();
    }
  });
  // Anything typed invalidates whatever the last answer was talking about.
  input.addEventListener('input', () => say(''));

  $('mapbox-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close };
}
