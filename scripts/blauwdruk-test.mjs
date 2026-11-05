// Stuurt de blauwdruktest aan via de testhaak van de debug-build. Alle uitvoer komt in .blauwdruk-test/, die git negeert.
//   node scripts/blauwdruk-test.mjs fetch             haalt de selectie op en toont het oordeel per stuk
//   node scripts/blauwdruk-test.mjs run [labels...]   maakt blauwdrukken; een stuk dat er al is wordt overgeslagen.
//                                                     Met labels worden ook alleen die stukken geopend.
// Vraagt modellen op bij de providers die in de app staan. Sleutels en tokens blijven in de AI-laag van de app.
// MODELS=sushi of MODELS=chatgpt beperkt de run tot één model.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".blauwdruk-test");
const BIN = join(ROOT, "src-tauri/target/debug/deepdive");
const PROVIDERS = join(homedir(), "Library/Application Support/app.deepdive.reader/providers.json");
const CHATGPT_MODEL = process.env.CHATGPT_MODEL ?? "gpt-6.1-sol";
const SUSHI_MODEL = "GLM-5.3-Flash-Sushi-2.4bpw";

function pieces() {
  const dropped = existsSync(join(OUT, "uit-selectie.txt")) ? readFileSync(join(OUT, "uit-selectie.txt"), "utf8").split(/\s+/) : [];
  const lines = readFileSync(join(ROOT, "docs/blauwdruk-test/selectie.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const web = lines.map((l) => l.split(" ")).map(([kind, label, url]) => ({ kind, label, url })).filter((p) => !dropped.includes(p.label));
  const dir = join(ROOT, "docs/blauwdruk-test/fixtures");
  const own = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "VERWACHT.md").map((f) => ({ label: f.replace(".md", ""), fixture: join(dir, f) }));
  return [...web, ...own];
}

function models() {
  const { providers } = JSON.parse(readFileSync(PROVIDERS, "utf8"));
  const sushi = providers.find((p) => p.kind === "openai_compatible" && p.models.some((m) => m.id === SUSHI_MODEL));
  const chatgpt = providers.find((p) => p.kind === "chatgpt_plan" && p.models.some((m) => m.id === CHATGPT_MODEL));
  const all = [];
  if (sushi) all.push({ slug: "sushi", providerId: sushi.id, modelId: SUSHI_MODEL });
  if (chatgpt) all.push({ slug: "chatgpt", providerId: chatgpt.id, modelId: CHATGPT_MODEL });
  const only = process.env.MODELS?.split(",");
  return only ? all.filter((m) => only.includes(m.slug)) : all;
}

const [command, ...labels] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const chosen = pieces().filter((p) => !p.kind || p.kind !== "reserve").filter((p) => !labels.length || labels.includes(p.label));
const plan = command === "fetch" ? { pieces: pieces() } : { pieces: chosen, models: models(), only: labels };
// Een eigen plan per run: twee runs tegelijk (één per model) lezen zo niet elkaars plan.
const planFile = join(OUT, `plan-${process.pid}.json`);
writeFileSync(planFile, JSON.stringify(plan, null, 1));
const result = spawnSync(BIN, [], {
  stdio: "inherit",
  env: { ...process.env, DEEPDIVE_DATA_DIR: join(OUT, "data"), DEEPDIVE_BLUEPRINT_TEST: planFile, DEEPDIVE_BLUEPRINT_OUT: OUT },
});
process.exit(result.status ?? 1);
