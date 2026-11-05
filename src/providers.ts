// Het providerscherm en de modelkiezer. Een sleutel gaat alleen de richting van Rust op: het veld wordt na
// opslaan geleegd en de app krijgt alleen `hasKey` terug.
import { Channel, invoke } from "@tauri-apps/api/core";
import { countSummary, describeReport, filterModels, imagesToValue, modelCount, modelLabel, parseContext, parseRefValue, pickerGroups, PRESETS, refValue, testModel, valueToImages } from "./providerLogic";
import type { ApiKind, AppError, ConnectionReport, KeyChange, Model, Provider, ProvidersFile, StreamEvent } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const dialog = $<HTMLDialogElement>("providers-dialog");
const picker = $<HTMLSelectElement>("model-picker");
const list = $("provider-list");
const form = $<HTMLFormElement>("provider-form");
const presetRow = $("provider-preset-row");
const presetSelect = $<HTMLSelectElement>("provider-preset");
const nameInput = $<HTMLInputElement>("provider-name");
const kindSelect = $<HTMLSelectElement>("provider-kind");
const urlInput = $<HTMLInputElement>("provider-url");
const keyInput = $<HTMLInputElement>("provider-key");
const keyState = $("provider-key-state");
const keyClear = $<HTMLButtonElement>("provider-key-clear");
const removeButton = $<HTMLButtonElement>("provider-delete");
const testButton = $<HTMLButtonElement>("provider-test");
const result = $("provider-result");
const modelsSection = $("models-section");
const modelsBody = $("models-body");
const modelsFilter = $<HTMLInputElement>("models-filter");
const modelsCount = $("models-count");
const refreshButton = $<HTMLButtonElement>("models-refresh");
const modelsResult = $("models-result");

let data: ProvidersFile = { schemaVersion: 1, providers: [], selection: { active: null, perAction: {} } };
let selectedId: string | null = null;

const selected = () => data.providers.find((p) => p.id === selectedId) ?? null;

function toError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: "Er ging iets mis. Probeer het opnieuw.", detail: String(err) };
}

function showMessage(target: HTMLElement, tone: "ok" | "error" | "busy", message: string, detail?: string | null) {
  target.hidden = false;
  target.className = `notice notice-${tone}`;
  const text = document.createElement("span");
  text.textContent = message;
  target.replaceChildren(text);
  if (detail) {
    const more = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Technische details";
    const code = document.createElement("code");
    code.textContent = detail;
    more.append(summary, code);
    target.append(more);
  }
}

function showError(target: HTMLElement, err: unknown) {
  const e = toError(err);
  showMessage(target, "error", e.message, e.detail);
}

function clearMessage(target: HTMLElement) {
  target.hidden = true;
  target.replaceChildren();
}

function replaceProvider(provider: Provider) {
  const index = data.providers.findIndex((p) => p.id === provider.id);
  if (index >= 0) data.providers[index] = provider;
  else data.providers.push(provider);
}

/** Na een wijziging kan de keuze zijn vervallen; die staat in Rust, dus altijd opnieuw lezen. */
async function reload() {
  data = await invoke<ProvidersFile>("list_providers");
  renderPicker();
}

// ---------- modelkiezer ----------

function renderPicker() {
  const groups = pickerGroups(data);
  const placeholder = new Option(groups.length ? "Kies een model" : "Nog geen model ingesteld", "");
  picker.replaceChildren(placeholder);
  for (const group of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const option of group.options) optgroup.append(new Option(option.label, option.value));
    picker.append(optgroup);
  }
  picker.value = data.selection.active ? refValue(data.selection.active) : "";
  picker.disabled = groups.length === 0;
}

picker.addEventListener("change", async () => {
  try {
    await invoke("select_model", { selection: parseRefValue(picker.value) });
  } finally {
    // Ook als het mislukt: de kiezer toont altijd wat er echt is opgeslagen.
    await reload();
  }
});

// ---------- lijst en formulier ----------

function renderList() {
  list.replaceChildren(
    ...data.providers.map((p) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = p.id === selectedId ? "provider-item current" : "provider-item";
      button.textContent = p.name;
      button.addEventListener("click", () => select(p.id));
      const item = document.createElement("li");
      item.append(button);
      return item;
    }),
  );
}

