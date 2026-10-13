# Minion scratch progress — stream `chat.jsonl` into Atelier

## Problem

Atelier Minion today polls orchestrator only (`gettask` + `listinteractions`) and
renders **assistant text**. Minion web’s Working / tool timeline comes from the
DevPod scratch file **`chat.jsonl`**, exposed via:

- `POST /api/listScratchFiles`
- `POST /api/getFileContents`

Without that feed, users see setup + final/progress prose but not Bash cards,
named Agent steps (“Validate SKILL.md fix”), or live tool status.

## Goal

While a Minion session is active (create or attach), Atelier **incrementally
ingests** scratch `chat.jsonl` and shows the same class of intermediate status
and progress the Minion web Working UI shows — reusing Claude’s tool-card /
status chrome where possible.

---

## User flow

1. User creates or attaches a Minion task (existing New Session flow).
2. **SETUP** card still tracks Provision → Boot → Connect from `gettask`
   (unchanged).
3. Once `gettask` has `metadata.devpodName` + region and the runner is up,
   Atelier starts the **scratch stream** (see Transport).
4. As `chat.jsonl` grows, the transcript gains:
   - collapsed **tool cards** (Bash, Read, Edit, Skill, MCP, …)
   - **named step** rows for Agent subtasks (`task_*` / Agent `description`)
   - streaming **assistant text** from scratch `text_delta` (preferred over
     duplicating the same prose from `listinteractions`)
5. Top-of-composer / chrome shows a compact **current progress** line
   (active step or latest `tool_start` name + short input preview) while remote
   is non-terminal.
6. On completion, tool cards settle to completed/error; SETUP stays cleared;
   sidebar returns to idle; final answer remains one assistant message (no
   double COMPLETED).
7. Follow-up steers keep the scratch stream running; new lines append; no
   re-dump of history.

Attach / cold resume: on first open, seed from the current `chat.jsonl`
snapshot **without** firing notify/toasts for historical tools; only lines
arriving after the seed watermark notify.

---

## Expected UI (mock tokens)

Reuse existing mock / components — do **not** invent a second chat system.

| Surface | Reuse |
|---|---|
| Tool cards | `ToolCallCard` / `ToolCallSequence` (`.tool-call-*` in mocks / `shared.css`) |
| SETUP | existing `ConversationStatusCard` `data-status-kind="minion-setup"` |
| Live progress chrome | extend `ConversationStatusCard` **or** composer status strip with a new kind `minion_working` — same `.conversation-status-card` visual language |
| Sidebar working | existing `session-dot` / `status-working` while stream active or tools running |
| Tracker rail | optional: map open Agent/`task_*` steps into `TrackerRail` todos when present |

If a mock row doesn’t exist for “named Minion step”, treat Agent/`task_started`
as a `ToolCallCard` with `name: "Agent"` (or `"Task"`) and title =
`description` / task name — same card chrome as Claude Agent tools.

**Out of scope for v1 UI:** pixel-perfect clone of Minion’s CSS; raw
`worker-live.log` / debug logs; PR diff browser (already covered elsewhere).

---

## Transport — “streaming” model

True SSE is **not** available on these APIs. Streaming = **append-aware polling**
of an append-only NDJSON file.

### Auth

Direct web API (same as browser):

- Host: `https://minion.uberinternal.com`
- `Authorization: Basic base64(":" + usso_token)` with `usso -fetch minion`
- `x-csrf-token: x`
- Cookie jar optional (Basic + csrf was sufficient in live probes)

Do **not** replace `aifx --usso` orchestrator calls; keep create/gettask/
listinteractions/createinteraction/canceltask on aifx. Scratch is an
**additional** client next to them.

### Discovery + fetch loop

Inside `MinionHarness.pollUntilDone` (or a sibling `ScratchTail` driven by the
same abort signal):

