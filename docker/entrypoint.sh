#!/bin/sh
# Runs synapse as PUID:PGID so files in the mounted vault belong to you, not root.
set -e
# the image ships exactly one model in /app/models/<name>
[ -z "$SYNAPSE_MODEL" ] && SYNAPSE_MODEL="$(find /app/models -mindepth 1 -maxdepth 1 -type d | head -n1)" && export SYNAPSE_MODEL
mkdir -p /data/vault
if [ "$(id -u)" = 0 ] && [ "$1" = synapse ]; then
  # may fail on Windows/macOS bind mounts – harmless there
  chown "$PUID:$PGID" /data /data/vault 2>/dev/null || true
  [ -e "$SYNAPSE_DB" ] && { chown "$PUID:$PGID" "$SYNAPSE_DB"* 2>/dev/null || true; }
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
