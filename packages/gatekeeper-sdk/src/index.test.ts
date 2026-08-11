import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { issueExecutionLease } from "@opap/approval";
import type { Principal } from "@opap/contracts";
import { AuthorizedExecutor, InMemoryNonceStore } from "./index.js";

const principal: Principal = {
  principalId: "principal:owner",
  deploymentId: "deployment:fixture",
  kind: "owner",
  issuer: "https://access.example.test",
  subject: "owner-subject",
  audienceIds: [],
};

describe("AuthorizedExecutor", () => {
  it("consumes an execution lease only once", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const input = { issueTitle: "架空のIssue" };
    const token = await issueExecutionLease(
      {
        issuer: "control:fixture",
        principalId: principal.principalId,
        capabilityId: "github.issues.create",
        gatekeeperId: "gatekeeper:github-personal",
        taskId: "task:fixture",
        request: input,
        grantVersion: 1,
        policyVersion: 1,
        issuedAt: new Date("2026-08-07T00:00:00.000Z"),
      },
      privateKey,
    );
    const executor = new AuthorizedExecutor({
      gatekeeperId: "gatekeeper:github-personal",
      issuer: "control:fixture",
      publicKey,
      nonceStore: new InMemoryNonceStore(),
      execute: () => Promise.resolve({
        status: "succeeded",
        value: { issueNumber: 1 },
        observations: [],
      }),
    });
    const request = {
      lease: token,
      capabilityId: "github.issues.create",
      input,
    };
    const context = {
      requestId: "request:fixture",
      principal,
      agentId: "agent:fixture",
      receivedAt: new Date("2026-08-07T00:01:00.000Z"),
    };
    await expect(executor.execute(request, context)).resolves.toMatchObject({
      status: "succeeded",
    });
    await expect(executor.execute(request, context)).rejects.toThrow("replay");
  });
});
