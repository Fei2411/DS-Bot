# Bot 视图（widget views）

- 日期：2026-10-20
- 相关：#386、#468（第三版：图表、输入和公式、沙箱 html）

## 为什么

Bot 的回答现在只有 Markdown 文本。有些回答天生是结构化的：几张卡片、一张表、一组选项、一个进度。纯文本表达这些东西又长又难读，模型也常写错格式。业界（ChatGPT Apps、MCP Apps、OpenUI）的做法是让模型直接在聊天里给出可交互的界面。

2026-10-20 的第一版方案「模型写 HTML、iframe 渲染」经外部评审否决，主要理由：

- 任意 HTML 没有压缩序列化策略：上下文管家和交接包要么塞爆要么丢光，下一段会话的 Bot 不知道用户看过什么。
- iframe 在聊天虚拟滚动中卸载即丢失内部状态；模型生成的脚本可以自动提交，造成回合劫持死循环。
- 为 widget 内容开 GET 路由、配 CSP 需要依赖 DSH 未文档化的服务能力，风险由插件承担。

取舍（第二版）：

- 不执行模型生成的代码。模型只从一份固定组件目录里挑组件、填数据，渲染用 ds-bot 自己的 React 组件。安全性来自「没有代码执行」，不靠沙箱。
- 蓝图是有上限的 JSON，可以被 `parts.js` 压成摘要进交接包；历史回放用同一份蓝图重渲染。
- 复用提问卡的整条回路：state 登记、ToolCell 内联画卡、隐藏回合浮到输入框上方、回答作为用户消息回注。视图卡是提问卡的泛化，但存储、回复格式各自独立，不与提问卡共用一个 map。

第三版（2026-10-23，#468）在第二版上加三样东西，第二版的规则不变：

- 图表和本地交互：目录加图表、输入控件和公式。用户拖滑块、改数字时，页面按 Bot 写好的公式当场重算，不调模型、不花 token。
- 目录画不了的内容（自定义图形、小游戏、流程图）可以写成 `html` 组件，放进沙箱 iframe。常用的展示仍走蓝图：省 token、跟主题、有校验，出错时模型能拿到带路径的错误重写。
- 外框：只展示的视图直接放在回答里，不带框；有输入或回答控件的视图带浅框。去掉「视图」标签，标题改成可选的小标题。

## 已定的行为

### 工具

- `show_view`：在自己的聊天里给用户看一个视图。参数：`title`（可选，小标题）、`view`（JSON 蓝图，见下）、`await_reply`（可选）。
- 组合规则：蓝图里含回答组件（options/confirm/form/submit）时必须 `await_reply: true`；输入控件（slider/number/choice/toggle）不算回答组件；纯展示蓝图配 `await_reply: true` 拒绝（回合会空等一张不能提交的卡）。缺省按蓝图中是否含交互组件推断；`exec.concludeTurn()` 按**生效后**的 `await_reply` 调用，在校验通过、state 落盘之后。
- 群聊会话拒绝使用（和 `ask_user` 同一句提示）。
- 校验失败原子拒绝：不登记 state、不结束回合，工具结果给出可修复的错误（带路径和允许值，如 `view.children[2].type: unknown component "chart"; allowed: stack, text, …`；超限时带实测值和上限）。
- 上限：序列化后 8 KiB（UTF-8 字节，含 title）、组件树深 8 层、组件节点 64 个；表格行 ≤ 50、列 ≤ 8；form 字段 ≤ 6；options 选项 ≤ 8。嵌套的 JSON 结构不算深度，只算组件树。

### 组件目录

蓝图是一个组件节点：`{ type: string, …props, children?: node[] }`。

排版：

- `stack`：纵向排列子节点。`row`：横向排列，窄时换行。两者 `children` 必填（1–16 个）。最外层的容器可以带 `let: { 名字: "公式" }`。

展示：

- `text`：`{ text, tone?: muted }`，一段 Markdown。不渲染原始 HTML；链接只 http(s)，新窗口打开；不允许模型控制 style、事件、className 等 DOM 属性。
- `metric`：`{ label, value, tone?: good|warn|bad, caption? }`。
- `table`：`{ columns: [{ key, label }], rows: [[…]] }`，只读。整列是数字时右对齐。
- `chart`：`{ kind?: bar|hbar|line|area|donut, categories: [标签], series: [{ name?, values: [数字] }], unit?, caption? }`。每个系列的值和类别一样多；环形图只有一个系列。用 SVG 画在拿到的宽度上，颜色只用主题变量（第一个系列用强调色）。悬停或方向键显示一个类别的数值、其余变淡；多系列有图例，点一下隐藏或显示一个系列；右上角菜单：以表格查看、复制数据（CSV）、下载图片（PNG）。
- `progress`：`{ label?, percent }` 或 `{ label?, value, max }`，可带 `valueLabel`（右侧文字，如「剩余 ¥10」）和 `tone`。
- `callout`：`{ text, tone?: info|good|warn|bad }`，一段提示。
- `sources`：`{ items: [{ label, url }] }`，来源小标签，只收 http(s)，新窗口打开。
- `html`：`{ html, summary, height? }`，见下面「沙箱 html」。

