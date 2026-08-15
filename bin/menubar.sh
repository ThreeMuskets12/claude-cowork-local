#!/usr/bin/env bash
# Build and run the macOS Menu Bar status item.
set -euo pipefail

# Resolve to a canonical path: the trailing "/.." would otherwise leak into
# APP_BIN and stop pgrep from matching the running process (which reports its
# real, resolved path).
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." && pwd)"
BIN_DIR="$ROOT/bin"
SWIFT_SRC="$BIN_DIR/menubar.swift"
APP_DIR="$BIN_DIR/CoworkMenu.app"
APP_BIN="$APP_DIR/Contents/MacOS/CoworkMenu"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"

cat > "$APP_DIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>CoworkMenu</string>
    <key>CFBundleIdentifier</key>
    <string>com.noahpage.coworkmenu</string>
    <key>CFBundleName</key>
    <string>CoworkMenu</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

if [ ! -f "$APP_BIN" ] || [ "$SWIFT_SRC" -nt "$APP_BIN" ]; then
  echo "→ Compiling menu bar app with swiftc..."
  swiftc -O -target arm64-apple-macosx14.0 "$SWIFT_SRC" -o "$APP_BIN"
fi

# Stop any previous instance and wait for it to actually exit. `open` on a
# bundle that is still running re-activates it rather than starting the new
# binary, so a fixed sleep here would silently keep the old build alive.
PIDS="$(pgrep -f "$APP_BIN" || true)"
if [ -n "$PIDS" ]; then
  echo "→ Stopping previous instance (PID: $PIDS)..."
  kill $PIDS 2>/dev/null || true
  for _ in $(seq 1 20); do            # up to 5s
    pgrep -f "$APP_BIN" >/dev/null 2>&1 || break
    sleep 0.25
  done
  if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    kill -9 $(pgrep -f "$APP_BIN") 2>/dev/null || true
    sleep 0.5
  fi
fi

open "$APP_DIR"

# Confirm it actually came up rather than reporting success blindly.
for _ in $(seq 1 20); do
  if pgrep -f "$APP_BIN" >/dev/null 2>&1; then
    echo "✓ CoworkMenu.app launched (PID: $(pgrep -f "$APP_BIN" | tr '\n' ' '))"
    exit 0
  fi
  sleep 0.25
done

echo "✗ CoworkMenu.app did not start"
echo "  try running it directly to see the error:"
echo "  $APP_BIN"
exit 1
