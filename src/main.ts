import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, initAnswers, setAnswersSource } from "./answers";
import { initBlueprint, setBlueprintSource } from "./blueprint";
import { highlightParam } from "./blueprintLogic";
import { initProviders } from "./providers";
import { frameLoading, initReading, jumpInFrame, pdfReady, setReadingSource } from "./reading";
import { initSites, refreshSites } from "./sites";
import { initUpdate } from "./update";
import { formatDate, formatNumber, initLanguage, isLang, lang, LANGUAGES, onLanguageChange, plural, setLanguage, t } from "./i18n";
import type { PdfViewHandle } from "./pdf";
import type { AppError, LoginClosed, PagePreview, ParagraphRange, RefetchOutcome, SiteSession, Source, SourceSummary } from "./types";

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
let pdfHandle: PdfViewHandle | null = null;
let opening = 0;
let frameLoads = 0;
let lastHighlight: string | null = null;
let previewRequests = 0;
let previewShownFor: string | null = null;
let awaitingPreview: { request: string; token: number; url: string } | null = null;

const snapshotBase = navigator.userAgent.includes("Windows") ? "http://deepdive-snapshot.localhost" : "deepdive-snapshot://localhost";

function remember(id: string) {
  try { localStorage.setItem(LAST_KEY, id); } catch { /* alleen gemak */ }
}
function remembered(): string | null {
  try { return localStorage.getItem(LAST_KEY); } catch { return null; }
}

/** De bron voor alles wat erbij hoort: blauwdruk, vragen, markeringen en de taal van het model. */
function setSource(source: Source | null) {
  renderAiLanguage(source);
  void setBlueprintSource(source);
  void setAnswersSource(source);
  void setReadingSource(source);
}

// ---------- talen ----------

const aiLanguage = $<HTMLSelectElement>("ai-language");

/** The flag next to the model: the language the model writes in for this article. */
function renderAiLanguage(source: Source | null) {
  aiLanguage.replaceChildren(...LANGUAGES.map((l) => new Option(`${l.flag} ${l.name}`, l.code)));
  aiLanguage.disabled = !source;
  aiLanguage.value = source?.aiLanguage && isLang(source.aiLanguage) ? source.aiLanguage : lang();
}

aiLanguage.addEventListener("change", async () => {
  const source = current;
  if (!source || !isLang(aiLanguage.value)) return;
  try {
    const saved = await invoke<Source>("set_ai_language", { id: source.id, language: aiLanguage.value });
    if (current?.id !== saved.id) return;
    current = saved;
    setSource(saved);
  } catch (err) {
    showError(err);
    renderAiLanguage(current);
  }
});

function initSettings() {
  const dialog = $<HTMLDialogElement>("settings-dialog");
  const select = $<HTMLSelectElement>("settings-language");
  select.replaceChildren(...LANGUAGES.map((l) => new Option(`${l.flag} ${l.name}`, l.code)));
  $("settings-open").addEventListener("click", () => {
    select.value = lang();
    dialog.showModal();
  });
  $("settings-close").addEventListener("click", () => dialog.close());
  select.addEventListener("change", () => {
    if (isLang(select.value)) void setLanguage(select.value);
  });
}

onLanguageChange(() => {
  renderAiLanguage(current);
  if (current) renderStatus(current);
  void refreshList().catch(() => {});
});

// ---------- meldingen en status ----------

function showError(err: unknown, pasteUrl?: string) {
  const e = normalizeError(err);
  const canPaste = !["invalid_url", "pdf", "storage", "not_found_page", "empty_text", "not_found", "update"].includes(e.kind);
  $("error-message").textContent = e.message;
  $("error-detail").textContent = e.detail ?? "";
  $("error-details").hidden = !e.detail;
  const paste = $("error-paste");
  paste.hidden = !canPaste;
  paste.onclick = () => openPasteDialog(pasteUrl);
  // Bij een cookiemuur of een site die eerst een account vraagt, kan de lezer dat zelf oplossen in het venster.
  const login = $("error-login");
  login.hidden = !pasteUrl || !["blocked", "consent", "empty"].includes(e.kind);
  login.onclick = () => {
    clearError();
    if (pasteUrl) void beginLogin(pasteUrl, null);
  };
  $("error").hidden = false;
}

