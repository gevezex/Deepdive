import { describe, expect, it } from "vitest";
import { assignLanes, errorView, formatRanges, highlightParam, isLocalModel, MAX_LANES, modelName, outcomes, pickSaved, pointsByAnchor, pointTarget, readableIds, suggestModel } from "../src/blueprintLogic";
import type { Blueprint, Critique, DiagramBlock, Point, Provider, ProvidersFile, Relation } from "../src/types";

const block = (id: string): DiagramBlock => ({ id, role: "argument", title: id, content: "", paragraphs: [], quote: null });
const rel = (id: string, dependsOn: string, target: string): Relation => ({ id, block: target, dependsOn, kind: "builds_on", explanation: "" });
const point = (over: Partial<Point>): Point => ({ id: "k1", category: "leap", polarity: "minus", origin: "inferred", certainty: "medium", anchor: "r1", claim: "", explanation: "", paragraphs: [[3, 4]], quotes: [], evidenceKind: null, broad: false, ...over });
const critique = (over: Partial<Critique>): Critique => ({ points: [], terms: [], checked: [], overall: "", ...over });
const blueprint = (over: Partial<Blueprint>) => ({ providerId: "p", model: "m", promptVersion: 2, createdAt: "2026-01-01", critique: null, ...over }) as Blueprint;

describe("verwijzingen", () => {
  it("schrijft bereiken zoals de lezer ze kent", () => {
    expect(formatRanges([[1, 2], [5, 5]])).toBe("¶1–2, 5");
    expect(formatRanges([])).toBe("");
    expect(highlightParam([[1, 2], [5, 5]])).toBe("1-2,5-5");
  });

  it("een breed punt springt naar de eerste alinea en licht niet alles op", () => {
    expect(pointTarget(point({ paragraphs: [[2, 40], [50, 60]], broad: true }))).toEqual([[2, 2]]);
    expect(pointTarget(point({ paragraphs: [[2, 4]] }))).toEqual([[2, 4]]);
    expect(pointTarget(point({ paragraphs: [], broad: true }))).toEqual([]);
  });
});

describe("tekst van het model", () => {
  it("vervangt interne ids door het nummer dat de lezer ziet", () => {
    const numbers = new Map([["b3", 2], ["b4", 3]]);
    expect(readableIds("Het in b3 gemaakte getal en de tegenspraak in b4.", numbers)).toBe("Het in stap 2 gemaakte getal en de tegenspraak in stap 3.");
    expect(readableIds("Vitamine b12 en b9 blijven staan.", numbers)).toBe("Vitamine b12 en b9 blijven staan.");
  });
});

describe("pijlen", () => {
  const blocks = ["a", "b", "c", "d", "e", "f", "g", "h"].map(block);

  it("opeenvolgende stappen delen een baan", () => {
    const lanes = assignLanes(blocks, [rel("r1", "a", "b"), rel("r2", "b", "c"), rel("r3", "c", "d")]);
    expect(lanes.map((l) => l.lane)).toEqual([0, 0, 0]);
  });

  it("overlappende pijlen krijgen een eigen baan en de kortste zit het dichtst bij de blokken", () => {
    const lanes = assignLanes(blocks, [rel("lang", "a", "d"), rel("kort", "b", "c")]);
    expect(lanes.find((l) => l.relation.id === "kort")?.lane).toBe(0);
    expect(lanes.find((l) => l.relation.id === "lang")?.lane).toBe(1);
  });

  it("twee pijlen uit hetzelfde blok naar verschillende stappen delen geen baan als ze overlappen", () => {
    const lanes = assignLanes(blocks, [rel("r1", "a", "c"), rel("r2", "a", "b")]);
    expect(new Set(lanes.map((l) => l.lane)).size).toBe(2);
  });

  it("een pijl terug in de tekst werkt ook", () => {
    const [lane] = assignLanes(blocks, [rel("r1", "d", "a")]);
    expect([lane.from, lane.to, lane.lane]).toEqual([3, 0, 0]);
  });

  it("een smal paneel krijgt nooit meer banen dan het maximum", () => {
    const relations = [0, 1, 2, 3, 4, 5].map((i) => rel(`r${i}`, "a", ["c", "d", "e", "f", "g", "h"][i]));
    const lanes = assignLanes(blocks, relations);
    expect(Math.max(...lanes.map((l) => l.lane))).toBe(MAX_LANES - 1);
    expect(lanes).toHaveLength(6);
  });

  it("een pijl naar een blok dat nog niet binnen is, wordt niet getekend", () => {
    expect(assignLanes(blocks, [rel("r1", "a", "onbekend")])).toEqual([]);
  });
});

