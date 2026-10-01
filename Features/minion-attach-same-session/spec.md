# Minion attach — reopen same task, don't spawn a twin

## Bug

Attaching a Minion link sometimes left users with a **second** sidebar
session (or an error that pushed them to Create), instead of focusing /
reopening the existing Atelier row for that task UUID.

## Expected

1. Paste `https://minion.uberinternal.com/v2?taskId=<uuid>` (or bare UUID,
   or any URL that embeds a task UUID).
2. **Attach Session**:
   - Task already open → focus that row (no second session, no createtask).
   - Task closed in Atelier → reopen + reconnect (session.resumed).
   - Task never in Atelier (or fully deleted) → attach via gettask, one new
     row, transcript says **Attached to existing…** (not “spinning up a
     DevPod”).
3. Parser accepts path-style links and loose `taskId=` embeds, not only
   `?taskId=` on `/v2`.

## Done

- [x] `parseMinionTaskId` covers path + embedded UUID shapes
- [x] Already-open attach returns the existing session (select/focus)
- [x] Soft-deleted (cleanup in flight) waits then attaches; no hard “deleted” dead-end when purge finished
- [x] E2E: attach shows Attached ack and never the create DevPod line
- [x] `npm run build` + `npx playwright test e2e/minion-session.spec.ts --workers=1`
