import { readFile, readdir } from "node:fs/promises";
import { collectSelectedServiceNames, transformWranglerConfig, validateDeploymentTarget,
  type SetupRequest, type WranglerConfig } from "../packages/setup-engine/src/index.ts";

type Profile = { extends?: string; workers: string[] };
type ValidatedTarget = ReturnType<typeof validateDeploymentTarget>;

const loadJson = async <T>(url: URL): Promise<T> =>
  JSON.parse(await readFile(url, "utf8")) as T;

const loadProfileWorkers = async (id: string): Promise<string[]> => {
  const profile = await loadJson<Profile>(new URL(`../deployments/profiles/${id}.json`, import.meta.url));
  const inherited = profile.extends ? await loadProfileWorkers(profile.extends) : [];
  return [...new Set([...inherited, ...profile.workers])];
};

const targets = new Map<string, ValidatedTarget>();
for (const file of (await readdir(new URL("../deployments/targets/", import.meta.url)))
  .filter((name) => name.endsWith(".json")).sort()) {
  const target = validateDeploymentTarget(await loadJson<unknown>(
    new URL(`../deployments/targets/${file}`, import.meta.url)));
  targets.set(target.id, target);
  let workers = await loadProfileWorkers(target.profile);
  if (!target.providers.discord) {
    workers = workers.filter((worker) => !["discord-adapter", "discord-gatekeeper"].includes(worker));
  }
  if (!target.providers.google) workers = workers.filter((worker) => worker !== "google-gatekeeper");
  if (!target.providers.github) workers = workers.filter((worker) => worker !== "github-gatekeeper");
  if (!target.providers.google && !target.providers.github) {
    workers = workers.filter((worker) => worker !== "delegated-source-gatekeeper");
  }
  if (!target.providers.dynamicPlugin) {
    workers = workers.filter((worker) => worker !== "plugin-runtime-worker");
  }
  const sourceConfigs = new Map<string, WranglerConfig>();
  for (const worker of workers) {
    sourceConfigs.set(worker, await loadJson<WranglerConfig>(
      new URL(`../apps/${worker}/wrangler.jsonc`, import.meta.url)));
  }
  const selectedNames = collectSelectedServiceNames(sourceConfigs.values());
  const request: SetupRequest = { action: "install", deploymentName: target.deploymentName,
    profile: target.profile, accountId: "validation", environment: target.environment,
    providerSelections: [], dryRun: true };
  const resolved = [...sourceConfigs.values()].map((config) =>
    transformWranglerConfig(config, request, selectedNames, target));
  const workerNames = resolved.map((config) => config.name).filter((name): name is string => Boolean(name));
  if (new Set(workerNames).size !== workerNames.length) {
    throw new Error(`Deployment target ${target.id} contains duplicate Worker names`);
  }
  console.log(`${target.id}: ${workerNames.length} explicit Worker names validated`);
}

const production = targets.get("production");
const test = targets.get("test");
if (!production || !test) throw new Error("Production and test deployment targets are required");
if (test.environment !== production.environment || test.profile !== production.profile ||
  JSON.stringify(test.providers) !== JSON.stringify(production.providers)) {
  throw new Error("The installer test target may differ from production only by identity and resource names");
}
