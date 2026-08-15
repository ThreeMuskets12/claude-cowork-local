import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';
import {
  findWebSearchTool, toOpenRouterWebSearchTool, toZaiWebSearchTool, toOpenAiWebSearchTool,
  extractResultsFromZai, extractResultsFromAnnotations, webSearchBlocks, buildServerToolMessage,
  lastUserText, anthropicMessageToSSE,
} from './websearch';
import { findWebFetchTool, webFetchFunctionTool } from './webfetch';
import { runWebToolLoop, streamWebToolLoop } from './webtools';
import { loadCredential as loadZaiCredential } from './zai/tokenstore';
import { credentialString as zaiCredentialString, isExpired as zaiExpired } from './zai/credential';
import { buildZaiIdentityHeaders, buildZaiTraceHeaders } from './zai/identity';
import { ZAI_MODELS, ZAI_VISION_MODEL } from './zai/models';
import { getValidCredential as getOpenAiCredential } from './openai/auth';
import { buildCodexHeaders, chatCompletionsToResponses, streamResponsesToOpenAIChat, collectResponsesToChatCompletion, CODEX_RESPONSES_URL } from './openai/responses';

const OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1";
const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
// Z.ai GLM Coding Plan (subscription). The /zaisub route uses a credential
// minted via the ZCode OAuth flow (run `cowork-zai-login`) as a Bearer key
// against this OpenAI-compatible endpoint.
const ZAISUB_UPSTREAM = "https://api.z.ai/api/coding/paas/v4";
const DEFAULT_UPSTREAM = OPENROUTER_UPSTREAM;
// ── /openrouter route catalog ─────────────────────────────────────────────
// The models the /openrouter route advertises (Claude Desktop's picker reads
// GET /v1/models). Single entry: everything on this route runs Gemini 3.7
// Flash through OpenRouter's :nitro (throughput-optimized) providers.
const OPENROUTER_MODEL = "google/gemini-3.7-flash:nitro";
// Advertised under the Anthropic alias claude-sonnet-5 so Claude Code's
// picker and status line show "Sonnet 5"; the upstream is still Gemini.
// The [1m] suffix is what makes Claude Code use a 1M context window instead of
// its 200k default — it keys the window off the model id, not off /v1/models.
// Gemini 3.7 Flash's real window is 1,048,576, so the claim holds upstream.
const MODEL_CATALOG: Array<{ id: string; display_name: string; created_at: string; upstream: string }> = [
  { id: "claude-sonnet-5[1m]", display_name: "Claude Sonnet 5 (1M context)", created_at: "2026-05-15T00:00:00Z", upstream: OPENROUTER_MODEL },
];

// Gemini 3.7 Flash is multimodal, so image requests need no escalation.
const VISION_MODEL = OPENROUTER_MODEL;
// Gemini's reasoning is mandatory and billed against max_tokens, so a small
// cap is spent entirely on thinking and comes back finish_reason "length" with
// no text at all (measured: 128 tokens → empty). Claude Code's background
// calls — titles, summaries — set caps that low, so floor the upstream cap.
const GEMINI_MIN_OUTPUT_TOKENS = 1024;

