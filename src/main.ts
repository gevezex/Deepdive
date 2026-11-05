import { invoke } from "@tauri-apps/api/core";
import { initProviders } from "./providers";
import type { AppError, Source, SourceSummary } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const urlInput = $<HTMLInputElement>("url-input");
const frame = $<HTMLIFrameElement>("source-frame");
const pdfView = $("pdf-view");
const shield = $("frame-shield");
const dropHint = $("drop-hint");
const pasteDialog = $<HTMLDialogElement>("paste-dialog");
const sourceList = $<HTMLSelectElement>("source-list");
const LAST_KEY = "deepdive.lastSource";

let current: Source | null = null;
let pdfHandle: { destroy(): void } | null = null;
let opening = 0;

const snapshotBase = navigator.userAgent.includes("Windows") ? "http://deepdive-snapshot.localhost" : "deepdive-snapshot://localhost";

function remember(id: string) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* alleen gemak */ }
}
function remembered(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

// ---------- meldingen en status ----------

function showError(err: unknown, pasteUrl?: string) {
  const e = normalizeError(err);
  const canPaste = !["invalid_url", "pdf", "storage", "not_found_page", "empty_text", "not_found"].includes(e.kind);
  $("error-message").textContent = e.message;
  $("error-detail").textContent = e.detail ?? "";
  $("error-details").hidden = !e.detail;
  const paste = $("error-paste");
  paste.hidden = !canPaste;
  paste.onclick = () => openPasteDialog(pasteUrl);
  $("error").hidden = false;
}

function normalizeError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: "Er ging iets mis. Probeer het opnieuw.", detail: String(err) };
}

function clearError() {
  $("error").hidden = true;
}

function setBusy(text: string | null) {
  $("busy").hidden = text === null;
  $("busy-text").textContent = text ?? "";
  $<HTMLButtonElement>("url-open").disabled = text !== null;
}

function renderStatus(source: Source | null) {
  $("status").hidden = !source;
  if (!source) return;
  const date = new Date(source.capturedAt).toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "short" });
  const parts = [
    source.kind === "web" ? "Website" : source.kind === "pdf" ? "Pdf" : "Geplakte tekst",
    source.pageCount ? `${source.pageCount} pagina's` : null,
    `${source.blocks.length} alinea's`,
    `${source.wordCount.toLocaleString("nl-NL")} woorden`,
    `vastgelegd ${date}`,
  ];
  $("status-text").textContent = parts.filter(Boolean).join(" · ");
  $("status-text").title = source.finalUrl ?? source.url ?? "";
  $("status-warnings").textContent = source.warnings.join(" ");
  $("refresh").hidden = !source.url || source.kind === "text";
}

async function refreshList() {
  const sources = await invoke<SourceSummary[]>("list_sources");
  sourceList.replaceChildren(new Option(sources.length ? `Eerder geopend (${sources.length})` : "Nog geen bronnen", ""));
  for (const s of sources) sourceList.add(new Option(s.title, s.id));
  sourceList.value = current && sources.some((s) => s.id === current!.id) ? current.id : "";
}

// ---------- tonen ----------

function hideViews() {
  pdfHandle?.destroy();
  pdfHandle = null;
  frame.hidden = true;
  frame.removeAttribute("src");
  pdfView.hidden = true;
  shield.hidden = true;
}

async function show(source: Source) {
  const token = ++opening;
  clearError();
  hideViews();
  current = source;
  remember(source.id);
  document.title = `${source.title} – Deepdive`;
  $("empty").hidden = true;
  urlInput.value = source.url ?? "";
  renderStatus(source);

  if (source.kind === "pdf") {
    pdfView.hidden = false;
    setBusy("De pdf wordt geopend…");
    try {
      // pdf.js alleen inladen als er echt een pdf wordt geopend.
      const { loadPdf, renderPdf, extractText } = await import("./pdf");
      const data = await invoke<ArrayBuffer>("read_pdf", { id: source.id });
      const doc = await loadPdf(new Uint8Array(data));
      if (token !== opening) return void doc.loadingTask.destroy();
      pdfHandle = await renderPdf(pdfView, doc);
      if (!source.textReady) {
        setBusy("De tekst wordt gelezen…");
        const text = await extractText(doc);
        const saved = await invoke<Source>("save_pdf_text", { id: source.id, title: text.title, pageCount: text.pageCount, blocks: text.blocks });
        if (token === opening) {
          current = saved;
          renderStatus(saved);
          document.title = `${saved.title} – Deepdive`;
        }
      }
    } catch (err) {
      if (token === opening) showError({ kind: "pdf", message: "Deze pdf kon niet worden geopend. Het bestand is mogelijk beschadigd of beveiligd.", detail: String(err) });
    } finally {
      if (token === opening) setBusy(null);
    }
  } else {
    frame.hidden = false;
    frame.src = `${snapshotBase}/${source.id}/index.html`;
  }
  await refreshList();
}

