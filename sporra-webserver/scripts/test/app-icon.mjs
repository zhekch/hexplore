// The app icon, and the fact that there are two of it.
//
//   node scripts/test/app-icon.mjs
//
// Both apps wear the same face, and both have to carry their own copy of it.
// Xcode 26 compiles an Icon Composer document (`Sporra.icon`) rather than an
// asset catalog's icon set, and it will only compile one it can find inside the
// target's own synchronized folder: a symlink to a shared copy at the repo root
// builds for a while and then fails with *Icon export exited with status 255*,
// which says nothing about symlinks. So there are two real copies, and the only
// thing standing between them and a slow drift is this file.
//
// The other half of the trap is that a mismatch is silent in the direction that
// matters. Nothing reads both projects; nobody opens the Mac app to check its
// icon after changing the phone's. Two copies that disagree simply ship, and
// the first person to notice is looking at a Dock.

import { readdirSync, readFileSync, statSync, lstatSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  ok ? pass++ : fail++;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Three folders under one repo root, and the webserver is not the root.
const REPO = path.resolve(ROOT, '..');

const APPS = ['sporra-ios', 'sporra-macos'];
const ICON = 'Sporra/Sporra.icon';
// What `ASSETCATALOG_COMPILER_APPICON_NAME` has to say for the document above to
// be the one compiled. The two have to agree or the build fails outright — but
// it fails with "None of the input catalogs contained a matching … icon stack",
// which reads like a broken document rather than a misspelt setting.
const ICON_NAME = 'Sporra';

/** Every file in a directory tree, as `relative path → bytes`. */
function tree(dir, base = dir, into = new Map()) {
  for (const name of readdirSync(dir).sort()) {
    // Finder leaves these in any folder it has been asked to show, and one of
    // them arriving in a single copy is exactly the kind of difference this
    // test would otherwise report as an icon change.
    if (name === '.DS_Store') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) tree(full, base, into);
    else into.set(path.relative(base, full), readFileSync(full));
  }
  return into;
}

const trees = new Map();
for (const app of APPS) {
  const dir = path.join(REPO, app, ICON);
  const there = existsSync(dir);
  check(there, `${app} carries its own ${ICON}`);
  // A symlink passes `existsSync`, reads back identical to the thing it points
  // at, and fails the build — so it is named here rather than left to be
  // rediscovered. `lstatSync`, because `statSync` follows the link and would
  // report the directory at the other end.
  if (there) {
    check(!lstatSync(dir).isSymbolicLink(), `${app}'s copy is a real directory, not a link`);
    trees.set(app, tree(dir));
  }
}

if (trees.size === APPS.length) {
  const [a, b] = APPS;
  const one = trees.get(a);
  const two = trees.get(b);
  check(one.size === two.size, 'both copies hold the same files',
    `${a} has ${one.size}, ${b} has ${two.size}`);
  for (const [rel, bytes] of one) {
    const other = two.get(rel);
    check(other != null && other.equals(bytes), `${rel} is the same in both apps`,
      other == null ? `missing from ${b}` : `${bytes.length} vs ${other.length} bytes`);
  }
  for (const rel of two.keys()) {
    check(one.has(rel), `${rel} is not only in ${b}`);
  }
}

for (const app of APPS) {
  const pbx = readFileSync(path.join(REPO, app, 'Sporra.xcodeproj/project.pbxproj'), 'utf8');
  const named = [...pbx.matchAll(/ASSETCATALOG_COMPILER_APPICON_NAME = ([^;]+);/g)].map((m) => m[1]);
  // Both configurations, Debug and Release, carry the setting — change one and
  // the app has an icon or does not depending on how it was built.
  check(named.length === 2, `${app} names the icon in both configurations`,
    `found ${named.length}`);
  check(named.every((n) => n === ICON_NAME), `${app} points at ${ICON_NAME}.icon`,
    named.join(', '));
  // The empty `AppIcon.appiconset` the project was created with outranks
  // nothing, but leaving it there means two plausible places to edit the icon
  // and only one of them does anything.
  check(!existsSync(path.join(REPO, app, 'Sporra/Assets.xcassets/AppIcon.appiconset')),
    `${app} has no leftover AppIcon.appiconset`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
