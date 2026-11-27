# docs/plans：已定设计目录

这里收录 DS Bot 已定下的架构与功能设计：为什么这样做、当前已定的行为、不做什么、已知限制。拿不准一个现象是 bug 还是设计如此时，先查这里、[文档总导航](../README.md) 和 [愿景](../vision.zh.md)。

## 维护原则（活文档）

- **大功能**：在同一个 Pull Request 里附一份 `docs/plans/<日期>-<主题>.md`，随代码一起审查合并。
- **改动已定设计**：先在 Issue 里和维护者确认（带 `maintainer` 标签），合并时**直接就地更新对应文档的「已定的行为」**，删掉已失效的旧方案，仅在文末「变更」留一行记录，不要用「（已作废：…）」层叠堆砌旧稿。
- **修 bug**：不用写设计文档。

## 按领域索引

### 1. 架构、权限与核心边界

| 文档 | 内容 |
|---|---|
| [DSH 让步总账](2026-10-13-dsh-concessions.md) | 当前仍在生效的 DSH 上游限制、现行绕法与清理方向（以及已清理清单） |
| [角色与权限](2026-10-07-roles-and-permissions.md) | 用户、Main Bot、群管理员、普通 Bot 的权责边界；Bot 权限预设与群统一权限 |
| [隐私 Bot](2026-10-27-private-bots.md) | 独立工作文件夹、团队内隔离边界、外发审批与删除后保留保护 |
| [Bot 运行配置](2026-10-10-bot-runtime.md) | Agent 预设、每 Bot 模型与思考强度、新 Bot 默认模型、工作文件夹与能力 |
| [每个 Bot 的 Agent 预设](2026-11-06-bot-presets.md) | `bot.agentPreset`：默认跟着目录走（可用的 standard，否则 DSH 的默认），用户可给 Bot 显式换兼容的预设；失效即报错不静默回落；换预设后空闲换段生效，没成就在下一轮补；预设不解除 Bot 的 guard 和角色限制 |
| [额外工作文件夹](2026-11-10-extra-folders.md) | Bot 和群聊在工作文件夹之外再列几个文件夹；文件工具写那里由 DS Bot 自动批准，shell 命令仍问用户；群文件夹优先；隐私 Bot 只用自己的文件夹 |
| [功能包](2026-11-21-feature-packs.md) | 团队库三档状态（常驻 / 清单 / 关）、按会话 `use_pack` / `drop_pack` 装卸与 `team-admin` 内置包 |

### 2. Bot 对话、异步工作与协作

| 文档 | 内容 |
|---|---|
| [Bot 异步工作](2026-11-16-async-work.md) | 慢 Shell 自动转后台 job、前台忙收新消息转后台、`task_*` 后台任务工具与顶栏灵动岛 |
| [消息与异步协作底座](2026-11-25-message-coordination.md) | 本机 SQLite 协调真相库（`coordination.sqlite`）、逻辑地址投递、原子终态与报告义务、统一冷历史核实与不打断工作更正（英文） |
| [Bot 之间派活](2026-10-16-bot-handoffs.md) | 同伴状态可见、独立委托编号与派活树（子活交回后再向上交回） |
| [本地 Agent CLI 作为 Bot](2026-11-04-local-agents.md) | 将本机编程 CLI 接入为 Bot：运行切换、会话映射、工具桥、审批与记忆（英文） |
| [Side chat（侧边对话）](2026-10-21-btw.md) | 右侧栏 `/side` 顺手提问：基于快照回答、不执行工具、不打断主对话 |
| [Bot 聊天和群聊的 `/` 菜单](2026-11-13-bot-slash-commands.md) | agent 作用域命令遮蔽（`commandShield`）与 DS Bot 动作注入（`/scheduled-task`、`/goal`） |
| [长消息](2026-10-16-long-messages.md) | 超过 2 万字的 Bot 消息转存为附件与全文按需读取 |
| [读长回复](2026-11-13-long-reply-reading.md) | 长回复滚动后顶部阅读胶囊：回到开头、当前小节与目录跳转 |
| [批量换 Bot 的模型](2026-11-13-bot-models.md) | 设置页多选 Bot 一次切换模型与逐个结果报告（英文） |

