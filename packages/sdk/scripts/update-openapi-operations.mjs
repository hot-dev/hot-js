import { readFile, writeFile } from "node:fs/promises";

const source = process.argv[2] ?? "http://localhost:4681/openapi.json";
const out = new URL("../test/fixtures/openapi-operations.json", import.meta.url);

const spec = await loadOpenApi(source);
const paths = spec?.paths;
if (!paths || typeof paths !== "object") {
  throw new Error(`No OpenAPI paths found in ${source}`);
}

const operations = [];
for (const [path, pathItem] of Object.entries(paths)) {
  if (!pathItem || typeof pathItem !== "object") continue;

  for (const method of ["get", "post", "put", "patch", "delete"]) {
    if (method in pathItem) {
      operations.push({
        method: method.toUpperCase(),
        path,
      });
    }
  }
}

operations.sort((a, b) => {
  const byPath = a.path.localeCompare(b.path);
  return byPath || a.method.localeCompare(b.method);
});

await writeFile(out, `${JSON.stringify(operations, null, 2)}\n`);

async function loadOpenApi(input) {
  if (/^https?:\/\//.test(input)) {
    const response = await fetch(input);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${input}: ${response.status}`);
    }
    return response.json();
  }

  return JSON.parse(await readFile(input, "utf8"));
}
