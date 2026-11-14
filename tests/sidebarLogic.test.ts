import { describe, expect, it } from "vitest";
import { dateGroup, fold, hostOf, readingMinutes, search, snippet } from "../src/sidebarLogic";
import type { HighlightBrief, SourceSummary } from "../src/types";

const mark = (text: string, note: string | null = null): HighlightBrief => ({ id: text, color: "yellow", text, note, from: 3, to: 4 });
const source = (over: Partial<SourceSummary>): SourceSummary => ({
  id: "x",
  kind: "web",
  title: "Titel",
  url: null,
  capturedAt: "2026-11-14T09:00:00Z",
  wordCount: 1000,
  siteName: null,
  pageCount: null,
  highlights: [],
  ...over,
});

describe("zijbalk: kleine dingen", () => {
  it("haalt de site uit het adres", () => {
    expect(hostOf("https://www.nrc.nl/nieuws/1")).toBe("nrc.nl");
    expect(hostOf("geen adres")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });

  it("rekent leestijd in hele minuten, minstens één", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(2300)).toBe(10);
  });

  it("vouwt accenten weg", () => {
    expect(fold("Café ŞEHİR")).toBe(fold("cafe şehir"));
  });
});

describe("zijbalk: groepen op datum", () => {
  const now = new Date(2026, 10, 14, 15, 0);
  it("vandaag, gisteren, deze week en daarna per maand", () => {
    expect(dateGroup(new Date(2026, 10, 14, 1, 0).toISOString(), now)).toEqual({ kind: "today" });
    expect(dateGroup(new Date(2026, 10, 13, 23, 0).toISOString(), now)).toEqual({ kind: "yesterday" });
    expect(dateGroup(new Date(2026, 10, 9, 12, 0).toISOString(), now)).toEqual({ kind: "week" });
    expect(dateGroup(new Date(2026, 9, 2, 12, 0).toISOString(), now)).toEqual({ kind: "month", year: 2026, month: 9 });
  });
});

describe("zijbalk: zoeken", () => {
  const list = [
    source({ id: "a", title: "Why we sleep less", url: "https://aeon.co/x", highlights: [mark("Average sleep barely moved")] }),
    source({ id: "b", kind: "pdf", title: "Attention is all you need", pageCount: 15 }),
    source({ id: "c", title: "Koffie", url: "https://www.nrc.nl/k", highlights: [mark("Iets anders", "over slaap en koffie")] }),
  ];

  it("zonder zoekterm: alles wat door het filter komt", () => {
    expect(search(list, "", "all").sources.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(search(list, "", "pdf").sources.map((s) => s.id)).toEqual(["b"]);
    expect(search(list, "", "marked").sources.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("vindt titels en sites, en markeringen apart, ook in notities", () => {
    const r = search(list, "sleep", "all");
    expect(r.sources.map((s) => s.id)).toEqual(["a"]);
    expect(r.highlights.map((h) => [h.source.id, h.inNote])).toEqual([["a", false]]);
    expect(search(list, "nrc", "all").sources.map((s) => s.id)).toEqual(["c"]);
    expect(search(list, "slaap", "all").highlights.map((h) => [h.source.id, h.inNote])).toEqual([["c", true]]);
  });

  it("alle woorden moeten voorkomen", () => {
    expect(search(list, "why less", "all").sources).toHaveLength(1);
    expect(search(list, "why koffie", "all").sources).toHaveLength(0);
  });
});

describe("zijbalk: stukje rond de treffer", () => {
  it("knipt rond het eerste woord", () => {
    const text = `${"a ".repeat(50)}de slaap ${"b ".repeat(50)}`;
    const part = snippet(text, "slaap", 10);
    expect(part.hit).toBe("slaap");
    expect(part.before.startsWith("…")).toBe(true);
    expect(part.after.endsWith("…")).toBe(true);
  });

  it("zonder treffer: het begin", () => {
    expect(snippet("kort", "zzz")).toEqual({ before: "kort", hit: "", after: "" });
  });
});
