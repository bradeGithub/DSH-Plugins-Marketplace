#!/bin/sh
# Install Git Hooks (Linux / macOS)
# Usage: bash scripts/install-hooks.sh
# Copies scripts/hooks/* hooks into .git/hooks/ and makes them executable.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$SCRIPT_DIR/hooks"
# worktree 下 .git 是文件而非目录；hooks 共享主仓 git-common-dir
DST="$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)/hooks"

if [ ! -d "$DST" ]; then
  echo "error: .git/hooks not found; run from repository root" >&2
  exit 1
fi

HOOKS="pre-commit commit-msg pre-push"
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
