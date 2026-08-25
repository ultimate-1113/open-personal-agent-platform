import { contextBridge, ipcRenderer } from "electron";

export type InstallerBridge = {
  getOverview: () => Promise<unknown>;
  getConfiguration: () => Promise<unknown>;
  selectDataPath: (currentPath: string) => Promise<string | null>;
  initializeVault: (input: { deploymentName: string; passphrase?: string }) => Promise<unknown>;
  saveDryRun: (value: unknown) => Promise<boolean>;
  copyDiagnostic: (value: string) => Promise<boolean>;
  saveDiagnostic: (value: string) => Promise<boolean>;
  openSource: () => Promise<boolean>;
  openAccessDashboard: () => Promise<boolean>;
  saveSbom: () => Promise<boolean>;
  install: (input: { deploymentName: string; google: boolean; github: boolean; discord: boolean;
    profile: "cloud-base" | "cloud-base-dynamic";
    localDataPath: string;
    ownerEmail: string; accessTeamDomain: string; accessAudience: string; ownerTimeZone: string;
    aiGatewayId: string; action?: "install" | "update" | "repair" }) => Promise<unknown>;
  onInstallProgress: (callback: (value: { stage: string; progress: number; message: string }) => void) => void;
  authenticateCloudflare: () => Promise<unknown>;
  importProvider: (input: { deploymentName: string; provider: "google" | "github" | "discord" }) => Promise<unknown>;
  createGitHubApp: (input: { deploymentName: string; oauthCallbackUrl: string }) => Promise<unknown>;
  remove: (input: { deploymentName: string; localDataPath: string; exportConfirmed: boolean }) => Promise<unknown>;
};

const bridge: InstallerBridge = {
  getOverview: () => ipcRenderer.invoke("installer:get-overview") as Promise<unknown>,
  getConfiguration: () => ipcRenderer.invoke("installer:get-configuration") as Promise<unknown>,
  selectDataPath: (currentPath) => ipcRenderer.invoke("installer:select-data-path", currentPath) as Promise<string | null>,
  initializeVault: (input) => ipcRenderer.invoke("installer:initialize-vault", input) as Promise<unknown>,
  saveDryRun: (value) => ipcRenderer.invoke("installer:save-dry-run", value) as Promise<boolean>,
  copyDiagnostic: (value) => ipcRenderer.invoke("installer:copy-diagnostic", value) as Promise<boolean>,
  saveDiagnostic: (value) => ipcRenderer.invoke("installer:save-diagnostic", value) as Promise<boolean>,
  openSource: () => ipcRenderer.invoke("installer:open-source") as Promise<boolean>,
  openAccessDashboard: () => ipcRenderer.invoke("installer:open-access-dashboard") as Promise<boolean>,
  saveSbom: () => ipcRenderer.invoke("installer:save-sbom") as Promise<boolean>,
  install: (input) => ipcRenderer.invoke("installer:install", input) as Promise<unknown>,
  onInstallProgress: (callback) => { ipcRenderer.on("installer:install-progress", (_event, value: unknown) => {
    callback(value as { stage: string; progress: number; message: string });
  }); },
  authenticateCloudflare: () => ipcRenderer.invoke("installer:authenticate-cloudflare") as Promise<unknown>,
  importProvider: (input) => ipcRenderer.invoke("installer:import-provider", input) as Promise<unknown>,
  createGitHubApp: (input) => ipcRenderer.invoke("installer:create-github-app", input) as Promise<unknown>,
  remove: (input) => ipcRenderer.invoke("installer:remove", input) as Promise<unknown>,
};
contextBridge.exposeInMainWorld("opapInstaller", bridge);
