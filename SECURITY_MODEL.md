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
- IM messages (`ds-bot/src/host/im/`, adapters in `im/platforms/`): each connection is an IM bot account bound to a Bot; only senders the user has paired in Settings reach it, and replies go out only to the chat whose message started the turn. How far a paired sender is trusted is an open question below.
- Paired phones and browser clients over the phone link (`link/`, `mobile/`, host side `phone.js`, `mobile.js`): X25519 identities, pairing by QR code plus a one-time code sent inside the encrypted handshake. The Relay Server (`link/server`, default `wss://relay.dsbot.app/v1/link`) is reachable from the internet and only forwards encrypted frames; browser clients also run the page it serves.
- Local API & MCP gateway (`ds-bot/src/host/api/`), off by default: local programs holding a revocable, hashed Bearer token (`Authorization` header only; URL query tokens are rejected), bound to `127.0.0.1` by default (non-loopback binding requires explicit confirmation); requests with an `Origin` header or a non-local `Host` (on loopback) are refused with `403`. Each token is bounded by explicit scopes (`read`, `message`, `event:ingest`, `memory:write`, and confirmation-gated `approval` / `team:manage`) and a target whitelist. Private Bots are excluded by default and return `404` when unauthorized; turning a Bot private immediately revokes access for tokens that did not explicitly confirm it. Secrets plaintext, deleting Bots, changing Bot privacy, changing computer-use policy, and managing API tokens themselves are never exposed via the API or remote phone/web channels; `privacy.js` also blocks Bots' own file and shell tools from reading `api-tokens.json`, `mcp.json`, or `api-audit.jsonl`. External events submitted to `POST /v1/events` are marked `external_untrusted` in the ledger and carry no user command authority.

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
- Paired-phone input over the encrypted link is owner-trusted by design: pairing binds the phone's X25519 identity by QR plus one-time code, so what it sends is the owner's own input like the composer's, not an external channel. (The Relay Server itself, pairing abuse, and denial of service stay open below.)
- Memory's transcript is a trust boundary (`ds-bot/src/host/memory-review.js`): input that merely masquerades as the user — paired IM senders, whose identity the host cannot verify as the owner, and local API tokens any program can hold (`im:*` / `api:*` request ids, tagged `via` in group logs) — never enters the memory review's transcript, so an injected instruction cannot be laundered through an idle review into permanent memory. Transcripts are quoted behind a fence sized one longer than the longest run of angles inside, and automated writes do not silently re-add what memory dropped within 14 days.
- Secrets: scoped per Bot (`canUse`), redacted from tool results and outbound model requests (`redactor`, JSON/URL-encoded forms).
- Optional encryption at rest: the secrets file can be a scrypt + AES-256-GCM envelope. A passphrase unlocks it in Settings or, for unattended starts, from `DS_BOT_SECRETS_PASSPHRASE` or `DS_BOT_SECRETS_PASSPHRASE_FILE`; a locked store has no values, refuses secret writes, and shows why in Settings.
- Remote connectors require HTTPS, except custom connectors can use HTTP on localhost/127.*; custom local commands are also supported (`connectors/index.js`).
- HTML widgets in `sandbox="allow-scripts"` iframes; Electron webviews sandboxed with contextIsolation and own partitions; IPC handlers call `assertWindow(event)`.
- Cookie values stay in the Electron main process (`cookie-import.mjs`).
- Launch token redacted from host logs (`host-process.mjs`).
- Telemetry (`ds-bot/src/host/telemetry.js`, `telemetry/`): strictly gated behind explicit user confirmation of the privacy notice (`noticeAccepted`) and environment kill switches (`DS_BOT_TELEMETRY_DISABLED`, `DO_NOT_TRACK`). Sends only allowlisted daily aggregates (monthly rotating random UUID, coarse buckets, built-in enums) and optional structured error fingerprints (relative `ds-bot/`/`app/`/`link/`/`mobile/` stack frames only, no raw `error.message`). Private Bots are excluded from both DS Bot telemetry and upstream DSH `session-log-deepseek` / `session-telemetry/record` uploads; DSH session-log and feedback telemetry default to off in DS Bot. Telemetry settings are computer-only (refused over remote links) and `bot/telemetry.json` is off-limits to Bot file/shell tools.

### Plugin execution security (`ds-bot/src/host/plugins/`)

Bot plugins are third-party or registry-distributed code. The controls below are what is enforced today; the boundaries are stated exactly, including what is NOT yet enforced.

