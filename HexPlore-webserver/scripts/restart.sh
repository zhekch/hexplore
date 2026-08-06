#!/bin/bash
# Pull, build, and restart the server as a detached process.
#
#   HexPlore-webserver/scripts/restart.sh              port 3001
#   HexPlore-webserver/scripts/restart.sh --no-pull    skip the git pull
#   PORT=8080 HexPlore-webserver/scripts/restart.sh    somewhere else
#
# Run it from anywhere; it finds its own folder. That is the whole point of it
# existing. The command this replaces hardcoded the repo path four times, and by
# the time it was retired every one of them was wrong: this folder has been
# renamed more than once and moved a level deeper, and none of those are the
# kind of change anyone thinks to grep an old shell command for.
#
# The failure is silent in the worst way. `git pull` and `npm run build` succeed
# in whatever directory you were already standing in, so only the `node` on the
# end fails — after everything before it has reported success.
#
# So there is one path in this file, on the line below, and it is derived rather
# than written down. Everything after the `cd` is relative, and the next rename
# costs nothing.
#
# Three things this does differently from the command it replaces, each of which
# was a real failure rather than a tidy-up:
#
#   It kills by port, not `killall node`. That killall took down every node
#   process on the machine — other projects' dev servers, editor tooling, MCP
#   servers — to restart one of them.
#
#   It builds before it kills. A chain that stopped the server first and then
#   failed to build left nothing running, which is the one outcome a restart
#   should never produce.
#
#   It backgrounds only the server. Written as `a && b && c & disown`, the `&`
#   applies to the entire list, so the pull and the build were detached too and
#   their output went nowhere: a failed build looked exactly like a good one.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$here/.."

port="${PORT:-3001}"
pull=1
[[ "${1:-}" == "--no-pull" ]] && pull=0

if [[ $pull == 1 ]]; then
  echo "→ pulling"
  git pull --ff-only
fi

echo "→ installing"
npm install --silent

echo "→ building"
npm run build

# Only now is it safe to drop the running server: everything that could have
# failed has already failed, with the old one still answering.
running="$(lsof -ti "tcp:$port" || true)"
if [[ -n "$running" ]]; then
  echo "→ stopping $(echo "$running" | tr '\n' ' ')"
  kill $running
  # Wait for the socket rather than guessing at a sleep: SQLite is opened on
  # boot and two servers must never hold data.db at once.
  for _ in $(seq 1 40); do
    lsof -ti "tcp:$port" >/dev/null 2>&1 || break
    sleep 0.25
  done
  if lsof -ti "tcp:$port" >/dev/null 2>&1; then
    echo "   still holding port $port after 10s — not starting a second one" >&2
    exit 1
  fi
fi

echo "→ starting on $port"
PORT="$port" nohup npm start > server.log 2>&1 < /dev/null &
disown

# nohup succeeding means the process launched, not that it works. Anything that
# fails at boot — a port taken, a database it cannot open — does so in the first
# second, and reporting a healthy restart that is not one wastes the next hour.
for _ in $(seq 1 40); do
  curl -sf -o /dev/null "http://127.0.0.1:$port/" && break
  sleep 0.25
done

if curl -sf -o /dev/null "http://127.0.0.1:$port/"; then
  echo "✓ up on http://localhost:$port (pid $(lsof -ti "tcp:$port" | head -1))"
else
  echo "✗ did not come up — last of server.log:" >&2
  tail -20 server.log >&2
  exit 1
fi
