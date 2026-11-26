---
name: ds-bot-plugin-dev
description: Build, register, and attach plugins, MCP servers, reusable skills, capability packs, connectors, local ACP agents, or DSH extensions for DS Bot using progressive disclosure.
---

# DS Bot Extension & Plugin Development

Guide for Main Bots and contributors creating new capabilities, MCP servers, reusable skills, capability packs, connectors, local ACP agents, standalone DSH plugins, or core DS Bot extensions.

## Extension Layer Decision Tree

Always pick the simplest extension layer that satisfies the user's requirement:

1. **Live Team Capability (`save_capability` + `attach_capability`) — default first choice:**
   - Best for reusable prompts/workflows (`kind: 'skill'`), external or Bot-authored MCP tool servers (`kind: 'mcp'`), or bundles (`kind: 'pack'`).
   - Takes effect live with zero host restart and survives upgrades cleanly inside team state. Feature-pack states can be set per Bot to `Always`, `Catalog` (one-line prompt index loaded/unloaded per session via `use_pack` / `drop_pack`), or `Off`.
2. **Team Connector (`list_connectors` / `request_connector` / `Settings → Connect → Connectors`):**
   - Best when integrating one of the built-in catalog services (OAuth, API key, or keyless) or a user-managed HTTP MCP server routed through DS Bot's loopback connector gateway (`readOnly` policy, OAuth token refresh, per-Bot `offFor`).
3. **Custom Local Agent CLI (`local-acp-<id>`):**
   - Best when connecting an external ACP-compatible coding CLI (`Settings → Models → Local agents`, validated via `validateCustom`) that should receive DS Bot team tools over `LoopbackMcp` / `mcp-stdio.js`.
4. **Standalone DSH Plugin (`profiles/<profile>`) or Core `ds-bot` Change — last resort:**
   - Required only for new DSH kernel/Cordis services, client UI views, HTTP endpoints (`/api/bot`), or IM platform adapters.
   - Always obtain explicit user confirmation first (requires host stop/restart, profile installs, or client rebuilds/tests in a source checkout).

## Non-Negotiable Self-Extension Guardrails

- **Secrets via `request_secret`:** Store API keys/tokens with `request_secret` and reference them as `$DSH_SECRET_<NAME>` in capability config. Prefer `headers` or `env` (replaced raw); references inside `url` are `encodeURIComponent`-encoded. Values are redacted as `[secret:<NAME>]` in tool output and LLM streams.
- **MCP approval gate:** Bot-saved `stdio` MCP servers ALWAYS start `approved: false` (`needs-approval`). Tell the user to approve the capability in `Settings → Tools → Capabilities` before attaching or testing it. HTTP/HTTPS `streamable-http` MCP servers start `approved: true`.
- **Safe artifact location:** Store Bot-authored scripts, local MCP servers, and helper packages under `<workspace>/plugins/<name>` — NEVER inside `<DSH_HOME>` or `bot/`.
- **Progressive disclosure in authored skills:** Keep every skill's `SKILL.md` concise (~40–85 lines covering safety, decision criteria, and routing) and put schemas, templates, and walkthroughs into on-demand `references/*.md` files.
- **DSH plugin isolation & safety:** Standalone DSH plugins MUST declare `"@deepseek-ai/*": "*"` in `peerDependencies`, respect `sessionId !== botId` (do not conflate session IDs with Bot IDs), never claim `id: bot`, `local-*`, or `local-acp-*`, and never edit live `cordis.patch.yml`, `package.json`, or `bot/state.json`.
- **No hand-edited client bundles:** For core `ds-bot` UI edits, modify `ds-bot/src/client/` and run `npm run build`; never edit `ds-bot/client.js` or `ds-bot/link.js` by hand.

## On-Demand References

Load **only** the reference matching the chosen extension layer before writing code or saving capabilities:

