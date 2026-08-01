// Where the on-screen keyboard is, so the page can stay out from under it.
//
// Nothing here is supposed to scroll. `body` is `overflow: hidden`, the map
// fills the window and every panel over it is `position: fixed`, so the
// document is exactly one screen tall and always has been.
//
// iOS does not take that as an answer. When a text field takes focus the
// keyboard covers the bottom half of the screen, and WebKit's way of keeping
// the field visible is to make the *page* scrollable and move it — which on a
// full-bleed map means a stray finger drags the map, the glass and the search
// results up past the status bar and leaves them there, with no scrollbar and
// nothing to say how to get back. That is the bug this file exists for.
//
// The fix is to remove the reason to scroll rather than to fight the scrolling:
// measure how much of the screen the keyboard has taken, publish it as `--kb`,
// and let the panels holding text fields end above it (see `--kb` in
// style.css). A field that is already visible is one WebKit has no cause to go
// looking for.
//
// **This file only measures anything in a browser.** `innerHeight` minus
// `visualViewport.height` is the keyboard in mobile Safari and is flat zero in
// a WKWebView, which does not resize its viewport for the keyboard at all — it
// insets the scroll view and scrolls instead, changing nothing the page can
// read. The app therefore sets `--kb` from Swift and marks the document
// `data-kb-host`, and everything below stands down when it sees that.
//
// The iOS app additionally turns the web view's own scrolling off — see
// `webView.scrollView.isScrollEnabled` in WebPanel.swift — because a native
// switch is the only thing that stops a *deliberate* drag. This half is what
// works in mobile Safari, where there is no such switch, and it is also what
// makes the app's version safe: with scrolling off, a page WebKit has nudged
// out of place can no longer be dragged back by hand, so it had better not be
// nudged.

/** Anything smaller is a rounding error or a hidden toolbar, not a keyboard. */
const KEYBOARD_MIN = 90;

/**
 * Keep `--kb` on `:root` equal to the height of the on-screen keyboard, and
 * undo any scrolling the browser did to get a field into view.
 *
 * Safe to call in any browser: without `visualViewport` there is nothing to
 * measure, `--kb` stays at its `0px` default, and every panel lays out exactly
 * as it did before.
 */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;

  const root = document.documentElement;
  let applied = 0;

  const measure = () => {
    // `innerHeight` is the layout viewport, which the keyboard does not shrink;
    // `visualViewport.height` is what you can actually see of it. The gap is
    // the keyboard — except while the page is pinched, where the same gap is
    // just magnification, so that case measures nothing.
    if (vv.scale > 1.01) return 0;
    const gap = Math.round(window.innerHeight - vv.height);
    return gap >= KEYBOARD_MIN ? gap : 0;
  };

  const apply = () => {
    // The iOS app measures the keyboard itself and sets `--kb` from Swift,
    // because none of what `measure()` reads changes inside a WKWebView — see
    // `observeKeyboard()` in WebPanel.swift. Two writers for one variable, one
    // of which is always wrong there, is how it would start flickering.
    if (root.dataset.kbHost) return;
    const kb = measure();
    if (kb === applied) return;
    applied = kb;
    root.style.setProperty('--kb', `${kb}px`);
  };

  // Put back whatever WebKit scrolled to reveal a field. The layout has already
  // made room for the keyboard, so the top is the only scroll position this
  // page has ever had a use for.
  //
  // ONLY ever called when nothing has the focus. An earlier version ran this
  // from the visual viewport's `scroll` event as well, on the theory that a
  // reveal shows up there too. It does — and so does dragging a list inside a
  // panel, which on iOS moves the visual viewport while your finger is still
  // down. Every frame of the drag was yanked back to the top, and scrolling the
  // trips list turned into a violent jitter. There is no version of this that
  // is safe to run mid-gesture: leave the page where it is until the gesture,
  // and the field, are over.
  const restore = () => {
    if (vv.scale > 1.01) return; // pinched: moving the page about is the point
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
  };

  // The keyboard arriving and leaving. Not `scroll` — see above.
  vv.addEventListener('resize', apply);
  // A field that has lost the focus can never need the page moved to show it,
  // which makes this the one moment when putting the page back is unambiguous.
  window.addEventListener('focusout', () => {
    apply();
    restore();
  });
  apply();
}
