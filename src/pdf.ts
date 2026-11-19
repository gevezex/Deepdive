// Toont een pdf met echte pagina's en een selecteerbare tekstlaag, en leest de tekst voor de tekstkopie.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { buildBlocks, type PdfItem } from "./pdfBlocks";
import { mergeRects, type HighlightColor, type PageRect } from "./readingLogic";
import type { Block } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Een blok hoort een paar alinea's te zijn. Meer markeringen dan dit voegt op het scherm niets toe. */
const MAX_PDF_MARKS = 60;

const asset = (dir: string) => new URL(`/pdfjs/${dir}/`, location.href).href;

export async function loadPdf(bytes: Uint8Array): Promise<pdfjs.PDFDocumentProxy> {
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: asset("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts"),
    wasmUrl: asset("wasm"),
    iccUrl: asset("iccs"),
    isEvalSupported: false,
    enableXfa: false,
  } as Parameters<typeof pdfjs.getDocument>[0]).promise;
}

export async function extractText(doc: pdfjs.PDFDocumentProxy): Promise<{ title: string | null; pageCount: number; blocks: Block[] }> {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      items.push({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height || Math.abs(item.transform[3]) });
    }
    pages.push({ page: n, height: page.getViewport({ scale: 1 }).height, items });
    page.cleanup();
  }
  const meta = await doc.getMetadata().catch(() => null);
  const info = meta?.info as { Title?: string } | undefined;
  return { title: info?.Title?.trim() || null, pageCount: doc.numPages, blocks: buildBlocks(pages) };
}

export interface PdfRegion {
  page: number;
  bbox: [number, number, number, number];
}

export interface PdfMark {
  id: string;
  color: HighlightColor;
  note: boolean;
  rects: PageRect[];
}

export interface PdfViewHandle {
  destroy(): void;
  /** Scrolt naar de eerste plek en markeert ze allemaal. De vorige markering verdwijnt. */
  highlight(regions: PdfRegion[]): Promise<void>;
  /** De selectie in de tekstlaag, als deel van elke pagina. Leeg als er niets in de pdf is geselecteerd. */
  selectionRects(range: Range): PageRect[];
  /** De plek van elk blok op zijn pagina, als deel van de pagina. */
  blockRects(blocks: Block[]): Promise<{ n: number; rect: PageRect }[]>;
  /** Tekent de markeringen van de lezer. De vorige verdwijnen. */
  setMarks(marks: PdfMark[]): void;
  /** De markering onder dit punt op het scherm, als die er is. */
  markAt(x: number, y: number): string | null;
  /** De rechthoek op het scherm van een markering. */
  markRect(id: string): DOMRect | null;
  setActiveMark(id: string | null): void;
  scrollToMark(id: string): void;
}

