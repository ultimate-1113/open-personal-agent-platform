import { describe, expect, it } from "vitest";
import { assertInstallerNodeVersion } from "../scripts/installer-node-policy.ts";

describe("installer Node security baseline", () => {
  it.each(["26.13.0", "v26.13.0", "26.13.1", "26.14.0"])("accepts supported Node %s", (version) => {
    expect(() => assertInstallerNodeVersion(version)).not.toThrow();
  });

  it.each(["24.22.1", "25.0.0", "26.12.1", "27.0.0", "26.13.0-rc.1", "26.13", "garbage"])(
    "rejects pre-LTS or unsupported Node %s", (version) => {
    expect(() => assertInstallerNodeVersion(version)).toThrow("Node.js >=26.13.0 <27");
  });
});
