import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractDeploymentBundle } from "./archive";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

function tarEntry(name: string, content: Buffer, type = 48): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  const octal = (offset: number, length: number, value: number) => {
    header.write(value.toString(8).padStart(length - 1, "0"), offset, length - 1, "ascii");
    header[offset + length - 1] = 0;
  };
  octal(100, 8, 0o644); octal(108, 8, 0); octal(116, 8, 0); octal(124, 12, content.length);
  octal(136, 12, 0); header.fill(0x20, 148, 156); header[156] = type;
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  octal(148, 8, [...header].reduce((sum, value) => sum + value, 0));
  return Buffer.concat([header, content, Buffer.alloc((512 - content.length % 512) % 512)]);
}

async function archive(entries: Array<[string, Buffer]>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opap-archive-test-")); temporary.push(root);
  const path = join(root, "bundle.tgz");
  await writeFile(path, gzipSync(Buffer.concat([...entries.map(([name, content]) => tarEntry(name, content)), Buffer.alloc(1024)])));
  return path;
}

describe("deployment bundle extraction", () => {
  it("verifies the manifest before extracting", async () => {
    const content = Buffer.from("verified\n");
    const manifest = Buffer.from(JSON.stringify({ apiVersion: "opap.dev/deployment-bundle/v1alpha1", files: [{
      path: "apps/test.txt", size: content.length, sha256: createHash("sha256").update(content).digest("hex"),
    }] }));
    const path = await archive([["bundle-manifest.json", manifest], ["apps/test.txt", content]]);
    const destination = `${path}.out`;
    await extractDeploymentBundle(path, destination);
    await expect(readFile(join(destination, "apps/test.txt"), "utf8")).resolves.toBe("verified\n");
  });

  it("rejects archive traversal before writing", async () => {
    const manifest = Buffer.from(JSON.stringify({ apiVersion: "opap.dev/deployment-bundle/v1alpha1", files: [] }));
    const path = await archive([["bundle-manifest.json", manifest], ["../outside", Buffer.from("bad")]]);
    await expect(extractDeploymentBundle(path, `${path}.out`)).rejects.toThrow(/escapes destination/u);
  });

  it.each(["/absolute", "C:/drive", "bad\\windows"])("rejects unsafe path %s", async (name) => {
    const manifest = Buffer.from(JSON.stringify({ apiVersion: "opap.dev/deployment-bundle/v1alpha1", files: [] }));
    const path = await archive([["bundle-manifest.json", manifest], [name, Buffer.from("bad")]]);
    await expect(extractDeploymentBundle(path, `${path}.out`)).rejects.toThrow(/Unsafe bundle path/u);
  });

  it("rejects unsupported entry types", async () => {
    const root = await mkdtemp(join(tmpdir(), "opap-archive-test-")); temporary.push(root);
    const path = join(root, "bundle.tgz");
    await writeFile(path, gzipSync(Buffer.concat([tarEntry("link", Buffer.alloc(0), 50), Buffer.alloc(1024)])));
    await expect(extractDeploymentBundle(path, `${path}.out`)).rejects.toThrow(/Unsupported bundle entry type/u);
  });

  it("requires a valid manifest and matching digest", async () => {
    const missing = await archive([["file.txt", Buffer.from("data")]]);
    await expect(extractDeploymentBundle(missing, `${missing}.out`)).rejects.toThrow(/manifest is missing/u);
    const invalid = await archive([["bundle-manifest.json", Buffer.from(JSON.stringify({ apiVersion: "wrong", files: [] }))]]);
    await expect(extractDeploymentBundle(invalid, `${invalid}.out`)).rejects.toThrow(/Invalid deployment bundle manifest/u);
    const mismatchManifest = Buffer.from(JSON.stringify({ apiVersion: "opap.dev/deployment-bundle/v1alpha1", files: [{
      path: "file.txt", size: 4, sha256: "0".repeat(64),
    }] }));
    const mismatch = await archive([["bundle-manifest.json", mismatchManifest], ["file.txt", Buffer.from("data")]]);
    await expect(extractDeploymentBundle(mismatch, `${mismatch}.out`)).rejects.toThrow(/verification failed/u);
  });
});
