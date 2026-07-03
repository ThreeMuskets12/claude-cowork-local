# Z.ai Subscription Auth Backend — Implementation Plan

## Overview

This plan adds a new backend, **`zaisub`**, to the local Anthropic↔OpenAI translation
proxy (this codebase, a Bun/Hono app on `localhost:8787`). The backend lets Claude
Code talk to **Z.ai's GLM Coding Plan** (the `z.ai/subscribe` developer subscription)
using credentials obtained through the **ZCode subscription OAuth flow** rather than
a manually-pasted OpenRouter API key.

Two layers are required, with very different complexity:

1. **Relay layer (low effort, fully fits)** — once OAuth has minted a credential, it
   is a normal api.z.ai `{apiKey}.{secret}` API key sent as `Authorization: Bearer`
   against an OpenAI-compatible endpoint. This is behaviorally identical to the
   existing OpenRouter/Zen/Go static-key backends and reuses the existing
   translator with **no translator changes**.

2. **OAuth login + lifecycle layer (high effort, does NOT fit the stateless model)** —
   interactive browser login on a localhost callback, a 4-call API-key resolution
   chain, a persistent on-disk credential store, ZCode desktop client-fingerprint
   headers, and a re-login trigger when the credential is rejected. The worker
   currently has **zero** persistent state, **zero** interactive-login concept, and
   **zero** refresh machinery.

The plan implements both. A close, much simpler alternative (paste the resolved key
manually, skip OAuth) is documented in **Out of Scope** and is the recommended
starting point if the OAuth layer's ToS/maintenance risk is unacceptable.

## Goal

Route Claude Code requests through the Z.ai GLM Coding Plan subscription, with
credentials obtained by an interactive `chat.z.ai` OAuth login, persisted locally,
and re-obtained via re-login when rejected — all behind the existing
Anthropic→OpenAI translation the proxy already performs for OpenRouter/Zen/Go.

## Background — How Z.ai Subscription OAuth Works

There are two distinct Z.ai "subscription" surfaces (conflated in marketing, very
different technically). This plan targets **surface (A)**.

### Surface (A) — ZCode "GLM Coding Plan" OAuth (the target)

Implemented and documented in **TriDefender/zcode-api** (TypeScript/Bun,
https://github.com/TriDefender/zcode-api, default branch `master`, cloned to
`/tmp/zcode-api` and read line-by-line for this plan) and **router-for-me/CLIProxyAPI**
(Go, https://github.com/router-for-me/CLIProxyAPI, commit `40b5658` added the
`zai`/`bigmodel` OAuth provider). This is the canonical "subscription OAuth" path.

The flow (verified in `/tmp/zcode-api/src/auth/oauth.ts` and `src/auth/resolver.ts`):

1. Start a localhost HTTP callback server on a random port (`127.0.0.1:<port>`),
   generate a random hex `state`.
2. Build the authorize URL (Z.AI international):
   `https://chat.z.ai/api/oauth/authorize?response_type=code&client_id=client_P8X5CMWmlaRO9gyO-KSqtg&redirect_uri=http://127.0.0.1:<port>/oauth/callback/zai&state=<state>`
3. Open the URL in a browser; the user signs in (Z.ai / GitHub / Google) and
   approves. The provider redirects back to localhost with
   `?authCode=...&state=...` (param name `authCode`, falling back to `code` —
   `oauth.ts:160`).
4. POST to the **shared** token-exchange endpoint
   `https://zcode.z.ai/api/v1/oauth/token` with JSON body
   `{provider: "zai", code: <authCode>, redirect_uri: <localhost url>, state: <state>}`.
   The ZCode server holds the app secret and performs the real provider exchange
   (`oauth.ts:211-248`).
5. Response: `{code:0, data:{token: <zcode-plan JWT>, zai:{access_token:<provider token>}, user:{user_id:<id>}}}`.
   Extract the provider access token from `data.zai.access_token` and the plan JWT
   from `data.token` (`oauth.ts:236-247`).
6. **Coding-plan resolve to API key** (`resolver.ts:121-154`,
   `resolveCodingPlanCredential`):
   - POST `https://api.z.ai/api/auth/z/login` `{token: <provider access_token>}` → `bizToken`.
   - GET `https://api.z.ai/api/biz/customer/getCustomerInfo` with
     `Authorization: Bearer <bizToken>` → pick org/project named "默认机构"/"默认项目"
     (or the first).
   - GET/POST
     `https://api.z.ai/api/biz/v1/organization/<orgId>/projects/<projectId>/api_keys`
     to find or create an API key named `zcode-api-key`.
   - GET `.../api_keys/copy/<apiKey>` → `secretKey`.
   - Final credential = `{apiKey}.{secret}` (zai) (`resolver.ts:138`,
     `auth/types.ts:33-38` `credentialString`).
7. The LLM call itself is a **standard api.z.ai bearer call** billed to the
   subscription: `Authorization: Bearer ${apiKey}.${secret}` against
   `https://api.z.ai/api/coding/paas/v4/chat/completions` (OpenAI-format,
   `providers.ts:8-14`: `openaiBaseURL = "https://api.z.ai/api/coding/paas/v4"`;
   `upstream.ts:60-68` `buildUpstreamURL` appends `/chat/completions`).

**There is NO refresh-token flow.** Verified in `/tmp/zcode-api/src/auth/manager.ts:46-48`:
when `oauthCred.expiresAt` passes, it throws `"OAuth credential expired; re-authentication required (T9/T10 not yet implemented)"`. CLIProxyAPI's `token.go` carries the same comment: *"The flow does not return a refresh token; when the token is rejected the user logs in again."* This is the single most important constraint in this plan: **"subscription OAuth with refresh" as literally requested is not achievable** — only a re-login-on-rejection path is.

