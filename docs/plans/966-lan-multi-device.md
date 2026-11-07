# 局域网多机：Hub、Bot 工具与同一会话（v1）

- 日期：2026-11-08
- 相关：Issue #966

## 为什么

一个人手边常有两三台机器：Mac 上跑着 DS Bot 的团队，Windows 台式机上放着要跑的东西。两件事都要成立：

1. **团队能动手**：Bot 知道哪些机器在线，并按任务自己选一台，把一条白名单命令交给它跑，拿回 stdout、stderr 和退出码。
2. **人看到同一段对话**：在 Mac 和 Windows 上打开的是同一个 Bot 会话，不是两台机器各聊各的。

v0 只打通了第 1 条的命令链路，而且 Hub 和 Worker 都是独立进程，插件完全没接入。v1 把 Hub 接进插件进程、把能力做成 Bot 工具，并把第 2 条落成一条可执行的路径（一台主机 + 远程浏览器），同时写清 DSH 目前缺什么。

## v1 相对 v0 改了什么

- 插件的 `index.js` 加载新模块 `src/host/multi-device/tools.js`；`config.multiDevice` 打开时，Hub 在插件进程里启动，不再必须常驻一个 CLI。
- 新增四个 Bot 工具：`list_devices`、`run_on_device`、`device_task`、`device_pairing_code`。
- 节点（Windows）仍然只跑 `cli.js worker`，不需要装 DSH，也不需要开入站端口。
- 会话统一：确定「一台 DSH 主机，其他机器是浏览器」的路径，并记录不采用「两台 DSH 同步聊天记录」的证据。
- v0 的协议、配对、令牌、队列、超时和安全边界不变；CLI 保留为调试入口。

## 三个角色

| 角色 | 跑在哪 | 做什么 |
|---|---|---|
| 中心（host） | 用户的 Mac，DSH 插件进程内 | 跑 Bot 团队和 Web 界面；内嵌 Hub，监听局域网端口；向 Bot 提供设备工具 |
| 节点（worker） | Windows 等被指挥的机器 | 主动连 Hub，收一条白名单命令，执行后回传结果；不监听端口 |
| 客户端（viewer） | 任意机器的浏览器 | 打开中心机器的 DSH Web 页面，看到同一段会话，和中心看到的是同一个 Session |

Hub 与插件是**同一个进程**：插件加载时 `createHub()` 并 `start()`，卸载时 `stop()`。这样中心机器不需要额外守护进程，Bot 工具直接调用内存里的 Hub 对象（`dispatch`/`waitForTask`），配对码也直接由工具生成。CLI 的 `lan:nodes`、`lan:code` 仍可对同一个数据目录工作（同一个 `admin.token`、`nodes.json`），方便排查；但同一个端口只能有一个 Hub，端口被 CLI 占用时插件会在诊断日志里报 bind 失败，工具会直接说明 Hub 没起来。

## 会话：一台主机，多个屏幕

### 结论

**一个会话只能有一个 DSH 主机。** 其他机器不跑第二份 DSH，而是用浏览器打开这台主机的 DSH Web 页面。Mac 和 Windows 看到的是同一个 Session、同一个 Bot 团队和同一份消息；Windows 只是屏幕和输入，不执行 Agent。

### 可执行路径

**A. 中心直接用 Web 版（推荐，插件不需要改 DSH）**

```sh
dsh --profile web --host <中心机器的局域网 IP> --no-open
```

启动行会打印一个带一次性 token 的 URL；Windows 浏览器打开这个 URL，换取签名 cookie 后就是同一个页面。`--host` 只接受一个具体的本机地址，不能是通配地址；非回环地址且没有 TLS 时 DSH 会明确警告走明文 HTTP。直接访问这个 IP 时，Host/Origin 检查认 bind 地址本身；如果通过另一个主机名或代理访问，再加 `--trusted-host <那个主机名>`。登录 token 就是凭据，不要贴到聊天、日志或截图里。

