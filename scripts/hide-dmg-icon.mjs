// Hides .VolumeIcon.icns in the macOS dmg. Tauri's dmg script copies the volume icon but does not mark it hidden,
// so Finder shows it next to Deepdive and Applications. Run after `npm run tauri build`, before uploading the dmg.
//
//   node scripts/hide-dmg-icon.mjs [path/to/Deepdive_<version>_aarch64.dmg]
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
const dmg = process.argv[2] ?? join(root, `src-tauri/target/release/bundle/dmg/Deepdive_${version}_aarch64.dmg`);
if (!existsSync(dmg)) {
  console.error(`${dmg} is missing. Build first: npm run tauri build -- --bundles app,dmg`);
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const work = mkdtempSync(join(tmpdir(), "dd-dmg-"));
const rw = join(work, "rw.dmg");
const mount = join(work, "mnt");
const out = join(work, "out.dmg");
try {
  run("hdiutil", ["convert", dmg, "-format", "UDRW", "-o", rw]);
  run("hdiutil", ["attach", rw, "-nobrowse", "-noautoopen", "-mountpoint", mount]);
  try {
    for (const name of [".VolumeIcon.icns", ".background", ".fseventsd"]) {
      if (existsSync(join(mount, name))) run("chflags", ["hidden", join(mount, name)]);
    }
  } finally {
    run("hdiutil", ["detach", mount]);
  }
  run("hdiutil", ["convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", out]);
  renameSync(out, dmg);
  console.log(`Hid the volume icon in ${dmg}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
