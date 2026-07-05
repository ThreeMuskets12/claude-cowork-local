/**
 * Worker-side OpenAI credential resolution with silent refresh.
 *
 * Unlike Z.ai (no refresh token → re-login on rejection), OpenAI issues a
 * refresh token, so the worker refreshes the access token in place before it
 * expires and re-saves it. Callers get a ready-to-use credential or an error.
 */
import { loadCredential, saveCredential } from "./tokenstore";
import { needsRefresh, type OpenAiCredential } from "./credential";
import { refreshTokens } from "./oauth";

/** Load the credential, refreshing if near expiry. Returns null if absent, throws on refresh failure. */
export async function getValidCredential(force = false): Promise<OpenAiCredential | null> {
  const cred = loadCredential();
  if (!cred) return null;
  if (!force && !needsRefresh(cred)) return cred;

  const tokens = await refreshTokens(cred.refreshToken);
  const updated: OpenAiCredential = {
    ...cred,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId,
    resolvedAt: Date.now(),
  };
  saveCredential(updated);
  return updated;
}
