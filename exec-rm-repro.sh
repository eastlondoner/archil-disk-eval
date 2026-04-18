#!/usr/bin/env bash
# Minimal repro: `disk exec` cannot unlink files on the Archil mount plane.
#
# Expected: all three operations succeed (the mount at /mnt/archil is rw).
# Actual:   create and overwrite succeed; rm fails with "Read-only file system".
#
# Usage:
#   export ARCHIL_API_KEY=key-...
#   export ARCHIL_REGION=aws-eu-west-1        # whichever region your key is in
#   export DISK_ID=dsk-000000000000c9d3       # any existing disk with an rw mount
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

run "echo hello > /mnt/archil/$FILE"      # create    — works
run "cat /mnt/archil/$FILE"               # read      — works
run "echo overwritten > /mnt/archil/$FILE" # overwrite — works
run "rm -v /mnt/archil/$FILE"             # delete    — FAILS: Read-only file system
run "ls -la /mnt/archil/$FILE"            # still there
