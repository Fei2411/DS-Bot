# 功能包：按 Bot 挑选技能、MCP 和内置工具组（设计稿）

状态：已决定；本次实现第 10 节的第 1 步。测量基于 `dev` @ `f09c081a`。
相关：`docs/plans/2026-10-10-bot-runtime.md`「能力」一节（本稿是它的延伸，不推翻它）；PR #1654、#1838、#1919。

## 1. 现在每轮花多少 token

用 `cl100k_base` 估算（DeepSeek 实际分词会有出入），按 DSH Web `standard` 预设、原生工具执行器重建了每一步请求里的定义部分。不含历史、记忆、项目说明、工具结果。

| 部分 | 普通 Bot | Main Bot | 说明 |
|---|---:|---:|---|
| DS Bot 自己的工具（35 个） | 7,262 | 7,262 | 普通 Bot 也带着 Main 专用工具的 schema，权限在调用时才拦 |
| DSH 原生工具（21 个） | 3,158 | 3,158 | bash/read/edit/grep/schedule_*/web_* 等 |
| 工具数组合计 | **10,377** | **10,377** | |
| 技能目录（3 个内置技能 / 开 Office 后 9 个） | 321 / 443 | 321 / 443 | 只有一行一个；正文按需加载（3 个合计 2,545，9 个合计 7,559） |
| 身份 + 团队规则（prompt.js） | 1,901 | 2,325 | |
| 按条件出现的工具（浏览器、邮件、OCR、电脑操作、插件管理） | +0 ~ 2,700 | 同左 | 看设置 |
| 每挂一个 MCP 服务 | 例：Playwright 25 个工具 **3,942** | 同左 | 服务返回什么就全量注册 |

结论：

1. **技能已经是「目录 + 按需加载」**，一个技能每轮只花 20–70 token。光把技能做成功能包，省不了多少 token；技能的问题是「无关的技能出现在目录里会被误用」，不是体积。
2. **真正的大头是工具 schema**：内置 10.4k 每轮固定带着；每挂一个 MCP 服务再加 1k–4k，而且是全量注册。挂三四个 MCP 后，定义部分就能到 20k+。
3. 普通 Bot 每轮带着约 2k token 的 Main 专用工具（create_bot 343、update_bot 424、update_group 381、save_capability 317、create_group 235、stop_bot 111、delete_group 59、list_bot_models 51、delete_capability 41）。
4. 现在已经有按 Bot 挂载：设置 → Capabilities 里的 MCP / 技能 / 能力包，挂到 `bot.capabilities` 后从下一条消息生效（`capabilities.js` reconcile，按 Agent 挂载）。缺的是「放在那、不挂、要用时再挂」这一档。

所以功能包要管的是**工具（MCP + 内置工具组）**，技能顺带。

## 2. 目标

- 团队库里的技能、MCP、内置工具组默认**不注入**。
- 每个 Bot 有一份「功能包清单」：每个包在提示词里只占一行（名字 + 一句话 + 已知时的工具数）。
- Bot 做任务时自己用工具装上需要的包；用户和 Main Bot 也能给 Bot 配。
- 尽量保留 DeepSeek 的前缀缓存；实际命中率以提供商 usage 为准，卸包不保证保留此前全部缓存。

## 3. 三档状态

在现有的「Bot 能力开关」上把一档开关改成三档：

| 档位 | 含义 | 注入什么 |
|---|---|---|
| 常驻（现在的「启用」） | 每个会话一开始就挂好 | 完整工具 / 技能目录行 |
| 清单 | 不挂；只在功能包清单里占一行 | 一行（约 20–40 token） |
| 关 | 这个 Bot 看不到 | 无 |

- 存储：`bot.capabilities`（常驻，原样不动）+ 新增 `bot.packs`（清单档，名字列表）。老数据全部是常驻，行为不变。
- 单个 MCP、单个技能也能放进清单档，不必先包成能力包；清单里一行就是一个可装的东西。
- 复用已有的可选 `description`，不加必填字段。缺少说明时用 MCP / 技能的简短类型说明，或包内条目列表；清单说明压成一行并截到 120 字符。

