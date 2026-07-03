import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';
import { findWebSearchTool, toOpenRouterWebSearchTool, buildWebSearchMessage, anthropicMessageToSSE } from './websearch';

const OPENROUTER_UPSTREAM = "https://openrouter.ai/api/v1";
const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = OPENROUTER_UPSTREAM;
// Requests containing images are escalated to a vision-capable model
// (GLM 5.2 is text-only).
const VISION_MODEL = "anthropic/claude-sonnet-5";

// The catalog of models the proxy advertises to Anthropic clients (Claude
// Desktop's model picker reads GET /v1/models). Each Anthropic-style alias is
// served by a specific OpenRouter model; ":nitro" routes to the
// highest-throughput provider.
const MODEL_CATALOG: Array<{ id: string; display_name: string; created_at: string; upstream: string }> = [
  { id: "claude-opus-4-8", display_name: "Claude Opus 4.8", created_at: "2026-05-01T00:00:00Z", upstream: "z-ai/glm-5.2" },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-05-15T00:00:00Z", upstream: "anthropic/claude-sonnet-5" },
  { id: "claude-fable-5", display_name: "Claude Fable 5", created_at: "2026-06-01T00:00:00Z", upstream: "z-ai/glm-5.2:nitro" },
];

const API_START_PATHS = new Set(['v1', 'v2', 'api']);

type RouteConfig = {
  path: string;
  upstream: string;
  modelOverride: string | null;
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

/**
 * Map Anthropic model IDs onto OpenRouter slugs.
 *
 * Catalog aliases (what the proxy advertises on /v1/models) map to their
 * configured upstream. Other Anthropic IDs — Claude Code sends e.g.
 * "claude-haiku-4-5-20251001" for internal calls — fall back to the
 * generic "anthropic/<model>" slug so they still resolve upstream.
 */
function mapModelForOpenRouter(model: any): any {
  if (typeof model !== "string" || model.includes("/")) return model;
  let m = model.replace(/^us\./, "").replace(/-\d{8}$/, "").replace(/-latest$/, "");
  const catalogEntry = MODEL_CATALOG.find((entry) => m === entry.id || m.startsWith(`${entry.id}-`));
  if (catalogEntry) return catalogEntry.upstream;
  if (!m.startsWith("claude-")) return model;
  m = m.replace(/(\d)-(\d)/g, "$1.$2");
  return `anthropic/${m}`;
}

function isGlmModel(model: any): boolean {
  return typeof model === "string" && model.startsWith("z-ai/glm");
}

/**
 * Map Anthropic thinking/effort settings onto OpenRouter's normalized
 * `reasoning` parameter, restricted to the levels GLM 5.2 actually respects
 * (low | medium | high — there is no xhigh/max on OpenRouter, so Anthropic's
 * higher tiers clamp to "high").
 */
function mapEffortToReasoning(req: any): any | null {
  if (req?.thinking?.type === "disabled") return { enabled: false };
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

      if (fmt === "openai") {
        const req: any = await request.json();
        const originalModel = req.model;
        const openrouter = isOpenRouterUpstream(upstream);
        if (route.modelOverride) req.model = route.modelOverride;
        if (hasImages(req) && openrouter) {
          req.model = VISION_MODEL;
        }
        if (openrouter) req.model = mapModelForOpenRouter(req.model);

        const webSearchTool = openrouter ? findWebSearchTool(req.tools) : null;
        const openaiReq = formatAnthropicToOpenAI(req);
        if (openrouter) {
          if (isGlmModel(req.model)) {
            const reasoning = mapEffortToReasoning(req);
            if (reasoning) openaiReq.reasoning = reasoning;
          }
          if (webSearchTool) {
            openaiReq.tools = [...(openaiReq.tools || []), toOpenRouterWebSearchTool(webSearchTool)];
            // Search citations only arrive on the complete message, so buffer
            // the upstream call and re-stream the result to the client below.
            delete openaiReq.stream;
            delete openaiReq.stream_options;
          }
        }
        const res = await fetch(`${upstream}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`,
          },
          body: JSON.stringify(openaiReq),
        });
        if (!res.ok) return upstreamErrorResponse(res, await res.text());

        if (webSearchTool) {
          const data: any = await res.json();
          const message = buildWebSearchMessage(data, originalModel, req);
          if (req.stream) {
            return new Response(anthropicMessageToSSE(message), {
              headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
            });
          }
          return new Response(JSON.stringify(message), {
            headers: { "Content-Type": "application/json" },
          });
        }

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

      // Pass-through to OpenAI upstream
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

      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key),
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
      "/openrouter": OPENROUTER_UPSTREAM,
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
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
