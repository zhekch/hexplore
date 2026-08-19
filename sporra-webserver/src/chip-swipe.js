// Swiping the chip that says which day the map is showing.
//
// The chip is the only thing on screen that names the day, and until now the
// only thing it could do was stop showing it. But a day is never asked about on
// its own: you look at the Monday because you are working out where that week
// went, and the next question is always the day either side of it. Answering it
// meant the search palette, a month grid, and a day picked out of it — four
// moves to step one day.
//
// So the chip takes a horizontal swipe, which is what a strip of days is for.
// It is the same gesture the photograph card takes (src/photo-info.js), and
// deliberately so: sideways over something that names one of a series means
// *the next one* everywhere else on this device, and a chip that answered it
// differently would be a second thing to learn.
//
// It is a gesture rather than two little buttons. The chip follows the finger,
// resists where there is nothing further to go, and can be changed its mind
// about by putting it back — a swipe that only reacts on release is one you
// cannot tell has been noticed, which is how you end up swiping twice and
// skipping a day. The arrows either side of the text are the hint that any of
// this is possible: nothing about a chip says "drag me", and a gesture nobody
// can discover is a feature that does not exist.

/** How far it has to be pulled, in CSS pixels, before letting go means "next". */
export const SWIPE_COMMIT = 48;

/**
 * Or how fast, in pixels per millisecond. Either will do: a slow deliberate
 * pull and a quick flick are the same instruction, and demanding both makes the
 * gesture feel like it is arguing with you.
 *
 * Both numbers are smaller than the photograph card's, because the thing being
 * dragged is smaller. 56px is a third of the way across a chip and most of the
 * way across the screen for a photograph, and a gesture measured in absolute
 * pixels on an element this size has to be started nearer its edge than a thumb
 * usually lands.
 */
export const SWIPE_FLICK = 0.4;

/**
 * How far sideways before the gesture is ours at all, and the chip starts
 * moving. Below this a press that drifts is still a press — the chip carries a
 * button, and a tap that slides it two pixels and stops nothing is a broken
 * button.
 */
export const SWIPE_CLAIM = 8;

/** How far the chip can be pulled towards a day that isn't there. */
const SWIPE_STUCK = 0.25;

/**
 * A finished drag → which way to step, if at all.
 *
 * Pulled out of the DOM on purpose: everything that makes this gesture feel
 * right or wrong is arithmetic — how far is far enough, how fast counts as a
 * flick, what happens where there is nothing further to go — and none of it is
 * visible in the review that breaks it. `scripts/test/chip-swipe.mjs` is that
 * arithmetic, without a browser.
 *
 * @param {number} dx how far the finger travelled, positive rightwards
 * @param {number} ms how long it took
 * @returns {-1|0|1} the day before, nothing, or the day after
 */
export function swipeStep(dx, ms) {
  // Below the claim distance nothing is a swipe, however fast it happened. The
  // handler below never gets that far — it hasn't claimed the gesture yet — but
  // the speed rule divides by a duration, and two pointer events in the same
  // frame make a 1px twitch look like the fastest flick ever thrown.
  if (!Number.isFinite(dx) || Math.abs(dx) < SWIPE_CLAIM) return 0;
  // Milliseconds, floored at one, for the same division.
  const speed = Math.abs(dx) / Math.max(1, ms || 0);
  if (Math.abs(dx) < SWIPE_COMMIT && speed < SWIPE_FLICK) return 0;
  // Pulling the chip left brings the next day in from the right, which is the
  // direction time runs in every calendar this app draws.
  return dx < 0 ? 1 : -1;
}

/**
 * Let a chip be swiped from one of a series to the next.
 *
 * @param {HTMLElement} el the chip
 * @param {object} opts
 * @param {(dir:number) => boolean} opts.can is there anything that way? Asked
 *   on every drag rather than once, because what the chip is showing changes
 *   under it — and asked per direction, so the first day of a history resists
 *   backwards and moves forwards
 * @param {(dir:number) => void} opts.onStep
 */
export function swipeChip(el, { can, onStep }) {
  if (!el) return;
  let drag = null;
  // A drag that ends where it began still dispatches a click, so a swipe that
  // starts on the Stop button would also press it — the map would stop showing
  // the day you had just asked for the next one of. Cleared on the next press
  // rather than only where it is read, or a gesture the system cancels leaves
  // it standing to swallow a real tap later.
  let swallowTap = false;

  const slide = (dx) => {
    el.style.translate = dx ? `${dx}px 0` : '';
    el.classList.toggle('swiping', !!dx);
  };

  el.addEventListener('pointerdown', (e) => {
    swallowTap = false;
    if (e.button > 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, at: e.timeStamp, dx: 0, own: false };
  });

  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.own) {
      // Claimed once, and only when the movement is plainly sideways: the chip
      // sits over a map that is panned with the same finger, and one that
      // grabbed every downward drag would be a hole in the map.
      if (Math.abs(dx) < SWIPE_CLAIM || Math.abs(dx) <= Math.abs(dy)) return;
      if (!can(dx < 0 ? 1 : -1) && !can(dx < 0 ? -1 : 1)) return;
      drag.own = true;
      swallowTap = true;
      el.setPointerCapture?.(drag.id);
    }
    drag.dx = dx;
    // Resisted rather than refused where there is nothing further: a chip that
    // will not move at all is indistinguishable from one that has stopped
    // responding, and a quarter of the movement says "there is no such day" in
    // the language the gesture is already speaking.
    slide(can(dx < 0 ? 1 : -1) ? dx : dx * SWIPE_STUCK);
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { dx, own, at } = drag;
    drag = null;
    if (!own) return;
    // Released before the movement is undone, or the chip springs back from
    // wherever the capture happened to end rather than from where it is.
    el.releasePointerCapture?.(e.pointerId);
    slide(0);
    const dir = swipeStep(dx, e.timeStamp - at);
    if (dir && can(dir)) onStep(dir);
  };

  el.addEventListener('pointerup', endDrag);
  // A pointer the system takes away — a phone that decides the gesture was a
  // pan of the map, a mouse that leaves the window — has to put the chip back,
  // or it stays where the finger left it for ever.
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('click', (e) => {
    if (!swallowTap) return;
    swallowTap = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
