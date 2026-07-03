#!/usr/bin/env bash
# Tail the worker log.
LOG_DIR="${XDG_LOG_HOME:-$HOME/.local/log}/claude-cowork-local"
LOG_FILE="$LOG_DIR/worker.log"
if [ ! -f "$LOG_FILE" ]; then
  echo "no log file at $LOG_FILE (worker never started?)"
  exit 1
fi
exec tail -n +1 -F "$LOG_FILE"
