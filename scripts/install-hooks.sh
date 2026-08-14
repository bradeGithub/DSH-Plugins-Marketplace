#!/bin/sh
# Install Git Hooks (Linux / macOS)
# Usage: bash scripts/install-hooks.sh
# Copies scripts/hooks/* hooks into .git/hooks/ and makes them executable.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$SCRIPT_DIR/hooks"
DST="$REPO/.git/hooks"

if [ ! -d "$DST" ]; then
  echo "error: .git/hooks not found; run from repository root" >&2
  exit 1
fi

HOOKS="pre-commit commit-msg"
for h in $HOOKS; do
  if [ -f "$SRC/$h" ]; then
    cp "$SRC/$h" "$DST/$h"
    chmod +x "$DST/$h"
    echo "installed hook: $h"
  fi
done

echo
echo "Git Hooks installed."
echo "To skip (not recommended): git commit --no-verify"
echo "Tune severity in .hooksrc (emojiLevel=error|warn|off)"
