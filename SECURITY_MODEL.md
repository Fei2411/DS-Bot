# DS Bot security model

The threat model that security reviews and scans of this repository start from. Infrastructure is `docker/` and `docker-compose.yml` in this repository.

## System overview and trust boundaries

DS Bot is a team of long-lived LLM Bots built as a plugin on DeepSeek Harness (DSH). It runs in three ways:

- **DSH Desktop / DSH Web** with the `ds-bot` plugin, on the user's own computer.
- **Desktop app** (`app/`, Electron) that runs a pinned DSH with the plugin in its own `DSH_HOME`, and imports a team from `~/.dsh` (read only).
- **Docker** (`docker/`, `docker-compose.yml`): DSH Web on the container's concrete address at port 3080 (the entrypoint translates `DSH_HOST=0.0.0.0`; published as `0.0.0.0:13080`), `DSH_PERMISSION_MODE=danger-full-access`, approval `never`. The container is the sandbox boundary.

Each Bot has its own saved model/settings profile, separate from the host's DSH installation profile. Model Bots use DSH's agent loop and model service; local-agent routes run the CLI's tools and model access. Auxiliary model calls use the model service outside the agent loop. DeepSeek OCR/TTS/ASR and web search/fetch make direct service requests, so the DSH model route is not a universal outbound-request boundary. Phone and browser clients (`mobile/`, `link/`) access the running host over an encrypted link through a relay; browser clients additionally trust the page served by that relay.

Trust boundaries:
1. Untrusted content -> model -> Bot tools. Web pages, files, search results, connector/MCP results and messages from other Bots reach the model; the model's tool calls run with the Bot's permission preset.
2. Ordinary Bot -> Main Bot rights (create/change/stop Bots, groups, folders), enforced in `ds-bot/src/host/tools.js` via `rt.isMain`.
3. Model/tool output -> outbound model requests (secret redaction in `ds-bot/src/host/secrets.js`).
4. Browser renderer -> host: `POST /api/bot` channel (`ds-bot/src/host/channel.js`, `ROUTE` in `constants.js`) and Electron IPC (`app/src/main.mjs`, `preload.cjs`).
5. Bot-produced HTML widgets -> app page (`ds-bot/src/client/widget-cell.js`, `sandbox="allow-scripts"` iframe without same-origin).
6. Bot browser pages -> app (`app/src/bot-browser.mjs`, `bot-views.mjs`: sandboxed, contextIsolation, own partition).

## Components

- **host** — plugin server side: `ds-bot/index.js`, `ds-bot/src/host/` (roster, tools, turns/delivery, background tasks, groups/ledger, goals, parts, memory, schedules, permissions, privacy, folders, capabilities/packs, connectors, providers, local-agents, computer, im, phone/mobile, mcp-server).
- **secrets** — `ds-bot/src/host/secrets.js` (`bot/secrets.json` mode 600, optional passphrase encryption at rest in `secrets-crypto.js`, `$DSH_SECRET_<NAME>`, redactor) and API keys/providers (`providers.js`, `models.js`).
- **client** — browser UI: `ds-bot/src/client/` (incl. settings console, widget-cell, read-page, connectors UI) and generated `ds-bot/client.js`.
- **browser & computer** — Bot browser bridge and browser plugins (`ds-bot/src/host/browser.js`, `browser-plugins.js`, `src/host/browser/`, `browser-plugins/`) and computer-use mediation (`ds-bot/src/host/computer/`).
- **remote & im** — encrypted phone/browser link (`link/`, `mobile/`, `ds-bot/src/host/phone.js`, `mobile.js`), IM bridges (`ds-bot/src/host/im/`), and local MCP server (`ds-bot/src/host/mcp-server.js`).
- **desktop-app** — Electron app: `app/src/` (main, start-window, preload, IPC, cookie import, updates, import from `~/.dsh`, move-data).
- **web-search** — `ds-bot/web-search.js`.
- **docker** — `docker/Dockerfile`, `entrypoint.sh`, `docker.patch.yml`, `docker-compose.yml`.

## Entry points and who reaches them