function renderKeyState(provider: Provider | null) {
  const has = provider?.hasKey ?? false;
  keyState.textContent = has ? "Er is een sleutel ingesteld, bewaard in de sleutelhanger. Laat dit veld leeg om hem te houden." : "Wordt alleen in de sleutelhanger van deze Mac bewaard.";
  keyInput.placeholder = has ? "••••••••" : "Geen sleutel";
  keyClear.hidden = !has;
}

function resetDeleteButton() {
  removeButton.textContent = "Provider verwijderen";
  removeButton.dataset.armed = "";
}

function select(id: string | null) {
  selectedId = id;
  const provider = selected();
  presetRow.hidden = provider !== null;
  removeButton.hidden = provider === null;
  resetDeleteButton();
  modelsSection.hidden = provider === null;
  keyInput.value = "";
  modelsFilter.value = "";
  clearMessage(result);
  clearMessage(modelsResult);
  if (provider) {
    nameInput.value = provider.name;
    kindSelect.value = provider.kind;
    urlInput.value = provider.baseUrl;
    renderModels();
  } else {
    presetSelect.value = "ollama";
    applyPreset();
  }
  renderKeyState(provider);
  renderList();
}

function applyPreset() {
  const preset = PRESETS.find((p) => p.id === presetSelect.value) ?? PRESETS[0];
  nameInput.value = preset.name;
  kindSelect.value = preset.kind;
  urlInput.value = preset.baseUrl;
  keyState.textContent = `${preset.keyHint} Wordt alleen in de sleutelhanger van deze Mac bewaard.`;
}

async function saveForm(key?: KeyChange): Promise<Provider> {
  const typed = keyInput.value.trim();
  const change: KeyChange = key ?? (typed ? { action: "set", value: typed } : { action: "keep" });
  const provider = await invoke<Provider>("save_provider", {
    input: { id: selectedId, name: nameInput.value, kind: kindSelect.value as ApiKind, baseUrl: urlInput.value },
    key: change,
  });
  replaceProvider(provider);
  const wasNew = selectedId === null;
  selectedId = provider.id;
  keyInput.value = "";
  urlInput.value = provider.baseUrl;
  await reload();
  if (wasNew) select(provider.id);
  else {
    renderKeyState(provider);
    renderList();
  }
  return provider;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await saveForm();
    showMessage(result, "ok", "Opgeslagen.");
  } catch (err) {
    showError(result, err);
  }
});

presetSelect.addEventListener("change", applyPreset);
$("provider-new").addEventListener("click", () => select(null));

keyClear.addEventListener("click", async () => {
  try {
    await saveForm({ action: "clear" });
    showMessage(result, "ok", "De sleutel is uit de sleutelhanger verwijderd.");
  } catch (err) {
    showError(result, err);
  }
});

// Eerst bevestigen met een tweede klik: dit haalt ook de sleutel weg.
removeButton.addEventListener("click", async () => {
  if (!selectedId) return;
  if (removeButton.dataset.armed !== "yes") {
    removeButton.textContent = "Echt verwijderen, ook de sleutel?";
    removeButton.dataset.armed = "yes";
    return;
  }
  try {
    await invoke("delete_provider", { id: selectedId });
    await reload();
    select(data.providers[0]?.id ?? null);
  } catch (err) {
    showError(result, err);
  }
});

// ---------- verbindingstest ----------

testButton.addEventListener("click", async () => {
  testButton.disabled = true;
  try {
    const provider = await saveForm();
    const onEvent = new Channel<StreamEvent>();
    let sample = "";
    onEvent.onmessage = (event) => {
      if (event.type === "text") {
        sample += event.text;
        showMessage(result, "busy", `Antwoord komt binnen: ${sample}`);
      }
    };
    showMessage(result, "busy", "Bezig met testen…");
    const report = await invoke<ConnectionReport>("test_connection", { providerId: provider.id, modelId: testModel(provider, data.selection.active), onEvent });
    showMessage(result, "ok", describeReport(report));
  } catch (err) {
    showError(result, err);
  } finally {
    testButton.disabled = false;
  }
});

// ---------- modellen ----------

function renderModels() {
  const provider = selected();
  if (!provider) return;
  const shown = filterModels(provider.models, modelsFilter.value);
  modelsCount.textContent = countSummary(provider.models);
  modelsFilter.hidden = provider.models.length <= 8;
  modelsBody.replaceChildren(...shown.map((m) => modelRow(provider.id, m)));
  modelsBody.parentElement!.hidden = shown.length === 0;
}

