# DeepSeek 语音：ASR 与 TTS

- 日期：2026-11-14（自 [DeepSeek 独立能力](2026-11-14-deepseek-services.md) 拆出的语音部分，与 [DeepSeek 文档识别](2026-11-14-read-document.md) 同源；文档识别的凭据网关隔离与状态持久化见该注）
- 相关：#1577；对应合并到 `dev` 的 PR

## 为什么

DS Bot 的基础路径不依赖官方 API：回复由系统语音朗读，听写由浏览器或本机语音插件完成。有些用户希望给任意主模型额外接上 DeepSeek 官方的语音识别与语音合成。取舍是**给能力，不给默认**：官方 API key 只是能力的凭据来源，配置 key 不代表自动切换语音；每项能力都在设置里由用户明确打开或选择，配置入口复用 DSH 已有的模型设置与插件页，不新增第二套凭据、网络客户端或偏好来源。账号登录不能当成 ASR / TTS 的开关。

## 已定的行为

### 凭据来源与网关隔离

- 语音能力只请求官方 `https://api.deepseek.com`（`/v1/tools/asr`、`/v1/tools/tts`），按用户自己的 DeepSeek API key 用量计费；从不用账号登录凭据。key 的来源、查询与网关隔离规则与 [DeepSeek 文档识别](2026-11-14-read-document.md) 相同：非官方 origin 的路由 key 绝不发往官方端点，同名无法区分时整体判为未配置并给出原因。
- 上游错误只回固定的状态短语；响应体可能回显请求或 key，不进入给模型的答案。

### 状态与持久化

- `deepseekServices()` 返回的 `tts` 带 `supported`、`enabled`、`configured`、`voices: ['stella','tide']` 与 `reason`；`speech` 带 `registered`、`providerId`、`configured`、`ready`、`reason`，**没有** `supported` / `enabled`。
- 偏好存在 `roster.prefs.deepseekServices`。`tts` 默认 `system`、`voice` 默认 `stella`，读取时由 `defaultServices()` 补齐；`normalizeServices` 只保留合法值。`setDeepseekServices({ tts, voice })`：缺省保留原值，`null` 删除该字段，非法值返回 `bot/invalid`；只有清洗后的对象为空才删掉整个 `deepseekServices` 键。
- 页面按 `configured` / `enabled` / `registered` / `ready` 与 `reason` 显示真实就绪状态和未就绪原因；`reason` 走 `hostText()`。

### ASR：服务选择与 readiness

- host 通过 `ctx.inject` 把 `deepseek-asr` 注册进 DSH 的 `speechToText` 服务，语言只声明 `auto`；provider 的 `ready` 阶段随 key 是否配置变化。
- 选择不另存偏好：客户端沿现有 speech Remote 的选择补丁 `configure({ providerId: 'deepseek-asr', language: 'auto' })` 选取，当前选择从 `speech.catalog().selection` 读取。DS Bot 的偏好里没有 ASR 项。
- `speech` 状态：`registered` 表示 provider 已注册，`configured` 表示 key 就绪，`ready` 表示 provider 可用（注册期间、重复 id、缺 `speechToText` 服务都给 `reason`）。Voice Input 插件没挂载时沿用浏览器听写，页面给出正常安装入口；缺 key 时状态与原因可见。账号登录不解锁 ASR。

### TTS：分段与取消

- `tts` 在 `system` / `deepseek` 间二选一，默认 `system`；选 `deepseek` 才有 `voice`（`stella` / `tide`）。voice 面板读 `roster.prefs.deepseekServices` 决定用哪条路径，key 中途失效报服务错误，不悄悄切到别的付费路径。
- 接口上限为 10,000 计费字符（汉字按 2 计）与 64 KiB 请求体；本地用更小的 60 KiB 保护上限留出错余量。一次回复按段落、句子、子句切成远低于这些上限的片段；串行播放器一次只有一个合成请求在飞，上一段播完才请求下一段。
- 停止 / 换一条回复会中止在途请求、静音当前片段、撤销 object URL，并丢弃迟到的应答；被替换的播放结果不再写状态。因此停止后不再请求后续片段；已经发出的合成请求仍可能计费。

