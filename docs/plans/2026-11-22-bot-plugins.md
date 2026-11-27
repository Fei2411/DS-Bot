# Bot 插件体系、插件面板与插件收录仓库

- 日期：2026-11-22
- 相关：v0.4.0；延续并收编 [浏览器插件](2026-10-21-browser-plugins.md) 与 [桌面应用](2026-10-16-desktop-app.md)「插件」一节
- 代码：`ds-bot/src/host/plugins/`、`ds-bot/src/host/browser-plugins.js`、`ds-bot/src/client/plugins-page.js`

## 为什么

DS Bot 的桌面应用和插件版都基于 DSH 引擎，但 DSH 原生插件管理面向通用单 Agent 会话，存在三个结构性缺口：

1. **没有 Bot 团队语义**：无法把同一类互斥能力（例如多个浏览器操控后端）抽象成全团队热切换槽位，也无法对普通插件按 Bot 单独开关或向插件安全透传每 Bot 隔离目录、桌面端浏览器面板、审批与交接卡上下文。
2. **桌面应用没有插件管理入口**：桌面应用接管了侧栏且不加载 DSH 的插件导航，用户无法在桌面应用里浏览、安装、开关、更新或卸载插件。
3. **浏览器后端写死在启动配置**：原有的 `browserPlugin` 只能在 DSH profile 里静态配置 `refs` / `script` / `task`，无法在界面热切换，也无法干净替换为 Ego Lite 等 DSH 浏览器插件或 Playwright / Chrome DevTools MCP 服务。

因此，v0.4.0 在 DSH 引擎 `pluginManager` 之上建立 DS Bot 自己的插件抽象、统一插件面板和独立的插件收录仓库，并以「多个可替换的浏览器插件」作为首批落地能力。

## 已定的行为

### 1. 插件来源与统一模型

DS Bot 插件运行时（`ds-bot/src/host/plugins/`）统一纳管三类插件：

- **`builtin`（内置插件）**：随 DS Bot 内置提供，遵循与第三方一致的生命周期契约（如 `builtin:readonly`、`builtin:refs`、`builtin:script`、`builtin:task`）。
- **`dsh`（DSH / Bot 原生包）**：通过 DSH 引擎的 `ctx.pluginManager` 安装、启停、更新与卸载（支持 npm 包名、GitHub 仓库、本地绝对路径）。该包既可以是标准 DSH 插件，也可以向 `ctx.dsBotPlugins` / `ctx.dsBotBrowser` 注册原生扩展以获得热插拔生命周期与 Bot 上下文。
- **`mcp`（MCP 封装插件）**：通过 `@deepseek-ai/dsh-mcp-client` 动态挂载 stdio 或 Streamable HTTP 服务，支持 `$DSH_SECRET_<NAME>` 密钥引用展开，卸载或切换时自动释放连接与子进程。

### 2. 互斥槽位（Slot）与按 Bot 开关

- **互斥槽位**：声明 `slot`（首批为 `browser`）的插件归属该槽位，全团队同一时间只激活一个插件，支持在界面热切换无需重启。
  - 切换时卸载旧插件挂载的资源与工具，屏蔽同槽位中未激活的外部 DSH 插件工具，再挂载新插件。
  - 挂载同步或异步失败时自动回滚已注册的工具与清理钩子，不留半套工具，并安全回退或报告错误。
  - 启动时若已保存的原生插件尚未加载完成而先回退到默认态（如 `builtin:readonly`），待该插件随后注册到 `ctx.dsBotPlugins` / `ctx.dsBotBrowser` 时自动重新协调并激活。
- **普通插件（无 `slot`）**：可并行启用，支持在 `state.plugins.offFor[pluginId]` 中按 Bot 单独关闭（新装插件默认对所有 Bot 开启），宿主通过 `agent.ctx.tools.restrict` 按 Bot 屏蔽对应工具前缀。
- **核心工具保护**：任何插件声明的 `toolPrefixes` 在屏蔽时绝不允许遮蔽 DS Bot 自身的团队核心工具。

### 3. 首批插件：可替换浏览器槽位（`slot: "browser"`）

