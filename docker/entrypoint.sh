#!/bin/sh
# Runs dsh web as the node user. The container is the sandbox boundary, so the
# image offers only the danger-full-access preset (see docker.patch.yml).
set -eu

PUID=${PUID:-1000}
PGID=${PGID:-1000}
groupmod -o -g "$PGID" node
usermod -o -u "$PUID" node

# First start: seed the data volume with the template home built into the image
# (a web profile that already has ds-bot installed).
if [ ! -d /data/profiles/web ]; then
  mkdir -p /data
  cp -a /opt/dsh-template/. /data/
fi

# A development container links the plugin to its source mount. Restore the
# release dependency tree before that mount disappears, keeping the profile data.
PROFILE=/data/profiles/web
if [ -f "$PROFILE/package.json.release" ]; then
  cp "$PROFILE/package.json.release" "$PROFILE/package.json"
  if [ -f "$PROFILE/pnpm-lock.yaml.release" ]; then
    cp "$PROFILE/pnpm-lock.yaml.release" "$PROFILE/pnpm-lock.yaml"
  else
    rm -f "$PROFILE/pnpm-lock.yaml"
  fi
  rm -rf "$PROFILE/node_modules/ds-bot"
  if [ -d "$PROFILE/ds-bot.release" ]; then
    mv "$PROFILE/ds-bot.release" "$PROFILE/node_modules/ds-bot"
  else
    cp -a /opt/dsh-template/profiles/web/node_modules/ds-bot "$PROFILE/node_modules/ds-bot"
  fi
  rm -f "$PROFILE/package.json.release" "$PROFILE/pnpm-lock.yaml.release"
fi

# Existing profiles and restored backups can belong to a previous PUID/PGID.
# Do not follow links into workspace shares or descend into other filesystems.
find -P /data -xdev \( ! -uid "$PUID" -o ! -gid "$PGID" \) \
  -exec chown -h node:node -- {} +

mkdir -p /workspace
# Only claim an empty /workspace; a populated share keeps its owners.
if [ -z "$(ls -A /workspace)" ]; then
  chown node:node /workspace
fi

# DSH 0.2.2 binds one concrete address and rejects the wildcard. Keep the
# existing 0.0.0.0 setting as the default, but translate it to the container's
# address; the publish rule remains the network boundary. DSH_LISTEN_PORT only
# matters with network_mode: host — published ports always map to 3080 inside.
HOST=${DSH_HOST:-0.0.0.0}
LISTEN_PORT=${DSH_LISTEN_PORT:-3080}
if [ "$HOST" = "0.0.0.0" ]; then
  HOST=$(hostname -i 2>/dev/null | awk '{print $1}')
  # An isolated network can have no hostname address; loopback keeps the
  # network-disabled regression and other local-only uses working.
  HOST=${HOST:-127.0.0.1}
fi
case "$LISTEN_PORT" in
  ''|*[!0-9]*) echo "entrypoint: DSH_LISTEN_PORT must be a port number (got '$LISTEN_PORT')" >&2; exit 1 ;;
esac

# --patch is a dsh option and must precede the app's own flags.
set -- dsh --profile web \
  --patch /opt/ds-bot/docker.patch.yml --no-open \
  --host "$HOST" --port "$LISTEN_PORT" "$@"

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
exec gosu node "$@"
