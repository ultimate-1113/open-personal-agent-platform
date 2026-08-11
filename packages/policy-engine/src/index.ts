import type {
  CapabilityDefinition,
  CapabilityGrant,
  CapabilityInvocation,
  DelegatedSourceAcl,
  InformationPolicy,
  PolicyDecision,
  Principal,
} from "@opap/contracts";

export type DestinationKind = "model" | "plugin" | "tool" | "audience";

export type PolicyEvaluationInput = {
  principal: Principal;
  capability: CapabilityDefinition;
  grant?: CapabilityGrant;
  invocation: CapabilityInvocation;
  destinationKind?: DestinationKind;
  now?: Date;
};

const deny = (reasonCode: string, detail?: string): PolicyDecision => ({
  outcome: "deny",
  reasonCode,
  ...(detail === undefined ? {} : { detail }),
});

const contains = (values: readonly string[], value: string): boolean =>
  values.includes(value);

export function evaluatePolicy(input: PolicyEvaluationInput): PolicyDecision {
  const { capability, grant, invocation, principal } = input;
  const now = input.now ?? new Date();

  if (!grant) {
    return deny("grant.missing");
  }

  if (grant.revokedAt) {
    return deny("grant.revoked");
  }

  if (grant.expiresAt && Date.parse(grant.expiresAt) <= now.getTime()) {
    return deny("grant.expired");
  }

  if (grant.principalId !== principal.principalId) {
    return deny("grant.principal_mismatch");
  }

  if (
    grant.capabilityId !== capability.id ||
    invocation.capabilityId !== capability.id
  ) {
    return deny("grant.capability_mismatch");
  }

  if (
    invocation.resourceId &&
    !contains(grant.resourceIds, invocation.resourceId)
  ) {
    return deny("grant.resource_scope_denied");
  }

  if (invocation.callsInTask >= capability.maxCallsPerTask) {
    return deny("capability.call_budget_exhausted");
  }

  const destinationId = invocation.destinationId;
  if (destinationId) {
    if (!contains(capability.allowedDestinationIds, destinationId)) {
      return deny("capability.destination_denied");
    }
    if (!contains(grant.allowedDestinationIds, destinationId)) {
      return deny("grant.destination_denied");
    }
    if (!contains(invocation.informationPolicy.allowedDestinationIds, destinationId)) {
      return deny("information.destination_denied");
    }
  }

  if (
    invocation.informationPolicy.sensitivity === "secret" &&
    (input.destinationKind === "model" || input.destinationKind === "plugin")
  ) {
    return deny("information.secret_destination_denied");
  }

  const audienceDecision = evaluateAudience(
    principal,
    invocation.informationPolicy,
  );
  if (audienceDecision.outcome === "deny") {
    return audienceDecision;
  }

  if (
    capability.approval === "always" ||
    (capability.approval === "policy" && capability.effect !== "read")
  ) {
    return {
      outcome: "requires-approval",
      reasonCode: "approval.required",
    };
  }

  return { outcome: "allow", reasonCode: "policy.allowed" };
}

export function evaluateAudience(
  principal: Principal,
  informationPolicy: InformationPolicy,
): PolicyDecision {
  if (principal.kind === "anonymous") {
    return informationPolicy.visibility === "public" &&
      contains(informationPolicy.allowedAudienceIds, "public")
      ? { outcome: "allow", reasonCode: "audience.public" }
      : deny("audience.anonymous_denied");
  }

  if (principal.kind === "owner") {
    const ownerAllowed =
      informationPolicy.visibility === "public" ||
      (informationPolicy.visibility === "owner" &&
        contains(informationPolicy.subjectPrincipalIds, principal.principalId));
    return ownerAllowed
      ? { outcome: "allow", reasonCode: "audience.owner" }
      : deny("audience.owner_denied");
  }

  if (principal.kind === "delegated") {
    const delegatedAllowed =
      informationPolicy.visibility === "public" ||
      (informationPolicy.visibility === "delegated-principal" &&
        contains(informationPolicy.allowedAudienceIds, principal.principalId));
    return delegatedAllowed
      ? { outcome: "allow", reasonCode: "audience.delegated" }
      : deny("audience.delegated_denied");
  }

  const serviceAllowed = contains(
    informationPolicy.allowedAudienceIds,
    principal.principalId,
  );
  return serviceAllowed
    ? { outcome: "allow", reasonCode: "audience.explicit" }
    : deny("audience.explicit_denied");
}

export type DelegatedClaims = {
  issuer: string;
  audience: string | readonly string[];
  subject: string;
  email?: string;
  emailVerified?: boolean;
  groups?: readonly string[];
};

const hasAudience = (
  audience: string | readonly string[],
  expected: string,
): boolean =>
  typeof audience === "string"
    ? audience === expected
    : audience.includes(expected);

export function evaluateDelegatedSourceAcl(
  acl: DelegatedSourceAcl,
  claims: DelegatedClaims,
): PolicyDecision {
  if (claims.issuer !== acl.issuer || !hasAudience(claims.audience, acl.audience)) {
    return deny("delegated.issuer_or_audience_denied");
  }

  for (const rule of acl.rules) {
    if (rule.claim === "subject") {
      if (!rule.values.includes(claims.subject)) {
        return deny("delegated.subject_denied");
      }
      continue;
    }

    if (rule.claim === "email") {
      if (!claims.email || claims.emailVerified !== true) {
        return deny("delegated.verified_email_required");
      }
      const normalizedEmail = claims.email.toLowerCase();
      const allowed = rule.values.some((value) => {
        const normalizedValue = value.toLowerCase();
        return rule.operator === "equals"
          ? normalizedEmail === normalizedValue
          : normalizedEmail.endsWith(`@${normalizedValue.replace(/^@/u, "")}`);
      });
      if (!allowed) {
        return deny("delegated.email_denied");
      }
      continue;
    }

    const groups = claims.groups ?? [];
    if (!rule.values.some((value) => groups.includes(value))) {
      return deny("delegated.group_denied");
    }
  }

  return { outcome: "allow", reasonCode: "delegated.acl_allowed" };
}

export function canExposePublicly(
  informationPolicy: InformationPolicy,
): boolean {
  return (
    informationPolicy.visibility === "public" &&
    informationPolicy.sensitivity !== "secret" &&
    informationPolicy.allowedAudienceIds.includes("public")
  );
}
