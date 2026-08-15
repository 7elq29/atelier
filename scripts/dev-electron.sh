#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export ATELIER_DEV=1
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi
if [[ "$(uname -s)" == "Darwin" ]]; then
  # shellcheck source=scripts/ensure-atelier-electron-mac.sh
  source scripts/ensure-atelier-electron-mac.sh
fi
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  ATELIER DEV — look for [DEV] in the window title bar"
echo "  Uses live Vite reload from this worktree (not packaged app)"
echo "  If UI looks stale, quit other Atelier windows from the Dock"
echo "════════════════════════════════════════════════════════════"
echo ""
exec electron-vite dev "$@"
