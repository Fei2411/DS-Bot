# Bot 插件体系、插件面板与插件收录仓库

- 日期：2026-11-22
- 相关：v0.4.0；延续并收编 [浏览器插件](2026-10-21-browser-plugins.md) 与 [桌面应用](2026-10-16-desktop-app.md)「插件」一节
- 代码：`ds-bot/src/host/plugins/`、`ds-bot/src/host/browser-plugins.js`、`ds-bot/src/client/plugins-page.js`

## 为什么

DS Bot 的桌面应用和插件版都基于 DSH 引擎，但 DSH 原生插件管理面向通用单 Agent 会话，存在三个结构性缺口：

1. **没有 Bot 团队语义**：无法把同一类互斥能力（例如多个浏览器操控后端）抽象成全团队热切换槽位，也无法对普通插件按 Bot 单独开关或向插件安全透传每 Bot 隔离目录、桌面端浏览器面板、审批与交接卡上下文。
2. **桌面应用没有插件管理入口**：桌面应用接管了侧栏且不加载 DSH 的插件导航，用户无法在桌面应用里浏览、安装、开关、更新或卸载插件。
3. **浏览器后端写死在启动配置**：原有的 `browserPlugin` 只能在 DSH profile 里静态配置 `refs` / `script` / `task`，无法在界面热切换，也无法干净替换为 Ego Lite 等 DSH 浏览器插件或 Playwright / Chrome DevTools MCP 服务。

因此，v0.4.0 在 DSH 引擎 `pluginManager` 之上建立 DS Bot 自己的插件抽象、统一插件面板和独立的插件收录仓库，并以「多个可替换的浏览器插件」作为首批落地能力。

## 已定的行为

### 1. 插件来源与统一模型

DS Bot 插件运行时（`ds-bot/src/host/plugins/`）统一纳管三类插件：

- **`builtin`（内置插件）**：随 DS Bot 内置提供，遵循与第三方一致的生命周期契约（如 `builtin:readonly`、`builtin:refs`、`builtin:script`、`builtin:task`）。
- **`dsh`（DSH / Bot 原生包）**：通过 DSH 引擎的 `ctx.pluginManager` 安装、启停、更新与卸载（支持 npm 包名、GitHub 仓库、本地绝对路径）。该包既可以是标准 DSH 插件，也可以向 `ctx.dsBotPlugins` / `ctx.dsBotBrowser` 注册原生扩展以获得热插拔生命周期与 Bot 上下文。
- **`mcp`（MCP 封装插件）**：通过 `@deepseek-ai/dsh-mcp-client` 动态挂载 stdio 或 Streamable HTTP 服务，支持 `$DSH_SECRET_<NAME>` 密钥引用展开，卸载或切换时自动释放连接与子进程。

### 2. 互斥槽位（Slot）与按 Bot 开关

- **互斥槽位**：声明 `slot`（首批为 `browser`）的插件归属该槽位，全团队同一时间只激活一个插件，支持在界面热切换无需重启。
  - 切换时卸载旧插件挂载的资源与工具，屏蔽同槽位中未激活的外部 DSH 插件工具，再挂载新插件。
  - 挂载同步或异步失败时自动回滚已注册的工具与清理钩子，不留半套工具，并安全回退或报告错误。
  - 启动时若已保存的原生插件尚未加载完成而先回退到默认态（如 `builtin:readonly`），待该插件随后注册到 `ctx.dsBotPlugins` / `ctx.dsBotBrowser` 时自动重新协调并激活。
- **普通插件（无 `slot`）**：可并行启用，支持在 `state.plugins.offFor[pluginId]` 中按 Bot 单独关闭（新装插件默认对所有 Bot 开启），宿主通过 `agent.ctx.tools.restrict` 按 Bot 屏蔽对应工具前缀。
- **核心工具保护**：任何插件声明的 `toolPrefixes` 在屏蔽时绝不允许遮蔽 DS Bot 自身的团队核心工具。

### 3. 首批插件：可替换浏览器槽位（`slot: "browser"`）

