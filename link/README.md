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

The Server speaks plain `ws://`. Put it behind a TLS proxy and give phones the `wss://` address.
