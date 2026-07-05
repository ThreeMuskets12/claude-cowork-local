/**
 * OpenAI ChatGPT-subscription (Codex) OAuth — auth-code flow with PKCE.
 *
 * Constants verified against numman-ali/opencode-openai-codex-auth (which
 * mirrors OpenAI's own Codex CLI):
 *   - client_id  app_EMoamEEZ73f0CkXaXp7hrann  (Codex public client)
 *   - authorize  https://auth.openai.com/oauth/authorize
 *   - token      https://auth.openai.com/oauth/token
 *   - redirect   http://localhost:1455/auth/callback  (fixed port — the client
 *                is registered with this exact redirect URI)
 *   - scope      openid profile email offline_access  (offline_access → refresh token)
 *
 * The ChatGPT account id is a claim inside the access-token JWT
 * (`https://api.openai.com/auth` → `chatgpt_account_id`) and is required as the
 * `chatgpt-account-id` header on codex requests.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_REDIRECT_PORT = 1455;
export const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_REDIRECT_PORT}/auth/callback`;
const OPENAI_SCOPE = "openid profile email offline_access";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type FetchFn = typeof fetch;

export interface OpenAiTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

// ---- PKCE ---------------------------------------------------------------
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge: string, state: string, redirectUri: string = OPENAI_REDIRECT_URI): string {
  const url = new URL(OPENAI_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OPENAI_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", OPENAI_SCOPE);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  url.searchParams.set("id_token_add_organizations", "true");
  url.searchParams.set("codex_cli_simplified_flow", "true");
  url.searchParams.set("originator", "codex_cli_rs");
  return url.toString();
}

// ---- JWT / account id ---------------------------------------------------
export function decodeJwt(token: string): any | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

export function extractAccountId(accessToken: string): string {
  const payload = decodeJwt(accessToken);
  const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  if (typeof accountId !== "string" || !accountId) {
    throw new Error("Failed to extract chatgpt_account_id from access token");
  }
  return accountId;
}

// ---- token exchange / refresh ------------------------------------------
function tokensFromResponse(json: any): OpenAiTokens {
  if (!json?.access_token || !json?.refresh_token || typeof json?.expires_in !== "number") {
    throw new Error("OpenAI token response missing access_token/refresh_token/expires_in");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

export async function exchangeCode(code: string, verifier: string, redirectUri: string = OPENAI_REDIRECT_URI, fetchImpl: FetchFn = fetch): Promise<OpenAiTokens> {
  const res = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`OpenAI code exchange failed: ${res.status} ${await res.text().catch(() => "")}`);
  return tokensFromResponse(await res.json());
}

export async function refreshTokens(refreshToken: string, fetchImpl: FetchFn = fetch): Promise<OpenAiTokens> {
  const res = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  });
  if (!res.ok) throw new Error(`OpenAI token refresh failed: ${res.status}`);
  const json: any = await res.json();
  // A refresh may or may not rotate the refresh token; keep the old one if absent.
  if (!json.refresh_token) json.refresh_token = refreshToken;
  return tokensFromResponse(json);
}

// ---- interactive login --------------------------------------------------
export async function runOpenAiOAuth(
  onAuthorizeUrl: (url: string) => void,
  opts: { timeoutMs?: number; fetchImpl?: FetchFn } = {},
): Promise<OpenAiTokens> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString("hex");

  let server: Server | null = null;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("Authorization timed out. Please retry login.")); }
      }, timeoutMs);

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", `http://localhost:${OPENAI_REDIRECT_PORT}`);
        if (url.pathname !== "/auth/callback") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        const gotState = url.searchParams.get("state") ?? "";
        const gotCode = url.searchParams.get("code") ?? "";
        if (gotState !== state || !gotCode) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Authorization failed: state mismatch or missing code.");
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error("OAuth callback state mismatch or missing code.")); }
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Authorization successful! You may close this window and return to the CLI.");
        if (!settled) { settled = true; clearTimeout(timer); resolve(gotCode); }
      });
      server.on("error", (e: Error) => { if (!settled) { settled = true; clearTimeout(timer); reject(e); } });
      // Fixed port: the OAuth client is registered with this exact redirect URI.
      server.listen(OPENAI_REDIRECT_PORT, "127.0.0.1", () => {
        onAuthorizeUrl(buildAuthorizeUrl(challenge, state));
      });
    });
    return await exchangeCode(code, verifier, OPENAI_REDIRECT_URI, fetchImpl);
  } finally {
    if (server) await new Promise<void>((r) => (server as Server).close(() => r()));
  }
}
