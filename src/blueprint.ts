// De blauwdruk in het rechterpaneel: de knop, de voortgang en de drie lagen. Alles wat van het model komt gaat via
// textContent op het scherm, dus tekst uit een bron of antwoord kan hier geen opmaak of script worden.
import { Channel, invoke } from "@tauri-apps/api/core";
import { assignLanes, CATEGORY_LABELS, CERTAINTY_LABELS, errorView, formatRanges, GOAL_LABELS, isLocalModel, modelName, outcomes, pickSaved, pointsByAnchor, pointTarget, readableIds, RELATION_LABELS, ROLE_LABELS, sameModel, suggestModel, TEXT_KIND_LABELS, type ErrorAction } from "./blueprintLogic";
import { currentProviders, onProvidersChange, selectModel } from "./providers";
import type { AppError, Blueprint, Critique, DiagramBlock, DraftStructure, JobEvent, ModelRef, ParagraphRange, Point, Quote, Relation, Source, Stage, Structure } from "./types";

const root = () => document.getElementById("blueprint") as HTMLElement;
const KEYCHAIN_HINT_AFTER = 20;

interface Job {
  sourceId: string;
  /** Een tweede poging voor alleen de kritiek: de structuur staat dan al vast. */
  critiqueOf: Blueprint | null;
  previous: Blueprint | null;
  modelText: string;
  local: boolean;
  startedAt: number;
  stage: Stage;
  attempt: number;
  thinking: boolean;
  chars: number;
  draft: DraftStructure;
  structure: Blueprint | null;
  cancelling: boolean;
}

interface Panel {
  source: Source | null;
  saved: Blueprint[];
  shown: Blueprint | null;
  error: AppError | null;
  note: string | null;
  loaded: boolean;
}

const jobs = new Map<string, Job>();
const panel: Panel = { source: null, saved: [], shown: null, error: null, note: null, loaded: false };
let jump: (ranges: ParagraphRange[]) => void = () => {};
let selected: string | null = null;
const expanded = new Set<string>();
let opening = 0;
/** De nummers van de blokken op het scherm, voor tekst die een blok bij zijn interne id noemt. */
let numbers = new Map<string, number>();
const readable = (text: string) => readableIds(text, numbers);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void, id?: string): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  if (id) node.id = id;
  node.addEventListener("click", onClick);
  return node;
}

// ---------- van buitenaf ----------

export function initBlueprint(onJump: (ranges: ParagraphRange[]) => void) {
  jump = onJump;
  onProvidersChange(() => {
    if (panel.source && !jobs.has(panel.source.id) && panel.loaded) panel.shown = pickSaved(panel.saved, currentProviders().selection.active);
    render();
  });
  setInterval(tick, 1000);
  render();
  new ResizeObserver(() => drawArrows()).observe(root());
}

/** Een andere bron op het scherm. Wat voor een andere bron wordt gemaakt loopt gewoon door. */
export async function setBlueprintSource(source: Source | null) {
  const same = panel.source?.id === source?.id;
  panel.source = source;
  if (same) return render();
  const token = ++opening;
  Object.assign(panel, { saved: [], shown: null, error: null, note: null, loaded: false });
  selected = null;
  expanded.clear();
  render();
  if (!source) return;
  try {
    const saved = await invoke<Blueprint[]>("saved_blueprints", { sourceId: source.id });
    if (token !== opening) return;
    panel.saved = saved;
    panel.shown = pickSaved(saved, currentProviders().selection.active);
  } catch (err) {
    if (token !== opening) return;
    panel.error = toError(err);
  }
  panel.loaded = true;
  render();
}

function toError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: "Er ging iets mis. Probeer het opnieuw.", detail: String(err) };
}

// ---------- maken ----------

async function start(critiqueOf: Blueprint | null = null) {
  const source = panel.source;
  if (!source || jobs.has(source.id)) return;
  const file = currentProviders();
  const ref: ModelRef | null = critiqueOf ? { providerId: critiqueOf.providerId, modelId: critiqueOf.model } : file.selection.active;
  const job: Job = {
    sourceId: source.id,
    critiqueOf,
    previous: panel.shown,
    modelText: ref ? modelName(file, ref.providerId, ref.modelId) : "",
    local: isLocalModel(file, ref),
    startedAt: Date.now(),
    stage: critiqueOf ? "critique" : "structure",
    attempt: 1,
    thinking: false,
    chars: 0,
    draft: { blocks: [], relations: [] },
    structure: critiqueOf,
    cancelling: false,
  };
  jobs.set(source.id, job);
  panel.error = null;
  panel.note = null;
  selected = null;
  render();

  const channel = new Channel<JobEvent>();
  channel.onmessage = (event) => onEvent(job, event);
  const args: Record<string, unknown> = { sourceId: source.id, onEvent: channel };
  if (critiqueOf) args.critiqueOf = ref;
  try {
    const blueprint = await invoke<Blueprint>("generate_blueprint", args);
    finish(job, blueprint);
  } catch (err) {
    fail(job, toError(err));
  }
}