**Identity headers** (`/tmp/zcode-api/src/proxy/identity.ts`, `buildIdentityHeaders`):
the ZCode desktop client's companion headers are injected on every upstream request
so the proxy is indistinguishable from the official client:

```
HTTP-Referer:        https://zcode.z.ai
User-Agent:          ZCode/<appVersion>          (or ZCode/unknown)
X-ZCode-App-Version: <ver>                       (only if printable-ASCII)
X-Title:             Z Code@cli
X-ZCode-Agent:       glm
X-Platform:          <platform>-<arch>
X-Os-Category:       windows | macos | linux
X-Os-Version:        <release>
```

**Models** (coding-plan, `zcode-api` `provider/models.ts`): `glm-4.5-air`,
`glm-4.6`, `glm-4.6v`, `glm-4.7`, `glm-5`, `glm-5-turbo`, `glm-5v-turbo`, `glm-5.1`,
`glm-5.2` (200K ctx / 128K out; `glm-5.2` is 1M ctx). Default for coding-plan is
`glm-5.2`.

### Surface (B) — chat.z.ai consumer chat (NOT targeted)

Implemented in **orbitoo/zai2api** (Python, https://github.com/orbitoo/zai2api),
**hulisang/ZtoApi**, **izaart95-jpg/GLM-Free-API**, **hmjz100/Z.ai2api**. Here there
is **no OAuth code flow**; you extract a long-lived JWT (`ZAI_JWT`) from a logged-in
`chat.z.ai` browser session, exchange it at `chat.z.ai/api/v1/auths/` for a
short-lived session token, then POST to `chat.z.ai/api/v2/chat/completions` with a
per-request **HMAC signature** (`X-Signature`) using a hard-coded
`SIGNING_SECRET = "key-@@@@)))()((9))-xxxx&&&%%%%%"` and a 5-minute time bucket.
This is reverse-engineering the consumer web app (brittle, ToS-hostile), uses
different endpoints, different models, and different quotas. **Out of scope.**

### Contrast: how other proxies treat Z.ai

**OpenClaw** (https://github.com/openclaw/openclaw) and **Hermes Agent**
(https://github.com/NousResearch/hermes-agent) both integrate Z.ai as a first-class
`zai` provider but use **plain API-key/Bearer auth, NOT OAuth**. Both obtain a
Z.ai/Zhipu API key from the Open Platform console (where the user separately
subscribes to the Coding Plan) and auto-detect which base URL the key is valid for
by probing candidate endpoints with a 1-token ping (`api.z.ai/api/paas/v4`,
`api.z.ai/api/coding/paas/v4`, `open.bigmodel.cn/...` variants). Hermes had a known
**billing bug** (issue #42536) where PAYG endpoints were probed before coding-plan
endpoints, silently billing subscription users against their wallet. The takeaway:
the resolved coding-plan key is just a Bearer API key, and a proxy that already
speaks OpenAI Chat Completions can drive it with no translation changes — exactly
this codebase's situation.

## Feasibility Assessment

**Verdict: PARTIAL.**

- The subscription-OAuth path **genuinely exists** and is fully implemented in
  portable TypeScript (zcode-api), so there is community code to port directly.
- The **relay layer fits cleanly**: the resolved credential is a standard Bearer
  API key against an OpenAI-compatible endpoint; this codebase already relays such
  keys (OpenRouter, Zen, Go) via the same code path; the translator is generic and
  needs no change.
- The **OAuth login + lifecycle layer does NOT fit** the existing stateless model.
  It requires: an interactive browser login with a localhost callback server, a
  multi-step API-key resolution chain, a persistent on-disk credential store with
  expiry, ZCode identity headers, and a re-login-on-rejection path. The worker
  currently has no persistent store, no interactive-login concept, and no refresh
  machinery.
- **No refresh token exists** (verified). "Subscription OAuth WITH refresh" as
  literally requested is not achievable; the plan delivers re-login-on-rejection
  instead and is explicit about this.
- **ToS risk**: the GLM Coding Plan is officially restricted to sanctioned tools
  (Claude Code is on the list), but wrapping it in a custom local proxy + spoofing
  the ZCode client fingerprint is grey-area and can get the account banned. This
  is the user's call; the plan documents it prominently.

Confidence: **high** on the technical mechanism (zcode-api read directly),
**medium-high** on stability (OAuth `client_id` is the official ZCode desktop app's
— reverse-engineered; the resolved key's expiry/revocation window is unknown and
server-enforced; Z.ai may rotate identity requirements).

## Proposed Architecture

```
                      Claude Code
                          |  (Anthropic Messages, ANTHROPIC_AUTH_TOKEN as Bearer)
                          v
   +--------------------------------------------------------+
   |  Local Bun/Hono proxy  (localhost:8787)                |
   |  worker/src/index.ts handleRequest                     |
   |    routeConfig() -> "/zaisub" prefix                   |
   |    -> load resolved credential from tokenstore         |
   |    -> build Authorization: Bearer <apiKey>.<secret>    |
   |       + ZCode identity headers (gated to /zaisub)      |
   |    -> formatAnthropicToOpenAI (unchanged translator)  |
   |    -> fetch https://api.z.ai/api/coding/paas/v4/       |
   |            chat/completions                            |
   |    -> streamOpenAIToAnthropic / toAnthropicResponse    |
   |    on 401 -> surface "re-run cowork-zai-login" error   |
   +--------------------------------------------------------+
                          ^ credential read from
                          |
   +--------------------------------------------------------+
   |  On-disk credential store (chmod 600)                 |
   |  ${XDG_CONFIG_HOME:-$HOME/.config}/                    |
   |    claude-cowork-local/zai-credential.json             |
   |  { apiKey, secret, expiresAt, userId, jwt, provider } |
   +--------------------------------------------------------+
                          ^ written by
                          |
   +--------------------------------------------------------+
   |  Interactive login CLI (separate process)             |
   |  bin/zai-login.sh -> bun worker/src/zai-login.ts       |
   |    1. zai-oauth.ts  : localhost callback + authorize   |
   |    2. zai-resolver.ts: resolve {apiKey}.{secret}       |
   |    3. zai-tokenstore.ts: persist credential             |
   +--------------------------------------------------------+
```

Key design decisions:

- **Login runs as a separate CLI, not in the Worker.** The Worker is a stateless
  request relay (matches the existing model and `server.ts`). The OAuth callback
  server, browser launch, and credential resolution are a one-shot CLI
  (`cowork-zai-login`) that writes the credential file. The Worker only reads it.
  This also means the Cloudflare Workers deploy path (vestigial here) is unaffected
  by the OAuth layer.
- **The caller's `ANTHROPIC_AUTH_TOKEN` becomes a gating sentinel, not the upstream
  credential.** For `/zaisub`, the upstream credential is the resolved
  `{apiKey}.{secret}` from the tokenstore. The existing `validateApiKey` (>=32 chars)
  still gates the incoming Claude Code request, but the key it validates is no longer
  forwarded upstream — the resolved credential is.
- **No translator changes.** `formatAnthropicToOpenAI` is generic OpenAI Chat
  Completions; `api.z.ai/api/coding/paas/v4` accepts that body shape (confirmed by
  OpenClaw/Hermes driving the same endpoint with the same shape).
- **Identity headers are gated to the `/zaisub` upstream** so they do not affect
  OpenRouter/Zen/Go (the outbound header literal at `index.ts:209-212` is shared).

## Detailed Implementation Steps

### Step 1 — Relay: add the upstream constant and route branch

File: `worker/src/index.ts`

Near lines 11-14, add:

```ts
// Z.ai GLM Coding Plan (subscription). The /zaisub route resolves a credential
// via the ZCode OAuth flow (see worker/src/zai-login.ts / zai-oauth.ts) and uses
// it as a standard Bearer key against this OpenAI-compatible endpoint.
const ZAISUB_UPSTREAM = "https://api.z.ai/api/coding/paas/v4";
```

In `routeConfig()` (index.ts:51-73), after the `/zen` block (line 69) and before
the default fallthrough (line 71), add:

```ts
const zaisubPath = stripPrefix(path, "/zaisub");
if (zaisubPath) {
  const { path: remaining, model } = extractModelSegment(zaisubPath);
  return { path: remaining, upstream: ZAISUB_UPSTREAM, modelOverride: model };
}
```

Add to the root `routes` object (index.ts:327-331):

```ts
"/zaisub": ZAISUB_UPSTREAM,
```

### Step 2 — Relay: settings template

New file: `settings/settings.zaisub.template.json` (mirrors
`settings/settings.zen.template.json`):

```json
{
  "_comment": "Z.ai GLM Coding Plan (subscription). Run `cowork-zai-login` after install to mint the credential; the proxy holds the real key, so ANTHROPIC_AUTH_TOKEN below is just a gating sentinel (any >=32-char string).",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "http://localhost:8787/zaisub",
    "ANTHROPIC_AUTH_TOKEN": "REPLACE_WITH_ZAISUB_SENTINEL_ANY_32_PLUS_CHARS"
  },
  "permissions": {
    "defaultMode": "bypassPermissions",
    "dangerouslySkipPermissions": true
  },
  "model": "glm-5.2",
  "skipWebFetchPreflight": true,
  "skipDangerousModePermissionPrompt": true
}
```

### Step 3 — OAuth module (ported from zcode-api)

New file: `worker/src/zai-oauth.ts`. Port `/tmp/zcode-api/src/auth/oauth.ts`
`AuthCodeOAuthClient` to Bun. Key changes for the local Bun runtime:

- Replace `node:http` `createServer` with `Bun.serve({ port: 0, hostname: "127.0.0.1" })`
  for the callback server (Bun has no `node:http` by default; `Bun.serve` returns
  the resolved port via `server.port`).
- Use `Bun.password`/`crypto` or `crypto.getRandomValues` for the 32-byte hex
  `state` (zcode-api uses `randomBytes(32).toString("hex")`).
- Keep the two constants verbatim:
  - `ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token"`
  - `ZAI_AUTH_CODE_CONFIG = { provider: "zai", authorizeUrl: "https://chat.z.ai/api/oauth/authorize", appId: "client_P8X5CMWmlaRO9gyO-KSqtg", tokenUrl: ZCODE_TOKEN_ENDPOINT, callbackPath: "/oauth/callback/zai", accessTokenField: "zai", authorizeParamStyle: "oauth2" }`
- `exchangeCode(authCode, redirectUri, state)` body and response parsing are
  runtime-agnostic (plain `fetch`) — copy directly.
- Return `{ accessToken, userId?, jwt? }`.

Sketch:

```ts
// worker/src/zai-oauth.ts
const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";

export interface OAuthResult {
  accessToken: string;
  userId?: string;
  jwt?: string; // zcode-plan JWT (data.token); kept for potential start-plan path
}

export async function runZaiOAuth(onAuthorizeUrl: (url: string) => void): Promise<OAuthResult> {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const callbackPath = "/oauth/callback/zai";

  // Bun.serve as a one-shot localhost callback
  const code = await new Promise<string>((resolve, reject) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== callbackPath) return new Response("Not found", { status: 404 });
        const st = url.searchParams.get("state") ?? "";
        const c = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";
        if (st !== state || !c) {
          return new Response("Authorization failed: state mismatch or missing code.", { status: 400 });
        }
        // resolve on next tick so the response is sent first
        queueMicrotask(() => { server.stop(true); resolve(c); });
        return new Response("Authorization successful! You may close this window.", { status: 200 });
      },
    });
    const callbackUrl = `http://127.0.0.1:${server.port}${callbackPath}`;
    const params = new URLSearchParams({
      redirect_uri: callbackUrl, response_type: "code",
      client_id: "client_P8X5CMWmlaRO9gyO-KSqtg", state,
    });
    onAuthorizeUrl(`https://chat.z.ai/api/oauth/authorize?${params.toString()}`);
  });

  // Exchange at the shared zcode.z.ai endpoint
  const resp = await fetch(ZCODE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "zai", code, redirect_uri: `http://127.0.0.1:<port>${callbackPath}`, state }),
  });
  const raw: any = await resp.json().catch(() => null);
  if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
    throw new Error(`zai token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`);
  }
  const accessToken = raw?.data?.zai?.access_token?.trim();
  if (!accessToken) throw new Error("zai token response missing data.zai.access_token");
  return {
    accessToken,
    userId: raw?.data?.user?.user_id,
    jwt: raw?.data?.token?.trim() || undefined,
  };
}
```

(Note: capture `server.port` into a variable before the fetch so `redirect_uri`
matches the registered callback exactly — the sketch elides that for brevity.)

### Step 4 — Resolver module (ported from zcode-api)

New file: `worker/src/zai-resolver.ts`. Port
`/tmp/zcode-api/src/auth/resolver.ts` `KeyResolver.resolveCodingPlanCredential`
(zai branch). The four calls:

```ts
// worker/src/zai-resolver.ts
import type { OAuthResult } from "./zai-oauth";

