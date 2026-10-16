# Minion over WebSocket — migration plan

**Status:** full WS switch implemented (Phases 1–6).  
**Branch:** `atelier-762b5651`.

---

## Why this exists

Today Atelier talks to Minion only over HTTP: create a task, send follow-ups
with `createInteraction`, then **poll** `getTask` / `listInteractions` /
scratch files and invent its own “Working” flag from that soup.

Minion Web (and uTerm, which already ports Web for Electron) do something
simpler for the live chat: they open a **WebSocket straight to the agent
worker on the DevPod**. That socket tells them, in real time, whether the
agent is busy, streams the turn, and accepts Send / Stop / answers.

The bug that keeps biting us — Atelier stuck on Working while Minion Web is
idle — is exactly this gap. Web clears Working from the worker’s status.
Atelier keeps guessing from poll + timers + `display_status`.

**Goal:** make Atelier’s live Minion session follow the same model as Minion
Web. One real “is the agent working?” signal. Same socket for send/stop when
we’re connected. HTTP/Orchestrator only when we need to create tasks, wake a
sleeping pod, or cancel.

**How we clone it:** copy the uTerm managed-sessions Minion code (Node, same
stack as Atelier). Do not reverse-engineer the Minion Web React app from
scratch — uTerm already did that.

---

## Picture in one paragraph

You still create and attach tasks through the Orchestrator (same as today).
Once the DevPod is up, Atelier opens a WebSocket to the worker. The worker
says hello with “I’m idle” or “I’m running,” then catches you up on past
events, then streams live ones. While that link is healthy, Send and Stop go
over the socket. If the pod is asleep, Send goes through Orchestrator (which
wakes the pod), we wait for the pod to come back, and we reconnect. Working
in the composer means “the worker said it is running” — nothing else.

---

## What the user should see (after)

1. Start or attach a Minion session → SETUP stages as today (Provision → Boot
   → Connect) until the DevPod is running.
2. Once connected, Working appears only while the remote agent is actually
   running a turn — same moments Minion Web would show it.
3. Send a follow-up while the pod is awake → message goes out immediately;
   Working turns on when the agent starts, off when it finishes. No stuck
   strip after the answer is already on screen.
4. Send while the pod is sleeping → message is accepted; we show waking /
   SETUP as needed; when the pod is back, the live link resumes.
5. Stop during a live turn → interrupts the agent (same as Web). Stop while
   still starting or only queued → withdraw / cancel rules, not a fake
   “interrupt” that later shows up as a user message.

UI chrome stays the same (SETUP card, Working above the composer, tool
cards). We only change **when** Working is true.

---

## How Minion Web / uTerm actually work

### Connecting to the worker

The chat is not talking to the Orchestrator for live status. It talks to a
small server on the DevPod (port **8766**), reached through Minion’s edge:

```
wss://minion.uberinternal.com/ws/ws/{taskId}
  ?x-proxy-devpod-name=<pod>
  &x-proxy-devpod-region=<region>
  &x-proxy-devpod-port=8766
  &batching_size=500
  &since=<optional last event id>
```

Those query params are how the edge knows which pod to route to (browsers
cannot set custom WebSocket headers). In Electron we also send
`Authorization: Bearer <usso token for minion>`.

**Atelier already has** USSO for Minion HTTP, plus pod name/region from
`getDevpods` / scratch. It just never opens this socket.

**Code to mirror:** uTerm `workerSocketUrl`, `transport.openWebSocket`;
Minion Web `use-devpod-socket-pool.ts`.

### Life of a connection (plain language)

States, roughly:

```
not connected → dialing → catching up → live
                    ↻ (retry with backoff)
                    → give up and use stored history if the pod is asleep
```

**1. Handshake.** First message is `connected`. It answers three practical
questions: Is the agent busy right now? (`worker_state`) Where are we in the
event log? (`last_seq`) Is there a question waiting for the user? Believe
this snapshot for Working/idle.

**2. Catch-up.** The worker then replays past events (singly or in batches)
so you can rebuild the conversation. When done it sends `replay_complete`.
If it says history was truncated (you asked to resume from an event that
fell out of the buffer), clear your resume cursor and reconnect for a full
replay.

**3. Live.** New events keep arriving the same way. If the socket drops,
reconnect and ask only for events newer than the last one you applied
(`since=lastSeq`).

