# DS Bot security model

The threat model that security reviews and scans of this repository start from. Infrastructure is `docker/` and `docker-compose.yml` in this repository.

## System overview and trust boundaries

DS Bot is a team of long-lived LLM Bots built as a plugin on DeepSeek Harness (DSH). It runs in three ways:

- **DSH Desktop / DSH Web** with the `ds-bot` plugin, on the user's own computer.
- **Desktop app** (`app/`, Electron) that runs a pinned DSH with the plugin in its own `DSH_HOME`, and imports a team from `~/.dsh` (read only).
- **Docker** (`docker/`, `docker-compose.yml`): `dsh web` on `0.0.0.0:3080` (published as `0.0.0.0:13080`), `DSH_PERMISSION_MODE=danger-full-access`, approval `never`. The container is the sandbox boundary.

Trust boundaries:
1. Untrusted content -> model -> Bot tools. Web pages, files, search results, connector/MCP results and messages from other Bots reach the model; the model's tool calls run with the Bot's permission preset.
2. Ordinary Bot -> Main Bot rights (create/change/stop Bots, groups, folders), enforced in `ds-bot/src/host/tools.js` via `rt.isMain`.
3. Model/tool output -> outbound model requests (secret redaction in `ds-bot/src/host/secrets.js`).
4. Browser renderer -> host: `POST /api/bot` channel (`ds-bot/src/host/channel.js`, `ROUTE` in `constants.js`) and Electron IPC (`app/src/main.mjs`, `preload.cjs`).
5. Bot-produced HTML widgets -> app page (`ds-bot/src/client/widget-html.js`, `sandbox="allow-scripts"` iframe without same-origin).
6. Bot browser pages -> app (`app/src/bot-browser.mjs`, `bot-views.mjs`: sandboxed, contextIsolation, own partition).

## Components

- **host** — plugin server side: `ds-bot/index.js`, `ds-bot/src/host/` (roster, tools, turns/delivery, groups, parts, memory, schedules, permissions, connectors, providers).
- **secrets** — `ds-bot/src/host/secrets.js` (secrets.json mode 600, `$DSH_SECRET_<NAME>`, redactor) and API keys/providers (`providers.js`, `models.js`).
- **client** — browser UI: `ds-bot/src/client/` (incl. widget-html, read-page, connectors UI) and generated `ds-bot/client.js`.
- **browser** — Bot browser bridge and browser plugins: `ds-bot/src/host/browser.js`, `browser-plugins.js`, `src/host/browser/`, `browser-plugins/`.
- **desktop-app** — Electron app: `app/src/` (main, preload, IPC, cookie import, updates, import from `~/.dsh`, move-data), `app/engine/`.
- **web-search** — `ds-bot/web-search.js`.
- **docker** — `docker/Dockerfile`, `entrypoint.sh`, `docker.patch.yml`, `docker-compose.yml`.

## Entry points and who reaches them

- Chat input from the user (trusted).
- Content the Bot reads: web pages (Bot browser, `read_browser`, web search), files in the work folder, connector/MCP tool results, messages from other Bots and group chats, scheduled-task prompts. **Attacker-controlled.**
- `/api/bot` HTTP endpoints and DSH Web UI: the local user; in Docker, anyone who can reach port 13080 (DSH trusted-host list + launch token).
- Electron IPC from the app window.

## Assets (maintainer-ranked)

1. **Critical: API keys and Bot secrets** — provider keys, `secrets.json`, `$DSH_SECRET_*`, connector tokens. Must not leak to the model, logs, tool results, other Bots outside the secret's scope, or outbound requests.
2. **Critical: files on the user's computer** — outside the Bot's work folder; `~/.dsh` must never be written by the app.
3. Other: imported cookies / browser login state, conversations and memory.

## Attacker profiles

- **Primary (maintainer-confirmed): prompt injection** in web pages, files or messages that makes a Bot exceed its rights — exfiltrate keys/secrets, read or write user files outside its scope, gain Main Bot rights, change other Bots, bypass the permission preset or redaction.
- Lower concern (not chosen by the maintainer): LAN users reaching the Docker web UI, malicious browser plugins or connectors, a rogue ordinary Bot acting by itself.

## Existing controls

- Main-Bot checks in `tools.js` (`rt.isMain`, `rt.isAdminOf`).
- Per-Bot permission presets (`permissions.js`), set on every Session.
- Secrets: scoped per Bot (`canUse`), redacted from tool results and outbound model requests (`redactor`, JSON/URL-encoded forms).
- Connectors refuse non-HTTPS addresses (`connectors.js`).
- HTML widgets in `sandbox="allow-scripts"` iframes; Electron webviews sandboxed with contextIsolation and own partitions; IPC handlers call `assertWindow(event)`.
- Cookie values stay in the Electron main process (`cookie-import.mjs`).
- Launch token redacted from host logs (`host-process.mjs`).

## Out of scope / accepted risk (maintainer)

- **Docker edition: Bots have full access inside the container by design** (`danger-full-access`, approval `never`). A Bot changing or reading files inside the container is not a finding; escaping the container or leaking keys/secrets still is.
- DSH itself is upstream; not explicitly ruled out, but fixes belong upstream (hard rule: never patch DSH).

## Open questions

- Is the Docker web UI expected to be reachable only on a trusted LAN?
- Should a secret scoped to one Bot be treated as hidden from Main Bots too?
