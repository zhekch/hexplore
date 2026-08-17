// Standing in an airport, against the real dataset.
//
// This is the question behind the phone's happy-flight notification, and the
// two ways it goes wrong are opposites:
//
//   - too tight a radius and it answers "no" from inside the terminal, which is
//     the only place anybody ever asks it from. A record is the airport
//     reference point and an airport is kilometres across.
//   - too loose, or drawn from the wrong group, and it wishes somebody a happy
//     flight in their own kitchen. Every wrong answer here is the app being odd
//     at a person, which is worse than a missing one.
//
// So the cases below are real terminals, real city centres a few kilometres from
// real airports, and the seam — because Anadyr and Nadi are both airports with
// scheduled flights sitting on ±180°, where a naive longitude difference puts a
// phone in the terminal 360° away from the field it is standing on.
//
//   node scripts/test/airport-at.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { airportAt } from '../../server/airport-at.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const at = (lat, lng) => airportAt(ROOT, lat, lng);

console.log('\nInside a terminal');
{
  // Zurich, the main terminal rather than the reference point.
  const zrh = at(47.4508, 8.5617);
  check(zrh !== null, 'Zurich terminal is at an airport');
  check(zrh?.iata === 'ZRH', 'and it is called ZRH', zrh?.iata);
  check(zrh?.country === 'CH', 'in Switzerland', zrh?.country);

  const lhr = at(51.4700, -0.4543);
  check(lhr?.iata === 'LHR', 'Heathrow answers LHR', lhr?.iata);

  // Frankfurt is four kilometres across, which is the case a tight radius fails.
  const fra = at(50.0510, 8.5710);
  check(fra?.iata === 'FRA', 'Frankfurt answers from the far end of the field', fra?.iata);

  // Dallas/Fort Worth is seven kilometres end to end — Terminal A, not the ARP.
  const dfw = at(32.8880, -97.0360);
  check(dfw?.iata === 'DFW', 'and so does DFW, which is bigger still', dfw?.iata);

  const jfk = at(40.6413, -73.7781);
  check(jfk?.iata === 'JFK', 'JFK answers JFK', jfk?.iata);
}

console.log('\nAnd not anywhere else');
{
  // Zurich city centre — 8 km from the airport, which is close enough that a
  // careless radius would catch it.
  check(at(47.3769, 8.5417) === null, 'Zurich city centre is not an airport');
  // Bern's Bundesplatz. The nearest field is Belp, which has no scheduled
  // service, so it must not answer even though it is only a few kilometres off.
  check(at(46.9470, 7.4444) === null, 'the Bundesplatz is not an airport');
  check(at(48.8584, 2.2945) === null, 'nor is the Eiffel Tower');
  // The middle of the Atlantic, and the middle of Antarctica.
  check(at(30, -40) === null, 'nor is the open ocean');
  check(at(-82, 40) === null, 'nor is the polar ice, where the longitude scale collapses');
}

console.log('\nThe antimeridian');
{
  // Nadi, Fiji — 177.4°E, with the ±180° line a couple of degrees away.
  const nan = at(-17.7554, 177.4434);
  check(nan !== null, 'Nadi is an airport');
  check(nan?.country === 'FJ', 'and it is in Fiji', nan?.country);

  // A point at the same latitude but on the *other* side of the line. If the
  // longitude difference is not wrapped, this is what wrongly matches.
  check(at(-17.7554, -177.4434) === null, 'and a point 5° away across the line is not it');
}

console.log('\nRubbish in');
{
  check(at(NaN, 8.5) === null, 'a NaN latitude has no airport');
  check(at(47.45, undefined) === null, 'nor does a missing longitude');
  check(at(200, 8.5) === null, 'nor does an impossible latitude');
  check(at(47.45, 400) === null, 'nor an impossible longitude');
  check(airportAt(ROOT, null, null) === null, 'nor nothing at all');
  // A root with no dataset under it must answer "no airport" rather than throw:
  // a server without the file still has to serve every other route.
  check(airportAt('/nonexistent-root', 47.4508, 8.5617) === null,
    'and a server with no dataset answers no rather than falling over');
}

console.log('\nWhat comes back');
{
  const zrh = at(47.4508, 8.5617);
  check(typeof zrh.name === 'string' && zrh.name.length > 0, 'an airport has a name to put in a notification');
  check(typeof zrh.km === 'number' && zrh.km >= 0, 'and how far away it was found to be');
  check(zrh.km < 4, 'which is inside the radius it was matched on', String(zrh.km));
  check(!('scheduled' in zrh), 'and nothing the caller has no use for');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
