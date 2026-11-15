---
name: ds-bot-maintenance
description: Diagnose, inspect, update, back up, migrate, or repair DS Bot across plugin, desktop app, source, and Docker deployments without corrupting live state or exposing secrets.
---

# DS Bot Self-Maintenance & Diagnostics

Use this skill whenever the user asks to inspect, diagnose, update, back up, migrate, or repair DS Bot itself.
Prefer live read-only inspection and Bot tools while the host is running, and require a clean host shutdown before changing any state or profile files on disk.

## 1. Safety Red Lines (Online vs Offline Boundary)

- **Online vs offline rule:** While DS Bot or DSH is running, only run read-only checks or Bot tools (`list_bots`, `list_bot_models`, `list_secrets`, `recall`, `stop_bot`, `list_connectors`, `list_capabilities`).
- **Never edit live state behind a running host:** Do not modify `bot/state.json`, `bot/state.lock`, `bot/ledger`, `sessions/*.jsonl`, `cordis.patch.yml`, `package.json`, `secrets.json`, `.credentials.yaml`, or SQLite files while active.
- **Respect the single-writer lock (`bot/state.lock`):**
  - The active host holds `{ pid, host, token, since }`, beats every 15 s, and expires after 60 s.
  - A second DSH process against the same `DSH_HOME` runs read-only; never delete a live lock to force writes.
  - If `state.json` fails JSON parsing at startup, DS Bot moves it aside to `state.json.broken-<ts>`.
- **Zero secret exposure:**
  - Never read, print, quote, or copy API keys, OAuth tokens, cookies, `.credentials.yaml`, `$DSH_SECRET_<NAME>`, or `DEEPSEEK_API_KEY`.
  - Never read `secrets.json` directly (`0o600`; optional AES-256-GCM/scrypt encryption unlocked unattended via `DS_BOT_SECRETS_PASSPHRASE` or `DS_BOT_SECRETS_PASSPHRASE_FILE`).
  - Use `request_secret` only inside a Bot's own chat (never in groups).
- **Respect Private Bot isolation:**
  - Never read, relay, or compare a Private Bot's `workDir`, memory, browser profile, downloads, `side/`, `btw/`, `archivePath`, diagnostic snippets, or sessions from another Bot.
  - Deleted Private Bots keep a tombstone record under `privateArchives`.
- **Confirm before disruptive changes:** Ask explicit user approval before stopping DS Bot, restarting containers, editing `cordis.patch.yml` or `package.json`, running `doctor --fix`, deleting caches, or moving/deleting folders.
- **Never hand-edit generated bundles:**
  - Edit `ds-bot/src/client/` and run `npm run build` rather than modifying `ds-bot/client.js`.
  - In source checkouts with Desktop App, also run `npm ci` in `app/` or start via `.\start.ps1` so `install-links` copies the updated build.

## 2. Identify Deployment Mode, Paths & Environment

Detect how DS Bot is running before touching files:
- `DS_BOT_APP=1`: DS Bot Desktop App.
- `docker-compose.yml` or `/opt/ds-bot/ds-bot.tgz`: Docker deployment.
- `.ds-bot-local` in repo root: Windows source launcher (`.\start.ps1`).
- Otherwise: DSH Desktop or DSH Web plugin install.

| Mode | `DSH_HOME` | Profile & Team Home | Extras & Logs |
| :--- | :--- | :--- | :--- |
| **DSH Desktop / Web** | `$DSH_HOME` or `~/.dsh` (`C:\Users\<user>\.dsh`, `/home/<user>/.dsh`, `/Users/<user>/.dsh`) | `profiles/desktop` or `profiles/web`; `bot/` | Memory-only browser in DSH Desktop; no Bot browser in DSH Web |
| **DS Bot Desktop App** | `$DS_BOT_HOME`, `<root>/data`, or `~/.ds-bot` | `profiles/ds-bot`; `bot/` | `locations.json`, browser `Partitions`, `logs/main.log` (`main.1.log`, `main.2.log`, 2 MB x 3) in `DS_BOT_SHELL_DATA` (`%APPDATA%\DS Bot`, `~/Library/Application Support/DS Bot`, `~/.config/DS Bot`); workspace `~/DS Bot`, `<root>/workspace`, or `<DSH_HOME>/bot/workspace` if `$DS_BOT_HOME` is set alone |
| **Windows Source** | `.ds-bot-local/data` (or `-DataRoot <folder>`) | `profiles/ds-bot`; `bot/` | `.ds-bot-local/workspace` and `.ds-bot-local/shell`; `.\start.ps1` (`-PrepareOnly` prepares without launching) |
| **Docker** | `/data` inside container | `profiles/web`; `/data/bot` | `docker-compose.yml` (`13080`) or `docker/compose.yml` (`3080`); `/workspace` mount; `/opt/ds-bot/ds-bot.tgz`; entrypoint aligns `/data` owner to `PUID`/`PGID` |

