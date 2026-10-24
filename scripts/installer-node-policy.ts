export const installerNodeMinimum = "24.22.1";

export function assertInstallerNodeVersion(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  if (major !== 24 || !(minor > 22 || (minor === 22 && patch >= 1))) {
    throw new Error(`Installer builds require stable Node.js >=${installerNodeMinimum} <25 (CVE-2026-111497); got ${version}`);
  }
}
