import { describe, expect, it } from "vitest";
import type {
  CapabilityDefinition,
  CapabilityGrant,
  CapabilityInvocation,
  InformationPolicy,
  Principal,
} from "@opap/contracts";
import {
  canExposePublicly,
  evaluateAudience,
  evaluateDelegatedSourceAcl,
  evaluatePolicy,
} from "./index.js";

const owner: Principal = {
  principalId: "principal:owner",
  deploymentId: "deployment:fixture",
  kind: "owner",
  issuer: "https://access.example.test",
  subject: "owner-subject",
  audienceIds: [],
};

const ownerPolicy: InformationPolicy = {
  deploymentId: "deployment:fixture",
  subjectPrincipalIds: [owner.principalId],
  visibility: "owner",
  sensitivity: "normal",
  trust: "trusted",
  allowedAudienceIds: [owner.principalId],
  allowedDestinationIds: ["destination:local"],
  retention: { mode: "until-deleted" },
};

const capability: CapabilityDefinition = {
  id: "calendar.events.create",
  version: "1",
  effect: "external-write",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  gatekeeperId: "gatekeeper:google-personal",
  defaultInformationPolicy: ownerPolicy,
  approval: "always",
  maxCallsPerTask: 1,
  allowedDestinationIds: ["destination:local"],
};

const grant: CapabilityGrant = {
  grantId: "grant:calendar",
  version: 4,
  principalId: owner.principalId,
  capabilityId: capability.id,
  resourceIds: ["calendar:primary"],
  allowedDestinationIds: ["destination:local"],
};

const invocation: CapabilityInvocation = {
  taskId: "task:fixture",
  capabilityId: capability.id,
  resourceId: "calendar:primary",
  destinationId: "destination:local",
  input: { title: "架空の予定" },
  informationPolicy: ownerPolicy,
  callsInTask: 0,
};

describe("evaluatePolicy", () => {
  it("requires approval for an allowed external write", () => {
    expect(
      evaluatePolicy({ principal: owner, capability, grant, invocation }),
    ).toEqual({
      outcome: "requires-approval",
      reasonCode: "approval.required",
    });
  });

  it("denies a resource outside the grant", () => {
    expect(
      evaluatePolicy({
        principal: owner,
        capability,
        grant,
        invocation: { ...invocation, resourceId: "calendar:other" },
      }).reasonCode,
    ).toBe("grant.resource_scope_denied");
  });

  it("never sends secret information to a model", () => {
    expect(
      evaluatePolicy({
        principal: owner,
        capability,
        grant,
        invocation: {
          ...invocation,
          informationPolicy: { ...ownerPolicy, sensitivity: "secret" },
        },
        destinationKind: "model",
      }).reasonCode,
    ).toBe("information.secret_destination_denied");
  });

  it("denies a missing grant", () => {
    expect(evaluatePolicy({ principal: owner, capability, invocation }).reasonCode).toBe(
      "grant.missing",
    );
  });

  it.each<readonly [CapabilityGrant, string]>([
    [{ ...grant, revokedAt: "2026-08-01T00:00:00.000Z" }, "grant.revoked"],
    [{ ...grant, expiresAt: "2026-08-01T00:00:00.000Z" }, "grant.expired"],
    [{ ...grant, principalId: "principal:other" }, "grant.principal_mismatch"],
    [{ ...grant, capabilityId: "other" }, "grant.capability_mismatch"],
  ])("denies invalid grant %#", (candidate, reasonCode) => {
    expect(
      evaluatePolicy({
        principal: owner,
        capability,
        grant: candidate,
        invocation,
        now: new Date("2026-08-07T00:00:00.000Z"),
      }).reasonCode,
    ).toBe(reasonCode);
  });

  it.each<readonly [CapabilityInvocation, string]>([
    [{ ...invocation, capabilityId: "other" }, "grant.capability_mismatch"],
    [{ ...invocation, callsInTask: 1 }, "capability.call_budget_exhausted"],
    [{ ...invocation, destinationId: "destination:other" }, "capability.destination_denied"],
    [
      { ...invocation, informationPolicy: { ...ownerPolicy, allowedDestinationIds: [] } },
      "information.destination_denied",
    ],
  ])("denies invalid invocation %#", (candidate, reasonCode) => {
    expect(evaluatePolicy({ principal: owner, capability, grant, invocation: candidate }).reasonCode).toBe(
      reasonCode,
    );
  });

  it("checks the grant destination separately", () => {
    expect(
      evaluatePolicy({
        principal: owner,
        capability,
        grant: { ...grant, allowedDestinationIds: [] },
        invocation,
      }).reasonCode,
    ).toBe("grant.destination_denied");
  });

  it("allows a read capability without approval", () => {
    expect(
      evaluatePolicy({
        principal: owner,
        capability: { ...capability, effect: "read", approval: "policy", maxCallsPerTask: 2 },
        grant,
        invocation,
      }).outcome,
    ).toBe("allow");
  });
});

