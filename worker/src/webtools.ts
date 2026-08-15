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

export interface StreamWebToolLoopParams extends Omit<WebToolLoopParams, "callUpstream"> {
  firstResponse: Response; // already-open streamed upstream response (first turn)
  callUpstream: (req: any) => Promise<Response>; // streamed upstream response
}

/**
 * Streaming variant of the loop: forwards text and thinking deltas to the
 * client as they arrive, and only appends server-tool blocks when the model
 * actually calls one. Turns that never touch a web tool — the common case,
 * since Claude Code sends the tool definitions on every request — stream end
 * to end instead of being buffered.
 */
export function streamWebToolLoop(params: StreamWebToolLoopParams): ReadableStream {
  const encoder = new TextEncoder();
  const urlFetch = params.urlFetch ?? ((u: string) => fetchUrlToText(u));
  const maxIterations = params.maxIterations ?? 5;
  const maxFetchChars = params.maxFetchChars ?? 20_000;

  const req: any = { ...params.openaiReq, stream: true, stream_options: { include_usage: true } };
  req.tools = [...(params.openaiReq.tools || [])];
  if (params.searchTool) req.tools.push(params.searchTool);
  if (params.wantFetch) req.tools.push(webFetchFunctionTool());

  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      let index = 0;
      /** Emit a fully-formed block (start → delta → stop) at the next index. */
      const sendBlock = (block: any) => {
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) } });
        } else {
          send("content_block_start", { type: "content_block_start", index, content_block: block });
        }
        send("content_block_stop", { type: "content_block_stop", index });
        index++;
      };

      let usage: any;
      let stopReason = "end_turn";
      let searchRequests = 0;
      const seenSearchUrls = new Set<string>();

      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_" + newServerToolId(), type: "message", role: "assistant", model: params.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      /** Consume one upstream SSE turn, streaming its text/thinking through. */
      const pumpTurn = async (res: Response) => {
        const reader = (res.body as ReadableStream).getReader();
        const decoder = new TextDecoder();
        const toolCalls: any[] = [];
        const annotations: any[] = [];
        let content = "";
        let buffer = "";
        let openBlock: "text" | "thinking" | null = null;

        const closeOpen = () => {
          if (openBlock) { send("content_block_stop", { type: "content_block_stop", index }); index++; openBlock = null; }
        };
        const openAs = (kind: "text" | "thinking") => {
          if (openBlock === kind) return;
          closeOpen();
          send("content_block_start", {
            type: "content_block_start", index,
            content_block: kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "", signature: "" },
          });
          openBlock = kind;
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let chunk: any;
            try { chunk = JSON.parse(payload); } catch { continue; }
            if (chunk.usage) usage = chunk.usage;
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;
            const reasoning = delta.reasoning_content ?? delta.reasoning;
            if (typeof reasoning === "string" && reasoning) {
              openAs("thinking");
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reasoning } });
            }
            if (typeof delta.content === "string" && delta.content) {
              openAs("text");
              content += delta.content;
              send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } });
            }
            if (Array.isArray(delta.annotations)) annotations.push(...delta.annotations);
            for (const tc of delta.tool_calls || []) {
              const slot = toolCalls[tc.index] ?? (toolCalls[tc.index] = { id: "", function: { name: "", arguments: "" } });
              if (tc.id) slot.id = tc.id;
              if (tc.function?.name) slot.function.name = tc.function.name;
              if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
            }
          }
        }
        closeOpen();
        return { toolCalls: toolCalls.filter(Boolean), annotations, content };
      };

      try {
        let res = params.firstResponse;
        for (let i = 0; i < maxIterations; i++) {
          const turn = await pumpTurn(res);

          if (params.searchTool) {
            const fresh = params.extractSearch({ choices: [{ message: { annotations: turn.annotations } }] })
              .filter((r) => !seenSearchUrls.has(r.url));
            if (fresh.length) {
              fresh.forEach((r) => seenSearchUrls.add(r.url));
              webSearchBlocks(fresh, params.query).forEach(sendBlock);
              searchRequests++;
            }
          }

          const fetchCalls = turn.toolCalls.filter((tc) => tc.function?.name === "web_fetch");
          const otherCalls = turn.toolCalls.filter((tc) => tc.function?.name !== "web_fetch");

          // A client-side tool (Bash, etc.) — hand it back and stop.
          if (otherCalls.length > 0) {
            for (const tc of otherCalls) {
              sendBlock({ type: "tool_use", id: tc.id, name: tc.function?.name, input: parseArgs(tc.function?.arguments) });
            }
            stopReason = "tool_use";
            break;
          }

          if (!params.wantFetch || fetchCalls.length === 0) break;

          req.messages = [...req.messages, { role: "assistant", content: turn.content || null, tool_calls: turn.toolCalls }];
          for (const tc of fetchCalls) {
            const url = parseArgs(tc.function?.arguments).url ?? "";
            const fr = await urlFetch(String(url));
            const id = newServerToolId();
            sendBlock(webFetchServerToolUse(id, String(url)));
            sendBlock(webFetchResultBlock(id, fr));
            req.messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: fr.error ? `Error fetching ${url}: ${fr.error}` : fr.text.slice(0, maxFetchChars),
            });
          }
          res = await params.callUpstream(req);
        }
      } catch (e: any) {
        send("error", { type: "error", error: { type: "api_error", message: String(e?.message ?? e) } });
      }

      const reported = usage?.server_tool_use?.web_search_requests;
      const finalSearchRequests = typeof reported === "number" ? reported : searchRequests;
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          input_tokens: usage?.prompt_tokens ?? 0,
          output_tokens: usage?.completion_tokens ?? 0,
          ...(finalSearchRequests ? { server_tool_use: { web_search_requests: finalSearchRequests } } : {}),
        },
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
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
