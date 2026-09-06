#!/usr/bin/env bash
# Install and start the player as a systemd user service.
#   scripts/install-service.sh            # picks a free port starting at 8420
#   scripts/install-service.sh 9000       # uses port 9000
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/webplayer.service"

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

if [[ -n "${1:-}" ]]; then
  PORT="$1"
else
  PORT=8420
  while ! port_free "$PORT"; do PORT=$((PORT + 1)); done
fi

mkdir -p "$UNIT_DIR"
sed -e "s|__DIR__|$DIR|g" -e "s|__PORT__|$PORT|g" -e "s|__NODE__|$NODE|g" \
  "$DIR/webplayer.service" > "$UNIT"

systemctl --user daemon-reload
systemctl --user enable --now webplayer.service
systemctl --user restart webplayer.service

echo "webplayer is running on http://127.0.0.1:$PORT"
echo "unit: $UNIT"
echo "logs: journalctl --user -u webplayer -f"
