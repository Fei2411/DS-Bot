# DeepSeek 独立能力：OCR / ASR / TTS 与官方联网搜索

- 日期：2026-11-14
- 相关：对应 issue 与合并到 `dev` 的 PR

## 为什么

DS Bot 的基础路径不依赖官方 API：图片由主模型或视觉模型读，回复由系统语音朗读，听写由浏览器或本机语音插件完成，联网搜索由 `auto` 提供方按当前会话的模型路由走自己的 key 与无 key 回退。有些用户希望给任意主模型额外接上 DeepSeek 官方的文档识别、语音识别与语音合成，也希望联网搜索能显式改用官方 Search / Fetch API。

取舍是**给能力，不给默认**：官方 API key 只是能力的凭据来源，配置 key 不代表自动上传文件、自动切换语音或自动改搜索路由。每项能力都在设置里由用户明确打开或选择；配置入口复用 DSH 已有的模型设置与插件页，不新增第二套凭据、网络客户端或偏好来源。账号登录只对当前 DeepSeek 账号路由的 Search / Fetch 有效，不能当成 OCR / TTS / ASR 的开关。

## 已定的行为

### 凭据来源与网关隔离

- 独立能力只请求官方 `https://api.deepseek.com`（`/v1/tools/ocr`、`/v1/tools/asr`、`/v1/tools/tts`），按用户自己的 DeepSeek API key 用量计费；从不用账号登录凭据。
- key 在 **Settings → Models** 的 provider key 控件里设置，状态通过凭据服务的 `describe` 查询、调用时才 `resolve` 取值。`key.ref` 是可公开的凭据引用名（默认 `DEEPSEEK_API_KEY`，或 DeepSeek 模型路由声明的 `apiKeyEnv`）；状态只带 `ref` 与 `configured`，不含 key 值、token 或账号凭据，界面也不渲染它们。
- **网关隔离**：DeepSeek 模型路由若通过 `baseURL` 或 `DEEPSEEK_BASE_URL` 指向非官方 origin，那把 key 属于那个网关，绝不能发往 `api.deepseek.com`。当路由的凭据名恰好也叫 `DEEPSEEK_API_KEY`、DS Bot 无法区分两者时，独立能力整体判为未配置并给出原因；路由使用其它凭据名时，独立能力仍解析自己那份 `DEEPSEEK_API_KEY`。
- 上游错误只回固定的状态短语；响应体可能回显请求或 key，不进入给模型的答案。

### 状态与持久化

- `deepseekServices()` 返回 `{ endpoint, key, ocr, tts, speech, preferences }`。`ocr` / `tts` 带 `supported`、`enabled`、`configured`、`reason`（`tts` 另有 `voices: ['stella','tide']`）；`speech` 带 `registered`、`providerId`、`configured`、`ready`、`reason`，**没有** `supported` / `enabled`；`preferences` 为 `{ ocr, tts, voice }`。
- 偏好存在 `roster.prefs.deepseekServices`（host 侧 `state.prefs.deepseekServices`）。默认值 `ocr: false`、`tts: 'system'`、`voice: 'stella'` 是读取时由 `defaultServices()` 补齐的；`normalizeServices` 只保留合法值，未知字段丢弃。
- `setDeepseekServices({ ocr, tts, voice })` 只接受这三个字段：缺省保留原值，`null` 删除该字段，非法值返回 `bot/invalid`。写回时先用 `normalizeServices` 清洗——只保留 `ocr: true`、`tts: 'system' | 'deepseek'`、`voice` 在 `stella` / `tide` 内的合法值，显式保存的 `system` / `stella` 也会保留下来；只有清洗后的对象为空才删掉整个 `deepseekServices` 键——再持久化并返回同样的状态。
- 页面按 `configured` / `supported` / `enabled` / `registered` / `ready` 与 `reason` 显示真实就绪状态和未就绪原因；`reason` 走 `hostText()`。

### OCR：read_document