Key runtime files under `<DSH_HOME>` (`<bot-home>` = `<DSH_HOME>/bot`):
- `profiles/<profile>/cordis.patch.yml` and `profiles/<profile>/package.json`: active DSH plugins, provider overrides, and exact dependency pins.
- `<bot-home>/state.json` and `<bot-home>/state.lock`: Bot roster, groups, conversation part chains, and active writer lock.
- `<bot-home>/logs/diagnostics.jsonl`: structured runtime errors (rotates to `diagnostics.jsonl.1` past 1 MiB, keeps 200 entries; secrets and home paths redacted). Desktop boot/Electron errors also write to `logs/main.log` inside `DS_BOT_SHELL_DATA`.
- `<bot-home>/memory`, `<bot-home>/secrets.json`, `<bot-home>/im/<connId>.json`, `<bot-home>/update.json`, `sessions/*.jsonl`, `storages/workspace.json`, `.credentials.yaml`.

Important environment variables:
- `DSH_HOME`, `DS_BOT_HOME`, `DS_BOT_WORKSPACE`, `DS_BOT_SHELL_DATA`: override DSH root, Desktop App data/workspace roots, and Electron `userData`.
- `DS_BOT_UPDATE_URL`: override Desktop App update feed URL; `DS_BOT_APP=1` disables in-plugin self-update.
- `DS_BOT_SECRETS_PASSPHRASE` / `DS_BOT_SECRETS_PASSPHRASE_FILE`: unlock encrypted `secrets.json` unattended.
- `DSH_TRUSTED_HOST`, `DSH_HOST`, `DSH_PORT`, `DSH_LISTEN_PORT`, `PUID`, `PGID`: Docker host allowlist, bind/listen settings, and `/data` UID/GID mapping.

## 3. Live Online Team Health Inspection

Run these checks in sequence while DS Bot is online:

### 3.1 Team roster, models & capability inventory
- Call `list_bots` to inspect each Bot's `role`, `model`, `effort`, `main` flag, `private` flag, `workDir`, groups, and running turn state.
- Call `list_bot_models` to view available `provider/model` refs and supported thinking levels (`effort`) for active models.
- Call `list_secrets`, `list_connectors`, and `list_capabilities` to verify secret names, connector auth status, and attached skills without reading secret payloads.

### 3.2 Error & startup log triage
- Read `<bot-home>/logs/diagnostics.jsonl` for lock contention, unhandled rejections, blocking codes, or recurring tool failures.
- When Desktop App fails before the plugin loads, read `logs/main.log` inside `DS_BOT_SHELL_DATA`.

### 3.3 Context window, compaction & session parts
- Steward defaults: `contextWindow` (`500,000` if unadvertised by steward; `1,000,000` `DEFAULT_CONTEXT_WINDOW` in DSH `dsh-llm-pi-ai` and `dsh-llm-deepseek`), `checkRatio` (`0.8`), `checkTokens` (`380,000`), and `hard = 0.95 * usable` (`usable = max(declared - reserve, floor(declared / 2))`).
- Near threshold, steward picks in-place `[Checkpoint N]` compaction or rotates to `[Handoff · part N]` (`16,384` recent / `4,096` list token budgets) while older parts remain readable via `read_own_chat`.
- Below the hard line, a failed handoff-note generation enters retry backoff (`1 min`, `5 min`, `15 min`) before re-evaluating the steward. If chat search seems incomplete, removing `chat-index.sqlite` while stopped lets DS Bot rebuild the FTS5 index at next startup.

