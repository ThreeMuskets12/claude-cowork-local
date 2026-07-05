# claude-cowork-local

Run [Claude Code](https://docs.anthropic.com/en/docs/claude-code) against
**OpenRouter** (GLM 5.2 on the fastest provider), a **Z.ai GLM Coding Plan
subscription**, an **OpenAI ChatGPT subscription** (GPT-5.5 via Codex OAuth),
plus **free OpenCode Zen models** and **OpenCode Go** — all through a
self-hosted translation proxy. A [model router](#model-router--one-picker-three-backends)
lets one Claude Desktop picker fan out to all three subscription backends at
once. Native Web Search and Web Fetch work through the OpenRouter route
(see [Web Search and Web Fetch](#web-search-and-web-fetch)).

---

## What this is

Claude Code speaks the **Anthropic Messages API** (`/v1/messages`). Most
non-Anthropic model providers — including OpenRouter and OpenCode — speak the
**OpenAI Chat Completions API** (`/v1/chat/completions`). They are not
wire-compatible.

This repository is a thin wrapper that:

1. Runs a fork of the [cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy)
   worker locally on `http://localhost:8787` (using Bun, no build step).
2. Generates `settings.*.json` profiles for Claude Code that
   point at the local worker.
3. Provides a small set of management commands (`cowork-start`, `cowork-stop`,
   `cowork-status`, `cowork-log`).

The result is a Claude Code / Claude Desktop installation that runs on
OpenRouter's `z-ai/glm-5.2` by default (pick `claude-fable-5` in the model
picker for the `:nitro` fastest-provider variant) and can hot-swap to free
Zen models or paid OpenCode Go models.

### Default provider: OpenRouter

The `/openrouter` route (also the default when no route prefix is used)
translates to `https://openrouter.ai/api/v1` and adds:

- **A three-model catalog** — `GET /v1/models` advertises exactly three
  Anthropic-style models to clients (Claude Desktop's model picker reads
  this), each backed by a specific OpenRouter model:

  | Advertised model | Actually served by |
  |---|---|
  | `claude-opus-4-8` | `z-ai/glm-5.2` |
  | `claude-sonnet-5` | `anthropic/claude-sonnet-5` |
  | `claude-fable-5` | `z-ai/glm-5.2:nitro` (highest-throughput provider) |

- **Effort mapping for GLM 5.2** — Anthropic `output_config.effort` is
  translated to OpenRouter's `reasoning.effort` using only the levels GLM 5.2
  respects: `low`/`medium`/`high` pass through, `xhigh` and `max` clamp to
  `high`, and `thinking: {type: "disabled"}` becomes
  `reasoning: {enabled: false}`.
- **Vision escalation** — requests containing images are automatically
  switched to `anthropic/claude-sonnet-5` (GLM 5.2 is text-only).
- **Model ID mapping** — other Anthropic-style IDs Claude Code uses
  internally (e.g. `claude-haiku-4-5-20251001`) are mapped to OpenRouter
  slugs (`anthropic/claude-haiku-4.5`) so background calls resolve.
- **Native Web Search / Web Fetch support** (see below).

---

## Why not just use the upstream worker on Cloudflare

The upstream project deploys to [Cloudflare Workers](https://workers.cloudflare.com/).
This has a specific operational drawback for the free
Zen tier:

- Cloudflare Workers share a small pool of egress IP addresses across all
  users on the platform. OpenCode Zen enforces a per-IP rate limit on the
  free model pool. Under sustained use, requests routed through Cloudflare
  start returning `HTTP 429 FreeUsageLimitError` with a `Retry-After` of
  several hours.

Running the same code locally moves egress to the user's own IP, which is
not subject to the shared rate limit.

## Quick start

```bash
git clone https://github.com/a-a-borodin/claude-cowork-local.git
cd claude-cowork-local
./install.sh
```

The installer will:

1. Verify or install `bun` (Bun 1.1+).
2. Install worker dependencies (just `hono`).
3. Prompt for API keys (see [API keys](#api-keys) below).
4. Render `settings.{zen,go}.json` into `~/.claude/` with the
   supplied keys.
5. Symlink `cowork-start`, `cowork-stop`, `cowork-status`, `cowork-log` into
   `~/.local/bin/`.
6. Optionally install and enable a systemd unit.
7. Start the worker and run a smoke test.

Then launch Claude Code with a profile:

```bash
claude --settings ~/.claude/settings.router.json       # Fable→OpenRouter, Opus→Z.ai, Sonnet→OpenAI
```

```bash
claude --settings ~/.claude/settings.openrouter.json   # all models → GLM 5.2 via OpenRouter
```

```bash
claude --settings ~/.claude/settings.zaisub.json   # Z.ai GLM Coding Plan (subscription)
```

```bash
claude --settings ~/.claude/settings.zen.json
```

```bash
claude --settings ~/.claude/settings.go.json
```

The `zaisub` profile needs a one-time browser login first — see
[Z.ai subscription (GLM Coding Plan)](#zai-subscription-glm-coding-plan) below.

To make a profile the default:

```bash
cp ~/.claude/settings.openrouter.json ~/.claude/settings.json
```

---

## Prerequisites

- Linux or macOS. On Windows, use WSL2.
- `curl` (used by the installer to fetch Bun if missing).
- **Bun** 1.1 or later — installed automatically if absent.
- **[Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI** —
  this package is a backend for it.

No other system packages are required. The worker binds to
`127.0.0.1:8787` by default.

---

## API keys

Three API keys are referenced across the profiles:

- **OpenRouter key** (`sk-or-…`) — get one at
  [openrouter.ai/keys](https://openrouter.ai/keys). Used by the default
  `openrouter` profile (GLM 5.2, Claude Sonnet 5 for images, web search).
- **Zen workspace key** — free OpenCode Zen models.
- **Go key** — paid OpenCode Go models (usually identical to the Zen key).

The installer accepts any subset — profiles for which no key is provided are
simply not generated.

---

## Installation

### Interactive

```bash
./install.sh
```

### Non-interactive

```bash
OPENROUTER_KEY=sk-or-… ./install.sh
```

The `GO_KEY` defaults to `ZEN_KEY` if not provided. Add
`--no-systemd` to skip the systemd unit installation:

```bash
OPENROUTER_KEY=sk-or-… PROXY_PORT=9999 ./install.sh --no-systemd
```

Available installer environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `OPENROUTER_KEY` | *(prompted)* | OpenRouter API key (default profile) |
| `ZEN_KEY` | *(prompted)* | Zen API key |
| `GO_KEY`  | `$ZEN_KEY` | Go API key (usually identical to `ZEN_KEY`) |
| `PROXY_PORT` | `8787` | TCP port the worker binds to |

---

## Worker management

After installation, the following commands are available in `PATH`
(via symlinks in `~/.local/bin/`):

| Command | Effect |
|---|---|
| `cowork-start`  | Start the worker. No-op if already listening on the configured port. |
| `cowork-stop`   | Kill the worker process and confirm the port is free. |
| `cowork-status` | Print PID, parent PID, port binding, and the last 20 log lines. |
| `cowork-log`    | `tail -F` the worker log. |

Manual equivalents:

```bash
./bin/start.sh
./bin/stop.sh
./bin/status.sh
```

If the systemd unit is installed (default behavior on Linux with
`systemctl` and sufficient privileges):

```bash
sudo systemctl status  claude-cowork-local
sudo systemctl restart claude-cowork-local
sudo journalctl -u     claude-cowork-local -f
```

The worker is reparented to PID 1 by the start script's subshell, so it
survives the parent shell exiting. After a system reboot, run
`cowork-start` (or rely on the systemd unit) to bring it back up.

Logs are written to `${XDG_LOG_HOME:-$HOME/.local/log}/claude-cowork-local/worker.log`.

---

## Web Search and Web Fetch

Claude Code's native WebSearch and WebFetch previously broke behind the
proxy (Issue #1). Both are handled now, on every backend — see
[the web-tool interpreter](#the-web-tool-interpreter) below for how each
backend maps them. Claude Code implements them as Anthropic *server tools*
(`web_search_20250305` / `web_fetch_20250910`); a plain Anthropic→OpenAI
translation turns those into broken function tools, so they returned 0
results. The proxy instead interprets them per backend.

**The WebFetch domain-safety preflight** is a separate fix: before fetching a
URL, Claude Code runs a preflight that cannot complete behind a custom
`ANTHROPIC_BASE_URL`, failing with *"Unable to verify if domain … is safe to
fetch"*. All generated settings profiles set `"skipWebFetchPreflight": true`,
and the worker also answers the preflight
(`GET /api/web/domain_info?domain=…` → `{"can_fetch": true}`) for Claude Code
versions that route the check through the base URL.

### The web-tool interpreter

Native WebSearch and WebFetch are Anthropic **server tools** — the model emits
them and expects results back inline. The proxy interprets them per backend so
they work everywhere, not just on OpenRouter:

| | WebSearch | WebFetch |
|---|---|---|
| **OpenRouter** (Fable) | OpenRouter's `web_search` (billed by OpenRouter) | proxy fetches the URL locally |
| **Z.ai** (Opus) | GLM's native `web_search` tool → reshaped | proxy fetches the URL locally |
| **OpenAI** (Sonnet) | Responses `web_search` tool → reshaped | *(not yet wired)* |

- **WebSearch** substitutes each backend's *native server-executed search* and
  reshapes the results (GLM's `web_search[]` array / OpenAI+OpenRouter
  `url_citation` annotations) into Anthropic `web_search_tool_result` blocks.
  This **does** consume the provider's search allowance (that's the point).
- **WebFetch** is executed **locally by the proxy** — it exposes a `web_fetch`
  function tool to the model, runs a bounded loop fetching the requested URLs
  itself (HTTP GET → HTML→text), and reshapes them into
  `web_fetch_tool_result` blocks. Backend-independent, consumes no provider
  quota. Model-supplied URLs are SSRF-gated (private/loopback hosts and
  non-http schemes are blocked) — this is best-effort; a public hostname that
  *resolves* to a private IP is not caught, so lock down egress if you expose
  this to untrusted input.

> **Not yet wired / needs a live probe:** WebFetch on the OpenAI (Sonnet)
> backend needs a Responses-format tool loop (follow-up). And the two native
> WebSearch bridges are built and unit-tested but unverified against the live
> subscription endpoints — the Z.ai coding endpoint may route search through a
> separate billed API, and the OpenAI `codex` backend may not permit the
> `web_search` tool. Each needs one live request to confirm.

---

## Model router — one picker, three backends

The `/router` route is the recommended way to use everything at once. It
advertises three models to Claude Desktop and dispatches each to a **different
real backend** — no fallback, one model → one backend:

| Claude Desktop shows | Real backend | Auth |
|---|---|---|
| **Claude Fable 5** | OpenRouter `z-ai/glm-5.2:nitro` (fastest provider) | your OpenRouter key |
| **Claude Opus 4.8** | Z.ai `glm-5.2` (GLM Coding Plan subscription) | `cowork-zai-login` |
| **Claude Sonnet 5** | OpenAI `gpt-5.5` (ChatGPT subscription) | `cowork-openai-login` |

Each backend gets **effort levels it actually respects**, even though Claude
Desktop only ever sends Anthropic's `low`/`medium`/`high`/`xhigh`/`max`:

- GLM backends (Fable, Opus) → OpenRouter/Z.ai `reasoning.effort`
  (`low`/`medium`/`high`; `xhigh`/`max` clamp to `high`; disabled →
  `{enabled:false}`).
- OpenAI backend (Sonnet) → Responses `reasoning.effort`
  (`minimal`/`low`/`medium`/`high`; disabled → `minimal`; `xhigh`/`max` → `high`).

Setup:

```bash
cowork-zai-login       # for Opus 4.8  (Z.ai subscription)
cowork-openai-login    # for Sonnet 5  (ChatGPT subscription)
# ANTHROPIC_AUTH_TOKEN in the profile is your OpenRouter key (used for Fable 5)
claude --settings ~/.claude/settings.router.json
```

Anything Claude Code sends that isn't one of the three aliases (e.g. its
internal Haiku background calls) routes to OpenRouter `z-ai/glm-5.2` so the
client keeps working.

### OpenAI ChatGPT subscription (Sonnet 5 → GPT-5.5)

The ChatGPT subscription is reached through OpenAI's **Codex OAuth** (PKCE) and
the **Responses API** at `chatgpt.com/backend-api/codex/responses` — a
different wire format than Chat Completions. The proxy therefore adds a
Chat-Completions ⟷ Responses adapter *after* the normal Anthropic→OpenAI
translation, so the Anthropic side is unchanged:

```
Anthropic → [translator] → Chat Completions → [Responses adapter]
          → codex backend (SSE) → [Responses adapter] → Chat Completions
          → [translator] → Anthropic
```

Unlike Z.ai, OpenAI **issues a refresh token**, so the worker refreshes the
access token silently before it expires — no periodic re-login. Commands:
`cowork-openai-login` / `cowork-openai-login status` / `cowork-openai-login logout`.

> ⚠️ Same ToS caveat as Z.ai — driving a ChatGPT Plus/Pro subscription through
> a custom proxy (replaying the Codex client id) is a grey area and can risk
> the account.

---

## Z.ai subscription (GLM Coding Plan)

The `zaisub` profile routes Claude Desktop through a **Z.ai GLM Coding Plan
subscription** instead of a pay-as-you-go API key — the same subscription
surface that tools like ZCode use. Credentials are obtained through Z.ai's
**ZCode OAuth login**, not a manually-pasted key.

> ⚠️ **ToS grey area.** The GLM Coding Plan is officially restricted to
> sanctioned clients. This proxy replays the ZCode desktop app's OAuth client
> id and fingerprint headers to look like that client, which can get an account
> banned. Use at your own risk. The login CLI prints this warning too.

### One-time login

```bash
cowork-zai-login          # opens a browser to sign in to Z.ai (Z.ai / GitHub / Google)
```

This runs the OAuth flow, resolves the coding-plan `{apiKey}.{secret}`, and
writes it to a private credential store
(`${XDG_CONFIG_HOME:-~/.config}/claude-cowork-local/zai-credential.json`,
mode `600`; override the location with `CLAUDE_COWORK_STATE_DIR`). Then:

```bash
claude --settings ~/.claude/settings.zaisub.json
```

Companion commands:

```bash
cowork-zai-login status   # show the stored credential (key masked)
cowork-zai-login logout   # delete the stored credential
```

### How it works

1. `cowork-zai-login` starts a localhost callback server, opens
   `chat.z.ai/api/oauth/authorize`, and after you approve, exchanges the code
   at the shared `zcode.z.ai/api/v1/oauth/token` endpoint.
2. It resolves the provider token into a coding-plan API key via four
   `api.z.ai` calls (`z/login` → `getCustomerInfo` → find-or-create the
   `zcode-api-key` → fetch its secret) and stores `{apiKey}.{secret}`.
3. The worker's `/zaisub` route reads that credential and sends it as
   `Authorization: Bearer {apiKey}.{secret}` — plus ZCode fingerprint and
   per-request trace headers — to `api.z.ai/api/coding/paas/v4/chat/completions`,
   reusing the existing Anthropic→OpenAI translation. The caller's
   `ANTHROPIC_AUTH_TOKEN` on this route is only a 32-char gating **sentinel**;
   the real key never leaves the proxy.
4. `GET /v1/models` on `/zaisub` advertises the GLM coding-plan catalog
   (`glm-5.2`, `glm-5.1`, `glm-4.7`, …); `output_config.effort` is mapped to
   GLM's `reasoning.effort` (same clamping as the OpenRouter route); image
   requests escalate to `glm-4.6v` since `glm-5.2` is text-only.

### No refresh token

The ZCode OAuth flow does **not** issue a refresh token. When the credential
is rejected (the worker surfaces a `401` telling you to re-run the login) you
simply run `cowork-zai-login` again — the find-or-create step reuses the same
`zcode-api-key`, so re-login is quick. There is no silent-refresh path; this is
a Z.ai limitation, not a proxy one.

The credential and ZCode headers are **gated strictly to the `/zaisub`
route** — the OpenRouter, Zen, and Go routes are byte-identical to before.

---

## Configuration

### Changing the port

```bash
PROXY_PORT=9999 ./install.sh         # initial install
PROXY_PORT=9999 ./bin/start.sh       # one-off start
```

If a systemd unit was previously installed on the old port, regenerate
it by re-running `./install.sh` with the new `PROXY_PORT`.

### Adding another upstream

To route to a third provider (for example Groq), edit
`worker/src/index.ts`:

```ts
const GROQ_UPSTREAM = "https://api.groq.com/openai/v1";
```

…add the corresponding prefix handling in `routeConfig`, and add the route
to the root endpoint's `routes` object. Then restart the worker:

```bash
cowork-stop && cowork-start
```

A new settings template at `settings/settings.groq.template.json` follows
the same pattern as the existing two.

---

## Project structure

```
claude-cowork-local/
├── README.md
├── LICENSE
├── .gitignore
├── install.sh                  # one-shot installer
├── bin/
│   ├── start.sh
│   ├── stop.sh
│   ├── status.sh
│   ├── log.sh
│   ├── zai-login.sh            # Z.ai subscription OAuth login CLI
│   └── openai-login.sh         # OpenAI ChatGPT subscription OAuth login CLI
├── settings/
│   ├── settings.router.template.json
│   ├── settings.openrouter.template.json
│   ├── settings.zaisub.template.json
│   ├── settings.zen.template.json
│   └── settings.go.template.json
└── worker/                     # fork of cucoleadan/opencode-cowork-proxy
    ├── package.json
    ├── wrangler.toml
    ├── tsconfig.json
    └── src/
        ├── index.ts            # router
        ├── server.ts           # Bun entrypoint
        ├── auth.ts             # API key extraction/validation
        ├── cache.ts            # prompt cache key helpers
        ├── websearch.ts        # WebSearch: provider-native search → Anthropic blocks
        ├── webfetch.ts         # WebFetch: local URL fetch (SSRF-gated) + HTML→text
        ├── webtools.ts         # in-request web-tool interpreter loop (search + fetch)
        ├── zai-login.ts        # Z.ai OAuth login orchestrator (CLI)
        ├── openai-login.ts     # OpenAI Codex OAuth login orchestrator (CLI)
        ├── zai/                # Z.ai subscription backend
        │   ├── oauth.ts        #   ZCode auth-code OAuth flow
        │   ├── resolver.ts     #   provider token → {apiKey}.{secret}
        │   ├── tokenstore.ts   #   on-disk credential store (600)
        │   ├── identity.ts     #   ZCode fingerprint + trace headers
        │   ├── credential.ts   #   credential type + helpers
        │   └── models.ts       #   GLM coding-plan catalog
        ├── openai/             # OpenAI ChatGPT-subscription backend
        │   ├── oauth.ts        #   Codex OAuth (PKCE) + refresh + account id
        │   ├── auth.ts         #   worker-side credential resolve + silent refresh
        │   ├── tokenstore.ts   #   on-disk credential store (600)
        │   ├── responses.ts    #   Chat Completions ⟷ Responses API adapter
        │   └── credential.ts   #   credential type + helpers
        └── translate/
            ├── request/        # Anthropic ↔ OpenAI
            ├── response/       # Anthropic ↔ OpenAI
            └── stream/         # SSE: Anthropic ↔ OpenAI
```

---

## License

MIT. See `LICENSE`.

The worker source is a derivative of
[cucoleadan/opencode-cowork-proxy](https://github.com/cucoleadan/opencode-cowork-proxy)
by `@cucoleadan`, also MIT licensed. The original copyright is preserved in
the source files.

---

## Credits

- `cucoleadan/opencode-cowork-proxy` — the upstream worker this package
  embeds.
