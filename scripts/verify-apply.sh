#!/usr/bin/env bash
# Clean-room smoke for `make apply`: deploy the patches into a fresh dir and
# assert every relative import in server.ts resolves. Catches the class of
# bug where apply.sh ships server.ts but forgets a runtime sibling under lib/.
#
# We can't fully air-gap the smoke (the upstream plugin pulls @mcp/sdk +
# discord.js via `bun install`), so the smoke borrows the real install's
# node_modules via symlink. The patches are deployed into a mktemp dir, so
# nothing in the real install is touched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.0.4}"
PLUGIN_DIR="${PLUGIN_DIR:-$HOME/.claude/plugins/cache/claude-plugins-official/discord/$PLUGIN_VERSION}"

if [[ ! -d "$PLUGIN_DIR" ]]; then
  echo "error: plugin dir not found: $PLUGIN_DIR" >&2
  echo "       smoke needs the real install for node_modules + package.json." >&2
  exit 2
fi
if [[ ! -d "$PLUGIN_DIR/node_modules" ]]; then
  echo "error: $PLUGIN_DIR/node_modules missing — boot the bot once or 'bun install' there." >&2
  exit 2
fi

SMOKE="$(mktemp -d)"
trap 'rm -rf "$SMOKE"' EXIT

# Minimal scaffold. node_modules is symlinked (heavy, read-only). package.json
# is part of the runtime contract; copy so the smoke is self-contained and
# can't mutate the real install.
ln -s "$PLUGIN_DIR/node_modules" "$SMOKE/node_modules"
cp "$PLUGIN_DIR/package.json" "$SMOKE/package.json"
[[ -f "$PLUGIN_DIR/.mcp.json" ]] && cp "$PLUGIN_DIR/.mcp.json" "$SMOKE/.mcp.json"

PLUGIN_DIR="$SMOKE" PLUGIN_VERSION="$PLUGIN_VERSION" \
  bash "$REPO_DIR/scripts/apply.sh" >/dev/null

mkdir -p "$SMOKE/.smoke"
if ! bun build "$SMOKE/server.ts" --target=bun --outdir="$SMOKE/.smoke" \
    >"$SMOKE/.smoke/build.log" 2>&1; then
  echo "smoke FAIL: bun build could not resolve $SMOKE/server.ts" >&2
  cat "$SMOKE/.smoke/build.log" >&2
  exit 1
fi

echo "smoke ok: server.ts + lib/ resolve cleanly from a fresh apply"
