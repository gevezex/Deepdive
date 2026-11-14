// De rekenregels achter selecteren, markeren en antwoorden. Geen DOM, zodat het met vitest te testen is.
import { t } from "./i18n";
import type { ParagraphRange } from "./types";

// ---------- acties ----------

export type Action = "ask" | "explain" | "simplify" | "define" | "fact_check" | "related" | "counterpoint";
export type HighlightColor = "yellow" | "green" | "blue" | "pink";
export const COLORS: HighlightColor[] = ["yellow", "green", "blue", "pink"];
export function colorLabel(color: HighlightColor): string {
  return t(`reading.color.${color}`);
}

export function actionLabel(action: Action | "copy"): string {
  return t(`reading.action.${action}`);
}

/** Het menu onder ⋯, met een korte uitleg per actie, in de taal van de interface. */
export function moreActions(): { action: Action | "copy"; label: string; hint: string }[] {
  return (["define", "fact_check", "related", "counterpoint", "copy"] as const).map((action) => ({ action, label: actionLabel(action), hint: t(`reading.hint.${action}`) }));
}

// ---------- verwijzingen en citaten ----------

export function paragraphLabel(from: number | null | undefined, to: number | null | undefined): string {
  if (from == null) return "";
  return to == null || to === from ? `¶${from}` : `¶${from}–${to}`;
}

/** "tekst" — Titel, ¶12. Lange citaten blijven heel: de lezer koos zelf wat ze kopieert. */
export function quoteText(text: string, title: string, from?: number | null, to?: number | null): string {
  const where = paragraphLabel(from, to);
  return `“${text.trim()}” — ${title}${where ? `, ${where}` : ""}`;
}

// ---------- antwoordtekst ----------
// Het model schrijft eenvoudige opmaak: **vet**, lijstjes met "- " en ¶-verwijzingen. Dit wordt een boom die de
// interface met textContent op het scherm zet; tekst uit een antwoord wordt dus nooit HTML.

export interface Inline {
  text: string;
  bold?: boolean;
  /** Een verwijzing als ¶12 of ¶12–14: klikbaar. */
  ref?: ParagraphRange;
}
export type AnswerBlock = { type: "p"; inlines: Inline[] } | { type: "ul"; items: Inline[][] };

const REF = /¶\s?(\d{1,5})(?:\s?[–—-]\s?¶?\s?(\d{1,5}))?/g;

function refs(text: string, bold: boolean): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(REF)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), bold });
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    out.push({ text: m[0], bold, ref: [Math.min(a, b), Math.max(a, b)] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold });
  return out;
}

export function parseInline(line: string): Inline[] {
  // Tijdens het streamen staat de sluitende ** er nog niet; het vette stuk is dan alvast vet.
  return line.split("**").flatMap((part, i) => (part ? refs(part, i % 2 === 1) : []));
}

export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let para: string[] = [];
  let list: Inline[][] | null = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: "p", inlines: parseInline(para.join(" ")) });
    para = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ type: "ul", items: list });
    list = null;
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const item = /^(?:[-*•]|\d{1,2}[.)])\s+(.*)$/.exec(line);
    if (!line) {
      flushPara();
      flushList();
    } else if (item) {
      flushPara();
      (list ??= []).push(parseInline(item[1]));
    } else {
      flushList();
      // Koppen horen niet in een antwoord; komen ze toch, dan als gewone vette regel.
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      para.push(heading ? `**${heading[1].replace(/\*\*/g, "")}**` : line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

// ---------- pdf ----------

export interface PageRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * De tekstlaag van pdf.js levert per woordgroep een rechthoek. Op één regel worden dat er een, zodat een markering
 * rustig oogt en het bestand klein blijft. Alles is als deel van de pagina (0 tot 1).
 */
export function mergeRects(rects: PageRect[]): PageRect[] {
  const sorted = rects.filter((r) => r.w > 0.0005 && r.h > 0.0005).sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
  const out: PageRect[] = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    const sameLine = prev && prev.page === r.page && Math.abs(prev.y + prev.h / 2 - (r.y + r.h / 2)) < Math.min(prev.h, r.h) * 0.5;
    if (sameLine && r.x <= prev.x + prev.w + Math.max(prev.h, r.h) * 0.6) {
      const right = Math.max(prev.x + prev.w, r.x + r.w);
      const top = Math.min(prev.y, r.y);
      const bottom = Math.max(prev.y + prev.h, r.y + r.h);
      prev.x = Math.min(prev.x, r.x);
      prev.w = right - prev.x;
      prev.y = top;
      prev.h = bottom - top;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** De alinea's die een selectie raakt, op grond van de plek van elk blok op de pagina. */
export function paragraphsForRects(rects: PageRect[], blocks: { n: number; rect: PageRect }[]): { from: number | null; to: number | null } {
  let from: number | null = null;
  let to: number | null = null;
  for (const b of blocks) {
    const hit = rects.some((r) => r.page === b.rect.page && r.x < b.rect.x + b.rect.w && b.rect.x < r.x + r.w && r.y < b.rect.y + b.rect.h && b.rect.y < r.y + r.h);
    if (!hit) continue;
    from = from === null ? b.n : Math.min(from, b.n);
    to = to === null ? b.n : Math.max(to, b.n);
  }
  return { from, to };
}
