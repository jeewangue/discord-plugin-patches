#!/usr/bin/env bash
# Source-of-truth manifest for `make apply`: emits absolute paths of files
# that must land in $PLUGIN_DIR for the patched plugin to run, one per line,
# relative to REPO_DIR. apply.sh and check-drift.sh both consume this so the
# deploy contract lives in exactly one place — adding a new runtime lib file
# is a single edit (or just a new file under lib/) instead of three.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "server.ts"

shopt -s nullglob
for f in "$REPO_DIR"/lib/*.ts; do
  base="$(basename "$f")"
  [[ "$base" == *.test.ts ]] && continue
  echo "lib/$base"
done
shopt -u nullglob
