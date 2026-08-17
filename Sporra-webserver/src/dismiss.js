// Closing something because you clicked away from it — without closing it when
// you were never away from it.
//
// **A `click` is dispatched on the nearest common ancestor of the press and the
// release**, not on the element you let go over. That is the whole of this file.
// Select a sentence inside a dialog, run the cursor past the edge of the card
// and let go, and the browser dispatches a click on the *backdrop* — a click
// nobody made, on an element nobody pressed. Every dialog in this app read that
// as "you clicked away", shut itself, and took the selection with it. The same
// event does the same thing to a slider dragged past its own panel, and to a
// colour picker.
//
// So "away" is decided when the press lands and confirmed when the click
// resolves: both ends have to be outside, and one end inside is enough to keep
// the thing open. That is not a heuristic about intent — it is the only reading
// under which the press and the click describe the same gesture.
//
// **There is a second reason to record it on pointerdown**, and it is why the
// layers menu in main.js grew its own copy of this before there was a file to
// put it in: a control that redraws its own row detaches the very element that
// was clicked, so by the time a click handler runs `e.target` is an orphan and
// `contains()` says false. Reading the tree while the press is happening is what
// makes that impossible. That one stays where it is — it settles a third thing
// about MapLibre's own click ordering that has nothing to do with dismissal.

/**
 * Dismiss on a click that both began and ended outside.
 *
 * @param {EventTarget} node where to listen — the overlay itself for a modal
 *   backdrop, or `document` for something with no backdrop of its own
 * @param {(e: Event) => boolean} outside whether an event is away from the thing
 * @param {(e: Event) => void} dismiss
 * @returns {() => void} stop listening
 */
export function onClickAway(node, outside, dismiss) {
  let pressedAway = false;
  // Capture, so this reads the tree before any handler further down has had the
  // chance to rebuild the element the press landed on.
  const down = (e) => {
    pressedAway = outside(e);
  };
  const click = (e) => {
    const away = pressedAway && outside(e);
    // Cleared whatever the verdict: a press that resolves into a click has been
    // spent, and one left standing would be answered by whatever came next.
    pressedAway = false;
    if (away) dismiss(e);
  };
  node.addEventListener('pointerdown', down, true);
  node.addEventListener('click', click);
  return () => {
    node.removeEventListener('pointerdown', down, true);
    node.removeEventListener('click', click);
  };
}

/**
 * The modal case: a press on the dimmed area around a card, released there too.
 *
 * `e.target === overlay` rather than "not inside the card", because the overlay
 * *is* the dimmed area — anything else the click could name is the card or
 * something in it.
 *
 * @param {Element} overlay the `.modal-overlay`
 * @param {(e: Event) => void} dismiss
 * @returns {() => void} stop listening
 */
export const onBackdropClick = (overlay, dismiss) =>
  onClickAway(overlay, (e) => e.target === overlay, dismiss);
