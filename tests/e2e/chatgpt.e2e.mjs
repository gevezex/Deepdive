// End-to-endtest van "Inloggen met ChatGPT": de echte app en de echte sleutelhanger, tegen een lokale nep van
// OpenAI. Niets gaat naar de echte dienst. De nepbrowser volgt het inlogadres dat de app wil openen.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/chatgpt.e2e.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { startMock } from "./mock-ai.mjs";
import { startChatgptMock } from "./mock-chatgpt.mjs";

const SERVICE = `app.deepdive.reader.e2e.${randomBytes(4).toString("hex")}`;
const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const data = mkdtempSync(join(tmpdir(), "dd-gpt-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-gpt-ctl-"));
const browserFile = join(ctl, "browser-url");
const shots = process.argv[2];
const mock = await startChatgptMock();
const other = await startMock("dd-e2e-andere-sleutel");
const s = mock.state;
let appOutput = "";
let app;
let failures = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, extra = "") {
  console.log(`${ok ? "ok  " : "FOUT"} ${name}${!ok && extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function startApp() {
  app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_KEYCHAIN_SERVICE: SERVICE, DEEPDIVE_CHATGPT_AUTH_BASE: mock.base, DEEPDIVE_CHATGPT_API_BASE: `${mock.base}/v1`, DEEPDIVE_CHATGPT_BROWSER_FILE: browserFile }, stdio: ["ignore", "pipe", "pipe"] });
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

async function run(body, timeoutMs = 60000) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:e&&e.message?e:String(e)});0`);
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

const HELPERS = `
const $ = (id) => document.getElementById(id);
const invoke = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const settled = async (id) => { for (let i = 0; i < 600; i++) { await wait(50); const e = $(id); if (!e.hidden && !e.classList.contains("notice-busy") && e.textContent) return { tone: e.className, text: e.textContent }; } throw "geen uitslag in " + id; };
const fresh = (id) => { const e = $(id); e.hidden = true; e.replaceChildren(); };
const pick = (name) => [...$("provider-list").querySelectorAll("button")].find((b) => b.textContent.includes(name)).click();
`;

/** De nepbrowser: wacht tot de app een adres wil openen, en volgt dat tot aan de lokale callback. */
async function browse() {
  for (let i = 0; i < 200; i++) {
    if (existsSync(browserFile)) break;
    await sleep(50);
  }
  const url = readFileSync(browserFile, "utf8");
  rmSync(browserFile);
  if (!url.startsWith(mock.base)) return url;
  const page = await fetch(url);
  await page.text();
  return url;
}

/** Klikt op een knop in het scherm, doet alsof de gebruiker in de browser klaar is, en geeft de uitslag. */
async function loginVia(buttonId) {
  await run(`fresh("provider-result"); $("${buttonId}").click()`);
  const url = await browse();
  const result = await run(`return settled("provider-result")`);
  return { url, ...result };
}

const list = () => run(`return invoke("list_providers")`);
const clickTest = () => run(`fresh("provider-result"); $("provider-test").click(); return settled("provider-result")`);
const inKeychain = (id) => spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", `chatgpt:${id}`], { stdio: "ignore" }).status === 0;
const secrets = () => [...s.issued.access, ...s.issued.refresh, ...s.issued.id];

function grepDir(dir, needles) {
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(p);
      else if (st.size < 50_000_000) {
        const bytes = readFileSync(p);
        if (needles.some((n) => bytes.includes(n))) hits.push(p);
      }
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

async function waitForApp() {
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("providers-open")`, 3000)) === true) return;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
  }
}

async function main() {
  startApp();
  await waitForApp();
  check("de app start op macOS", true);
  await run(`$("providers-open").click()`);
  const offer = await run(`return { hidden: $("chatgpt-offer").hidden, label: $("chatgpt-continue").textContent }`);
  check("het providerscherm biedt Continue with ChatGPT aan", !offer.hidden && offer.label === "Continue with ChatGPT");
  await shot("1-aanbod");

  // ---------- geweigerde toestemming blokkeert niets ----------
  s.browserMode = "deny";
  const denied = await loginVia("chatgpt-continue");
  check("geweigerde toestemming: begrijpelijke melding", denied.tone.includes("error") && denied.text.includes("geen toestemming"), denied.text);
  check("geweigerde toestemming: geen code ingewisseld", !s.log.some((r) => r.path === "/api/accounts/oauth/token"));
  check("geweigerde toestemming: geen provider aangemaakt", (await list()).providers.length === 0);
  await shot("2-geweigerd");

  // ---------- onbetrouwbaar ID-token ----------
  s.browserMode = "badnonce";
  const badNonce = await loginVia("chatgpt-continue");
  check("verkeerde nonce: geweigerd", badNonce.tone.includes("error") && badNonce.text.includes("niet worden gecontroleerd"), badNonce.text);
  check("verkeerde nonce: geen provider aangemaakt", (await list()).providers.length === 0);

  // ---------- andere providers blijven werken ----------
  await run(`
    $("provider-new").click();
    const set = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
    set("provider-preset", "custom"); set("provider-name", "Eigen sleutel"); set("provider-url", ${JSON.stringify(`http://127.0.0.1:${other.port}/ok/v1`)}); set("provider-key", "dd-e2e-andere-sleutel");
    fresh("provider-result"); $("provider-form").requestSubmit(); await settled("provider-result");
  `);
  const local = await clickTest();
  check("API-sleutelprovider werkt na een mislukte login", local.tone.includes("ok") && local.text.includes("Werkt goed"), local.text);

  // ---------- de eerste login ----------
  s.browserMode = "ok";
  await run(`$("provider-new").click()`);
  const login = await loginVia("chatgpt-continue");
  check("login slaagt via de loopback-callback", login.tone.includes("ok") && login.text.includes("lezer@example.com"), login.text);
  check("geen schendingen van de documentatie bij de login", s.violations.length === 0, s.violations.join("; "));
  const firstAuth = new URL(login.url);
  check("eerste login registreert via dynamic_agent_client", firstAuth.searchParams.get("client_id") === "dynamic_agent_client");
  check("het inlogadres bevat geen token", !secrets().some((t) => login.url.includes(t)));
  const welcomeOpen = await run(`return $("chatgpt-welcome").open`);
  check("eerste keer: bevestiging You're using your ChatGPT plan", welcomeOpen === true);
  await shot("3-welkom");
  await run(`$("chatgpt-welcome-ok").click(); await wait(200);`);

  let state = await list();
  const chatgpt = state.providers.find((p) => p.kind === "chatgpt_plan");
  check("frontend ziet het account maar geen token", chatgpt.chatgpt.email === "lezer@example.com" && !secrets().some((t) => JSON.stringify(state).includes(t)));
  check("client-ID is bewaard, niet dynamic_agent_client", chatgpt.chatgpt.clientId === s.clientId);
  check("tokens staan in de sleutelhanger", inKeychain(chatgpt.id));
  check("modellen uit de catalogus, in volgorde, zonder verborgen", chatgpt.models.map((m) => m.id).join() === "nep-gpt-snel,nep-gpt-diep", chatgpt.models.map((m) => m.id).join());
  const status = await run(`return $("chatgpt-account-status").textContent`);
  check("scherm toont het ingelogde account", status.includes("Ingelogd als lezer@example.com"), status);
  await shot("4-ingelogd");

  // ---------- van login tot antwoord ----------
  const seen = await run(`
    const seen = [];
    const obs = new MutationObserver(() => seen.push($("provider-result").textContent));
    obs.observe($("provider-result"), { childList: true, subtree: true, characterData: true });
    const out = await (async () => { fresh("provider-result"); $("provider-test").click(); return settled("provider-result"); })();
    obs.disconnect();
    return { out, seen };
  `);
  check("antwoord via stream_chat", seen.out.tone.includes("ok") && seen.out.text.includes("Werkt via ChatGPT"), seen.out.text);
  check("antwoord komt in stukken binnen", new Set(seen.seen.filter((t) => t.startsWith("Antwoord komt binnen"))).size >= 3, JSON.stringify(seen.seen));
  const firstResponse = s.log.find((r) => r.path === "/v1/responses");
  check("Responses kreeg het token als Bearer", firstResponse.headers.authorization === `Bearer ${s.issued.access.at(-1)}`);
  check("geen schendingen van de preview-eisen", s.violations.length === 0, s.violations.join("; "));

  // ---------- voorstel in het blauwdrukpaneel ----------
  await run(`$("providers-close").click(); $("paste-open").click(); $("paste-title").value = "Stuk"; $("paste-text").value = "Eerste alinea met genoeg woorden.\\n\\nTweede alinea met nog meer woorden."; $("paste-form").requestSubmit(); await wait(800);`);
  const suggestion = await run(`return { shown: !!$("bp-suggest"), text: $("bp-suggest")?.textContent ?? "", picker: $("model-picker").value }`);
  check("blauwdruk: zonder keuze wordt ChatGPT voorgesteld", suggestion.shown && suggestion.text.includes("Jij kiest") && suggestion.text.includes("Nep GPT Snel"), JSON.stringify(suggestion));
  check("blauwdruk: het voorstel kiest niet stilletjes", suggestion.picker === "" && (await list()).selection.active === null);
  await run(`$("bp-suggest-use").click(); await wait(400);`);
  check("blauwdruk: pas na een klik is ChatGPT gekozen", (await list()).selection.active?.modelId === "nep-gpt-snel");
  check("blauwdruk: voorstel verdwijnt na kiezen", (await run(`return !$("bp-suggest")`)) === true);
  await shot("4b-voorstel");

  // ---------- modelkiezer en merkteken ----------
  const value = JSON.stringify([chatgpt.id, "nep-gpt-diep"]);
  await run(`$("providers-close").click(); const p = $("model-picker"); p.value = ${JSON.stringify(value)}; p.dispatchEvent(new Event("change", { bubbles: true })); await wait(300);`);
  check("model staat in de modelkiezer en blijft gekozen", (await run(`return $("model-picker").value`)) === value);
  const badge = await run(`return { hidden: $("chatgpt-plan-badge").hidden, text: $("chatgpt-plan-badge").textContent }`);
  check("Using ChatGPT plan staat bij de modelkiezer", !badge.hidden && badge.text.includes("Using ChatGPT plan") && badge.text.includes("Manage usage"));
  await shot("5-modelkiezer");
  await run(`$("chatgpt-plan-manage").click(); await wait(300);`);
  check("Manage usage opent de vaste pagina", (await browse()) === "https://chatgpt.com/settings/usage");

  // ---------- herstart en een geweigerd token ----------
  await stopApp();
  const hostFile = join(data, "chatgpt-host-id");
  const hostId = readFileSync(hostFile, "utf8");
  startApp();
  await waitForApp();
  check("na een herstart: geen tweede bevestiging", (await run(`return $("chatgpt-welcome").open`)) === false);
  check("na een herstart: keuze en merkteken blijven", (await run(`return !$("chatgpt-plan-badge").hidden && $("model-picker").value`)) === value);
  await run(`$("providers-open").click(); pick("ChatGPT");`);
  const afterRestart = await clickTest();
  check("na een herstart komt het token weer uit de sleutelhanger", afterRestart.text.includes("Werkt via ChatGPT"), afterRestart.text);

  // Geweigerd token: één keer vernieuwen en dan verder. De nepserver weigert hergebruik van een vernieuwingstoken.
  s.responsesMode = "revoked";
  const refreshCount = () => s.log.filter((r) => r.form.grant_type === "refresh_token").length;
  const before = refreshCount();
  const rejected = await clickTest();
  check("geweigerd token: één vernieuwing geprobeerd", refreshCount() === before + 1, String(refreshCount() - before));
  check("geweigerd maar vernieuwd: duidelijke melding, geen wissen", rejected.tone.includes("error") && rejected.text.includes("accepteert deze aanmelding niet") && inKeychain(chatgpt.id), rejected.text);
  s.responsesMode = "ok";
  const renewed = await clickTest();
  check("vernieuwd token werkt daarna", renewed.text.includes("Werkt via ChatGPT"), renewed.text);
  check("Responses kreeg het nieuwe token", s.log.findLast((r) => r.path === "/v1/responses").headers.authorization === `Bearer ${s.issued.access.at(-1)}`);

  // ---------- foutmeldingen ----------
  s.responsesMode = "limit";
  const limit = await clickTest();
  check("limiet: begrijpelijke melding", limit.text.includes("gebruikslimiet"), limit.text);
  const manage = await run(`const b = $("provider-result").querySelector("button"); return b && { label: b.textContent, primary: b.classList.contains("primary") };`);
  check("limiet: Manage usage als hoofdactie", manage?.label === "Manage usage" && manage.primary, JSON.stringify(manage));
  await shot("6-limiet");
  check("limiet: tokens blijven", inKeychain(chatgpt.id));

  s.responsesMode = "limit_mid_stream";
  const midLimit = await clickTest();
  check("limiet midden in de stream: zelfde melding", midLimit.text.includes("gebruikslimiet"), midLimit.text);

  s.responsesMode = "ineligible";
  const ineligible = await clickTest();
  check("ontbrekend abonnement: begrijpelijke melding", ineligible.text.includes("abonnement kan niet in deze app") && ineligible.text.includes("API-sleutel"), ineligible.text);
  s.responsesMode = "ok";

  // ---------- uitloggen en opnieuw inloggen ----------
  const lastRefresh = s.issued.refresh.at(-1);
  await run(`fresh("provider-result"); $("chatgpt-signout").click();`);
  const signedOut = await run(`return settled("provider-result")`);
  check("uitloggen: bevestigd", signedOut.tone.includes("ok") && signedOut.text.includes("uitgelogd"), signedOut.text);
  check("uitloggen trekt de sessie in met de client-ID", s.revoked.at(-1)?.token === lastRefresh && s.revoked.at(-1)?.client_id === s.clientId && s.revoked.at(-1)?.token_type_hint === "refresh_token");
  check("uitloggen wist de sleutelhanger", !inKeychain(chatgpt.id));
  state = await list();
  const out = state.providers.find((p) => p.id === chatgpt.id);
  check("na uitloggen blijft de client-ID voor een volgende login", !out.hasKey && out.chatgpt.clientId === s.clientId);
  const blocked = await clickTest();
  check("uitgelogd: melding in plaats van een verzoek", blocked.text.includes("niet ingelogd"), blocked.text);

  const exchanges = s.log.filter((r) => r.form.grant_type === "authorization_code").length;
  s.expiresIn = 60; // Bijna verlopen, voor de controle op automatisch vernieuwen hieronder.
  const again = await loginVia("chatgpt-signin");
  check("opnieuw inloggen slaagt", again.tone.includes("ok"), again.text);
  const reAuth = new URL(again.url).searchParams;
  check("opnieuw inloggen: bewaarde client-ID, zonder agent_name_hint", reAuth.get("client_id") === s.clientId && !reAuth.has("agent_name_hint"));
  check("opnieuw inloggen: e-mail als hint, geen token in het adres", reAuth.get("login_hint") === "lezer@example.com" && !reAuth.has("id_token_hint"));
  check("opnieuw inloggen: dezelfde host-ID", reAuth.get("ext_agent_host_id") === hostId && firstAuth.searchParams.get("ext_agent_host_id") === hostId);
  check("opnieuw inloggen: nieuwe code ingewisseld", s.log.filter((r) => r.form.grant_type === "authorization_code").length === exchanges + 1);
  check("opnieuw inloggen: geen tweede registratie", (await list()).providers.filter((p) => p.kind === "chatgpt_plan").length === 1);
  check("opnieuw inloggen: geen tweede bevestiging", (await run(`return $("chatgpt-welcome").open`)) === false);

  // ---------- automatisch vernieuwen ----------
  s.expiresIn = 3600;
  const beforeAuto = refreshCount();
  const nearExpiry = s.issued.access.at(-1);
  const rotated = s.issued.refresh.at(-1);
  const auto = await clickTest();
  check("bijna verlopen token wordt vooraf vernieuwd", refreshCount() === beforeAuto + 1 && auto.text.includes("Werkt via ChatGPT"), auto.text);
  check("Responses kreeg meteen het nieuwe token", s.log.findLast((r) => r.path === "/v1/responses").headers.authorization === `Bearer ${s.issued.access.at(-1)}` && s.issued.access.at(-1) !== nearExpiry);
  check("vernieuwen gebruikte het laatste vernieuwingstoken", s.log.findLast((r) => r.form.grant_type === "refresh_token").form.refresh_token === rotated);
  await clickTest();
  check("daarna geen onnodige vernieuwing", refreshCount() === beforeAuto + 1);

  // ---------- ingetrokken sessie ----------
  s.responsesMode = "revoked";
  s.tokenFailure = { status: 400, code: "invalid_grant" };
  const revoked = await clickTest();
  check("ingetrokken sessie: begrijpelijke melding", revoked.text.includes("ingetrokken of verlopen"), revoked.text);
  check("ingetrokken sessie: tokens gewist", !inKeychain(chatgpt.id));
  state = await list();
  check("ingetrokken sessie: scherm weet het", state.providers.find((p) => p.id === chatgpt.id).chatgpt.sessionLost);
  await run(`pick("Eigen sleutel"); pick("ChatGPT");`);
  const lostStatus = await run(`return { text: $("chatgpt-account-status").textContent, signin: !$("chatgpt-signin").hidden }`);
  check("ingetrokken sessie: knop om opnieuw in te loggen", lostStatus.signin && lostStatus.text.includes("ingetrokken"), lostStatus.text);
  await shot("7-ingetrokken");
  await run(`$("bp-start").click(); for (let i = 0; i < 100 && !$("bp-error"); i++) await wait(50);`);
  const expired = await run(`const e = $("bp-error"); return { kind: e?.dataset.kind, text: e?.textContent ?? "", providers: !!$("bp-action-providers") }`);
  check("blauwdruk: verlopen login krijgt een eigen melding met weg terug", expired.kind === "chatgpt_session_revoked" && expired.text.includes("login is verlopen") && expired.providers, JSON.stringify(expired));
  await shot("7b-blauwdruk-verlopen");
  s.responsesMode = "ok";

  // ---------- abonnement niet toegestaan, daarna inschakelen ----------
  s.scope = "openid profile email offline_access";
  const noPlan = await loginVia("chatgpt-signin");
  check("zonder abonnementsrecht: ingelogd maar uitgeschakeld", noPlan.text.includes("niet gebruiken"), noPlan.text);
  const offState = await run(`return { enable: !$("chatgpt-enable").hidden, models: [...$("model-picker").options].map((o) => o.value) }`);
  check("zonder abonnementsrecht: knop om in te schakelen", offState.enable);
  const noInference = s.log.filter((r) => r.path === "/v1/responses").length;
  const off = await clickTest();
  check("zonder abonnementsrecht: geen verzoek en een keuze", off.text.includes("staat uit") && off.text.includes("API-sleutel") && s.log.filter((r) => r.path === "/v1/responses").length === noInference, off.text);
  await shot("8-abonnement-uit");
  s.scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  const enabled = await loginVia("chatgpt-enable");
  check("inschakelen vraagt expliciet opnieuw om toestemming", new URL(enabled.url).searchParams.get("prompt") === "consent");
  check("inschakelen werkt", enabled.tone.includes("ok") && enabled.text.includes("Ingelogd als"), enabled.text);
  check("gewone logins vroegen niet om opnieuw toestemming", !reAuth.has("prompt") && !firstAuth.searchParams.has("prompt"));

  // ---------- het pagina-venster kan er niet bij ----------
  await run(`$("providers-close").click();`);
  const hostile = (() => {
    const cmds = ["list_providers", "chatgpt_login", "chatgpt_logout", "chatgpt_cancel_login", "chatgpt_welcome_seen", "open_chatgpt_usage", "test_connection", "refresh_models"];
    return `<!doctype html><html><head><title>Vijandig</title></head><body><article><h1>Vijandig</h1>${"<p>Genoeg woorden om als echt artikel te tellen bij het vastleggen van deze pagina.</p>".repeat(30)}</article><script>
      (async () => {
        const report = (r) => { new Image().src = "/beacon?" + new URLSearchParams({ from: "hidden", r: JSON.stringify(r) }); };
        report({ started: true });
        for (const cmd of ${JSON.stringify(cmds)}) {
          try { const out = await window.__TAURI_INTERNALS__.invoke(cmd, { providerId: "x", askConsent: false }); report({ cmd, allowed: true, out }); }
          catch (e) { report({ cmd, allowed: false, error: String(e) }); }
        }
      })();
    </script></body></html>`;
  })();
  writeFileSync(join(ctl, "hostile.html"), hostile);
  const page = await other.serveHtml(hostile);
  const hiddenLog = () => other.log.filter((r) => r.path === "/beacon" && r.query.from === "hidden").map((r) => JSON.parse(r.query.r));
  await run(`try { await invoke("open_url", { url: ${JSON.stringify(page)}, refresh: true }); } catch (e) { return e; }`, 120000);
  const attempts = hiddenLog().filter((r) => r.cmd);
  check("controle: het script van de pagina is echt gedraaid", hiddenLog().some((r) => r.started));
  check("pagina-venster: alle ChatGPT-commando's geweigerd", attempts.length === 8 && attempts.every((r) => !r.allowed), JSON.stringify(attempts));
  check("pagina-venster: geen tokens gelekt", !secrets().some((t) => JSON.stringify(other.log).includes(t)));
  check("pagina-venster: geen tweede login gestart", !existsSync(browserFile));

  // ---------- nergens anders dan in de sleutelhanger ----------
  const dom = await run(`return document.documentElement.outerHTML + JSON.stringify(Object.entries(localStorage)) + JSON.stringify(Object.entries(sessionStorage)) + document.cookie`);
  check("geen token in het scherm of in browseropslag", !secrets().some((t) => dom.includes(t)));
  const answers = await run(`return JSON.stringify([await invoke("list_providers"), await invoke("list_sources")])`);
  check("geen token in wat de frontend kan opvragen", !secrets().some((t) => answers.includes(t)));
  await stopApp();
  check("geen token in de app-uitvoer (logs)", !secrets().some((t) => appOutput.includes(t)));
  const places = [data, ctl, join(homedir(), "Library/Application Support/app.deepdive.reader"), join(homedir(), "Library/WebKit/app.deepdive.reader"), join(homedir(), "Library/Caches/app.deepdive.reader"), join(homedir(), "Library/WebKit/deepdive"), join(homedir(), "Library/Caches/deepdive")];
  const hits = places.flatMap((p) => grepDir(p, secrets()));
  check(`geen token in de bestanden van de app (${secrets().length} tokens gezocht)`, hits.length === 0, hits.join());
  check("tokens staan wel in de sleutelhanger", inKeychain(chatgpt.id));
  check("host-ID is anoniem en niet veranderd", readFileSync(hostFile, "utf8") === hostId && !hostId.includes("lezer") && /^urn:uuid:/.test(hostId));
  check("in de hele flow geen schending van de documentatie", s.violations.length === 0, s.violations.join("; "));
}

try {
  await main();
} catch (e) {
  failures++;
  console.log(`FOUT ${e.stack ?? e}`);
  if (appOutput) console.log(`app-uitvoer:\n${secrets().reduce((text, t) => text.replaceAll(t, "***"), appOutput).slice(-2000)}`);
} finally {
  app?.kill("SIGKILL");
  mock.close();
  other.close();
  const file = join(data, "providers.json");
  for (const p of existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).providers : []) {
    for (const account of [`chatgpt:${p.id}`, `provider:${p.id}`]) spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
  }
  rmSync(ctl, { recursive: true, force: true });
  rmSync(data, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} controle(s) mislukt` : "\nAlles geslaagd");
process.exit(failures ? 1 : 0);
