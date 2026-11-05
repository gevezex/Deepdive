import { describe, expect, it } from "vitest";
import { countSummary, describeReport, filterModels, imagesToValue, parseContext, parseRefValue, pickerGroups, PRESETS, refValue, testModel, valueToImages } from "../src/providerLogic";
import type { Model, Provider, ProvidersFile } from "../src/types";

const model = (id: string, enabled = true): Model => ({ id, displayName: null, supportsImages: null, contextTokens: null, enabled, manual: false, userEdited: false });
const provider = (id: string, models: Model[]): Provider => ({ id, name: id.toUpperCase(), kind: "openai_compatible", baseUrl: "http://localhost:1/v1", hasKey: false, models });
const file = (providers: Provider[], active: ProvidersFile["selection"]["active"] = null): ProvidersFile => ({ schemaVersion: 1, providers, selection: { active, perAction: {} } });

describe("voorinstellingen", () => {
  it("hebben de standaardadressen van de lokale servers", () => {
    const by = (id: string) => PRESETS.find((p) => p.id === id)!;
    expect(by("ollama").baseUrl).toBe("http://localhost:11434/v1");
    expect(by("lmstudio").baseUrl).toBe("http://localhost:1234/v1");
    expect(by("ollama").kind).toBe("openai_compatible");
    expect(by("anthropic").kind).toBe("anthropic");
  });
});

describe("modelkiezer", () => {
  it("groepeert per provider en laat uitgezette modellen en lege providers weg", () => {
    const groups = pickerGroups(file([provider("a", [model("m1"), model("m2", false)]), provider("b", [model("m3", false)])]));
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("A");
    expect(groups[0].options.map((o) => o.label)).toEqual(["m1"]);
  });

  it("houdt de actieve keuze zichtbaar, ook als die is uitgezet", () => {
    const groups = pickerGroups(file([provider("a", [model("m2", false)])], { providerId: "a", modelId: "m2" }));
    expect(groups[0].options[0].value).toBe(refValue({ providerId: "a", modelId: "m2" }));
  });

  it("zet een keuze om en terug, ook met vreemde tekens in de naam", () => {
    const ref = { providerId: "a", modelId: 'org/model:"x",1' };
    expect(parseRefValue(refValue(ref))).toEqual(ref);
    expect(parseRefValue("")).toBeNull();
  });
});

describe("testmodel", () => {
  const p = provider("a", [model("uit", false), model("aan")]);
  it("kiest de actieve keuze, anders het eerste dat aan staat", () => {
    expect(testModel(p, { providerId: "a", modelId: "uit" })).toBe("uit");
    expect(testModel(p, { providerId: "b", modelId: "uit" })).toBe("aan");
    expect(testModel(p, null)).toBe("aan");
  });
  it("kan zonder modellen", () => {
    expect(testModel(provider("a", []), null)).toBeNull();
  });
});

describe("invoer", () => {
  it("leest een contextgrootte", () => {
    expect(parseContext("")).toBeNull();
    expect(parseContext("200000")).toBe(200000);
    expect(parseContext("200.000")).toBe(200000);
    expect(parseContext("veel")).toBeUndefined();
    expect(parseContext("0")).toBeUndefined();
    expect(parseContext("99999999999")).toBeUndefined();
  });
  it("zet de drie standen voor afbeeldingen om", () => {
    for (const v of [true, false, null]) expect(valueToImages(imagesToValue(v))).toBe(v);
  });
  it("filtert op naam", () => {
    const list = [model("gpt-5"), { ...model("x"), displayName: "Mooi Model" }];
    expect(filterModels(list, "GPT")).toHaveLength(1);
    expect(filterModels(list, "mooi")).toHaveLength(1);
    expect(filterModels(list, " ")).toHaveLength(2);
  });
});

describe("uitslag", () => {
  it("is begrijpelijk", () => {
    expect(describeReport({ model: "m", sample: "werkt", firstTokenMs: 1200 })).toBe("Verbinding werkt. m antwoordde in 1,2 s: “werkt”");
    expect(describeReport({ model: "m", sample: "", firstTokenMs: 40 })).toBe("Verbinding werkt. m antwoordde in 40 ms, zonder tekst");
    expect(countSummary([model("a"), model("b", false)])).toBe("2 modellen, 1 in de kiezer");
    expect(countSummary([model("a")])).toBe("1 model, 1 in de kiezer");
    expect(describeReport({ model: null, sample: "", firstTokenMs: null })).toContain("nog geen model");
  });
});
