// End-to-endtest van de voorvertoning, tegen de echte app en een lokale testsite. Alleen testgegevens.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/preview.e2e.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSite } from "./mock-site.mjs";

const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-preview-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-preview-ctl-"));
const shots = process.argv[2];
const site = await startSite("niet-gebruikt");
const base = `http://127.0.0.1:${site.port}`;
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FOUT"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}
const app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_LANGUAGE: "nl", DEEPDIVE_KEYCHAIN_SERVICE: "app.deepdive.reader.e2e-preview" }, stdio: "ignore" });
async function raw(js) {
  const out = join(ctl, "out.json");
  rmSync(out, { force: true });
  writeFileSync(join(ctl, "cmd.tmp"), js);
  renameSync(join(ctl, "cmd.tmp"), join(ctl, "cmd.js"));
  for (let i = 0; i < 400; i++) {
    await sleep(25);
    if (existsSync(out)) return readFileSync(out, "utf8");
  }
  throw new Error(`geen antwoord op: ${js.slice(0, 100)}`);
}
const STATE = `JSON.stringify({src:document.getElementById("source-frame").getAttribute("src"),sandbox:document.getElementById("source-frame").getAttribute("sandbox"),frameHidden:document.getElementById("source-frame").hidden,busy:!document.getElementById("busy").hidden,open:document.getElementById("url-open").disabled,status:document.getElementById("status-text").textContent,saved:!document.getElementById("show-saved").hidden,refresh:!document.getElementById("refresh").hidden,error:document.getElementById("error").hidden?null:document.getElementById("error-message").textContent,title:document.title})`;
async function state() {
  let v = JSON.parse(await raw(STATE));
  if (typeof v === "string") v = JSON.parse(v);
  return v;
}
async function waitFor(test, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await state();
    if (test(s)) return s;
    if (Date.now() > end) throw new Error(`te lang gewacht, laatste stand: ${JSON.stringify(s)}`);
    await sleep(40);
  }
}
async function open(path) {
  await raw(`(()=>{const i=document.getElementById("url-input");i.value=${JSON.stringify(base + path)};document.getElementById("url-form").requestSubmit();return 1})()`);
  return Date.now();
}
const isPreview = (s) => !!s.src && s.src.includes("/preview/");
async function shot(name) {
  if (!shots) return;
  const tiff = join(shots, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  execFileSync("sips", ["-s", "format", "png", tiff, "--out", join(shots, `${name}.png`)], { stdio: "ignore" });
  rmSync(tiff);
}

await sleep(2500);
try {
  // Traag stuk: tekst staat er meteen, de afbeelding duurt 5 seconden en moet daarna nog worden opgeslagen.
  site.clearLog();
  let t0 = await open("/traag");
  let s = await waitFor(isPreview);
  const toPreview = Date.now() - t0;
  console.log(`     voorbeeld na ${toPreview} ms`);
  check("voorbeeld staat er ruim voor de afbeelding klaar is", toPreview < 3500, `${toPreview} ms`);
  check("iframe blijft afgeschermd", s.sandbox === "", JSON.stringify(s));
  check("geen wachtscherm meer, wel ruimte voor een nieuw adres", !s.busy && !s.open, JSON.stringify(s));
  check("status zegt dat het nog wordt opgeslagen", s.status.includes("wordt op de achtergrond opgeslagen"), s.status);
  check("nog niet opnieuw op te halen", !s.refresh, JSON.stringify(s));
  await sleep(800);
  await shot("voorbeeld");
  const preview = s.src;
  s = await waitFor((x) => x.saved);
  const toSaved = Date.now() - t0;
  console.log(`     opgeslagen na ${toSaved} ms`);
  check("opslaan duurde langer dan het voorbeeld", toSaved > toPreview + 2000, `${toSaved} ms`);
  check("voorbeeld blijft staan, de pagina springt niet", s.src === preview, JSON.stringify(s));
  check("status toont nu de vaste kopie", s.status.includes("vastgelegd"), s.status);
  check("nu wel opnieuw op te halen", s.refresh, JSON.stringify(s));
  const noReferrer = site.log.filter((l) => l.path === "/voorbeeld.gif" && !l.referer);
  check("voorbeeld laadt de afbeelding van de site, zonder verwijzer", noReferrer.length >= 1, JSON.stringify(site.log.filter((l) => l.path === "/voorbeeld.gif")));
  await raw(`(()=>{document.getElementById("show-saved").click();return 1})()`);
  s = await waitFor((x) => !isPreview(x) && !x.saved, 5000);
  check("de knop zet de vaste kopie neer", /\/[0-9a-f]{32}\/index\.html/.test(s.src ?? ""), JSON.stringify(s));
  check("ook die is afgeschermd", s.sandbox === "");
  await shot("vaste-kopie");

  // Tekst die er pas na het laden komt.
  t0 = await open("/later-opgebouwd");
  s = await waitFor(isPreview);
  check("site die zichzelf opbouwt krijgt ook een voorbeeld", s.sandbox === "", JSON.stringify(s));
  await waitFor((x) => x.saved);

  // Al opgeslagen: meteen de vaste kopie, zonder voorbeeld.
  await open("/traag");
  s = await waitFor((x) => /vastgelegd/.test(x.status) && !isPreview(x) && !x.busy, 5000);
  check("bekend adres opent direct de vaste kopie", /\/[0-9a-f]{32}\/index\.html/.test(s.src ?? ""), JSON.stringify(s));

  // Mislukt het vastleggen, dan blijft het voorbeeld staan met een melding erbij.
  await open("/mislukt-na-voorbeeld");
  s = await waitFor(isPreview);
  s = await waitFor((x) => x.error);
  check("na een mislukte opslag staat er een melding", /blokkeert/.test(s.error), JSON.stringify(s));
  check("voorbeeld blijft staan en is als niet opgeslagen gemarkeerd", isPreview(s) && s.status.includes("niet opgeslagen"), JSON.stringify(s));
  await shot("mislukt");
  const before = await raw(`(async()=>{window.__r=await window.__TAURI_INTERNALS__.invoke("list_sources");return 1})()`);
  void before;
  const listed = JSON.parse(await raw(`JSON.stringify(window.__r.map(s=>s.title))`));
  check("mislukte pagina staat niet in de lijst", !JSON.stringify(listed).includes("Eerst tekst"), JSON.stringify(listed));

  // Een robotcontrole krijgt geen voorbeeld, de melding komt zoals altijd.
  await raw(`(()=>{document.getElementById("error-close").click();return 1})()`);
  await open("/robotcontrole");
  await sleep(1000);
  const seen = [];
  s = await waitFor((x) => {
    seen.push(x.src);
    return x.error;
  });
  check("robotcontrole wordt niet als nieuw voorbeeld getoond", new Set(seen.filter((v) => v?.includes("/preview/"))).size <= 1 && seen.at(-1) === s.src, JSON.stringify([...new Set(seen)]));
  check("melding bij robotcontrole", /blokkeert/.test(s.error), JSON.stringify(s));

  // Pdf-link: de webview loopt mee, de pdf wint.
  const pdf = await raw(`(async()=>{window.__p=null;window.__TAURI_INTERNALS__.invoke("open_url",{url:${JSON.stringify(base + "/los.pdf")},previewRequest:"pdf-test"}).then(v=>window.__p=v.kind,e=>window.__p="fout:"+JSON.stringify(e));return 1})()`);
  void pdf;
  let kind = null;
  for (let i = 0; i < 100 && !kind; i++) {
    await sleep(200);
    kind = JSON.parse(await raw(`JSON.stringify(window.__p)`));
    if (typeof kind === "string" && kind.startsWith('"')) kind = JSON.parse(kind);
  }
  check("pdf-link wordt nog steeds een pdf", kind === "pdf", String(kind));
} finally {
  const done = new Promise((r) => app.once("exit", r));
  app.kill("SIGTERM");
  await done;
  site.close?.();
  rmSync(data, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
}
console.log(failures ? `${failures} fouten` : "alles goed");
process.exit(failures ? 1 : 0);