**4. Keepalive.** Ping about every 20 seconds; if no pong in ~10 seconds,
treat the link as dead and reconnect. Busy workers can answer late, so the
timeout is intentionally not tiny.

**5. When dialing keeps failing.** Back off with random delay up to ~30s.
On hard failures (HTTP 502 or abrupt close), ask DevpodApi about the pod:

- **Sleeping** → stop the socket; show stored history; watch until it wakes.
- **Still starting** → keep waiting (SETUP).
- **Unknown** → keep retrying (same as Minion Web).

### The one Working signal

Minion Web’s chat does not OR together five heuristics. It does:

> Working = we have a live conversation stream **and** the worker is not
> “done.”

“Done” means the worker’s status is **anything other than running (integer
2)**. That comes from the handshake’s `worker_state`, then from
`status_change` events as the turn progresses.

| Worker status (int) | Meaning for us |
| --- | --- |
| 2 | Agent is running → show **Working** |
| 1, 7, 8 | Idle / waiting between turns → **not** Working |
| 7 + open question | Waiting on the user (elicitation) → not Working |
| 3 / 6 / 9 | Completed / interrupted / error |

**Important:** the task list in Minion Web uses a different, coarser field —
Orchestrator `task.status` (`TASK_STATUS_RUNNING`, `IDLE`, …). That is fine
for sidebar tags. It is **not** what drives the chat Working indicator.
Atelier must stop using `display_status`, steer timers, or “poll still
running” as Working.

uTerm names for the same idea: `workerStatusToThreadStatus`,
`isWorking = status === 'running' | 'starting'`.

### How do we know the DevPod is up?

**Not from the WebSocket.** The socket only works once the pod is already
routable. Pod readiness comes from a separate HTTP call:

1. Know the pod’s name and region (from the task: `devpodName` /
   `devpodRegion`, or parse `runner_url`).
2. Call Minion BFF **`getDevpods`** (same API Atelier already uses for
   SETUP).
3. Find our pod in the list and read its **phase** string.
4. Normalize with uTerm’s `classifyPodPhase`:

| DevpodApi phase (examples) | Class | Meaning |
| --- | --- | --- |
| `running` | **running** | Pod is up — safe to open the worker WebSocket |
| `pending`, `initiating`, `starting`, `creating`, `restoring` | **starting** | Still coming up — stay on SETUP, do not treat as Working |
| `snapshotted`, `shutdown`, `stopped`, `suspended`, `terminated` | **sleeping** | Asleep — use stored history; RPC send can wake it |
| `failed`, `error`, … | **failed** | Dead — show error / storage |
| missing / weird | **unknown** | API glitch — Web still *tries* the socket |

**“DevPod is up” for opening the chat socket = class `running`.**  
(uTerm also tries the socket on `unknown` / `failed` as a best effort, then
falls back if dial fails.)

Atelier’s existing SETUP already polls `getDevpods` for `STATE_RUNNING` —
same source of truth; the WebSocket migration must keep using it.

### Provision / Boot / Connect — how the three SETUP stages are chosen

These are **UI stages**, not raw DevpodApi enums. uTerm’s `syncStartup`
picks them like this (same idea as Atelier’s `deriveMinionSetup`):

| Stage | When |
| --- | --- |
| **Provision** | We do not yet have a pod name/region on the task (Orchestrator has not assigned a DevPod). |
| **Boot** | We have a pod identity, but the worker has **not** completed the JSON-RPC `connected` handshake yet (pod may still be starting, or already `STATE_RUNNING` but unreachable / dialing). |
| **Connect** | Worker socket `onConnected` / uTerm `moveStartup('connect')` — handshake received; waiting for replay / first turn before SETUP dismisses. |

Then SETUP **ends** exactly like uTerm `completeStartup` — **not** merely
when the socket reaches `live`:

| Path | SETUP dismissed when |
| --- | --- |
| **Create** (`justCreated`) | First `user_message` arrives (replay or live) — the worker took the first turn. |
| **Attach / reattach / wake** | Replay finishes (`replay` phase, including empty), i.e. past Connect. |

Not when `getDevpods` alone says RUNNING, and not when scratch/`latest_update`
look “done.” Detach/resume must **not** restore `setupComplete` from memory and
must **not** pre-complete SETUP because the tip already has history — reattach
re-runs syncStartup (Boot or Connect) until `completeStartup`.

