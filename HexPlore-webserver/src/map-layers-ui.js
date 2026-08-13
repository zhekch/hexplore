// The Map layers page: the three doors that are about what the map is built out
// of, behind one door instead of three.
//
// Settings had grown six of these buttons in a column, and a list of six doors
// is not a list — it is a thing you read every time to find the one you meant.
// Three of them belonged together and said so in their own subtitles: the
// railway overlay, the airports overlay and the 3D basemap's token are all
// *ingredients*, set once, and none of them is about you or about this device.
// The other three — Sources, the cached copy, the introduction — are about the
// app, and they stay where they were.
//
// This page holds no controls of its own on purpose. It is a signpost, and the
// moment it grows a checkbox it becomes a fourth place to look for one.

/**
 * @param {object} opts
 * @param {() => void} [opts.onClose] going Back, which is Settings again
 * @param {{open:Function}} [opts.rail] the Train tracks dialog
 * @param {{open:Function}} [opts.airports] the Airports dialog
 * @param {{open:Function}} [opts.mapbox] the 3D basemap's token dialog
 */
export function mountMapLayers({ onClose, rail, airports, mapbox }) {
  const overlay = document.getElementById('maplayers-overlay');
  if (!overlay) return { open() {}, close() {} };

  const close = () => { overlay.hidden = true; };

  // Each door needs the whole dialog, so this one gets out of the way rather
  // than stacking a second overlay on top of itself — exactly what Settings
  // does to reach this one, and what it used to do to reach these three.
  const doors = { rail, airports, mapbox };
  for (const btn of overlay.querySelectorAll('[data-maplayer]')) {
    const door = doors[btn.dataset.maplayer];
    if (!door) continue;
    btn.addEventListener('click', () => {
      close();
      door.open();
    });
  }

  for (const id of ['maplayers-back', 'maplayers-close']) {
    document.getElementById(id)?.addEventListener('click', () => {
      close();
      onClose?.();
    });
  }
  // Done is the same journey as Back from here, because there is nothing on this
  // page to accept: every setting behind it was already applied by the dialog
  // that owns it. Both spellings are offered because both are what the other
  // dialogs offer, and a page where Done is missing reads as one you cannot
  // leave.
  document.getElementById('maplayers-done')?.addEventListener('click', () => {
    close();
    onClose?.();
  });

  return {
    open() { overlay.hidden = false; },
    close,
  };
}
