// Het providerscherm en de modelkiezer. Een sleutel gaat alleen de richting van Rust op: het veld wordt na
// opslaan geleegd en de app krijgt alleen `hasKey` terug.
import { Channel, invoke } from "@tauri-apps/api/core";
import { onLanguageChange, plural, t } from "./i18n";
import { chatgptState, chatgptStatus, countSummary, describeReport, filterModels, imagesToValue, modelCount, modelLabel, parseContext, parseRefValue, pickerGroups, presetKeyHint, presetLabel, PRESETS, refValue, testModel, usesChatgptPlan, valueToImages } from "./providerLogic";
import type { ApiKind, AppError, ConnectionReport, KeyChange, LoginOutcome, LogoutOutcome, Model, ModelRef, Provider, ProvidersFile, StreamEvent } from "./types";

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
const apiFields = $("provider-api-fields");
const chatgptOffer = $("chatgpt-offer");
const chatgptContinue = $<HTMLButtonElement>("chatgpt-continue");
const chatgptCancel = $<HTMLButtonElement>("chatgpt-cancel");
const chatgptAccount = $("chatgpt-account");
const chatgptAccountStatus = $("chatgpt-account-status");
const chatgptSignin = $<HTMLButtonElement>("chatgpt-signin");
const chatgptEnable = $<HTMLButtonElement>("chatgpt-enable");
const chatgptSignout = $<HTMLButtonElement>("chatgpt-signout");
const chatgptAccountCancel = $<HTMLButtonElement>("chatgpt-account-cancel");
const planBadge = $("chatgpt-plan-badge");
const welcome = $<HTMLDialogElement>("chatgpt-welcome");

let data: ProvidersFile = { schemaVersion: 1, providers: [], selection: { active: null, perAction: {} } };
let selectedId: string | null = null;

const selected = () => data.providers.find((p) => p.id === selectedId) ?? null;

const changeListeners: (() => void)[] = [];

/** Wat er nu is ingesteld. Het blauwdrukpaneel leest hier het gekozen model uit. */
export const currentProviders = () => data;

export function onProvidersChange(listener: () => void) {
  changeListeners.push(listener);
}

/** Kiest een model namens de lezer, alleen na een klik van de lezer zelf. */
export async function selectModel(selection: ModelRef) {
  await invoke("select_model", { selection });
  await reload();
}

function toError(err: unknown): AppError {
  if (err && typeof err === "object" && "message" in err) return err as AppError;
  return { kind: "unknown", message: t("common.genericError"), detail: String(err) };
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
    summary.textContent = t("common.technicalDetails");
    const code = document.createElement("code");
    code.textContent = detail;
    more.append(summary, code);
    target.append(more);
  }
}

function openUsage() {
  invoke("open_chatgpt_usage").catch((err) => showError(result, err));
}

function showError(target: HTMLElement, err: unknown) {
  const e = toError(err);
  showMessage(target, "error", e.message, e.detail);
  if (e.kind === "chatgpt_usage_limit") {
    const manage = document.createElement("button");
    manage.type = "button";
    manage.className = "primary notice-action";
    manage.textContent = t("providers.manageUsage");
    manage.addEventListener("click", openUsage);
    target.append(manage);
  }
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

function renderPicker(notify = true) {
  const groups = pickerGroups(data);
  const placeholder = new Option(groups.length ? t("providers.chooseModel") : t("providers.noModelSet"), "");
  picker.replaceChildren(placeholder);
  for (const group of groups) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.label;
    for (const option of group.options) optgroup.append(new Option(option.label, option.value));
    picker.append(optgroup);
  }
  picker.value = data.selection.active ? refValue(data.selection.active) : "";
  picker.disabled = groups.length === 0;
  planBadge.hidden = !usesChatgptPlan(data);
  if (notify) for (const listener of changeListeners) listener();
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
  keyState.textContent = has ? t("providers.keySet") : t("providers.keyStoredLocally");
  keyInput.placeholder = has ? "••••••••" : t("providers.noKey");
  keyClear.hidden = !has;
}

function resetDeleteButton() {
  removeButton.textContent = t("providers.delete");
  removeButton.dataset.armed = "";
}

