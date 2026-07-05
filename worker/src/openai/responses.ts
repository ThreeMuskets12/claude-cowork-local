/**
 * OpenAI Responses API adapter for the ChatGPT-subscription (Codex) backend.
 *
 * The codex backend (`chatgpt.com/backend-api/codex/responses`) speaks the
 * **Responses API**, not Chat Completions — and it is SSE-only, stateless
 * (`store: false`), and needs `include: ["reasoning.encrypted_content"]`
 * (verified against numman-ali/opencode-openai-codex-auth).
 *
 * This module sits between the existing translator and the codex backend:
 *
 *   Anthropic → [existing translator] → Chat Completions
 *             → chatCompletionsToResponses → Responses request
 *             → codex backend (SSE) → streamResponsesToOpenAIChat
 *             → Chat Completions SSE → [existing translators] → Anthropic
 *
 * so the only new code is the Chat-Completions ↔ Responses conversion; the
 * Anthropic side is unchanged.
 */
import type { OpenAiCredential } from "./credential";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/** Headers the codex backend expects (mirrors the Codex CLI). */
export function buildCodexHeaders(cred: OpenAiCredential): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${cred.accessToken}`,
    "chatgpt-account-id": cred.accountId,
    "OpenAI-Beta": "responses=experimental",
    "originator": "codex_cli_rs",
    "accept": "text/event-stream",
  };
}

function textOfContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  }
  return "";
}

/** Convert an OpenAI Chat Completions body into a Responses API request. */
export function chatCompletionsToResponses(cc: any): any {
  const input: any[] = [];
  let instructions: string | undefined;

  for (const msg of cc.messages ?? []) {
    if (msg.role === "system") {
      const text = textOfContent(msg.content);
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const text = typeof msg.content === "string" ? msg.content : textOfContent(msg.content);
      if (text) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const tc of msg.tool_calls ?? []) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? "{}",
        });
      }
      continue;
    }
    // user
    if (typeof msg.content === "string") {
      input.push({ type: "message", role: "user", content: [{ type: "input_text", text: msg.content }] });
    } else if (Array.isArray(msg.content)) {
      const parts: any[] = [];
      for (const p of msg.content) {
        if (p.type === "text") parts.push({ type: "input_text", text: p.text });
        else if (p.type === "image_url") parts.push({ type: "input_image", image_url: p.image_url?.url });
      }
      input.push({ type: "message", role: "user", content: parts });
    }
  }

  const body: any = {
    model: cc.model,
    input,
    store: false, // codex backend requires stateless
    stream: true, // codex backend is SSE-only; we accumulate for non-streaming clients
    include: ["reasoning.encrypted_content"],
  };
  if (instructions) body.instructions = instructions;
  if (cc.tools) {
    body.tools = cc.tools.map((t: any) => ({
      type: "function",
      name: t.function?.name,
      description: t.function?.description,
      parameters: t.function?.parameters,
    }));
  }
  if (cc.tool_choice) body.tool_choice = cc.tool_choice;
  if (cc.parallel_tool_calls !== undefined) body.parallel_tool_calls = cc.parallel_tool_calls;
  // `reasoning` is attached by the router's effort mapping (Responses shape).
  if (cc.reasoning) body.reasoning = cc.reasoning;
  return body;
}

// ---- Responses SSE → OpenAI Chat Completions -----------------------------

interface ChatToolCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

/**
 * Parse the Responses SSE stream and drive a callback per logical delta,
 * shared by the streaming and non-streaming paths.
 */
async function readResponsesEvents(
  stream: ReadableStream,
  on: {
    text?: (delta: string) => void;
    reasoning?: (delta: string) => void;
    toolStart?: (tc: ChatToolCall) => void;
    toolArgs?: (index: number, delta: string) => void;
    annotation?: (a: any) => void;
    done?: (finishReason: string, usage: any) => void;
  },
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const toolIndexByItem = new Map<string, number>();
  let nextToolIndex = 0;
  let sawToolCall = false;
  let finished = false;

  const handle = (evt: any) => {
    const type = evt?.type as string | undefined;
    if (!type) return;
    if (type === "response.output_text.delta" && typeof evt.delta === "string") {
      on.text?.(evt.delta);
    } else if ((type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") && typeof evt.delta === "string") {
      on.reasoning?.(evt.delta);
    } else if (type === "response.output_item.added" && evt.item?.type === "function_call") {
      const item = evt.item;
      const key = item.id ?? item.call_id ?? String(nextToolIndex);
      const index = nextToolIndex++;
      toolIndexByItem.set(key, index);
      sawToolCall = true;
      on.toolStart?.({ index, id: item.call_id ?? item.id, name: item.name ?? "", args: item.arguments ?? "" });
    } else if (type === "response.function_call_arguments.delta" && typeof evt.delta === "string") {
      const key = evt.item_id ?? evt.item?.id;
      const index = key != null && toolIndexByItem.has(key) ? toolIndexByItem.get(key)! : Math.max(0, nextToolIndex - 1);
      on.toolArgs?.(index, evt.delta);
    } else if (type === "response.output_text.annotation.added" && evt.annotation) {
      on.annotation?.(evt.annotation);
    } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
      // Fallback: some servers only attach annotations to the final output items.
      if (on.annotation) {
        for (const item of evt.response?.output ?? []) {
          for (const part of item?.content ?? []) {
            for (const a of part?.annotations ?? []) on.annotation(a);
          }
        }
      }
      if (finished) return;
      finished = true;
      const usage = evt.response?.usage
        ? {
            prompt_tokens: evt.response.usage.input_tokens ?? 0,
            completion_tokens: evt.response.usage.output_tokens ?? 0,
          }
        : undefined;
      on.done?.(sawToolCall ? "tool_calls" : type === "response.completed" ? "stop" : "length", usage);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { handle(JSON.parse(data)); } catch { /* skip partial */ }
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const data = buffer.trim().slice(5).trim();
      if (data && data !== "[DONE]") { try { handle(JSON.parse(data)); } catch { /* ignore */ } }
    }
  } finally {
    reader.releaseLock();
  }
  if (!finished) on.done?.(sawToolCall ? "tool_calls" : "stop", undefined);
}

/** Responses SSE → OpenAI chat.completion.chunk SSE (consumed by the existing Anthropic stream translator). */
export function streamResponsesToOpenAIChat(stream: ReadableStream, model: string): ReadableStream {
  const encoder = new TextEncoder();
  const id = "chatcmpl_" + Date.now().toString(36);
  const emit = (controller: ReadableStreamDefaultController, delta: any, extra: any = {}) => {
    const chunk = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }], ...extra };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };
  return new ReadableStream({
    async start(controller) {
      await readResponsesEvents(stream, {
        text: (d) => emit(controller, { content: d }),
        reasoning: (d) => emit(controller, { reasoning: d }),
        toolStart: (tc) => emit(controller, { tool_calls: [{ index: tc.index, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.args } }] }),
        toolArgs: (index, d) => emit(controller, { tool_calls: [{ index, function: { arguments: d } }] }),
        done: (finishReason, usage) => {
          const final: any = { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
          if (usage) final.usage = usage;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(final)}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
    },
  });
}

/** Responses SSE → a complete OpenAI Chat Completions object (for non-streaming clients). */
export async function collectResponsesToChatCompletion(stream: ReadableStream, model: string): Promise<any> {
  let content = "";
  let reasoning = "";
  const tools: ChatToolCall[] = [];
  const annotations: any[] = [];
  let finishReason = "stop";
  let usage: any = undefined;

  await readResponsesEvents(stream, {
    text: (d) => (content += d),
    reasoning: (d) => (reasoning += d),
    toolStart: (tc) => (tools[tc.index] = { ...tc }),
    toolArgs: (index, d) => { if (tools[index]) tools[index].args += d; },
    annotation: (a) => annotations.push(a),
    done: (fr, u) => { finishReason = fr; usage = u; },
  });

  const message: any = { role: "assistant", content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (annotations.length) message.annotations = annotations;
  if (tools.length) {
    message.tool_calls = tools.filter(Boolean).map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.args || "{}" },
    }));
  }
  const result: any = { id: "chatcmpl_" + newId(), object: "chat.completion", model, choices: [{ index: 0, message, finish_reason: finishReason }] };
  if (usage) result.usage = usage;
  return result;
}

let idCounter = 0;
function newId(): string {
  return (idCounter++).toString(36).padStart(6, "0");
}
