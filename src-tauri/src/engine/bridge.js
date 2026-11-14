// Het enige script in de visuele kopie. De app zet het er bij het serveren in; de scripts van de site blijven weg.
// De iframe heeft sandbox="allow-scripts" zonder allow-same-origin: dit script kan dus niet bij de app, haar opslag of
// haar commando's. Het praat alleen met het venster erboven via postMessage, en neemt alleen berichten van dat venster aan.
// Het geeft door wat de lezer selecteert, tekent markeringen en springt naar alinea's.
(() => {
  "use strict";
  const parentWin = window.parent;
  if (!parentWin || parentWin === window) return;
  const post = (msg) => parentWin.postMessage(Object.assign({ dd: 1 }, msg), "*");
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);
  const MAX_SELECTION = 20000;

  function addStyle() {
    const style = document.createElement("style");
    style.setAttribute("data-dd-style", "");
    style.textContent =
      "mark[data-dd-mark]{color:inherit;border-radius:2px;cursor:pointer;padding:0;box-decoration-break:clone;-webkit-box-decoration-break:clone}" +
      "mark[data-dd-color=yellow]{background:rgba(255,212,59,.45)}" +
      "mark[data-dd-color=green]{background:rgba(120,200,110,.4)}" +
      "mark[data-dd-color=blue]{background:rgba(110,170,240,.38)}" +
      "mark[data-dd-color=pink]{background:rgba(240,130,180,.38)}" +
      "mark[data-dd-note]{border-bottom:2px dotted rgba(90,60,30,.6)}" +
      "mark[data-dd-mark].dd-active{outline:2px solid rgba(122,74,30,.6)}" +
      "[data-dd-flash]{animation:dd-flash 1.6s ease-out 1;outline:2px solid rgba(176,120,20,.55);outline-offset:2px}" +
      "@keyframes dd-flash{0%{background-color:rgba(255,186,40,.75)}100%{background-color:rgba(255,205,86,.25)}}" +
      "@media (prefers-reduced-motion:reduce){[data-dd-flash]{animation:none}}";
    (document.head || document.documentElement).appendChild(style);
  }

  // ---------- tekstposities ----------
  // De kopie verandert nooit, dus een plek in de tekst van <body> blijft altijd dezelfde plek. Markeringen
  // voegen alleen <mark> om bestaande tekst toe en veranderen die tekst dus niet.

  function textNodes() {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  /** De plek van (node, offset) als aantal tekens vanaf het begin van de body. */
  function offsetOf(nodes, container, offset) {
    let total = 0;
    if (container.nodeType !== Node.TEXT_NODE) {
      // Een grens tussen elementen: de eerste tekst die erna komt.
      const probe = document.createRange();
      probe.setStart(container, offset);
      for (const n of nodes) {
        if (probe.comparePoint(n, 0) >= 0) return total;
        total += n.data.length;
      }
      return total;
    }
    for (const n of nodes) {
      if (n === container) return total + offset;
      total += n.data.length;
    }
    return null;
  }

  function paragraphsIn(range) {
    let from = null;
    let to = null;
    for (const el of document.querySelectorAll("[data-dd-n]")) {
      if (!range.intersectsNode(el)) continue;
      const n = Number(el.getAttribute("data-dd-n"));
      if (!Number.isFinite(n)) continue;
      if (from === null || n < from) from = n;
      if (to === null || n > to) to = n;
    }
    return { from, to };
  }

  function rectOf(range) {
    const r = range.getBoundingClientRect();
    const rects = range.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : r;
    return { top: r.top, left: r.left, bottom: r.bottom, right: r.right, endX: last.right, endBottom: last.bottom };
  }

  // ---------- selectie ----------

  let lastKey = "";
  function currentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const text = sel.toString().replace(/\s+/g, " ").trim();
    if (!text) return null;
    return { range, text };
  }

  function reportSelection(force) {
    const cur = currentSelection();
    if (!cur) {
      if (lastKey !== "") post({ type: "selection", text: "" });
      lastKey = "";
      return;
    }
    const nodes = textNodes();
    const start = offsetOf(nodes, cur.range.startContainer, cur.range.startOffset);
    const end = offsetOf(nodes, cur.range.endContainer, cur.range.endOffset);
    const { from, to } = paragraphsIn(cur.range);
    const key = `${start}:${end}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    post({ type: "selection", text: cur.text.slice(0, MAX_SELECTION), from, to, start, end, rect: rectOf(cur.range) });
  }

  let pending = 0;
  function soon(force) {
    clearTimeout(pending);
    pending = setTimeout(() => reportSelection(force), force ? 0 : 120);
  }

  // Tijdens het slepen geen balk: die zou onder de muis kunnen verschijnen en de selectie afbreken. Pas bij loslaten.
  let dragging = false;
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    clearTimeout(pending);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    soon(true);
  });
  document.addEventListener("selectionchange", () => {
    if (!dragging) soon(false);
  });
  document.addEventListener("keyup", (e) => {
    if (e.shiftKey || e.key.startsWith("Arrow")) soon(true);
  });

  // Tijdens het scrollen schuift de selectie mee; het venster erboven zet de balk dan op de nieuwe plek.
  let scrollFrame = 0;
  window.addEventListener(
    "scroll",
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        const cur = currentSelection();
        if (cur) post({ type: "selection-moved", rect: rectOf(cur.range) });
        if (activeMark) post({ type: "mark-moved", id: activeMark, rect: markRect(activeMark) });
      });
    },
    { passive: true, capture: true },
  );

  // Geen menu van het systeem (Herlaad, Inspecteer, ...): de selectiebalk is het menu.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    soon(true);
  });

  // Gewoon beginnen met typen terwijl er iets geselecteerd is: de letters gaan naar het vraagveld.
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      post({ type: "escape" });
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
    if (!currentSelection()) return;
    e.preventDefault();
    post({ type: "key", key: e.key });
  });

  // ---------- markeringen ----------

  const marks = new Map(); // id -> { color, note, els: [] }
  let activeMark = null;

  function unwrap(els) {
    for (const el of els) {
      const parent = el.parentNode;
      if (!parent) continue;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    }
  }

  function clearMarks() {
    for (const m of marks.values()) unwrap(m.els);
    marks.clear();
    activeMark = null;
  }

  /** Zet <mark> om de tekst van start tot end. Elk tekstknooppunt krijgt zijn eigen <mark>, zodat de opbouw van de pagina blijft. */
  function wrap(item) {
    const nodes = textNodes();
    const els = [];
    let pos = 0;
    for (const n of nodes) {
      const len = n.data.length;
      const a = Math.max(item.start, pos);
      const b = Math.min(item.end, pos + len);
      pos += len;
      if (b <= a) {
        if (pos >= item.end) break;
        continue;
      }
      // Alleen witruimte tussen blokken krijgt geen kleur.
      if (!n.data.slice(a - (pos - len), b - (pos - len)).trim()) continue;
      let target = n;
      const localA = a - (pos - len);
      const localB = b - (pos - len);
      if (localB < target.data.length) target.splitText(localB);
      if (localA > 0) target = target.splitText(localA);
      const mark = document.createElement("mark");
      mark.setAttribute("data-dd-mark", item.id);
      mark.setAttribute("data-dd-color", item.color);
      if (item.note) mark.setAttribute("data-dd-note", "");
      target.parentNode.insertBefore(mark, target);
      mark.appendChild(target);
      els.push(mark);
    }
    return els;
  }

  function setMarks(items) {
    clearMarks();
    // Van achter naar voren: zo verschuift het splitsen van tekst de nog te zetten plekken niet.
    const sorted = items.slice().sort((x, y) => y.start - x.start);
    for (const item of sorted) {
      if (typeof item.start !== "number" || typeof item.end !== "number" || item.end <= item.start) continue;
      marks.set(item.id, { color: item.color, note: !!item.note, els: wrap(item) });
    }
  }

  function markRect(id) {
    const m = marks.get(id);
    if (!m || !m.els.length) return null;
    const first = m.els[0].getBoundingClientRect();
    const last = m.els[m.els.length - 1].getBoundingClientRect();
    return { top: first.top, left: first.left, bottom: last.bottom, right: last.right, endX: last.right, endBottom: last.bottom };
  }

  function setActive(id) {
    for (const m of marks.values()) for (const el of m.els) el.classList.remove("dd-active");
    activeMark = id;
    const m = id && marks.get(id);
    if (m) for (const el of m.els) el.classList.add("dd-active");
  }

  document.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("mark[data-dd-mark]") : null;
    if (!target || currentSelection()) return;
    const id = target.getAttribute("data-dd-mark");
    setActive(id);
    post({ type: "mark-click", id, rect: markRect(id) });
  });

  // ---------- springen ----------

  function jump(ranges, markId) {
    for (const el of document.querySelectorAll("[data-dd-flash]")) el.removeAttribute("data-dd-flash");
    let first = null;
    if (markId && marks.get(markId)) {
      first = marks.get(markId).els[0] || null;
    } else {
      for (const el of document.querySelectorAll("[data-dd-n]")) {
        const n = Number(el.getAttribute("data-dd-n"));
        if (!ranges.some(([a, b]) => a <= n && n <= b)) continue;
        // Een pagina kan alinea's binnen elkaar nesten; alleen de buitenste licht op.
        if (el.parentElement && el.parentElement.closest("[data-dd-flash]")) continue;
        el.setAttribute("data-dd-flash", "");
        first = first || el;
      }
    }
    if (!first) return false;
    const top = first.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.18;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    return true;
  }

  // ---------- berichten van het venster erboven ----------

  window.addEventListener("message", (e) => {
    if (e.source !== parentWin) return;
    const msg = e.data;
    if (!msg || typeof msg !== "object" || msg.dd !== 1) return;
    switch (msg.type) {
      case "marks":
        if (Array.isArray(msg.items)) setMarks(msg.items.filter((i) => i && typeof i.id === "string" && typeof i.color === "string"));
        break;
      case "active-mark":
        setActive(typeof msg.id === "string" ? msg.id : null);
        break;
      case "clear-selection": {
        const sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        lastKey = "";
        break;
      }
      case "jump":
        if (Array.isArray(msg.ranges) || typeof msg.mark === "string") jump(Array.isArray(msg.ranges) ? msg.ranges : [], msg.mark);
        break;
    }
  });

  const ready = () => {
    addStyle();
    post({ type: "ready" });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready);
  else ready();
})();
