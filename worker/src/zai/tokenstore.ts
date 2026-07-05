/**
 * On-disk credential store for the Z.ai coding-plan credential.
 *
 * The worker is otherwise stateless; this is the one persistent bit. The
 * credential is written as plain JSON with mode 0600 in a state directory
 * outside the repo (so it is never committed). We deliberately do NOT encrypt
 * at rest: any key we could derive locally would live next to the ciphertext,
 * making it obfuscation rather than protection. File permissions are the real
 * control — keep the state dir private.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ZaiCredential } from "./credential";

export function storePath(): string {
  const stateDir =
    process.env.CLAUDE_COWORK_STATE_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-cowork-local");
  return join(stateDir, "zai-credential.json");
}

export function loadCredential(): ZaiCredential | null {
  const path = storePath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ZaiCredential;
  } catch {
    return null;
  }
}

export function saveCredential(cred: ZaiCredential): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cred, null, 2), { mode: 0o600 });
  try {
    chmodSync(path, 0o600); // belt-and-suspenders (writeFileSync mode is umask-masked)
  } catch {
    /* non-POSIX filesystem */
  }
}

export function clearCredential(): void {
  const path = storePath();
  if (existsSync(path)) unlinkSync(path);
}
