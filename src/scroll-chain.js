// Handing a touch-scroll from an inner list to the panel around it.
//
// A touch scroll on iOS belongs to whichever scroller the gesture started in,
// for the whole gesture. Reach the end of that scroller and the finger simply
// stops working: the panel behind it does not take over the way a wheel or a
// trackpad does on a desktop, and the way overscroll chaining does on Android.
// In a dialog built out of a scrolling column with scrolling lists inside it —
// which is every settings panel in this app, and the export dialog most of all
// — that means a list of 200 countries is a wall. You cannot get past it
// without lifting your finger and finding one of the few pixels that are not
// the list.
//
// So the hand-off is done by hand. The gesture is watched only once it has
// started inside a nested scroller, the inner scroller is left alone for as
// long as it can still move, and the moment it runs out the same finger travel
// is applied to the first ancestor that can move instead.
//
// The listener is armed per gesture rather than kept on the document, because a
// permanent non-passive `touchmove` on the document opts the whole page out of
// the browser's fast-path scrolling — a real cost on a phone, paid on every
// scroll, to fix the few that start inside a list.

/** How much of a scroller's travel still counts as "not at the end". */
const EDGE_SLOP_PX = 1;

/**
 * Can this scroller still move in the direction the finger is asking for?
 *
 * `dy` is finger travel: positive is downwards, which reveals content *above*
 * and so decreases scrollTop.
 *
 * Takes a plain box rather than an element so the decision can be tested
 * without a DOM.
 */
export function canScroll(box, dy) {
  const max = box.scrollHeight - box.clientHeight;
  if (max <= EDGE_SLOP_PX) return false;
  if (dy > 0) return box.scrollTop > EDGE_SLOP_PX;
  if (dy < 0) return box.scrollTop < max - EDGE_SLOP_PX;
  return false;
}

/**
 * Which scroller in a chain should move, given a chain ordered innermost first.
 *
 * Returns -1 when the browser should be left to it — either because the
 * innermost scroller can still move (it is the one the gesture is already
 * driving) or because nothing in the chain can. Any other index is an ancestor
 * that has to be scrolled by hand, because the browser will not do it.
 */
export function pickHandoff(chain, dy) {
  if (!dy) return -1;
  for (let i = 0; i < chain.length; i++) {
    if (!canScroll(chain[i], dy)) continue;
    return i === 0 ? -1 : i;
  }
  return -1;
}

/** Does this element scroll vertically under its own steam? */
function scrolls(el) {
  if (!el || el.nodeType !== 1) return false;
  const overflow = getComputedStyle(el).overflowY;
  if (overflow !== 'auto' && overflow !== 'scroll') return false;
  return el.scrollHeight - el.clientHeight > EDGE_SLOP_PX;
}

/** The scrollers above a node, innermost first. */
function chainOf(node) {
  const out = [];
  for (let el = node; el && el !== document.body; el = el.parentElement) {
    if (scrolls(el)) out.push(el);
  }
  return out;
}

/**
 * Watch single-finger gestures and hand them on when the inner list runs out.
 *
 * Idempotent — calling it twice does not install two listeners.
 */
export function installScrollChain(root = document) {
  if (root.__scrollChained) return;
  root.__scrollChained = true;

  root.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) return;
      const chain = chainOf(e.target);
      // One scroller is the browser's own business, and none is the map.
      if (chain.length < 2) return;
      arm(chain, e.touches[0].clientY);
    },
    { passive: true },
  );
}

function arm(chain, startY) {
  const inner = chain[0];
  let y = startY;

  const move = (e) => {
    // A second finger is a pinch, not a scroll. Let go of the gesture rather
    // than fighting whatever it turns into.
    if (e.touches.length !== 1) return disarm();
    const dy = e.touches[0].clientY - y;
    y = e.touches[0].clientY;
    const at = pickHandoff(chain, dy);
    if (at < 0) return;
    // The browser has committed this gesture to the inner scroller and will not
    // be talked out of it, so the ancestor is moved directly. Cancelling the
    // default as well stops the page itself rubber-banding underneath.
    e.preventDefault();
    chain[at].scrollTop -= dy;
  };

  const disarm = () => {
    inner.removeEventListener('touchmove', move);
    inner.removeEventListener('touchend', disarm);
    inner.removeEventListener('touchcancel', disarm);
  };

  inner.addEventListener('touchmove', move, { passive: false });
  inner.addEventListener('touchend', disarm, { passive: true });
  inner.addEventListener('touchcancel', disarm, { passive: true });
}
