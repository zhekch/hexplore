// Which copy of the preferences wins on load.
//
// This exists because the old rule — "on load, the server wins" — lost a colour
// that had been picked but whose push had not landed. The failure mode is nasty
// precisely because it looks like nothing went wrong: the colour applies, the
// map redraws, and it is only the *next* reload that quietly puts the old one
// back. The 'push' verdict below is the fix, and these cases are what stop it
// being simplified back into "trust the server".
//
//   node scripts/test/prefs-sync.mjs

import { reconcilePrefs } from '../../src/prefs.js';

let pass = 0;
let fail = 0;
const eq = (got, want, label) => {
  const ok = got === want;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok ? '' : ` — got "${got}", wanted "${want}"`}`);
  ok ? pass++ : fail++;
};

const T = 1_760_000_000_000; // some fixed epoch ms; the actual value is irrelevant

// --- A browser that has never saved anything ---------------------------------
eq(
  reconcilePrefs({ localStamp: 0, dirty: false, remote: { updatedAt: T, accent: '#ff0000' } }),
  'adopt',
  'a fresh browser takes the account colours',
);
eq(
  reconcilePrefs({ localStamp: 0, dirty: false, remote: {} }),
  'idle',
  'nothing anywhere is nothing to do',
);
eq(
  reconcilePrefs({ localStamp: 0, dirty: false, remote: null }),
  'idle',
  'a missing prefs blob is not an error',
);

// A copy written before preferences carried a stamp reads back as 0, and must
// still be adopted rather than treated as older than a browser that is also 0.
eq(
  reconcilePrefs({ localStamp: 0, dirty: false, remote: { routeView: { hidden: [], colors: {} } } }),
  'adopt',
  'an unstamped account copy still wins over a browser that has saved nothing',
);

// --- The bug this was written for --------------------------------------------
// Colour picked, push never landed, page reloaded. The account still holds the
// previous copy; adopting it is exactly what made the colour disappear.
eq(
  reconcilePrefs({ localStamp: T + 5000, dirty: true, remote: { updatedAt: T, accent: '#ff0000' } }),
  'push',
  'a local change the account has not seen is sent, not overwritten',
);
// Same, but the flag was lost with the page: the stamp alone still settles it.
eq(
  reconcilePrefs({ localStamp: T + 5000, dirty: false, remote: { updatedAt: T } }),
  'push',
  'a newer local stamp wins even after the dirty flag is gone',
);
eq(
  reconcilePrefs({ localStamp: T, dirty: false, remote: {} }),
  'push',
  'an account with no preferences is given this browser’s',
);

// --- The other device ---------------------------------------------------------
eq(
  reconcilePrefs({ localStamp: T, dirty: false, remote: { updatedAt: T + 5000 } }),
  'adopt',
  'a newer copy from the phone wins here',
);
// Equal stamps mean the same save: the account's copy is the canonical one, and
// re-pushing an identical blob would only add a request.
eq(
  reconcilePrefs({ localStamp: T, dirty: false, remote: { updatedAt: T } }),
  'adopt',
  'the same save on both sides settles to the account copy',
);
// A local edit made *while* the account is ahead is still the more recent
// intent — it was stamped when it happened.
eq(
  reconcilePrefs({ localStamp: T + 1, dirty: true, remote: { updatedAt: T } }),
  'push',
  'one millisecond newer is newer',
);

// --- Junk from the wire -------------------------------------------------------
eq(
  reconcilePrefs({ localStamp: T, dirty: false, remote: { updatedAt: 'yesterday' } }),
  'push',
  'an unparseable stamp counts as no stamp',
);
eq(
  reconcilePrefs({ localStamp: 0, dirty: false, remote: { updatedAt: 'yesterday', accent: '#abcdef' } }),
  'adopt',
  '…but the copy is still adopted by a browser with nothing of its own',
);
eq(reconcilePrefs({}), 'idle', 'called with nothing, decides nothing');

console.log(`\n${fail ? 'FAILED' : 'passed'}: ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
