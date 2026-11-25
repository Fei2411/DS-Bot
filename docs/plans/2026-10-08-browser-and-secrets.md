# Bot 浏览器、联网搜索与密钥

- 日期：2026-10-08 建立，后续持续更新
- 相关：[浏览器插件](2026-10-21-browser-plugins.md) · [连接器](2026-11-04-connectors.md) · [搜索来源摘要](2026-11-14-search-summaries.md) · [密钥的静态加密](2026-11-12-encrypted-secrets.md)
- 代码：`ds-bot/src/host/browser.js`、`src/client/bot-browsers.js`、`app/src/bot-browser.mjs`、`app/src/bot-views.mjs`、`src/client/read-page.js`、`ds-bot/web-search.js`、`src/host/secrets.js`

## 为什么

Bot 替用户在网上查资料或调用外部服务时，面对同一个核心风险：**网页与外部返回内容不可信，密钥绝不能泄露**。因此：

- 每个 Bot 拥有隔离的浏览器状态；默认只读，交互操作由可选的[浏览器插件](2026-10-21-browser-plugins.md)与明确授权边界控制。
- 密钥值仅由用户经安全卡片输入并只留本机，Bot 只拿到环境变量名，出站请求与工具结果均做脱敏替换。

## 已定的行为

### Bot 浏览器（桌面应用与 DSH Desktop）

- `browser-wait` 空闲长轮询最多 6 秒，客户端 8 秒超时；超时或更新锁的 503 响应后退避重试，停止时取消退避，避免阻塞桌面更新。
- 每个 Bot 拥有独立浏览器面板与多标签页，按 `bot:<id>` 分区隔离 Cookie 与登录态。
- **持久化**：桌面应用使用主进程持有的 `WebContentsView`，将分区保存在应用自身目录，重启保留登录并在删除 Bot 时清理；DSH Desktop 使用内存分区（最多 6 个活跃 webview，超限时回收最久未看的页签），退出即清。
- **只读读取（`read_browser`）**：读取当前页标题、地址、可见 DOM 转成的 Markdown 及用户选区，支持 open Shadow DOM 与同源 iframe（最多 3 层），不读密码 / 信用卡 / 一次性验证码字段；内容严格标记为数据而非指令。
- **交互与接管**：桌面应用配置 `browserPlugin` 后，Bot 通过 Playwright 与用户共享同一组标签页，敏感操作走授权，登录/验证码/付款交由用户接管；DSH Desktop 中 `read_browser` 保持只读。
- **Cookie 与登录导入（仅桌面应用）**：支持从本机多浏览器 Profile（Chrome/Edge/Brave/Arc/Vivaldi/Opera/Chromium/Firefox/Zen，含 Windows Chrome/Edge 144+ 官方 `DevToolsActivePort` CDP 直连与 macOS 钥匙串本地直解）或文件/剪贴板（Cookie-Editor JSON、`cookies.txt`、Playwright `storageState`、Copy as cURL、Cookie Header）按站点导入 Cookie 与受支持的 `localStorage`，值全程不离开主进程。
- **安全边界**：只允许不含内嵌凭据的 HTTP(S) 导航并拒绝访问应用自身 Host 端口；抽屉预览取页面摘要而不截图，避免渲染崩溃。

### 联网搜索（`auto` 提供方）

- `ds-bot/web-search.js` 独立于 Bot 团队代码，普通 DSH 会话也可使用。
- 搜索顺序：优先尝试发起会话自身模型路由的原生搜索与同源官方 Search API（详见[搜索来源摘要](2026-11-14-search-summaries.md)），**绝不借用另一条路由的 Key**；不可用时回退至无 Key 公开结果页解析；均失败则报错并提示模型不要编造链接。

### 密钥

- Bot 调用 `request_secret` 在私聊弹出安全密钥卡，仅用户可输入值，Bot 永不见明文；保存后变量以 `DSH_SECRET_<NAME>` 注入允许使用的 Bot Shell 环境，MCP 能力也可在 env/header/URL 中引用 `$DSH_SECRET_<NAME>`。
- 存储于 `<DSH_HOME>/bot/secrets.json`（权限 600，原子写入；可选口令加密见[密钥的静态加密](2026-11-12-encrypted-secrets.md)）。
- 工具结果落盘前与模型请求发出前，将所有密钥值（含 JSON 转义与 URL 编码形式，长值优先）替换为 `[secret:<NAME>]`；4–7 字符短值仅在非字母数字边界匹配，避免误伤正文。
- 范围支持「只给这个 Bot」与「所有 Bot」，可在 **设置 → 工具 → 密钥** 统一管理；记忆系统自动拒绝形似密钥的内容。
- 外部服务连接器（含 GitHub、邮箱及自定义 MCP）已统一收归[通用连接器](2026-11-04-connectors.md)设计。

## 不做什么

- 不允许 Bot 读取或写入密钥明文，不把密钥写入聊天记录、记忆或 DSH profile。
- 联网搜索不跨路由借用其他服务商的 Key。

## 已知限制

- Bot 浏览器仅桌面应用与 DSH Desktop 可用，DSH Web 无浏览器面板与 `read_browser`。
- 插件版禁用 `web-search-auto` 后需在 `cordis.patch.yml` 指定其他 `searchProvider`（桌面应用启动时自动修复，见[已知问题](../known-issues.zh.md)）。
- 密钥脱敏防意外泄露，但拥有 Shell 权限的 Bot 仍可通过编码/拆分自行输出，只应向可信 Bot 开放重要密钥。

## 变更

- 2026-11-22：移除已被[通用连接器](2026-11-04-connectors.md)取代的早期 GitHub 专用连接器段落，整合多浏览器 Cookie/localStorage 导入与桌面应用主进程视图现状。
