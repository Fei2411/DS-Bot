# DS Bot source development in Docker

This Compose override runs the checkout on disk with the DSH 0.2.2 toolchain.
Frontend source changes rebuild the browser bundles; host source changes restart
DSH. The development image stays local and is separate from the GHCR release.

## Start

From the repository root:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f ds-bot
```

The base Compose file supplies the port, model environment and persistent data
mounts. Add your existing local override between those two files when you keep
keys there:

```sh
docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f docker-compose.dev.yml up -d --build
```

Use the same file list with `stop`, `down` and `logs`. A fresh `docker/data`
is initialized from the image; an existing one keeps the team, chats, settings
and browser login key. Bookmark the root URL without the process token: the
signed browser cookie survives restarts.

## Source reload

The checkout is mounted at `/app/ds-bot`, and the web profile links to it with
`link:/app/ds-bot`. `docker/dev-supervisor.mjs` polls the source every 1.5
seconds, which also works with Docker Desktop bind mounts.

- `src/client/`, `src/office/` and `src/shared/`: rebuild `client.js`
  and `office.js`; refresh the browser to load the new bundle.
- `src/host/`, `src/shared/`, `index.js`, `web-search.js`,
  `package.json` and `cordis.patch.yml`: restart DSH to load the new host
  code. The restart interrupts a turn that is running.
- The generated bundles are written in the checkout, so the host and container
  use the same files. Every development start builds them before DSH starts,
  including edits made while the container was stopped.

The checkout's `node_modules` is masked by a named volume and populated with
Linux dependencies from the image. This keeps a Windows or macOS checkout's
native binaries out of the container. After changing `package-lock.json`,
recreate the development image and the `ds-bot-dev-modules` volume to refresh
those dependencies.

## Data and release switching

The first development start saves the profile's release manifest, lockfile and
installed dependency tree, then links the profile to the checkout. To return the
same data directory to the release image, stop the development container and
start the release Compose setup. Its entrypoint restores those saved files,
including additional installed plugins, before starting DSH.

Use one container with a given data directory at a time. The supervisor removes
a team lock left by a previous container whose hostname differs, which covers
container recreation and Docker's process ID reuse.

## Checks

Build and exercise fresh startup, profile linking, HTTP service, frontend
rebuilds and host restarts:

```sh
docker build -f docker/Dockerfile -t ds-bot:local .
docker build -f docker/Dockerfile.dev -t ds-bot:dev .
node docker/test-dev.mjs ds-bot:dev ds-bot:local
```

The test copies the plugin to a temporary directory and uses isolated,
network-disabled containers and temporary volumes. Development startup reuses
the installed dependency tree, including local plugins whose original archives
are absent. The test makes no model calls and removes its resources when it
finishes. The release image continues to use `docker/test.mjs`.
