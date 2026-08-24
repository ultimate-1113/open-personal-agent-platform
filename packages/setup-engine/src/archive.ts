import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

type BundleManifest = { apiVersion: "opap.dev/deployment-bundle/v1alpha1";
  files: Array<{ path: string; sha256: string; size: number }> };

function safeTarget(root: string, name: string): string {
  if (!name || name.includes("\\") || name.startsWith("/") || /^[a-z]:/iu.test(name)) {
    throw new Error(`Unsafe bundle path: ${name}`);
  }
  const target = resolve(root, name);
  const nested = relative(resolve(root), target);
  if (nested === ".." || nested.startsWith(`..${sep}`)) throw new Error(`Bundle path escapes destination: ${name}`);
  return target;
}

export async function extractDeploymentBundle(archivePath: string, destination: string): Promise<BundleManifest> {
  const compressed = await readFile(archivePath);
  if (compressed.length > 64 * 1024 * 1024) throw new Error("Deployment bundle is too large");
  const tar = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  const extracted = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/u, "");
    const type = String.fromCharCode(header[156] ?? 0);
    if (type !== "0" && type !== "\0") throw new Error(`Unsupported bundle entry type: ${type}`);
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > 64 * 1024 * 1024) throw new Error("Invalid bundle entry size");
    const contentStart = offset + 512;
    const content = Buffer.from(tar.subarray(contentStart, contentStart + size));
    if (extracted.size >= 2_000) throw new Error("Deployment bundle has too many entries");
    safeTarget(destination, name);
    extracted.set(name, content);
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  const rawManifest = extracted.get("bundle-manifest.json");
  if (!rawManifest) throw new Error("Deployment bundle manifest is missing");
  const manifest = JSON.parse(rawManifest.toString("utf8")) as BundleManifest;
  if (manifest.apiVersion !== "opap.dev/deployment-bundle/v1alpha1" || !Array.isArray(manifest.files)) {
    throw new Error("Invalid deployment bundle manifest");
  }
  for (const item of manifest.files) {
    const content = extracted.get(item.path);
    if (!content || content.length !== item.size
      || createHash("sha256").update(content).digest("hex") !== item.sha256) {
      throw new Error(`Deployment bundle verification failed: ${item.path}`);
    }
  }
  await mkdir(destination, { recursive: true });
  for (const item of manifest.files) {
    const target = safeTarget(destination, item.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, extracted.get(item.path)!);
  }
  return manifest;
}
