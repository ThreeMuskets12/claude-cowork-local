#!/usr/bin/env bash
# Start the local proxy worker. Idempotent: returns 0 if already running.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/.."
WORKER_DIR="$ROOT/worker"
LOG_DIR="${XDG_LOG_HOME:-$HOME/.local/log}/claude-cowork-local"
PROXY_PORT="${PROXY_PORT:-8787}"

mkdir -p "$LOG_DIR"

# Already running?
if ss -tln 2>/dev/null | grep -q ":$PROXY_PORT " || netstat -tln 2>/dev/null | grep -q ":$PROXY_PORT "; then
  echo "✓ worker already listening on :$PROXY_PORT"
  exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
fi

if [ ! -d "$WORKER_DIR/node_modules" ]; then
  echo "→ installing worker deps (first run)"
  (cd "$WORKER_DIR" && bun install --production 2>&1 | tail -2)
fi

# Detach via subshell so the shell tool/process doesn't wait on the child.
(nohup bun "$WORKER_DIR/src/server.ts" >"$LOG_DIR/worker.log" 2>&1 </dev/null &)

# Wait for the port to come up (max 5s)
for i in {1..10}; do
  if ss -tln 2>/dev/null | grep -q ":$PROXY_PORT " || netstat -tln 2>/dev/null | grep -q ":$PROXY_PORT "; then
    echo "✓ worker started on http://localhost:$PROXY_PORT (log: $LOG_DIR/worker.log)"
    exit 0
  fi
  sleep 0.5
done

echo "✗ worker did not bind :$PROXY_PORT within 5s"
echo "  tail of $LOG_DIR/worker.log:"
tail -10 "$LOG_DIR/worker.log" || true
exit 1
