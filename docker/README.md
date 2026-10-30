# DS Bot in Docker

This directory deploys DS Bot as a Docker image: a `dsh web` server (DeepSeek
Harness) with the `ds-bot` plugin installed, ready for a NAS or any always-on
box. The container is the sandbox boundary — see [Permissions](#permissions).

## Requirements

- Docker 24+ with Compose v2.24+ (Docker Desktop, or Docker Engine + the
  compose plugin — `env_file.required` needs 2.24).
- Linux containers, x86-64. arm64 builds should work (`node:24-bookworm-slim` is
  multi-arch) but are untested.
- A DeepSeek API key (or another Anthropic-Messages-compatible endpoint through
  `DEEPSEEK_BASE_URL`).

## Quick start

From the repository root, edit `docker-compose.yml`: fill in
`DEEPSEEK_API_KEY`, add the NAS IP to `DSH_TRUSTED_HOST`, and set `PUID`/`PGID`
to the share owner's IDs. Environment variables, ports and paths are all
configured directly in this file; no `.env` is needed. Do not commit real keys.

```sh
docker compose up -d --build
docker compose logs ds-bot
```

This builds the local image without pulling a published DS Bot image. The root
Compose file publishes host port **13080**, and stores data and workspace files
in `docker/data` and `docker/workspace`.

The log prints a line like `dsh web: http://127.0.0.1:3080/?token=… (LAN:
http://172.x.x.x:3080/?token=…)`. Take the token from it and open
`http://<NAS IP>:13080/?token=…` once in your browser: the token sets a signed
cookie (valid 30 days, bound to that authority), after which
`http://<NAS IP>:13080/` opens the UI directly. The printed port is the container's;
use the host port from `ports:` when opening it. The first time the team opens,
DS Bot creates a Main Bot called Chief.

An alternative for users who prefer `.env` is still available in `docker/`:

```sh
cd docker
cp .env.example .env
# Edit .env: DEEPSEEK_API_KEY, DSH_TRUSTED_HOST, PUID/PGID.
docker compose up -d --build
```

That file publishes host port **3080** by default. Choose one deployment
method; do not run both against the same data directory.

## Permissions

The container is the only sandbox. DSH's own kernel sandbox (bubblewrap /
Landlock) does not run inside Docker's default seccomp profile or on most NAS
kernels, so the image offers exactly one permission preset, **Full access**:
every Bot command runs without asking. Only mount folders the Bots may change
into `/workspace`, and run the container with `PUID`/`PGID` of the share owner
so file ownership stays right.

## Network

`dsh web` binds only loopback or all interfaces (`0.0.0.0`) — never a concrete
LAN address — and its `--host` flag refuses `0.0.0.0`, so the entrypoint writes
a config overlay that binds all interfaces. Inside a container the publish rule
is the real boundary, and the trust fence below still applies. The UI checks
the `Host` header of every `/api` request: loopback is always trusted, and
every other name or IP you open it at must be listed in `DSH_TRUSTED_HOST`
(no port — a bare entry trusts it on any port), or the API answers 403.
`DSH_HOST=127.0.0.1` narrows the bind to loopback (e.g. a reverse proxy in the
same network namespace); published ports then no longer reach it.

Alternatives:

- **Host network**: set `network_mode: host` in `compose.yml` and drop `ports:`.
  The server then binds the NAS's interfaces directly on `DSH_LISTEN_PORT`
  (default 3080); `DSH_HOST=127.0.0.1` narrows it to loopback again.
- **Reverse proxy / HTTPS**: the proxy must preserve the browser-visible
  `Host` header and forward WebSocket upgrades; add the public host name to
  `DSH_TRUSTED_HOST`. The printed login URL is the container's — replace its
  host with the public one when logging in the first time.

**HTTPS is recommended, not required.** The UI works over plain
`http://<LAN IP>` on this dsh release, but the page is not a secure context
there: API keys and secret values you type cross the LAN in clear text. Put a
reverse proxy in front for regular use.

## Environment variables

In the root `docker-compose.yml`, edit container variables under `environment`,
the published port under `ports`, and host directories under `volumes`.
The alternative `docker/compose.yml` reads these settings from `.env`;
see `docker/.env.example` for its full list. The main variables are:

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | API key for the model endpoint |
| `DEEPSEEK_BASE_URL` | Override the endpoint (Anthropic-Messages-compatible) |
| `DSH_TRUSTED_HOST` | Comma-separated host names / IPs the UI answers to |
| `DSH_PORT` | Alternative `.env` deployment's host port (default 3080); edit `ports` directly in the root Compose file |
| `DSH_HOST` | Bind address: `0.0.0.0` (default) or `127.0.0.1`; only relevant with `network_mode: host` |
| `DSH_LISTEN_PORT` | Listen port inside the container (default 3080); only relevant with `network_mode: host` |
| `PUID` / `PGID` | User/group the server runs as and new files belong to |
| `DSH_TELEMETRY_DISABLED` | `1` turns off dsh's anonymous telemetry |

