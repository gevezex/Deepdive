import { describe, expect, it } from "vitest";
import answers from "../src/i18n/answers";
import app from "../src/i18n/app";
import blueprint from "../src/i18n/blueprint";
import common from "../src/i18n/common";
import providers from "../src/i18n/providers";
import reading from "../src/i18n/reading";
import { lang, plural, t } from "../src/i18n";

const AREAS = { answers, app, blueprint, common, providers, reading };

describe("talen", () => {
  it("elke tekst bestaat in alle drie de talen, niet leeg, met dezelfde {plekken}", () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const [name, area] of Object.entries(AREAS)) {
      for (const [key, en] of Object.entries(area.en as Record<string, string>)) {
        for (const code of ["nl", "tr"] as const) {
          const other = (area[code] as Record<string, string>)[key];
          expect(other, `${name} ${code} ${key}`).toBeTruthy();
          expect(holes(other), `${name} ${code} ${key}`).toBe(holes(en));
        }
      }
    }
  });

  it("begint in het Engels en vult plekken in", () => {
    expect(lang()).toBe("en");
    expect(t("app.loginTitle", { site: "nos.nl" })).toBe("Log in to nos.nl in the window that just opened.");
    expect(plural(1, "app.words.one", "app.words.other")).toBe("1 word");
    expect(plural(1200, "app.words.one", "app.words.other")).toBe("1,200 words");
  });
});
