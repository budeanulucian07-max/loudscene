/** Plain-text output helpers: aligned tables and progress wording, no colours (they break pipes). */

export function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd();
  return all.map(line).join("\n");
}

export const pct = (p: number) => `${Math.round((Number(p) || 0) * 100)}%`;

/** "9:16" → "9x16", for file names. */
export const formatSlug = (f: string) => f.replace(":", "x");

/** Dollars the way the site shows them: $97, $19.0K, $36.45M, $1.20B. */
export function usd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${a >= 1 || a === 0 ? Math.round(n) : n.toPrecision(2)}`;
}

/** "2026-11-25T12:03:42.000Z" → "2026-11-25 12:03" (UTC); the input itself when it isn't a date. */
export function utc(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ");
}