So: Provision/Boot come from **task metadata + getDevpods**. Connect means
**pod running, worker link in progress**. Working (composer strip) is a
*later* concern and only follows `worker_state === 2`, with a short label
only — never `latest_update` / answer prose.

### First message on connect — what it is and what we do with it

Yes: every successful dial starts with one JSON-RPC frame:

```json
{
  "jsonrpc": "2.0",
  "method": "connected",
  "params": {
    "worker_state": 2,
    "last_seq": 1042,
    "execution_mode": "interactive",
    "pending_elicitation": { "call_id": "…", "questions": [/* … */] },
    "workflow_state": { /* optional plan tracker */ }
  }
}
```

That frame is **not** a chat bubble. It is control plane:

- Set Working/idle from `worker_state` **immediately** (don’t wait for
  replay).
- Remember `last_seq` as a lock so *old* replayed `status_change` events
  cannot override that snapshot.
- If `pending_elicitation` is present, show the AskQuestion card right away
  (even before the rest of history finishes replaying).
- **Do not** advance your event cursor to `last_seq` here — if you did, you
  would skip the entire replay and the chat would look empty. Cursor only
  moves as you **apply** each event (or at `replay_complete`).

After `connected`, the worker sends history events, then `replay_complete`,
then live events. Only those history/live events become messages / tool
cards / etc.

### How chat history is shown (and how we avoid duplicates)

Think of the conversation as a **fold of numbered events**. Every event has
a monotonic `seq`. The UI is “apply events in order into one in-memory
thread.” You never append the same `seq` twice.

**Order (Minion UI):** previous history (prompt N + answer N) → current prompt
→ intermediate cards → current answer. User rows and assistant rows share that
one fold clock. Atelier must **not** insert composer/create user rows on a
parallel SessionManager clock — that is what produced
`prompt N+1 → answer N → answer N+1`.

**Fresh connect (no prior cursor)**

1. Dial without `since`.
2. Apply `connected` (status + optional elicitation only).
3. Buffer replay events until `replay_complete`, then fold them in order into
   an empty thread (or replace a previous fold if this is a wake with
   `resetOnConnect`).
4. From then on, apply live events one by one.

**Reconnect (we already had a live session)**

1. Dial with `since=<last applied seq>`.
2. Keep existing bubbles on screen (Minion Web “resume” path).
3. Drop any event with `seq <= lastSeq` (socket-layer `dedupe` + reducer
   guard `if (event.seq <= lastSeq) return`).
4. If the worker says `replay_complete.truncated` (our cursor fell off the
   ring buffer), clear the cursor, reconnect **without** `since`, and
   rebuild from a full replay.
5. If the worker’s `connected.last_seq` is **lower** than our cursor (event
   store was rebuilt on the worker), force a full replay the same way.

**Attach to an existing task**

Same machinery, two cases:

| Pod state on attach | What we show first | Then |
| --- | --- | --- |
| **Running** | Open socket → `connected` + full/partial replay builds the transcript | Live updates; Working from `worker_state` |
| **Sleeping / no pod** | Minion web HTTP has no TaskStorage RPC; scratch `getFileContents` fails without DevPod DNS. On attach, call `devpodStart` once, paint SETUP Boot (wake intent), then open the worker socket when `RUNNING` | Poll `getDevpods` until `running`, open socket with `resetOnConnect` so replay builds the transcript. Do **not** soft-stop a finished tip while the socket is still dialing or attach-wake is in flight (that tore down reconnect and left reattach empty). |

uTerm also seeds open AskQuestion cards from `ListInteractions` when needed,
keyed by request id, and skips ids already resolved.

**Atelier note:** today attach seeds from poll/scratch into the Atelier
transcript store. After migration, the fold should be **seq-keyed from the
worker** (or storage events), and SessionManager should not also push the
same turn again from `listInteractions`. One pipeline owns the live
transcript.

### AskQuestion and other cards

