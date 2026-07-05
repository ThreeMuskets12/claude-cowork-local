#!/usr/bin/env bash
# Interactive OpenAI ChatGPT-subscription login (Codex OAuth). Mints the
# credential the /router route's Sonnet 5 → OpenAI backend uses.
# Subcommands: (none) login | status | logout.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/.."

if ! command -v bun >/dev/null 2>&1; then
  export PATH="$HOME/.bun/bin:$PATH"
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "✗ bun not found (needed to run the login flow). Install from https://bun.sh" >&2
  exit 1
fi

exec bun "$ROOT/worker/src/openai-login.ts" "$@"
