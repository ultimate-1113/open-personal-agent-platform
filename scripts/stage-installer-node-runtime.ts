import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const output = join(process.cwd(), "apps", "installer", "resources", "node-runtime");
await mkdir(output, { recursive: true });
const binaryName = process.platform === "win32" ? "node.exe" : "node";
await copyFile(process.execPath, join(output, binaryName));
await writeFile(join(output, "runtime.json"), `${JSON.stringify({
  version: process.version,
  platform: process.platform,
  architecture: process.arch,
  sourceBinary: basename(process.execPath),
}, null, 2)}\n`, "utf8");
console.log(`Staged ${process.version} for ${process.platform}-${process.arch}.`);