| Card / UI | Source of truth | How it appears / clears |
| --- | --- | --- |
| **AskQuestion / elicitation** | Worker event `elicitation_request`, or `connected.pending_elicitation`, or seed from `ListInteractions` | Open a pending request by `call_id`. Clear on `elicitation_response`, user answer, or a new delivered user turn (Web clears open elicitation when a message is delivered). Answering: WS `ELICITATION_RESPONSE` if live, else `RespondToInteraction`. |
| **Working strip** | `worker_state` / `status_change` (= 2?) | Not a transcript card; composer chrome only. |
| **Tool / skill / agent activity** | Worker events (`tool_start`, `tool_result`, …) folded like Web; scratch `chat.jsonl` remains a backup enrichment path in early phases | Upsert by tool id; don’t re-create from poll if seq already applied. |
| **Plan / workflow tracker** | `workflow_progress` events + optional `connected.workflow_state` | Same fold. |
| **Queued message chip** | `message_queued` while worker busy | Shown until a real user turn delivers. |
| **SETUP (Provision/Boot/Connect)** | Task + `getDevpods` (see above) | Not from worker events. |

Identity rules that prevent duplicate cards:

- Elicitations keyed by **`call_id`** (seed skipped if already open or
  already in the resolved set).
- Tools upserted by tool call id inside the reducer.
- Chat lines keyed by **event `seq`** — never apply the same seq twice.

### Sending messages (two channels, one rule)

Rule uTerm uses:

> If the socket is fully **live** (past catch-up), send on the WebSocket.
> Otherwise send through Orchestrator RPC (which can also **wake** a sleeping
> pod).

On the socket, commands look like:

```json
{
  "jsonrpc": "2.0",
  "method": "command",
  "params": {
    "type": "USER_MESSAGE | ELICITATION_RESPONSE | INTERRUPT | CHANGE_MODE",
    "data": { }
  }
}
```

| User action | When live on WS | When not live |
| --- | --- | --- |
| Send a message | `USER_MESSAGE` | `CreateInteraction` (wakes pod) |
| Answer a question | `ELICITATION_RESPONSE` | `RespondToInteraction` + wake |
| Stop | `INTERRUPT` on the socket only | Withdraw still-pending user messages; do **not** create an INTERRUPT via RPC (it can later show up as a normal user line) |
| Attachments | Upload, then `USER_MESSAGE` with file names | Not available offline |

After an RPC send while the socket is down: poll DevpodApi until the pod is
running, then open the socket again and treat the next catch-up as a fresh
history (`resetOnConnect`).

### Session modes (how uTerm thinks about a task)

| Mode | In human terms |
| --- | --- |
| `starting` | Pod not ready yet — SETUP. Don’t pretend we’re Working. |
| `socket` | Live link to the worker — status and traffic from WS. |
| `storage` | Pod asleep (or gone) — read history from storage; watch for wake. |
| `closed` / `deleted` | Tear down. |

Orchestrator `task.status` still matters for “this mission is cancelled /
completed / archived.” It does not own the live Working bit.

---

## What Atelier does today (and why it drifts)

`minion-harness.ts` is HTTP-only:

- Create / attach / follow-up via `createTask` / `createInteraction`
- Poll `getTask`, `listInteractions`, and scratch `chat.jsonl`
- Working ≈ “we’re still polling” ∧ “task not finished” ∧ “still waiting on
  a steer”
- “Finished” sometimes means terminal status, sometimes
  `latest_update.display_status === COMPLETED` while `task.status` is still
  RUNNING

So Atelier can stay Working after Minion Web has already gone idle — exactly
the Torchlight-class stuck chrome.

We already have the ingredients for the WebSocket (USSO, pod name/region).
We just need to use them the way Web/uTerm do.

---

## Migration plan (phased)

Each phase should leave the app usable. Prefer shipping the Working fix
before the full streaming rewrite.

### Phase 0 — Agree on the plan

- [x] Read Minion Web + uTerm socket model
- [x] Clone **uTerm**-shaped `minion-worker-socket.ts` + harness wiring
- [x] Done criteria: build + `e2e/minion-session.spec.ts` (A/B/D) green

### Phase 1 — Open the pipe

- [x] `src/main/harness/minion-worker-socket.ts` — URL, USSO Bearer, connect /
      replay / live / backoff, ping, command frames
- [x] `getMinionBearerToken` / `invalidateMinionToken` on HTTP client

### Phase 2 — Drive Working from the worker

- [x] Open socket when tip DevPod is `STATE_RUNNING` + name/region known
- [x] `isRemoteActive` / Working chrome from `worker_state === 2`
- [x] Clear Working when worker leaves RUNNING (even if task still RUNNING)

### Phase 3 — Stream the turn from the socket

