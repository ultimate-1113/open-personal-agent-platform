import { describe, expect, it } from "vitest";
import {
  evaluateResourceBudget,
  ExplicitBatch,
  shouldFlushAuditImmediately,
  VersionedSnapshotCache,
} from "./index.js";

describe("VersionedSnapshotCache", () => {
  it("reuses only the requested version before expiry", () => {
    const cache = new VersionedSnapshotCache<string>({ ttlMs: 100 });
    cache.set("policy:owner", { version: 3, value: "snapshot" }, 1_000);
    expect(cache.get("policy:owner", 3, 1_050)).toBe("snapshot");
    expect(cache.get("policy:owner", 2, 1_050)).toBeUndefined();
  });

  it("expires, invalidates and evicts old snapshots", () => {
    const cache = new VersionedSnapshotCache<string>({ maxEntries: 2, ttlMs: 10 });
    cache.set("a", { version: 1, value: "a" }, 0);
    cache.set("b", { version: 1, value: "b" }, 0);
    expect(cache.get("a", 1, 1)).toBe("a");
    cache.set("c", { version: 1, value: "c" }, 1);
    expect(cache.get("b", 1, 1)).toBeUndefined();
    cache.invalidate("a");
    expect(cache.get("a", 1, 1)).toBeUndefined();
    expect(cache.get("c", 1, 11)).toBeUndefined();
  });
});

describe("resource budgets", () => {
  const budget = { softLimit: 80, hardLimit: 100 };

  it("degrades before the hard limit and blocks before overspend", () => {
    expect(evaluateResourceBudget(70, 15, budget)).toMatchObject({
      allowed: true,
      mode: "degraded",
      projected: 85,
    });
    expect(evaluateResourceBudget(95, 6, budget)).toMatchObject({
      allowed: false,
      reason: "HARD_LIMIT_REACHED",
    });
  });

  it("rejects invalid budgets", () => {
    expect(() => evaluateResourceBudget(0, 1, { softLimit: 2, hardLimit: 1 })).toThrow(
      "Soft limit",
    );
  });

  it("accepts normal use and rejects invalid numeric values", () => {
    expect(evaluateResourceBudget(10, 5, budget).mode).toBe("normal");
    expect(() => evaluateResourceBudget(-1, 1, budget)).toThrow("negative");
    expect(() => evaluateResourceBudget(0, Number.POSITIVE_INFINITY, budget)).toThrow(
      "finite",
    );
  });

  it("synchronously flushes only security audit events", () => {
    expect(shouldFlushAuditImmediately("security")).toBe(true);
    expect(shouldFlushAuditImmediately("normal")).toBe(false);
  });
});

describe("ExplicitBatch", () => {
  it("rejects invalid batch limits", () => {
    expect(() => new ExplicitBatch(0)).toThrow("Batch size");
    expect(() => new ExplicitBatch(101)).toThrow("Batch size");
  });

  it("writes many events through one repository call", async () => {
    const calls: number[][] = [];
    const batch = new ExplicitBatch<number>(3);
    expect(batch.add(1)).toBe(false);
    expect(batch.add(2)).toBe(false);
    expect(batch.add(3)).toBe(true);
    await batch.flush({
      appendBatch: (items) => {
        calls.push([...items]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([[1, 2, 3]]);
  });

  it("restores a batch after a failed write", async () => {
    const batch = new ExplicitBatch<number>();
    batch.add(1);
    await expect(
      batch.flush({ appendBatch: async () => Promise.reject(new Error("failed")) }),
    ).rejects.toThrow("failed");
    expect(batch.size).toBe(1);
  });

  it("does not call a repository for an empty batch", async () => {
    let calls = 0;
    await new ExplicitBatch<number>().flush({
      appendBatch: () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    expect(calls).toBe(0);
  });
});
