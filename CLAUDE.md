# Notes for Claude

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

Two things that worktree does differently: its `data.db` is a symlink to the
real database at the repo root, so only one dev server may own it at a time;
and because there is now a single place to work, parallel sessions will tread
on each other. Run them one at a time, or branch off `nightly` deliberately.

## House rules

- **Tuning constants live at the top of their module** (`src/main.js`,
  `src/blob-canvas.js`, `src/locations.js`) and are documented in
  ARCHITECTURE.md. Change the constant, then update the prose that explains it.
- **Comments explain why, not what.** The existing ones are written to be read
  in a year; match that register rather than annotating the obvious.
- **`npm test`** before you call something done.
- **Never commit personal data.** `data.db`, `import/*` and
  `src/imported-cells.json` are real location history and are gitignored —
  check `git status` before staging.
