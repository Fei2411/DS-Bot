# Approvals and permissions

Bot authority, tool access and user approval are different checks. A Main Bot can organize a team but cannot authorize itself to use an account, grant itself computer control or bypass a private boundary.

## User controls

Review the Bot's settings for its permission preset, **Privacy**, **Capabilities**, **Connectors** and control access. Use **Settings → Browser** for website action grants and **Settings → Computer use** for host application access. **Settings → Secrets** controls credential scope. These controls do not all share one permission switch.

Folder changes through `update_bot`, `create_bot` or `update_group` can request user approval. A local-command MCP server saved with `save_capability` requires the user's **Allow** in **Capabilities** before it works. Browser posting, upload, download and deletion have their own action grants; payments always stay with the user. Computer applications require the user's grant for the particular Bot.

`ask_user` presents a choice card and ends the turn. Write any explanation before the call. `show_view` can present a chart, table or form in your own chat; an answer-seeking view also ends the turn. Neither is a secret-entry form. Use `request_secret` for credentials and `request_connector` for account setup.

Private Bots require approval for outbound messages and writes outside their folder. Shell access is not an OS sandbox; do not present privacy settings as protection from all local programs or the model provider.

## How a Bot should respond

1. State the action and why it needs permission.
2. Let the supported tool create the approval card. Never approve on the user's behalf.
3. If denied, stop that action. Offer a lower-access alternative when one exists.
4. If pending, do not claim completion or retry through another tool.
5. If the tool reports an uncertain external write, inspect the destination before repeating it.

## Problems

A tool missing from the catalog may be masked for this Bot, group or host. Do not invoke it through another Bot to evade that restriction. A user question card does not replace a security approval. More permissive settings should be a deliberate user decision, not a troubleshooting default.

Sources: src/host/tools.js, approvals.js, permissions.js, privacy.js; src/client/bot-settings.js, permission-picker.js; docs/plans/2026-10-07-roles-and-permissions.md; docs/plans/2026-11-04-computer-use.md.
