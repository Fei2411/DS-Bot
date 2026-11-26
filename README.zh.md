<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

[English](README.md) | 中文 · [文档导航](docs/README.md) · [愿景](docs/vision.zh.md) · [已知问题](docs/known-issues.zh.md) · [参与开发](CONTRIBUTING.zh.md)

![版本](https://img.shields.io/badge/版本-v0.4.0-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.5-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DS Bot 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 DSH）的开源项目，提供独立桌面应用和 DSH 插件两种形态。它将 DSH 转化为一支持久化的 Bot 团队，你可以创建、交流并与它们一起工作。

## 赞助

<table>
<tr>
<td width="180" align="center"><a href="https://modelgo.ai/?utm_source=dsbot&utm_medium=sponsorship&utm_content=readme&campaign_id=dsbot&ad_group_id=readme"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/sponsors/modelgo-dark.svg"><img src="docs/images/sponsors/modelgo.svg" alt="ModelGo" width="150"></picture></a></td>
<td>ModelGo 是一个稳定、高效的企业级 AI API 聚合平台，一个 API Key 即可调用 Claude、OpenAI、Gemini、DeepSeek 等主流 AI 模型。当前注册即享 6 折 deepseek v4.1 flash。<br>另为 DS-Bot 用户提供专属福利：注册即送 $0.5 额度，完成首次 API 调用再送 $2，充值赠金最高至 $10！立即体验：<a href="https://modelgo.ai/?utm_source=dsbot&utm_medium=sponsorship&utm_content=readme&campaign_id=dsbot&ad_group_id=readme">ModelGo 官网</a></td>
</tr>
</table>

<h2></h2>

![和 Chief 说一句话，它就把 bot 和群聊建好](docs/images/team.zh.png)

## 安装

**桌面应用（Windows、macOS、Linux）**

桌面应用自带锁定版本的 DSH，不需要先装 DSH。直接在 [Releases](https://github.com/Fei-Craft/DS-Bot/releases/latest) 下载对应系统的安装包，打开后在设置里配好模型即可使用（也可以直接复制你原来在 DSH 里的 Bot 团队）。

如果安装或打开时提示未签名拦截：Windows 点 **更多信息** → **仍要运行**；macOS 在 **系统设置** → **隐私与安全性** 里点 **仍要打开**。

**作为 DSH 插件**

先装好 DSH，并在 DSH 里配好至少一个模型。DS Bot 直接使用 DSH 里的模型。

- **DSH Desktop**：侧栏点 **插件** → **添加插件**，包名填 `ds-bot`（在中国大陆，安装源选 **中国大陆镜像源**），点 **安装** 并 **立即启用**。
- **DSH Web**（需要 Node.js `22.19` 以上和 pnpm）：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.5 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.2-rc.5 web
```

**Docker（NAS、Linux 服务器）**

见 [`docker/README.md`](docker/README.md)。

**可选代码执行器（实验性）**

可选代码执行器通过 `ds-bot/code-mode` 提供（要求 DSH **0.2.2-rc.1 或更新版本**，默认关闭，不影响旧版宿主和默认 Bot）。在当前 profile 的 `bot`（`ds-bot`）行中设置 `config.codeMode.enabled: true` 并重启 engine，多文件补丁可同时在 agent 预设中开启 `tool-fs` 的 `applyPatch: true`。参见[配置和限制](docs/plans/2026-11-18-code-mode.md)。

## 配置

最简单的方式是直接和你的 Main Bot 对话，让它帮你创建和配置其他 Bot 与群聊。

**设置**默认打开**概览**总控台，汇总待处理事项、团队卡片、近 7 天用量与各功能区入口；按 `⌘K` / `Ctrl+K`（或点顶部搜索栏）可直接搜到任意设置项、Bot、群聊或模型。各大类在一页内滚动并附顶部锚点：

- **通用**与**外观**（实时预览、8 种界面语言、主题、布局与动效）
- **模型**：服务商 · 本地智能体 · Bot 模型 · DeepSeek 服务
- **团队**：Bot · 群聊 · 定时任务
- **连接**：连接器 · IM · 手机 · API
- **工具**：电脑操控 · 浏览器 · 能力 · 密钥
- **用量**与**关于 DS Bot**（含**反馈**）

在独立桌面应用中，可以用 ChatGPT 套餐为 Bot 提供模型，无需 OpenAI API 密钥。在**设置 → 模型 → 服务商**展开 **OpenAI**（或通过**添加服务商 → 常用服务商**选择它），然后选择**使用 ChatGPT 登录**。这需要系统提供的安全存储。如何启用套餐用量并选择模型，见[模型说明](ds-bot/README.md#models)。

> **网页搜索提示**：DS Bot 会把 `auto` 搜索 provider 选为整个 profile 的后端。禁用 `web-search-auto` 时，须同时为该 profile 指定另一个已注册的搜索 provider。详见[网页搜索说明](ds-bot/README.md#web-search)和[恢复步骤](docs/known-issues.zh.md#关掉web-search-auto后所有会话的网页搜索都失败)。

## 功能

### 浏览器远程访问（预览）

无需安装 App，也能在浏览器里使用手机端界面。在电脑上打开 **设置 → 手机**，开启手机访问并显示配对码，然后选择 **Open in a browser** 或 **Copy browser link**；也可以在网页里粘贴配对链接。浏览器作为一台额外设备，经已有的端到端加密链路配对；在电脑的已配对设备列表里移除即可撤销访问。

中转服务器需要部署网页构建：在 `mobile/` 运行 `npm ci && npm run export:web`，启动[中转服务器](link/README.md)时把 `DSBOT_LINK_WEB_DIR` 设为 `mobile/dist` 的绝对路径。localhost 以外使用 HTTPS/WSS。`relay.dsbot.app` 完成这项部署后，默认服务器的浏览器链接才能使用。浏览器存储由 IndexedDB 中不可导出的密钥进行 AES-GCM 加密，但浏览器仍运行服务器提供的网页，请只使用可信的服务器。敏感操作需要改用手机 App 或电脑；网页没有后台通知。详见[设计与安全限制](docs/plans/2026-11-17-web-remote.md)。

### 本地 API 与 MCP

本机的其他智能体（Claude Desktop、Cursor、Codex、Antigravity 或你自己的脚本与本地服务）可以通过统一的本地 API 网关调用你的 Bot 和群聊。打开 **设置 → 连接 → API** 开启服务（默认关闭，仅监听 `127.0.0.1:17830`），按能力域与目标范围创建可撤销的 Bearer 令牌；令牌只在创建时展示一次并仅存哈希，隐私 Bot 默认彻底隔离，仅在显式二次确认后才对指定令牌开放。

同一本地网关同时提供版本化 `/v1/*` REST + SSE、MCP Streamable HTTP（`/mcp`）、可单独开关的 OpenAI 兼容层（`/compat/openai/v1/*`）以及薄层命令行（`ds-bot mcp` stdio 桥、`ds-bot send`、`ds-bot event`）。旧版 `mcp.json` 配置与 `npx -p ds-bot ds-bot-mcp` 命令自动平滑迁移与兼容。详见[设计](docs/plans/2026-11-21-external-api.md)。

### Bot

每个 Bot 都是持久化身份，对外始终只有一条连续对话——没有会话列表，也不用手动切会话或开新会话。上下文快满时系统自动压缩或换段，历史记录持续可读可搜。每个 Bot 拥有自己保存的配置（模型、思考强度、指令、工作文件夹和权限预设），不同于 DSH 的安装 profile。

每个 Bot 可以单独设置工作文件夹和权限，换文件夹直接和它说一声就行；一个 Bot 同时负责几个项目时，可以再给它加几个额外工作文件夹，它在这些文件夹里同时干活。Bot 干活时前台始终能接话：耗时的终端命令会自动转入后台执行；Bot 也能主动启动后台任务，或在它正忙时你发新消息把正在做的活顺手转到后台继续跑。你可以在顶栏灵动岛查看进度、批复权限、发追问或停止，在详情页「任务」标签查看任务记录，或在手机端管理活跃任务，也可以输入 `/side` 开侧边对话顺手问一句。Bot 还支持长期记忆、在回复里绘制交互式图表/表格/表单、定时任务，并可在侧边栏按工作收进折叠分组。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### Main Bot

Main Bot 是你的团队总管，拥有创建和修改其他 Bot、管理群聊的高权限（删除 Bot 和修改 Main Bot 身份仅限用户操作）。首次打开时默认带有一个 Main Bot **Chief**——有问题或想搭建团队，直接找它即可。

在**设置 → 团队 → Bot**中可以给 Chief 改名或换头像，不会改变它的 Main Bot 身份。

### 群聊

每个群聊都有一名管理员，默认由管理员回复你的消息并用 `@名字` 调度成员，控制多 Bot 协作的费用。你也可以直接 `@` 任意成员，或通过输入框 **+ → 引用对话** 带入另一段对话作为上下文。

在**设置 → 团队 → 群聊**中选择群聊，可以设置或移除群头像。没有照片时，群聊会显示成员头像拼图。

同一条消息点到的多个成员会并行开工、实时回报进度，共享群记忆、群工作文件夹、群任务面板（`group_task`）和群共享待办（`group_todo`）。做大任务时，群聊可以运行 **Goal**（`/goal`）：管理员先和你对齐完成标准，拆分成阶段派给成员，每段带证据验收后再推进。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 隐私 Bot

把私密工作交给一个 Bot 时，可在它的设置里打开**隐私**并指定独立的工作文件夹。其他 Bot 读不到它的文件夹、记忆和聊天记录，它向其他 Bot 发消息或写外部文件都必须经你批准。即使删掉它，原有文件夹和记录也会继续受保护，直到你在设置里手动解除。

隐私 Bot 不能担任 Main Bot，也不能加入群聊。这道边界只隔离团队内的其他 Bot，不是操作系统沙箱：终端和联网权限仍会生效，模型服务商也会收到对话内容。

### 本地智能体

可直接把电脑上已安装的编程 Agent CLI（Claude Code、Codex CLI、Cursor CLI、GitHub Copilot、Devin CLI、OpenCode、Gemini CLI、Antigravity、Kimi CLI、Kilo CLI 及自定义 CLI）接入为 Bot。它使用 CLI 自己的登录、套餐、模型、工具和上下文，同时照常参与私聊、群聊、派活和记忆。

由于使用 CLI 自己的工具，DS Bot 里的共享能力和连接器不会传给它，切换运行方式会新开一段对话；只有完全拒绝 MCP 服务的 CLI 才拿不到团队工具。注意 Cursor CLI 会把最后一次选中的模型存为全局默认（`~/.cursor`），不想改终端默认时保持「CLI 默认」即可。

### 浏览器

每个 Bot 有独立的浏览器和登录态，桌面应用支持从文件或本机浏览器（Chrome/Edge、Safari、Brave、Arc、Firefox、Zen 等）导入 Cookie 及受支持的 `localStorage`。需要交互式操作网页时，在 DSH profile 里将 `browserPlugin` 设为 `refs`、`script` 或 `task` 并重启 DS Bot；**设置 → 工具 → 浏览器**提供配置指引和按站点操作授权。发帖、上传、下载、删除默认需要你批准；登录、验证码和付款会交还由你操作。

内嵌浏览器面板仅桌面应用和 DSH Desktop 可用（DSH Web 没有）；仅桌面应用会在退出后保留登录态并支持导入 Cookie。

### 电脑操控

在 **设置 → 工具 → 电脑操控** 开启后，可按 Bot 设置权限档位（只看、后台操作、可以动前台）和允许操作的应用；操作时屏幕顶部显示指示条，随时可暂停或接管；系统设置、密码管理器等敏感应用永不授权。

所有 Bot 共用你的桌面，同一时间只有一个 Bot 可占用指定应用或前台鼠标。Windows 上 Chrome/Electron 应用通常需要「可以动前台」，且无法操控管理员权限应用；macOS 需要 14+ 并授予辅助功能与屏幕录制权限；Linux 支持 X11（Wayland 受限）。

### 连接器、能力与功能包

- **设置 → 连接 → 连接器**：接入 GitHub、Gmail、QQ 邮箱、163 等邮箱及远程 MCP 服务（支持浏览器 OAuth 登录或固定 Header/Key），或从 Claude Desktop、Cursor、VS Code 导入配置。凭据存在受保护/可加密的密钥库中（**设置 → 工具 → 密钥**），发邮件默认需要确认。
- **设置 → 工具 → 能力**：管理团队共享的 MCP 服务、技能和能力包。每个 Bot 可按项设为**常驻**（每轮加载）、**清单**（提示词仅占一行索引，任务需要时由 Bot 用 `use_pack` / `drop_pack` 按会话装卸）或**关**；Bot 添加的本地命令必须经你批准才能运行。

### 联网搜索与 DeepSeek 服务

- **联网搜索**：`auto` 搜索坚持使用发起会话自己的模型路由与 Key（绝不借用其他路由的 Key），支持同源 DeepSeek 官方 Search API，不可用时回退至无 Key 搜索。如需所有模型统一使用官方 Search / Fetch API，可在 **插件 → 网页搜索** 打开 **Use the new Web Search API**。
- **DeepSeek 服务**（**设置 → 模型 → DeepSeek 服务**）：在 **设置 → 模型 → 服务商** 配好 DeepSeek API Key 后，可为任意主模型单独开启文档/图片识别（`read_document`）、DeepSeek 朗读与 DeepSeek 听写。各项默认关闭，按自己的 API Key 用量计费。

### Office 文件

Bot 可直接创建、检查和编辑 Word（`.docx`）、PowerPoint（`.pptx`）与 Excel（`.xlsx`）文档，并将页面渲染为图片核对排版。桌面应用自带完整离线运行时；DSH Web 仅支持检查和编辑已有文档，从零创建与页面渲染需使用桌面应用或 DSH Desktop。

### 手机 App 与浏览器远程访问

通过端到端加密链路（Noise IK）在 iOS、Android 或浏览器里远程操控电脑上的 Bot 团队——电脑仅向外连接，不需要公网 IP 或开放端口。在 **设置 → 连接 → 手机** 开启手机访问，用手机 App 扫码即可配对（Android APK 见 [Releases](https://github.com/Fei-Craft/DS-Bot/releases/latest)，iOS 构建见 [`mobile/README.md`](mobile/README.md)）。

无需安装 App 也可使用**浏览器远程访问（预览）**：在同一配对页点 **Open in a browser** 或 **Copy browser link**。自建中转服务器与安全限制见 [`link/README.md`](link/README.md) 和 [`docs/plans/2026-11-17-web-remote.md`](docs/plans/2026-11-17-web-remote.md)。

### IM

在 **设置 → 连接 → IM**，可将任意 Bot 或群聊绑定到微信、飞书、钉钉、企业微信、QQ、Telegram、Discord 或 Slack。电脑运行时即可在聊天软件里对话、群内 `@` 机器人、回复提问卡和审批卡。

微信仅支持与扫码账号私聊；微信与 QQ 有平台回复时间窗；微信、QQ、钉钉不支持卡片按钮，按编号回复即可；密钥卡不允许在聊天软件中填写。


### 用量与外观

在 **设置 → 用量** 按时间、Bot、模型查看 Token 消耗。在 **设置 → 外观** 选择内置主题、强调色、气泡或平铺布局与宽度滑块、界面动效档位及头像动画三档，支持实时预览和 8 种界面语言。

![用量页](docs/images/usage.zh.png)

## 数据与隐私

所有数据都留在你自己的电脑上：桌面应用存在首次启动选定的数据目录（默认 `~/.ds-bot`），插件版存在 DSH 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 下。卸载应用或插件不会删除这些数据。

可选的匿名遥测在首次隐私告知卡确认前不会发送任何数据；你随时可以在 **设置 → 关于 DS Bot → 隐私** 中调整、查看本机最近发出的 20 条完整 JSON 原文或一键关闭（也支持 `DS_BOT_TELEMETRY_DISABLED=1` / `DO_NOT_TRACK=1` 环境变量）。对话、记忆、密钥、文件路径、Bot 名称、隐私 Bot、报错原文与 IP 地址绝不收集。DS Bot 同时默认关闭 DSH 上游的官方 API Session Log 与反馈会话上传，并永久排除隐私 Bot。详见 [`docs/plans/2026-11-25-telemetry-and-privacy.md`](docs/plans/2026-11-25-telemetry-and-privacy.md) 与开源接收端 [`telemetry/`](telemetry/)。

## 文档与开发

- 文档总导航与架构速览：[`docs/README.md`](docs/README.md)
- 插件内部结构与配置项：[`ds-bot/README.md`](ds-bot/README.md)
- 桌面应用结构与打包：[`app/README.md`](app/README.md)
- 开发环境、测试与协作规范：[`CONTRIBUTING.zh.md`](CONTRIBUTING.zh.md)
- 版本更新日志：[`CHANGELOG.md`](CHANGELOG.md)

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：DS Bot 建在 DSH 的插件系统和 Session 上。模型 Bot 用它的 Agent 循环和模型服务；本地智能体 Bot 用 CLI 自己的工具和模型访问。辅助模型调用不经过 Agent 循环，搜索 / 抓取和 DeepSeek OCR、TTS、ASR 则直接请求服务。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。DS Bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：Bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 `@` 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 DS Bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

DS Bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

Bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
