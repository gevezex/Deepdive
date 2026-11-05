// End-to-endtest van stap 2 tegen de echte app, de echte sleutelhanger en een lokale nepserver.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/providers.e2e.mjs [map-voor-schermafdrukken]
// De sleutel is nep en staat onder een eigen dienstnaam in de sleutelhanger; de test ruimt hem op.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-ai.mjs";

const KEY = `dd-e2e-nep-${randomBytes(12).toString("hex")}`;
const SERVICE = `app.deepdive.reader.e2e.${randomBytes(4).toString("hex")}`;
const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-e2e-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-e2e-ctl-"));
const shots = process.argv[2];
const mock = await startMock(KEY);
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

/** Voert asynchrone code uit in het hoofdvenster en geeft het resultaat terug. */
async function run(body, timeoutMs = 90000) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:e&&e.message?e:String(e)});0`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let text = await raw(`JSON.stringify(window.__r)`);
    let value = JSON.parse(text);
    if (typeof value === "string") value = JSON.parse(value);
    if (value) {
      if ("err" in value) throw new Error(`in de app: ${JSON.stringify(value.err)}`);
      return value.ok;
    }
    await sleep(100);
  }
  throw new Error(`te lang gewacht op: ${body.slice(0, 100)}`);
}

const HELPERS = `
const $ = (id) => document.getElementById(id);
const invoke = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
const settled = async (id) => { for (let i = 0; i < 1800; i++) { await wait(50); const e = $(id); if (!e.hidden && !e.classList.contains("notice-busy") && e.textContent) return { tone: e.className, text: e.textContent }; } throw "geen uitslag in " + id; };
const fresh = (id) => { const e = $(id); e.hidden = true; e.replaceChildren(); };
const newProvider = async (preset, name, url, key) => {
  $("provider-new").click();
  setValue("provider-preset", preset);
  if (name) setValue("provider-name", name);
  if (url) setValue("provider-url", url);
  if (key) setValue("provider-key", key);
  fresh("provider-result");
  $("provider-form").requestSubmit();
  return settled("provider-result");
};
const clickTest = async () => { fresh("provider-result"); $("provider-test").click(); return settled("provider-result"); };
const clickRefresh = async () => { fresh("models-result"); $("models-refresh").click(); return settled("models-result"); };
`;

const list = () => run(`return invoke("list_providers")`);
const inKeychain = (id) => spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", `provider:${id}`], { stdio: "ignore" }).status === 0;

function grepDir(dir, needle) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const s = statSync(p, { throwIfNoEntry: false });
      if (!s) continue;
      if (s.isDirectory()) walk(p);
      else if (s.size < 50_000_000 && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

async function shot(name) {
  if (!shots) return;
  const tiff = join(shots, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  await sleep(300);
  execFileSync("sips", ["-s", "format", "png", tiff, "--out", join(shots, `${name}.png`)], { stdio: "ignore" });
  rmSync(tiff, { force: true });
}

async function main() {
  startApp();
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("providers-open")`, 3000)) === true) break;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
  }
  check("de app start op macOS", true);

  // ---------- aanmaken en sleutel ----------
  await run(`$("providers-open").click()`);
  const ollama = await run(`setValue("provider-preset", "ollama"); return [$("provider-name").value, $("provider-url").value]`);
  check("voorinstelling Ollama vult het standaardadres", ollama[1] === "http://localhost:11434/v1", ollama.join());
  const lm = await run(`setValue("provider-preset", "lmstudio"); return $("provider-url").value`);
  check("voorinstelling LM Studio vult het standaardadres", lm === "http://localhost:1234/v1", lm);
  await shot("1-nieuwe-provider");

  const saved = await run(`return newProvider("custom", "Nep OpenAI", ${JSON.stringify(`${base}/ok/v1`)}, ${JSON.stringify(KEY)})`);
  check("provider opslaan via het scherm", saved.tone.includes("ok"), saved.text);
  let state = await list();
  const openaiId = state.providers[0].id;
  check("frontend ziet alleen dat er een sleutel is", state.providers[0].hasKey === true && !JSON.stringify(state).includes(KEY));
  check("sleutelveld is na opslaan leeg", (await run(`return $("provider-key").value`)) === "");
  check("sleutel staat in de sleutelhanger", inKeychain(openaiId));
  check("sleutel staat niet in de app-data", grepDir(data, KEY).length === 0, grepDir(data, KEY).join());

  // ---------- streaming via de verbindingstest ----------
  const seen = await run(`
    const seen = [];
    const obs = new MutationObserver(() => seen.push($("provider-result").textContent));
    obs.observe($("provider-result"), { childList: true, subtree: true, characterData: true });
    const out = await clickTest();
    obs.disconnect();
    return { out, seen };
  `);
  check("verbindingstest slaagt zonder model (eerste uit de lijst)", seen.out.tone.includes("ok") && seen.out.text.includes("nep-klein"), seen.out.text);
  const growing = seen.seen.filter((t) => t.startsWith("Antwoord komt binnen"));
  check("het antwoord komt in stukken binnen in de interface", new Set(growing).size >= 3, JSON.stringify(seen.seen));
  const chat = mock.log.find((r) => r.path === "/ok/v1/chat/completions");
  check("nepserver kreeg de sleutel uit de sleutelhanger", chat?.headers.authorization === `Bearer ${KEY}`);
  check("verzoek vraagt om streaming", JSON.parse(chat.body).stream === true);

  // ---------- modellen ----------
  const refreshed = await run(`return clickRefresh()`);
  check("modellen ophalen", refreshed.tone.includes("ok") && refreshed.text.includes("2 modellen gevonden"), refreshed.text);
  state = await list();
  let groot = state.providers[0].models.find((m) => m.id === "nep-groot");
  check("mogelijkheden komen mee als de provider ze noemt", groot.contextTokens === 128000 && groot.supportsImages === true);
  await run(`
    const row = [...$("models-body").children].find((r) => r.textContent.includes("nep-klein"));
    const [enabled, images, context] = row.querySelectorAll("input, select");
    images.value = "no"; images.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(200);
    context.value = "8.192"; context.dispatchEvent(new Event("change", { bubbles: true }));
    await wait(200);
    setValue("model-add-id", "eigen-model");
    setValue("model-add-context", "4096");
    $("model-add-form").requestSubmit();
    await wait(300);
  `);
  state = await list();
  const klein = state.providers[0].models.find((m) => m.id === "nep-klein");
  check("afbeeldingen en context zijn aan te passen", klein.supportsImages === false && klein.contextTokens === 8192 && klein.userEdited, JSON.stringify(klein));
  check("model handmatig toevoegen", state.providers[0].models.some((m) => m.id === "eigen-model" && m.manual && m.contextTokens === 4096));
  await run(`await clickRefresh()`);
  state = await list();
  check("opnieuw ophalen houdt eigen waarden en eigen model", state.providers[0].models.find((m) => m.id === "nep-klein").contextTokens === 8192 && state.providers[0].models.some((m) => m.id === "eigen-model"));
  await run(`const bad = [...$("models-body").children].find((r) => r.textContent.includes("nep-klein")).querySelector("input[type=text]"); bad.value = "veel"; bad.dispatchEvent(new Event("change", { bubbles: true })); await wait(100);`);
  check("ongeldige context geeft een melding", (await run(`return $("models-result").textContent`)).includes("geen geldig aantal"));
  await run(`const bad = [...$("models-body").children].find((r) => r.textContent.includes("nep-klein")).querySelector("input[type=text]"); bad.value = "8192"; bad.dispatchEvent(new Event("change", { bubbles: true })); await wait(100);`);

  // ---------- Anthropic ----------
  const anth = await run(`return newProvider("anthropic", "Nep Anthropic", ${JSON.stringify(`${base}/anthropic`)}, ${JSON.stringify(KEY)})`);
  check("Anthropic-provider opslaan", anth.tone.includes("ok"), anth.text);
  const anthRefresh = await run(`return clickRefresh()`);
  check("Anthropic: modellen ophalen", anthRefresh.text.includes("1 model gevonden"), anthRefresh.text);
  const anthTest = await run(`return clickTest()`);
  check("Anthropic: verbindingstest met streaming", anthTest.tone.includes("ok") && anthTest.text.includes("Werkt"), anthTest.text);
  const anthReq = mock.log.findLast((r) => r.path === "/anthropic/v1/messages");
  check("Anthropic: sleutel in x-api-key, niet in Authorization", anthReq?.headers["x-api-key"] === KEY && !anthReq.headers.authorization);
  await shot("2-anthropic-met-modellen");

  // ---------- foutmeldingen ----------
  await run(`await newProvider("custom", "Foute sleutel", ${JSON.stringify(`${base}/badkey/v1`)}, ${JSON.stringify(KEY)})`);
  const bad = await run(`setValue("model-add-id", "m"); $("model-add-form").requestSubmit(); await wait(200); return clickTest()`);
  check("verkeerde sleutel: begrijpelijke melding", bad.tone.includes("error") && bad.text.includes("sleutel wordt niet geaccepteerd"), bad.text);
  check("melding herhaalt de sleutel niet, ook niet in de details", !bad.text.includes(KEY), bad.text);
  await shot("3-verkeerde-sleutel");

  const closedPort = 1; // op poort 1 luistert niets
  await run(`await newProvider("custom", "Lokaal uit", "http://localhost:${closedPort}/v1", "")`);
  const off = await run(`return clickTest()`);
  check("lokale server uit: begrijpelijke melding", off.tone.includes("error") && off.text.includes("Staat Ollama of LM Studio aan"), off.text);
  const offRefresh = await run(`return clickRefresh()`);
  check("lokale server uit: ook bij modellen ophalen, met handmatig als uitweg", offRefresh.text.includes("Staat Ollama") && offRefresh.text.includes("zelf toevoegen"), offRefresh.text);

  await run(`await newProvider("custom", "Onbekend model", ${JSON.stringify(`${base}/nomodel/v1`)}, "")`);
  const unknown = await run(`setValue("model-add-id", "bestaat-niet"); $("model-add-form").requestSubmit(); await wait(200); return clickTest()`);
  check("onbekend model: begrijpelijke melding", unknown.tone.includes("error") && unknown.text.includes("kent model \"bestaat-niet\" niet"), unknown.text);

  await run(`await newProvider("custom", "Verkeerd pad", ${JSON.stringify(`${base}/nergens`)}, "")`);
  const wrongPath = await run(`return clickTest()`);
  check("verkeerd adres: tip over /v1", wrongPath.text.includes("/v1"), wrongPath.text);

  const insecure = await run(`return newProvider("custom", "Onveilig", "http://example.com/v1", "nep")`);
  check("sleutel over onversleuteld http naar buiten wordt geweigerd", insecure.tone.includes("error") && insecure.text.includes("https"), insecure.text);

  // ---------- modelkiezer ----------
  state = await list();
  const value = JSON.stringify([openaiId, "nep-groot"]);
  const options = await run(`$("providers-close").click(); return [...$("model-picker").options].map((o) => o.value)`);
  check("modelkiezer toont de modellen", options.includes(value), options.join());
  await run(`setValue("model-picker", ${JSON.stringify(value)}); await wait(300);`);
  await shot("4-modelkiezer");
  state = await list();
  check("keuze wordt opgeslagen", state.selection.active?.modelId === "nep-groot");

  // ---------- herstart ----------
  await stopApp();
  const before = mock.log.length;
  startApp();
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return $("model-picker").value !== ""`, 3000)) === true) break;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
    if (i > 60) throw new Error("kiezer bleef leeg na herstart");
  }
  state = await list();
  check("providers blijven na een herstart bestaan", state.providers.some((p) => p.id === openaiId && p.models.length >= 3));
  check("modelkiezer onthoudt de keuze na een herstart", (await run(`return $("model-picker").value`)) === value);
  check("eigen context blijft na een herstart", state.providers.find((p) => p.id === openaiId).models.find((m) => m.id === "nep-klein").contextTokens === 8192);
  const again = await run(`$("providers-open").click(); [...$("provider-list").querySelectorAll("button")].find((b) => b.textContent === "Nep OpenAI").click(); return clickTest()`);
  const after = mock.log.slice(before).find((r) => r.path === "/ok/v1/chat/completions");
  check("na een herstart komt de sleutel weer uit de sleutelhanger", again.tone.includes("ok") && after?.headers.authorization === `Bearer ${KEY}`, again.text);
  check("sleutelwaarde staat niet in het scherm", !(await run(`return document.documentElement.outerHTML + $("provider-key").value`)).includes(KEY));

  // ---------- afscherming ----------
  await run(`$("providers-close").click();`);
  const hiddenLog = () => mock.log.filter((r) => r.path === "/beacon" && r.query.from === "hidden").map((r) => JSON.parse(r.query.r));
  await run(`try { await invoke("open_url", { url: ${JSON.stringify(`${base}/hostile.html`)}, refresh: true }); } catch (e) { return e; }`, 120000);
  const hostile = hiddenLog();
  check("controle: het script van de vijandige pagina is echt gedraaid", hostile.some((r) => r.started), JSON.stringify(hostile));
  const attempts = hostile.filter((r) => r.cmd);
  check("verborgen venster: alle commando's geweigerd", attempts.length === 3 && attempts.every((r) => !r.allowed), JSON.stringify(attempts));
  console.log(`     (weigering: ${attempts[0]?.error ?? "geen"})`);

  const copy = await run(`const s = await invoke("import_text", { title: "Kopie", url: null, text: "Een stuk tekst voor de afgeschermde kopie." }); return s.id`);
  const sourceDir = join(data, "sources", copy);
  writeFileSync(join(sourceDir, "index.html"), `<!doctype html><body><img src="${base}/beacon?from=copy-img"><script>
    new Image().src = "${base}/beacon?from=copy-script";
    try { window.__TAURI_INTERNALS__.invoke("list_providers", {}).then(r => { new Image().src = "${base}/beacon?from=copy-allowed"; }); } catch (e) {}
    try { window.parent.document.title = "gehackt"; } catch (e) {}
    fetch("${base}/beacon?from=copy-fetch").catch(() => {});
  </script><p id="marker">Geladen kopie</p></body>`);
  const frameLoaded = await run(`
    const f = $("source-frame");
    const loaded = new Promise((r) => f.addEventListener("load", () => r(true), { once: true }));
    await invoke("get_source", { id: ${JSON.stringify(copy)} });
    const list = $("source-list"); await wait(100);
    if (![...list.options].some((o) => o.value === ${JSON.stringify(copy)})) list.add(new Option("Kopie", ${JSON.stringify(copy)}));
    list.value = ${JSON.stringify(copy)}; list.dispatchEvent(new Event("change"));
    const ok = await Promise.race([loaded, wait(5000).then(() => false)]);
    await wait(1500);
    return { ok, sandbox: f.getAttribute("sandbox"), title: document.title };
  `);
  // Controle op de schermafdruk: de tekst "Geladen kopie" toont dat juist dit bestand in de iframe staat.
  await shot("5-vijandige-kopie");
  const copyHits = mock.log.filter((r) => r.path === "/beacon" && r.query.from?.startsWith("copy"));
  check("vaste kopie: iframe is geladen en afgeschermd", frameLoaded.ok === true && frameLoaded.sandbox === "", JSON.stringify(frameLoaded));
  check("vaste kopie: geen script, geen netwerk, geen commando's", copyHits.length === 0, JSON.stringify(copyHits.map((h) => h.query)));
  check("vaste kopie: kan het hoofdvenster niet aanraken", !frameLoaded.title.includes("gehackt"), frameLoaded.title);

  // ---------- verwijderen ----------
  state = await list();
  const ids = state.providers.map((p) => p.id);
  const keyed = state.providers.filter((p) => p.hasKey).map((p) => p.id);
  check("sleutels staan voor het verwijderen in de sleutelhanger", keyed.length === 3 && keyed.every(inKeychain), String(keyed.length));
  await run(`
    $("providers-open").click();
    for (let i = 0; i < 50 && $("provider-list").children.length; i++) {
      $("provider-delete").click();
      await wait(50);
      $("provider-delete").click();
      await wait(200);
    }
    $("providers-close").click();
  `);
  state = await list();
  check("providers verwijderen via het scherm", state.providers.length === 0, String(state.providers.length));
  check("verwijderen haalt de sleutel uit de sleutelhanger", ids.every((id) => !inKeychain(id)));
  check("keuze is vervallen", state.selection.active === null && (await run(`return $("model-picker").value`)) === "");

  // ---------- laatste controle ----------
  await stopApp();
  check("sleutel staat niet in de app-uitvoer (logs)", !appOutput.includes(KEY));
  const places = [data, join(homedir(), "Library/Application Support/app.deepdive.reader"), join(homedir(), "Library/WebKit/app.deepdive.reader"), join(homedir(), "Library/Caches/app.deepdive.reader"), join(homedir(), "Library/WebKit/deepdive"), join(homedir(), "Library/Caches/deepdive")];
  const hits = places.flatMap((p) => grepDir(p, KEY));
  check("sleutel staat nergens in de bestanden van de app", hits.length === 0, hits.join());
  check("providers.json bevat geen sleutel en wel hasKey", !readFileSync(join(data, "providers.json"), "utf8").includes(KEY));
}

try {
  await main();
} catch (e) {
  failures++;
  console.log(`FOUT ${e.stack ?? e}`);
  if (appOutput) console.log(`app-uitvoer:\n${appOutput.slice(-2000).replaceAll(KEY, "***")}`);
} finally {
  app?.kill("SIGKILL");
  mock.close();
  for (const id of JSON.parse(existsSync(join(data, "providers.json")) ? readFileSync(join(data, "providers.json"), "utf8") : '{"providers":[]}').providers.map((p) => p.id)) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", `provider:${id}`], { stdio: "ignore" });
  }
  rmSync(ctl, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} controle(s) mislukt` : "\nAlles geslaagd");
process.exit(failures ? 1 : 0);
