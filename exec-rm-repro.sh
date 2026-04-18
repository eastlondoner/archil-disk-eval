#!/usr/bin/env bash
# Demonstrates the `disk exec` write/delete asymmetry:
#
#   1. create + overwrite work without ceremony
#   2. `rm` fails with EROFS out of the box
#   3. `archil checkout <parent-folder>` (preinstalled at /usr/local/bin/archil
#      inside the exec container) unlocks deletes — `rm` then succeeds
#
# Per Archil, the explicit-checkout requirement is being removed.
#
# Usage:
#   export ARCHIL_API_KEY=key-...
#   export ARCHIL_REGION=aws-eu-west-1
#   export DISK_ID=dsk-...
#   ./exec-rm-repro.sh
#
# Tested against disk@0.8.8.

set -u
: "${ARCHIL_API_KEY:?set ARCHIL_API_KEY}"
: "${ARCHIL_REGION:?set ARCHIL_REGION}"
: "${DISK_ID:?set DISK_ID}"

FILE="repro-$(date +%s).txt"

run() {
  echo
  echo "\$ $*"
  npx --yes disk@0.8.8 exec "$DISK_ID" "$@"
  echo "-> exit=$?"
}

# Setup
run "echo hello > /mnt/archil/$FILE"        # create    — works
run "echo overwritten > /mnt/archil/$FILE"  # overwrite — works

# Without checkout: rm fails
run "rm -v /mnt/archil/$FILE"               # delete    — FAILS EROFS
run "ls -la /mnt/archil/$FILE"              # still present

# With archil checkout on the parent folder: rm succeeds
run "archil checkout /mnt/archil && rm -v /mnt/archil/$FILE"
run "ls -la /mnt/archil/$FILE 2>&1 || echo 'gone'"
