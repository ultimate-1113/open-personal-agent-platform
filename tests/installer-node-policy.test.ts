import { describe, expect, it } from "vitest";
import { assertInstallerNodeVersion } from "../scripts/installer-node-policy.ts";

describe("installer Node security baseline", () => {
  it.each(["24.22.1", "v24.22.1", "24.22.2", "24.23.0"])("accepts patched Node %s", (version) => {
    expect(() => assertInstallerNodeVersion(version)).not.toThrow();
  });

  it.each(["24.13.1", "24.19.0", "24.21.0", "24.22.0", "22.23.4", "25.0.0", "26.12.1",
    "24.22.1-rc.1", "24.22", "garbage"])("rejects unpatched or unsupported Node %s", (version) => {
    expect(() => assertInstallerNodeVersion(version)).toThrow("CVE-2026-111497");
  });
});
