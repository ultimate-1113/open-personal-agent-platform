import { describe, expect, it } from "vitest";
import { auditOccurredAtFromRpc } from "../apps/audit-ledger-worker/src/index.js";

describe("Audit Ledger RPC time", () => {
  it("restores a serialized ISO timestamp as a Date", () => {
    const value = auditOccurredAtFromRpc("2026-08-11T06:43:45.533Z");
    expect(value).toBeInstanceOf(Date);
    expect(value?.toISOString()).toBe("2026-08-11T06:43:45.533Z");
  });

  it("rejects invalid serialized timestamps", () => {
    expect(auditOccurredAtFromRpc("not-a-date")).toBeUndefined();
  });
});
