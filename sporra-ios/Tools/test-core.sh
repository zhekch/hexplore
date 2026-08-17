#!/bin/bash
# Run the SporraCore tests — the maths and the Metal pipeline.
#
#   Sporra-IOS/Tools/test-core.sh          on the Mac, about a second
#   Sporra-IOS/Tools/test-core.sh --ios    on the iOS Simulator, about a minute
#
# The Mac run is the one to use while working: no simulator to boot, no signing,
# no Xcode. The --ios run is the one that proves the code works where it is
# actually going to run — same 34 tests, including the GPU ones against the
# simulator's Metal stack rather than the Mac's.
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
package="$here/../SporraCore"

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

scratch="${SPORRA_SCRATCH:-$HOME/Library/Caches/SporraCore-build}"
mkdir -p "$scratch"

echo "Xcode:   ${DEVELOPER_DIR:-<xcode-select default>}"
echo "Scratch: $scratch"

cd "$package"

if [[ "${1:-}" == "--ios" ]]; then
  shift
  simulator="${SPORRA_SIMULATOR:-iPhone 17 Pro}"
  echo "Where:   iOS Simulator — $simulator"
  echo
  exec xcodebuild test \
    -scheme SporraCore \
    -destination "platform=iOS Simulator,name=$simulator" \
    -derivedDataPath "$scratch/ios" \
    "$@"
fi

echo "Where:   this Mac"
echo
exec swift test --scratch-path "$scratch" "$@"
