// End-to-endtest van het weghalen van popups, tegen de echte app en een lokale testsite. Alleen testgegevens.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/popups.e2e.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSite } from "./mock-site.mjs";

const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-popup-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-popup-ctl-"));
const shots = process.argv[2];
const site = await startSite("niet-gebruikt");
const base = `http://127.0.0.1:${site.port}`;
let app;
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FOUT"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
function startApp() {
  app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_LANGUAGE: "nl", DEEPDIVE_KEYCHAIN_SERVICE: "app.deepdive.reader.e2e-popups" }, stdio: "ignore" });
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
  for (let i = 0; i < 400; i++) {
    await sleep(50);
    if (existsSync(out)) return readFileSync(out, "utf8");
  }
  throw new Error(`geen antwoord op: ${js.slice(0, 100)}`);
}
async function run(body, timeoutMs = 120000) {
  await raw(`window.__r=null;(async()=>{const $=(id)=>document.getElementById(id);const invoke=window.__TAURI_INTERNALS__.invoke;const wait=(ms)=>new Promise((r)=>setTimeout(r,ms));${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:JSON.stringify(e)||String(e)});0`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let value = JSON.parse(await raw("JSON.stringify(window.__r)"));
    if (typeof value === "string") value = JSON.parse(value);
    if (value) {
      if ("err" in value) throw new Error(`in de app: ${value.err}`);
      return value.ok;
    }
    await sleep(100);
  }
  throw new Error(`te lang gewacht op: ${body.slice(0, 100)}`);
}
const open = (path) => run(`const s=await invoke("open_url",{url:${JSON.stringify(base + path)},refresh:true});$("source-list").value="";return s;`);
const show = (id) => run(`await invoke("list_sources");const o=new Option("x",${JSON.stringify(id)});$("source-list").add(o);$("source-list").value=${JSON.stringify(id)};$("source-list").dispatchEvent(new Event("change"));await wait(1500);return {label:$("hide-floating").textContent,hidden:$("hide-floating").hidden,src:$("source-frame").getAttribute("src"),sandbox:$("source-frame").getAttribute("sandbox")};`);
const pagePath = (id, name = "index.html") => join(data, "sources", id, name);
const page = (id) => readFileSync(pagePath(id), "utf8");
const hash = (id) => createHash("sha256").update(readFileSync(pagePath(id))).digest("hex");
async function shot(name) {
  if (!shots) return null;
  const tiff = join(shots, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  const png = join(shots, `${name}.png`);
  execFileSync("sips", ["-s", "format", "png", tiff, "--out", png], { stdio: "ignore" });
  rmSync(tiff);
  return png;
}

startApp();
await sleep(2500);
try {
  // Laag 1: bij het vastleggen.
  const sub = await open("/popup-inschrijf");
  check("inschrijflaag die later verschijnt is weg", !page(sub.id).includes("POPUPTEKST"));
  check("hele stuk bewaard", sub.blocks.length >= 40 && sub.wordCount > 900, `${sub.blocks.length} blokken, ${sub.wordCount} woorden`);

  const bar = await open("/popup-balk");
  check("appbalk onderin is weg", !page(bar.id).includes("POPUPTEKST"));
  check("stuk onder de appbalk bewaard", bar.blocks.length >= 40);

  const lock = await open("/popup-slot");
  const locked = page(lock.id);
  check("laag op vergrendelde pagina is weg", !locked.includes("POPUPTEKST"));
  check("scrollen staat weer aan", /<html[^>]*overflow-y: visible !important/.test(locked) && /<body[^>]*overflow-y: visible !important/.test(locked), locked.slice(0, 400));
  check("body zit niet meer vast", /<body[^>]*position: relative !important/.test(locked));

  const wall = await open("/popup-betaalmuur");
  check("betaalmuur blijft staan", page(wall.id).includes("MUURTEKST"));

  const menu = await open("/popup-menu");
  check("zwevend menu blijft staan", page(menu.id).includes("MENUTEKST"));

  // Laag 2: de uitweg, op een kopie met een laag die de herkenning niet kent.
  const rest = await open("/popup-onbekend");
  check("onbekende laag blijft bij het vastleggen staan", page(rest.id).includes("BLIJFTTEKST"));
  const before = hash(rest.id);
  const viewed = await show(rest.id);
  check("knop staat klaar", viewed.label === "Popup weghalen" && !viewed.hidden, JSON.stringify(viewed));
  check("iframe is afgeschermd", viewed.sandbox === "allow-scripts");
  const voor = await shot("popup-voor");
  const after = await run(`$("hide-floating").click();await wait(1500);return {label:$("hide-floating").textContent,src:$("source-frame").getAttribute("src"),sandbox:$("source-frame").getAttribute("sandbox")};`);
  check("knop wisselt", after.label === "Popup terugzetten", JSON.stringify(after));
  check("iframe laadt opnieuw en blijft afgeschermd", after.src !== viewed.src && after.sandbox === "allow-scripts", JSON.stringify(after));
  const na = await shot("popup-na");
  if (voor && na) check("de schermafdruk verandert", !readFileSync(voor).equals(readFileSync(na)));
  check("kopie op schijf is niet gewijzigd", hash(rest.id) === before);
  const saved = JSON.parse(readFileSync(pagePath(rest.id, "source.json"), "utf8"));
  check("keuze staat bij de bron", saved.hideFloating === true);
  check("tekst en oordeel blijven gelijk", saved.blocks.length === rest.blocks.length && saved.completeness.verdict === rest.completeness.verdict);

  await stopApp();
  startApp();
  await sleep(2500);
  const again = await show(rest.id);
  check("na herstart blijft de laag weg", again.label === "Popup terugzetten", JSON.stringify(again));
  await shot("popup-na-herstart");
  const undo = await run(`$("hide-floating").click();await wait(1000);return $("hide-floating").textContent;`);
  check("terugzetten werkt", undo === "Popup weghalen" && JSON.parse(readFileSync(pagePath(rest.id, "source.json"), "utf8")).hideFloating === false);

  const denied = await run(`try{await invoke("set_hide_floating",{id:"../../etc",hide:true});return "toegestaan"}catch(e){return e.kind||"geweigerd"}`);
  check("vreemd id wordt geweigerd", denied !== "toegestaan");
} finally {
  await stopApp().catch(() => {});
  site.close?.();
  rmSync(data, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
}
console.log(failures ? `${failures} fouten` : "alles goed");
process.exit(failures ? 1 : 0);
