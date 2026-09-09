# Daily Big Three — edit in Atelier

## User flow

1. When the daily note has Big Three values, the Daily Notes right panel shows the existing
   **Today’s Focus** block with an **Edit** action.
2. Clicking **Edit** replaces the read-only list with three numbered, single-line fields,
   prefilled from `DailyNote.bigThree`.
3. **Save** trims the three values, drops empty slots, immediately updates the read-only list,
   and persists the values into the vault note’s `## 🗓️ Daily Big Three` section.
4. **Cancel** or Escape restores the saved values without writing. Enter in a field saves.
5. External file updates continue to refresh the read-only values through the existing daily-note
   watcher. If an external update arrives while editing, the draft stays local until Save or
   Cancel; Save uses the main process’s existing merge/write path so unrelated tasks and sections
   are preserved.

## UI

- Reference mock: `Features/UI-Design/daily-notes.css` defines `.dn-focus-block`,
  `.dn-focus-heading`, and `.dn-focus-list` for the read-only **Today’s Focus** block.
- The mock does not define an edit state. The production treatment will keep the same block and
  heading, put the existing small ghost-button treatment in the heading row, and use the existing
  `.input` plus small Save/Cancel buttons for three compact numbered rows.
- Notes without a Big Three keep the existing layout with no focus block. Creating the section is
  outside this update-existing-values feature.

## Data

- Source of truth remains the configured Obsidian daily note.
- `useDailyNote.updateBigThree(values)` performs the optimistic renderer update and uses the
  existing debounced `writeDailyNote` IPC path.
- Serialization remains canonical:

  ```markdown
  ## 🗓️ Daily Big Three

  * First priority
  * Second priority
  * Third priority
  ```

- No new database table or renderer-only persistence.

## Done criteria

- `npm run build` is clean.
- A real Electron E2E opens a seeded daily note, edits all three priorities, saves, verifies the
  rendered list, verifies the vault Markdown and unrelated tasks/Notes content are preserved,
  then relaunches and verifies the three saved values reload.
- The E2E also verifies Cancel does not persist a draft.
- Screenshot: `e2e-artifacts/daily-big-three-edit.png`, personally compared with the mock’s
  read-only focus block and existing production input/button treatments.
- Run all daily-notes specs mapped by `e2e/TEST_CATEGORIES.md`.
