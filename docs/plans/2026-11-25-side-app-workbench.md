# Side App 工作台 V1 实施计划

2026-11-25 · Stage 1 定案。本文是 Stage 2 前后端共同执行的唯一计划。

## 1. 目标与范围

把聊天右侧改成一个稳定的 Side App 挂载区。Browser、Bot 详情、Side Chat 和现有后台任务视图先通过适配器迁入，保持原入口、状态和布局行为。Canvas 与 Reader 通过同一个内部注册表接入。

| V1 交付 | 用户能做什么 |
|---|---|
| 工作台 | 在右侧标签条切换既有 App 和多个文件标签，拖宽、收起，关闭后可从聊天卡片重开。 |
| Canvas | 打开真实 `.html` / `.htm`，运行沙箱内的本地交互原型，加载获准的同目录相对资源，切换 Render / Source / Changes，随文件变化刷新。 |
| Reader | 打开真实 `.md` / `.markdown` / `.mdx`，用目录定位，在 Read / Source / Changes 间切换，选一段放入聊天待修改，审阅前后版本。MDX 按普通 Markdown 渲染，JSX、表达式和模块声明均不执行。 |
| 工具与卡片 | Bot 在自己的 DS Bot 界面聊天中调用 `open_canvas` / `open_reader`，聊天留下可重开的卡片，改文件继续用同一会话的 `write` / `edit`。 |

覆盖插件 Web 与 DS Bot 桌面同款界面。群聊、IM、手机 API 的新工具入口，`.txt`、公开链接、外部依赖联网预览、富文本编辑、第三方 Side App SDK、历史任意版本回溯均留到后续。现有 `show_view` 及其 8 KiB 规则原样保留。[Bot 视图](2026-10-20-widget-views.md) · [DS Bot 愿景](../vision.md)

## 2. 现状证据与技术假设

