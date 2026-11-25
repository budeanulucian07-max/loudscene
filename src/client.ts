import { randomUUID } from "node:crypto";

/**
 * A small client for the loudscene public API v1 (the same endpoints documented at
 * /api/v1/openapi.json). Every POST carries a fresh Idempotency-Key, so a retry after a dropped
 * connection can never create or charge twice.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class ApiRequestError extends Error {
  override readonly name = "ApiRequestError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

export interface Job {
  id: string;
  kind: string;
  status: string;
  stage: string | null;
  progress: number;
  error: string | null;
  result: Record<string, unknown> | null;
}

export interface Render {
  id: string;
  video_id: string;
  format: string;
  resolution: number;
  fps: number;
  status: string;
  progress: number;
  /** Signed, short-lived: fetch it soon after reading the render (see url_expires_at). */
  url: string | null;
  poster_url: string | null;
  url_expires_at?: string | null;
  error: string | null;
}

export interface Video {
  id: string;
  title: string;
  status: string;
  story_id: string | null;
  brand_kit_id: string | null;
  default_format: string;
  duration_sec: number | null;
  current_version: {
    id: string;
    number: number;
    doc: { scenes?: { id: string; label?: string; duration?: number }[]; fields?: Record<string, { type?: string; label?: string; value?: unknown }> };
  } | null;
  job: Job | null;
}

export interface BrandKit {
  id: string;
  name: string;
  source_url: string | null;
  is_default: boolean;
  tokens: { colors?: Record<string, string> };
}

export interface Story {
  id: string;
  name: string;
  category: string;
  description: string;
  default_duration_sec: number;
  fields: Record<string, { type: string; label: string }>;
}

/** A stills job's result once it has succeeded: signed PNG URLs, valid for about 10 minutes. */
export interface StillsResult {
  stills: { t: number; url: string | null }[];
  layout_errors?: number;
  layout_warnings?: number;
}

export const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

