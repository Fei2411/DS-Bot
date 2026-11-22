# Install and first run

DS Bot is a persistent Bot team built on DeepSeek Harness (DSH). The desktop app includes a pinned DSH. The plugin uses the DSH installation where it is enabled. Teams, chats and memory are stored on the computer hosting DS Bot.

## User steps

1. Download the desktop installer for Windows, macOS or Linux from the repository's Releases page. Open it. No separate DSH install is needed.
2. Set up a model in **Settings → Models**. The app can also import an existing team from DSH. Its data is separate from the user's DSH data.
3. Talk to **Chief**, the initial Main Bot. Describe one concrete job. Ask it to create a specialist only if that role needs an ongoing identity.
4. Open **Settings → Bots**, select a Bot, and review **Instructions**, **Model** and **Working folder**.

For the plugin, install DSH and configure at least one model first. In DSH Desktop use **Plugins → Add plugin**, enter ds-bot, then **Install** and **Enable now**. For DSH Web the README specifies Node.js 22.19 or later and pnpm. Use the README's commands for the supported DSH version rather than guessing a newer version.

## Bot help and authority

Call `list_bots` before proposing a new team. A Main Bot can call `create_bot` and `create_group`. Ordinary Bots can explain setup or ask a Main Bot with `message_bot`. Installing the app, importing a team and supplying model credentials are user steps, not Bot tools. Do not ask for API keys in chat.

## Common problems

- No usable model: configure a provider and model in **Models** first. A Bot cannot create a working provider merely by changing its model name.
- Unsigned app warning: the README documents **More info → Run anyway** on Windows and **System Settings → Privacy & Security → Open Anyway** on macOS. The user decides whether to trust the download.
- Linux native-library failure on an old distribution: see troubleshooting. Do not replace DSH libraries.

Sources: root README.md (Install, Setup, Main bot); docs/vision.md; docs/plans/2026-10-16-desktop-app.md; src/client/settings.js; src/host/tools.js.
