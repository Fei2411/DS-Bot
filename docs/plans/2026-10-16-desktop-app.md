# 桌面应用

- 日期：2026-10-16 建立，后续持续更新
- 相关：PR #275；[愿景](../vision.zh.md) · [DSH 让步总账](2026-10-13-dsh-concessions.md) · [启动窗口](2026-10-26-start-window.md) · [桌面端安装与上手流程](2026-10-26-windows-onboarding.md)

## 为什么

插件版跑在用户自己的 DSH 中，DSH 版本升级、全局配置与界面结构都不受 DS Bot 控制。独立桌面应用打包锁定版本的 DSH，拥有独立 profile 与数据目录，开箱即进入 Bot 团队，同时不触碰用户原有的 `~/.dsh`。

取舍：
- **引擎复用 DSH，不另写 Agent 运行时**：回合、工具、模型、会话、MCP 与技能与插件版共享同一份 `ds-bot`。
- **界面当前复用 DSH 网页前端**：桌面窗口加载引擎提供的 DSH 网页前端 + `ds-bot` 插件；仓库中的自绘前端原型（`app/ui/`）未安装、未打包，后续版本演进后再切换。

## 已定的行为

### 结构与 Profile

| 部分 | 职责 |
|---|---|
| 壳（Electron 主进程） | 单实例锁、启动窗口与主窗口、无边框材质、系统托盘、自建页内卡片/文件选择器、Bot 浏览器 `WebContentsView` 与 Cookie 导入、导入/搬迁数据、自动更新 |
| 引擎（子进程） | 通过 `@deepseek-ai/dsh/profile-boot` 的 `runProfile()` 启动 `ds-bot` profile，仅监听 `127.0.0.1` 固定空闲端口（保持本地存储稳定）；Linux 使用随包独立 Node 避免 native 库冲突，macOS/Windows 使用 Electron Node；携带 `DS_BOT_APP=1` |
| Profile 组合 | 每次启动置顶 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`ds-bot` 三个 bundle，用户后续安装的插件排在其后；通过 `patchFiles` 注入关闭自动凭据引导、绑定 Office 运行时、移除 DSH `/goal` 及修复搜索选择器的补丁 |

- 安装包锁定 DSH rc 版本（当前 `0.2.2-rc.1`），安装包与 `ds-bot` 共用版本号。
- 桌面应用随包内置 Office 离线运行时（Python、独立 Node、LibreOffice 引擎放于 `resources/node_modules` 以便子进程启动）。

### 窗口、托盘与自建控件

- **启动与无边框窗口**：启动先展示 720×540 启动窗口，就绪后与主窗口交叉淡化。Windows 11（22H2+）侧栏启用 Mica 材质，macOS 启用无边框 40px 标题带与侧栏 vibrancy，Linux 使用系统标题栏。
- **常驻托盘**：关闭窗口默认隐藏至系统托盘（首次关闭弹出页内确认卡），引擎与 Bot 继续工作；托盘「退出 DS Bot」为正常退出入口（macOS 无 ⌘Q，除非桌面环境无托盘）。
- **页内自建卡片与选择框**：所有提示确认、选文件夹、选 Cookie 文件和下载另存为均在窗口内用自建卡片/选择器（`folder-picker.mjs`、`picker-host.mjs`、`page-card.css`）完成，不使用系统弹窗；主进程做真实路径与权限校验，弹窗期间自动让开 Bot 浏览器视图。

### 数据、首次启动、导入与改位置

- 数据位置（`DSH_HOME`）默认 `~/.ds-bot`，总工作区默认 `~/DS Bot`，记在壳数据目录的 `locations.json`；绝不写入 `~/.dsh`。
- 首次启动检测到 `~/.dsh` 存在团队时，提供一次只读复制导入（先检锁与版本兼容再暂存复制）；之后两边独立演进。
- **设置 → 通用 → 位置** 支持随时修改总工作区（免重启，下一回合换段）与搬迁数据位置（停引擎 → 暂存复制 → 原子切换并重启，旧目录保留）。

### 安装与自动更新

- 应用标识 `io.github.fei2411.dsbot`，安装包与 `ds-bot` 同版本。
- **Windows（x64）**：仅当前用户安装的 NSIS 向导（默认 `%LOCALAPPDATA%\Programs\DS Bot`），内置 `electron-updater` 后台下载校验 sha512 并提示重启安装（启动失败页也可更新）。
- **Linux（x64）**：同轮产出 AppImage（支持自动更新）与 deb（解决 Ubuntu 24.04+ 沙箱问题，提示手动下载）。
- **macOS（arm64 / x64）**：按架构分别打包 ad-hoc 签名的 zip（不用未签名 dmg），检测到新版本时提示跳转发布页下载。
- 桌面应用内的 `ds-bot` 与 DSH 随应用整体更新，插件自身不再单独推送更新。

## 不做什么

- 不 fork、不修补 DSH。
- 不做通过 npm 安装的桌面应用形态。

## 已知限制

- Windows / macOS 未购置商业签名证书，首次打开会触发 SmartScreen 或 Gatekeeper 提示。
- Linux 部分桌面环境（GNOME / KDE）需要托盘扩展才能显示托盘图标（仍可通过再次启动应用唤回主窗口）。
- 换工作文件夹与导入后会触发换段（旧段保持完整可读可搜）。

## 变更

- 2026-11-22：移除已作废的独立 UI 插件组合旧方案与冗长开发流水账，收口为 `v0.3.10` 现行桌面应用架构说明。
