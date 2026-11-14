// Kijkt naar het ontwerp in de echte app: vult een lege map met een paar stukken en markeringen en maakt
// schermafdrukken van de zijbalk, het zoeken, het Nieuw-menu en de donkere modus.
// Eerst bouwen: npm run tauri build -- --debug --no-bundle --features screenshots
// Daarna: node tests/e2e/look.mjs [map-voor-schermafdrukken]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const SERVICE = `app.deepdive.reader.e2e.${randomBytes(4).toString("hex")}`;
const data = mkdtempSync(join(tmpdir(), "dd-look-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-look-ctl-"));
const shots = process.argv[2] ?? mkdtempSync(join(tmpdir(), "dd-look-shots-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const para = (n) => `<p>${"Every few years a headline announces that we are in the grip of a sleep epidemic. Screens, stress and long commutes have eaten away at the night. ".repeat(n)}</p>`;
const site = createServer((req, res) => {
  const title = decodeURIComponent(req.url.slice(1)).replace(/-/g, " ");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html lang="en"><head><title>${title}</title></head><body><article><h1>${title}</h1><p class="byline">By Maria Lindqvist</p>${para(3)}<p>Yet the best long-term data tell a quieter story. Average sleep duration has barely moved since 1960.</p>${para(4)}${para(5)}${para(3)}</article></body></html>`);
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${site.address().port}`;

const app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_LANGUAGE: process.env.LOOK_LANG ?? "nl", DEEPDIVE_KEYCHAIN_SERVICE: SERVICE }, stdio: "ignore" });

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
const HELPERS = `const $ = (id) => document.getElementById(id); const invoke = window.__TAURI_INTERNALS__.invoke; const wait = (ms) => new Promise((r) => setTimeout(r, ms));`;
async function run(body) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:String(e&&e.message||e)});0`);
  for (let i = 0; i < 600; i++) {
    let v = JSON.parse(await raw(`JSON.stringify(window.__r)`));
    if (typeof v === "string") v = JSON.parse(v);
    if (v) {
      if ("err" in v) throw new Error(v.err);
      return v.ok;
    }
    await sleep(50);
  }
  throw new Error("te lang");
}
async function shot(name) {
  const tiff = join(shots, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  await sleep(300);
  execFileSync("sips", ["-s", "format", "png", tiff, "--out", join(shots, `${name}.png`)], { stdio: "ignore" });
  rmSync(tiff, { force: true });
  console.log(join(shots, `${name}.png`));
}

try {
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("source-list")`)) === true) break;
    } catch {
      if (i > 80) throw new Error("app start niet");
    }
    await sleep(250);
  }
  const titles = ["Why-we-sleep-less-than-our-grandparents-did", "The-quiet-decline-of-the-public-library", "Primes-are-more-regular-than-we-thought", "Waarom-we-vergeten-wat-we-lezen"];
  const ids = [];
  for (const t of titles) ids.push((await run(`return (await invoke("open_url", { url: ${JSON.stringify(`${base}/${t}`)}, refresh: true, previewRequest: "0" })).id`)));
  ids.push(await run(`return (await invoke("import_text", { title: "Notities koffieproef", url: "", text: "Eerste alinea over koffie.\\n\\nTweede alinea, met wat meer tekst over smaak en slaap." })).id`));
  // Oudere datums, zodat de groepen te zien zijn.
  const days = [0, 3, 12, 40, 1];
  ids.forEach((id, i) => {
    const file = join(data, "sources", id, "source.json");
    const src = JSON.parse(readFileSync(file, "utf8"));
    src.capturedAt = new Date(Date.now() - days[i] * 86_400_000).toISOString();
    writeFileSync(file, JSON.stringify(src));
  });
  const hl = (id, text, color, note) => `await invoke("save_highlight", { sourceId: ${JSON.stringify(id)}, highlight: { id: "${randomBytes(16).toString("hex")}", color: "${color}", text: ${JSON.stringify(text)}, from: 2, to: 2, anchor: { kind: "web", start: 10, end: 60 }, note: ${JSON.stringify(note)} } });`;
  await run(hl(ids[0], "Average sleep duration has barely moved since 1960.", "yellow", null) + hl(ids[0], "Artificial light pushed sleep later, not shorter.", "blue", "Interessant: verschuiving, geen tekort") + hl(ids[3], "We vergeten het meeste binnen een dag.", "green", null));
  await run(`location.reload()`).catch(() => {});
  await sleep(2500);
  await run(`await wait(300); $("source-list").querySelector('[data-id="${ids[0]}"]').click(); await wait(2500);`);
  await shot("1-licht");
  await run(`const s=$("source-search"); s.value="sleep"; s.dispatchEvent(new Event("input")); await wait(600);`);
  await shot("2-zoeken");
  await run(`const s=$("source-search"); s.value=""; s.dispatchEvent(new Event("input")); $("new-open").click(); await wait(300);`);
  await shot("3-nieuw-menu");
  await run(`$("new-open").click(); document.documentElement.dataset.theme="dark"; await wait(300);`);
  await shot("4-donker");
  await run(`$("settings-open").click(); await wait(300);`);
  await shot("5-instellingen-donker");
  await run(`$("settings-close").click(); document.documentElement.dataset.theme="light"; $("sidebar-hide").click(); await wait(300);`);
  await shot("6-zijbalk-dicht");
  await run(`$("sidebar-show").click();`);
  if (process.env.LOOK_KEEP) await sleep(Number(process.env.LOOK_KEEP));
} finally {
  app.kill("SIGTERM");
  site.close();
}
