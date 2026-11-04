import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseSse, runBridge } from "../src/bridge.js";

const KEY = "ls_live_" + "A".repeat(30);

interface Seen {
  headers: Record<string, string>;
  body: unknown;
}

/** A fake remote /api/mcp: answers like the real server (JSON, 202 for notifications, 401 without the key). */
function fakeServer(opts: { delayMs?: (body: { method?: string }) => number } = {}) {
  const seen: Seen[] = [];
  const fetch = async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = JSON.parse(String(init?.body)) as { id?: number | string; method?: string; params?: { protocolVersion?: string } } | unknown[];
    seen.push({ headers, body });
    if (headers.authorization !== `Bearer ${KEY}`) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This API key doesn't exist." } }), { status: 401, headers: { "content-type": "application/json" } });
    }
    if (Array.isArray(body)) return Response.json(body.filter((m) => (m as { id?: unknown }).id !== undefined).map((m) => ({ jsonrpc: "2.0", id: (m as { id: unknown }).id, result: {} })));
    const delay = opts.delayMs?.(body) ?? 0;
    if (delay) await new Promise((r) => setTimeout(r, delay));
    if (body.id === undefined) return new Response(null, { status: 202 });
    if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "loudscene" } } });
    if (body.method === "sse") return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { via: "sse" } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { method: body.method } });
  };
  return { fetch, seen };
}

async function bridge(lines: string[], opts: { key?: string; server?: ReturnType<typeof fakeServer> } = {}) {
  const server = opts.server ?? fakeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  output.on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  const logs: string[] = [];
  const done = runBridge({ endpoint: "https://loudscene.test/api/mcp", key: opts.key ?? KEY, input, output, log: (l) => logs.push(l), fetch: server.fetch });
  for (const l of lines) input.write(`${l}\n`);
  input.end();
  await done;
  const text = chunks.join("");
  return { text, messages: text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: unknown; result?: Record<string, unknown>; error?: { code: number; message: string } }), logs, seen: server.seen };
}

describe("stdio bridge", () => {
  it("forwards each line with the key and writes one JSON line per answer", async () => {
    const { text, messages, seen } = await bridge([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {} } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ]);
    expect(text.endsWith("\n")).toBe(true);
    expect(messages).toHaveLength(1); // the notification's 202 writes nothing
    expect(messages[0]!.result?.protocolVersion).toBe("2025-03-26");
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.headers.accept).toContain("application/json");
  });

  it("sends the negotiated MCP-Protocol-Version after initialize", async () => {
    const server = fakeServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const got: string[] = [];
    output.on("data", (c: Buffer) => got.push(c.toString()));
    const done = runBridge({ endpoint: "https://x/api/mcp", key: KEY, input, output, log: () => undefined, fetch: server.fetch });
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
    input.end();
    await done;
    expect(server.seen[1]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  it("answers requests concurrently: a slow call does not hold up a ping", async () => {
    const server = fakeServer({ delayMs: (b) => (b.method === "tools/call" ? 60 : 0) });
    const { messages } = await bridge([JSON.stringify({ jsonrpc: "2.0", id: "slow", method: "tools/call" }), JSON.stringify({ jsonrpc: "2.0", id: "fast", method: "ping" })], { server });
    expect(messages.map((m) => m.id)).toEqual(["fast", "slow"]);
  });

  it("turns a bad line into a parse error and HTTP 401 into a JSON-RPC error for that id", async () => {
    const bad = await bridge(["{nope"]);
    expect(bad.messages[0]).toMatchObject({ id: null, error: { code: -32700 } });
    const denied = await bridge([JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" })], { key: "ls_live_wrong" });
    expect(denied.messages[0]).toMatchObject({ id: 7, error: { code: -32001, message: "This API key doesn't exist." } });
  });

  it("passes batches through and unwraps SSE answers", async () => {
    const batch = await bridge([JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }])]);
    expect(Array.isArray(batch.messages[0])).toBe(true);
    const sse = await bridge([JSON.stringify({ jsonrpc: "2.0", id: 9, method: "sse" })]);
    expect(sse.messages[0]).toEqual({ jsonrpc: "2.0", id: 9, result: { via: "sse" } });
  });

  it("reports an unreachable server as an error for the request", async () => {
    const server = { fetch: async () => Promise.reject(new Error("ECONNREFUSED")), seen: [] };
    const { messages, logs } = await bridge([JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })], { server: server as unknown as ReturnType<typeof fakeServer> });
    expect(messages[0]).toMatchObject({ id: 3, error: { code: -32603 } });
    expect(logs[0]).toContain("ECONNREFUSED");
  });

  it("parses multi-event SSE bodies", () => {
    expect(parseSse('data: {"a":1}\n\n: comment\n\ndata: {"b":2}\n\n')).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
