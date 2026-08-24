import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from "electron";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { decryptSecrets, encryptSecrets, generatePlatformSecrets, type EncryptedSecretFile } from "@opap/secret-vault";
import { allowedNetworkHosts, assertAllowedUrl, createInstallPlan, validateDeploymentName, validateOwnerBootstrapConfiguration,
  validateDeploymentTarget, type DeploymentTarget, type InstallationLedger, type SetupRequest } from "@opap/setup-engine";
import { extractDeploymentBundle } from "@opap/setup-engine/archive";
import { createGitHubAppManifest } from "@opap/setup-engine/github-manifest";

app.commandLine.appendSwitch("disable-breakpad");
type ReleaseMetadata = { version: string; commit: string; workflowUrl: string; sourceUrl?: string;
  lockSha256?: string; bundleSha256?: string; sbomSha256?: string;
  codeSigning?: { platform: string; signed: boolean; notarized: boolean } };
const localRelease: ReleaseMetadata = {
  version: process.env["OPAP_RELEASE_VERSION"] ?? "0.1.0-beta.1",
  commit: process.env["OPAP_GIT_COMMIT"] ?? "local-working-tree",
  workflowUrl: process.env["OPAP_BUILD_WORKFLOW_URL"] ?? "local-build",
};
const release = (() => {
  try { return JSON.parse(readFileSync(join(app.getAppPath(), "resources", "release.json"), "utf8")) as ReleaseMetadata; }
  catch { return localRelease; }
})();
const secretPurposes: Record<string, string> = {
  GOOGLE_CREDENTIAL_KEK: "Google OAuth credential encryption",
  GITHUB_CREDENTIAL_KEK: "GitHub OAuth credential encryption",
  GITHUB_APP_PRIVATE_KEY: "GitHub App installation authentication",
  GITHUB_WEBHOOK_SECRET: "GitHub webhook authentication",
  DELEGATED_CREDENTIAL_KEK: "Delegated source credential encryption",
  PLUGIN_INVOCATION_SIGNING_KEY: "Dynamic plugin invocation authentication",
  DISCORD_BRIDGE_SIGNING_KEY: "Discord Gateway Bridge authentication",
  OAUTH_STATE_SIGNING_KEY: "OAuth state authentication",
  EXPORT_SIGNING_KEY: "Export integrity",
  EXECUTION_LEASE_PRIVATE_JWK: "Execution Lease signing",
  EXECUTION_LEASE_PUBLIC_JWK: "Execution Lease verification",
};
const vaultSecrets = new Map<string, Record<string, string>>();
const vaultPersistence = new Map<string, (values: Record<string, string>) => Promise<void>>();
const execFileAsync = promisify(execFile);
const stagedNodeRuntime = app.isPackaged
  ? join(process.resourcesPath, "node-runtime", process.platform === "win32" ? "node.exe" : "node")
  : join(app.getAppPath(), "resources", "node-runtime", process.platform === "win32" ? "node.exe" : "node");
const nodeRuntime = existsSync(stagedNodeRuntime) ? stagedNodeRuntime : process.execPath;
const stagedWranglerRuntime = app.isPackaged
  ? join(process.resourcesPath, "node-runtime", "node_modules", "wrangler", "wrangler-dist", "cli.js")
  : join(app.getAppPath(), "resources", "node-runtime-deps", "node_modules", "wrangler", "wrangler-dist", "cli.js");
const wranglerRuntime = existsSync(stagedWranglerRuntime)
  ? stagedWranglerRuntime
  : join(app.getAppPath(), "..", "..", "node_modules", "wrangler", "wrangler-dist", "cli.js");
const nodeModuleArguments = (entry: string, args: readonly string[]): string[] => [entry, ...args];
const wranglerEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, ELECTRON_RUN_AS_NODE: "1",
  XDG_CONFIG_HOME: join(app.getPath("userData"), "wrangler-auth") });

