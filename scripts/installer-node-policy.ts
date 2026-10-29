export const installerNodeMinimum = "26.13.0";

export function assertInstallerNodeVersion(version: string): void {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  const patch = Number(match?.[3]);
  if (major !== 26 || !(minor > 13 || (minor === 13 && patch >= 0))) {
    throw new Error(`Installer builds require stable Node.js >=${installerNodeMinimum} <27; got ${version}`);
  }
}
