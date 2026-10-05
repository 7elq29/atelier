# Bug: Cortana/Minion missing from Ctrl+X B buffer switcher

## Reproduce

1. Create active Cortana and/or Minion sessions (sidebar rows visible).
2. Press **Ctrl+X**, then **B**.
3. Buffer switcher lists claude-code and terminal sessions but not Cortana or Minion.

Root cause: `bufferSwitcherItems` in `App.tsx` only iterates `mode === 'claude-code'` for the Sessions category.

## Done

- [x] Cortana and Minion active sessions appear under **Sessions** in Ctrl+X B (same as claude-code).
- [x] `e2e/buffer-switcher.spec.ts` covers Cortana + Minion rows in the switcher.
- [x] `npm run test:e2e:affected -- --base main` (buffer-switcher spec)
