# 局域网多机：Hub、通用任务、常驻 worker 与同一会话（v2）

- 日期：2026-11-08
- 相关：Issue #966

## 为什么

一个人手边常有两三台机器：Mac 上跑着 DS Bot 的团队，Windows 台式机上放着要跑的东西。两件事都要成立：

1. **团队能动手**：Bot 知道哪些机器在线，并按任务自己选一台，把一条白名单命令交给它跑，拿回 stdout、stderr 和退出码。
2. **人看到同一段对话**：在 Mac 和 Windows 上打开的是同一个 Bot 会话，不是两台机器各聊各的。

v0 只打通了第 1 条的命令链路，而且 Hub 和 Worker 都是独立进程，插件完全没接入。v1 把 Hub 接进插件进程、把能力做成 Bot 工具，并把第 2 条落成一条可执行的路径（一台主机 + 远程浏览器），同时写清 DSH 目前缺什么。

## v2 做了什么（六条）

CEO 的定调不变：Mac 是**云中心**，其他机器仍是**出站 worker**；没有公网穿透、TLS 或远程桌面。

1. **节点通用执行。** 任务协议在旧的 `argv[]` 之上增加 `kind`：`shell`（参数列表，永不经过 shell）、`read_file`、`write_file`、`transfer`（`get`/`put`）。旧任务没有 `kind`，按 `shell` 读取。文件内容以文本或 base64 回传，单文件上限 1 MiB；相对路径落在 worker 的 `workspace/` 下，绝对路径是用户的明确选择。Hub 和 worker 都校验路径、大小和参数；输出截断规则保留。
2. **常驻 worker。** `npm run lan:daemon -- install|uninstall|status` 写平台自带的守护：macOS LaunchAgent、Linux systemd user unit、Windows 登录计划任务 + 循环脚本。登录/开机自启，断线沿用 worker 自己的重连退避。令牌仍在 `device.json`，安装命令不带配对码。
3. **对话里可见设备。** 侧栏账号行上方新增 Devices 条（轨模式下是带在线数的圆形按钮），显示「N/M 在线」；点击进入 Settings → Devices。节点状态随现有的 state 轮询以 `live.multiDevice` 下发，不额外轮询。
4. **危险操作审批。** `write_file`、`transfer put` 和只读列表之外的 `shell` 都先调用现有的 `approval.request`，用户在同一张审批卡上允许后才派单；拒绝、取消或没有审批服务时不派单，工具返回明确说明。`device_read_file` 默认可直接读，profile 里 `multiDevice.requireApprovalForReads: true` 可改成需要审批。
5. **选机更稳。** `list_devices` 接受可选 `hint`，按 hostname、机器名、路径暗示（Windows `C:\...`、`.exe`；macOS `/Users/...`、`.app`）和在线状态给出最佳匹配。离线节点直接拒绝，并列出在线机器及其 OS；Windows 路径不会落到唯一在线的 Mac 上。
6. **同一会话入口。** Devices 页和侧栏条提供复制共享地址；回环地址不当作可用链接，改为显示 `ssh -L <port>:127.0.0.1:<port> ...` 端口转发命令和原因；DSH 没有报告 Web 地址时给出降级说明。地址只是页面，登录凭据仍是 DSH 启动时打印的带 token 链接。

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

工具注册进 `rt.teamTools`，和 `list_bots`、`read_browser` 一样只出现在 Bot 自己的 Session 和群 Session 里。默认配置（`multiDevice` 未开）不注册、不起监听。

| 工具 | 参数 | 行为 |
|---|---|---|
| `list_devices` | `hint?` | 列出已配对机器的名字、在线状态、操作系统/架构、主机名、最后联系时间、id；再列只读命令和共享会话地址。给了 `hint` 时给出最佳匹配（hostname、机器名、路径暗示、OS）。 |
| `run_on_device` | `node`、`argv[]`、`timeoutMs?`、`waitMs?` | 参数列表，永不拼 shell。只读命令直接派单；其他程序先审批。默认等 20 秒，最多等 55 秒；超时返回任务 id。节点离线不派单，直接列出在线机及 OS。 |
| `device_read_file` | `node`、`path`、`maxBytes?`、`waitMs?` | 读节点文件，返回文本；二进制返回 mime、大小和 base64 标记。默认不需要审批，可配置。 |
| `device_write_file` | `node`、`path`、`content`、`encoding?`、`waitMs?` | 写节点文件，必须先审批；允许覆盖，超过 1 MiB 拒绝。 |
| `device_transfer` | `node`、`direction`、`path`、`content?`、`encoding?`、`waitMs?` | `get` 把节点文件取回本机回合（文本或 base64）；`put` 把内容送到节点，必须先审批。 |
| `device_task` | `task_id`、`waitMs?` | 读任务状态和结果；`waitMs` 大于 0 时等待。 |
| `device_pairing_code` | 无 | 生成一次性配对码（5 分钟、一台设备），并给出另一台机器要执行的 `lan:worker` 命令。 |

