<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

English | [中文](README.zh.md)

![version](https://img.shields.io/badge/version-v0.3_preview-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![license](https://img.shields.io/badge/license-Apache_2.0-green)

**[Download DS Bot for Windows 10/11 (64-bit) / 下载 Windows 10/11（64 位）版](https://github.com/Fei2411/DS-Bot/releases/latest)**, about 212 MB / 约 212 MB. A community project, not an official DeepSeek product. / 社区开源项目，不是 DeepSeek 官方产品。

On that page, download `DS-Bot-<version>-win-x64.exe`. Double-click it to install; DS Bot opens when it is done. No administrator rights, no Node or DSH needed. You need a DeepSeek account (you can sign up with a phone number on the spot) or a DeepSeek API key. DeepSeek bills by usage: see [its prices](https://api-docs.deepseek.com/quick_start/pricing). For macOS, Linux or the DSH plugin, see [Install](README.md#install).

在这个页面下载 `DS-Bot-<版本>-win-x64.exe`，双击就会安装，装好自动打开。不用管理员权限，不用另装 Node 或 DSH。需要一个 DeepSeek 账号（可以当场用手机号注册）或 DeepSeek API Key。DeepSeek 按用量收费，见[价格页](https://api-docs.deepseek.com/quick_start/pricing)。macOS、Linux 和 DSH 插件见[安装](README.zh.md#安装)。

<details>
<summary><b>The browser or Windows warns you, or blocks the installer? / 浏览器或 Windows 提示、拦下了安装包？</b></summary>

The installer is not signed yet, so Windows does not know its publisher.

- Edge says the file is not commonly downloaded: **···** → **Keep** → **Show more** → **Keep anyway**.
- "Windows protected your PC": **More info** → **Run anyway**.
- "Smart App Control blocked …", with no **Run anyway**: there is no safe way around this for an unsigned installer. Use [DSH Desktop with the DS Bot plugin](README.md#install) instead. Do not turn Smart App Control off.
- An antivirus blocks it: check the file first. In Command Prompt, run `certutil -hashfile <file> SHA256` and compare the result with the file's line in `SHA256SUMS.txt` on the release page. If they match, choose to trust the file in the antivirus.
- The installer says it could not uninstall the old version: close DS Bot and run the installer again. If your antivirus stopped the installer, check and trust it as above first.

Still stuck? [Report an install problem](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml).

安装包还没有签名，所以 Windows 认不出发布者。

- Edge 提示「不常下载」：「···」→「保留」→「显示更多」→「仍然保留」。
- 「Windows 已保护你的电脑」：「更多信息」→「仍要运行」。
- 「智能应用控制已阻止…」，而且没有「仍要运行」：未签名的安装包没有安全的绕过办法，请改用 [DSH Desktop 加 DS Bot 插件](README.zh.md#安装)。不要关掉智能应用控制。
- 杀毒软件拦截：先核对文件。在命令提示符里运行 `certutil -hashfile <文件> SHA256`，和 Release 页上 `SHA256SUMS.txt` 里这个文件的那一行比较，一致后再在杀毒软件里选「信任」。
- 安装时提示卸载旧版失败：先关掉 DS Bot，再运行一次安装包。杀毒软件拦了安装包时，先按上面的方法核对，选「信任」。

还是装不上？[报告安装问题](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml)。
</details>

**DS Bot**: the desktop app, the project and the plugin / 桌面应用、项目和插件 · **DeepSeek Harness (DSH)**: what they are built on / 它们的底层

DS Bot is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), available as a standalone desktop app or as a DSH plugin. It turns DSH into a team of long-lived bots that you create, talk to and work with.

![Say one sentence to Chief, and it sets up the bots and the group chat](docs/images/team.png)

## Install

**Desktop app (Windows, macOS, Linux)**

The desktop app brings its own DSH, so you don't need to install DSH first. Download it from [Releases](https://github.com/Fei2411/DS-Bot/releases):

- Windows (x64): `DS-Bot-<version>-win-x64.exe`. Run it; it installs for your user only, without administrator rights. If Windows shows "Windows protected your PC", select **More info** → **Run anyway**. For other warnings and blocks, open **The browser or Windows warns you, or blocks the installer?** at the top of this page.
- macOS: `DS-Bot-<version>-mac-arm64.zip` for an Apple chip, `DS-Bot-<version>-mac-x64.zip` for Intel. Safari unzips it by itself; drag **DS Bot** into **Applications** and open it. When macOS says it cannot check the app, open **System Settings** → **Privacy & Security** and select **Open Anyway**.
- Linux (x64): `DS-Bot-<version>-linux-x86_64.AppImage` runs on every distribution with glibc 2.28 or newer — make it executable and open it. It mounts through FUSE 2, which you may need to install first (`sudo apt install libfuse2t64` on Ubuntu 24.04+, `sudo dnf install fuse-libs` on Fedora, `sudo pacman -S fuse2` on Arch). On Ubuntu 24.04 and later an AppImage can refuse to start (Ubuntu restricts the sandbox it needs); the `DS-Bot-<version>-linux-amd64.deb` on Debian/Ubuntu does not have this problem and adds a menu entry. On older-glibc systems such as CentOS 7 the app and DSH Web fail with `GLIBC_2.27 not found`; run the Docker image instead (see below and [known issues](docs/known-issues.md)).

At the first start the app keeps its data and the Bots' files in your home folder; the start window says where and lets you change it in one click. It offers to copy a Bot team from your DSH (it only reads your DSH). Set up a model in Settings. The Windows app and the Linux AppImage update themselves; the macOS app and the Linux deb tell you when a new version is ready to download.

If the app does not download, install or start, [report an install problem](https://github.com/Fei2411/DS-Bot/issues/new?template=install.yml); it needs no diagnostics.

**Desktop app from source (Windows)**

With Node.js 22.19 or later and npm installed, run `.\start.ps1` in PowerShell from this checkout. It prepares and launches the current source, keeping your Bots, chats and model settings in `.ds-bot-local/` between runs. See [source startup](app/README.md#run-from-source-windows).

**As a plugin in DSH**

First install DSH and set up at least one model in it. DS Bot uses the models from DSH.

**DSH Desktop (Windows, macOS)**

1. In the sidebar, select **Plugins** → **Add plugin**.
2. In **Package name or address**, enter `ds-bot`. In mainland China, set **Registry** to **Mainland China mirror**.
3. Select **Install**, then **Enable now**. If DSH says the change takes effect at the next start, quit DSH completely and open it again.

If npm is not reachable, in step 2 you can also enter the full path of `ds-bot-<version>.tgz` downloaded from [Releases](https://github.com/Fei2411/DS-Bot/releases), or `github:Fei2411/DS-Bot#v<version>&path:/ds-bot` (needs Git).

DS Bot 0.2.1 and earlier cannot update themselves in DSH Desktop 0.2.1-rc.2 or later: on the Plugins page, remove `ds-bot` and add `ds-bot` again. The Bots, chats and memory stay.

**DSH Web (Windows, macOS, Linux)**

Needs Node.js `22.19` or later, and pnpm. On Linux it needs the same glibc 2.28 or newer as the desktop app — the DSH install loads its own native libraries, so CentOS 7 and other older-glibc systems take the Docker route below instead.

```sh
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

**Docker (NAS, Linux server)**

The [`docker/`](docker/) directory builds an image with DSH Web and DS Bot, for a NAS or any always-on machine. CI is configured to publish a prebuilt linux/amd64 image to GHCR. The container is the Bots' sandbox: they get full access to what you mount into it, and nothing else. See [`docker/README.md`](docker/README.md).

## Setup

I strongly recommend that you set up your other bots and group chats by just talking to a bot.

### Web search

DS Bot selects its `auto` search provider for the whole profile. If you disable `web-search-auto`, also select another registered search provider in that profile. See [Web search](ds-bot/README.md#web-search) and the [recovery steps](docs/known-issues.md#web-search-fails-everywhere-after-turning-off-web-search-auto).

## Features

### Bot

You can do all your talking and work with one bot in one window, without worrying about the context behind it — long chats condense or move to a fresh part on their own, and earlier parts stay searchable. On the bot's details page you can view its info and pick its model and thinking level. You can switch models at any time, but I still recommend keeping one model for a bot for a long time and switching only when you really need to.

Bots also have long-term memory: they remember your preferences and apply them in later work. You can view, undo or manage memory on the details page, or just tell the bot in chat. After long work, a bot can also propose durable rules as skills or `AGENTS.md` updates, applied only when you approve.

Each bot can have its own working folder and permission preset (Read only, Workspace or Full access) — just tell the bot when you want to switch folders. While a bot is working, you can send a message to steer it right away, or type `/side` to ask a side question without interrupting its task. Bots can draw charts, tables, interactive calculators and forms in their replies, and run scheduled tasks. The sidebar lets you group bots and group chats into collapsible sections by project.

![Bot details: model, memory, usage](docs/images/details.png)

### Main bot

The main bot is your chief. It has the highest rights and manages your other bots and group chats (you can have more than one main bot). The first time you open DS Bot, there is already a main bot called Chief. Talk to it, and it walks you through the setup.

In short: have a question? Ask the main bot.

### Group chats

A group chat is a great way to get several bots to work together, but it clearly costs more. DS Bot optimizes for this: every group chat has an admin. Your messages go to the admin by default, and it calls in the other bots for you. You can also type `@` to call a bot directly, or use `+` → **Reference a chat** to attach another chat as context.

Any bot can hand work to other bots with `@` (naming several starts them in parallel). Those bots do the work on their own and post their results back to the group. Each group chat has its own memory, working folder and permission setting, invisible outside the group. For larger work, a group can run a **Goal**: the admin aligns with you on what "done" means, splits the work into stages across members, and checks each stage against evidence before moving on.

![Group chat: the admin, Chief, hands the work to Writer and Coder](docs/images/group.png)

### Private bot

Some work (such as personal finances or private notes) is meant for you and one bot only. Turn on **Private** in a bot's settings and give it a separate working folder: other bots cannot read its folder, memory or chat, and sharing anything outward or writing outside its folder needs your approval. Even if you delete a private bot, its folder and records stay protected from other bots until you release them in Settings.

**Limits**: A private bot cannot be a main bot or join group chats. This boundary is between bots in your team, not an OS sandbox — if you give the bot shell or network access, commands can still read system files or reach the network, and its model provider still receives the prompt. If it runs on a local agent CLI, the privacy rules do not cover the CLI's own built-in tools.

### Local agents

Coding-agent CLIs you already use on your computer (Claude Code, Codex CLI, Cursor CLI, Devin CLI, OpenCode, Gemini CLI and other ACP agents) can run a bot directly. Pick **Local agent** when creating a bot (or switch in the bot's settings): the bot uses the CLI's own sign-in, plan and models, while working like any other bot in private chats, group chats, handoffs, approvals and memory.

**Limits**:
- **Separate from DS Bot models**: A local-agent bot uses the CLI's own tools and compaction; shared Capabilities (MCP servers, skills) and Connectors in DS Bot are not passed to it, and switching how a bot runs starts a fresh conversation part.
- **Selecting a model in Cursor CLI changes Cursor's global default**: Cursor CLI saves the last selected model to its own global config (`~/.cursor`). If you pick a specific model for one Cursor bot, other Cursor bots set to "CLI default" and Cursor in your terminal will switch to that model too. Keep **CLI default** if you do not want to change your global Cursor default (and sign in to Cursor first so the full model list loads).
- **Protocol differences**: Custom CLIs that do not support MCP over HTTP cannot use team tools (creating bots, handoffs, group actions) and only support plain chat.

### Browser

Each bot has its own isolated browser with separate sign-ins, and can import cookies from a file or from Chrome, Edge or Firefox on your computer. Turn on a browser plugin in Settings → **Browser** to let bots open and operate pages on their own; posting, uploading, downloading and deleting ask for your approval, and sign-in, captchas or payments hand back to you with a card. You can take over and hand back at any time.

**Limits**: Available in the desktop app and DSH Desktop only (not in DSH Web); only the desktop app keeps browser sign-ins after you quit and supports cookie import. Cookie import copies cookies only (not localStorage or passkeys), and on Windows, Chrome/Edge cookies encrypted with App-Bound Encryption (v20) cannot be read directly — export them with a browser extension first.

### Computer use

Bots can use native apps on your computer as far as you allow. Turn it on in Settings → **Computer use**, then give each bot a level (Off, View only, Background, or Foreground) and the apps it may use. A top bar shows when a bot is working so you can stop or take over at any time; system settings, password managers and DS Bot itself are never given to a bot.

**Limits**: All bots share your desktop — only one bot can use a given app or the foreground mouse at a time. On Windows, Chrome and Electron apps often ignore background input and need "Foreground", and apps running as administrator cannot be controlled; macOS requires macOS 14+ with Accessibility and Screen Recording permissions; Linux supports X11 with limited Wayland support. In DSH Web, do not grant a bot access to the browser running DS Bot.

### IM

Talk to your bots or group chats from your chat apps while away from your desk. Settings → **IM** links bots to WeChat, Feishu, DingTalk, WeCom, QQ, Telegram, Discord and Slack — pairing, group `@` mentions, question cards, approvals and replies all work without a public IP or open port on your computer.

**Limits**: Messages only flow while your computer is awake and DS Bot is running. WeChat supports private chat with the QR-paired account only (no group chats); WeChat and QQ only allow replies within a platform-imposed window after you send a message (send another message in the app to resume). WeChat, QQ and DingTalk do not have interactive card buttons, so reply with the option number instead; for security, secret cards cannot be filled in from chat apps.

### Connectors, capabilities and secrets

- **Connectors**: Settings → **Connectors** connects GitHub, Gmail, QQ Mail, 163 and other mailboxes, and remote MCP servers with one sign-in, or imports MCP configs from Claude Desktop, Cursor and VS Code. Credentials stay in Secrets and never reach a bot; emails a bot writes wait for your confirmation by default.
- **Capabilities**: Settings → **Capabilities** is a shared library of MCP servers, skills and packs that you enable per bot; local MCP commands added by a bot need your approval before they run.
- **Secrets**: When a bot needs an API key or password, it asks with a secret card; the value is injected only as an environment variable and masked before model calls and logs.

### Office files

Bots can create, inspect and edit Word (`.docx`), PowerPoint (`.pptx`) and Excel (`.xlsx`) files directly, and render pages to images to check layout.

**Limits**: The desktop app includes the full runtime (Python and LibreOffice) out of the box; DSH Web does not bundle this runtime, so it can inspect and edit existing files, while creating files from scratch and rendering pages require the desktop app or DSH Desktop.

### Usage

In Settings → **Usage**, you can see token usage by time, by bot and by model.

![Usage page](docs/images/usage.png)

## Data

All data stays on your own computer: in the folder you chose on first start in the desktop app (`~/.ds-bot` by default), or in `bot/` and `sessions/` inside the DSH home folder (`~/.dsh` by default) for the plugin. Uninstalling the app or the plugin does not delete this data.

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
