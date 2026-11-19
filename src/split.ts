// The divider between the source and the right panel (blueprint and questions): drag it to choose the panel's width.
// The width is kept in localStorage, so it is the same after a restart. Double-click puts it back to the default.

const WIDTH_KEY = "deepdive.professorWidth";
const MIN = 300;
/** Room the source keeps at least; the same number as in the clamp() in style.css. */
const SOURCE_MIN = 360;
const STEP = 24;

function clampWidth(width: number, panels: HTMLElement): number {
  return Math.round(Math.max(MIN, Math.min(width, panels.clientWidth - SOURCE_MIN)));
}

function apply(panels: HTMLElement, width: number | null): void {
  if (width === null) panels.style.removeProperty("--professor-w");
  else panels.style.setProperty("--professor-w", `${width}px`);
}

function store(width: number | null): void {
  try {
    if (width === null) localStorage.removeItem(WIDTH_KEY);
    else localStorage.setItem(WIDTH_KEY, String(width));
  } catch { /* alleen gemak */ }
}

export function initSplit(): void {
  const split = document.getElementById("panel-split");
  const panels = split?.parentElement;
  const professor = split?.nextElementSibling as HTMLElement | null;
  if (!split || !panels || !professor) return;

  let saved: number | null = null;
  try {
    const raw = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(raw) && raw >= MIN) saved = raw;
  } catch { /* alleen gemak */ }
  apply(panels, saved);

  const current = () => professor.getBoundingClientRect().width;
  const set = (width: number) => {
    const w = clampWidth(width, panels);
    apply(panels, w);
    return w;
  };

  split.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    split.setPointerCapture(e.pointerId);
    document.body.classList.add("is-resizing");
    const right = panels.getBoundingClientRect().right;
    let width = current();
    const move = (ev: PointerEvent) => { width = set(right - ev.clientX); };
    const end = () => {
      split.removeEventListener("pointermove", move);
      split.removeEventListener("pointerup", end);
      split.removeEventListener("pointercancel", end);
      document.body.classList.remove("is-resizing");
      store(width);
    };
    split.addEventListener("pointermove", move);
    split.addEventListener("pointerup", end);
    split.addEventListener("pointercancel", end);
  });

  split.addEventListener("dblclick", () => {
    apply(panels, null);
    store(null);
  });

  // Toetsenbord: pijltjes links/rechts maken het paneel breder of smaller.
  split.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    store(set(current() + (e.key === "ArrowLeft" ? STEP : -STEP)));
  });
}
