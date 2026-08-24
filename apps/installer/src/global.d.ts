import type { InstallerBridge } from "./preload.js";
declare global { interface Window { opapInstaller: InstallerBridge } }
export {};
