# Capabilities, MCP Servers, Reusable Skills, and Packs

Use this reference when building or attaching live team extensions (`kind: 'mcp' | 'skill' | 'pack'`) with zero host restart. Source implementations live in `ds-bot/src/host/capabilities.js`, `ds-bot/src/host/tools.js`, `ds-bot/src/host/tool-schema.js`, and `ds-bot/src/host/secrets.js`.

## Team Capability Tools

- `list_capabilities` — Inspect existing team capabilities, types, approval status, runtime statuses (`ready`, `connecting`, `needs-approval`, `error`), and attachments.
- `save_capability` — Create or update a capability entry (`itemInput`). Capability `name` must pass `validateCapabilityName`:
  - Regex: `/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/` (lowercase kebab-case, max 32 chars).
  - Reserved names rejected: any identifier in `CONNECTOR_IDS` (e.g. `'github'`, `'mail'`, catalog and custom connector IDs).
- `delete_capability` — Removes a capability only if allowed (`allowedToEdit` / `usedByOthers` checks).
- `attach_capability` / `detach_capability` — Attach/detach a capability (including expanding `pack` members via `expandCapabilityNames`) to target Bots; orphan items are cleaned with `dropOrphanCapabilities`.

## Capability Kinds & Configuration

### 1. MCP Capabilities (`kind: 'mcp'`)

Mounted via `@deepseek-ai/dsh-mcp-client` with `failOnStartupError: true` and `ENSURE_TIMEOUT_MS = 15_000`.

- **`transport: 'stdio'`:**
  - Fields: `command`, `args` (array), `env` (key-value map).
  - **Approval rule:** Any Bot-saved `stdio` MCP (`!ui`), or any edit changing `command`, `args`, or `env`, forces `approved: false` (`needs-approval`). You MUST ask the user to approve it in `Settings → Tools → Capabilities` before attaching/using it.
- **`transport: 'streamable-http'`:**
  - Fields: `url` (`http:` or `https:`), optional `headers` (key-value map).
  - **Approval rule:** HTTP/HTTPS `streamable-http` MCP capabilities start `approved: true`.

### 2. Skill Capabilities (`kind: 'skill'`)

- Mounted synthetically as `ds-bot-capability-skill-<name>` (`source: 'runtime'`) into `agent.ctx` on `agent/created`.
- For substantial workflows, author the skill using progressive disclosure: keep instructions concise and modular, placing deep scripts/references under `<workspace>/plugins/<name>` or a skill directory's `references/` subfolder.

### 3. Capability Packs (`kind: 'pack'`)

- Bundles existing skill and capability names together so Main Bots can attach/detach a whole toolkit in one call (`expandCapabilityNames`).
- In `Settings → Tools → Capabilities`, team-library items and feature packs can be set per Bot to `Always` (always mounted), `Catalog` (one-line index in the prompt; loaded/unloaded on demand per session with `use_pack` / `drop_pack`), or `Off`.

## Secret Management (`secrets.js`)

Never hardcode API tokens or passwords into capability files, scripts, or `save_capability` payloads:

1. Use `list_secrets` to check whether the needed secret name already exists.
2. In your own chat (or guide the user in Settings), call `request_secret` (`fill` or `allow` mode). Secret names must match `/^[A-Z][A-Z0-9_]{0,63}$/` (values 4–16,384 characters).
3. Reference secrets in capability fields using `$DSH_SECRET_<NAME>` (`SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g`):
   - **Preferred:** put `$DSH_SECRET_<NAME>` in `headers` (for `streamable-http`) or `env` (for `stdio`) — injected as the raw secret value into the process/request.
   - **Avoid if avoidable:** inside `url`, `$DSH_SECRET_<NAME>` is automatically `encodeURIComponent`-encoded.
4. `secrets.js` runs `redactDeep` on `tools/execute` and `llm/stream`, replacing known secret values with `[secret:<NAME>]` (encrypted store stays at `<DSH_HOME>/bot/secrets.json`, mode `0o600`).

## Provider Schema Compatibility (`plainToolSchema`)

Before `llm/stream` forwards MCP/connector tool schemas to models, `ds-bot/src/host/tool-schema.js` (`plainToolSchema`) simplifies each tool's `parameters` JSON schema:
- Deletes `$ref`, `$defs`, `definitions`, and `const`.
- Collapses `oneOf` / `anyOf` / `allOf` to the first branch whose `type !== 'null'`.
- Infers missing `type` for `object` (`properties` present), `array` (`items` present), or scalar `enum`, and strips `null` from scalar `enum`.

**Authoring rule:** Keep every MCP tool's `inputSchema` flat and explicit (`type: 'object'`, `properties`, `required`, simple `string`/`number`/`boolean`/`array`/`object` types without `$ref`, `oneOf`, or `const`).

## Minimal Node `stdio` MCP Server Skeleton

Store Bot-authored servers under `<workspace>/plugins/<name>/` (never inside `<DSH_HOME>` or `bot/`). Write diagnostics only to `process.stderr`; reserve `process.stdout` exclusively for newline-delimited JSON-RPC:

```js
// <workspace>/plugins/example-tool/server.mjs
import { createInterface } from 'node:readline'

const TOKEN = process.env.SERVICE_TOKEN ?? ''
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

rl.on('line', async (line) => {
  if (!line.trim()) return
  const req = JSON.parse(line)
  if (req.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'example-tool', version: '0.1.0' },
      },
    })
  }
  if (req.method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [{
          name: 'ping',
          description: 'Verify connectivity without leaking secrets',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        }],
      },
    })
  }
  if (req.method === 'tools/call') {
    const query = String(req.params?.arguments?.query ?? '')
    return send({
      jsonrpc: '2.0',
      id: req.id,
      result: { content: [{ type: 'text', text: `ok:${query}:configured=${Boolean(TOKEN)}` }] },
    })
  }
  if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `Unknown method: ${req.method}` } })
  }
})
```

Save via `save_capability` (`name: 'example-tool'`, `kind: 'mcp'`, `transport: 'stdio'`, `command: 'node'`, `args: ['<workspace>/plugins/example-tool/server.mjs']`, `env: { SERVICE_TOKEN: '$DSH_SECRET_MY_TOKEN' }`), ask the user to approve in `Settings → Tools → Capabilities`, then `attach_capability` and test `ping`.

## Progressive-Disclosure Checklist for Authored Skills

- Keep `SKILL.md` short (~40–85 lines): safety rules, when to use the skill, and a table routing to `references/*.md`.
- Put bulky CLI flags, JSON schemas, API specs, and examples inside `references/*.md` so Bots load them only when needed.
- Never embed raw secrets, live host paths with real OS usernames, or prohibited draft/legacy terms.
