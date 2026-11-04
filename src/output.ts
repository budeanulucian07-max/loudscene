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