function normalizeError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: t("common.genericError"), detail: String(err) };
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
  const parts = [
    t(`app.kind.${source.kind}`),
    source.pageCount ? plural(source.pageCount, "app.pages.one", "app.pages.other") : null,
    plural(source.blocks.length, "app.paragraphs.one", "app.paragraphs.other"),
    plural(source.wordCount, "app.words.one", "app.words.other"),
    t("app.capturedAt", { date: formatDate(source.capturedAt) }),
  ];
  $("status-text").textContent = parts.filter(Boolean).join(" · ");
  $("status-text").title = source.finalUrl ?? source.url ?? "";
  $("status-warnings").textContent = source.warnings.join(" ");
  $("refresh").hidden = !source.url || source.kind === "text";
  const hide = $("hide-floating");
  hide.hidden = source.kind !== "web";
  hide.textContent = t(source.hideFloating ? "app.showFloating" : "app.hideFloating");
}

// ---------- melding boven de kopie ----------

interface NoticeAction {
  label: string;
  primary?: boolean;
  run: () => void;
}

function setNotice(title: string, text: string, actions: NoticeAction[] = []) {
  $("source-notice-title").textContent = title;
  $("source-notice-text").textContent = text;
  $("source-notice-actions").replaceChildren(
    ...actions.map((a) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = a.label;
      if (a.primary) button.className = "primary";
      button.onclick = a.run;
      return button;
    }),
  );
  $("source-notice").hidden = false;
}

function clearNotice() {
  $("source-notice").hidden = true;
}

/** De melding die bij de bron hoort als er verder niets aan de hand is. */
function renderSourceNotice(source: Source) {
  clearNotice();
  if (source.supersededBy) {
    const newest = source.supersededBy;
    setNotice(t("app.olderCopyTitle"), t("app.olderCopyText"), [{ label: t("app.toNewest"), primary: true, run: () => void openById(newest) }]);
    return;
  }
  const c = source.completeness;
  if (c.verdict !== "likely_incomplete" || c.acceptedByUser) return;
  const url = source.url ?? source.finalUrl;
  setNotice(t("app.incompleteTitle"), c.reason, [
    ...(url ? [{ label: t("app.logIn"), primary: true, run: () => void beginLogin(url, source) }] : []),
    {
      label: t("app.useAnyway"),
      run: async () => {
        try {
          const saved = await invoke<Source>("accept_incomplete", { id: source.id });
          if (current?.id === saved.id) {
            current = saved;
            void setSource(saved);
          }
          clearNotice();
        } catch (err) {
          showError(err);
        }
      },
    },
  ]);
}

async function openById(id: string) {
  try {
    await show(await invoke<Source>("get_source", { id }));
  } catch (err) {
    showError(err);
  }
}

// ---------- inloggen op een site en opnieuw ophalen ----------

let loginSite: string | null = null;
let loginAfter: (() => void) | null = null;

async function beginLogin(url: string, source: Source | null) {
  clearError();
  const again = () => {
    if (source) void refetch(source);
    else void openUrl(url, true);
  };
  try {
    const session = await invoke<SiteSession>("site_login_open", { url });
    loginSite = session.site;
    loginAfter = again;
    setNotice(t("app.loginTitle", { site: session.site }), t("app.loginText"), [{ label: t("app.refetch"), primary: true, run: again }]);
    refreshSites();
  } catch (err) {
    showError(err);
  }
}

function words(n: number) {
  return formatNumber(n);
}

async function refetch(source: Source) {
  clearError();
  clearNotice();
  if (loginSite) {
    await invoke("site_login_close", { site: loginSite }).catch(() => {});
    loginSite = null;
    loginAfter = null;
  }
  setBusy(t("app.refetching"));
  try {
    const result = await invoke<RefetchOutcome>("refetch_source", { id: source.id });
    if (result.status === "replaced") {
      await show(result.current);
      const previous = result.current.previousId;
      const c = result.current.completeness;
      const title = t(c.verdict === "likely_incomplete" ? "app.newCopyStillIncomplete" : "app.newCopy");
      const detail = t("app.newCopyDetail", { old: words(result.oldWords), new: words(result.newWords) });
      setNotice(title, c.verdict === "likely_incomplete" ? `${c.reason} ${detail}` : detail, [
        ...(previous ? [{ label: t("app.previousCopy"), run: () => void openById(previous) }] : []),
        ...(c.verdict === "likely_incomplete" && result.current.url ? [{ label: t("app.logIn"), primary: true, run: () => void beginLogin(result.current.url!, result.current) }] : []),
      ]);
    } else if (result.status === "kept_old" && result.candidateId) {
      const candidate = result.candidateId;
      setNotice(
        t("app.copyUnchangedTitle"),
        t("app.copyUnchangedText", { old: words(result.oldWords), new: words(result.newWords) }),
        [
          { label: t("app.keepOld"), primary: true, run: () => void invoke("discard_candidate", { id: source.id, candidateId: candidate }).then(clearNotice, showError) },
          { label: t("app.takeNew"), run: () => void invoke<Source>("adopt_candidate", { id: source.id, candidateId: candidate }).then(show, showError) },
        ],
      );
    } else {
      setNotice(t("app.noDifferenceTitle"), t("app.noDifferenceText"));
    }
  } catch (err) {
    showError(err, source.url ?? undefined);
    renderSourceNotice(source);
  } finally {
    setBusy(null);
  }
}

