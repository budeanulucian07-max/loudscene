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
  renderFormats(videoId: string, formats: string[], resolution?: number) {
    return this.request<{ renders: Render[] }>("POST", `/v1/videos/${encodeURIComponent(videoId)}/variants`, { formats, ...(resolution ? { resolution } : {}) });
  }
}
