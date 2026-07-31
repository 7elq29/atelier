#!/usr/bin/env bash
# Run Gardenia's dev build with full functionality from a plain terminal.
#
# Why this exists: the Claude Agent SDK harness authenticates by inheriting
# whatever's in the shell's environment (ANTHROPIC_BASE_URL, etc.) — but those
# vars are only auto-injected into a Claude Code *session's* environment by
# aifx. The `claude` CLI itself doesn't need them in your shell because it
# reads them straight out of ~/.claude/settings.json's "env" block. This
# script re-exports that same config into a plain terminal so `npm run dev`
# behaves the same way a Claude Code session does.
#
# Usage:
#   ./scripts/dev-full.sh                  # SDK/chat features only
#   GARDENIA_VAULT_ROOT=/path/to/vault ./scripts/dev-full.sh   # + Obsidian integration
#
# Do NOT set GARDENIA_VAULT_ROOT to your real Obsidian vault unless you've
# already verified this build's Obsidian sync against a disposable copy —
# it does real file writes.

set -euo pipefail

SETTINGS_FILE="$HOME/.claude/settings.json"
if [ ! -f "$SETTINGS_FILE" ]; then
  echo "error: $SETTINGS_FILE not found — can't load ANTHROPIC_*/CLAUDE_CODE_* env config." >&2
  echo "       Falling back to whatever's already in your shell environment." >&2
else
  # Export every key in settings.json's "env" block into this shell.
  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    export "$key=$value"
  done < <(python3 -c "
import json
with open('$SETTINGS_FILE') as f:
    env = json.load(f).get('env', {})
for k, v in env.items():
    print(f'{k}={v}')
")
  echo "Loaded $(python3 -c "import json; print(len(json.load(open('$SETTINGS_FILE')).get('env', {})))") env vars from $SETTINGS_FILE"
fi

# Node is only available via nvm in this environment, not on default PATH.
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null
else
  echo "warning: ~/.nvm/nvm.sh not found — assuming node is already on PATH." >&2
fi

if [ -n "${GARDENIA_VAULT_ROOT:-}" ]; then
  echo "Obsidian integration enabled: GARDENIA_VAULT_ROOT=$GARDENIA_VAULT_ROOT"
else
  echo "Obsidian integration disabled (no GARDENIA_VAULT_ROOT set) — Daily Notes panel will show 'No vault configured'."
fi

exec npm run dev