/** Bouwt de pagina's lazy op: alleen wat in beeld komt wordt getekend, wat ver weg is wordt weer vrijgegeven. */
export async function renderPdf(container: HTMLElement, doc: pdfjs.PDFDocumentProxy): Promise<PdfViewHandle> {
  container.replaceChildren();
  const width = () => Math.max(300, Math.min(container.clientWidth - 22, 1100));
  const first = await doc.getPage(1);
  const firstBase = first.getViewport({ scale: 1 });

  interface Slot { n: number; el: HTMLDivElement; canvas: HTMLCanvasElement | null; hasText: boolean; drawing: boolean; }
  const slots: Slot[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const el = document.createElement("div");
    el.className = "pdf-page page";
    el.dataset.page = String(n);
    const scale = width() / firstBase.width;
    el.style.width = `${firstBase.width * scale}px`;
    el.style.height = `${firstBase.height * scale}px`;
    container.append(el);
    slots.push({ n, el, canvas: null, hasText: false, drawing: false });
  }

  const draw = async (slot: Slot) => {
    if (slot.drawing || slot.canvas) return;
    slot.drawing = true;
    try {
      const page = await doc.getPage(slot.n);
      const base = page.getViewport({ scale: 1 });
      const scale = width() / base.width;
      const viewport = page.getViewport({ scale });
      slot.el.style.width = `${viewport.width}px`;
      slot.el.style.height = `${viewport.height}px`;
      slot.el.style.setProperty("--scale-factor", String(scale));
      slot.el.style.setProperty("--total-scale-factor", String(scale));

      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      slot.el.prepend(canvas);
      slot.canvas = canvas;
      const painting = page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;

      // De tekstlaag wacht niet op het tekenen: tekenen staat stil zolang het venster niet zichtbaar is.
      if (!slot.hasText) {
        slot.hasText = true;
        const layer = document.createElement("div");
        layer.className = "textLayer";
        slot.el.append(layer);
        await new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport }).render();
      }
      await painting;
    } finally {
      slot.drawing = false;
    }
  };

  const near = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const slot = slots[Number((e.target as HTMLElement).dataset.page) - 1];
        if (e.isIntersecting) void draw(slot).catch((err) => {
          if (!(err instanceof pdfjs.RenderingCancelledException)) console.error(err);
        });
        else if (slot.canvas && !slot.drawing) {
          slot.canvas.remove();
          slot.canvas = null;
        }
      }
    },
    { root: container, rootMargin: "1500px 0px" },
  );
  slots.forEach((s) => near.observe(s.el));

  // Past de pagina's aan als het paneel breder of smaller wordt.
  let lastWidth = container.clientWidth;
  let timer = 0;
  const resize = new ResizeObserver(() => {
    if (Math.abs(container.clientWidth - lastWidth) < 8) return;
    lastWidth = container.clientWidth;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      for (const s of slots) {
        s.canvas?.remove();
        s.canvas = null;
        s.hasText = false;
        s.el.querySelector(".textLayer")?.remove();
        const scale = width() / firstBase.width;
        s.el.style.width = `${firstBase.width * scale}px`;
        s.el.style.height = `${firstBase.height * scale}px`;
        near.unobserve(s.el);
        near.observe(s.el);
      }
    }, 200);
  });
  resize.observe(container);

  let marks: PdfMark[] = [];
  const pageOf = (n: number) => slots[n - 1]?.el ?? null;
  const drawMarks = () => {
    for (const el of container.querySelectorAll(".pdf-hl")) el.remove();
    for (const mark of marks) {
      for (const r of mark.rects) {
        const page = pageOf(r.page);
        if (!page) continue;
        const el = document.createElement("div");
        el.className = `pdf-hl pdf-hl-${mark.color}${mark.note ? " has-note" : ""}`;
        el.dataset.mark = mark.id;
        el.style.left = `${r.x * 100}%`;
        el.style.top = `${r.y * 100}%`;
        el.style.width = `${r.w * 100}%`;
        el.style.height = `${r.h * 100}%`;
        page.append(el);
      }
    }
  };
  const markEls = (id: string) => [...container.querySelectorAll<HTMLElement>(".pdf-hl")].filter((el) => el.dataset.mark === id);

  return {
    selectionRects(range) {
      if (!container.contains(range.commonAncestorContainer)) return [];
      const out: PageRect[] = [];
      for (const rect of range.getClientRects()) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const slot = slots.find((s) => {
          const p = s.el.getBoundingClientRect();
          return cx >= p.left && cx <= p.right && cy >= p.top && cy <= p.bottom;
        });
        if (!slot) continue;
        const p = slot.el.getBoundingClientRect();
        // De tekstlaag van pdf.js heeft een onzichtbaar blok aan het eind; dat hoort niet bij de selectie.
        if (rect.height > p.height * 0.08) continue;
        out.push({ page: slot.n, x: (rect.left - p.left) / p.width, y: (rect.top - p.top) / p.height, w: rect.width / p.width, h: rect.height / p.height });
      }
      return mergeRects(out);
    },
    async blockRects(blocks) {
      const views = new Map<number, ReturnType<pdfjs.PDFPageProxy["getViewport"]>>();
      const out: { n: number; rect: PageRect }[] = [];
      for (const b of blocks) {
        if (!b.page || !b.bbox) continue;
        if (!views.has(b.page)) views.set(b.page, (await doc.getPage(b.page)).getViewport({ scale: 1 }));
        const view = views.get(b.page)!;
        const [x0, y0] = view.convertToViewportPoint(b.bbox[0], b.bbox[1]) as [number, number];
        const [x1, y1] = view.convertToViewportPoint(b.bbox[2], b.bbox[3]) as [number, number];
        out.push({ n: b.n, rect: { page: b.page, x: Math.min(x0, x1) / view.width, y: Math.min(y0, y1) / view.height, w: Math.abs(x1 - x0) / view.width, h: Math.abs(y1 - y0) / view.height } });
      }
      return out;
    },
    setMarks(next) {
      marks = next;
      drawMarks();
    },
    markAt(x, y) {
      for (const el of container.querySelectorAll<HTMLElement>(".pdf-hl")) {
        const r = el.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el.dataset.mark ?? null;
      }
      return null;
    },
    markRect(id) {
      const els = markEls(id);
      if (!els.length) return null;
      const first = els[0].getBoundingClientRect();
      const last = els[els.length - 1].getBoundingClientRect();
      return new DOMRect(Math.min(first.left, last.left), first.top, Math.max(first.right, last.right) - Math.min(first.left, last.left), last.bottom - first.top);
    },
    setActiveMark(id) {
      for (const el of container.querySelectorAll<HTMLElement>(".pdf-hl")) el.classList.toggle("is-active", el.dataset.mark === id);
    },
    scrollToMark(id) {
      const el = markEls(id)[0];
      if (!el) return;
      const page = el.parentElement as HTMLElement;
      const top = page.offsetTop + (parseFloat(el.style.top) / 100) * page.offsetHeight;
      container.scrollTo({ top: Math.max(0, top - container.clientHeight * 0.18), behavior: "smooth" });
    },
    async highlight(regions) {
      for (const mark of container.querySelectorAll(".pdf-mark")) mark.remove();
      let first: HTMLElement | null = null;
      for (const region of regions.slice(0, MAX_PDF_MARKS)) {
        const slot = slots[region.page - 1];
        if (!slot) continue;
        const view = (await doc.getPage(region.page)).getViewport({ scale: 1 });
        const [x0, y0] = view.convertToViewportPoint(region.bbox[0], region.bbox[1]) as [number, number];
        const [x1, y1] = view.convertToViewportPoint(region.bbox[2], region.bbox[3]) as [number, number];
        const mark = document.createElement("div");
        mark.className = "pdf-mark";
        // In procenten van de pagina, zodat de markering meeschaalt als het paneel breder of smaller wordt.
        mark.style.left = `${(Math.min(x0, x1) / view.width) * 100}%`;
        mark.style.top = `${(Math.min(y0, y1) / view.height) * 100}%`;
        mark.style.width = `${(Math.abs(x1 - x0) / view.width) * 100}%`;
        mark.style.height = `${(Math.abs(y1 - y0) / view.height) * 100}%`;
        slot.el.append(mark);
        first ??= mark;
      }
      if (!first) return;
      const page = first.parentElement as HTMLElement;
      const top = page.offsetTop + (parseFloat(first.style.top) / 100) * page.offsetHeight;
      container.scrollTo({ top: Math.max(0, top - container.clientHeight * 0.18) });
    },
    destroy() {
      clearTimeout(timer);
      near.disconnect();
      resize.disconnect();
      container.replaceChildren();
      void doc.loadingTask.destroy();
    },
  };
}