// ---------- invoer ----------

async function openUrl(url: string, refresh = false) {
  const trimmed = url.trim();
  if (!trimmed) return;
  clearError();
  setBusy("De pagina wordt opgehaald en vastgelegd. Dit duurt meestal 10 tot 30 seconden…");
  try {
    await show(await invoke<Source>("open_url", { url: trimmed, refresh }));
  } catch (err) {
    showError(err, trimmed);
  } finally {
    setBusy(null);
  }
}

async function openPdfFile(file: File) {
  clearError();
  setBusy("De pdf wordt opgeslagen…");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const source = await invoke<Source>("import_pdf", bytes, { headers: { "x-file-name": encodeURIComponent(file.name) } });
    await show(source);
  } catch (err) {
    showError(err);
  } finally {
    setBusy(null);
  }
}

function openPasteDialog(url?: string) {
  $<HTMLInputElement>("paste-url").value = url ?? "";
  $<HTMLInputElement>("paste-title").value = "";
  $<HTMLTextAreaElement>("paste-text").value = "";
  pasteDialog.showModal();
  $("paste-text").focus();
}

$("paste-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const source = await invoke<Source>("import_text", {
      title: $<HTMLInputElement>("paste-title").value,
      url: $<HTMLInputElement>("paste-url").value,
      text: $<HTMLTextAreaElement>("paste-text").value,
    });
    pasteDialog.close();
    await show(source);
  } catch (err) {
    pasteDialog.close();
    showError(err);
  }
});
$("paste-cancel").addEventListener("click", () => pasteDialog.close());
$("paste-open").addEventListener("click", () => openPasteDialog());
$("error-close").addEventListener("click", clearError);

$("url-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void openUrl(urlInput.value);
});
$("refresh").addEventListener("click", () => {
  if (current?.url) void openUrl(current.url, true);
});
$<HTMLInputElement>("pdf-input").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) void openPdfFile(file);
});
sourceList.addEventListener("change", async () => {
  if (!sourceList.value) return;
  try {
    await show(await invoke<Source>("get_source", { id: sourceList.value }));
  } catch (err) {
    showError(err);
  }
});

// Plakken buiten een invoerveld opent het adres meteen.
document.addEventListener("paste", (e) => {
  const target = e.target as HTMLElement;
  if (target.closest("input, textarea")) return;
  const text = e.clipboardData?.getData("text/plain")?.trim();
  if (text && /^https?:\/\/\S+$/i.test(text)) {
    e.preventDefault();
    void openUrl(text);
  }
});

// ---------- slepen ----------

function droppedUrl(data: DataTransfer): string | null {
  const list = data.getData("text/uri-list");
  const fromList = list.split(/\r?\n/).find((l) => l && !l.startsWith("#"));
  const text = fromList ?? data.getData("text/plain").trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
}

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  dropHint.hidden = false;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropHint.hidden = true;
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropHint.hidden = true;
  shield.hidden = true;
  const data = e.dataTransfer;
  if (!data) return;
  const file = data.files[0];
  if (file) {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) void openPdfFile(file);
    else showError({ kind: "pdf", message: `"${file.name}" is geen pdf. Sleep een pdf of een webadres.`, detail: null });
    return;
  }
  const url = droppedUrl(data);
  if (url) void openUrl(url);
  else showError({ kind: "invalid_url", message: "Dit is geen webadres of pdf. Sleep een link of een pdf-bestand.", detail: null });
});

// Een afgeschermde iframe geeft sleepacties niet door. Slepen vanuit een andere app gebeurt altijd terwijl
// dit venster geen focus heeft, dus dan ligt er een onzichtbaar schild over de kopie. De eerste muisbeweging haalt het weg.
window.addEventListener("blur", () => {
  setTimeout(() => {
    if (!document.hasFocus() && !frame.hidden) shield.hidden = false;
  }, 0);
});
for (const type of ["mousemove", "mousedown", "wheel"]) {
  shield.addEventListener(type, () => (shield.hidden = true));
}

// ---------- start ----------

async function start() {
  await Promise.all([refreshList(), initProviders()]);
  const last = remembered();
  if (!last) return;
  try {
    await show(await invoke<Source>("get_source", { id: last }));
  } catch {
    // De laatste bron bestaat niet meer: gewoon leeg beginnen.
  }
}
void start();