前提：中心机器用同一个 `DSH_HOME` 跑团队（`$DSH_HOME/bot` 就是团队数据），并且该 profile 里有 `ds-bot`。`--profile web` 的插件清单和 `--profile desktop` 是分开的，加过一次即可。**同一时间只跑一个 DSH 主机**；不要再开桌面应用去碰同一份数据。

数据位置要分清：DSH Desktop 和 `dsh --profile web` 默认共用 `~/.dsh`，所以团队和会话是同一份；DS Bot 的桌面应用（Electron）按设计用自己的 `DSH_HOME`，团队不在 `~/.dsh`。桌面应用已经在用的场景走路径 B，转发它的引擎端口；另起一个 Web 版去读 `~/.dsh` 会看到另一份团队，不是同一个会话。

**B. 桌面应用已经在跑（只监听回环）**

桌面应用的引擎只绑 `127.0.0.1`。在 Windows 上用 SSH 本地端口转发（或同类端口转发客户端）把中心的回环端口映射到本机，再打开中心启动时打印的带 token 地址。DSH Web 文档明确支持「通过呈现受信任主机名的端口转发客户端」访问；浏览器看到的 authority 是 localhost，因此能通过 Host/Origin 检查。仍然只有一个 DSH 进程，所以是同一个会话。

### 为什么不做「两台 DSH 同步聊天记录」

- **Session 是单所有者的。** DSH 在第二个实例打开同一会话时直接拒绝：`This session is already in use, possibly by another running DSH instance (such as dsh web or the desktop app).`（`dsh-client-ui-model-selection` 的用户提示）。没有「第二个进程附着到活会话」的插件 API。
- **DS Bot 的团队状态是一把写锁。** `src/host/home-lock.js` 的规则是「一个 home 只有一个写者」，第二个 host 只读。即使两台机器指向同一个 `DSH_HOME`，第二台也改不了团队、发不出消息，不是同步。
- **可用的远程能力都不适合局域网自建。** `dsh-experimental-liveshare` 是「共享会话」的现成实现，但它要求独立的 Liveshare 服务器和 OAuth 身份，默认 profile 不启用；手机 App 的远程 Host 还是骨架。
- **自己造一套聊天存储**会把 Bot、群聊、记忆、审批、卡片、搜索索引全部复制一遍，超出本轮，也和「数据留在用户自己的电脑上、只有一份真相」相冲突。

### 本轮做到哪

- Bot 工具和 Hub 已接入插件；中心 Bot 可以跨机器行动。
- 同一会话用「一台主机 + 浏览器」实现，写进本文档和 README；插件侧只做了一件事：`list_devices` 会读出本机 Web 服务的 origin，告诉 Bot 这段会话由哪台机器提供，方便它回答用户「另一台怎么打开」。
- 不做会话复制、离线合并、双写。等 DSH 提供文档化的「第二台设备附着到活会话」API 再补；那之前的 blocker 就是上面两条（单所有者 Session、单写者 home）。

## Bot 工具

四个工具注册进 `rt.teamTools`，和 `list_bots`、`read_browser` 一样只出现在 Bot 自己的 Session 和群 Session 里。默认配置（`multiDevice` 未开）不注册、不起监听。

| 工具 | 参数 | 行为 |
|---|---|---|
| `list_devices` | 无 | 列出已配对机器的名字、在线状态、操作系统/架构、主机名、最后联系时间、id；再列白名单和共享会话地址。没有节点时提示去要配对码。 |
| `run_on_device` | `node`、`argv[]`、`timeoutMs?`、`waitMs?` | 先按白名单校验，再派单；默认等 20 秒拿结果，最多等 55 秒；超时未完成时返回任务 id 和状态。节点离线时**不派单**，直接说明哪台在线。 |
| `device_task` | `task_id`、`waitMs?` | 读任务状态和结果；`waitMs` 大于 0 时等待。 |
| `device_pairing_code` | 无 | 生成一次性配对码（5 分钟、一台设备），并给出另一台机器要执行的 `lan:worker` 命令。 |

