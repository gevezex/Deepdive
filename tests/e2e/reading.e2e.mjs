// End-to-endtest van selecteren, vragen en markeren in de echte app, tegen de lokale nepserver.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/reading.e2e.mjs [map-voor-schermafdrukken]
//
// In de websitekopie kan de test niet zelf selecteren: de iframe is afgeschermd. De test controleert daarom dat het
// eigen script daar draait (het meldt zich) en speelt daarna de berichten van dat script na. In de pdf selecteert de test echt.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-ai.mjs";

const SERVICE = `app.deepdive.reader.e2e.${randomBytes(4).toString("hex")}`;
const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-read-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-read-ctl-"));
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "dd-read-shots-"));
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
  app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_LANGUAGE: "nl", DEEPDIVE_KEYCHAIN_SERVICE: SERVICE }, stdio: ["ignore", "pipe", "pipe"] });
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
const frame = () => $("source-frame");
/** Speelt een bericht van het script in de kopie na, met de iframe als afzender. */
const fromFrame = (msg) => window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, data: { dd: 1, ...msg } }));
const select = (text, from, start) => fromFrame({ type: "selection", text, from, to: from, start, end: start + text.length, rect: { top: 120, left: 120, bottom: 140, right: 420 } });
const cards = () => [...document.querySelectorAll("#answers .ans-card")];
`;

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

const TEXT = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  if (n === 4) return "Alinea 4 is the English quote that the reader selects and asks about.";
  return `Alinea ${n} van het teststuk, met genoeg woorden om in de kopie een eigen regel te vullen en de pagina lang te maken.`;
}).join("\n\n");

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

const highlightsOf = (id) => {
  const f = join(data, "sources", id, "highlights.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
};
const threadsOf = (id) => {
  const dir = join(data, "sources", id, "threads");
  return existsSync(dir) ? readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
};

async function main() {
  startApp();
  await waitForApp();

  // Een model kiezen bij de nepserver.
  await run(`
    $("providers-open").click();
    $("provider-new").click();
    setValue("provider-preset", "custom");
    setValue("provider-name", "Nepserver");
    setValue("provider-url", ${JSON.stringify(`${base}/bp/v1`)});
    $("provider-form").requestSubmit();
    await settled("provider-result");
    $("models-refresh").click();
    await settled("models-result");
    $("providers-close").click();
    const p = (await invoke("list_providers")).providers.find((p) => p.name === "Nepserver");
    setValue("model-picker", JSON.stringify([p.id, "nep-blauwdruk"]));
    await wait(300);
  `);

  // ---------- het eigen script in de kopie ----------
  await run(`
    window.__dd = [];
    window.addEventListener("message", (e) => { if (e.source === frame().contentWindow && e.data?.dd === 1) window.__dd.push(e.data.type); });
    $("paste-open").click();
    $("paste-title").value = "Teststuk"; $("paste-url").value = ""; $("paste-text").value = ${JSON.stringify(TEXT)};
    $("paste-form").requestSubmit();
    await until(() => document.title.startsWith("Teststuk") && !frame().hidden, "bron");
    await until(() => window.__dd.includes("ready"), "script in de kopie");
  `);
  const sourceId = await run(`return localStorage.getItem("deepdive.lastSource")`);
  check("het script in de kopie draait en meldt zich", true);
  check("de iframe heeft alleen allow-scripts", (await run(`return frame().getAttribute("sandbox")`)) === "allow-scripts");

  // ---------- selecteren en vragen ----------
  await run(`select("Alinea 4 is the English quote", 4, 100); await wait(100);`);
  const barShown = await run(`const b = $("sel-bar"); return { hidden: b.hidden, buttons: [...b.querySelectorAll("button")].map((x) => x.textContent.trim()).filter(Boolean) }`);
  check("selectie: de balk verschijnt", !barShown.hidden && barShown.buttons.includes("Leg uit") && barShown.buttons.includes("Eenvoudiger"), JSON.stringify(barShown));
  await run(`$("sel-more").click(); await wait(100);`);
  const more = await run(`return [...document.querySelectorAll("#sel-menu .sel-menu-item strong")].map((s) => s.textContent)`);
  check("⋯ toont de andere acties", more.join("|") === "Wat betekent dit woord?|Klopt dit nog?|Waar komt dit nog terug?|Tegenargument|Citaat kopiëren", more.join("|"));
  await shot("1-balk-en-menu");
  await run(`$("sel-more").click();`);

  bp.holdAsk = true;
  await run(`document.querySelector('#sel-bar [data-action="explain"]').click(); await until(() => cards().length === 1, "kaart");`);
  const during = await run(`await wait(200); return { text: cards()[0].textContent, tab: $("tab-answers").getAttribute("aria-selected"), bar: $("sel-bar").hidden, status: cards()[0].querySelector(".ans-status")?.textContent ?? "" }`);
  check("vragen: het paneel wisselt naar Vragen en wacht zichtbaar", during.tab === "true" && during.bar && during.status.includes("Stoppen"), JSON.stringify(during));
  bp.holdAsk = false;
  await run(`await until(() => cards()[0].querySelector(".ans-follow"), "antwoord af");`);
  const answer = await run(`const c = cards()[0]; return { kern: c.querySelector(".ans-body strong")?.textContent, refs: [...c.querySelectorAll(".ans-body .bp-range")].map((b) => b.textContent), items: c.querySelectorAll(".ans-body li").length, head: c.querySelector(".ans-head").textContent, quote: c.querySelector(".ans-quote").textContent }`);
  check("antwoord: kern vet, verwijzing klikbaar, lijstje", answer.kern === "Dit is de kern van het antwoord." && answer.refs.includes("¶4") && answer.items === 2, JSON.stringify(answer));
  check("antwoord: actie, plek en selectie staan erboven", answer.head.includes("Leg uit") && answer.head.includes("¶4") && answer.quote.startsWith("Alinea 4"), JSON.stringify(answer));
  const sent = bp.asks.at(-1);
  check("verzoek: bron, selectie met plek en opdracht", sent.includes("<selection-") && sent.includes("(in ¶4)") && sent.includes("Task: Explain") && sent.includes("¶30 [paragraph]"));
  check("gesprek is bewaard", threadsOf(sourceId).length === 1 && threadsOf(sourceId)[0].turns.length === 2);
  await shot("2-antwoord");

  // Klik op ¶4 in het antwoord: springen in de kopie, zonder herladen.
  const src = await run(`return frame().getAttribute("src")`);
  await run(`[...cards()[0].querySelectorAll(".ans-body .bp-range")].find((b) => b.textContent === "¶4").click(); await wait(300);`);
  const jumped = await run(`return { src: frame().getAttribute("src"), jump: frame().dataset.jump }`);
  check("¶ in een antwoord springt in de kopie, zonder herladen", jumped.src === src && jumped.jump === "4-4", JSON.stringify(jumped));

  // Doorvragen.
  await run(`const f = cards()[0].querySelector(".ans-follow"); f.querySelector("input").value = "En waarom?"; f.requestSubmit(); await until(() => cards()[0].textContent.includes("Vervolgantwoord") && cards()[0].querySelector(".ans-follow"), "vervolg");`);
  const follow = JSON.parse(bp.asks.at(-1)).messages.map((m) => m.role).filter((r) => r !== "system");
  check("doorvragen: het hele gesprek gaat mee", follow.join() === "user,assistant,user", follow.join());
  check("doorvragen: bewaard in hetzelfde gesprek", threadsOf(sourceId).length === 1 && threadsOf(sourceId)[0].turns.length === 4);

  // Eigen vraag, en typen terwijl er iets geselecteerd is.
  await run(`select("Alinea 7 van het teststuk", 7, 900); await wait(50); fromFrame({ type: "key", key: "W" }); fromFrame({ type: "key", key: "a" }); await wait(50);`);
  const typed = await run(`return { value: $("sel-ask").value, focus: document.activeElement === $("sel-ask") }`);
  check("typen tijdens een selectie gaat naar het vraagveld", typed.value === "Wa" && typed.focus, JSON.stringify(typed));
  await run(`$("sel-ask").value = "Wat bedoelt de auteur?"; $("sel-ask-form").requestSubmit(); await until(() => cards().length === 2 && cards()[0].querySelector(".ans-follow"), "eigen vraag");`);
  check("eigen vraag: staat in de kaart en in het verzoek", (await run(`return cards()[0].querySelector(".ans-question")?.textContent`)) === "Wat bedoelt de auteur?" && bp.asks.at(-1).includes("The reader's question: Wat bedoelt de auteur?"));

  // Een actie uit het menu, en stoppen.
  bp.holdAsk = true;
  await run(`select("Alinea 9 van het teststuk", 9, 1500); $("sel-more").click(); await wait(50); [...document.querySelectorAll("#sel-menu .sel-menu-item")].find((b) => b.textContent.includes("Tegenargument")).click(); await until(() => cards().length === 3, "kaart");`);
  check("menu-actie gaat met eigen opdracht naar het model", bp.asks.at(-1)?.includes("sterkste bezwaar") ?? false);
  await sleep(300);
  await run(`[...cards()[0].querySelectorAll("button")].find((b) => b.textContent === "Stoppen").click(); await until(() => cards()[0].querySelector(".ans-follow"), "gestopt");`);
  bp.holdAsk = false;
  check("stoppen: het gesprek blijft, met een melding", (await run(`return cards()[0].textContent.includes("Gestopt")`)) === true);

  // ---------- markeren ----------
  // De laatst gekozen kleur blijft bewaard in de webview, ook tussen testruns.
  const startColor = await run(`return $("sel-mark-dot").dataset.color`);
  await run(`select("Alinea 4 is the English", 4, 100); await wait(50); $("sel-mark").click(); await wait(400);`);
  let marks = highlightsOf(sourceId);
  check("markeren: bewaard met plek, tekst en kleur", marks.length === 1 && marks[0].color === startColor && marks[0].anchor.kind === "web" && marks[0].anchor.end - marks[0].anchor.start === "Alinea 4 is the English".length && marks[0].from === 4, JSON.stringify(marks));
  await run(`fromFrame({ type: "mark-click", id: ${JSON.stringify(marks[0]?.id)}, rect: { top: 120, left: 120, bottom: 140, right: 300 } }); await wait(100);`);
  const menuShown = await run(`return { hidden: $("mark-menu").hidden, swatches: document.querySelectorAll("#mark-menu .sel-swatch").length }`);
  check("klik op een markering: kleuren en acties", !menuShown.hidden && menuShown.swatches === 4, JSON.stringify(menuShown));
  await shot("3-markering-menu");
  await run(`document.querySelector('#mark-menu .sel-swatch[data-color="${startColor === "pink" ? "green" : "pink"}"]').click(); await wait(400);`);
  const newColor = startColor === "pink" ? "green" : "pink";
  check("andere kleur: bewaard, plek blijft", highlightsOf(sourceId)[0]?.color === newColor && highlightsOf(sourceId)[0]?.anchor.start === marks[0].anchor.start);
  check("de gekozen kleur is de nieuwe standaard", (await run(`return $("sel-mark-dot").dataset.color`)) === newColor);
  await run(`select("Alinea 12 van", 12, 2400); await wait(50); $("sel-note").click(); await until(() => !$("note-pop").hidden, "notitie"); $("note-text").value = "Mijn eigen gedachte"; $("note-save").click(); await wait(400);`);
  marks = highlightsOf(sourceId);
  check("notitie: markering met notitie", marks.length === 2 && marks[1].note === "Mijn eigen gedachte" && marks[1].color === newColor, JSON.stringify(marks));
  await run(`fromFrame({ type: "mark-click", id: ${JSON.stringify(marks[0].id)}, rect: { top: 120, left: 120, bottom: 140, right: 300 } }); await wait(50); [...document.querySelectorAll("#mark-menu button")].find((b) => b.title === "Markering weghalen").click(); await wait(400);`);
  check("markering weghalen", highlightsOf(sourceId).length === 1);

  // Na opnieuw openen: gesprekken en markeringen zijn er nog, en het script krijgt de markeringen.
  await run(`window.__dd = []; location.reload();`).catch(() => {});
  await sleep(1500);
  await waitForApp();
  const reopened = await run(`await until(() => cards().length === 3, "gesprekken"); return { count: $("answers-count").textContent }`);
  check("opnieuw openen: gesprekken staan er nog", reopened.count === "3", JSON.stringify(reopened));
  await shot("4-na-opnieuw-openen");

  // ---------- pdf: echt selecteren in de tekstlaag ----------
  const pdf = Buffer.from(tinyPdf(), "latin1").toString("base64");
  await run(`
    const bytes = Uint8Array.from(atob(${JSON.stringify(pdf)}), (c) => c.charCodeAt(0));
    const list = new DataTransfer();
    list.items.add(new File([bytes], "test.pdf", { type: "application/pdf" }));
    const input = $("pdf-input");
    input.files = list.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => !$("pdf-view").hidden && document.querySelector(".pdf-page .textLayer span"), "pdf met tekstlaag");
    await wait(1500);
  `);
  const pdfId = await run(`return localStorage.getItem("deepdive.lastSource")`);
  const pdfSel = await run(`
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) => s.textContent.includes("Eerste"));
    const range = document.createRange();
    range.setStart(span.firstChild, 0);
    range.setEnd(span.firstChild, 13);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $("pdf-view").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await until(() => !$("sel-bar").hidden, "balk bij pdf");
    return true;
  `);
  check("pdf: echte selectie geeft de balk", pdfSel === true);
  const drag = await run(`
    getSelection().removeAllRanges(); await wait(300);
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) => s.textContent.includes("Eerste"));
    span.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const range = document.createRange(); range.setStart(span.firstChild, 0); range.setEnd(span.firstChild, 13);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    await wait(500);
    const during = $("sel-bar").hidden;
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await wait(200);
    return { during, after: $("sel-bar").hidden };
  `);
  check("pdf: tijdens het slepen geen balk, na loslaten wel", drag.during === true && drag.after === false, JSON.stringify(drag));
  const menuBlocked = await run(`
    const ev = (el) => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e.defaultPrevented; };
    return { page: ev($("pdf-view")), input: ev($("url-input")) };
  `);
  check("rechtermuisknop: geen systeemmenu, behalve in invoervelden", menuBlocked.page === true && menuBlocked.input === false, JSON.stringify(menuBlocked));
  await run(`$("sel-mark").click(); await until(() => document.querySelector(".pdf-hl"), "markering in pdf");`);
  const pdfMarks = highlightsOf(pdfId);
  check("pdf: markering met rechthoeken en alinea", pdfMarks.length === 1 && pdfMarks[0].anchor.kind === "pdf" && pdfMarks[0].anchor.rects[0].page === 1 && pdfMarks[0].from === 1 && pdfMarks[0].text === "Eerste alinea", JSON.stringify(pdfMarks));
  await run(`
    const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .textLayer span')].find((s) => s.textContent.includes("Eerste"));
    const range = document.createRange(); range.setStart(span.firstChild, 0); range.setEnd(span.firstChild, 13);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    $("pdf-view").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await until(() => !$("sel-bar").hidden, "balk");
    document.querySelector('#sel-bar [data-action="simplify"]').click();
    await until(() => cards().length === 1 && cards()[0].querySelector(".ans-follow"), "antwoord bij pdf");
  `);
  check("pdf: vragen werkt ook, met de alinea", bp.asks.at(-1).includes("(in ¶1)") && bp.asks.at(-1).includes("Task: Say the same idea"));
  await shot("5-pdf");

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
