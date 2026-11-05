// End-to-endtest van stap 2b tegen de echte app en een lokale testsite. Alleen testgegevens, geen echte sites.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/login.e2e.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startSite } from "./mock-site.mjs";

const PASSWORD = `test-${randomBytes(9).toString("hex")}`;
const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-login-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-login-ctl-"));
const shots = process.argv[2];
const site = await startSite(PASSWORD);
const base = `http://127.0.0.1:${site.port}`;
let app;
let appOutput = "";
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FOUT"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function startApp() {
  app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_KEYCHAIN_SERVICE: "app.deepdive.reader.e2e-login" }, stdio: ["ignore", "pipe", "pipe"] });
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
const notice = () => ({ hidden: $("source-notice").hidden, title: $("source-notice-title").textContent, text: $("source-notice-text").textContent, actions: [...$("source-notice-actions").children].map((b) => b.textContent) });
const clickNotice = (label) => { const b = [...$("source-notice-actions").children].find((x) => x.textContent === label); if (!b) throw "geen knop " + label; b.click(); };
const idle = async () => { for (let i = 0; i < 1800; i++) { await wait(50); if ($("busy").hidden) return; } throw "bleef bezig"; };
const openUrl = async (u) => { $("url-input").value = u; $("url-form").requestSubmit(); await wait(50); await idle(); };
`;

async function run(body, timeoutMs = 120000) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:e&&e.message?e.message:String(e)});0`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let value = JSON.parse(await raw(`JSON.stringify(window.__r)`));
    if (typeof value === "string") value = JSON.parse(value);
    if (value) {
      if ("err" in value) throw new Error(`in de app: ${JSON.stringify(value.err)}`);
      return value.ok;
    }
    await sleep(100);
  }
  throw new Error(`te lang gewacht op: ${body.slice(0, 100)}`);
}

/** Voert code uit in een ander venster. Voor de testsite speelt de test hier de gebruiker. */
async function inWindow(prefix, js) {
  let value = JSON.parse(await raw(`win:${prefix}\n${js}`));
  return value;
}
const hasWindow = async (prefix) => (await inWindow(prefix, "1")) !== "geen venster";

async function shot(name, prefix) {
  if (!shots) return;
  await raw(prefix ? `shotwin:${prefix} ${join(shots, name)}.tiff` : `shot:${join(shots, name)}.tiff`);
  try { execFileSync("sips", ["-s", "format", "png", join(shots, `${name}.tiff`), "--out", join(shots, `${name}.png`)], { stdio: "ignore" }); rmSync(join(shots, `${name}.tiff`)); } catch {}
}

const until = async (what, fn, ms = 30000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  throw new Error(`te lang gewacht op: ${what}`);
};

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

const storeDirs = () => {
  // WebKit bewaart eigen opslagen per programma. Alleen de mapnamen, de inhoud lezen we niet.
  const root = join(homedir(), "Library/WebKit/deepdive/WebsiteDataStore");
  return existsSync(root) ? readdirSync(root) : [];
};

async function logIn() {
  await until("inlogvenster", () => hasWindow("login-"));
  await until("pagina in inlogvenster", async () => (await inWindow("login-", `document.readyState`)) === "complete");
  // De gebruiker op de testsite: naar de inlogpagina en het testwachtwoord invullen.
  await inWindow("login-", `location.href = "/login?terug=/betaald"; 1`);
  await until("inlogformulier", async () => (await inWindow("login-", `!!document.getElementById("wachtwoord")`)) === true);
  await shot("inlogvenster", "login-");
  await inWindow("login-", `document.getElementById("wachtwoord").value = ${JSON.stringify(PASSWORD)}; document.getElementById("inloggen").click(); 1`);
  await until("ingelogd", () => site.state.sessionCount > 0 && [...site.log].some((l) => l.path === "/betaald" && l.cookie?.includes("sessie=")));
}

async function closeLoginAsUser() {
  await raw("closewin:login-");
  await sleep(300);
}

