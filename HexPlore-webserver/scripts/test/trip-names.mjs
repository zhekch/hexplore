// Calling a trip something of your own.
//
//   node scripts/test/trip-names.mjs
//
// Trips are derived rather than stored — there is no row with a name column in
// it — so a rename is an opinion kept beside the derivation and put back on
// every time it is re-read. Three things about that are easy to break and
// invisible when broken:
//
//   - **the same array, edited.** The palette uses trip objects as the keys of
//     its relevance map and the calendar compares them by identity, so handing
//     back renamed *copies* is two lists of the same holidays that do not match
//     each other. Everything here checks the object, not the value.
//   - **a fresh answer arrives unnamed.** `/api/trips` is asked on every
//     opening and answers with the gazetteer's name, so a rename that is only
//     applied once survives exactly until the next 200.
//   - **clearing a name is not clearing the trip's name.** It means "call it
//     what you worked out again", which is unanswerable if the derived name has
//     been overwritten rather than kept.

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

// The server's side of it. Every load hands back a *new* list with the derived
// names on it, which is exactly what the real endpoint does and the thing a
// rename has to survive.
let served = [
  { id: 'trip-1000', name: 'Zermatt, Switzerland', days: 6 },
  { id: 'trip-2000', name: 'Rome, Italy', days: 12 },
];
let loads = 0;
globalThis.fetch = async () => {
  loads++;
  return {
    ok: true,
    status: 200,
    json: async () => ({ trips: served.map((t) => ({ ...t })), home: null }),
  };
};

const { derived } = await import('../../src/derived.js');

const byId = (id) => derived.trips().find((t) => t.id === id);

console.log('\nA name given is a name kept');
{
  await derived.loadTrips();
  check(byId('trip-1000').name === 'Zermatt, Switzerland', 'it starts with what the server worked out');

  derived.setTripNames({ 'trip-1000': 'The week the lift broke' });
  check(byId('trip-1000').name === 'The week the lift broke', 'naming one renames it', byId('trip-1000').name);
  check(byId('trip-2000').name === 'Rome, Italy', 'and leaves the others alone', byId('trip-2000').name);

  const held = byId('trip-1000');
  derived.setTripNames({ 'trip-1000': 'Zermatt with Mum' });
  check(byId('trip-1000') === held, 'renaming edits the trip rather than replacing it');
}

console.log('\nAnd survives the next answer from the server');
{
  const before = loads;
  await derived.loadTrips();
  check(loads === before + 1, 'the list really was asked for again', String(loads));
  check(byId('trip-1000').name === 'Zermatt with Mum',
    'a fresh answer still comes back under the name you gave it', byId('trip-1000').name);

  // A trip that did not exist when the name was chosen — more history arrived,
  // and the run it belongs to is a new one.
  served = [...served, { id: 'trip-3000', name: 'Oslo, Norway', days: 3 }];
  await derived.loadTrips();
  check(byId('trip-3000').name === 'Oslo, Norway', 'and one nobody has named is called what it derives');
  check(byId('trip-1000').name === 'Zermatt with Mum', 'with the named one unaffected');
}

console.log('\nClearing a name gives back the one it had');
{
  derived.setTripNames({});
  check(byId('trip-1000').name === 'Zermatt, Switzerland',
    'the derived name comes back rather than an empty row', byId('trip-1000').name);

  // The same by the route an empty field takes: a name is either something or
  // it is absent, and both spellings have to mean the same thing.
  derived.setTripNames({ 'trip-1000': 'Named again' });
  derived.setTripNames({ 'trip-1000': '' });
  check(byId('trip-1000').name === 'Zermatt, Switzerland', 'and an empty name is the same as no name');
}

console.log('\nA Map is as good as an object, and neither is required');
{
  derived.setTripNames(new Map([['trip-2000', 'Two weeks off']]));
  check(byId('trip-2000').name === 'Two weeks off', 'the map the caller keeps can be handed straight over');
  derived.setTripNames(null);
  check(byId('trip-2000').name === 'Rome, Italy', 'and nothing at all clears them');
}

console.log('\nSigning out takes them with it');
{
  derived.setTripNames({ 'trip-1000': 'Mine' });
  derived.clear();
  check(derived.trips() === null, 'the trips go');
  await derived.loadTrips();
  check(byId('trip-1000').name === 'Zermatt, Switzerland',
    'and the next account is not shown what the last one called them',
    byId('trip-1000').name);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
