import { parseArgs } from "node:util";

/**
 * Command-line parsing: `loudscene <command> [positionals] [--flags]`, with node:util parseArgs
 * (strict, so a typo in a flag is an error rather than silently ignored).
 */

export const FORMATS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type Format = (typeof FORMATS)[number];
export const RESOLUTIONS = [720, 1080, 2160] as const;

export const COMMANDS = ["login", "logout", "whoami", "brand", "brands", "stories", "create", "status", "update", "stills", "render", "download", "open", "mcp", "help", "version"] as const;
export type Command = (typeof COMMANDS)[number];

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface Flags {
  json: boolean;
  wait: boolean;
  render: boolean;
  help: boolean;
  url?: string;
  brand?: string;
  /** A token's contract address or link: its launch film (the REST API's `token`). */
  token?: string;
  brief?: string;
  story?: string;
  formats?: Format[];
  duration?: number;
  resolution?: number;
  locale?: string;
  title?: string;
  /** `--field key=value` (text) and `--field key:=<json>` (numbers, toggles, images, lists). */
  fields?: Record<string, unknown>;
  /** Shown in the video's version history (update). */
  note?: string;
  /** Moments for stills, in seconds. */
  times?: number[];
  /** Extra languages for render: each becomes a translated copy of the video. */
  translate?: string[];
  output?: string;
  key?: string;
  apiUrl?: string;
  /** Upper bound of --wait, in seconds. */
  timeout?: number;
}

export interface ParsedCli {
  command: Command;
  positionals: string[];
  flags: Flags;
}

const OPTIONS = {
  json: { type: "boolean" },
  wait: { type: "boolean" },
  render: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  url: { type: "string" },
  brand: { type: "string" },
  token: { type: "string" },
  brief: { type: "string" },
  story: { type: "string" },
  formats: { type: "string" },
  format: { type: "string" },
  duration: { type: "string" },
  resolution: { type: "string" },
  locale: { type: "string" },
  title: { type: "string" },
  field: { type: "string", multiple: true },
  note: { type: "string" },
  at: { type: "string" },
  translate: { type: "string" },
  output: { type: "string", short: "o" },
  key: { type: "string" },
  "api-url": { type: "string" },
  timeout: { type: "string" },
} as const;

/** "9:16", "9x16" and "9/16" all mean 9:16 (a colon is awkward in some shells and file names). */
export function parseFormats(raw: string): Format[] {
  const out: Format[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const f = part.replace(/[x/]/i, ":");
    if (!(FORMATS as readonly string[]).includes(f)) throw new UsageError(`Unknown format "${part}". Use ${FORMATS.join(", ")} (comma-separated).`);
    if (!out.includes(f as Format)) out.push(f as Format);
  }
  if (out.length === 0) throw new UsageError(`--formats needs at least one of ${FORMATS.join(", ")}.`);
  return out;
}

/** The API takes field values typed: text as a string, the rest (numbers, toggles, images, lists) as JSON. */
export function parseFields(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const typed = eq > 0 && pair[eq - 1] === ":";
    const key = (eq > 0 ? pair.slice(0, typed ? eq - 1 : eq) : "").trim();
    if (!key) throw new UsageError(`--field "${pair}" needs a key: --field headline="Launch day", or --field price:=29 for a typed value.`);
    const raw = pair.slice(eq + 1);
    if (!typed) {
      out[key] = raw;
      continue;
    }
    try {
      out[key] = JSON.parse(raw);
    } catch {
      throw new UsageError(`--field ${key}:= takes JSON (29, true, {"url":"https://…"}, ["a","b"]). For text use --field ${key}=…`);
    }
  }
  return out;
}

