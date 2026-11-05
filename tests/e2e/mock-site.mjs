// Lokale testsite met login, betaalmuur, kort volledig artikel en aanvalspagina. Bevat geen echte gegevens.
import { createServer } from "node:http";

const paragraph = (i) => `Dit is alinea ${i} van het testartikel, met genoeg woorden om op een echte alinea te lijken en met een nette punt aan het einde van de zin.`;
const paragraphs = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<p>${paragraph(from + i)}</p>`).join("");
const FULL_WORDS = 40 * 26;

const shell = (title, body, head = "") => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="/stijl.css"><link rel="stylesheet" href="/beveiligd.css">${head}</head>
<body><header><nav><a href="/">Voorpagina</a> <a href="/login">Inloggen</a> <a href="/abonneren">Word abonnee</a> <span>Al abonnee? Log in</span></nav></header>
<main>${body}</main>
<footer><p>Word abonnee en lees onbeperkt. Al abonnee? Log in.</p></footer></body></html>`;

const ld = (free, words) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "NewsArticle", headline: "Stuk", isAccessibleForFree: free, wordCount: words })}</script>`;

/** Start de site. `otherOrigin` is een tweede server op een andere poort en een andere sitenaam. */
export async function startSite(password) {
  const log = [];
  const sessions = new Set();
  const state = { password, expired: false, sessionCount: 0, sawPasswordElsewhere: false };

  const cookiesOf = (req) => Object.fromEntries((req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => c.split("=")));
  const loggedIn = (req) => !state.expired && sessions.has(cookiesOf(req).sessie);

  // Tweede server: staat voor een andere site en mag nooit een cookie krijgen.
  const other = createServer((req, res) => {
    log.push({ server: "other", path: req.url, cookie: req.headers.cookie ?? null, accept: req.headers.accept ?? "" });
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
  });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const otherPort = other.address().port;

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const path = url.pathname;
    log.push({ server: "main", path: req.url, cookie: req.headers.cookie ?? null, method: req.method });
    const html = (body, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...headers });
      res.end(body);
    };

    if (path === "/stijl.css") return void res.writeHead(200, { "content-type": "text/css" }).end("body{font-family:Georgia,serif;max-width:40em;margin:2em auto}");
    if (path === "/beveiligd.css") {
      if (!loggedIn(req)) return void res.writeHead(302, { location: "/login" }).end();
      return void res.writeHead(200, { "content-type": "text/css" }).end("main{color:#223344}");
    }
    if (path === "/beveiligd.gif" || path === "/open.gif") {
      if (path === "/beveiligd.gif" && !loggedIn(req)) return void res.writeHead(302, { location: "/login" }).end();
      res.writeHead(200, { "content-type": "image/gif" });
      return void res.end(Buffer.from("R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==", "base64"));
    }
    // Met sessie een doorverwijzing naar een andere poort: de cookie mag daar niet meekomen.
    if (path === "/omleiding.gif") {
      if (!loggedIn(req)) return void res.writeHead(401).end();
      return void res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/na-omleiding.gif` }).end();
    }
    if (path === "/geheim.pdf") {
      if (!loggedIn(req)) return void res.writeHead(302, { location: "/login" }).end();
      res.writeHead(200, { "content-type": "application/pdf" });
      return void res.end("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
    }

    if (path === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("wachtwoord") !== state.password) return html(shell("Inloggen", "<h1>Inloggen</h1><p>Onjuist wachtwoord.</p>"), 403);
        const id = `sessie${++state.sessionCount}`;
        sessions.add(id);
        html("", 302, {
          location: form.get("terug") || "/",
          "set-cookie": [`sessie=${id}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax`, `voorkeur=licht; Path=/; Max-Age=86400`],
        });
      });
      return;
    }
    if (path === "/login") {
      const back = url.searchParams.get("terug") ?? "/betaald";
      return html(shell("Inloggen", `<h1>Inloggen</h1><form method="post" action="/login"><input type="hidden" name="terug" value="${back}"><label>Naam <input name="naam" value="test"></label><label>Wachtwoord <input id="wachtwoord" type="password" name="wachtwoord"></label><button id="inloggen" type="submit">Inloggen</button></form>`));
    }
    if (path === "/uitloggen") {
      sessions.delete(cookiesOf(req).sessie);
      return html("", 302, { location: "/", "set-cookie": "sessie=; Path=/; Max-Age=0" });
    }
    if (path === "/betaald" && state.forbidden) return html("<!doctype html><title>Geen toegang</title><p>Geen toegang</p>", 403);
    if (path === "/betaald") {
      if (loggedIn(req)) {
        const account = `<p id="account">Ingelogd als testpersoon</p><form><input type="hidden" name="csrf" value="csrf-token-geheim"></form>`;
        return html(shell("Betaald stuk", `<article><h1>Betaald stuk</h1>${account}${paragraphs(1, 40)}<img src="/beveiligd.gif" alt=""><img src="/open.gif" alt=""><img src="/omleiding.gif" alt=""><img src="http://localhost:${otherPort}/andere-site.gif" alt=""></article>`, ld(false, FULL_WORDS)));
      }
      return html(shell("Betaald stuk", `<article><h1>Betaald stuk</h1>${paragraphs(1, 3)}</article><div class="subscribe-box"><h2>Lees verder met een abonnement</h2><p>Log in om verder te lezen. <a href="/login">Inloggen</a></p></div>`, ld(false, FULL_WORDS)));
    }
    if (path === "/kort") {
      return html(shell("Kort bericht", `<article><h1>Kort bericht</h1><p>Vandaag ging de brug weer open, nadat die een week dicht was geweest. De gemeente verwacht geen nieuwe hinder.</p><p>De werkzaamheden zijn klaar. Fietsers kunnen er vanaf vanmiddag weer langs, en ook de bus rijdt weer zijn gewone route door het centrum van de stad.</p></article>`));
    }
    if (path === "/aanval") {
      // Zelfde soort pogingen als de aanvalspagina van stap 1, plus het lezen van een opgeslagen kopie.
      const id = url.searchParams.get("kopie") ?? "";
      return html(`<!doctype html><html><head><meta charset="utf-8"><title>Aanval</title>
<meta http-equiv="refresh" content="60;url=/uitgelekt?via=refresh"></head><body onload="fetch('/uitgelekt?via=onload')">
<h1>Aanvalspagina</h1>
${paragraphs(1, 30)}
<img src="x" onerror="fetch('/uitgelekt?via=onerror')">
<a href="javascript:fetch('/uitgelekt?via=js-link')">klik</a>
<form action="/uitgelekt"><input name="q" value="1"><button>verstuur</button></form>
<script>
  window.__aanval = { invoke: "geen", snapshot: "geen" };
  fetch("/uitgelekt?via=script");
  navigator.sendBeacon("/uitgelekt?via=beacon");
  (async () => {
    const results = {};
    for (const cmd of ["list_sources", "get_source", "list_providers", "list_site_sessions", "wipe_site_session", "refetch_source"]) {
      try {
        await window.__TAURI_INTERNALS__.invoke(cmd, { id: ${JSON.stringify(id)}, site: "127.0.0.1" });
        results[cmd] = "TOEGESTAAN";
      } catch (e) { results[cmd] = String(e).slice(0, 120); }
    }
    window.__aanval.invoke = results;
    try {
      const r = await fetch("deepdive-snapshot://localhost/${id}/index.html");
      const text = await r.text();
      window.__aanval.snapshot = r.status + ":" + text.length;
    } catch (e) { window.__aanval.snapshot = "fout: " + String(e).slice(0, 80); }
    const img = new Image();
    img.onload = () => (window.__aanval.snapshotImg = "GELADEN");
    img.onerror = () => (window.__aanval.snapshotImg = "geweigerd");
    img.src = "deepdive-snapshot://localhost/${id}/index.html";
    fetch("/aanval-klaar?res=" + encodeURIComponent(JSON.stringify(window.__aanval))).catch(() => {});
  })();
</script></body></html>`);
    }
    if (path === "/uitgelekt" || path === "/aanval-klaar") return html("ok");
    if (path === "/abonneren") return html(shell("Abonneren", "<h1>Abonneren</h1>"));
    if (path === "/favicon.ico") return void res.writeHead(404).end();
    return html(shell("Voorpagina", `<h1>Testkrant</h1><p><a href="/betaald">Betaald stuk</a></p>`));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));

  return {
    port: server.address().port,
    otherPort,
    log,
    state,
    sessions,
    clearLog: () => (log.length = 0),
    close: () => {
      server.closeAllConnections?.();
      other.closeAllConnections?.();
      server.close();
      other.close();
    },
  };
}
