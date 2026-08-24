import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

type Manifest = {
  id: string;
  version: string;
  runtime: { kind: string; package?: string };
  tools: Array<{ id: string; inputSchema: unknown; outputSchema: unknown }>;
};

const root = resolve("plugins");
const categories = await readdir(root, { withFileTypes: true }).catch(() => []);
const manifests: Manifest[] = [];
for (const category of categories.filter((entry) => entry.isDirectory())) {
  const categoryRoot = resolve(root, category.name);
  for (const plugin of await readdir(categoryRoot, { withFileTypes: true })) {
    if (!plugin.isDirectory()) continue;
    const value: unknown = JSON.parse(await readFile(resolve(categoryRoot, plugin.name, "plugin.json"), "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid plugin manifest");
    const manifest = value as Manifest;
    if (!manifest.id || !manifest.version || manifest.runtime?.kind !== "static" || !Array.isArray(manifest.tools)) {
      throw new Error(`Invalid static plugin manifest: ${category.name}/${plugin.name}`);
    }
    manifests.push(manifest);
  }
}
const pluginIds = new Set<string>();
const toolIds = new Set<string>();
for (const manifest of manifests) {
  if (pluginIds.has(manifest.id)) throw new Error(`Duplicate plugin id: ${manifest.id}`);
  pluginIds.add(manifest.id);
  for (const tool of manifest.tools) {
    if (toolIds.has(tool.id)) throw new Error(`Duplicate tool id: ${tool.id}`);
    if (!tool.inputSchema || !tool.outputSchema) throw new Error(`Missing schema: ${tool.id}`);
    toolIds.add(tool.id);
  }
}
await writeFile(resolve("packages", "plugin-sdk", "static-plugin-registry.json"),
  `${JSON.stringify({ apiVersion: "opap.dev/static-plugin-registry/v1", plugins: manifests }, null, 2)}\n`);
console.log(`Validated ${manifests.length} static plugin(s) and ${toolIds.size} tool(s).`);