void listen<LoginClosed>("site-login-closed", ({ payload }) => {
  refreshSites();
  if (payload.site !== loginSite) return;
  const again = loginAfter;
  loginSite = null;
  loginAfter = null;
  if (!payload.hasSession) {
    setNotice(t("app.noSessionTitle"), t("app.noSessionText"));
    return;
  }
  setNotice(t("app.loginClosedTitle"), t("app.loginClosedText"), again ? [{ label: t("app.refetch"), primary: true, run: again }] : []);
});

async function refreshList() {
  const sources = await invoke<SourceSummary[]>("list_sources");
  sourceList.replaceChildren(new Option(sources.length ? t("app.previouslyOpened", { n: sources.length }) : t("app.noSources"), ""));
  for (const s of sources) sourceList.add(new Option(s.title, s.id));
  sourceList.value = current && sources.some((s) => s.id === current!.id) ? current.id : "";
}

// ---------- tonen ----------

function hideViews() {
  $("show-saved").hidden = true;
  frameLoading();
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
  renderSourceNotice(source);
  void setSource(source);

  if (source.kind === "pdf") {
    pdfView.hidden = false;
    setBusy(t("app.openingPdf"));
    try {
      // pdf.js alleen inladen als er echt een pdf wordt geopend.
      const { loadPdf, renderPdf, extractText } = await import("./pdf");
      const data = await invoke<ArrayBuffer>("read_pdf", { id: source.id });
      const doc = await loadPdf(new Uint8Array(data));
      if (token !== opening) return void doc.loadingTask.destroy();
      pdfHandle = await renderPdf(pdfView, doc);
      void pdfReady(pdfHandle, source);
      if (!source.textReady) {
        setBusy(t("app.readingText"));
        const text = await extractText(doc);
        const saved = await invoke<Source>("save_pdf_text", { id: source.id, title: text.title, pageCount: text.pageCount, blocks: text.blocks });
        if (token === opening) {
          current = saved;
          void setSource(saved);
          if (pdfHandle) void pdfReady(pdfHandle, saved);
          renderStatus(saved);
          document.title = `${saved.title} – Deepdive`;
        }
      }
    } catch (err) {
      if (token === opening) showError({ kind: "pdf", message: t("app.pdfFailed"), detail: String(err) });
    } finally {
      if (token === opening) setBusy(null);
    }
  } else {
    frame.hidden = false;
    lastHighlight = null;
    loadFrame(source.id);
  }
  await refreshList();
}

/** `reload`: een adres dat alleen in het anker verschilt, laadt de iframe niet opnieuw. Daarom krijgt het dan een eigen nummer. */
function loadFrame(id: string, reload = false) {
  $("show-saved").hidden = true;
  frameLoading();
  const query = [lastHighlight ? `hl=${lastHighlight}` : null, reload ? `v=${++frameLoads}` : null].filter(Boolean).join("&");
  frame.src = `${snapshotBase}/${id}/index.html${query ? `?${query}` : ""}${lastHighlight ? "#dd-doel" : ""}`;
}

/** De iframe is afgeschermd en voert geen scripts uit. De app laadt de kopie opnieuw, met een stijl die de zwevende lagen verbergt. */
async function toggleFloating() {
  if (!current || current.kind !== "web") return;
  try {
    const saved = await invoke<Source>("set_hide_floating", { id: current.id, hide: !current.hideFloating });
    if (current?.id !== saved.id) return;
    current = saved;
    renderStatus(saved);
    loadFrame(saved.id, true);
  } catch (err) {
    showError(err);
  }
}

/**
 * Springt naar alinea's en laat ze oplichten. De sitekopie staat in een iframe met sandbox="" en een CSP zonder
 * scripts: wij kunnen er niet in kijken en er draait niets in. Daarom vraagt de iframe een nieuw adres op. De server
 * van de app markeert de alinea's met een stijl in de pagina, en de browser scrolt zelf naar het anker. De afscherming
 * blijft precies zoals ze is.
 */
