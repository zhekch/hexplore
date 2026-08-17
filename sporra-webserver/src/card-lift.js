// Lifting the map's own controls over whatever card is open.
//
// On a phone an info card is a sheet across the bottom of the screen, and the
// button cluster — search, the layers menu, "my location" — sits in the corner
// underneath it. Tap a cell and those three are behind the card: still there,
// still tappable in the few pixels that stick out, and to anyone using it they
// have simply gone. So while a card is open they step above it.
//
// **The distance cannot be a constant.** A cell card is a title and five rows; a
// route card is a title, six rows and three buttons; a photo card is a
// photograph, and a photograph's card *changes height while you are looking at
// it* — the figure is 116 px of waiting panel until the picture arrives and then
// takes the shape of the picture. A hardcoded offset would be wrong for two of
// the three cards and wrong twice for the third.
//
// So it is measured, and re-measured, and published as `--card-h` for the
// stylesheet to read. The lifting itself is CSS, in the phone media query, where
// the problem exists.
//
// Nothing calls this per card. There are a dozen places that open or close one —
// `showCellInfoAt`, `closeRouteInfo`, the mode switch, signing out — and a
// notification hooked into each of them is a notification somebody forgets to
// add to the thirteenth. Watching the cards themselves cannot drift.

/** The three of them. All are `.cell-info` in the markup; the ids are the list. */
const CARDS = ['cell-info', 'route-info', 'photo-info'];

/**
 * Watch the info cards, and keep `--card-h` and `body.card-open` true of them.
 *
 * @param {Document} [doc]
 */
export function installCardLift(doc = document) {
  const cards = CARDS.map((id) => doc.getElementById(id)).filter(Boolean);
  // No cards is not a failure — it is a page that has not got them, and there is
  // nothing to lift over.
  if (!cards.length || typeof ResizeObserver === 'undefined') return;

  const sync = () => {
    // The tallest rather than the sum. The cards close each other, so in
    // practice one is open at most; taking the maximum is what makes that an
    // observation rather than an assumption the layout depends on.
    //
    // `offsetHeight` is 0 for a hidden card *and* for one the menu has covered
    // with `display: none`, which is exactly right: both mean "nothing of it is
    // on screen", and the controls should be back in their corner for both.
    const height = cards.reduce((tallest, card) => Math.max(tallest, card.offsetHeight), 0);
    doc.body.classList.toggle('card-open', height > 0);
    doc.documentElement.style.setProperty('--card-h', `${Math.round(height)}px`);
  };

  // Height first: a card that is shown, resized by its own content, or hidden
  // all arrive here, because all three change the box.
  const sizes = new ResizeObserver(sync);
  // And the attribute as well, for the one case a size change does not cover: a
  // card hidden and reopened at exactly the height it had before.
  const shown = new MutationObserver(sync);
  for (const card of cards) {
    sizes.observe(card);
    shown.observe(card, { attributes: true, attributeFilter: ['hidden'] });
    // And anything inside one that finishes loading, which is the photo card's
    // whole story: it opens at the height of an empty frame and becomes the
    // height of a photograph. A `ResizeObserver` reports that too, but only when
    // the browser next runs its rendering steps — measured going stale here by
    // 350 px in a tab that was not being painted. An image saying it has loaded
    // is not subject to that, and it is the same event for any card that ever
    // holds one. Capture, because `load` does not bubble.
    card.addEventListener('load', sync, true);
  }
  sync();
}