```
every poll tick (early 2s / steady 5s, same as today):
  1. gettask (existing) → status, latest_update, metadata.devpodName/region
  2. if no devpod yet → skip scratch; keep SETUP
  3. listScratchFiles({ taskId, devpodName, region })
       → find entry path === "chat.jsonl"
       → note sizeBytes + modifiedTimeUnix
  4. if missing or size unchanged since last watermark → skip fetch
  5. getFileContents({ taskId, devpodName, region, path: "chat.jsonl" })
  6. take content[byteOffset:] (or lineCount:), split NDJSON, parse new lines
  7. map events → HarnessEvents (below)
  8. advance watermark (byte length + mtime)
```

**Watermark** lives in `MinionMemory` (survives soft-stop) keyed by task id:
`scratchByteOffset`, `scratchMtime`, `scratchSeeded`.

**Backoff:** if `listScratchFiles` / `getFileContents` 4xx/5xx or DevPod gone,
log once, retry next tick; do not tear down orchestrator polling. After
terminal `gettask` status, do one final scratch fetch then stop the tail.

**Size guard:** if `chat.jsonl` > e.g. 2 MB on cold attach, seed by parsing
full file once (required for correct tool state) but **collapse** historical
tool groups in the UI (see Features); notify off until seed completes.

### Why `listScratchFiles` first

Avoid re-downloading ~300KB+ every 2–5s when idle. Size/mtime is the cheap
change detector; `getFileContents` only when grown.

---

## Event mapping (`chat.jsonl` → harness → UI)

Map into the **existing** Claude harness event types so `SessionManager.applyEvent`
and `ToolCallCard` work unchanged.

| Scratch event | Harness event(s) | UI |
|---|---|---|
| `tool_start` | `tool_call_start` (`toolUseId`, `name`, `input` from `input_json`) | running `ToolCallCard` |
| `tool_result` / tool end | `tool_call_end` (+ output if present) | completed/error card |
| `text_delta` | `text_delta` (flush/`result` per existing rules) | markdown assistant |
| `task_started` | `tool_call_start` name=`Task`/`Agent`, title=task name **or** tracker `task_*` | named step card / rail |
| `task_progress` | `tool_progress` or status detail update | in-card / chrome detail |
| `task_completed` | `tool_call_end` | step complete |
| `workflow_progress` | feed `sdk_status` `minion_working` detail | progress chrome |
| unknown types | ignore (log at debug) | — |

**IDs:** prefer scratch-provided tool/task ids; if missing, synthesize stable
ids (`minion-tool:${lineIndex}` / hash of start payload) so start/end pair.

**Dedup vs orchestrator text:** when scratch stream is healthy
(`chat.jsonl` seen and advancing), **suppress** duplicate assistant rows from
`listinteractions` / `latest_update` that match normalized scratch text.
Keep orchestrator text as fallback if scratch never appears (old tasks / API
failure).

**Ephemeral:** continue dropping short “Processing…” lines from orchestrator;
scratch noise (empty deltas) ignored.

---

## Feature list (v1)

### Must ship

1. **ScratchTail client** — USSO Basic + csrf; `listScratchFiles` +
   `getFileContents`; watermarked append parse.
2. **DevPod gate** — only start after `devpodName` + `region` from `gettask`
   (camelCase or snake_case normalize).
3. **Tool cards** — Bash / Read / Edit / Skill / Agent / MCP / … via existing
   `ToolCallContent` pipeline.
4. **Named steps** — “Validate SKILL.md fix”, “Push review fixes” as cards
   (or tracker rows) with running → completed.
5. **Progress chrome** — `minion_working` status: current step title or
   `Running Bash: <cmd preview>`; clears on idle/complete.
6. **SETUP coexistence** — SETUP until running; then working chrome; never both
   claiming the same slot.
7. **Sidebar working** — true while remote non-terminal **or** in-flight tool
   from scratch (same `isRemoteActive` semantics, extended).
8. **Cold attach seed** — load existing `chat.jsonl`, render history, no toast
   storm; watermark at EOF.
9. **Steer continuity** — after `createinteraction`, keep tailing; new tools
   append.
10. **Completion** — final scratch flush + existing single COMPLETED /
    `end_turn` behavior; no re-echo.
