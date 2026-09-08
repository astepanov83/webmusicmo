#!/usr/bin/env bash
# Install and start the player as a systemd user service, plus a daily refresh timer.
#   scripts/install-service.sh            # picks a free port starting at 8420
#   scripts/install-service.sh 9000       # uses port 9000
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/webmusicmo.service"
REFRESH_UNIT="$UNIT_DIR/webmusicmo-refresh.service"
REFRESH_TIMER="$UNIT_DIR/webmusicmo-refresh.timer"
# A writable path outside the repo, so the refresh never dirties the tracked seed file and
# blocks "git pull". Must stay in step with the %h/.local/state/webmusicmo path in both
# webmusicmo.service and webmusicmo-refresh.service.
STATE_DIR="$HOME/.local/state/webmusicmo"
STATE_STATIONS_FILE="$STATE_DIR/stations.json"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [[ -n "${1:-}" ]]; then
  PORT="$1"
elif [[ -f "$UNIT" ]] && grep -q '^Environment=PORT=' "$UNIT"; then
  # Re-install: keep the port the service already uses.
  PORT="$(sed -n 's/^Environment=PORT=//p' "$UNIT")"
else
  PORT=8420
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); done
fi

mkdir -p "$UNIT_DIR"
sed -e "s|__DIR__|$DIR|g" -e "s|__PORT__|$PORT|g" -e "s|__NODE__|$NODE|g" \
  "$DIR/webmusicmo.service" > "$UNIT"
sed -e "s|__DIR__|$DIR|g" -e "s|__NODE__|$NODE|g" "$DIR/webmusicmo-refresh.service" > "$REFRESH_UNIT"
cp "$DIR/webmusicmo-refresh.timer" "$REFRESH_TIMER"

# Seed the state directory from the committed list so a first install has a full station
# list even when SomaFM is unreachable, then refresh into that same writable path rather
# than the repository copy.
mkdir -p "$STATE_DIR"
if [[ ! -f "$STATE_STATIONS_FILE" ]]; then
  cp "$DIR/public/stations.json" "$STATE_STATIONS_FILE"
fi

# First refresh, so the page has something to show. A failure still leaves the seed file.
STATIONS_FILE="$STATE_STATIONS_FILE" "$NODE" "$DIR/scripts/refresh.js" || true

systemctl --user daemon-reload
systemctl --user enable --now webmusicmo.service
systemctl --user restart webmusicmo.service
systemctl --user enable --now webmusicmo-refresh.timer

echo "webmusicmo is running on http://127.0.0.1:$PORT"
echo "unit: $UNIT"
echo "logs: journalctl --user -u webmusicmo -f"
echo "refresh timer: systemctl --user list-timers webmusicmo-refresh.timer"
