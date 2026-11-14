// Hides .VolumeIcon.icns in the macOS dmg. Tauri's dmg script copies the volume icon but does not mark it hidden,
// so Finder shows it next to Deepdive and Applications. Someone who shows hidden files in Finder (⌘⇧.) would still
// see it, so the script also moves it outside the window, as Tauri does when a dmg has a background picture.
// Run after `npm run tauri build`, before uploading the dmg. Finder opens the disk for a moment while it runs.
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

// Puts the icon to the right of the window, outside the part Finder shows when the disk opens. Finder writes the
// position to .DS_Store when the window closes. No `update`: on macOS 27 that deletes .VolumeIcon.icns.
const MOVE_ICON = `on run argv
  tell application "Finder"
    set d to (POSIX file (item 1 of argv)) as alias
    open d
    delay 1
    set w to front Finder window
    set b to bounds of w
    set position of item ".VolumeIcon.icns" of d to {(item 3 of b) - (item 1 of b) + 100, 100}
    delay 2
    close w
    delay 1
  end tell
end run`;

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const work = mkdtempSync(join(tmpdir(), "dd-dmg-"));
const rw = join(work, "rw.dmg");
const mount = join(work, "mnt");
const out = join(work, "out.dmg");
try {
  run("hdiutil", ["convert", dmg, "-format", "UDRW", "-o", rw]);
  // Without -nobrowse: Finder has to see the disk to store the new position in its .DS_Store.
  run("hdiutil", ["attach", rw, "-noautoopen", "-mountpoint", mount]);
  try {
    // First move, then hide: Finder does not see hidden items.
    run("osascript", ["-e", MOVE_ICON, mount]);
    if (!existsSync(join(mount, ".VolumeIcon.icns"))) throw new Error("Finder removed .VolumeIcon.icns; the dmg was left unchanged.");
    for (const name of [".VolumeIcon.icns", ".background"]) {
      if (existsSync(join(mount, name))) run("chflags", ["hidden", join(mount, name)]);
    }
    // Finder may clear the custom-icon flag of the disk; without it the disk shows a plain icon.
    run("SetFile", ["-a", "C", mount]);
    // Finder's own bookkeeping folder; the dmg from Tauri does not have it.
    rmSync(join(mount, ".fseventsd"), { recursive: true, force: true });
    run("sync", []);
  } finally {
    run("hdiutil", ["detach", mount]);
  }
  run("hdiutil", ["convert", rw, "-format", "UDZO", "-imagekey", "zlib-level=9", "-o", out]);
  renameSync(out, dmg);
  console.log(`Hid the volume icon in ${dmg}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
