// Light or dark. The choice lives in Settings; "system" follows macOS. The window around the article changes,
// web pages and PDFs keep their own colours.
export type ThemeChoice = "light" | "dark" | "system";

const KEY = "deepdive.theme";
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function stored(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return isThemeChoice(value) ? value : "light";
  } catch {
    return "light";
  }
}

let current: ThemeChoice = stored();

export function themeChoice(): ThemeChoice {
  return current;
}

function apply() {
  const choice = current;
  const dark = choice === "dark" || (choice === "system" && !!media?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setThemeChoice(choice: ThemeChoice) {
  current = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Then it lasts until the app closes.
  }
  apply();
}

export function initTheme() {
  apply();
  media?.addEventListener("change", apply);
}
