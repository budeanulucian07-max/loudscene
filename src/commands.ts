import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";
import { need, parseCli, UsageError, type Flags, type ParsedCli } from "./args.js";
import { runBridge } from "./bridge.js";
import { ApiClient, ApiRequestError, TERMINAL, type FetchLike, type Job, type Render, type StillsResult, type Video } from "./client.js";
import { API_KEY_RE, clearKey, configPath, maskKey, readConfig, resolveApiUrl, resolveKey, writeConfig, type Env } from "./config.js";
import { formatSlug, pct, table } from "./output.js";

/** Everything a command touches outside itself, so tests can run commands in memory. */
export interface Io {
  stdout: Pick<Writable, "write">;
  stderr: Pick<Writable, "write">;
  stdin: Readable;
  env: Env;
  fetch: FetchLike;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Whether stderr is a terminal (progress lines are shown only then). */
  interactive: boolean;
  home?: string;
  version: string;
  openUrl: (url: string) => Promise<void>;
  /** Reads one line from the person at the terminal, without echo when `hidden`. */
  prompt: (question: string, hidden: boolean) => Promise<string>;
}

export class CliError extends Error {
  override readonly name = "CliError";
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export const HELP = `loudscene: on-brand videos from your terminal and your AI agents.

Usage: loudscene <command> [options]

Account
  login [--key ls_live_...]        Save an API key (Settings > API keys) to ~/.config/loudscene/config.json
  logout                           Forget the saved key
  whoami                           Show which key and server are in use, and check the key

Brand
  brand <url> [--wait]             Extract a brand kit from a website
  brands                           List brand kits
  stories                          List story templates and their fields

Videos
  create [--url <site> | --brand <kit id>] [--token <contract or link>] --brief "<text>"
         [--story <id>] [--formats 9:16,1:1] [--duration <s>] [--locale <code>] [--title <text>]
         [--wait] [--render]       Create a video. --token makes a token's launch film (its live
                                   figures and its image; --brief is optional then). --wait waits
                                   for the AI generation; --render then renders every --formats
                                   (spends credits, see below)
  status <job|video|render id>     Status and progress of anything (for a video: its field values)
  update <video id> [--field key=value ...] [--field key:=<json> ...] [--title <text>] [--note <text>]
                                   Change a video's text and values, without AI and at no cost.
                                   The change is a new version: render it again for new MP4s
  stills <video id> --at 0,4.5,12 [--formats 9:16] [--wait] [-o <dir>]
                                   PNG frames of the current version at those seconds, to check the
                                   look before rendering. Free. -o saves the PNGs (and waits)
  render <video id> [--formats 16:9,9:16,1:1,4:5] [--resolution 720|1080|2160] [--translate de,es] [--wait]
                                   Render MP4s (default: the video's main format). --translate also
                                   makes a translated copy of the video per language (up to 3, one
                                   AI generation each, Pro plan and up)
  download <render id> [-o <dir>] [--wait]
                                   Save a finished render as an MP4
  open <video id>                  Open the video in the loudscene editor

Agents
  mcp                              Run a stdio MCP server that forwards to <server>/api/mcp

Options
  --json                           Machine-readable output
  --api-url <url>                  Server (default https://www.loudscene.com, or LOUDSCENE_API_URL)
  --timeout <s>                    Upper bound for --wait (default 900)
  -h, --help / -v, --version

Environment: LOUDSCENE_API_KEY overrides the saved key; LOUDSCENE_API_URL overrides the server.
Credits: AI generations count against your plan's monthly generations; the first render of a video
version costs 1 credit per started minute and covers every format of that version.`;

interface Ctx {
  io: Io;
  flags: Flags;
  apiUrl: string;
  path: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function out(ctx: Ctx, text: string) {
  ctx.io.stdout.write(`${text}\n`);
}

function json(ctx: Ctx, value: unknown) {
  ctx.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Progress for people: on stderr, only in a terminal, never with --json. */
function progress(ctx: Ctx, text: string) {
  if (ctx.io.interactive && !ctx.flags.json) ctx.io.stderr.write(`${text}\n`);
}

async function apiKey(ctx: Ctx): Promise<string> {
  const config = await readConfig(ctx.path);
  const auth = resolveKey(ctx.flags.key, ctx.io.env, config);
  if (!auth) throw new CliError("No API key. Run `loudscene login` or set LOUDSCENE_API_KEY (create a key in Settings > API keys).", 3);
  if (!API_KEY_RE.test(auth.key)) throw new CliError(`The ${auth.source === "env" ? "LOUDSCENE_API_KEY" : "saved"} key isn't a loudscene API key (they start with ls_live_).`, 3);
  return auth.key;
}

async function client(ctx: Ctx): Promise<ApiClient> {
  return new ApiClient(ctx.apiUrl, await apiKey(ctx), ctx.io.fetch);
}

function assertId(id: string, what: string): string {
  if (!UUID_RE.test(id)) throw new UsageError(`"${id}" isn't a ${what} id (ids look like 8d3f2c1a-…).`);
  return id;
}

/** Polls until `done` or --timeout (default 15 minutes). */
async function poll<T>(ctx: Ctx, read: () => Promise<T>, done: (x: T) => boolean, describe: (x: T) => string, intervalMs = 3000): Promise<T> {
  const deadline = ctx.io.now() + (ctx.flags.timeout ?? 900) * 1000;
  let value = await read();
  let last = "";
  while (!done(value)) {
    const line = describe(value);
    if (line !== last) progress(ctx, line);
    last = line;
    if (ctx.io.now() + intervalMs > deadline) throw new CliError(`Still not finished after ${ctx.flags.timeout ?? 900} s. Check again with \`loudscene status\`.`);
    await ctx.io.sleep(intervalMs);
    value = await read();
  }
  return value;
}

const jobLine = (j: Job) => `${j.kind} ${j.status}${j.stage ? ` · ${j.stage}` : ""} · ${pct(j.progress)}`;
const renderLine = (r: Render) => `${r.format} ${r.resolution}p ${r.status} · ${pct(r.progress)}`;

function printVideo(ctx: Ctx, v: Video) {
  const scenes = v.current_version?.doc?.scenes ?? [];
  out(ctx, `${v.title}  (${v.id})`);
  out(ctx, `status   ${v.status}${v.job ? ` · job ${v.job.id} ${pct(v.job.progress)}` : ""}`);
  out(ctx, `format   ${v.default_format}${v.duration_sec ? ` · ${v.duration_sec} s` : ""}${v.story_id ? ` · story ${v.story_id}` : ""}`);
  if (scenes.length) out(ctx, `scenes   ${scenes.map((s) => s.label ?? s.id).join(" → ")}`);
  const fields = Object.entries(v.current_version?.doc?.fields ?? {});
  if (fields.length) {
    const rows = table(fields.map(([key, f]) => [key, f.type ?? "", shorten(JSON.stringify(f.value ?? null))]));
    out(ctx, `fields   ${rows.split("\n").join("\n         ")}`);
  }
  out(ctx, `editor   ${ctx.apiUrl}/app/videos/${v.id}`);
}

function shorten(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function printRenders(ctx: Ctx, renders: Render[]) {
  out(ctx, table(renders.map((r) => [r.id, r.format, `${r.resolution}p`, r.status, r.url ?? (r.error ?? pct(r.progress))]), ["RENDER", "FORMAT", "RES", "STATUS", "URL"]));
}

async function waitRenders(ctx: Ctx, api: ApiClient, renders: Render[]): Promise<Render[]> {
  return Promise.all(renders.map((r) => (TERMINAL.has(r.status) ? r : poll(ctx, () => api.render(r.id), (x) => TERMINAL.has(x.status), renderLine))));
}

/** Streams a signed file URL to disk. */
async function save(ctx: Ctx, url: string, file: string) {
  const res = await ctx.io.fetch(url);
  if (!res.ok || !res.body) throw new CliError(`Download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), createWriteStream(file));
}

/* ------------------------------------------------------------------ commands */

async function login(ctx: Ctx) {
  let key = ctx.flags.key?.trim();
  if (!key) {
    out(ctx, "Create a key in loudscene: Settings > API keys (Pro plan and up).");
    key = (await ctx.io.prompt("API key: ", true)).trim();
  }
  if (!API_KEY_RE.test(key)) throw new CliError("That isn't a loudscene API key. Keys start with ls_live_.", 3);
  const api = new ApiClient(ctx.apiUrl, key, ctx.io.fetch);
  const kits = await api.brandKits();
  const config = await readConfig(ctx.path);
  await writeConfig(ctx.path, { ...config, apiKey: key, ...(ctx.flags.apiUrl ? { apiUrl: ctx.apiUrl } : {}) });
  if (ctx.flags.json) return json(ctx, { ok: true, key: maskKey(key), config: ctx.path, api_url: ctx.apiUrl, brand_kits: kits.data.length });
  out(ctx, `Logged in with ${maskKey(key)}. Saved to ${ctx.path} (readable only by you).`);
  if (ctx.io.env.LOUDSCENE_API_KEY) out(ctx, "Note: LOUDSCENE_API_KEY is set and takes precedence over the saved key.");
}

async function logout(ctx: Ctx) {
  const removed = await clearKey(ctx.path);
  if (ctx.flags.json) return json(ctx, { ok: true, removed });
  out(ctx, removed ? `Removed the key from ${ctx.path}.` : "No saved key.");
}

async function whoami(ctx: Ctx) {
  const config = await readConfig(ctx.path);
  const auth = resolveKey(ctx.flags.key, ctx.io.env, config);
  if (!auth) throw new CliError("Not logged in. Run `loudscene login` or set LOUDSCENE_API_KEY.", 3);
  const api = new ApiClient(ctx.apiUrl, auth.key, ctx.io.fetch);
  const kits = await api.brandKits();
  const info = { key: maskKey(auth.key), source: auth.source === "config" ? ctx.path : auth.source === "env" ? "LOUDSCENE_API_KEY" : "--key", api_url: ctx.apiUrl, mcp_url: `${ctx.apiUrl}/api/mcp`, valid: true, brand_kits: kits.data.length };
  if (ctx.flags.json) return json(ctx, info);
  out(ctx, table([["key", `${info.key} (from ${info.source})`], ["server", info.api_url], ["mcp", info.mcp_url], ["status", `valid · ${info.brand_kits} brand kit${info.brand_kits === 1 ? "" : "s"}`]]));
}

async function brand(ctx: Ctx, p: ParsedCli) {
  const url = need(p.positionals, 0, "website", "loudscene brand <url> [--wait]");
  const api = await client(ctx);
  let job = await api.extractBrand(url);
  if (ctx.flags.wait) job = await poll(ctx, () => api.job(job.id), (j) => TERMINAL.has(j.status), jobLine);
  if (ctx.flags.json) return json(ctx, job);
  if (job.status === "succeeded") out(ctx, `Brand kit ready: ${String(job.result?.brand_kit_id ?? "(see `loudscene brands`)")}`);
  else if (job.status === "failed") throw new CliError(`Brand extraction failed: ${job.error ?? "unknown error"}`);
  else out(ctx, `Extracting the brand (job ${job.id}). Follow it with \`loudscene status ${job.id}\`, or pass --wait.`);
}

async function brands(ctx: Ctx) {
  const { data } = await (await client(ctx)).brandKits();
  if (ctx.flags.json) return json(ctx, data);
  if (data.length === 0) return out(ctx, "No brand kits yet. Create one with `loudscene brand <url>`.");
  out(ctx, table(data.map((k) => [k.id, k.is_default ? `${k.name} (default)` : k.name, k.tokens.colors?.accent ?? "", k.source_url ?? ""]), ["ID", "NAME", "ACCENT", "SOURCE"]));
}

async function stories(ctx: Ctx) {
  const { data } = await (await client(ctx)).stories();
  if (ctx.flags.json) return json(ctx, data);
  out(ctx, table(data.map((s) => [s.id, s.name, `${s.default_duration_sec} s`, Object.keys(s.fields).join(", ")]), ["ID", "NAME", "LENGTH", "FIELDS"]));
}

async function create(ctx: Ctx) {
  const f = ctx.flags;
  const api = await client(ctx);
  if (f.brand) assertId(f.brand, "brand kit");
  const body = {
    ...(f.brief !== undefined ? { brief: f.brief } : {}),
    ...(f.story !== undefined ? { storyId: f.story } : {}),
    ...(f.url !== undefined ? { url: f.url } : {}),
    ...(f.brand !== undefined ? { brandKitId: f.brand } : {}),
    ...(f.token !== undefined ? { token: f.token } : {}),
    ...(f.formats?.[0] ? { format: f.formats[0] } : {}),
    ...(f.duration !== undefined ? { durationSec: f.duration } : {}),
    ...(f.locale !== undefined ? { locale: f.locale } : {}),
    ...(f.title !== undefined ? { title: f.title } : {}),
  };
  if (!f.brief && !f.story && !f.token) throw new UsageError('Tell the video what to say with --brief "…" (or pick a --story, or pass --token for a token\'s launch film).');
  let video = await api.createVideo(body);
  progress(ctx, `Created video ${video.id}.`);
  if ((f.wait || f.render) && video.status === "generating") {
    video = await poll(ctx, () => api.video(video.id), (v) => v.status !== "generating", (v) => (v.job ? jobLine(v.job) : `video ${v.status}`));
    if (video.status === "failed") throw new CliError(`The generation failed${video.job?.error ? `: ${video.job.error}` : ""}. Try another brief, or open ${ctx.apiUrl}/app/videos/${video.id}.`);
  }
  let renders: Render[] | null = null;
  if (f.render) {
    renders = (await api.renderFormats(video.id, f.formats ?? [video.default_format], f.resolution)).renders;
    if (f.wait) renders = await waitRenders(ctx, api, renders);
  }
  if (ctx.flags.json) return json(ctx, renders ? { video, renders } : video);
  printVideo(ctx, video);
  if (renders) printRenders(ctx, renders);
  else if (video.status === "generating") out(ctx, `\nGenerating. Follow it with \`loudscene status ${video.id}\`, or pass --wait.`);
  else out(ctx, `\nRender it: loudscene render ${video.id} --formats ${(f.formats ?? [video.default_format]).join(",")} --wait`);
}

async function status(ctx: Ctx, p: ParsedCli) {
  const id = assertId(need(p.positionals, 0, "id", "loudscene status <job|video|render id>"), "job, video or render");
  const api = await client(ctx);
  const tries: [string, () => Promise<unknown>][] = [
    ["job", () => api.job(id)],
    ["video", () => api.video(id)],
    ["render", () => api.render(id)],
  ];
  for (const [kind, read] of tries) {
    let value: unknown;
    try {
      value = await read();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 404) continue;
      throw error;
    }
    if (ctx.flags.json) return json(ctx, { type: kind, [kind]: value });
    if (kind === "job") {
      const j = value as Job;
      out(ctx, `job ${j.id}: ${jobLine(j)}${j.error ? `\n${j.error}` : ""}${j.result ? `\n${JSON.stringify(j.result)}` : ""}`);
    } else if (kind === "video") printVideo(ctx, value as Video);
    else printRenders(ctx, [value as Render]);
    return;
  }
  throw new CliError(`Nothing with id ${id} in this workspace (checked jobs, videos and renders).`);
}

async function update(ctx: Ctx, p: ParsedCli) {
  const id = assertId(need(p.positionals, 0, "video id", 'loudscene update <video id> --field headline="Launch day" [--title <text>]'), "video");
  const f = ctx.flags;
  if (!f.fields && f.title === undefined) {
    throw new UsageError(`Nothing to change. Pass --field key=value (the keys are listed by \`loudscene status ${id}\`) and/or --title "…".`);
  }
  const api = await client(ctx);
  const video = await api.updateVideo(id, {
    ...(f.fields ? { fields: f.fields } : {}),
    ...(f.title !== undefined ? { title: f.title } : {}),
    ...(f.note !== undefined ? { note: f.note } : {}),
  });
  if (ctx.flags.json) return json(ctx, video);
  printVideo(ctx, video);
  const version = video.current_version ? `Saved as version ${video.current_version.number}. ` : "";
  out(ctx, `\n${version}Render it: loudscene render ${video.id} --wait`);
}

async function stills(ctx: Ctx, p: ParsedCli) {
  const usage = "loudscene stills <video id> --at 0,4.5,12 [--formats 9:16] [--wait] [-o <dir>]";
  const id = assertId(need(p.positionals, 0, "video id", usage), "video");
  const f = ctx.flags;
  if (!f.times) throw new UsageError(`Missing --at (the moments, in seconds). Usage: ${usage}`);
  if ((f.formats?.length ?? 0) > 1) throw new UsageError("Stills are taken in one format at a time: pass a single --formats value.");
  const format = f.formats?.[0];
  const api = await client(ctx);
  let job = await api.stills(id, f.times, format);
  if ((f.wait || f.output !== undefined) && !TERMINAL.has(job.status)) job = await poll(ctx, () => api.job(job.id), (j) => TERMINAL.has(j.status), jobLine, 2000);
  if (job.status === "failed" || job.status === "canceled") throw new CliError(`The stills job ${job.status}${job.error ? `: ${job.error}` : "."}`);
  const result = job.status === "succeeded" ? (job.result as StillsResult | null) : null;

  const files: (string | null)[] = [];
  if (result && f.output !== undefined) {
    const dir = resolve(f.output);
    await mkdir(dir, { recursive: true });
    for (const s of result.stills) {
      if (!s.url) {
        files.push(null);
        continue;
      }
      const file = join(dir, `loudscene-${id.slice(0, 8)}${format ? `-${formatSlug(format)}` : ""}-${s.t}s.png`);
      await save(ctx, s.url, file);
      files.push(file);
    }
  }
  if (f.json) return json(ctx, f.output !== undefined ? { job, files } : job);
  if (!result) return out(ctx, `Taking stills (job ${job.id}). Follow it with \`loudscene status ${job.id}\`, or pass --wait.`);
  const saved = f.output !== undefined;
  out(ctx, table(result.stills.map((s, i) => [`${s.t} s`, (saved ? files[i] : s.url) ?? "(not captured)"]), ["AT", saved ? "FILE" : "PNG"]));
  if (result.layout_errors || result.layout_warnings) out(ctx, `\nLayout check: ${result.layout_errors ?? 0} error(s), ${result.layout_warnings ?? 0} warning(s). Open the video to look: loudscene open ${id}`);
  if (!saved) out(ctx, "\nThe links expire in about 10 minutes. Save the PNGs with -o <dir>.");
}

async function render(ctx: Ctx, p: ParsedCli) {
  const id = assertId(need(p.positionals, 0, "video id", "loudscene render <video id> [--formats 16:9,9:16] [--translate de,es] [--wait]"), "video");
  const api = await client(ctx);
  const formats = ctx.flags.formats ?? [(await api.video(id)).default_format];
  const started = await api.renderFormats(id, formats, ctx.flags.resolution, ctx.flags.translate);
  let renders = started.renders;
  let translations = started.translations ?? [];
  if (ctx.flags.wait) {
    renders = await waitRenders(ctx, api, renders);
    translations = await Promise.all(translations.map((j) => (TERMINAL.has(j.status) ? j : poll(ctx, () => api.job(j.id), (x) => TERMINAL.has(x.status), jobLine))));
  }
  // Without --translate the JSON stays the plain list of renders it has always been.
  if (ctx.flags.json) return json(ctx, ctx.flags.translate ? { renders, translations } : renders);
  printRenders(ctx, renders);
  if (!ctx.flags.wait && renders.some((r) => !TERMINAL.has(r.status))) out(ctx, `\nDownload when ready: loudscene download <render id> --wait`);
  if (translations.length) {
    out(ctx, `\nTranslations (${(ctx.flags.translate ?? []).join(", ")}):`);
    out(ctx, table(translations.map((j) => [j.id, j.status, typeof j.result?.video_id === "string" ? j.result.video_id : (j.error ?? pct(j.progress))]), ["JOB", "STATUS", "COPY"]));
    out(ctx, ctx.flags.wait ? "\nEach copy is a video of its own: loudscene render <copy id> --wait" : "\nWhen a job succeeds, `loudscene status <job id>` gives the translated copy's video id.");
  }
}

async function download(ctx: Ctx, p: ParsedCli) {
  const id = assertId(need(p.positionals, 0, "render id", "loudscene download <render id> [-o dir] [--wait]"), "render");
  const api = await client(ctx);
  let r = await api.render(id);
  if (ctx.flags.wait && !TERMINAL.has(r.status)) r = await poll(ctx, () => api.render(id), (x) => TERMINAL.has(x.status), renderLine);
  if (r.status !== "succeeded" || !r.url) throw new CliError(r.status === "failed" ? `The render failed: ${r.error ?? "unknown error"}` : `The render is ${r.status} (${pct(r.progress)}). Retry when it has finished, or pass --wait.`);
  const dir = resolve(ctx.flags.output ?? ".");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `loudscene-${r.video_id.slice(0, 8)}-${formatSlug(r.format)}-${r.resolution}p.mp4`);
  await save(ctx, r.url, file);
  if (ctx.flags.json) return json(ctx, { file, render: r });
  out(ctx, file);
}

async function open(ctx: Ctx, p: ParsedCli) {
  const id = assertId(need(p.positionals, 0, "video id", "loudscene open <video id>"), "video");
  const url = `${ctx.apiUrl}/app/videos/${id}`;
  if (ctx.flags.json) return json(ctx, { url });
  out(ctx, url);
  await ctx.io.openUrl(url).catch(() => undefined);
}

async function mcp(ctx: Ctx) {
  const key = await apiKey(ctx);
  ctx.io.stderr.write(`loudscene mcp: forwarding stdio to ${ctx.apiUrl}/api/mcp\n`);
  await runBridge({
    endpoint: `${ctx.apiUrl}/api/mcp`,
    key,
    input: ctx.io.stdin,
    output: ctx.io.stdout as Writable,
    log: (line) => ctx.io.stderr.write(`${line}\n`),
    fetch: ctx.io.fetch,
    userAgent: `loudscene-cli/${ctx.io.version} (mcp bridge)`,
  });
}

/** Runs one invocation and returns the process exit code. Never throws. */
export async function run(argv: string[], io: Io): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (parsed.command === "version") {
    io.stdout.write(`${io.version}\n`);
    return 0;
  }
  if (parsed.command === "help" || parsed.flags.help) {
    io.stdout.write(`${HELP}\n`);
    return 0;
  }
  try {
    const path = configPath(io.env, io.home);
    const apiUrl = resolveApiUrl(parsed.flags.apiUrl, io.env, await readConfig(path));
    const ctx: Ctx = { io, flags: parsed.flags, apiUrl, path };
    const commands: Record<Exclude<ParsedCli["command"], "help" | "version">, (c: Ctx, p: ParsedCli) => Promise<void>> = {
      login,
      logout,
      whoami,
      brand,
      brands,
      stories,
      create,
      status,
      update,
      stills,
      render,
      download,
      open,
      mcp,
    };
    await commands[parsed.command](ctx, parsed);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`${error.message}\n`);
      return 2;
    }
    if (error instanceof ApiRequestError) {
      io.stderr.write(`Error: ${error.message}${error.requestId ? ` (request ${error.requestId})` : ""}\n`);
      return error.status === 401 || error.status === 403 ? 3 : 1;
    }
    if (error instanceof CliError) {
      io.stderr.write(`Error: ${error.message}\n`);
      return error.exitCode;
    }
    io.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
