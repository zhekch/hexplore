# Notes for Claude

**Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing anything non-trivial.**
It is long, and it is the reason most of this code looks the way it does — the
hex grid maths, the blob rendering pipeline, the level crossfades, the security
model, and a number of approaches that were tried and abandoned for reasons
that are not visible from the code alone.

[README.md](README.md) is written for people using the app, not working on it.
Keep it that way: implementation detail belongs in ARCHITECTURE.md.

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
