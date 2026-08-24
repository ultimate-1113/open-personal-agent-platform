import {
  pluginManifestSchema,
  type PluginManifest,
} from "@opap/contracts";

export const MAX_PLUGIN_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_FILES = 64;
export const MAX_PLUGIN_EXPANDED_BYTES = 32 * 1024 * 1024;

export type PluginArchiveEntryKind = "file" | "directory";

export type PluginArchiveEntry = {
  path: string;
  kind: PluginArchiveEntryKind;
  size: number;
  content: Uint8Array;
};

export type PluginInspection = {
  manifest: PluginManifest;
  archiveSha256: string;
  bundleSha256: string;
  expandedBytes: number;
  entryCount: number;
  sbomVersion: "1.5" | "1.6";
};

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

const normalizeArchivePath = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized.length === 0 || normalized.includes("\0") || normalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(normalized) || normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`Unsafe plugin archive path: ${value}`);
  }
  return normalized;
};

const sha256 = async (value: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", value as BufferSource);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
};

const decodeTarString = (block: Uint8Array): string => {
  const end = block.indexOf(0);
  return new TextDecoder().decode(end === -1 ? block : block.subarray(0, end)).trim();
};

const parseTarNumber = (block: Uint8Array): number => {
  const raw = decodeTarString(block).replaceAll("\u0000", "").trim();
  if (raw.length === 0) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid TAR numeric field");
  return value;
};

const concatChunks = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

async function gunzip(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("Gzip decompression is unavailable in this runtime");
  }
  const stream = new Blob([input as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PLUGIN_EXPANDED_BYTES + MAX_PLUGIN_ARCHIVE_FILES * 512) {
      await reader.cancel();
      throw new Error("Plugin archive expands beyond the allowed size");
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

export async function readPluginArchive(input: Uint8Array): Promise<readonly PluginArchiveEntry[]> {
  if (input.byteLength === 0 || input.byteLength > MAX_PLUGIN_ARCHIVE_BYTES) {
    throw new Error("Plugin archive exceeds the compressed size limit");
  }
  const tar = await gunzip(input);
  const entries: PluginArchiveEntry[] = [];
  const paths = new Set<string>();
  let expandedBytes = 0;
  for (let offset = 0; offset + 512 <= tar.byteLength;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = decodeTarString(header.subarray(0, 100));
    const prefix = decodeTarString(header.subarray(345, 500));
    const path = normalizeArchivePath(prefix ? `${prefix}/${name}` : name);
    const size = parseTarNumber(header.subarray(124, 136));
    const typeFlag = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.byteLength) throw new Error("Plugin archive is truncated");
    if (paths.has(path)) throw new Error(`Duplicate plugin archive path: ${path}`);
    paths.add(path);
    if (entries.length >= MAX_PLUGIN_ARCHIVE_FILES) {
      throw new Error("Plugin archive contains too many files");
    }
    if (["1", "2", "3", "4", "6"].includes(typeFlag)) {
      throw new Error(`Unsupported plugin archive entry type at ${path}`);
    }
    if (typeFlag !== "\0" && typeFlag !== "0" && typeFlag !== "5") {
      throw new Error(`Unsupported TAR extension at ${path}`);
    }
    const kind: PluginArchiveEntryKind = typeFlag === "5" ? "directory" : "file";
    if (kind === "file") {
      expandedBytes += size;
      if (expandedBytes > MAX_PLUGIN_EXPANDED_BYTES) {
        throw new Error("Plugin archive expands beyond the allowed size");
      }
      if (path.toLowerCase().endsWith(".node")) {
        throw new Error(`Native addon is not allowed: ${path}`);
      }
    }
    entries.push({ path, kind, size, content: tar.slice(dataStart, dataEnd) });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

const parseJsonEntry = (entry: PluginArchiveEntry | undefined, label: string): unknown => {
  if (!entry || entry.kind !== "file") throw new Error(`${label} is missing from plugin archive`);
  try {
    return JSON.parse(new TextDecoder().decode(entry.content)) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
};

export async function inspectPluginArchive(input: Uint8Array): Promise<PluginInspection> {
  const entries = await readPluginArchive(input);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const manifest = parsePluginManifest(parseJsonEntry(byPath.get("plugin.json"), "plugin.json"));
  if (manifest.runtime.kind !== "sandbox-esm") {
    throw new Error("Uploaded plugins must use the sandbox-esm runtime");
  }
  const bundle = byPath.get(normalizeArchivePath(manifest.runtime.entrypoint));
  if (!bundle || bundle.kind !== "file") throw new Error("Plugin ESM entrypoint is missing");
  const bundleSha256 = await sha256(bundle.content);
  if (bundleSha256 !== manifest.artifact.sha256) {
    throw new Error("Plugin ESM digest does not match the manifest");
  }
  const sbom = parseJsonEntry(
    byPath.get(normalizeArchivePath(manifest.artifact.sbomPath)),
    "CycloneDX SBOM",
  );
  const sbomVersion = typeof sbom === "object" && sbom !== null
    ? (sbom as Record<string, unknown>)["specVersion"]
    : undefined;
  if (sbomVersion !== "1.5" && sbomVersion !== "1.6") {
    throw new Error("CycloneDX SBOM must use version 1.5 or 1.6");
  }
  const packageJson = byPath.get("package.json");
  if (packageJson) {
    const packageValue = parseJsonEntry(packageJson, "package.json");
    if (typeof packageValue !== "object" || packageValue === null) {
      throw new Error("package.json must be an object");
    }
    const scripts = (packageValue as Record<string, unknown>)["scripts"];
    if (typeof scripts === "object" && scripts !== null &&
      ["preinstall", "install", "postinstall"].some((name) => name in scripts)) {
      throw new Error("Plugin install scripts are not allowed");
    }
  }
  return {
    manifest,
    archiveSha256: await sha256(input),
    bundleSha256,
    expandedBytes: entries.reduce((total, entry) => total + entry.size, 0),
    entryCount: entries.length,
    sbomVersion,
  };
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
