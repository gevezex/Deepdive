import { describe, expect, it } from "vitest";
import { buildBlocks, type PdfItem } from "../src/pdfBlocks";

const line = (str: string, y: number, x = 72, height = 10, width = 400): PdfItem => ({ str, x, y, width, height });

describe("buildBlocks", () => {
  it("voegt regels samen tot alinea's en nummert vast", () => {
    const blocks = buildBlocks([{ page: 1, height: 800, items: [line("Eerste regel van", 700), line("de eerste alinea.", 688, 72, 10, 100), line("Tweede alinea begint", 650), line("en eindigt hier.", 638)] }]);
    expect(blocks.map((b) => b.text)).toEqual(["Eerste regel van de eerste alinea.", "Tweede alinea begint en eindigt hier."]);
    expect(blocks.map((b) => b.n)).toEqual([1, 2]);
    expect(blocks[0].page).toBe(1);
  });

  it("herstelt afgebroken woorden", () => {
    const blocks = buildBlocks([{ page: 1, height: 800, items: [line("een gesplitst woor-", 700), line("denboek staat hier", 688)] }]);
    expect(blocks[0].text).toBe("een gesplitst woordenboek staat hier");
  });

  it("zet stukken op dezelfde regel achter elkaar", () => {
    const blocks = buildBlocks([{ page: 1, height: 800, items: [line("Hallo", 700, 72, 10, 30), line("wereld", 700, 110, 10, 40)] }]);
    expect(blocks[0].text).toBe("Hallo wereld");
  });

  it("herkent een kop aan de lettergrootte", () => {
    const body = Array.from({ length: 6 }, (_, i) => line("Gewone tekst van een behoorlijke lengte hier", 600 - i * 12));
    const blocks = buildBlocks([{ page: 1, height: 800, items: [line("Grote kop", 700, 72, 20), ...body] }]);
    expect(blocks[0].kind).toBe("heading");
    expect(blocks[1].kind).toBe("paragraph");
  });

  it("laat terugkerende koptekst en paginanummers weg", () => {
    const page = (n: number) => ({ page: n, height: 800, items: [line("Tijdschrift voor Tests", 780), line(`Inhoud van pagina ${n}`, 400), line(String(n), 30)] });
    const blocks = buildBlocks([page(1), page(2), page(3), page(4)]);
    expect(blocks.map((b) => b.text)).toEqual(["Inhoud van pagina 1", "Inhoud van pagina 2", "Inhoud van pagina 3", "Inhoud van pagina 4"]);
  });

  it("geeft niets terug voor een scan zonder tekst", () => {
    expect(buildBlocks([{ page: 1, height: 800, items: [] }])).toEqual([]);
  });
});
