# Minion session (v1 + chat loop)

## User flow

1. New Session → **Minion** → either:
   - **Create**: repo + required prompt → Start (new DevPod task), or
   - **Attach**: paste a Minion link
     (`https://minion.uberinternal.com/v2?taskId=<uuid>`) or bare task UUID →
     Start (no prompt required). Session id = task UUID; transcript shows an
     attach ack and resumes polling (history seeded, no re-dump).
2. While Start is in flight for a **new** task, the modal shows that DevPod
   setup can take a minute.
3. Chat opens speaking **as Minion**. While DevPod comes up, an ephemeral
   **SETUP** transcript card (same `.conversation-status-card` pattern as Cortana’s
   requesting/compacting cards) tracks **Provision → Boot → Connect** (uTerm
   SETUP: no pod → Provision; worker not linked → Boot; worker `connected`
   handshake → Connect). Boot stays active until the worker socket handshake,
   not merely until `getDevpods` reports `STATE_RUNNING`
   (`runner_url` / task RUNNING alone must not jump to Connect). The card clears
   via uTerm `completeStartup`: first `user_message` on create, or replay finish
   on attach/wake — not merely socket-live or `latest_update`. Real agent updates
   stay as assistant rows; ephemeral “Processing…” lines stay out of the
   transcript. Follow-up steers wait for the new AGENT interaction (event-driven)
   — not a wall-clock timer on stale COMPLETED.
4. Composer follow-ups go to Minion with no transcript ack (Stop/working chrome
   is the in-flight signal).
5. Completion is announced **once**. Follow-ups after complete must not re-dump old
   interactions or re-post “COMPLETED”.
6. Stop cancels. Notify on real replies (`end_turn` + `minion_progress`): OS
   banner when unfocused; in-app toast when focused. Create/cancel stay quiet.
7. Sidebar “working” only while a turn is busy or the remote task is still
   non-terminal. Post-complete / post-steer background polls must not leave the
   execution icon stuck on an idle session.

## Done

- [x] Steer e2e: create → send → busy → cancel
- [x] First-person voice + DevPod progress
- [x] Post-complete follow-ups keep polling for new replies (no re-echo / no double COMPLETED)
- [x] Dedupe identical latest_update + listinteractions progress rows
- [x] No coordinator “Got it” ack; skip ephemeral “Processing…” status rows
- [x] Idle completed session clears sidebar working icon (poll activity notify)
- [x] SETUP conversation-status-card for Provision → Boot → Connect
- [x] Notify on Minion return (`end_turn` + `minion_progress`)
- [x] Attach existing task via Minion link / task UUID
- [x] `npm run build` + `e2e/minion-session.spec.ts` pass
