import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
if (!process.env["GITHUB_SHA"] && execFileSync("git", ["status", "--porcelain", "--untracked-files=all"],
  { cwd: root, encoding: "utf8" }).trim() !== "") {
  throw new Error("Refusing to finalize a release from a dirty working tree; build provenance would not match the source archive");
}
const releaseDirectory = resolve(root, process.argv[2] ?? "apps/installer/release");
const resources = resolve(root, "apps/installer/resources");
await mkdir(releaseDirectory, { recursive: true });
for (const name of ["opap-deployment-bundle.tgz", "opap-installer.cdx.json",
  "opap-deployment-bundle.cdx.json", "release.json"]) {
  await copyFile(resolve(resources, name), resolve(releaseDirectory, name));
}
await copyFile(resolve(root, "verify.ps1"), resolve(releaseDirectory, "verify.ps1"));
await copyFile(resolve(root, "verify.sh"), resolve(releaseDirectory, "verify.sh"));
execFileSync("git", ["archive", "--format=tar.gz", `--output=${resolve(releaseDirectory, "opap-source.tar.gz")}`, "HEAD"],
  { cwd: root, stdio: "inherit" });

const files = (await readdir(releaseDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name !== "SHA256SUMS" && entry.name !== "provenance.json")
  .map((entry) => resolve(releaseDirectory, entry.name)).sort();
const artifacts = await Promise.all(files.map(async (path) => ({
  path: basename(path),
  sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
} )));
await writeFile(resolve(releaseDirectory, "SHA256SUMS"),
  `${artifacts.map((item) => `${item.sha256}  ${item.path}`).join("\n")}\n`);
const release = JSON.parse(await readFile(resolve(resources, "release.json"), "utf8")) as Record<string, unknown>;
await writeFile(resolve(releaseDirectory, "provenance.json"), `${JSON.stringify({
  apiVersion: "opap.dev/build-provenance/v1alpha1", ...release, artifacts,
}, null, 2)}\n`);
console.log(`Finalized ${artifacts.length} artifact(s) in ${basename(releaseDirectory)}.`);