## 4. 清单怎么注入

- 在 `capabilities.js` 注册独立系统提示词段「Feature packs」（order 646，紧邻记忆段），每行：`- <name>: <summary>`，已从此前挂载获知数量时附加 ` (<n> tools)`。按名字排序；空清单不输出文字，并提示任务需要时调用 `use_pack`。
- 这一节**在一轮内冻结**：轮首和轮末比较最新清单文本，有变化时清除快照，下一次重新渲染；即使没有装包，也会检查清单和说明变化。轮首检查确保空闲期间的修改在新一轮立即可见。装包工具当场读最新库，所以清单文字晚一点不影响使用。
- 第 1 步不持久化 token 估算或工具数；工具数只在挂载后记于进程内存，下一轮可显示。清单文字在轮内冻结，不因本轮装包而改变。

## 5. 装包、卸包

新增两个 Bot 工具（DS Bot 工具，约 150 token）：

- `use_pack { name, reason? }`
  - 只对**这个会话**生效（这个 Bot 的私聊或某个群里它的会话），不改 `bot.capabilities`。要长期常驻，仍然用现有 `attach_capability` 或让用户在设置里改。
  - 走现有 reconcile 挂载，**等到挂好（ready / needs-approval / error）再返回**，上限沿用 `ENSURE_TIMEOUT_MS`（15 s）。DSH 每一步都会重新选工具（`dsh-agent-loop` `preStep()` → `tools.resolve()`），所以挂好后同一轮的下一步就能用，不用等下一条消息。
  - 本地 stdio MCP 没批准的，照旧返回 needs-approval，不绕过审批。私有 Bot、密钥、谁能用哪个能力的规则照旧（`privacy.js`、`canUseSecret`）。
- `drop_pack { name }`：标记卸载，**到本轮结束才真正卸**。
- 会话已加载的清单项被移出 `bot.packs` 或从团队库删除时，也等到本轮结束合并卸载；常驻档保持已有行为。

缓存：

- DSH 给 `deepseek-flash` 声明了 `toolUpdate: "addition-only"`：新加的工具走延迟声明 + 历史里激活（`dsh-llm` / `dsh-llm-deepseek` 的 `defer_loading`），前缀不重写。所以**加包是缓存友好的**，可以在任务中途做。
- 去掉工具会从第一个受影响的位置起让缓存失效。所以**卸包只在轮次边界做**，而且合并：一轮里 drop 几个都只卸一次。
- 已加载的技能正文留在历史里，卸包不删历史，只是之后不再在目录里出现。
- 换段（handoff / 上下文满）时会话里装的包全部清空，新段只带常驻档。换段本来就重建前缀，正好在这时收拾。
- 上线后用 usage 里的 `cacheReadTokens` 对比装包前后几步，验证命中率；这是这份设计里唯一没实测的假设。

## 6. 内置工具组也做成包（第二阶段）

DS Bot 已经能按 Bot 过滤组装好的工具（`tools.js` `filterBotAssembly`、连接器的 `maskConnectorTools`），所以内置工具可以分组，不改 DSH：

| 内置包 | 工具 | 约 token | 默认 |
|---|---|---:|---|
| `team-admin` | create_bot、update_bot、stop_bot、list_bot_models、create_group、update_group、delete_group | ~1,600 | Main Bot 常驻；普通 Bot 关（它们本来就不能用） |
| `capability-admin` | save/delete/attach/detach/list_capabilities | ~550 | Main Bot 常驻；普通 Bot 清单 |
| `schedule` | schedule_create/list/view/edit | ~1,050 | 清单 |
| `mail`、`browser`、`computer`、`office` | 各自工具 / 技能 | 各 0.5k–1k | 清单（前提是设置里已启用） |
| `group-work` | group_goal、group_task、group_todo、group_relay | ~1,300 | 群会话常驻，私聊清单 |