describe("kritische laag", () => {
  it("hangt punten aan hun blok of pijl en de rest los", () => {
    const { attached, loose } = pointsByAnchor(critique({ points: [point({ id: "1", anchor: "b1" }), point({ id: "2", anchor: "b1" }), point({ id: "3", anchor: "r1" }), point({ id: "4", anchor: null }), point({ id: "5", anchor: "weg" })] }), ["b1", "r1"]);
    expect(attached.get("b1")?.map((p) => p.id)).toEqual(["1", "2"]);
    expect(attached.get("r1")?.map((p) => p.id)).toEqual(["3"]);
    expect(loose.map((p) => p.id)).toEqual(["4", "5"]);
  });

  it("niets gevonden en niet van toepassing zijn gewone uitkomsten", () => {
    const list = outcomes(critique({
      points: [point({ category: "leap" }), point({ id: "2", category: "leap" }), point({ id: "3", category: "gap" })],
      checked: [{ category: "evidence", result: "not_applicable", note: "Een memoire hoeft niets te bewijzen." }, { category: "assumption", result: "nothing_found", note: null }],
    }));
    const by = Object.fromEntries(list.map((o) => [o.category, o]));
    expect(by.leap.text).toBe("2 punten");
    expect(by.gap.text).toBe("1 punt");
    expect(by.evidence.text).toBe("niet van toepassing");
    expect(by.evidence.note).toContain("memoire");
    expect(by.assumption.text).toBe("niets gevonden");
    expect(by.missing.text).toBe("niet beoordeeld");
    expect(list).toHaveLength(6);
  });
});

describe("bewaarde blauwdrukken", () => {
  const a = blueprint({ model: "a", createdAt: "2026-01-01" });
  const b = blueprint({ model: "b", createdAt: "2026-02-01" });

  it("toont die van het gekozen model, ook als een andere nieuwer is", () => {
    expect(pickSaved([a, b], { providerId: "p", modelId: "a" })).toBe(a);
  });

  it("zonder eigen blauwdruk de nieuwste, zodat er geen nieuwe aanroep nodig is", () => {
    expect(pickSaved([a, b], { providerId: "p", modelId: "c" })).toBe(b);
    expect(pickSaved([a, b], null)).toBe(b);
    expect(pickSaved([], null)).toBeNull();
  });

  it("een nieuwere promptversie gaat voor", () => {
    const older = blueprint({ model: "a", promptVersion: 1, createdAt: "2026-03-01" });
    expect(pickSaved([older, a], { providerId: "p", modelId: "a" })).toBe(a);
  });
});

describe("modelkeuze", () => {
  const model = (id: string, enabled = true) => ({ id, displayName: null, supportsImages: null, contextTokens: null, enabled, manual: false, userEdited: false });
  const chatgpt = (over: Partial<Provider> = {}): Provider => ({ id: "c", name: "ChatGPT", kind: "chatgpt_plan", baseUrl: "https://api.openai.com/v1", hasKey: true, models: [model("uit", false), model("gpt")], chatgpt: { clientId: "x", subject: "s", email: null, planEnabled: true, sessionLost: false }, ...over });
  const local: Provider = { id: "l", name: "Lokaal", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1", hasKey: false, models: [model("glm")] };
  const file = (providers: Provider[], active: ProvidersFile["selection"]["active"] = null): ProvidersFile => ({ schemaVersion: 1, providers, selection: { active, perAction: {} } });

  it("stelt ChatGPT alleen voor zolang er niets is gekozen", () => {
    expect(suggestModel(file([local, chatgpt()]))?.ref).toEqual({ providerId: "c", modelId: "gpt" });
    expect(suggestModel(file([local, chatgpt()], { providerId: "l", modelId: "glm" }))).toBeNull();
  });

  it("stelt niets voor als ChatGPT niet werkt of niet gekoppeld is", () => {
    expect(suggestModel(file([local]))).toBeNull();
    expect(suggestModel(file([chatgpt({ hasKey: false })]))).toBeNull();
  });

  it("herkent een model op deze computer", () => {
    expect(isLocalModel(file([local]), { providerId: "l", modelId: "glm" })).toBe(true);
    expect(isLocalModel(file([chatgpt()]), { providerId: "c", modelId: "gpt" })).toBe(false);
    expect(isLocalModel(file([{ ...local, baseUrl: "https://openrouter.ai/api/v1" }]), { providerId: "l", modelId: "glm" })).toBe(false);
    expect(isLocalModel(file([local]), null)).toBe(false);
  });

  it("noemt ook een verdwenen model bij naam", () => {
    expect(modelName(file([]), "weg", "oud-model")).toBe("oud-model");
  });
});

describe("meldingen", () => {
  const view = (kind: string) => errorView({ kind, message: "tekst van de bron", detail: null });

  it("elke situatie die de lezer kan oplossen heeft een eigen titel en knop", () => {
    expect(view("no_model").actions).toContain("providers");
    expect(view("context_too_large").title).toContain("te lang");
    expect(view("context_too_large").actions).toEqual(["picker"]);
    expect(view("chatgpt_session_revoked").title).toContain("verlopen");
    expect(view("chatgpt_session_revoked").actions).toEqual(["providers"]);
    expect(view("chatgpt_usage_limit").actions).toContain("usage");
    const titles = ["no_model", "context_too_large", "chatgpt_session_revoked", "chatgpt_usage_limit", "unreachable_local", "blueprint_schema"].map((k) => view(k).title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("onbekende fouten laten de eigen tekst zien en bieden opnieuw proberen", () => {
    const other = view("server");
    expect(other.text).toBe("tekst van de bron");
    expect(other.actions).toContain("retry");
  });
});
