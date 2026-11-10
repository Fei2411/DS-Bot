<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v0.3_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

DS Bot is an open-source project built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), available as a standalone desktop app or as a DSH plugin. It turns DSH into bots that you create, talk to and work with.

## Sponsors

<table>
<tr>
<td width="180" align="center"><a href="https://modelgo.ai/?utm_source=dsbot&utm_medium=sponsorship&utm_content=readme&campaign_id=dsbot&ad_group_id=readme"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/sponsors/modelgo-dark.svg"><img src="docs/images/sponsors/modelgo.svg" alt="ModelGo" width="150"></picture></a></td>
<td>ModelGo is a reliable, high-performance, enterprise-grade AI API aggregation platform. Access leading AI models—including Claude, OpenAI, Gemini, and DeepSeek—with a single API key. Sign up now and get 40% off DeepSeek V4.1 Flash.<br>Exclusive perks for DS-Bot users: get $0.50 in credits when you sign up, earn another $2 after your first API call, and receive up to $10 in bonus credits when you top up! Try it now: <a href="https://modelgo.ai/?utm_source=dsbot&utm_medium=sponsorship&utm_content=readme&campaign_id=dsbot&ad_group_id=readme">ModelGo Official Website</a></td>
</tr>
</table>

<h2></h2>

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Install

**Desktop app (Windows, macOS, Linux)**

The desktop app brings its own DSH, so you don't need to install DSH first. Download the installer for your system from [Releases](https://github.com/Fei2411/DS-Bot/releases/latest), open it, and set up a model in Settings (it can also copy your existing bot team from DSH).

If your system warns about an unsigned app: on Windows select **More info** → **Run anyway**; on macOS open **System Settings** → **Privacy & Security** and select **Open Anyway**.

**As a plugin in DSH**

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

- **DSH Desktop**: In the sidebar, select **Plugins** → **Add plugin**, enter `ds-bot` (in mainland China, set **Registry** to **Mainland China mirror**), then select **Install** and **Enable now**.
- **DSH Web** (needs Node.js `22.19` or later, and pnpm):

