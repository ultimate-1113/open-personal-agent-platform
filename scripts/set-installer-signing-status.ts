import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const platform = process.argv[2];
const status = process.argv[3];
if (!platform || !["windows", "linux", "macos"].includes(platform)
  || !status || !["signed", "unsigned"].includes(status)) {
  throw new Error("Usage: set-installer-signing-status <windows|linux|macos> <signed|unsigned>");
}
const path = resolve(import.meta.dirname, "../apps/installer/resources/release.json");
const release = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
release["codeSigning"] = { platform, signed: status === "signed",
  notarized: platform === "macos" && status === "signed" };
await writeFile(path, `${JSON.stringify(release, null, 2)}\n`, "utf8");
