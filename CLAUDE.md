# Notes for Claude

**Work in the `nightly` worktree. Do not create a new one.**
If you are not already inside `.claude/worktrees/nightly`, enter it —
`EnterWorktree` takes an existing worktree by `path`, and that is the only
worktree this project keeps. Never call it with a `name`; that makes the
per-task worktrees this setup exists to avoid. See [Where work
happens](#where-work-happens).

## Layout

Three folders under one repo root, and the repo root is not any of them:

- **`Sporra-webserver/`** — the web app and its Node/SQLite server. **npm runs
  here, not at the root**: `package.json`, `node_modules/`, `data.db` and the
  test suite all live inside this folder.
- **`Sporra-IOS/`**, **`Sporra-macOS/`** — the two native apps.

`ARCHITECTURE.md`, `CLAUDE.md` and `LICENSE` sit at the root because they
describe all three. Paths in this file are written from the root.

The two apps are deliberately the same program either side of what the platforms
actually differ about. Each has a README; the macOS one is written as a diff
against the iOS one and is the place that explains what a Mac cannot promise.
**A change to the shared shape of the app usually belongs in both.**

They share more than a shape: `Sporra-IOS/Tools/gen-*-vectors.mjs` import
straight out of `Sporra-webserver/src/` to generate the golden vectors that
hold `SporraCore`'s Swift maths to the JavaScript that defines it, and
`Sporra-webserver/scripts/test/photos.mjs` reads the iOS Swift sources to
check both halves of the photo bridge still agree on the same strings. **Those
paths cross folders. Moving a folder breaks them silently** — the Swift still
compiles and the site still builds.

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything non-trivial.**
It is long, and it is the reason most of this code looks the way it does — the
hex grid maths, the blob rendering pipeline, the level crossfades, the security
model, and a number of approaches that were tried and abandoned for reasons
that are not visible from the code alone.

The READMEs — [the root one](README.md) for orientation and
[the webserver's](Sporra-webserver/README.md) for using the app — are written
for people using it, not working on it. Keep them that way: implementation
detail belongs in ARCHITECTURE.md.

## Where work happens

Two checkouts, both long-lived, and no others:

- **`main`**, at the repo root — the branch that ships. Nothing is developed here.
- **`nightly`**, at `.claude/worktrees/nightly` — where every change is made.

**Do not create a worktree per task.** Enter the existing one by path and commit
there. A branch per change left eleven stale worktrees and 337MB of duplicated
`node_modules` behind, for work that had been merged days earlier; the cleanup
cost more than the isolation was worth.

Landing `nightly` on `main` is the user's call, not yours — leave the merge to
them. Afterwards `nightly` gets `git merge main` so the two never drift.

That worktree's `Sporra-webserver/data.db` is a symlink to the real database
at `Sporra-webserver/data.db` in the main checkout, so only one dev server may
own it at a time. One job runs at a time here; two sessions sharing the worktree
would tread on each other.

## House rules

- **Tuning constants live at the top of their module**
  (`Sporra-webserver/src/main.js`, `.../src/blob-canvas.js`,
  `.../src/locations.js`) and are documented in ARCHITECTURE.md. Change the
  constant, then update the prose that explains it.
- **Comments explain why, not what.** The existing ones are written to be read
  in a year; match that register rather than annotating the obvious.
- **`npm test`** before you call something done — from inside
  `Sporra-webserver/`, which is where `package.json` is.
- **The Swift side has tests too, and they do run here.** `SporraCore` holds
  the port of the blob pipeline and pins it to the JavaScript with generated
  vectors, so anything that moves a shaping constant should be checked against
  it. Two things about this machine are needed to get there, and neither is
  discoverable from the error it gives you:

  ```sh
  cd Sporra-IOS/SporraCore
  DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
    swift test --scratch-path ~/.cache/sporra-swift
  ```

  - **`DEVELOPER_DIR`**, because `xcode-select -p` points at
    `/Library/Developer/CommandLineTools`, which has no `metal` — the package
    compiles a Metal shader, so without this it fails with *unable to spawn
    process 'metal'*. Only **Xcode beta** is installed; there is a simulator
    (iOS 27) but no `metal` on the default toolchain path.
  - **`--scratch-path` outside the repo**, because building into
    `.claude/worktrees/…/.build` makes codesign refuse the test bundle —
    *resource fork, Finder information, or similar detritus not allowed*.
    Clearing xattrs does not fix it; the bundle is rebuilt with them. Any
    scratch directory outside the worktree does.

  Changing the shaping constants also means regenerating the vectors:
  `node Sporra-IOS/Tools/gen-blob-vectors.mjs`, and updating
  `BlobShaping.swift` to match — the test that compares the two is what catches
  a port that has quietly drifted from the JavaScript.
- **Move the version, every time.** Two numbers are shown in Settings and both
  exist to answer *which build am I actually looking at* — the question every
  confusing hour on this project has turned out to be. A number that does not
  move is worse than none, because it rules out the very thing that is wrong.
  - `SERVER_VERSION` in `Sporra-webserver/server/index.js` — patch bump for a
    fix, minor for anything a user would notice.
  - `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in
    `Sporra-IOS/Sporra.xcodeproj/project.pbxproj` — whenever anything under
    `Sporra-IOS/` changes. The build number goes up every time; the marketing
    version follows the same patch/minor rule and **stays below 1.0**, which is
    the honest description of where this is.

    Both configurations, Debug and Release, carry each setting: change one and
    the app reports a different version depending on how it was built.
  - The same two settings in
    `Sporra-macOS/Sporra.xcodeproj/project.pbxproj` — whenever anything
    under `Sporra-macOS/` changes, by the same rules and in both
    configurations. **The two apps version independently.** They ship
    separately, they are built separately, and the number is there to answer
    *which build am I looking at* — a Mac that borrowed the phone's number
    would answer a question nobody asked. A change to only one project moves
    only that project's version.
- **Never commit personal data.** `Sporra-webserver/data.db`,
  `Sporra-webserver/import/*` and `Sporra-webserver/src/imported-cells.json`
  are real location history and are gitignored — check `git status` before
  staging.
