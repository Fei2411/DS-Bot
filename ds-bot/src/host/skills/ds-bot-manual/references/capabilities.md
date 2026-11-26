# Capabilities, connectors and secrets

Capabilities are shared definitions that can be attached to Bots. An **MCP server** supplies tools. A **Skill** supplies instructions. A **Pack** groups MCP servers and skills. Connectors are account/service connections with their own sign-in and per-Bot access.

## Capabilities

Open **Settings → Capabilities → Shared capabilities → Add capability**. Choose **Type**, **Name** and **Description**. MCP connections offer **Local command** or **HTTP server**. Skills use **Skill instructions**. Bot settings also have **Capabilities** for attachments.

Call `list_capabilities` first. `save_capability` creates or updates a shared definition; `delete_capability` removes it and detaches it from Bots and packs. These shared changes can affect other Bots: explain that effect before doing them. `attach_capability` and `detach_capability` change your own attachments; only a Main Bot can target another Bot. Changes apply from the next message. A saved local-command MCP server needs the user's **Allow** in settings before it can run. No Bot may approve that command for the user.

Keep credentials out of definitions. In MCP env or headers use the saved-secret placeholder syntax $DSH_SECRET_<NAME>. The tool also supports secret substitution in URLs, but prefer headers for keys.

## Connectors and mail

Open **Settings → Connectors** to connect accounts or add a custom server. Bot details have **Connectors** controls for each Bot. `list_connectors` shows the catalog, connection status and availability to you. `request_connector` asks the user to connect a service with a card in your own chat; it is not a group-chat sign-in tool. Wait for the user's result instead of retrying. User sign-in and per-Bot access controls are not bypassed by Main Bot rights.

Connected remote servers can have **Read-only** enabled. It exposes only tools marked read-only by the server. Unmarked tools count as writes. Default mailbox sends need user confirmation; configured send rules may allow direct sending, but private Bots still require confirmation. Check the current tool catalog for service-specific and mail tools: these depend on connected accounts.

## Secrets

Use **Settings → Secrets** to manage credentials. `list_secrets` lists metadata, not secret values. `request_secret` opens a secure card so the user supplies a key without putting it in chat. Use its injected environment variable without printing it. In Bash the form is $DSH_SECRET_<NAME>; in PowerShell it is $env:DSH_SECRET_<NAME>. Scope controls which Bots receive it.

Optional at-rest encryption protects copied disks and backups, not a compromised running process. The user must keep the passphrase separately. Losing it means the encrypted keys cannot be recovered. A locked store rejects writes; unlock it in **Secrets**, not by replacing the file.

## Problems

An attached capability can still need approval, credentials or a running server. Inspect status before repeating a call. Reconnect an expired connector login through the UI. Never ask for tokens in ordinary messages or a generic form card. Do not grant a Bot more account access just to hide an error.

Sources: src/host/tools.js, capabilities.js, secrets.js, connectors/index.js; src/client/capability-settings.js, connectors-page.js, secret-card.js; docs/plans/2026-11-04-connectors.md; docs/plans/2026-11-12-encrypted-secrets.md.
