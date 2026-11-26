# Bot 聊天和群聊的 `/` 菜单

- 日期：2026-11-13
- 相关：Issue #810（相关：#133、#791）

## 为什么

DS Bot 已经把 Bot 聊天和群聊输入框里的命令按钮换成了自己的「+」菜单，但打 `/` 仍然打开 DSH 的命令菜单，用户和 Bot 都能从这里绕回 DSH 命令：例如 `/goal` 会走 DSH 的长任务目标，而不是群目标；`/plan`、`/permission`、`/compact` 等也越过 DS Bot 为 Bot 保留的那套界面和行为。

DSH 0.2.2-rc.1 没有「把一个 DSH 命令从某个会话的 `/` 菜单里去掉」的文档 API：

- 宿主 `commands` 注册表只有 `register` / `list` / `find` / `execute`，没有按会话删除；agent 作用域的注册能**遮蔽**同名命令的定义，但 `list(agent)` 里那一行仍在。
- 客户端 `/` 菜单的 source 注册在 **root 全局**，`InputTriggerService` 只按 session 解析 controller，没有按会话隐藏其他 source 的接口；`dsh-client-ui-input-trigger` 的 README「Known Limitations」原话是 “Global source layer only — session-scope source registration (per-session shadowing) is designed but not enabled”。
- 客户端 `ctx.commandUi` 的贡献与宿主命令同名会直接报错（不能遮蔽）；装饰（decoration）只替换宿主的 bare 调用，保留目录行和参数认领，也不能删行。

所以这一版只做文档 API 能做到的部分：**菜单里 DSH 行仍然在，但手打 `/命令 参数` 在 Bot 聊天和群聊里不执行 DSH 命令**；同时把 DS Bot 自己的动作补进 `/` 菜单。

## 已定的行为

- 宿主模块 `src/host/agent-commands.js` 在每个 Agent 上挂一个小插件，通过反射（`child.get('commands')`）拿命令服务；直接读 `agent.ctx.commands` 会抛 “cannot get property commands without inject”，所以必须挂在 agent context 下的插件里。不用 `inject: ['commands']`：实测注入只在第一个 Agent 上解析，之后挂的 Agent 拿不到服务；反射 `get` 在所有 Agent 上都能拿到。只有确认这个 Session 是 Bot 私聊或群自己的 room Session 时，才在该 agent 的作用域里给**当前可见的全部命令名**注册同名遮蔽命令。
- 新建 Bot 的 Agent 可能先于 Bot 的状态条目出现：插件先挂上，等状态保存后再复查一次（`onSaved`），所以新 Bot 的第一条命令也不会漏。
- 在这些会话里手打 `/name args`：DSH 的 handler 不执行，返回一条明确结果；`/goal` 在群聊里指向群详情里的 Goal。技能（独立的 `/` source）不受影响。
- 监听全局 `commands/change`：先 lift 自己的影子再取当前集合重新注册，新增命令也会被遮蔽；影子随 Agent scope 卸载。
- 整个屏蔽在一个模块、一个开关：宿主 config `commandShield: false` 关掉；删掉这个模块和 `index.js` 的 MODULES 一行即整体退役（DSH 上游打开按会话过滤的 source 后就走这一步）。
- 客户端 `src/client/command-actions.js` 通过 `ctx.commandUi` 增加 DS Bot 动作行：
  - `/scheduled-task`：打开本会话（Bot 或群）的定时任务。
  - 群聊里 bare `/goal` 用 decoration 打开 DS Bot 的群 Goal（DSH 的 `/goal` 行还在，但 bare 调用换成 DS Bot 的行为）。
  - 「引用对话」留在「+」菜单：`ActionSpec.run(session)` 只拿到 Session，拿不到 composer 的 caret/insertion，而引用菜单依赖 `captureInsertion` 的 span。
- 非 Bot 的 DSH 会话保持原样。

## 不做什么

- 不删除菜单里的 DSH 命令行（文档 API 做不到）。
- 不做 DOM 层拦截 `/`，不自己重画 composer（会让菜单出现两套真相，且依赖 DSH 界面内部结构）。
- 不替换整个 composer 组件。

## 已知限制

- 菜单里仍能看到 DSH 命令行；能保证的是手打不执行。第一方命令的行沿用 DSH 自己的标题/说明（客户端按定义身份渲染），遮蔽只换执行。
- 走命令路径时（菜单打开、选行或直接 Enter）得到 DS Bot 的明确拒绝结果；先按 Esc 关掉菜单再手打，这一行会作为普通消息发给 Bot——两种路径都不会执行 DSH 命令。
- 若其他插件在同一 agent 的同一作用域注册了同名命令，遮蔽会失败并 warn，该命令仍可能执行 DSH 版本。
- 技能名与宿主命令同名时，仍按 DSH 既有规则解析为宿主命令（现在被遮蔽为 DS Bot 的拒绝结果）；不与宿主命令重名的技能照常可用。
- DSH 上游将来启用按会话的 source 过滤（#133）后，本模块应删除，菜单改成原生过滤。