- 向后兼容旧的 DSH profile `config.browserPlugin`（`refs` / `script` / `task`）和 `config.browserPluginApi`：在 `state.plugins.slots.browser` 未显式设置时作为初始默认项；未配置时默认是 `builtin:readonly`。
- 首批内置可替换插件：
  - `builtin:readonly`：仅保留桌面只读 `read_browser`。
  - `builtin:refs`：Playwright 按元素编号快照/点击/输入/截图，支持每 Bot 独立 profile、桌面端 CDP 面板、写操作预授权与审批、删除二次确认、付款拦截与 `browser_handoff` 交接卡。
  - `builtin:script`：Playwright 单步 JS 脚本执行，复用同等隔离与安全能力。
  - `builtin:task`：Playwright 子任务委派，使用当前 Bot 的模型完成多步任务。
- 首批目录收录外部可替换插件：
  - `dsh:dsh-ego-browser`（兼容 `@dshworks/dsh-ego-browser`）：Ego Lite DSH 浏览器插件。
  - `mcp:playwright-mcp`：`@playwright/mcp`（Playwright MCP 服务）。
  - `mcp:chrome-devtools-mcp`：`chrome-devtools-mcp`（Chrome DevTools MCP 服务）。
- 激活任意非 `readonly` 外部浏览器插件时，自动在 Bot 会话中隐藏 `read_browser` 并注入 `bot-browser` 系统提示词段落，要求将网页内容视为不可信数据。

### 4. 插件收录仓库与目录源（Registry Schema v1）

- DS Bot 默认连接官方维护的独立插件收录仓库索引（`registry.json`，支持通过环境变量 `DS_BOT_PLUGIN_REGISTRY` 覆盖，并允许用户在面板里增删自定义 HTTPS 目录源）。
- 本地磁盘缓存到 `<rt.home>/plugin-catalog-cache.json`（1 小时 TTL，支持手动刷新），并内嵌一份离线默认快照，断网时仍可查看首批精选插件。
- 目录源拉取强制仅允许 `https:` 且拒绝本地环回与私网地址（防 SSRF），单次响应上限 1 MB、超时 10 秒。

### 5. Bot 插件面板

- 桌面应用与插件版共用同一套自建「插件」面板，入口位于设置总控台独立分组「插件」及侧栏底部「插件」快捷按钮；「设置 → 工具 → 浏览器」页提供当前浏览器插件状态与直跳入口。
- 面板包含「已安装 / 发现 / 添加」三块视图，支持搜索、分类与槽位筛选、一键安装/切换/启停/更新/卸载、按 Bot 开关以及自定义 DSH 包 / MCP 服务 / 目录源管理。
- 插件安装、卸载、切换与自定义 MCP/目录源管理属于高权限宿主变更，不在 `BROWSER_ALLOWED` 远程浏览器白名单中（远控端默认 fail-closed 拒绝），只读窗口禁止变更。

### 6. 自定义 MCP 安全约束

- 拒绝在 Streamable HTTP URL 中内嵌用户名/密码或敏感 query 参数，拒绝明文敏感 header（如 `Authorization`、`Cookie`、`X-Api-Key` 等），要求改用 `$DSH_SECRET_<NAME>` 密钥引用。
- 返回给前端的自定义 MCP 视图隐去环境变量与请求头的值，仅暴露已配置的键名。

### 7. 插件执行安全：执行层级、同意指纹、终止列表与子进程环境（已在仓库落地）

插件是能执行代码的第三方分发物。以下四道防线按「已强制实施」与「仅奠定基础、尚未强制」严格区分表述，夸大任何一条都是安全问题本身。

#### 执行层级（`tiers.js`）——声明校验已强制，沙箱执行是预留

- 四个层级：`data`（纯数据）/ `declarative`（声明式入口）/ `sandboxed-ui` / `trusted-worker`（完全信任），能力上限分别为无 / `entry` / `entry`+`process` / 全部。未声明的旧清单一律按 `trusted-worker`（与引入层级前的实际信任完全一致），要进入受限层级必须显式声明。
- 已强制：声明与激活方式矛盾的组合直接作废（fail-closed）——`data`/`declarative` 插件骑在 stdio MCP 或 DSH 包上（这两类本质上必然执行进程代码）会被丢弃为 `invalid-manifest`；原生进程内挂载拒绝一切受限层级。
- 尚未强制：受限层级的真实沙箱执行机制不存在，声明 `data`/`declarative`/`sandboxed-ui` 的插件今天不会获得任何额外隔离——能跑起来的插件一律以宿主信任运行。层级词表先行的唯一理由是让清单可以诚实地携带意图。

