// The interface language. English is the default; the reader can switch in Settings. Static texts in index.html
// carry a data-i18n attribute, everything built in code calls t(). The language the model writes in is a separate
// choice per source (see aiLanguage in types.ts).
import { invoke } from "@tauri-apps/api/core";
import type { Lang, Messages } from "./define";
import answers from "./answers";
import app from "./app";
import blueprint from "./blueprint";
import common from "./common";
import providers from "./providers";
import reading from "./reading";

export type { Lang } from "./define";

const AREAS = [answers, app, blueprint, common, providers, reading];

// Listed one by one: as an array type TypeScript would merge the areas into one and lose the keys.
export type Key =
  | keyof typeof answers.en
  | keyof typeof app.en
  | keyof typeof blueprint.en
  | keyof typeof common.en
  | keyof typeof providers.en
  | keyof typeof reading.en;

export const LANGUAGES: { code: Lang; name: string; flag: string; locale: string }[] = [
  { code: "en", name: "English", flag: "🇬🇧", locale: "en-GB" },
  { code: "nl", name: "Nederlands", flag: "🇳🇱", locale: "nl-NL" },
  { code: "tr", name: "Türkçe", flag: "🇹🇷", locale: "tr-TR" },
];

const STORE_KEY = "deepdive.language";
const tables = Object.fromEntries(
  LANGUAGES.map(({ code }) => [code, Object.assign({}, ...AREAS.map((area) => (area as Record<Lang, Messages>)[code])) as Messages]),
) as Record<Lang, Messages>;

export function isLang(value: unknown): value is Lang {
  return typeof value === "string" && LANGUAGES.some((l) => l.code === value);
}

function stored(): Lang {
  try {
    const value = globalThis.localStorage?.getItem(STORE_KEY);
    return isLang(value) ? value : "en";
  } catch {
    return "en";
  }
}

let current: Lang = stored();
const listeners = new Set<() => void>();

export function lang(): Lang {
  return current;
}

/** For dates and numbers: "en-GB", "nl-NL", "tr-TR". */
export function locale(): string {
  return LANGUAGES.find((l) => l.code === current)!.locale;
}

export function languageInfo(code: string | null | undefined) {
  return LANGUAGES.find((l) => l.code === code) ?? null;
}

/** A text in the interface language. `{name}` in the text is replaced by `params.name`. */
export function t(key: Key, params?: Record<string, string | number>): string {
  const text = tables[current][key as string] ?? tables.en[key as string] ?? String(key);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}

/** "1 point" or "3 points". The texts carry {n}. */
export function plural(n: number, one: Key, other: Key): string {
  return t(n === 1 ? one : other, { n: n.toLocaleString(locale()) });
}

export function formatDate(value: string | number | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Date(value).toLocaleString(locale(), options);
}

export function formatNumber(n: number, options?: Intl.NumberFormatOptions): string {
  return n.toLocaleString(locale(), options);
}

/** Fills in the static texts: data-i18n for the text, data-i18n-title, -placeholder and -aria-label for attributes. */
export function translateStatic(root: ParentNode = document) {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) node.textContent = t(node.dataset.i18n as Key);
  for (const [attr, data] of [["title", "i18nTitle"], ["placeholder", "i18nPlaceholder"], ["aria-label", "i18nAriaLabel"]] as const) {
    for (const node of root.querySelectorAll<HTMLElement>(`[data-${attr === "aria-label" ? "i18n-aria-label" : `i18n-${attr}`}]`)) {
      node.setAttribute(attr, t(node.dataset[data] as Key));
    }
  }
}

export function onLanguageChange(listener: () => void) {
  listeners.add(listener);
}

/** Tells the backend, so its messages follow. Called once at start and on every change. */
async function tellBackend(): Promise<string | null> {
  try {
    return await invoke<string>("set_ui_language", { language: current });
  } catch {
    // Without the backend (tests) the interface still works.
    return null;
  }
}

export async function initLanguage() {
  // A test build can force a language; that is not stored as the reader's choice.
  const inForce = await tellBackend();
  if (isLang(inForce)) current = inForce;
  document.documentElement.lang = current;
  translateStatic();
}

export async function setLanguage(next: Lang) {
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(STORE_KEY, next);
  } catch {
    // Only a convenience: next start falls back to English.
  }
  document.documentElement.lang = next;
  translateStatic();
  await tellBackend();
  for (const listener of listeners) listener();
}