/** "0,4.5,12" → [0, 4.5, 12]: moments of a video in seconds, 1 to 24 of them. */
export function parseTimes(raw: string): number[] {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const times = parts.map(Number);
  if (times.length === 0 || times.length > 24 || times.some((t) => !Number.isFinite(t) || t < 0 || t > 600)) {
    throw new UsageError("--at takes 1 to 24 moments in seconds (0 to 600), comma-separated, e.g. --at 0,4.5,12.");
  }
  return times;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

/** "de,pt-BR" → ["de", "pt-BR"]; the API translates at most 3 languages per request. */
export function parseLocales(raw: string): string[] {
  const out = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const bad = out.find((l) => !LOCALE_RE.test(l));
  if (bad) throw new UsageError(`"${bad}" isn't a language code. Use codes like de, es or pt-BR.`);
  if (out.length === 0 || out.length > 3) throw new UsageError("--translate takes 1 to 3 language codes per render, e.g. --translate de,es.");
  return out;
}

/** The closest command to a typo, when it is close enough to be what was meant. */
export function suggestCommand(input: string): string | null {
  const distance = (a: string, b: string) => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let diagonal = row[0]!;
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j]!;
        row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
        diagonal = above;
      }
    }
    return row[b.length]!;
  };
  let best: { name: string; d: number } | null = null;
  for (const name of COMMANDS) {
    const d = distance(input.toLowerCase(), name);
    if (!best || d < best.d) best = { name, d };
  }
  return best && best.d <= Math.max(1, Math.floor(best.name.length / 3)) ? best.name : null;
}

function number(name: string, raw: string | undefined, check: (n: number) => boolean, hint: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || !check(n)) throw new UsageError(`--${name} ${hint}`);
  return n;
}

export function parseCli(argv: string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message.replace(/^TypeError \[\w+\]: /, "") : String(error));
  }
  const { values: o, positionals } = parsed;
  const [first, ...rest] = positionals;
  let command: Command;
  if (o.version) command = "version";
  else if (!first) command = "help";
  else if ((COMMANDS as readonly string[]).includes(first)) command = first as Command;
  else {
    const guess = suggestCommand(first);
    throw new UsageError(`Unknown command "${first}".${guess ? ` Did you mean \`loudscene ${guess}\`?` : ""} Run \`loudscene help\` for the list.`);
  }

  const formatsRaw = o.formats ?? o.format;
  const flags: Flags = {
    json: o.json ?? false,
    wait: o.wait ?? false,
    render: o.render ?? false,
    help: o.help ?? false,
    ...(o.url !== undefined ? { url: o.url } : {}),
    ...(o.brand !== undefined ? { brand: o.brand } : {}),
    ...(o.token !== undefined ? { token: o.token } : {}),
    ...(o.brief !== undefined ? { brief: o.brief } : {}),
    ...(o.story !== undefined ? { story: o.story } : {}),
    ...(formatsRaw !== undefined ? { formats: parseFormats(formatsRaw) } : {}),
    ...(o.locale !== undefined ? { locale: o.locale } : {}),
    ...(o.title !== undefined ? { title: o.title } : {}),
    ...(o.field !== undefined ? { fields: parseFields(o.field) } : {}),
    ...(o.note !== undefined ? { note: o.note } : {}),
    ...(o.at !== undefined ? { times: parseTimes(o.at) } : {}),
    ...(o.translate !== undefined ? { translate: parseLocales(o.translate) } : {}),
    ...(o.output !== undefined ? { output: o.output } : {}),
    ...(o.key !== undefined ? { key: o.key } : {}),
    ...(o["api-url"] !== undefined ? { apiUrl: o["api-url"] } : {}),
  };
  const duration = number("duration", o.duration, (n) => n >= 6 && n <= 90, "must be a number of seconds from 6 to 90.");
  if (duration !== undefined) flags.duration = duration;
  const resolution = number("resolution", o.resolution, (n) => (RESOLUTIONS as readonly number[]).includes(n), "must be 720, 1080 or 2160.");
  if (resolution !== undefined) flags.resolution = resolution;
  const timeout = number("timeout", o.timeout, (n) => n > 0 && n <= 24 * 3600, "must be a number of seconds.");
  if (timeout !== undefined) flags.timeout = timeout;
  if (flags.url && flags.brand) throw new UsageError("Pass either --url or --brand, not both.");

  return { command, positionals: rest, flags };
}

/** A command's required positional, or a usage error naming it. */
export function need(positionals: string[], index: number, what: string, usage: string): string {
  const value = positionals[index];
  if (!value) throw new UsageError(`Missing ${what}. Usage: ${usage}`);
  return value;
}
