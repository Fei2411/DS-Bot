# 连接器（Connectors）

日期：2026-11-04。代码：`ds-bot/src/host/connectors/`（`catalog.js` 目录、`oauth.js` 登录、`gateway.js` 本地网关、`mail/` 邮箱、`index.js` 引擎），客户端 `src/client/connectors.js`，端点在 `src/host/channel.js` 的 `connector-*` / `mail-*`。

## 目录

`catalog.js` 是一个纯数据数组，一项一个服务：`{ id, name, category, about, remote?: { url }, auth, headers?, whoami? }`。`about` 是自己写的一句话，不抄官网。`auth` 四种：`none`（免登录）、`oauth`（MCP OAuth，`client` 指定已知的公开客户端，`token: true` 同时接受贴令牌）、`key`（密钥放 header 或 query 参数，`keyUrl` 指路去哪里拿）、自定义项（用户加的地址或命令）。GitHub 保留原来的样子：`mcp__github__*` 工具名不变、`GITHUB_TOKEN` 不变、贴令牌流程不变。行内图标一律自绘：GitHub 用原标，其余用按 id 取色的首字母块。

## 登录

OAuth 登录的顺序是定的：目录里写的客户端 → CIMD → DCR → 让用户填 client。CIMD（client metadata document，`https://dsbot.app/oauth/client.json`）只在回环监听拿到固定端口 38517 时用，因为文档里登记的回调是 `http://127.0.0.1:38517/callback`；拿不到就落到 DCR：按本次的回调地址注册，地址变了或 client secret 过期就重新注册。都不行的（Asana、Box、HubSpot、Slack 这类要先在服务商注册的）显示 client 表单。发现元数据走三段：未认证请求拿 `WWW-Authenticate` → 受保护资源元数据（含 well-known 回退）→ AS 元数据；老服务器（如 Atlassian）没有资源文档时退回 MCP 源站查 AS 元数据。授权请求带 PKCE（S256）、`state` 和 `resource`；贴回的地址校验 `state`，贴裸 code 时用本次的 state。GitHub 走设备码（`client_id` + scope 换 `device_code`，轮询时遵守 `slow_down`）；`DS_BOT_GITHUB_OAUTH_CLIENT_ID` 为空时只显示令牌表单，和现在一样。

## 网关

凭据永远不进 mcp-client 的配置，因为 `@deepseek-ai/dsh-mcp-client` 只接受静态 headers，没有 OAuth 也没有刷新。所以每个远程连接器在插件进程里挂的是 `http://127.0.0.1:<port>/c/<id>` 加一次性的随机 nonce；网关在转发时才注入真凭据（Bearer、key header 或 key query、目录里的静态 headers），转发 `Mcp-Session-Id`、`MCP-Protocol-Version`、`Accept` 等头，回传 `Mcp-Session-Id`，SSE 原样透传，下游断开就销毁上游。上游 401 且还没回字节时：刷新一次、重试一次；并发 401 共享一次刷新；刷新轮换时写新 refresh token，写失败留旧的；`invalid_grant` 转「需要重新登录」；只读窗口不刷新、只重读密钥。非 https 的上游一律拒绝（本机回环 http 除外，给本地自定义服务器）。每个远程连接器有「Read-only」开关：打开后网关把 `tools/list` 过滤到 `readOnlyHint` 工具，写 `tools/call` 在本地拒绝（批请求整体拒掉），stdio 连接器不显示这个开关。

## 状态与密钥

密钥在 DS Bot 密钥里，首次写入 `scope: []`（不进任何 Bot shell）：GitHub 仍用 `GITHUB_TOKEN`，其他 `CONNECTOR_<ID>_TOKEN / _REFRESH / _CLIENT_SECRET / _KEY`，邮箱 `MAIL_<地址>_PASSWORD / _TOKEN / _REFRESH`。非密状态在 `state.connectors[id]`（账号、连接时间、client 元信息、token 过期、readOnly、offFor、custom）。令牌变化不触发重挂（指纹不含令牌）。

## 每个 Bot 的开关

默认所有 Bot 都能用已连接的连接器。Bot 详情 → Connectors 逐项关（`offFor`）：按 `mcp__<id>__*` / `mail_` 前缀在 per-agent 工具遮罩里 deny，`tools/change` 时按需重挂，只有 deny 集合变了才动。关掉后该 Bot 看不到工具，也不能再发起新的连接请求。

## Bot 工具和卡片

`list_connectors` 列目录、连接状态和本 Bot 可用性；`request_connector`（id、purpose）在本 Bot 自己的会话里出卡片，按密钥卡同一套规矩：只在私聊、群聊拒绝、只读窗口拒绝、记录 pending 并 `concludeTurn`、连接或取消后回话。`request_secret` 的笔记机制原样复用（`rt.deliver` 带角色标签）。邮箱发送同样复用 `show_view` 的 `form` 卡片：展示可编辑的待发邮件（主题、只读发件人、收件人、抄送、密送、多行正文与附件名和大小），用户可直接修改后点「发送」或「丢弃」。默认每封信都需要确认；左下角规则菜单可设为「允许收件人」「需要批准（默认）」「允许此 Bot 直接发送」或打开「管理规则」（设置 → 连接器 → 邮箱可查看与移除规则）；隐私 Bot 始终需要确认；`mail_draft` 不出卡。

## 邮箱

按地址域名选预设：QQ（含 foxmail）、163、126、Gmail、iCloud、其他（自填主机端口）。163/126 不发 IMAP `ID` 命令会回 Unsafe Login，所以每个账号都带 `ID`（name/version/vendor）。QQ 限频繁登录，一个账号复用一条连接。加账号先登录验证一次（IMAP + SMTP）再保存，验证码错误只报干净的错。工具：`mail_search / mail_read / mail_draft / mail_send / mail_update`，只在有账号时注册。附件保存进 Bot 的工作文件夹，文件名清理防目录穿越；发送的附件限工作文件夹内（realpath 校验），卡片显示名字和大小。Gmail 也支持 Google 登录（Gmail API，`openid + userinfo.email + gmail.modify`），client 由 `DS_BOT_GOOGLE_OAUTH_CLIENT_ID/SECRET` 提供，缺一则按钮隐藏——应用过 Google 审核前只有测试账号能登。不落任何 Google secret 进仓。

## 导入与自定义

`connector-import-scan` 只读扫 Claude Desktop、Cursor、VS Code 的 MCP 配置（不改源文件），返回名称和 env 名；`connector-import` 把 env 值移进 DS Bot 密钥（`CONNECTOR_<ID>_<ENV>`），配置里留 `$DSH_SECRET_` 引用。自定义 id 从名字派生，唯一、≤32 字符、不占目录 id；能力名校验同样拒绝连接器 id。

## 不做

- 不加 Google 的 Gmail/Drive/Calendar MCP（开发者预览条款），不引入任何厂商 logo。
- 不把凭据放进 Bot shell 或 mcp-client 配置；不改 DSH。

## 已知限制

- 浏览器登录只在本机回环；远程浏览器用贴回地址兜底。
- 只读过滤依赖服务的 `readOnlyHint`；没标注的按写处理。
- 邮箱线程按 References/In-Reply-To 关联；Gmail 的「移动」按标签实现。
- Google 登录在应用过审前仅限测试账号。

## 变更

- 2026-11-04 重写：修正网关把连接器路径和 query 丢到源站根的问题；下游断开销毁上游；只读模式拒批请求；CIMD 存储客户端只在固定端口复用；邮箱附件路径收紧并显示大小；卡片回话与密钥卡同一机制。