| Extension layer | Load reference | Covers |
|---|---|---|
| Capabilities, MCP servers, Skills, Packs | `references/capabilities-and-mcp.md` | `save_capability`, `attach_capability`, `$DSH_SECRET_<NAME>`, `stdio` approval, `plainToolSchema`, Node MCP skeleton, skill structure |
| Connectors & Standalone DSH Plugins | `references/dsh-plugins-and-connectors.md` | Loopback gateway, OAuth/CIMD, peerDependencies, official DSH docs (`llms.txt` / `dsh_docs`), `dsh_plugins`, `cordis_inspect_*`, `dsh-v*` alignment |
| Custom Local ACP Agents & Core `ds-bot` | `references/local-agents-and-core.md` | `local-acp-<id>`, `LoopbackMcp`, `mcp-stdio.js`, `MODULES` order, `/api/bot`, IM adapters, `style-debt.test.js`, `docs/plugin-development.md` |

## Standard Build & Attach Sequence

1. **Choose the lowest layer** from the decision tree (default to `save_capability` unless connector, ACP CLI, or host plugin semantics truly demand more).
2. **Read the matching reference** under `references/` to verify exact schemas and constraints. Never invent DSH/Cordis APIs: verify against `https://deepseek-harness.github.io/deepseek-harness/llms.txt` (via `dsh_docs` if installed, else `web_fetch`) and the matching `dsh-v*` tag at `https://github.com/deepseek-ai/deepseek-harness` (`references/dsh-plugins-and-connectors.md`).
3. **Request secrets safely** via `request_secret` (own chat only) or check existing names via `list_secrets`.
4. **Author cleanly** under `<workspace>/plugins/<name>` (scripts/MCP servers) or save `skill`/`mcp`/`pack` capabilities via `save_capability`.
5. **Handle approval & verify:** For `stdio` MCPs, ask the user to approve in `Settings → Tools → Capabilities`; then `attach_capability`, run an end-to-end tool call test, and confirm no secret leaks (`[secret:*]`).

## Common Pitfalls & Quick Checks

- **Schema flattening:** `plainToolSchema` strips `$ref`, `$defs`, `const`, and collapses `oneOf`/`anyOf`/`allOf`; author flat `type: 'object'` schemas directly.
- **Name constraints:** `validateCapabilityName` allows lowercase kebab-case up to 32 chars and rejects connector IDs in `CONNECTOR_IDS` (such as `'github'` and `'mail'`).
- **No stdout noise:** `stdio` MCP servers must write logs strictly to `process.stderr`; reserve `process.stdout` for JSON-RPC messages.
- **Connector read-only gates:** When creating or advising read-only connectors, mark read tools with `readOnlyHint: true`; write calls and batch JSON-RPC fail with `-32600`.
- **ACP env isolation:** Child CLI processes automatically strip `DS_BOT_`, `DSH_`, `ANTIGRAVITY_`, `AGY_`, and `DEEPSEEK_` variables via `cleanEnv`.
- **Live config protection:** Never edit `<DSH_HOME>/profiles/<profile>/cordis.patch.yml`, `package.json`, or `bot/state.json` directly from a Bot or running host.
- **Desktop packaging:** Plugins bundling skill trees or Node helper scripts inside Electron must unpack them under `asarUnpack` and rewrite `app.asar` -> `app.asar.unpacked`.
- **UI styling rules:** Client edits under `ds-bot/src/client/` must stick to `--bt-*` tokens, allowed radii, and `motion.js` springs (`test/style-debt.test.js`).
- **Full checkout guide:** Read `docs/plugin-development.md` (and `docs/design/ui-standard.md` for UI views) when editing the DS Bot repository directly.

## Verification Checklist

- Confirm capability/plugin names match allowed conventions, zero secrets appear outside `$DSH_SECRET_<NAME>`, and `references/*.md` stays under `references/`.
- Verify user approval for any `stdio` MCP (`Settings → Tools → Capabilities`) or host restart, then run an end-to-end tool call (and `npm test` / `npm run lint` for core changes).
