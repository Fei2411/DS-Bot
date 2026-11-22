---
name: ds-bot-manual
description: Read the DS Bot user manual when users ask how DS Bot works, what it can do, how to use or set it up, for a guided tour, or before changing DS Bot settings yourself.
---

# DS Bot manual

Read the relevant reference before answering or changing a setting. This manual describes DS Bot, not every tool supplied by DSH or an installed plugin. Check the current tool catalog and current settings too. Availability depends on the host, installed services, model and user permissions.

Settings paths in the references often abbreviate to a page name. See the [settings map](references/settings.md) for the current navigation group and tab, or use Settings search.

## How to use it

- Answer questions with the shortest useful steps and the exact English UI labels below. Explain the effect and limits, not just the switch.
- For a guided tour, start with one Bot and one small task. Show memory, a working folder and model selection next. Introduce groups, capabilities and automation when useful. Do not enable everything at once.
- To configure on the user's behalf, read the appropriate reference, inspect current state, explain any cost or permission change, then call the supported tool. Check its result. Do not claim success on a refusal or a pending approval.
- Ask for decisions, not secrets. Use a secure request card for credentials. Never read or print a stored secret.
- If a setting has no Bot tool, guide the user through the UI. Do not edit internal state files or bypass approval checks.

## Authority

Every Bot can change its own supported profile settings with `update_bot`, manage its own memory, and use the tools it has been granted. A Main Bot can create Bots and change other Bots. Group administration has separate rules; being a member is not the same as being the admin.

Only the user deletes Bots, changes Main Bot status, switches between DS Bot models and local agent CLIs, changes privacy or permission controls, authorizes accounts, and grants computer access. A Main Bot is not exempt from user approval. Folder changes can require approval. Local MCP commands need user permission before they run. Browser actions and computer applications have their own approval boundaries.

## Index

- [Install and first run](references/getting-started.md)
- [Bots, roles, instructions and characters](references/bots.md)
- [Chats, groups, goals and conversation parts](references/chats.md)
- [Models, providers and thinking](references/models.md)
- [Memory and context](references/memory.md)
- [Capabilities, connectors and secrets](references/capabilities.md)
- [Browser and computer use](references/browser-computer.md)
- [IM, phone and mobile access](references/remote-access.md)
- [Schedules and background tasks](references/tasks.md)
- [Approvals and permissions](references/permissions.md)
- [Settings reference](references/settings.md)
- [Troubleshooting and limits](references/troubleshooting.md)