// ── /router route: one picker, three backends ─────────────────────────────
// The /router route advertises three Anthropic aliases and dispatches each to
// a DIFFERENT real backend (no fallback — one model, one backend):
//   Fable 5  → OpenRouter GLM 5.2 :nitro (fastest provider)
//   Opus 4.8 → Z.ai GLM 5.2 (subscription, OAuth)
//   Sonnet 5 → OpenAI GPT-5.5 (ChatGPT subscription, OAuth, Responses API)
// Effort is mapped to whatever each backend actually respects.
type RouterBackend = "openrouter" | "zaisub" | "openai";
interface ModelRoute {
  id: string;
  display_name: string;
  created_at: string;
  backend: RouterBackend;
  upstreamModel: string;
  effort: "glm" | "openai";
  vision?: string; // vision-capable substitute for image requests (text-only models)
}
const MODEL_ROUTES: ModelRoute[] = [
  { id: "claude-fable-5",  display_name: "Claude Fable 5",  created_at: "2026-06-01T00:00:00Z", backend: "openrouter", upstreamModel: "z-ai/glm-5.2:nitro", effort: "glm",    vision: "z-ai/glm-4.6v" },
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-05-01T00:00:00Z", backend: "zaisub",     upstreamModel: "glm-5.2",           effort: "glm",    vision: "glm-4.6v" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-05-15T00:00:00Z", backend: "openai",     upstreamModel: "gpt-5.5",           effort: "openai" },
];
// Claude Code makes background calls with non-catalog model ids (e.g. haiku);
// route those to a cheap default so the client keeps working.
const DEFAULT_ROUTE: ModelRoute = {
  id: "default", display_name: "default", created_at: "2026-06-01T00:00:00Z",
  backend: "openrouter", upstreamModel: "z-ai/glm-5.2", effort: "glm", vision: "z-ai/glm-4.6v",
};

function resolveModelRoute(model: any): ModelRoute {
  if (typeof model === "string") {
    const m = model.replace(/^us\./, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
    const found = MODEL_ROUTES.find((r) => m === r.id || m.startsWith(`${r.id}-`));
    if (found) return found;
  }
  return DEFAULT_ROUTE;
}

const API_START_PATHS = new Set(['v1', 'v2', 'api']);

type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
  router?: boolean;
};

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function extractModelSegment(path: string): { path: string; model: string | null } {
  const segments = path.replace(/^\/+/, '').split('/');
  if (segments.length > 0 && segments[0] && !API_START_PATHS.has(segments[0])) {
    return { path: '/' + segments.slice(1).join('/'), model: segments[0] };
  }
  return { path, model: null };
}

function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const routerPath = stripPrefix(path, "/router");
  if (routerPath) {
    // Backend is chosen per-model in the handler; upstream is a placeholder.
    return { path: routerPath, upstream: OPENROUTER_UPSTREAM, modelOverride: null, router: true };
  }

  const openrouterPath = stripPrefix(path, "/openrouter");
  if (openrouterPath) {
    const { path: remaining, model } = extractModelSegment(openrouterPath);
    return { path: remaining, upstream: OPENROUTER_UPSTREAM, modelOverride: model };
  }

  const goPath = stripPrefix(path, "/go");
  if (goPath) {
    const { path: remaining, model } = extractModelSegment(goPath);
    return { path: remaining, upstream: GO_UPSTREAM, modelOverride: model };
  }

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) {
    const { path: remaining, model } = extractModelSegment(zenPath);
    return { path: remaining, upstream: ZEN_UPSTREAM, modelOverride: model };
  }

  const zaisubPath = stripPrefix(path, "/zaisub");
  if (zaisubPath) {
    const { path: remaining, model } = extractModelSegment(zaisubPath);
    return { path: remaining, upstream: ZAISUB_UPSTREAM, modelOverride: model };
  }

  const { path: remaining, model } = extractModelSegment(path);
  return { path: remaining, upstream: DEFAULT_UPSTREAM, modelOverride: model };
}

function getUpstream(request: Request, routeUpstream: string): string {
  return request.headers.get("X-Upstream-Url") || routeUpstream;
}