- 核心工具（read/edit/bash/grep、message_bot、ask_user、bot_remember/recall、use_pack/drop_pack 等）永远常驻，不进包。
- 内置组的「卸」也只在轮次边界、按会话做，同第 5 节。
- 第一阶段只做团队库里的 MCP / 技能 / 能力包；第二阶段再分内置组。按上表，普通 Bot 不带 Main 专用工具一项就每轮省约 1.6k，加上 schedule 和群工具进清单，私聊每轮能省 3k–4k。

## 7. 谁来组装

- **用户**：后续设置页提供每项三档；本次只扩展 `bot-capability` 端点的 `mode` 参数，不改界面。说明复用 `description`。
- **Main Bot**：用现有 `attach_capability`（常驻），加一个参数 `mode: 'always' | 'catalog'` 给别的 Bot 配清单档。权限规则照旧（私有 Bot 不能被别人改）。
- **Bot 自己**：任务中 `use_pack` / `drop_pack`；觉得某个包每次都要用，可以 `attach_capability` 自己设常驻（现有权限允许它给自己挂）。
- 群聊：每个 Bot 在群里的会话独立装包，互不影响；群不另设包。

## 8. 不做什么

- 不改 DSH，不碰 DSH 的技能发现：用户在 `~/.dsh/skills` 或项目 `.agents/skills` 里的技能仍由 DSH 发现、对所有 Bot 可见。要管它们得有 DSH 的按 Agent 过滤 API，缺这个就先记下，不打补丁。
- 不做「按任务自动猜包」：由 Bot 根据清单自己决定，避免一个不可见的分类器。
- 只能有一个取值的设置（工具呈现方式、persona、压缩引擎）仍然不进包，和现有设计一致。

## 9. 和现有 PR 的关系

| PR | 关系 | 建议 |
|---|---|---|
| [#1838](https://github.com/Fei2411/DS-Bot/pull/1838) 导入完整技能文件夹为能力（已 Approve） | 同一套能力库和 Bot 开关，导入的文件夹技能就是包里的一项 | not a prerequisite |
| [#1654](https://github.com/Fei2411/DS-Bot/pull/1654) 内置运维 / 插件开发技能 | 加的是全局内置技能（`maintenance-skills.js`，和 office / goal-grill 同路），靠 `MAIN_RULES` 只给 Main Bot 指路；不是打包机制，代码不重叠 | 可以并进来：合入后这两个技能就是第一个内置包 `ds-bot-maintenance`（Main Bot 清单档），`MAIN_RULES` 里那几条指路改成清单里的一行。它的 `ds-bot-plugin-dev` 文档写了 `save_capability kind: 'pack'`，功能包落地时要同步改文档 |
| [#1919](https://github.com/Fei2411/DS-Bot/pull/1919) MCP access（外部 agent 调 DS Bot） | 方向相反：DS Bot 当 MCP 服务端，不是给 Bot 挂 MCP；不重叠 | 无需协调。只是界面上「MCP access」和「Capabilities → MCP」名字接近，设置页文案要分清 |

## 10. 分步

1. 三档存储 + 清单注入 + `use_pack` / `drop_pack`（只管团队库里的 MCP / 技能 / 包），测：挂载时机、轮末卸载、换段清空、审批和私有 Bot 规则；用 mock 模型 + usage 验缓存。
2. 设置页三档开关（交给前端那边做）。
3. 内置工具组分包，先做 `team-admin`（普通 Bot 立刻每轮省 ~1.6k）。
4. #1654 的技能挪进内置包。

## 11. 已决定

1. 采纳普通 Bot 的 `team-admin` 默认关，但放在第 10 节第 3 步；本次不隐藏任何现有团队管理工具，也不基于 #1654。
2. 会话里装的包在 handoff / 新段时清空，不跟到下一段；新段只带常驻档。

## 附：测量方法

测量使用一次性脚本：用真实的 DSH 注册和 DS Bot `plainToolSchema()` 生成 schema，Playwright MCP 用其真实 `tools/list` 结果，`js-tiktoken` `cl100k_base` 计数。这是重建出来的请求组成，不是线上遥测。
