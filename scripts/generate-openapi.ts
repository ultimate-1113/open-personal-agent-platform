import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import openapiTS, { astToString, type OpenAPI3 } from "openapi-typescript";
import { createOpenApiDocument } from "../packages/knowledge-api/src/index.ts";

const check = process.argv.includes("--check");
const directory = resolve("openapi");
await mkdir(directory, { recursive: true });
let stale = false;
for (const plane of ["public", "delegated"] as const) {
  const path = resolve(directory, `${plane}.openapi.json`);
  const document = createOpenApiDocument(plane);
  const expected = `${JSON.stringify(document, null, 2)}\n`;
  const typePath = resolve("packages", "sdk", "src", "generated", `${plane}.ts`);
  const generatedTypes = astToString(await openapiTS(document as OpenAPI3));
  if (check) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== expected) { console.error(`${path} is stale`); stale = true; }
    const currentTypes = await readFile(typePath, "utf8").catch(() => "");
    if (currentTypes !== generatedTypes) { console.error(`${typePath} is stale`); stale = true; }
  } else {
    await mkdir(resolve("packages", "sdk", "src", "generated"), { recursive: true });
    await Promise.all([writeFile(path, expected, "utf8"), writeFile(typePath, generatedTypes, "utf8")]);
  }
}
if (stale) process.exitCode = 1;
