// Kopieert de pdf.js-bestanden die offline nodig zijn (cmaps, standaardfonts, wasm) naar public/pdfjs.
// Die map is gegenereerd en staat niet in git.
import { cpSync, existsSync, mkdirSync } from "node:fs";

const from = "node_modules/pdfjs-dist";
const to = "public/pdfjs";
if (!existsSync(from)) process.exit(0);
mkdirSync(to, { recursive: true });
for (const dir of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
  if (existsSync(`${from}/${dir}`)) cpSync(`${from}/${dir}`, `${to}/${dir}`, { recursive: true });
}