describe("audience", () => {
  const publicPolicy: InformationPolicy = {
    ...ownerPolicy,
    visibility: "public",
    allowedAudienceIds: ["public"],
  };

  it("separates anonymous, owner, delegated and service principals", () => {
    expect(
      evaluateAudience({ ...owner, kind: "anonymous" }, publicPolicy).outcome,
    ).toBe("allow");
    expect(
      evaluateAudience({ ...owner, kind: "anonymous" }, ownerPolicy).outcome,
    ).toBe("deny");
    expect(evaluateAudience(owner, ownerPolicy).outcome).toBe("allow");
    expect(
      evaluateAudience(owner, { ...ownerPolicy, subjectPrincipalIds: [] }).outcome,
    ).toBe("deny");
    const delegated = { ...owner, kind: "delegated" as const, principalId: "principal:reader" };
    expect(evaluateAudience(delegated, publicPolicy).outcome).toBe("allow");
    expect(
      evaluateAudience(delegated, {
        ...ownerPolicy,
        visibility: "delegated-principal",
        allowedAudienceIds: [delegated.principalId],
      }).outcome,
    ).toBe("allow");
    expect(evaluateAudience(delegated, ownerPolicy).outcome).toBe("deny");
    const service = { ...owner, kind: "service" as const, principalId: "principal:service" };
    expect(
      evaluateAudience(service, { ...ownerPolicy, allowedAudienceIds: [service.principalId] }).outcome,
    ).toBe("allow");
    expect(evaluateAudience(service, ownerPolicy).outcome).toBe("deny");
  });
});

describe("delegated source ACL", () => {
  it("requires verified email claims", () => {
    const acl = {
      issuer: "https://issuer.example.test",
      audience: "docs-api",
      rules: [
        { claim: "email" as const, operator: "domain" as const, values: ["example.test"] },
      ],
    };

    expect(
      evaluateDelegatedSourceAcl(acl, {
        issuer: acl.issuer,
        audience: acl.audience,
        subject: "visitor-1",
        email: "reader@example.test",
        emailVerified: false,
      }).reasonCode,
    ).toBe("delegated.verified_email_required");

    expect(
      evaluateDelegatedSourceAcl(acl, {
        issuer: acl.issuer,
        audience: acl.audience,
        subject: "visitor-1",
        email: "reader@example.test",
        emailVerified: true,
      }).outcome,
    ).toBe("allow");
  });

  it("rejects mismatched identity claims and accepts subject/group rules", () => {
    const base = {
      issuer: "https://issuer.example.test",
      audience: "docs-api",
      subject: "reader-1",
      groups: ["docs-readers"],
    };
    expect(
      evaluateDelegatedSourceAcl(
        { issuer: base.issuer, audience: base.audience, rules: [] },
        { ...base, issuer: "https://other.example.test" },
      ).outcome,
    ).toBe("deny");
    expect(
      evaluateDelegatedSourceAcl(
        {
          issuer: base.issuer,
          audience: base.audience,
          rules: [{ claim: "subject", operator: "in", values: ["reader-1"] }],
        },
        { ...base, audience: ["other", base.audience] },
      ).outcome,
    ).toBe("allow");
    expect(
      evaluateDelegatedSourceAcl(
        {
          issuer: base.issuer,
          audience: base.audience,
          rules: [{ claim: "subject", operator: "equals", values: ["reader-2"] }],
        },
        base,
      ).reasonCode,
    ).toBe("delegated.subject_denied");
    expect(
      evaluateDelegatedSourceAcl(
        {
          issuer: base.issuer,
          audience: base.audience,
          rules: [{ claim: "group", operator: "in", values: ["admins"] }],
        },
        base,
      ).reasonCode,
    ).toBe("delegated.group_denied");
  });

  it("normalizes exact email matches", () => {
    expect(
      evaluateDelegatedSourceAcl(
        {
          issuer: "issuer",
          audience: "audience",
          rules: [{ claim: "email", operator: "equals", values: ["Reader@Example.Test"] }],
        },
        {
          issuer: "issuer",
          audience: "audience",
          subject: "reader",
          email: "reader@example.test",
          emailVerified: true,
        },
      ).outcome,
    ).toBe("allow");
  });
});

describe("public exposure", () => {
  it("does not expose owner data", () => {
    expect(canExposePublicly(ownerPolicy)).toBe(false);
    expect(
      canExposePublicly({
        ...ownerPolicy,
        visibility: "public",
        allowedAudienceIds: ["public"],
      }),
    ).toBe(true);
    expect(
      canExposePublicly({
        ...ownerPolicy,
        visibility: "public",
        sensitivity: "secret",
        allowedAudienceIds: ["public"],
      }),
    ).toBe(false);
  });
});
