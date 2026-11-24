# Deployment Paths & Runtime Layout

Use this reference when locating DS Bot installations, `DSH_HOME`, `DS_BOT_HOME`, `DS_BOT_WORKSPACE`, `DS_BOT_SHELL_DATA`, logs, Desktop App import roots, or Docker mounts. Never read or write live user data when inspecting a checkout or running tests.

## Deployment Mode Detection & OS Paths

| Mode | Detection markers | `DSH_HOME` & Profile | Workspace & Extras |
|---|---|---|---|
| **Desktop App** | `DS_BOT_APP=1`, Electron binary, `Settings > General > Locations` | `$DS_BOT_HOME`, `<root>/data`, or `~/.ds-bot`<br>(profile `profiles/ds-bot`, team home `bot/`) | Workspace: `~/DS Bot`, `<root>/workspace`, or `<DSH_HOME>/bot/workspace` if `$DS_BOT_HOME` is set alone (overridden by `DS_BOT_WORKSPACE`).<br>Shell data in `DS_BOT_SHELL_DATA`: Windows `%APPDATA%\DS Bot`, macOS `~/Library/Application Support/DS Bot`, Linux `${XDG_CONFIG_HOME:-~/.config}/DS Bot` (`locations.json`, browser `Partitions`, `logs/main.log`). |
| **Docker Compose** | Container environment with `/data` volume and `/opt/ds-bot/ds-bot.tgz` | `/data` (when `DSH_HOME=/data`, profile `profiles/web`) | `/workspace` mount; persistent host state under `/data` |
| **Source Checkout** | Git repo containing `ds-bot/`, `app/`, `start.ps1`, `.ds-bot-local`, or `ds-bot/dev/bench.sh` | Repo-local `.ds-bot-local/data` (via `start.ps1`) or `ds-bot/.dsh-test-<name>` (via `bench.sh`) | Source plugin at `<repo>/ds-bot`, Electron app at `<repo>/app`; `.ds-bot-local/workspace` and `.ds-bot-local/shell` |
| **DSH Plugin** | Standalone `dsh` installation running profile with `ds-bot` dependency | `DSH_HOME` env var, or default `~/.dsh` | `profiles/<profile>/` under `DSH_HOME` (`dsh plugin --profile <profile> add ds-bot`); team home `<DSH_HOME>/bot` |

### Desktop App First-Run Import Boundary

- On first startup, the Desktop App (`app/src/first-run.mjs`, `app/src/profile.mjs`) reads an existing `~/.dsh` installation **read-only** to import the user's Bot team into `DSH_HOME` (`~/.ds-bot` or `$DS_BOT_HOME`).
- It checks that `state.lock` is inactive and never writes back to `~/.dsh`. Switching back to standalone DSH later does not carry over changes made inside the Desktop App unless exported or copied while both hosts are stopped.

## Key Environment Variables

- `DSH_HOME`: Root directory holding DSH profiles, sessions, auth/provider state, and `<bot-home>` (`<DSH_HOME>/bot`).
- `DS_BOT_HOME`: Desktop App environment variable overriding `DSH_HOME` (defaults to `~/.ds-bot`).
- `DS_BOT_WORKSPACE`: Overrides the default Bot workspace folder (defaults to `~/DS Bot`, or `<DSH_HOME>/bot/workspace` if `$DS_BOT_HOME` is set alone).
- `DS_BOT_SHELL_DATA`: Overrides the Electron `<userData>` path holding `locations.json`, browser `Partitions`, and `logs/main.log` (`%APPDATA%\DS Bot` on Windows).
- `DS_BOT_APP=1`: Set when running under the Desktop App host.
- `DSH_HARNESS`: Points source-checkout unit tests and `ds-bot/dev/bench.sh` to a DSH checkout or `ds-bot/dev/harness`.
- `DSH_TRUSTED_HOST`: Reverse-proxy / headless host allowlist for remote Web deployments (e.g., Docker behind a custom domain/IP).
- `DS_BOT_SECRETS_PASSPHRASE` / `DS_BOT_SECRETS_PASSPHRASE_FILE`: Optional passphrase or key-file path that unlocks an already-encrypted `<DSH_HOME>/bot/secrets.json` (the store is plaintext by default; encryption is opt-in under Settings → Secrets).

## Runtime Directory Layout (`<bot-home>` = `<DSH_HOME>/bot`)

Inspect paths read-only while the host is running; mutate only offline after verifying clean shutdown:

- `<DSH_HOME>/profiles/<profile>/package.json` & `cordis.patch.yml` — Installed plugins and Cordis service patch rows for the active profile (Desktop App uses profile `ds-bot`).
- `<bot-home>/state.json` — Team roster, Bot configs, groups, schedules metadata, and connector bindings.
- `<bot-home>/state.lock` — Host lock file (refreshed every 15s; considered stale after 60s). Presence of a fresh lock means another host owns `<DSH_HOME>`.
- `<bot-home>/state.json.broken-<ts>` — Automatic quarantine copy created if `state.json` failed JSON parse on load.
- `<bot-home>/secrets.json` — Secret store (`0o600`, plaintext by default; at-rest encryption is opt-in). **Do not open or print this file**; inspect names only via `list_secrets`.
- `<bot-home>/logs/diagnostics.jsonl` & `diagnostics.jsonl.1` — Structured Bot diagnostic events (rotates when exceeding 1 MiB or 200 entries; secrets and home paths redacted).
- `<bot-home>/chat-index.sqlite` — SQLite FTS/conversation index queried by `read_own_chat`.
- `<bot-home>/memory/` — Agent memory files: `journal.jsonl`, `journal.torn`, `reviewed.json`, `retired.jsonl`, `bots/<botId>/`, `groups/<roomId>/`, and `team/`.
- `<bot-home>/ledger/` and `<DSH_HOME>/sessions/*.jsonl` — Bot conversation ledger and underlying DSH session files managed by DSH itself.
- `<bot-home>/im/<connId>.json` — Persisted IM channel pairing and connection state.
- Workspace fallback: `<DSH_HOME>/bot/workspace` if `$DS_BOT_HOME` is set alone without `DS_BOT_WORKSPACE` or `~/DS Bot`.
- `<DSH_HOME>/attachments` — Uploaded attachments managed by DSH.

### Desktop App Electron Logs

When running the Desktop App (`DS_BOT_APP=1`), Electron main-process logs live in `DS_BOT_SHELL_DATA/logs/` (accessible via `Settings > General > Locations`):
- `main.log`, `main.1.log`, `main.2.log` — Startup errors, DSH boot output, `update.json` / `latest.yml` auto-update activity, and uncaught exceptions (2 MB x 3 rotation).
