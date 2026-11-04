import { parseArgs } from "node:util";

/**
 * Command-line parsing: `loudscene <command> [positionals] [--flags]`, with node:util parseArgs
 * (strict, so a typo in a flag is an error rather than silently ignored).
 */

export const FORMATS = ["16:9", "9:16", "1:1", "4:5"] as const;
export type Format = (typeof FORMATS)[number];
export const RESOLUTIONS = [720, 1080, 2160] as const;

export const COMMANDS = ["login", "logout", "whoami", "brand", "brands", "stories", "create", "status", "render", "download", "open", "mcp", "help", "version"] as const;
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
  else throw new UsageError(`Unknown command "${first}". Run \`loudscene help\` for the list.`);

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
