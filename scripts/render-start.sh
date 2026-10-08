#!/bin/sh
set -eu

# Render supplies the hostname; an explicit URL takes precedence for custom domains.
export SYNIXIR_PUBLIC_URL="${SYNIXIR_PUBLIC_URL:-https://${RENDER_EXTERNAL_HOSTNAME:?RENDER_EXTERNAL_HOSTNAME or SYNIXIR_PUBLIC_URL is required}}"

/app/bin/synixir eval 'Synixir.Release.native_check(); Synixir.Release.migrate()'
exec /app/bin/synixir start
