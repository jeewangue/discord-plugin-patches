#!/usr/bin/env bash
# Compare the patched plugin tree with the cached install. Iterates the
# deploy manifest (scripts/deploy-manifest.sh) so apply + drift always check
# the same file set. Exits 0 if every file matches, 1 if any drift is found,
# 2 if the install dir is missing entirely. Prints unified diffs on drift.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.0.4}"
PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.claude/plugins/cache/claude-plugins-official/discord/$PLUGIN_VERSION}"

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "error: plugin dir not found: $PLUGIN_DIR" >&2
  exit 2
fi

drift=0

while IFS= read -r rel; do
  src="$REPO_DIR/$rel"
  dst="$PLUGIN_DIR/$rel"
  if [[ ! -f "$dst" ]]; then
    echo "missing in install: $dst"
    drift=1
    continue
  fi
  if ! cmp -s "$src" "$dst"; then
    echo "drift: $src vs $dst"
    diff -u "$dst" "$src" || true
    drift=1
  fi
done < <(bash "$REPO_DIR/scripts/deploy-manifest.sh")

if [[ "$drift" -eq 0 ]]; then
  echo "in sync: every file in the deploy manifest matches the install"
  exit 0
fi
exit 1
