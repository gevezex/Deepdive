// Draait in de verborgen webview, in de pagina zelf. Alles wat hier uitkomt is onbetrouwbaar:
// de pagina kan dit script en de uitvoer beïnvloeden. Rust saneert de HTML daarom opnieuw.
(function (NS) {
  if (window[NS]) return;
  const state = (window[NS] = { phase: "wachten", done: false, error: null, payload: null, offset: 0 });

  // Geeft de uitvoer in stukken terug, zonder een emoji (surrogaatpaar) door te knippen.
  state.next = function () {
    const CHUNK = 1 << 21;
    const p = state.payload || "";
    if (state.offset >= p.length) return "";
    let end = Math.min(state.offset + CHUNK, p.length);
    const code = p.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff && end < p.length) end -= 1;
    const out = p.slice(state.offset, end);
    state.offset = end;
    return out;
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- wachten tot de pagina is opgebouwd ----------

  let lastActivity = Date.now();
  try {
    new MutationObserver(() => (lastActivity = Date.now())).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true,
    });
    new PerformanceObserver(() => (lastActivity = Date.now())).observe({ entryTypes: ["resource"] });
  } catch (_) {}

  async function waitQuiet(quietMs, maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (Date.now() - lastActivity >= quietMs && document.readyState !== "loading") return;
      await sleep(100);
    }
  }

  function scrollContainers() {
    const out = [document.scrollingElement || document.documentElement];
    const vh = window.innerHeight;
    for (const el of document.querySelectorAll("main, article, section, div")) {
      if (el.clientHeight < vh * 0.5 || el.scrollHeight <= el.clientHeight + 200) continue;
      const o = getComputedStyle(el).overflowY;
      if (o === "auto" || o === "scroll") out.push(el);
      if (out.length >= 4) break;
    }
    return out;
  }

  // Scrolt de hele pagina door, zodat afbeeldingen en tekst die pas bij het scrollen laden er staan.
  async function scrollThrough() {
    for (const img of document.images) {
      try { img.loading = "eager"; } catch (_) {}
    }
    const step = Math.max(400, Math.floor(window.innerHeight * 0.8));
    for (const el of scrollContainers()) {
      for (let i = 0; i < 100; i++) {
        const before = el.scrollTop;
        el.scrollTop = before + step;
        window.dispatchEvent(new Event("scroll"));
        await sleep(90);
        if (el.scrollTop === before) break;
      }
      el.scrollTop = 0;
    }
    window.scrollTo(0, 0);
  }

  async function waitImages(maxMs) {
    const pending = [...document.images].filter((i) => !i.complete).map((i) => i.decode().catch(() => {}));
    await Promise.race([Promise.all(pending), sleep(maxMs)]);
  }

  // ---------- tekstkopie: blokken met vaste alineanummers ----------

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "BUTTON", "NAV", "ASIDE", "FOOTER", "FORM",
    "SELECT", "OPTION", "TEXTAREA", "INPUT", "IFRAME", "OBJECT", "EMBED", "VIDEO", "AUDIO", "MAP", "DIALOG",
  ]);
  const SKIP_ROLES = new Set(["navigation", "complementary", "contentinfo", "search", "dialog", "alertdialog", "menu", "toolbar"]);
  const SKIP_NAME =
    /(^|[-_\s])(onetrust|didomi|gdpr|reacties?|reactions?|discussions?|responses?|disqus|share|sharing|social|related|recommend\w*|newsletter|promo|advert\w*|ads?|comments?|sidebar|breadcrumbs?|cookie\w*|consent|subscribe|teasers?|read-?also|lees-?ook|tags?)([-_\s]|$)/i;
  const BLOCKISH = new Set(["block", "flex", "grid", "list-item", "table", "table-row", "table-row-group", "table-cell", "flow-root", "table-caption"]);

  function nameOf(el) {
    const c = typeof el.className === "string" ? el.className : "";
    return c + " " + (el.id || "");
  }

  function isHidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const s = getComputedStyle(el);
    return s.display === "none" || s.visibility === "hidden";
  }

  const COMMENTS_NAME = /(reactie|reaction|comment|discussion|response|disqus)/i;

  // Een klassenaam is een zwakke aanwijzing ("newsletter-post" is gewoon het artikel). Reacties mogen lang
  // zijn, maar verder krijgt een element met veel tekst of het hoofdartikel het voordeel van de twijfel.
  function nameSkips(el) {
    const name = nameOf(el);
    if (!SKIP_NAME.test(name)) return false;
    if (el.matches("article, main, [role=main], body") || el.querySelector("h1")) return false;
    return COMMENTS_NAME.test(name) || norm(el.textContent).length < 3000;
  }

  function skip(el) {
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true;
    if (SKIP_ROLES.has(el.getAttribute("role"))) return true;
    if (nameSkips(el)) return true;
    return isHidden(el);
  }

  const norm = (s) => (s || "").replace(/[\s ]+/g, " ").trim();
  const textOf = (el) => norm(el.innerText !== undefined ? el.innerText : el.textContent);
  const hasWord = (s) => /[\p{L}\p{N}]/u.test(s);

  function isBlock(el) {
    const s = getComputedStyle(el);
    // Een zwevende initiaal hoort bij de alinea, ook al rekent de browser hem als blok.
    if (s.cssFloat !== "none" && norm(el.textContent).length <= 3) return false;
    return BLOCKISH.has(s.display);
  }

  function kidsOf(el) {
    if (el.tagName === "SLOT") {
      const a = el.assignedNodes({ flatten: true });
      if (a.length) return a;
    }
    return el.shadowRoot ? [...el.shadowRoot.childNodes] : [...el.childNodes];
  }

  function hasSkippedKid(el) {
    for (const k of kidsOf(el)) {
      if (k.nodeType === 1 && k.tagName !== "BR" && skip(k) && norm(k.textContent)) return true;
    }
    return false;
  }

  function hasBlockKid(el) {
    for (const k of kidsOf(el)) {
      if (k.nodeType !== 1) continue;
      if (skip(k)) continue;
      if (isBlock(k) || k.shadowRoot || k.tagName === "SLOT" || hasBlockKid(k)) return true;
    }
    return false;
  }

  // Oudere sites scheiden alinea's met twee keer <br>. Dan is het element geen één blok.
  function isBr(n) {
    return n && n.nodeType === 1 && n.tagName === "BR";
  }
  function nextIsBr(n) {
    let k = n.nextSibling;
    while (k && k.nodeType === 3 && !k.nodeValue.trim()) k = k.nextSibling;
    return isBr(k);
  }
  function hasDoubleBr(el) {
    for (const br of el.querySelectorAll("br")) if (nextIsBr(br)) return true;
    return false;
  }

  function kindOf(el) {
    const t = el.tagName.toUpperCase();
    if (/^H[1-6]$/.test(t)) return { kind: "heading", level: Number(t[1]) };
    if (t === "TR") return { kind: "table-row" };
    if (t === "PRE") return { kind: "code" };
    if (el.closest("figcaption, caption")) return { kind: "caption" };
    if (el.closest("blockquote")) return { kind: "quote" };
    if (el.closest("li")) return { kind: "list-item" };
    return { kind: "paragraph" };
  }

  function collect(root, blocks) {
    const emit = (el, text) => {
      if (!hasWord(text)) return;
      if (blocks.length && blocks[blocks.length - 1].text === text) return;
      const info = kindOf(el);
      if (info.kind !== "heading" && text.split(" ").length <= 15 && linkShare(el) > 0.9) return;
      const n = blocks.length + 1;
      el.setAttribute("data-dd-n", String(n));
      blocks.push({ n, ...info, text });
    };

    const walk = (el) => {
      if (skip(el)) return;
      const t = el.tagName.toUpperCase();
      if (t === "TR") {
        const cells = [...el.children].map(textOf).filter(Boolean);
        return emit(el, cells.join(" | "));
      }
      if (t === "PRE") return emit(el, (el.textContent || "").trim());
      if (!hasBlockKid(el) && !el.shadowRoot && !hasDoubleBr(el) && !hasSkippedKid(el)) return emit(el, textOf(el));

      // Gemengde inhoud: losse tekst naast blokken krijgt een eigen omhulling, zodat er niets wegvalt.
      let run = [];
      const flush = () => {
        const text = norm(run.map((n) => n.textContent).join(" "));
        const nodes = run;
        run = [];
        if (!hasWord(text) || !nodes[0].parentNode) return;
        const wrap = document.createElement("span");
        nodes[0].parentNode.insertBefore(wrap, nodes[0]);
        for (const n of nodes) wrap.appendChild(n);
        emit(wrap, text);
      };
      for (const k of kidsOf(el)) {
        if (k.nodeType === 3) {
          if (k.textContent.trim()) run.push(k);
          else if (run.length) run.push(k);
          continue;
        }
        if (k.nodeType !== 1) continue;
        if (isBr(k)) {
          if (nextIsBr(k) || isBr(k.previousElementSibling)) flush();
          else if (run.length) run.push(k);
          continue;
        }
        if (skip(k)) continue;
        if (isBlock(k) || k.shadowRoot || k.tagName === "SLOT" || hasBlockKid(k) || hasDoubleBr(k)) {
          flush();
          walk(k);
        } else {
          run.push(k);
        }
      }
      flush();
    };
    walk(root);
  }

  // Tekst in een koppeling die bijna alles beslaat is doorklikmateriaal, geen lopende tekst.
  function linkShare(el) {
    let linked = 0;
    for (const a of el.querySelectorAll("a")) linked += norm(a.textContent).length;
    return linked / Math.max(1, norm(el.textContent).length);
  }

  function inExcluded(el) {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      if (a.matches("nav, aside, footer, dialog, [role=navigation], [role=complementary], [role=contentinfo], [role=dialog]")) return true;
      if (nameSkips(a)) return true;
      if (getComputedStyle(a).position === "fixed") return true;
    }
    return false;
  }

  function ownTextLength(el) {
    let n = 0;
    for (const k of el.childNodes) if (k.nodeType === 3) n += norm(k.nodeValue).length;
    return n;
  }

  // Zoekt de container met de lopende tekst: tel de tekst van lange blokken op bij al hun voorouders en
  // daal vanaf de body af zolang één kind het grootste deel bevat. Liever iets te ruim dan tekst missen.
  function pickRoot() {
    const totals = new Map();
    const add = (el, len) => {
      for (let a = el.parentElement; a; a = a.parentElement) totals.set(a, (totals.get(a) || 0) + len);
    };
    const scan = (nodes, lengthOf) => {
      for (const p of nodes) {
        const len = lengthOf(p);
        if (len < 40 || linkShare(p) > 0.7 || inExcluded(p)) continue;
        add(p, len);
      }
    };
    scan(document.querySelectorAll("p, pre, blockquote, li"), (p) => norm(p.textContent).length);
    if ((totals.get(document.body) || 0) < 500) {
      // Sites zonder <p>: tekst staat direct in div's, tabelcellen of <font>.
      scan(document.querySelectorAll("div, td, section, article, span, font, center"), ownTextLength);
    }
    const total = totals.get(document.body) || 0;
    if (total < 200) return document.querySelector("article, main, [role=main]") || document.body;
    let cur = document.body;
    for (;;) {
      const here = totals.get(cur) || 0;
      let best = null;
      let bestScore = 0;
      for (const c of cur.children) {
        const v = totals.get(c) || 0;
        if (v > bestScore) { bestScore = v; best = c; }
      }
      if (!best || bestScore < here * 0.7) return cur;
      cur = best;
    }
  }

  // ---------- cookiemuren en overlays ----------

  const OVERLAY_NAME = /(cookie|consent|gdpr|onetrust|didomi|sourcepoint|sp_message|qc-cmp|cmp-|usercentrics|cc-banner|ccm_|modal-backdrop)/i;
  const CONSENT_TEXT = /(cookie|privacy|toestemming|consent|gdpr|personal data|persoonsgegevens)/i;
  const ACCEPT_BUTTON = /(akkoord|accept|aanvaard|toestaan|agree|allow all|got it|^ok[é.!]?$)/i;

  // Alle elementen, ook die in een schaduw-DOM zitten.
  function deepAll(root, out) {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  }

  const parentOf = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  function holdsArticle(el) {
    return !!el.querySelector("article, main") || norm(el.textContent).length > 8000;
  }

  // Zonder scripts is een overlay niet meer weg te klikken. Daarom gaat hij vóór het opslaan uit de pagina.
  // We klikken niets aan: de keuze blijft onbeantwoord en de site krijgt geen toestemming van ons.
  function removeOverlays() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const all = deepAll(document, []);
    const doomed = new Set();

    // 1. Vanaf de knop "Akkoord" omhoog naar de bovenste zwevende laag met de cookietekst.
    for (const el of all) {
      if (!el.matches("button, a, [role=button], input[type=button], input[type=submit]")) continue;
      const label = norm(el.value || el.textContent);
      if (label.length > 40 || !ACCEPT_BUTTON.test(label)) continue;
      let target = null;
      for (let a = parentOf(el); a && a !== document.body && a !== document.documentElement; a = parentOf(a)) {
        if (holdsArticle(a)) break;
        const pos = getComputedStyle(a).position;
        const floats = pos === "fixed" || pos === "sticky" || a.tagName === "DIALOG" || (pos === "absolute" && Number(getComputedStyle(a).zIndex) > 0);
        if ((floats || a.getRootNode() !== document) && CONSENT_TEXT.test(a.textContent)) target = a;
      }
      if (target) {
        const root = target.getRootNode();
        doomed.add(root instanceof ShadowRoot ? root.host : target);
      }
    }

    // 2. Bekende cookielagen, en zwevende vlakken die bijna het hele scherm bedekken.
    for (const el of all) {
      const pos = getComputedStyle(el).position;
      const isDialog = el.tagName === "DIALOG" && el.hasAttribute("open");
      if (pos !== "fixed" && pos !== "sticky" && !isDialog) {
        if (!(el.getRootNode() === document && OVERLAY_NAME.test(nameOf(el)) && !holdsArticle(el) && el.parentElement === document.body)) continue;
      }
      if (holdsArticle(el)) continue;
      const r = el.getBoundingClientRect();
      // Ook een grote zwevende reclame of donatievraag blijft anders voorgoed over de tekst liggen.
      // Smalle balken en zijkolommen met navigatie blijven staan.
      // Een betaalmuur blijft staan: de kopie laat zien wat de site de lezer liet zien en omzeilt niets.
      const covers = pos === "fixed" && r.width >= vw * 0.4 && r.height >= vh * 0.2 && !el.querySelector("h1") && !isPaywallLayer(el);
      if (covers || OVERLAY_NAME.test(nameOf(el)) || (isDialog && CONSENT_TEXT.test(el.textContent))) {
        const root = el.getRootNode();
        doomed.add(root instanceof ShadowRoot ? root.host : el);
      }
    }

    for (const el of doomed) el.remove();
    if (doomed.size) {
      // De overlay zette het scrollen vaak uit.
      for (const el of [document.documentElement, document.body]) {
        const c = getComputedStyle(el);
        if (c.overflowY === "hidden") el.style.setProperty("overflow", "visible", "important");
        if (c.position === "fixed") el.style.setProperty("position", "static", "important");
      }
    }
    return doomed.size;
  }

  // ---------- aanwijzingen voor het oordeel over de volledigheid ----------
  // Het oordeel zelf valt in Rust (completeness.rs). Hier verzamelen we alleen wat er te zien is.

  const GATE_HINT = /abonn|subscri|member|leden|log ?in|inlog|sign ?in|regist|verder (te )?lezen|lees verder|continue|keep reading|read the|lees het|premium|plus-?artikel|access|toegang|buy|purchase|rent or|unlock|free trial|limit|free article|reserved|paywall/i;
  const GATE_NAME = /(^|[-_\s])(pay-?wall\w*|reg-?wall\w*|piano|tp-modal|tp-container|subscribe-?wall|subscription-?(gate|wall|required)|meter-?(wall|gate)|premium-?(gate|wall|lock)|locked-?content|content-?(gate|locked)|article-?gate|access-?wall)([-_\s]|$)/i;
  const PAYWALL_LAYER = /(abonn|subscri|log ?in|inlog|sign ?in|paywall)/i;

  function isPaywallLayer(el) {
    return !OVERLAY_NAME.test(nameOf(el)) && (GATE_NAME.test(nameOf(el)) || PAYWALL_LAYER.test(norm(el.textContent).slice(0, 600))) && !CONSENT_TEXT.test(norm(el.textContent).slice(0, 600));
  }

  function visibleBox(el) {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && !isHidden(el);
  }

  function placeOf(el, root) {
    let floating = false;
    for (let a = el; a && a !== document.documentElement; a = parentOf(a)) {
      if (a.matches("nav, header, [role=navigation], [role=banner]")) return "chrome";
      if (getComputedStyle(a).position === "fixed" || getComputedStyle(a).position === "sticky" || a.matches("dialog, [role=dialog], [role=alertdialog]")) floating = true;
    }
    if (floating) return "overlay";
    for (let a = el; a && a !== document.documentElement; a = parentOf(a)) {
      if (a.matches("footer, aside, [role=contentinfo], [role=complementary]")) return "chrome";
    }
    if (root.contains(el)) return "in";
    const pos = root.compareDocumentPosition(el);
    return pos & Node.DOCUMENT_POSITION_FOLLOWING ? "after" : "before";
  }

  // De grootste elementen met korte tekst: zo blijft een zin met een koppeling erin in zijn geheel.
  function shortTexts(start, out) {
    const walk = (el) => {
      if (out.length >= 200) return;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME)$/i.test(el.tagName) || isHidden(el)) return;
      if (el.shadowRoot) for (const k of el.shadowRoot.children) walk(k);
      const text = norm(el.textContent);
      if (!text) return;
      if (text.length <= 240 && !el.shadowRoot) {
        if (text.length >= 6 && GATE_HINT.test(text) && visibleBox(el)) out.push({ el, text: textOf(el) || text });
        return;
      }
      for (const k of el.children) walk(k);
    };
    walk(start);
  }

  function readStructuredData(sig) {
    const visit = (v, depth) => {
      if (!v || typeof v !== "object" || depth > 5) return;
      if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
      if (v["@graph"]) visit(v["@graph"], depth + 1);
      const type = String(v["@type"] || "");
      const free = v.isAccessibleForFree;
      if (free !== undefined) sig.ldFree.push(free === true || /^true$/i.test(String(free)));
      if (v.hasPart) visit(v.hasPart, depth + 1);
      if (!/Article|Posting|Report/i.test(type)) {
        if (v.mainEntity) visit(v.mainEntity, depth + 1);
        return;
      }
      const count = parseInt(v.wordCount, 10);
      if (count > 0) sig.ldWordCount = Math.max(sig.ldWordCount || 0, count);
      if (typeof v.articleBody === "string") {
        const n = norm(v.articleBody).split(" ").length;
        sig.ldBodyWords = Math.max(sig.ldBodyWords || 0, n);
      }
    };
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(s.textContent), 0); } catch (_) {}
    }
    const micro = document.querySelector('[itemprop="isAccessibleForFree"]');
    if (micro) sig.ldFree.push(/^true$/i.test(micro.getAttribute("content") || micro.textContent || ""));
  }

  function readClipping(root, sig) {
    for (let a = root, i = 0; a && a !== document.body && i < 4; a = a.parentElement, i++) {
      if (getComputedStyle(a).overflowY === "hidden" && a.scrollHeight > a.clientHeight + 200 && a.clientHeight > 100) sig.clipped = true;
    }
    const nearEnd = [root, ...[...root.querySelectorAll("*")].slice(-12), root.nextElementSibling].filter(Boolean);
    for (const el of nearEnd) {
      const hasGradient = (s) => /gradient/.test(s.backgroundImage) && s.position === "absolute";
      if (hasGradient(getComputedStyle(el)) || hasGradient(getComputedStyle(el, "::after")) || hasGradient(getComputedStyle(el, "::before"))) sig.fade = true;
    }
  }

  // Vóór het weghalen van overlays: een betaalmuur zit daar vaak in.
  function collectSignals() {
    const sig = { ldFree: [], ldWordCount: null, ldBodyWords: null, contentTier: meta("article:content_tier", "og:article:content_tier"), gateCandidates: [], gateElements: [], passwordField: false, clipped: false, fade: false, pageWords: 0 };
    const root = pickRoot();
    readStructuredData(sig);
    readClipping(root, sig);
    sig.pageWords = norm(document.body.innerText).split(" ").length;
    const found = [];
    shortTexts(document.body, found);
    const candidates = found.map((c) => ({ el: c.el, text: c.text, place: placeOf(c.el, root) }));
    const all = deepAll(document, []);
    for (const el of all) {
      if (el.matches("input[type=password]") && visibleBox(el)) sig.passwordField = true;
      if (sig.gateElements.length < 5 && GATE_NAME.test(nameOf(el)) && visibleBox(el) && norm(el.textContent).length < 1500) {
        const place = placeOf(el, root);
        if (place !== "chrome" && place !== "before") sig.gateElements.push(nameOf(el).trim().slice(0, 80));
      }
    }
    return { sig, candidates };
  }

  // Hoeveel tekst volgt er nog na een blok? Na een echte betaalmuur bijna niets.
  function finishSignals(sig, candidates, blocks) {
    const numbered = [...document.querySelectorAll("[data-dd-n]")];
    sig.gateCandidates = candidates.map((c) => {
      let after = 0;
      if (c.el.isConnected) {
        for (const b of numbered) {
          if (c.el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING && !c.el.contains(b)) {
            const block = blocks[Number(b.getAttribute("data-dd-n")) - 1];
            if (block) after += block.text.split(" ").length;
          }
        }
      }
      return { text: c.text, place: c.place, wordsAfter: after };
    });
    return sig;
  }

  function extract() {
    const root = pickRoot();
    const blocks = [];
    const h1 = [...document.querySelectorAll("h1")].find((h) => !isHidden(h) && hasWord(textOf(h)));
    if (h1 && !root.contains(h1)) {
      const box = h1.parentElement;
      if (box && !box.contains(root) && box !== document.body) collect(box, blocks);
      else collect(h1, blocks);
    }
    collect(root, blocks);
    if (blocks.length < 3 && root !== document.body) {
      for (const el of document.querySelectorAll("[data-dd-n]")) el.removeAttribute("data-dd-n");
      blocks.length = 0;
      collect(document.body, blocks);
    }
    return blocks;
  }

  // ---------- visuele kopie: de opgebouwde DOM als tekst ----------

  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
  const DROP = new Set(["script", "noscript", "template", "base", "object", "embed", "applet", "frame", "frameset", "source", "track"]);
  const escText = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const PLACEHOLDER = /^data:|(?:^|\/)(?:blank|spacer|pixel|placeholder|transparent|lazy)[^/]*\.(?:gif|png|svg)/i;

  function bestImageSrc(img) {
    const current = img.currentSrc || img.getAttribute("src") || "";
    const small = img.complete && img.naturalWidth <= 2;
    if (current && !PLACEHOLDER.test(current) && !small) return current;
    for (const a of ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-url", "data-hi-res-src"]) {
      const v = img.getAttribute(a);
      if (v) return v;
    }
    const set = img.getAttribute("data-srcset") || img.getAttribute("srcset");
    if (set) return set.split(",")[0].trim().split(/\s+/)[0];
    return current;
  }

  function rulesOf(sheet) {
    try {
      return [...sheet.cssRules].map((r) => r.cssText).join("\n");
    } catch (_) {
      return "";
    }
  }

  function adopted(root) {
    let out = "";
    for (const s of root.adoptedStyleSheets || []) {
      const css = rulesOf(s);
      if (css) out += "<style>" + css + "</style>";
    }
    return out;
  }

  function attrs(el, overrides, omit) {
    let out = "";
    for (const a of el.attributes) {
      if (omit && omit.has(a.name)) continue;
      if (overrides && a.name in overrides) continue;
      if (!/^[^\s"'<>/=]+$/.test(a.name)) continue;
      out += " " + a.name + '="' + escAttr(a.value) + '"';
    }
    if (overrides) {
      for (const k in overrides) {
        if (overrides[k] !== null) out += " " + k + '="' + escAttr(String(overrides[k])) + '"';
      }
    }
    return out;
  }

  function ser(node) {
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.nodeType !== 1) return "";
    const el = node;
    const tag = el.localName;
    const lower = tag.toLowerCase();
    if (DROP.has(lower)) return "";
    if (lower === "link" && !/\bstylesheet\b/i.test(el.getAttribute("rel") || "")) return "";

    if (lower === "style") {
      let css = el.textContent || "";
      if (!css.trim() && el.sheet) css = rulesOf(el.sheet);
      return "<style" + attrs(el) + ">" + css.replace(/<\/style/gi, "<\\/style") + "</style>";
    }
    if (lower === "img") {
      const src = bestImageSrc(el);
      return "<img" + attrs(el, { src }, new Set(["srcset", "sizes", "loading", "data-src", "data-srcset"])) + ">";
    }
    if (lower === "canvas") {
      try {
        const data = el.toDataURL("image/png");
        if (data.length > 200) {
          return '<img src="' + data + '" style="max-width:100%;width:' + el.clientWidth + 'px" alt="">';
        }
      } catch (_) {}
      return "";
    }
    if (lower === "iframe") {
      const r = el.getBoundingClientRect();
      if (isHidden(el) || r.width < 120 || r.height < 60) return "";
      // Zwevende inlogknoppen en widgets zijn geen onderdeel van het stuk.
      for (let a = el, i = 0; a && i < 4; a = a.parentElement, i++) {
        const pos = getComputedStyle(a).position;
        if (pos === "fixed" || pos === "absolute") return "";
      }
      const over = { width: Math.round(r.width), height: Math.round(r.height) };
      return "<iframe" + attrs(el, over, new Set(["srcdoc"])) + "></iframe>";
    }
    if (lower === "input") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "password" || type === "hidden") return "";
      const over = {};
      if (el.value) over.value = el.value;
      if (el.checked) over.checked = "";
      return "<input" + attrs(el, over) + ">";
    }
    if (lower === "textarea") return "<textarea" + attrs(el) + ">" + escText(el.value || "") + "</textarea>";

    let inner = "";
    if (el.shadowRoot) {
      inner += '<template shadowrootmode="open">' + adopted(el.shadowRoot);
      for (const k of el.shadowRoot.childNodes) inner += ser(k);
      inner += "</template>";
    }
    for (const k of el.childNodes) inner += ser(k);
    if (VOID.has(lower)) return "<" + tag + attrs(el) + ">";
    return "<" + tag + attrs(el) + ">" + inner + "</" + tag + ">";
  }

  function serializeDocument() {
    const root = document.documentElement;
    return "<!doctype html>\n<html" + attrs(root) + ">" + ser(document.head || document.createElement("head")) + adopted(document) + ser(document.body) + "</html>";
  }

  function meta(...names) {
    for (const n of names) {
      const el = document.querySelector('meta[property="' + n + '"], meta[name="' + n + '"]');
      const v = el && norm(el.getAttribute("content"));
      if (v) return v;
    }
    return null;
  }

  async function run() {
    state.phase = "opbouwen";
    await waitQuiet(1200, 12000);
    state.phase = "scrollen";
    await scrollThrough();
    await waitQuiet(800, 4000);
    await waitImages(3000);
    state.phase = "vastleggen";
    const { sig, candidates } = collectSignals();
    removeOverlays();
    const blocks = extract();
    const signals = finishSignals(sig, candidates, blocks);
    const h1 = document.querySelector("h1");
    state.payload = JSON.stringify({
      html: serializeDocument(),
      finalUrl: location.href,
      title: meta("og:title", "twitter:title") || (h1 && textOf(h1)) || norm(document.title) || null,
      documentTitle: norm(document.title),
      author: meta("author", "article:author", "parsely-author"),
      siteName: meta("og:site_name", "application-name"),
      published: meta("article:published_time", "date", "datePublished", "pubdate"),
      lang: document.documentElement.lang || null,
      blocks,
      signals,
    });
    state.phase = "klaar";
    state.done = true;
  }

  run().catch((e) => {
    state.error = String((e && e.stack) || e);
    state.done = true;
  });
})("__NS__");
