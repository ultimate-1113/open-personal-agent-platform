import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const sumsPath = resolve(process.argv[2] ?? "apps/installer/resources/SHA256SUMS");
const lines = (await readFile(sumsPath, "utf8")).trim().split(/\r?\n/u);
for (const line of lines) {
  const match = /^(?<digest>[a-f0-9]{64})\s{2}(?<name>[^/\\]+)$/u.exec(line);
  if (!match?.groups) throw new Error(`Invalid checksum line: ${line}`);
  const path = resolve(dirname(sumsPath), basename(match.groups["name"]!));
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  if (actual !== match.groups["digest"]) throw new Error(`Checksum mismatch: ${match.groups["name"]}`);
  console.log(`verified ${match.groups["name"]}`);
}
