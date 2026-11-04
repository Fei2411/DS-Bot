# 连接器(Connectors)

日期:2026-11-04。代码:`ds-bot/src/host/connectors/`(`catalog.js` 目录、`oauth.js` 登录、`gateway.js` 本地网关、`mail/` 邮箱、`index.js` 引擎),客户端 `src/client/connectors.js`,端点在 `src/host/channel.js` 的 `connector-*` / `mail-*`。

## 行为

- 设置 → Connectors 一页:已连接列表、目录(搜索 + 分类)、添加菜单(粘贴地址、命令、从 Claude Desktop / Cursor / VS Code 导入)。
- 每个连接器一行:图标(GitHub 用原标,其他用首字母色块)、名称、状态、操作(Connect / Disconnect / Try again / Sign in again)、展开面板(浏览器登录、设备码、密钥/令牌、client 表单)、只读开关、工具数。
- 登录方式:免登录直连;MCP OAuth(WWW-Authenticate → 受保护资源元数据 → AS 元数据,旧服务器退回 MCP 源站;CIMD 仅在固定回环端口 38517 可用时;否则 DCR;都不行给 client 表单);GitHub 设备码(`DS_BOT_GITHUB_OAUTH_CLIENT_ID` 或常量为空时只给令牌粘贴);密钥(header / query);令牌粘贴。
- 令牌全部存 DS Bot 密钥(`GITHUB_TOKEN` 不变;其他 `CONNECTOR_<ID>_TOKEN/REFRESH/CLIENT_SECRET/KEY`),`scope: []` 不进 Bot shell;非密状态在 `state.connectors[id]`。
- 本地网关:mcp-client 只拿到 `http://127.0.0.1:<port>/c/<id>` 加随机 nonce;网关注入真实凭据、转发 `Mcp-Session-Id` 等头、透传 SSE、401 先刷新一次再重试一次(并发 401 共享一次刷新;`invalid_grant` → needs-sign-in);只读开关过滤 `tools/list` 非 readOnlyHint 工具并拒绝写 `tools/call`。
- Bot 默认都能用已连接的连接器;Bot 详情 → Connectors 逐项关(`offFor`,按 `mcp__<id>__*` / `mail_` 前缀在 per-agent mask 里 deny,随 `tools/change` 重挂)。
- Bot 工具:`list_connectors`、`request_connector`(自己会话出卡片,连接或忽略后回话)。
- 邮箱:QQ / 163 / 126 / Gmail / iCloud / 其他(IMAP+SMTP 应用密码;163/126 登录后发 ID;QQ 复用连接);Google 登录走 Gmail API(`DS_BOT_GOOGLE_OAUTH_CLIENT_ID/SECRET` 缺一则按钮隐藏)。`mail_search / mail_read / mail_draft / mail_send / mail_update`;发送必须经发送卡用户确认;草稿不出卡;附件存 Bot 工作文件夹。
- 导入:只读扫描 Claude Desktop / Cursor / VS Code 的 MCP 配置,env 值进密钥、配置里留 `$DSH_SECRET_` 引用;自定义 id 唯一且不占目录 id;能力名校验拒绝连接器 id。

## 不做

- 不加 Google 系 MCP(开发者预览条款)、不存 Google client secret 进仓、不引入厂商 logo、不在 Bot shell 暴露凭据、连接器不改 DSH。

## 已知限制

- OAuth 仅在本进程内生效;无图形验证时部分服务仍要手动贴 client。
- 只读过滤依赖服务的 `readOnlyHint`;没标注的按写处理。
- 邮箱线程按 References/In-Reply-To 关联;Gmail 「移动」按标签实现。
