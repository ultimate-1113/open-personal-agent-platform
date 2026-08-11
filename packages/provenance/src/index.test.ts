import { describe, expect, it } from "vitest";
import type { InformationPolicy } from "@opap/contracts";
import {
  appendAuditEvent,
  createObservation,
  InMemoryAuditOutbox,
  InMemoryAuditSegmentLedger,
  mergeInformationPolicies,
} from "./index.js";

const publicPolicy: InformationPolicy = {
  deploymentId: "deployment:fixture",
  subjectPrincipalIds: [],
  visibility: "public",
  sensitivity: "normal",
  trust: "external",
  allowedAudienceIds: ["public", "principal:owner"],
  allowedDestinationIds: ["destination:workers-ai", "destination:local"],
  retention: { mode: "ttl", expiresAt: "2027-01-01T00:00:00.000Z" },
};

const ownerPolicy: InformationPolicy = {
  deploymentId: "deployment:fixture",
  subjectPrincipalIds: ["principal:owner"],
  visibility: "owner",
  sensitivity: "sensitive",
  trust: "trusted",
  allowedAudienceIds: ["principal:owner"],
  allowedDestinationIds: ["destination:local"],
  retention: { mode: "until-deleted" },
};

describe("mergeInformationPolicies", () => {
  it("inherits the strictest constraints", () => {
    expect(mergeInformationPolicies([publicPolicy, ownerPolicy])).toEqual({
      deploymentId: "deployment:fixture",
      subjectPrincipalIds: ["principal:owner"],
      visibility: "owner",
      sensitivity: "sensitive",
      trust: "external",
      allowedAudienceIds: ["principal:owner"],
      allowedDestinationIds: ["destination:local"],
      retention: { mode: "ttl", expiresAt: "2027-01-01T00:00:00.000Z" },
    });
  });

  it("rejects cross-deployment derivation", () => {
    expect(() =>
      mergeInformationPolicies([
        publicPolicy,
        { ...ownerPolicy, deploymentId: "deployment:other" },
      ]),
    ).toThrow("different deployments");
  });
});

describe("provenance records", () => {
  it("stores a digest instead of observation content", async () => {
    const observation = await createObservation({
      observationId: "observation:fixture",
      deploymentId: "deployment:fixture",
      principalId: "principal:owner",
      agentId: "agent:fixture",
      capabilityId: "documents.read",
      sourceType: "fixture",
      sourceResourceId: "document:fixture",
      informationPolicy: ownerPolicy,
      parentObservationIds: [],
      content: "本文は保存しない",
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(observation.contentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(observation).not.toHaveProperty("content");
  });

  it("chains audit event hashes", async () => {
    const first = await appendAuditEvent({
      eventId: "audit:1",
      deploymentId: "deployment:fixture",
      eventType: "policy.evaluate",
      outcome: "success",
      requestId: "request:1",
      metadata: { reasonCode: "policy.allowed" },
      occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const second = await appendAuditEvent({
      eventId: "audit:2",
      deploymentId: "deployment:fixture",
      eventType: "capability.execute",
      outcome: "success",
      requestId: "request:1",
      metadata: {},
      previousHash: first.eventHash,
      occurredAt: new Date("2026-01-01T00:00:01.000Z"),
    });
    expect(second.previousHash).toBe(first.eventHash);
    expect(second.eventHash).not.toBe(first.eventHash);
  });

  it("closes daily audit segments before pruning them", async () => {
    const ledger = new InMemoryAuditSegmentLedger();
    await ledger.appendBatch([
      {
        eventId: "audit:segment-1",
        deploymentId: "deployment:fixture",
        eventType: "budget.changed",
        outcome: "success",
        requestId: "request:segment-1",
        metadata: {},
        occurredAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        eventId: "audit:segment-2",
        deploymentId: "deployment:fixture",
        eventType: "budget.changed",
        outcome: "success",
        requestId: "request:segment-2",
        metadata: {},
        occurredAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]);
    expect(ledger.pruneClosedSegments("2026-01-03")).toEqual([]);
    const checkpoint = ledger.closeSegment("2026-01-01", {
      r2ObjectKey: "audit/2026-01-01.json",
      closedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(checkpoint.eventCount).toBe(1);
    expect(ledger.pruneClosedSegments("2026-01-03")).toEqual(["2026-01-01"]);
    expect(ledger.getSegment("2026-01-01")).toBeUndefined();
    expect(ledger.getSegment("2026-01-02")).toBeDefined();
  });

  it("removes delivered outbox rows after ledger acknowledgement", () => {
    const outbox = new InMemoryAuditOutbox();
    outbox.enqueue({
      eventId: "audit:outbox",
      deploymentId: "deployment:fixture",
      eventType: "conversation.updated",
      outcome: "success",
      requestId: "request:outbox",
      metadata: {},
    });
    expect(outbox.pending()).toHaveLength(1);
    outbox.acknowledge(["audit:outbox"]);
    expect(outbox.pending()).toHaveLength(0);
  });
});
