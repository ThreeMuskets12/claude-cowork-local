/**
 * Local WebFetch execution.
 *
 * Claude Code's WebFetch is an Anthropic *server* tool: the model emits a
 * `server_tool_use(web_fetch, {url})` and expects a `web_fetch_tool_result`
 * back inline. No non-Anthropic backend has an equivalent server tool, so the
 * proxy executes the fetch itself — a plain HTTP GET, HTML→text extraction —
 * and reshapes the result into the block shape Claude Code parses. This is
 * backend-independent (works for Z.ai, OpenAI, anything) and consumes no
 * provider search quota.
 *
 * SECURITY: fetching model-supplied URLs is an SSRF surface. We block
 * non-http(s) schemes and literal private/loopback/link-local hosts. This is
 * best-effort — a public hostname that *resolves* to a private IP is not
 * caught here (the runtime doesn't expose the post-resolution IP cheaply);
 * deployments exposed to untrusted input should add a resolving egress filter.
 */

export function findWebFetchTool(tools: any): any | null {
  if (!Array.isArray(tools)) return null;
  return tools.find((t: any) => typeof t?.type === "string" && t.type.startsWith("web_fetch")) || null;
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./, // link-local incl. cloud metadata 169.254.169.254
  /^\[?::1\]?$/,
  /^\[?fc00:/i,
  /^\[?fd[0-9a-f]{2}:/i,
  /^\[?fe80:/i,
  /\.internal$/i,
  /\.local$/i,
];

export function isUrlFetchable(rawUrl: string): { ok: true } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme ${url.protocol}` };
  }
  const host = url.hostname;
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: "private/loopback host blocked" };
  }
  return { ok: true };
}

/** Strip HTML to readable-ish plain text (scripts/styles removed, tags dropped, entities decoded). */
export function htmlToText(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : null;

  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").replace(/^\s+|\s+$/g, "");
  return { title, text: s };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const cp = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return named[code.toLowerCase()] ?? m;
  });
}

export interface WebFetchResult {
  url: string;
  title: string | null;
  text: string;
  retrievedAt: string;
  error?: string;
}

/** Fetch a URL and return extracted text (or an error record). Never throws. */
export async function fetchUrlToText(
  rawUrl: string,
  opts: { maxBytes?: number; maxChars?: number; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => string } = {},
): Promise<WebFetchResult> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const maxChars = opts.maxChars ?? 100_000;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retrievedAt = opts.now ? opts.now() : new Date().toISOString();

  const gate = isUrlFetchable(rawUrl);
  if (!gate.ok) return { url: rawUrl, title: null, text: "", retrievedAt, error: gate.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(rawUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "claude-cowork-local/webfetch", "Accept": "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
    });
    if (!res.ok) return { url: rawUrl, title: null, text: "", retrievedAt, error: `HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") || "";
    const raw = await readCapped(res, maxBytes);
    if (/text\/html|application\/xhtml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)) {
      const { title, text } = htmlToText(raw);
      return { url: rawUrl, title, text: text.slice(0, maxChars), retrievedAt };
    }
    // Plain text / JSON / markdown — return as-is (capped).
    return { url: rawUrl, title: null, text: raw.slice(0, maxChars), retrievedAt };
  } catch (e: any) {
    const reason = e?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (e?.message || "fetch failed");
    return { url: rawUrl, title: null, text: "", retrievedAt, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    out += decoder.decode(value, { stream: true });
    if (total >= maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      break;
    }
  }
  return out;
}

/** Build the Anthropic `web_fetch_tool_result` block for a fetched URL. */
export function webFetchResultBlock(toolUseId: string, r: WebFetchResult): any {
  if (r.error) {
    return {
      type: "web_fetch_tool_result",
      tool_use_id: toolUseId,
      content: { type: "web_fetch_tool_error", error_code: "unavailable", error_message: r.error, url: r.url },
    };
  }
  return {
    type: "web_fetch_tool_result",
    tool_use_id: toolUseId,
    content: {
      type: "web_fetch_result",
      url: r.url,
      retrieved_at: r.retrievedAt,
      content: {
        type: "document",
        title: r.title,
        citations: { enabled: true },
        source: { type: "text", media_type: "text/plain", data: r.text },
      },
    },
  };
}

/** The function-tool definition we hand the upstream model so it can request a fetch. */
export function webFetchFunctionTool(): any {
  return {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch the full text content of a web page by URL. Use when you need to read a specific page the user referenced or that appeared in the conversation.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The absolute http(s) URL to fetch." } },
        required: ["url"],
      },
    },
  };
}
