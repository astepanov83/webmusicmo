#!/usr/bin/env bash
# Stop and remove the systemd user service.
set -euo pipefail
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/webplayer.service"
systemctl --user disable --now webplayer.service 2>/dev/null || true
rm -f "$UNIT"
systemctl --user daemon-reload
echo "webplayer service removed"
