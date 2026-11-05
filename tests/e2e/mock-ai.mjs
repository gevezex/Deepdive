// Lokale nepserver voor de end-to-endtest: spreekt beide API-soorten, met trage streaming en foutgevallen.
import { createServer } from "node:http";

const PARAGRAPHS = Array.from({ length: 30 }, (_, i) => `<p>Dit is alinea ${i + 1} van de testpagina, met genoeg woorden om als echt artikel te tellen bij het vastleggen.</p>`).join("");

// Draait in de echte webview tijdens het vastleggen en probeert bij de commando's van de app te komen.
const HOSTILE = `<!doctype html><html><head><title>Vijandige pagina</title></head><body><article><h1>Vijandig</h1>${PARAGRAPHS}</article><script>
(async () => {
  const report = (r) => { new Image().src = "/beacon?" + new URLSearchParams({ from: "hidden", r: JSON.stringify(r) }); };
  report({ started: true, hasInternals: !!window.__TAURI_INTERNALS__ });
  for (const cmd of ["list_providers", "test_connection", "get_source"]) {
    try {
      const out = await window.__TAURI_INTERNALS__.invoke(cmd, {});
      report({ cmd, allowed: true, out });
    } catch (e) {
      report({ cmd, allowed: false, error: String(e) });
    }
  }
})();
</script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

async function streamOpenai(res, words) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const word of words) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word }, finish_reason: null }] })}\n\n`);
    await sleep(150);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  res.end();
}

async function streamAnthropic(res, words) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (type, body) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
  send("message_start", { message: { usage: { input_tokens: 5 } } });
  for (const text of words) {
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
    await sleep(150);
  }
  send("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  send("message_stop", {});
  res.end();
}

// Vaste blauwdruk voor de test. De alinea's kloppen met de tekst in blueprint.e2e.mjs.
const BP_STRUCTURE = {
  textKind: "opinion",
  goal: { main: { kind: "persuade", description: "Overtuigt de lezer dat het stuk een test is." }, secondary: [{ kind: "explain_problem", description: "Legt ook het probleem uit." }] },
  message: "De boodschap van de nepblauwdruk staat hier in één zin.",
  occasion: { text: "De aanleiding staat in de eerste alinea's.", origin: "stated", paragraphs: [[1, 2]] },
  summary: "Een korte samenvatting van het nepstuk.",
  articleParagraphs: [1, 40],
  blocks: [
    { id: "b1", role: "occasion", title: "Aanleiding", content: "Het begint hier.", paragraphs: [[1, 2]], quote: null },
    { id: "b2", role: "argument", title: "Eerste argument", content: "Het argument loopt lang door.", paragraphs: [[3, 10]], quote: { paragraph: 4, text: "Alinea 4 is the English quote" } },
    { id: "b3", role: "evidence", title: "Het bewijs", content: "Hier staat het bewijs.", paragraphs: [[11, 20]], quote: null },
    { id: "b4", role: "objection", title: "Een bezwaar", content: "Iemand is het oneens.", paragraphs: [[21, 30]], quote: null },
    { id: "b5", role: "conclusion", title: "Conclusie", content: "Dus dit.", paragraphs: [[31, 40]], quote: null },
  ],
  relations: [
    { id: "r1", block: "b2", dependsOn: "b1", kind: "builds_on", explanation: "Bouwt voort op de aanleiding." },
    { id: "r2", block: "b3", dependsOn: "b2", kind: "evidence_for", explanation: "Ondersteunt het argument." },
    { id: "r3", block: "b4", dependsOn: "b3", kind: "contrasts", explanation: "Spreekt het bewijs tegen." },
    { id: "r4", block: "b5", dependsOn: "b3", kind: "concludes", explanation: "De conclusie steunt op het bewijs." },
    { id: "r5", block: "b5", dependsOn: "b1", kind: "builds_on", explanation: "Komt terug op het begin." },
  ],
};

const BP_CRITIQUE = {
  points: [
    { id: "k1", category: "leap", polarity: "minus", origin: "inferred", certainty: "medium", anchor: "r4", claim: "De conclusie gaat verder dan het bewijs.", explanation: "Het bewijs gaat over iets anders.", paragraphs: [[31, 32]], quotes: [], evidenceKind: null },
    { id: "k2", category: "evidence", polarity: "plus", origin: "stated", certainty: "high", anchor: "b3", claim: "Het bewijs is opvallend sterk.", explanation: "De auteur noemt de bron.", paragraphs: [[12, 12]], quotes: [{ paragraph: 12, text: "Alinea 12 is the strong evidence" }], evidenceKind: "study" },
    { id: "k3", category: "missing", polarity: "minus", origin: "inferred", certainty: "low", anchor: "b4", claim: "De tegenpartij komt nergens aan het woord.", explanation: "Dat geldt voor het hele stuk.", paragraphs: [[1, 40]], quotes: [], evidenceKind: null },
    { id: "k4", category: "gap", polarity: "minus", origin: "inferred", certainty: "medium", anchor: null, claim: "Een punt dat nergens aan hangt.", explanation: "Los.", paragraphs: [[5, 5]], quotes: [], evidenceKind: null },
  ],
  terms: [{ term: "Nepwoord", explanation: "Een woord dat de lezer moet kennen.", paragraphs: [[6, 6]] }],
  checked: [
    { category: "assumption", result: "nothing_found", note: null },
    { category: "leap", result: "found", note: null },
    { category: "gap", result: "found", note: null },
    { category: "evidence", result: "found", note: null },
    { category: "missing", result: "found", note: null },
    { category: "headline_vs_content", result: "not_applicable", note: "Dit stuk heeft geen kop." },
  ],
  overall: "Het oordeel van de nepprofessor: redelijk stevig.",
};