```sh
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

**Docker (NAS, Linux server)**

See [`docker/README.md`](docker/README.md).

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

### Web search

DS Bot selects its `auto` search provider for the whole profile. If you disable `web-search-auto`, also select another registered search provider in that profile. See [Web search](ds-bot/README.md#web-search) and the [recovery steps](docs/known-issues.md#web-search-fails-everywhere-after-turning-off-web-search-auto).

## Features

### Bot

You can do all your talking and work with one bot, in one window. You don't need to worry about the context behind it. The bot's details page shows its info, and there you can pick the model and thinking level you want it to use. You can switch models at any time, but I still recommend that you keep one model for a bot for a long time, and switch only when you really need to.

Bots also have memory. A bot remembers what you like and uses it in later work. You can manage its memory on the bot's details page, or just tell the bot.

Each bot can have its own working folder and permission preset — just tell the bot when you want to switch folders. While a bot is working, you can send a message to steer it right away, or type `/side` to ask a side question without interrupting its task; it can also draw charts, tables and forms in its replies, or run scheduled tasks. In the sidebar, you can group bots and group chats into collapsible sections by work.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has very high rights: it manages the other bots and the group chats. The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

DS Bot has group chats. A group chat is a great way to get several bots to work together, but it clearly costs more. So DS Bot does this: every group chat has an admin. The admin answers your messages by default and calls in the other bots for you. You can also @ a bot directly, and it answers you directly. To give the bots another chat as context, use + → Reference a chat in the message box.

Any bot can hand work to other bots with @, and those bots do the work on their own and post the results back to the group. A group chat has its own memory and working folder, invisible to bots outside the group. For larger work, a group chat can run a Goal: the admin aligns with you on what "done" means, splits the work into stages across members, and checks each stage before moving on.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Private bot

If you have private work that you only want to discuss with one bot, turn on Private in its settings and give it a separate working folder. Other bots cannot read its folder, memory or chat history, and sending messages to other bots or writing files outside its folder requires your approval. Even if you delete it, its folder and records stay protected until you release them in Settings.

Note that a private bot cannot be a main bot or join group chats. This boundary only isolates it from other bots in your team, not as an OS sandbox: if you give it shell or network access, its commands can still read and write system files or reach the network, and its model provider still receives the conversation.

### Local agents

Coding-agent CLIs you already use on your computer (Claude Code, Codex CLI, Cursor CLI, Devin CLI, OpenCode, Gemini CLI and others) can be connected as bots directly. Pick Local agent when creating a bot (or switch in the bot's settings), and it will use the CLI's own sign-in, plan and models while working like any other bot in private chats, group chats, handoffs and memory.

There are a few limits to keep in mind: a local agent uses the CLI's own tools and context, so shared capabilities and connectors in DS Bot are not passed to it, and switching how a bot runs starts a fresh conversation part; custom CLIs without HTTP MCP support do not get team tools such as creating bots or handing off work. Also, Cursor CLI saves the last selected model as its own global default (`~/.cursor`), so if you pick a specific model for a Cursor bot in DS Bot, other Cursor bots on the default model and Cursor in your terminal will switch to it too — keep "CLI default" if you don't want to change your global default (sign in to Cursor first so the model list loads).

### Browser

Each bot has its own isolated browser with separate sign-ins, and can import cookies from a file or from your local browsers. Turn on a browser plugin in Settings → Browser to let bots open and operate web pages on their own; posting, uploading, downloading and deleting need your approval, and sign-in, captchas or payments hand back to you with a card so you can take over and hand back at any time.

The browser feature is available in the desktop app and DSH Desktop only (not in DSH Web), and only the desktop app keeps browser sign-ins after you quit and supports cookie import. On Windows, new Chrome and Edge cookies encrypted with v20 cannot be read directly — export them to a file with a browser extension first.

### Computer use

Turn on Settings → Computer use to let bots operate apps on your computer as far as you allow. You can set a level (view only, background, or foreground) and allowed apps for each bot, with a top bar showing when a bot is working so you can pause or take over at any time; apps like system settings and password managers are never given to a bot.

All bots share your desktop, so only one bot can use a given app or the foreground mouse at a time. On Windows, Chrome and Electron apps often ignore background input and need "foreground", and apps running as administrator cannot be controlled; macOS requires 14 or later with Accessibility and Screen Recording permissions; Linux supports X11, with limited Wayland support.

### IM

In Settings → IM, you can link a bot or group chat to WeChat, Feishu, DingTalk, WeCom, QQ, Telegram, Discord or Slack. Once paired, you can talk to your bots, @ them in groups, and answer question and approval cards directly from your chat app without a public IP or open port on your computer.

Messages only flow while your computer is awake and DS Bot is running. WeChat only supports private chat with the QR-paired account, not group chats; WeChat and QQ only allow replies within a platform time window after you send a message, and sending another message resumes it. WeChat, QQ and DingTalk do not have card buttons, so reply with the option number instead; for security, secret cards cannot be filled in from chat apps.

### Connectors and capabilities

In Settings → Connectors, you can sign in to GitHub, Gmail, QQ Mail, 163 and other mailboxes, and remote MCP servers, or import existing configs from Claude Desktop, Cursor and VS Code. Credentials stay in DS Bot's secrets so bots never see the raw values, and emails written by a bot wait for your confirmation by default.

In Settings → Capabilities, you can manage shared MCP servers, skills and packs for the team and enable them per bot; local commands added by a bot need your approval before they run.

### Office files

Bots can create, check and edit Word (`.docx`), PowerPoint (`.pptx`) and Excel (`.xlsx`) documents directly, and render pages to images to check layout. The desktop app includes the full runtime out of the box; DSH Web does not bundle this runtime, so it can only check and edit existing documents, while creating files from scratch and rendering pages require the desktop app or DSH Desktop.

### Usage

In **Settings** → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

## Data

All data stays on your own computer: in the folder you chose on first start in the desktop app (`~/.ds-bot` by default), or in `bot/` and `sessions/` in the DSH home folder (`~/.dsh` by default) for the plugin. Uninstalling the app or the plugin does not delete this data.

## Development

The plugin source is in [`ds-bot/`](ds-bot/). For options and internals, see [`ds-bot/README.md`](ds-bot/README.md). For development, tests and how the team works, see [CONTRIBUTING.md](CONTRIBUTING.md). For changes between versions, see [CHANGELOG.md](CHANGELOG.md).

## Acknowledgments

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): DS Bot is built on the DSH plugin system. Every bot works in DSH sessions and uses the DSH tools and models.
- [esbuild](https://esbuild.github.io/): bundles the plugin's interface code.
- Thanks to these projects for the ideas they published. DS Bot learned from their designs and does not contain their code:
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo): the Markdown format of Bot memory.
  - [OpenAI Codex](https://github.com/openai/codex): checkpoints that keep the user's messages next to the summary, and message anchors for chat search.
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot): group chat rounds and @mention relays.
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) and [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode): one session per member per group chat, and handoffs that carry the earlier user messages.
  - [OpenCode](https://github.com/sst/opencode), [goose](https://github.com/block/goose), [pi](https://github.com/badlogic/pi-mono) and [Gemini CLI](https://github.com/google-gemini/gemini-cli): when to condense a long chat, and what a handoff note holds.
  - [obelisk](https://github.com/tommy0103/obelisk): chat search with a SQLite full-text index.
- Everyone who tries DS Bot, asks questions and reports bugs.

## License

[Apache License 2.0](LICENSE). Provided "as is", without any warranty. Third-party code and its license are listed in [NOTICE](NOTICE).

## Disclaimer

DS Bot is an independent community project. **It is not an official DeepSeek product**, and it is not affiliated with, endorsed by or sponsored by DeepSeek. "DeepSeek", "DeepSeek Harness" and the other names are trademarks of their owners. They are used here only to say what this plugin works with.

Bots use your own model quota, and they read and write files and run commands when you ask them to. Check important actions yourself.