function onEvent(job: Job, event: JobEvent) {
  switch (event.type) {
    case "attempt":
      job.stage = event.stage;
      job.attempt = event.attempt;
      job.thinking = false;
      if (event.stage === "structure" && event.attempt > 1) job.draft = { blocks: [], relations: [] };
      break;
    case "alive":
      job.chars = event.chars;
      if (job.thinking !== event.thinking) {
        job.thinking = event.thinking;
        break;
      }
      return updateProgress();
    case "field":
      (job.draft as unknown as Record<string, unknown>)[event.name] = event.value;
      break;
    case "block":
      job.draft.blocks.push(event.value);
      break;
    case "structure":
      job.structure = event.blueprint;
      break;
  }
  if (panel.source?.id === job.sourceId) render();
}

/** Leest terug wat er nu bewaard is; dat kan intussen zijn veranderd. */
async function refreshSaved(sourceId: string): Promise<Blueprint[]> {
  try {
    return await invoke<Blueprint[]>("saved_blueprints", { sourceId });
  } catch {
    return panel.saved;
  }
}

async function finish(job: Job, blueprint: Blueprint) {
  jobs.delete(job.sourceId);
  const saved = await refreshSaved(job.sourceId);
  if (panel.source?.id !== job.sourceId) return;
  panel.saved = saved;
  panel.shown = blueprint;
  // Een mislukte poging laat een eerdere, volledige blauwdruk van hetzelfde model staan.
  if (!blueprint.critique && saved.some((b) => b.providerId === blueprint.providerId && b.model === blueprint.model && b.promptVersion === blueprint.promptVersion && b.critique)) {
    panel.note = "De eerder bewaarde blauwdruk van dit model blijft bewaard en komt terug als je dit stuk opnieuw opent.";
  }
  render();
}

async function fail(job: Job, error: AppError) {
  jobs.delete(job.sourceId);
  const saved = await refreshSaved(job.sourceId);
  if (panel.source?.id !== job.sourceId) return;
  panel.saved = saved;
  // Afgebroken of mislukt: wat er stond komt terug.
  panel.shown = job.previous ?? pickSaved(saved, currentProviders().selection.active);
  panel.error = error.kind === "cancelled" ? null : error;
  panel.note = error.kind === "cancelled" ? "Afgebroken. Er is niets bewaard." : null;
  render();
}

function cancel(job: Job) {
  job.cancelling = true;
  void invoke("cancel_blueprint", { sourceId: job.sourceId });
  render();
}

// ---------- tonen ----------

function render() {
  const out: Node[] = [];
  const source = panel.source;
  if (!source) {
    out.push(el("p", "bp-empty", "Open eerst een stuk. Daarna maakt de professor hier de samenvatting en de blauwdruk."));
    root().replaceChildren(...out);
    return;
  }
  const job = jobs.get(source.id) ?? null;
  const warning = warningText(source, job ? null : panel.shown);
  if (warning) out.push(warningBox(warning));

  if (job) out.push(progressBox(job));
  else if (panel.loaded) out.push(...controls());

  if (panel.error) out.push(errorBox(panel.error));
  if (panel.note) out.push(el("p", "bp-note", panel.note));

  if (job) {
    const structure: DraftStructure | Blueprint = job.structure ?? job.draft;
    out.push(...layers(structure, job.structure?.critique ?? null, job));
  } else if (panel.shown) {
    out.push(...layers(panel.shown, panel.shown.critique, null));
    out.push(...repairs(panel.shown));
  }
  root().replaceChildren(...out);
  drawArrows();
  updateProgress();
}

function warningText(source: Source, shown: Blueprint | null): string | null {
  if (shown?.source.warning) return shown.source.warning;
  if (source.completeness.verdict !== "likely_incomplete") return null;
  return `Dit stuk is waarschijnlijk onvolledig. ${source.completeness.reason}`.trim();
}