### 停止 / 取消 / 缺 key / 费用

- 关闭语音只影响后续调用：TTS 选回 `system`、或把字段传 `null` 重置。进行中的请求本身可取消：调用方 `AbortSignal`、超时 deadline 与模块卸载信号合成为一个信号传给请求，停止 Bot 一轮、超时或模块卸载都会中止它，中止原因交回调用方转成失败文案；TTS 另有上面的分段取消。
- 缺 key：`configured: false` 并带 `reason`，页面显示未就绪原因，基础路径（系统朗读、浏览器 / 本机听写）全部不变；不自动回落到账号登录、不静默切语音。配置 key 只改变 key 状态，不改任何偏好。
- 费用：按官方 API 用量计费，账户需有余额。页面只显示就绪 / 未就绪，不显示余额、费用或充值入口，不写升级广告；余额与账单以 DeepSeek 开放平台为准。
- 错误：保存失败走设置对话框错误行；状态加载失败在页面内 `role="alert"`；听写选择失败沿用同一错误通道。

### 界面

- Settings → DeepSeek services：key 状态与 endpoint、每项能力的开关 / 选择与就绪原因，不渲染任何 key 值或 token。语音页与 [DeepSeek 文档识别](2026-11-14-read-document.md) 的 OCR 分区同页。
- 英文源文案 + `t()`；`zh / zh-TW / ja / ko / es / fr / de` 全部有真实译文（`zh-TW` 由 `convertDict` 派生），`i18n.test.js` 强制覆盖，不允许回落英文或英文占位。
- 复用 `SetSection` / `SetRow` / `Switch` / `Segmented`，只用 `--bt-*` 变量（light / dark 跟随主题），原生键盘可用控件、`:focus-visible` 焦点环、保存中 / 已保存 / 错误状态；分区沿用设置页留白（`display:grid;gap:20px`）。

## 不做什么

- 不因配置 key 自动切语音、不自动回落到账号登录。
- 不新建第二套凭据、网络客户端或 ASR 偏好来源。
- 不把账号登录写成 ASR / TTS 的开关；不显示余额、费用、充值或升级广告。

## 已知限制

- speech Remote 只在 Voice Input 插件挂载时存在；插件关闭时保持原有听写路径，页面只给安装入口。
- 账号登录目前不对 ASR / TTS 有效。
- 汉字按 2 个计费字符计，超限文本需分段；已经发出的合成请求取消后仍可能计费。

## 验收

- 未配 key / 缺服务时基础路径不变（系统朗读、原听写），页面显示未就绪原因；配置 key 不启用任何语音能力。
- `tts` / `voice` 偏好分别保存，缺省保留、`null` 重置、非法值报错，默认值与持久化正确；状态字段与实际一致（`speech` 只有 `registered` / `configured` / `ready`）。
- ASR 通过现有 `speech.configure` 选择，`registered` / `configured` / `ready` 与选择一致，插件缺失时保留原听写。
- TTS 分段串行，停止即取消在途请求，迟到应答不影响当前状态。
- 凭据只走官方 origin；网关指向别处且同名时语音能力判为未配置，不泄漏网关 key；页面不出现 key 值。
- 界面：全语言文案、键盘、保存 / 错误状态、分区留白。
- 测试为纯 mock UI 与单元测试，不发起网络、不调用真实服务、不产生费用。

## 参考

- [DeepSeek ASR](https://api-docs.deepseek.com/guides/asr.md)、[TTS](https://api-docs.deepseek.com/guides/tts.md)：两个独立接口与计费字符规则。
- [DeepSeek 文档识别](2026-11-14-read-document.md)：同源的凭据网关隔离与状态持久化设计。

## 变更

- 2026-11-14：初版。
