#!/usr/bin/env bash
# node-pty prebuilds ship spawn-helper without +x (microsoft/node-pty#850); posix_spawnp fails if load falls back to prebuilds.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PTY="$ROOT/node_modules/node-pty"
if [[ ! -d "$PTY" ]]; then
  exit 0
fi
while IFS= read -r -d '' helper; do
  chmod +x "$helper"
done < <(find "$PTY" -name spawn-helper -print0 2>/dev/null)
