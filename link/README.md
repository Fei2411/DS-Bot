# DS Bot phone link

The encrypted link between the DS Bot phone app and the computer, and the Relay Server between them. The design is in [docs/plans/2026-10-24-mobile-app.md](../docs/plans/2026-10-24-mobile-app.md).

- `src/`: code both ends share. The phone uses `RelayTransport`, `SecureTransport` and `RpcClient`; the computer uses `HostLink` and `DeviceRegistry`.
- `server/`: the Relay Server. It forwards encrypted frames and cannot read them.

The phone and the computer each keep an X25519 identity key. The device id is derived from the key. The computer shows a QR code with its key and a one-time pairing code; the phone sends the code inside the encrypted handshake, so the Server never sees it.

## Run

Needs Node 24.

```sh
npm ci
npm run typecheck
npm test
PORT=8787 DSBOT_LINK_DATA=./data/devices.json npm run server
```

The Server speaks plain `ws://`. Put it behind a TLS proxy and give phones the `wss://` address. DS Bot uses `wss://relay.dsbot.app/v1/link` unless the user enters another Server in Settings → Phone.

Settings, all optional:

| Variable | Default | |
|---|---|---|
| `HOST`, `PORT` | `0.0.0.0`, `8787` | Where the Server listens |
| `DSBOT_LINK_DATA` | none (memory only) | File for the known devices |
| `DSBOT_LINK_TRUST_PROXY` | off | `1`: take the client address from the last `X-Forwarded-For` entry. Set it only behind a proxy that writes this header |
| `DSBOT_LINK_MAX_SOCKETS` | `1024` | Open sockets in total |
| `DSBOT_LINK_MAX_LINKS` | `1024` | Phone-to-computer links in total |
| `DSBOT_LINK_MAX_SOCKETS_PER_ADDRESS` | `256` | Open sockets from one address |
| `DSBOT_LINK_MAX_NEW_DEVICES_PER_HOUR` | `20` | New devices one address may register in an hour |
| `DSBOT_LINK_MAX_MB_PER_HOUR` | `512` | MiB one address may send in an hour |
| `DSBOT_LINK_DEVICE_TTL_DAYS` | none | Forget devices not seen for this many days |
