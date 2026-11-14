// The sidebar without the DOM: grouping by date, filtering and searching in titles and highlights.
import type { HighlightBrief, SourceSummary } from "./types";

export type Filter = "all" | "web" | "pdf" | "marked";
export type DateGroup = { kind: "today" } | { kind: "yesterday" } | { kind: "week" } | { kind: "month"; year: number; month: number };

/** "www.nrc.nl" → "nrc.nl". Null without a usable address. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Reading time in minutes, at about 230 words a minute. At least one. */
export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Today, yesterday, the last seven days, and after that per month. In local time. */
export function dateGroup(capturedAt: string, now: Date = new Date()): DateGroup {
  const date = new Date(capturedAt);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days <= 0) return { kind: "today" };
  if (days === 1) return { kind: "yesterday" };
  if (days < 7) return { kind: "week" };
  return { kind: "month", year: date.getFullYear(), month: date.getMonth() };
}

export function groupKey(g: DateGroup): string {
  return g.kind === "month" ? `${g.year}-${g.month}` : g.kind;
}

/** Lower case and without accents, so "cafe" finds "café" and "Ş" finds "ş". */
export function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

export interface HighlightHit {
  source: SourceSummary;
  highlight: HighlightBrief;
  /** Found in the note, not in the marked text. */
  inNote: boolean;
}

export interface SearchResult {
  sources: SourceSummary[];
  highlights: HighlightHit[];
}

function passes(source: SourceSummary, filter: Filter): boolean {
  if (filter === "web") return source.kind === "web" || source.kind === "text";
  if (filter === "pdf") return source.kind === "pdf";
  if (filter === "marked") return source.highlights.length > 0;
  return true;
}

/** Without a query: all sources that pass the filter. With one: matching sources, and matching highlights apart. */
export function search(list: SourceSummary[], query: string, filter: Filter): SearchResult {
  const passing = list.filter((s) => passes(s, filter));
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return { sources: passing, highlights: [] };
  const matches = (text: string | null) => {
    if (!text) return false;
    const folded = fold(text);
    return words.every((w) => folded.includes(w));
  };
  const sources = passing.filter((s) => matches([s.title, hostOf(s.url), s.siteName].filter(Boolean).join(" ")));
  const highlights: HighlightHit[] = [];
  for (const source of passing) {
    for (const highlight of source.highlights) {
      if (matches(highlight.text)) highlights.push({ source, highlight, inNote: false });
      else if (matches(highlight.note)) highlights.push({ source, highlight, inNote: true });
    }
  }
  return { sources, highlights };
}

/** A piece of `text` around the first word of the query, cut at about `radius` characters on each side. */
export function snippet(text: string, query: string, radius = 60): { before: string; hit: string; after: string } {
  const flat = text.replace(/\s+/g, " ").trim();
  const word = fold(query).split(/\s+/).find(Boolean);
  // Folding can change the length (ligatures), so only use the position when the lengths agree.
  const folded = fold(flat);
  const at = word && folded.length === flat.length ? folded.indexOf(word) : -1;
  if (at < 0) {
    const cut = flat.length > radius * 2 ? `${flat.slice(0, radius * 2).trimEnd()}…` : flat;
    return { before: cut, hit: "", after: "" };
  }
  const end = at + word!.length;
  const from = Math.max(0, at - radius);
  const to = Math.min(flat.length, end + radius);
  return {
    before: (from > 0 ? "…" : "") + flat.slice(from, at).trimStart(),
    hit: flat.slice(at, end),
    after: flat.slice(end, to).trimEnd() + (to < flat.length ? "…" : ""),
  };
}
