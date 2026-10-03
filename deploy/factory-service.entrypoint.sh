#!/bin/sh
set -eu
umask 077
exec node /app/bin/native-cell.mjs "$@"
