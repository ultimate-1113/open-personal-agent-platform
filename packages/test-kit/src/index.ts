import type {
  CapabilityDefinition,
  CapabilityGrant,
  InformationPolicy,
  Principal,
} from "@opap/contracts";

export const fixtureOwner = (): Principal => ({
  principalId: "principal:owner-fixture",
  deploymentId: "deployment:fixture",
  kind: "owner",
  issuer: "https://access.example.test",
  subject: "owner-fixture-subject",
  audienceIds: [],
});

export const fixtureOwnerPolicy = (): InformationPolicy => ({
  deploymentId: "deployment:fixture",
  subjectPrincipalIds: ["principal:owner-fixture"],
  visibility: "owner",
  sensitivity: "normal",
  trust: "trusted",
  allowedAudienceIds: ["principal:owner-fixture"],
  allowedDestinationIds: ["model:mock-local"],
  retention: { mode: "until-deleted" },
});

export const fixtureReadCapability = (): CapabilityDefinition => ({
  id: "fixture.documents.read",
  version: "1",
  effect: "read",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  gatekeeperId: "gatekeeper:fixture",
  defaultInformationPolicy: fixtureOwnerPolicy(),
  approval: "never",
  maxCallsPerTask: 10,
  allowedDestinationIds: ["model:mock-local"],
});

export const fixtureGrant = (): CapabilityGrant => ({
  grantId: "grant:fixture",
  version: 1,
  principalId: "principal:owner-fixture",
  capabilityId: "fixture.documents.read",
  resourceIds: ["document:fixture"],
  allowedDestinationIds: ["model:mock-local"],
});