- 默认关闭。`read_document` 始终登记在团队工具里，关闭时调用会被拒绝（`bot/unavailable`）；只有开启后才允许发起识别：给 `path`（工作区文件）或 `attachment_id`（本会话上传的文件或图片）之一，按 `text_recognition` / `rich_layout_recognition` 识别 PDF、Word、PowerPoint 与常见图片。
- **当前会话归属**：`attachment_id` 必须命中发起调用的 Session 自己消息里的 `file` / `image` 块；猜的 id 读不到任何东西。`path` 经工作区文件系统按该 Session 的工作目录解析，落在 DeepSeek Harness 或团队数据目录里的路径被拒绝；`read_document` 也登记在隐私工具表里，私有 Bot 的路径规则同样适用。
- **只读、不丢全文**：工具只读字节、回文本，不改文件。结果按页返回；单页被服务截断会标注「possibly incomplete」。全文不超过 8,000 字直接内联；更长时整份文本写入该 Session 的 `spillStore`（DSH 的留存接缝，文件名 `<name>.ocr.txt`），工具结果给出取回提示和开头，模型仍可读到全文；`spillStore` 不可用时整份文本仍内联返回。
- 本地 Office 编辑流程不变；`read_document` 也能读 Office 文件，所以界面提示只说「选中的文件会上传给 DeepSeek 做文字识别，本地 Office 编辑不变」，不承诺 Office 文件不上传。

### ASR：服务选择与 readiness

- host 通过 `ctx.inject` 把 `deepseek-asr` 注册进 DSH 的 `speechToText` 服务，语言只声明 `auto`；provider 的 `ready` 阶段随 key 是否配置变化。
- 选择不另存偏好：客户端沿现有 speech Remote 的选择补丁 `configure({ providerId: 'deepseek-asr', language: 'auto' })` 选取，当前选择从 `speech.catalog().selection` 读取。DS Bot 的偏好里没有 ASR 项。
- `speech` 状态：`registered` 表示 provider 已注册，`configured` 表示 key 就绪，`ready` 表示 provider 可用（注册期间、重复 id、缺 `speechToText` 服务都给 `reason`）。Voice Input 插件没挂载时沿用浏览器听写，页面给出正常安装入口；缺 key 时状态与原因可见。账号登录不解锁 ASR。

### TTS：分段与取消

- `tts` 在 `system` / `deepseek` 间二选一，默认 `system`；选 `deepseek` 才有 `voice`（`stella` / `tide`）。voice 面板读 `roster.prefs.deepseekServices` 决定用哪条路径，key 中途失效报服务错误，不悄悄切到别的付费路径。
- 接口上限为 10,000 计费字符（汉字按 2 计）与 64 KiB 请求体；本地用更小的 60 KiB 保护上限留出错余量。一次回复按段落、句子、子句切成远低于这些上限的片段；串行播放器一次只有一个合成请求在飞，上一段播完才请求下一段。
- 停止 / 换一条回复会中止在途请求、静音当前片段、撤销 object URL，并丢弃迟到的应答；被替换的播放结果不再写状态。因此停止后不再请求后续片段；已经发出的合成请求仍可能计费。

### 联网搜索与导航

- `auto` 提供方仍按**发起检索的会话自己的模型路由**走它自己的 key、它自己的 origin，绝不借用别的路由的 key；失败时仍走解析公开结果页的无 key 回退。现在 `auto` 的候选里多了一条针对 `api.deepseek.com` 的官方 Search API 声明（先于按协议的标准搜索工具尝试，空结果不计费），每次尝试的结果按路由 / 端点 / 模型记忆，避免为不支持搜索的端点反复付费。
- 显式跨模型选择 `deepseek-search-api` / `fetch-api` 由 DSH 自己的 Plugins → Web search 开关提供（"Use the new Web Search API"，一个开关同时选 Search 与 Fetch）。DS Bot 不在自己的设置页里重做这个开关，只从 DeepSeek services 页导航到插件页：先关闭设置对话框再打开插件页，否则对话框会挡住插件页；「设置语音输入」共用同一导航。
- provider key、Models 管理、账号登录与插件安装都复用 DSH 现有入口（`openModels()` / `openPlugins()`），不新建网络客户端。

### 停止 / 取消 / 缺 key / 费用

