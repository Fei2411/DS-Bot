# DS Bot 文档导航

这里汇总 DS Bot 仓库的全部有效文档。每份文档只记录当前实现与已拍板的设计；代码改动时直接更新对应文档，不再靠层叠补丁保留过期方案。

## 上手与使用

| 文档 | 内容 |
|---|---|
| [README（中文）](../README.zh.md) · [README (English)](../README.md) | 项目简介、安装（桌面应用 / DSH 插件 / Docker）、核心功能与设置入口 |
| [已知问题（中文）](known-issues.zh.md) · [Known issues](known-issues.md) | 常见问题与恢复步骤（等待中的 `@`、插件行损坏、关闭 `auto` 搜索、旧 Linux glibc） |
| [内置用户手册（供 Bot 读取）](../ds-bot/src/host/skills/ds-bot-manual/SKILL.md) | 随插件分发的 `ds-bot-manual` 技能与 12 篇分主题参考（单测校验工具名一致性） |

## 模块说明

| 模块 | 说明文档 | 职责 |
|---|---|---|
| `ds-bot/` | [ds-bot/README.md](../ds-bot/README.md) | 核心 DSH 插件：服务端宿主（`src/host/`）、浏览器界面（`src/client/` → `client.js`）、`auto` 搜索（`web-search.js`） |
| `app/` | [app/README.md](../app/README.md) | 独立桌面应用（Windows / macOS / Linux Electron 壳、锁定 DSH 引擎、首次启动与导入、自动更新） |
| `mobile/` | [mobile/README.md](../mobile/README.md) | Expo React Native 手机 App（iOS / Android）与浏览器远程导出 |
| `link/` | [link/README.md](../link/README.md) | 端到端加密（Noise IK）连接协议与自建中转服务器 |
| `browser-plugins/` | [browser-plugins/README.md](../browser-plugins/README.md) | 可选交互式浏览器后端（`refs` / `script` / `task`） |
| `docker/` | [docker/README.md](../docker/README.md) · [README.dev.md](../docker/README.dev.md) | NAS / Linux 服务器 Docker 部署与容器化开发环境 |

## 产品、架构与安全

| 文档 | 内容 |
|---|---|
| [愿景（中文）](vision.zh.md) · [Vision (English)](vision.md) | 产品定位、两种形态、十条核心要求与取舍原则 |
| [安全模型](../SECURITY_MODEL.md) | 信任边界、资产分级、威胁模型（重点防 Prompt Injection）与现行防护 |
| [DSH 让步总账](plans/2026-10-13-dsh-concessions.md) | 因 DSH 自身限制所做的让步与当前边界（区分 DS Bot 缺陷与上游限制） |
| [UI 设计标准](design/ui-standard.md) | 主题变量、排版、圆角、动效弹簧、组件规格、文案与无障碍规范 |
| [已定设计目录](plans/README.md) | 按领域分类的全部核心功能设计文档 |

## 开发与发版

| 文档 | 内容 |
|---|---|
| [参与开发（中文）](../CONTRIBUTING.zh.md) · [Contributing](../CONTRIBUTING.md) | 开发环境、测试命令、分支与 PR 协作规则、发版步骤 |
| [发版前真机检查](dev/release-checklist.md) | Windows / macOS / 插件版 / Android 发版前的真机验收清单 |
| [更新日志](../CHANGELOG.md) | 各已发布版本的用户可见变更历史 |

## 架构速览

```text
用户界面（桌面应用窗口 / DSH Desktop / DSH Web / 手机 App / 浏览器远程 / IM / 本地 MCP）
        │
        ▼  POST /api/bot · GET /api/bot/feed · Noise IK 中转 · 127.0.0.1:8797/mcp
ds-bot 服务端宿主（ds-bot/index.js + ds-bot/src/host/）
  ├── 团队与状态：roster · store · home-lock · feed · usage
  ├── 对话与执行：turns · delivery · parts · steward · bot-tasks · handoffs · btw
  ├── 群聊协作：groups · ledger · goals · tasks · group-search
  ├── 记忆与学习：memory · memory-review · memory-tidy · learning · chat-index
  ├── 能力与隔离：tools · capabilities · builtin-packs · connectors · secrets · permissions · privacy
  └── 外部桥接：local-agents · browser · computer · im · phone · mcp-server · deepseek-services
        │
        ▼  仅通过公开插件 API（不修改 DSH）
DeepSeek Harness（DSH 引擎：Agent 循环、Session 存储、模型服务、基础工具与插件系统）
```

- **单 Bot 单连续对话**：每个 Bot（含本地 Agent CLI）对外只有一条连续对话；上下文接近上限时由上下文管家自动压缩或换段，旧段归档可搜；耗时任务走后台异步任务。
- **配置隔离**：每个 Bot 拥有独立保存的配置（模型、思考强度、指令、工作文件夹、权限预设），不同于 DSH 的安装 profile。
- **请求路径**：模型 Bot 走 DSH Agent 循环与模型服务；本地 Agent Bot 走对应 CLI 自身的工具与模型；辅助调用（记忆整理、上下文管家、交接、侧边对话等）在 Agent 循环外调用模型服务；DeepSeek 独立服务（OCR/TTS/ASR）与网页搜索/抓取直接请求对应接口。
