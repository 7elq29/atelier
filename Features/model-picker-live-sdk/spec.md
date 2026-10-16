# Model picker uses live SDK `/model` list

## User flow

1. Open a Claude Code session and wait until the session is connected
   (SDK `initializationResult()` has completed).
2. Open the composer model picker (button or `/model` slash entry).
3. The Model section lists exactly the same options Claude Code’s `/model`
   command exposes for this account/org — same `value`s and display names
   from `query.initializationResult().models` (e.g. Default, Opus, Fable,
   Sonnet, Haiku; Mythos when entitlement allows).
4. Choosing a row applies that SDK `value` (alias or wire id) for the next
   turn, same as typing `/model <value>`.
5. Before init completes, a short fallback list may flash; once live models
   arrive, the picker replaces the fallback entirely (no merge with a
   hardcoded generation list).

## UI

- Reuse existing `.picker-pop` / `.picker-item` in Composer.
- Prefer SDK `displayName` as the row label.
- Context badges (`200k` / `400k` / `1M`) are optional — only show when
  known for that id; do not invent badges for alias rows.

## Done criteria

- [x] `resolveModelPickerOptions(live)` returns one row per live SDK model
      when `live.length > 0` (not a hardcoded catalog overlay).
- [x] Fallback catalog (empty live) matches the current `/model` shape
      (default / opus / fable / sonnet / haiku), not Opus 4.8 / Sonnet 5 /
      Mythos 5 generation ids.
- [x] E2E asserts picker options match the session’s live `models_updated`
      list (and old `claude-opus-4-8` catalog rows are gone).
- [x] `npm run build` clean; `npm run test:e2e:affected -- --base main`.
