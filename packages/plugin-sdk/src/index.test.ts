import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_ARCHIVE_FILES,
  PluginRegistry,
  validateArchiveEntries,
} from "./index.js";

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
