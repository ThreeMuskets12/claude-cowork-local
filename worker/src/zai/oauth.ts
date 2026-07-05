/**
 * Z.ai (ZCode "GLM Coding Plan") subscription OAuth — auth-code flow.
 *
 * Ported from TriDefender/zcode-api (src/auth/oauth.ts), reduced to the single
 * `zai` (international, chat.z.ai) provider this proxy targets. The flow:
 *
 *   1. Start a localhost callback server on a random port.
 *   2. Open `chat.z.ai/api/oauth/authorize` in a browser (oauth2 params).
 *   3. User signs in; provider redirects to the localhost callback with
 *      `?authCode=…&state=…` (param name `authCode`, falling back to `code`).
 *   4. POST the code to the shared `zcode.z.ai/api/v1/oauth/token` endpoint,
 *      which holds the app secret and performs the real provider exchange.
 *   5. Extract `data.zai.access_token` (provider token), `data.token` (plan
 *      JWT), and `data.user.user_id`.
 *
 * `node:http` is used for the callback server so this runs identically under
 * Bun (the production runtime) and Node/Deno (for tests).
 *
 * There is NO refresh token in this flow — when the resolved credential is
 * rejected, the user re-runs the login. See PLAN.md and README.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

/** Shared token-exchange endpoint (holds the app secret server-side). */
export const ZCODE_TOKEN_ENDPOINT = "https://zcode.z.ai/api/v1/oauth/token";
/** The official ZCode desktop app's OAuth client id (reverse-engineered). */
export const ZAI_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const ZAI_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const ZAI_CALLBACK_PATH = "/oauth/callback/zai";

export interface OAuthResult {
  /** Provider access token (data.zai.access_token) — feeds the resolver. */
  accessToken: string;
  /** Upstream user id (data.user.user_id), if present. */
  userId?: string;
  /** ZCode plan JWT (data.token), if present. */
  jwt?: string;
}

interface TokenExchangeResponse {
  code?: number;
  data?: {
    token?: string;
    user?: { user_id?: string };
  } & Record<string, unknown>;
  msg?: string;
}

type FetchFn = typeof fetch;

/**
 * Run the full Z.ai OAuth flow. `onAuthorizeUrl` is called with the URL the
 * user must open in a browser. Resolves once the localhost callback fires and
 * the code is exchanged.
 */
export async function runZaiOAuth(
  onAuthorizeUrl: (url: string) => void,
  opts: { timeoutMs?: number; fetchImpl?: FetchFn } = {},
): Promise<OAuthResult> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const state = randomBytes(32).toString("hex");

  let server: Server | null = null;
  try {
    const { code, callbackUrl } = await new Promise<{ code: string; callbackUrl: string }>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Authorization timed out. Please retry login."));
      }, timeoutMs);

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== ZAI_CALLBACK_PATH) {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
          return;
        }
        const gotState = url.searchParams.get("state") ?? "";
        const gotCode = url.searchParams.get("authCode") ?? url.searchParams.get("code") ?? "";
        if (gotState !== state || !gotCode) {
          res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Authorization failed: state mismatch or missing code.");
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(new Error("OAuth callback state mismatch or missing code."));
          }
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Authorization successful! You may close this window and return to the CLI.");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const addr = server!.address();
          const port = addr && typeof addr === "object" ? addr.port : 0;
          resolve({ code: gotCode, callbackUrl: `http://127.0.0.1:${port}${ZAI_CALLBACK_PATH}` });
        }
      });

      server.on("error", (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });

      server.listen(0, "127.0.0.1", () => {
        const addr = server!.address();
        if (!addr || typeof addr !== "object") {
          reject(new Error("Failed to bind localhost callback server"));
          return;
        }
        const callbackUrl = `http://127.0.0.1:${addr.port}${ZAI_CALLBACK_PATH}`;
        onAuthorizeUrl(buildAuthorizeUrl(callbackUrl, state));
      });
    });

    return await exchangeCode(code, callbackUrl, state, fetchImpl);
  } finally {
    if (server) await new Promise<void>((r) => (server as Server).close(() => r()));
  }
}

export function buildAuthorizeUrl(callbackUrl: string, state: string): string {
  const params = new URLSearchParams({
    redirect_uri: callbackUrl,
    response_type: "code",
    client_id: ZAI_CLIENT_ID,
    state,
  });
  return `${ZAI_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange the auth code at the shared zcode.z.ai token endpoint. */
export async function exchangeCode(
  authCode: string,
  redirectUri: string,
  state: string,
  fetchImpl: FetchFn = fetch,
): Promise<OAuthResult> {
  const resp = await fetchImpl(ZCODE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider: "zai", code: authCode, redirect_uri: redirectUri, state }),
  });
  let raw: TokenExchangeResponse | null = null;
  try {
    raw = JSON.parse(await resp.text());
  } catch {
    raw = null;
  }
  if (!resp.ok || (raw && typeof raw.code === "number" && raw.code !== 0)) {
    throw new Error(`zai token exchange failed: status=${resp.status} msg=${raw?.msg ?? "(none)"}`);
  }
  const providerToken = raw?.data?.["zai"] as { access_token?: string } | undefined;
  const accessToken = providerToken?.access_token?.trim() ?? "";
  if (!accessToken) {
    throw new Error("zai token response missing data.zai.access_token");
  }
  const userId = raw?.data?.user?.user_id;
  const jwt = raw?.data?.token?.trim() || undefined;
  return { accessToken, userId: typeof userId === "string" ? userId : undefined, jwt };
}