function warningBox(text: string): HTMLElement {
  const box = el("div", "bp-warning", text);
  box.id = "bp-warning";
  box.setAttribute("role", "note");
  return box;
}

function controls(): Node[] {
  const file = currentProviders();
  const active = file.selection.active;
  const out: Node[] = [];
  const shown = panel.shown;
  const local = isLocalModel(file, active);
  const activeName = active ? modelName(file, active.providerId, active.modelId) : null;

  if (shown) {
    const when = new Date(shown.createdAt).toLocaleString("nl-NL", { dateStyle: "medium", timeStyle: "short" });
    const row = el("div", "bp-meta");
    const text = el("p", "bp-meta-text");
    text.id = "bp-origin";
    text.append("Gemaakt met ", el("strong", "", modelName(file, shown.providerId, shown.model)), ` · ${when} · ${duration(shown.seconds)} · opdracht v${shown.promptVersion}`);
    row.append(text);
    const again = sameModel(shown, active) || !activeName ? "Opnieuw maken" : `Opnieuw maken met ${activeName}`;
    row.append(button(again, "", () => void start(), "bp-again"));
    out.push(row);
    if (local) out.push(el("p", "bp-hint bp-local", "Opnieuw maken met dit lokale model kan tot ongeveer een kwartier duren."));
    if (panel.saved.length > 1) out.push(savedPicker(file));
    const missing = critiqueMissing(shown);
    if (missing) out.push(missing);
  } else {
    const box = el("div", "bp-start");
    box.append(button("Maak samenvatting en blauwdruk", "primary", () => void start(), "bp-start"));
    if (activeName) box.append(el("p", "bp-hint", `Met ${activeName}. Je kunt het model bovenaan wijzigen.`));
    const suggestion = suggestModel(file);
    if (suggestion) {
      const offer = el("div", "bp-suggest");
      offer.id = "bp-suggest";
      offer.append(el("p", "", "Nog geen model gekozen. Je bent ingelogd met ChatGPT; dat was in de test snel en gaf weinig ruis. Jij kiest."));
      offer.append(button(`${suggestion.label} kiezen`, "", () => void selectModel(suggestion.ref), "bp-suggest-use"));
      box.append(offer);
    } else if (!active) {
      box.append(el("p", "bp-hint", "Kies eerst bovenaan een model."));
    }
    out.push(box);
    if (local) out.push(localNote());
  }
  return out;
}

function localNote(): HTMLElement {
  const note = el("p", "bp-hint bp-local", "Dit model draait op deze computer. Een blauwdruk kan dan lang duren: in de test tot ongeveer een kwartier. Je kunt intussen gewoon doorlezen.");
  note.id = "bp-local-note";
  return note;
}

function savedPicker(file: ReturnType<typeof currentProviders>): HTMLElement {
  const label = el("label", "bp-saved", "Bewaard");
  const select = el("select");
  select.id = "bp-saved";
  panel.saved.forEach((b, i) => {
    const when = new Date(b.createdAt).toLocaleDateString("nl-NL", { dateStyle: "medium" });
    select.add(new Option(`${modelName(file, b.providerId, b.model)} · v${b.promptVersion} · ${when}`, String(i)));
  });
  select.value = String(panel.saved.indexOf(panel.shown as Blueprint));
  select.addEventListener("change", () => {
    panel.shown = panel.saved[Number(select.value)];
    selected = null;
    render();
  });
  label.append(select);
  return label;
}

