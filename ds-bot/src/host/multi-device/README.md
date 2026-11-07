# LAN multi-device (v0)

A hub on the machine the user sits at, and a worker on another machine in the same
network. The worker dials the hub and holds one server-sent-events connection; the hub
sends one allowlisted command at a time and takes back stdout, stderr and the exit code.

Nothing here is loaded by the DSH plugin: `index.js`, `src/client/` and `client.js` are
untouched. The design and the full protocol are in
[docs/plans/966-lan-multi-device.md](../../../docs/plans/966-lan-multi-device.md).

```sh
# on the hub machine, inside ds-bot/
npm run lan:hub -- --name "Mac mini"      # prints the pairing code
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
| `sse.js` | The event framing both sides share |
| `cli.js` | `hub`, `code`, `nodes`, `run`, `worker` |

The allowlist is `hostname`, `whoami`, `uname` and `echo`; `echo` is built into the
worker because Windows has no echo executable. Nothing runs through a shell, and a child
process gets only a minimal environment, so the hub's secrets never reach a worker.
