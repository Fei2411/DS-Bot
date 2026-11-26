# 搜索来源摘要与官方 Search API 接入

- 日期：2026-11-14（自 [DeepSeek 独立能力](2026-11-14-deepseek-services.md) 拆出的搜索部分）
- 相关：#1577；对应合并到 `dev` 的 PR

## 为什么

DS Bot 的 `auto` 联网搜索按当前会话的模型路由走自己的 key 与无 key 回退。有些用户希望搜索能显式改用官方 Search / Fetch API，并希望结果里保留提供方自己的长摘要（summary），而不是只剩展示用的短 snippet。

## 已定的行为

- `auto` 仍按**发起检索的会话自己的模型路由**走它自己的 key、它自己的 origin，绝不借用别的路由的 key；失败时仍走解析公开结果页的无 key 回退。
- `auto` 的候选里新增一条针对 `api.deepseek.com` 的官方 Search API 声明（先于按协议的标准搜索工具尝试，空结果不计费、即结束 native 探测），每次尝试的结果按路由 / 端点 / 模型记忆，避免为不支持搜索的端点反复付费。
- 声明式搜索 API 只在 `https` base 上规划：候选请求带路由自己的 key，明文 http 不发（内置 `SEARCH_APIS` 与 config `searchApis` 一视同仁）。
- 账号登录路由的 Search 只用账号 token，按搜索端点解析；key 不混用。
- 来源（`WebSearchSource.summary`）：提供方返回的长摘要在 `summary` 字段与展示用 `snippet` 并存；只有 summary 时两个展示位都用它；超长按上限截断。
- 显式跨模型选择 `deepseek-search-api` / `fetch-api` 由 DSH 自己的 Plugins → Web search 开关提供（"Use the new Web Search API"，一个开关同时选 Search 与 Fetch）。

## 不做什么

- 不新增第二套凭据、网络客户端；不改各路由自己的 key 归属。
- 不把 Web search 开关搬进 DS Bot 设置页。

## 验收

- `auto` 保持同源 key 与无 key 回退并含官方 Search API 候选；官方 Search / Fetch 开关在 DSH Plugins 页可选且跨模型。
- 声明式 API 在 http base 上不规划（`planNative` 跳过）；deepseek / kimi 等 host 的 http 路由只剩协议候选。
- 来源 summary 透传、截断、summary-only 展示均有测试；测试为纯 mock，不发起网络。

## 参考

- [Web access](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web.md)：`ctx.web`、`searchProvider` / `fetchProvider`、`listProviders()`。
- [DeepSeek Search](https://api-docs.deepseek.com/guides/search)：接口与计费规则。

## 变更

- 2026-11-14：初版（随 DeepSeek services 设计一起起草）。
- 2026-11-20：自该设计拆出为独立搜索 PR 的设计说明。