function duration(seconds: number): string {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function progressBox(job: Job): HTMLElement {
  const box = el("div", "bp-progress");
  box.id = "bp-progress";
  box.setAttribute("role", "status");
  const hasGoal = !!job.draft.message || !!job.structure;
  const hasDiagram = !!job.structure;
  const steps = el("ol", "bp-steps");
  const step = (text: string, state: "done" | "now" | "todo") => {
    const item = el("li", `bp-step bp-step-${state}`, text);
    item.dataset.state = state;
    return item;
  };
  steps.append(
    step("Doel en boodschap", hasGoal ? "done" : "now"),
    step("Diagram", hasDiagram ? "done" : hasGoal ? "now" : "todo"),
    step("Kritische laag", hasDiagram ? "now" : "todo"),
  );
  box.append(steps);
  const line = el("p", "bp-progress-line");
  line.id = "bp-progress-line";
  box.append(line);
  const actions = el("div", "bp-progress-actions");
  actions.append(button(job.cancelling ? "Afbreken…" : "Afbreken", "", () => cancel(job), "bp-cancel"));
  (actions.firstChild as HTMLButtonElement).disabled = job.cancelling;
  box.append(actions);
  if (job.local) box.append(localNote());
  return box;
}

function updateProgress() {
  const job = panel.source && jobs.get(panel.source.id);
  const line = document.getElementById("bp-progress-line");
  if (!job || !line) return;
  const seconds = (Date.now() - job.startedAt) / 1000;
  // Een testbouw zonder vaste handtekening kan hier stilstaan op een melding van macOS, die niet altijd vooraan staat.
  const waiting = !job.local && seconds > KEYCHAIN_HINT_AFTER ? "Wachten op het model. Vraagt macOS om toegang tot de sleutelhanger? Kies dan Altijd toestaan" : "Wachten op het model";
  const what = job.attempt > 1 ? "Tweede poging: het vorige antwoord klopte niet" : job.thinking ? "Het model denkt na" : job.chars ? "Het model schrijft" : waiting;
  line.textContent = `${job.modelText ? `${job.modelText}: ` : ""}${what} · ${duration(seconds)}`;
}

function tick() {
  if (panel.source && jobs.has(panel.source.id)) updateProgress();
}

function errorBox(error: AppError): HTMLElement {
  const view = errorView(error);
  const box = el("div", "notice notice-error bp-error");
  box.id = "bp-error";
  box.dataset.kind = error.kind;
  box.setAttribute("role", "alert");
  box.append(el("strong", "", view.title), el("p", "", view.text));
  const actions = el("div", "bp-actions");
  for (const action of view.actions) actions.append(errorAction(action));
  if (actions.childElementCount) box.append(actions);
  if (error.detail) {
    const more = el("details");
    more.append(el("summary", "", "Technische details"), el("code", "", error.detail));
    box.append(more);
  }
  return box;
}

function errorAction(action: ErrorAction): HTMLElement {
  switch (action) {
    case "providers":
      return button("Providers openen", "", () => document.getElementById("providers-open")?.click(), "bp-action-providers");
    case "usage":
      return button("Manage usage", "", () => void invoke("open_chatgpt_usage"), "bp-action-usage");
    case "picker":
      return button("Ander model kiezen", "", () => document.getElementById("model-picker")?.focus(), "bp-action-picker");
    case "retry":
      return button("Opnieuw proberen", "primary", () => void start(), "bp-action-retry");
  }
}

// ---------- de drie lagen ----------

function layers(structure: DraftStructure | Structure, critique: Critique | null, job: Job | null): Node[] {
  const out: Node[] = [];
  numbers = new Map(structure.blocks.map((b, i) => [b.id, i + 1]));
  const goal = goalLayer(structure);
  if (goal) out.push(goal);
  if (structure.blocks.length) out.push(diagramLayer(structure, critique));
  else if (job && structure.message) out.push(waiting("Het diagram wordt gemaakt…"));
  const critiqueSection = critiqueLayer(structure, critique, job);
  if (critiqueSection) out.push(critiqueSection);
  return out;
}

function waiting(text: string): HTMLElement {
  const box = el("p", "bp-waiting", text);
  return box;
}

function sectionHead(text: string): HTMLElement {
  return el("h2", "bp-head", text);
}

function goalLayer(s: DraftStructure | Structure): HTMLElement | null {
  if (!s.goal && !s.message && !s.textKind) return null;
  const box = el("section", "bp-goal");
  box.id = "bp-goal";
  if (s.textKind) box.append(el("p", "bp-kind", TEXT_KIND_LABELS[s.textKind] ?? s.textKind));
  if (s.goal?.main) {
    const line = el("p", "bp-purpose");
    line.append(el("span", "bp-label", GOAL_LABELS[s.goal.main.kind] ?? "Doel"), ` ${s.goal.main.description}`);
    box.append(line);
    for (const goal of s.goal.secondary ?? []) {
      const extra = el("p", "bp-purpose bp-secondary");
      extra.append(el("span", "bp-label", `Daarnaast: ${(GOAL_LABELS[goal.kind] ?? "doel").toLowerCase()}`), ` ${goal.description}`);
      box.append(extra);
    }
  }
  if (s.message) {
    const message = el("p", "bp-message", s.message);
    message.id = "bp-message";
    box.append(message);
  }
  if (s.occasion) {
    const line = el("p", "bp-occasion");
    line.append(el("span", "bp-label", "Aanleiding"), " ");
    line.append(originTag(s.occasion.origin), ` ${s.occasion.text} `);
    const ranges = s.occasion.paragraphs;
    if (ranges.length) line.append(rangeLink(ranges));
    box.append(line);
  }
  if (s.summary) {
    const summary = el("p", "bp-summary", s.summary);
    summary.id = "bp-summary";
    box.append(summary);
  }
  return box;
}

function originTag(origin: "stated" | "inferred"): HTMLElement {
  const tag = el("span", `bp-origin bp-origin-${origin}`, origin === "stated" ? "gezegd" : "afgeleid");
  tag.title = origin === "stated" ? "De tekst zegt dit zelf." : "De professor leidt dit af. De tekst zegt het niet zo.";
  return tag;
}

function rangeLink(ranges: ParagraphRange[]): HTMLElement {
  return button(formatRanges(ranges), "bp-range", () => jump(ranges));
}

function quoteBlock(quote: Quote): HTMLElement {
  const box = el("blockquote", "bp-quote");
  box.lang = panel.source?.lang ?? "";
  box.append(`“${quote.text}”`);
  box.append(" ", button(`¶${quote.paragraph}`, "bp-range", () => jump([[quote.paragraph, quote.paragraph]])));
  return box;
}

function diagramLayer(s: DraftStructure | Structure, critique: Critique | null): HTMLElement {
  const box = el("section", "bp-diagram-section");
  box.append(sectionHead("Levensloop van het betoog"));
  const diagram = el("div", "bp-diagram");
  diagram.id = "bp-diagram";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("bp-arrows");
  svg.setAttribute("aria-hidden", "true");
  diagram.append(svg);

  const number = new Map(s.blocks.map((b, i) => [b.id, i + 1]));
  const { attached } = pointsByAnchor(critique, [...s.blocks.map((b) => b.id), ...s.relations.map((r) => r.id)]);
  for (const block of s.blocks) {
    for (const relation of s.relations.filter((r) => r.block === block.id && number.has(r.dependsOn))) {
      diagram.append(relationRow(relation, number, block, attached.get(relation.id) ?? []));
    }
    diagram.append(blockCard(block, number.get(block.id) ?? 0, attached.get(block.id) ?? []));
  }
  box.append(diagram);
  return box;
}

function selectItem(id: string, ranges: ParagraphRange[]) {
  selected = id;
  if (ranges.length) jump(ranges);
  for (const node of root().querySelectorAll(".is-selected")) node.classList.remove("is-selected");
  root().querySelector(`[data-select="${CSS.escape(id)}"]`)?.classList.add("is-selected");
  drawArrows();
}

function relationRow(relation: Relation, number: Map<string, number>, target: DiagramBlock, points: Point[]): HTMLElement {
  const row = el("div", "bp-rel");
  row.dataset.rel = relation.id;
  row.dataset.select = relation.id;
  if (selected === relation.id) row.classList.add("is-selected");
  if (points.some((p) => p.polarity === "minus")) row.classList.add("has-minus");
  const head = el("button", "bp-rel-head");
  head.type = "button";
  head.append(el("span", "bp-rel-from", `van ${number.get(relation.dependsOn)}`), el("span", "bp-rel-kind", RELATION_LABELS[relation.kind] ?? relation.kind), relation.explanation ? ` ${readable(relation.explanation)}` : "");
  head.addEventListener("click", () => selectItem(relation.id, target.paragraphs));
  row.append(head);
  if (points.length) row.append(pointList(points));
  return row;
}

function blockCard(block: DiagramBlock, n: number, points: Point[]): HTMLElement {
  const card = el("article", "bp-block");
  card.dataset.block = block.id;
  card.dataset.select = block.id;
  card.dataset.role = block.role;
  if (selected === block.id) card.classList.add("is-selected");
  const head = el("button", "bp-block-head");
  head.type = "button";
  const top = el("span", "bp-block-top");
  top.append(el("span", "bp-num", String(n)), el("span", "bp-role", ROLE_LABELS[block.role] ?? block.role));
  if (block.paragraphs.length) top.append(el("span", "bp-para", formatRanges(block.paragraphs)));
  head.append(top, el("span", "bp-title", block.title), el("span", "bp-content", readable(block.content)));
  head.addEventListener("click", () => selectItem(block.id, block.paragraphs));
  card.append(head);
  if (block.quote) card.append(quoteBlock(block.quote));
  if (points.length) card.append(pointList(points));
  return card;
}

function pointList(points: Point[]): HTMLElement {
  const list = el("ul", "bp-points");
  for (const point of points) list.append(pointItem(point));
  return list;
}

function pointItem(point: Point): HTMLElement {
  const item = el("li", `bp-point bp-point-${point.polarity} bp-point-${point.origin}`);
  item.dataset.point = point.id;
  item.dataset.select = point.id;
  item.dataset.origin = point.origin;
  if (selected === point.id) item.classList.add("is-selected");
  const head = el("button", "bp-point-head");
  head.type = "button";
  const open = expanded.has(point.id);
  head.setAttribute("aria-expanded", String(open));
  const top = el("span", "bp-point-top");
  const sign = el("span", "bp-sign", point.polarity === "plus" ? "+" : "−");
  sign.title = point.polarity === "plus" ? "Maakt het betoog sterker" : "Maakt het betoog zwakker";
  top.append(sign, el("span", "bp-category", CATEGORY_LABELS[point.category] ?? point.category), originTag(point.origin));
  head.append(top, el("span", "bp-claim", readable(point.claim)));
  head.addEventListener("click", () => {
    if (expanded.has(point.id)) expanded.delete(point.id);
    else expanded.add(point.id);
    selected = point.id;
    jump(pointTarget(point));
    render();
  });
  item.append(head);
  if (open) {
    const more = el("div", "bp-point-more");
    more.append(el("p", "", readable(point.explanation)));
    for (const quote of point.quotes) more.append(quoteBlock(quote));
    const foot = el("p", "bp-point-foot");
    foot.append(el("span", "bp-certainty", CERTAINTY_LABELS[point.certainty]));
    if (point.paragraphs.length) foot.append(" ", rangeLink(pointTarget(point)));
    if (point.broad) foot.append(el("span", "bp-broad", `Geldt voor een groot deel van het stuk (${formatRanges(point.paragraphs)}). Springen gaat naar het begin.`));
    more.append(foot);
    item.append(more);
  }
  return item;
}

function critiqueLayer(s: DraftStructure | Structure, critique: Critique | null, job: Job | null): HTMLElement | null {
  if (!critique && (!job || !job.structure)) return null;
  const box = el("section", "bp-critique");
  box.id = "bp-critique";
  box.append(sectionHead("Kritische laag"));
  if (critique) {
    box.append(el("p", "bp-overall", readable(critique.overall)));
    const list = el("dl", "bp-outcomes");
    list.id = "bp-outcomes";
    for (const outcome of outcomes(critique)) {
      const line = el("div", `bp-outcome bp-outcome-${outcome.result}`);
      line.dataset.category = outcome.category;
      line.dataset.result = outcome.result;
      line.append(el("dt", "", outcome.label), el("dd", "", outcome.note ? `${outcome.text}. ${outcome.note}` : outcome.text));
      list.append(line);
    }
    box.append(list);
    if (!critique.points.length) box.append(el("p", "bp-nothing", "De professor vond geen zwakke plekken om te noemen. Dat is een uitkomst, geen ontbrekend deel."));
    const { loose } = pointsByAnchor(critique, [...s.blocks.map((b) => b.id), ...s.relations.map((r) => r.id)]);
    if (loose.length) {
      box.append(el("h3", "bp-subhead", "Hoort niet bij één stap"));
      box.append(pointList(loose));
    }
    if (critique.terms.length) {
      const terms = el("details", "bp-terms");
      terms.id = "bp-terms";
      terms.append(el("summary", "", `Begrippen (${critique.terms.length}): hulp bij het lezen, geen kritiek`));
      const list2 = el("dl");
      for (const term of critique.terms) {
        const line = el("div");
        const dt = el("dt", "", term.term);
        const dd = el("dd", "", `${term.explanation} `);
        if (term.paragraphs.length) dd.append(rangeLink([[term.paragraphs[0][0], term.paragraphs[0][0]]]));
        line.append(dt, dd);
        list2.append(line);
      }
      terms.append(list2);
      box.append(terms);
    }
    return box;
  }
  box.append(waiting("De kritische laag wordt gemaakt. Doel en diagram staan al vast."));
  return box;
}

/** Staat bovenaan, want onder een lang diagram zou niemand zien dat er iets ontbreekt. */
function critiqueMissing(shown: Blueprint): HTMLElement | null {
  if (shown.critique) return null;
  const failed = shown.issues.find((i) => i.code === "critique_failed");
  const stopped = shown.issues.find((i) => i.code === "critique_cancelled");
  const notice = el("div", failed ? "notice notice-error bp-critique-missing" : "notice bp-critique-missing");
  notice.id = "bp-critique-missing";
  if (failed) notice.append(el("strong", "", "De kritische laag is niet gelukt. Doel en diagram blijven staan."), el("p", "", failed.detail));
  else notice.append(el("p", "", stopped ? "De kritische laag is afgebroken. Doel en diagram zijn bewaard." : "De kritische laag ontbreekt nog. Doel en diagram zijn bewaard."));
  notice.append(button("Alleen de kritische laag maken", "primary", () => void start(shown), "bp-critique-retry"));
  return notice;
}

const HIDDEN_ISSUES = new Set(["critique_failed", "critique_cancelled"]);

/** Wat de controle heeft hersteld of gemarkeerd. Niets verdwijnt stilletjes, maar het is ook niet het belangrijkste. */
function repairs(b: Blueprint): Node[] {
  const issues = b.issues.filter((i) => !HIDDEN_ISSUES.has(i.code));
  if (!issues.length) return [];
  const box = el("details", "bp-repairs");
  box.id = "bp-repairs";
  box.append(el("summary", "", issues.length === 1 ? "De controle heeft 1 ding hersteld of gemarkeerd" : `De controle heeft ${issues.length} dingen hersteld of gemarkeerd`));
  const list = el("ul");
  for (const issue of issues) list.append(el("li", "", issue.detail));
  box.append(list);
  return [box];
}

// ---------- pijlen ----------

const SVG = "http://www.w3.org/2000/svg";
const LANE_WIDTH = 9;
const GUTTER_PAD = 10;

/** Tekent de pijlen links van de blokken, nadat de blokken hun hoogte hebben gekregen. */
function drawArrows() {
  const diagram = document.getElementById("bp-diagram");
  const svg = diagram?.querySelector("svg");
  if (!diagram || !svg) return;
  const source = panel.source && jobs.get(panel.source.id);
  const data: DraftStructure | Blueprint | null = source ? (source.structure ?? source.draft) : panel.shown;
  if (!data) return;
  const lanes = assignLanes(data.blocks, data.relations);
  const used = lanes.reduce((max, l) => Math.max(max, l.lane + 1), 1);
  const gutter = GUTTER_PAD + used * LANE_WIDTH;
  diagram.style.setProperty("--bp-gutter", `${gutter}px`);
  const box = diagram.getBoundingClientRect();
  svg.setAttribute("width", String(gutter));
  svg.setAttribute("height", String(diagram.scrollHeight));
  svg.replaceChildren();
  for (const lane of lanes) {
    const from = diagram.querySelector<HTMLElement>(`[data-block="${CSS.escape(lane.relation.dependsOn)}"]`);
    const to = diagram.querySelector<HTMLElement>(`[data-rel="${CSS.escape(lane.relation.id)}"]`);
    if (!from || !to) continue;
    const a = from.getBoundingClientRect();
    const b = to.getBoundingClientRect();
    const y1 = a.bottom - box.top - 14;
    const y2 = b.top - box.top + 11;
    const x = gutter - 6 - lane.lane * LANE_WIDTH;
    const down = y2 >= y1 ? 1 : -1;
    const r = Math.min(5, Math.abs(y2 - y1) / 2);
    const d = `M ${gutter} ${y1} H ${x + r} Q ${x} ${y1} ${x} ${y1 + down * r} V ${y2 - down * r} Q ${x} ${y2} ${x + r} ${y2} H ${gutter - 4}`;
    const group = document.createElementNS(SVG, "g");
    group.classList.add("bp-arrow");
    if (to.classList.contains("has-minus")) group.classList.add("has-minus");
    if (selected === lane.relation.id) group.classList.add("is-selected");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", d);
    const head = document.createElementNS(SVG, "path");
    head.setAttribute("d", `M ${gutter - 4} ${y2 - 3.5} L ${gutter} ${y2} L ${gutter - 4} ${y2 + 3.5} Z`);
    head.classList.add("bp-arrow-head");
    group.append(path, head);
    svg.append(group);
  }
}