- [x] Live `text_delta` buffer → progress on leave-RUNNING
- [x] `elicitation_request` / `connected.pending_elicitation` → AskQuestion
- [x] Seq-keyed `MinionWorkerFold` (replay + live) → harness events; tools /
      messages / workflow chrome. `listInteractions` no longer posts answers.

### Phase 4 — Send / answer / stop like Web

- [x] Follow-up: `USER_MESSAGE` when socket live; else `createInteraction`
- [x] Elicitation: `ELICITATION_RESPONSE` when live; else RPC payload
- [x] Stop: WS `INTERRUPT` only when live (no `cancelTask`); no socket →
      clear chrome only. Close/delete only detaches — there is no hard cancel.
- [x] Working = `worker_state === 2` only (no steer-PENDING / poll invent)

### Phase 5 — Sleep, wake, reconnect

- [x] Close socket when pod leaves RUNNING; reconnect on next RUNNING poll
- [x] Sleeping (`SHUTDOWN` / `SNAPSHOTTED` / …): no stuck SETUP on cold
      resume; Boot only with wake intent / starting phase
- [x] Sleeping attach: `devpodStart` + SETUP Boot wake intent; skip soft-stop
      while dialing / catch-up; scratch `getFileContents` only when pod DNS
      exists; WS `resetOnConnect` owns history after wake

### Phase 6 — Delete the old guesses

- [x] Drop steer-wait / `latest_update` / `listInteractions` transcript writers
      once fold is healthy; scratch is backup only when fold never connected
- [x] Narrow poll cadence when socket is live (`POLL_INTERVAL_LIVE_MS`)

---

## Out of scope for this migration

- Replacing Orchestrator for create / list / attach / cancel
- Rebuilding Minion Web’s full React chat in Atelier
- AES-only or V1 Buildkite paths (keep today’s HTTP)
- The separate “changes” file-watcher socket (nice follow-up, not required)

---

## Risks (and how we handle them)

| What can go wrong | What we do |
| --- | --- |
| USSO rejects the WebSocket | Refresh token and retry once (uTerm already does this) |
| Pod flaps / 502s | Ask DevpodApi before giving up; backoff like Web |
| Poll and socket both try to set Working | One owner only: the worker status bit |
| Stop via Orchestrator “INTERRUPT” | Never; document in the harness header |
| E2E needs a real DevPod socket | Stay mock-free; allow longer timeouts / attach a live tip |
| Porting the whole reducer is huge | Ship Phase 2 (status only) before full event fold |

---

## Done when

- [x] `npm run build` is clean (validate in worktree)
- [x] Minion validation: `e2e/minion-session.spec.ts` A/B/D green after undici
      WS fix (skipped full `e2e:affected` — `types.ts`/`manager.ts` expand to
      ~97 harness tests; impact-map includes `minion-worker-fold.ts`)
- [x] E2E covers at least:
  1. Working on while the worker is running; **off** when Web would be idle
     (`worker_state ≠ 2`), even if Orchestrator still says RUNNING
  2. Live follow-up → answer without stuck Working; no duplicate prior answer
  3. Attach / reattach paths (B history, D one row); sleep/wake via storage
     fold + `resetOnConnect` in harness (CI uses live tips)
- [x] Screenshots of Working on/off reviewed against prior stall artifacts
- [x] `main.log` shows socket connect + `worker_state` and fold/replay lines
      (undici WS; Electron main has no global `WebSocket`)

---

## Where to read the real code

**Minion Web** (`uber-code/web-code`, under `aifx/minion-web/…`):

- `use-devpod-socket-pool.ts` — dial, reconnect, handshake
- `chat-event-apply.ts` — how events update `isDone` / messages
- `AgentChatView.tsx` — `isAgentCurrentlyRunning`

**uTerm (clone this)** (`uber-non-production/uTerm`,
`managed-sessions/…`):

- `minion/worker-socket.ts` — connection state machine
- `minion/commands.ts` — WS vs RPC channel selection and payloads
- `minion/reducer.ts` — worker status → thread status, event fold
- `minion/provider.ts` — modes, wake, send/stop/answer
- `minion/list-source.ts` — list-row status from `task.status` × pod
- `host/transport.ts`, `host/endpoints.ts` — USSO WebSocket open

**Atelier today:**

- `src/main/harness/minion-harness.ts`
- `src/main/harness/minion-http-client.ts`
- `src/main/harness/minion-scratch-*.ts`
