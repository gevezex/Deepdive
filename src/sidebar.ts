// The sidebar: every source ever opened, newest first, with a search field that also looks in highlights and notes.
// The list comes fresh from the backend on every refresh and on every search, so a source saved elsewhere shows up too.
import { invoke } from "@tauri-apps/api/core";
import { formatDate, plural, t } from "./i18n";
import { dateGroup, groupKey, hostOf, readingMinutes, search, snippet, type DateGroup, type Filter } from "./sidebarLogic";
import type { HighlightBrief, SourceSummary } from "./types";

interface Options {
  open: (id: string) => void;
  openHighlight: (sourceId: string, highlight: HighlightBrief) => void;
  error: (err: unknown) => void;
}

const HIDDEN_KEY = "deepdive.sidebarHidden";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let options: Options;
let sources: SourceSummary[] = [];
let currentId: string | null = null;
let filter: Filter = "all";
let loads = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function groupLabel(g: DateGroup, now: Date): string {
  if (g.kind === "today") return t("side.today");
  if (g.kind === "yesterday") return t("side.yesterday");
  if (g.kind === "week") return t("side.week");
  const date = new Date(g.year, g.month, 1);
  return formatDate(date, g.year === now.getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
}

function badge(source: SourceSummary): HTMLElement {
  if (source.kind === "pdf") return el("span", "fav fav-pdf", "PDF");
  if (source.kind === "text") return el("span", "fav", "¶");
  const host = hostOf(source.url);
  // Een adres als 127.0.0.1 zegt niets: dan de naam van de site of de titel.
  const name = host && !/^[\d.:[\]]+$/.test(host) ? host : source.siteName || source.title;
  return el("span", "fav", (name.trim()[0] ?? "·").toLocaleUpperCase());
}

function meta(source: SourceSummary): HTMLElement {
  const line = el("span", "item-meta");
  const where = source.kind === "text" ? t("side.text") : hostOf(source.url) ?? (source.kind === "pdf" ? t("side.file") : source.siteName);
  const size = source.kind === "pdf" && source.pageCount ? plural(source.pageCount, "app.pages.one", "app.pages.other") : t("side.minutes", { n: readingMinutes(source.wordCount) });
  for (const [i, part] of [where, size].filter(Boolean).entries()) {
    if (i) line.append(el("span", "dot"));
    line.append(el("span", "meta-part", part!));
  }
  if (source.highlights.length) {
    const pill = el("span", "mark-pill", String(source.highlights.length));
    pill.title = plural(source.highlights.length, "side.highlights.one", "side.highlights.other");
    line.append(pill);
  }
  return line;
}

function sourceItem(source: SourceSummary): HTMLElement {
  const item = el("button", "src-item");
  item.type = "button";
  item.dataset.id = source.id;
  item.title = source.url ?? source.title;
  if (source.id === currentId) item.setAttribute("aria-current", "true");
  const body = el("span", "item-body");
  body.append(el("span", "item-title", source.title), meta(source));
  item.append(badge(source), body);
  item.addEventListener("click", () => options.open(source.id));
  return item;
}

function highlighted(text: string, query: string): DocumentFragment {
  const part = snippet(text, query);
  const frag = document.createDocumentFragment();
  frag.append(part.before);
  if (part.hit) frag.append(el("mark", "hit", part.hit));
  frag.append(part.after);
  return frag;
}

function render() {
  const list = $("source-list");
  const query = $<HTMLInputElement>("source-search").value.trim();
  const result = search(sources, query, filter);
  const nodes: HTMLElement[] = [];
  if (!sources.length) {
    nodes.push(el("p", "side-empty", t("app.noSources")));
  } else if (!result.sources.length && !result.highlights.length) {
    nodes.push(el("p", "side-empty", query ? t("side.noResults") : t("side.noneInFilter")));
  } else if (query) {
    if (result.sources.length) {
      nodes.push(el("h3", "group", plural(result.sources.length, "side.articles.one", "side.articles.other")));
      for (const s of result.sources) nodes.push(sourceItem(s));
    }
    if (result.highlights.length) {
      nodes.push(el("h3", "group", plural(result.highlights.length, "side.highlights.one", "side.highlights.other")));
      for (const hit of result.highlights.slice(0, 200)) {
        const item = el("button", "src-item hl-item");
        item.type = "button";
        item.dataset.highlight = hit.highlight.id;
        const body = el("span", "item-body");
        const quote = el("span", "item-quote");
        quote.append(highlighted(hit.inNote ? hit.highlight.note ?? "" : hit.highlight.text, query));
        body.append(quote, el("span", "item-meta", hit.inNote ? `${t("side.inNote")} · ${hit.source.title}` : hit.source.title));
        const dot = el("span", "fav hl-dot");
        dot.dataset.color = hit.highlight.color;
        item.append(dot, body);
        item.addEventListener("click", () => options.openHighlight(hit.source.id, hit.highlight));
        nodes.push(item);
      }
    }
  } else {
    const now = new Date();
    let last = "";
    for (const s of result.sources) {
      const group = dateGroup(s.capturedAt, now);
      const key = groupKey(group);
      if (key !== last) {
        nodes.push(el("h3", "group", groupLabel(group, now)));
        last = key;
      }
      nodes.push(sourceItem(s));
    }
  }
  list.replaceChildren(...nodes);
}

/** Fetches the list again. `current` marks the open source. */
export async function refreshSidebar(current: string | null = currentId) {
  currentId = current;
  const load = ++loads;
  const next = await invoke<SourceSummary[]>("list_sources");
  if (load !== loads) return;
  sources = next;
  render();
}

/** Only the mark on the open source, without asking the backend. */
export function markCurrent(id: string | null) {
  currentId = id;
  for (const item of document.querySelectorAll<HTMLElement>("#source-list .src-item[data-id]")) {
    if (item.dataset.id === id) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
}

export function rerenderSidebar() {
  render();
}

export function focusSearch() {
  setSidebarHidden(false);
  const input = $<HTMLInputElement>("source-search");
  input.focus();
  input.select();
}

function setSidebarHidden(hidden: boolean) {
  $("shell").classList.toggle("side-hidden", hidden);
  $("sidebar").hidden = hidden;
  $("sidebar-show").hidden = !hidden;
  try {
    localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "");
  } catch {
    // Only a convenience.
  }
}

export function toggleSidebar() {
  setSidebarHidden(!$("sidebar").hidden);
}

// ---------- the New menu ----------

export function setNewMenu(open: boolean) {
  $("new-menu").hidden = !open;
  $("new-open").setAttribute("aria-expanded", String(open));
  if (open) setSidebarHidden(false);
}

export function initSidebar(opts: Options) {
  options = opts;
  let stored = false;
  try {
    stored = localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    // Starts open.
  }
  setSidebarHidden(stored);
  $("sidebar-hide").addEventListener("click", () => setSidebarHidden(true));
  $("sidebar-show").addEventListener("click", () => setSidebarHidden(false));

  const searchInput = $<HTMLInputElement>("source-search");
  searchInput.addEventListener("input", () => {
    render();
    void refreshSidebar().catch(opts.error);
  });
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && searchInput.value) {
      e.stopPropagation();
      searchInput.value = "";
      render();
    } else if (e.key === "Enter") {
      $("source-list").querySelector<HTMLButtonElement>(".src-item")?.click();
    }
  });

  for (const chip of document.querySelectorAll<HTMLButtonElement>("#source-filters .chip")) {
    chip.addEventListener("click", () => {
      filter = chip.dataset.filter as Filter;
      for (const other of document.querySelectorAll<HTMLButtonElement>("#source-filters .chip")) other.setAttribute("aria-pressed", String(other === chip));
      render();
    });
  }

  $("new-open").addEventListener("click", () => setNewMenu($("new-menu").hidden !== false));
  for (const item of $("new-menu").querySelectorAll("button, label")) item.addEventListener("click", () => setNewMenu(false));
  document.addEventListener("mousedown", (e) => {
    if (!$("new-menu").hidden && !(e.target as HTMLElement).closest(".new-wrap")) setNewMenu(false);
  });
}
