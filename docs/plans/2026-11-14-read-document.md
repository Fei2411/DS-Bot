# DeepSeek 文档识别：read_document 与凭据网关隔离

- 日期：2026-11-14（自 [DeepSeek 独立能力](2026-11-14-deepseek-services.md) 拆出的文档部分；语音部分随后单独成文）
- 相关：#1577；对应合并到 `dev` 的 PR

## 为什么

DS Bot 的基础路径不依赖官方 API：图片由主模型或视觉模型读。有些用户希望给任意主模型额外接上 DeepSeek 官方的文档识别。取舍是**给能力，不给默认**：官方 API key 只是能力的凭据来源，配置 key 不代表自动上传文件。

## 已定的行为

### 凭据来源与网关隔离

- 文档识别只请求官方 `https://api.deepseek.com`（`/v1/tools/ocr`），按用户自己的 DeepSeek API key 用量计费；从不用账号登录凭据。
- key 在 **Settings → Models → Providers** 的 provider key 控件里设置，状态通过凭据服务的 `describe` 查询、调用时才 `resolve` 取值。`key.ref` 是可公开的凭据引用名（默认 `DEEPSEEK_API_KEY`，或 DeepSeek 模型路由声明的 `apiKeyEnv`）；状态只带 `ref` 与 `configured`，不含 key 值、token 或账号凭据，界面也不渲染它们。
- **网关隔离**：DeepSeek 模型路由若通过 `baseURL` 或 `DEEPSEEK_BASE_URL` 指向非官方 origin，那把 key 属于那个网关，绝不能发往 `api.deepseek.com`。当路由的凭据名恰好也叫 `DEEPSEEK_API_KEY`、DS Bot 无法区分两者时，独立能力整体判为未配置并给出原因；路由使用其它凭据名时，独立能力仍解析自己那份 `DEEPSEEK_API_KEY`。
- 上游错误只回固定的状态短语；响应体可能回显请求或 key，不进入给模型的答案。

### 状态与持久化

- `deepseekServices()` 返回 `{ endpoint, key, ocr, tts, speech, preferences }`。`ocr` 带 `supported`、`enabled`、`configured`、`reason`；`preferences` 已包含 `ocr`、`tts`、`voice`，语音字段见[DeepSeek 语音](2026-11-14-deepseek-services.md)。
- 偏好存在 `roster.prefs.deepseekServices`（host 侧 `state.prefs.deepseekServices`）。默认值 `ocr: false` 由读取时 `defaultServices()` 补齐；`normalizeServices` 只保留合法值，未知字段丢弃。
- `setDeepseekServices` 接受 `ocr`、`tts`、`voice`：缺省保留原值，`null` 删除该字段，非法值返回 `bot/invalid`。写回时先用 `normalizeServices` 清洗；只有清洗后的对象为空才删掉整个 `deepseekServices` 键——再持久化并返回同样的状态。
- 页面按 `configured` / `supported` / `enabled` 与 `reason` 显示真实就绪状态和未就绪原因；`reason` 走 `hostText()`。

### OCR：read_document

- 默认关闭。关闭时 `read_document` 不登记进 `TEAM_TOOLS` 目录（不占上下文、也不诱导误调）；开启后才登记。工具仍拒绝关闭态调用（`bot/unavailable`）作为双保险。给 `path`（工作区文件）或 `attachment_id`（本会话上传的文件或图片）之一，按 `text_recognition` / `rich_layout_recognition` 识别 PDF、Word、PowerPoint 与常见图片。
- **当前会话归属**：`attachment_id` 必须命中发起调用的 Session 自己消息里的 `file` / `image` 块；猜的 id 读不到任何东西。`path` 经工作区文件系统按该 Session 的工作目录解析，落在 DeepSeek Harness 或团队数据目录里的路径被拒绝；`read_document` 也登记在隐私工具表里，私有 Bot 的路径规则同样适用。
- **只读、不丢全文**：工具只读字节、回文本，不改文件。结果按页返回；单页被服务截断会标注「possibly incomplete」。全文不超过 8,000 字直接内联；更长时整份文本写入文件（文件名 `<name>.ocr.txt`），工具结果给出取回提示和开头，模型仍可读到全文。非隐私 Session 走 DSH 的 `spillStore`（无法落盘时整份文本内联返回）；隐私 Bot 的溢出写在自己工作文件夹下 `.ocr/{botId}/{sessionId}/`，路径含字面 Session id，好让 `ownerOfPath` 拦住其它 Bot 的 `glob`/`read`（只读窗口或无法写入隐私副本时截断内联返回，绝不回落到共享 `spillStore` 或触发 DSH 二次公共溢出）。
- 上传提示：OCR 开启时，团队会话里文件块后附加一条指向 `attachment_id` 的提示（幂等、不改动原块）；图片转文本的附注也会指向 `read_document`。纯 DSH 会话没有该工具，不提示。
- 本地 Office 编辑流程不变；`read_document` 也能读 Office 文件，所以界面提示只说「选中的文件会上传给 DeepSeek 做文字识别，本地 Office 编辑不变」，不承诺 Office 文件不上传。

### 停止 / 取消 / 缺 key / 费用

- 关闭只影响后续调用。进行中的请求可取消：调用方 `AbortSignal`、超时 deadline 与模块卸载信号合成为一个信号传给请求，停止 Bot 一轮、超时或模块卸载都会中止它。
- 缺 key：`configured: false` 并带 `reason`，基础路径（本地识图）不变；不自动回落到账号登录、不静默上传。配置 key 只改变 key 状态，不改任何偏好。
- 费用：按官方 API 用量计费，账户需有余额。页面只显示就绪 / 未就绪，不显示余额、费用或充值入口。

## 不做什么

- 不因配置 key 自动启用任何能力、自动上传；不新建第二套凭据、网络客户端。
- 不改本地 Office 编辑流程，不承诺 Office 文件绝不上传。

## 验收

- 未配 key 时基础路径不变，页面显示未就绪原因；配置 key 不启用任何能力。
- 偏好保存：缺省保留、`null` 重置、非法值报错，默认值与持久化正确；状态字段与实际一致。
- OCR 只读取、`attachment_id` 限本会话、隐私路径生效、长文全文可读不丢；Office 提示不承诺不上传；错误短语固定、不回显 key。
- 测试为纯 mock 单元测试，不发起网络、不调用真实服务、不产生费用。

## 参考

- [User settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings.md)：配置表单与 `describe` / `update`。
- [DeepSeek OCR](https://api-docs.deepseek.com/guides/ocr.md)：接口与计费规则。

## 变更

- 2026-11-14：初版（随 DeepSeek services 设计一起起草）。
- 2026-11-20：自该设计拆出为独立文档 PR 的设计说明。
- 2026-11-20：维护者审阅后，本 PR 带上最小 OCR 开关（Settings → DeepSeek services）；关闭态隐藏 `read_document`；隐私 Bot 的长文溢出不再走共享 spill 哈希目录。
- 2026-11-22：同步已加入语音后的状态字段与偏好更新参数（#1881），补齐 Providers 设置路径，对照 dev 代码校正。