设计要点：

- **AI 选机器。** 工具描述明确要求先 `list_devices`，按操作系统、主机名、路径暗示和在线状态选节点，用户不需要每次指定。离线节点被排除，避免任务静默排队。
- **审批在工具侧先挡一次。** 需要审批的任务在派单前调用 `approval.request`；用户不允许就不生成任务。Worker 仍会检查 `approved` 标记和参数，Hub 不替节点放行。
- **等待有上限。** 工具调用最多等 55 秒，超过就让 Bot 用 `device_task` 续读，避免一个卡住的命令拖死回合。
- **结果格式固定。** 第一行是 `[节点] 任务 — 状态, exit N, N ms`，随后是 stdout、stderr；文件任务给出大小和 mime，文本直接显示，二进制提示用 `device_transfer`。被拒绝、被截断都会单独一行说明。
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

### Settings → Devices（客户端开关）

`config.multiDevice` 只决定第一次启动。用户在 **Settings → Devices** 拨过开关之后，选择保存在团队文件 `state.json` 的 `multiDevice.enabled` 里，下次启动以它为准：关了就是关，不会因为 profile 里还写着 `multiDevice: true` 又起来。`multiDevice: false` 是硬关闭，页面上开关不可用。

页面直接走 `/api/bot` 的 `multi-device-*` 端点，不要求用户改 YAML 或手编 `nodes.json`：

- `multi-device-status`（只读）：开关是否可用、是否打开、Hub 状态（`off`/`starting`/`listening`/`failed`）与错误、端口、局域网 URL、本机 URL、DSH Web 的共享地址、已配对节点（名字、在线、OS/架构、hostname、最后联系时间）、只读命令、是否要求审批读取、常驻 worker 的安装/卸载/状态命令。
- `multi-device-enable`：写 `state.json` 并真正启动/停止 Hub；已加载的 Bot 会话同步拿到或失去设备工具。
- `multi-device-pair-code`：等价 `device_pairing_code`，返回一次性配对码、过期时间和带当前 Hub URL 的 `npm run lan:worker` 命令；配对码只回到页面，不写团队文件，Hub 的日志也不再携带它。
- `multi-device-remove`：真正移除节点（同时管理 API 有 `DELETE /admin/nodes/<name|id>`）：断开该节点的流、取消它未完成的任务、删掉令牌散列。那台机器必须重新配对。没有「假按钮」——远程杀不掉对方的 worker 进程，页面明确说需要重新配对。

页面写清只有一个中心：换主设备 = 在另一台打开多机并重新配对；其他机器看同一段对话仍然是浏览器打开本机的 DSH Web。节点在线数也出现在侧栏账号行上方的 Devices 条，点它回到这个页面；`live.multiDevice` 随 state 轮询更新，不另开定时器。

## 配对与令牌

（v0 不变）

- Hub 生成 6 位一次性配对码，5 分钟有效，只能换一台设备；用过的码立即作废，即使后面的请求失败。
- 同一来源地址 5 分钟内配对失败 10 次后返回 429，防止猜码。
- Worker 用码换取 32 字节设备令牌。Hub 只保存令牌的 SHA-256，`nodes.json` 里没有明文令牌。
- 设备端点认 `Authorization: Bearer <token>`；管理端点认 `x-admin-token`（0600 保存在 Hub 数据目录）。插件工具直接调用 Hub 对象，不经过管理端点，因此管理令牌不会进入聊天或工具输出。
- 配对码只在 Hub 进程内存里：Hub 重启后未用掉的码失效，已配对节点和令牌仍在 `nodes.json` 里。

