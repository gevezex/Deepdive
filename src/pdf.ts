// Toont een pdf met echte pagina's en een selecteerbare tekstlaag, en leest de tekst voor de tekstkopie.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import { buildBlocks, type PdfItem } from "./pdfBlocks";
import type { Block } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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

export interface PdfViewHandle {
  destroy(): void;
}

/** Bouwt de pagina's lazy op: alleen wat in beeld komt wordt getekend, wat ver weg is wordt weer vrijgegeven. */
export async function renderPdf(container: HTMLElement, doc: pdfjs.PDFDocumentProxy): Promise<PdfViewHandle> {
  container.replaceChildren();
  const width = () => Math.max(300, Math.min(container.clientWidth - 32, 1100));
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

  return {
    destroy() {
      clearTimeout(timer);
      near.disconnect();
      resize.disconnect();
      container.replaceChildren();
      void doc.loadingTask.destroy();
    },
  };
}