- 向后兼容旧的 DSH profile `config.browserPlugin`（`refs` / `script` / `task`）和 `config.browserPluginApi`：在 `state.plugins.slots.browser` 未显式设置时作为初始默认项；未配置时默认是 `builtin:readonly`。
- 首批内置可替换插件：
  - `builtin:readonly`：仅保留桌面只读 `read_browser`。
  - `builtin:refs`：Playwright 按元素编号快照/点击/输入/截图，支持每 Bot 独立 profile、桌面端 CDP 面板、写操作预授权与审批、删除二次确认、付款拦截与 `browser_handoff` 交接卡。
  - `builtin:script`：Playwright 单步 JS 脚本执行，复用同等隔离与安全能力。
  - `builtin:task`：Playwright 子任务委派，使用当前 Bot 的模型完成多步任务。
- 首批目录收录外部可替换插件：
  - `dsh:dsh-ego-browser`（兼容 `@dshworks/dsh-ego-browser`）：Ego Lite DSH 浏览器插件。
  - `mcp:playwright-mcp`：`@playwright/mcp`（Playwright MCP 服务）。
  - `mcp:chrome-devtools-mcp`：`chrome-devtools-mcp`（Chrome DevTools MCP 服务）。
- 激活任意非 `readonly` 外部浏览器插件时，自动在 Bot 会话中隐藏 `read_browser` 并注入 `bot-browser` 系统提示词段落，要求将网页内容视为不可信数据。

### 4. 插件收录仓库与目录源（Registry Schema v1）

- DS Bot 默认连接官方维护的独立插件收录仓库索引（`registry.json`，支持通过环境变量 `DS_BOT_PLUGIN_REGISTRY` 覆盖，并允许用户在面板里增删自定义 HTTPS 目录源）。
- 本地磁盘缓存到 `<rt.home>/plugin-catalog-cache.json`（1 小时 TTL，支持手动刷新），并内嵌一份离线默认快照，断网时仍可查看首批精选插件。
- 目录源拉取强制仅允许 `https:` 且拒绝本地环回与私网地址（防 SSRF），单次响应上限 1 MB、超时 10 秒。

### 5. Bot 插件面板

- 桌面应用与插件版共用同一套自建「插件」面板，入口位于设置总控台独立分组「插件」及侧栏底部「插件」快捷按钮；「设置 → 工具 → 浏览器」页提供当前浏览器插件状态与直跳入口。
- 面板包含「已安装 / 发现 / 添加」三块视图，支持搜索、分类与槽位筛选、一键安装/切换/启停/更新/卸载、按 Bot 开关以及自定义 DSH 包 / MCP 服务 / 目录源管理。
- 插件安装、卸载、切换与自定义 MCP/目录源管理属于高权限宿主变更，不在 `BROWSER_ALLOWED` 远程浏览器白名单中（远控端默认 fail-closed 拒绝），只读窗口禁止变更。

### 6. 自定义 MCP 安全约束

- 拒绝在 Streamable HTTP URL 中内嵌用户名/密码或敏感 query 参数，拒绝明文敏感 header（如 `Authorization`、`Cookie`、`X-Api-Key` 等），要求改用 `$DSH_SECRET_<NAME>` 密钥引用。
- 返回给前端的自定义 MCP 视图隐去环境变量与请求头的值，仅暴露已配置的键名。

## 不做什么

- 不修改或 patch DSH 本体，全部通过 DSH 公开的 `pluginManager`、`tools`、`systemPrompt` 与 `@deepseek-ai/dsh-mcp-client` 实现。
- 不在 DS Bot 仓库内嵌第三方浏览器插件代码或二进制（如 Ego Lite 运行时）。
- 不为单个 Bot 分别指定不同的浏览器后端：浏览器槽位仍为全团队单选，保持同队工具契约一致。

## 已知限制

- 非原生 Provider 形态的标准 DSH 浏览器插件自带浏览器实例与隔离方式，无法复用 DS Bot 桌面端 Electron `WebContentsView` 每 Bot cookie 分区与 DOM 级写操作预授权。
- 在未开启 HMR 的 DSH profile 中安装、更新或卸载 DSH 插件包时，工具加载或彻底释放可能需要重启 DS Bot；界面会明确提示重启状态，且待重启卸载的插件工具会在重启前保持屏蔽。
- 普通 DSH 插件的按 Bot 开关依赖工具前缀匹配（目录条目预填，自定义条目可手动补充），对界面扩展与后台服务不按 Bot 拆分。

## 变更

- 2026-11-22：定案并落地 v0.4.0 Bot 插件体系、插件面板、可替换浏览器槽位与独立插件收录仓库规范。
