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
// they own, changed by us.
//
// **And a dragged card stops travelling with the ground.** That is the second
// half, and it is the half that took being used to notice. An undragged card
// belongs to its place and should ride with it: that is what makes it a popup
// rather than a dialog, and panning the map to see where the eleven activities
// actually go is exactly when you want the card pointing at them. But a card
// you have *moved* has been moved for a reason — it was covering something —
// and having it slide straight back over that something on the next pan is the
// drag being undone by the gesture it was making room for.
//
// So the first drag pins it. Not by taking it out of the popup, which would
// cost the close button, the close event that gives the route colours back, and
// the map's own habit of taking a popup away on the next click. The screen
// point is held instead, and the anchor is moved to wherever that point is now:
// `setLngLat(map.unproject(pinned))` on every `move`. The library goes on doing
// all of its own work, and the answer it computes happens not to change.
//
// The correction lands in the same event as the move that needed it — `move`
// fires, the popup's own handler positions it at the old anchor, ours runs
// after and `setLngLat` re-runs the same update synchronously — so the browser
// only ever paints the corrected position. Nothing flickers, and the anchor
// flip both libraries do when a point nears the edge of the window stops
// happening at all, because the point no longer moves.

/** Below this a press is a click on the heading, not the start of a drag. */
const DRAG_SLOP_PX = 3;

// How much of the card has to stay in the window. It is the way back: a card
// dragged entirely off screen is a card that cannot be dragged on again, and
// the only way out of it would be closing the card and re-opening it — which
// costs you the row you had picked.
const KEEP_ON_SCREEN_PX = 56;

/**
 * Let a popup card be dragged by its heading, and let go of the ground once it
 * has been.
 *
 * Safe to call on anything: a card with no `h4`, or a library whose popups have
 * no `setOffset`, is simply left alone rather than half-wired.
 *
 * @param {object} map the map the popup is on
 * @param {object} popup the `Popup` the card was given to
 * @param {HTMLElement} card the card's root element
 * @param {string} [label] a title for the handle, if the caller has one
 */
export function draggableCard(map, popup, card, label) {
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

  // The screen point the anchor is held at once the card has been moved, and
  // null while it still belongs to the ground.
  let pinned = null;

  const hold = () => {
    if (!pinned) return;
    try {
      popup.setLngLat(map.unproject(pinned));
    } catch {
      // A map mid-teardown can refuse to unproject. There is nothing useful to
      // do about it and nothing broken if it happens: the card is on its way
      // out with the map.
    }
  };

  /** Stop travelling with the ground, and stay where the window has it. */
  const pin = () => {
    if (pinned) return;
    const at = popup.getLngLat?.();
    if (!at || typeof map?.project !== 'function') return;
    pinned = map.project(at);
    map.on('move', hold);
    // Both libraries keep a popup's handlers in their own list, so this is the
    // one place that hears about the commonest way this card goes — the next
    // click on the map, which neither library asks anybody about.
    popup.on('close', () => {
      pinned = null;
      map.off('move', hold);
    });
  };

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
      // At the start rather than at the end, so that a camera still settling
      // from an earlier flight cannot slide the card out from under the drag.
      pin();
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