function select(id: string | null) {
  selectedId = id;
  const provider = selected();
  const isChatgpt = provider?.kind === "chatgpt_plan";
  presetRow.hidden = provider !== null;
  apiFields.hidden = isChatgpt;
  chatgptOffer.hidden = provider !== null;
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
  renderChatgptAccount(provider);
  renderList();
}

function applyPreset() {
  const preset = PRESETS.find((p) => p.id === presetSelect.value) ?? PRESETS[0];
  nameInput.value = preset.name;
  kindSelect.value = preset.kind;
  urlInput.value = preset.baseUrl;
  renderPresetHint();
}

function renderPresetHint() {
  const preset = PRESETS.find((p) => p.id === presetSelect.value) ?? PRESETS[0];
  keyState.textContent = `${presetKeyHint(preset)} ${t("providers.keyStoredLocally")}`;
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
    showMessage(result, "ok", t("providers.saved"));
  } catch (err) {
    showError(result, err);
  }
});

presetSelect.addEventListener("change", applyPreset);
$("provider-new").addEventListener("click", () => select(null));

keyClear.addEventListener("click", async () => {
  try {
    await saveForm({ action: "clear" });
    showMessage(result, "ok", t("providers.keyRemoved"));
  } catch (err) {
    showError(result, err);
  }
});

