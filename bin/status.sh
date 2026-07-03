#!/usr/bin/env bash
# Show worker status: process, port, recent log.
PROXY_PORT="${PROXY_PORT:-8787}"
LOG_DIR="${XDG_LOG_HOME:-$HOME/.local/log}/claude-cowork-local"
LOG_FILE="$LOG_DIR/worker.log"

echo "── process ──"
ps -ef | awk '/[b]un .*server\.ts/ {printf "  pid=%s  ppid=%s  cmd=%s\n", $2, $3, substr($0, index($0,$8))}'

echo "── port :$PROXY_PORT ──"
if ss -tln 2>/dev/null | grep -q ":$PROXY_PORT "; then
  ss -tlnp 2>/dev/null | grep ":$PROXY_PORT " | sed 's/^/  /'
elif netstat -tln 2>/dev/null | grep -q ":$PROXY_PORT "; then
  netstat -tlnp 2>/dev/null | grep ":$PROXY_PORT " | sed 's/^/  /'
else
  echo "  not listening"
fi

echo "── log (last 20 lines) ──"
if [ -f "$LOG_FILE" ]; then
  tail -n 20 "$LOG_FILE" | sed 's/^/  /'
else
  echo "  (no log file yet)"
fi
