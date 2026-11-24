# Custom Local ACP Agents & Core DS Bot Development

Use this reference when wiring a custom ACP-compatible local coding CLI (`local-acp-<id>`) or performing secondary development inside the DS Bot repository (`ds-bot/` and `app/`). Ask for explicit user confirmation before modifying core plugin code or rebuilding host profiles.

## Custom Local Agent CLIs (`ds-bot/src/host/local-agents/`)

DS Bot supports a set of built-in local agent engines (`ROUTE_PREFIX = 'local-'`, defined in `engines.js`, e.g., `'cursor-cli'`, `'antigravity'`) plus user-registered custom ACP agents (`CUSTOM_PREFIX = 'local-acp-'`).

### Registration & Validation (`local-agents/index.js`)

- Custom ACP agents are configured in `Settings → Models → Local agents` and registered via `local-agent-add`:
  - `local-agent-add` passes `{ name, command, args }` through `validateCustom` (up to 40-character `name`, `command` program name, absolute path or `~/path` with no spaces, and `args` with no NUL bytes or newlines), creating ID `agent-<id>` and route `local-acp-<id>` (never colliding with built-in `local-*` IDs).
  - Engine properties like `cwdPerProcess` (per-process directory isolation) and `modes` (permission presets) belong to built-in engines in `engines.js` (such as `antigravity`).
- Defaults & lifecycle (`acp.js` / `adapter.js`):
  - `DEFAULT_CONTEXT_WINDOW = 200_000`
  - `IDLE_CLOSE_MS = 10 * 60_000` (closes idle ACP child processes after 10 minutes)
  - Session replay caps when resuming: `REPLAY_MESSAGES = 12`, `REPLAY_BYTES = 24KB`

### Team MCP Bridge (`mcp.js`, `mcp-stdio.js`, `acp.js`)

- **`LoopbackMcp` (`mcp.js`):** Listens on `http://127.0.0.1:<port>/mcp` with a 32-byte hex Bearer token, `20_000` ms SSE keepalive, `flattenSchema` compatibility, and `toolsFor` exposing `rt.teamTools` plus `approve_agent_action`.
- **Transport negotiation (`acp.js`):** Negotiates `http` -> `stdio` -> `none`. When a CLI only supports stdio MCP, `stdioBridgePath` extracts zero-dependency `mcp-stdio.js` and spawns it via `ELECTRON_RUN_AS_NODE=1` with `DSBOT_MCP_URL` and `DSBOT_MCP_TOKEN`.
- **Subprocess environment scrubbing (`cleanEnv`):** Automatically unwraps Windows `.cmd`/`.bat` shims and strips `DROP_EXACT` plus `DROP_PREFIX = ['DS_BOT_', 'DSH_', 'ANTIGRAVITY_', 'AGY_', 'DEEPSEEK_']` so DSH/Bot credentials never leak into child CLIs.

## Core `ds-bot` Secondary Development

Only take this path in a source checkout when user requirements cannot be solved via capabilities, connectors, custom ACP CLIs, or a standalone DSH plugin. Read `docs/plugin-development.md` (and `docs/design/ui-standard.md` for UI changes) in the repository first.

### Host Architecture & Ordering Invariants (`ds-bot/index.js`)

- Keep `MODULES` initialization order intact:
  - `privacy` MUST be installed before tool execution hooks so private-Bot boundaries apply first.
  - `usage` MUST run after `llm/stream` request/schema rewriters so token/usage tracking sees final normalized payloads.
  - `maintenanceSkills` installs alongside `officeSkills` and `goalSkills` cleanly via `ctx.inject?.({ skills: null }, ...)`.
- **HTTP Channel (`src/host/channel.js`, `src/host/feed.js`):** External integrations post messages through `POST /api/bot` and subscribe to events via `GET /api/bot/feed`.
- **IM Platform Adapters (`src/host/im/platforms/`):** Add new messaging platforms by implementing the adapter interface and registering in `src/host/im/platforms/index.js` alongside built-in adapters (`weixin.js`, `qq.js`, etc.).

### Client UI Rules (`ds-bot/src/client/` & `style-debt.test.js`)

- **Never hand-edit `ds-bot/client.js` or `ds-bot/link.js`:** Make all UI changes inside `ds-bot/src/client/`, then run `npm run build` in `ds-bot/` and commit both source and generated bundle.
- **Strict styling guardrails (`scripts/style-debt.mjs` & `test/style-debt.test.js`):**
  - Colors: Use `--bt-*` CSS custom properties exclusively (exemptions exist only for explicit palette files such as `themes.js`, `inks.js`, `characters.js`, `connector-marks.js`, body `--bt-*`, `rgba(0,0,0,`, and black-to-transparent gradients).
  - Border radii: Restricted to `RADII` (`0`, `4px`, `6px`, `8px`, `10px`, `12px`, `16px`, `18px`, `20px`, `22px`, `999px`, `50%`, `inherit`).
  - Motion: Use spring presets imported from `motion.js`.
  - No new entries may be introduced into `test/style-debt.json`.

### Required Verification Commands (`ds-bot/`)

Before finalizing core changes:
1. `npm run build` && `node scripts/build-client.mjs --check`
2. `npm test` (uses mock LLM; requires `npm run harness` or `DSH_HARNESS` pointing at `@deepseek-ai/*` packages)
3. `npm run lint` (`oxlint`)
4. For host changes (`index.js` or `src/host/`), run the smoke test bench against an isolated `.dsh-test-<name>` directory and stop the bench afterward.
