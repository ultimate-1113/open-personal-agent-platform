import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const resources = resolve(root, "apps/installer/resources");
const digest = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
const workspacePackages = (await Promise.all(["apps", "packages", "examples", "plugins"].map(async (directory) => {
  const first = await readdir(resolve(root, directory), { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of first.filter((item) => item.isDirectory())) {
    const direct = resolve(root, directory, entry.name, "package.json");
    try { await readFile(direct); paths.push(direct); } catch { /* nested plugin */ }
    const second = await readdir(resolve(root, directory, entry.name), { withFileTypes: true }).catch(() => []);
    for (const nested of second.filter((item) => item.isDirectory())) {
      const path = resolve(root, directory, entry.name, nested.name, "package.json");
      try { await readFile(path); paths.push(path); } catch { /* not a package */ }
    }
  }
  return paths;
}))).flat();
const components = await Promise.all(workspacePackages.sort().map(async (path) => {
  const value = JSON.parse(await readFile(path, "utf8")) as { name: string; version: string };
  return { type: "application", name: value.name, version: value.version, purl: `pkg:npm/${value.name.replace("/", "%2F")}@${value.version}` };
}));
const sbom = { bomFormat: "CycloneDX", specVersion: "1.6", serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
  version: 1, metadata: { component: { type: "application", name: "opap-installer", version: "0.1.0-beta.1" } }, components };
await mkdir(resources, { recursive: true });
const sbomPath = resolve(resources, "opap-installer.cdx.json");
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
const bundlePath = resolve(resources, "opap-deployment-bundle.tgz");
const clean = process.env["GITHUB_SHA"] !== undefined || execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
  { cwd: root, encoding: "utf8" }).trim() === "";
const commit = process.env["GITHUB_SHA"] ?? (clean
  ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  : "local-working-tree");
const metadata = { apiVersion: "opap.dev/installer-release/v1alpha1", version: "0.1.0-beta.1", commit,
  ...(clean ? { sourceUrl: `https://github.com/ultimate-1113/open-personal-agent-platform/tree/${commit}` } : {}),
  workflowUrl: process.env["GITHUB_SERVER_URL"] && process.env["GITHUB_REPOSITORY"] && process.env["GITHUB_RUN_ID"]
    ? `${process.env["GITHUB_SERVER_URL"]}/${process.env["GITHUB_REPOSITORY"]}/actions/runs/${process.env["GITHUB_RUN_ID"]}` : "local-build",
  lockSha256: await digest(resolve(root, "pnpm-lock.yaml")), bundleSha256: await digest(bundlePath), sbomSha256: await digest(sbomPath) };
const deploymentSbom = { bomFormat: "CycloneDX", specVersion: "1.6",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000002", version: 1,
  metadata: { component: { type: "application", name: "opap-deployment-bundle", version: metadata.version,
    hashes: [{ alg: "SHA-256", content: metadata.bundleSha256 }] } }, components };
await writeFile(resolve(resources, "opap-deployment-bundle.cdx.json"), `${JSON.stringify(deploymentSbom, null, 2)}\n`);
await writeFile(resolve(resources, "release.json"), `${JSON.stringify(metadata, null, 2)}\n`);
const sums = [`${metadata.bundleSha256}  opap-deployment-bundle.tgz`, `${metadata.sbomSha256}  opap-installer.cdx.json`];
await writeFile(resolve(resources, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`Generated installer metadata for ${commit}.`);
