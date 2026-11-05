// End-to-endtest van de blauwdruk in de echte app, tegen de lokale nepserver: knop, stap voor stap tonen, springen,
// afbreken, meldingen, bewaren en opnieuw openen. Er gaat niets naar een echt model en er is geen sleutel nodig.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/blueprint.e2e.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-ai.mjs";

const SERVICE = `app.deepdive.reader.e2e.${randomBytes(4).toString("hex")}`;
const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-bp-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-bp-ctl-"));
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "dd-bp-shots-"));
const mock = await startMock("niet-gebruikt");
const bp = mock.bp;
const base = `http://127.0.0.1:${mock.port}`;
let appOutput = "";
let app;
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FOUT"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function startApp() {
  app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_KEYCHAIN_SERVICE: SERVICE }, stdio: ["ignore", "pipe", "pipe"] });
  app.stdout.on("data", (d) => (appOutput += d));
  app.stderr.on("data", (d) => (appOutput += d));
}

async function stopApp() {
  const done = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await done;
}

async function raw(js) {
  const out = join(ctl, "out.json");
  rmSync(out, { force: true });
  writeFileSync(join(ctl, "cmd.tmp"), js);
  renameSync(join(ctl, "cmd.tmp"), join(ctl, "cmd.js"));
  for (let i = 0; i < 300; i++) {
    await sleep(50);
    if (existsSync(out)) return readFileSync(out, "utf8");
  }
  throw new Error(`geen antwoord op: ${js.slice(0, 100)}`);
}

const HELPERS = `
const $ = (id) => document.getElementById(id);
const invoke = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
const settled = async (id) => { for (let i = 0; i < 1800; i++) { await wait(50); const e = $(id); if (!e.hidden && !e.classList.contains("notice-busy") && e.textContent) return { tone: e.className, text: e.textContent }; } throw "geen uitslag in " + id; };
const until = async (fn, what) => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await wait(25); } throw "te lang gewacht op " + what; };
const paste = async (title, text) => {
  const before = $("source-list").options.length;
  $("paste-open").click();
  $("paste-title").value = title; $("paste-url").value = ""; $("paste-text").value = text;
  $("paste-form").requestSubmit();
  await until(() => document.title.startsWith(title) && $("source-list").options.length !== before, "bron " + title);
  await wait(300);
};
const steps = () => [...document.querySelectorAll(".bp-step")].map((s) => s.dataset.state).join();
`;

/** Voert asynchrone code uit in het hoofdvenster en geeft het resultaat terug. */
async function run(body, timeoutMs = 30000) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:e&&e.message?e:String(e)});0`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let value = JSON.parse(await raw(`JSON.stringify(window.__r)`));
    if (typeof value === "string") value = JSON.parse(value);
    if (value) {
      if ("err" in value) throw new Error(`in de app: ${JSON.stringify(value.err)}`);
      return value.ok;
    }
    await sleep(50);
  }
  throw new Error(`te lang gewacht op: ${body.slice(0, 100)}`);
}

async function shot(name) {
  const tiff = join(shots, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  await sleep(300);
  execFileSync("sips", ["-s", "format", "png", tiff, "--out", join(shots, `${name}.png`)], { stdio: "ignore" });
  rmSync(tiff, { force: true });
  return join(shots, `${name}.png`);
}

async function waitForApp() {
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("providers-open")`, 3000)) === true) break;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
  }
  await sleep(500);
}

// Veertig alinea's: de eerste zijn Engels voor de citaten, en het geheel is langer dan het scherm, zodat springen te zien is.
const TEXT = Array.from({ length: 40 }, (_, i) => {
  const n = i + 1;
  if (n === 4) return "Alinea 4 is the English quote that must stay in English when it is shown on the screen.";
  if (n === 12) return "Alinea 12 is the strong evidence that the author names with its source and sample.";
  return `Alinea ${n} van het teststuk, met genoeg woorden om in de kopie een eigen regel te vullen en de pagina lang te maken voor het springen.`;
}).join("\n\n");