- **Execution tiers** (`tiers.js`): `data` / `declarative` / `sandboxed-ui` / `trusted-worker` with capability ceilings (`entry`, `process`, `worker`). Enforced now: registry and custom manifests declaring an impossible combination (e.g. a `data` plugin that spawns processes, or a confined tier riding a DSH/stdio activation path, which always executes worker code) are dropped fail-closed, and native in-process mounts reject confined tiers outright. **Future groundwork, not enforcement**: declaring `data`/`declarative`/`sandboxed-ui` today does not sandbox anything — the sandboxed execution machinery does not exist yet. Until it does, every plugin that actually runs executes with host-level trust regardless of its declared tier; the tier vocabulary exists so manifests can carry honest intent ahead of enforcement.
- **Consent fingerprints** (`consent.js`, `content-hash.js`): installing or first-activating a plugin records a server-computed fingerprint over what it is — declared capabilities, execution tier, executable entry (command/spec/URL with argv and env/header key NAMES, never values), exact package version when known, the SHA-256 content hash of the executable tree, and slot placement. Drift in any input invalidates the approval: the plugin stops and cannot run until the user approves it again exactly as it now is (`plugins-consent` recomputes the fingerprint server-side; a client cannot widen what it approves). Content hashing binds the installed bundle directory (what actually executes) with `node_modules`/`.git` contents excluded; the entry point may itself be a symlink (pnpm's isolated layout, `link:` installs) and resolves to the real directory it points at, while symlinks escaping from INSIDE the resolved tree still fail closed. A tree that resolves but cannot be hashed (escaping symlink, unreadable, capability overrun) fails CLOSED as `unverifiable` — consent is never recorded for unverifiable bytes. The full consent gate rules every enablement path: install-time activation, slot re-picking, the enable toggle, updates, and the reconcile all refuse to start drifted or unverifiable bytes before `setBundleEnabled(true)` ever reaches the package manager; explicit approval through `plugins-consent` is the only way back. Honest nuance: MCP plugins whose package spec is floating (`@latest`, ranges, bare names) run whatever the registry serves at spawn time; approval cannot and does not pin their bytes — the UI says so explicitly, and only exact-pinned specs feed version-based kill matching. Hashing installs whose directory cannot be resolved (registry/npm packages outside a DSH profile context) degrades to version-plus-manifest binding, documented rather than hidden.
- **Kill-list circuit breaker** (`kill-list.js`): registry documents may embed a kill list (`id` with optional semver range or content hashes; `*` matches every version including unknown/floating ones). Evaluation is offline-first against a local cache, applies per-source anti-rollback (a strictly older document never replaces a newer one, far-future `issuedAt` is rejected), and re-evaluates ALREADY-RUNNING plugins when fresh kills land — a killed plugin is unmounted and refuses reactivation. Trust root: kill lists are unsigned; their authority is the registry document's transport (HTTPS plus control of the registry host). A compromised registry can kill but never silently un-kill or weaken what another source already killed (entries merge across sources, deduplicated by exact id+range+hash identity).
- **DSH bundle activation boundary** — stated exactly: DSH's `pluginManager` activates enabled bundles inside its own operations and at process startup, before DS Bot's gates can evaluate in-process. Enforced mitigation: DS Bot installs bundles with `enabled: false`, pre-disables a bundle before updating it (DSH updates install with the bundle's current selection, so the new version and any restore install disabled), gates every enablement through kill-list and consent evaluation, and persistently disables in the profile any bundle whose bytes are killed or consent-invalid — so the NEXT startup does not execute it. Residual, accepted: (1) a bundle already activated inside the CURRENT process before invalidation is unmounted at the plugin layer but its DSH-side activation is not retroactively preempted within that process; (2) package-manager build scripts during install are governed by the separate `approvedBuilds` approval, never implied by plugin consent.
- **MCP child-process environment** (`env.js`): stdio MCP servers spawn through `@deepseek-ai/dsh-mcp-client`, whose real contract is `{...scrubbedParentEnv(), ...config.env}` — DSH's scrub drops credential-shaped names (`KEY`/`TOKEN`/`SECRET`/`PASSWORD` patterns, `DSH_*`) and the spawn REPLACES the child environment wholesale. DS Bot's contribution: a nullification overlay that empties capability variables the parent may carry (`SSH_AUTH_SOCK`, `KUBECONFIG`, `DOCKER_HOST`, `LD_PRELOAD`/`DYLD_INSERT_LIBRARIES`, credential-shaped leftovers) inside `config.env`, plus an allowlist for host-level runner env (`ELECTRON_RUN_AS_NODE` survives because the desktop runner needs it), with the plugin manifest's declared entries applied verbatim on top so a deliberate user declaration can consciously re-enable a variable. Boundary, not hidden: empty is not identical to absent for every conceivable consumer, unusual non-secret variable names outside the blocked list still pass through DSH's scrub, and deleting inherited ambient variables entirely requires an authoritative-env option in `dsh-mcp-client` upstream.

## Out of scope / accepted risk (maintainer)

- **Encryption at rest does not protect a running host**: the process needs the decrypted values and, for encrypted stores, the passphrase (in memory or in the environment/passphrase file). A compromised process, a same-user process that can read the environment, or an administrator can get the keys. The benefit is disk copies and backups not carrying plaintext; keep the passphrase out of those copies.

- **Docker edition: Bots have full access inside the container by design** (`danger-full-access`, approval `never`). A Bot changing or reading files inside the container is not a finding; escaping the container or leaking keys/secrets still is.
- DSH itself is upstream; not explicitly ruled out, but fixes belong upstream (hard rule: never patch DSH).

## Open questions

- IM: is a paired IM sender trusted like the user, or untrusted input like a message from another Bot?
- Phone link: is a paired phone trusted like the user, and is the public Relay Server in scope (denial of service, metadata, pairing abuse)?
- Is the Docker web UI expected to be reachable only on a trusted LAN?
- Should a secret scoped to one Bot be treated as hidden from Main Bots too?
