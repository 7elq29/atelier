#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  # shellcheck source=scripts/ensure-atelier-electron-mac.sh
  source scripts/ensure-atelier-electron-mac.sh
fi
exec electron-vite dev "$@"
