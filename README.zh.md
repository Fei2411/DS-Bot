<p align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg"><img src="docs/images/logo.svg" alt="DS Bot" width="260"></picture></p>

# DS Bot

[English](README.md) | 中文

![版本](https://img.shields.io/badge/版本-v0.3_预览-blue) ![DSH](https://img.shields.io/badge/DSH-0.2.2--rc.1-4D6BFE) ![许可](https://img.shields.io/badge/许可-Apache_2.0-green)

DS Bot 是一个基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的开源项目，提供独立桌面应用和 dsh 插件两种形态。它将 dsh 改造为 bot 形式，你可以与自己创建的 bot 交流、工作。

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

桌面应用自带 dsh，不用先装 dsh。直接在 [Releases](https://github.com/Fei2411/DS-Bot/releases/latest) 下载对应系统的安装包，打开后在设置里配好模型就能用（也可以直接复制你原来在 dsh 里的 bot 团队）。

如果安装或打开时提示未签名拦截：Windows 点 **更多信息** → **仍要运行**；macOS 在 **系统设置** → **隐私与安全性** 里点 **仍要打开**。

**作为 dsh 插件**

先装好 dsh，并在 dsh 里配好至少一个模型。ds bot 直接使用 dsh 里的模型。

- **dsh Desktop**：侧栏点 **插件** → **添加插件**，包名填 `ds-bot`（在中国大陆，安装源选 **中国大陆镜像源**），点 **安装** 并 **立即启用**。
- **dsh Web**（需要 Node.js `22.19` 以上和 pnpm）：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add ds-bot
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

**Docker（NAS、Linux 服务器）**

见 [`docker/README.md`](docker/README.md)。

## 配置

我强烈建议你直接通过和 bot 对话来配置其他 bot 和群聊。

### 网页搜索

DS Bot 会把 `auto` 搜索 provider 选为整个 profile 的后端。禁用 `web-search-auto` 时，也要为该 profile 选择另一个已注册的搜索 provider。详见[网页搜索说明](ds-bot/README.md#web-search)和[恢复步骤](docs/known-issues.zh.md#关掉-web-search-auto-后所有会话的网页搜索都失败)。

## 功能

### Bot

你可以在一个窗口中和一个 bot 完成所有对话和工作，你无需担心背后的上下文问题。你可以在 bot 详情页查看 bot 信息，也可以为 bot 选择你想使用的模型和思考强度。你可以随时切换模型，但我仍然建议你为一个 bot 长期保持一个模型，仅在真正必要的时刻切换。

另外，bot 拥有记忆，它会记住你的喜好并在下次的工作中应用。你可以在 bot 的详情页管理记忆，也可以直接和 bot 对话来进行管理。

每个 bot 可以单独设置工作文件夹和权限，换文件夹直接和它说一声就行。它干活时你可以随时插话，或者输入 `/side` 开侧边对话顺手问一句而不打断它；它也能在回复里直接画图表、表格和表单，或者跑定时任务。侧边栏里还可以把 bot 和群聊按工作收进分组。

![bot 详情页：模型、记忆、用量](docs/images/details.zh.png)

### Main bot

这个 bot 作为你的 chief，它拥有非常高的权限，可以管理其他 bot 和群聊。第一次进入 ds bot 时，默认会有一个 main bot 叫 Chief。你可以直接和它对话，让它引导你完成配置。

总之，有问题，找 main bot。

### 群聊

ds bot 拥有群聊功能。群聊是非常好的多 bot 协作方式，但它会带来非常明显的费用问题。ds bot 为此特意做了优化：在一个群聊中，你需要设置一个管理员。你的消息默认由管理员回复，它会帮你调用其他 bot。你也可以直接 @ 你需要沟通的 bot，它会直接回应你。想让 bot 参考另一段对话，点输入框的 + → 引用对话就行。

任何 bot 都可以用 @ 把活派给其他 bot，接活的 bot 自己去做，做完把结果发回群里。群聊有自己独立的记忆和工作文件夹，群外的 bot 看不到。做大任务时，群聊可以设定目标（Goal），由管理员先和你对齐完成标准，再拆成阶段分给成员，逐段验收推进。

![群聊：管理员 Chief 把活派给写手和程序员](docs/images/group.zh.png)

### 隐私 bot

如果有些私密工作你只想和一个 bot 聊，可以在它的设置里打开隐私，并给它设一个独立的工作文件夹。其他 bot 读不到它的文件夹、记忆和聊天记录，它向其他 bot 发消息或写外部文件也必须先经你批准。就算删掉它，原来的内容也会继续受保护，直到你在设置里手动解除。

要注意，隐私 bot 不能作为 main bot，也不能进群聊。这道隔离只防团队里的其他 bot，不是系统沙箱：如果给了它终端命令或联网权限，它仍然能读写系统文件或联网，模型服务商也会收到对话内容。

### 本地 Agent

你电脑上已经在用的编程 Agent CLI（Claude Code、Codex CLI、Cursor CLI、Devin CLI、OpenCode、Gemini CLI 等）可以直接接入当 bot 用。新建 bot 时选本地 Agent（或在 bot 设置里切换），它就会直接用 CLI 自己的登录、套餐和模型，同时照常参与私聊、群聊、派活和记忆。

不过有几点限制：本地 Agent 走的是 CLI 自己的工具和上下文，ds bot 里的共享能力和连接器不会传给它，切换运行方式也会新开一段对话；不支持 HTTP MCP 的自定义 CLI 拿不到建 bot、派活等团队工具。另外，Cursor CLI 会把最后一次切换的模型存成它自己的全局默认（`~/.cursor`），如果你在 ds bot 里给某个 Cursor bot 选了具体模型，其他用默认模型的 Cursor bot 和你终端里的 Cursor 都会跟着变，不想改全局默认的话保持“CLI 默认”即可（需要先登录 Cursor 才能看到模型列表）。

### 浏览器

每个 bot 有自己独立的浏览器，登录状态互不干扰，也支持从文件或本机浏览器导入 Cookie。在 设置 → 浏览器 里开启操作插件后，bot 可以自己打开和操作网页；发帖、上传、下载、删除需要你批准，遇到登录、验证码或付款会发卡片交给你处理，你随时可以接管再交还。

浏览器功能仅桌面应用和 dsh Desktop 可用（dsh Web 没有），且只有桌面应用在退出后会保留网页登录状态、支持导入 Cookie。Windows 上 Chrome 和 Edge 开启了 v20 加密的新 Cookie 无法直接读取，需要先用浏览器扩展导出成文件再导入。

### 电脑操控

在 设置 → 电脑操控 里打开开关后，bot 可以在你允许的范围内操作电脑上的应用。你可以给每个 bot 单独设档位（只看、后台操作、可以动前台）和允许使用的应用，操作时屏幕顶部有指示条，随时能暂停或接管；系统设置、密码管理这类应用永远不会交给 bot。

所有 bot 和你共用同一个桌面，同一个应用或前台鼠标同一时间只能有一个 bot 用。Windows 上 Chrome、Electron 这类应用在后台常收不到点击和输入，需要设为“可以动前台”，且无法操作管理员权限的应用；macOS 需要 14 及以上并开启辅助功能与屏幕录制权限；Linux 支持 X11，Wayland 受限。

### IM

在 设置 → IM 里，可以把 bot 或群聊连到微信、飞书、钉钉、企业微信、QQ、Telegram、Discord 或 Slack。配对账号后就能在聊天软件里直接对话、在群里 @ 机器人、回复提问卡和审批卡，电脑不需要公网地址或开放端口。

只有你的电脑开着、ds bot 在运行时才能收发消息。微信只支持和扫码账号私聊，不支持群聊；微信和 QQ 受平台限制，只有在你发消息后的一段时间内能回复，超时后你在聊天软件里再发一句就能恢复。微信、QQ、钉钉没有卡片按钮，直接回复数字编号来选择；出于安全，密钥卡不能在聊天软件里填。

### 连接器与能力

在 设置 → 连接器 里，可以登录 GitHub、Gmail、QQ 邮箱、163 等邮箱和远程 MCP 服务，也能从 Claude Desktop、Cursor、VS Code 导入已有配置。凭据保存在 ds bot 的密钥里，bot 看不到明文，写的邮件默认也要你确认后才发。

在 设置 → 能力 里，可以管理团队共享的 MCP 服务、技能和能力包，并在每个 bot 的设置里按需开启；bot 自己添加的本地命令需要先经你批准才能运行。

### Office 文件

bot 可以直接创建、检查和修改 Word（`.docx`）、PowerPoint（`.pptx`）和 Excel（`.xlsx`）文档，还能把页面渲染成图片来检查排版。桌面应用已经自带完整的运行环境，开箱即用；dsh Web 没有打包这套环境，只能检查和修改已有文档，从零建文件和渲染页面需要用桌面应用或 dsh Desktop。

### 用量

在 设置 → 用量 里，可以按时间、按 bot、按模型查看 Token 用量。

![用量页](docs/images/usage.zh.png)

## 数据

所有数据都在你自己的电脑上：桌面应用存在首次启动选定的位置（默认 `~/.ds-bot`），插件版存在 dsh 主目录（默认 `~/.dsh`）的 `bot/` 和 `sessions/` 里。卸载应用或插件不会删除这些数据。

## 开发

插件源码在 [`ds-bot/`](ds-bot/)。配置项和内部结构见 [`ds-bot/README.md`](ds-bot/README.md)，开发、测试和协作方式见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## 致谢

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：ds bot 建在 dsh 的插件系统上。每个 bot 都在 dsh 会话里工作，用的是 dsh 的工具和模型。
- [esbuild](https://esbuild.github.io/)：用来打包插件的界面代码。
- 感谢下面这些项目公开的设计思路。ds bot 参考了它们的思路，没有使用它们的代码：
  - [AgentMemoryRepo](https://github.com/AgentMemoryRepo/agentmemoryrepo)：bot 记忆的 Markdown 格式。
  - [OpenAI Codex](https://github.com/openai/codex)：压缩时把用户原话留在摘要旁边，以及搜索聊天记录用的消息锚点。
  - [OpenMausBot](https://github.com/milind-soni/OpenMausBot)：群聊轮流发言和 @ 接力。
  - [Hermes Agent](https://github.com/NousResearch/hermes-agent) 和 [Hermes Bot Mode](https://github.com/NousResearch/Hermes-Bot-Mode)：每个成员在每个群里一个会话，以及交接时带上用户之前的原话。
  - [OpenCode](https://github.com/sst/opencode)、[goose](https://github.com/block/goose)、[pi](https://github.com/badlogic/pi-mono)、[Gemini CLI](https://github.com/google-gemini/gemini-cli)：长对话什么时候压缩，交接笔记写哪些内容。
  - [obelisk](https://github.com/tommy0103/obelisk)：用 SQLite 全文索引搜索聊天记录。
- 每一位试用 ds bot、提问题、报 bug 的人。

## 许可

[Apache License 2.0](LICENSE)。按“原样”提供，不附带任何担保。用到的第三方代码和它的许可见 [NOTICE](NOTICE)。

## 声明

ds bot 是独立的社区项目，**不是 DeepSeek 官方产品**，与 DeepSeek 没有隶属、认可或赞助关系。“DeepSeek”“DeepSeek Harness”等名称是各自所有者的商标，这里只用来说明本插件和什么一起用。

bot 会消耗你自己的模型额度，也会按你的要求读写文件、运行命令。重要的操作请自己检查。
