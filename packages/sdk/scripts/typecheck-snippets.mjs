// Type-check the TypeScript code blocks in the READMEs against the SDK
// sources, so documented examples keep compiling. Each block becomes its own
// module in .snippets/; names the examples leave to the reader (an existing
// client, IDs, the app's auth helper) are declared in a shared prelude.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(sdk, ".snippets");
const readmes = [join(sdk, "README.md"), join(sdk, "..", "..", "README.md")];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let count = 0;
for (const readme of readmes) {
  const text = readFileSync(readme, "utf8");
  const blocks = text.matchAll(/```(?:typescript|ts)\n([\s\S]*?)```/g);
  for (const [, code] of blocks) {
    count += 1;
    writeFileSync(join(out, `snippet-${count}.ts`), `export {};\n${code}`);
  }
}

writeFileSync(join(out, "prelude.d.ts"), `import type { HotClient } from "@hot-dev/sdk";

declare global {
  const hot: HotClient;
  const runId: string;
  const taskId: string;
  const taskIds: string[];
  function requireUser(request: Request): Promise<{ id: string }>;
}
`);

writeFileSync(join(out, "tsconfig.json"), JSON.stringify({
  extends: "../../../tsconfig.base.json",
  compilerOptions: {
    noEmit: true,
    noUnusedLocals: false,
    types: ["node"],
    baseUrl: ".",
    paths: {
      "@hot-dev/sdk": ["../src/index.ts"],
      "@hot-dev/sdk/*": ["../src/*/index.ts"],
    },
  },
  include: ["*.ts", "../src/**/*.ts"],
}, null, 2));

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
try {
  execFileSync(process.execPath, [tsc, "-p", join(out, "tsconfig.json")], { stdio: "inherit" });
} catch {
  console.error(`README snippets failed to type-check (sources in ${out})`);
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
console.log(`Type-checked ${count} README snippets`);