#### 同意指纹（`consent.js` + `content-hash.js`）

- 安装或首次激活即为对插件「当时状态」的同意：服务端计算指纹（声明能力、执行层级、可执行入口与参数及 env/header 键名——永远不含值、确切包版本、可执行树的 SHA-256 内容哈希、槽位位置）并记录基线。
- 之后任何输入漂移（版本升级、`link:` 开发树字节变动、清单改动、槽位变更）使旧同意失效：插件停止，状态为 `consent-required`，界面给出「变化了什么 + 按现状批准」的显式入口（`plugins-consent` 在服务端重新计算指纹，客户端无法放宽批准范围）。用户点击「更新」本身就是对新版本的同意——指纹在更新落盘后按已安装字节记录，避免一次多余批准。
- 内容哈希绑定实际执行的已安装包目录（pnpm `file:` 副本也在那里），`node_modules` 与 `.git` 内容不参与（依赖树既不是稳定也不是有意义的同意信号，目录本身的存在仍计入结构）；目录能解析却无法哈希（逃逸符号链接、不可读、超上限）一律 fail-closed 为 `unverifiable`，无法验证的字节永不记录同意、永不激活。
- 诚实边界：stdio MCP 的包规格若是浮动的（`@latest`、范围、裸名），运行时内容是注册表在启动瞬间给的任何东西，批准不可能固定其字节——界面明确标注「批准不固定具体代码」，也只有确切钉死版本的规格参与按版本匹配的终止规则；无法解析安装目录时（profile 上下文之外）退化为「版本+清单」绑定，写在这里而不是藏起来。

#### 终止列表熔断器（`kill-list.js`）

- 注册表文档可内嵌终止列表：`id` 可带 semver 范围或内容哈希（`*` 匹配包括未知/浮动版本在内的一切版本；无约束条目终止该 id 的全部安装）。
- 求值完全离线（本地缓存优先）、按来源独立防回滚（同来源较旧文档永不覆盖较新的、远未来 `issuedAt` 拒绝）、且在运行中的插件上实时生效——新终止落地时活挂载被卸载且拒绝再激活；安装/启用/更新路径在触碰 pluginManager 之前先过终止检查（profile 变更即可能开始执行代码）。
- 信任根：终止列表不签名，权威性来自注册表传输（HTTPS + 注册表宿主控制权）。被攻陷的注册表能新增终止，但永远不能悄悄撤销或弱化其他来源已发出的终止（各来源条目按 id+范围+哈希精确合并去重）。
- DSH profile 级对齐：字节被终止或同意失效的包会被持久禁用（`setBundleEnabled(false)`）——下次启动根本不会执行它；用户批准后按已批准的确切字节重新启用。强制执行失败的禁用会每次 reconcile 重试并按会话每包告警一次，绝不悄悄丢。
- 诚实边界：当前进程内已经激活的包被终止/失效后，插件层会卸载挂载，但 DSH 侧激活在同一进程内不可回溯地撤销——持久禁用保证的是「不再激活、下次启动不执行」，不是「当前进程内追溯清除」。安装期的构建脚本由独立的 `approvedBuilds` 批准约束，不由插件同意隐含。

#### MCP 子进程环境（`env.js`）

