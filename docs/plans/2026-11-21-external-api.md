# 对外统一 API

- 日期：2026-11-21
- 相关：#1204、#1665

## 为什么

DS Bot 的 Bot 团队具备长期记忆、独立工作区、独立浏览器、本地 Agent CLI、多 Bot 群聊协作和后台任务，但过去只能通过桌面界面、手机 App 或 IM 驱动。

- `POST /api/bot` 属于内部前端通道，依赖 DSH 浏览器会话 Cookie，且包含删 Bot、读写 Secrets、电脑操控等全权管理能力，不适合对外开放。
- 外部编码 Agent、本地自动化脚本和监控服务需要一份版本化、最小权限、可追踪完成态的稳定接口，并且要把「受用户授权的指令调用」与「不可信的外部事件投递」按信任等级分开。
- 服务由持 `state.lock` 的 DS Bot 宿主进程直接用 `node:http` 提供，不依赖 DSH 网页端端口或 Cookie，不修改 DSH，桌面应用与插件版行为一致。

## 已定的行为

### 1. 传输、团队锁与本机发现

- **默认关闭**：`api-config.json` 中 `enabled` 默认为 `false`；关闭时不监听任何端口。
- **默认地址与端口**：默认仅绑定 `127.0.0.1:17830`（可在「设置 → API」修改；端口设为 `0` 时由系统分配空闲端口）。绑定非回环地址需用户在设置页二次确认。
- **团队锁联动**：仅持有 `state.lock` 的宿主进程监听；只读窗口不监听，接管锁后自动按配置拉起。
- **本机自动发现**：启动后原子写入 `<home>/api-endpoint.json`（权限 `0600`，含 `baseUrl`、`mcpUrl`、`pid`、`instanceId`、`startedAt`，**绝不写入 Token**），关闭时仅当 `pid` 与 `instanceId` 匹配自身才删除，并向活跃 SSE 连接发送 `event: shutdown`。
- **请求体上限**：JSON 请求默认 `2 MiB`，文件上传 `/v1/uploads` 默认 `32 MiB`，超限返回 `413`。

### 2. 安全边界与鉴权

- **独立可撤销令牌**：格式 `dsb_live_<keyId>_<secret>`（256-bit 随机熵）；明文只在创建时展示一次，`<home>/api-tokens.json`（`0600`）只存加盐哈希，校验采用恒定时间比对。
- **仅接受请求头**：只接受 `Authorization: Bearer <token>`，URL query 携带 `token` / `api_key` / `access_token` 一律返回 `401`。
- **防跨站与 DNS Rebinding**：拒绝带 `Origin` 头的浏览器跨站请求，绑定回环地址时拒绝非回环 `Host` 头（返回 `403`）。
- **能力域 × 目标范围**：
  - Scopes：`read`、`message`、`event:ingest`、`memory:write`、`approval`（需二次确认）、`team:manage`（需二次确认）。
  - 目标范围：`selected`（默认，显式勾选 Bot 与群）或 `all_public`（所有非隐私 Bot 与群）。
  - **隐私 Bot 硬规则**：`all_public` 永远不包含隐私 Bot；未获显式确认授权的隐私 Bot 在所有列表不可见且按 ID 访问返回 `404`；普通 Bot 切为隐私后，未显式勾选它的已有 Token 立即失效。
- **永不暴露的禁区**：不开放读写 Secrets 明文或模型 API Key、删除 Bot、修改隐私开关、修改全局电脑操控开关、通过 API 或手机/远程端创建或修改 Token 自身。
- **宿主文件保护**：无论团队是否存在隐私 Bot，Bot 自身的文件与 Shell 工具均不得读取或修改 `api-tokens.json`、`api-audit.jsonl`、`api-config.json`、`api-runs.json`。
- **与 IM 隔离**：API 发起的消息带独立 `api:<keyId>:<runId>` 来源标记，聊天记录标注 `via API · <Token名>`，绝不向已连接的 IM 渠道跨源外发。
- **限流与审计**：支持按 Token 可选配置最大并发 Run 数与每分钟请求上限，超限返回 `429`（含 `Retry-After`）；`<home>/api-audit.jsonl`（`0600`，保留最近 5,000 条）仅记录时间、Token 元信息、方法、路径、目标、状态码与耗时，不记录 Token 原文、消息正文或模型回复。

### 3. 统一 `Run` 状态机与协议面

- 所有对外发起的执行返回统一 `Run` 资源：`queued` → `running` → `waiting_human`（审批 / 提问 / 交互视图 / 密钥 / 浏览器接管）→ `completed` / `stopped` / `failed`。
- **投递模式**：`chat`（进入 Bot 主对话或群聊；群聊等待整批协作收口后进入 `completed`）、`task`（从前台 fork 后台任务执行）。
- **消费方式**：异步立即返回 `202`、同步 `wait` 等待、或 `stream: true` / `Accept: text/event-stream` 直连 SSE；`GET /v1/runs/{runId}/events` 与 `GET /v1/events/stream` 支持 `Last-Event-ID` 断点续传。
- **幂等与重启恢复**：支持 `Idempotency-Key`（同 key 同内容重放原 `Run`，不同内容返 `409`）；`api-runs.json` 持久化近期索引，宿主重启后未结束的旧 `Run` 收口为 `stopped`（`api/host-restarted`）且仍可查询。
- **多协议同核复用**：
  - REST + SSE：`/v1/health`、`/v1/capabilities`、`/v1/bots*`、`/v1/groups*`、`/v1/runs*`、`/v1/uploads`、`/v1/files/{fileRef}`、`/v1/*/memory*`、`/v1/events/stream`、`/v1/events`（外部不可信事件入月度账本，带 `trust: 'external_untrusted'`、`(source, eventId)` 去重与 `dryRun`）。
  - MCP Streamable HTTP（`/mcp`）：按 Token Scope 动态裁剪工具与只读资源。
  - 薄层本地 CLI（`ds-bot`）：`ds-bot mcp`（stdio 桥）、`ds-bot send`、`ds-bot bots`、`ds-bot groups`、`ds-bot run`、`ds-bot event`、`ds-bot health`（保留 `ds-bot doctor`）。
  - 可单独开关的 OpenAI 兼容层：`/compat/openai/v1/models`、`POST /compat/openai/v1/chat/completions`（流式与非流式，响应头带 `X-DSBot-Run-Id`、`X-DSBot-Status`）。

## 不做什么

- 不修改 DSH，不复用 DSH 浏览器 Cookie 或未公开内部路由。
- 不默认公网开放，不内置公网内网穿透或云中继。
- 不把外部调用方注册进 Bot 花名册作为假 Bot。
- 不开放 Secrets 明文、删除 Bot、解除隐私保护或远程管理 API Token。

## 已知限制

- 局域网/远程调用需由用户自行配合 SSH 隧道、Tailscale 或带 TLS 的反向代理使用。
- 密钥卡与浏览器人工接管无法通过 API 代答，需由用户在电脑或手机端完成。

## 变更

- 2026-11-21：初版设计与实现落地。
