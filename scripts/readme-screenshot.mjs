// Makes the screenshots for the README with the real app, filled with made-up English articles, answers and a
// blueprint from a local fake model. Nothing here comes from a real user, site or model.
// Build first: npm run tauri build -- --debug --no-bundle --features screenshots
// Then:        node scripts/readme-screenshot.mjs [output-folder]   (default: docs/screenshots)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../src-tauri/target/debug/deepdive", import.meta.url).pathname;
const out = process.argv[2] ?? new URL("../docs/screenshots", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const data = mkdtempSync(join(tmpdir(), "dd-shot-data-"));
const ctl = mkdtempSync(join(tmpdir(), "dd-shot-ctl-"));
const SERVICE = `app.deepdive.reader.shot.${randomBytes(4).toString("hex")}`;
const MODEL = "qwen3-30b-a3b";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- made-up articles ----------

const MAIN = {
  slug: "streets", domain: "civicledger.example", path: "/opinion/give-the-streets-back-to-children",
  site: "The Civic Ledger",
  title: "Give the streets back to children",
  standfirst: "For two generations we have quietly shrunk the world a child may explore alone. It is time to undo that, one street at a time.",
  author: "Mara Lindqvist",
  date: "March 3, 2026",
  paragraphs: [
    "When my grandmother was eight, she walked a mile and a half to school, stopped at the baker on the way home and spent long summer evenings at the river with friends. Nobody thought this was remarkable. When my daughter turned eight last spring, she was not allowed to cross the road in front of our house without an adult.",
    "This is not a story about one cautious parent. Researchers call it the shrinking radius of childhood: the distance children may roam on their own has fallen by roughly ninety percent in three generations. A map of where a child may go alone now often ends at the front door.",
    "The usual explanation is fear of strangers. But crime against children has fallen in most rich countries since the 1990s. What has grown, steadily and almost without debate, is the space we give to cars.",
    "Traffic is the real reason streets stopped being places to play. In a typical residential street, more than seventy percent of the public space is reserved for moving or parked vehicles. Children did not leave the street; they were pushed off it.",
    "The costs are larger than they look. Children who move around on their own are more active, sleep better and report less anxiety. They also learn things no classroom can teach: how to judge risk, how to find their way, how to solve a problem without asking an adult first.",
    "There is good evidence that this can be reversed. When the city of Pontevedra in Spain closed its centre to most through-traffic, the number of children walking to school on their own more than tripled within a decade. Shops did not empty out. Footfall went up.",
    "Smaller experiments work too. Play streets, where a road is closed to traffic for a few hours each week, are cheap and popular. In the cities that tried them, neighbours report knowing more people on their street within a year.",
    "Critics say this is a luxury for leafy neighbourhoods. They point out that families in poorer districts depend more on cars and have less time to organise street parties. That objection deserves a serious answer.",
    "The answer is that the burden of traffic already falls hardest on those same districts. Children from low-income families are far more likely to be hit by a car. Calmer streets are not a perk for the comfortable; they are a matter of basic safety.",
    "Others worry about deliveries, emergency services and older residents who cannot walk far. These are real needs, and good schemes plan for them: access for those who need it, through-traffic for nobody.",
    "None of this requires a revolution. It requires a change in the default question we ask about a street. Today we ask how many cars it can carry. We should ask whether an eight-year-old could walk it alone.",
    "If the answer is no, the street is not finished. Lower speed limits, narrower junctions, wider pavements and a few closed through-routes would change the answer in most neighbourhoods within a few years.",
    "My grandmother's freedom was not the result of braver parents. It was the result of streets that belonged to people. We built the streets we have now. We can build different ones.",
  ],
};

const OTHERS = [
  {
    slug: "octopus", domain: "fieldnotes.example", site: "Field Notes Magazine", title: "What octopuses can teach us about memory", author: "Jonah Reyes", date: "February 27, 2026",
    standfirst: "An animal with most of its neurons in its arms is rewriting what we thought a mind needs.",
    paragraphs: [
      "Two thirds of an octopus's neurons sit not in its brain but in its arms. Each arm can taste, touch and make small decisions on its own.",
      "That raises an odd question for anyone who studies memory: where does an octopus remember things? Early experiments suggest the answer may be everywhere at once.",
      "In one study, octopuses learned to open a jar with one arm and later solved the same puzzle faster with another. Something had been shared, but not in the way a single central brain would share it.",
      "For engineers designing robots, the idea is tempting. Instead of one controller that does everything, many small controllers could learn locally and report back only what matters.",
      "The lesson for the rest of us is humbler. Memory may be less like a filing cabinet and more like a conversation between parts that each know a little.",
    ],
  },
  {
    slug: "libraries", domain: "commonsreview.example", site: "Commons Review", title: "The quiet economics of public libraries", author: "Priya Natarajan", date: "February 20, 2026",
    standfirst: "Libraries rarely make headlines. The numbers suggest they should.",
    paragraphs: [
      "Ask a city council what a library costs and you will get a precise number. Ask what it returns and the room usually goes quiet.",
      "Several studies have tried to put a figure on it. Most land somewhere between three and five units of value for every unit spent, through lending, job help, study space and simple warmth in winter.",
      "Those estimates are rough, and critics are right to say so. But even the lowest of them would make a library one of the best investments a town can make.",
      "The harder question is what we lose when a branch closes. The people who used it most are often the ones with the fewest alternatives.",
    ],
  },
  {
    slug: "four-day-week", domain: "workweekweekly.example", site: "Workweek Weekly", title: "A short history of the four-day week", author: "Tom Achterberg", date: "February 12, 2026",
    standfirst: "The idea is older than you think, and so are the arguments against it.",
    paragraphs: [
      "The five-day week was once a radical idea too. When factories first gave workers Saturday off, critics predicted ruin.",
      "Trials of a four-day week in recent years have mostly reported the same pattern: similar output, fewer sick days and staff who are reluctant to go back.",
      "The trials have limits. Companies that volunteer are not a random sample, and some jobs cannot simply be squeezed into fewer days.",
      "Still, the history suggests a pattern. Shorter weeks tend to arrive not when the arguments are settled but when enough employers decide to try.",
    ],
  },
  {
    slug: "risk", domain: "signalandnoise.example", site: "Signal & Noise", title: "Why we misjudge risk after a disaster", author: "Elena Brook", date: "February 5, 2026",
    standfirst: "Vivid events change our behaviour long after the numbers say they should not.",
    paragraphs: [
      "After a widely reported accident, many people switch to a mode of transport that is statistically more dangerous.",
      "Psychologists call it the availability heuristic: what comes to mind easily feels more likely.",
      "The effect fades, but slowly, and it can shape policy long after the public has moved on.",
    ],
  },
];

function page(a) {
  const ps = a.paragraphs.map((p) => `<p>${p}</p>`).join("\n");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${a.title} | ${a.site}</title>
<meta property="og:title" content="${a.title}"><meta property="og:site_name" content="${a.site}"><meta name="author" content="${a.author}">
<style>
body{margin:0;background:#fbfaf7;color:#1d1d1b;font:19px/1.65 Georgia,"Times New Roman",serif}
header.site{border-bottom:1px solid #e3ded3;padding:14px 32px;font:700 15px/1 -apple-system,Helvetica,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:#7a2e1f}
article{max-width:680px;margin:0 auto;padding:40px 32px 80px}
.kicker{font:600 13px/1 -apple-system,Helvetica,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#7a2e1f}
h1{font-size:42px;line-height:1.12;margin:12px 0 14px}
.standfirst{font-size:22px;line-height:1.45;color:#4a4740;margin:0 0 18px}
.byline{font:14px/1.4 -apple-system,Helvetica,sans-serif;color:#6b675e;margin-bottom:28px}
figure{margin:0 0 28px}figure div{height:220px;border-radius:4px;background:linear-gradient(135deg,#d8c7a3,#9fb59a 55%,#6f8f9a)}
figcaption{font:13px/1.4 -apple-system,Helvetica,sans-serif;color:#6b675e;margin-top:6px}
p{margin:0 0 1.1em}
</style></head><body><header class="site">${a.site}</header><article>
<div class="kicker">Opinion</div><h1>${a.title}</h1><p class="standfirst">${a.standfirst}</p>
<div class="byline">By ${a.author} · ${a.date}</div>
${ps}
</article></body></html>`;
}

// ---------- made-up model ----------

const STRUCTURE = {
  textKind: "opinion",
  goal: {
    main: { kind: "persuade", description: "Convinces the reader that cities should redesign residential streets so that children can move around on their own again." },
    secondary: [{ kind: "explain_problem", description: "Explains why children's independent range has shrunk." }],
  },
  message: "Children lost the street to traffic, not to strangers, and modest changes to street design can give it back.",
  occasion: { text: "The author's daughter may not cross the road alone at the age her grandmother walked to school.", origin: "stated", paragraphs: [[5, 5]] },
  summary: "Children today may roam far less on their own than earlier generations. The author argues that the main cause is the space given to cars, not crime, and that this harms children's health and development. Examples such as Pontevedra and play streets show it can be reversed. She answers the objection that this is a luxury for wealthy areas and ends with a simple test for every street.",
  articleParagraphs: [5, 17],
  blocks: [
    { id: "b1", role: "occasion", title: "Then and now", content: "A grandmother roamed freely; her great-granddaughter may not cross the road.", paragraphs: [[5, 6]], quote: { paragraph: 6, text: "the shrinking radius of childhood" } },
    { id: "b2", role: "thesis", title: "Cars, not strangers", content: "Crime against children fell while the space for cars grew.", paragraphs: [[7, 8]], quote: { paragraph: 8, text: "Children did not leave the street; they were pushed off it." } },
    { id: "b3", role: "argument", title: "Why it matters", content: "Independent mobility makes children healthier and more capable.", paragraphs: [[9, 9]], quote: null },
    { id: "b4", role: "evidence", title: "It can be reversed", content: "Pontevedra and play streets show results within years.", paragraphs: [[10, 11]], quote: null },
    { id: "b5", role: "objection", title: "A luxury for the rich?", content: "Critics say only wealthy areas benefit.", paragraphs: [[12, 12]], quote: null },
    { id: "b6", role: "rebuttal", title: "Safety first", content: "Poorer districts carry the heaviest burden of traffic now.", paragraphs: [[13, 14]], quote: null },
    { id: "b7", role: "conclusion", title: "A new test for every street", content: "Ask whether an eight-year-old could walk it alone.", paragraphs: [[15, 17]], quote: { paragraph: 15, text: "We should ask whether an eight-year-old could walk it alone." } },
  ],
  relations: [
    { id: "r1", block: "b2", dependsOn: "b1", kind: "builds_on", explanation: "Explains the change described in the opening." },
    { id: "r2", block: "b3", dependsOn: "b2", kind: "builds_on", explanation: "Says why losing the street matters." },
    { id: "r3", block: "b4", dependsOn: "b2", kind: "evidence_for", explanation: "Shows that removing traffic brings children back." },
    { id: "r4", block: "b5", dependsOn: "b4", kind: "contrasts", explanation: "Questions who benefits from the examples." },
    { id: "r5", block: "b6", dependsOn: "b5", kind: "answers", explanation: "Answers the objection." },
    { id: "r6", block: "b7", dependsOn: "b4", kind: "concludes", explanation: "Turns the evidence into a rule of thumb." },
  ],
};

const CRITIQUE = {
  points: [
    { id: "k1", category: "evidence", polarity: "plus", origin: "stated", certainty: "high", anchor: "b4", claim: "A concrete, checkable example supports the main claim.", explanation: "Pontevedra is named, with a time frame and an outcome.", paragraphs: [[10, 10]], quotes: [], evidenceKind: "data" },
    { id: "k2", category: "leap", polarity: "minus", origin: "inferred", certainty: "medium", anchor: "r3", claim: "One city does not prove it works everywhere.", explanation: "Pontevedra is small and compact; the text does not say whether larger cities saw the same effect.", paragraphs: [[10, 10]], quotes: [], evidenceKind: null },
    { id: "k3", category: "evidence", polarity: "minus", origin: "inferred", certainty: "medium", anchor: "b2", claim: "The key figures have no source.", explanation: "The ninety and seventy percent figures are not attributed to a study.", paragraphs: [[6, 6], [8, 8]], quotes: [], evidenceKind: null },
    { id: "k4", category: "missing", polarity: "minus", origin: "inferred", certainty: "low", anchor: "b6", claim: "Parents' own choices are left out.", explanation: "The text treats traffic as the only cause and does not discuss changing norms about supervision.", paragraphs: [[7, 7]], quotes: [], evidenceKind: null },
  ],
  terms: [{ term: "Play street", explanation: "A road closed to traffic for a few hours a week so children can play there.", paragraphs: [[11, 11]] }],
  checked: [
    { category: "assumption", result: "found", note: null },
    { category: "leap", result: "found", note: null },
    { category: "gap", result: "nothing_found", note: null },
    { category: "evidence", result: "found", note: null },
    { category: "missing", result: "found", note: null },
    { category: "headline_vs_content", result: "nothing_found", note: null },
  ],
  overall: "A clear and well-built argument with one strong example, but its numbers need sources and its evidence comes from a single small city.",
};

const WHOLE_ANSWER = `**The author argues that children lost their freedom to roam because of traffic, not crime, and that modest changes to streets can give it back.**

The evidence is mixed in strength:
- The strongest support is the Pontevedra example in ¶10: a named city, a time frame and a measurable result.
- The figures in ¶6 and ¶8 are plausible but have no source, so you cannot check them.
- ¶13 turns the main objection around well: the districts that rely most on cars also suffer most from traffic.

Outside the text: studies of independent mobility in the UK and Germany show a similar decline, though the exact percentages vary.`;

const EXPLAIN_ANSWER = `**It means the area in which a child may move around without an adult has become much smaller over the generations.**

The author uses the phrase to link her personal story in ¶5 to a wider pattern. The "radius" is the distance from home a child may go alone; for many children today it "ends at the front door". In ¶7–8 she argues that this is caused by traffic rather than danger from strangers.`;

function chunks(text, size = 24) {
  const outp = [];
  for (let i = 0; i < text.length; i += size) outp.push(text.slice(i, i + size));
  return outp;
}

async function stream(res, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const piece of chunks(text)) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece }, finish_reason: null }] })}\n\n`);
    await sleep(3);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  res.end();
}

const server = createServer((req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => {
    const p = new URL(req.url, "http://localhost").pathname;
    const body = Buffer.concat(parts).toString();
    const article = [MAIN, ...OTHERS].find((a) => p === `/${a.slug}`);
    if (article) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page(article));
    }
    if (p === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: MODEL }] }));
    }
    if (p.startsWith("/v1/")) {
      if (body.includes("about the text as a whole")) return stream(res, WHOLE_ANSWER);
      if (body.includes("<selection-")) return stream(res, EXPLAIN_ANSWER);
      if (body.includes("TASK: make layer 3")) return stream(res, JSON.stringify(CRITIQUE));
      return stream(res, JSON.stringify(STRUCTURE));
    }
    res.writeHead(404);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------- driving the app (same control channel as the e2e tests) ----------

const app = spawn(BIN, [], { env: { ...process.env, DEEPDIVE_DATA_DIR: data, DEEPDIVE_E2E_DIR: ctl, DEEPDIVE_LANGUAGE: "en", DEEPDIVE_KEYCHAIN_SERVICE: SERVICE }, stdio: ["ignore", "pipe", "pipe"] });
let appOutput = "";
app.stdout.on("data", (d) => (appOutput += d));
app.stderr.on("data", (d) => (appOutput += d));

async function raw(js) {
  const o = join(ctl, "out.json");
  rmSync(o, { force: true });
  writeFileSync(join(ctl, "cmd.tmp"), js);
  renameSync(join(ctl, "cmd.tmp"), join(ctl, "cmd.js"));
  for (let i = 0; i < 300; i++) {
    await sleep(50);
    if (existsSync(o)) return readFileSync(o, "utf8");
  }
  throw new Error(`no answer to: ${js.slice(0, 100)}`);
}

const HELPERS = `
const $ = (id) => document.getElementById(id);
const invoke = window.__TAURI_INTERNALS__.invoke;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const setValue = (id, v) => { const e = $(id); e.value = v; e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); };
const settled = async (id) => { for (let i = 0; i < 1800; i++) { await wait(50); const e = $(id); if (!e.hidden && !e.classList.contains("notice-busy") && e.textContent) return e.textContent; } throw "no result in " + id; };
const until = async (fn, what) => { for (let i = 0; i < 1200; i++) { const v = fn(); if (v) return v; await wait(25); } throw "waited too long for " + what; };
const frame = () => $("source-frame");
const fromFrame = (msg) => window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, data: { dd: 1, ...msg } }));
const cards = () => [...document.querySelectorAll("#answers .ans-card")];
`;

async function run(body, timeoutMs = 60000) {
  await raw(`window.__r=null;(async()=>{${HELPERS};${body}})().then(v=>window.__r={ok:v===undefined?null:v},e=>window.__r={err:e&&e.message?e.message:String(e)});0`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let value = JSON.parse(await raw(`JSON.stringify(window.__r)`));
    if (typeof value === "string") value = JSON.parse(value);
    if (value) {
      if ("err" in value) throw new Error(`in the app: ${JSON.stringify(value.err)}`);
      return value.ok;
    }
    await sleep(50);
  }
  throw new Error(`waited too long for: ${body.slice(0, 100)}`);
}

async function shot(name) {
  const tiff = join(ctl, `${name}.tiff`);
  await raw(`shot:${tiff}`);
  await sleep(400);
  const png = join(out, `${name}.png`);
  // 1800 px wide: sharp on GitHub, and about 1 MB per picture.
  execFileSync("sips", ["-s", "format", "png", "-Z", "1800", tiff, "--out", png], { stdio: "ignore" });
  rmSync(tiff, { force: true });
  console.log(`wrote ${png}`);
}

async function openArticle(a) {
  console.log("  open " + a.slug);
  await run(`
    $("url-input").value = ${JSON.stringify(`${base}/${a.slug}`)}; $("url-form").requestSubmit();
    for (let i = 0; i < 600; i++) {
      if ((await invoke("list_sources")).some((s) => s.title === ${JSON.stringify(a.title)})) break;
      await wait(100);
    }
    await until(() => document.title.startsWith(${JSON.stringify(a.title)}) && !frame().hidden, "article ${a.slug}");
    await wait(1200);
  `, 120000);
}

/** The place of a piece of text in the copy, counted the way the script in the copy counts (bridge.js). */
function offsets(html, needle) {
  return `
    const doc = new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html");
    const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);
    const w = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement && SKIP.has(n.parentElement.tagName) ? 2 : 1) });
    let text = ""; for (let n = w.nextNode(); n; n = w.nextNode()) text += n.data;
    const start = text.indexOf(${JSON.stringify(needle)});
    if (start < 0) throw "not in copy: " + ${JSON.stringify(needle)};
    const at = { start, end: start + ${needle.length} };
  `;
}

function copyOf(sourceId) {
  const dir = join(data, "sources", sourceId);
  const file = readdirSync(dir, { recursive: true }).map(String).find((f) => f.endsWith(".html"));
  return readFileSync(join(dir, file), "utf8");
}

try {
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("providers-open")`, 3000)) === true) break;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
  }

  console.log("step: provider");
  await run(`
    $("providers-open").click();
    $("provider-new").click();
    setValue("provider-preset", "custom");
    setValue("provider-name", "Local");
    setValue("provider-url", ${JSON.stringify(`${base}/v1`)});
    $("provider-form").requestSubmit();
    await settled("provider-result");
    $("models-refresh").click();
    await settled("models-result");
    $("providers-close").click();
    const p = (await invoke("list_providers")).providers.find((p) => p.name === "Local");
    setValue("model-picker", JSON.stringify([p.id, ${JSON.stringify(MODEL)}]));
    await wait(300);
  `);

  console.log("step: articles");
  for (const a of [...OTHERS].reverse()) await openArticle(a);
  await openArticle(MAIN);
  const sourceId = await run(`return (await invoke("list_sources")).find((s) => s.title === ${JSON.stringify(MAIN.title)}).id`);
  const blocks = await run(`return (await invoke("get_source", { id: ${JSON.stringify(sourceId)} })).blocks.map((b) => b.n + " " + b.kind + " " + b.text.slice(0, 50))`);
  console.log(blocks.join("\n"));

  console.log("step: blueprint");
  // Blueprint.
  await run(`$("tab-blueprint").click(); $("bp-start").click(); await until(() => $("bp-outcomes") && !$("bp-progress"), "blueprint"); await wait(500);`, 120000);

  console.log("step: highlight and explain");
  // A highlight, and a question about a selected phrase.
  const html = copyOf(sourceId);
  const mark = "What has grown, steadily and almost without debate, is the space we give to cars.";
  await run(`${offsets(html, mark)}
    fromFrame({ type: "selection", text: ${JSON.stringify(mark)}, from: 7, to: 7, start: at.start, end: at.end, rect: { top: 300, left: 200, bottom: 320, right: 600 } });
    await wait(100);
    $("sel-mark").click(); await wait(500);`);
  const phrase = "the shrinking radius of childhood";
  await run(`${offsets(html, phrase)}
    fromFrame({ type: "selection", text: ${JSON.stringify(phrase)}, from: 6, to: 6, start: at.start, end: at.end, rect: { top: 300, left: 200, bottom: 320, right: 600 } });
    await wait(100);
    document.querySelector('#sel-bar [data-action="explain"]').click();
    await until(() => cards().length === 1 && cards()[0].querySelector(".ans-follow"), "explain answer");`);

  console.log("step: whole-text question");
  // The new question about the whole text.
  await run(`const f = document.querySelector(".ans-ask"); f.querySelector("input").value = "What is the author's main argument, and how strong is the evidence?"; f.requestSubmit();
    await until(() => cards().length === 2 && cards()[0].querySelector(".ans-follow"), "whole-text answer");
  `);
  // Reload, as after a restart: the copy then gets its highlights from disk.
  await run(`location.reload();`).catch(() => {});
  await sleep(2500);
  for (let i = 0; ; i++) {
    try {
      if ((await run(`return !!$("providers-open") && !frame().hidden`, 3000)) === true) break;
    } catch (e) {
      if (i > 60) throw e;
    }
    await sleep(500);
  }
  await run(`await wait(1500); $("tab-answers").click(); await until(() => cards().length === 2, "conversations after reload");
    document.activeElement?.blur(); $("answers").scrollTop = 0; await wait(500);`);
  // The copies came from 127.0.0.1; show made-up .example addresses instead, so the picture looks like real use.
  const domains = Object.fromEntries([MAIN, ...OTHERS].map((a) => [a.title, a.domain]));
  await run(`
    $("url-input").value = ${JSON.stringify(`https://${MAIN.domain}${MAIN.path}`)};
    const domains = ${JSON.stringify(domains)};
    for (const [title, domain] of Object.entries(domains)) {
      const item = [...document.querySelectorAll("#sidebar *")].find((e) => e.children.length === 0 && e.textContent.trim() === title)?.closest("li, button, a, [role=option], .source-item");
      if (!item) continue;
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.data.includes("127.0.0.1")) n.data = n.data.replace("127.0.0.1", domain);
    }
    await wait(200);
  `);
  await shot("questions");

  await run(`$("tab-blueprint").click(); $("blueprint").scrollTop = 0; await wait(600);`);
  await shot("blueprint");
} catch (e) {
  console.error(e);
  console.error(appOutput.slice(-2000));
  process.exitCode = 1;
} finally {
  app.kill("SIGTERM");
  server.close();
  rmSync(data, { recursive: true, force: true });
  rmSync(ctl, { recursive: true, force: true });
}
