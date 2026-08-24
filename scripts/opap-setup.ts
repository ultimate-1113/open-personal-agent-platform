import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadEnvFile, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { collectSelectedServiceNames, isAlreadyAbsentCloudflareError, transformWranglerConfig, validateDeploymentName, type SetupRequest,
  validateOwnerBootstrapConfiguration, type InstallationLedger, type ManagedResource,
  validateDeploymentTarget, type WranglerConfig
  } from "../packages/setup-engine/src/index.ts";
import { decryptSecrets, encryptSecrets, generatePlatformSecrets, type EncryptedSecretFile
  } from "../packages/secret-vault/src/index.ts";

for (const file of [".env", ".dev.vars"]) {
  try { loadEnvFile(file); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

type Profile = { id: string; extends?: string; stability: string; workers: string[]; features: string[] };
const restrictTemporarySecretFile = (path: string): void => {
  if (process.platform !== "win32") return;
  const user = process.env["USERNAME"];
  const domain = process.env["USERDOMAIN"];
  if (!user || /[\r\n]/u.test(user) || (domain && /[\r\n]/u.test(domain))) throw new Error("Current Windows user is unavailable");
  const identity = domain ? `${domain}\\${user}` : user;
  const result = spawnSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(R,W)`],
    { stdio: "ignore", windowsHide: true });
  if (result.status !== 0) throw new Error("Failed to restrict temporary secret file permissions");
};
const profileIds = ["local-dev", "minimal", "cloud-base", "cloud-base-dynamic"] as const;
const args = new Set(process.argv.slice(2));
const action = args.has("remove") ? "remove" : args.has("doctor") ? "doctor" : args.has("repair") ? "repair"
  : args.has("update") ? "update" : args.has("setup") ? "setup" : undefined;
const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
if (!action) {
  console.log("Usage: pnpm opap <setup|update|repair|doctor|remove> [--target test|staging|production] [--name opap] [--profile cloud-base] [--apply]");
  process.exitCode = 1;
} else {
  const targetId = valueAfter("--target");
  if (targetId && !["test", "staging", "production"].includes(targetId)) {
    throw new Error("Target must be test, staging, or production");
  }
  const target = targetId ? validateDeploymentTarget(JSON.parse(await readFile(
    new URL(`../deployments/targets/${targetId}.json`, import.meta.url), "utf8")) as unknown) : undefined;
  if (target && (valueAfter("--name") || valueAfter("--profile") ||
    process.env["OPAP_INSTALLATION_NAME"] || process.env["OPAP_ENVIRONMENT"])) {
    throw new Error("A named deployment target is authoritative; do not override its name, profile, or environment");
  }
  const requested = valueAfter("--profile") ?? target?.profile;
  const terminal = createInterface({ input: stdin, output: stdout });
  const selected = profileIds.includes(requested as typeof profileIds[number])
    ? requested
    : await terminal.question(`Profile (${profileIds.join(" / ")}) [cloud-base]: `) || "cloud-base";
  if (!profileIds.includes(selected as typeof profileIds[number])) throw new Error(`Unknown profile: ${selected}`);
  terminal.close();
  const load = async (id: string): Promise<Profile> => JSON.parse(
    await readFile(new URL(`../deployments/profiles/${id}.json`, import.meta.url), "utf8"),
  ) as Profile;
  const profile = await load(selected!);
  const inherited = profile.extends ? await load(profile.extends) : undefined;
  let workers = [...new Set([...(inherited?.workers ?? []), ...profile.workers])];
  const deploymentName = validateDeploymentName(valueAfter("--name")
    ?? process.env["OPAP_INSTALLATION_NAME"] ?? target?.deploymentName ?? "opap");
  const bundleRoot = process.env["OPAP_BUNDLE_ROOT"];
  const bundledWrangler = process.env["OPAP_WRANGLER_CLI"];
  const bundledWranglerArguments = (commandArgs: readonly string[]): string[] => {
    if (!bundledWrangler) throw new Error("Bundled Wrangler is unavailable");
    return [bundledWrangler, ...commandArgs];
  };
  if (target) {
    const targetProviderEnabled = (name: "DISCORD" | "GOOGLE" | "GITHUB", fallback: boolean): boolean => {
      const configured = process.env[`OPAP_ENABLE_${name}`];
      return configured === undefined ? fallback : configured === "1";
    };
    const discordEnabled = targetProviderEnabled("DISCORD", target.providers.discord);
    const googleEnabled = targetProviderEnabled("GOOGLE", target.providers.google);
    const githubEnabled = targetProviderEnabled("GITHUB", target.providers.github);
    if (!discordEnabled) {
      workers = workers.filter((worker) => !["discord-adapter", "discord-gatekeeper"].includes(worker));
    }
    if (!googleEnabled) workers = workers.filter((worker) => worker !== "google-gatekeeper");
    if (!githubEnabled) workers = workers.filter((worker) => worker !== "github-gatekeeper");
    if (!googleEnabled && !githubEnabled) {
      workers = workers.filter((worker) => worker !== "delegated-source-gatekeeper");
    }
    if (!target.providers.dynamicPlugin) {
      workers = workers.filter((worker) => worker !== "plugin-runtime-worker");
    }
  } else if (bundleRoot || process.env["OPAP_ENABLE_DISCORD"] !== undefined
    || process.env["OPAP_ENABLE_GOOGLE"] !== undefined || process.env["OPAP_ENABLE_GITHUB"] !== undefined) {
    if (process.env["OPAP_ENABLE_DISCORD"] !== "1") {
      workers = workers.filter((worker) => !["discord-adapter", "discord-gatekeeper"].includes(worker));
    }
    if (process.env["OPAP_ENABLE_GOOGLE"] !== "1") workers = workers.filter((worker) => worker !== "google-gatekeeper");
    if (process.env["OPAP_ENABLE_GITHUB"] !== "1") workers = workers.filter((worker) => worker !== "github-gatekeeper");
    if (process.env["OPAP_ENABLE_GOOGLE"] !== "1" && process.env["OPAP_ENABLE_GITHUB"] !== "1") {
      workers = workers.filter((worker) => worker !== "delegated-source-gatekeeper");
    }
  }
  if (process.platform === "win32" && workers.includes("plugin-runtime-worker")
    && !process.env["WRANGLER_DOCKER_BIN"]) {
    const dockerDesktopCli = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    if (await access(dockerDesktopCli).then(() => true).catch(() => false)) {
      process.env["WRANGLER_DOCKER_BIN"] = dockerDesktopCli;
    }
  }
  console.log(`\nOPAP ${profile.id} (${profile.stability}); deployment: ${deploymentName}`);
  console.log(`Workers: ${workers.join(", ")}`);
  const enabledFeatures = [...(inherited?.features ?? []), ...profile.features]
    .filter((feature) => feature !== "discord-interactions" || workers.includes("discord-adapter"))
    .filter((feature) => !["dynamic-plugins", "sandbox-preview"].includes(feature)
      || workers.includes("plugin-runtime-worker"));
  console.log(`Features: ${enabledFeatures.join(", ")}`);
  console.log("\nPreflight");
  const run = (command: string, commandArgs: readonly string[], input?: string) => {
    const stdio = input === undefined ? "inherit" as const
      : ["pipe", "inherit", "inherit"] as ["pipe", "inherit", "inherit"];
    const wranglerIndex = commandArgs.indexOf("wrangler");
    if (bundleRoot && bundledWrangler && command === "corepack" && wranglerIndex >= 0) {
      const filterIndex = commandArgs.indexOf("--filter");
      const packageName = filterIndex >= 0 ? commandArgs[filterIndex + 1]?.replace(/^@opap\//u, "") : undefined;
      return spawnSync(process.execPath, bundledWranglerArguments(commandArgs.slice(wranglerIndex + 1)), {
        cwd: packageName ? join(bundleRoot, "apps", packageName) : bundleRoot, stdio, input,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
    if (command === "node") return spawnSync(process.execPath, commandArgs, { stdio, input });
    const executable = process.platform === "win32" && command === "corepack" ? process.execPath : command;
    const actualArgs = process.platform === "win32" && command === "corepack"
      ? [join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"), ...commandArgs]
      : commandArgs;
    return spawnSync(executable, actualArgs, { stdio, input });
  };
  const capture = (command: string, commandArgs: readonly string[]): string => {
    const options = { encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const wranglerIndex = commandArgs.indexOf("wrangler");
    if (bundleRoot && bundledWrangler && command === "corepack" && wranglerIndex >= 0) {
      const filterIndex = commandArgs.indexOf("--filter");
      const packageName = filterIndex >= 0 ? commandArgs[filterIndex + 1]?.replace(/^@opap\//u, "") : undefined;
      const result = spawnSync(process.execPath,
        bundledWranglerArguments(commandArgs.slice(wranglerIndex + 1)), {
          ...options, cwd: packageName ? join(bundleRoot, "apps", packageName) : bundleRoot,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        });
      if (result.status !== 0) throw new Error(result.stderr || "Wrangler failed");
      return result.stdout;
    }
    const executable = process.platform === "win32" && command === "corepack" ? process.execPath : command;
    const actualArgs = process.platform === "win32" && command === "corepack"
      ? [join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"), ...commandArgs]
      : commandArgs;
    const result = spawnSync(executable, actualArgs, options);
    if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
    return result.stdout;
  };
  const succeeds = (command: string, commandArgs: readonly string[]): boolean => {
    const options = { stdio: "ignore" as const };
    const wranglerIndex = commandArgs.indexOf("wrangler");
    if (bundleRoot && bundledWrangler && command === "corepack" && wranglerIndex >= 0) {
      const filterIndex = commandArgs.indexOf("--filter");
      const packageName = filterIndex >= 0 ? commandArgs[filterIndex + 1]?.replace(/^@opap\//u, "") : undefined;
      return spawnSync(process.execPath,
        bundledWranglerArguments(commandArgs.slice(wranglerIndex + 1)), {
          ...options, cwd: packageName ? join(bundleRoot, "apps", packageName) : bundleRoot,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }).status === 0;
    }
    const executable = process.platform === "win32" && command === "corepack" ? process.execPath : command;
    const actualArgs = process.platform === "win32" && command === "corepack"
      ? [join(dirname(process.execPath), "node_modules", "corepack", "dist", "corepack.js"), ...commandArgs]
      : commandArgs;
    return spawnSync(executable, actualArgs, options).status === 0;
  };
  const wranglerJson = (commandArgs: readonly string[]): unknown => {
    const output = capture("corepack", ["pnpm@11.23.0", "exec", "wrangler", ...commandArgs]);
    const firstObject = Math.min(...[output.indexOf("["), output.indexOf("{")]
      .filter((index) => index >= 0));
    if (!Number.isFinite(firstObject)) throw new Error("Wrangler did not return JSON");
    return JSON.parse(output.slice(firstObject)) as unknown;
  };
  const commands: Array<readonly [string, readonly string[]]> = [["node", ["--version"]]];
  if (!bundleRoot) commands.push(["corepack", ["pnpm@11.23.0", "--version"]]);
  commands.push(["corepack", ["pnpm@11.23.0", "exec", "wrangler", "whoami"]]);
  if (workers.includes("plugin-runtime-worker") && args.has("--apply") &&
    action !== "remove" && action !== "doctor") {
    try {
      const dockerVersion = capture("docker", ["info", "--format", "{{.ServerVersion}}"]);
      console.log(`Docker Engine ${dockerVersion.trim()}: ready`);
    } catch {
      throw new Error("Preflight failed: Docker Desktop or Docker Engine must be running before Cloud Base Dynamic can be deployed");
    }
  }
  for (const [command, commandArgs] of commands) {
    const result = run(command, commandArgs);
    if (result.status !== 0) {
      const hint = command === "docker"
        ? "Docker Desktop or Docker Engine must be running before Cloud Base Dynamic can be deployed"
        : `${command} ${commandArgs.join(" ")}`;
      throw new Error(`Preflight failed: ${hint}`);
    }
  }
  console.log("\nThe setup tool never changes an existing Access team domain, Tunnel, application, or policy.");
  console.log("Back up production D1 with a Time Travel bookmark and SQL export before migrations.");
  console.log("Secret values remain in .dev.vars/.env and are registered with Wrangler; they are never printed.");
  console.log("\nDeployment order:");
  workers.forEach((worker, index) => console.log(`${index + 1}. ${worker}`));
  const ledgerPath = process.env["OPAP_INSTALLATION_LEDGER_PATH"]
    ?? fileURLToPath(new URL(`../.opap/installations/${deploymentName}.json`, import.meta.url));
  if (action === "doctor" || action === "remove") {
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as InstallationLedger;
    if (ledger.deploymentName !== deploymentName) throw new Error("Installation ledger deployment name does not match");
    const automatic = ledger.resources.filter((resource) => resource.ownership === "created"
      && resource.deletion === "automatic");
    if (action === "doctor") {
      for (const resource of automatic.filter((item) => item.kind === "worker")) {
        const result = run("corepack", ["pnpm@11.23.0", "exec", "wrangler", "deployments", "status", "--name", resource.name]);
        console.log(`${resource.kind} ${resource.name}: ${result.status === 0 ? "ok" : "unavailable"}`);
      }
    } else if (!args.has("--apply")) {
      console.log("\nRemoval dry run. The following installer-created resources would be removed:");
      automatic.forEach((resource) => console.log(`- ${resource.kind}: ${resource.name}`));
      console.log(`Re-run with --apply --confirm ${deploymentName} after exporting owner data.`);
    } else {
      if (valueAfter("--confirm") !== deploymentName) throw new Error("Removal confirmation does not match deployment name");
      if (!args.has("--export-confirmed")) throw new Error("Create and verify an opap-export/v1 file, then pass --export-confirmed");
      const order = { worker: 0, container: 1, r2: 2, d1: 3 } as const;
      const d1Rows = automatic.some((resource) => resource.kind === "d1")
        ? wranglerJson(["d1", "list", "--json"]) : [];
      if (!Array.isArray(d1Rows)) throw new Error("Unexpected D1 list response during removal");
      const existingD1 = new Set(d1Rows.flatMap((row) => {
        if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        return [value["name"], value["uuid"], value["id"]].filter((item): item is string => typeof item === "string");
      }));
      const r2Output = automatic.some((resource) => resource.kind === "r2")
        ? capture("corepack", ["pnpm@11.23.0", "exec", "wrangler", "r2", "bucket", "list"]) : "";
      const existingR2 = new Set([...r2Output.matchAll(/^name:\s+([^\r\n]+)$/gmu)]
        .map((match) => match[1]!.trim()));
      const containerRows = automatic.some((resource) => resource.kind === "container")
        ? wranglerJson(["containers", "list", "--json"]) : [];
      const containerList = Array.isArray(containerRows) ? containerRows
        : typeof containerRows === "object" && containerRows !== null && !Array.isArray(containerRows)
          && Array.isArray((containerRows as Record<string, unknown>)["containers"])
          ? (containerRows as { containers: unknown[] }).containers : [];
      const existingContainers = new Set(containerList.flatMap((row) => {
        if (typeof row !== "object" || row === null || Array.isArray(row)) return [];
        const value = row as Record<string, unknown>;
        return [value["name"], value["id"]].filter((item): item is string => typeof item === "string");
      }));
      const resourceExists = (resource: ManagedResource): boolean => {
        if (resource.kind === "worker") {
          try {
            capture("corepack", ["pnpm@11.23.0", "exec", "wrangler", "deployments", "list",
              "--name", resource.name, "--json"]);
            return true;
          } catch (error) {
            if (error instanceof Error && isAlreadyAbsentCloudflareError(error.message)) return false;
            throw error;
          }
        }
        if (resource.kind === "d1") return existingD1.has(resource.id) || existingD1.has(resource.name);
        if (resource.kind === "r2") return existingR2.has(resource.name);
        if (resource.kind === "container") return existingContainers.has(resource.id) || existingContainers.has(resource.name);
        return false;
      };
      for (const resource of automatic.sort((left, right) => (order[left.kind as keyof typeof order] ?? 9)
        - (order[right.kind as keyof typeof order] ?? 9))) {
        if (!resourceExists(resource)) {
          console.log(`Already absent: ${resource.kind} ${resource.name}`);
          continue;
        }
        const commandArgs = resource.kind === "worker" ? ["delete", resource.name, "--force"]
          : resource.kind === "container" ? ["containers", "delete", resource.id]
          : resource.kind === "r2" ? ["r2", "bucket", "delete", resource.name]
          : resource.kind === "d1" ? ["d1", "delete", resource.name, "-y"] : undefined;
        if (!commandArgs) continue;
        try {
          capture("corepack", ["pnpm@11.23.0", "exec", "wrangler", ...commandArgs]);
        } catch (error) {
          if (error instanceof Error && isAlreadyAbsentCloudflareError(error.message)) {
            console.log(`Already absent: ${resource.kind} ${resource.name}`);
            continue;
          }
          throw new Error(`Removal failed: ${resource.kind} ${resource.name}`, { cause: error });
        }
      }
      ledger.status = "removed"; ledger.updatedAt = new Date().toISOString();
      ledger.completedOperations.push("remove");
      await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await rm(new URL(`../.opap/credentials/${deploymentName}.opap-secrets`, import.meta.url), { force: true });
      for (const entry of await readdir(new URL("../apps/", import.meta.url), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        await rm(new URL(`../apps/${entry.name}/.opap.${deploymentName}.wrangler.jsonc`, import.meta.url), { force: true });
        await rm(new URL(`../apps/${entry.name}/.opap.${deploymentName}.bootstrap.wrangler.jsonc`, import.meta.url), { force: true });
      }
      console.log("Removal finished. External Google, GitHub, and Discord applications are retained for manual review.");
    }
  } else if (!args.has("--apply")) {
    console.log("\nDry run complete. Re-run with --apply after reviewing resource IDs and bindings.");
  } else {
    const secretTargets: ReadonlyArray<{ name: string; worker: string; source?: string }> = [
      { name: "PLUGIN_INVOCATION_SIGNING_KEY", worker: "assistant-worker" },
      { name: "PLUGIN_INVOCATION_SIGNING_KEY", worker: "plugin-runtime-worker" },
      { name: "GOOGLE_CLIENT_SECRET", worker: "google-gatekeeper" },
      { name: "GOOGLE_CLIENT_SECRET", worker: "delegated-source-gatekeeper" },
      { name: "GITHUB_CLIENT_SECRET", worker: "github-gatekeeper" },
      { name: "GITHUB_CLIENT_SECRET", worker: "delegated-source-gatekeeper" },
      { name: "CREDENTIAL_KEK", worker: "google-gatekeeper", source: "GOOGLE_CREDENTIAL_KEK" },
      { name: "CREDENTIAL_KEK", worker: "github-gatekeeper", source: "GITHUB_CREDENTIAL_KEK" },
      { name: "CREDENTIAL_KEK", worker: "delegated-source-gatekeeper", source: "DELEGATED_CREDENTIAL_KEK" },
      { name: "EXECUTION_LEASE_PRIVATE_JWK", worker: "policy-control-worker" },
      { name: "EXECUTION_LEASE_PUBLIC_JWK", worker: "google-gatekeeper" },
      { name: "EXECUTION_LEASE_PUBLIC_JWK", worker: "github-gatekeeper" },
      { name: "EXECUTION_LEASE_PUBLIC_JWK", worker: "discord-gatekeeper" },
      { name: "DISCORD_BOT_TOKEN", worker: "discord-gatekeeper" },
      { name: "DISCORD_BRIDGE_SIGNING_KEY", worker: "discord-adapter" },
    ];
    let generatedSecrets: Record<string, string>;
    const suppliedSecretsFile = process.env["OPAP_PLATFORM_SECRETS_FILE"];
    if (suppliedSecretsFile) {
      generatedSecrets = JSON.parse(await readFile(suppliedSecretsFile, "utf8")) as Record<string, string>;
    } else {
      const credentialDirectory = new URL("../.opap/credentials/", import.meta.url);
      await mkdir(credentialDirectory, { recursive: true });
      const credentialFile = new URL(`${deploymentName}.opap-secrets`, credentialDirectory);
      const recoveryPassphrase = process.env["OPAP_RECOVERY_PASSPHRASE"];
      if (!recoveryPassphrase) {
        throw new Error("OPAP_RECOVERY_PASSPHRASE is required for --apply. It encrypts the local recovery file and is never sent to Cloudflare.");
      }
      const credentialExists = await access(credentialFile).then(() => true).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      });
      if (credentialExists) {
        generatedSecrets = await decryptSecrets(JSON.parse(await readFile(credentialFile, "utf8")) as EncryptedSecretFile,
          recoveryPassphrase);
      } else {
        generatedSecrets = generatePlatformSecrets();
        await writeFile(credentialFile, `${JSON.stringify(await encryptSecrets(generatedSecrets, recoveryPassphrase), null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 });
        await chmod(credentialFile, 0o600).catch(() => undefined);
      }
    }
    const deploymentEnvironment = process.env["OPAP_ENVIRONMENT"] ?? target?.environment ??
      (selected === "local-dev" ? "development" : "production");
    if (!/^[a-z][a-z0-9-]{1,31}$/u.test(deploymentEnvironment)) {
      throw new Error("OPAP_ENVIRONMENT must contain only lowercase letters, numbers, and hyphens");
    }
    const providerSelections = [
      { provider: "ai-search" as const, enabled: target?.providers.aiSearch
        ?? Boolean(process.env["OPAP_AI_SEARCH_INSTANCE"]) },
      { provider: "discord" as const, enabled: workers.includes("discord-adapter") },
      { provider: "dynamic-plugin" as const, enabled: workers.includes("plugin-runtime-worker") },
      { provider: "google" as const, enabled: workers.includes("google-gatekeeper") },
      { provider: "github" as const, enabled: workers.includes("github-gatekeeper") },
    ];
    const accessIssuer = process.env["ACCESS_ISSUER"];
    const ownerBootstrap = validateOwnerBootstrapConfiguration({
      ownerEmail: process.env["OWNER_EMAIL"] ?? "",
      accessTeamDomain: process.env["OPAP_ACCESS_TEAM_DOMAIN"]
        ?? accessIssuer?.replace(/^https:\/\//u, "") ?? "",
      accessAudience: process.env["ACCESS_AUDIENCE"] ?? "",
      ownerTimeZone: process.env["OWNER_TIME_ZONE"] ?? "UTC",
      aiGatewayId: process.env["AI_GATEWAY_ID"] ?? "default",
    });
    const request: SetupRequest = { action: action === "update" ? "update" : action === "repair" ? "repair" : "install",
    deploymentName, profile: selected === "minimal"
      ? "minimal" : selected === "cloud-base-dynamic" ? "cloud-base-dynamic" : "cloud-base",
    accountId: process.env["CLOUDFLARE_ACCOUNT_ID"] ?? "wrangler-session", environment: deploymentEnvironment,
    providerSelections, ownerBootstrap, dryRun: false };
    const requiredProviderValues: Record<string, readonly string[]> = {
      "google-gatekeeper": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
      "github-gatekeeper": ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
      "discord-adapter": ["DISCORD_APPLICATION_ID", "DISCORD_PUBLIC_KEY", "DISCORD_BOT_TOKEN"],
    };
    for (const [worker, names] of Object.entries(requiredProviderValues)) {
      if (!workers.includes(worker)) continue;
      for (const name of names) {
        if (!(generatedSecrets[name] ?? process.env[name])) throw new Error(`${name} is required when ${worker} is enabled`);
      }
    }
    const sourceConfigs = new Map<string, WranglerConfig>();
    for (const worker of workers) {
      const sourceConfig = JSON.parse(await readFile(
        new URL(`../apps/${worker}/wrangler.jsonc`, import.meta.url), "utf8")) as WranglerConfig;
      sourceConfigs.set(worker, sourceConfig);
    }
    const selectedServiceNames = collectSelectedServiceNames(sourceConfigs.values());
    const configs = new Map<string, WranglerConfig>();
    for (const worker of workers) {
      const sourceConfig = structuredClone(sourceConfigs.get(worker)!);
      if (bundleRoot) sourceConfig["main"] = "dist/index.js";
      const config = transformWranglerConfig(sourceConfig, request, selectedServiceNames, target);
      if (!providerSelections.find((selection) => selection.provider === "discord")?.enabled && config.vars) {
        delete config.vars["DISCORD_APPLICATION_ID"];
        delete config.vars["DISCORD_PUBLIC_KEY"];
      }
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && config.vars?.[key] !== undefined) config.vars[key] = value;
      }
      const publicProviderVariables = ["GOOGLE_CLIENT_ID", "GITHUB_CLIENT_ID", "DISCORD_APPLICATION_ID",
        "DISCORD_PUBLIC_KEY"] as const;
      for (const key of publicProviderVariables) {
        const value = generatedSecrets[key] ?? process.env[key];
        if (value && config.vars && (config.vars[key] !== undefined
          || ["google-gatekeeper", "github-gatekeeper", "delegated-source-gatekeeper"].includes(worker))) {
          config.vars[key] = value;
        }
      }
      configs.set(worker, config);
    }
    const deploymentId = `deployment:${deploymentName}:${deploymentEnvironment}`;
    const generatedConfigName = `.opap.${deploymentName}.wrangler.jsonc`;
    const bootstrapConfigName = `.opap.${deploymentName}.bootstrap.wrangler.jsonc`;
    console.log(`Target environment: ${deploymentEnvironment}; deployment: ${deploymentId}`);
    const secretsForWorker = (worker: string): Record<string, string> => Object.fromEntries(secretTargets
      .filter((target) => target.worker === worker)
      .flatMap((target) => {
        const value = generatedSecrets[target.source ?? target.name] ?? process.env[target.name];
        return value ? [[target.name, value] as const] : [];
      }));
    const deploy = async (worker: string, configName: string): Promise<void> => {
      const directory = await mkdtemp(join(tmpdir(), "opap-secrets-"));
      const secretsPath = join(directory, "values.json");
      try {
        await writeFile(secretsPath, `${JSON.stringify(secretsForWorker(worker))}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(secretsPath, 0o600).catch(() => undefined);
        restrictTemporarySecretFile(secretsPath);
        const result = run("corepack", ["pnpm@11.23.0", "--filter", `@opap/${worker}`,
          "exec", "wrangler", "deploy", "--config", configName, "--secrets-file", secretsPath]);
        if (result.status !== 0) throw new Error(`Deployment failed: ${worker}`);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
    const listedDatabases = wranglerJson(["d1", "list", "--json"]);
    if (!Array.isArray(listedDatabases)) throw new Error("Unexpected D1 list response");
    const databaseIds = new Map<string, string>();
    const existingDatabases = new Set<string>();
    for (const database of listedDatabases) {
      if (typeof database !== "object" || database === null || Array.isArray(database)) continue;
      const row = database as Record<string, unknown>;
      const name = typeof row["name"] === "string" ? row["name"] : undefined;
      const id = typeof row["uuid"] === "string" ? row["uuid"]
        : typeof row["id"] === "string" ? row["id"] : undefined;
      if (name && id) { databaseIds.set(name, id); existingDatabases.add(name); }
    }
    const requiredDatabases = new Set([...configs.values()].flatMap((config) =>
      (config.d1_databases ?? []).map((database) => database.database_name)));
    for (const name of requiredDatabases) {
      if (databaseIds.has(name)) continue;
      console.log(`Creating D1 ${name}`);
      const created = run("corepack", ["pnpm@11.23.0", "exec", "wrangler", "d1", "create",
        name, "--location", "apac"]);
      if (created.status !== 0) throw new Error(`D1 creation failed: ${name}`);
    }
    if ([...requiredDatabases].some((name) => !databaseIds.has(name))) {
      const refreshed = wranglerJson(["d1", "list", "--json"]);
      if (!Array.isArray(refreshed)) throw new Error("Unexpected D1 list response");
      for (const database of refreshed) {
        if (typeof database !== "object" || database === null || Array.isArray(database)) continue;
        const row = database as Record<string, unknown>;
        const name = typeof row["name"] === "string" ? row["name"] : undefined;
        const id = typeof row["uuid"] === "string" ? row["uuid"]
          : typeof row["id"] === "string" ? row["id"] : undefined;
        if (name && id) databaseIds.set(name, id);
      }
    }
    for (const name of requiredDatabases) {
      if (!databaseIds.has(name)) throw new Error(`D1 ID not found after provisioning: ${name}`);
    }

    const listedBuckets = capture("corepack",
      ["pnpm@11.23.0", "exec", "wrangler", "r2", "bucket", "list"]);
    const bucketNames = new Set([...listedBuckets.matchAll(/^name:\s+([^\r\n]+)$/gmu)]
      .map((match) => match[1]!.trim()));
    const requiredBuckets = new Set([...configs.values()].flatMap((config) =>
      (config.r2_buckets ?? []).map((bucket) => bucket.bucket_name)));
    for (const name of requiredBuckets) {
      if (bucketNames.has(name)) continue;
      console.log(`Creating private R2 bucket ${name}`);
      const created = run("corepack", ["pnpm@11.23.0", "exec", "wrangler", "r2", "bucket",
        "create", name, "--location", "apac", "--storage-class", "Standard"]);
      if (created.status !== 0) throw new Error(`R2 creation failed: ${name}`);
    }

    const previousLedger = await readFile(ledgerPath, "utf8").then((value) => JSON.parse(value) as InstallationLedger)
      .catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
    if (previousLedger && previousLedger.deploymentName !== deploymentName) {
      throw new Error("Existing installation ledger belongs to another deployment");
    }
    const startedAt = previousLedger?.createdAt ?? new Date().toISOString();
    const previousResources = new Map<string, ManagedResource>((previousLedger?.resources ?? [])
      .map((resource) => [`${resource.kind}:${resource.name}`, resource]));
    let containerResources = [...previousResources.values()].filter((resource) => resource.kind === "container");
    const writeLedger = async (status: "installing" | "active" | "failed"): Promise<void> => {
      await mkdir(dirname(ledgerPath), { recursive: true });
      await writeFile(ledgerPath, `${JSON.stringify({ apiVersion: "opap.dev/installation-ledger/v1alpha1",
        deploymentName, accountId: request.accountId, environment: deploymentEnvironment, profile: request.profile,
        platformVersion: "0.1.0-beta.1", createdAt: startedAt, updatedAt: new Date().toISOString(), status,
        resources: [
          ...[...configs.values()].flatMap((config) => config.name ? [{ provider: "cloudflare", kind: "worker",
            id: config.name, name: config.name, ownership: previousResources.get(`worker:${config.name}`)?.ownership ?? "created",
            deletion: previousResources.get(`worker:${config.name}`)?.deletion ?? "automatic" }] : []),
          ...[...requiredDatabases].map((name) => ({ provider: "cloudflare", kind: "d1", id: databaseIds.get(name) ?? name,
            name, ownership: previousResources.get(`d1:${name}`)?.ownership ?? (existingDatabases.has(name) ? "reused" : "created"),
            deletion: previousResources.get(`d1:${name}`)?.deletion ?? (existingDatabases.has(name) ? "retain" : "automatic") })),
          ...[...requiredBuckets].map((name) => ({ provider: "cloudflare", kind: "r2", id: name, name,
            ownership: previousResources.get(`r2:${name}`)?.ownership ?? (bucketNames.has(name) ? "reused" : "created"),
            deletion: previousResources.get(`r2:${name}`)?.deletion ?? (bucketNames.has(name) ? "retain" : "automatic") })),
          ...containerResources,
        ], secrets: secretTargets.filter((target) => workers.includes(target.worker)).map((target) => ({
          secretId: `${target.worker}:${target.name}`, purpose: `${target.worker} ${target.name}`,
          storage: "cloudflare-only", recoverable: true })), completedOperations: status === "active"
          ? [...new Set([...(previousLedger?.completedOperations ?? []), action, "smoke"])]
          : previousLedger?.completedOperations ?? [],
      }, null, 2)}\n`, "utf8");
    };
    await writeLedger("installing");

    for (const [worker, config] of configs) {
      for (const database of config.d1_databases ?? []) {
        database.database_id = databaseIds.get(database.database_name)!;
      }
      for (const target of secretTargets.filter((item) => item.worker === worker)) {
        if (config.vars) delete config.vars[target.name];
      }
      await writeFile(new URL(`../apps/${worker}/${generatedConfigName}`, import.meta.url),
        `${JSON.stringify(config, null, 2)}\n`, "utf8");
    }
    console.log(`Resolved resource bindings were written to ignored ${generatedConfigName} files.`);

    const backupStamp = new Date().toISOString().replaceAll(":", "-");
    const backupDirectory = `.opap/backups/${backupStamp}`;
    await mkdir(new URL(`../${backupDirectory}/`, import.meta.url), { recursive: true });
    for (const name of requiredDatabases) {
      if (!existingDatabases.has(name)) continue;
      console.log(`Backing up D1 ${name}`);
      const bookmark = capture("corepack", ["pnpm@11.23.0", "exec", "wrangler", "d1",
        "time-travel", "info", name, "--json"]);
      await writeFile(new URL(`../${backupDirectory}/${name}.bookmark.json`, import.meta.url),
        bookmark, "utf8");
      if (!succeeds("corepack", ["pnpm@11.23.0", "exec", "wrangler", "d1", "export",
        name, "--remote", "--skip-confirmation", `--output=${backupDirectory}/${name}.sql`])) {
        throw new Error(`D1 export failed: ${name}`);
      }
    }

    const migrated = new Set<string>();
    for (const [worker, config] of configs) {
      for (const database of config.d1_databases ?? []) {
        if (!database.migrations_dir || migrated.has(database.database_name)) continue;
        console.log(`Applying migrations to ${database.database_name}`);
        const result = run("corepack", ["pnpm@11.23.0", "exec", "wrangler", "d1", "migrations",
          "apply", database.database_name, "--remote", "--config",
          `apps/${worker}/${generatedConfigName}`]);
        if (result.status !== 0) throw new Error(`Migration failed: ${database.database_name}`);
        migrated.add(database.database_name);
      }
    }

    let conversationBootstrap = false;
    if (workers.includes("conversation-agent") && workers.includes("assistant-worker")) {
      const assistantExists = succeeds("corepack", ["pnpm@11.23.0", "--filter",
        "@opap/assistant-worker", "exec", "wrangler", "deployments", "status", "--config",
        generatedConfigName]);
      if (!assistantExists) {
        const conversationConfig = structuredClone(configs.get("conversation-agent")!);
        conversationConfig.services = (conversationConfig.services ?? [])
          .filter((service) => service.binding !== "TASK_RUNNER");
        await writeFile(new URL(`../apps/conversation-agent/${bootstrapConfigName}`,
          import.meta.url), `${JSON.stringify(conversationConfig, null, 2)}\n`, "utf8");
        console.log("\nBootstrapping Conversation Agent before the circular Assistant binding exists");
        await deploy("conversation-agent", bootstrapConfigName);
        conversationBootstrap = true;
      }
    }
    for (const worker of workers) {
      if (conversationBootstrap && worker === "conversation-agent") continue;
      console.log(`\nDeploying ${worker}`);
      await deploy(worker, generatedConfigName);
    }
    if (conversationBootstrap) {
      console.log("\nRestoring the Conversation Agent Task Runner binding");
      await deploy("conversation-agent", generatedConfigName);
    }
    if (workers.includes("plugin-runtime-worker")) {
      if (!target) throw new Error("Dynamic Plugin deployment requires an explicit named target");
      const expectedName = target.resources.containers["opap-plugin-runtime-sandbox"];
      if (!expectedName) throw new Error(`Deployment target ${target.id} does not define the Plugin Runtime container`);
      const listed = wranglerJson(["containers", "list", "--json"]);
      if (!Array.isArray(listed)) throw new Error("Unexpected Container list response");
      const match = listed.find((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry)
        && (entry as Record<string, unknown>)["name"] === expectedName) as Record<string, unknown> | undefined;
      const id = typeof match?.["id"] === "string" ? match["id"] : undefined;
      if (!id) throw new Error(`Container ID not found after provisioning: ${expectedName}`);
      containerResources = [{ provider: "cloudflare", kind: "container", id, name: expectedName,
        ownership: previousResources.get(`container:${expectedName}`)?.ownership ?? "created",
        deletion: previousResources.get(`container:${expectedName}`)?.deletion ?? "automatic" }];
    }
    for (const worker of workers) {
      const result = run("corepack", ["pnpm@11.23.0", "--filter", `@opap/${worker}`,
        "exec", "wrangler", "deployments", "status", "--config", generatedConfigName]);
      if (result.status !== 0) throw new Error(`Deployment status check failed: ${worker}`);
    }
    const smokeUrls = ["OPAP_ASSISTANT_URL", "OPAP_PUBLIC_URL", "OPAP_DISCORD_URL"] as const;
    for (const name of smokeUrls) {
      const baseUrl = process.env[name];
      if (!baseUrl) continue;
      const response = await fetch(new URL("/health", baseUrl), { redirect: "error" });
      if (!response.ok) throw new Error(`Smoke test failed: ${name} (${response.status})`);
    }
    console.log("\nDeployment and deployment-status smoke checks finished.");
    console.log("If URL variables were omitted, run the Web UI, /health endpoints, Public search, and MCP smoke tests manually.");
    await writeLedger("active");
  }
}