## 命令与文件

- 直接运行（不需要审批）的只读命令：`hostname`、`whoami`、`uname`、`echo`、`pwd`、`ls`、`dir`。程序名必须是裸名字（`./hostname`、`/bin/hostname` 一律拒绝），参数按程序逐个校验。
- 其他程序也可以跑，但必须是 `approved: true` 的任务；Worker 看到没有审批标记的写操作或非只读命令时拒绝（`exitCode 126`、`state: rejected`）。
- `echo` 由 Worker 自己实现：Windows 没有 echo 可执行文件，而且这样能保证它永远只回显文本。
- 执行用 `spawn(program, args, { shell: false })`，从不经过 shell；`; rm -rf /` 只是参数文本，不会变成第二条命令。
- 子进程只拿到最少的几个环境变量（PATH、SystemRoot、TEMP 等），Hub 上的模型密钥不会下发到节点。
- 文件任务：`read_file` 默认全读（最多 1 MiB，超出标记 `truncated`）；`write_file` 原子写入并建父目录；`transfer` 按内容返回文本或 base64（保字节），`put` 需要审批。相对路径在 worker 的 `workspace/` 下，`../` 不能逃出；绝对路径就是用户给的路径。

## 常驻 worker

```sh
cd ds-bot
npm run lan:daemon -- install --hub http://192.168.1.23:8787 --name windows-pc
npm run lan:daemon -- status
npm run lan:daemon -- uninstall
```

- 安装前必须已经用配对码跑过一次 `lan:worker`，因为守护命令读取 `device.json` 里的令牌，不写配对码。
- macOS 写 `~/Library/LaunchAgents/cool.dsbot.lan-worker.plist`（`RunAtLoad` + `KeepAlive`）；Linux 写 `~/.config/systemd/user/cool.dsbot.lan-worker.service`（`Restart=always`）；Windows 写 `<dataDir>\lan-worker.cmd` 并注册登录计划任务，脚本本身循环重启。
- 日志在 `<dataDir>/worker.log`（launchd）；systemd 走 journal；Windows 脚本在当前控制台。
- 平台命令不可用或没有权限时，文件仍会写出，并把启动失败的原因放到 `warning`，不假装成功。

## 任务与结果

- 任务字段：`kind`（`shell`、`read_file`、`write_file`、`transfer`）+ 该类型自己的字段；旧任务的 `argv[]` 按 `shell` 读。
- 节点离线时 CLI 派的任务留在队列里，节点连上后按入队顺序下发；**工具派单要求节点在线**，离线直接返回说明。
- 同一节点同时只有一条任务在跑，每个 Worker 串行执行。
- 任务状态：`queued`、`sent`、`done`、`failed`、`rejected`、`timeout`、`cancelled`。
- 流在任务已发出、结果未回时断开，这条任务会退回队列，重连后重发（至少一次）。写操作可能重发，但写入是整文件原子替换，结果一致。
- 默认超时 30 秒，可设到 5 分钟；命令输出单条上限 64 KiB（Worker）、128 KiB（Hub）；文件单次上限 1 MiB（base64 后约 1.37 MiB，Hub 请求体上限 2 MiB）。
- 文件内容不进诊断日志；Worker 只记路径和字节数。

## 数据位置

| 位置 | 内容 |
|---|---|
| Hub（插件进程） | `~/.ds-bot/multi-device/nodes.json`、`admin.token`、`hub.json`（CLI 记住的地址） |
| Worker | `device.json`（设备令牌，0600） |

## 怎么用

**中心机器（Mac）**

打开 **Settings → Devices**，拨开 “Enable multi-device on this computer”，确认 Hub 一行显示 Listening，并复制它的局域网地址。点 **Add machine** 会给出一次性配对码和另一台机器要跑的命令；也可以继续用 CLI 看状态：

```sh
cd ds-bot
npm run lan:nodes
npm run lan:run -- --node windows-pc -- hostname
```

也可以让 Bot 在聊天里加一台机器；它调用 `device_pairing_code`，给出同样的配对码和命令。profile 里的 `multiDevice: true` 只是让这台机器第一次就打开多机；用户在页面上关掉后，以 `state.json` 里的选择为准。

**另一台机器（Windows）**