### 3. 群聊协作

| 文档 | 内容 |
|---|---|
| [群聊](2026-10-07-group-chat.md) | 管理员先答与全员轮流、`@` 并行开工与接力、派活批次、空转守卫、审批与全部停止 |
| [消息账本](2026-11-10-message-ledger.md) | 群聊只追加账本（`ledger/group-<id>.jsonl`），统一服务界面、成员、记忆整理与 IM |
| [群聊 Goal](2026-11-01-group-goal.md) | 管理员对齐完成标准、分阶段派活与带证据验收、空闲推进与头部进度胶囊 |
| [群聊任务面板](2026-11-12-group-task-board.md) | `group_task` 显式登记负责人、目标、进度与结果摘要 |
| [群聊共享待办](2026-11-10-group-todos.md) | `group_todo` 群内共享待办清单（上限 100 条） |
| [群聊里的改动](2026-11-12-group-changes.md) | 每轮消息下方展示该轮文件改动摘要并可打开改动审查（英文） |

### 4. 上下文、记忆与自我改进

| 文档 | 内容 |
|---|---|
| [上下文与记忆](2026-10-09-context-and-memory.md) | 自动分段、上下文管家（压缩检查点 vs 换段交接包）、`read_own_chat` 全文索引与记忆存储 |
| [记忆的四种读法](2026-11-09-memory-layers.md) | 常驻、增量、自动召回、按需四层机制、额度计算、团队常驻层与每日整理 |
| [记忆撤销与更改记录](2026-11-01-memory-restore.md) | 基于 `journal.jsonl` 的单条记忆逆操作撤销 |
| [AGENTS.md 维护](2026-10-27-agents-md-upkeep.md) | 从项目工作中提炼持久规则，经用户批准后原子写入 |
| [自动缺陷报告](self-report-issue.md) | 内置 `report-ds-bot-issue` 技能脱敏起草并在确认卡授权后提交 GitHub Issue（英文） |

### 5. 工具、浏览器、服务与安全

| 文档 | 内容 |
|---|---|
| [Bot 浏览器、联网搜索与密钥](2026-10-08-browser-and-secrets.md) | 隔离浏览器面板与 Cookie/localStorage 导入、`auto` 搜索、密钥卡与出站脱敏 |
| [浏览器插件](2026-10-21-browser-plugins.md) | 可选交互式浏览器后端（`refs` / `script` / `task`）、每 Bot 独立 Profile、动作预授权与用户接管 |
| [Bot 插件体系与面板](2026-11-22-bot-plugins.md) | DS Bot 统一插件运行时、互斥槽位、按 Bot 开关、独立插件面板、可替换浏览器插件与插件收录仓库目录 |
| [电脑操控](2026-11-04-computer-use.md) | 按 Bot 四档权限、应用授权与禁碰清单、应用/前台租约与顶部指示条 |
| [连接器](2026-11-04-connectors.md) | 通用连接器引擎、OAuth 浏览器登录、自定义 MCP 服务器与邮箱集成 |
| [密钥的静态加密](2026-11-12-encrypted-secrets.md) | `secrets.json` 可选 scrypt + AES-256-GCM 口令加密与无人值守解锁 |
| [搜索来源摘要](2026-11-14-search-summaries.md) | `auto` 联网搜索接入同源官方 Search API 与来源 summary 透传 |
| [DeepSeek 文档识别](2026-11-14-read-document.md) | 独立 DeepSeek API Key 驱动的只读 `read_document` OCR 与凭据隔离 |
| [DeepSeek 语音](2026-11-14-deepseek-services.md) | 独立 DeepSeek API Key 驱动的 ASR 听写与分段串行 TTS 朗读 |
| [Office 文档](2026-10-27-office-documents.md) | 离线读写 `.docx` / `.pptx` / `.xlsx` 与页面渲染核对 |

### 6. 桌面应用、移动端、IM 与外部访问

