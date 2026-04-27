#!/usr/bin/env bash
# Copy the patched plugin tree onto the cached claude-plugins-official/discord
# install. The deploy file list comes from scripts/deploy-manifest.sh —
# adding a new runtime lib/*.ts is automatic, no edit needed here. Restart
# Claude Code (or `/reload-plugins`) to pick up the changes.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.0.4}"
PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.claude/plugins/cache/claude-plugins-official/discord/$PLUGIN_VERSION}"

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "error: plugin dir not found: $PLUGIN_DIR" >&2
  echo "       set PLUGIN_DIR or PLUGIN_VERSION env var if your install is elsewhere." >&2
  exit 1
fi

while IFS= read -r rel; do
  src="$REPO_DIR/$rel"
  dst="$PLUGIN_DIR/$rel"
  if [[ ! -f "$src" ]]; then
    echo "error: manifest names $rel but $src does not exist" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "applied: $src -> $dst"
done < <(bash "$REPO_DIR/scripts/deploy-manifest.sh")

echo "restart Claude Code or run /reload-plugins to pick up changes."
