# Notes for Claude

**Work in the `nightly` worktree. Do not create a new one.**
If you are not already inside `.claude/worktrees/nightly`, enter it —
`EnterWorktree` takes an existing worktree by `path`, and that is the only
worktree this project keeps. Never call it with a `name`; that makes the
per-task worktrees this setup exists to avoid. See [Where work
happens](#where-work-happens).

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything non-trivial.**
It is long, and it is the reason most of this code looks the way it does — the
hex grid maths, the blob rendering pipeline, the level crossfades, the security
model, and a number of approaches that were tried and abandoned for reasons
that are not visible from the code alone.

[README.md](README.md) is written for people using the app, not working on it.
Keep it that way: implementation detail belongs in ARCHITECTURE.md.

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

That worktree's `data.db` is a symlink to the real database at the repo root,
so only one dev server may own it at a time. One job runs at a time here; two
sessions sharing the worktree would tread on each other.

## House rules

- **Tuning constants live at the top of their module** (`src/main.js`,
  `src/blob-canvas.js`, `src/locations.js`) and are documented in
  ARCHITECTURE.md. Change the constant, then update the prose that explains it.
- **Comments explain why, not what.** The existing ones are written to be read
  in a year; match that register rather than annotating the obvious.
- **`npm test`** before you call something done.
- **Move the version, every time.** Two numbers are shown in Settings and both
  exist to answer *which build am I actually looking at* — the question every
  confusing hour on this project has turned out to be. A number that does not
  move is worse than none, because it rules out the very thing that is wrong.
  - `SERVER_VERSION` in `server/index.js` — patch bump for a fix, minor for
    anything a user would notice.
  - `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` in
    `HexPlore-IOS/HexPlore.xcodeproj/project.pbxproj` — whenever anything under
    `HexPlore-IOS/` changes. The build number goes up every time; the marketing
    version follows the same patch/minor rule and **stays below 1.0**, which is
    the honest description of where this is.

    Both configurations, Debug and Release, carry each setting: change one and
    the app reports a different version depending on how it was built.
- **Never commit personal data.** `data.db`, `import/*` and
  `src/imported-cells.json` are real location history and are gitignored —
  check `git status` before staging.
