// The banner every entry point prints, and the version stamped under it.
//
// This exists for the same reason SERVER_VERSION does, one step earlier in the
// chain: the number at the foot of Settings answers "which build is running"
// only once you are already in the app and it is already serving. A restart
// that pulled nothing, a build that went to a dist/ nobody is serving, a server
// that came back on the old code because the pull failed quietly — all of those
// look identical from the terminal, and all of them are answered by printing
// the number at the moment the thing starts.
//
// So the art is not the point. The line under it is.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Trailing whitespace is trimmed off each row; the glyphs are ragged on the
// right and padding them buys nothing but a diff full of invisible characters.
const ART = String.raw`
 ___  ___   ___   ___  ___    _
/ __|| _ \ / _ \ | _ \| _ \  /_\
\__ \|  _/| (_) ||   /|   / / _ \
|___/|_|   \___/ |_|_\|_|_\/_/ \_\
`;

// Read off index.js rather than imported from it: importing that module starts
// a server, opens the database and binds the port, which is not a thing a build
// or a shell script can do to find out a version number.
//
// This is the same trick the update check plays on the *remote* copy of
// index.js (see UPDATE_BYTES there) — the constant is the interface, and it is
// read the same way whether the file came from disk or from GitHub. Moving
// SERVER_VERSION out of index.js breaks both halves at once.
export function readVersion(from = path.join(HERE, 'index.js')) {
  try {
    const src = readFileSync(from, 'utf8').slice(0, 16384);
    return /SERVER_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/.exec(src)?.[1] ?? null;
  } catch {
    // A caller that cannot read the file still gets a banner; an unknown
    // version is worth saying out loud, and worth saying differently from a
    // version that is merely old.
    return null;
  }
}

// `note` is whatever the caller is actually doing — the URL it came up on, or
// the fact that this was a build rather than a boot.
export function banner(note = '', version = readVersion()) {
  const stamp = ['v' + (version ?? '?'), note].filter(Boolean).join('  ·  ');
  return `${ART.replace(/\n$/, '')}\n  ${stamp}\n`;
}

// `node server/banner.js "some note"` — how restart.sh gets one without
// duplicating the art in a heredoc that would then drift from this file.
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(HERE, 'banner.js')) {
  console.log(banner(process.argv[2] ?? ''));
}