try {
  startApp();
  await until("app", async () => { try { return (await run(`return !!$("url-input")`, 5000)) === true; } catch { return false; } }, 30000);

  // --- herkenning ---
  await run(`await openUrl(${JSON.stringify(`${base}/kort`)})`);
  let n = await run(`return { n: notice(), v: (await invoke("list_sources")).length }`);
  check("kort volledig bericht krijgt geen waarschuwing", n.n.hidden, JSON.stringify(n));

  await run(`await openUrl(${JSON.stringify(`${base}/betaald`)})`);
  n = await run(`return notice()`);
  check("betaalmuur wordt herkend", !n.hidden && n.title.includes("onvolledig"), JSON.stringify(n));
  check("melding noemt de reden", /verder te lezen|verder met/.test(n.text), n.text);
  check("melding biedt Inloggen en Toch gebruiken", n.actions.includes("Inloggen") && n.actions.includes("Toch gebruiken"), JSON.stringify(n.actions));
  await shot("betaalmuur");

  const paywalled = await run(`const s = (await invoke("list_sources"))[0]; return await invoke("get_source", { id: s.id })`);
  check("oordeel is opgeslagen bij de bron", paywalled.completeness.verdict === "likely_incomplete" && paywalled.completeness.reason.length > 0);
  const stored = JSON.parse(readFileSync(join(data, "sources", paywalled.id, "source.json"), "utf8"));
  check("oordeel staat in source.json", stored.completeness.verdict === "likely_incomplete");
  const paywalledHtml = readFileSync(join(data, "sources", paywalled.id, "index.html"), "utf8");
  check("zonder sessie ontbreken beveiligde bestanden", paywalled.assets.failed >= 1, JSON.stringify(paywalled.assets));

  // "Toch gebruiken" legt alleen de keuze vast
  await run(`clickNotice("Toch gebruiken"); await wait(300)`);
  let accepted = await run(`return { n: notice(), s: await invoke("get_source", { id: ${JSON.stringify(paywalled.id)} }) }`);
  check("Toch gebruiken haalt de melding weg en bewaart de keuze", accepted.n.hidden && accepted.s.completeness.acceptedByUser);
  check("Toch gebruiken wijzigt de kopie niet", readFileSync(join(data, "sources", paywalled.id, "index.html"), "utf8") === paywalledHtml);
  await run(`await invoke("get_source", { id: ${JSON.stringify(paywalled.id)} }); await openUrl(${JSON.stringify(`${base}/betaald`)})`);

  // --- opnieuw ophalen zonder sessie: oude kopie blijft ---
  const beforeHtml = readFileSync(join(data, "sources", paywalled.id, "index.html"), "utf8");
  // --- inloggen ---
  const storesBefore = storeDirs();
  await run(`
    const s = await invoke("get_source", { id: ${JSON.stringify(paywalled.id)} });
    const r = await invoke("site_login_open", { url: s.url });
    return r`);
  site.clearLog();
  await logIn();
  check("inlogvenster krijgt een sessie op de testsite", site.sessions.size === 1);
  await closeLoginAsUser();
  await until("inlogvenster dicht", async () => !(await hasWindow("login-")));
  const ownStores = storeDirs().filter((d) => !storesBefore.includes(d));
  check("de site heeft een eigen opslag", ownStores.length === 1, JSON.stringify(ownStores));
  check("wachtwoord staat niet in de appmap", grepDir(data, PASSWORD).length === 0, grepDir(data, PASSWORD).join());
  let sessions = await run(`return await invoke("list_site_sessions")`);
  check("site staat in de lijst", sessions.length === 1 && sessions[0].site === "127.0.0.1", JSON.stringify(sessions));
  const sessionFile = readFileSync(join(data, "site-sessions.json"), "utf8");
  check("sessiebestand bevat geen cookie", !sessionFile.includes("sessie1") && !sessionFile.includes(PASSWORD));

  // --- opnieuw ophalen via de echte knop ---
  site.clearLog();
  await run(`
    await invoke("get_source", { id: ${JSON.stringify(paywalled.id)} });
    document.getElementById("refresh").click();
    await wait(100);
    await idle();`);
  const after = await run(`return { n: notice(), list: await invoke("list_sources") }`);
  check("melding meldt de nieuwe kopie", after.n.title.startsWith("Nieuwe kopie"), JSON.stringify(after.n));
  check("vorige kopie blijft bereikbaar", after.n.actions.includes("Vorige kopie"));
  const newest = after.list.find((s) => s.url?.endsWith("/betaald"));
  check("nieuwe kopie staat in de lijst, oude niet", newest && newest.id !== paywalled.id && !after.list.some((s) => s.id === paywalled.id), JSON.stringify(after.list));
  const full = await run(`return await invoke("get_source", { id: ${JSON.stringify(newest.id)} })`);
  check("kopie na inloggen is volledig", full.completeness.verdict === "complete" && full.wordCount > 900, `${full.completeness.verdict} ${full.wordCount} ${full.completeness.reason}`);
  check("kopie is gemarkeerd als opgehaald met sessie", full.fetchedWithSession === true);
  const oldNow = await run(`return await invoke("get_source", { id: ${JSON.stringify(paywalled.id)} })`);
  check("oude kopie is bewaard en ongewijzigd", oldNow.supersededBy === newest.id && readFileSync(join(data, "sources", paywalled.id, "index.html"), "utf8") === beforeHtml);
  await shot("na-inloggen");

  const fullHtml = readFileSync(join(data, "sources", newest.id, "index.html"), "utf8");
  check("beveiligde afbeelding en stijl zijn meegekomen", full.assets.saved >= 4 && !full.assets.failedUrls.some((u) => u.includes("beveiligd")), JSON.stringify(full.assets));
  check("csrf-token staat niet in de kopie", !fullHtml.includes("csrf-token-geheim"));
  check("kopie heeft geen scripts", !/<script/i.test(fullHtml));
  check("wachtwoord staat niet in de kopie", grepDir(join(data, "sources"), PASSWORD).length === 0);
  check("sessiecookie staat niet op schijf in de appmap", grepDir(data, "sessie=").length === 0, grepDir(data, "sessie=").join());

  // Alleen wat de app zelf vraagt. De webview is een gewone browser: die stuurt cookies van 127.0.0.1 ook naar een andere poort.
  const offsite = site.log.filter((l) => l.server === "other" && l.accept.includes("font/*"));
  const offsiteAsset = offsite.filter((l) => l.path === "/andere-site.gif");
  const redirected = offsite.filter((l) => l.path === "/na-omleiding.gif");
  check("cookie gaat niet mee naar een andere site", offsiteAsset.length > 0 && offsiteAsset.every((l) => !l.cookie), JSON.stringify(offsite));
  check("cookie gaat niet mee bij doorverwijzing naar een andere poort", redirected.length > 0 && redirected.every((l) => !l.cookie), JSON.stringify(offsite));
  check("openbaar bestand is eerst zonder cookie gevraagd", site.log.some((l) => l.path === "/open.gif" && !l.cookie));

  // --- herstart: sessie is er nog ---
  await sleep(1500);
  await stopApp();
  startApp();
  await until("app na herstart", async () => { try { return (await run(`return !!$("url-input")`, 5000)) === true; } catch { return false; } }, 30000);
  sessions = await run(`return await invoke("list_site_sessions")`);
  check("sessie staat na herstart nog in de lijst", sessions.length === 1);
  site.clearLog();
  const again = await run(`return await invoke("refetch_source", { id: ${JSON.stringify(newest.id)} })`);
  check("na herstart wordt met dezelfde sessie opgehaald", again.status === "replaced" && again.current.completeness.verdict === "complete", JSON.stringify({ s: again.status, v: again.current?.completeness }));
  let currentId = again.current.id;

  // --- verlopen sessie: volledige kopie wijkt niet stilzwijgend ---
  site.state.expired = true;
  const expired = await run(`return await invoke("refetch_source", { id: ${JSON.stringify(currentId)} })`);
  check("slechtere kopie vervangt de volledige niet", expired.status === "kept_old" && expired.current.id === currentId && expired.candidateId, JSON.stringify({ s: expired.status, id: expired.current?.id }));
  await run(`return await invoke("discard_candidate", { id: ${JSON.stringify(currentId)}, candidateId: ${JSON.stringify(expired.candidateId)} })`);
  check("afgewezen kopie is weg", !existsSync(join(data, "sources", expired.candidateId)));
  site.state.expired = false;

  // --- site weigert: oude kopie blijft ---
  site.state.forbidden = true;
  const count = readdirSync(join(data, "sources")).length;
  const htmlBefore = readFileSync(join(data, "sources", currentId, "index.html"), "utf8");
  const failed = await run(`try { await invoke("refetch_source", { id: ${JSON.stringify(currentId)} }); return "gelukt"; } catch (e) { return e.kind; }`);
  site.state.forbidden = false;
  check("mislukt ophalen geeft een fout", failed === "blocked", failed);
  check("mislukt ophalen laat de oude kopie staan", readdirSync(join(data, "sources")).length === count && readFileSync(join(data, "sources", currentId, "index.html"), "utf8") === htmlBefore);

  // --- aanvalspagina in het inlogvenster, met een echt id van een kopie ---
  site.clearLog();
  const attackUrl = `${base}/aanval?kopie=${currentId}`;
  await run(`return await invoke("site_login_open", { url: ${JSON.stringify(attackUrl)} })`);
  await until("aanval klaar in inlogvenster", () => site.log.some((l) => l.path.startsWith("/aanval-klaar")));
  await sleep(500);
  const inLogin = await inWindow("login-", "JSON.stringify(window.__aanval)");
  const parsed = JSON.parse(inLogin);
  check("inlogvenster krijgt geen app-commando's", Object.values(parsed.invoke).every((v) => v !== "TOEGESTAAN"), inLogin);
  check("inlogvenster kan opgeslagen kopie niet lezen", !/^200/.test(parsed.snapshot), parsed.snapshot);
  check("inlogvenster kan opgeslagen kopie niet als afbeelding laden", parsed.snapshotImg !== "GELADEN", parsed.snapshotImg);
  await closeLoginAsUser();
  await until("inlogvenster dicht", async () => !(await hasWindow("login-")));
  const stillThere = await run(`return await invoke("list_site_sessions")`);
  check("aanval kon de sessie niet wissen", stillThere.length === 1);

  // --- aanvalspagina opgehaald en opgeslagen ---
  site.clearLog();
  const attackSource = await run(`return await invoke("open_url", { url: ${JSON.stringify(attackUrl)}, refresh: true })`);
  const captureResult = site.log.find((l) => l.path.startsWith("/aanval-klaar"));
  check("aanvalspagina draaide in het verborgen venster", !!captureResult);
  const res = JSON.parse(decodeURIComponent(captureResult.path.split("res=")[1]));
  check("verborgen venster krijgt geen app-commando's", Object.values(res.invoke).every((v) => v !== "TOEGESTAAN"), JSON.stringify(res));
  check("verborgen venster kan opgeslagen kopie niet lezen", !/^200/.test(res.snapshot), res.snapshot);
  const attackHtml = readFileSync(join(data, "sources", attackSource.id, "index.html"), "utf8");
  check("kopie van aanvalspagina bevat geen scripts of handlers", !/<script|onload=|onerror=|javascript:|http-equiv="refresh"/i.test(attackHtml));
  site.clearLog();
  await run(`await invoke("get_source", { id: ${JSON.stringify(attackSource.id)} }).then((s) => { document.getElementById("source-frame").src = "deepdive-snapshot://localhost/" + s.id + "/index.html"; }); await wait(1500)`);
  check("openen van de opgeslagen kopie geeft nul verzoeken", site.log.length === 0, JSON.stringify(site.log));

  // --- uitloggen ---
  await run(`$("sites-open").click(); await wait(300);`);
  await shot("sites-scherm");
  const row = await run(`const row = document.querySelector('.site-row[data-site="127.0.0.1"]'); if (!row) throw "geen rij"; const dirs = row.textContent; row.querySelector('[data-action="wipe"]').click(); for (let i = 0; i < 400; i++) { await wait(50); if (!document.querySelector('.site-row')) return dirs; } throw $("sites-result").textContent || "rij bleef staan";`);
  check("uitloggen via het scherm slaagt", !!row);
  const result = await run(`const t = $("sites-result").textContent; $("sites-close").click(); return t`);
  check("scherm meldt dat de sessie is gewist", result.includes("gewist"), result);
  check("opslag van de site is echt weg", !storeDirs().includes(ownStores[0]), JSON.stringify(storeDirs()));
  check("sessiebestand is leeg", JSON.parse(readFileSync(join(data, "site-sessions.json"), "utf8")).length === 0);

  site.clearLog();
  const afterLogout = await run(`return await invoke("open_url", { url: ${JSON.stringify(`${base}/betaald`)}, refresh: true })`);
  check("na uitloggen weer de betaalmuur", afterLogout.completeness.verdict === "likely_incomplete" && !afterLogout.fetchedWithSession, afterLogout.completeness.verdict);
  check("na uitloggen geen enkele sessiecookie naar de site", site.log.every((l) => !l.cookie?.includes("sessie=")), JSON.stringify(site.log.filter((l) => l.cookie)));

  // Dezelfde site opnieuw openen in het inlogvenster: geen oude cookies in een nieuwe opslag.
  site.clearLog();
  await run(`return await invoke("site_login_open", { url: ${JSON.stringify(`${base}/betaald`)} })`);
  await until("pagina in inlogvenster", () => site.log.some((l) => l.path === "/betaald"));
  check("nieuw inlogvenster heeft geen oude sessie", site.log.every((l) => !l.cookie?.includes("sessie=")), JSON.stringify(site.log.filter((l) => l.cookie)));
  await closeLoginAsUser();
  await until("inlogvenster dicht", async () => !(await hasWindow("login-")));
  await sleep(1500);
  sessions = await run(`return await invoke("list_site_sessions")`);
  check("venster dicht zonder cookies: site verdwijnt weer uit de lijst", sessions.length === 0, JSON.stringify(sessions));

  // Oude kopie blijft leesbaar na uitloggen, en is na uitloggen nog steeds lokaal.
  check("geen opslag blijft achter", storeDirs().every((d) => storesBefore.includes(d)), JSON.stringify(storeDirs()));
  check("kopieën blijven staan na uitloggen", existsSync(join(data, "sources", currentId, "index.html")));
} catch (e) {
  check("test liep door tot het einde", false, e.message);
} finally {
  if (app && app.exitCode === null) await stopApp().catch(() => {});
  site.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
  if (failures && appOutput) console.log(appOutput.slice(-2000));
  console.log(failures ? `\n${failures} controle(s) mislukt` : "\nAlles geslaagd");
  process.exit(failures ? 1 : 0);
}
