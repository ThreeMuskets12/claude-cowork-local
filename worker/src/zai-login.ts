/**
 * Interactive Z.ai subscription login CLI (`cowork-zai-login`).
 *
 * Runs the ZCode OAuth flow, resolves the coding-plan `{apiKey}.{secret}`, and
 * writes it to the credential store the worker reads. This is a separate
 * one-shot process — the worker itself stays a stateless relay.
 *
 * Subcommands:
 *   (none)   run the browser login and save the credential
 *   status   print the stored credential's metadata
 *   logout   delete the stored credential
 */
import { spawn } from "node:child_process";
import { runZaiOAuth } from "./zai/oauth";
import { resolveCodingPlanCredential } from "./zai/resolver";
import { saveCredential, loadCredential, clearCredential, storePath } from "./zai/tokenstore";
import { credentialString } from "./zai/credential";

function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true, shell: process.platform === "win32" }).unref();
  } catch {
    /* best-effort; the URL is printed regardless */
  }
}

async function login(): Promise<void> {
  console.log("\n⚠️  Using the Z.ai GLM Coding Plan through a custom proxy is a ToS grey area.");
  console.log("    Proceed only if you accept the account-ban risk.\n");
  const oauth = await runZaiOAuth((url) => {
    console.log("Open this URL to sign in to Z.ai (Z.ai / GitHub / Google):\n");
    console.log("  " + url + "\n");
    console.log("Waiting for authorization…");
    openInBrowser(url);
  });
  console.log("Authorization received. Resolving coding-plan credential…");
  const cred = await resolveCodingPlanCredential(oauth);
  saveCredential(cred);
  const shown = credentialString(cred);
  console.log(`\n✓ Z.ai credential saved to ${storePath()}`);
  console.log(`  key: ${shown.slice(0, 8)}…${shown.slice(-4)}${cred.userId ? `  user: ${cred.userId}` : ""}`);
  console.log("\nNow run:  claude --settings ~/.claude/settings.zaisub.json\n");
}

function status(): void {
  const cred = loadCredential();
  if (!cred) {
    console.log(`No Z.ai credential found (${storePath()}). Run \`cowork-zai-login\` to sign in.`);
    return;
  }
  const shown = credentialString(cred);
  console.log(`Z.ai credential: ${storePath()}`);
  console.log(`  provider:   ${cred.provider}`);
  console.log(`  key:        ${shown.slice(0, 8)}…${shown.slice(-4)}`);
  if (cred.userId) console.log(`  user:       ${cred.userId}`);
  console.log(`  resolvedAt: ${new Date(cred.resolvedAt).toISOString()}`);
  if (cred.expiresAt) console.log(`  expiresAt:  ${new Date(cred.expiresAt).toISOString()}`);
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  if (sub === "status") return status();
  if (sub === "logout") {
    clearCredential();
    console.log("Z.ai credential cleared.");
    return;
  }
  await login();
}

main().catch((e) => {
  console.error(`\n✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