输入（值只留在页面里，不发给 Bot，不结束回合）：

- `slider`：`{ id, label, min, max, step?, value, unit? }`。
- `number`：`{ id, label, value, min?, max?, step?, unit? }`。
- `choice`：`{ id, label, options: [{ label, value }], value? }`。四个以内的短选项并排成分段按钮，其余竖排。
- `toggle`：`{ id, label, value? }`。

回答（结束回合，答案是用户的下一条消息）：

- `options`：`{ id, options: [{ label, description? }], multi? }`。单选按下即提交；多选切换勾选、出 Submit 按钮（和提问卡一致）。
- `confirm`：`{ id, confirmLabel?, cancelLabel? }`，按下即提交。
- `form`：`{ id, fields: [{ id, label, placeholder? }], submitLabel? }`，短文本输入框 + 提交按钮。说明里禁止用 form 收集密钥——密钥走 `request_secret`。
- `submit`：`{ id, label? }`，把输入控件当前的值发给 Bot（「发给 Bot」）。

标识约束：交互组件和输入的 `id` 在整棵树里唯一；输入的 `id` 必须是公式能引用的名字（字母、数字、下划线，不以数字开头）；form 内字段 `id` 在该 form 内唯一；options 的选项以 label 为身份（和提问卡一致）；choice 的选项值唯一。

### 公式

- 写法：`{ "=": "表达式" }`。能写公式的属性：metric 的 value、caption、tone；text 的 text；progress 的 percent、value、max、valueLabel、tone；callout 的 text、tone；表格单元格；图表的每个值。
- 表达式只读输入的 `id` 和 `let` 里的名字：数字、'文字'、`+ - * / %`、比较、`&& || !`、`a ? b : c`，以及 `min max abs floor ceil sqrt pow round clamp fixed format percent`。没有属性访问、赋值、循环，碰不到页面。解析和计算在 `deep-view` 包的 `src/core/formula.js`，主机和界面共用。
- 主机按 Bot 设的初始值把每个公式算一遍：解析失败、用了不存在的名字、`let` 互相引用、结果类型不对（如 tone 不在允许值里），都原样拒绝并给出路径。
- 页面上每次输入变化都重算；某个公式在用户的值下算不出来时，这一处显示占位，不影响别处。

### 沙箱 html

- 只在目录画不了时用；`summary` 必填，交接和摘要只用它。
- 放进 `sandbox="allow-scripts"` 的 iframe（`srcdoc`），不给 same-origin：碰不到应用、存储和接口。文档开头先写禁止联网的 CSP（`default-src 'none'`，只放行内联脚本和样式、`data:` 图片和字体），再放模型的内容。
- 注入主题变量（`--bt-ink`、`--bt-line`、`--bt-accent` 等）和配色方案；切换明暗时发消息更新。框里的脚本只能报告自己的高度，iframe 跟着变高。
- iframe 里没有提交通道，不能回答 Bot，也不能结束回合；它的状态不保存。
- iframe 跳到别的页面时（第二次 load），换成一句提示，不再显示。

### 外框

- 只展示的视图不带框，直接接在回答里，宽度跟正文一样；有输入或回答控件的视图带浅框；浮到输入框上方的待答视图保持凸起样式。
- 没有「视图」标签；`title` 有值时显示成一行小标题。

一张视图可含多个交互组件；**一次提交结算整张卡**：只带触发组件的值 `values`（options：`{ selected: string[] }`；confirm：`{ confirmed: boolean }`；form：`{ fields: { [fieldId]: string } }`；submit：`{}`），其他组件未提交的输入丢弃，已答渲染里它们的控件不再可用。视图有输入控件时，任何一次提交都带上 `inputs: { [inputId]: 值 }`：没发来的按初始值补齐，服务端逐个校验（范围、选项值、布尔）。已答视图按发出时的值显示，控件只读。空提交：options 至少一项、confirm 必有一个按钮值、form 允许全空字段。文本值上限 2,000 字。

### 状态与生命周期

- 待答视图存 `state.views`，按当前聊天会话各存一条（`{ id, callId?, title, view, askedAt }`）。新待答视图覆盖同会话旧视图；用户普通消息或回答到达时撤销；换段时迁移并去掉 `callId`；Bot 删除时随各段清理——与 `state.questions` 的消费者规则一一对应。
- 两个 store 的关系：同会话的待答提问卡和待答视图可以**共存**，谁也不覆盖谁；普通消息到达时两者都撤销。纯展示 `show_view` 不影响任何待答记录。
- 纯展示视图不进 `state.views`：从已接受的工具调用参数渲染，可见性不依赖待答记录。
- 隐藏回合：待答视图浮到 dock（进 `CARDS`，与提问卡同一 `useShownCards` 记账；dock 保留 QuestionDock 的历史加载抑制）；隐藏回合里的纯展示视图不持久展示，只留在回合记录里。

### 渲染与提交

