// De antwoorden van de professor in het rechterpaneel, als gesprekken per selectie. Alles wat van het model komt gaat
// via textContent op het scherm (zie parseAnswer), dus tekst uit een bron of antwoord kan geen opmaak of script worden.
import { Channel, invoke } from "@tauri-apps/api/core";
import { modelName } from "./blueprintLogic";
import { currentProviders } from "./providers";
import { actionLabel, paragraphLabel, parseAnswer, type Action, type Inline } from "./readingLogic";
import { onLanguageChange, t } from "./i18n";
import type { Selected } from "./reading";
import type { AppError, ParagraphRange, Source } from "./types";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

interface Thread {
  id: string;
  sourceId: string;
  action: Action;
  selection: Selected;
  turns: Turn[];
  providerId: string;
  model: string;
  createdAt: string;
  stopped?: boolean;
}

type AskEvent = { type: "started"; thread: Thread } | { type: "thinking" } | { type: "text"; text: string };

/** Een vraag die nog loopt, of mislukte. Een nieuw gesprek heeft nog geen id tot het eerste bericht. */
interface Live {
  key: string;
  request: string;
  threadId: string | null;
  action: Action;
  selection: Selected;
  question: string | null;
  answer: string;
  thinking: boolean;
  error: AppError | null;
  stopping: boolean;
}

const root = () => document.getElementById("answers") as HTMLElement;
let source: Source | null = null;
let threads: Thread[] = [];
/** Lopende vragen: nieuwe gesprekken op hun eigen sleutel, vervolgvragen op het id van het gesprek. */
const live = new Map<string, Live>();
let requests = 0;
let jump: (ranges: ParagraphRange[]) => void = () => {};
let showTab: () => void = () => {};
let opening = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function toError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: t("common.genericError"), detail: String(err) };
}

// ---------- van buitenaf ----------

export function initAnswers(onJump: (ranges: ParagraphRange[]) => void, onShow: () => void) {
  jump = onJump;
  showTab = onShow;
  onLanguageChange(render);
  render();
}

export async function setAnswersSource(next: Source | null) {
  if (source?.id === next?.id) {
    source = next;
    return;
  }
  source = next;
  threads = [];
  const token = ++opening;
  render();
  if (!next) return;
  try {
    const list = await invoke<Thread[]>("list_threads", { sourceId: next.id });
    if (token !== opening) return;
    threads = list;
  } catch {
    // Zonder eerdere gesprekken kan de lezer gewoon verder.
  }
  render();
}

export function ask(action: Action, selection: Selected, question?: string) {
  if (!source) return;
  const key = `new-${++requests}`;
  const item: Live = { key, request: key, threadId: null, action, selection, question: question ?? null, answer: "", thinking: false, error: null, stopping: false };
  live.set(key, item);
  showTab();
  render();
  root().scrollTop = 0;
  void send(item, source.id, { action, selection, question: question ?? null });
}

function followUp(thread: Thread, question: string) {
  if (!source || live.has(thread.id)) return;
  const key = thread.id;
  const item: Live = { key, request: `follow-${++requests}`, threadId: thread.id, action: thread.action, selection: thread.selection, question, answer: "", thinking: false, error: null, stopping: false };
  live.set(key, item);
  render();
  void send(item, source.id, { threadId: thread.id, question });
}

async function send(item: Live, sourceId: string, args: Record<string, unknown>) {
  const channel = new Channel<AskEvent>();
  channel.onmessage = (event) => {
    if (event.type === "started") {
      item.threadId = event.thread.id;
    } else if (event.type === "thinking") {
      item.thinking = true;
    } else {
      item.thinking = false;
      item.answer += event.text;
    }
    renderLive(item);
  };
  try {
    const thread = await invoke<Thread>("ask_professor", { sourceId, requestId: item.request, onEvent: channel, ...args });
    live.delete(item.key);
    if (source?.id !== sourceId) return;
    threads = [...threads.filter((t) => t.id !== thread.id), thread];
    render();
  } catch (err) {
    item.error = toError(err);
    item.thinking = false;
    if (source?.id === sourceId) render();
  }
}

function stop(item: Live) {
  item.stopping = true;
  renderLive(item);
  void invoke("cancel_ask", { requestId: item.request });
}

async function removeThread(thread: Thread) {
  if (!source) return;
  try {
    await invoke("delete_thread", { sourceId: source.id, threadId: thread.id });
    threads = threads.filter((t) => t.id !== thread.id);
    render();
  } catch (err) {
    alert(toError(err).message);
  }
}

// ---------- tekenen ----------

function updateCount() {
  const n = threads.length + [...live.values()].filter((l) => !l.threadId || !threads.some((t) => t.id === l.threadId)).length;
  const count = document.getElementById("answers-count");
  if (count) count.textContent = n ? String(n) : "";
}

