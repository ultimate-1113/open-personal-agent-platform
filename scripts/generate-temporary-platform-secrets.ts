import { execFileSync } from "node:child_process";
import { chmod, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generatePlatformSecrets } from "../packages/secret-vault/src/index.ts";

const output = process.argv[2];
if (!output) throw new Error("An explicit temporary output path is required");
const path = resolve(output);
try {
  await writeFile(path, `${JSON.stringify(generatePlatformSecrets())}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(path, 0o600).catch(() => undefined);
  if (process.platform === "win32") {
    const user = process.env["USERNAME"];
    const domain = process.env["USERDOMAIN"];
    if (!user || /[\r\n]/u.test(user) || (domain && /[\r\n]/u.test(domain))) {
      throw new Error("Current Windows user is unavailable");
    }
    const identity = domain ? `${domain}\\${user}` : user;
    execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(R,W)`],
      { stdio: "ignore", windowsHide: true });
  }
} catch (error) {
  await rm(path, { force: true });
  throw error;
}