11. **Failure soft-degrade** — scratch errors don’t kill create/steer/cancel;
    fall back to today’s text-only polling.
12. **Stop/cancel** — abort scratch loop with orchestrator cancel.
13. **E2E** — real task: assert tool card / named step appears (or
    `data-testid` progress chrome) while working; screenshot artifact.
14. **Spec + impact map** — `e2e/test-impact-map.json` owns new main files.

### Nice-to-have (v1.1, same design)

15. TrackerRail sync for open Agent tasks.
16. Byte-range / partial read if API gains it (keep watermark interface).
17. Collapsed “N earlier tools” summary on huge histories.
18. Open-in-Minion affordance already present; optional jump-to-tool deep link
    later.
19. Surface `artifacts.jsonl` PR chip from scratch (secondary to `gettask`
    artifacts).

### Explicit non-goals

- Replacing aifx orchestrator with web-only APIs.
- Rendering `claude-debug.log` / `worker-live.log` in chat.
- Recording/replay fixtures (project rule: real SDK / real aifx only).
- Perfect parity with every Minion web animation.

---

## Architecture (files)

| Piece | Location |
|---|---|
| HTTP client | `src/main/harness/minion-scratch-client.ts` — list + getFileContents |
| Tail / parse | `src/main/harness/minion-scratch-tail.ts` — watermark, NDJSON, map→events |
| Wire-up | `src/main/harness/minion-harness.ts` — drive from poll loop + memory |
| Types | extend `HarnessEvent` only if needed; prefer reuse of `tool_call_*` |
| Chrome | `sdk_status` kind `minion_working` in `harness-ui-types` +
  `ConversationStatusCard` |
| Auth helper | reuse `findUsso` / PATH augmentation (`shell-path`, `uber-auth`) |
| Spec | this file |
| E2E | extend `e2e/minion-session.spec.ts` (+ artifact under `e2e-artifacts/`) |

Renderer: ideally **no new transcript component** — only status-card branch for
`minion_working`.

---

## Status & progress semantics

| Phase | Chrome | Transcript | Sidebar | Composer icon |
|---|---|---|---|---|
| Provisioning | `minion_setup` steps | — | working | **Stop** |
| Runner up, waiting for first scratch line | `minion_working` “Waiting for session…” | — | working | **Stop** |
| Tools running | `minion_working` current tool/step | tool cards + text | working | **Stop** (empty) / **Send=steer** (typed) |
| Between tools, task still RUNNING | `minion_working` latest step or “Working…” | settled cards | working | same |
| COMPLETED / FAILED / CANCELLED | chrome clear | final text + settled cards | idle | **Send** |

Progress line priority: active `task_*` name > running tool name+preview >
`latest_update.display_status` from gettask > “Working…”.

---

## Composer Send/Stop icon integration

Today the submit control is driven only by `session:turnState` →
`Composer.busy`:

- `busy && !text` → `stop-button` (running / cancel)
- `busy && text` → send styled as **Queue**
- `!busy` → normal **Send**

Minion also sets sidebar working via a **different** signal:
`live.busy || minionHarness.isRemoteActive()` (`getStatus`). Scratch tools
must not leave those two signals inconsistent.

### Problem if we naively reuse Claude turn busy

1. Scratch emits many `tool_call_*` + occasional `result` rows. Each
   `result` today clears `live.busy` / `sendTurnState(false)` → **Stop
   flickers off** while the DevPod is still working.
2. If we keep `busy=true` for the whole remote job, typed follow-ups hit the
   **message queue** (“Queue”) instead of immediate `createinteraction`
   steer — wrong for Minion.

### Design: Minion-specific composer busy = remote active

Drive the icon from **remote task lifetime**, not from each progress
`result`:

