import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_ARCHIVE_FILES,
  PluginRegistry,
  inspectPluginArchive,
  readPluginArchive,
  validateArchiveEntries,
} from "./index.js";

const encoder = new TextEncoder();

const tarGzip = async (files: Readonly<Record<string, Uint8Array | string>>): Promise<Uint8Array> => {
  const blocks: Uint8Array[] = [];
  const write = (target: Uint8Array, offset: number, value: string, length: number): void => {
    target.set(encoder.encode(value).subarray(0, length), offset);
  };
  for (const [path, raw] of Object.entries(files)) {
    const content = typeof raw === "string" ? encoder.encode(raw) : raw;
    const header = new Uint8Array(512);
    write(header, 0, path, 100);
    write(header, 100, "0000644\0", 8);
    write(header, 108, "0000000\0", 8);
    write(header, 116, "0000000\0", 8);
    write(header, 124, `${content.byteLength.toString(8).padStart(11, "0")}\0`, 12);
    write(header, 136, "00000000000\0", 12);
    write(header, 148, "        ", 8);
    header[156] = "0".charCodeAt(0);
    write(header, 257, "ustar\0", 6);
    write(header, 263, "00", 2);
    const checksum = header.reduce((total, value) => total + value, 0);
    write(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
    blocks.push(header, content, new Uint8Array((512 - (content.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const size = blocks.reduce((total, block) => total + block.byteLength, 0);
  const tar = new Uint8Array(size);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  const compressed = new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(compressed).arrayBuffer());
};

const sha256 = async (value: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", value as BufferSource))]
    .map((part) => part.toString(16).padStart(2, "0")).join("");

const manifest = (id: string, toolId: string) => ({
  apiVersion: "opap.dev/v1alpha1" as const,
  kind: "Plugin" as const,
  id,
  version: "0.1.0",
  platformVersion: ">=0.1.0-alpha.0",
  runtime: { kind: "sandbox-esm" as const, entrypoint: "dist/index.mjs" },
  tools: [
    {
      id: toolId,
      description: "Fixture tool",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
    },
  ],
  requestedCapabilityIds: [],
  limits: { timeoutMs: 30_000, outputBytes: 1_048_576, concurrency: 2 },
  artifact: {
    sha256: "0".repeat(64),
    sbomPath: "sbom.cdx.json",
  },
});

describe("plugin archives", () => {
  it("rejects traversal and absolute paths", () => {
    expect(() => validateArchiveEntries(["../secret"])).toThrow("Unsafe");
    expect(() => validateArchiveEntries(["C:\\secret"])).toThrow("Unsafe");
    expect(() => validateArchiveEntries(["/etc/passwd"])).toThrow("Unsafe");
  });

  it("accepts normal paths and rejects oversized archives", () => {
    expect(() => validateArchiveEntries(["dist/index.mjs", "sbom.cdx.json"])).not.toThrow();
    expect(() =>
      validateArchiveEntries(
        Array.from({ length: MAX_PLUGIN_ARCHIVE_FILES + 1 }, (_, index) => `file-${index}`),
      ),
    ).toThrow("too many");
  });

  it("inspects a valid ESM plugin and records separate bundle and archive digests", async () => {
    const bundle = encoder.encode("export default { invoke: async () => ({ ok: true }) };\n");
    const value = manifest("plugin:fixture", "fixture.echo");
    value.artifact.sha256 = await sha256(bundle);
    const archive = await tarGzip({
      "plugin.json": JSON.stringify(value),
      "dist/index.mjs": bundle,
      "sbom.cdx.json": JSON.stringify({ bomFormat: "CycloneDX", specVersion: "1.6" }),
    });
    const inspection = await inspectPluginArchive(archive);
    expect(inspection.bundleSha256).toBe(value.artifact.sha256);
    expect(inspection.archiveSha256).not.toBe(inspection.bundleSha256);
    expect(inspection.sbomVersion).toBe("1.6");
  });

  it("rejects archive links, duplicate paths and install scripts", async () => {
    const archive = await tarGzip({
      "plugin.json": "{}",
      "package.json": JSON.stringify({ scripts: { postinstall: "node setup.js" } }),
    });
    await expect(inspectPluginArchive(archive)).rejects.toThrow();

    const regular = await tarGzip({ "safe.txt": "ok" });
    const bytes = new Uint8Array(await new Response(
      new Blob([regular as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer());
    bytes[156] = "2".charCodeAt(0);
    const linked = new Uint8Array(await new Response(
      new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer());
    await expect(readPluginArchive(linked)).rejects.toThrow("Unsupported");
  });

  it("rejects empty archives and missing or invalid manifests", async () => {
    await expect(readPluginArchive(new Uint8Array())).rejects.toThrow("compressed size");
    await expect(inspectPluginArchive(await tarGzip({ "readme.txt": "none" })))
      .rejects.toThrow("plugin.json is missing");
    await expect(inspectPluginArchive(await tarGzip({ "plugin.json": "{" })))
      .rejects.toThrow("not valid JSON");
  });

  it("rejects a non-sandbox upload and mismatched ESM digest", async () => {
    const staticValue = { ...manifest("plugin:static", "fixture.static"),
      runtime: { kind: "static", package: "fixture" } };
    await expect(inspectPluginArchive(await tarGzip({ "plugin.json": JSON.stringify(staticValue) })))
      .rejects.toThrow("sandbox-esm");
    const mismatched = manifest("plugin:mismatch", "fixture.mismatch");
    await expect(inspectPluginArchive(await tarGzip({
      "plugin.json": JSON.stringify(mismatched),
      "dist/index.mjs": "export const invoke = () => null;",
    }))).rejects.toThrow("digest");
  });
});

describe("PluginRegistry", () => {
  it("rejects tool ID collisions", () => {
    const registry = new PluginRegistry();
    registry.register(manifest("plugin:first", "tool:shared"));
    expect(() =>
      registry.register(manifest("plugin:second", "tool:shared")),
    ).toThrow("collision");
  });

  it("lists manifests and rejects an identical version", () => {
    const registry = new PluginRegistry();
    const second = registry.register(manifest("plugin:z", "tool:z"));
    registry.register(manifest("plugin:a", "tool:a"));
    expect(registry.get("plugin:z")).toEqual(second);
    expect(registry.get("plugin:missing")).toBeUndefined();
    expect(registry.list().map((item) => item.id)).toEqual(["plugin:a", "plugin:z"]);
    expect(() => registry.register(second)).toThrow("already registered");
  });
});
