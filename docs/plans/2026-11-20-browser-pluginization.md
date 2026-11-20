# 浏览器操控插件化：可替换后端与第三方 DSH 插件接入

- 日期：2026-11-20
- 相关：延续并扩展 [浏览器插件](2026-10-21-browser-plugins.md)（v0.4.0 前置架构）
- 代码：`ds-bot/src/host/browser/provider.js`、`ds-bot/src/host/browser/catalog.js`、`ds-bot/src/host/browser-plugins.js`、`ds-bot/src/host/browser/mount.js`、`ds-bot/src/host/browser.js`、`ds-bot/src/client/browser-settings.js`

## 为什么

DS Bot 内置了基于 Playwright 的浏览器后端（`refs` / `script` / `task`），按 Bot 隔离 profile 并接入桌面应用侧边面板与安全授权。但生态里已有多种同样优秀的浏览器操控方案，例如：

- **社区 DSH 浏览器插件**：如 `dsh-ego-browser`、`@dshworks/dsh-ego-browser`（ego lite），或其他直接向 DSH 注册浏览器工具的插件；
- **MCP 浏览器服务**：如 Playwright MCP（`@playwright/mcp`）、Chrome DevTools MCP（`chrome-devtools-mcp`）或自定义 stdio / Streamable HTTP 服务；
- **深度集成的原生 Provider 插件**：希望接管浏览器引擎实现，同时继续复用 DS Bot 的每 Bot profile、桌面端 CDP 面板、写操作预授权和 `browser_handoff` 交接卡。

原先的 `browserPlugin` 只能把 `refs` / `script` / `task` 写死在 DSH profile 配置里，重启生效，无法在设置页切换，也不能干净地替换为第三方浏览器操控插件（多个插件同时挂在会话里会导致工具冲突，内置 `read_browser` 也会干扰外部浏览器工具）。

本次将 DS Bot 的浏览器操控能力彻底插件化，使内置 Playwright 成为众多可插拔后端之一，所有浏览器操控工具都可以在「设置 → 浏览器」里热切换、安装和替换。

## 已定的行为

### 统一的浏览器后端抽象（全团队单选，热切换）

- 团队在 `state.browser.active` 中保存当前选中的浏览器后端，在「设置 → 浏览器」中切换立即生效（热卸载旧后端工具与连接、热挂载新后端，无需重启 DS Bot）。
- 向后兼容旧的 DSH profile `config.browserPlugin`（`refs` / `script` / `task`）和 `config.browserPluginApi`：在 `state.browser.active` 未显式设置时作为初始默认后端；未配置时默认仍是 `readonly`。
- 支持五类后端：
  1. **`readonly`（内置只读面板）**：保留原有桌面 `read_browser`，不挂载交互工具。
  2. **`builtin:refs` / `builtin:script` / `builtin:task`（内置 Playwright）**：通过与第三方完全一致的 Provider 契约挂载；支持每 Bot 隔离 profile、桌面应用侧边面板 CDP、写操作预授权与审批、删除二次确认、付款拦截与 `browser_handoff` 交接卡。
  3. **`dsh:<packageName>`（标准 DSH 浏览器插件）**：
     - 内置常用插件目录（如 `dsh-ego-browser`、`@dshworks/dsh-ego-browser`），不内嵌任何第三方代码。
     - 通过 DSH 的 `pluginManager.listBundles()` 自动探测已安装的浏览器类 DSH 插件（包括目录已知包、用户手动添加的自定义 DSH 插件，以及包名/描述声明为浏览器操控插件的 bundle）。
     - 在设置页支持一键安装（`pluginManager.installBundle(spec)`）或启用（`pluginManager.setBundleEnabled(name, true)`）；环境不提供 `pluginManager` 时提供可复制的 `dsh plugin add <spec>` 命令。
     - 若该 DSH 插件同时向 DS Bot 注册了原生 Provider（见下节），优先走原生 Provider 挂载；否则作为标准 DSH 插件激活。
  4. **`mcp:<id>`（MCP 浏览器服务）**：
     - 内置常用预设（Playwright MCP、Chrome DevTools MCP），支持在设置页添加自定义 stdio 或 Streamable HTTP 服务。
     - 通过 `@deepseek-ai/dsh-mcp-client` 动态挂载，支持 `$DSH_SECRET_<NAME>` 密钥引用展开，切换或关闭时自动释放子进程与连接。
  5. **`provider:<id>`（原生 DS Bot Browser Provider）**：
     - DS Bot 通过 `rt.browserRegistry` 及 Cordis 服务 `dsBotBrowser`（`registerProvider` / `unregisterProvider` / `listProviders` / `getActive`）向第三方 DSH 插件暴露标准注册入口，并导出 `defineBrowserProvider` 辅助函数。
     - Provider 可提供 `{ toolDefs, openSession? }` 复用 DS Bot 的会话排队、截图附件落盘、`gateScope` 写操作授权与接管检查，或实现完整的 `mount(host)` 生命周期（返回 `{ dispose, drop?, frame?, systemPrompt? }`）。
     - `host` 上下文提供：`defineTool`、`registerTool`、`unregisterTool`、`resolveBotId`、`profileDir`、`downloadRoots`、`uploadRoots`、`connectCdp`、`authorize`、`getHold`、`onHold`、`subscribeHolds`、`completeFor` 及运行时选项。

