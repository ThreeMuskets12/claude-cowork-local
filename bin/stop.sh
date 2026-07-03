#!/usr/bin/env bash
# Stop the local proxy worker.
set -euo pipefail

PROXY_PORT="${PROXY_PORT:-8787}"

PIDS="$(ps -ef | awk '/[b]un .*server\.ts/ {print $2}')"
if [ -z "$PIDS" ]; then
  echo "no worker process found"
  exit 0
fi

echo "killing: $PIDS"
echo "$PIDS" | xargs -r kill -9 2>/dev/null || true
sleep 0.3

if ss -tln 2>/dev/null | grep -q ":$PROXY_PORT " || netstat -tln 2>/dev/null | grep -q ":$PROXY_PORT "; then
  echo "✗ port $PROXY_PORT still bound:"
  ss -tlnp 2>/dev/null | grep ":$PROXY_PORT " || netstat -tlnp 2>/dev/null | grep ":$PROXY_PORT "
  exit 1
fi

echo "✓ worker stopped"
