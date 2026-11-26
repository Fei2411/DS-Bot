# Message and Async Coordination Base

- Date: 2026-11-25
- Related: [Bot handoffs](2026-10-16-bot-handoffs.md), [Group chat](2026-10-07-group-chat.md), [Message ledger](2026-11-10-message-ledger.md), [Async work](2026-11-16-async-work.md), [External API](2026-11-21-external-api.md), #2235, #2265

## Why

DS Bot's message ledger (`ledger/*.jsonl`), handoff work tree (`state.works`), and DSH Session logs already answer what was said, who owes whom a result, and which turn read which event. What remained split across separate files (`state.json`, `inflight.json`, and in-memory maps) was the **delivery obligation**: committing a terminal state transition together with the report or return it owes, addressing a logical target instead of a transient DSH Session id, and verifying durable DSH session history before replaying after a restart.

This split caused four reproducible cross-process recovery failures:

1. A background task whose opening delivery failed stayed in `inflight.json` and replayed `role: 'task'` into the Bot's foreground private chat on restart.
2. Exiting between saving a task's terminal `completed` state and submitting its `task-report` lost the owed report permanently.
3. A stale queued delivery snapshot replayed an already-consumed `exchangeId`, causing the same Session to consume the message twice.
4. A stale running-turn snapshot issued a redundant `role: 'resume'` turn even when the DSH Session log already held `turn/end: completed`, because recovery only checked the removed `sessionController.inspect` method.

## Decided behavior

### 1. Local SQLite coordination store (`coordination.sqlite`)

- Owned exclusively by the lock-holding host process (`node:sqlite`, WAL mode, `busy_timeout = 5000`); read-only windows never write to it, and Bot file/shell tools are blocked from accessing it (`privacy.js`).
- Stores only coordination truth: `deliveries`, `active_turns`, `obligations` (`task_report`, `room_report`, `peer_result`), and `silent_notes` (session-buffered notices and work-scoped mid-step updates).
- Chat transcripts, attachments, and tool logs stay in DSH Sessions and `ledger/*.jsonl`; no bodies are migrated into SQLite.
- On startup, a legacy `inflight.json` (from earlier versions) is imported once into `coordination.sqlite`; `inflight.json` is kept as a generation-tagged compatibility mirror so stale mirrors never resurrect cleared SQLite rows.

### 2. Logical addresses replace Session IDs as delivery targets

- Every tracked delivery carries a logical address (`{ foreground: true }`, `{ roomId }`, `{ taskId }`, or `{ retired: true }`) resolved at admission and recovery via `addressedSession()`.
- Context part switches keep the same logical address and route to the newest segment.
- A closed/failed background task, deleted group, or removed member resolves to `undefined` and cancels cleanly with a diagnostic notice (`RECIPIENT_CLOSED`) — it never falls back to the Bot's private foreground chat.

### 3. Atomic terminal obligations and shared cold-evidence verification

- `settleTask` commits task-start cancellation and any owed `task_report` obligation in a single SQLite transaction (`commitTaskTerminal`) before saving `state.json` or calling `deliver()`. `deliverRoomReport` and `answerSender` commit `room_report` and `peer_result` obligations before clearing pending state or sending.
- Live recovery, queued replay, obligation replay, and `reconcileEndedTask` all share one `readSessionEvidence()` reader backed by real DSH `sessionQuery` (`inspectSession` / `readSession`), `sessionController.page`, live snapshots, and test `inspect` hooks.
- Replay checks live inboxes and durable session history by `(exchangeId, role, deferred, resumed, retried)`. Already-consumed messages are forgotten; cold-read I/O errors fail closed (`CONSUMPTION_UNVERIFIED` / `TURN_UNVERIFIED`) instead of blindly duplicating; turns with unconfirmed `tool/call` events (and no pending approval) are held for user verification instead of automatically re-running side-effectful tools.

### 4. Non-interrupting work updates and progress-based loop guards

- Callers can attach mid-work corrections to an open delegation or group assignment via `note_bot(to, note, work_id)`. Updates persist in `coordination.sqlite` (`scope = 'work'`), reject unauthorized third parties, inject at the worker's next `agent/pre-step` without interrupting running commands, and clear only after `sessions.flush(session) === true`.
- Foreground chats remain able to execute fast tools and direct Q&A without forcing every action into a background task; slow shell auto-backgrounding, explicit `fg-handoff`, and `bot-handoff` continue as designed.
- Fixed turn-count cutoffs (`WORK_REWORK_CHECKPOINT` and `ROOM_ZERO_WORK_RELAY_LIMIT`) are replaced by content-hash no-progress detection and directed cycle detection so long productive chains run uninterrupted while genuine stalls pause visibly.
- Permanent `session/not-found` failures during group model sync are dropped from `roomRetry` and logged once instead of retrying indefinitely (#2265).

## Non-goals

- Do not patch DeepSeek Harness (`@deepseek-ai/*`).
- Do not migrate chat bodies or replace `ledger/*.jsonl`.
- Do not ban foreground fast tools or introduce static write-region locking schedulers.