Extra `dsh` CLI flags can be appended to the container command.

## Custom model endpoint

For an OpenAI-compatible relay (or another provider DSH speaks), create
`DATA_DIR/cordis.patch.yml` before the first start — DSH's home-level patch
layer, applied after the profile's own — with an `llm-pi-ai` provider and an
`agent-default-model` row, and pass the key as an env var:

```yaml
- id: llm-pi-ai
  config:
    providers:
      relay:
        apiKeyEnv: RELAY_API_KEY
        api: openai-completions          # or openai-responses / anthropic-messages
        baseURL: http://host.docker.internal:3425/v1
        models:
          - id: my-model
            contextWindow: 131072
            maxTokens: 8192
# New Bots made from the Create Bot form start on DSH's default model;
# point it at the relay too, or they start on deepseek-official without a key.
- id: agent-default-model
  config:
    provider: relay
    model: my-model
```

Add `RELAY_API_KEY` under `environment` in the root Compose file, or to `.env`
for the alternative deployment. The alternative is Settings → Models in the
UI, which writes the same config.

## Data

- `/data` (`DATA_DIR`) is `DSH_HOME`: the team and chats (`bot/`, `sessions/`),
  profiles, settings and the login cookie key (`.credentials.yaml`).
- `/workspace` (`WORKSPACE_DIR`) is the team workspace where the Bots work.

A rebuild reuses the persisted data and workspace. Keep their container
destinations `/data` and `/workspace` unchanged when you rebuild or move the
host directories; the team records those destinations, not the host paths.

**Backup**: stop the container, then copy both `DATA_DIR` and `WORKSPACE_DIR`.
Restore by putting both folders back and starting again.

On every start, entries in `/data` with a different owner or group are assigned
to `PUID`/`PGID`, including existing profiles and restored files. This scans the
data directory, so large histories can take longer to start. It does not follow
symbolic links or descend into other filesystems. A populated `/workspace` keeps
its ownership; if you change `PUID`/`PGID`, grant the new user access to that
share on the host.

## Updating

```sh
docker compose build   # or: docker build -f docker/Dockerfile -t ds-bot:local .
docker compose up -d
```

A rebuild changes the image and the DSH it contains. An existing persisted
profile is reused, and the entrypoint does not manage plugin upgrades. The
image is built and tested with dsh `0.2.0-rc.2`, the version
DS Bot is verified with; a `DSH_VERSION` build arg exists, but other releases
are untested and newer ones change how the server binds.

## Prebuilt image

GitHub Actions publishes the image to GHCR after the branch CI succeeds:
`main` as `latest`, `dev` as `dev`, and every successful push also as
`sha-<full commit SHA>`. Only the tested linux/amd64 image is published. The
first publication happens only after this workflow is merged and a push
succeeds. The maintainer must set the GHCR package visibility to Public once
before anonymous pulls work.

Save this as `compose.yml` in the directory you want to deploy from. Fill in
the API key and your NAS host names before starting it. Running these commands
from the repository root would use the local root Compose file instead.

```yaml
services:
  ds-bot:
    image: ghcr.io/fei2411/ds-bot:dev
    ports:
      - "13080:3080"
    environment:
      DEEPSEEK_API_KEY: ""
      PUID: "1000"
      PGID: "1000"
      DSH_TRUSTED_HOST: "localhost,127.0.0.1"
    volumes:
      - ./data:/data
      - ./workspace:/workspace
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped
    stop_grace_period: 15s
```

```sh
docker compose pull
docker compose up -d
```

The root `docker-compose.yml` and `docker/compose.yml` still build the local
image. Choose one setup; do not run both against the same data directory. An
existing persisted profile is not upgraded automatically.

## Limits

- No Bot browser / `read_browser` tool: those exist in dsh Desktop and the
  desktop app only.
- Over plain http, API keys and secret values you type cross the network in
  clear text — use HTTPS off-box (see [Network](#network)).
- Full access is the only permission mode: a Bot can change everything the
  container can see.

## Testing

After building the image, run `node docker/test.mjs ds-bot:local` from the
repository root. The test uses isolated, network-disabled containers and
temporary Docker volumes, with no host directory mounts or model calls. It
checks entrypoint permissions, first start, UID/GID changes, restored files,
workspace ownership and web startup. All test containers and volumes are
removed when it finishes.
CI builds the image from the Linux checkout and runs this test as part of the
required Test result check.
