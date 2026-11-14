import { describe, expect, it } from "vitest";
import { mergeRects, paragraphsForRects, parseAnswer, parseInline, quoteText } from "../src/readingLogic";

describe("antwoordtekst", () => {
  it("maakt vet en klikbare verwijzingen", () => {
    expect(parseInline("**De kern.** Zie ¶12 en ¶3–5.")).toEqual([
      { text: "De kern.", bold: true },
      { text: " Zie ", bold: false },
      { text: "¶12", bold: false, ref: [12, 12] },
      { text: " en ", bold: false },
      { text: "¶3–5", bold: false, ref: [3, 5] },
      { text: ".", bold: false },
    ]);
  });

  it("toont een half binnengekomen vet stuk alvast vet, zonder sterretjes", () => {
    expect(parseInline("**Half")).toEqual([{ text: "Half", bold: true }]);
  });

  it("deelt in alinea's en lijstjes; koppen worden een vette regel", () => {
    const blocks = parseAnswer("## Kop\nEerste regel\nloopt door.\n\n- een\n- twee ¶4\nNa de lijst.");
    expect(blocks.map((b) => b.type)).toEqual(["p", "ul", "p"]);
    expect(blocks[0]).toEqual({ type: "p", inlines: [{ text: "Kop", bold: true }, { text: " Eerste regel loopt door.", bold: false }] });
    expect(blocks[1].type === "ul" && blocks[1].items[1][1].ref).toEqual([4, 4]);
  });

  it("laat HTML gewoon tekst", () => {
    const blocks = parseAnswer("<img src=x onerror=alert(1)>");
    expect(blocks).toEqual([{ type: "p", inlines: [{ text: "<img src=x onerror=alert(1)>", bold: false }] }]);
  });
});

describe("pdf", () => {
  it("voegt rechthoeken op één regel samen, maar niet over regels heen", () => {
    const merged = mergeRects([
      { page: 1, x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
      { page: 1, x: 0.205, y: 0.101, w: 0.1, h: 0.02 },
      { page: 1, x: 0.1, y: 0.13, w: 0.2, h: 0.02 },
      { page: 2, x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0].x).toBeCloseTo(0.1);
    expect(merged[0].w).toBeCloseTo(0.205);
  });

  it("vindt de alinea's onder een selectie", () => {
    const blocks = [
      { n: 1, rect: { page: 1, x: 0.1, y: 0.1, w: 0.8, h: 0.1 } },
      { n: 2, rect: { page: 1, x: 0.1, y: 0.25, w: 0.8, h: 0.1 } },
      { n: 3, rect: { page: 2, x: 0.1, y: 0.1, w: 0.8, h: 0.1 } },
    ];
    expect(paragraphsForRects([{ page: 1, x: 0.2, y: 0.15, w: 0.3, h: 0.15 }], blocks)).toEqual({ from: 1, to: 2 });
    expect(paragraphsForRects([{ page: 3, x: 0, y: 0, w: 1, h: 1 }], blocks)).toEqual({ from: null, to: null });
  });
});

it("citaat met titel en alinea", () => {
  expect(quoteText(" Iets moois ", "Het stuk", 4, 4)).toBe("“Iets moois” — Het stuk, ¶4");
  expect(quoteText("x", "T", null, null)).toBe("“x” — T");
});