```powershell
cd ds-bot
npm run lan:worker -- --hub http://192.168.1.23:8787 --code 123456 --name windows-pc
```

第一次配对后令牌写在 `%USERPROFILE%\.ds-bot\multi-device\device.json`，以后不再需要 `--code`。之后让它常驻：

```powershell
npm run lan:daemon -- install --hub http://192.168.1.23:8787 --name windows-pc
```

**让 Bot 用它**

> 看看 Windows 那台机器现在登录的是谁

Bot 会 `list_devices` → 选 `windows-pc` → `run_on_device`，结果直接回到聊天。

> 把 Mac 上的报告复制到 Windows 的 D 盘

Bot 会 `device_transfer`：先 `put`（审批卡），需要时再 `get` 回来。读取、写入和 shell 的选择写在工具描述里，用户不用记命令。

**在 Windows 上打开同一段会话**

按上面「会话」的路径 A 或 B 打开中心的 DSH Web 页面。不要在那台机器上再起一个 DS Bot 去连同一份团队数据。Devices 页和侧栏的 Devices 条都有复制地址的按钮；如果中心的 DSH Web 只绑 `127.0.0.1`，页面给的是端口转发命令，不会给一个打不开的链接。

## 安全边界

- **明文 HTTP，假定局域网可信。** 同网段能嗅探到设备令牌、配对码和命令内容；Hub 不提供 TLS。
- **管理令牌 = 本机管理员权限。** 拿到它就能给任意节点派任意任务（包括审批过的写入）；插件工具不暴露它，但数据目录里的 `admin.token` 要按 0600 保护。
- **审批是工具侧的门，不是节点的沙箱。** 用户允许一次写入后，worker 会照做；只读命令也能读到机器上的文件（`ls`、`read_file`）。给不可信节点配对前先想清楚。
- **所有 Bot 都能用这些工具**，目前没有按 Bot 的节点权限。团队里的 Bot 共享同一个 Hub。
- **配对码是一次性短秘密。** 它只应在用户明确要求加机器时生成，并只出现在聊天里；不要写进文件、日志或公开 issue。
- **节点不需要入站端口。** Worker 主动外连，Windows 防火墙不用放行；中心需要放行 8787/TCP。

## 不做什么

- 不做远程桌面、屏幕和鼠标控制；那是电脑操控（`docs/plans/2026-11-04-computer-use.md`）的范围。
- 不做多 Hub、跨网段穿透、TLS 与账号体系。
- 不做交互式命令、实时任务日志、断点续传或超过 1 MiB 的单文件；也不做按 Bot 细分的设备权限。
- 不做两台 DSH 之间的会话同步、离线合并或双写。
- 不把 Worker 塞进 DSH 插件：Windows 只需要 Node，不需要 DSH 和 DS Bot。

## 已知限制

- 明文 HTTP：只适合可信局域网。
- 只读列表写死在 `policy.js`，加一个常用只读命令要改代码并发新版本；其他程序走审批，不用改列表。
- 单文件上限 1 MiB，没有分块或断点续传；更大的文件要先在节点上切分。
- 审批依赖 DSH 的 approval 服务；在没有审批卡的宿主里，写入和非只读命令会直接拒绝，不会悄悄执行。
- `uname` 在 Windows 上不存在，会以非零退出码和系统错误信息返回，这是预期行为。
- 任务只在 Hub 内存里：Hub 重启（包括 DSH 重启）后未完成的任务丢失（节点登记不丢）。
- 一台 Worker 串行执行；大文件传输会占住该节点，其他任务排队。
- 工具默认最多等 20 秒；长命令和大文件要靠 `device_task` 续读。
- 共享会话依赖中心的 DSH Web 或端口转发；Devices 页只能复制 Web origin，带 token 的登录链接仍要看 DSH 启动时的输出。

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
- 2026-11-08：客户端 Settings → Devices（开关落 `state.json`、Hub 状态与地址、节点列表、配对码与命令、真正移除节点），profile 改为只提供首次默认值。
- 2026-11-08：v2 六条（任务 `kind` 与读写文件/传输、平台守护安装、侧栏设备条、审批门槛、路径与 OS 选机、共享地址复制与回环降级）。单测覆盖协议、路径逃逸、大小上限、审批前不派单、守护文件内容与选机纯函数。
