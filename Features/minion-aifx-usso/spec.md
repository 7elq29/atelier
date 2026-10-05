# Bug: Minion New Session create fails (aifx muttley routing)

## Reproduce

1. Launch Atelier from Dock / Finder (GUI PATH — not a login shell).
2. New Session → Minion → repo `go-code` → prompt e.g. “Are you able to read the content?” → Start Session.
3. Modal shows a red error; no sidebar row. `main.log` has `session:create invoked` with `mode: minion` and **no** `session.created`.

Root cause: `aifx mcp call` auto-detects “service-container” mode under the GUI env and posts to `http://localhost:5436` (muttley). Connection refused → createtask never runs. Same failure with a stripped env:

```bash
env -i HOME="$HOME" USER="$USER" PATH="/usr/bin:/bin" \
  aifx mcp call minion-orchestrator minionorchestrator_gettask \
  --args-file <(echo '{"id":"…"}') -o /tmp/out.json
# → dial tcp 127.0.0.1:5436: connection refused … re-run with --usso
```

With `--usso`, the call hits the public MCP gateway and succeeds (or returns a normal not-found for a fake id).

## Done

- [x] `aifx mcp call` for Minion always passes `--usso` (and logs aifx failures)
- [x] Minion e2e launches Electron with Dock-like sparse `PATH` (not the shell env)
- [x] `npm run build` clean
- [x] `npm run test:e2e:affected -- --base main` (create+attach pass under GUI env)
- [x] Packaged `/Applications/Atelier.app` rebuilt with `--usso`
