#!/usr/bin/env bash
# Switch Claude Desktop to Gateway (3P) mode.
# Starts the proxy, quits Claude, sets deploymentMode=3p, relaunches.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/.."
. "$ROOT/bin/_claude-app.sh"

echo "→ Ensuring proxy server is started..."
"$ROOT/bin/start.sh"

echo "→ Quitting Claude Desktop..."
quit_claude

echo "→ Setting deploymentMode to 3p..."
set_deployment_mode 3p

echo "→ Relaunching Claude Desktop..."
launch_claude
echo "✓ Claude Desktop launched (Gateway mode)"
