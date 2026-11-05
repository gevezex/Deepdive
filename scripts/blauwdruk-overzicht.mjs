// Bouwt het lokale beoordelingsoverzicht uit .blauwdruk-test/ en schrijft een samenvatting zonder artikeltekst.
//   node scripts/blauwdruk-overzicht.mjs
// .blauwdruk-test/overzicht.html bevat kopieën van artikelen en blijft dus buiten git.
// docs/blauwdruk-test/resultaten.json bevat alleen getallen en labels, en gaat wel mee.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".blauwdruk-test");
const json = (p) => JSON.parse(readFileSync(p, "utf8"));

const pieceMeta = json(join(OUT, "pieces.json")).filter((p) => p.ok);
const selection = Object.fromEntries(readFileSync(join(ROOT, "docs/blauwdruk-test/selectie.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" ")).map(([kind, label]) => [label, kind]));
const slugs = existsSync(join(OUT, "runs")) ? readdirSync(join(OUT, "runs")) : [];

const pieces = [];
const summary = [];
for (const meta of pieceMeta) {
  if (selection[meta.label] === "reserve") continue;
  const runs = {};
  for (const slug of slugs) {
    const file = join(OUT, "runs", slug, `${meta.label}.json`);
    if (!existsSync(file)) continue;
    const run = json(file);
    delete run.raw;
    runs[slug] = run;
    const calls = run.report.calls;
    const b = run.blueprint;
    summary.push({
      label: meta.label,
      group: selection[meta.label] ?? "eigen tekst",
      model: slug,
      modelId: run.model,
      words: meta.words,
      ok: run.ok,
      errorKind: run.errorKind ?? null,
      seconds: Math.round(run.seconds),
      goalReadySeconds: calls.find((c) => c.stage === "structure" && c.goalReadySeconds)?.goalReadySeconds ?? null,
      calls: calls.length,
      schemaFirstTry: calls.filter((c) => c.attempt === 1).every((c) => c.schemaOk),
      estimatedInputTokens: run.report.estimatedInputTokens,
      contextTokens: run.report.contextTokens,
      inputTokens: calls.find((c) => c.stage === "structure")?.inputTokens ?? null,
      textKind: b?.textKind ?? null,
      goalKind: b?.goal.main.kind ?? null,
      blocks: b?.blocks.length ?? 0,
      relations: b?.relations.length ?? 0,
      points: b?.critique?.points.length ?? null,
      pointsByCategory: b?.critique ? Object.fromEntries(b.critique.checked.map((k) => [k.category, b.critique.points.filter((p) => p.category === k.category).length])) : null,
      inferredPoints: b?.critique?.points.filter((p) => p.origin === "inferred").length ?? null,
      quotes: b?.checks.quotes ?? null,
      coverage: b ? Math.round(b.checks.coverage * 100) / 100 : null,
      rangesFixed: b?.checks.rangesFixed ?? null,
      relationsRemoved: b?.checks.relationsRemoved ?? null,
      anchorsRemoved: b?.checks.anchorsRemoved ?? null,
      issues: b ? b.issues.map((i) => i.code) : [],
      likelyIncomplete: b?.source.likelyIncomplete ?? null,
    });
  }
  if (!Object.keys(runs).length) continue;
  const dir = join(OUT, "data/sources", meta.id);
  const source = json(join(dir, readdirSync(dir).find((f) => f === "source.json")));
  pieces.push({ ...meta, group: selection[meta.label] ?? "eigen tekst", source: { title: source.title, url: source.url, blocks: source.blocks.map((b) => ({ n: b.n, kind: b.kind, text: b.text })) }, runs });
}

writeFileSync(join(ROOT, "docs/blauwdruk-test/resultaten.json"), JSON.stringify(summary, null, 1) + "\n");
const verdict = existsSync(join(OUT, "oordeel.json")) ? json(join(OUT, "oordeel.json")) : { general: "", pieces: {} };
const data = JSON.stringify({ pieces, summary, verdict }).replace(/</g, "\\u003c");
const template = readFileSync(join(ROOT, "docs/blauwdruk-test/overzicht-sjabloon.html"), "utf8");
writeFileSync(join(OUT, "overzicht.html"), template.replace("/*DATA*/null", () => data));
console.log(`${pieces.length} stukken, ${summary.length} runs. Overzicht: ${join(OUT, "overzicht.html")}`);
