/**
 * Resolve a ZCode OAuth access token into a Z.ai coding-plan `{apiKey}.{secret}`.
 *
 * Ported from TriDefender/zcode-api (src/auth/resolver.ts), `zai` branch. Four
 * upstream calls against api.z.ai:
 *   1. POST /api/auth/z/login            {token} -> bizToken
 *   2. GET  /api/biz/customer/getCustomerInfo    -> default org + project
 *   3. GET/POST .../api_keys                     -> find-or-create "zcode-api-key"
 *   4. GET  .../api_keys/copy/{apiKey}           -> secret
 */
import type { OAuthResult } from "./oauth";
import type { ZaiCredential } from "./credential";

const BIZ_HOST = "https://api.z.ai";
const ZAI_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "默认机构"; // 默认机构
const DEFAULT_PROJECT_MARKER = "默认项目"; // 默认项目

type FetchFn = typeof fetch;

async function requestBizApi(fetchImpl: FetchFn, url: string, authorization: string, init?: RequestInit): Promise<any> {
  const resp = await fetchImpl(url, {
    ...init,
    headers: { Authorization: authorization, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`Biz API ${url} failed: ${resp.status}`);
  const body: any = await resp.json();
  const code = body.code ?? body.status;
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new Error(body.msg ?? `Biz API error ${code}`);
  }
  return body.data ?? body;
}

export async function resolveCodingPlanCredential(oauth: OAuthResult, fetchImpl: FetchFn = fetch): Promise<ZaiCredential> {
  // 1. provider access token -> bizToken
  const loginResp = await fetchImpl(`${BIZ_HOST}/api/auth/z/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: oauth.accessToken }),
  });
  if (!loginResp.ok) throw new Error(`z/login failed: ${loginResp.status}`);
  const loginData: any = await loginResp.json();
  const bizToken = loginData.access_token ?? loginData.accessToken ?? loginData.data?.access_token;
  if (!bizToken) throw new Error("z/login response missing access token");
  const authorization = `Bearer ${bizToken}`;

  // 2. customer info -> default org + project
  const info = await requestBizApi(fetchImpl, `${BIZ_HOST}/api/biz/customer/getCustomerInfo`, authorization, { method: "GET" });
  const orgs: any[] = info.organizations ?? info.orgs ?? [];
  if (!Array.isArray(orgs) || orgs.length === 0) throw new Error("No organizations found");
  const org = orgs.find((o) => (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER)) ?? orgs[0];
  const orgId = org.organizationId ?? org.id ?? org.orgId;
  const projects: any[] = org.projects ?? [];
  if (!Array.isArray(projects) || projects.length === 0) throw new Error("No projects found in default organization");
  const project = projects.find((p) => (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER)) ?? projects[0];
  const projectId = project.projectId ?? project.id;

  // 3. find-or-create the named api key
  const keysUrl = `${BIZ_HOST}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;
  let apiKey: string | undefined;
  try {
    const existing: any[] = (await requestBizApi(fetchImpl, keysUrl, authorization, { method: "GET" })) ?? [];
    if (Array.isArray(existing)) apiKey = existing.find((k) => k.name === ZAI_API_KEY_NAME)?.apiKey;
  } catch {
    /* ignore — will create */
  }
  if (!apiKey) {
    const created = await requestBizApi(fetchImpl, keysUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    });
    apiKey = created.apiKey;
  }
  if (!apiKey) throw new Error("Failed to resolve or create api key");

  // 4. fetch the secret (credential is apiKey-only if this fails)
  let secret: string | undefined;
  try {
    const copy = await requestBizApi(fetchImpl, `${keysUrl}/copy/${encodeURIComponent(apiKey)}`, authorization, { method: "GET" });
    secret = copy.secretKey ?? copy.secret_key ?? undefined;
  } catch {
    /* apiKey-only */
  }

  return {
    apiKey,
    secret: secret || undefined,
    userId: oauth.userId,
    jwt: oauth.jwt,
    provider: "zai",
    resolvedAt: Date.now(),
  };
}
