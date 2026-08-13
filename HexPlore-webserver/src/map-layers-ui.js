// The Map layers page: everything the map is built out of, on one page.
//
// Settings had grown six of these buttons in a column, and a list of six doors
// is not a list — it is a thing you read every time to find the one you meant.
// Three of them belonged together and said so in their own subtitles: the
// railway overlay, the airports overlay and the 3D basemap's token are all
// *ingredients*, set once, and none of them is about you or about this device.
// So they went behind one door.
//
// **And then that door was a signpost with three more doors on it**, which is
// the version this replaces. Reaching a checkbox took three taps, and the page
// in the middle held nothing but a list of places its content was not. It said
// of itself that it deliberately had no controls, "because the moment it grows a
// checkbox it becomes a fourth place to look for one" — which was true of a page
// that also kept the dialogs. With the dialogs gone there is no fourth place: it
// is the only place, and the three sections are named and ruled off inside it.
//
// The trade is a longer scroll, and it is the right way round. This is a page
// somebody opens to change one thing and close again; skimming a scroll is
// cheaper than three round trips, and on a phone it is far cheaper than three
// dialogs each of which fills the screen.
//
// The three modules that own the controls are unchanged in what they wire — see
// src/rail-ui.js, src/airports-ui.js and src/mapbox-ui.js. What they lost is a
// dialog each, not a control each: they now draw into this one and are told when
// it opens.

import { onBackdropClick } from './dismiss.js';

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose] going Back, which is Settings again
 * @param {{draw:Function}} [opts.rail] the Train tracks section
 * @param {{draw:Function}} [opts.airports] the Airports section
 * @param {{draw:Function, commit:Function}} [opts.mapbox] the 3D basemap section
 */
export function mountMapLayers({ onClose, rail, airports, mapbox }) {
  const overlay = document.getElementById('maplayers-overlay');
  if (!overlay) return { open() {}, close() {} };
  const scroller = overlay.querySelector('.ha-scroll');

  /**
   * Fade the last few pixels once there is more below the fold, the same as
   * every other dialog that outgrows a phone. CSS cannot tell whether a box
   * overflows, so the class is put on from here — and this page is the one that
   * needed it most the moment it stopped being a signpost.
   *
   * Exported to the sections through `onGrew` below, because two of the three
   * fill their lists asynchronously and there is nothing to overflow with until
   * they land.
   */
  function markOverflow() {
    if (!scroller) return;
    const over = scroller.scrollHeight - scroller.clientHeight;
    scroller.classList.toggle('more', over > 4);
    scroller.classList.toggle('at-end', scroller.scrollTop >= over - 4);
  }

  scroller?.addEventListener('scroll', markOverflow, { passive: true });

  const close = () => { overlay.hidden = true; };
  const leave = () => {
    close();
    onClose?.();
  };

  const open = () => {
    // Each section reads its own state and draws its own rows. Order matters
    // only in that the railway's may arrive late — its style is a lazily
    // imported 315 KB chunk — which is why they all report back to
    // `markOverflow` rather than it being measured once here.
    rail?.draw();
    airports?.draw();
    mapbox?.draw();
    overlay.hidden = false;
    markOverflow();
  };

  document.getElementById('maplayers-back')?.addEventListener('click', leave);
  document.getElementById('maplayers-close')?.addEventListener('click', close);

  // **Done is the only button that commits the token**, which is the same
  // arrangement the 3D basemap dialog had — it has moved up a floor along with
  // everything else on this page. Every other control here applies itself as it
  // is touched, so this is only ever asking Mapbox about a token that changed,
  // and it stays open to say so when the answer is no.
  document.getElementById('maplayers-done')?.addEventListener('click', async () => {
    const held = await mapbox?.commit?.();
    if (held === false) return; // the token was refused; the note says why
    leave();
  });

  onBackdropClick(overlay, close);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) close();
  });

  return { open, close, markOverflow };
}
