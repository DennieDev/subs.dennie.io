#!/bin/sh
set -e
# Docker creates a missing bind-mount directory as root; hand it to the node user.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi
exec "$@"