function jumpToParagraphs(ranges: ParagraphRange[]) {
  if (!current || !ranges.length) return;
  if (current.kind === "pdf") {
    const inRange = (n: number) => ranges.some(([a, b]) => a <= n && n <= b);
    const regions = current.blocks.filter((b) => inRange(b.n) && b.page && b.bbox).map((b) => ({ page: b.page!, bbox: b.bbox! }));
    void pdfHandle?.highlight(regions);
    return;
  }
  // Het eigen script in de kopie springt zonder herladen. Is het er (nog) niet, dan via een nieuw adres.
  if (frame.src.includes(`/${current.id}/`) && jumpInFrame(ranges)) return;
  lastHighlight = highlightParam(ranges);
  loadFrame(current.id);
}

// ---------- voorvertoning ----------

function renderPreviewStatus(text: string) {
  $("status").hidden = false;
  $("status-text").textContent = text;
  $("status-text").title = "";
  $("status-warnings").textContent = "";
  $("refresh").hidden = true;
  $("hide-floating").hidden = true;
}

/** Alvast de pagina tonen. Er is nog geen bron, dus alles wat een vaste kopie nodig heeft staat uit tot die er is. */
function showPreview(preview: PagePreview, url: string) {
  hideViews();
  current = null;
  clearNotice();
  setSource(null);
  document.title = `${preview.title} – Deepdive`;
  urlInput.value = url;
  $("empty").hidden = true;
  renderPreviewStatus(t("app.previewSaving"));
  setBusy(null);
  frame.hidden = false;
  frame.src = `${snapshotBase}/preview/${preview.id}/index.html`;
}

/**
 * De kopie staat op schijf. De lezer is intussen misschien al aan het lezen, en de afgeschermde iframe kan zijn
 * scrollpositie niet doorgeven. Daarom blijft het voorbeeld staan tot de lezer zelf de kopie kiest of ergens heen springt.
 */
async function adoptSaved(source: Source) {
  current = source;
  remember(source.id);
  document.title = `${source.title} – Deepdive`;
  renderStatus(source);
  renderSourceNotice(source);
  void setSource(source);
  $("show-saved").hidden = source.kind === "pdf";
  await refreshList();
}

void listen<PagePreview>("page-preview", ({ payload }) => {
  if (awaitingPreview?.request !== payload.request || awaitingPreview.token !== opening) return;
  showPreview(payload, awaitingPreview.url);
  awaitingPreview = null;
  previewShownFor = payload.request;
});

// ---------- invoer ----------

async function openUrl(url: string, refresh = false) {
  const trimmed = url.trim();
  if (!trimmed) return;
  clearError();
  const token = ++opening;
  const request = String(++previewRequests);
  awaitingPreview = { request, token, url: trimmed };
  setBusy(t("app.loadingPage"));
  try {
    const source = await invoke<Source>("open_url", { url: trimmed, refresh, previewRequest: request });
    if (token !== opening) {
      // De lezer is alweer verder. De kopie staat wel in de lijst.
      await refreshList();
      return;
    }
    if (previewShownFor === request) {
      await adoptSaved(source);
    } else {
      // Nu al: `show` begint een nieuwe opening, en dan slaat het opruimen hieronder over.
      setBusy(null);
      awaitingPreview = null;
      await show(source);
    }
  } catch (err) {
    if (token !== opening) return;
    if (previewShownFor === request) renderPreviewStatus(t("app.previewNotSaved"));
    showError(err, trimmed);
  } finally {
    if (token === opening) {
      setBusy(null);
      awaitingPreview = null;
    }
  }
}

async function openPdfFile(file: File) {
  clearError();
  setBusy(t("app.savingPdf"));
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
$("hide-floating").addEventListener("click", () => void toggleFloating());
$("show-saved").addEventListener("click", () => {
  if (current) loadFrame(current.id);
});
$("refresh").addEventListener("click", () => {
  if (current?.url) void refetch(current);
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
    else showError({ kind: "pdf", message: t("app.notPdf", { name: file.name }), detail: null });
    return;
  }
  const url = droppedUrl(data);
  if (url) void openUrl(url);
  else showError({ kind: "invalid_url", message: t("app.notUrlOrPdf"), detail: null });
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

// ---------- rechterpaneel ----------

function showPanel(which: "blueprint" | "answers") {
  for (const name of ["blueprint", "answers"] as const) {
    $(name).hidden = name !== which;
    $(`tab-${name}`).setAttribute("aria-selected", String(name === which));
  }
}
$("tab-blueprint").addEventListener("click", () => showPanel("blueprint"));
$("tab-answers").addEventListener("click", () => showPanel("answers"));

async function start() {
  await initLanguage();
  initSettings();
  initUpdate((err) => showError(err));
  renderAiLanguage(null);
  initSites();
  initBlueprint(jumpToParagraphs);
  initAnswers(jumpToParagraphs, () => showPanel("answers"));
  initReading({ frame, pdfView, pdf: () => pdfHandle, ask, error: (err) => showError(err) });
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