设计要点：

- **AI 选机器。** 工具描述明确要求先 `list_devices`，按操作系统、主机名和任务选节点，用户不需要每次指定。离线节点被排除，避免任务静默排队。
- **白名单在工具侧先挡一次。** `checkCommand` 在派单前拒绝非白名单命令，错误直接回到 Bot；Worker 仍会再校验一次，Hub 不替节点放行。
- **等待有上限。** 工具调用最多等 55 秒，超过就让 Bot 用 `device_task` 续读，避免一个卡住的命令拖死回合。
- **结果格式固定。** 第一行是 `[节点] 命令 — 状态, exit N, N ms`，随后是 stdout、stderr；被拒绝、被截断都会单独一行说明。
- **配对码只给用户。** 工具输出里写明「只用于这台机器，不要发到别处」；Hub 在插件里的日志是静音的，配对码不会进诊断日志。

## 插件的 Hub

配置写在 profile 的 `cordis.patch.yml` 的 `bot` 行下：

```yaml
- id: bot
  name: ds-bot
  config:
    multiDevice: true
    # 或者写成对象：
    # multiDevice:
    #   host: 0.0.0.0          # 监听所有网卡；默认 0.0.0.0
    #   port: 8787             # 默认 8787
    #   name: office-mac       # 显示给节点的 Hub 名；默认本机 hostname
    #   dataDir: ~/.ds-bot/multi-device
```

- `true` 等价于全默认；`false`/缺省 = 关闭。
- 默认数据目录和 CLI 一致：`~/.ds-bot/multi-device`（或 `DSBOT_LAN_DATA`）。`nodes.json`、`admin.token`、`hub.json` 都在这里，CLI 能直接读。
- 启动失败（端口被占用、权限不足）只写诊断日志并让工具返回「Hub 没起来」，不影响 Bot 团队启动。
- 插件不打印配对码；只有 `device_pairing_code` 被调用时才生成，并只回到聊天里。
- Hub 监听 `0.0.0.0` 意味着同网段可访问；只想本机调试时把 `host` 设成 `127.0.0.1`。

## 配对与令牌

（v0 不变）

- Hub 生成 6 位一次性配对码，5 分钟有效，只能换一台设备；用过的码立即作废，即使后面的请求失败。
- 同一来源地址 5 分钟内配对失败 10 次后返回 429，防止猜码。
- Worker 用码换取 32 字节设备令牌。Hub 只保存令牌的 SHA-256，`nodes.json` 里没有明文令牌。
- 设备端点认 `Authorization: Bearer <token>`；管理端点认 `x-admin-token`（0600 保存在 Hub 数据目录）。插件工具直接调用 Hub 对象，不经过管理端点，因此管理令牌不会进入聊天或工具输出。
- 配对码只在 Hub 进程内存里：Hub 重启后未用掉的码失效，已配对节点和令牌仍在 `nodes.json` 里。

## 命令

（v0 不变）

- 白名单固定为 `hostname`、`whoami`、`uname`、`echo`。程序名必须是裸名字（`./hostname`、`/bin/hostname` 一律拒绝），参数按程序逐个校验。
- `echo` 由 Worker 自己实现：Windows 没有 echo 可执行文件，而且这样能保证它永远只回显文本。
- 执行用 `spawn(program, args, { shell: false })`，从不经过 shell；`; rm -rf /` 只是 echo 的文本。
- 子进程只拿到最少的几个环境变量（PATH、SystemRoot、TEMP 等），Hub 上的模型密钥不会下发到节点。
- 非白名单命令由 Worker 拒绝并回报 `exitCode 126`、`state: rejected`。

## 任务与结果

（v0 不变）

