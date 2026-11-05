// Het deel van het providerscherm dat zonder scherm te testen is.
import type { ApiKind, ConnectionReport, Model, ModelRef, Provider, ProvidersFile } from "./types";

export interface Preset {
  id: string;
  label: string;
  name: string;
  kind: ApiKind;
  baseUrl: string;
  keyHint: string;
}

const KEY_NEEDED = "Nodig voor deze dienst.";
const KEY_LOCAL = "Niet nodig, tenzij je de server zelf hebt beveiligd.";

export const PRESETS: Preset[] = [
  { id: "anthropic", label: "Anthropic", name: "Anthropic", kind: "anthropic", baseUrl: "https://api.anthropic.com", keyHint: KEY_NEEDED },
  { id: "openai", label: "OpenAI", name: "OpenAI", kind: "openai_compatible", baseUrl: "https://api.openai.com/v1", keyHint: KEY_NEEDED },
  { id: "openrouter", label: "OpenRouter", name: "OpenRouter", kind: "openai_compatible", baseUrl: "https://openrouter.ai/api/v1", keyHint: KEY_NEEDED },
  { id: "ollama", label: "Ollama (lokaal)", name: "Ollama", kind: "openai_compatible", baseUrl: "http://localhost:11434/v1", keyHint: KEY_LOCAL },
  { id: "lmstudio", label: "LM Studio (lokaal)", name: "LM Studio", kind: "openai_compatible", baseUrl: "http://localhost:1234/v1", keyHint: KEY_LOCAL },
  { id: "custom", label: "Andere OpenAI-compatibele API", name: "", kind: "openai_compatible", baseUrl: "", keyHint: "Vul in als deze dienst erom vraagt." },
];

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
        .filter((m) => m.enabled || (active?.providerId === p.id && active.modelId === m.id))
        .map((m) => ({ value: refValue({ providerId: p.id, modelId: m.id }), label: modelLabel(m) })),
    }))
    .filter((g) => g.options.length > 0);
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
  if (!r.model) return "De provider is bereikbaar, maar er is nog geen model om mee te proberen. Haal de modellen op of voeg er een toe.";
  const ms = r.firstTokenMs;
  const time = ms === null ? "" : ms < 1000 ? ` in ${ms} ms` : ` in ${(ms / 1000).toLocaleString("nl-NL", { maximumFractionDigits: 1 })} s`;
  const answer = r.sample ? `: “${r.sample}”` : ", zonder tekst";
  return `Verbinding werkt. ${r.model} antwoordde${time}${answer}`;
}

export const modelCount = (n: number) => (n === 1 ? "1 model" : `${n} modellen`);

export function countSummary(models: Model[]): string {
  return models.length ? `${modelCount(models.length)}, ${models.filter((m) => m.enabled).length} in de kiezer` : "Nog geen modellen. Haal ze op of voeg er zelf een toe.";
}