export interface ZaiCredential {
  apiKey: string;
  secret?: string;        // ZAI: `${apiKey}.${secret}`
  userId?: string;
  jwt?: string;
  expiresAt?: number;      // best-effort, from OAuth response if present
  provider: "zai";
  resolvedAt: number;
}

const ZAI_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "默认机构";     // 默认机构
const DEFAULT_PROJECT_MARKER = "默认项目"; // 默认项目
const BIZ_HOST = "https://api.z.ai";

async function biz<T>(url: string, authorization: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, { ...init, headers: { Authorization: authorization, "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const body: any = await resp.json();
  const code = body.code ?? body.status;
  if (!resp.ok || (code != null && code !== 0 && code !== 200)) throw new Error(body.msg ?? `biz ${resp.status}`);
  return (body.data ?? body) as T;
}

export async function resolveCodingPlanCredential(oauth: OAuthResult): Promise<ZaiCredential> {
  // 1. provider access token -> bizToken
  const r = await fetch(`${BIZ_HOST}/api/auth/z/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: oauth.accessToken }),
  });
  if (!r.ok) throw new Error(`z/login failed: ${r.status}`);
  const d: any = await r.json();
  const bizToken = d.access_token ?? d.accessToken ?? d.data?.access_token;
  const authorization = `Bearer ${bizToken}`;

  // 2. customer info -> default org + project
  const info: any = await biz(`${BIZ_HOST}/api/biz/customer/getCustomerInfo`, authorization, { method: "GET" });
  const orgs: any[] = info.organizations ?? info.orgs ?? [];
  if (!orgs.length) throw new Error("No organizations found");
  const org = orgs.find(o => (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER)) ?? orgs[0];
  const orgId = org.organizationId ?? org.id ?? org.orgId;
  const projects: any[] = org.projects ?? [];
  const project = projects.find(p => (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER)) ?? projects[0];
  const projectId = project.projectId ?? project.id;

  // 3. find-or-create the named api key
  const listUrl = `${BIZ_HOST}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
  let apiKey: string | undefined;
  try {
    const existing: any[] = (await biz(listUrl, authorization, { method: "GET" })) ?? [];
    apiKey = existing.find(k => k.name === ZAI_API_KEY_NAME)?.apiKey;
  } catch { /* will create */ }
  if (!apiKey) {
    const created = await biz<{ apiKey: string }>(listUrl, authorization, { method: "POST", body: JSON.stringify({ name: ZAI_API_KEY_NAME }) });
    apiKey = created.apiKey;
  }

  // 4. fetch the secret
  let secret: string | undefined;
  try {
    const copy = await biz<{ secretKey?: string; secret_key?: string }>(
      `${listUrl}/copy/${encodeURIComponent(apiKey)}`, authorization, { method: "GET" });
    secret = copy.secretKey ?? copy.secret_key;
  } catch { /* apiKey-only */ }

  return { apiKey, secret, userId: oauth.userId, jwt: oauth.jwt, provider: "zai", resolvedAt: Date.now() };
}

export function credentialString(c: ZaiCredential): string {
  return c.secret ? `${c.apiKey}.${c.secret}` : c.apiKey;
}
```

### Step 5 — Tokenstore (the persistent store the worker lacks)

New file: `worker/src/zai-tokenstore.ts`. Local Bun path: a JSON file on disk,
chmod 600, in a state dir (separate from `settings/` so it is never committed).

```ts
// worker/src/zai-tokenstore.ts
import { ZaiCredential } from "./zai-resolver";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_DIR = process.env.CLAUDE_COWORK_STATE_DIR
  ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(process.env.HOME ?? "", ".config"), "claude-cowork-local");
const STORE_PATH = path.join(STATE_DIR, "zai-credential.json");

export function loadCredential(): ZaiCredential | null {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf-8");
    return JSON.parse(raw) as ZaiCredential;
  } catch { return null; }
}

export function saveCredential(c: ZaiCredential): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.chmodSync(STORE_PATH, 0o600); // belt-and-suspenders across platforms
}