- 节点离线时 CLI 派的任务留在队列里，节点连上后按入队顺序下发；**工具派单要求节点在线**，离线直接返回说明。
- 同一节点同时只有一条任务在跑，每个 Worker 串行执行。
- 任务状态：`queued`、`sent`、`done`、`failed`、`rejected`、`timeout`。
- 流在任务已发出、结果未回时断开，这条任务会退回队列，重连后重发（至少一次；白名单命令都是只读的）。
- 默认超时 30 秒，可设到 5 分钟；输出单条上限 64 KiB（Worker）、128 KiB（Hub）。

## 数据位置

| 位置 | 内容 |
|---|---|
| Hub（插件进程） | `~/.ds-bot/multi-device/nodes.json`、`admin.token`、`hub.json`（CLI 记住的地址） |
| Worker | `device.json`（设备令牌，0600） |

## 怎么用

**中心机器（Mac）**

```yaml
# profile 的 cordis.patch.yml
- id: bot
  name: ds-bot
  config:
    multiDevice: true
```

重启 DSH 后，在聊天里让 Bot 加一台机器；它调用 `device_pairing_code` 给出配对码和命令。也可以继续用 CLI 看状态：

```sh
cd ds-bot
npm run lan:nodes
npm run lan:run -- --node windows-pc -- hostname
```

**另一台机器（Windows）**

```powershell
cd ds-bot
npm run lan:worker -- --hub http://192.168.1.23:8787 --code 123456 --name windows-pc
```

第一次配对后令牌写在 `%USERPROFILE%\.ds-bot\multi-device\device.json`，以后不再需要 `--code`。

**让 Bot 用它**

> 看看 Windows 那台机器现在登录的是谁

Bot 会 `list_devices` → 选 `windows-pc` → `run_on_device`，结果直接回到聊天。

**在 Windows 上打开同一段会话**

按上面「会话」的路径 A 或 B 打开中心的 DSH Web 页面。不要在那台机器上再起一个 DS Bot 去连同一份团队数据。

## 安全边界

- **明文 HTTP，假定局域网可信。** 同网段能嗅探到设备令牌、配对码和命令内容；Hub 不提供 TLS。
- **管理令牌 = 本机管理员权限。** 拿到它就能给任意节点派任意白名单命令；插件工具不暴露它，但数据目录里的 `admin.token` 要按 0600 保护。
- **白名单不是沙箱。** 它只限制「能执行哪些程序」，不限制这些程序能读到什么；`whoami`/`hostname` 会暴露用户名和机器名。Hub 被攻破就等于拿到这些命令的执行权。
- **所有 Bot 都能用这些工具**，目前没有按 Bot 的节点权限。团队里的 Bot 共享同一个 Hub。
- **配对码是一次性短秘密。** 它只应在用户明确要求加机器时生成，并只出现在聊天里；不要写进文件、日志或公开 issue。
- **节点不需要入站端口。** Worker 主动外连，Windows 防火墙不用放行；中心需要放行 8787/TCP。

## 不做什么

- 不做远程桌面、屏幕和鼠标控制；那是电脑操控（`docs/plans/2026-11-04-computer-use.md`）的范围。
- 不做多 Hub、跨网段穿透、TLS 与账号体系。
- 不做交互式命令、实时任务日志、文件传输，也不做按 Bot 细分的设备权限。
- 不做两台 DSH 之间的会话同步、离线合并或双写。
- 不把 Worker 塞进 DSH 插件：Windows 只需要 Node，不需要 DSH 和 DS Bot。

## 已知限制

