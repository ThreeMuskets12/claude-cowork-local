#!/usr/bin/env bash
# claude-cowork-local installer
# Sets up a local Anthropic→OpenAI translation proxy and Claude Code settings
# for using OpenRouter (default), free Zen models, and OpenCode Go in Claude Code CLI.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$ROOT/worker"
SETTINGS_DIR="$ROOT/settings"
CLAUDE_DIR="$HOME/.claude"
LOG_DIR="${XDG_LOG_HOME:-$HOME/.local/log}/claude-cowork-local"
PROXY_PORT="${PROXY_PORT:-8787}"

OPENROUTER_KEY="${OPENROUTER_KEY:-}"
ZEN_KEY="${ZEN_KEY:-}"
GO_KEY="${GO_KEY:-}"
SKIP_SYSTEMD=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || { red "missing: $1"; exit 1; }
}

prompt_secret() {
  local var_name="$1" prompt="$2" current="${!1:-}"
  if [ -n "$current" ]; then
    printf '%s [%s***%s]: ' "$prompt" "${current:0:7}" "${current: -3}"
  else
    printf '%s: ' "$prompt"
  fi
  read -r input
  if [ -n "$input" ]; then
    eval "$var_name=\$input"
  fi
}

# ---------- 1. Bun ----------
ensure_bun() {
  if command -v bun >/dev/null 2>&1; then
    green "✓ bun $(bun --version)"
    return
  fi
  yellow "bun not found, installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    red "bun install failed"; exit 1
  fi
  green "✓ bun $(bun --version)"
}

# ---------- 2. Worker deps ----------
install_worker_deps() {
  blue "→ installing worker deps (hono only)..."
  (cd "$WORKER_DIR" && bun install --production 2>&1 | tail -3)
  green "✓ worker deps installed"
}

# ---------- 3. Keys ----------
collect_keys() {
  echo
  blue "── API keys ─────────────────────────────────────────"
  echo "  - OpenRouter key (default provider): https://openrouter.ai/keys"
  echo "    Used for GLM 5.2 (fastest provider) and Claude Sonnet 5 vision."
  echo
  echo "  - Zen workspace key (optional). Free models"
  echo "    work even without a payment method; paid models need a card."
  echo
  echo "  - Go key: same as Zen key. Required only for the /go profile (paid Go models)."
  echo "    Press Enter to skip any of them."
  echo
  prompt_secret OPENROUTER_KEY "OpenRouter key (sk-or-…)"
  prompt_secret ZEN_KEY "Zen key (sk-…)"
  if [ -z "$GO_KEY" ]; then GO_KEY="$ZEN_KEY"; fi
  prompt_secret GO_KEY  "Go key (defaults to Zen key)"
}

# ---------- 4. Settings files ----------
write_settings() {
  blue "→ writing settings to $CLAUDE_DIR/"
  mkdir -p "$CLAUDE_DIR"

  for profile in openrouter zen go; do
    src="$SETTINGS_DIR/settings.$profile.template.json"
    dst="$CLAUDE_DIR/settings.$profile.json"
    if [ ! -f "$src" ]; then
      yellow "skipping $profile (template missing)"; continue
    fi
    if [ "$profile" = "openrouter" ] && [ -z "$OPENROUTER_KEY" ]; then
      yellow "skipping $profile (no OPENROUTER_KEY)"; continue
    fi
    if [ "$profile" = "zen" ] && [ -z "$ZEN_KEY" ]; then
      yellow "skipping $profile (no ZEN_KEY)"; continue
    fi
    if [ "$profile" = "go" ] && [ -z "$GO_KEY" ]; then
      yellow "skipping $profile (no GO_KEY)"; continue
    fi

    sed \
      -e "s|REPLACE_WITH_YOUR_OPENROUTER_KEY|$OPENROUTER_KEY|g" \
      -e "s|REPLACE_WITH_YOUR_ZEN_WORKSPACE_KEY|$ZEN_KEY|g" \
      "$src" > "$dst"
    chmod 600 "$dst"
    green "✓ $dst"
  done
}

# ---------- 5. Symlink bin scripts ----------
install_bin() {
  blue "→ installing bin scripts to ~/.local/bin/"
  mkdir -p "$HOME/.local/bin"
  for f in start stop status log; do
    ln -sf "$ROOT/bin/$f.sh" "$HOME/.local/bin/cowork-$f"
  done
  green "✓ cowork-start / cowork-stop / cowork-status / cowork-log"
}

# ---------- 6. Systemd (optional) ----------
install_systemd() {
  command -v systemctl >/dev/null 2>&1 || { yellow "no systemd, skipping"; return; }
  [ -w /etc/systemd/system ] 2>/dev/null || SKIP_SYSTEMD=1
  if [ "$SKIP_SYSTEMD" = "1" ]; then yellow "no systemd permissions, skipping"; return; fi

  blue "→ installing systemd unit"
  local unit=/etc/systemd/system/claude-cowork-local.service
  cat > "$unit" <<EOF
[Unit]
Description=claude-cowork-local (Anthropic→OpenAI bridge for Claude Code)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$WORKER_DIR
ExecStart=$HOME/.bun/bin/bun $WORKER_DIR/src/server.ts
Restart=always
RestartSec=3
Environment=PORT=$PROXY_PORT
StandardOutput=append:$LOG_DIR/worker.log
StandardError=append:$LOG_DIR/worker.log

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now claude-cowork-local.service
  green "✓ systemd unit installed and started"
}

# ---------- 7. Start + smoke test ----------
start_and_test() {
  "$ROOT/bin/start.sh" || true
  sleep 1
  echo
  blue "── smoke test ────────────────────────────────────────"
  if curl -sS -m 3 "http://localhost:$PROXY_PORT/" -o /dev/null -w "root → HTTP %{http_code}\n"; then :; fi
}

# ---------- main ----------
main() {
  blue "claude-cowork-local installer"
  echo "  ROOT:        $ROOT"
  echo "  PROXY_PORT:  $PROXY_PORT"
  echo

  need_cmd curl
  ensure_bun
  install_worker_deps
  collect_keys
  write_settings
  install_bin

  if [ "${1:-}" != "--no-systemd" ]; then
    install_systemd
  fi

  start_and_test

  echo
  green "── done ─────────────────────────────────────────────"
  echo "  Start worker:    cowork-start     (or: $ROOT/bin/start.sh)"
  echo "  Stop worker:     cowork-stop      (or: $ROOT/bin/stop.sh)"
  echo "  Worker status:   cowork-status    (or: $ROOT/bin/status.sh)"
  echo "  Worker log:      cowork-log       (or: tail -f $LOG_DIR/worker.log)"
  echo
  echo "  Run Claude Code with a profile:"
  echo "    claude --settings $CLAUDE_DIR/settings.openrouter.json   (default: GLM 5.2 via OpenRouter)"
  echo "    claude --settings $CLAUDE_DIR/settings.zen.json"
  echo "    claude --settings $CLAUDE_DIR/settings.go.json"
  echo
  echo "  Or copy any of them to $CLAUDE_DIR/settings.json to make it default, e.g.:"
  echo "    cp $CLAUDE_DIR/settings.openrouter.json $CLAUDE_DIR/settings.json"
}

main "$@"
