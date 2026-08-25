import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPluginArchive } from "@opap/plugin-sdk";

const directory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(directory, "dist");
const bundle = await readFile(join(directory, "src", "index.mjs"));
const bundleSha256 = createHash("sha256").update(bundle).digest("hex");
const manifest = {
  apiVersion: "opap.dev/v1alpha1",
  kind: "Plugin",
  id: "text.utilities",
  version: "0.1.0",
  platformVersion: ">=0.1.0-beta.1 <0.2.0",
  runtime: { kind: "sandbox-esm", entrypoint: "dist/index.mjs" },
  tools: [{
    id: "text.utilities.stats",
    description: "Count Unicode characters, lines, and whitespace-delimited words without external communication.",
    inputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { text: { type: "string", maxLength: 100_000 } },
      required: ["text"],
      additionalProperties: false,
    },
    outputSchema: {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        characters: { type: "integer", minimum: 0 },
        lines: { type: "integer", minimum: 0 },
        words: { type: "integer", minimum: 0 },
      },
      required: ["characters", "lines", "words"],
      additionalProperties: false,
    },
  }],
  requestedCapabilityIds: [],
  limits: { timeoutMs: 5_000, outputBytes: 8_192, concurrency: 1 },
  artifact: { sha256: bundleSha256, sbomPath: "sbom.cdx.json" },
};
const sbom = {
  bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: "urn:uuid:1d30b2e8-cd1e-4f31-92d7-23ca291c7d9d",
  version: 1, metadata: { component: { type: "application", name: "OPAP Text Utilities", version: "0.1.0" } },
  components: [],
};

const encoder = new TextEncoder();
const writeAscii = (target: Uint8Array, offset: number, value: string, length: number): void => {
  target.set(encoder.encode(value).subarray(0, length), offset);
};
const tarGzip = async (files: Readonly<Record<string, Uint8Array | string>>): Promise<Uint8Array> => {
  const blocks: Uint8Array[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const content = typeof raw === "string" ? encoder.encode(raw) : raw;
    const header = new Uint8Array(512);
    writeAscii(header, 0, path, 100); writeAscii(header, 100, "0000644\0", 8);
    writeAscii(header, 108, "0000000\0", 8); writeAscii(header, 116, "0000000\0", 8);
    writeAscii(header, 124, `${content.byteLength.toString(8).padStart(11, "0")}\0`, 12);
    writeAscii(header, 136, "00000000000\0", 12); writeAscii(header, 148, "        ", 8);
    header[156] = "0".charCodeAt(0); writeAscii(header, 257, "ustar\0", 6); writeAscii(header, 263, "00", 2);
    const checksum = header.reduce((total, value) => total + value, 0);
    writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
    blocks.push(header, content, new Uint8Array((512 - (content.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const tar = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) { tar.set(block, offset); offset += block.byteLength; }
  return new Uint8Array(await new Response(new Blob([tar]).stream()
    .pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
};

const archive = await tarGzip({
  "plugin.json": `${JSON.stringify(manifest, null, 2)}\n`,
  "dist/index.mjs": bundle,
  "sbom.cdx.json": `${JSON.stringify(sbom, null, 2)}\n`,
});
const inspection = await inspectPluginArchive(archive);
await mkdir(outputDirectory, { recursive: true });
const output = join(outputDirectory, "opap-text-utilities-0.1.0.tgz");
await writeFile(output, archive);
console.log(`Built ${output}`);
console.log(`Archive SHA-256: ${inspection.archiveSha256}`);
console.log(`Bundle SHA-256: ${inspection.bundleSha256}`);
