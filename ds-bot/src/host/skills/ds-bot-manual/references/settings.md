# Settings reference

Open **Settings** from the sidebar. Settings opens on **Overview** and groups domains in the left rail; multi-part domains scroll as one page with top anchor links, and Settings search (⌘K / Ctrl+K) jumps straight to any setting, Bot, group chat or model. Other references abbreviate paths to the page name. DSH and other plugins can add more pages. A page's presence does not mean every service on it is available on this host.

| Page | Use it for | Who configures it |
| --- | --- | --- |
| Overview | Attention banners, team summary, 7-day usage and quick cards for every area | User reads; missing keys can be fixed in place |
| General | Language, input, new-Bot defaults, locations, memory limits and background command timeout | User |
| Appearance | Theme, accent, live preview, message layout, interface motion and Bot animation | User |
| Models → Providers | Provider and model setup | User |
| Models → Local agents | Installed agent CLI setup | User |
| Models → Bot models | Team model assignments and batch switching | User; supported individual assignments also via Bot tools |
| Models → DeepSeek services | Independent DeepSeek OCR, TTS and dictation | User |
| Team → Bots | Bot profile, model, folder, instructions, memory, privacy and access | User; supported profile fields also via Bot tools |
| Team → Group chats | Group membership and settings | User; Main Bot or group admin via supported tools (folder and sidebar-section changes are Main Bot only) |
| Team → Scheduled tasks | Scheduled prompts for Bots and groups | User; available schedule tools for a Bot's own chat |
| Connect → Connectors | Service accounts, custom servers and mail | User sign-in; Bot can request a connection |
| Connect → IM | Messaging platform connections | User |
| Connect → Phone | Phone and browser remote access, pairing and device revocation | User |
| Connect → MCP access | Scoped local-agent access tokens | User |
| Tools → Computer use | Provider status and computer access | User |
| Tools → Browser | Browser access information and website action grants | User |
| Tools → Capabilities | Shared MCP servers, skills and feature packs (Always / Catalog / Off per Bot) | User or Bot; local commands require user approval |
| Tools → Secrets | Credentials, scope and optional encryption at rest | User; Bot can request credentials securely |
| Usage | Token usage by time, Bot and model | User reads |
| About DS Bot | Application version, updates and links | User reads |
| About DS Bot → Feedback | Report a problem and export diagnostics | User |

## Bot configuration map

Use `list_bots` before changing the team. `update_bot` supports own profile settings and Main Bot edits to others. `create_bot` and `create_group` require a Main Bot. `update_group` requires group-admin or Main Bot rights. `list_bot_models` discovers valid model choices. `list_capabilities`, `save_capability`, `attach_capability`, `detach_capability` and `delete_capability` manage capability definitions and attachments subject to their rights; `use_pack` and `drop_pack` load or unload catalog feature packs for the current session. `request_connector` and `request_secret` request user input; they do not supply it.

For any setting not exposed by these supported tools, explain the UI steps. Do not rewrite the application's state store or DSH installation. A successful tool result should name the changed object; a pending card is not success. Recheck the resulting team or capability state when available.

## Problems

The UI may be translated. These are the English source labels, not a promise that the user's current language shows English. Plugin-provided pages can differ from the standalone app. If a page or option is missing, ask which host/version is running and inspect its current capabilities rather than inventing a menu.

Sources: src/client/settings.js (NAV_GROUPS), settings-overview.js, settings-palette.js, bot-settings.js; src/host/tools.js, connectors/index.js, secrets.js, mcp-server.js.
