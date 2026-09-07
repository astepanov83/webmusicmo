#!/usr/bin/env bash
# Stop and remove the systemd user service.
set -euo pipefail
UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/webmusicmo.service"
systemctl --user disable --now webmusicmo.service 2>/dev/null || true
rm -f "$UNIT"
systemctl --user daemon-reload
echo "webmusicmo service removed"
