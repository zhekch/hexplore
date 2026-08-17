// The scale bar, and what the map is currently drawing cells at.
//
// Two readings that belong together and were both missing. A map of hexagons
// has no landmarks in it to judge size against — the grid looks the same at
// every zoom, so "how big is that blob" had no answer on screen at all. And the
// cell size was written down only inside the layers menu, which is a panel you
// open, change something in, and shut: exactly the wrong place for a fact about
// what you are looking at *now*.
//
// So: a bar of a round distance, and beside it what one cell is. `≈ 600 m cell`
// against a 500 m bar is the sentence that makes the grid legible.

// Web Mercator metres per pixel at the equator, zoom 0, for a 512px tile —
// which is what both map libraries use. Cosine of the latitude does the rest:
// a pixel at 60° covers half the ground a pixel at the equator does.
const EQUATOR_M_PER_PX_Z0 = 156543.03392804097 / 2;

// The distances a scale bar is allowed to be. Anything else and the bar stops
// being a ruler you can multiply by eye: nobody reads "3,847 m" off a map and
// then estimates four of them.
const STEPS = [1, 2, 5];

/** Metres each screen pixel covers, at this zoom and latitude. */
export function metresPerPixel(zoom, lat) {
  return (EQUATOR_M_PER_PX_Z0 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * The longest round distance that fits in `maxPx`, and how wide it draws.
 *
 * Round first, then measure — the reverse (a fixed bar, whatever distance it
 * happens to be) gives a ruler marked 137 m. So the bar's width is the variable
 * and the number is always one of 1, 2 or 5 times a power of ten.
 *
 * @returns {{metres:number, px:number, label:string}}
 */
export function scaleStep(mPerPx, maxPx = 120) {
  // No floor of a metre here. At full zoom near the poles a hundred pixels is
  // less than a metre of ground — cos(71°) is a third, and z22 is centimetres a
  // pixel — and forcing "1 m" there drew a bar wider than the space it was given
  // rather than admitting the map was closer than that.
  const most = mPerPx * maxPx;
  const decade = 10 ** Math.floor(Math.log10(most));
  // Largest step that still fits. Walked downwards so the first hit is the
  // longest bar, and 10× the decade is included because `most` can be 9.9 of
  // one decade and 0.99 of the next.
  let metres = decade;
  for (const s of [...STEPS, 10]) {
    if (s * decade <= most) metres = s * decade;
  }
  return { metres, px: Math.round(metres / mPerPx), label: distanceLabel(metres) };
}

/** A round metre count, said the way a map says it. */
export function distanceLabel(metres) {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${km >= 10 ? Math.round(km) : km} km`;
  }
  // Below a metre the unit changes rather than the number growing a decimal
  // point: "0.5 m" is a measurement somebody has to decode, and "50 cm" is one
  // they can already picture.
  if (metres < 1) return `${Math.round(metres * 100)} cm`;
  return `${Math.round(metres)} m`;
}

/**
 * Wire the bar to a map.
 *
 * `level` is asked for rather than pushed, because the grid level changes for
 * reasons that have nothing to do with the map moving — the Detail buttons, a
 * dataset arriving — and a bar that only refreshed on `move` would sit there
 * describing the level before last.
 *
 * @param {object} opts
 * @param {() => object|null} opts.map the live map, or null before one is built
 * @param {() => string} opts.detail what a cell is right now, already worded
 */
export function mountScaleBar({ map, detail }) {
  const root = document.getElementById('scale');
  const line = document.getElementById('scale-line');
  const text = document.getElementById('scale-text');
  if (!root || !line || !text) return { update: () => {} };

  function update() {
    const m = map?.();
    if (!m) return;
    let mPerPx;
    try {
      mPerPx = metresPerPixel(m.getZoom(), m.getCenter().lat);
    } catch {
      // A map mid-rebuild answers neither. Leaving the last reading up is the
      // honest thing: it was true a moment ago and will be again.
      return;
    }
    if (!(mPerPx > 0) || !Number.isFinite(mPerPx)) return;
    const step = scaleStep(mPerPx);
    line.style.width = `${step.px}px`;
    const what = detail?.();
    text.textContent = what ? `${step.label} · ${what}` : step.label;
    root.hidden = false;
  }

  return { update };
}
