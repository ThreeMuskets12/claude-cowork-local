/**
 * Interactive OpenAI ChatGPT-subscription login CLI (`cowork-openai-login`).
 *
 * Runs the Codex OAuth flow (PKCE), extracts the ChatGPT account id, and stores
 * the access + refresh tokens. The worker refreshes silently thereafter.
 *
 * Subcommands: (none) login | status | logout.
 */
import { spawn } from "node:child_process";
import { runOpenAiOAuth } from "./openai/oauth";
import { saveCredential, loadCredential, clearCredential, storePath } from "./openai/tokenstore";
import type { OpenAiCredential } from "./openai/credential";

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* best-effort */
  }
}

async function login(): Promise<void> {
  console.log("\n⚠️  Driving a ChatGPT Plus/Pro subscription through a custom proxy is a ToS grey area.");
  console.log("    Proceed only if you accept the account-risk.\n");
  const tokens = await runOpenAiOAuth((url) => {
    console.log("Open this URL to sign in to ChatGPT:\n");
    console.log("  " + url + "\n");
    console.log("Waiting for authorization (callback on http://localhost:1455)…");
    openInBrowser(url);
  });
  const cred: OpenAiCredential = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    accountId: tokens.accountId,
    provider: "openai",
    resolvedAt: Date.now(),
  };
  saveCredential(cred);
  console.log(`\n✓ OpenAI credential saved to ${storePath()}`);
  console.log(`  account: ${cred.accountId}   expires: ${new Date(cred.expiresAt).toISOString()}`);
  console.log("\nNow run:  claude --settings ~/.claude/settings.router.json  (pick Sonnet 5)\n");
}

function status(): void {
  const cred = loadCredential();
  if (!cred) {
    console.log(`No OpenAI credential found (${storePath()}). Run \`cowork-openai-login\` to sign in.`);
    return;
  }
  console.log(`OpenAI credential: ${storePath()}`);
  console.log(`  account:    ${cred.accountId}`);
  console.log(`  expiresAt:  ${new Date(cred.expiresAt).toISOString()}${Date.now() >= cred.expiresAt ? " (expired — will refresh on next use)" : ""}`);
  console.log(`  resolvedAt: ${new Date(cred.resolvedAt).toISOString()}`);
  console.log(`  refresh:    ${cred.refreshToken ? "present (silent refresh enabled)" : "MISSING"}`);
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "status") return status();
  if (sub === "logout") {
    clearCredential();
    console.log("OpenAI credential cleared.");
    return;
  }
  await login();
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
