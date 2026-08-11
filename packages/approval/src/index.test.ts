import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import {
  InMemoryApprovalStore,
  issueExecutionLease,
  verifyExecutionLease,
} from "./index.js";

const request = {
  calendarId: "calendar:primary",
  event: { title: "架空の予定", startsAt: "2026-08-07T10:00:00+09:00" },
};

describe("execution leases", () => {
  it("binds a signed lease to the exact request", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const token = await issueExecutionLease(
      {
        issuer: "control:fixture",
        principalId: "principal:owner",
        capabilityId: "calendar.events.create",
        gatekeeperId: "gatekeeper:google-personal",
        taskId: "task:fixture",
        request,
        grantVersion: 1,
        policyVersion: 1,
        approvalId: "approval:fixture",
        issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      },
      privateKey,
    );

    await expect(
      verifyExecutionLease(token, publicKey, {
        issuer: "control:fixture",
        principalId: "principal:owner",
        capabilityId: "calendar.events.create",
        gatekeeperId: "gatekeeper:google-personal",
        request,
        now: new Date("2026-08-07T00:01:00.000Z"),
      }),
    ).resolves.toMatchObject({ approvalId: "approval:fixture" });

    await expect(
      verifyExecutionLease(token, publicKey, {
        issuer: "control:fixture",
        principalId: "principal:owner",
        capabilityId: "calendar.events.create",
        gatekeeperId: "gatekeeper:google-personal",
        request: { ...request, calendarId: "calendar:other" },
        now: new Date("2026-08-07T00:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "lease.request_mismatch",
    });
  });

  it("rejects expired leases", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const token = await issueExecutionLease(
      {
        issuer: "control:fixture",
        principalId: "principal:owner",
        capabilityId: "calendar.events.create",
        gatekeeperId: "gatekeeper:google-personal",
        taskId: "task:fixture",
        request,
        grantVersion: 1,
        policyVersion: 1,
        issuedAt: new Date("2026-08-07T00:00:00.000Z"),
        ttlSeconds: 1,
      },
      privateKey,
    );
    await expect(
      verifyExecutionLease(token, publicKey, {
        issuer: "control:fixture",
        principalId: "principal:owner",
        capabilityId: "calendar.events.create",
        gatekeeperId: "gatekeeper:google-personal",
        request,
        now: new Date("2026-08-07T00:00:02.000Z"),
      }),
    ).rejects.toMatchObject({ code: "lease.expired" });
  });
});

describe("approval store", () => {
  it("records a digest and accepts one decision", async () => {
    const store = new InMemoryApprovalStore();
    const approval = await store.create({
      principalId: "principal:owner",
      capabilityId: "calendar.events.create",
      request,
      preview: { title: "架空の予定" },
      now: new Date("2026-08-07T00:00:00.000Z"),
    });
    expect(approval.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(
      store.decide(
        approval.approvalId,
        "approved",
        new Date("2026-08-07T00:01:00.000Z"),
      ),
    ).resolves.toMatchObject({ status: "approved" });
    await expect(store.decide(approval.approvalId, "approved")).rejects.toThrow(
      "no longer pending",
    );
  });
});