// Eerst bevestigen met een tweede klik: dit haalt ook de sleutel weg.
removeButton.addEventListener("click", async () => {
  if (!selectedId) return;
  if (removeButton.dataset.armed !== "yes") {
    removeButton.textContent = t("providers.confirmDelete");
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

// ---------- ChatGPT ----------

let loginBusy = false;

function renderChatgptAccount(provider: Provider | null) {
  chatgptAccount.hidden = provider?.kind !== "chatgpt_plan";
  chatgptContinue.disabled = loginBusy;
  chatgptCancel.hidden = !loginBusy;
  chatgptAccountCancel.hidden = !loginBusy;
  if (provider?.kind !== "chatgpt_plan") return;
  const state = chatgptState(provider);
  chatgptAccountStatus.textContent = chatgptStatus(provider);
  chatgptSignin.hidden = state === "ready" || state === "plan_disabled";
  chatgptEnable.hidden = state !== "plan_disabled";
  chatgptSignout.hidden = !provider.hasKey;
  chatgptSignin.disabled = loginBusy;
  chatgptEnable.disabled = loginBusy;
}

/** Een geweigerde of mislukte login geeft alleen een melding; de rest van de app blijft werken. */
async function chatgptLogin(providerId: string | null, askConsent: boolean) {
  loginBusy = true;
  renderChatgptAccount(selected());
  showMessage(result, "busy", t("providers.loginWaiting"));
  try {
    const outcome = await invoke<LoginOutcome>("chatgpt_login", { providerId, askConsent });
    loginBusy = false;
    await reload();
    select(outcome.provider.id);
    if (outcome.modelsError) showMessage(result, "error", t("providers.loginModelsError", { message: outcome.modelsError.message }), outcome.modelsError.detail);
    else showMessage(result, "ok", chatgptStatus(outcome.provider));
    if (outcome.showWelcome) welcome.showModal();
  } catch (err) {
    loginBusy = false;
    renderChatgptAccount(selected());
    if (toError(err).kind === "chatgpt_login_cancelled") clearMessage(result);
    else showError(result, err);
  }
}

/** Rust kan tijdens een verzoek ontdekken dat de sessie is ingetrokken; dan moet het scherm dat ook weten. */
async function syncAfterChatgptError(err: unknown) {
  if (!toError(err).kind.startsWith("chatgpt_")) return;
  await reload();
  renderChatgptAccount(selected());
}

chatgptContinue.addEventListener("click", () => chatgptLogin(null, false));
chatgptSignin.addEventListener("click", () => chatgptLogin(selectedId, false));
// Alleen hier vraagt de app expliciet opnieuw om toestemming, omdat de gebruiker dat zelf kiest.
chatgptEnable.addEventListener("click", () => chatgptLogin(selectedId, true));
for (const button of [chatgptCancel, chatgptAccountCancel]) button.addEventListener("click", () => invoke("chatgpt_cancel_login"));

chatgptSignout.addEventListener("click", async () => {
  if (!selectedId) return;
  try {
    const outcome = await invoke<LogoutOutcome>("chatgpt_logout", { providerId: selectedId });
    await reload();
    select(outcome.provider.id);
    if (outcome.revoked) showMessage(result, "ok", t("providers.logoutRevoked"));
    else showMessage(result, "error", t("providers.logoutUnconfirmed"));
  } catch (err) {
    showError(result, err);
  }
});

$("chatgpt-manage").addEventListener("click", openUsage);
$("chatgpt-plan-manage").addEventListener("click", openUsage);

$("chatgpt-welcome-ok").addEventListener("click", async () => {
  welcome.close();
  await invoke("chatgpt_welcome_seen");
  await reload();
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
        showMessage(result, "busy", t("providers.testReceiving", { sample }));
      }
    };
    showMessage(result, "busy", t("providers.testing"));
    const report = await invoke<ConnectionReport>("test_connection", { providerId: provider.id, modelId: testModel(provider, data.selection.active), onEvent });
    showMessage(result, "ok", describeReport(report));
  } catch (err) {
    await syncAfterChatgptError(err);
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
  enabled.setAttribute("aria-label", t("providers.rowInPicker", { model: model.id }));

  const name = document.createElement("td");
  name.className = "model-name";
  name.textContent = modelLabel(model);
  name.title = model.id;

  const images = document.createElement("select");
  images.setAttribute("aria-label", t("providers.rowImages", { model: model.id }));
  images.append(new Option(t("providers.unknown"), ""), new Option(t("providers.yes"), "yes"), new Option(t("providers.no"), "no"));
  images.value = imagesToValue(model.supportsImages);

  const context = document.createElement("input");
  context.type = "text";
  context.inputMode = "numeric";
  context.placeholder = t("providers.contextUnknown");
  context.value = model.contextTokens?.toString() ?? "";
  context.setAttribute("aria-label", t("providers.rowContext", { model: model.id }));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "link";
  remove.textContent = t("common.remove");

  const save = async () => {
    const tokens = parseContext(context.value);
    if (tokens === undefined) {
      showMessage(modelsResult, "error", t("providers.invalidTokensLong", { value: context.value }));
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
  showMessage(modelsResult, "busy", t("providers.fetchingModels"));
  try {
    const provider = await saveForm();
    const updated = await invoke<Provider>("refresh_models", { providerId: provider.id });
    replaceProvider(updated);
    await reload();
    renderModels();
    const hidden = updated.models.filter((m) => !m.enabled).length;
    const found = t("providers.modelsFound", { count: modelCount(updated.models.length) });
    showMessage(modelsResult, "ok", hidden ? `${found} ${plural(hidden, "providers.hiddenOne", "providers.hiddenOther")}` : found);
  } catch (err) {
    await syncAfterChatgptError(err);
    const e = toError(err);
    showMessage(modelsResult, "error", `${e.message} ${t("providers.addYourself")}`, e.detail);
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
    showMessage(modelsResult, "error", t("providers.invalidTokens", { value: tokensInput.value }));
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

function renderPresets() {
  const value = presetSelect.value;
  presetSelect.replaceChildren(...PRESETS.map((preset) => new Option(presetLabel(preset), preset.id)));
  if (value) presetSelect.value = value;
}

/** Een andere interfacetaal: wat in code is opgebouwd opnieuw tekenen, zonder ingevulde velden te wissen. */
function onLanguage() {
  renderPresets();
  renderPicker(false);
  if (!dialog.open) return;
  const provider = selected();
  renderList();
  if (provider) renderKeyState(provider);
  else renderPresetHint();
  if (removeButton.dataset.armed === "yes") removeButton.textContent = t("providers.confirmDelete");
  else resetDeleteButton();
  renderChatgptAccount(provider);
  renderModels();
}

export async function initProviders() {
  renderPresets();
  onLanguageChange(onLanguage);
  $("providers-open").addEventListener("click", open);
  $("providers-close").addEventListener("click", () => dialog.close());
  await reload();
}