const safeProcessFailure = (error: unknown): string => {
  const failure = error as { code?: unknown; stderr?: unknown; stdout?: unknown; message?: unknown };
  const combined = [failure.code, failure.stderr, failure.stdout, failure.message]
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .map(String).join(" ");
  const withoutAnsi = combined.split(String.fromCharCode(27))
    .map((chunk, index) => index === 0 ? chunk : chunk.replace(/^\[[0-?]*[ -/]*[@-~]/u, "")).join("");
  return withoutAnsi
    .replaceAll(/(?:[A-Za-z]:\\|\/)[^\s\r\n]+/gu, "<path>").replaceAll(/https?:\/\/[^\s\r\n]+/gu, "<url>")
    .replaceAll(/\r\n?/gu, "\n").replaceAll(/[\t ]+/gu, " ").replaceAll(/\n{3,}/gu, "\n\n")
    .trim().slice(0, 32 * 1024) || "SETUP_FAILED";
};

type InstallerPackageMetadata = { opapInstallerTarget?: unknown };
const installerPackage = JSON.parse(
  readFileSync(join(app.getAppPath(), "package.json"), "utf8"),
) as InstallerPackageMetadata;
const installerTargetId = installerPackage.opapInstallerTarget === "test" ? "test" : "production";
const installerTargetPath = app.isPackaged
  ? join(process.resourcesPath, "targets", `${installerTargetId}.json`)
  : join(app.getAppPath(), "..", "..", "deployments", "targets", `${installerTargetId}.json`);
const installerTarget: DeploymentTarget = validateDeploymentTarget(
  JSON.parse(readFileSync(installerTargetPath, "utf8")) as unknown);
const installerProductName = installerTarget.id === "test"
  ? "Open Personal Agent Setup Test" : "Open Personal Agent Setup";
app.setName(installerProductName);

type GitHubManifestConversion = {
  id: number;
  client_id: string;
  client_secret: string;
  pem: string;
  webhook_secret: string;
  slug?: string;
  html_url?: string;
};

const escapeHtmlAttribute = (value: string): string => value.replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function registerGitHubAppFromManifest(input: {
  deploymentName: string;
  oauthCallbackUrl: string;
}): Promise<GitHubManifestConversion> {
  const state = randomBytes(32).toString("base64url");
  let finish: ((value: GitHubManifestConversion) => void) | undefined;
  let fail: ((reason: Error) => void) | undefined;
  let callbackConsumed = false;
  const result = new Promise<GitHubManifestConversion>((resolve, reject) => { finish = resolve; fail = reject; });
  const server = createServer((request, response) => {
    void (async () => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(request.url ?? "/", base);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "GET" && url.pathname === "/start") {
        const redirectUrl = `${base}/callback`;
        const manifest = createGitHubAppManifest({ ...input, redirectUrl });
        const action = assertAllowedUrl(`https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`);
        const encoded = escapeHtmlAttribute(JSON.stringify(manifest));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; form-action https://github.com; style-src 'unsafe-inline'" });
        response.end(`<!doctype html><meta charset="utf-8"><title>Create OPAP GitHub App</title>
          <style>body{font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px}button{padding:12px 18px}</style>
          <h1>Create OPAP GitHub App</h1><p>GitHub will show the complete permissions before creation.</p>
          <form method="post" action="${escapeHtmlAttribute(action.toString())}">
          <input type="hidden" name="github_app_manifest" value="${encoded}"><button>Create on GitHub</button></form>`);
        return;
      }
      if (request.method === "GET" && url.pathname === "/callback") {
        if (callbackConsumed) {
          response.writeHead(409, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("This GitHub App response was already processed.");
          return;
        }
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.get("state") !== state || !/^[A-Za-z0-9_-]{8,256}$/u.test(code)) {
          response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
          response.end("The GitHub response could not be verified. Return to the Installer.");
          fail?.(new Error("GitHub manifest state validation failed"));
          return;
        }
        callbackConsumed = true;
        const endpoint = assertAllowedUrl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`);
        const conversionResponse = await fetch(endpoint, { method: "POST", redirect: "error", headers: {
          Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "opap-installer",
        }, signal: AbortSignal.timeout(30_000) });
        if (!conversionResponse.ok) throw new Error("GitHub manifest conversion failed");
        const converted = await conversionResponse.json() as Partial<GitHubManifestConversion>;
        if (typeof converted.id !== "number" || typeof converted.client_id !== "string"
          || typeof converted.client_secret !== "string" || typeof converted.pem !== "string"
          || typeof converted.webhook_secret !== "string") throw new Error("GitHub returned an invalid App credential response");
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        response.end("<!doctype html><meta charset=\"utf-8\"><style>body{font:16px system-ui;text-align:center;margin-top:18vh}</style><h1>GitHub App created</h1><p>You can close this page and return to OPAP Setup.</p>");
        finish?.(converted as GitHubManifestConversion);
        return;
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("GitHub App creation failed. Return to the Installer.");
      fail?.(new Error("GitHub App creation failed"));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const timeout = setTimeout(() => fail?.(new Error("GitHub App creation timed out")), 10 * 60_000);
  try {
    const address = server.address() as AddressInfo;
    await shell.openExternal(`http://127.0.0.1:${address.port}/start`);
    return await result;
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}

async function restrictSecretFile(path: string): Promise<void> {
  if (process.platform !== "win32") return;
  const user = process.env["USERNAME"];
  const domain = process.env["USERDOMAIN"];
  if (!user || /[\r\n]/u.test(user) || (domain && /[\r\n]/u.test(domain))) throw new Error("Current Windows user is unavailable");
  const identity = domain ? `${domain}\\${user}` : user;
  await execFileAsync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${identity}:(R,W)`],
    { windowsHide: true, maxBuffer: 64 * 1024 });
}

async function cleanupStaleTemporaryDirectories(): Promise<void> {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:opap-installer|opap-removal|opap-secrets)-/u.test(entry.name)) continue;
    const path = join(tmpdir(), entry.name);
    const details = await stat(path).catch(() => undefined);
    if (details && details.mtimeMs < cutoff) await rm(path, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createWindow(): void {
  const window = new BrowserWindow({ width: 1080, height: 760, minWidth: 860, minHeight: 620,
    title: app.getName(), webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"), nodeIntegration: false, contextIsolation: true,
      sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
    } });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void window.loadFile(join(import.meta.dirname, "../dist/index.html"));
}

ipcMain.handle("installer:get-overview", () => {
  const request: SetupRequest = { action: "install", deploymentName: installerTarget.deploymentName,
    profile: installerTarget.profile, accountId: "not-selected", environment: installerTarget.environment,
    providerSelections: [], dryRun: true };
  return { release, unsigned: release.codeSigning?.signed !== true, telemetry: false, crashUpload: false,
    sourceUrl: release.commit === "local-working-tree" ? null
      : release.sourceUrl ?? `https://github.com/ultimate-1113/open-personal-agent-platform/tree/${release.commit}`,
    networkHosts: [...allowedNetworkHosts].sort(),
    secretPurposes,
    plan: createInstallPlan(request, ["quota-worker", "audit-ledger-worker", "policy-control-worker",
      "conversation-agent", "maintenance-worker", "assistant-worker", "public-agent-api",
      "delegated-agent-api"]),
  };
});

ipcMain.handle("installer:get-configuration", () => ({ targetId: installerTarget.id,
  deploymentName: installerTarget.deploymentName, profile: installerTarget.profile,
  productName: app.getName(), defaultDataPath: join(app.getPath("documents"), "Open Personal Agent", installerTarget.deploymentName) }));

ipcMain.handle("installer:select-data-path", async (_event, currentPath: unknown) => {
  const result = await dialog.showOpenDialog({ title: "Select OPAP data folder", defaultPath: typeof currentPath === "string" ? currentPath : app.getPath("documents"),
    properties: ["openDirectory", "createDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("installer:initialize-vault", async (_event, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid vault request");
  const { deploymentName, passphrase } = input as { deploymentName?: unknown; passphrase?: unknown };
  if (typeof deploymentName !== "string") throw new Error("Invalid deployment name");
  if (passphrase !== undefined && typeof passphrase !== "string") throw new Error("Invalid recovery passphrase");
  validateDeploymentName(deploymentName);
  const available = await safeStorage.isAsyncEncryptionAvailable();
  const backend = process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : process.platform;
  const directory = join(app.getPath("userData"), "credentials");
  const path = join(directory, `${deploymentName}.opap-secrets`);
  const exists = await access(path).then(() => true).catch(() => false);
  if (!available || backend === "basic_text") {
    if (!passphrase) return { status: "passphrase-required", backend, references: [] };
    const values = exists
      ? await decryptSecrets(JSON.parse(await readFile(path, "utf8")) as EncryptedSecretFile, passphrase)
      : generatePlatformSecrets();
    const encryptedFile = await encryptSecrets(values, passphrase);
    await mkdir(directory, { recursive: true });
    if (!exists) await writeFile(path, `${JSON.stringify(encryptedFile, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    vaultSecrets.set(deploymentName, values);
    vaultPersistence.set(deploymentName, async (next) => {
      await writeFile(path, `${JSON.stringify(await encryptSecrets(next, passphrase), null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 });
    });
    return { status: "ready", backend: "passphrase-encrypted", references: Object.entries(secretPurposes)
      .map(([name, purpose]) => ({ secretId: `${deploymentName}:${name}:${randomUUID()}`, purpose,
        storage: "passphrase-encrypted", recoverable: true })) };
  }
  const decrypted = exists ? await safeStorage.decryptStringAsync(await readFile(path)) : undefined;
  const values = decrypted
    ? JSON.parse(decrypted.result) as Record<string, string>
    : generatePlatformSecrets();
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(values));
  await mkdir(directory, { recursive: true });
  if (!exists || decrypted?.shouldReEncrypt) await writeFile(path, encrypted, { mode: 0o600 });
  vaultSecrets.set(deploymentName, values);
  vaultPersistence.set(deploymentName, async (next) => {
    await writeFile(path, await safeStorage.encryptStringAsync(JSON.stringify(next)), { mode: 0o600 });
  });
  return { status: "ready", backend, references: Object.entries(secretPurposes).map(([name, purpose]) => ({
    secretId: `${deploymentName}:${name}:${randomUUID()}`, purpose, storage: "os-protected", recoverable: true,
  })) };
});

ipcMain.handle("installer:import-provider", async (_event, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid provider import");
  const { deploymentName, provider } = input as { deploymentName?: unknown; provider?: unknown };
  if (typeof deploymentName !== "string" || !["google", "github", "discord"].includes(String(provider))) {
    throw new Error("Invalid provider import");
  }
  validateDeploymentName(deploymentName);
  const values = vaultSecrets.get(deploymentName);
  const persist = vaultPersistence.get(deploymentName);
  if (!values || !persist) throw new Error("Initialize the secret vault before importing credentials");
  const selected = await dialog.showOpenDialog({ title: `Import ${String(provider)} credentials`, properties: ["openFile"],
    filters: [{ name: "JSON", extensions: ["json"] }] });
  if (selected.canceled || !selected.filePaths[0]) return { status: "cancelled" };
  const parsed = JSON.parse(await readFile(selected.filePaths[0], "utf8")) as Record<string, unknown>;
  if (provider === "google") {
    const source = (parsed["web"] ?? parsed["installed"] ?? parsed) as Record<string, unknown>;
    if (typeof source["client_id"] !== "string" || typeof source["client_secret"] !== "string") {
      throw new Error("Google client_secret.json is invalid");
    }
    values["GOOGLE_CLIENT_ID"] = source["client_id"];
    values["GOOGLE_CLIENT_SECRET"] = source["client_secret"];
    await persist(values);
    return { status: "ready", provider, label: typeof source["project_id"] === "string"
      ? source["project_id"] : source["client_id"].split(".")[0] };
  }
  if (provider === "github") {
    const clientId = parsed["clientId"] ?? parsed["client_id"];
    const clientSecret = parsed["clientSecret"] ?? parsed["client_secret"];
    if (typeof clientId !== "string" || typeof clientSecret !== "string") throw new Error("GitHub credential JSON is invalid");
    values["GITHUB_CLIENT_ID"] = clientId; values["GITHUB_CLIENT_SECRET"] = clientSecret;
    await persist(values);
    return { status: "ready", provider, label: typeof parsed["appName"] === "string" ? parsed["appName"] : clientId };
  }
  const applicationId = parsed["applicationId"] ?? parsed["application_id"];
  const publicKey = parsed["publicKey"] ?? parsed["public_key"];
  const botToken = parsed["botToken"] ?? parsed["bot_token"];
  if (typeof applicationId !== "string" || typeof publicKey !== "string" || typeof botToken !== "string") {
    throw new Error("Discord credential JSON is invalid");
  }
  values["DISCORD_APPLICATION_ID"] = applicationId;
  values["DISCORD_PUBLIC_KEY"] = publicKey;
  values["DISCORD_BOT_TOKEN"] = botToken;
  await persist(values);
  return { status: "ready", provider, label: applicationId };
});

ipcMain.handle("installer:create-github-app", async (_event, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid GitHub App request");
  const { deploymentName, oauthCallbackUrl } = input as { deploymentName?: unknown; oauthCallbackUrl?: unknown };
  if (typeof deploymentName !== "string" || typeof oauthCallbackUrl !== "string") throw new Error("Invalid GitHub App request");
  validateDeploymentName(deploymentName);
  const values = vaultSecrets.get(deploymentName);
  const persist = vaultPersistence.get(deploymentName);
  if (!values || !persist) throw new Error("Initialize the secret vault before creating a GitHub App");
  const converted = await registerGitHubAppFromManifest({ deploymentName, oauthCallbackUrl });
  values["GITHUB_CLIENT_ID"] = converted.client_id;
  values["GITHUB_CLIENT_SECRET"] = converted.client_secret;
  values["GITHUB_APP_PRIVATE_KEY"] = converted.pem;
  values["GITHUB_WEBHOOK_SECRET"] = converted.webhook_secret;
  await persist(values);
  return { status: "ready", provider: "github", label: converted.slug ?? `GitHub App ${converted.id}`,
    appUrl: typeof converted.html_url === "string" ? converted.html_url : null };
});

ipcMain.handle("installer:save-dry-run", async (_event, value: unknown) => {
  const selected = await dialog.showSaveDialog({ title: "Save OPAP dry run", defaultPath: "opap-dry-run.json",
    filters: [{ name: "JSON", extensions: ["json"] }] });
  if (selected.canceled || !selected.filePath) return false;
  await writeFile(selected.filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return true;
});

ipcMain.handle("installer:copy-diagnostic", (_event, value: unknown) => {
  if (typeof value !== "string" || value.length > 64 * 1024) return false;
  clipboard.writeText(value);
  return true;
});

ipcMain.handle("installer:save-diagnostic", async (_event, value: unknown) => {
  if (typeof value !== "string" || value.length > 64 * 1024) return false;
  const selected = await dialog.showSaveDialog({ title: "Save OPAP diagnostic", defaultPath: "opap-installer-error.txt",
    filters: [{ name: "Text", extensions: ["txt"] }] });
  if (selected.canceled || !selected.filePath) return false;
  await writeFile(selected.filePath, `${value}\n`, "utf8");
  return true;
});

ipcMain.handle("installer:open-source", async () => {
  if (release.commit === "local-working-tree") return false;
  await shell.openExternal(`https://github.com/ultimate-1113/open-personal-agent-platform/tree/${release.commit}`);
  return true;
});

ipcMain.handle("installer:open-access-dashboard", async () => {
  await shell.openExternal("https://one.dash.cloudflare.com/");
  return true;
});

ipcMain.handle("installer:save-sbom", async () => {
  const selected = await dialog.showSaveDialog({ title: "Save installer SBOM", defaultPath: "opap-installer.cdx.json",
    filters: [{ name: "CycloneDX JSON", extensions: ["json"] }] });
  if (selected.canceled || !selected.filePath) return false;
  await writeFile(selected.filePath, readFileSync(join(app.getAppPath(), "resources", "opap-installer.cdx.json")));
  return true;
});

ipcMain.handle("installer:authenticate-cloudflare", async () => {
  try {
    const environment = wranglerEnvironment();
    await mkdir(environment["XDG_CONFIG_HOME"]!, { recursive: true });
    const options = { windowsHide: true, maxBuffer: 256 * 1024, env: environment };
    await execFileAsync(nodeRuntime, nodeModuleArguments(wranglerRuntime, ["logout"]), options).catch(() => undefined);
    await execFileAsync(nodeRuntime, nodeModuleArguments(wranglerRuntime, ["login", "--browser=true"]), options);
    await execFileAsync(nodeRuntime, nodeModuleArguments(wranglerRuntime, ["whoami"]), {
      windowsHide: true, maxBuffer: 256 * 1024, env: environment,
    });
    return { status: "authenticated" };
  } catch (error) {
    return { status: "failed", errorCode: "CLOUDFLARE_AUTH_FAILED",
      detail: safeProcessFailure(error) };
  }
});

ipcMain.handle("installer:install", async (_event, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid install request");
  const value = input as { deploymentName?: unknown; google?: unknown; github?: unknown; discord?: unknown;
    profile?: unknown;
    localDataPath?: unknown;
    ownerEmail?: unknown; accessTeamDomain?: unknown; accessAudience?: unknown; ownerTimeZone?: unknown;
    aiGatewayId?: unknown; action?: unknown };
  if (typeof value.deploymentName !== "string") throw new Error("Invalid deployment name");
  if (typeof value.localDataPath !== "string" || !isAbsolute(value.localDataPath)) throw new Error("A local data folder is required");
  validateDeploymentName(value.deploymentName);
  if (value.deploymentName !== installerTarget.deploymentName) throw new Error("Deployment target name cannot be overridden");
  if (value.profile !== "cloud-base" && value.profile !== "cloud-base-dynamic") throw new Error("Invalid setup profile");
  if (value.profile !== installerTarget.profile) throw new Error("Deployment target profile cannot be overridden");
  const setupAction = value.action === "update" || value.action === "repair" ? value.action : "setup";
  if (typeof value.ownerEmail !== "string" || typeof value.accessTeamDomain !== "string"
    || typeof value.accessAudience !== "string" || typeof value.ownerTimeZone !== "string"
    || typeof value.aiGatewayId !== "string") throw new Error("Owner bootstrap configuration is incomplete");
  const owner = validateOwnerBootstrapConfiguration({ ownerEmail: value.ownerEmail,
    accessTeamDomain: value.accessTeamDomain, accessAudience: value.accessAudience,
    ownerTimeZone: value.ownerTimeZone, aiGatewayId: value.aiGatewayId });
  const secrets = vaultSecrets.get(value.deploymentName);
  if (!secrets) throw new Error("Initialize the secret vault before installation");
  if (value.google === true && (!secrets["GOOGLE_CLIENT_ID"] || !secrets["GOOGLE_CLIENT_SECRET"])) {
    throw new Error("Import Google credentials before enabling Google");
  }
  if (value.github === true && (!secrets["GITHUB_CLIENT_ID"] || !secrets["GITHUB_CLIENT_SECRET"])) {
    throw new Error("Import GitHub credentials before enabling GitHub");
  }
  if (value.discord === true && (!secrets["DISCORD_APPLICATION_ID"] || !secrets["DISCORD_PUBLIC_KEY"]
    || !secrets["DISCORD_BOT_TOKEN"])) throw new Error("Import Discord credentials before enabling Discord");
  const archive = join(app.getAppPath(), "resources", "opap-deployment-bundle.tgz");
  if (release.bundleSha256) {
    const actual = createHash("sha256").update(await readFile(archive)).digest("hex");
    if (actual !== release.bundleSha256) throw new Error("Deployment bundle digest does not match release metadata");
  }
  const working = await mkdtemp(join(tmpdir(), "opap-installer-"));
  const bundle = join(working, "bundle");
  const secretFile = join(working, "values.json");
  const ledgerDirectory = join(value.localDataPath, "installations");
  await mkdir(ledgerDirectory, { recursive: true });
  const ledger = join(ledgerDirectory, `${value.deploymentName}.json`);
  try {
    await extractDeploymentBundle(archive, bundle);
    await writeFile(secretFile, `${JSON.stringify(secrets)}\n`, { encoding: "utf8", mode: 0o600 });
    await restrictSecretFile(secretFile);
    const runner = join(bundle, "scripts", "opap-setup.ts");
    await execFileAsync(nodeRuntime, ["--experimental-strip-types", "--no-warnings", ...nodeModuleArguments(runner, [setupAction, "--target",
      installerTarget.id, "--apply"])], { cwd: bundle, windowsHide: true,
      maxBuffer: 1024 * 1024, env: { ...wranglerEnvironment(),
        NODE_OPTIONS: [process.env["NODE_OPTIONS"], "--experimental-strip-types", "--no-warnings"].filter(Boolean).join(" "), OPAP_BUNDLE_ROOT: bundle,
        OPAP_WRANGLER_CLI: wranglerRuntime, OPAP_PLATFORM_SECRETS_FILE: secretFile,
        OPAP_INSTALLATION_LEDGER_PATH: ledger,
        OWNER_EMAIL: owner.ownerEmail, OPAP_ACCESS_TEAM_DOMAIN: owner.accessTeamDomain,
        ACCESS_ISSUER: owner.accessIssuer, ACCESS_AUDIENCE: owner.accessAudience,
        ACCESS_JWKS_URI: owner.accessJwksUri, OWNER_TIME_ZONE: owner.ownerTimeZone,
        AI_GATEWAY_ID: owner.aiGatewayId,
        OPAP_ENABLE_GOOGLE: value.google === true ? "1" : "0",
        OPAP_ENABLE_GITHUB: value.github === true ? "1" : "0",
        OPAP_ENABLE_DISCORD: value.discord === true ? "1" : "0" } });
    return { status: "active" };
  } catch (error) {
    try {
      const current = JSON.parse(await readFile(ledger, "utf8")) as InstallationLedger;
      current.status = "failed";
      current.updatedAt = new Date().toISOString();
      await writeFile(ledger, `${JSON.stringify(current, null, 2)}\n`, "utf8");
    } catch { /* No ledger exists when validation or preflight failed before resource creation. */ }
    return { status: "failed", errorCode: "SETUP_FAILED", detail: safeProcessFailure(error) };
  } finally {
    await rm(working, { recursive: true, force: true });
  }
});

ipcMain.handle("installer:remove", async (_event, input: unknown) => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Invalid removal request");
  const value = input as { deploymentName?: unknown; localDataPath?: unknown; exportConfirmed?: unknown };
  if (typeof value.deploymentName !== "string" || typeof value.localDataPath !== "string"
    || !isAbsolute(value.localDataPath) || value.exportConfirmed !== true) {
    throw new Error("A verified owner export is required before removal");
  }
  validateDeploymentName(value.deploymentName);
  if (value.deploymentName !== installerTarget.deploymentName) throw new Error("Deployment target name cannot be overridden");
  const working = await mkdtemp(join(tmpdir(), "opap-removal-"));
  const bundle = join(working, "bundle");
  try {
    await extractDeploymentBundle(join(app.getAppPath(), "resources", "opap-deployment-bundle.tgz"), bundle);
    const ledger = join(value.localDataPath, "installations", `${value.deploymentName}.json`);
    await execFileAsync(nodeRuntime, ["--experimental-strip-types", join(bundle, "scripts", "opap-setup.ts"),
      "remove", "--target", installerTarget.id, "--apply", "--confirm",
      value.deploymentName, "--export-confirmed"], { cwd: bundle, windowsHide: true, maxBuffer: 1024 * 1024,
      env: { ...wranglerEnvironment(), OPAP_BUNDLE_ROOT: bundle,
        OPAP_WRANGLER_CLI: wranglerRuntime, OPAP_INSTALLATION_LEDGER_PATH: ledger } });
    await rm(join(app.getPath("userData"), "credentials", `${value.deploymentName}.opap-secrets`), { force: true });
    vaultSecrets.delete(value.deploymentName);
    vaultPersistence.delete(value.deploymentName);
    return { status: "removed" };
  } catch (error) { return { status: "failed", errorCode: "REMOVAL_FAILED", detail: safeProcessFailure(error) }; }
  finally { await rm(working, { recursive: true, force: true }); }
});

void app.whenReady().then(async () => { await cleanupStaleTemporaryDirectories(); createWindow(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