export function isExpired(c: ZaiCredential, now = Date.now()): boolean {
  return c.expiresAt !== undefined && now >= c.expiresAt;
}
```

Add `zai-credential.json` and the state dir to `.gitignore` (the file lives outside
the repo by default, but add the path defensively).

### Step 6 — Identity headers (gated to /zaisub)

New file: `worker/src/zai-identity.ts`. Port
`/tmp/zcode-api/src/proxy/identity.ts` `buildIdentityHeaders` to Bun (use
`process.platform` and `Bun`/`os` for arch/release). Keep the printable-ASCII gate.

```ts
// worker/src/zai-identity.ts  (sketch — see zcode-api identity.ts for the exact gate)
import * as os from "node:os";
const ASCII = /^[\x20-\x7e]+$/;
const printable = (v?: string) => (typeof v === "string" && ASCII.test(v) ? v : undefined);

export function buildZaiIdentityHeaders(appVersion = "3.1.0"): Record<string, string> {
  const n = printable(appVersion);
  const platform = printable(process.platform);
  const arch = printable(os.arch());
  const release = printable(os.release());
  const osCategory = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
  return {
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${n ?? "unknown"}`,
    ...(n ? { "X-ZCode-App-Version": n } : {}),
    "X-Title": "Z Code@cli",
    "X-ZCode-Agent": "glm",
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    "X-Os-Category": osCategory,
    ...(release ? { "X-Os-Version": release } : {}),
  };
}
```

### Step 7 — Intercept in handleRequest (the central relay change)

File: `worker/src/index.ts`. In the `POST /v1/messages`, `fmt === "openai"` branch
(index.ts:182-238), the outbound fetch at line 207-214 currently sends
`Authorization: Bearer ${key}` where `key` is the caller's static token. For the
`/zaisub` route, replace `key` with the resolved credential and add identity
headers. Introduce an upstream predicate and a helper:

```ts
// near the other predicates (index.ts:95-97)
function isZaisubUpstream(upstream: string): boolean {
  return upstream === ZAISUB_UPSTREAM;
}

// new helper near anthropicHeaders
function zaisubUpstreamHeaders(cred: ZaiCredential): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${credentialString(cred)}`,
    ...buildZaiIdentityHeaders(),
  };
}
```

Then, in the `fmt === "openai"` block, branch on `isZaisubUpstream(upstream)`:

```ts
// inside handleRequest, POST /v1/messages, fmt === "openai" (index.ts ~182-214)
let outHeaders: Record<string, string>;
let outBody: string;
if (isZaisubUpstream(upstream)) {
  const cred = loadCredential();
  if (!cred) {
    return new Response(JSON.stringify({ error: { type: "authentication_error",
      message: "Z.ai credential not found. Run `cowork-zai-login` to sign in." } }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  if (isExpired(cred)) {
    return new Response(JSON.stringify({ error: { type: "authentication_error",
      message: "Z.ai credential expired. Re-run `cowork-zai-login`." } }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  outHeaders = zaisubUpstreamHeaders(cred);
  // Optionally inject metadata.user_id (userId) if api.z.ai requires it — see Open Questions.
} else {
  outHeaders = { "Content-Type": "application/json", "Authorization": `Bearer ${key}` };
}
// ... existing model-override / translator / web-search logic (all gated on isOpenRouterUpstream, so /zaisub is plain) ...
const res = await fetch(`${upstream}/chat/completions`, {
  method: "POST", headers: outHeaders, body: JSON.stringify(openaiReq),
});
if (!res.ok) {
  // Surface a helpful error specifically for a 401 on /zaisub
  if (isZaisubUpstream(upstream) && res.status === 401) {
    return new Response(JSON.stringify({ error: { type: "authentication_error",
      message: "Z.ai rejected the credential (401). Re-run `cowork-zai-login` to refresh." } }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return upstreamErrorResponse(res, await res.text());
}
// ... existing stream/JSON handling unchanged ...
```

Apply the same intercept to `POST /v1/chat/completions` (index.ts:278-282,
OpenAI pass-through) and `GET /v1/models` (index.ts:315-318) for the `/zaisub`
route. (For `/v1/models` on `/zaisub`, either proxy `${ZAISUB_UPSTREAM}/models`
with the resolved Bearer or return a small static coding-plan catalog — the plan
proxies upstream, matching the non-OpenRouter behavior.)

### Step 8 — Interactive login CLI

New file: `worker/src/zai-login.ts` — the orchestrator run by the user:

```ts
// worker/src/zai-login.ts
import { runZaiOAuth } from "./zai-oauth";
import { resolveCodingPlanCredential } from "./zai-resolver";
import { saveCredential } from "./zai-tokenstore";

(async () => {
  const oauth = await runZaiOAuth((url) => {
    console.log("\nOpen this URL in your browser to sign in to Z.ai:\n");
    console.log(url);
    console.log("\nWaiting for authorization...");
    // Best-effort auto-open:
    try { Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
  });
  const cred = await resolveCodingPlanCredential(oauth);
  saveCredential(cred);
  console.log(`\n✓ Z.ai credential saved (provider=${cred.provider}, apiKey=${cred.apiKey.slice(0,8)}…).`);
})();
```

New file: `bin/zai-login.sh` (mirrors `bin/start.sh` style):

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/.."
if ! command -v bun >/dev/null 2>&1; then export PATH="$HOME/.bun/bin:$PATH"; fi
exec bun "$ROOT/worker/src/zai-login.ts" "$@"
```

### Step 9 — Wire into install.sh

File: `install.sh`.

- In `collect_keys()` (install.sh:65-81), after the existing prompts, add a
  branch that does **not** `prompt_secret` for a key; instead print the post-install
  instruction:

  ```bash
  echo "  - Z.ai subscription (GLM Coding Plan): no key needed now."
  echo "    After install, run: cowork-zai-login   (opens a browser to sign in to chat.z.ai)"
  ```

- In `write_settings()` (install.sh:84-110), add `zaisub` to the `for profile in`
  loop. Since there is no key to substitute, render the template with the sentinel
  as-is (or substitute a fixed 32+ char sentinel). Add a skip guard if the template
  is missing. The `sed` substitution for `zaisub` can be a no-op (the sentinel is
  already a valid 32+ char string in the template) or substitute a generated
  random sentinel so two machines don't share one.

- In `install_bin()` (install.sh:113-121), add `zai-login` to the symlinked
  scripts:

  ```bash
  for f in start stop status log zai-login; do
    ln -sf "$ROOT/bin/$f.sh" "$HOME/.local/bin/cowork-$f"
  done
  ```

- In the usage hints (install.sh:192-198), add:

  ```bash
  echo "    claude --settings $CLAUDE_DIR/settings.zaisub.json   (Z.ai Coding Plan; run cowork-zai-login first)"
  ```

- `chmod +x bin/zai-login.sh`.

### Step 10 — Restart and smoke test

After editing, restart the worker (per README "Adding another upstream",
lines 256-273):

```bash
cowork-stop && cowork-start
```

No build step — Bun runs TS directly via `worker/src/server.ts`.

## Token / Login Flow

**Initial login (interactive):**

1. User runs `cowork-zai-login` (or `bin/zai-login.sh`).
2. `zai-oauth.ts` starts a localhost callback server on a random port, builds the
   authorize URL, and opens it (or prints it).
3. User signs in at `chat.z.ai` with Z.ai / GitHub / Google and approves.
4. `chat.z.ai` redirects to `http://127.0.0.1:<port>/oauth/callback/zai?authCode=…&state=…`.
5. The CLI exchanges `authCode` at `https://zcode.z.ai/api/v1/oauth/token` →
   `data.zai.access_token` (+ `data.token` JWT, `data.user.user_id`).
6. `zai-resolver.ts` resolves the coding-plan credential:
   `z/login` → `getCustomerInfo` → find-or-create `zcode-api-key` → `copy/<apiKey>` →
   `{apiKey}.{secret}`.
7. `zai-tokenstore.ts` writes the credential to `zai-credential.json` (chmod 600).

**Per-request relay (non-interactive):**

1. Claude Code sends `POST /v1/messages` to `http://localhost:8787/zaisub/v1/messages`
   with `Authorization: Bearer <sentinel>`.
2. `routeConfig` strips `/zaisub`, sets `upstream = ZAISUB_UPSTREAM`.
3. `handleRequest` loads the credential from the tokenstore; if missing/expired,
   returns a 401 telling the user to run `cowork-zai-login`.
4. The translator (`formatAnthropicToOpenAI`) converts the Anthropic body to OpenAI
   Chat Completions (unchanged). Model `glm-5.2` from the settings profile is
   forwarded as-is (no OpenRouter model mapping on this route).
5. The worker fetches `https://api.z.ai/api/coding/paas/v4/chat/completions` with
   `Authorization: Bearer <apiKey>.<secret>` + ZCode identity headers.
6. The OpenAI SSE/JSON response is translated back via `streamOpenAIToAnthropic`
   or `toAnthropicResponse` (unchanged) and returned to Claude Code.

**Re-login (no refresh token — this is the "refresh" path):**

- There is **no refresh token** (verified in zcode-api `manager.ts`). If the
  resolved credential's `expiresAt` passes, the worker returns a 401 prompting
  `cowork-zai-login`. If `api.z.ai` rejects the credential with 401 mid-session,
  the worker's 401 intercept surfaces the same re-login message. The user re-runs
  the browser login; the resolved `{apiKey}.{secret}` is typically the same API
  key (find-or-create reuses `zcode-api-key`), so the only thing that changes is
  the freshness of the underlying authorization. This is the closest achievable
  behavior to "refresh" and the plan is explicit that true silent refresh is not
  possible.

## Configuration

New settings profile (rendered to `~/.claude/settings.zaisub.json` by
`install.sh`):

```json
{
  "_comment": "Z.ai GLM Coding Plan (subscription). Run `cowork-zai-login` after install to mint the credential; the proxy holds the real key, so ANTHROPIC_AUTH_TOKEN below is just a gating sentinel (any >=32-char string).",
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "0",
    "ANTHROPIC_BASE_URL": "http://localhost:8787/zaisub",
    "ANTHROPIC_AUTH_TOKEN": "REPLACE_WITH_ZAISUB_SENTINEL_ANY_32_PLUS_CHARS"
  },
  "permissions": { "defaultMode": "bypassPermissions", "dangerouslySkipPermissions": true },
  "model": "glm-5.2",
  "skipWebFetchPreflight": true,
  "skipDangerousModePermissionPrompt": true
}
```

- `ANTHROPIC_BASE_URL = http://localhost:8787/zaisub` — the **only** field that
  selects the backend (path-prefix routing, identical to the existing three
  templates).
- `ANTHROPIC_AUTH_TOKEN` — a >=32-char **sentinel**. The proxy no longer forwards
  the caller's key upstream on this route; it uses the resolved credential. The
  sentinel only needs to pass `validateApiKey`'s 32-char gate (`auth.ts:26`). A
  real, secret value is fine too; it just won't be used upstream.
- `model = "glm-5.2"` — forwarded unchanged (no OpenRouter model mapping on
  `/zaisub`). Override per-request via the path
  (`/zaisub/glm-4.7/v1/messages`) or `X-Upstream-Url`.

Credential store (NOT in `settings/`, lives in a state dir, git-ignored):

- Default path: `${XDG_CONFIG_HOME:-$HOME/.config}/claude-cowork-local/zai-credential.json`
- Override: `CLAUDE_COWORK_STATE_DIR` env var.
- Mode 600. Contains `{ apiKey, secret, userId, jwt, provider, resolvedAt, expiresAt? }`.

## Edge Cases & Risks

- **No refresh token (highest-impact).** Verified: the resolved credential
  expires/gets-rejected and the user must re-run `cowork-zai-login`. Long-running
  sessions will see a 401 mid-stream. Mitigation: clear 401 messaging; document
  the re-login step; consider a `cowork-zai-status` helper that prints the
  credential's `resolvedAt`/`expiresAt`. There is no way to make this silent.
- **ToS / account ban risk.** The GLM Coding Plan is officially restricted to
  sanctioned tools; spoofing the ZCode desktop fingerprint (`User-Agent: ZCode/...`,
  `X-ZCode-Agent: glm`, `HTTP-Referer: https://zcode.z.ai`) to look like the
  official client is itself a ToS risk. Claude Code is on the sanctioned list,
  which reduces but does not eliminate the risk. Surface this in the README and
  the login CLI's startup banner.
- **Unknown-field tolerance.** The translator injects `prompt_cache_key`
  (`anthropic-to-openai.ts:130`) and `stream_options:{include_usage:true}`
  (`:104`). OpenClaw/Hermes drive `/paas/v4` with similar bodies, so api.z.ai very
  likely tolerates these, but if a request 400s, gate these two fields behind
  `!isZaisubUpstream(upstream)` (or behind an explicit allowlist) and re-test.
- **Identity-header drift.** Z.ai may rotate expected `X-ZCode-App-Version` or
  tighten fingerprint checks. Pin a known-good `appVersion` (zcode-api uses the
  ZCode 3.1.x bundle's) and make it overridable via env (`ZCODE_APP_VERSION`).
- **Cloudflare path cannot do interactive login.** The OAuth callback needs a
  localhost server + browser, impossible in a Worker. The login CLI is local-only;
  the Worker only consumes the resolved credential file. This is fine for this
  codebase (local Bun is the real run path; wrangler is vestigial), but the CF
  deploy cannot use this backend.
- **China vs international.** This plan implements `zai` (chat.z.ai, international).
  The `bigmodel` (bigmodel.cn) variant uses a different authorize URL
  (`bigmodel.cn/login?appId=zcode&redirect=&state=`), a non-oauth2 param style,
  and a different resolver path (no `z/login`; the access token is used directly
  as the biz `Authorization`). Mixing them silently fails. The OAuth module is
  config-driven (mirroring zcode-api's `AuthCodeConfig`), so adding bigmodel later
  is mostly config — but it is out of scope for v1.
- **Coding-plan vs start-plan.** The OAuth flow returns both a provider
  `access_token` and a zcode-plan `jwt` (`data.token`). This plan uses the
  **coding-plan** path (resolve to `{apiKey}.{secret}`), which is the documented,
  stable route. The **start-plan** path (Bearer `<jwt>` against
  `https://zcode.z.ai/api/v1/zcode-plan/chat/completions`, with captcha + injected
  ZCode system prompts) is more fragile and out of scope; the `jwt` is stored only
  for potential future use.
- **Billing bug precedent.** Hermes accidentally billed coding-plan subscribers
  against their wallet because PAYG endpoints were probed first. This plan does
  not probe — `/zaisub` hardcodes the coding-plan base URL
  (`api.z.ai/api/coding/paas/v4`), so there is no risk of mis-billing.
- **Quota.** Coding-plan quota is 5-hour + weekly prompt limits with a 3x peak
  multiplier (14:00–18:00 UTC+8). 429s flow through `upstreamErrorResponse`
  (forwards `Retry-After`/`RateLimit-*`).
- **Existing OpenRouter/Zen/Go routes must be unaffected.** All new headers are
  gated behind `isZaisubUpstream(upstream)`; the outbound fetch header literal at
  `index.ts:209-212` is only extended for the `/zaisub` branch, never for the
  shared paths.

## Testing Plan

**Unit (Bun test, no network):**

- `zai-oauth.test.ts`: mock `fetch` for the token exchange; verify the authorize
  URL is built with the correct `client_id`, `response_type=code`, `redirect_uri`,
  `state`; verify `data.zai.access_token` is extracted; verify `authCode`/`code`
  fallback and state-mismatch rejection (mirror zcode-api's `oauth.test.ts`).
- `zai-resolver.test.ts`: mock `fetch` for `z/login`, `getCustomerInfo`,
  `api_keys` list/create, `copy/<apiKey>`; verify `{apiKey}.{secret}` assembly and
  default org/project selection by marker; verify find-or-create reuses an
  existing `zcode-api-key`; verify apiKey-only fallback when `copy` fails.
- `zai-tokenstore.test.ts`: write/read/expire in a temp dir; verify mode 600.
- `zai-identity.test.ts`: verify the printable-ASCII gate drops bad values; verify
  platform/arch/osCategory mapping.

**Relay (the proxy, against a mock upstream):**

- `index.test.ts` (extend if present): for the `/zaisub` route, assert the outbound
  request to `${ZAISUB_UPSTREAM}/chat/completions` carries
  `Authorization: Bearer <apiKey>.<secret>` plus the ZCode identity headers, and
  does NOT carry the caller's sentinel. Assert a missing credential yields the
  "run cowork-zai-login" 401. Assert an expired credential yields the
  "re-run cowork-zai-login" 401. Assert a 401 from the upstream surfaces the
  re-login message.
- Assert OpenRouter/Zen/Go routes are byte-identical to before (no identity
  headers, `Bearer ${key}` from the caller) — regression guard.

**Integration (live, gated behind an env flag, requires a real Z.ai subscription):**

1. `cowork-zai-login` — complete the browser flow; verify
   `zai-credential.json` is written with `{apiKey, secret}`.
2. `curl http://localhost:8787/zaisub/v1/models` (with the sentinel Bearer) —
   verify a model list returns.
3. `claude --settings ~/.claude/settings.zaisub.json` — run a real
   `POST /v1/messages` (non-streaming) and verify a response from `glm-5.2`.
4. Repeat with `stream: true` — verify SSE translates correctly (thinking via
   `reasoning_content` is already handled by the stream translator per the
   analysis notes).
5. Vision: send a message with an image to `/zaisub` — note `glm-5.2` is
   text-only (index.ts:16 comment); either use a vision-capable GLM model
   (`glm-5v-turbo`) via path override or accept that vision escalates only on
   the OpenRouter route. Document the chosen behavior.
6. Confirm `prompt_cache_key`/`stream_options` are tolerated (else gate them).
7. Confirm quota/429 passthrough (force a rate limit or wait for a peak window).

## Out of Scope

- **Surface (B) — chat.z.ai consumer chat** (zai2api / ZtoApi / GLM-Free-API): the
  signed-HMAC `/api/v2/chat/completions` path with the hard-coded `SIGNING_SECRET`
  and fake-browser fingerprint. Different endpoints, different models, different
  quotas, much higher ToS/brittleness risk. Not implemented.
- **Start-plan path** (Bearer `<zcode JWT>` against `zcode.z.ai/.../zcode-plan/...`
  with captcha + injected ZCode system prompts). Stored JWT is kept for potential
  future use, but not wired.
- **Bigmodel (China) provider.** The OAuth module is config-driven so this is
  additive later, but v1 ships `zai` only.
- **True silent refresh.** Not possible — there is no refresh token. Re-login is
  the only path. (If Z.ai ever ships a refresh-token flow, the natural home is a
  `zai-refresh.ts` alongside `zai-oauth.ts`, called lazily in `handleRequest`
  before forwarding — but the research found no such flow exists.)
- **Cloudflare Workers interactive login.** Impossible; the OAuth layer is
  local-Bun-only. The Cloudflare deploy path would need a separately-resolved key
  injected via a `[secrets]` binding (the closest viable alternative below).

## Closest Viable Alternative (if the OAuth layer is rejected)

If the ToS risk, the "no refresh token" limitation, or the maintenance burden of
the OAuth + identity-header layer is unacceptable, **the relay layer (Steps 1-2
only) already works as a pure static-key backend** using the OpenClaw/Hermes model:

1. Run the official **ZCode desktop app** once (or run zcode-api locally just to
   mint a key), complete its login, and extract the resolved `{apiKey}.{secret}`
   from the account (or create an API key named `zcode-api-key` in the Z.ai
   console).
2. Paste it as `ANTHROPIC_AUTH_TOKEN` in `~/.claude/settings.zaisub.json`.
3. The proxy routes `/zaisub` → `https://api.z.ai/api/coding/paas/v4` with
   `Authorization: Bearer <apiKey>.<secret>` exactly as in Step 7, but the
   credential comes from the caller's header instead of the tokenstore — i.e. the
   existing static-key relay model. **No `zai-oauth.ts`, `zai-resolver.ts`,
   `zai-tokenstore.ts`, `zai-login.ts`, or identity headers.**

Trade-offs vs the full plan: no in-proxy login UX, no automatic credential
resolution, manual re-paste when the key is revoked/rejected, and arguably lower
ToS risk (you're not replaying the OAuth client_id — but you are still using a
Coding-Plan key outside the sanctioned ZCode client, so the ToS grey-area
remains). The translator and route work are identical. This is the recommended
first milestone: ship Steps 1-2 + the manual-key path, validate end-to-end against
`api.z.ai/api/coding/paas/v4`, then layer in the OAuth login CLI (Steps 3-9) if the
manual path is too painful.

## Open Questions

1. What is the actual expiry/revocation behavior of the resolved
   `{apiKey}.{secret}`? The OAuth response carries an expiry for
   `data.zai.access_token`, but the **derived** api.z.ai API key may be long-lived
   and independently revocable from the Z.ai console. Need empirical testing to
   know whether re-login is "rarely" or "often." This drives how prominent the
   re-login UX must be.
2. Does `api.z.ai/api/coding/paas/v4` require `metadata.user_id` on the body (zcode-api
   injects it for the Anthropic-format upstream)? The OpenAI-format path likely
   ignores it; if required, gate a small injection behind `isZaisubUpstream`.
3. Should `validateApiKey` be relaxed for `/zaisub`? Today the caller must send a
   >=32-char key (`auth.ts:26`). Since the proxy holds the real credential and the
   caller key is a sentinel, the template's `ANTHROPIC_AUTH_TOKEN` must be >=32
   chars, OR `handleRequest` special-cases `/zaisub` to skip `validateApiKey`.
   Minor; needs a decision (recommend keeping the gate — a 32-char sentinel is
   trivial).
4. Does `api.z.ai/api/coding/paas/v4` accept `prompt_cache_key` and
   `stream_options.include_usage`, or must they be gated off for `/zaisub`?
   Verify with a real request during integration testing.
5. Bigmodel (China) support: in scope for a fast-follow or defer to v2?
6. Should `/v1/models` on `/zaisub` proxy the upstream model list or return a
   static coding-plan catalog (e.g. `glm-5.2`, `glm-5.1`, `glm-4.7`)? Proxied is
   simpler and matches the non-OpenRouter behavior; static gives a cleaner
   Claude Desktop picker. Either is a small change at `index.ts:295-318`.