| 已核实 | 影响 |
|---|---|
| `BotPanel`、`PanelStrip` 和布局分别枚举既有视图，浏览器另有 guest 显隐、拖拽保护和落位时序。 | 先用注册表收拢枚举，隔离浏览器的既有行为，随后接文件 App。[browser-pane.js:168](../../ds-bot/src/client/browser-pane.js#L168) · [frame-layout.js:11](../../ds-bot/src/client/frame-layout.js#L11) |
| DS Bot 面板与 DSH 右栏已经互斥。 | 保留现有让位和收起规则。既有整轮改动审阅仍可走 DSH 右栏。[index.js:1278](../../ds-bot/src/client/index.js#L1278) · [DSH 右侧 Sidebar](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/sidebar-right.md) |
| 工具展示有运行态、完成态和历史回放入口，`USER_UI_TOOLS` 参与纯工具回合可见性。 | 新工具走团队工具与 ToolCell，历史可重开与自动开窗分离。分段、压缩后的交付字段须真测。[cells.js:1358](../../ds-bot/src/client/cells.js#L1358) · [turns.js:1122](../../ds-bot/src/host/turns.js#L1122) · [constants.js:99](../../ds-bot/src/host/constants.js#L99) |
| `/api/bot` 用 `connection.fetch.register`；`markdown-image` 已有会话归属、路径边界、数据根拒绝和内容版本先例。 | 复用可用的底层路径与权限原语，Side App 单独规定窄授权，无需改旧图片端点行为。[channel.js:1168](../../ds-bot/src/host/channel.js#L1168) · [mobile.js:643](../../ds-bot/src/host/mobile.js#L643) |
| 仓库测试包和桌面应用都钉 `0.2.2-rc.5`，当前群会话声明的运行宿主为 `0.2.2-rc.1`。官网文档是 current。 | Stage 2 在隔离 bench 上记录加载的实际版本、路由与历史行为。`rc.5` 作为分支验证基线，若要对 `rc.1` 承诺兼容须另有隔离结果。现有 3101 实例保留原状。[测试依赖:6](../../ds-bot/dev/harness/package.json#L6) · [桌面依赖:28](../../app/package.json#L28) |

`docs/canvas` 的 `145abff8` 目前只有群内线索，尚无可引用的内容。`MarkdownText` 的链接、图片、原始 HTML 安全行为与桌面原语一致性，Canvas iframe 的资源隔离，卡片字段在历史回放中的保留，均列为 Stage 2 起步验证。[dsh-primitives.js](../../ds-bot/src/client/dsh-primitives.js) · [桌面原语](../../app/ui/src/primitives.js)

## 3. 容器与交互

DS Bot 自己的面板是 V1 的唯一挂载面。它已经管理浏览器 guest、侧聊、宽度、让位和退场。保留与 DSH 右栏的现有互斥规则，不注册 `sidebarRightTabs`。内建注册项只声明 `id`、顺序、适用主体、宽度、标签提供方和视图。外壳管理活动标签、焦点、拖拽与显隐，App 自己持有模式及文件读取状态。已有 `ui.side`、`ui.task` 和浏览器标签目标沿用。先完成等价迁移，再接新 App。

新文件标签键为 `(subjectId, app, workspaceTag, displayPath)`。重复打开聚焦旧标签，同名时显示最短可区分的目录。每个主体最多 8 个文件标签，满时提示关闭一项，避免静默丢失未审阅 Diff。浏览器等既有标签保留自己的策略。持久化标签元数据、上次活动标签、模式和宽度，整页重载后先收起面板。旧 browser 宽度作为迁移默认值。正文、Diff、预览地址和权限凭据仅存内存。1280px 及窄宽状态都沿用现有空间判断，优先保留聊天的 420px，面板折叠后可通过原入口恢复。详情保留 320px，Browser 保留 360px 最小 / 520px 默认，Canvas 初始 560px，Reader 初始 480px。空间不足时隐藏次要工具入口，面板主体优先可用。[UI 标准](../design/ui-standard.md)

```text
             Browser · Bot · Side Chat · draft.html × · report.md ×
Canvas       Refresh   [ Render | Source | Changes ]   Live
             ┌─ 交互预览 / 只读源码 / 统一 Diff ───────────────────┐
Reader       Contents  [ Read   | Source | Changes ]
             ┌─ 正文与目录 ──────────────────────────────────────┐
             │ 选中文本 → Ask Bot → Add to chat                     │
```

- **Canvas** 使用只读源码和独立 iframe。首次加载和更新失败均给出状态与重试入口。仅在激活的 Render 标签挂载 iframe。切标签或关面板释放实例。加载完成后更新显示，异步响应以标签身份和 `revision` 判定新旧。文件重载会重置预览内部表单及滚动位置，可用 `Live` 暂停，手动刷新仍可用。
- **Reader** 正文限宽、清晰的标题层次与独立滚动。复用现有大纲提取及跳转，宽面板常驻目录，窄面板用 `Contents`。刷新按标题和节内偏移恢复，锚点消失时回退到合理的滚动位置。Markdown 走已验证的安全渲染，原始 HTML 与需自动请求的外部资源关闭，同目录图片经会话授权读取。安全能力不足时先给可读纯文本，再补安全 Markdown 接线作为验收要求。[reading.js:23](../../ds-bot/src/client/reading.js#L23)
- **选段** 在正文选区提供 `Ask Bot`，附工作区相对路径、节名、原文与用户的修改要求，原文上限 2,000 字。主操作 `Add to chat` 向当前同一会话的 composer 追加内容并保留原输入。次操作 `Send` 由用户明确点击，走现有普通聊天发送入口。仅原文在同版本源码中唯一匹配时提供可选行号，刷新致选区失效时请用户重选。换会话后取消未投递请求。路径或片段不再匹配时，Bot 应先核对，再决定修改或追问。
- **Diff** 优先采用宿主通过文档化 `ctx.fs` 写入结果取得的当轮 before 基底。宿主只保留有完整前后文本、可匹配会话/文件和当前 after 版本的记录，同轮连续写入用首个 before 和最后一个 after。记录仅存有容量和时限的内存缓存，查询复用文件鉴权。写结果取得方式需在 `rc.5` 隔离宿主验证。以 shell、外部编辑、基底失效或不存在为例，降级为标签首个完整文本或最近一次 `Mark reviewed` 的客户端快照。已审阅版本和更早的宿主基底不会重新显示为未阅变化。两种来源在界面注明审阅范围，版本不匹配时不用旧宿主基底。快照重建后明确提示无更早基线。超过计算预算时展示 `Diff too large`，保留源码入口。缺失文件时保留同一标签上一份已读快照，恢复后继续比较。既有整轮改动审阅可补充回看。 [现有整轮审阅](2026-11-10-group-changes.md)
- 所有用户源文案用英语并同步现有语言。使用原主题令牌、弹簧和控件，用形状或标记辅助区分新增与删除。覆盖键盘切 Tab、Esc 和焦点恢复，检查减少动态效果以及浅色、深色。iframe 带可访问标题。[UI 标准](../design/ui-standard.md)

## 4. 前后端契约与数据流

| 接口 | 输入和输出 | 约束 |
|---|---|---|
| `open_canvas` / `open_reader` | `{path, tab?}`，`tab` 为 `preview`（默认）、`source` 或 `diff`。成功返回版本化展示描述 `{v:1, app, sessionId, workspaceTag, displayPath, tab}`。 | `preview` 显示为 Render 或 Read。直达 `diff` 时查有无匹配基底，无基底则显示提示并建立客户端快照。失败卡提供原因，成功卡可重开。工具返回体仅含描述和一行结果。 |
| `/api/bot` → `side-app-open` | 使用卡片/标签描述，宿主重新授权后返回 `{file, revision, size, previewAvailable}`，`file` 由上述描述的文件身份字段组成。 | `sessionId` 来自聊天记录归属，请求体字段与已鉴权会话、当前可访问工作区共同校验。`workspaceTag` 是宿主签发或推导的工作区身份标记，不能当阅读凭据。 |
| `/api/bot` → `side-app-read` | `{file, knownRevision?}` → `{kind:'unchanged',revision}` 或 `{kind:'text',revision,text}`。 | `revision` 以实际 UTF-8 字节内容标识，版本与文本来自同一快照。文本读取上限 4 MiB。超过 4 MiB 且不超过 8 MiB 的 Canvas HTML 可 Render，Source / Changes 显示文本超限。前端可进一步截断 Source 显示并标明，截断结果不得作为 Diff 基底。 |
| `/api/bot` → `side-app-diff` | `{file, revision}` → `{kind:'host', before, baseRevision, revision}` 或 `{kind:'unavailable'}`。 | 仅在宿主基底的 after 匹配请求文本版本时返回基底。权限错误仍按统一错误传输。客户端据此选择宿主或标签快照。 |
| `/api/bot` → `side-app-preview` | `{file, knownPreviewRevision?}` → `{frameUrl, expiresAt, previewRevision}`、`unchanged` 或 `preview-unavailable`。 | 仅 Canvas，入口 HTML 上限 8 MiB。`previewRevision` 随入口或获准资源变化，独立于文本 `revision`。`frameUrl` 仅存于当前实例内存，票据临近失效时仍在当前 Render 标签才续期。 |

- **打开**。工具沿用团队工具注册和可见性分类。当前窗口前台会话的实时成功完成事件只消费一次，面板关着就打开，已开则切到目标 App 和文件标签。保持当前会话与聊天焦点。后台会话和历史加载仅留下卡片入口。采用宿主完成事件或带去重 ID 的前台增量，不能靠卡片组件挂载判断。工具登记保持短期内存态。用户点击历史卡时从已保留的成功工具记录恢复描述并校验原会话授权。若原有历史机制裁剪该描述，沿用 DS Bot 持久展示机制保存最小字段，先验证跨分段再接 UI。旧条目缺少必要身份时给出不可重开提示。
- **刷新**。前端通过一个文件数据适配层向已经鉴权的 `/api/bot` 条件读取。V1 仅前台可见的活动文件 2 秒一次，关闭、换标签、隐藏、暂停时停止，重新激活立即检查。请求串行并带退避，处理乱序响应和删除后重建。连续写入合并渲染。版本以真实字节判定，避免同长或保留时间戳的改动漏掉。Canvas Render 按 `previewRevision` 跟踪入口及实际获准资源的变化，Source / Changes 和 Reader 按文本 `revision` 更新。验收目标是本地 bench 在写入稳定后 5 秒内更新，且隐藏页无定时文件读取。V1 省去 host 全局监听表、`fs.watch` 和 DSH Remote 流依赖。若量测证明成本超限，在不漏掉文件变化的条件下调整探测策略。[现有增量通道](../../ds-bot/src/host/channel.js#L167)
- **错误**。统一 `invalid`、`not-found`、`forbidden`、`workspace-changed`、`too-large`、`preview-unavailable`，继续用现有 `bot/*` 错误传输。UI 给出相应的修复动作。日志不输出文件内容、绝对根、票据或凭据。

## 5. 文件、权限与 Canvas 隔离

- 入口基准为调用时自身聊天的有效 Session 工作目录。建议 V1 仅支持这个工作根，接受工作区相对路径或能规范化为同根相对路径的绝对路径。历史 part 的当前可授权根须与 `workspaceTag` 一致。换工作目录后打开同名文件须发新工具调用，旧卡不能静默重绑。保留隐私 Bot、会话与数据根的已有拒绝语义。额外工作文件夹或旧 part 根若需扩大支持，应先补独立授权证据。[额外工作文件夹](2026-11-10-extra-folders.md) · [隐私 Bot](2026-10-27-private-bots.md)
- 校验统一在宿主完成并覆盖每次 open/read/preview/资源请求。用规范工作根与真实路径做边界检查，拒绝目录、越界、会话/团队数据目录、链接或 junction 逃逸以及异常路径。Windows 盘符、UNC、设备名、编码和大小写要有边界用例。实现须对替换路径期间的检查与实际读取一致性做防御性核验。UI 不发送任意文件写入请求，修改遵循 Bot 当前沙箱及审批规则。
- HTML 和脚本视为不受信内容。iframe 只启用所需脚本能力，禁止 `allow-same-origin`、弹窗、顶层导航、表单提交与下载。预览文件服务只接受 `GET` / `HEAD`，禁止列目录。高熵、短时效、可撤销的 capability 绑定入口 HTML 和资源根，资源根限定为入口 HTML 的同目录子树。每次资源读取均以 realpath 检查，拒绝路径穿越、点文件、`.git`、密钥类文件及 symlink 或 junction 逃逸。只提供获准的 CSS、JS、普通图片等资源类型。预览不发送 referrer、不缓存，响应使用正确 MIME。CSP 必须有 `connect-src 'none'`，并限制子资源来源。预览承载还须验证宿主 API 隔离、外联和预览内导航约束。
- Stage 2 先覆盖路径穿越、敏感文件、过期票据和外联的安全单测，再在 Web 和桌面真实浏览器分别验证相对 CSS、JS、图片可用，宿主凭据/API、未授权文件与外部网络均不可达。真实浏览器覆盖预览内导航，宿主层验证票据不能跨文件或资源根使用，过期即拒绝。涉及路由只走文档化插件接口。未通过相应安全门槛的环境关闭可交互 Render，保留 Source 与 Reader，并将实测差距交 Sherry。降级状态不计入完整 V1 验收。[DSH Filesystem 官方契约](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/filesystem.md) · [插件开发边界](../plugin-development.md)

## 6. 阶段、依赖与验收证据

| 阶段 / 负责人 | 交付与依赖 | 通过依据 |
|---|---|---|
| 1 · Hannah 汇总，Sherry 验收 | Noah、Leia 的输入归入本文，分别确认 §3、§4–5。 | 唯一主计划具备接口、依赖与验收；Sherry 确认可交互预览的最小文件授权。 |
| 2a · Leia + Noah，Mago 并行准备验证 | 隔离运行环境与安全探针。Leia 验证路由、工作根、历史卡片与资源承载；Noah 验证现有渲染原语、原右栏行为与桌面样式；Mago 准备真实文件 fixtures 和回归基线。 | 记录实际 DSH 版本、worktree/branch、原面板截图与安全探针结果。Canvas 真实 Render 依赖 §5 探针过关。 |
| 2b · Noah 容器；Leia 宿主 | 并行。Noah 先适配详情 / Browser / Side Chat / 任务，按 §4 用契约 fixture 开发。Leia 实现工具、工作根解析、刷新与授权端点。 | 容器回归全绿。失败和成功形状在假机和宿主一致。文件根和历史记录至少各有一条真实通过与拒绝证据。 |
| 2c · Noah Canvas / Reader；Leia 真实接线 | 依赖 2b；Canvas 另依赖安全探针。共用文件源、只读 Source 和统一 Diff。 | mock Bot 生成真实 HTML/Markdown 并调用 `open_*`，两套 UI 在真实文件上可从聊天打开、编辑后刷新，并保留可重开的历史卡。 |
| 3 · Mago 验收、Hiro 独立审查、Ema 体验 | 依赖 2c。Mago 在隔离 bench 跑检查和回归，Hiro 复核路径、票据、历史权限和既有 App 迁移，Ema 操作端到端任务。 | 以提交或工作树版本、命令输出/退出码、浏览器断言、Web/桌面截图或录屏、独立审查结论作为证据。Sherry 判定完成。 |

| 场景 | 要观察到的结果 |
|---|---|
| 既有行为 | Browser 在四种切换/收起状态下 guest 正确显隐，拖宽/导入/独立浏览器标签照旧，详情、侧聊、任务不丢本地状态；DSH 右栏与工作台互斥；已有 `show_view` 与 8 KiB 门禁通过。 |
| 卡片与作用域 | 前台实时成功在面板关闭时打开，在面板已开时切到目标 App，整个过程保留会话和聊天焦点。后台完成和历史加载仅展示卡片。重载、旧 part 回看时点击卡片能重开同一文件且不重复标签。跨会话、改工作目录、删文件、超限与错误格式都给正确结果。桌面与 Web 分别取证。 |
| Canvas | 相对 CSS、JS、图片实际加载，预览内按钮可交互。保存 HTML 和仅修改允许资产分别触发刷新。暂停与手动刷新正常，拖动不重载。测试覆盖 4 MiB 文本与 8 MiB HTML 两个边界，§5 安全单测和浏览器证据齐全。 |
| Reader | 三种支持的后缀均可阅读，MDX 内容按普通 Markdown 显示，`.txt` 被拒绝。大纲可跳转，窄宽可操作，刷新保留阅读位置。`Add to chat` 保留输入区既有内容且不发送，显式 `Send` 走现有聊天。分别取证 Bot 写入的宿主基底、版本不匹配与外部编辑的客户端快照降级、`Mark reviewed` 清空已审阅变化。多处命中时不附行号。 |
| 刷新与生命周期 | 同大小写入、连续保存、删除/恢复、换标签和后台恢复均更新正确；隐藏标签在测试中不发轮询。关闭面板释放 iframe、请求和票据引用。 |
| 界面 | Web 与桌面至少留存 Canvas Render/Source、Reader Read/Changes、窄宽目录/工具条、键盘与减少动态效果的证据。英文、现有语言和主题通过检查。 |

候选改点：前端 `side-apps` 注册表、文件数据适配层、Canvas / Reader 视图与卡片，接上 `BotPanel` / `PanelStrip`、布局、动作、composer、样式/i18n。宿主在团队工具模块、`channel` 与独立授权/文件模块接线。旧图片读取、IM、手机和 DSH 核心不纳入改造。改 `ds-bot/src/client/` 后生成 `client.js` 并检查相应桌面样式入口。

可执行检查以 `ds-bot/` 为运行目录。按仓库流程备依赖，依次运行 `npm run build`、`node scripts/build-client.mjs --check`、`npm test`、`npm run lint`。本任务含 host 改动，使用独立 mock bench。若改到 `src/host/browser/`，补 `npm run test:browser`。新 iframe 权限与刷新用实际 Chromium 覆盖，DOM 单测不足以替代。

```sh
# 先核验两端口空闲、隔离 home 在本 worktree、显式 DSH_HARNESS 对应版本。
# bench 内含 pnpm，按团队规定使用完全访问或该命令的一次性授权。
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 sh dev/bench.sh side-app 3096 8796 start
node dev/smoke.mjs side-app 3096
sh dev/bench.sh side-app 3096 8796 stop
sh dev/bench.sh side-app 3096 8796 status
```

命令端口为示例，取可用值。bench 的 POSIX 进程工具链须可用，失败后也要停止自己启动的进程。单测、smoke 以及本功能真实交互分别取证。只操作 `T:\side-app-workbench` 的隔离数据和服务。原仓、并行工作区、真实 `~/.dsh`、3101 均为禁区。Sherry 已在完全访问会话实测 `git status` 正常，分支为 `feat/side-app-workbench`，未改 Windows 权限。受限实施会话若仍遇到 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(T:\side-app-workbench)`，在 Stage 2 开工时处理并验证 `npm run build`、`npm test`，记录输出。Windows 权限若需修复，范围限此 worktree 并单独审批。Stage 1 目前只有设计交付，构建、单测与运行验收归 Stage 2–3。[AGENTS.md](../../AGENTS.md) · [bench 脚本](../../ds-bot/dev/bench.sh) · [命令定义](../../ds-bot/package.json#L52)

## 7. 风险处置与拍板

| 风险 | 处置或降级 |
|---|---|
| 预览内容能扩大本地文件可读范围或同宿主通信 | 发布前必须过 §5 实机门槛。禁用结果不合格环境的 Render，并记录用户受影响范围。 |
| DSH 版本、历史保留或桌面原语与预期不同 | 以隔离实测更新契约，先使用现有明确支持的 API。若没有文档化能力，停在该边界并交 Sherry。 |
| 容器迁移影响 Browser 或抢占右栏 | 首步只改适配和注册，原动画、guest 生命周期与互斥逻辑保留。回归失败先修等价迁移，两个新 App 继续通过 fixture 独立开发。 |
| Reader 基线丢失或定位有歧义 | 重开显示新基线提示。发送前由用户确认含引用的文本，模糊位置由 Bot 核对。 |

Sherry 已有条件批准 Canvas 文件服务。Stage 2 按本文实施，Canvas Render 以 §5 的安全证据为放行条件。遇到文档化能力或安全边界无法满足的情况，按上表停在对应功能并提交实测差距。

## 变更

- 2026-11-25 归并 Noah 的前端设计与 Leia 的宿主侦察，定为一份 Stage 1 实施计划。