/** Een kleine pdf met tekst op twee pagina's. */
function tinyPdf() {
  const page = (lines) => `BT /F1 12 Tf 72 700 Td 16 TL ${lines.map((l) => `(${l}) Tj T*`).join(" ")} ET`;
  const streams = [page(["Eerste alinea op de eerste pagina van de test."]), page(["Laatste alinea op de tweede pagina van de test."])];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

async function addProvider() {
  await run(`
    $("providers-open").click();
    $("provider-new").click();
    setValue("provider-preset", "custom");
    setValue("provider-name", "Nepserver");
    setValue("provider-url", ${JSON.stringify(`${base}/bp/v1`)});
    const r = $("provider-result"); r.hidden = true; r.replaceChildren();
    $("provider-form").requestSubmit();
    await settled("provider-result");
    await wait(100);
    const m = $("models-result"); m.hidden = true; m.replaceChildren();
    $("models-refresh").click();
    await settled("models-result");
    $("providers-close").click();
    await wait(200);
  `);
  const state = await run(`return invoke("list_providers")`);
  const provider = state.providers.find((p) => p.name === "Nepserver");
  return { provider, value: JSON.stringify([provider.id, "nep-blauwdruk"]) };
}

const blueprintFiles = (sourceId) => {
  const dir = join(data, "sources", sourceId, "blueprints");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
};

async function main() {
  startApp();
  await waitForApp();
  check("de app start op macOS", true);

  // ---------- zonder bron en zonder model ----------
  check("zonder bron: uitleg in plaats van een knop", (await run(`return !$("bp-start") && $("blueprint").textContent.includes("Open eerst een stuk")`)) === true);
  await run(`await paste("Teststuk", ${JSON.stringify(TEXT)});`);
  const sourceId = await run(`return JSON.parse(localStorage.getItem("deepdive.lastSource") ?? "null") ?? localStorage.getItem("deepdive.lastSource")`).catch(() => null) ?? (await run(`return localStorage.getItem("deepdive.lastSource")`));
  check("knop staat in het rechterpaneel", (await run(`return $("bp-start").closest(".professor") !== null`)) === true);
  await run(`$("bp-start").click(); await until(() => $("bp-error"), "melding");`);
  const noModel = await run(`const e = $("bp-error"); return { kind: e.dataset.kind, text: e.textContent, providers: !!$("bp-action-providers") }`);
  check("geen model: eigen melding, met weg naar Providers", noModel.kind === "no_model" && noModel.text.includes("Kies eerst een model") && noModel.providers, JSON.stringify(noModel));
  check("geen model: niets verstuurd", bp.calls.length === 0);
  await shot("1-geen-model");

  // ---------- stap voor stap ----------
  const { provider, value } = await addProvider();
  const noDefault = await run(`return [$("model-picker").value, (await invoke("list_providers")).selection.active]`);
  check("een nieuw model wordt niet stilletjes gekozen", noDefault[0] === "" && noDefault[1] === null, JSON.stringify(noDefault));
  await run(`setValue("model-picker", ${JSON.stringify(value)}); await wait(300);`);
  const hint = await run(`return { note: $("bp-local-note")?.textContent ?? "", start: $("bp-start").closest(".bp-start").textContent, error: !!$("bp-error") }`);
  check("lokaal model: de duur wordt vooraf genoemd", hint.note.includes("lang duren") && hint.note.includes("kwartier"), JSON.stringify(hint));
  check("knop noemt het gekozen model", hint.start.includes("nep-blauwdruk"), hint.start);

  bp.holdAfterGoal = true;
  bp.holdAfterBlock = true;
  bp.holdCritique = true;
  await run(`$("bp-start").click(); await until(() => $("bp-progress"), "voortgang");`);
  check("voortgang is meteen zichtbaar", (await run(`return !!$("bp-cancel") && !$("bp-start")`)) === true);
  await run(`await until(() => $("bp-message"), "boodschap");`);
  const goalStage = await run(`await wait(100); return { message: $("bp-message").textContent, summary: $("bp-goal").textContent, diagram: !!$("bp-diagram"), critique: !!$("bp-critique"), steps: steps(), line: $("bp-progress-line").textContent }`);
  check("doel en boodschap staan er terwijl de rest nog komt", goalStage.message.includes("boodschap van de nepblauwdruk") && goalStage.summary.includes("samenvatting") && !goalStage.diagram && !goalStage.critique, JSON.stringify(goalStage));
  check("voortgang: doel klaar, diagram bezig", goalStage.steps === "done,now,todo", goalStage.steps);
  check("voortgang noemt model en tijd", goalStage.line.includes("nep-blauwdruk") && /\d+ s/.test(goalStage.line), goalStage.line);
  await shot("2-doel-klaar");

  bp.holdAfterGoal = false;
  await run(`await until(() => document.querySelector(".bp-block"), "eerste blok");`);
  const blockStage = await run(`return { blocks: document.querySelectorAll(".bp-block").length, rels: document.querySelectorAll(".bp-rel").length, critique: !!$("bp-critique") }`);
  check("diagram groeit blok voor blok", blockStage.blocks === 1 && blockStage.rels === 0 && !blockStage.critique, JSON.stringify(blockStage));

  bp.holdAfterBlock = false;
  await run(`await until(() => document.querySelectorAll(".bp-rel").length === 5, "relaties");`);
  const structureStage = await run(`return { blocks: document.querySelectorAll(".bp-block").length, waiting: $("bp-critique")?.textContent ?? "", points: document.querySelectorAll(".bp-point").length, steps: steps(), arrows: document.querySelectorAll(".bp-arrow").length }`);
  check("diagram staat vóór de kritische laag", structureStage.blocks === 5 && structureStage.points === 0 && structureStage.waiting.includes("wordt gemaakt"), JSON.stringify(structureStage));
  check("pijlen uit de data, zonder Mermaid", structureStage.arrows === 5 && (await run(`return !document.querySelector(".mermaid") && !!document.querySelector(".bp-arrows path")`)) === true);
  check("voortgang: alleen de kritiek loopt nog", structureStage.steps === "done,done,now", structureStage.steps);
  check("structuur is al bewaard terwijl de kritiek loopt", blueprintFiles(sourceId).length === 1);
  await shot("3-diagram-klaar");

  bp.holdCritique = false;
  await run(`await until(() => $("bp-outcomes"), "kritiek");`);
  check("twee aanroepen: structuur, dan kritiek", bp.calls.join() === "structure,critique", bp.calls.join());
  await run(`await wait(100);`);
  check("knop verdwijnt, voortgang ook", (await run(`return !$("bp-progress") && !$("bp-start")`)) === true);
  const origin = await run(`return $("bp-origin").textContent`);
  check("toont welk model de blauwdruk maakte", origin.includes("nep-blauwdruk") && origin.includes("Gemaakt met"), origin);
  check("biedt Opnieuw maken aan", (await run(`return $("bp-again").textContent`)) === "Opnieuw maken");

  // ---------- wat er op het scherm staat ----------
  const shown = await run(`
    const point = (id) => document.querySelector('[data-point="' + id + '"]');
    const style = (id) => getComputedStyle(point(id)).borderLeftStyle;
    const out = {};
    out.onArrow = !!document.querySelector('[data-rel="r4"] [data-point="k1"]');
    out.onBlock = !!document.querySelector('[data-block="b3"] [data-point="k2"]');
    out.loose = !!document.querySelector('#bp-critique [data-point="k4"]');
    out.minus = point("k1").querySelector(".bp-sign").textContent;
    out.plus = point("k2").querySelector(".bp-sign").textContent;
    out.colorDiffers = getComputedStyle(point("k1")).backgroundColor !== getComputedStyle(point("k2")).backgroundColor;
    out.stated = [style("k2"), point("k2").dataset.origin, point("k2").querySelector(".bp-origin").textContent];
    out.inferred = [style("k1"), point("k1").dataset.origin, point("k1").querySelector(".bp-origin").textContent, getComputedStyle(point("k1").querySelector(".bp-claim")).fontStyle];
    out.statedStyle = getComputedStyle(point("k2").querySelector(".bp-claim")).fontStyle;
    out.outcomes = Object.fromEntries([...document.querySelectorAll(".bp-outcome")].map((o) => [o.dataset.category, [o.dataset.result, o.querySelector("dd").textContent, getComputedStyle(o).opacity]]));
    out.quote = document.querySelector('[data-block="b2"] .bp-quote').textContent;
    out.terms = $("bp-terms").textContent;
    out.pointCount = document.querySelectorAll(".bp-point").length;
    out.text = $("blueprint").textContent;
    out.arrowMinus = !!document.querySelector(".bp-arrow.has-minus");
    return out;
  `);
  check("punt hangt aan de pijl", shown.onArrow && shown.arrowMinus);
  check("punt hangt aan het blok", shown.onBlock);
  check("punt zonder plek staat los", shown.loose);
  check("plus en min zijn zichtbaar verschillend", shown.minus === "−" && shown.plus === "+" && shown.colorDiffers, JSON.stringify([shown.minus, shown.plus]));
  check("gezegd: doorgetrokken lijn en het woord gezegd", shown.stated.join() === "solid,stated,gezegd" && shown.statedStyle === "normal", JSON.stringify(shown.stated));
  check("afgeleid: gestippeld, cursief en het woord afgeleid", shown.inferred.join() === "dashed,inferred,afgeleid,italic", JSON.stringify(shown.inferred));
  check("niets gevonden is een gewone uitkomst", shown.outcomes.assumption[0] === "nothing_found" && shown.outcomes.assumption[1] === "niets gevonden" && shown.outcomes.assumption[2] === "1", JSON.stringify(shown.outcomes.assumption));
  check("niet van toepassing is een gewone uitkomst, met toelichting", shown.outcomes.headline_vs_content[0] === "not_applicable" && shown.outcomes.headline_vs_content[1].includes("niet van toepassing") && shown.outcomes.headline_vs_content[1].includes("geen kop") && shown.outcomes.headline_vs_content[2] === "1", JSON.stringify(shown.outcomes.headline_vs_content));
  check("citaat blijft in de brontaal", shown.quote.includes("Alinea 4 is the English quote"), shown.quote);
  check("begrippen staan apart en tellen niet als punt", shown.terms.includes("Nepwoord") && shown.terms.includes("geen kritiek") && shown.pointCount === 4);
  check("dekking staat niet op het scherm", !/dekking|coverage|\d+\s?%/i.test(shown.text), shown.text.match(/.{30}(dekking|coverage|%).{10}/i)?.[0]);
  check("oordeel staat erbij", shown.text.includes("redelijk stevig"));
  const panelOk = await run(`const b = $("blueprint"); return { horizontal: b.scrollWidth <= b.clientWidth + 1, narrow: b.clientWidth }`);
  check("diagram past in het paneel, zonder zijwaarts scrollen", panelOk.horizontal, JSON.stringify(panelOk));
  await shot("4-klaar");

  // ---------- springen ----------
  const frameBefore = await run(`return { src: $("source-frame").getAttribute("src"), sandbox: $("source-frame").getAttribute("sandbox") }`);
  check("de kopie staat in een iframe zonder rechten", frameBefore.sandbox === "" && !frameBefore.src.includes("hl="), JSON.stringify(frameBefore));
  const before = readFileSync(await shot("5-voor-sprong"));
  await run(`document.querySelector('[data-block="b5"] .bp-block-head').click(); await wait(800);`);
  const afterJump = await run(`return { src: $("source-frame").getAttribute("src"), sandbox: $("source-frame").getAttribute("sandbox"), selected: document.querySelector('[data-block="b5"]').classList.contains("is-selected") }`);
  check("klik op een blok springt naar die alinea's", afterJump.src.endsWith("/index.html?hl=31-40#dd-doel"), afterJump.src);
  check("het blok licht op in het paneel", afterJump.selected);
  check("de afscherming is niet veranderd", afterJump.sandbox === "");
  const after = readFileSync(await shot("6-na-sprong"));
  check("links is het beeld veranderd", !before.equals(after));
  await run(`document.querySelector('[data-point="k1"] .bp-point-head').click(); await wait(600);`);
  const pointJump = await run(`return { src: $("source-frame").getAttribute("src"), explanation: document.querySelector('[data-point="k1"] .bp-point-more')?.textContent ?? "" }`);
  check("klik op een punt springt en klapt de uitleg uit", pointJump.src.includes("hl=31-32#") && pointJump.explanation.includes("over iets anders"), JSON.stringify(pointJump));
  check("zekerheid staat bij het uitgeklapte punt", (await run(`return document.querySelector('[data-point="k1"] .bp-certainty').textContent`)) === "Zekerheid: gemiddeld");
  await shot("7-punt-open");
  await run(`document.querySelector('[data-point="k3"] .bp-point-head').click(); await wait(400);`);
  const broad = await run(`return { src: $("source-frame").getAttribute("src"), text: document.querySelector('[data-point="k3"] .bp-point-more').textContent }`);
  check("breed punt springt naar het begin en zegt dat", broad.src.includes("hl=1-1#") && broad.text.includes("groot deel van het stuk"), JSON.stringify(broad));
  await run(`document.querySelector('[data-rel="r2"] .bp-rel-head').click(); await wait(300);`);
  check("klik op een pijl springt ook", (await run(`return $("source-frame").getAttribute("src")`)).includes("hl=11-20#"));
  const repairs = await run(`return $("bp-repairs")?.textContent ?? ""`);
  check("wat de controle markeerde is na te lezen", repairs.includes("te veel alinea's"), repairs);

  // ---------- bewaren en opnieuw openen ----------
  const callsBefore = bp.calls.length;
  await stopApp();
  startApp();
  await waitForApp();
  await run(`await until(() => $("bp-origin"), "bewaarde blauwdruk");`);
  const reopened = await run(`return { origin: $("bp-origin").textContent, message: $("bp-message").textContent, blocks: document.querySelectorAll(".bp-block").length, points: document.querySelectorAll(".bp-point").length, again: !!$("bp-again") }`);
  check("na herstart staat alles er weer", reopened.blocks === 5 && reopened.points === 4 && reopened.message.includes("boodschap") && reopened.origin.includes("nep-blauwdruk"), JSON.stringify(reopened));
  check("opnieuw openen roept geen model aan", bp.calls.length === callsBefore, bp.calls.join());
  check("per bron, model en promptversie één bestand", blueprintFiles(sourceId).length === 1 && /-p2\.json$/.test(blueprintFiles(sourceId)[0]), blueprintFiles(sourceId).join());
  await shot("8-heropend");

  // ---------- opnieuw maken, en afbreken ----------
  bp.holdAfterGoal = true;
  await run(`$("bp-again").click(); await until(() => $("bp-message") && $("bp-cancel"), "tweede poging"); await wait(150);`);
  await shot("9-afbreken-kan");
  await run(`$("bp-cancel").click(); await until(() => !$("bp-progress"), "einde na afbreken"); await wait(200);`);
  bp.holdAfterGoal = false;
  await sleep(200);
  check("afbreken sluit de verbinding met het model", bp.aborted.includes("structure"), bp.aborted.join());
  const cancelled = await run(`return { note: document.querySelector(".bp-note")?.textContent ?? "", blocks: document.querySelectorAll(".bp-block").length, points: document.querySelectorAll(".bp-point").length, error: !!$("bp-error") }`);
  check("afgebroken: het oude resultaat komt terug", cancelled.blocks === 5 && cancelled.points === 4 && cancelled.note.includes("Afgebroken") && !cancelled.error, JSON.stringify(cancelled));

  // Tweede poging na een onbruikbaar antwoord: wat er al stond verdwijnt, en daarna komt het goed.
  bp.badStructureOnce = true;
  bp.calls.length = 0;
  await run(`$("bp-again").click(); await until(() => $("bp-outcomes") && !$("bp-progress"), "na herstelpoging");`);
  check("onbruikbaar antwoord krijgt één herkansing", bp.calls.join() === "structure,structure,critique", bp.calls.join());

  // ---------- mislukte kritiek ----------
  await run(`await paste("Tweede stuk", ${JSON.stringify(TEXT)});`);
  check("nieuwe bron: geen oude blauwdruk op het scherm", (await run(`return !!$("bp-start") && !document.querySelector(".bp-block")`)) === true);
  bp.failCritique = { status: 500, message: "kapot" };
  await run(`$("bp-start").click(); await until(() => $("bp-critique-missing"), "melding over de kritiek");`);
  const failed = await run(`return { text: $("bp-critique-missing").textContent, blocks: document.querySelectorAll(".bp-block").length, message: $("bp-message").textContent, retry: !!$("bp-critique-retry"), onTop: !!($("bp-critique-missing").compareDocumentPosition($("bp-diagram")) & Node.DOCUMENT_POSITION_FOLLOWING) }`);
  check("mislukte kritiek: de melding staat boven het diagram", failed.onTop);
  check("mislukte kritiek: structuur blijft staan, met melding", failed.blocks === 5 && failed.message.includes("boodschap") && failed.text.includes("niet gelukt") && failed.retry, JSON.stringify(failed));
  await shot("10-kritiek-mislukt");
  bp.failCritique = null;
  bp.calls.length = 0;
  await run(`$("bp-critique-retry").click(); await until(() => $("bp-outcomes"), "kritiek na herkansing");`);
  check("opnieuw proberen doet alleen de kritiek", bp.calls.join() === "critique", bp.calls.join());
  check("daarna is de melding weg", (await run(`return !$("bp-critique-missing")`)) === true);

  // ---------- afbreken tijdens de kritiek ----------
  await run(`await paste("Derde stuk", ${JSON.stringify(TEXT)});`);
  bp.holdCritique = true;
  await run(`$("bp-start").click(); await until(() => document.querySelector(".bp-rel"), "structuur"); await wait(100); $("bp-cancel").click(); await until(() => $("bp-critique-missing"), "afgebroken kritiek");`);
  bp.holdCritique = false;
  const stopped = await run(`return { text: $("bp-critique-missing").textContent, blocks: document.querySelectorAll(".bp-block").length, retry: !!$("bp-critique-retry"), error: !!$("bp-error") }`);
  check("afgebroken kritiek: doel en diagram blijven bewaard", stopped.blocks === 5 && stopped.text.includes("afgebroken") && stopped.retry && !stopped.error, JSON.stringify(stopped));

  // ---------- doorlezen in een ander stuk terwijl de blauwdruk loopt ----------
  await run(`await paste("Vierde stuk", ${JSON.stringify(TEXT)});`);
  bp.holdCritique = true;
  await run(`$("bp-start").click(); await until(() => document.querySelector(".bp-rel"), "structuur");`);
  const fourth = await run(`return localStorage.getItem("deepdive.lastSource")`);
  await run(`setValue("source-list", ${JSON.stringify(sourceId)}); await until(() => $("bp-origin"), "ander stuk");`);
  check("een ander stuk toont zijn eigen blauwdruk", (await run(`return !$("bp-progress")`)) === true);
  await run(`setValue("source-list", ${JSON.stringify(fourth)}); await until(() => $("bp-progress"), "terug bij lopende blauwdruk");`);
  check("terug: de lopende blauwdruk is er nog", (await run(`return document.querySelectorAll(".bp-block").length`)) === 5);
  bp.holdCritique = false;
  await run(`await until(() => $("bp-outcomes"), "klaar");`);
  check("en maakt zichzelf af", (await run(`return !$("bp-progress")`)) === true);

  // ---------- te lange tekst ----------
  await run(`
    await invoke("save_model", { providerId: ${JSON.stringify(provider.id)}, input: { id: "klein", displayName: null, supportsImages: null, contextTokens: 100, enabled: true } });
  `).catch(async () => {});
  const stateNow = await run(`return invoke("list_providers")`);
  const small = stateNow.providers.find((p) => p.id === provider.id).models.find((m) => m.id === "klein");
  if (small) {
    await run(`await paste("Te lang", ${JSON.stringify(TEXT)});`);
    await run(`await invoke("select_model", { selection: { providerId: ${JSON.stringify(provider.id)}, modelId: "klein" } });`);
    bp.calls.length = 0;
    await run(`$("bp-start").click(); await until(() => $("bp-error"), "melding");`);
    const tooLong = await run(`const e = $("bp-error"); return { kind: e.dataset.kind, text: e.textContent, picker: !!$("bp-action-picker") }`);
    check("te lange tekst: eigen melding, niets verstuurd", tooLong.kind === "context_too_large" && tooLong.text.includes("te lang") && tooLong.picker && bp.calls.length === 0, JSON.stringify(tooLong));
    await shot("11-te-lang");
    await run(`await invoke("select_model", { selection: { providerId: ${JSON.stringify(provider.id)}, modelId: "nep-blauwdruk" } });`);
  } else {
    check("testmodel met kleine context is aangemaakt", false);
  }

  // ---------- waarschuwing bij een onvolledige bron ----------
  await stopApp();
  const sourceFile = join(data, "sources", fourth, "source.json");
  const blueprintDir = join(data, "sources", fourth, "blueprints");
  const source = JSON.parse(readFileSync(sourceFile, "utf8"));
  source.completeness = { verdict: "likely_incomplete", reason: "De tekst stopt midden in een zin.", signals: [], acceptedByUser: false };
  writeFileSync(sourceFile, JSON.stringify(source));
  rmSync(blueprintDir, { recursive: true });
  startApp();
  await waitForApp();
  await run(`setValue("model-picker", ${JSON.stringify(value)}); await wait(200); setValue("source-list", ${JSON.stringify(fourth)}); await until(() => $("bp-warning"), "waarschuwing");`);
  const before2 = await run(`return { first: $("blueprint").firstElementChild.id, text: $("bp-warning").textContent }`);
  check("onvolledige bron: waarschuwing staat bovenaan, al vóór het maken", before2.first === "bp-warning" && before2.text.includes("waarschijnlijk onvolledig") && before2.text.includes("midden in een zin"), JSON.stringify(before2));
  await run(`$("bp-start").click(); await until(() => $("bp-outcomes"), "blauwdruk"); await wait(150);`);
  const after2 = await run(`return { first: $("blueprint").firstElementChild.id, text: $("bp-warning").textContent }`);
  check("onvolledige bron: en erna nog steeds", after2.first === "bp-warning" && after2.text.includes("blauwdruk gaat over een waarschijnlijk onvolledig stuk"), JSON.stringify(after2));
  await shot("12-onvolledig");

  // ---------- pdf ----------
  const pdf = Buffer.from(tinyPdf(), "latin1").toString("base64");
  await run(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(pdf)}), (c) => c.charCodeAt(0));
    const list = new DataTransfer();
    list.items.add(new File([bytes], "test.pdf", { type: "application/pdf" }));
    const input = $("pdf-input");
    input.files = list.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => !$("pdf-view").hidden && document.querySelectorAll(".pdf-page").length === 2, "pdf");
    await until(() => $("bp-start"), "knop bij pdf");
    await wait(1200);
  `);
  bp.holdAfterGoal = false;
  await run(`$("bp-start").click(); await until(() => $("bp-outcomes"), "blauwdruk van de pdf"); await wait(100);`);
  const pdfBlocks = await run(`return [...document.querySelectorAll(".bp-block")].map((b) => b.querySelector(".bp-para")?.textContent ?? "")`);
  check("pdf: verzonnen alinea's zijn weg", pdfBlocks.filter(Boolean).every((t) => /^¶[12](–2)?$/.test(t)), pdfBlocks.join("|"));
  await run(`[...document.querySelectorAll(".bp-block-head")].find((b) => b.textContent.includes("¶1")).click(); await wait(300);`);
  const pdfJump = await run(`const v = $("pdf-view"); const m = document.querySelector(".pdf-mark"); return { marks: document.querySelectorAll(".pdf-mark").length, page: m?.parentElement.dataset.page, top: parseFloat(m?.style.top), sandbox: $("source-frame").getAttribute("sandbox") }`);
  check("pdf: klik markeert de plek op de pagina", pdfJump.marks >= 1 && pdfJump.page === "1" && pdfJump.top > 5 && pdfJump.top < 30, JSON.stringify(pdfJump));
  await shot("13-pdf");

  check("geen paniek in de app", !appOutput.includes("panicked"), appOutput.slice(-500));
}

try {
  await main();
} catch (e) {
  check("test liep door zonder fout", false, e.message);
  console.log(appOutput.slice(-2000));
} finally {
  if (app && app.exitCode === null) await stopApp().catch(() => {});
  mock.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} controle(s) mislukt` : "\nAlles goed");
console.log(`Schermafdrukken: ${shots}`);
process.exit(failures ? 1 : 0);
