// The 3D basemap section of the Map layers page: somewhere to put a Mapbox
// token.
//
// It is the only credential this app asks anyone for that is not its own, so it
// gets a paragraph rather than a row: there is a whole *why am I being asked
// this* to answer, and a row in a list is not the place to answer it. It used to
// get a dialog of its own as well; see src/map-layers-ui.js for why the page of
// doors went away, and what stayed.
//
// **Only the token.** The light preset used to be here too, and it is not any
// more: it moved to the layers menu, under the basemap picker, where it is
// beside the map it changes and one press away rather than four. A control in
// two places is a control you have to keep in step, and the one you reach for
// is always the nearer one.
//
// **Leaving is what commits**, and it is the pane's business rather than this
// section's: "Use this token", switching to another tab, or pressing Done all
// run the same check, which either puts the map on the basemap it pays for or
// holds the tab open saying what was wrong. Emptying the box and leaving is how
// a token is taken off. Everything else on that page applies itself as it is
// touched, so this is only ever asking Mapbox about a token that actually
// changed.
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
 * @param {(token: string) => void} [opts.onToken] a token was saved or cleared
 * @param {() => void} [opts.onUse] there is a working token and Done was pressed:
 *   put the map on the basemap it pays for
 */
export function mountMapbox({ onToken, onUse } = {}) {
  const $ = (id) => document.getElementById(id);
  const input = $('mapbox-token');
  const note = $('mapbox-note');

  /** Say something under the field, in one of three registers. */
  const say = (text, kind) => {
    note.textContent = text ?? '';
    note.hidden = !text;
    note.classList.toggle('ok', kind === 'ok');
    note.classList.toggle('bad', kind === 'bad');
  };

  /**
   * Commit whatever is in the box, and say whether the page may leave.
   *
   * **Returns false to hold the page open**, which is the whole of what this
   * used to do by simply not closing its own dialog. The box still holds what
   * was typed, which is what makes the complaint under it worth printing.
   */
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
      return true;
    }

    // Unchanged, and it was checked the moment it went in. Asking Mapbox again
    // would be a request for a question already answered and a slower Done.
    if (typed === held) {
      onUse?.();
      return true;
    }

    const complaint = tokenComplaint(typed);
    if (complaint) {
      say(complaint, 'bad');
      return false;
    }

    say('Asking Mapbox…');
    const { ok, why } = await checkMapboxToken(typed);
    if (!ok) {
      say(why ?? 'That token did not work.', 'bad');
      return false;
    }

    setMapboxToken(typed);
    onToken?.(typed);
    onUse?.();
    return true;
  }

  /** Show what is stored. Called by the page when it opens. */
  function draw() {
    const held = mapboxToken();
    input.value = held;
    // Deliberately not re-checked on every opening: that is a network request
    // for a question nobody asked, and the answer was already given when the
    // token went in. It says what is *stored*, which is the thing this is about.
    say(held ? 'A token is saved to your account.' : '', held ? 'ok' : null);
  }

  input.addEventListener('keydown', (e) => {
    // A token is one long line pasted from somewhere else; Return is the natural
    // way to finish it, and finishing it is what the pane's own button does.
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('maplayers-apply')?.click();
    }
  });
  // Anything typed invalidates whatever the last answer was talking about.
  input.addEventListener('input', () => say(''));

  return { draw, commit: done };
}
