// Het deel van het providerscherm dat zonder scherm te testen is.
import { formatNumber, plural, t, type Key } from "./i18n";
import type { ApiKind, ConnectionReport, Model, ModelRef, Provider, ProvidersFile } from "./types";

export interface Preset {
  id: string;
  name: string;
  kind: ApiKind;
  baseUrl: string;
  /** Het label in de keuzelijst; zonder eigen tekst is het de naam. */
  labelKey?: Key;
  keyHintKey: Key;
}

export const PRESETS: Preset[] = [
  { id: "anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", keyHintKey: "providers.keyNeeded" },
  { id: "openai", name: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", keyHintKey: "providers.keyNeeded" },
  { id: "openrouter", name: "OpenRouter", kind: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", keyHintKey: "providers.keyNeeded" },
  { id: "ollama", name: "Ollama", kind: "openai_compatible", baseUrl: "http://localhost:11434/v1", labelKey: "providers.presetOllama", keyHintKey: "providers.keyLocal" },
  { id: "lmstudio", name: "LM Studio", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1", labelKey: "providers.presetLmStudio", keyHintKey: "providers.keyLocal" },
  { id: "custom", name: "", kind: "openai_compatible", baseUrl: "", labelKey: "providers.presetCustom", keyHintKey: "providers.keyCustom" },
];

export const presetLabel = (p: Preset) => (p.labelKey ? t(p.labelKey) : p.name);
export const presetKeyHint = (p: Preset) => t(p.keyHintKey);

export interface PickerGroup {
  label: string;
  options: { value: string; label: string }[];
}

export const refValue = (r: ModelRef) => JSON.stringify([r.providerId, r.modelId]);

export function parseRefValue(value: string): ModelRef | null {
  if (!value) return null;
  const [providerId, modelId] = JSON.parse(value) as [string, string];
  return { providerId, modelId };
}

export const modelLabel = (m: Model) => m.displayName || m.id;

/** De modelkiezer: per provider de modellen die aan staan. De actieve keuze blijft altijd zichtbaar. */
export function pickerGroups(file: ProvidersFile): PickerGroup[] {
  const active = file.selection.active;
  return file.providers
    .map((p) => ({
      label: p.name,
      options: p.models
        .filter((m) => (m.enabled && (p.kind !== "chatgpt_plan" || chatgptState(p) === "ready")) || (active?.providerId === p.id && active.modelId === m.id))
        .map((m) => ({ value: refValue({ providerId: p.id, modelId: m.id }), label: modelLabel(m) })),
    }))
    .filter((g) => g.options.length > 0);
}

export type ChatgptState = "ready" | "plan_disabled" | "session_lost" | "signed_out";

export function chatgptState(p: Provider): ChatgptState {
  if (!p.hasKey) return p.chatgpt?.sessionLost ? "session_lost" : "signed_out";
  return p.chatgpt?.planEnabled ? "ready" : "plan_disabled";
}

/** De regel in het providerscherm: met welk account je bent ingelogd en wat er eventueel moet gebeuren. */
export function chatgptStatus(p: Provider): string {
  const who = p.chatgpt?.email ?? t("providers.thisAccount");
  switch (chatgptState(p)) {
    case "ready":
      return t("providers.statusReady", { who });
    case "plan_disabled":
      return t("providers.statusPlanDisabled", { who });
    case "session_lost":
      return t("providers.statusSessionLost", { who });
    case "signed_out":
      return t("providers.statusSignedOut", { who });
  }
}

/** Of het gekozen model het ChatGPT-abonnement gebruikt, want dat moet zichtbaar zijn bij de modelkiezer. */
export function usesChatgptPlan(file: ProvidersFile): boolean {
  const active = file.selection.active;
  return !!active && file.providers.some((p) => p.id === active.providerId && p.kind === "chatgpt_plan");
}

/** Het model voor de verbindingstest: de actieve keuze, anders het eerste dat aan staat. */
export function testModel(provider: Provider, active: ModelRef | null): string | null {
  if (active?.providerId === provider.id && provider.models.some((m) => m.id === active.modelId)) return active.modelId;
  return provider.models.find((m) => m.enabled)?.id ?? provider.models[0]?.id ?? null;
}

/** Leeg is onbekend. Geeft `undefined` bij iets wat geen geldig aantal is. */
export function parseContext(text: string): number | null | undefined {
  const clean = text.replace(/[\s.,_]/g, "");
  if (!clean) return null;
  if (!/^\d+$/.test(clean)) return undefined;
  const n = Number(clean);
  return n > 0 && n <= 4_294_967_295 ? n : undefined;
}

export const imagesToValue = (v: boolean | null) => (v === null ? "" : v ? "yes" : "no");
export const valueToImages = (v: string) => (v === "" ? null : v === "yes");

export function filterModels(models: Model[], query: string): Model[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.displayName?.toLowerCase().includes(q));
}

export function describeReport(r: ConnectionReport): string {
  if (!r.model) return t("providers.reportNoModel");
  const ms = r.firstTokenMs;
  const time = ms === null ? null : ms < 1000 ? t("providers.ms", { n: formatNumber(ms) }) : t("providers.seconds", { n: formatNumber(ms / 1000, { maximumFractionDigits: 1 }) });
  const model = r.model;
  if (time === null) return r.sample ? t("providers.reportText", { model, sample: r.sample }) : t("providers.reportEmpty", { model });
  return r.sample ? t("providers.reportTimedText", { model, time, sample: r.sample }) : t("providers.reportTimedEmpty", { model, time });
}

export const modelCount = (n: number) => plural(n, "providers.modelCountOne", "providers.modelCountOther");

export function countSummary(models: Model[]): string {
  if (!models.length) return t("providers.noModelsYet");
  return t("providers.countSummary", { count: modelCount(models.length), enabled: formatNumber(models.filter((m) => m.enabled).length) });
}
