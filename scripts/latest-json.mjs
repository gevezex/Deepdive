// Writes latest.json for the in-app updater, next to the signed update in the macOS bundle folder.
// Run after `npm run tauri build` with TAURI_SIGNING_PRIVATE_KEY set; upload latest.json, Deepdive.app.tar.gz and the
// dmg to the GitHub release v<version>. The app reads releases/latest/download/latest.json.
//
//   node scripts/latest-json.mjs [--notes "What is new"] [--base-url <url>] [--target <dir>]
//
// --base-url and --target are for the local update test; normally the defaults are right.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const version = option("--version") ?? config.version;
const bundle = option("--target") ?? join(root, "src-tauri/target/release/bundle/macos");
const archive = "Deepdive.app.tar.gz";
const sigPath = join(bundle, `${archive}.sig`);
if (!existsSync(sigPath)) {
  console.error(`${sigPath} is missing. Build with TAURI_SIGNING_PRIVATE_KEY set, for example:
  TAURI_SIGNING_PRIVATE_KEY=~/.tauri/deepdive-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build -- --bundles app,dmg`);
  process.exit(1);
}

const baseUrl = option("--base-url") ?? `https://github.com/gevezex/Deepdive/releases/download/v${version}`;
const latest = {
  version,
  notes: option("--notes") ?? `Deepdive ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": { signature: readFileSync(sigPath, "utf8").trim(), url: `${baseUrl}/${archive}` },
  },
};
const out = join(bundle, "latest.json");
writeFileSync(out, JSON.stringify(latest, null, 2) + "\n");
console.log(`Wrote ${out} for version ${version}`);
