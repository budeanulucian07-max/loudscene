import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../src/commands.js";

/** The commands that need no key: every request is a plain GET without an Authorization header. */

type Handler = (path: string, query: URLSearchParams) => Response | undefined;

async function harness(handler: Handler, env: Record<string, string> = {}) {
  const home = await mkdtemp(join(tmpdir(), "loudscene-cli-public-"));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const opened: string[] = [];
  const requests: { method: string; url: URL; headers: Record<string, string> }[] = [];
  const io: Io = {
    stdout: { write: (s: string) => (stdout.push(s), true) } as Io["stdout"],
    stderr: { write: (s: string) => (stderr.push(s), true) } as Io["stderr"],
    stdin: new PassThrough(),
    env: { XDG_CONFIG_HOME: join(home, "config"), ...env },
    fetch: async (url, init) => {
      const u = new URL(url);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      requests.push({ method: init?.method ?? "GET", url: u, headers });
      return handler(u.pathname, u.searchParams) ?? Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    },
    sleep: async () => undefined,
    now: () => 0,
    interactive: false,
    home,
    version: "0.3.0",
    openUrl: async (u) => void opened.push(u),
    prompt: async () => "",
  };
  return { io, stdout, stderr, requests, opened, out: () => stdout.join(""), err: () => stderr.join("") };
}

const CA = "0xCD291FA4d3e2Eb43e4639625092D31ae10E61111";

const filmBody = {
  ok: true,
  film: {
    doc: { scenes: [{ id: "drop" }], logo: "data:image/png;base64,AAAA" },
    token: {
      chain: "robinhood",
      chainName: "Robinhood Chain",
      address: CA,
      name: "loudscene",
      symbol: "LOUD",
      imageUrl: "https://cdn.dexscreener.com/cms/images/x",
      marketCap: 19009,
      liquidityUsd: 16311.92,
      volume24h: 96.86,
      holders: 1181,
      readAt: "2026-11-25T12:09:32.539Z",
      pairUrl: "https://dexscreener.com/robinhood/0xd3e6",
    },
    sharePath: `/t/robinhood/${CA}/film`,
    makePath: "/signup?next=%2Fapp%2Fvideos%2Fnew",
    builderRecord: { name: "loudscene", statusLabel: "Active", url: "https://heyresearch.xyz/project/loudscene" },
  },
};

describe("film", () => {
  it("asks the instant-film endpoint without a key and prints the figures and the film link", async () => {
    const h = await harness((p, q) => (p === "/api/instant-film" && q.get("q") === CA ? Response.json(filmBody) : undefined));
    expect(await run(["film", CA], h.io)).toBe(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]!.method).toBe("GET");
    expect(h.requests[0]!.headers.authorization).toBeUndefined();
    const out = h.out();
    expect(out).toMatch(/^loudscene \(\$LOUD\) on Robinhood Chain\n/);
    expect(out).toContain("market cap $19.0K · liquidity $16.3K · 24h volume $97 · 1,181 holders (read 2026-11-25 12:09 UTC)");
    expect(out).toContain("loudscene · Active · https://heyresearch.xyz/project/loudscene");
    expect(out).toMatch(new RegExp(`film\\s+https://www\\.loudscene\\.com/t/robinhood/${CA}/film`));
    expect(out).toContain("https://www.loudscene.com/signup?next=%2Fapp%2Fvideos%2Fnew");
    expect(h.opened).toEqual([]);
  });

  it("--json leaves the player's doc out and adds full links; --open opens the film", async () => {
    const h = await harness((p) => (p === "/api/instant-film" ? Response.json(filmBody) : undefined), { LOUDSCENE_API_URL: "http://localhost:3000" });
    expect(await run(["film", `https://torch.fun/token/${CA}`, "--json", "--open"], h.io)).toBe(0);
    expect(h.requests[0]!.url.origin).toBe("http://localhost:3000");
    expect(h.requests[0]!.url.searchParams.get("q")).toBe(`https://torch.fun/token/${CA}`);
    const body = JSON.parse(h.out()) as Record<string, unknown>;
    expect(body.doc).toBeUndefined();
    expect(body).toMatchObject({ token: { symbol: "LOUD", holders: 1181 }, film_url: `http://localhost:3000/t/robinhood/${CA}/film` });
    expect(h.opened).toEqual([`http://localhost:3000/t/robinhood/${CA}/film`]);
  });

  it("passes on the server's message for an unknown token, and the wait on a 429", async () => {
    const h = await harness((p, q) =>
      q.get("q") === "0xdead"
        ? Response.json({ ok: false, error: "not_found", message: "We couldn't find a trading pool for that address yet." }, { status: 404 })
        : Response.json({ ok: false, error: "rate_limited", message: "That's a lot of films in a minute." }, { status: 429, headers: { "retry-after": "42" } }),
    );
    expect(await run(["film", "0xdead"], h.io)).toBe(1);
    expect(h.err()).toContain("We couldn't find a trading pool");
    h.stderr.length = 0;
    expect(await run(["film", CA], h.io)).toBe(1);
    expect(h.err()).toBe("Error: That's a lot of films in a minute. (loudscene asks to wait 42 s before the next one.)\n");
    // A 429 is never retried by the CLI.
    expect(h.requests).toHaveLength(2);
  });

  it("needs something to look up, and never asks for a key", async () => {
    const h = await harness(() => undefined);
    expect(await run(["film"], h.io)).toBe(2);
    expect(h.err()).toContain("Missing contract address or token link");
    expect(h.requests).toHaveLength(0);
  });
});