- 关闭某项能力只影响后续调用：OCR 关开关、TTS 选回 `system`、或把字段传 `null` 重置。进行中的请求本身可取消：调用方 `AbortSignal`、超时 deadline 与模块卸载信号合成为一个信号传给请求，停止 Bot 一轮、超时或模块卸载都会中止它，中止原因交回调用方转成失败文案；TTS 另有上面的分段取消。不另造一套取消协议不等于不可取消。
- 缺 key：`configured: false` 并带 `reason`，页面显示未就绪原因，基础路径（本地识图、系统朗读、浏览器 / 本机听写、`auto` 搜索）全部不变；不自动回落到账号登录、不静默上传、不自动切语音。配置 key 只改变 key 状态，不改任何偏好。
- 费用：按官方 API 用量计费，账户需有余额。页面只显示就绪 / 未就绪，不显示余额、费用或充值入口，不写升级广告；余额与账单以 DeepSeek 开放平台为准。
- 错误：保存失败走设置对话框错误行；状态加载失败在页面内 `role="alert"`；听写选择失败沿用同一错误通道。

### 界面

- Settings → DeepSeek services：key 状态与 endpoint、四个分区、每项能力的开关 / 选择与就绪原因，不渲染任何 key 值或 token。
- 英文源文案 + `t()`；`zh / zh-TW / ja / ko / es / fr / de` 全部有真实译文（`zh-TW` 由 `convertDict` 派生），`i18n.test.js` 强制覆盖，不允许回落英文或英文占位。
- 复用 `SetSection` / `SetRow` / `Switch` / `Segmented`，只用 `--bt-*` 变量（light / dark 跟随主题），原生键盘可用控件、`:focus-visible` 焦点环、保存中 / 已保存 / 错误状态；分区沿用设置页留白（`display:grid;gap:20px`）。

## 不做什么

- 不因配置 key 自动启用任何能力、自动上传、自动切语音或自动改搜索路由。
- 不新建第二套凭据、网络客户端或 ASR 偏好来源；不把 Web search 开关搬进 DS Bot 设置页。
- 不把账号登录写成 OCR / TTS / ASR 的开关；不显示余额、费用、充值或升级广告。
- 不改本地 Office 编辑流程，不承诺 Office 文件绝不上传。

## 已知限制

- speech Remote 只在 Voice Input 插件挂载时存在；插件关闭时保持原有听写路径，页面只给安装入口。
- Web search 开关在 DSH 的 Plugins 页内，DS Bot 只能导航过去。
- 账号登录目前只对当前 DeepSeek 账号路由的 Search / Fetch 有效；不覆盖 OCR / TTS / ASR。
- 单页识别可能被服务截断并标注「possibly incomplete」；长文依赖 `spillStore` 留存，该服务不可用时整份文本仍内联返回。

## 验收

- 未配 key / 缺服务时基础路径不变，页面显示未就绪原因；配置 key 不启用任何能力。
- 三项偏好分别保存，缺省保留、`null` 重置、非法值报错，默认值与持久化正确；状态字段与实际一致（`speech` 只有 `registered` / `configured` / `ready`）。
- OCR 只读取、`attachment_id` 限本会话、隐私路径生效、长文全文可读不丢；Office 提示不承诺不上传。
- ASR 通过现有 `speech.configure` 选择，`registered` / `configured` / `ready` 与选择一致，插件缺失时保留原听写。
- TTS 分段串行，停止即取消在途请求，迟到应答不影响当前状态。
- `auto` 保持同源 key 与无 key 回退并含官方 Search API 候选；官方 Search / Fetch 开关在 DSH Plugins 页可选且跨模型。
- 凭据只走官方 origin；网关指向别处且同名时独立能力判为未配置，不泄漏网关 key；页面不出现 key 值。
- 界面：全语言文案、键盘、保存 / 错误状态、导航先关对话框、分区留白。
- 测试为纯 mock UI 与单元测试，不发起网络、不调用真实服务、不产生费用。

## 参考

- [Web access](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web.md)：`ctx.web`、`searchProvider` / `fetchProvider`、`listProviders()`。
- [User settings](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/settings.md)：配置表单与 `describe` / `update`。
- [DeepSeek OCR](https://api-docs.deepseek.com/guides/ocr.md)、[ASR](https://api-docs.deepseek.com/guides/asr.md)、[TTS](https://api-docs.deepseek.com/guides/tts.md)：三个独立接口与计费字符规则。

## 变更

- 2026-11-14：初版。
