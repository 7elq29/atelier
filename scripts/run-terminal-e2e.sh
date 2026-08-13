#!/usr/bin/env bash
# Run terminal PTY e2e from a real macOS terminal (PTY-capable). Writes a log for CI/agents to read.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  source "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null 2>&1 || true
fi
mkdir -p e2e-artifacts
LOG=e2e-artifacts/terminal-pty-run.log
{
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) terminal-pty e2e ==="
  if ! script -q /dev/null /bin/zsh -c 'echo pty-probe-ok' 2>/dev/null; then
    echo "FATAL: this shell cannot allocate a PTY (openpty). Run from Terminal.app/iTerm, not a PTY-less sandbox."
    exit 1
  fi
  npm run build
  npx playwright test e2e/terminal-pty.spec.ts
  echo "PLAYWRIGHT_EXIT:$?"
} 2>&1 | tee "$LOG"
echo "PLAYWRIGHT_DONE" >>"$LOG"
