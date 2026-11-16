#!/bin/sh
# Shell entry point for the TimeMachine API shell.
#
# Everything is delegated to scripts/tm-api/cli.mjs; this wrapper exists so the
# command can live in package.json and be called with a stable name. It passes
# arguments through unchanged and never interpolates them into a shell string.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$here/tm-api/cli.mjs" "$@"
