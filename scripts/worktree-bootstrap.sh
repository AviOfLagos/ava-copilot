#!/bin/sh
# Prepares a git worktree of this repo for a Wave 2 stream: the git-ignored model files the build
# needs, the local env file, dependencies, and the locale merge driver.
# Usage: sh scripts/worktree-bootstrap.sh <worktree-path>
set -eu
MAIN="$(cd "$(dirname "$0")/.." && pwd)"
TREE="${1:?worktree path}"
for dir in public/wake public/voice; do
  if [ -d "$MAIN/$dir" ] && [ ! -d "$TREE/$dir" ]; then mkdir -p "$TREE/$dir" && cp -R "$MAIN/$dir/." "$TREE/$dir/"; fi
done
[ -f "$MAIN/.env.local" ] && [ ! -f "$TREE/.env.local" ] && cp "$MAIN/.env.local" "$TREE/.env.local"
git -C "$MAIN" config merge.jsonunion.name "Union of JSON keys (locales)"
git -C "$MAIN" config merge.jsonunion.driver "node scripts/json-union-merge.mjs %O %A %B"
cd "$TREE" && snare shield check . >/dev/null && command pnpm install --frozen-lockfile --silent
echo "Ready: $TREE"
