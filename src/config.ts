import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the CLI keeps its key: $XDG_CONFIG_HOME/loudscene/config.json (default
 * ~/.config/loudscene/config.json), readable only by its owner (file 0600, folder 0700).
 * LOUDSCENE_API_KEY and LOUDSCENE_API_URL override the file, so CI never needs one.
 */

export const DEFAULT_API_URL = "https://www.loudscene.com";
export const API_KEY_RE = /^ls_(live|test)_[A-Za-z0-9]{20,80}$/;

export interface Config {
  apiKey?: string;
  apiUrl?: string;
}

export type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env, home = homedir()): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(base, "loudscene", "config.json");
}

export async function readConfig(path: string): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    const c = parsed as Record<string, unknown>;
    return { ...(typeof c.apiKey === "string" ? { apiKey: c.apiKey } : {}), ...(typeof c.apiUrl === "string" ? { apiUrl: c.apiUrl } : {}) };
  } catch {
    return {};
  }
}

export async function writeConfig(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode applies only when it creates the file; tighten an existing one too.
  await chmod(path, 0o600);
}

export async function clearKey(path: string): Promise<boolean> {
  const c = await readConfig(path);
  if (!c.apiKey) return false;
  const { apiKey: _drop, ...rest } = c;
  if (Object.keys(rest).length === 0) await rm(path, { force: true });
  else await writeConfig(path, rest);
  return true;
}

export interface ResolvedAuth {
  key: string;
  source: "flag" | "env" | "config";
}

export function resolveKey(flag: string | undefined, env: Env, config: Config): ResolvedAuth | null {
  if (flag) return { key: flag.trim(), source: "flag" };
  const fromEnv = env.LOUDSCENE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (config.apiKey) return { key: config.apiKey, source: "config" };
  return null;
}

/** The site origin (no trailing slash, no /api suffix): flag, then env, then config, then production. */
export function resolveApiUrl(flag: string | undefined, env: Env, config: Config): string {
  const raw = flag?.trim() || env.LOUDSCENE_API_URL?.trim() || config.apiUrl || DEFAULT_API_URL;
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error(`LOUDSCENE_API_URL "${raw}" isn't a URL.`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/api(\/v1|\/mcp)?$/, "")}`;
}

/** "ls_live_AbCd…wxyz": enough to recognise a key, never enough to use it. */
export function maskKey(key: string): string {
  const m = /^(ls_(?:live|test)_)(.*)$/.exec(key);
  if (!m) return "••••";
  const body = m[2] ?? "";
  return `${m[1]}${body.slice(0, 4)}…${body.slice(-4)}`;
}
