/**
 * In-request web-tool interpreter for Chat-Completions backends (OpenRouter,
 * Z.ai). Makes Claude Code's Anthropic *server* tools work by:
 *
 *   - WebSearch → substituting the backend's native server-executed search
 *     (results arrive inline on the completion; one upstream call).
 *   - WebFetch → exposing a local `web_fetch` function tool the proxy executes
 *     itself (HTTP GET → text), looping upstream with the fetched content until
 *     the model stops requesting fetches.
 *
 * The accumulated searches and fetches are reshaped into the
 * `server_tool_use` + `*_tool_result` blocks Claude Code expects, so from the
 * client's perspective native WebSearch/WebFetch "just work". The upstream call
 * is buffered (non-streaming) since results are assembled across the loop.
 */
import {
  webSearchBlocks,
  webFetchServerToolUse,
  newServerToolId,
  buildServerToolMessage,
  type NormalizedSearchResult,
} from "./websearch";
import { webFetchFunctionTool, webFetchResultBlock, fetchUrlToText, type WebFetchResult } from "./webfetch";

export interface WebToolLoopParams {
  openaiReq: any;
  model: string; // original Anthropic model id (echoed on the message)
  query: string; // last user text (search block input)
  searchTool?: any | null; // provider search tool to inject, if WebSearch requested
  wantFetch: boolean; // WebFetch server tool present
  extractSearch: (completion: any) => NormalizedSearchResult[];
  callUpstream: (req: any) => Promise<any>; // returns a Chat Completions JSON
  urlFetch?: (url: string) => Promise<WebFetchResult>; // injectable for tests
  maxIterations?: number;
  maxFetchChars?: number; // cap of fetched text fed back to the model
}

/** Run the loop and return a complete Anthropic message. */
export async function runWebToolLoop(params: WebToolLoopParams): Promise<any> {
  const urlFetch = params.urlFetch ?? ((u: string) => fetchUrlToText(u));
  const maxIterations = params.maxIterations ?? 5;
  const maxFetchChars = params.maxFetchChars ?? 20_000;

  const req: any = { ...params.openaiReq };
  req.tools = [...(params.openaiReq.tools || [])];
  if (params.searchTool) req.tools.push(params.searchTool);
  if (params.wantFetch) req.tools.push(webFetchFunctionTool());
  delete req.stream;
  delete req.stream_options;

  const blocks: any[] = [];
  const seenSearchUrls = new Set<string>();
  let searchRequests = 0;
  let reasoning = "";
  let text = "";
  let stopReason = "end_turn";
  let lastUsage: any;

  for (let i = 0; i < maxIterations; i++) {
    const completion = await params.callUpstream(req);
    lastUsage = completion?.usage;
    const message = completion?.choices?.[0]?.message ?? {};

    // Native search results (dedup across the whole loop).
    if (params.searchTool) {
      const fresh = params.extractSearch(completion).filter((r) => !seenSearchUrls.has(r.url));
      if (fresh.length) {
        fresh.forEach((r) => seenSearchUrls.add(r.url));
        blocks.push(...webSearchBlocks(fresh, params.query));
        searchRequests++;
      }
    }

    const r = message.reasoning_content ?? message.reasoning;
    if (typeof r === "string" && r) reasoning += r;

    const toolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const fetchCalls = toolCalls.filter((tc) => tc.function?.name === "web_fetch");
    const otherCalls = toolCalls.filter((tc) => tc.function?.name !== "web_fetch");

    // A client-side tool (Bash, etc.) was requested — hand it back to Claude
    // Code as tool_use blocks and stop; the loop only owns web_fetch.
    if (otherCalls.length > 0) {
      for (const tc of otherCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
      }
      if (typeof message.content === "string") text = message.content;
      stopReason = "tool_use";
      break;
    }

    if (!params.wantFetch || fetchCalls.length === 0) {
      if (typeof message.content === "string") text = message.content;
      break;
    }

    // Execute each fetch locally, append to the conversation, and loop.
    req.messages = [...req.messages, { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls }];
    for (const tc of fetchCalls) {
      const url = parseArgs(tc.function?.arguments).url ?? "";
      const fr = await urlFetch(String(url));
      const id = newServerToolId();
      blocks.push(webFetchServerToolUse(id, String(url)), webFetchResultBlock(id, fr));
      req.messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: fr.error ? `Error fetching ${url}: ${fr.error}` : fr.text.slice(0, maxFetchChars),
      });
    }
  }

  // Prefer the provider-reported search count (more accurate than our
  // per-round tally) when it's available.
  const reported = lastUsage?.server_tool_use?.web_search_requests;
  const finalSearchRequests = typeof reported === "number" ? reported : searchRequests;
  const message = buildServerToolMessage({ model: params.model, blocks, text, reasoning, usage: lastUsage, searchRequests: finalSearchRequests });
  if (stopReason !== "end_turn") message.stop_reason = stopReason;
  return message;
}

function parseArgs(args: any): any {
  if (typeof args !== "string") return args && typeof args === "object" ? args : {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
