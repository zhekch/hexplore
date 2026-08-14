// Moving a map card out of the way of the thing it is about.
//
// The four `feature-popup` cards — the activity stack, the railway, the trails
// and the airports — are anchored to the point you tapped, and the point you
// tapped is usually the one you want to look at. A card listing eleven
// activities is most of the window, and every one of those eleven runs under
// it. The card is answering a question about a place while standing on it.
//
// So the heading is a handle: press it and the card goes where you put it.
//
// **The offset is the library's, not a transform of our own.** A popup is
// positioned by MapLibre and Mapbox on every frame of every pan, by writing a
// `transform` onto the container — so a translate of ours would be overwritten
// on the next frame, and holding it would mean fighting the renderer for the
// same property forty times a second. Both libraries already have the concept
// this needs: `Popup#setOffset` is a screen-space nudge that *they* compose
// into the transform they were going to write anyway. A drag is then a number
// they own, changed by us, and the card goes on being anchored to its own
// point — pan the map and it travels with the place, which is the whole reason
// a popup is a popup.

/** Below this a press is a click on the heading, not the start of a drag. */
const DRAG_SLOP_PX = 3;

// How much of the card has to stay in the window. It is the way back: a card
// dragged entirely off screen is a card that cannot be dragged on again, and
// the only way out of it would be closing the card and re-opening it — which
// costs you the row you had picked.
const KEEP_ON_SCREEN_PX = 56;

/**
 * Let a popup card be dragged by its heading.
 *
 * Safe to call on anything: a card with no `h4`, or a library whose popups have
 * no `setOffset`, is simply left alone rather than half-wired.
 *
 * @param {object} popup the `Popup` the card was given to
 * @param {HTMLElement} card the card's root element
 * @param {string} [label] a title for the handle, if the caller has one
 */
export function draggableCard(popup, card, label) {
  const handle = card?.querySelector?.('h4');
  if (!handle || typeof popup?.setOffset !== 'function') return;

  handle.classList.add('popup-grip');
  if (label) handle.title = label;

  // Where the card has been dragged to, in pixels from where the map put it.
  // Held here rather than read back off the popup because neither library
  // offers a getter, and reaching into `options.offset` would be reading a
  // field to find out what we ourselves last wrote.
  let offset = [0, 0];
  let from = null;
  let dragging = false;

  const grip = (ev) => {
    // Left button only; anything else is a context menu or a stylus barrel.
    if (ev.button != null && ev.button !== 0) return;
    // Measured per drag, not once: the map moves between them, and the anchor
    // the card hangs off moves with it.
    const box = card.getBoundingClientRect();
    from = {
      x: ev.clientX,
      y: ev.clientY,
      at: offset.slice(),
      // The card's position with our offset taken back out, which is what the
      // clamp below is in terms of.
      left: box.left - offset[0],
      top: box.top - offset[1],
      w: box.width,
      h: box.height,
    };
    dragging = false;
    try {
      handle.setPointerCapture(ev.pointerId);
    } catch {
      /* a browser that will not capture still gets the move events below */
    }
    // Stops the press selecting the heading's text, and stops a touch from
    // being read as a scroll of whatever is underneath.
    ev.preventDefault();
  };

  const move = (ev) => {
    if (!from) return;
    const dx = ev.clientX - from.x;
    const dy = ev.clientY - from.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_SLOP_PX) return;
    if (!dragging) {
      dragging = true;
      handle.classList.add('dragging');
    }
    const x = from.at[0] + dx;
    const y = from.at[1] + dy;
    offset = [
      Math.min(
        Math.max(x, KEEP_ON_SCREEN_PX - from.w - from.left),
        window.innerWidth - KEEP_ON_SCREEN_PX - from.left,
      ),
      // The top is clamped to the window rather than to a margin, because the
      // handle is the top of the card: push it past the top edge and the way
      // back goes with it.
      Math.min(Math.max(y, -from.top), window.innerHeight - KEEP_ON_SCREEN_PX - from.top),
    ];
    popup.setOffset(offset);
  };

  const drop = (ev) => {
    if (!from) return;
    from = null;
    dragging = false;
    handle.classList.remove('dragging');
    try {
      handle.releasePointerCapture(ev.pointerId);
    } catch {
      /* it may already be gone with the popup */
    }
  };

  handle.addEventListener('pointerdown', grip);
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', drop);
  handle.addEventListener('pointercancel', drop);
}
