# Split picker keyboard navigation

## Reproduction

1. Create enough app notes for the Ctrl+X 2 picker to overflow vertically.
2. Open the picker with Ctrl+X, then 2.
3. Press ArrowDown until the selected row moves beyond the visible results.
4. Current failure: selection changes, but the results viewport does not
   scroll, so the selected row is hidden.
5. Press Ctrl+N or Ctrl+P.
6. Current failure: neither key moves the selection.

The supplied screenshot shows the overflowing split picker and its fixed
results viewport. No main-process log event exists for picker-only keyboard
selection; the failing DOM state is the relevant runtime evidence.

## Expected user flow

1. ArrowDown and Ctrl+N move selection down one row.
2. ArrowUp and Ctrl+P move selection up one row.
3. Selection remains clamped to the first and last result.
4. Every keyboard selection change scrolls the selected row into the visible
   portion of the result list.
5. The shared behavior applies to both Ctrl+X 2 and Ctrl+X B pickers.

## Expected UI

No visual redesign. Reuse the existing `.cp-results`, `.cp-item`, and
`.cp-item.selected` treatment from `Features/UI-Design/mocks/index.html`.
Only keyboard behavior and scroll position change.

## Done criteria

- [ ] A real Electron E2E reproduces the hidden selected row before the fix.
- [ ] Ctrl+N/Ctrl+P and arrow keys move selection as specified.
- [ ] The selected row stays within `.cp-results` bounds after navigation.
- [ ] Enter and Escape behavior remain unchanged.
- [ ] `npm run build` and `npm run test:e2e:affected -- --base main` pass,
      except independently confirmed pre-existing failures.
