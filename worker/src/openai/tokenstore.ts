/**
 * On-disk store for the OpenAI ChatGPT-subscription credential.
 * Same model as the Z.ai store: plain JSON, mode 0600, in a state dir outside
 * the repo. The worker refreshes the access token in place using the refresh
 * token, so this file is rewritten whenever a refresh happens.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { OpenAiCredential } from "./credential";

export function storePath(): string {
  const stateDir =
    process.env.CLAUDE_COWORK_STATE_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-cowork-local");
  return join(stateDir, "openai-credential.json");
}

export function loadCredential(): OpenAiCredential | null {
  const path = storePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as OpenAiCredential;
  } catch {
    return null;
  }
}

export function saveCredential(cred: OpenAiCredential): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* non-POSIX filesystem */
  }
}

export function clearCredential(): void {
  const path = storePath();
  if (existsSync(path)) unlinkSync(path);
}
