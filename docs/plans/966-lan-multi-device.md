# 局域网多机：Hub 与 Worker（v0）

- 日期：2026-11-08
- 相关：Issue #966

## 为什么

一个人手边常有两三台机器：Mac 上跑着 DS Bot 的团队，Windows 台式机上放着要跑的东西。团队应该能把自己的一条明确命令交给另一台机器执行，并拿回 stdout、stderr 和退出码，而不是让用户在两台机器之间来回切换、手工复制结果。

v0 只打通这一条链路：中心生成配对码、登记节点、派一条命令、收结果。不碰远程桌面，不做复杂调度，也不改 DSH 本身——Hub 和 Worker 都是独立进程，插件的加载路径和 `index.js` 不变。

## 已定的行为

**角色与连接**

- Hub 在中心机器（本机 Mac）上，监听一个端口（默认 8787）。Worker 在被指挥的机器上（Windows）。
- Worker 主动连 Hub，连接是一条 HTTP 长连接上的 SSE（`GET /stream`）。Worker 不监听端口，Windows 不需要放行入站规则。
- Worker 断线后自己重连：首次 1 秒，之后翻倍，上限 30 秒；重连成功后退回 1 秒。Hub 收到同一节点的新流就替换旧流。

**配对与令牌**

- Hub 生成 6 位一次性配对码，5 分钟有效，只能换一台设备；用过的码立即作废，即使后面的请求失败。
- 同一来源地址 5 分钟内配对失败 10 次后返回 429，防止猜码。
- Worker 用码换取 32 字节设备令牌。Hub 只保存令牌的 SHA-256，`nodes.json` 里没有明文令牌，文件读走也不能冒充设备。
- 设备端点认 `Authorization: Bearer <token>`；管理端点（生成配对码、列节点、派单、查任务）认 `x-admin-token`，首次启动生成，0600 保存在 Hub 的数据目录。
- 配对码只在 Hub 进程内存里：Hub 重启后未用掉的码失效，已配对节点和令牌仍在 `nodes.json` 里。

**命令**

- 白名单固定为 `hostname`、`whoami`、`uname`、`echo`。程序名必须是裸名字（`./hostname`、`/bin/hostname` 一律拒绝），参数按程序逐个校验（`hostname`/`uname` 只接受规定的短选项，`whoami` 不接受参数）。
- `echo` 由 Worker 自己实现：Windows 没有 echo 可执行文件，而且这样能保证它永远只回显文本。
- 执行用 `spawn(program, args, { shell: false })`，从不经过 shell；`; rm -rf /` 只是 echo 的文本。
- 子进程只拿到最少的几个环境变量（PATH、SystemRoot、TEMP 等），Hub 上的模型密钥不会下发到节点。
- 非白名单命令由 Worker 拒绝并回报 `exitCode 126`、`state: rejected`，Hub 不替它放行。v0 里的「危险命令需确认」就是这条白名单本身。

**任务与结果**

- 节点离线时任务留在队列里，节点连上后按入队顺序下发；同一节点同时只有一条任务在跑，前一条结束后才发下一条，每个 Worker 串行执行。
- 任务状态：`queued`、`sent`、`done`、`failed`、`rejected`、`timeout`。
- 流在任务已发出、结果未回时断开，这条任务会退回队列，重连后重发（至少一次；白名单里的命令都是只读的，重复执行没有副作用）。
- 默认超时 30 秒，可设到 5 分钟；Worker 超时杀掉子进程并回报 124 之外，Hub 在超时后再等 5 秒，仍没有结果就把任务标成 `timeout`（`exitCode 124`）。
- 输出单条上限 64 KiB（Worker 采集）、128 KiB（Hub 再截一次），截断会在结果里标明。

**心跳与在线**

- SSE 每 15 秒发一行注释 ping，保持中间设备不主动断开。
- Worker 每 20 秒 `POST /heartbeat` 更新 `lastSeen`。
- 节点的在线状态以「Hub 上有没有它的流」为准，心跳只用于记录最后一次联系时间。

**数据位置**

- Hub：`nodes.json`（节点与 tokenHash）、`admin.token`、`hub.json`（CLI 记住的 Hub 地址）。
- Worker：`device.json`（设备令牌，0600）。
- 默认目录 `~/.ds-bot/multi-device`，用 `--data` 或 `DSBOT_LAN_DATA` 指定别的目录。

## 怎么启动

需要在两台机器上都有一份仓库和 Node 22 以上（用到内置 `fetch` 和 SSE 流）。以下命令都在 `ds-bot/` 目录里执行。

本机 Mac（Hub）：

```sh
npm run lan:hub -- --name "Mac mini"
```

输出里有监听地址、数据目录、管理令牌文件和一枚配对码，另外打印了另一台机器要用的命令。想再要一枚配对码（例如第二台机器）：

```sh
npm run lan:code
```

Windows（Worker），把 `--hub` 和 `--code` 换成 Hub 打印的值：

```powershell
npm run lan:worker -- --hub http://192.168.1.23:8787 --code 123456 --name windows-pc
```

Worker 第一次运行会把令牌写进 `%USERPROFILE%\.ds-bot\multi-device\device.json`，之后不再需要 `--code`。想换一个数据目录就加 `--data`。

验证：

```sh
npm run lan:nodes                              # 看节点是否 online
npm run lan:run -- --node windows-pc -- hostname
npm run lan:run -- --node windows-pc -- echo hello from the mac
npm run lan:run -- --node windows-pc -- rm -rf /   # 应被拒绝，退出码 126
```

没有第二台机器时，Worker 用 `--hub http://127.0.0.1:8787` 在本机就能跑通整条链路。

防火墙：Hub 需要放行 8787/TCP（macOS 首次启动会询问）；Worker 不需要任何入站规则。

## 不做什么

- 不做远程桌面、屏幕和鼠标控制；那是电脑操控（`docs/plans/2026-11-04-computer-use.md`）的范围。
- 不做多 Hub、跨网段穿透、TLS 与账号体系。v0 假定局域网可信，管理令牌等于本机管理员权限。
- 不做交互式命令、实时任务日志、文件传输，也不做按 Bot 细分的设备权限。
- 不接入插件加载路径：v0 是独立进程，`index.js` 和 `client.js` 都不变。

## 已知限制

- 明文 HTTP：同网段能嗅探到设备令牌和命令内容，只适合可信局域网。
- 白名单写死在 `policy.js`，加一个命令要改代码并发新版本。
- `uname` 在 Windows 上不存在，会以非零退出码和系统错误信息返回，这是预期行为。
- 任务只在 Hub 内存里：Hub 重启后未完成的任务丢失（节点登记不丢）。
- Hub 被攻破就等于拿到白名单内的执行权，白名单不是沙箱。
- 一台 Worker 串行执行；任务很多时排队时间会体现为较晚的 `sent` 时间。

## 变更

- 2026-11-08：v0 初版（配对、心跳、队列、白名单执行、结果回传、CLI 与单测）。
