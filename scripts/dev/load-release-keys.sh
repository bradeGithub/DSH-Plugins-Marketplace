#!/bin/sh
# Load release signing keys into ssh-agent (Linux/macOS).
# Run once per boot/login — the agent holds keys in memory until restart.
# macOS tip: `ssh-add --apple-use-keychain ~/.ssh/dsh-release-1` stores the
# passphrase in Keychain once, after which plain `ssh-add` loads it forever
# (no per-boot prompt). Linux: your desktop keyring serves the same role.
set -e

for k in dsh-release-1 dsh-release-2; do
  f="$HOME/.ssh/$k"
  if [ -f "$f" ]; then
    ssh-add "$f"
  else
    echo "skip $k (not found)"
  fi
done
