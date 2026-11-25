#!/usr/bin/env bash
# Installs nodo-agent (panel included) as a systemd service. Run as root from the unpacked folder.
# Usage: ./install.sh [port] [name]      defaults: 9980 nodo
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root (sudo ./install.sh)"; exit 1; }
here="$(cd "$(dirname "$0")" && pwd)"
port="${1:-9980}"
name="${2:-nodo}"

install -m 0755 "$here/nodo-agent" /usr/bin/nodo-agent
/usr/bin/nodo-agent init "$port" "$name"
systemctl daemon-reload
systemctl enable --now "$name"
echo
echo "Panel: http://<this-server>:$port"
echo "API token: $(cat "/etc/nodo/$name/token")"