- ToolCell 把 `show_view` 画成视图卡（`WidgetCell`），样式跟随 `--bt-*` 变量；明暗主题、窄布局、键盘操作、表格溢出、禁用/提交中/出错态都要过。
- 提交走 `POST /api/bot` 的新 case `view-reply`：解析会话→核对待答 id→对**服务端持有的蓝图**校验提交值→先认领再入队→`agent.followup` + `flush`→失败恢复记录→保存。拒绝过期和重复提交。
- 回注的用户消息：`readReply`/`replyText` 的形状按判别字段扩展——`kind: 'answer_to_pending_view'` 时读 `views`/`answers`（`views: [{ id, title, view(校验过的蓝图) }]`，`answers: [{ id, action, values }]`），原 `questions`/`answers` 分支不变，两分支各自校验、互不混读。`parts.js` 的 history 提取、归档，以及回复节点的实时渲染（ AnsweredCell 对应的视图版 `AnsweredView` ）都按判别字段分流。
- 已答视图画在**回复节点**上，数据来自回复消息本身，只读样式。原待答卡随即收起消失（同 `bt-q-gone`）。
- 界面文案走 `t()`；模型写的标题和标签按用户语言生成，不当翻译键。

### 压缩与交接

- `viewCardText`（和 `cardText` 同构）：`[View card] 标题`（没有标题时只有 `[View card]`）+ 一行组件清单（带关键数值/选项，如 `metric: 进度=70%; options: A/B/C`，每个组件至多 40 字、至多 8 个）+ 已答时的答案摘要。已答摘要从回复事件取，不从 state 取。
- 纯展示视图同样压成一行摘要。公式按初始值算出结果再写进摘要；输入写成 `slider: 标签=值`；图表写类别和第一个系列的值；`html` 写它的 `summary`。
- 答案摘要里，输入写成 `标签=值`（choice 写选项标签）。

## 不做什么

- 模型生成的 HTML/JS 只在 `html` 组件的沙箱 iframe 里跑；其余组件不执行模型代码。不嵌入外部页面。
- 不自建 MCP Apps host；DSH 官方支持 SEP-1865 后再评估把 connectors 的 MCP UI 接进来。
- 不引入 OpenUI Lang。它（Apache-2.0、渐进解析渲染、比 JSON 省约 2/3 token）的真实优势是蓝图随 token 流式出现；本设计等工具参数完整并校验通过才渲染，接近上限的大蓝图会有可感的首屏延迟。8 个组件的小卡片暂不值这个解析器；实测接近上限的调用后重新评估。
- 视图不进群聊。群里没有画视图的地方（群页面读的是 DS Bot 自己的群记录，每条只有文字），交互视图还会和「谁来回答、按顺序发言」的群聊规则冲突，要单独设计。
- 用户拖过的值不保存：卸载后回到 Bot 设的初始值；Bot 默认不知道，用户按 `submit` 才发过去。

## 已知限制

- 蓝图保得住，**填到一半的表单保不住**：虚拟滚动或换段卸载后，未提交的输入、拖过的值、html 框里的状态都回到初始值。
- 目录外的展示要写成 `html`：比蓝图费 token，样式靠模型照着主题变量写，脚本出错时模型收不到错误。
- `html` 框禁止联网，但挡不住它把自己导航到外部地址（数据可以跟着网址出去）；导航发生后框被换成提示，请求本身已经发出。
- 蓝图质量依赖模型按 schema 输出的能力；校验拒绝消耗一次工具调用。
- 已答视图在会话压缩后只剩一行摘要，Bot 看不到当时的完整蓝图。
- 8 KiB 上限是按 DSH 会话日志里 `ask_user_question` 参数的现有形状定的起点，未在真实持久化日志里验证过 DSH/供应商的硬上限；冒烟测试要实测接近上限和超限的调用。

## 代码位置

蓝图、公式、回复格式和卡片组件的实现收在独立的 `deep-view` 包里，ds-bot 依赖它，不再自带一份。ds-bot 也不再全局注册 `show_view`：每个 Bot 自己的会话和群会话都在自己的 Agent 作用域里注册同名工具（作用域注册压过全局注册），所以另一个插件的全局 `show_view`（比如 Deep View）只管 ds-bot 不管的会话；群里调用照样被 ds-bot 的注册拦下，回「只能在自己的会话里画视图」。

## 变更

- 2026-10-20：初稿（声明式目录，第二版）。评审：Antigravity 否决第一版 iframe 方案；Codex 一审（ship with changes）：state.views 独立、已答视图在回复节点、交互组合规则、未提交输入的限制、摘要带关键值。
- 2026-10-20：Codex 二审（ship with changes）：concludeTurn 绑定生效后的 await_reply；回复格式改判别字段双分支；标识唯一性和 values 形状定死；首次提交结算整张卡；views 与 questions 共存规则写明。
- 2026-10-20：Codex 三审签字（ship，无需再改）。
- 2026-10-23：第三版（#468）：图表、输入控件和公式、row/callout/sources、沙箱 html；只展示的视图去掉外框和「视图」标签，标题可选。
- 2026-10-27：核心代码移入独立的 deep-view 包；show_view 改为按会话在 Agent 作用域注册，在 Bot 会话和群会话里压过别的插件全局注册的同名工具。
