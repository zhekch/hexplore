// The Map layers pane: everything the map is built out of, in three columns.
//
// This started as six buttons in a Settings column, became one door onto a
// signpost with three more doors on it, then one scrolling page with three
// headings — and is now a tab with three columns. Each step took a tap out; this
// one takes out the scroll as well.
//
// The three sections have nothing to do with each other. The railway overlay,
// the airports overlay and the 3D basemap's token are three independent
// ingredients, and the only reason they were ever stacked in a column was that
// the dialog they lived in was 400px wide. Side by side they are one screenful,
// which is what a page you open to change one thing and close should be. Below
// 1040px they stack again, in the same order — see `.settings-cols` in
// src/style.css.
//
// The three modules that own the controls are unchanged in what they wire; see
// src/rail-ui.js, src/airports-ui.js and src/mapbox-ui.js. This one owns the
// column that is *not* theirs: the token has to be committed, and everything
// else on the page applies itself the moment it is touched.

/**
 * @param {object} opts
 * @param {{draw:Function}} [opts.rail] the Train tracks column
 * @param {{draw:Function}} [opts.airports] the Airports column
 * @param {{draw:Function, commit:Function}} [opts.mapbox] the 3D basemap column
 */
export function mountMapLayers({ rail, airports, mapbox }) {
  const noteEl = document.getElementById('maplayers-note');
  const applyBtn = document.getElementById('maplayers-apply');

  const say = (text) => {
    if (noteEl) noteEl.textContent = text ?? '';
  };

  /**
   * Ask Mapbox about a token that has changed.
   *
   * The one thing on this page that cannot apply itself as it is typed: a
   * request per keystroke is not something to do to somebody's Mapbox account.
   * So it is committed on the way out — this button, switching tab, or Done —
   * and `commit()` answers `false` when the token was refused, which holds the
   * tab so the note under the field can be read.
   *
   * Deliberately *not* held on Done. See the note on `leave` in
   * src/settings-ui.js: a dialog you cannot close is worse than a token you
   * have to paste again.
   */
  async function commit() {
    const held = await mapbox?.commit?.();
    return held !== false;
  }

  applyBtn?.addEventListener('click', async () => {
    applyBtn.disabled = true;
    say('Checking…');
    const ok = await commit();
    applyBtn.disabled = false;
    // On success the note is cleared rather than turned into a tick: the
    // basemap switching under you is the answer, and a line saying "saved" under
    // a field whose effect you are looking at is noise. A refusal writes its own
    // reason into #mapbox-note, which is beside the field rather than here.
    say(ok ? '' : 'That token was not accepted.');
  });

  return {
    draw() {
      // Each column reads its own state and draws its own rows. The railway's
      // may arrive late — its style is a lazily imported 315 KB chunk — which is
      // why nothing here measures anything after the fact.
      rail?.draw();
      airports?.draw();
      mapbox?.draw();
      say('');
    },
    leave: commit,
  };
}
