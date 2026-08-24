import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "apps/installer/resources/opap-deployment-bundle.tgz");
const includeRoots = ["migrations", "deployments/profiles", "deployments/targets", "packages/plugin-sdk/static-plugin-registry.json",
  "scripts/opap-setup.ts", "packages/setup-engine/src/index.ts", "packages/secret-vault/src/index.ts",
  "packages/secret-vault/node_modules/hash-wasm",
  "apps/owner-ui/dist", ...["assistant-worker", "audit-ledger-worker", "conversation-agent",
    "delegated-agent-api", "delegated-source-gatekeeper", "discord-adapter", "discord-gatekeeper",
    "github-gatekeeper", "google-gatekeeper", "maintenance-worker", "policy-control-worker",
    "public-agent-api", "quota-worker"].flatMap((name) => [
      `apps/${name}/dist`, `apps/${name}/wrangler.jsonc`, `apps/${name}/package.json`,
    ])];

async function filesAt(path: string): Promise<string[]> {
  const absolute = resolve(root, path);
  const info = await stat(absolute).catch(() => undefined);
  if (!info) return [];
  if (info.isFile()) return [absolute];
  const entries = await readdir(absolute, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesAt(relative(root, resolve(absolute, entry.name)))));
  return nested.flat();
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function tarEntry(name: string, content: Buffer): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`Deployment bundle path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name.replaceAll("\\", "/"), 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644); writeOctal(header, 108, 8, 0); writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, content.length); writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  writeOctal(header, 148, 8, [...header].reduce((sum, value) => sum + value, 0));
  const padding = Buffer.alloc((512 - content.length % 512) % 512);
  return Buffer.concat([header, content, padding]);
}

const files = (await Promise.all(includeRoots.map(filesAt))).flat().sort((a, b) => a.localeCompare(b));
const entries: Buffer[] = [];
const manifest: Array<{ path: string; sha256: string; size: number }> = [];
for (const file of files) {
  const content = await readFile(file);
  const path = relative(root, file).replaceAll("\\", "/");
  manifest.push({ path, sha256: createHash("sha256").update(content).digest("hex"), size: content.length });
  entries.push(tarEntry(path, content));
}
const manifestContent = Buffer.from(`${JSON.stringify({ apiVersion: "opap.dev/deployment-bundle/v1alpha1", files: manifest }, null, 2)}\n`);
entries.unshift(tarEntry("bundle-manifest.json", manifestContent));
entries.push(Buffer.alloc(1024));
await mkdir(dirname(output), { recursive: true });
await writeFile(output, gzipSync(Buffer.concat(entries), { level: 9 }));
console.log(`Built ${relative(root, output)} with ${files.length} files.`);
