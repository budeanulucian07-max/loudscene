import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/commands.js";

const KEY = "ls_live_" + "K".repeat(32);
const VIDEO = "22222222-2222-4222-8222-222222222222";
const JOB = "11111111-1111-4111-8111-111111111111";
const RENDER = "33333333-3333-4333-8333-333333333333";

type Handler = (method: string, path: string, body: unknown, headers: Record<string, string>) => Response | undefined;

async function harness(handler: Handler, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "loudscene-cli-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: { method: string; path: string; body: unknown; headers: Record<string, string> }[] = [];
  let clock = 0;
  const io: Io = {
    stdout: { write: (s: string) => (stdout.push(s), true) } as Io["stdout"],
    stderr: { write: (s: string) => (stderr.push(s), true) } as Io["stderr"],
    stdin: new PassThrough(),
    env: { XDG_CONFIG_HOME: join(home, "config"), ...env },
    fetch: async (url, init) => {
      const u = new URL(url);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined;
      requests.push({ method: init?.method ?? "GET", path: u.pathname, body, headers });
      if (u.hostname === "cdn.test") return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
      if (headers.authorization !== `Bearer ${KEY}`) return Response.json({ error: { code: "unauthorized", message: "This API key doesn't exist.", request_id: "req_1" } }, { status: 401 });
      return handler(init?.method ?? "GET", u.pathname, body, headers) ?? Response.json({ error: { code: "not_found", message: "Not found.", request_id: "req_2" } }, { status: 404 });
    },
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
    interactive: false,
    home,
    version: "0.1.0",
    openUrl: async () => undefined,
    prompt: async () => KEY,
  };
  return { io, home, stdout, stderr, requests, out: () => stdout.join("") };
}

const video = (status: string, progress = 0.5) => ({
  id: VIDEO,
  title: "Acme launch",
  status,
  story_id: null,
  brand_kit_id: null,
  default_format: "9:16",
  duration_sec: status === "ready" ? 20 : null,
  current_version: status === "ready" ? { id: "v1", number: 1, doc: { scenes: [{ id: "hook", label: "Hook" }, { id: "cta", label: "CTA" }] } } : null,
  job: status === "generating" ? { id: JOB, kind: "generate", status: "running", stage: "scenes", progress, error: null, result: null } : null,
});