| Signal | Source | Consumers |
|---|---|---|
| `composerBusy` (turnState) | Minion: `isRemoteActive()` (poll running ∧ ¬completionPosted), refreshed on every poll/scratch tick via existing `setActivityListener` → also call `sendTurnState` | Composer Stop/Send, `data-working` |
| Sidebar `working` | unchanged: `live.busy \|\| isRemoteActive()` | `session-dot` |
| Turn queue / steer | Minion bypass: while remote active, follow-ups **always** `streamInput` immediately (never enqueue as Claude turns) | createinteraction |

Concrete wiring:

1. **`MinionHarness.isRemoteActive`** stays the single source of truth for
   “job still running” (already true while polling and not completed;
   scratch tail does **not** invent a second flag — tools only run while
   remote is active).
2. On each activity notify (poll start/stop, status change, scratch
   watermark advance, completion), `SessionManager` pushes
   `sendTurnState(sessionId, isRemoteActive(sessionId) || live.busy)` for
   Minion — so Stop stays up for the whole Working phase, including between
   tools and while SETUP/scratch catch up.
3. **Do not** clear turnState on intermediate Minion `result` subtypes
   (`minion_progress`, scratch-driven tool settles). Clear only on
   terminal (`end_turn` / cancel / error) when `isRemoteActive` becomes
   false.
4. **Composer Minion branch** (small renderer change): when
   `sessionMode === 'minion' && busy && hasSendableContent`, keep the
   control as **Send** (label/title “Send” / steer), **not** Queue — main
   already dispatches immediately. Empty composer still shows **Stop** →
   `interrupt` → `canceltask`.
5. Scratch `tool_call_start` / pending tools **do not** independently own
   the icon; they only enrich transcript + `minion_working` chrome. If
   scratch dies but gettask still RUNNING, Stop remains (orchestrator
   fallback). If gettask terminal, icon returns to Send even if a last
   tool card is settling.

### Interaction matrix

| User action | Composer shows | What happens |
|---|---|---|
| Create / attach in flight | Stop | cancel |
| Remote RUNNING, empty input | Stop | cancel task |
| Remote RUNNING, typed text | Send (steer) | `createinteraction`; Stay Stop after send until empty again |
| Remote COMPLETED | Send | new steer may reopen poll briefly → Stop again while reply pending |
| Hit Stop | Send (optimistic) | `canceltask`; scratch tail aborts; cards finalize |

### What we explicitly do **not** do

- Replace Stop with a spinner-only affordance (Stop remains the cancel
  affordance; `data-working="true"` on `.composer-box` already marks
  running).
- Tie Stop solely to “a tool card is running” (would hide Stop between
  Bash calls while the Agent is still thinking).
- Use Claude Queue semantics for Minion steers.

---

## Done criteria

- [x] User flow above works for create and attach on a real DevPod task.
- [x] Intermediate Bash / named Agent steps visible in Atelier without opening
      Minion web (verified by e2e + screenshot reviewed against Working UI).
- [x] No duplicate walls of the same progress text (scratch preferred when live).
- [x] Scratch API failure → text-only fallback still works.
- [x] Soft-stop / resume preserves watermark (no full replay / notify spam).
- [x] `npm run build` clean.
- [x] Minion e2e (`e2e/minion-session.spec.ts`) green — create/steer/cancel,
      attach, and scratch seed from chat.jsonl.
- [ ] Full `npm run test:e2e:affected -- --base main`: also selects harness
      suites via `types.ts`; those fail on missing Claude `initial-prompt` in
      New Session modal (pre-existing on `main`, confirmed in isolation 2× —
      not caused by scratch progress).
- [x] New/changed `e2e-artifacts/*` personally viewed via Read.

---

## Open implementation notes

1. Confirm USSO service name `minion` remains correct from Dock-launched app
   (same PATH/`--usso` hardening as create).
2. Normalize `devpod_region` vs `region` vs `devpodRegion` from gettask.
3. If `getFileContents` ever truncates huge files, switch seed strategy; API
   today returned full `chat.jsonl` in probes (~320KB).
4. Product choice: show **all** Bash cards vs collapse noisy bursts — default
   **show all**, collapsed by card UI (Claude default), with v1.1 summary if
   needed.
