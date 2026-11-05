// Het deel van de blauwdruk dat zonder scherm te testen is.
import { chatgptState, modelLabel } from "./providerLogic";
import type { AppError, Blueprint, Category, CheckResult, Critique, DiagramBlock, ModelRef, ParagraphRange, Point, ProvidersFile, Relation } from "./types";

export const ROLE_LABELS: Record<string, string> = {
  occasion: "Aanleiding", thesis: "Stelling", concept: "Begrip", explanation: "Uitleg", argument: "Argument", evidence: "Bewijs", example: "Voorbeeld",
  objection: "Bezwaar", rebuttal: "Weerlegging", conclusion: "Conclusie", question: "Vraag", method: "Methode", results: "Resultaten",
  interpretation: "Interpretatie", limitation: "Beperking", event: "Gebeurtenis", background: "Achtergrond", reaction: "Reactie",
  reflection: "Bespiegeling", lesson: "Les", instruction: "Instructie", assessment: "Beoordeling", other: "Stap",
};

export const RELATION_LABELS: Record<string, string> = {
  builds_on: "bouwt voort", evidence_for: "bewijs", example_of: "voorbeeld", answers: "antwoord", contrasts: "contrast", follows_in_time: "daarna", concludes: "conclusie",
};

export const CATEGORY_LABELS: Record<Category, string> = {
  assumption: "Aanname", leap: "Sprong", gap: "Logisch gat", evidence: "Bewijs", missing: "Wat ontbreekt", headline_vs_content: "Kop tegenover inhoud",
};

export const GOAL_LABELS: Record<string, string> = {
  explain_problem: "Een probleem uitleggen", offer_solution: "Een oplossing bieden", vent_frustration: "Een frustratie uiten", personal_experience: "Een ervaring vertellen",
  develop_concept: "Een idee uitwerken", persuade: "De lezer overtuigen", report_research: "Onderzoek rapporteren", report_event: "Een gebeurtenis verslaan",
  refute: "Weerleggen", evaluate: "Beoordelen", instruct: "Instructies geven", other: "Anders",
};

export const TEXT_KIND_LABELS: Record<string, string> = {
  news: "Nieuws", opinion: "Opinie", research: "Onderzoek", memoir: "Memoire", essay: "Essay", explainer: "Uitleg", review: "Recensie", reference: "Naslag", other: "Tekst",
};

export const RESULT_LABELS: Record<CheckResult, string> = { found: "gevonden", nothing_found: "niets gevonden", not_applicable: "niet van toepassing" };

export const CERTAINTY_LABELS = { high: "Zekerheid: hoog", medium: "Zekerheid: gemiddeld", low: "Zekerheid: laag, een vermoeden" } as const;

/** Volgorde waarin de onderdelen van de kritiek op het scherm staan. */
const CATEGORY_ORDER: Category[] = ["assumption", "leap", "gap", "evidence", "missing", "headline_vs_content"];

/** Hoogstens zoveel banen naast het diagram: daarna delen pijlen een baan, anders blijft er voor de blokken niets over. */
export const MAX_LANES = 4;

export function formatRanges(ranges: ParagraphRange[]): string {
  if (!ranges.length) return "";
  return `¶${ranges.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ")}`;
}

export function highlightParam(ranges: ParagraphRange[]): string {
  return ranges.map(([a, b]) => `${a}-${b}`).join(",");
}

/** Waar een punt heen springt. Een te brede verwijzing licht niet tientallen alinea's op, maar gaat naar de eerste. */
export function pointTarget(point: Point): ParagraphRange[] {
  if (!point.broad || !point.paragraphs.length) return point.paragraphs;
  const first = point.paragraphs[0][0];
  return [[first, first]];
}

export interface Lane {
  relation: Relation;
  from: number;
  to: number;
  lane: number;
}

/**
 * Verdeelt de pijlen over banen naast de kolom met blokken. Korte pijlen zitten het dichtst bij de blokken; pijlen die
 * elkaar overlappen krijgen een eigen baan. Pijlen die elkaar alleen in een blok raken mogen dezelfde baan delen.
 */
export function assignLanes(blocks: DiagramBlock[], relations: Relation[]): Lane[] {
  const index = new Map(blocks.map((b, i) => [b.id, i]));
  const lanes: Lane[] = [];
  for (const relation of relations) {
    const from = index.get(relation.dependsOn);
    const to = index.get(relation.block);
    if (from !== undefined && to !== undefined) lanes.push({ relation, from, to, lane: 0 });
  }
  const span = (l: Lane) => [Math.min(l.from, l.to), Math.max(l.from, l.to)] as const;
  const order = [...lanes].sort((a, b) => span(a)[1] - span(a)[0] - (span(b)[1] - span(b)[0]) || span(a)[0] - span(b)[0]);
  const taken: (readonly [number, number])[][] = [];
  for (const lane of order) {
    const [lo, hi] = span(lane);
    let n = taken.findIndex((spans) => !spans.some(([a, b]) => lo < b && a < hi));
    if (n < 0 || n >= MAX_LANES) n = taken.length < MAX_LANES ? taken.length : MAX_LANES - 1;
    (taken[n] ??= []).push([lo, hi]);
    lane.lane = n;
  }
  return lanes;
}

/** Aan welk blok of welke pijl elk punt hangt. Wat nergens aan hangt, staat los onder het diagram. */
export function pointsByAnchor(critique: Critique | null | undefined, anchors: string[]): { attached: Map<string, Point[]>; loose: Point[] } {
  const known = new Set(anchors);
  const attached = new Map<string, Point[]>();
  const loose: Point[] = [];
  for (const point of critique?.points ?? []) {
    if (point.anchor && known.has(point.anchor)) attached.set(point.anchor, [...(attached.get(point.anchor) ?? []), point]);
    else loose.push(point);
  }
  return { attached, loose };
}

