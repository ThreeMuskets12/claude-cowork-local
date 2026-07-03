/**
 * Anthropic server-side web search bridged onto OpenRouter's web search tool.
 *
 * Claude Code implements its WebSearch feature by sending a one-shot
 * `/v1/messages` request whose `tools` contain the Anthropic *server* tool
 * `web_search_20250305` (no `input_schema`), and it expects the response to
 * contain `server_tool_use` + `web_search_tool_result` content blocks. A naive
 * Anthropic→OpenAI translation turns that server tool into a broken function
 * tool, the model answers with a client-side `tool_call`, and Claude Code
 * reports "0 results".
 *
 * OpenRouter exposes an equivalent server-executed tool
 * (`type: "openrouter:web_search"`) whose results come back as
 * `url_citation` annotations on the completion message. This module maps
 * between the two shapes.
 */

export function findWebSearchTool(tools: any): any | null {
  if (!Array.isArray(tools)) return null;
  return tools.find((t: any) => typeof t?.type === "string" && t.type.startsWith("web_search")) || null;
}

/** Map Anthropic's web_search server tool onto OpenRouter's server-executed web search tool. */
export function toOpenRouterWebSearchTool(tool: any): any {
  const parameters: any = { engine: "auto", max_results: 5 };
  if (typeof tool?.max_uses === "number") parameters.max_total_results = Math.min(tool.max_uses * 5, 25);
  if (Array.isArray(tool?.allowed_domains) && tool.allowed_domains.length > 0) {
    parameters.allowed_domains = tool.allowed_domains;
  }
  if (Array.isArray(tool?.blocked_domains) && tool.blocked_domains.length > 0) {
    parameters.excluded_domains = tool.blocked_domains;
  }
  return { type: "openrouter:web_search", parameters };
}

function lastUserText(anthropicReq: any): string {
  const messages = Array.isArray(anthropicReq?.messages) ? anthropicReq.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("\n");
      if (text) return text;
    }
  }
  return "";
}

/**
 * Build an Anthropic message whose content carries the search results in the
 * server-tool shape Claude Code parses (`server_tool_use` +
 * `web_search_tool_result`), followed by the model's synthesized answer.
 */
export function buildWebSearchMessage(completion: any, model: string, anthropicReq: any): any {
  const message = completion?.choices?.[0]?.message;
  const annotations = Array.isArray(message?.annotations) ? message.annotations : [];

  const seen = new Set<string>();
  const results: any[] = [];
  for (const annotation of annotations) {
    if (annotation?.type !== "url_citation") continue;
    // OpenRouter nests the payload under `url_citation`; some providers flatten it.
    const citation = annotation.url_citation || annotation;
    const url = citation?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    results.push({
      type: "web_search_result",
      url,
      title: citation.title || url,
      encrypted_content: "",
      page_age: null,
    });
  }

  const toolUseId = "srvtoolu_" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  const content: any[] = [
    {
      type: "server_tool_use",
      id: toolUseId,
      name: "web_search",
      input: { query: lastUserText(anthropicReq).slice(0, 400) },
    },
    { type: "web_search_tool_result", tool_use_id: toolUseId, content: results },
  ];

  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }
  if (typeof message?.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }

  const result: any = {
    id: "msg_" + Date.now(),
    type: "message",
    role: "assistant",
    content,
    stop_reason: "end_turn",
    stop_sequence: null,
    model,
  };

  const usage = completion?.usage;
  if (usage) {
    result.usage = {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: usage.server_tool_use?.web_search_requests ?? 1 },
    };
  }

  return result;
}

/**
 * Serialize a complete Anthropic message as an Anthropic SSE stream.
 * Used when the client asked for streaming but the upstream call had to be
 * buffered (web search annotations only arrive on the complete message).
 */
export function anthropicMessageToSSE(message: any): ReadableStream {
  const encoder = new TextEncoder();
  const usage = message.usage || { input_tokens: 0, output_tokens: 0 };

  return new ReadableStream({
    start(controller) {
      const send = (event: string, data: any) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      send("message_start", {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage },
      });

      (message.content || []).forEach((block: any, index: number) => {
        if (block.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        } else if (block.type === "thinking") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
        } else if (block.type === "tool_use" || block.type === "server_tool_use") {
          send("content_block_start", { type: "content_block_start", index, content_block: { ...block, input: {} } });
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input || {}) },
          });
        } else {
          // Complete blocks (web_search_tool_result, ...) are sent whole in content_block_start.
          send("content_block_start", { type: "content_block_start", index, content_block: block });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });

      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason || "end_turn", stop_sequence: null },
        usage,
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  });
}
