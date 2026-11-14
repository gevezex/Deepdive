// The update button in the toolbar. At start the backend looks once on GitHub for a newer release; only then does
// the button appear. A click downloads and installs it, after which the app restarts by itself.
import { Channel, invoke } from "@tauri-apps/api/core";
import { formatNumber, onLanguageChange, t } from "./i18n";

type Available = { version: string; currentVersion: string };
type Progress = { kind: "download"; done: number; total: number | null } | { kind: "install" };
type State = { kind: "idle" } | Progress;

const button = () => document.getElementById("update-button") as HTMLButtonElement;

let available: Available | null = null;
let state: State = { kind: "idle" };

function render() {
  const el = button();
  if (!available) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.disabled = state.kind !== "idle";
  el.title = t("update.availableTitle", { version: available.version, current: available.currentVersion });
  if (state.kind === "idle") {
    el.textContent = t("update.available");
  } else if (state.kind === "install") {
    el.textContent = t("update.installing");
  } else if (state.total) {
    el.textContent = t("update.downloading", { percent: formatNumber(Math.min(100, Math.floor((state.done / state.total) * 100))) });
  } else {
    el.textContent = t("update.downloadingNoTotal");
  }
}

async function install(error: (err: unknown) => void) {
  if (state.kind !== "idle") return;
  state = { kind: "download", done: 0, total: null };
  render();
  const onProgress = new Channel<Progress>();
  onProgress.onmessage = (progress) => {
    state = progress;
    render();
  };
  try {
    // Only returns on an error: after installing, the backend restarts the app.
    await invoke("install_update", { onProgress });
  } catch (err) {
    state = { kind: "idle" };
    render();
    error(err);
  }
}

export function initUpdate(error: (err: unknown) => void) {
  button().addEventListener("click", () => void install(error));
  onLanguageChange(render);
  // Without internet the backend simply answers "nothing new"; the button then stays hidden.
  invoke<Available | null>("check_update")
    .then((found) => {
      available = found;
      render();
    })
    .catch(() => {});
}