function modelRow(providerId: string, model: Model): HTMLElement {
  const row = document.createElement("tr");

  const enabled = document.createElement("input");
  enabled.type = "checkbox";
  enabled.checked = model.enabled;
  enabled.setAttribute("aria-label", `${model.id} in de kiezer`);

  const name = document.createElement("td");
  name.className = "model-name";
  name.textContent = modelLabel(model);
  name.title = model.id;

  const images = document.createElement("select");
  images.setAttribute("aria-label", `${model.id} kan afbeeldingen lezen`);
  images.append(new Option("Onbekend", ""), new Option("Ja", "yes"), new Option("Nee", "no"));
  images.value = imagesToValue(model.supportsImages);

  const context = document.createElement("input");
  context.type = "text";
  context.inputMode = "numeric";
  context.placeholder = "onbekend";
  context.value = model.contextTokens?.toString() ?? "";
  context.setAttribute("aria-label", `${model.id} context in tokens`);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link";
  remove.textContent = "Weghalen";

  const save = async () => {
    const tokens = parseContext(context.value);
    if (tokens === undefined) {
      showMessage(modelsResult, "error", `"${context.value}" is geen geldig aantal tokens. Vul een getal in, of laat het leeg als het onbekend is.`);
      context.focus();
      return;
    }
    clearMessage(modelsResult);
    try {
      const provider = await invoke<Provider>("save_model", { providerId, input: { id: model.id, supportsImages: valueToImages(images.value), contextTokens: tokens, enabled: enabled.checked } });
      replaceProvider(provider);
      await reload();
      modelsCount.textContent = countSummary(provider.models);
    } catch (err) {
      showError(modelsResult, err);
    }
  };
  enabled.addEventListener("change", save);
  images.addEventListener("change", save);
  context.addEventListener("change", save);
  remove.addEventListener("click", async () => {
    try {
      replaceProvider(await invoke<Provider>("delete_model", { providerId, modelId: model.id }));
      await reload();
      renderModels();
    } catch (err) {
      showError(modelsResult, err);
    }
  });

  const cell = (...children: HTMLElement[]) => {
    const td = document.createElement("td");
    td.append(...children);
    return td;
  };
  row.append(cell(enabled), name, cell(images), cell(context), cell(remove));
  return row;
}

modelsFilter.addEventListener("input", renderModels);

refreshButton.addEventListener("click", async () => {
  if (!selectedId) return;
  refreshButton.disabled = true;
  showMessage(modelsResult, "busy", "Modellen worden opgehaald…");
  try {
    const provider = await saveForm();
    const updated = await invoke<Provider>("refresh_models", { providerId: provider.id });
    replaceProvider(updated);
    await reload();
    renderModels();
    const hidden = updated.models.filter((m) => !m.enabled).length;
    const note = hidden ? ` ${hidden} staan niet in de kiezer; vink aan welke je wilt gebruiken.` : "";
    showMessage(modelsResult, "ok", `${modelCount(updated.models.length)} gevonden.${note}`);
  } catch (err) {
    const e = toError(err);
    showMessage(modelsResult, "error", `${e.message} Je kunt een model ook hieronder zelf toevoegen.`, e.detail);
  } finally {
    refreshButton.disabled = false;
  }
});

$<HTMLFormElement>("model-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!selectedId) return;
  const idInput = $<HTMLInputElement>("model-add-id");
  const tokensInput = $<HTMLInputElement>("model-add-context");
  const tokens = parseContext(tokensInput.value);
  if (tokens === undefined) {
    showMessage(modelsResult, "error", `"${tokensInput.value}" is geen geldig aantal tokens.`);
    return;
  }
  try {
    const input = { id: idInput.value, supportsImages: valueToImages($<HTMLSelectElement>("model-add-images").value), contextTokens: tokens, enabled: true };
    replaceProvider(await invoke<Provider>("save_model", { providerId: selectedId, input }));
    idInput.value = "";
    tokensInput.value = "";
    clearMessage(modelsResult);
    await reload();
    renderModels();
  } catch (err) {
    showError(modelsResult, err);
  }
});

// ---------- openen ----------

function open() {
  select(selected()?.id ?? data.providers[0]?.id ?? null);
  dialog.showModal();
}

export async function initProviders() {
  for (const preset of PRESETS) presetSelect.add(new Option(preset.label, preset.id));
  $("providers-open").addEventListener("click", open);
  $("providers-close").addEventListener("click", () => dialog.close());
  await reload();
}
