#!/bin/bash
# Run the HexploreCore tests — the pure maths, on the Mac, in about a second.
#
#   HexPlore/Tools/test-core.sh
#
# Two workarounds are baked in, both of which cost an afternoon to find:
#
#   DEVELOPER_DIR — `xcode-select` on this machine points at the Command Line
#   Tools rather than at Xcode, so `swift test` would otherwise fail to find an
#   iOS toolchain. Setting the variable overrides that for this command only and
#   needs no sudo. To fix it globally instead:
#       sudo xcode-select -s /Applications/Xcode-beta.app
#
#   --scratch-path — the repo lives under ~/Documents, which is synced, and the
#   sync attaches extended attributes to everything. Codesigning a test bundle
#   refuses to touch a file carrying them ("resource fork, Finder information,
#   or similar detritus not allowed"), so the build products go somewhere that
#   is not synced.

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package="$here/../HexploreCore"

# Prefer a release Xcode, fall back to the beta, and leave whatever the user
# already set alone.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  for candidate in /Applications/Xcode.app /Applications/Xcode-beta.app; do
    if [[ -d "$candidate" ]]; then
      export DEVELOPER_DIR="$candidate/Contents/Developer"
      break
    fi
  done
fi

scratch="${HEXPLORE_SCRATCH:-$HOME/Library/Caches/HexploreCore-build}"
mkdir -p "$scratch"

echo "Xcode:   ${DEVELOPER_DIR:-<xcode-select default>}"
echo "Scratch: $scratch"
echo

cd "$package"
exec swift test --scratch-path "$scratch" "$@"
