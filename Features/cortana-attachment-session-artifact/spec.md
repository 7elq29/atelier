# Cortana image attachments: use session artifacts, not terrablob URLs

## Bug

User attaches a screenshot in a Cortana session. Atelier uploads it successfully
(`/api/v1/files/upload` → session artifact `image.png`), then appends only a
`terrablob_url` into `user_input`. Cortana replies that it cannot access the
screenshot — the URL is auth-gated and is not a multimodal content block.

Verified live (session `d2ef9a89`, 2026-10-01T21:00:41, `attachmentCount: 1`):
file list returns `image.png`; chat completed; Cortana asked the user to
describe the image instead.

## User flow

1. User pastes/attaches an image in a Cortana composer and sends.
2. Atelier uploads the file into that session’s artifacts.
3. The chat prompt tells Cortana the **artifact filename/path** and to open it
   with session file tools — not to fetch an external URL.
4. Cortana can inspect the file (same store as Diff panel / `files/list`).

## Done criteria

- [x] Upload failures surface as a harness error (no silent send without the file).
- [x] Successful upload logs filename + path; prompt references session artifact
      name/path, not terrablob URLs as the only handle.
- [x] `tsc -p tsconfig.node.json` clean.