- 明文 HTTP：只适合可信局域网。
- 白名单写死在 `policy.js`，加一个命令要改代码并发新版本。
- `uname` 在 Windows 上不存在，会以非零退出码和系统错误信息返回，这是预期行为。
- 任务只在 Hub 内存里：Hub 重启（包括 DSH 重启）后未完成的任务丢失（节点登记不丢）。
- 一台 Worker 串行执行；任务很多时排队时间会体现为较晚的 `sent` 时间。
- 工具默认最多等 20 秒；长命令要靠 `device_task` 续读。
- 共享会话依赖中心的 DSH Web 或端口转发，浏览器必须能拿到带 token 的启动地址；桌面应用模式下需要用户自己转发回环端口。

## 没做成的事：DSH 的 blocker

要在插件里做到「两台机器各跑 DSH，还能实时看到同一个 Session」，缺少两样文档化能力：

1. **第二个进程/设备附着到活 Session。** 目前 Session 是单所有者的，第二个实例直接报 `session is already in use`；插件 API 里没有 attach/observer/同步流。
2. **多写者的团队状态。** DS Bot 的 home lock 只允许一个写者，第二个 host 只读。即使 DSH 允许两个进程读同一份日志，DS Bot 的 `state.json` 也不会合并。

现有的 `dsh-api-remote-access` / `dsh-api-gateway` 是「远程调用 Host 能力」的底座，但把「一个 Peer 附着到某个 Session 并跟随事件」暴露给插件，需要 DSH 提供文档 API；`liveshare` 是唯一现成实现，但它需要独立服务器和 OAuth，不适合局域网自建。等这两点有了，再把「同一会话」从浏览器方案升级成原生薄客户端。

## 验收自动化

`ds-bot/dev/lan-sync-accept.mjs` 把「一台主机、两块屏幕」和「Bot 用设备工具」两条路径都跑成可重复的自测。它不启动第二个 DSH：只起一个 `dsh --profile web --host <局域网 IP> --no-open`，然后开两个独立的登录会话（各自换取 cookie）当作两台机器的浏览器。

```sh
cd ds-bot
npm run harness                                  # 第一次：装 dev/harness 里的 DSH 包
node dev/lan-sync-accept.mjs prove               # 全新团队 → 双向同步 → 设备路径 → 退出
KEEP=1 node dev/lan-sync-accept.mjs prove        # 跑完不退出，留给 Windows 接着验
node dev/lan-sync-accept.mjs pair                # 打印配对码和 Windows 要跑的命令（只在终端）
node dev/lan-sync-accept.mjs devices             # 真实 Windows 节点：list → 自动选 → hostname
node dev/lan-sync-accept.mjs status | stop
```

它做的事：

- 在系统临时目录建一个 `dsbot-966-sync-home`，web profile 和 `dev/bench.sh` 一样链接本仓库的 `ds-bot`（`link:<checkout>/ds-bot`，bundles 含 `ds-bot`）。少了这一层，页面能开但 `/api/bot` 不存在，团队消息没处发，这是上一次验收失败的原因。
- 用 `--patch` 覆盖 `bot` 行，把 `multiDevice` 打开（`0.0.0.0` + 临时端口，`dataDir` 在同一个 home 里），所以 Hub 真的跑在 dsh 进程里，不是另起的 CLI。
- 用 `dev/mock-llm.mjs` 当模型，选 `deepseek-official/*` 路由（不能选本机 local agent 的路由，否则回合会卡在登录上）。用户消息照常落进 Session，Bot 回复是 mock。
- 客户端 A 登录后给 Chief 发一条带时间戳的独特消息；客户端 B 用**自己的**登录换 cookie，再读同一个 Bot 的会话，断言读到完全相同的文本；然后 B 发、A 读，反向再验一次。
- 设备路径：临时 home 里的 Hub 发一个配对码，脚本在本机起一个 `cli.js worker`（名字 `windows-pc`）当替身，证明配对、上线、列表、自动选机、`hostname` 派单这条链是通的。随后让 Chief 自己跑一轮：发 `看设备`，mock 模型按 `list_devices` 的返回调用 `run_on_device`，报告里的 `botDevice` 就是这轮的两条回复。替身跑在 Mac 上，所以 `hostname` 不是 `DESKTOP-BNUICR3`；脚本会在报告里把这一步标成 `simulated` 并留下待办，不伪造绿色。

