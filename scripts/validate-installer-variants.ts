import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";

type BuilderConfig = Record<string, unknown> & { appId?: unknown; productName?: unknown;
  directories?: { output?: unknown }; extraMetadata?: Record<string, unknown> };
type InstallerPackage = { opapInstallerTarget?: unknown; build?: BuilderConfig };

const packageValue = JSON.parse(await readFile(
  new URL("../apps/installer/package.json", import.meta.url), "utf8")) as InstallerPackage;
const testValue = JSON.parse(await readFile(
  new URL("../apps/installer/electron-builder.test.json", import.meta.url), "utf8")) as BuilderConfig;
const production = packageValue.build;
if (!production) throw new Error("Production installer build configuration is missing");
if (packageValue.opapInstallerTarget !== "production" || testValue.extraMetadata?.["opapInstallerTarget"] !== "test") {
  throw new Error("Installer variants must reference explicit production and test targets");
}
if (production.appId === testValue.appId || production.productName === testValue.productName ||
  production.directories?.output === testValue.directories?.output) {
  throw new Error("Test installer identity and output directory must differ from production");
}
const common = (value: BuilderConfig): Record<string, unknown> => {
  const copy = structuredClone(value);
  delete copy.appId; delete copy.productName; delete copy.extraMetadata;
  if (copy.directories) delete copy.directories.output;
  return copy;
};
if (!isDeepStrictEqual(common(production), common(testValue))) {
  throw new Error("Installer variants differ in behavior beyond identity, output, and target");
}
console.log("Installer variants share one behavior configuration and use separate identities and targets");