| 文档 | 内容 |
|---|---|
| [桌面应用](2026-10-16-desktop-app.md) | Electron 壳与锁定 DSH 引擎、无边框材质、托盘、自建选择框、数据搬迁与自动更新 |
| [桌面端安装与上手流程](2026-10-26-windows-onboarding.md) | 下载资产、安装向导、首次启动定根与导入、模型配置与恢复卡 |
| [启动窗口：领航鲸](2026-10-26-start-window.md) | 固定小窗双窗口交接、三段/四段真实进度弧、鲸鱼动作与页内恢复卡 |
| [启动页文案](2026-10-29-start-copy.md) | 启动页与壳内卡片的文案分层、`text.mjs` 单表与扫描校验 |
| [Linux 桌面包](2026-10-21-linux-app-package.md) | 同轮产出 AppImage（自更新）与 deb（沙箱兜底） |
| [手机 App](2026-10-24-mobile-app.md) | iOS / Android 原生远程端：Noise IK 加密中转、高权限生物解锁与同步规则 |
| [移动端客户端 API](2026-10-24-mobile-api.md) | 握手版本、头像引用、群聊分页、提醒补发、分块下载与 Gateway Remote 方法 |
| [浏览器远程客户端](2026-11-17-web-remote.md) | Expo 网页版与 Relay 同源部署；浏览器链接配对、独立设备身份、localStorage 与 CSP 安全边界 |
| [iOS 出包与 TestFlight](2026-11-13-ios-release.md) | Apple 账号准备、签名归档与 TestFlight 上传指引 |
| [IM](2026-11-04-im.md) | 微信、飞书、钉钉、企业微信、QQ、Telegram、Discord、Slack 双向桥接与配对边界 |
| [MCP 访问](2026-11-20-mcp-access.md) | （已收口至 [对外统一 API](2026-11-21-external-api.md)）初版独立 MCP 访问设计记录；现统一由设置 → API 同端口 `/mcp` 与自动迁移承接 |
| [对外统一 API](2026-11-21-external-api.md) | 持锁宿主自建本机网关（默认关闭、`127.0.0.1:17830`）：独立可撤销 Bearer Token、Scope × 目标白名单与隐私隔离、统一 `Run` 状态机、`/v1/*` REST+SSE、`/mcp` Streamable HTTP、薄层 `ds-bot` CLI 与可选 OpenAI 兼容层 |

### 7. 界面与交互

| 文档 | 内容 |
|---|---|
| [设置总控台](2026-11-22-settings-console.md) | Overview 概览、⌘K 搜索面板、分组一页滚动锚点、外观实时预览与 `OverlayBoundary` 隔离 |
| [键盘快捷键系统](2026-11-25-shortcuts.md) | 统一快捷键注册表、切换经典模式/收件箱/浏览器/1–9 切对话、设置页自定义改键与冲突检测、Bot 浏览器视图透传 |
| [Bot 视图](2026-10-20-widget-views.md) | `show_view` 结构化蓝图组件（图表/表格/表单/公式）与沙箱 HTML 视图 |
| [收件箱](2026-11-25-inbox.md) | 宿主派生一份「等你处理」清单（决定 / 修复 / 建议），侧栏标记、收件箱页、桌面通知、手机「需要你」与推送都读它 |
| [侧边栏分组](2026-11-04-sidebar-sections.md) | 折叠分组、微缩角色簇与待处理状态透出、右键/拖拽归组与 88px 窄栏 |
| [消息布局和宽度](2026-10-22-message-layout.md) | 气泡 / 平铺两种消息布局与百分比宽度滑块 |
| [头像库](2026-10-23-avatar-library.md) | 按内容哈希去重的可复用自定义头像库与批量导入 |
| [头像动效](2026-11-24-avatar-motion.md) | 同一 3D 模型运行时转身、14 种表情、多轨片段与状态动作袋、三档与省电时钟 |

## 已废除的设计

| 文档 | 说明 |
|---|---|
| [一个 Bot 同时跑两个会话](2026-11-13-parallel-sessions.md) | 已废除（#2039、#2042）：由单 Bot 单连续对话 + [Bot 异步工作](2026-11-16-async-work.md)取代 |

## 新文档模板

```markdown
# 标题

- 日期：YYYY-MM-DD
- 相关：Issue / PR 编号

## 为什么
要解决的问题与核心取舍。

## 已定的行为
可验证的现行规则（只写现在，不写过程）。

## 不做什么

## 已知限制

## 变更
- YYYY-MM-DD：简述改动与对应 PR。
```
