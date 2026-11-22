# Settings reference

Open **Settings** from the sidebar. The English paths below follow the grouped navigation and its in-page tabs; Settings search can open a page directly. Other references abbreviate these paths to the page name. DSH and other plugins can add more pages. A page's presence does not mean every service on it is available on this host.

| Page | Use it for | Who configures it |
| --- | --- | --- |
| General | Language, input, new-Bot defaults and locations | User |
| Appearance | Theme, accent, message layout and motion | User |
| Models → Providers | Provider and model setup | User |
| Models → Local agents | Installed agent CLI setup | User |
| Team → Bots | Bot profile, model, folder, instructions, memory and access | User; supported profile fields also via Bot tools |
| Models → Bot models | Team model assignments | User; supported individual assignments also via Bot tools |
| Team → Group chats | Group membership and settings | User; Main Bot or group admin via supported tools (folder and sidebar-section changes are Main Bot only) |
| Connect → Connectors | Service accounts, custom servers and mail | User sign-in; Bot can request a connection |
| Connect → IM | Messaging platform connections | User |
| Connect → Phone | Phone access, pairing and paired-device revocation | User |
| Connect → MCP access | Scoped local-agent access tokens | User |
| Tools → Capabilities | Shared MCP servers, skills and packs | User or Bot; local commands require user approval |
| Models → DeepSeek services | DeepSeek service configuration | User |
| Tools → Browser | Browser access information and website action grants | User |
| Tools → Computer use | Provider status and computer access | User |
| Team → Scheduled tasks | Scheduled prompts for Bots and groups | User; available schedule tools for a Bot's own chat |
| Usage | Usage information | User reads |
| Tools → Secrets | Credentials, scope and optional encryption | User; Bot can request credentials securely |
| About DS Bot → Feedback | Report a problem | User |
| About DS Bot | Application information | User reads |

## Bot configuration map

Use `list_bots` before changing the team. `update_bot` supports own profile settings and Main Bot edits to others. `create_bot` and `create_group` require a Main Bot. `update_group` requires group-admin or Main Bot rights. `list_bot_models` discovers valid model choices. `list_capabilities`, `save_capability`, `attach_capability`, `detach_capability` and `delete_capability` manage capability definitions and attachments subject to their rights. `request_connector` and `request_secret` request user input; they do not supply it.

For any setting not exposed by these supported tools, explain the UI steps. Do not rewrite the application's state store or DSH installation. A successful tool result should name the changed object; a pending card is not success. Recheck the resulting team or capability state when available.

## Problems

The UI may be translated. These are the English source labels, not a promise that the user's current language shows English. Plugin-provided pages can differ from the standalone app. If a page or option is missing, ask which host/version is running and inspect its current capabilities rather than inventing a menu.

Sources: src/client/settings.js (NAV_GROUPS), bot-settings.js; src/host/tools.js, connectors/index.js, secrets.js, mcp-server.js.
