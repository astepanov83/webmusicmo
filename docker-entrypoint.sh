#!/bin/sh
# Refresh the station list once a day in the background, then run the server.
# REFRESH_HOURS=0 turns the loop off.
set -e
hours="${REFRESH_HOURS:-24}"
# A bad value must not quietly stop the refresh for the life of the container, so fall
# back to the default and say so where the operator will see it in the container log.
case "$hours" in
  ''|*[!0-9]*)
    echo "REFRESH_HOURS=$hours is not a whole number of hours, using 24"
    hours=24
    ;;
esac
if [ "$hours" != "0" ]; then
  (
    while true; do
      node scripts/refresh.js || echo "refresh failed"
      sleep $((hours * 3600))
    done
  ) &
fi
exec node server.js
