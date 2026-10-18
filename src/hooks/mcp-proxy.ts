import { createInterface } from "node:readline";
import { getApiKeyValue } from "../config.js";
import { createV5Client, normalizeSearchItem, searchV5 } from "../services/api.js";
import type { SearchResultItem } from "../services/client.js";
import { limitStatus, recallCoolingDown, startRecallCooldown } from "../services/recallCooldown.js";
import { memoryText } from "../services/resultText.js";
import { getTags } from "../services/tags.js";

const MCP_URL =
  process.env.SUPERMEMORY_MCP_URL || "https://mcp.supermemory.ai/mcp";
const REQUEST_TIMEOUT_MS = 30_000;

// The hosted search_memory tool returns formed memories only. This local tool
// searches memories and source chunks together, so an agent can reach document
// and code detail when it asks, without a search on every prompt.
const HYBRID_SEARCH_TOOL = {
  name: "search_hybrid",
  description:
    "Search memories and source document chunks together in one space. Use when search_memory misses detail that lives in documents or code. Defaults to this repository space.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language search query" },
      namespace: { type: "string", description: "Space to search; defaults to this repository" },
    },
    required: ["query"],
  },
};
const HYBRID_RESULT_CHARS = 600;

let sessionId: string | null = null;

interface JsonRpcMessage {
  id?: string | number | null;
  [key: string]: unknown;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendError(
  id: JsonRpcMessage["id"],
  code: number,
  message: string,
): void {
  if (id === undefined || id === null) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

// Add the local tool to the hosted tool list; other responses pass through.
function withLocalTools(data: string, message: JsonRpcMessage): string {
  if (message.method !== "tools/list") return data;
  try {
    const parsed = JSON.parse(data) as { result?: { tools?: unknown[] } };
    if (!Array.isArray(parsed.result?.tools)) return data;
    parsed.result.tools.push(HYBRID_SEARCH_TOOL);
    return JSON.stringify(parsed);
  } catch {
    return data;
  }
}

function emitSseData(body: string, message: JsonRpcMessage): void {
  for (const event of body.split("\n\n")) {
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data) process.stdout.write(`${withLocalTools(data, message)}\n`);
    }
  }
}

function sendToolText(id: JsonRpcMessage["id"], text: string, isError = false): void {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } });
}

function formatHybridResults(results: SearchResultItem[]): string {
  if (results.length === 0) return "No matching memories or document chunks.";
  return results
    .map((item) => {
      const text = memoryText(item).replace(/\s+/g, " ").slice(0, HYBRID_RESULT_CHARS);
      const kind = typeof item.chunk === "string" ? "chunk" : "memory";
      const score = Number.isFinite(item.similarity) ? ` ${Math.round((item.similarity as number) * 100)}%` : "";
      const source = item.filepath ? ` (${item.filepath})` : "";
      return `- [${kind}${score}] ${text}${source}`;
    })
    .join("\n");
}

async function callHybridSearch(message: JsonRpcMessage): Promise<void> {
  const params = (message.params ?? {}) as { arguments?: { query?: unknown; namespace?: unknown } };
  const args = params.arguments ?? {};
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const namespace = typeof args.namespace === "string" && args.namespace.trim()
    ? args.namespace.trim()
    : getTags(process.cwd()).canonical;
  if (!query || !namespace) {
    sendToolText(message.id, "search_hybrid needs a query and a space.", true);
    return;
  }
  if (recallCoolingDown()) {
    sendToolText(message.id, "Supermemory search is paused after a usage limit. Try again later.", true);
    return;
  }
  try {
    const search = await searchV5(createV5Client(), namespace, query, "hybrid", undefined, {
      timeoutInSeconds: REQUEST_TIMEOUT_MS / 1000,
      maxRetries: 0,
    });
    sendToolText(message.id, formatHybridResults(search.results.map(normalizeSearchItem)));
  } catch (error) {
    const status = limitStatus(error);
    if (status) startRecallCooldown(status);
    const detail = error instanceof Error ? error.message : String(error);
    sendToolText(message.id, `search_hybrid failed: ${detail}`, true);
  }
}

async function forward(message: JsonRpcMessage, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const nextSessionId = response.headers.get("mcp-session-id");
  if (nextSessionId) sessionId = nextSessionId;

  if (response.status === 202) return;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    sendError(
      message.id,
      -32000,
      `Supermemory MCP ${response.status}: ${body.slice(0, 200) || "request failed"}`,
    );
    return;
  }

  const contentType = response.headers.get("content-type") || "";
  const body = await response.text();
  if (!body.trim()) return;

  if (contentType.includes("text/event-stream")) emitSseData(body, message);
  else process.stdout.write(`${withLocalTools(body.trim(), message)}\n`);
}

function main(): void {
  const apiKey = getApiKeyValue();
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    if (!line.trim()) return;

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }

    queue = queue.then(async () => {
      if (!apiKey) {
        sendError(
          message.id,
          -32001,
          "Supermemory is not authenticated. Start a new Codex task to log in, or set SUPERMEMORY_CODEX_API_KEY.",
        );
        return;
      }

      try {
        const params = message.params as { name?: unknown } | undefined;
        if (message.method === "tools/call" && params?.name === HYBRID_SEARCH_TOOL.name) {
          await callHybridSearch(message);
          return;
        }
        await forward(message, apiKey);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendError(message.id, -32000, `Supermemory MCP proxy error: ${detail}`);
      }
    });
  });

  lines.on("close", () => {
    queue.finally(() => process.exit(0));
  });
}

main();