function render() {
  const r = root();
  updateCount();
  if (!source) {
    r.replaceChildren(el("p", "bp-empty", t("ans.noSource")));
    return;
  }
  const cards: HTMLElement[] = [];
  // Nieuwste bovenaan: een vraag die net is gesteld, staat meteen in beeld.
  for (const item of [...live.values()].reverse()) {
    if (!item.threadId || !threads.some((t) => t.id === item.threadId)) cards.push(newCard(item));
  }
  for (const thread of [...threads].reverse()) cards.push(threadCard(thread));
  if (!cards.length) {
    r.replaceChildren(
      el("p", "bp-empty", t("ans.empty")),
    );
    return;
  }
  r.replaceChildren(...cards);
}

/** Tijdens het streamen alleen het antwoord vervangen: de rest van het paneel blijft staan, ook een half getypte vervolgvraag. */
function renderLive(item: Live) {
  const card = root().querySelector<HTMLElement>(`[data-live="${item.key}"]`);
  if (!card) return render();
  const slot = card.querySelector<HTMLElement>(".ans-live");
  slot?.replaceWith(liveAnswer(item));
}

function inline(parts: Inline[]): Node[] {
  return parts.map((p) => {
    if (p.ref) {
      const ref = p.ref;
      const b = button(p.text, "bp-range", () => jump([ref]), t("ans.goTo", { where: p.text }));
      if (p.bold) b.classList.add("is-bold");
      return b;
    }
    return p.bold ? el("strong", "", p.text) : document.createTextNode(p.text);
  });
}

function answerBody(text: string): HTMLElement {
  const body = el("div", "ans-body");
  for (const block of parseAnswer(text)) {
    if (block.type === "p") {
      const p = el("p");
      p.append(...inline(block.inlines));
      body.append(p);
    } else {
      const ul = el("ul");
      for (const item of block.items) {
        const li = el("li");
        li.append(...inline(item));
        ul.append(li);
      }
      body.append(ul);
    }
  }
  return body;
}

function head(action: Action, selection: Selected, actions: HTMLElement[]): HTMLElement {
  const top = el("div", "ans-head");
  top.append(el("span", "ans-action", actionLabel(action)));
  const where = paragraphLabel(selection.from, selection.to);
  if (where && selection.from != null) {
    const range: ParagraphRange = [selection.from, selection.to ?? selection.from];
    top.append(button(where, "bp-range", () => jump([range]), t("ans.goTo", { where })));
  }
  top.append(el("span", "spacer"), ...actions);
  const quote = el("blockquote", "ans-quote", selection.text);
  if (selection.from != null) {
    const range: ParagraphRange = [selection.from, selection.to ?? selection.from];
    quote.addEventListener("click", () => jump([range]));
    quote.title = t("ans.goToPlace");
  }
  const wrap = el("div");
  wrap.append(top, quote);
  return wrap;
}

function question(text: string): HTMLElement {
  return el("p", "ans-question", text);
}

function liveAnswer(item: Live): HTMLElement {
  const box = el("div", "ans-live");
  if (item.answer) box.append(answerBody(item.answer));
  if (item.error) {
    const err = el("div", "notice notice-error");
    err.append(el("strong", "", item.error.message));
    if (item.error.detail) {
      const d = el("details");
      d.append(el("summary", "", t("common.technicalDetails")), el("code", "", item.error.detail));
      err.append(d);
    }
    box.append(err);
    return box;
  }
  const status = el("div", "ans-status");
  status.append(el("span", "ans-dots"), document.createTextNode(t(item.stopping ? "ans.stopping" : item.thinking ? "ans.thinking" : item.answer ? "ans.writing" : "ans.wait")));
  if (!item.stopping) status.append(button(t("common.stop"), "link", () => stop(item)));
  box.append(status);
  return box;
}

function newCard(item: Live): HTMLElement {
  const card = el("article", "ans-card");
  card.dataset.live = item.key;
  const close = item.error ? [button("×", "ans-close", () => {
    live.delete(item.key);
    render();
  }, t("common.remove"))] : [];
  card.append(head(item.action, item.selection, close));
  if (item.question) card.append(question(item.question));
  card.append(liveAnswer(item));
  return card;
}

function threadCard(thread: Thread): HTMLElement {
  const card = el("article", "ans-card");
  const running = live.get(thread.id);
  if (running) card.dataset.live = running.key;
  card.append(head(thread.action, thread.selection, [button("×", "ans-close", () => void removeThread(thread), t("ans.removeThread"))]));
  thread.turns.forEach((turn, i) => {
    if (turn.role === "user") {
      if (turn.text) card.append(question(turn.text));
    } else {
      card.append(answerBody(turn.text));
      if (i === thread.turns.length - 1 && thread.stopped) card.append(el("p", "ans-note", t("ans.stopped")));
    }
  });
  if (running) {
    card.append(question(running.question ?? ""), liveAnswer(running));
    if (running.error) {
      card.append(button(t("common.close"), "link", () => {
        live.delete(thread.id);
        render();
      }));
    }
  } else {
    const form = el("form", "ans-follow");
    form.autocomplete = "off";
    const input = el("input");
    input.type = "text";
    input.placeholder = t("ans.followUp");
    input.setAttribute("aria-label", t("ans.followUpLabel"));
    form.append(input);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (q) followUp(thread, q);
    });
    card.append(form);
  }
  const file = currentProviders();
  card.append(el("p", "ans-meta", modelName(file, thread.providerId, thread.model)));
  return card;
}
