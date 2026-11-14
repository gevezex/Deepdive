// Selecteren en markeren in het linkerpaneel, voor websites en pdf's. Bij een website zit de selectie in de
// afgeschermde iframe; het eigen script daarin (src-tauri/src/engine/bridge.js) geeft haar door met postMessage.
// Bij een pdf staat de tekstlaag gewoon in dit venster.
import { invoke } from "@tauri-apps/api/core";
import type { PdfViewHandle } from "./pdf";
import { COLOR_LABELS, COLORS, MORE_ACTIONS, paragraphsForRects, quoteText, type Action, type HighlightColor, type PageRect } from "./readingLogic";
import type { AppError, ParagraphRange, Source } from "./types";

export interface Selected {
  text: string;
  from: number | null;
  to: number | null;
}

type Anchor = { kind: "web"; start: number; end: number } | { kind: "pdf"; rects: PageRect[] };

export interface Highlight {
  id: string;
  color: HighlightColor;
  text: string;
  from: number | null;
  to: number | null;
  anchor: Anchor;
  note?: string | null;
  createdAt?: string;
}

interface Current extends Selected {
  anchor: Anchor | null;
  /** Waar de selectie op het scherm staat, in de coördinaten van dit venster. */
  rect: { top: number; left: number; bottom: number; right: number };
}

