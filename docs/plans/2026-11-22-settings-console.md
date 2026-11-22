# 设置总控台

- 日期：2026-11-22
- 相关：PR #2006、#2028、#2027
- 代码：`ds-bot/src/client/settings.js`、`settings-overview.js`、`settings-palette.js`、`settings-shell.js`、`settings-tour.js`、`settings-preferences.js`

## 为什么

随着模型提供方、本地智能体、DeepSeek 服务、连接器、IM、手机、MCP 访问、电脑操控、浏览器、功能包和密钥陆续落地，设置页已经扩展到 20 个子页面。早期平铺在左侧的长导航列表既难定位，也看不出当前团队有哪些缺口（如某个 Bot 缺 API Key、连接状态如何）。

## 已定的行为

### 1. 分组导航与页内滚动锚点

左侧导航栏（宽 212px）收敛为 9 个顶层域，多子页域在一页内纵向排列并配顶部锚点快捷跳转，原有 `openSettings(page, id)` 路由全部兼容并自动滚动到对应区块：

| 导航域 | 包含子区块 |
|---|---|
| **Overview**（默认落脚页） | 待处理横幅（缺 Key 可原地填写）、团队卡片（最多 6 格 + 新建）、近 7 天用量与各功能区状态卡 |
| **General** | 语言、输入习惯、新 Bot 默认模型、位置（总工作区 / 数据位置）、高级项（记忆额度、后台命令超时、经典模式切换） |
| **Appearance** | 实时预览卡片、主题与强调色、气泡/平铺布局与宽度滑块、思考过程开关、界面动效与头像动画三档 |
| **Models** | Providers · Local agents · Bot models · DeepSeek services |
| **Team** | Bots · Group chats · Scheduled tasks |
| **Connect** | Connectors · IM · Phone · MCP access |
| **Tools** | Computer use · Browser · Capabilities · Secrets |
| **Usage** | 全团队、按 Bot 与按模型的 Token 统计 |
| **About DS Bot** | 版本与更新信息 · Feedback（问题报告与诊断导出） |

DSH 或其他插件提供的独立设置页（去除已被 DS Bot 合并的 `general` 与 `models`）作为「引擎 / 扩展」入口挂在导航下方。

### 2. 命令式全局搜索（`⌘K` / `Ctrl+K`）

- 设置顶栏与快捷键 `⌘K`（macOS）/ `Ctrl+K`（Windows/Linux）打开 `SettingsPalette`。
- 一次查询同时命中：全部设置项（含中英文关键词与展开高级项）、Bot（直达该 Bot 设置）、群聊（直达该群设置）、可用模型（含「批量切换 Bot 到此模型」快捷动作）以及 DSH 引擎设置页。
- 关闭搜索面板后焦点自动归还触发元素；列表使用 `aria-activedescendant` 支持纯键盘上下选择与回车跳转。

### 3. 窄屏与崩溃隔离

- 窄屏（手机宽或小窗）自动切换为单列概览列表 + 子页顶部返回栏，不请求无须展示的用量小卡片。
- 全部浮层与设置对话框由可复位的 `OverlayBoundary` 包裹：捕获异常后渲染空并调用 `onDismiss` 关闭出错浮层、弹出 toast 提示，在下次打开或目标切换时复位；设置页内子视图另由 `PageBoundary` 兜底展示报错。客户端异常均经 `noteClientError()` 记入浏览器内存错误列表供 Feedback 页导出，不拖垮主聊天窗口。

## 不做什么

- 不把设置页拆成独立浏览器标签页或外部窗口。
- 不替 DSH 修改其未接管的第三方插件设置页内部布局。

## 已知限制

- 宿主未提供 `providers` 接口时（如极简插件宿主），Overview 只能按 roster 标记的 `needsKey` 提示并跳转到 Bot 模型页，不能原地编辑 Key。

## 变更

- 2026-11-22：整理 #2006（设置分组底座）、#2028（Overview 总控台、⌘K 搜索、一页滚动锚点与外观实时预览）与 #2027（浮层崩溃隔离）的现行设计。
