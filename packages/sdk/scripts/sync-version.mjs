// Rewrites src/version.ts from package.json. Wired into the `version`
// lifecycle script so `npm version <v>` keeps the two in sync.
import { readFile, writeFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const out = new URL("../src/version.ts", import.meta.url);

await writeFile(
  out,
  "// Generated from package.json by scripts/sync-version.mjs (runs on `npm version`).\n" +
    `export const VERSION = "${pkg.version}";\n`,
);
console.log(`src/version.ts -> ${pkg.version}`);