interface Options {
  frame: HTMLIFrameElement;
  pdfView: HTMLElement;
  pdf: () => PdfViewHandle | null;
  ask: (action: Action, selection: Selected, question?: string) => void;
  error: (err: unknown) => void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const COLOR_KEY = "deepdive.markColor";

const ICONS: Record<string, string> = {
  bulb: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1 2V16h5.2v-.2c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  feather: '<path d="M20 4c-6 0-12 4-13 13l-3 3M7 17h7M10 11h7"/><path d="M20 4c0 7-4 13-11 13"/>',
  dots: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  marker: '<path d="M14 4l6 6-8 8H6v-6z"/><path d="M4 21h8"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  check: '<path d="M12 3l2.4 1.7 2.9-.2.9 2.8 2.3 1.8-1 2.7 1 2.7-2.3 1.8-.9 2.8-2.9-.2L12 21l-2.4-1.7-2.9.2-.9-2.8-2.3-1.8 1-2.7-1-2.7 2.3-1.8.9-2.8 2.9.2z"/><path d="M8.5 12l2.3 2.3 4.7-4.6"/>',
  link: '<circle cx="5" cy="17" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="19" cy="15" r="2"/><path d="M6.4 15.6l4.2-6.8M13.8 8.2l3.8 5.2"/>',
  scale: '<path d="M12 4v16M6 20h12M5 8h14M7 8l-3 7h6zM17 8l-3 7h6z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};
const MORE_ICONS: Record<string, string> = { define: "book", fact_check: "check", related: "link", counterpoint: "scale", copy: "copy" };

function icon(name: string): string {
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ""}</svg>`;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

let opts: Options;
let source: Source | null = null;
let highlights: Highlight[] = [];
let current: Current | null = null;
let frameReady = false;
let activeMark: string | null = null;
let noteFor: string | null = null;
let pdfBlocks: { n: number; rect: PageRect }[] = [];
let color: HighlightColor = (() => {
  try {
    const saved = localStorage.getItem(COLOR_KEY) as HighlightColor | null;
    return saved && COLORS.includes(saved) ? saved : "yellow";
  } catch {
    return "yellow";
  }
})();

const bar = () => $("sel-bar");
const menu = () => $("sel-menu");
const markMenu = () => $("mark-menu");
const notePop = () => $("note-pop");
const askInput = () => $<HTMLInputElement>("sel-ask");

// ---------- van buitenaf ----------

export function initReading(options: Options) {
  opts = options;
  for (const el of document.querySelectorAll<HTMLElement>(".sel-icon[data-icon]")) el.innerHTML = icon(el.dataset.icon!);
  renderColorDot();
  buildMoreMenu();

  window.addEventListener("message", onFrameMessage);
  for (const button of bar().querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    button.addEventListener("click", () => run(button.dataset.action as Action));
  }
  $("sel-ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = askInput().value.trim();
    if (q) run("ask", q);
  });
  $("sel-more").addEventListener("click", () => toggleMore());
  $("sel-mark").addEventListener("click", () => void markSelection(false));
  $("sel-note").addEventListener("click", () => void markSelection(true));
  $("note-save").addEventListener("click", () => void saveNote());
  $("note-cancel").addEventListener("click", closeNote);
  $<HTMLTextAreaElement>("note-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void saveNote();
    if (e.key === "Escape") closeNote();
  });

  // Pdf: de selectie staat in dit venster.
  // Tijdens het slepen komt er geen balk: die zou onder de muis kunnen verschijnen en de selectie afbreken.
  // Pas bij loslaten, ook als dat buiten de pdf gebeurt. Selecteren met het toetsenbord gaat via selectionchange.
  document.addEventListener("selectionchange", () => {
    if (source?.kind === "pdf" && !dragging) schedulePdfSelection();
  });
  options.pdfView.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    clearTimeout(pdfTimer);
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    schedulePdfSelection(0);
  });
  options.pdfView.addEventListener("click", (e) => {
    if (source?.kind !== "pdf" || hasPdfSelection()) return;
    const id = opts.pdf()?.markAt(e.clientX, e.clientY);
    if (id) openMarkMenu(id);
  });
  options.pdfView.addEventListener("scroll", () => {
    if (current) placeBar();
    if (activeMark) placeMarkMenu();
  }, { passive: true });

  // Klikken ergens anders sluit de balk en de menu's.
  document.addEventListener("mousedown", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#sel-bar, #sel-menu, #mark-menu, #note-pop")) return;
    if (t.closest("#pdf-view")) {
      hideMarkMenu();
      return;
    }
    clearSelection();
    hideMarkMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!notePop().hidden) return closeNote();
    clearSelection();
    hideMarkMenu();
  });
  // Typen terwijl er in de pdf iets geselecteerd is: de letters gaan naar het vraagveld.
  document.addEventListener("keydown", (e) => {
    if (!current || source?.kind !== "pdf" || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    e.preventDefault();
    typeIntoAsk(e.key);
  });
  // Geen menu van het systeem (Herlaad, Inspecteer, ...), behalve in invoervelden voor knippen en plakken.
  // Tijdens het ontwikkelen opent Shift + rechtermuisknop het nog wel, voor Inspecteer.
  document.addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (import.meta.env.DEV && e.shiftKey) return;
    e.preventDefault();
    if (source?.kind === "pdf") schedulePdfSelection(0);
  });
  window.addEventListener("resize", () => {
    if (current) placeBar();
  });
}

/** Een andere bron op het scherm. De iframe of pdf wordt los daarvan geladen. */
export async function setReadingSource(next: Source | null) {
  const same = source?.id === next?.id;
  source = next;
  if (same) return;
  clearSelection();
  hideMarkMenu();
  closeNote();
  highlights = [];
  pdfBlocks = [];
  if (!next) return;
  try {
    const list = await invoke<Highlight[]>("list_highlights", { sourceId: next.id });
    if (source?.id !== next.id) return;
    highlights = list;
    sendMarks();
  } catch (err) {
    opts.error(err);
  }
}

/** De iframe laadt een nieuwe pagina; tot het script zich meldt, kan er niets heen. */
export function frameLoading() {
  frameReady = false;
  clearSelection();
  hideMarkMenu();
}

/** De pdf staat op het scherm, of de tekst ervan is net gelezen. */
export async function pdfReady(handle: PdfViewHandle, latest: Source) {
  source = latest.id === source?.id ? latest : source;
  sendMarks();
  try {
    pdfBlocks = await handle.blockRects(latest.blocks);
  } catch {
    pdfBlocks = [];
  }
}

/** Springen in de websitekopie zonder herladen. Geeft false als het script er (nog) niet is. */
export function jumpInFrame(ranges: ParagraphRange[]): boolean {
  if (!frameReady || source?.kind === "pdf") return false;
  postToFrame({ type: "jump", ranges });
  // Zichtbaar in de DOM, zodat te zien is waarheen het laatst werd gesprongen.
  opts.frame.dataset.jump = ranges.map(([a, b]) => `${a}-${b}`).join(",");
  return true;
}

// ---------- berichten van de iframe ----------

interface FrameRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function postToFrame(msg: Record<string, unknown>) {
  opts.frame.contentWindow?.postMessage({ dd: 1, ...msg }, "*");
}

function fromFrame(rect: FrameRect | null | undefined) {
  if (!rect) return null;
  const f = opts.frame.getBoundingClientRect();
  return { top: rect.top + f.top, left: rect.left + f.left, bottom: rect.bottom + f.top, right: rect.right + f.left };
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function onFrameMessage(e: MessageEvent) {
  // Alleen het script in onze eigen iframe. De inhoud is onbetrouwbaar: alleen getallen en tekst worden gebruikt.
  if (e.source !== opts.frame.contentWindow || opts.frame.hidden) return;
  const msg = e.data as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object" || msg.dd !== 1 || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "ready":
      frameReady = true;
      sendMarks();
      break;
    case "selection": {
      const text = typeof msg.text === "string" ? msg.text : "";
      const rect = fromFrame(msg.rect as FrameRect);
      if (!text || !rect || !source || source.kind === "pdf") {
        if (current) hideBar();
        current = null;
        return;
      }
      const start = num(msg.start);
      const end = num(msg.end);
      hideMarkMenu();
      current = { text, from: num(msg.from), to: num(msg.to), anchor: start !== null && end !== null && end > start ? { kind: "web", start, end } : null, rect };
      showBar();
      break;
    }
    case "selection-moved": {
      const rect = fromFrame(msg.rect as FrameRect);
      if (current && rect) {
        current.rect = rect;
        placeBar();
      }
      break;
    }
    case "mark-click":
      if (typeof msg.id === "string") openMarkMenu(msg.id, fromFrame(msg.rect as FrameRect));
      break;
    case "mark-moved":
      if (typeof msg.id === "string" && msg.id === activeMark) placeMarkMenu(fromFrame(msg.rect as FrameRect));
      break;
    case "key":
      if (current && typeof msg.key === "string" && msg.key.length === 1) typeIntoAsk(msg.key);
      break;
    case "escape":
      clearSelection();
      hideMarkMenu();
      break;
  }
}

function sendMarks() {
  if (!source) return;
  if (source.kind === "pdf") {
    opts.pdf()?.setMarks(highlights.filter((h) => h.anchor.kind === "pdf").map((h) => ({ id: h.id, color: h.color, note: !!h.note, rects: (h.anchor as { rects: PageRect[] }).rects })));
    return;
  }
  if (!frameReady) return;
  const items = highlights.flatMap((h) => (h.anchor.kind === "web" ? [{ id: h.id, color: h.color, note: !!h.note, start: h.anchor.start, end: h.anchor.end }] : []));
  postToFrame({ type: "marks", items });
}

// ---------- pdf-selectie ----------

let pdfTimer = 0;
let dragging = false;
function hasPdfSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.rangeCount > 0 && opts.pdfView.contains(sel.getRangeAt(0).commonAncestorContainer);
}

function schedulePdfSelection(delay = 150) {
  clearTimeout(pdfTimer);
  pdfTimer = window.setTimeout(readPdfSelection, delay);
}

function readPdfSelection() {
  const handle = opts.pdf();
  const sel = window.getSelection();
  if (!handle || !sel || sel.isCollapsed || sel.rangeCount === 0 || !hasPdfSelection()) {
    // Een selectie in het vraagveld of het notitieveld laat de balk staan.
    if (current && !(document.activeElement as HTMLElement | null)?.closest("#sel-bar, #note-pop")) {
      current = null;
      hideBar();
    }
    return;
  }
  const range = sel.getRangeAt(0);
  const text = sel.toString().replace(/\s+/g, " ").trim();
  const rects = handle.selectionRects(range);
  if (!text || !rects.length) return;
  const { from, to } = paragraphsForRects(rects, pdfBlocks);
  const r = range.getBoundingClientRect();
  hideMarkMenu();
  current = { text, from, to, anchor: { kind: "pdf", rects }, rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right } };
  showBar();
}

// ---------- de balk ----------

function showBar() {
  closeMore();
  askInput().value = "";
  bar().hidden = false;
  placeBar();
}

function hideBar() {
  bar().hidden = true;
  closeMore();
}

function clearSelection() {
  if (!current && bar().hidden) return;
  current = null;
  hideBar();
  if (source?.kind === "pdf") {
    if (hasPdfSelection()) window.getSelection()?.removeAllRanges();
  } else if (frameReady) {
    postToFrame({ type: "clear-selection" });
  }
}

/** Onder de selectie, of erboven als daar geen plek is. Valt de selectie uit beeld, dan de balk ook. */
function place(el: HTMLElement, rect: { top: number; left: number; bottom: number; right: number }) {
  const view = $("source-view").getBoundingClientRect();
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const gap = 10;
  const visible = rect.bottom > view.top && rect.top < view.bottom;
  el.style.visibility = visible ? "visible" : "hidden";
  let top = rect.bottom + gap;
  if (top + height > view.bottom - 4) top = rect.top - height - gap;
  top = Math.max(view.top + 4, Math.min(top, view.bottom - height - 4));
  const center = (rect.left + rect.right) / 2;
  const left = Math.max(view.left + 8, Math.min(center - width / 2, view.right - width - 8));
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
}

function placeBar() {
  if (!current || bar().hidden) return;
  place(bar(), current.rect);
  if (!menu().hidden) placeMore();
}

function typeIntoAsk(key: string) {
  const input = askInput();
  input.focus();
  input.value += key;
}

function run(action: Action, question?: string) {
  if (!current) return;
  const selected: Selected = { text: current.text, from: current.from, to: current.to };
  clearSelection();
  opts.ask(action, selected, question);
}

// ---------- meer acties ----------

function buildMoreMenu() {
  const m = menu();
  m.replaceChildren();
  MORE_ACTIONS.forEach((item, i) => {
    if (item.action === "copy") m.append(Object.assign(document.createElement("div"), { className: "sel-menu-sep" }));
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sel-menu-item";
    b.setAttribute("role", "menuitem");
    const ic = document.createElement("span");
    ic.className = "sel-menu-icon";
    ic.innerHTML = icon(MORE_ICONS[item.action] ?? "dots");
    const text = document.createElement("span");
    text.className = "sel-menu-text";
    const label = document.createElement("strong");
    label.textContent = item.label;
    const hint = document.createElement("small");
    hint.textContent = item.hint;
    text.append(label, hint);
    b.append(ic, text);
    b.addEventListener("click", () => (item.action === "copy" ? void copyQuote() : run(item.action)));
    if (i === 0) b.dataset.first = "";
    m.append(b);
  });
}

function toggleMore() {
  if (menu().hidden) {
    menu().hidden = false;
    $("sel-more").setAttribute("aria-expanded", "true");
    placeMore();
  } else {
    closeMore();
  }
}

function closeMore() {
  menu().hidden = true;
  $("sel-more").setAttribute("aria-expanded", "false");
}

function placeMore() {
  const b = $("sel-more").getBoundingClientRect();
  const barRect = bar().getBoundingClientRect();
  const m = menu();
  const height = m.offsetHeight;
  const above = barRect.top - height - 8 > 4;
  m.style.top = `${above ? barRect.top - height - 8 : barRect.bottom + 8}px`;
  m.style.left = `${Math.max(8, Math.min(b.left - 40, window.innerWidth - m.offsetWidth - 8))}px`;
}

async function copyQuote() {
  if (!current || !source) return;
  const text = quoteText(current.text, source.title, current.from, current.to);
  clearSelection();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  toast("Citaat gekopieerd");
}

let toastTimer = 0;
function toast(text: string) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 1800);
}

// ---------- markeren ----------

function renderColorDot() {
  $("sel-mark-dot").dataset.color = color;
  $("sel-mark").title = `Markeren (${COLOR_LABELS[color].toLowerCase()})`;
}

async function save(h: Highlight): Promise<boolean> {
  if (!source) return false;
  try {
    highlights = await invoke<Highlight[]>("save_highlight", { sourceId: source.id, highlight: h });
    sendMarks();
    return true;
  } catch (err) {
    opts.error(err);
    return false;
  }
}

async function markSelection(withNote: boolean) {
  if (!current?.anchor || !source) return;
  const h: Highlight = { id: newId(), color, text: current.text, from: current.from, to: current.to, anchor: current.anchor, note: null };
  const rect = current.rect;
  clearSelection();
  if (!(await save(h))) return;
  if (withNote) openNote(h.id, rect);
}

function find(id: string) {
  return highlights.find((h) => h.id === id) ?? null;
}

function markRectOnScreen(id: string): { top: number; left: number; bottom: number; right: number } | null {
  if (source?.kind === "pdf") {
    const r = opts.pdf()?.markRect(id);
    return r ? { top: r.top, left: r.left, bottom: r.bottom, right: r.right } : null;
  }
  return null;
}

let markRect: { top: number; left: number; bottom: number; right: number } | null = null;

function openMarkMenu(id: string, rect?: { top: number; left: number; bottom: number; right: number } | null) {
  const h = find(id);
  if (!h) return;
  clearSelection();
  activeMark = id;
  markRect = rect ?? markRectOnScreen(id);
  if (source?.kind === "pdf") opts.pdf()?.setActiveMark(id);
  else postToFrame({ type: "active-mark", id });
  const m = markMenu();
  m.replaceChildren();
  for (const c of COLORS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `sel-swatch${c === h.color ? " is-current" : ""}`;
    b.dataset.color = c;
    b.title = COLOR_LABELS[c];
    b.setAttribute("aria-label", COLOR_LABELS[c]);
    b.addEventListener("click", () => void recolor(id, c));
    m.append(b);
  }
  m.append(Object.assign(document.createElement("span"), { className: "sel-sep" }));
  const addButton = (label: string, iconName: string, onClick: () => void, title = label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sel-btn";
    b.title = title;
    const ic = document.createElement("span");
    ic.className = "sel-icon";
    ic.innerHTML = icon(iconName);
    b.append(ic, document.createTextNode(label));
    b.addEventListener("click", onClick);
    m.append(b);
  };
  addButton(h.note ? "Notitie" : "Notitie", "pencil", () => {
    const r = markRect;
    hideMarkMenu();
    openNote(id, r);
  }, h.note ? `Notitie: ${h.note}` : "Notitie toevoegen");
  addButton("Leg uit", "bulb", () => {
    hideMarkMenu();
    opts.ask("explain", { text: h.text, from: h.from, to: h.to });
  });
  addButton("", "trash", () => void removeMark(id), "Markering weghalen");
  m.hidden = false;
  placeMarkMenu();
}

function placeMarkMenu(rect?: { top: number; left: number; bottom: number; right: number } | null) {
  if (!activeMark || markMenu().hidden) return;
  if (rect !== undefined) markRect = rect;
  else if (source?.kind === "pdf") markRect = markRectOnScreen(activeMark);
  if (markRect) place(markMenu(), markRect);
}

function hideMarkMenu() {
  if (!activeMark && markMenu().hidden) return;
  markMenu().hidden = true;
  if (activeMark) {
    if (source?.kind === "pdf") opts.pdf()?.setActiveMark(null);
    else postToFrame({ type: "active-mark", id: null });
  }
  activeMark = null;
}

async function recolor(id: string, c: HighlightColor) {
  const h = find(id);
  if (!h) return;
  color = c;
  try {
    localStorage.setItem(COLOR_KEY, c);
  } catch {
    /* alleen gemak */
  }
  renderColorDot();
  await save({ ...h, color: c });
  if (activeMark === id) openMarkMenu(id, markRect);
}

async function removeMark(id: string) {
  if (!source) return;
  hideMarkMenu();
  try {
    highlights = await invoke<Highlight[]>("delete_highlight", { sourceId: source.id, highlightId: id });
    sendMarks();
  } catch (err) {
    opts.error(err as AppError);
  }
}

// ---------- notitie ----------

function openNote(id: string, rect: { top: number; left: number; bottom: number; right: number } | null) {
  const h = find(id);
  if (!h) return;
  noteFor = id;
  const pop = notePop();
  const area = $<HTMLTextAreaElement>("note-text");
  area.value = h.note ?? "";
  pop.hidden = false;
  if (rect) place(pop, rect);
  area.focus();
}

function closeNote() {
  notePop().hidden = true;
  noteFor = null;
}

async function saveNote() {
  const h = noteFor ? find(noteFor) : null;
  if (!h) return closeNote();
  const note = $<HTMLTextAreaElement>("note-text").value.trim();
  closeNote();
  await save({ ...h, note: note || null });
}