function upstreamFormat(request: Request): "openai" | "anthropic" {
  const fmt = (request.headers.get("X-Upstream-Format") || "openai").toLowerCase();
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function anthropicHeaders(request: Request, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version": request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function isOpenRouterUpstream(upstream: string): boolean {
  return upstream.startsWith("https://openrouter.ai/");
}

function isZaisubUpstream(upstream: string): boolean {
  return upstream === ZAISUB_UPSTREAM;
}

/**
 * Resolve the Z.ai coding-plan credential for a /zaisub request, or return an
 * Anthropic-shaped 401 telling the user to (re-)run `cowork-zai-login`.
 */
function resolveZaiCredentialOrError(): { headers: Record<string, string> } | { error: Response } {
  const authError = (message: string): Response =>
    new Response(JSON.stringify({ error: { type: "authentication_error", message } }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  const cred = loadZaiCredential();
  if (!cred) return { error: authError("Z.ai credential not found. Run `cowork-zai-login` to sign in.") };
  if (zaiExpired(cred)) return { error: authError("Z.ai credential expired. Re-run `cowork-zai-login`.") };
  return {
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${zaiCredentialString(cred)}`,
      ...buildZaiIdentityHeaders(),
      ...buildZaiTraceHeaders(),
    },
  };
}

/** A 401 from Z.ai means the credential was rejected — surface the re-login hint. */
function zaisubUpstreamError(res: Response, body: string): Response {
  if (res.status === 401) {
    return new Response(JSON.stringify({ error: { type: "authentication_error",
      message: "Z.ai rejected the credential (401). Re-run `cowork-zai-login` to refresh." } }),
      { status: 401, headers: { "Content-Type": "application/json" } });
  }
  return upstreamErrorResponse(res, body);
}

/**
 * Map Anthropic model IDs onto OpenRouter slugs.
 *
 * Catalog aliases (what the proxy advertises on /v1/models) map to their
 * configured upstream. Other Anthropic IDs — Claude Code sends e.g.
 * "claude-haiku-4-5-20251001" for internal calls — also resolve to the single
 * catalog model, so this route never reaches a second upstream.
 */
function mapModelForOpenRouter(model: any): any {
  if (typeof model !== "string" || model.includes("/")) return model;
  const m = model.replace(/^us\./, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  const catalogEntry = MODEL_CATALOG.find((entry) => m === entry.id || m.startsWith(`${entry.id}-`));
  if (catalogEntry) return catalogEntry.upstream;
  return OPENROUTER_MODEL;
}

function isGlmModel(model: any): boolean {
  // Matches both the OpenRouter slug ("z-ai/glm-5.2") and the bare Z.ai
  // coding-plan id ("glm-5.2").
  return typeof model === "string" && (model.startsWith("z-ai/glm") || model.startsWith("glm-"));
}

function isGeminiModel(model: any): boolean {
  return typeof model === "string" && model.startsWith("google/gemini");
}

/**
 * Map Anthropic thinking/effort settings onto OpenRouter's normalized
 * `reasoning` parameter, restricted to the levels GLM 5.2 actually respects
 * (low | medium | high — there is no xhigh/max on OpenRouter, so Anthropic's
 * higher tiers clamp to "high").
 */
function mapEffortToReasoning(req: any, model?: any): any | null {
  // Gemini 3.x reasoning is mandatory — OpenRouter rejects {enabled:false} and
  // effort "none" with a 400, so "off" becomes the cheapest allowed level.
  if (req?.thinking?.type === "disabled") {
    return isGeminiModel(model) ? { effort: "low" } : { enabled: false };
  }
  const effort = req?.output_config?.effort;
  const EFFORT_MAP: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };
  if (typeof effort === "string" && EFFORT_MAP[effort]) {
    return { effort: EFFORT_MAP[effort] };
  }
  return null; // no explicit setting — leave the provider default
}

/**
 * Map Anthropic thinking/effort onto the OpenAI Responses `reasoning` object,
 * restricted to the levels GPT-5.x respects (minimal | low | medium | high).
 * `thinking: {type:"disabled"}` → minimal; Anthropic's xhigh/max clamp to high.
 */
function mapEffortToOpenAIReasoning(req: any): any | null {
  if (req?.thinking?.type === "disabled") return { effort: "minimal" };
  const effort = req?.output_config?.effort;
  const EFFORT_MAP: Record<string, string> = {
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "high",
  };
  if (typeof effort === "string" && EFFORT_MAP[effort]) {
    return { effort: EFFORT_MAP[effort], summary: "auto" };
  }
  return null;
}

function hasImages(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image")
  );
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of ["Content-Type", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" };
const JSON_HEADERS = { "Content-Type": "application/json" };

function authError401(message: string): Response {
  return new Response(JSON.stringify({ error: { type: "authentication_error", message } }), { status: 401, headers: JSON_HEADERS });
}

/**
 * Drive a GLM Chat-Completions backend (OpenRouter or Z.ai), interpreting
 * Claude Code's WebSearch/WebFetch server tools. When either is present the
 * request runs through the web-tool loop (native search + locally-executed
 * fetch, buffered and reshaped into Anthropic server-tool blocks); otherwise
 * it's a plain single call.
 */
async function glmChatCompletion(opts: {
  backend: "openrouter" | "zaisub";
  upstream: string;
  headers: Record<string, string>;
  openaiReq: any;
  anthropicReq: any;
  model: string;
}): Promise<Response> {
  const { backend, upstream, headers, openaiReq, anthropicReq, model } = opts;
  const searchTool = findWebSearchTool(anthropicReq.tools);
  const fetchTool = findWebFetchTool(anthropicReq.tools);
  const wantStream = !!anthropicReq.stream;

  const callUpstream = async (reqBody: any): Promise<Response> => {
    const res = await fetch(`${upstream}/chat/completions`, { method: "POST", headers, body: JSON.stringify(reqBody) });
    if (!res.ok) {
      throw { __response: backend === "zaisub" ? zaisubUpstreamError(res, await res.text()) : upstreamErrorResponse(res, await res.text()) };
    }
    return res;
  };

  if (searchTool || fetchTool) {
    const providerSearchTool = searchTool
      ? (backend === "zaisub" ? toZaiWebSearchTool(searchTool) : toOpenRouterWebSearchTool(searchTool))
      : null;
    const extractSearch = backend === "zaisub"
      ? extractResultsFromZai
      : (c: any) => extractResultsFromAnnotations(c?.choices?.[0]?.message?.annotations);
    try {
      // Streaming clients get the incremental loop: the first upstream call is
      // made here so auth/rate-limit failures still surface as a real HTTP
      // status instead of an SSE error event.
      if (wantStream) {
        const streamReq = { ...openaiReq, stream: true, stream_options: { include_usage: true },
          tools: [...(openaiReq.tools || []), ...(providerSearchTool ? [providerSearchTool] : []), ...(fetchTool ? [webFetchFunctionTool()] : [])] };
        const firstResponse = await callUpstream(streamReq);
        return new Response(streamWebToolLoop({
          openaiReq, model, query: lastUserText(anthropicReq),
          searchTool: providerSearchTool, wantFetch: !!fetchTool, extractSearch,
          firstResponse, callUpstream,
        }), { headers: SSE_HEADERS });
      }
      const message = await runWebToolLoop({
        openaiReq, model, query: lastUserText(anthropicReq),
        searchTool: providerSearchTool, wantFetch: !!fetchTool, extractSearch,
        callUpstream: async (reqBody: any) => (await callUpstream(reqBody)).json(),
      });
      return new Response(JSON.stringify(message), { headers: JSON_HEADERS });
    } catch (e: any) {
      if (e && e.__response) return e.__response as Response;
      throw e;
    }
  }

  let res: Response;
  try { res = await callUpstream(openaiReq); } catch (e: any) { if (e && e.__response) return e.__response as Response; throw e; }
  if (openaiReq.stream) return new Response(streamOpenAIToAnthropic(res.body as ReadableStream, model), { headers: SSE_HEADERS });
  const data: any = await res.json();
  return new Response(JSON.stringify(toAnthropicResponse(data, model)), { headers: JSON_HEADERS });
}

/**
 * /router dispatch: translate the Anthropic request once, then send it to the
 * backend chosen for this model. GLM backends (OpenRouter, Z.ai) use Chat
 * Completions; the OpenAI backend uses the Responses API (codex) and is
 * bridged back through the same Chat-Completions → Anthropic translators.
 */
async function handleRouterDispatch(req: any, originalModel: string, dispatch: ModelRoute, callerKey: string): Promise<Response> {
  const openaiReq = formatAnthropicToOpenAI(req);

  if (dispatch.backend === "openai") {
    const reasoning = mapEffortToOpenAIReasoning(req);
    if (reasoning) openaiReq.reasoning = reasoning;
    const responsesReq = chatCompletionsToResponses(openaiReq);

    // WebSearch → OpenAI's built-in Responses web search tool. (WebFetch on the
    // Responses backend needs a Responses-format tool loop — not yet wired.)
    const searchTool = findWebSearchTool(req.tools);
    if (searchTool) {
      responsesReq.tools = [...(responsesReq.tools || []), toOpenAiWebSearchTool(searchTool)];
    }

    let cred: Awaited<ReturnType<typeof getOpenAiCredential>> = null;
    try { cred = await getOpenAiCredential(); } catch { cred = null; }
    if (!cred) return authError401("OpenAI credential not found or refresh failed. Run `cowork-openai-login`.");

    let res = await fetch(CODEX_RESPONSES_URL, { method: "POST", headers: buildCodexHeaders(cred), body: JSON.stringify(responsesReq) });
    if (res.status === 401) {
      // Access token may have just expired — force a refresh and retry once.
      try {
        const refreshed = await getOpenAiCredential(true);
        if (refreshed) res = await fetch(CODEX_RESPONSES_URL, { method: "POST", headers: buildCodexHeaders(refreshed), body: JSON.stringify(responsesReq) });
      } catch { /* fall through */ }
    }
    if (!res.ok) {
      if (res.status === 401) return authError401("OpenAI rejected the credential (401). Re-run `cowork-openai-login`.");
      return upstreamErrorResponse(res, await res.text());
    }
    const responsesSSE = res.body as ReadableStream;

    // With search, buffer to collect url_citation annotations, reshape into
    // Anthropic web_search_tool_result blocks, and re-stream if needed.
    if (searchTool) {
      const cc = await collectResponsesToChatCompletion(responsesSSE, originalModel);
      const msg = cc.choices?.[0]?.message ?? {};
      const results = extractResultsFromAnnotations(msg.annotations);
      const message = buildServerToolMessage({
        model: originalModel,
        blocks: webSearchBlocks(results, lastUserText(req)),
        text: typeof msg.content === "string" ? msg.content : undefined,
        reasoning: typeof msg.reasoning_content === "string" ? msg.reasoning_content : undefined,
        usage: cc.usage,
        searchRequests: 1,
      });
      return req.stream
        ? new Response(anthropicMessageToSSE(message), { headers: SSE_HEADERS })
        : new Response(JSON.stringify(message), { headers: JSON_HEADERS });
    }

    if (req.stream) {
      const chatSSE = streamResponsesToOpenAIChat(responsesSSE, originalModel);
      return new Response(streamOpenAIToAnthropic(chatSSE, originalModel), { headers: SSE_HEADERS });
    }
    const cc = await collectResponsesToChatCompletion(responsesSSE, originalModel);
    return new Response(JSON.stringify(toAnthropicResponse(cc, originalModel)), { headers: JSON_HEADERS });
  }

  // GLM backends — OpenAI Chat Completions (+ web-tool interpreter).
  if (isGlmModel(req.model)) {
    const reasoning = mapEffortToReasoning(req);
    if (reasoning) openaiReq.reasoning = reasoning;
  }

  let upstream: string;
  let headers: Record<string, string>;
  if (dispatch.backend === "zaisub") {
    upstream = ZAISUB_UPSTREAM;
    const resolved = resolveZaiCredentialOrError();
    if ("error" in resolved) return resolved.error;
    headers = resolved.headers;
  } else {
    upstream = OPENROUTER_UPSTREAM;
    headers = { "Content-Type": "application/json", "Authorization": `Bearer ${callerKey}` };
  }

  return await glmChatCompletion({
    backend: dispatch.backend === "zaisub" ? "zaisub" : "openrouter",
    upstream, headers, openaiReq, anthropicReq: req, model: originalModel,
  });
}

async function handleRequest(request: Request): Promise<Response> {
  const route = routeConfig(request);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);

  // WebFetch domain-safety preflight. Claude Code checks
  // GET /api/web/domain_info?domain=<domain> before fetching a URL; behind a
  // custom base URL the check can't reach Anthropic and WebFetch fails with
  // "Unable to verify if domain X is safe to fetch". Answer it locally.
  if (route.path === '/api/web/domain_info' && request.method === 'GET') {
      const domain = new URL(request.url).searchParams.get("domain") || "";
      return new Response(JSON.stringify({ domain, can_fetch: true }), {
        headers: { "Content-Type": "application/json" },
      });
  }

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === '/v1/messages' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      // ── /router: dispatch by model to one of three backends ──────────────
      if (route.router) {
        const req: any = await request.json();
        const originalModel = req.model;
        const dispatch = resolveModelRoute(req.model);
        req.model = hasImages(req) && dispatch.vision ? dispatch.vision : dispatch.upstreamModel;
        return await handleRouterDispatch(req, originalModel, dispatch, key!);
      }

      if (fmt === "openai") {
        const req: any = await request.json();
        const originalModel = req.model;
        const openrouter = isOpenRouterUpstream(upstream);
        const zaisub = isZaisubUpstream(upstream);

        // /zaisub swaps the caller's sentinel for the resolved Z.ai credential
        // + ZCode fingerprint headers; every other route uses the caller's key.
        let outHeaders: Record<string, string> = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${key}`,
        };
        if (zaisub) {
          const resolved = resolveZaiCredentialOrError();
          if ("error" in resolved) return resolved.error;
          outHeaders = resolved.headers;
        }

        if (route.modelOverride) req.model = route.modelOverride;
        if (hasImages(req)) {
          if (openrouter) req.model = VISION_MODEL;
          else if (zaisub) req.model = ZAI_VISION_MODEL;
        }
        if (openrouter) req.model = mapModelForOpenRouter(req.model);

        const openaiReq = formatAnthropicToOpenAI(req);
        // Effort mapping applies on both the OpenRouter and /zaisub routes,
        // for every upstream that accepts OpenRouter's `reasoning` parameter.
        if ((openrouter || zaisub) && (isGlmModel(req.model) || isGeminiModel(req.model))) {
          const reasoning = mapEffortToReasoning(req, req.model);
          if (reasoning) openaiReq.reasoning = reasoning;
        }
        if (openrouter && isGeminiModel(req.model) && typeof openaiReq.max_tokens === "number"
            && openaiReq.max_tokens < GEMINI_MIN_OUTPUT_TOKENS) {
          openaiReq.max_tokens = GEMINI_MIN_OUTPUT_TOKENS;
        }

        // OpenRouter and Z.ai go through the web-tool-aware GLM path (native
        // WebSearch + locally-executed WebFetch); other OpenAI upstreams
        // (Zen/Go/custom) use the plain relay.
        if (openrouter || zaisub) {
          return await glmChatCompletion({
            backend: zaisub ? "zaisub" : "openrouter",
            upstream, headers: outHeaders, openaiReq, anthropicReq: req, model: originalModel,
          });
        }

        const res = await fetch(`${upstream}/chat/completions`, {
          method: "POST",
          headers: outHeaders,
          body: JSON.stringify(openaiReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (openaiReq.stream) {
          return new Response(streamOpenAIToAnthropic(res.body as ReadableStream, originalModel), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toAnthropicResponse(data, originalModel)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to Anthropic upstream
      const res = await fetch(`${upstream}/v1/messages`, {
        method: "POST",
        headers: anthropicHeaders(request, key!),
        body: await request.text(),
      });
      return res;
  }

  // OpenAI → Anthropic (or pass-through)
  if (route.path === '/v1/chat/completions' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      if (fmt === "anthropic") {
        const req = await request.json();
        const anthReq = formatOpenAIToAnthropic(req);
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: JSON.stringify(anthReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (anthReq.stream) {
          return new Response(streamAnthropicToOpenAI(res.body as ReadableStream, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
        }
        const data: any = await res.json();
        return new Response(JSON.stringify(toOpenAIResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }

      // Pass-through to OpenAI upstream (Z.ai uses the resolved credential).
      if (isZaisubUpstream(upstream)) {
        const resolved = resolveZaiCredentialOrError();
        if ("error" in resolved) return resolved.error;
        const res = await fetch(`${upstream}/chat/completions`, {
          method: "POST",
          headers: resolved.headers,
          body: await request.text(),
        });
        if (!res.ok) return zaisubUpstreamError(res, await res.text());
        return new Response(res.body, { status: res.status, headers: res.headers });
      }
      const res = await fetch(`${upstream}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: await request.text(),
      });
      return res;
  }

  // Model discovery
  if (route.path === '/v1/models' && request.method === 'GET') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) return authErrorResponse(err);

      // The /router route advertises the three cross-backend aliases.
      if (route.router) {
        const data = MODEL_ROUTES.map(({ id, display_name, created_at }) => ({
          type: "model", id, display_name, created_at,
        }));
        return new Response(JSON.stringify({
          data, has_more: false, first_id: data[0].id, last_id: data[data.length - 1].id,
        }), { headers: JSON_HEADERS });
      }

      // On the OpenRouter route, advertise the proxy's own catalog in
      // Anthropic list format (Claude Desktop's model picker reads this)
      // instead of leaking the upstream's thousands of OpenAI-format models.
      if (fmt === "openai" && isOpenRouterUpstream(upstream)) {
        const data = MODEL_CATALOG.map(({ id, display_name, created_at }) => ({
          type: "model",
          id,
          display_name,
          created_at,
        }));
        return new Response(JSON.stringify({
          data,
          has_more: false,
          first_id: data[0].id,
          last_id: data[data.length - 1].id,
        }), { headers: { "Content-Type": "application/json" } });
      }

      // On the /zaisub route, advertise the GLM coding-plan catalog (static —
      // no upstream call needed, and it needs the resolved credential anyway).
      if (fmt === "openai" && isZaisubUpstream(upstream)) {
        const data = ZAI_MODELS.map(({ id, display_name }) => ({
          type: "model",
          id,
          display_name,
          created_at: "2026-06-16T00:00:00Z",
        }));
        return new Response(JSON.stringify({
          data,
          has_more: false,
          first_id: data[0].id,
          last_id: data[data.length - 1].id,
        }), { headers: { "Content-Type": "application/json" } });
      }

      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${key}` },
      });
      if (!res.ok) return upstreamErrorResponse(res, await res.text());
      return new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({
    name: "opencode-cowork-proxy",
    upstream,
    routes: {
      "/router": "model-based dispatch (Fable→OpenRouter, Opus→Z.ai, Sonnet→OpenAI)",
      "/openrouter": OPENROUTER_UPSTREAM,
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
      "/zaisub": ZAISUB_UPSTREAM,
      "(default)": DEFAULT_UPSTREAM,
    },
    endpoints: {
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai)",
      "/v1/chat/completions": "OpenAI → upstream (translated if upstream=anthropic)",
      "/v1/models": "Model discovery (proxy catalog on the OpenRouter route, upstream proxy elsewhere)",
      "/api/web/domain_info": "WebFetch domain-safety preflight (always allows)",
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: route.path === '/' ? 200 : 404,
  });
}

const app = new Hono();
app.all('*', (c) => handleRequest(c.req.raw));

export default app;
