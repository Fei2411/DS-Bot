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

### 1. Unified local SQLite coordination state machine (`coordination.sqlite`, `user_version = 3`)

- Owned exclusively by the lock-holding host process (`node:sqlite`, WAL mode on POSIX / rollback `DELETE` journal on Windows, `busy_timeout = 5000`); read-only windows open `{ readonly: true }` and never mutate state, corrupt database files auto-quarantine and rebuild on writable open, and Bot file/shell tools are blocked from accessing it (`privacy.js`).
- Single-track 5-table schema (`works`, `calls`, `inbox`, `waits`, `ready`) supersedes the earlier sidecar outbox tables (`user_version = 2`) in one atomic upgrade transaction, eliminating dual-write drift across `state.works`, `state.roomBatches`, `state.roomReports`, `inflight.json`, and `api-runs.json`.
- Chat transcripts, attachments, and tool logs stay in DSH Sessions and `ledger/*.jsonl`; SQLite stores only durable coordination truth.
- On startup, legacy `state.json`, `inflight.json`, and `api-runs.json` records are imported idempotently once into `coordination.sqlite`.

### 2. Logical addresses replace Session IDs as delivery targets

- Every tracked work and delivery carries a stable logical address (`foreground:<botId>`, `task:<taskId>`, `room:<roomId>:<botId>`, or `api:<runId>`) resolved at admission and recovery via `resolveLogicalSession()`.
- Context part switches update the Session binding without changing the logical address.
- A closed/failed background task, deleted group, or removed member resolves to `undefined` — it never falls back to the Bot's private foreground chat.

### 3. Single-settlement call barriers, D1–D4 adapter, and group 3-way zero-echo protocol

- `dsh-adapter.js` probes DSH capabilities and runs natively on official unmodified DSH `0.2.2-rc.5` using public plugin APIs only (never patches `@deepseek-ai/*` or wraps `sessionController.prompt`).
- Multi-child fan-out settles via atomic SQLite `calls` + `waits` barriers (`waiting -> queued`), waking the parent once when all required children finish; cold crash recovery inspects real DSH Session logs (`agent/inbox/spliced`, `tool/call`, `tool/result`, `turn/end`) and fails closed (`needs_verification`) on interrupted tools or corrupt/unreadable logs.
- Group chats enforce a strict 3-way message protocol (`visible` / `invite` / `call`): Bot body `@Name` text is display-only and never spawns wakes or calls; delegations enter explicitly via `delegate_work` / `post_to_group` with per-generation synthesis (`throughSeq`).
- External `/v1` API Runs persist their `works` row, `Idempotency-Key`, and request payload in SQLite before any side effects.

### 4. Non-interrupting notes and hard-signal loop guards

- `note_bot` persists zero-wake `inbox(kind='note')` entries in `coordination.sqlite`, attaches on the worker's next waking `agent/pre-step` without interrupting running commands, and acks only the note row on `user/message`.
- Foreground chats keep direct fast tools and pure public `agent/inbox/inserted` foreground handoff durability (#2309).
- Fixed turn-count cutoffs are replaced by wait-graph cycle detection and hard-signal no-progress detection (`progress_signature`), pausing only stagnant chains visibly until resumed.

## Non-goals

- Do not patch DeepSeek Harness (`@deepseek-ai/*`).
- Do not migrate chat bodies or replace `ledger/*.jsonl`.
- Do not ban foreground fast tools or introduce static write-region locking schedulers.