export interface Outcome {
  category: Category;
  label: string;
  result: CheckResult;
  text: string;
  note: string | null;
}

/** Per onderdeel wat de kritische blik opleverde. Een onderdeel dat het model oversloeg zeggen we ook zo. */
export function outcomes(critique: Critique): Outcome[] {
  return CATEGORY_ORDER.map((category) => {
    const check = critique.checked.find((c) => c.category === category);
    const count = critique.points.filter((p) => p.category === category).length;
    const result: CheckResult = count ? "found" : (check?.result ?? "nothing_found");
    const known = check !== undefined || count > 0;
    const text = result === "found" ? (count === 1 ? "1 punt" : `${count} punten`) : known ? RESULT_LABELS[result] : "niet beoordeeld";
    return { category, label: CATEGORY_LABELS[category], result, text, note: check?.note ?? null };
  });
}

/** Welke bewaarde blauwdruk bij openen op het scherm komt: die van het gekozen model, anders de nieuwste. */
export function pickSaved(all: Blueprint[], active: ModelRef | null): Blueprint | null {
  if (!all.length) return null;
  const newest = (list: Blueprint[]) =>
    [...list].sort((a, b) => b.promptVersion - a.promptVersion || (a.createdAt < b.createdAt ? 1 : -1))[0];
  const own = active ? all.filter((b) => b.providerId === active.providerId && b.model === active.modelId) : [];
  return newest(own.length ? own : all);
}

export function sameModel(b: Blueprint, ref: ModelRef | null): boolean {
  return !!ref && b.providerId === ref.providerId && b.model === ref.modelId;
}

/** De naam waaronder de lezer een model kent. Een verwijderde provider laat in elk geval het model-id staan. */
export function modelName(file: ProvidersFile, providerId: string, modelId: string): string {
  const model = file.providers.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
  return model ? modelLabel(model) : modelId;
}

const LOCAL_ADDRESS = /^https?:\/\/(localhost|127\.|\[::1\]|[^/]*\.localhost)/i;

/** Draait dit model op deze computer? Dan noemt de app vooraf dat het lang kan duren. */
export function isLocalModel(file: ProvidersFile, ref: ModelRef | null): boolean {
  const provider = ref && file.providers.find((p) => p.id === ref.providerId);
  return !!provider && provider.kind !== "chatgpt_plan" && LOCAL_ADDRESS.test(provider.baseUrl);
}

/**
 * ChatGPT voorstellen als er nog geen keuze is en die koppeling werkt. Dit is alleen een voorstel: het model wordt pas
 * gekozen als de lezer erop klikt.
 */
export function suggestModel(file: ProvidersFile): { ref: ModelRef; label: string } | null {
  if (file.selection.active) return null;
  for (const provider of file.providers) {
    if (provider.kind !== "chatgpt_plan" || chatgptState(provider) !== "ready") continue;
    const model = provider.models.find((m) => m.enabled);
    if (model) return { ref: { providerId: provider.id, modelId: model.id }, label: modelLabel(model) };
  }
  return null;
}

export type ErrorAction = "providers" | "usage" | "picker" | "retry";

export interface ErrorView {
  title: string;
  text: string;
  actions: ErrorAction[];
}

/** Elke situatie die de lezer zelf kan oplossen krijgt een eigen melding en een eigen knop. */
export function errorView(e: AppError): ErrorView {
  switch (e.kind) {
    case "no_model":
      return { title: "Kies eerst een model.", text: "Kies bovenaan dit paneel welk model de blauwdruk maakt. Staat er nog niets in de lijst, voeg dan een provider toe.", actions: ["picker", "providers"] };
    case "context_too_large":
      return { title: "Deze tekst is te lang voor dit model.", text: e.message, actions: ["picker"] };
    case "chatgpt_session_revoked":
    case "chatgpt_signed_out":
      return { title: "Je ChatGPT-login is verlopen.", text: "Log opnieuw in via Providers. Je bewaarde blauwdrukken blijven gewoon staan.", actions: ["providers"] };
    case "chatgpt_plan_disabled":
      return { title: "Deepdive mag je ChatGPT-abonnement nu niet gebruiken.", text: e.message, actions: ["providers", "picker"] };
    case "chatgpt_usage_limit":
    case "chatgpt_usage_unavailable":
      return { title: "Je ChatGPT-limiet is bereikt.", text: e.message, actions: ["usage", "picker"] };
    case "auth":
    case "key_missing":
      return { title: "De sleutel van deze provider werkt niet.", text: e.message, actions: ["providers"] };
    case "keychain":
      return { title: "De sleutelhanger gaf geen toegang.", text: e.message, actions: ["retry"] };
    case "unreachable_local":
      return { title: "De lokale server reageert niet.", text: e.message, actions: ["retry", "picker"] };
    case "no_text":
      return { title: "Deze bron heeft nog geen tekst.", text: "Wacht tot de pdf is gelezen en probeer het opnieuw. Een pdf zonder tekstlaag, zoals een scan, kan nog niet.", actions: ["retry"] };
    case "blueprint_schema":
      return { title: "Het model gaf geen bruikbare blauwdruk terug.", text: "Dat kan bij een volgende poging goed gaan. Lukt het vaker niet, kies dan een ander model.", actions: ["retry", "picker"] };
    case "blueprint_busy":
      return { title: "Dit stuk is al bezig.", text: e.message, actions: [] };
    default:
      return { title: "De blauwdruk is niet gelukt.", text: e.message, actions: ["retry", "picker"] };
  }
}
