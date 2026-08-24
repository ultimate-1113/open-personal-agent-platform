import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

const repositoryRoot = process.cwd();
const resourcesRoot = resolve(repositoryRoot, "apps", "installer", "resources");
const destination = resolve(resourcesRoot, "node-runtime-deps");
if (!destination.startsWith(`${resourcesRoot}${sep}`)) {
  throw new Error("Installer runtime dependency destination escaped the resources directory");
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const installerManifest = JSON.parse(await readFile(join(repositoryRoot, "apps", "installer", "package.json"), "utf8")) as {
  dependencies?: { wrangler?: unknown };
};
const repositoryManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
  packageManager?: unknown;
};
const declaredWrangler = installerManifest.dependencies?.wrangler;
if (typeof declaredWrangler !== "string" || !/^\^?\d+\.\d+\.\d+$/u.test(declaredWrangler)) {
  throw new Error("The installer must declare a fixed-compatible Wrangler version");
}
const wranglerVersion = declaredWrangler.replace(/^\^/u, "");
if (typeof repositoryManifest.packageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/u.test(repositoryManifest.packageManager)) {
  throw new Error("The repository must pin an exact pnpm packageManager version");
}
await writeFile(join(destination, "package.json"), `${JSON.stringify({
  name: "opap-installer-runtime",
  private: true,
  version: "0.0.0",
  dependencies: { wrangler: wranglerVersion },
}, null, 2)}\n`, { encoding: "utf8", flag: "wx" });

const executable = process.platform === "win32" ? process.env["ComSpec"] ?? "cmd.exe" : "corepack";
const packageManagerPrefix = process.platform === "win32" ? ["/d", "/s", "/c", "corepack.cmd"] : [];
const result = spawnSync(executable, [...packageManagerPrefix, repositoryManifest.packageManager, "install", "--dir", destination, "--prod", "--ignore-workspace",
  "--ignore-scripts", "--lockfile=false", "--config.package-import-method=copy", "--config.node-linker=hoisted"], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});
if (result.status !== 0) {
  throw new Error(`Failed to stage installer runtime dependencies (${result.status ?? result.error?.message ?? "unknown"})`);
}

const wranglerCli = join(destination, "node_modules", "wrangler", "wrangler-dist", "cli.js");
const loginSmokeTest = spawnSync(process.execPath, [wranglerCli, "login", "--help"], {
  cwd: destination,
  stdio: "inherit",
  env: { ...process.env, CI: "true" },
});
if (loginSmokeTest.status !== 0) {
  throw new Error(`Staged Wrangler cannot load the login path (${loginSmokeTest.error?.message ?? loginSmokeTest.signal ?? loginSmokeTest.status ?? "unknown"})`);
}
console.log(`Staged installer runtime dependencies. Wrangler entry: ${wranglerCli}`);
