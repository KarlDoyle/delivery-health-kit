#!/usr/bin/env bash
# E2E smoke — drives the BUILT CLI (dist/), not the TS sources, so it proves
# what a user actually installs. Mirrored in CI as the separate `e2e` job
# (relay pattern): unit gates first, this only if they pass.
#
# Checks the critical paths: help, demo (the never-empty first run), report,
# digest, scorecard — each must exit 0 and contain its headline content.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -f dist/index.js ]; then
  echo "e2e: dist/index.js missing — run \`pnpm build\` first." >&2
  exit 1
fi

run() {
  local label="$1" expect="$2"; shift 2
  local out
  out="$(node dist/index.js "$@" --quiet 2>/dev/null)"
  if ! printf '%s' "$out" | grep -qF "$expect"; then
    echo "e2e FAIL: $label — expected output to contain: $expect" >&2
    exit 1
  fi
  echo "e2e ok: $label"
}

# --help exits 0 and shows usage.
node dist/index.js --help | grep -qF "Delivery Health Kit" && echo "e2e ok: --help"

run "demo"      "This is sample data"                      demo
run "demo core4" "## Speed"                                demo
run "report"    "# Delivery Health — Team Atlas"           report
run "report badge" "team-level only"                       report
run "digest"    "# Reliability Digest — Team Atlas"        digest
run "digest cfr" "incident-linked"                         digest
run "scorecard" "# Delivery Scorecard"                     scorecard
run "sheets tsv" "deploy_freq_per_day"                     report --format sheets

echo "e2e: all smoke paths green."
