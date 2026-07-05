/**
 * Anthropic server-side WebSearch bridged onto each backend's native search.
 *
 * Claude Code implements WebSearch by sending a one-shot `/v1/messages` request
 * whose `tools` contain the Anthropic *server* tool `web_search_20250305` (no
 * `input_schema`), and expects `server_tool_use` + `web_search_tool_result`
 * content blocks back. A naive translation turns that into a broken function
 * tool and Claude Code reports "0 results".
 *
 * Each backend exposes a server-executed search we can substitute:
 *   - OpenRouter: `{type:"openrouter:web_search"}` → `url_citation` annotations
 *   - OpenAI Responses (codex): `{type:"web_search"}` → `url_citation` annotations
 *   - Z.ai / GLM: `{type:"web_search", web_search:{enable:true,...}}` → a
 *     top-level `web_search[]` array of results
 *
 * This module maps the Anthropic tool onto each, normalizes the results, and
 * reshapes them (composed with any local WebFetch results) into the block
 * shape Claude Code parses.
 */

export function findWebSearchTool(tools: any): any | null {
  if (!Array.isArray(tools)) return null;
  return tools.find((t: any) => typeof t?.type === "string" && t.type.startsWith("web_search")) || null;
}

// ── request-side: Anthropic web_search tool → provider tool ────────────────

/** OpenRouter server-executed web search tool. */
export function toOpenRouterWebSearchTool(tool: any): any {
  const parameters: any = { engine: "auto", max_results: 5 };
  if (typeof tool?.max_uses === "number") parameters.max_total_results = Math.min(tool.max_uses * 5, 25);
  if (Array.isArray(tool?.allowed_domains) && tool.allowed_domains.length > 0) parameters.allowed_domains = tool.allowed_domains;
  if (Array.isArray(tool?.blocked_domains) && tool.blocked_domains.length > 0) parameters.excluded_domains = tool.blocked_domains;
  return { type: "openrouter:web_search", parameters };
}

/** OpenAI Responses built-in web search tool. */
export function toOpenAiWebSearchTool(tool: any): any {
  const entry: any = { type: "web_search" };
  const filters: any = {};
  if (Array.isArray(tool?.allowed_domains) && tool.allowed_domains.length > 0) filters.allowed_domains = tool.allowed_domains;
  if (Object.keys(filters).length > 0) entry.filters = filters;
  return entry;
}

/** Z.ai / GLM native web search tool (chat completions). */
export function toZaiWebSearchTool(tool: any): any {
  const web_search: any = { enable: true, search_engine: "search-prime", search_result: true };
  if (typeof tool?.max_uses === "number") web_search.count = Math.min(Math.max(tool.max_uses * 5, 5), 20);
  if (Array.isArray(tool?.allowed_domains) && tool.allowed_domains.length > 0) web_search.search_domain_filter = tool.allowed_domains.join(",");
  return { type: "web_search", web_search };
}

// ── response-side: provider results → normalized search results ────────────

export interface NormalizedSearchResult {
  url: string;
  title: string;
  page_age?: string | null;
}

/** From `url_citation` annotations (OpenRouter, OpenAI Responses). */
export function extractResultsFromAnnotations(annotations: any): NormalizedSearchResult[] {
  const list = Array.isArray(annotations) ? annotations : [];
  const seen = new Set<string>();
  const out: NormalizedSearchResult[] = [];
  for (const a of list) {
    if (a?.type !== "url_citation") continue;
    const c = a.url_citation || a; // OpenRouter nests; OpenAI flattens
    const url = c?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: c.title || url });
  }
  return out;
}

/** From GLM's top-level `web_search[]` array. */
export function extractResultsFromZai(completion: any): NormalizedSearchResult[] {
  const list = Array.isArray(completion?.web_search) ? completion.web_search : [];
  const seen = new Set<string>();
  const out: NormalizedSearchResult[] = [];
  for (const r of list) {
    const url = r?.link ?? r?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: r.title || r.name || url, page_age: r.publish_date ?? r.published_date ?? null });
  }
  return out;
}

