#!/bin/sh
# Refresh the station list once a day in the background, then run the server.
# REFRESH_HOURS=0 turns the loop off.
set -e
hours="${REFRESH_HOURS:-24}"
if [ "$hours" != "0" ]; then
  (
    while true; do
      node scripts/refresh.js || echo "refresh failed"
      sleep $((hours * 3600))
    done
  ) &
fi
exec node server.js
