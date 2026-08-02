// The map's readings of itself, asked of the server rather than worked out here.
//
// Trips and coverage are derivations over the rows — which runs of days you did
// not come home, how much ground you have covered, how much of each country
// that is. The browser used to compute both, and it paid for them twice:
//
//   • **8.5 MB of geography.** Naming a trip needs the towns, the regions and
//     the countries; the coverage sweep needs two of the three. Opening the
//     search palette therefore downloaded `places.json`, `regions.json` and
//     `countries.json` — about 1.7 MB gzipped — and spent a couple of hundred
//     milliseconds of main thread, to produce an answer of roughly 100 KB that
//     the server had already worked out for the phone.
//   • **a second implementation.** Not a copy — `server/derive.js` imports the
//     same `src/trips.js` — but a second set of *inputs*, and that is enough to
//     disagree: this side's idea of home, this side's route list, this side's
//     memo of which cell is in which canton.
//
// So the server answers, and both clients render what they are given.
//
// **Asked every time, and remembered by the cache rather than by us.** Each of
// these reads carries an ETag over a signature of the rows behind it (see
// `conditional` in server/index.js), so a repeat ask that nothing has changed
// under is a 304 and a body the browser already had — a few hundred bytes on
// the wire, no work on the server, no gazetteer anywhere. That is what lets
// this have no `invalidate()` for an import or an edit to forget to call: being
// out of date is not a state this module can get into.
//
// The last good answer is kept and handed back on a failure, because a trip
// list that empties itself the moment the tunnel drops is worse than one that
// is a minute old and says so elsewhere — the connection banner is what says
// the server has gone.

import { auth } from './auth.js';

let tripsHeld = null; // { trips, home }
let statsHeld = null;

// One request at a time per reading. Both are asked from more than one place —
// the palette opening, the Trips tab, the Statistics tab — and two of those
// landing together should be one round trip rather than a race.
let tripsAsking = null;
let statsAsking = null;

export const derived = {
  /**
   * The trips as last read, or null if none have been. Synchronous on purpose:
   * the palette and the calendar render from this and must not wait on a fetch
   * to draw a month.
   */
  trips: () => tripsHeld?.trips ?? null,

  // The answer carries `home` as well — the point every trip in it was measured
  // from, named. Nothing here reads it: the map draws its marker from
  // `findHome` in src/trips.js, which is the same function over the same rows
  // and needs no gazetteer and no round trip, so the house is on screen before
  // a request could have come back. It is in the response for the iOS app,
  // which has neither.

  /** The coverage numbers as last read, or null. */
  stats: () => statsHeld,

  /**
   * Ask for the trips, and resolve to them.
   *
   * A failure keeps whatever was last read rather than emptying the list: the
   * connection banner is what says the server has gone, and a palette that
   * silently forgets your holidays says something else and something wrong.
   */
  async loadTrips() {
    if (!tripsAsking) {
      tripsAsking = (async () => {
        try {
          tripsHeld = await auth.getTrips();
        } catch {
          /* keep the last good answer */
        } finally {
          tripsAsking = null;
        }
      })();
    }
    await tripsAsking;
    return tripsHeld?.trips ?? null;
  },

  /**
   * The same for coverage — but this one throws, because the Statistics tab has
   * somewhere to put the reason and an empty panel would say nothing.
   */
  async loadStats() {
    if (!statsAsking) {
      statsAsking = (async () => {
        try {
          statsHeld = await auth.getStats();
        } finally {
          statsAsking = null;
        }
      })();
    }
    await statsAsking;
    return statsHeld;
  },

  /** Signing out must not leave the next account looking at this one's trips. */
  clear() {
    tripsHeld = null;
    statsHeld = null;
  },
};
