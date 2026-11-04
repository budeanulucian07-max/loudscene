import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { FetchLike } from "./client.js";

/**
 * `loudscene mcp`: a stdio MCP server that forwards every JSON-RPC message to the remote
 * loudscene MCP server (/api/mcp, Streamable HTTP) with the API key, for clients that only launch
 * local stdio servers (Claude Desktop, older IDE plugins).
 *
 * Framing follows the MCP stdio transport: one JSON-RPC message (or batch) per line, UTF-8, no
 * embedded newlines; stdout carries protocol messages only, diagnostics go to stderr. Requests run
 * concurrently (a 25 s wait_for_job must not hold up a ping); answers are written as they arrive.
 */

export interface BridgeOptions {
  endpoint: string;
  key: string;
  input: Readable;
  output: Writable;
  log: (line: string) => void;
  fetch?: FetchLike;
  userAgent?: string;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; result?: unknown };

function requestIds(message: unknown): (string | number)[] {
  const list = Array.isArray(message) ? message : [message];
  return list.flatMap((m: Message) => (m && typeof m === "object" && typeof m.method === "string" && (typeof m.id === "string" || typeof m.id === "number") ? [m.id] : []));
}

function errorFor(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** Messages carried by a text/event-stream body (servers that answer with SSE instead of JSON). */
export function parseSse(body: string): unknown[] {
  const out: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Not a JSON-RPC event; ignore.
    }
  }
  return out;
}

export function runBridge(opts: BridgeOptions): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  let protocolVersion: string | null = null;
  const inflight = new Set<Promise<void>>();

  const write = (message: unknown) => {
    // JSON.stringify never emits raw newlines, so one message is exactly one line.
    opts.output.write(`${JSON.stringify(message)}\n`);
  };

  const forward = async (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write(errorFor(null, -32700, "Parse error: each line must be one JSON-RPC message."));
      return;
    }
    const ids = requestIds(message);
    const fail = (code: number, text: string) => {
      opts.log(`loudscene mcp: ${text}`);
      for (const id of ids) write(errorFor(id, code, text));
    };
    const headers: Record<string, string> = {
      authorization: `Bearer ${opts.key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "user-agent": opts.userAgent ?? "loudscene-cli",
    };
    if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
    let res: Response;
    try {
      res = await doFetch(opts.endpoint, { method: "POST", headers, body: line });
    } catch (error) {
      fail(-32603, `couldn't reach ${opts.endpoint}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const text = await res.text().catch(() => "");
    if (res.status === 202 || res.status === 204 || text.trim() === "") {
      if (!res.ok) fail(-32603, `the server answered ${res.status}.`);
      return;
    }
    const type = res.headers.get("content-type") ?? "";
    let replies: unknown[];
    if (type.includes("text/event-stream")) replies = parseSse(text);
    else {
      try {
        replies = [JSON.parse(text)];
      } catch {
        fail(-32603, `the server answered ${res.status} with a body that isn't JSON.`);
        return;
      }
    }
    if (!res.ok) {
      // The server's own JSON-RPC error (401 bad key, 429 rate limit) names no request id; give each request its message.
      const reason = (replies[0] as { error?: { message?: string } } | undefined)?.error?.message ?? `the server answered ${res.status}.`;
      const code = res.status === 401 || res.status === 403 ? -32001 : -32603;
      if (ids.length === 0) opts.log(`loudscene mcp: ${reason}`);
      for (const id of ids) write(errorFor(id, code, reason));
      return;
    }
    for (const reply of replies) {
      const version = (reply as { result?: { protocolVersion?: unknown } } | null)?.result?.protocolVersion;
      if (typeof version === "string") protocolVersion = version;
      write(reply);
    }
  };

  return new Promise((resolve) => {
    const rl = createInterface({ input: opts.input, crlfDelay: Infinity, terminal: false });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      const p = forward(line.trim()).finally(() => inflight.delete(p));
      inflight.add(p);
    });
    rl.on("close", () => {
      void Promise.allSettled([...inflight]).then(() => resolve());
    });
  });
}