// ── block assembly ─────────────────────────────────────────────────────────

let serverToolCounter = 0;
function serverToolId(): string {
  // Deterministic-ish, unique within a process; avoids Date.now()/random which
  // some runtimes (and our test harness) disallow.
  return "srvtoolu_" + (serverToolCounter++).toString(36).padStart(6, "0") + performanceNonce();
}
function performanceNonce(): string {
  try { return Math.floor((performance?.now?.() ?? 0)).toString(36); } catch { return "0"; }
}

/** [server_tool_use(web_search), web_search_tool_result] for a set of results. */
export function webSearchBlocks(results: NormalizedSearchResult[], query: string): any[] {
  const id = serverToolId();
  return [
    { type: "server_tool_use", id, name: "web_search", input: { query: query.slice(0, 400) } },
    {
      type: "web_search_tool_result",
      tool_use_id: id,
      content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, encrypted_content: "", page_age: r.page_age ?? null })),
    },
  ];
}

/** server_tool_use(web_fetch) paired with a pre-built web_fetch_tool_result block. */
export function webFetchServerToolUse(toolUseId: string, url: string): any {
  return { type: "server_tool_use", id: toolUseId, name: "web_fetch", input: { url } };
}

export function newServerToolId(): string {
  return serverToolId();
}

export function lastUserText(anthropicReq: any): string {
  const messages = Array.isArray(anthropicReq?.messages) ? anthropicReq.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content.filter((p: any) => p?.type === "text" && typeof p.text === "string").map((p: any) => p.text).join("\n");
      if (text) return text;
    }
  }
  return "";
}

/**
 * Assemble the final Anthropic message: leading server-tool blocks (search
 * and/or fetch), then optional thinking, then the model's synthesized text.
 */
export function buildServerToolMessage(opts: {
  model: string;
  blocks: any[];
  text?: string;
  reasoning?: string;
  usage?: any;
  searchRequests?: number;
}): any {
  const content: any[] = [...opts.blocks];
  if (opts.reasoning && opts.reasoning.trim()) content.push({ type: "thinking", thinking: opts.reasoning, signature: "" });
  if (opts.text) content.push({ type: "text", text: opts.text });

  const result: any = {
    id: "msg_" + newServerToolId(),
    type: "message",
    role: "assistant",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    model: opts.model,
  };
  if (opts.usage) {
    result.usage = {
      input_tokens: opts.usage.prompt_tokens ?? opts.usage.input_tokens ?? 0,
      output_tokens: opts.usage.completion_tokens ?? opts.usage.output_tokens ?? 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      ...(opts.searchRequests ? { server_tool_use: { web_search_requests: opts.searchRequests } } : {}),
    };
  }
  return result;
}

/**
 * Backward-compatible wrapper for the OpenRouter path: reshape a chat
 * completion whose message carries `url_citation` annotations.
 */
export function buildWebSearchMessage(completion: any, model: string, anthropicReq: any): any {
  const message = completion?.choices?.[0]?.message;
  const results = extractResultsFromAnnotations(message?.annotations);
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  return buildServerToolMessage({
    model,
    blocks: webSearchBlocks(results, lastUserText(anthropicReq)),
    text: typeof message?.content === "string" ? message.content : undefined,
    reasoning: typeof reasoning === "string" ? reasoning : undefined,
    usage: completion?.usage,
    searchRequests: completion?.usage?.server_tool_use?.web_search_requests ?? 1,
  });
}

/** Serialize a complete Anthropic message as an Anthropic SSE stream (for streaming clients). */
export function anthropicMessageToSSE(message: any): ReadableStream {
  const encoder = new TextEncoder();
  const usage = message.usage || { input_tokens: 0, output_tokens: 0 };

  return new ReadableStream({
    start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage } });

      (message.content || []).forEach((block: any, index: number) => {
        if (block.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        } else if (block.type === "thinking") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        } else if (block.type === "tool_use" || block.type === "server_tool_use") {
          send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
        } else {
          send("content_block_start", { type: "content_block_start", index, content_block: block });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });

      send("message_delta", { type: "message_delta", delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null }, usage });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}
