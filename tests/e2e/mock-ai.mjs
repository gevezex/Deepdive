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

export function startMock(expectedKey) {
  const log = [];
  let extraPage = "";
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
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, log, serveHtml: (html) => { extraPage = html; return `http://127.0.0.1:${server.address().port}/extra.html`; }, close: () => { server.closeAllConnections(); server.close(); } })));
}