### 3.4 Stuck turns & blocking errors
- Check diagnostics for `BLOCKING_CODES` (`AUTH`, `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `QUOTA`, `ACCOUNT_*`, `LOCAL_AGENT_MISSING` / `_SIGNIN` / `_QUOTA` / `_EXIT`) and HTTP 403 `CONTENT_POLICY` errors; fixing credentials or quota automatically unblocks affected Bots.
- As Main Bot, call `stop_bot` with an explicit reason to halt a runaway or wedged Bot turn safely.

### 3.5 Memory health & undo safety
- Query memory via `recall` (`query`, `topic`, `scope`: `"own"`, `"group"`, `"team"`, or a Bot's name; stored on disk under `<bot-home>/memory` in `bots/<botId>`, `groups/<roomId>`, and `team`).
- Built-in caps: `MEMORY.md` allows `8,000` chars (bot), `12,000` (group), `4,000` (team), capped at `2%` of usable window; topic files allow `16,000` chars; entries allow `300` chars.
- Post-turn review tracks cursors in `reviewed.json` (private Bots stay isolated).
- Periodic tidy checks every `30 min` and tidies each changed scope at most once per day once >= `8` non-pinned entries exist (at most `1/5` per batch into `retired.jsonl`), supporting per-batch undo while target files remain unmodified.
- Exact-match journal undo uses `journal.jsonl` (`bots/<botId>/journal.jsonl` for private Bots); incomplete tail lines move to `journal.torn`.

### 3.6 Connectors & MCP
- OAuth uses browser loopback or GitHub device flow (`needs-sign-in` signals expired refresh tokens); the local gateway keeps credentials out of `dsh-mcp-client` config.
- Per-Bot tool masks (`offFor`) hide `mcp__<id>__*` and `mail_*` on `tools/change`.
- Custom stdio/HTTP MCP servers import from Cursor, Claude Desktop, or VS Code configs.

### 3.7 IM channels
- Only the `state.lock` holder connects adapters (`<bot-home>/im/<connId>.json`). Unbound chats show pairing (`requests` -> `paired`; `/start`, `/stop`).
- Reply origin lives in memory only and does not survive restarts.
- Buttonless platforms (QQ, WeChat) use numbered replies (`1 2`). QQ passive replies reuse inbound `msg_id`/`msg_seq` and fail permanently once the platform reply window closes; WeChat iLink `-14` indicates an expired login needing a fresh QR scan.

### 3.8 Local Agents
- Routes register as `local-<cli>` / `local-acp-<id>` (never colliding with DSH `opencode`).
- Child env strips `DS_BOT_*`, `DSH_*`, `DEEPSEEK_*`, and API keys; Windows `.cmd`/`.bat` shims are unwrapped automatically.
- ACP negotiates Streamable HTTP MCP -> stdio bridge (`mcp-stdio.js`) -> plain (`approve_agent_action` gates approvals).
- **Cursor CLI caveat:** choosing a model other than `'CLI default'` via `cursor-cli` writes a global default in `~/.cursor`, affecting other Cursor Bots on `'CLI default'` and terminal Cursor; keep Cursor Bots on `'CLI default'` or use a separate CLI for parallel multi-model runs.
- Mid-step in-turn threshold checks stay off for local-agent parts (the CLI condenses inside a turn); at turn end, DS Bot runs steward `decide` when the CLI reports usage >= `check` or compactions, whereas CLIs without reported usage stay off threshold checks until overflow, `cwd`, or mode changes.

### 3.9 Scheduled tasks
- Backed by DSH `schedule`; active/paused schedules follow a Bot automatically across part switches, and Bot-created tasks remain scoped to `"this_session"`.

## 4. Upgrade Playbooks & `ds-bot doctor`

Check `dsBot.verifiedDsh` and `dsBot.minBot` in `ds-bot/package.json` before upgrading:

- **DSH Plugin:**
  1. Upgrade DSH: `npm install -g @deepseek-ai/dsh@<version>`
  2. Install or update plugin: `dsh plugin --profile <profile> add ds-bot` (or `github:Fei2411/DS-Bot#v<ver>&path:/ds-bot`). Self-update persists `<bot-home>/update.json` across remove-and-reinstall and skips `link:` installs or `DS_BOT_APP=1`.
  3. Migrating from the legacy `dsh-bot` package name: remove `dsh-bot` from the profile first, then add `ds-bot`.
- **DS Bot Desktop App:** open `Settings > About DS Bot`. Windows (`latest.yml`) and Linux AppImage (`latest-linux.yml`) auto-update; macOS and `.deb` notify with a GitHub Releases link (`https://github.com/Fei2411/DS-Bot`).
- **Source Checkout:** inside `ds-bot/`, run `npm ci && npm run harness && npm run build`, then restart DSH. When running Desktop App from source, also run `npm ci` in `app/` or start with `.\start.ps1` so `install-links` copies the updated `ds-bot`.
- **Docker:** pull or rebuild (`docker compose pull && docker compose up -d`, or `docker compose build && docker compose up -d`). Because `/data/profiles` persists across container updates, `/opt/ds-bot/ds-bot.tgz` does **not** auto-overwrite an existing `ds-bot` install inside `/data`; update the persisted profile explicitly if needed.

### Repairing DSH dependency pins with `npx ds-bot doctor`

1. Stop the running host or container cleanly.
2. Run a read-only check first:
   ```sh
   npx ds-bot doctor [--home <DSH_HOME>] [--dsh-version <version>]
   ```
3. Inspect the exit code (`0` clean; `1` stale exact pins found; `2` bad CLI arguments, missing DSH version, or malformed `package.json`).
4. Confirm with the user, then repair stale exact pins on core `@deepseek-ai/*` packages and `dsh.profile.bundles` failing `semver.satisfies(dshVersion, spec, { includePrerelease: true })` (ranges, tags, `file:`, and `workspace:` are preserved):
   ```sh
   npx ds-bot doctor --fix [--home <DSH_HOME>] [--dsh-version <version>]
   ```
5. `--fix` deletes stale exact pins and executes `pnpm install --prefer-offline --config.strictDepBuilds=false`. If runtime mismatches persist after exit `0`, trace transitive versions via `pnpm why @deepseek-ai/<package>` inside the profile.

## 5. Known Failure Signatures & Offline Recovery

Always confirm with the user and stop the host/container cleanly before editing profile files:

- **`disabling profile plugin row "bot"` or missing team after crash/upgrade**
  - *Check:* run `npx @deepseek-ai/dsh@<version> --profile <p> --dump-config`.
  - *Cause:* orphan `id: bot` entry in `cordis.patch.yml` without `name: ds-bot`.
  - *Fix:* remove the orphan `id: bot` row in `profiles/<p>/cordis.patch.yml`, verify `ds-bot` is listed in `profiles/<p>/package.json`, and restart.
- **`WEB_PROVIDER_CONFIGURED_MISSING` (`configured web provider "auto" is not registered`)**
  - *Cause:* `web-search-auto` was disabled while `cordis.patch.yml` still sets `web` to `auto`.
  - *Fix:* re-enable `web-search-auto`, or edit the `web` row in `cordis.patch.yml` to specify both `searchProvider` (for example `deepseek-official`) and `fetchProvider: http`.
- **Pending services after DSH upgrade (`sessionController` / `workspaceRegistry`)**
  - *Cause:* stale exact `@deepseek-ai/*` pin in profile `package.json`.
  - *Fix:* stop the host and run `npx ds-bot doctor --fix`.
- **Linux `GLIBC_2.27 not found` (`libghostty-vt.so` on glibc < 2.28)**
  - *Cause:* host OS (such as CentOS 7) lacks glibc >= 2.28 required by DSH PTY binaries.
  - *Fix:* deploy DS Bot using Docker instead; never copy host `.so` libraries into containers.
- **Docker HTTP 403 or LAN access refused**
  - *Cause:* client hostname/IP is not in `DSH_TRUSTED_HOST`.
  - *Fix:* add the hostname or IP (without `:port`) to `DSH_TRUSTED_HOST` under `environment:` in root `docker-compose.yml` or in `docker/.env` (when using `docker/compose.yml`), then recreate the container; keep `DSH_HOST=0.0.0.0` (or `127.0.0.1` behind a same-network reverse proxy).

## 6. Safe Backup, Restore & Migration

- **Built-in move (`Settings > General > Locations`):**
  - Moving the workspace preserves existing chats.
  - In Desktop App, moving the data folder stops the Host, copies everything except `state.lock`, swaps atomically, and updates `locations.json` (blocks OneDrive, `~/.dsh`, program folders, and nested data/workspace locations).
- **Desktop App first-run import:** reads `~/.dsh` strictly read-only after confirming `state.lock` is inactive and session format is compatible; `~/.dsh` is never modified.
- **Manual offline backup & restore checklist:**
  1. Quit Desktop App (`Tray > Quit`), stop DSH, or run `docker compose down`, and verify `bot/state.lock` is gone.
  2. Exclude `bot/state.lock` and live SQLite `-wal`/`-shm` files from any snapshot.
  3. Archive all of `<DSH_HOME>` (`bot`, `sessions`, `storages`, `profiles`, `.credentials.yaml`, `.env`) together with external `workspace` and `DS_BOT_SHELL_DATA`.
  4. When restoring onto a different path or machine, update workspace paths in `storages/workspace.json` and re-point Bots whose `sessions/` `cwd` moved.
  5. After restart, confirm `list_bots`, `recall`, and `<bot-home>/logs/diagnostics.jsonl` show clean state. In a source checkout, also see `docs/self-maintenance.md` and `docs/known-issues.md`.
