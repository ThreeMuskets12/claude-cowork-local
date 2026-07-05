/**
 * OpenAI ChatGPT-subscription (Codex) credential.
 *
 * Obtained via the Codex OAuth flow (PKCE). Unlike Z.ai, OpenAI DOES issue a
 * refresh token, so the worker can refresh silently before expiry.
 */

export interface OpenAiCredential {
  /** OAuth access token (JWT) — Bearer against the codex backend. */
  accessToken: string;
  /** Refresh token — used to mint a new access token without re-login. */
  refreshToken: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
  /** ChatGPT account id (from the access-token JWT) — the chatgpt-account-id header. */
  accountId: string;
  provider: "openai";
  resolvedAt: number;
}

/** Refresh a bit early to avoid using a token that expires mid-flight. */
const REFRESH_SKEW_MS = 60_000;

export function needsRefresh(cred: OpenAiCredential, now: number = Date.now()): boolean {
  return now >= cred.expiresAt - REFRESH_SKEW_MS;
}