describe("login and whoami", () => {
  it("checks the key, stores it 0600 and reports it masked", async () => {
    const h = await harness((m, p) => (p === "/api/v1/brand-kits" ? Response.json({ data: [{ id: "k", name: "Acme", is_default: true, tokens: {} }] }) : undefined));
    expect(await run(["login"], h.io)).toBe(0);
    const file = join(h.home, "config", "loudscene", "config.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ apiKey: KEY });
    // Windows has no Unix permission bits: chmod 0600 is a no-op there.
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(h.out()).toContain("ls_live_KKKK…KKKK");
    expect(h.out()).not.toContain(KEY);

    h.stdout.length = 0;
    expect(await run(["whoami", "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ key: "ls_live_KKKK…KKKK", valid: true, brand_kits: 1, mcp_url: "https://www.loudscene.com/api/mcp" });
  });

  it("refuses a malformed key without saving it, and exits 3 without any key", async () => {
    const h = await harness(() => undefined);
    expect(await run(["login", "--key", "sk-nope"], h.io)).toBe(3);
    expect(await run(["brands"], h.io)).toBe(3);
    expect(h.stderr.join("")).toContain("loudscene login");
  });

  it("uses LOUDSCENE_API_KEY and LOUDSCENE_API_URL", async () => {
    const h = await harness((m, p) => (p === "/api/v1/stories" ? Response.json({ data: [{ id: "product-launch", name: "Product launch", category: "launch", description: "", default_duration_sec: 20, fields: { headline: { type: "text", label: "Headline" } } }] }) : undefined), { LOUDSCENE_API_KEY: KEY, LOUDSCENE_API_URL: "http://localhost:3000" });
    expect(await run(["stories"], h.io)).toBe(0);
    expect(h.out()).toContain("product-launch");
    expect(h.out()).toContain("headline");
  });
});

describe("videos", () => {
  it("create --wait sends the v1 body with an Idempotency-Key and waits for the generation", async () => {
    let reads = 0;
    const h = await harness(
      (m, p) => {
        if (m === "POST" && p === "/api/v1/videos") return Response.json(video("generating", 0), { status: 201 });
        if (p === `/api/v1/videos/${VIDEO}`) return Response.json(video(++reads >= 2 ? "ready" : "generating"));
        return undefined;
      },
      { LOUDSCENE_API_KEY: KEY },
    );
    expect(await run(["create", "--url", "acme.com", "--brief", "We launched v2", "--formats", "9:16,1:1", "--wait"], h.io)).toBe(0);
    const post = h.requests.find((r) => r.method === "POST")!;
    expect(post.body).toEqual({ url: "acme.com", brief: "We launched v2", format: "9:16" });
    expect(post.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.out()).toContain("Hook → CTA");
    expect(h.out()).toContain(`loudscene render ${VIDEO} --formats 9:16,1:1 --wait`);
  });

  it("create --token sends the token, no brief needed", async () => {
    const h = await harness((m, p) => (m === "POST" && p === "/api/v1/videos" ? Response.json(video("generating", 0), { status: 201 }) : undefined), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["create", "--token", "0xCD291FA4d3e2Eb43e4639625092D31ae10E61111"], h.io)).toBe(0);
    const post = h.requests.find((r) => r.method === "POST")!;
    expect(post.body).toEqual({ token: "0xCD291FA4d3e2Eb43e4639625092D31ae10E61111" });
  });

  it("status finds a video id after the job lookup 404s", async () => {
    const h = await harness((m, p) => (p === `/api/v1/videos/${VIDEO}` ? Response.json(video("ready")) : undefined), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["status", VIDEO, "--json"], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toMatchObject({ type: "video", video: { id: VIDEO } });
    expect(h.requests.map((r) => r.path)).toEqual([`/api/v1/jobs/${VIDEO}`, `/api/v1/videos/${VIDEO}`]);
  });

  it("render --wait uses the variants endpoint, then download saves the MP4", async () => {
    let polls = 0;
    const render = (status: string) => ({ id: RENDER, video_id: VIDEO, format: "9:16", resolution: 1080, fps: 30, status, progress: status === "succeeded" ? 1 : 0.3, url: status === "succeeded" ? "https://cdn.test/r.mp4" : null, poster_url: null, error: null });
    const h = await harness(
      (m, p) => {
        if (m === "POST" && p === `/api/v1/videos/${VIDEO}/variants`) return Response.json({ renders: [render("queued")], translations: [] }, { status: 202 });
        if (p === `/api/v1/renders/${RENDER}`) return Response.json(render(++polls >= 2 ? "succeeded" : "running"));
        return undefined;
      },
      { LOUDSCENE_API_KEY: KEY },
    );
    expect(await run(["render", VIDEO, "--formats", "9x16", "--wait"], h.io)).toBe(0);
    expect(h.requests[0]!.body).toEqual({ formats: ["9:16"] });
    expect(h.out()).toContain("https://cdn.test/r.mp4");

    h.stdout.length = 0;
    const dir = join(h.home, "out");
    expect(await run(["download", RENDER, "-o", dir], h.io)).toBe(0);
    const file = h.out().trim();
    expect(file).toBe(join(dir, "loudscene-22222222-9x16-1080p.mp4"));
    expect((await readFile(file)).length).toBe(8);
  });

  it("reports API errors with the request id and a non-zero exit", async () => {
    const h = await harness(() => Response.json({ error: { code: "insufficient_credits", message: "This render needs 1 credit and the workspace has 0.", request_id: "req_9" } }, { status: 402 }), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["render", VIDEO, "--formats", "16:9"], h.io)).toBe(1);
    expect(h.stderr.join("")).toContain("needs 1 credit");
    expect(h.stderr.join("")).toContain("req_9");
  });

  it("rejects ids that aren't UUIDs before calling the API", async () => {
    const h = await harness(() => undefined, { LOUDSCENE_API_KEY: KEY });
    expect(await run(["open", "nope"], h.io)).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});

describe("update", () => {
  const withFields = (headline: string, version = 2) => ({
    ...video("ready"),
    current_version: {
      id: `v${version}`,
      number: version,
      doc: { scenes: [{ id: "hook", label: "Hook" }], fields: { headline: { type: "text", label: "Headline", value: headline }, price: { type: "number", label: "Price", value: 29 } } },
    },
  });

  it("sends a PATCH with typed fields, the title and the note, and prints the new version", async () => {
    const h = await harness((m, p) => (m === "PATCH" && p === `/api/v1/videos/${VIDEO}` ? Response.json(withFields("Launch day")) : undefined), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["update", VIDEO, "--field", "headline=Launch day", "--field", "price:=29", "--title", "Acme v2", "--note", "new price"], h.io)).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.body).toEqual({ fields: { headline: "Launch day", price: 29 }, title: "Acme v2", note: "new price" });
    expect(h.out()).toMatch(/fields\s+headline\s+text\s+"Launch day"/);
    expect(h.out()).toContain("Saved as version 2.");
    expect(h.out()).toContain(`loudscene render ${VIDEO} --wait`);
  });

  it("status on a video lists its field values", async () => {
    const h = await harness((m, p) => (p === `/api/v1/videos/${VIDEO}` ? Response.json(withFields("Hello", 1)) : undefined), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["status", VIDEO], h.io)).toBe(0);
    expect(h.out()).toMatch(/price\s+number\s+29/);
  });

  it("refuses an update with nothing to change, before calling the API", async () => {
    const h = await harness(() => undefined, { LOUDSCENE_API_KEY: KEY });
    expect(await run(["update", VIDEO, "--note", "only a note"], h.io)).toBe(2);
    expect(h.stderr.join("")).toContain("Nothing to change");
    expect(h.requests).toHaveLength(0);
  });
});

describe("stills", () => {
  const STILLS = "44444444-4444-4444-8444-444444444444";
  const stillsJob = (status: string) => ({
    id: STILLS,
    kind: "stills",
    status,
    stage: null,
    progress: status === "succeeded" ? 1 : 0.4,
    error: null,
    result: status === "succeeded" ? { stills: [{ t: 0, url: "https://cdn.test/0.png" }, { t: 4.5, url: "https://cdn.test/4.5.png" }], layout_errors: 0, layout_warnings: 1 } : null,
  });

  it("starts a stills job, waits for it and saves the PNGs with -o", async () => {
    let polls = 0;
    const h = await harness(
      (m, p) => {
        if (m === "POST" && p === `/api/v1/videos/${VIDEO}/stills`) return Response.json(stillsJob("queued"), { status: 202 });
        if (p === `/api/v1/jobs/${STILLS}`) return Response.json(stillsJob(++polls >= 2 ? "succeeded" : "running"));
        return undefined;
      },
      { LOUDSCENE_API_KEY: KEY },
    );
    const dir = join(h.home, "stills");
    expect(await run(["stills", VIDEO, "--at", "0,4.5", "--formats", "9:16", "-o", dir], h.io)).toBe(0);
    expect(h.requests[0]!.body).toEqual({ times: [0, 4.5], format: "9:16" });
    expect(h.requests[0]!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const file = join(dir, "loudscene-22222222-9x16-4.5s.png");
    expect(h.out()).toContain(file);
    expect(h.out()).toContain("1 warning(s)");
    expect((await readFile(file)).length).toBe(8);
  });

  it("without --wait prints the job to follow", async () => {
    const h = await harness((m, p) => (m === "POST" && p === `/api/v1/videos/${VIDEO}/stills` ? Response.json(stillsJob("queued"), { status: 202 }) : undefined), { LOUDSCENE_API_KEY: KEY });
    expect(await run(["stills", VIDEO, "--at", "3"], h.io)).toBe(0);
    expect(h.requests[0]!.body).toEqual({ times: [3] });
    expect(h.out()).toContain(`loudscene status ${STILLS}`);
  });

  it("needs --at and a single format", async () => {
    const h = await harness(() => undefined, { LOUDSCENE_API_KEY: KEY });
    expect(await run(["stills", VIDEO], h.io)).toBe(2);
    expect(await run(["stills", VIDEO, "--at", "1", "--formats", "9:16,1:1"], h.io)).toBe(2);
    expect(await run(["stills", VIDEO, "--at", "1,-2"], h.io)).toBe(2);
    expect(h.requests).toHaveLength(0);
  });
});