/** Hakt tekst in stukjes, zodat de app het antwoord echt in delen ontvangt. */
function pieces(text, size = 40) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

async function streamBlueprint(req, res, body, bp) {
  const critique = body.includes("OPDRACHT: maak laag 3");
  bp.calls.push(critique ? "critique" : "structure");
  const failure = critique ? bp.failCritique : bp.failStructure;
  if (failure) return json(res, failure.status, { error: { message: failure.message } });
  const gone = { closed: false };
  req.on("close", () => {});
  res.on("close", () => {
    gone.closed = true;
    if (!res.writableFinished) bp.aborted.push(critique ? "critique" : "structure");
  });
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const send = (text) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`);
  // Het wachten is steeds op een vlag van de test, zodat die elk tussenstadium op zijn gemak kan bekijken.
  const hold = async (flag) => {
    while (bp[flag] && !gone.closed) await sleep(30);
  };
  if (critique) {
    await hold("holdCritique");
    for (const piece of pieces(JSON.stringify(BP_CRITIQUE))) {
      if (gone.closed) return;
      send(piece);
      await sleep(2);
    }
  } else {
    const answer = bp.badStructureOnce ? "{\"message\": \"kapot\"}" : JSON.stringify(BP_STRUCTURE);
    bp.badStructureOnce = false;
    const cut = answer.indexOf("\"articleParagraphs\"");
    const firstBlock = answer.indexOf("\"id\":\"b2\"");
    const parts = cut < 0 ? [answer] : [answer.slice(0, cut), answer.slice(cut, firstBlock), answer.slice(firstBlock)];
    const flags = ["holdAfterGoal", "holdAfterBlock"];
    for (const [i, part] of parts.entries()) {
      for (const piece of pieces(part)) {
        if (gone.closed) return;
        send(piece);
        await sleep(2);
      }
      if (flags[i]) await hold(flags[i]);
    }
  }
  if (gone.closed) return;
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  res.end();
}

export function startMock(expectedKey) {
  const log = [];
  let extraPage = "";
  const bp = { calls: [], aborted: [], holdAfterGoal: false, holdAfterBlock: false, holdCritique: false, failCritique: null, failStructure: null, badStructureOnce: false };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url, "http://localhost");
      const body = Buffer.concat(chunks).toString();
      log.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const p = url.pathname;
      if (p === "/hostile.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(HOSTILE);
      }
      if (p === "/extra.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(extraPage);
      }
      if (p === "/beacon") {
        res.writeHead(204);
        return res.end();
      }
      // De blauwdruk: geen sleutel, antwoord in stukken, en de test bepaalt het tempo.
      if (p.startsWith("/bp/v1/")) {
        if (p.endsWith("/models")) return json(res, 200, { data: [{ id: "nep-blauwdruk" }] });
        return streamBlueprint(req, res, body, bp);
      }
      // OpenAI-compatibel, sleutel verplicht.
      if (p.startsWith("/ok/v1/")) {
        if (req.headers.authorization !== `Bearer ${expectedKey}`) return json(res, 401, { error: { message: "bad key" } });
        if (p.endsWith("/models")) return json(res, 200, { data: [{ id: "nep-klein" }, { id: "nep-groot", context_length: 128000, architecture: { input_modalities: ["text", "image"] } }] });
        return streamOpenai(res, ["Wer", "kt", " goed"]);
      }
      // Anthropic, sleutel verplicht.
      if (p.startsWith("/anthropic/v1/")) {
        if (req.headers["x-api-key"] !== expectedKey || !req.headers["anthropic-version"]) return json(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
        if (p.endsWith("/models")) return json(res, 200, { data: [{ id: "nep-claude", display_name: "Nep Claude", max_input_tokens: 200000, capabilities: { image_input: { supported: true } } }], has_more: false, last_id: "nep-claude" });
        return streamAnthropic(res, ["Wer", "kt"]);
      }
      // Weigert elke sleutel en herhaalt die in de foutmelding, zoals sommige diensten doen.
      if (p.startsWith("/badkey/v1/")) return json(res, 401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}` } });
      if (p.startsWith("/nomodel/v1/")) {
        if (p.endsWith("/models")) return json(res, 200, { data: [] });
        return json(res, 404, { error: { message: "model 'bestaat-niet' not found, try pulling it first" } });
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 page not found");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, log, bp, serveHtml: (html) => { extraPage = html; return `http://127.0.0.1:${server.address().port}/extra.html`; }, close: () => { server.closeAllConnections(); server.close(); } })));
}
