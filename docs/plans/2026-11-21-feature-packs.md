# 功能包：按 Bot 按需装卸技能、MCP 与内置工具组

- 日期：2026-11-21
- 相关：PR #2019、#2035、#2043；延伸 [Bot 运行配置](2026-10-10-bot-runtime.md)「能力」一节
- 代码：`ds-bot/src/host/capabilities.js`、`builtin-packs.js`、`tools.js`、`ds-bot/src/client/bot-settings.js`

## 为什么

技能本身已经是「目录 + 按需加载」，单轮只占几十个 token；真正拉高每轮固定提示开销的是工具 schema（内置工具 + 多个 MCP 服务动辄上万 token）。通过引入「清单档 + 按会话按需装卸」以及对内置管理类工具做角色裁剪，可以在不改 DSH 的前提下减少无关工具干扰与每步 token 消耗，同时尽量保持前缀缓存命中。

## 已定的行为

### 1. 团队库能力三档状态

每个 Bot 对团队能力库中的任意 MCP 服务、技能或能力包均可单独配置三档（旧数据默认保持「常驻」）：

| 档位 | 存储位置 | 行为 |
|---|---|---|
| **常驻（`always`）** | `bot.capabilities` | 每个会话启动即挂载完整工具 / 技能目录行 |
| **清单（`catalog`）** | `bot.packs` | 不预挂载；仅在提示词「Feature packs」段落占一行（名称 + 简短说明 + 已知工具数） |
| **关（`off`）** | 均不列入 | 对该 Bot 完全不可见 |

- 用户在 Bot 设置页的能力卡片中切换三档；Main Bot 亦可通过 `attach_capability` 的 `mode: 'always' | 'catalog'` 为其他 Bot 配置。
- 提示词段「Feature packs」（order 646，紧邻记忆段）在单轮内冻结以保护前缀缓存，轮首和轮末检测变更并在下轮刷新；空清单不输出该段。

### 2. 按会话装卸：`use_pack` / `drop_pack`

- `use_pack { name, reason? }`：仅对当前会话生效（不修改持久化的 `bot.capabilities`），经既有 reconcile 挂载并等待就绪（超时上限 15 秒）；DSH 在下一步重新解析工具后即可立刻调用。本地 stdio MCP 未获批准时仍返回 `needs-approval`，私有 Bot 与密钥权限边界不变。
- `drop_pack { name }`：标记卸载并延迟至本轮结束合并执行，避免在轮中修改工具数组破坏前缀缓存。
- 换段（上下文交接 / 切工作文件夹）时清空会话内动态加载的包，新段仅携带常驻档。群聊中各成员会话独立装包，互不干扰。

### 3. 内置工具分包：`team-admin`

- `builtin-packs.js` 定义内置工具分包与角色默认策略，经 `llm/stream` 瀑布流过滤最终工具数组。
- 当前落地的内置包为 `team-admin`，仅包含真正 Main Bot 专用的 4 个工具：`create_bot`、`stop_bot`、`create_group`、`delete_group`（普通 Bot 默认关闭，每步请求减少约 744 cl100k 代理 token；Main Bot 默认常驻）。
- `update_bot`（自改设置）、`update_group`（群管理员管本群）、`list_bot_models`（查看可用模型）对所有 Bot 保持可见，调用时权限校验照旧。
- 角色在 `turn/start` 同步取快照并在 `turn/end` 清理，确保单轮内工具数组稳定、不因中途升降级破坏前缀缓存。

## 不做什么

- 不修改 DSH 的全局技能发现机制（`~/.dsh/skills` 与项目 `.agents/skills` 仍由 DSH 发现）。
- 不做隐式「按任务自动猜包」分类器，由 Bot 依据清单显式调用 `use_pack`。
- 互斥型单例设置（工具呈现方式、persona、压缩引擎）不纳入功能包。

## 已知限制

- 除 `team-admin` 外的其他内置工具组（如日程、邮件、浏览器、群工具）尚未分包，也暂不支持内置组的会话级动态装卸。

## 变更

- 2026-11-22：按 #2019、#2035、#2043 合并后的现行实现收口，移除设计阶段预估表与旧 PR 协调记录。
