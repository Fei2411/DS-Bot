# LAN multi-device (v1)

A hub on the machine the user sits at, and a worker on another machine in the same
network. The worker dials the hub and holds one server-sent-events connection; the hub
sends one allowlisted command at a time and takes back stdout, stderr and the exit code.

The hub runs **inside the DS Bot plugin process**. Settings → Devices turns it on and
off, shows whether it is listening, lists the paired machines, makes a pairing code
with the worker command, and removes a machine. Bots use it through four tools
(`list_devices`, `run_on_device`, `device_task`, `device_pairing_code`), so a Bot picks
the machine that fits the task instead of the user choosing per command. A worker stays
a separate process on the other machine and needs Node only — no DSH, no DS Bot. The
CLI remains for debugging.

`config.multiDevice` sets the starting value only. Once the user moves the switch, the
choice in `<DSH_HOME>/bot/state.json` (`multiDevice.enabled`) wins, so an off hub stays
off after a restart. `multiDevice: false` keeps the switch out of reach.

The same chat on both machines is **one DSH host with browsers on the other machines**,
not two DS Bot installations: see the plan for the thin-client path and why a second DSH
cannot attach to the same Session. The design and the full protocol are in
[docs/plans/966-lan-multi-device.md](../../../docs/plans/966-lan-multi-device.md).

```yaml
# profile cordis.patch.yml, under the bot row
- id: bot
  name: ds-bot
  config:
    multiDevice: true    # or { host, port, name, dataDir }
```

```sh
# debug and status on the hub machine, inside ds-bot/
npm run lan:nodes
npm run lan:run -- --node windows-pc -- hostname

# on the worker machine
npm run lan:worker -- --hub http://192.168.1.23:8787 --code 123456 --name windows-pc
```

Data lives in `~/.ds-bot/multi-device` unless `--data` or `DSBOT_LAN_DATA` says otherwise.

| File | What it holds |
|---|---|
| `pairing.js` | Pairing codes (single use, 5 minutes) and token hashing |
| `registry.js` | `nodes.json`: paired nodes, never the plaintext token |
| `policy.js` | The allowlist and the argument rules |
| `hub.js` | HTTP endpoints, SSE streams, task queue, timeouts |
| `worker.js` | Pairing, reconnect loop, execution, result delivery |
| `tools.js` | The four Bot tools and the hub's lifecycle in the plugin |
| `sse.js` | The event framing both sides share |
| `cli.js` | `hub`, `code`, `nodes`, `run`, `worker` |

The allowlist is `hostname`, `whoami`, `uname` and `echo`; `echo` is built into the
worker because Windows has no echo executable. Nothing runs through a shell, and a child
process gets only a minimal environment, so the hub's secrets never reach a worker.

Plain HTTP on a trusted LAN, the admin token equals local administrator, and the allowlist
is not a sandbox. The hub listens on all interfaces by default; set `multiDevice.host` to
`127.0.0.1` for local-only debugging.
