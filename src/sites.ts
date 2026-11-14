// Het scherm met de sites waar de app een sessie voor bewaart. Er komen hier geen cookies langs,
// alleen de naam van de site en wanneer die voor het laatst is gebruikt.
import { invoke } from "@tauri-apps/api/core";
import { formatDate, onLanguageChange, t } from "./i18n";
import type { SiteSession } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function date(value: string | null): string {
  return value ? formatDate(value) : t("sites.notYet");
}

async function render() {
  const sessions = await invoke<SiteSession[]>("list_site_sessions");
  const list = $("sites-list");
  list.replaceChildren();
  $("sites-empty").hidden = sessions.length > 0;
  for (const s of sessions) {
    const row = document.createElement("li");
    row.className = "site-row";
    row.dataset.site = s.site;

    const text = document.createElement("div");
    text.className = "site-text";
    const name = document.createElement("strong");
    name.textContent = s.site;
    const when = document.createElement("span");
    when.className = "hint";
    when.textContent = s.wipePending
      ? t("sites.wipePending")
      : `${t("sites.since", { created: date(s.createdAt), used: date(s.lastUsedAt) })}${s.loginOpen ? t("sites.loginOpen") : ""}`;
    text.append(name, when);

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = t("sites.openSite");
    open.title = t("sites.openSiteTitle");
    open.disabled = s.wipePending;
    open.onclick = () => void run(() => invoke("site_login_open", { url: `https://${s.site}` }));

    const wipe = document.createElement("button");
    wipe.type = "button";
    wipe.dataset.action = "wipe";
    wipe.textContent = t("sites.wipe");
    wipe.onclick = () => void run(() => invoke("wipe_site_session", { site: s.site }), t("sites.wiped", { site: s.site }));

    row.append(text, open, wipe);
    list.append(row);
  }
}

async function run(action: () => Promise<unknown>, done?: string) {
  const result = $("sites-result");
  result.hidden = true;
  try {
    await action();
    if (done) {
      result.className = "notice notice-ok";
      result.textContent = done;
      result.hidden = false;
    }
  } catch (err) {
    result.className = "notice notice-error";
    result.textContent = (err as { message?: string }).message ?? String(err);
    result.hidden = false;
  }
  await render();
}

export function initSites() {
  const dialog = $<HTMLDialogElement>("sites-dialog");
  $("sites-open").addEventListener("click", () => {
    $("sites-result").hidden = true;
    void render();
    dialog.showModal();
  });
  $("sites-close").addEventListener("click", () => dialog.close());
  onLanguageChange(refreshSites);
}

export const refreshSites = () => {
  if ($<HTMLDialogElement>("sites-dialog").open) void render();
};
