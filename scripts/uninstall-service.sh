#!/usr/bin/env bash
# Stop and remove the systemd user service and the refresh timer.
set -euo pipefail
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/webmusicmo.service"
REFRESH_UNIT="$UNIT_DIR/webmusicmo-refresh.service"
REFRESH_TIMER="$UNIT_DIR/webmusicmo-refresh.timer"
systemctl --user disable --now webmusicmo.service 2>/dev/null || true
systemctl --user disable --now webmusicmo-refresh.timer 2>/dev/null || true
rm -f "$UNIT" "$REFRESH_UNIT" "$REFRESH_TIMER"
systemctl --user daemon-reload
echo "webmusicmo service removed"