export class ApiClient {
  constructor(
    readonly baseUrl: string,
    private readonly key: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async request<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, accept: "application/json", "user-agent": "loudscene-cli" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (method === "POST") headers["idempotency-key"] = randomUUID();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      throw new ApiRequestError(0, "network_error", `Couldn't reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A proxy or HTML error page: reported below with the status.
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; request_id?: string } } | null)?.error;
      throw new ApiRequestError(res.status, err?.code ?? `http_${res.status}`, err?.message ?? `The API answered ${res.status} ${res.statusText}.`, err?.request_id ?? res.headers.get("x-request-id"));
    }
    return json as T;
  }

  extractBrand(url: string) {
    return this.request<Job>("POST", "/v1/brand/extract", { url });
  }
  brandKits() {
    return this.request<{ data: BrandKit[] }>("GET", "/v1/brand-kits");
  }
  stories() {
    return this.request<{ data: Story[] }>("GET", "/v1/stories");
  }
  createVideo(body: Record<string, unknown>) {
    return this.request<Video>("POST", "/v1/videos", body);
  }
  video(id: string) {
    return this.request<Video>("GET", `/v1/videos/${encodeURIComponent(id)}`);
  }
  job(id: string) {
    return this.request<Job>("GET", `/v1/jobs/${encodeURIComponent(id)}`);
  }
  render(id: string) {
    return this.request<Render>("GET", `/v1/renders/${encodeURIComponent(id)}`);
  }
  /** Field values and/or the title, without AI and at no cost; field changes become a new version. */
  updateVideo(id: string, body: { fields?: Record<string, unknown>; title?: string; note?: string }) {
    return this.request<Video>("PATCH", `/v1/videos/${encodeURIComponent(id)}`, body);
  }
  /** A stills job: PNG frames of the current version at `times` seconds, free. */
  stills(videoId: string, times: number[], format?: string) {
    return this.request<Job>("POST", `/v1/videos/${encodeURIComponent(videoId)}/stills`, { times, ...(format ? { format } : {}) });
  }
  /** Renders every format of the current version; `locales` also starts one translate job per language. */
  renderFormats(videoId: string, formats: string[], resolution?: number, locales?: string[]) {
    return this.request<{ renders: Render[]; translations?: Job[] }>("POST", `/v1/videos/${encodeURIComponent(videoId)}/variants`, {
      formats,
      ...(resolution ? { resolution } : {}),
      ...(locales?.length ? { locales } : {}),
    });
  }
}

/* ------------------------------------------------------------- no key needed */

/** A token as the home page's instant film reads it (GET /api/instant-film). */
export interface InstantFilmToken {
  chain: string;
  chainName: string;
  address: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  holders: number | null;
  readAt: string;
  pairUrl: string | null;
}

export interface InstantFilm {
  /** The player's document (scenes, the logo as data: URIs): large, and only the player needs it. */
  doc?: unknown;
  token: InstantFilmToken;
  /** /t/<chain>/<address>/film: the page that plays the film. */
  sharePath: string;
  /** Sign-up, then a new video with this token: the editable, renderable version. */
  makePath: string;
  /** The team's builder record on HEY Research Lab, when it has one (Robinhood Chain). */
  builderRecord: { name: string; statusLabel: string; url: string } | null;
}

/** One line of the Score live feed (GET /api/creators/live): a launch, a call, a founder seat. */
export interface LiveEvent {
  id: string;
  kind: string;
  title: string;
  detail: string | null;
  at: string;
  /** A path on the site, e.g. /creators/p/robinhood/0x… */
  href: string | null;
}

export interface TorchLaunches {
  updatedAt: string | null;
  launches: { ca: string; symbol: string; since: string | null; page: string; signals: string[] }[];
  count: number;
  rule: string;
}

export interface Seats {
  taken: number;
  slots: number;
}

/**
 * The site's public JSON endpoints: no key, no Authorization header, nothing but a GET. They are
 * rate-limited per IP; a 429 says how long to wait (Retry-After) and is never retried here.
 */
export class PublicApi {
  constructor(
    readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "loudscene-cli" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ApiRequestError(0, "network_error", `Couldn't reach ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`, null);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // A proxy or HTML error page: reported below with the status.
    }
    if (res.ok && json !== null) return json as T;
    // Two error shapes: { error: { code, message } } (API v1) and { ok: false, error, message } (site routes).
    const body = (json ?? {}) as { error?: unknown; message?: unknown };
    const nested = typeof body.error === "object" && body.error !== null ? (body.error as { code?: string; message?: string }) : null;
    const code = nested?.code ?? (typeof body.error === "string" ? body.error : `http_${res.status}`);
    let message = nested?.message ?? (typeof body.message === "string" ? body.message : `The server answered ${res.status} ${res.statusText}.`);
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after"));
      message = `${message}${Number.isFinite(wait) && wait > 0 ? ` (loudscene asks to wait ${Math.ceil(wait)} s before the next one.)` : ""}`;
    }
    if (res.ok) message = `The server answered ${res.status} without JSON.`;
    throw new ApiRequestError(res.status, code, message, res.headers.get("x-request-id"));
  }

  /** The home page's free film for a pasted contract address or token link: no AI, no account. */
  instantFilm(q: string) {
    return this.get<{ ok: true; film: InstantFilm }>(`/api/instant-film?q=${encodeURIComponent(q)}`);
  }
  /** The latest Robinhood Chain events on loudscene Score, newest first. */
  live() {
    return this.get<{ events: LiveEvent[] }>("/api/creators/live");
  }
  /** Torch tokens that used loudscene (a film, memes or a service), with their Score pages. */
  torchLaunches() {
    return this.get<TorchLaunches>("/api/torch/loud-launches");
  }
  /** Season 1 founder seats on loudscene Score. */
  seats() {
    return this.get<Seats>("/api/creators/seats");
  }
}
