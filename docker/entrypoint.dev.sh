#!/bin/sh
# Run dsh web from the mounted checkout. The data layout, permissions and
# network trust settings match the release image; the supervisor owns reloads.
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi
# Restore ownership after a PUID/PGID change or a backup restore. Stay on the
# data filesystem and leave symlink targets in workspace shares untouched.
find -P /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
  -exec chown -h node:node -- {} +

# A checkout can carry host-specific native binaries. This named volume holds
# the matching Linux dependencies instead.
if [ ! -d /app/ds-bot/node_modules/esbuild ]; then
  mkdir -p /app/ds-bot/node_modules
  cp -a /opt/ds-bot-deps/node_modules/. /app/ds-bot/node_modules/
fi

mkdir -p /workspace
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi

# DSH 0.2.2 requires a concrete listen address. The existing wildcard setting
# selects the container's address; the published port is the network boundary.
HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
case "$HOST" in
  0.0.0.0|127.0.0.1) ;;
  *) echo "entrypoint: DSH_HOST must be 0.0.0.0 or 127.0.0.1 (got '$HOST')" >&2; exit 1 ;;
esac
if [ "$HOST" = "0.0.0.0" ]; then
  HOST=$(hostname -i 2>/dev/null | awk '{print $1}')
  # A network-disabled container has loopback only.
  HOST=${HOST:-127.0.0.1}
fi
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

cat > /tmp/listen.patch.yml <<EOF
- id: webserver
  config:
    host: $HOST
    port: $LISTEN_PORT
    compression: gzip
    compressionLevel: 1
    compressionThresholdBytes: 1024
EOF

set -- dsh --profile web \
  --patch /opt/ds-bot/docker.patch.yml --patch /tmp/listen.patch.yml \
  --no-open "$@"

if [ -n "${DSH_TRUSTED_HOST:-}" ]; then
  old_ifs=$IFS
  IFS=','
  for trusted in $DSH_TRUSTED_HOST; do
    [ -n "$trusted" ] && set -- "$@" --trusted-host "$trusted"
  done
  IFS=$old_ifs
fi

export HOME=/home/node
cd /workspace
exec gosu node /opt/ds-bot/dev-supervisor.mjs "$@"
