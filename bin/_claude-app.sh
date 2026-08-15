#!/usr/bin/env bash
# Shared helpers for quitting/relaunching Claude Desktop.
# Sourced by launch-gateway.sh and launch-normal.sh.

CLAUDE_APP="/Applications/Claude.app"

# PID of the main Electron process, or empty.
# Uses ps (not pgrep): BSD pgrep excludes the caller's own ancestors, so it
# returns nothing when this script is run from a terminal inside Claude Desktop.
claude_main_pid() {
  ps -axo pid=,ucomm= | awk '{
    pid = $1; $1 = ""
    sub(/^ +/, ""); sub(/ +$/, "")
    if ($0 == "Claude") print pid
  }'
}

# Quit Claude Desktop and block until the process is really gone.
# Graceful AppleScript quit first, then SIGTERM, then SIGKILL.
quit_claude() {
  if [ -z "$(claude_main_pid)" ]; then
    echo "  Claude Desktop is not running"
    return 0
  fi

  echo "  asking Claude Desktop to quit..."
  osascript -e 'tell application "Claude" to quit' >/dev/null 2>&1 || true

  for _ in $(seq 1 40); do          # up to 10s
    [ -z "$(claude_main_pid)" ] && { echo "  quit cleanly"; return 0; }
    sleep 0.25
  done

  local pid
  pid="$(claude_main_pid)"
  echo "  still running (pid $pid) — sending SIGTERM"
  kill -TERM $pid 2>/dev/null || true

  for _ in $(seq 1 12); do          # up to 3s
    [ -z "$(claude_main_pid)" ] && { echo "  terminated"; return 0; }
    sleep 0.25
  done

  pid="$(claude_main_pid)"
  echo "  unresponsive (pid $pid) — sending SIGKILL"
  kill -9 $pid 2>/dev/null || true

  for _ in $(seq 1 12); do
    [ -z "$(claude_main_pid)" ] && { echo "  killed"; return 0; }
    sleep 0.25
  done

  echo "  ✗ could not stop Claude Desktop (pid $(claude_main_pid))"
  return 1
}

# Set deploymentMode in both profile configs. Must run *after* quit_claude,
# since Claude rewrites claude_desktop_config.json as it shuts down.
set_deployment_mode() {
  MODE="$1" python3 - <<'PY'
import json, os

mode = os.environ["MODE"]
paths = [
    os.path.expanduser("~/Library/Application Support/Claude/claude_desktop_config.json"),
    os.path.expanduser("~/Library/Application Support/Claude-3p/claude_desktop_config.json"),
]

for p in paths:
    if not os.path.exists(p):
        continue
    try:
        with open(p) as f:
            data = json.load(f)
        data["deploymentMode"] = mode
        with open(p, "w") as f:
            json.dump(data, f, indent=2)
    except Exception as e:
        print(f"  warn: could not update {p}: {e}")
PY
}

launch_claude() {
  open -a "$CLAUDE_APP"
}
