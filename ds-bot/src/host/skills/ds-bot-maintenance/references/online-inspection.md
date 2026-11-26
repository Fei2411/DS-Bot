# Online Team Inspection & Subsystems

Use this reference while the DS Bot host is running. Stick to read-only Bot tools and read-only log/SQLite/JSON checks unless explicitly stopping the host offline.

## Read-Only Bot Tools for Live Inspection

- `list_bots`: Inspect all configured Bots, IDs, roles (`Main` indicator), models, disabled/stopped flags, and active session status.
- `list_bot_models`: Inspect available DSH model routes plus discovered local agent routes (`local-*`, `local-acp-*`) and their readiness.
- `list_secrets`: Check which secret names exist without revealing any secret values.
- `bot_recall`: Search saved Markdown memory under `<bot-home>/memory/` — a Bot's `MEMORY.md` and topic files, plus group and team memory — with explicit `scope`:
  - `"own"` — the calling Bot's memory
  - `"group"` — the current group's memory
  - `"team"` — the shared team memory
  - `<botName>` — another Bot's memory (refused when that Bot is private)
  - For indexed conversation history (`bot/chat-index.sqlite`), `read_own_chat` is the tool — `bot_recall` never reads it.
- `stop_bot`: Gracefully stop a runaway or stuck Bot turn (use only when diagnosing/halting a live loop with user awareness).

## Diagnostics, Logs, and Journals

- **Bot diagnostics (`<bot-home>/logs/diagnostics.jsonl` & `diagnostics.jsonl.1`):** Rotates once the file exceeds 1 MiB or 200 entries. Inspect recent lines for turn failures, steward handoffs, connector/OAuth refresh errors, local agent spawn failures, and IM transport warnings.
- **Desktop main logs (`main.log`, `main.1.log`, `main.2.log`):** In Desktop App, check `DS_BOT_SHELL_DATA/logs/main.log` when startup fails before the HTTP/Web UI comes up or when auto-update downloads fail.
- **Journals (`<bot-home>/memory/journal.jsonl`, `<bot-home>/memory/bots/<botId>/journal.jsonl`, `journal.torn`):** Verify turn durability; `journal.torn` appears if a previous process crashed mid-line write.

## Context Steward, Handoff, and Blocking Errors

Check these thresholds when investigating truncated context, frequent handoffs, or stalled Bot loops:

- **Context windows & trigger math (`steward.js` / `context-runtime.js`):**
  - Default fallback window when a model declares no `contextWindow`: `500,000` tokens.
  - Auto-handoff check triggers at `0.8` (`checkRatio`) of the usable window (no default hard token ceiling; an explicit `checkTokens` config caps it when set), with a hard ceiling of `0.95 * usable`.
  - Reserved headroom/summary defaults: `16,384` response reserve and `4,096` token budget parameters during summary/compaction.
- **Handoff failure backoff:** Failed handoff retries back off through `1m`, `5m`, and `15m` delays before retrying automatically.
- **Non-retryable `BLOCKING_CODES`:** Provider/request failures classified as blocking (including HTTP `403` `CONTENT_POLICY`) stop automatic retries immediately instead of looping; inspect `diagnostics.jsonl` for the exact blocking code and status.
- **Search index (`<bot-home>/chat-index.sqlite`):** Backed conversation parts feed `read_own_chat`; check file existence/permissions if `read_own_chat` returns empty results on older sessions.

## Memory Budgets & Nightly Tidy (`memory.js`, `memory-tidy.js`)

- **Memory limits (`src/host/memory-entries.js`):**
  - Limits: `MEMORY_LIMITS = { entry: 300, group: 12000, bot: 8000, team: 4000, topic: 16000, topics: 40 }` chars.
  - Usable window reservation: `WINDOW_SHARE = 0.02` (2% of usable context window reserved for memory).
- **Auto-tidy (`memory-tidy.js`):**
  - Background scheduler polls every `30m`, running at most **once daily** per Bot when it has `>= 8` non-pinned memory entries.
  - Retires at most `1/5` (`20%`) of non-pinned entries per pass into `<bot-home>/memory/retired.jsonl` and records review timestamps in `<bot-home>/memory/reviewed.json`.

## Connectors, OAuth, and IDE MCP Imports

- **Auth state:** OAuth connectors track `needs-sign-in` when refresh tokens fail (`invalid_grant` or `401`). Ask the user to reconnect in `Settings > Connectors` — never probe or dump token files.
- **Per-Bot connector filtering:** Check `offFor` entries in connector state when a Bot lacks expected `mcp__<id>__*` or `mail_*` tools.
- **IDE MCP import sources:** Built-in import inspects standard user IDE configs (`claude_desktop_config.json`, `~/.cursor/mcp.json`, VS Code `mcp.json`) only when triggered through Settings.

## IM Channels (`<bot-home>/im/<connId>.json`)

- **Option cards & approvals:** In buttonless IM platforms, users send text `1 2` to pick numbered options on question cards, or `1` (allow) / `2` (reject) on tool approval cards.
- **Pairing authorization:** Pairing state transitions from `requests` to `paired` in `<bot-home>/im/<connId>.json` via administrator approval or QR scan.
- **QQ passive replies:** QQ enforces strict passive reply limits/windows per inbound message; failures after expiry indicate platform window expiration rather than host failure.
- **WeChat error `-14`:** Return code `-14` indicates an expired/invalid WeChat session token requiring user re-login / QR re-auth rather than retrying automatically.

## Local Agent CLIs (`local-*` / `local-acp-*`)

- **Environment scrubbing (`DROP_PREFIX`):** Subprocesses strip `DS_BOT_`, `DSH_`, `ANTIGRAVITY_`, `AGY_`, and `DEEPSEEK_` variables plus exact sensitive keys before spawning CLIs.
- **Windows shims & stdio bridge:** Windows `.cmd`/`.bat` shims are unwrapped automatically; ACP falls back from loopback HTTP MCP to stdio via zero-import `mcp-stdio.js` (`approve_agent_action` exposes team tool approval).
- **Cursor CLI (`cursor-cli`):** Uses `'CLI default'` model selection and reads user auth under `~/.cursor`; `checkLocal` verifies CLI availability and binary resolution.

## Schedules (`schedules.js` & `tools.js`)

- **`this_session` target requirement:** `schedule_create` and `schedule_edit` (`SCHEDULE_TARGET_TOOLS`) require `target` to be `'this_session'` so scheduled runs stay bound to the Bot's owning session.
- **Bot-owned task tools (`OWN_TASK_TOOLS`):** Recurring cron schedules are managed by DSH's injected `schedule` service (`schedules.js`); Bots inspect and edit their own jobs through `schedule_list`, `schedule_create`, `schedule_edit`, `schedule_delete`.
