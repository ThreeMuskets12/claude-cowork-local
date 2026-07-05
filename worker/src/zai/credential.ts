/**
 * Z.ai GLM Coding Plan credential type + helpers.
 *
 * A resolved credential is the `{apiKey}.{secret}` pair minted through the
 * ZCode subscription OAuth flow (see oauth.ts / resolver.ts). It is used as a
 * plain Bearer token against Z.ai's OpenAI-compatible coding endpoint.
 */

export interface ZaiCredential {
  /** API key id (the part before the dot). */
  apiKey: string;
  /** Secret (the part after the dot); Z.ai keys are `{apiKey}.{secret}`. */
  secret?: string;
  /** Upstream user id from the OAuth response, if any. */
  userId?: string;
  /** ZCode plan JWT (data.token) — stored for potential start-plan use; unused today. */
  jwt?: string;
  /**
   * Unix ms when the *provider access token* expired, if the OAuth response
   * carried one. The derived api.z.ai key may outlive this; treated as a soft
   * hint, not a hard gate (Z.ai enforces the real lifetime server-side).
   */
  expiresAt?: number;
  provider: "zai";
  /** Unix ms when this credential was resolved. */
  resolvedAt: number;
}

/** The string sent upstream: `{apiKey}.{secret}` (or bare apiKey if no secret). */
export function credentialString(cred: ZaiCredential): string {
  return cred.secret ? `${cred.apiKey}.${cred.secret}` : cred.apiKey;
}

/** Soft-expiry check against the provider access token's `expiresAt`, if present. */
export function isExpired(cred: ZaiCredential, now: number = Date.now()): boolean {
  return cred.expiresAt !== undefined && now >= cred.expiresAt;
}
