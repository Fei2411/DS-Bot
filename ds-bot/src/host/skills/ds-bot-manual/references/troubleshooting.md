# Troubleshooting and known limits

Start with the exact error, current host (desktop app, DSH Desktop, DSH Web or Docker), and the action that failed. Never request a full config dump containing credentials. Ask for redacted relevant lines only.

## Model or tool failures

Check **Settings → Models** and the Bot's **Model** assignment. Use `list_bot_models` and `list_bots` to inspect supported choices. A missing provider key needs secure user setup. A missing tool may mean a disabled service, unattached capability, permission mask or local-agent limitation. Use `list_capabilities` and `list_connectors` before recommending changes.

If **Capabilities** says **Needs approval**, the user must **Allow** the local command. If the secret store is locked, unlock it in **Settings → Secrets**. Do not reset the store. If a computer operation lacks OS permission, the user must grant it; repeated calls cannot fix it.

## Web search fails everywhere

The known error is: configured web provider "auto" is not registered (WEB_PROVIDER_CONFIGURED_MISSING). This can happen after disabling web-search-auto while the profile still selects auto. DS Bot selects auto for the profile, not only Bot chats. Re-enable that provider or have the user configure another registered search provider while preserving the fetch provider. Follow docs/known-issues.md for the exact profile patch procedure. Do not guess search URLs or present remembered pages as live results.

## Missing plugin name at startup

The error Plugin at plugins[] is missing name can mean the profile has a stale row with id bot but no name ds-bot. The recovery in docs/known-issues.md is to quit DSH, back up the profile patch, remove only the malformed row, check that ds-bot is a dependency, and restart or reinstall the plugin. Do not delete the whole profile as a first step: that also removes unrelated plugins and model settings. Do not inspect or edit the user's DSH data without their request and approval.

## Old Linux native libraries

An error such as GLIBC_2.27 not found while loading libghostty-vt.so comes from DSH's native libraries on an old distribution. DS Bot cannot rebuild or replace those internals. The known-issues guide recommends the Docker image with a newer userspace. Very old host kernels and Docker versions can still be incompatible; that combination is not guaranteed tested.

## Browser, remote access and history

- A read-only browser cannot click. Review **Settings → Browser → Browser access**.
- Browser profiles do not share logins between Bots. Payments require user handoff.
- Browser remote needs a Relay Server serving the web build. Sensitive actions need the phone app or computer.
- An old fact outside active context is not necessarily lost. Call `read_own_chat`, `read_group_chat` or `bot_recall` as appropriate.
- Approval denial is not a transient failure. Do not retry through a different tool.

Use the bundled **report-ds-bot-issue** skill to prepare a DS Bot bug report and ask for approval before publishing. Include the redacted error, reproduction steps and host/version. Separate what you observed from what you suspect. Never patch DSH or promise an unverified workaround.

Sources: docs/known-issues.md; README.md (Web search, Browser remote, Local agents); src/host/prompt.js; src/client/settings.js, capability-settings.js, browser-settings.js.