### 干净替换与工具隔离

- **按后端替换工具**：
  - 切换到外部浏览器（`mode: 'external'`，包括自带浏览器的标准 DSH 插件与 MCP 浏览器服务）时，自动卸载内置 Playwright 交互工具，并隐藏 Bot 的 `read_browser` 工具，避免模型在无页面可看的内置面板上打转；切回 `readonly` 或 `builtin:*` 时立即恢复。
  - 多个浏览器 DSH 插件同时安装时，DS Bot 在 Bot 会话作用域内通过 `agent.ctx.tools.restrict({ deny })` 屏蔽未激活浏览器插件的工具前缀（例如未选中 ego 插件时屏蔽 `ego_*`），只让当前选中的后端工具对 Bot 可见。
  - 非 Bot 的普通 DSH 会话（例如 DSH Agent）不受 DS Bot 的工具屏蔽影响；仅当 DS Bot 自己挂载 MCP 浏览器服务时，才将它限制在 Bot 会话中使用。
- **提示词指引**：
  - `readonly` 模式下不增加额外系统提示词段落，保持前缀稳定。
  - 启用交互式后端后，注册 `bot-browser` 系统提示词段（order 648），向 Bot 说明当前浏览器后端的用法，并统一要求将网页内容视为不可信数据而非指令。
- **写操作预授权范围**：
  - 内置 Playwright 以及声明 `supportsGrants: true` 的原生 Provider 继续使用「设置 → 浏览器」中的写操作预授权与审批卡。
  - 切换到外部 DSH 插件或 MCP 服务时，原有已保存的预授权记录保留不丢，界面明确说明当前外部插件由其自身或 DSH 审批机制负责权限控制。

## 不做什么

- 不内嵌或复制任何第三方浏览器插件的代码、二进制或图标（如 ego lite 运行时）。
- 不为单个 Bot 单独配置不同的浏览器后端：团队仍统一选一个后端，避免同队 Bot 工具形态割裂。
- 不修改 DSH 本体（仅使用 DSH 公开的 `pluginManager`、`loader`、`tools`、`systemPrompt` 与 `@deepseek-ai/dsh-mcp-client`）。

## 已知限制

- 非原生 Provider 形态的标准 DSH 插件（如直接全局注册 `ego_*` 工具的插件）自带浏览器窗口与隔离模型，无法复用 DS Bot 内置的 Electron `WebContentsView` 每 Bot cookie 分区和 DOM 级写操作拦截。
- 通过 `pluginManager.installBundle` 安装新 DSH 插件时，若当前 DSH profile 未开启 HMR，可能需要重启 DS Bot 才能加载新插件的工具；界面会明确提示。
- 标准 DSH 插件的工具屏蔽依赖声明的 `toolPrefixes`（已知目录预填，自定义 DSH 插件可在表单中填写）。

## 变更

- 2026-11-20：新增浏览器操控插件化架构，支持内置 Playwright、DSH 浏览器插件（含 ego lite 插件）、MCP 浏览器服务与原生 Provider 热切换。