- 已强制的真实边界：`@deepseek-ai/dsh-mcp-client` 实际契约是 `{...scrubbedParentEnv(), ...config.env}`——DSH 的名称形态 scrub 丢弃密钥形状变量与 `DSH_*`，但 `SSH_AUTH_SOCK`、`KUBECONFIG`、`DOCKER_HOST`、`LD_PRELOAD` 这类「不是密钥形状的能力变量」会被继承。DS Bot 在显式层做三件事：运行器层环境过严格白名单（密钥与能力变量永远过不去，`ELECTRON_RUN_AS_NODE` 明确保留——桌面捆绑运行器没它起不来）；按名称把父环境中的能力/密钥变量覆盖为空串（因 `config.env` 最后合并，子进程收到空值）；清单声明的 env 原样居顶——用户显式声明可以有意识地重新启用某个变量（明文密钥形状的值仍被清单校验拒绝）。
- 诚实边界：空串不是不存在——对把空值当作「已设置但为空」的诡异消费者这不是擦除，且名单之外的罕见变量仍随 scrub 通过。从 spawn 环境真正删除继承变量需要 `@deepseek-ai/dsh-mcp-client` 上游提供 authoritative-env 选项；在那之前任何「完全环境隔离」的说法都是假的。

## 不做什么

- 不修改或 patch DSH 本体，全部通过 DSH 公开的 `pluginManager`、`tools`、`systemPrompt` 与 `@deepseek-ai/dsh-mcp-client` 实现。
- 不在 DS Bot 仓库内嵌第三方浏览器插件代码或二进制（如 Ego Lite 运行时）。
- 不为单个 Bot 分别指定不同的浏览器后端：浏览器槽位仍为全团队单选，保持同队工具契约一致。

## 已知限制

- 受限执行层级（`data`/`declarative`/`sandboxed-ui`）目前只是声明校验，不构成运行时隔离；真实沙箱执行落地前，一切能运行的插件都以宿主信任运行。
- HMR 下热更新替换包内容时，DSH 在移除旧版本与安装新版本之间执行的是其自身生命周期；DS Bot 以「更新前预先禁用选择」保证新版本与失败回滚都按禁用安装，但同一进程内已经运行的旧代码不可追溯撤销。
- stdio MCP 浮动包规格（`@latest`/范围）的运行内容永远跟随注册表，同意与按版本终止都无法预先绑定；子进程环境的空值化是缓解而非擦除，彻底删除继承变量需要上游 authoritative-env。
- 非原生 Provider 形态的标准 DSH 浏览器插件自带浏览器实例与隔离方式，无法复用 DS Bot 桌面端 Electron `WebContentsView` 每 Bot cookie 分区与 DOM 级写操作预授权。
- 在未开启 HMR 的 DSH profile 中安装、更新或卸载 DSH 插件包时，工具加载或彻底释放可能需要重启 DS Bot；界面会明确提示重启状态，且待重启卸载的插件工具会在重启前保持屏蔽。
- 普通 DSH 插件的按 Bot 开关依赖工具前缀匹配（目录条目预填，自定义条目可手动补充），对界面扩展与后台服务不按 Bot 拆分。

## 变更

- 2026-11-22：定案并落地 v0.4.0 Bot 插件体系、插件面板、可替换浏览器槽位与独立插件收录仓库规范。
- 2026-12-05：落地插件执行安全四道防线（执行层级声明校验、同意指纹与内容哈希、终止列表熔断器、MCP 子进程环境分层），安全边界按「已强制/预留」如实写进第 7 节与 SECURITY_MODEL.md。


补充修正（2026-12-05 round-2 review）：

1. **内容哈希接受符号链接入口**：pnpm 隔离布局中 `<profile>/node_modules/<pkg>` 是指向 `.pnpm/` 的符号链接，`link:` 安装同样如此；哈希校验解析后的真实目录，解析树内部的逃逸符号链接仍 fail-closed。
2. **同意门覆盖全部启用路径**：`plugins-slot-set` 和 `plugins-toggle` 在 `setBundleEnabled(true)` 之前现在评估完整激活门——漂移或不可验证的包拒绝启用，不会在 `publishAndReload` 里先执行未经批准的字节；唯一恢复路径是显式批准。
3. **槽位状态不串染**：槽位的 killed/consent-required/error 状态只属于其 `desiredId`/`activeId` 指向的目标，同槽其他插件条目的状态和控件不再被兄弟插件的状态覆盖。
4. **修复可见性与细节**：安装后启用失败在视图中如实显示为错误而非静默"已装未启用"；npm 接受 `pkg@v1.2.3` 形式的 exact 版本，pin 解析同步支持并归一化参与 semver/kill 匹配；不可验证错误消息附带恢复指引（移除后重新安装）。
