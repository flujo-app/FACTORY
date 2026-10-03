#!/bin/sh
set -eu
umask 077
if [ "${1-}" = capacity-broker ]; then
  shift
  exec node /app/bin/capacity.mjs broker "$@"
fi
exec node /app/bin/native-cell.mjs "$@"
