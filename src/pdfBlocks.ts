// Maakt van de losse tekststukken uit pdf.js de blokken van de tekstkopie. Los van pdf.js, zodat het testbaar is.
import type { Block } from "./types";

export interface PdfItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPageText {
  page: number;
  height: number;
  items: PdfItem[];
}

interface Line {
  page: number;
  text: string;
  x0: number;
  x1: number;
  y: number;
  h: number;
}

function toLines(page: PdfPageText): Line[] {
  const lines: Line[] = [];
  let cur: Line | null = null;
  for (const item of page.items) {
    if (!item.str) continue;
    const h = item.height || 10;
    const sameLine = cur && Math.abs(cur.y - item.y) <= Math.max(cur.h, h) * 0.5 && item.x >= cur.x1 - h * 2;
    if (cur && sameLine) {
      const gap = item.x - cur.x1;
      const needsSpace = gap > h * 0.15 && !cur.text.endsWith(" ") && !item.str.startsWith(" ");
      cur.text += (needsSpace ? " " : "") + item.str;
      cur.x1 = Math.max(cur.x1, item.x + item.width);
      cur.h = Math.max(cur.h, h);
    } else {
      if (!item.str.trim()) continue;
      if (cur) lines.push(cur);
      cur = { page: page.page, text: item.str, x0: item.x, x1: item.x + item.width, y: item.y, h };
    }
  }
  if (cur) lines.push(cur);
  return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Kop- en voettekst die op veel pagina's terugkomt en losse paginanummers horen niet bij de tekst. */
function dropRunningText(pages: { page: PdfPageText; lines: Line[] }[]): void {
  const inMargin = (l: Line, height: number) => l.y > height * 0.92 || l.y < height * 0.08;
  const key = (l: Line) => l.text.replace(/\d+/g, "#").toLowerCase();
  const counts = new Map<string, number>();
  for (const { page, lines } of pages) {
    for (const k of new Set(lines.filter((l) => inMargin(l, page.height)).map(key))) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  const limit = Math.max(3, pages.length * 0.5);
  for (const p of pages) {
    p.lines = p.lines.filter((l) => {
      if (!inMargin(l, p.page.height)) return true;
      if (pages.length > 1 && /^[\divxlc\s\-–—/.]+$/i.test(l.text)) return false;
      return (counts.get(key(l)) ?? 0) < limit;
    });
  }
}

function joinLine(text: string, next: string): string {
  if (/\p{Ll}[-­]$/u.test(text) && /^\p{Ll}/u.test(next)) return text.slice(0, -1) + next;
  return text + " " + next;
}

export function buildBlocks(input: PdfPageText[]): Block[] {
  const pages = input.map((page) => ({ page, lines: toLines(page) }));
  dropRunningText(pages);

  const bodyHeight = median(pages.flatMap((p) => p.lines.flatMap((l) => Array<number>(Math.min(l.text.length, 200)).fill(l.h))));
  const blocks: Block[] = [];

  for (const { lines } of pages) {
    const pageLeading = median(
      lines.slice(1).map((l, i) => lines[i].y - l.y).filter((gap) => gap > 0 && gap < bodyHeight * 3),
    ) || bodyHeight * 1.2;

    let current: { text: string; lines: Line[] } | null = null;
    const flush = () => {
      if (!current) return;
      const ls = current.lines;
      const h = median(ls.map((l) => l.h));
      const words = current.text.split(/\s+/).length;
      const heading = h > bodyHeight * 1.15 && words <= 25;
      blocks.push({
        n: blocks.length + 1,
        kind: heading ? "heading" : "paragraph",
        text: current.text,
        page: ls[0].page,
        bbox: [
          Math.min(...ls.map((l) => l.x0)),
          Math.min(...ls.map((l) => l.y)),
          Math.max(...ls.map((l) => l.x1)),
          Math.max(...ls.map((l) => l.y + l.h)),
        ],
      });
      current = null;
    };

    for (const line of lines) {
      if (current) {
        const c: { text: string; lines: Line[] } = current;
        const prev = c.lines[c.lines.length - 1];
        const gap = prev.y - line.y;
        const widest = Math.max(...c.lines.map((l) => l.x1));
        const width = widest - Math.min(...c.lines.map((l) => l.x0));
        const newColumn = gap < -prev.h;
        const bigGap = gap > pageLeading * 1.5;
        const fontChange = Math.abs(prev.h - line.h) > Math.max(prev.h, line.h) * 0.15;
        const shortEnd = prev.x1 < widest - width * 0.15 && /[.!?:"”’)]$/.test(prev.text);
        if (newColumn || bigGap || fontChange || shortEnd) flush();
      }
      if (current) {
        const c: { text: string; lines: Line[] } = current;
        c.text = joinLine(c.text, line.text);
        c.lines.push(line);
      } else {
        current = { text: line.text, lines: [line] };
      }
    }
    flush();
  }
  return blocks;
}