- Chat input from the user (trusted).
- Content the Bot reads: web pages (Bot browser, `read_browser`, web search), files in the work folder, connector/MCP tool results, messages from other Bots and group chats, scheduled-task prompts. **Attacker-controlled.**
- `/api/bot` HTTP endpoints and DSH Web UI: the local user; in Docker, anyone who can reach port 13080 (DSH trusted-host list + launch token).
- Electron IPC from the app window.
- MCP access (`ds-bot/src/host/mcp-server.js`), off by default: local programs holding a per-client token, on 127.0.0.1 only; requests with an `Origin` header or a non-local `Host` are refused. A client sends messages as a marked user channel to the Bots and groups in its scope (never private Bots) and cannot answer approvals or questions, or reach settings, secrets or tools itself. Each message still runs a normal turn of the target Bot under that Bot's permission preset, so a token can direct its Bots to do anything they may do without an approval; with the default scope that is the Main Bots, which have the most rights. The source marker is information only. Its messages are untrusted input like any channel message.

## Assets (maintainer-ranked)

1. **Critical: API keys and Bot secrets** — provider keys, `secrets.json`, `$DSH_SECRET_*`, connector tokens. Must not leak to the model, logs, tool results, other Bots outside the secret's scope, or outbound requests.
2. **Critical: files on the user's computer** — outside the Bot's work folder; `~/.dsh` must never be written by the app.
3. Other: imported cookies / browser login state, conversations and memory.

## Attacker profiles

- **Primary (maintainer-confirmed): prompt injection** in web pages, files or messages that makes a Bot exceed its rights — exfiltrate keys/secrets, read or write user files outside its scope, gain Main Bot rights, change other Bots, bypass the permission preset or redaction.
- Lower concern (not chosen by the maintainer): LAN users reaching the Docker web UI, malicious browser plugins or connectors, a rogue ordinary Bot acting by itself.

## Existing controls

- Main-Bot checks in `tools.js` (`rt.isMain`, `rt.isAdminOf`).
- Working folders, the team workspace and Bot photos stay out of DSH's data and the team's data (`folders.js` `guarded`/`inData`).
- Private Bots (`privacy.js`): user-only switch; other Bots cannot read a private Bot's working folder, memory or Sessions, and a private Bot's outbound sharing (`message_bot`, shared capabilities, writes outside its folder) requires user approval; protection stays after deletion until the user releases it in Settings.
- Per-Bot permission presets (`permissions.js`), set on every Session.
- Secrets: scoped per Bot (`canUse`), redacted from tool results and outbound model requests (`redactor`, JSON/URL-encoded forms).
- Optional encryption at rest: the secrets file can be a scrypt + AES-256-GCM envelope. A passphrase unlocks it in Settings or, for unattended starts, from `DS_BOT_SECRETS_PASSPHRASE` or `DS_BOT_SECRETS_PASSPHRASE_FILE`; a locked store has no values, refuses secret writes, and shows why in Settings.
- Remote connectors require HTTPS, except custom connectors can use HTTP on localhost/127.*; custom local commands are also supported (`connectors/index.js`).
- HTML widgets in `sandbox="allow-scripts"` iframes; Electron webviews sandboxed with contextIsolation and own partitions; IPC handlers call `assertWindow(event)`.
- Cookie values stay in the Electron main process (`cookie-import.mjs`).
- Launch token redacted from host logs (`host-process.mjs`).

## Out of scope / accepted risk (maintainer)

- **Encryption at rest does not protect a running host**: the process needs the decrypted values and, for encrypted stores, the passphrase (in memory or in the environment/passphrase file). A compromised process, a same-user process that can read the environment, or an administrator can get the keys. The benefit is disk copies and backups not carrying plaintext; keep the passphrase out of those copies.

- **Docker edition: Bots have full access inside the container by design** (`danger-full-access`, approval `never`). A Bot changing or reading files inside the container is not a finding; escaping the container or leaking keys/secrets still is.
- DSH itself is upstream; not explicitly ruled out, but fixes belong upstream (hard rule: never patch DSH).

## Open questions

- Is the Docker web UI expected to be reachable only on a trusted LAN?
- Should a secret scoped to one Bot be treated as hidden from Main Bots too?
