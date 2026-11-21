# Settings reference

Open **Settings** from the sidebar. The English page labels below are the DS Bot pages. DSH and other plugins can add more pages. A page's presence does not mean every service on it is available on this host.

| Page | Use it for | Who configures it |
| --- | --- | --- |
| General | General and interface preferences | User |
| Models | Provider and model setup | User |
| Local agents | Installed agent CLI setup | User |
| Bots | Bot profile, model, folder, instructions, memory and access | User; supported profile fields also via Bot tools |
| Bot models | Team model assignments | User; supported individual assignments also via Bot tools |
| Group chats | Group membership and settings | User; Main Bot or group admin via supported tools |
| Connectors | Service accounts, custom servers and mail | User sign-in; Bot can request a connection |
| IM | Messaging platform connections | User |
| Phone | Phone access, pairing and paired-device revocation | User |
| Capabilities | Shared MCP servers, skills and packs | User or Bot; local commands require user approval |
| DeepSeek services | DeepSeek service configuration | User |
| Browser | Browser access information and website action grants | User |
| Computer use | Provider status and computer access | User |
| Scheduled tasks | Scheduled prompts for Bots and groups | User; available schedule tools for a Bot's own chat |
| Usage | Usage information | User reads |
| Secrets | Credentials, scope and optional encryption | User; Bot can request credentials securely |
| Feedback | Report a problem | User |
| About DS Bot | Application information | User reads |

## Bot configuration map

Use `list_bots` before changing the team. `update_bot` supports own profile settings and Main Bot edits to others. `create_bot` and `create_group` require a Main Bot. `update_group` requires group-admin or Main Bot rights. `list_bot_models` discovers valid model choices. `list_capabilities`, `save_capability`, `attach_capability`, `detach_capability` and `delete_capability` manage capability definitions and attachments subject to their rights. `request_connector` and `request_secret` request user input; they do not supply it.

For any setting not exposed by these supported tools, explain the UI steps. Do not rewrite the application's state store or DSH installation. A successful tool result should name the changed object; a pending card is not success. Recheck the resulting team or capability state when available.

## Problems

The UI may be translated. These are the English source labels, not a promise that the user's current language shows English. Plugin-provided pages can differ from the standalone app. If a page or option is missing, ask which host/version is running and inspect its current capabilities rather than inventing a menu.

Sources: src/client/settings.js (SETTINGS_PAGES), settings-shell.js, bot-settings.js; src/host/tools.js, connectors/index.js, secrets.js.
