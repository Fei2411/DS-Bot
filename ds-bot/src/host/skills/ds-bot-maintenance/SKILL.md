---
name: ds-bot-maintenance
description: Diagnose, inspect, update, back up, migrate, or repair DS Bot across Desktop App, DSH plugin, source checkout, and Docker deployments while keeping live team state and secrets safe.
---

# DS Bot Self-Maintenance

Operational runbook for Main Bots diagnosing, inspecting, upgrading, backing up, or repairing DS Bot across Desktop App, Docker Compose, source checkout, and standalone DSH plugin installations.

## Safety Red Lines

- **Online vs. offline boundary:** While the host is running, limit actions to read-only Bot tools (`list_bots`, `list_bot_models`, `list_secrets`, `bot_recall`) and read-only checks on logs and configs.
- **No live state mutation:** NEVER create, edit, delete, or overwrite `<DSH_HOME>`, `bot/state.json`, `bot/secrets.json`, `bot/ledger/`, `sessions/*.jsonl`, `profiles/`, or `cordis.patch.yml` behind a running host.
- **Lock awareness:** Respect `bot/state.lock` (15s heartbeat, 60s stale window). Damaged state files are quarantined as `state.json.broken-<ts>`.
- **Zero secret exposure:** NEVER read, print, commit, or transmit `bot/secrets.json` (mode `0o600`, plaintext by default; at-rest encryption is opt-in, and `DS_BOT_SECRETS_PASSPHRASE` / `DS_BOT_SECRETS_PASSPHRASE_FILE` only unlock an already-encrypted store), `.env` keys, tokens, cookies, or `credentials/`. Use `list_secrets` for names and presence only.
- **Private Bot isolation:** NEVER read, summarize, export, or expose a Private Bot's sessions or memory for another Bot. A Private Bot's memory stays with it: `bot_recall` refuses a Private Bot's scope outright, Private Bots cannot join group chats, and their change log stays in their own `memory/bots/<id>/journal.jsonl`. There is no Bot-side way to open another Bot's private data; ask the user to share what is needed.
- **Confirmation gate:** Always obtain explicit user confirmation before stopping DSH, switching deployments, deleting workspaces, rotating secrets, restoring backups, or running `npx ds-bot doctor --fix`.
- **No hand-edited bundles:** NEVER edit generated `ds-bot/client.js` or `ds-bot/link.js` directly; edit `ds-bot/src/client/` and rebuild with `npm run build`.

## Quick Mode Detector

Identify the active deployment from environment variables, process layout, and files before reading state:

| Mode | Primary detection signals | Data & config root |
|---|---|---|
| **Desktop App** | `DS_BOT_APP=1`, packaged binary, `Settings > General > Locations` | `$DS_BOT_HOME`, `<root>/data`, or `~/.ds-bot` (`DSH_HOME`); `DS_BOT_SHELL_DATA` (`%APPDATA%\DS Bot`); `~/.dsh` read-only import |
| **Docker Compose** | Container with `/data` mount and `/opt/ds-bot/ds-bot.tgz` payload | `/data` holds persistent `DSH_HOME`, `profiles/`, and `bot/` state |
| **Source Checkout** | Git working tree with `.ds-bot-local`, `start.ps1`, or `ds-bot/dev/bench.sh` | `.ds-bot-local` (or bench `.dsh-test-<name>`), repo `ds-bot/` & `app/` |
| **DSH Plugin** | Host running `dsh` CLI/Web with `ds-bot` in a profile | `DSH_HOME` or default `~/.dsh` -> `profiles/<profile>/` |

- **Workspace resolution:** `DS_BOT_WORKSPACE` overrides Bot workspace; defaults to `~/DS Bot`, `<root>/workspace`, or `<DSH_HOME>/bot/workspace` if `$DS_BOT_HOME` is set alone.
- **Test data hygiene:** Never point test scripts or manual checks at the user's live `~/.dsh` or `%APPDATA%` Desktop App data.

## On-Demand References

Load **only** the single reference file under `references/` matching the user's request:

| Task | Load reference | What it covers |
|---|---|---|
| Inspect paths, env vars, logs, or import boundaries | `references/deployment-paths.md` | OS default paths for all 4 modes, `DSH_HOME`, `DS_BOT_SHELL_DATA`, workspace, `<bot-home>` layout |
| Diagnose live team, context, memory, IM, or schedules | `references/online-inspection.md` | `list_bots`, `bot_recall`, `diagnostics.jsonl`, `main.1.log`, steward/handoff `1m/5m/15m` backoff, `memory-tidy.js`, `cursor-cli`, `schedule_*` |
| Upgrade, run `doctor`, troubleshoot, or restore backups | `references/upgrades-and-recovery.md` | `verifiedDsh`/`minBot`, 4 upgrade flows, `npx ds-bot doctor --fix`, `pnpm why`, known errors, official DSH docs (`llms.txt` / `dsh_docs`), `dsh-v*` checks, recovery |

## Standard Execution Protocol

1. **Classify the mode:** Detect Desktop App, Docker, Source Checkout, or DSH Plugin and note active `DSH_HOME` and `DS_BOT_HOME`.
2. **Check host state:** Read `bot/state.lock` and process status first; stay strictly read-only whenever the host is live.
3. **Open one reference:** Load the relevant `references/*.md` file before inspecting logs, upgrading, or running `doctor`.
4. **Act safely online:** Gather facts via `list_bots`, `list_bot_models`, `list_secrets`, `bot_recall`, and read-only file/log checks.
5. **Act safely offline:**
   - Summarize exact findings, risks, and rollback plan first.
   - Wait for explicit user confirmation and confirm the host has exited cleanly.
   - Take a timestamped backup outside `<DSH_HOME>` before touching `bot/` or `profiles/`. A backup containing `secrets.json` is sensitive even when the file is only copied, never opened.
6. **Verify and report:** Re-check with `npx ds-bot doctor` (expect exit `0`), inspect startup logs / `diagnostics.jsonl`, and report only observed commands, files, and results.

## Scope & Escalation Boundaries

- Verify upstream DSH CLI flags, profile rules, or `cordis.patch.yml` behavior via `https://deepseek-harness.github.io/deepseek-harness/llms.txt` (`dsh_docs` or `web_fetch`) and the matching `dsh-v<version>` tag at `https://github.com/deepseek-ai/deepseek-harness` instead of guessing or patching DSH.
- Do not guess undeclared paths or invent recovery steps outside verified reference material.
- For full source-checkout architecture and troubleshooting background, see `docs/self-maintenance.md` and `docs/known-issues.md`.
- If a maintenance request requires changing plugin code or client bundles rather than operating an install, hand off or load `ds-bot-plugin-dev`.
