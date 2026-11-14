// Het deel van de blauwdruk dat zonder scherm te testen is.
import { chatgptState, modelLabel } from "./providerLogic";
import { lang, plural, t, type Key } from "./i18n";
import type { AppError, Blueprint, Category, CheckResult, Critique, DiagramBlock, ModelRef, ParagraphRange, Point, ProvidersFile, Relation } from "./types";

/** Labels for the fixed values the model returns. Unknown values are shown as they are. */
function label(prefix: string, value: string): string | null {
  const key = `${prefix}.${value}` as Key;
  const text = t(key);
  return text === key ? null : text;
}
export const roleLabel = (role: string) => label("bp.role", role) ?? role;
export const relationLabel = (kind: string) => label("bp.rel", kind) ?? kind;
export const categoryLabel = (category: string) => label("bp.cat", category) ?? category;
export const goalLabel = (kind: string) => label("bp.goal", kind);
export const textKindLabel = (kind: string) => label("bp.kind", kind) ?? kind;
export const certaintyLabel = (certainty: "high" | "medium" | "low") => t(`bp.certainty.${certainty}`);

/** Volgorde waarin de onderdelen van de kritiek op het scherm staan. */
const CATEGORY_ORDER: Category[] = ["assumption", "leap", "gap", "evidence", "missing", "headline_vs_content"];

/** Hoogstens zoveel banen naast het diagram: daarna delen pijlen een baan, anders blijft er voor de blokken niets over. */
export const MAX_LANES = 4;

/** Modellen schrijven soms de interne ids in hun tekst ("het in b3 gemaakte getal"). De lezer kent alleen de nummers. */
export function readableIds(text: string, numbers: Map<string, number>): string {
  return text.replace(/\bb\d+\b/g, (id) => (numbers.has(id) ? t("bp.step", { n: numbers.get(id)! }) : id));
}

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
    const text = result === "found" ? plural(count, "bp.points.one", "bp.points.other") : known ? t(`bp.result.${result}`) : t("bp.result.notAssessed");
    return { category, label: categoryLabel(category), result, text, note: check?.note ?? null };
  });
}

/** The language a blueprint was written in. Blueprints from before languages existed said "Nederlands". */
export function blueprintLanguage(b: Pick<Blueprint, "language">): string {
  const value = (b.language ?? "").toLowerCase();
  if (value === "nederlands" || value === "dutch") return "nl";
  if (value === "engels" || value === "english") return "en";
  if (value === "turks" || value === "turkish") return "tr";
  return value;
}

/** The language the model writes in for this source: its own choice, otherwise the interface language. */
export function sourceLanguage(source: { aiLanguage?: string | null } | null | undefined): string {
  return source?.aiLanguage || lang();
}

/**
 * Welke bewaarde blauwdruk bij openen op het scherm komt: in de taal van de bron, die van het gekozen model, anders
 * de nieuwste. Zonder `language` telt elke taal.
 */
export function pickSaved(all: Blueprint[], active: ModelRef | null, language?: string): Blueprint | null {
  if (language) all = all.filter((b) => blueprintLanguage(b) === language);
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
      return { title: t("bp.err.noModelTitle"), text: t("bp.err.noModelText"), actions: ["picker", "providers"] };
    case "context_too_large":
      return { title: t("bp.err.tooLongTitle"), text: e.message, actions: ["picker"] };
    case "chatgpt_session_revoked":
    case "chatgpt_signed_out":
      return { title: t("bp.err.chatgptExpiredTitle"), text: t("bp.err.chatgptExpiredText"), actions: ["providers"] };
    case "chatgpt_plan_disabled":
      return { title: t("bp.err.planDisabledTitle"), text: e.message, actions: ["providers", "picker"] };
    case "chatgpt_usage_limit":
    case "chatgpt_usage_unavailable":
      return { title: t("bp.err.usageLimitTitle"), text: e.message, actions: ["usage", "picker"] };
    case "auth":
    case "key_missing":
      return { title: t("bp.err.authTitle"), text: e.message, actions: ["providers"] };
    case "keychain":
      return { title: t("bp.err.keychainTitle"), text: e.message, actions: ["retry"] };
    case "unreachable_local":
      return { title: t("bp.err.localTitle"), text: e.message, actions: ["retry", "picker"] };
    case "no_text":
      return { title: t("bp.err.noTextTitle"), text: t("bp.err.noTextText"), actions: ["retry"] };
    case "blueprint_schema":
      return { title: t("bp.err.schemaTitle"), text: t("bp.err.schemaText"), actions: ["retry", "picker"] };
    case "blueprint_busy":
      return { title: t("bp.err.busyTitle"), text: e.message, actions: [] };
    default:
      return { title: t("bp.err.failedTitle"), text: e.message, actions: ["retry", "picker"] };
  }
}
