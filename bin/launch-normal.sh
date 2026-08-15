#!/usr/bin/env bash
# Switch Claude Desktop to Normal (OAuth / 1P) mode.
# Stops the proxy, quits Claude, sets deploymentMode=1p, relaunches.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/.."
. "$ROOT/bin/_claude-app.sh"

echo "→ Stopping proxy server..."
"$ROOT/bin/stop.sh" || true

echo "→ Quitting Claude Desktop..."
quit_claude

echo "→ Setting deploymentMode to 1p..."
set_deployment_mode 1p

echo "→ Relaunching Claude Desktop..."
launch_claude
echo "✓ Claude Desktop launched (Normal mode)"
