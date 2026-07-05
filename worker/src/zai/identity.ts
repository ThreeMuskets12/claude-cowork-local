/**
 * ZCode desktop-client fingerprint headers.
 *
 * The real ZCode client stamps every upstream request with identity headers
 * (User-Agent, X-ZCode-*, X-Platform, ...) AND per-request trace headers
 * (x-request-id, x-zcode-trace-id, x-query-id, x-session-id). Emitting both
 * makes the proxy indistinguishable from the official client at the
 * fingerprinting layer.
 *
 * Identity headers are ported field-for-field from zcode-api's
 * `buildIdentityHeaders` (src/proxy/identity.ts). Trace headers mirror the
 * bundle's default "observe" mode (random UUIDs) — these were absent from the
 * original PLAN.md and are added here for closer fidelity.
 *
 * NOTE: these are gated to the /zaisub route in index.ts; they never touch the
 * OpenRouter/Zen/Go upstreams.
 */
import os from "node:os";

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

function printable(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim();
  return v.length > 0 && ASCII_PRINTABLE.test(v) ? v : undefined;
}

function osCategory(platform: NodeJS.Platform | string): string {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

/** Pinned ZCode desktop app version; override with ZCODE_APP_VERSION. */
const DEFAULT_APP_VERSION = "3.1.0";

export function buildZaiIdentityHeaders(): Record<string, string> {
  const appVersion = printable(process.env.ZCODE_APP_VERSION ?? DEFAULT_APP_VERSION);
  const platform = printable(process.platform);
  const arch = printable(os.arch());
  const release = printable(os.release());
  return {
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": "Z Code@cli",
    "X-ZCode-Agent": "glm",
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    "X-Os-Category": osCategory(process.platform),
    ...(release ? { "X-Os-Version": release } : {}),
  };
}

/** Fresh per-request trace headers (default "observe" mode: random UUIDs). */
export function buildZaiTraceHeaders(): Record<string, string> {
  return {
    "x-request-id": crypto.randomUUID(),
    "x-zcode-trace-id": crypto.randomUUID(),
    "x-query-id": crypto.randomUUID(),
    "x-session-id": crypto.randomUUID(),
  };
}