证据写到 `/tmp/dsbot-966-sync-accept-report.json`（`--out` 可改）。里面有：`origin`（不带 token）、`sync.sessionId`、两个方向的消息文本与读回时间、双方 read-back 片段、cookie 的 SHA-256 前缀（不存 cookie 值）、`devices.nodes`（名字、在线、OS、主机名）、自动选中的节点、`hostname` 的 stdout/退出码、Bot 自己那轮的两次回复（`botDevice.posts` / `botDevice.hit`）、逐项 `checks` 和 `windowsRemaining`。启动地址带进程 token，只写进 `<home>/login-url.txt`（0600），不打印、不进报告。

### 还需要 Windows 的部分

`prove` 能自动跑完的到此为止。真机那一段要两台机器配合：

1. 中心 Mac：`node dev/lan-sync-accept.mjs start`，记下它打印的 `origin`，再用 `pair` 拿配对码。
2. Windows：在 `ds-bot/` 里跑 `npm run lan:worker -- --hub http://<Mac IP>:<hub 端口> --code <配对码> --name windows-pc`，看到 `connected`。
3. Windows 浏览器：打开 Mac 上 `<home>/login-url.txt` 里那一条地址（不是 `origin`），确认看到 Chief 的同一段会话；在 Windows 发一句话，Mac 上能看到它和回复。
4. 中心 Mac：`node dev/lan-sync-accept.mjs devices`。它要求在线节点里有 Windows 机器，按「在线 → win32 → `DESKTOP-*` 主机名」选一台，跑 `hostname`，断言输出是 `DESKTOP-BNUICR3`（可用 `EXPECT_HOSTNAME` 改）。证据写到 `/tmp/dsbot-966-sync-devices.json`。

`devices` 是这条验收的硬门：只有真实 Windows worker 在线且 `hostname` 对得上才返回 0。

## 双机验收清单

在中心 Mac 上：

1. 打开 `multiDevice`，重启 DSH，确认 8787 在监听（`lsof -iTCP:8787 -sTCP:LISTEN`）。
2. 让 Bot 生成配对码；确认配对码只在聊天里出现，诊断日志里没有。
3. `npm run lan:nodes` 能看到刚配对的节点。

在 Windows 上：

4. 用配对码跑 `lan:worker`，看到 `connected`；中心 `lan:nodes` 显示 `online`。
5. 让 Bot「看看 Windows 那台机器的主机名」，确认 `hostname` 的输出来自 Windows。
6. 跑一条 `echo hello from windows`，确认中文/空格参数按原样回显。
7. 让 Bot 跑 `rm -rf /`，确认被工具侧拒绝（不会发到节点）。
8. 在 Windows 上停掉 worker，确认 `list_devices` 显示 offline，`run_on_device` 直接说明离线而不排队。
9. 重新启动 worker，确认能自动重连并继续执行。

会话：

10. 按路径 A 或 B 从 Windows 浏览器打开中心的 DSH 页面，确认看到 Mac 上同一个 Bot、同一段消息；在 Windows 发一句话，Mac 上能看到它和 Bot 的回复。
11. 关掉 Windows 页面后，Mac 的会话和 Bot 工作不受影响。

## 变更

- 2026-11-08：v0 初版（配对、心跳、队列、白名单执行、结果回传、CLI 与单测）。
- 2026-11-08：v1（Hub 进插件进程、四个 Bot 工具、AI 选机器、同一会话的一主机多浏览器路径、DSH blocker 与双机清单）。
- 2026-11-08：验收自动化 `dev/lan-sync-accept.mjs`（两个客户端读同一 Session 的双向证据、插件 Hub 上的配对/选机/`hostname`、证据 JSON 与 Windows 剩余清单）。
