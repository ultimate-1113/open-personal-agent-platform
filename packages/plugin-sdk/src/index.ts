import {
  pluginManifestSchema,
  type PluginManifest,
} from "@opap/contracts";

export const MAX_PLUGIN_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_FILES = 64;

export function parsePluginManifest(value: unknown): PluginManifest {
  return pluginManifestSchema.parse(value);
}

export function validateArchiveEntries(entries: readonly string[]): void {
  if (entries.length > MAX_PLUGIN_ARCHIVE_FILES) {
    throw new Error("Plugin archive contains too many files");
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:\//u.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Unsafe plugin archive path: ${entry}`);
    }
  }
}

export class PluginRegistry {
  readonly #plugins = new Map<string, PluginManifest>();
  readonly #toolOwners = new Map<string, string>();

  register(manifestInput: unknown): PluginManifest {
    const manifest = parsePluginManifest(manifestInput);
    const existing = this.#plugins.get(manifest.id);
    if (existing && existing.version === manifest.version) {
      throw new Error(`Plugin already registered: ${manifest.id}@${manifest.version}`);
    }
    for (const tool of manifest.tools) {
      const owner = this.#toolOwners.get(tool.id);
      if (owner && owner !== manifest.id) {
        throw new Error(`Tool ID collision: ${tool.id} is owned by ${owner}`);
      }
    }
    this.#plugins.set(manifest.id, manifest);
    for (const tool of manifest.tools) this.#toolOwners.set(tool.id, manifest.id);
    return manifest;
  }

  get(pluginId: string): PluginManifest | undefined {
    return this.#plugins.get(pluginId);
  }

  list(): readonly PluginManifest[] {
    return [...this.#plugins.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
}
