// The banner that says what changed while you were not looking.
//
// Shaped like the offline bar and coloured differently, for the reason the
// railway one is: that bar is red because your edits are not being saved, and
// nothing here is wrong at all. This is the only banner in the app that is
// *good* news, so it is the accent colour rather than a warning colour.
//
// The arithmetic — what counts as a change, what counts as a substantial one,
// and what the sentence says — is all in `src/whats-new.js`, which has no DOM in
// it and is where that argument is tested. This is the part that has to know
// about elements.

import { bannerFor, bannerMode, changesSince, lastSnapshot, rememberSnapshot, snapshotOf } from './whats-new.js';

// How long it stays before going on its own.
//
// Long enough to read twice — it appears while the map is still drawing, and
// the first thing anyone does with a map is look at the map. Not permanent:
// there is nothing to act on, so a banner that waits to be dismissed is a
// chore attached to good news.
const SHOW_MS = 14_000;

/**
 * @param {object} opts
 * @param {() => object|null} opts.stats  the coverage answer, or null if it
 *   could not be read — in which case nothing is said, rather than a banner
 *   describing a map from a failed request
 * @param {() => Array|null} opts.routes  the route list, for the workout count
 * @param {(newWorkouts: number) => void} [opts.onOpenStats] where the banner
 *   goes when pressed, told how many workouts the sentence is about — one of
 *   them is a different destination from several, because there is somewhere
 *   specific to go
 */
export function mountWhatsNew({ stats, routes, onOpenStats }) {
  const bar = document.getElementById('whats-new-bar');
  const titleEl = document.getElementById('whats-new-title');
  const detailEl = document.getElementById('whats-new-detail');
  const openBtn = document.getElementById('whats-new-open');
  const dismissBtn = document.getElementById('whats-new-dismiss');
  if (!bar) return { show: () => {}, hide: () => {} };

  let timer = null;
  // What the banner currently on screen is about. Read when it is pressed
  // rather than passed through the button, because the button outlives the
  // sentence: a banner that has been replaced must not open the one before it.
  let newWorkouts = 0;

  const hide = () => {
    clearTimeout(timer);
    bar.hidden = true;
  };

  /**
   * Work out whether there is anything to say, and say it.
   *
   * Called once per sign-in, after the routes and the coverage have both been
   * read — the workout count comes from one and everything else from the other,
   * and a banner built from half of them would report a ride that arrived as no
   * change at all.
   */
  const show = () => {
    const now = snapshotOf(stats?.(), routes?.());
    // No coverage answer means the request failed or has not landed. Nothing is
    // said and — importantly — the baseline is not moved: the next open should
    // still be able to report whatever happened in between.
    if (!now) return;

    const before = lastSnapshot();
    const change = changesSince(before, now);
    const { show: wanted, title, detail } = bannerFor(change, bannerMode());

    // The baseline moves whenever something was said, and also on the very
    // first visit — which has nothing to compare against and must not spend the
    // *next* one reporting the whole map as new. It deliberately does not move
    // when a real change went unmentioned for being too small: that is what
    // lets four quiet days add up to one worth a sentence.
    if (wanted || !before) rememberSnapshot(now);
    if (!wanted) return;

    newWorkouts = change.workouts;
    titleEl.textContent = title;
    detailEl.textContent = detail;
    bar.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(hide, SHOW_MS);
  };

  openBtn?.addEventListener('click', () => {
    hide();
    onOpenStats?.(newWorkouts);
  });
  dismissBtn?.addEventListener('click', hide);

  return { show, hide };
}
