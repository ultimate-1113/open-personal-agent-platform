import {
  SignJWT,
  errors as joseErrors,
  jwtVerify,
  type CryptoKey,
  type KeyObject,
} from "jose";
import {
  approvalRequestSchema,
  executionLeaseClaimsSchema,
  type ApprovalRequest,
  type ExecutionLeaseClaims,
  type JsonValue,
} from "@opap/contracts";
import { digestJson, timingSafeEqualText } from "@opap/security";

export type LeaseKey = CryptoKey | KeyObject | Uint8Array;

export async function createRequestDigest(request: JsonValue): Promise<string> {
  return digestJson(request);
}

export type IssueExecutionLeaseInput = {
  issuer: string;
  principalId: string;
  capabilityId: string;
  gatekeeperId: string;
  taskId: string;
  request: JsonValue;
  grantVersion: number;
  policyVersion: number;
  approvalId?: string;
  resourceId?: string;
  leaseId?: string;
  issuedAt?: Date;
  ttlSeconds?: number;
};

export async function issueExecutionLease(
  input: IssueExecutionLeaseInput,
  privateKey: LeaseKey,
): Promise<string> {
  const issuedAt = input.issuedAt ?? new Date();
  const issuedAtSeconds = Math.floor(issuedAt.getTime() / 1_000);
  const ttlSeconds = input.ttlSeconds ?? 300;
  if (ttlSeconds < 1 || ttlSeconds > 900) {
    throw new RangeError("Execution lease TTL must be between 1 and 900 seconds");
  }

  const requestDigest = await createRequestDigest(input.request);
  const claims: ExecutionLeaseClaims = {
    jti: input.leaseId ?? `lease:${crypto.randomUUID()}`,
    iss: input.issuer,
    sub: input.principalId,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + ttlSeconds,
    capabilityId: input.capabilityId,
    gatekeeperId: input.gatekeeperId,
    taskId: input.taskId,
    requestDigest,
    grantVersion: input.grantVersion,
    policyVersion: input.policyVersion,
    ...(input.approvalId === undefined ? {} : { approvalId: input.approvalId }),
    ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
  };
  executionLeaseClaimsSchema.parse(claims);

  return new SignJWT({
    capabilityId: claims.capabilityId,
    gatekeeperId: claims.gatekeeperId,
    taskId: claims.taskId,
    requestDigest: claims.requestDigest,
    grantVersion: claims.grantVersion,
    policyVersion: claims.policyVersion,
    ...(claims.approvalId === undefined ? {} : { approvalId: claims.approvalId }),
    ...(claims.resourceId === undefined ? {} : { resourceId: claims.resourceId }),
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "opap-execution-lease+jwt" })
    .setJti(claims.jti)
    .setIssuer(claims.iss)
    .setSubject(claims.sub)
    .setIssuedAt(claims.iat)
    .setExpirationTime(claims.exp)
    .sign(privateKey);
}

export type VerifyExecutionLeaseInput = {
  issuer: string;
  principalId: string;
  capabilityId: string;
  gatekeeperId: string;
  request: JsonValue;
  now?: Date;
};

export class ExecutionLeaseError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ExecutionLeaseError";
    this.code = code;
  }
}

export async function verifyExecutionLease(
  token: string,
  publicKey: LeaseKey,
  expected: VerifyExecutionLeaseInput,
): Promise<ExecutionLeaseClaims> {
  let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
  try {
    ({ payload } = await jwtVerify(token, publicKey, {
      algorithms: ["EdDSA"],
      issuer: expected.issuer,
      subject: expected.principalId,
      typ: "opap-execution-lease+jwt",
      ...(expected.now === undefined ? {} : { currentDate: expected.now }),
      clockTolerance: 0,
    }));
  } catch (error) {
    const code =
      error instanceof joseErrors.JWTExpired ? "lease.expired" : "lease.invalid";
    throw new ExecutionLeaseError(code, "Execution lease verification failed");
  }

  const claims = executionLeaseClaimsSchema.parse(payload);
  if (claims.capabilityId !== expected.capabilityId) {
    throw new ExecutionLeaseError(
      "lease.capability_mismatch",
      "Execution lease capability does not match",
    );
  }
  if (claims.gatekeeperId !== expected.gatekeeperId) {
    throw new ExecutionLeaseError(
      "lease.gatekeeper_mismatch",
      "Execution lease gatekeeper does not match",
    );
  }

  const expectedDigest = await createRequestDigest(expected.request);
  if (!timingSafeEqualText(claims.requestDigest, expectedDigest)) {
    throw new ExecutionLeaseError(
      "lease.request_mismatch",
      "Execution lease request does not match",
    );
  }
  return claims;
}

export type CreateApprovalInput = {
  principalId: string;
  capabilityId: string;
  request: JsonValue;
  preview: Readonly<Record<string, unknown>>;
  now?: Date;
  ttlSeconds?: number;
};

export interface ApprovalStore {
  create(input: CreateApprovalInput): Promise<ApprovalRequest>;
  get(approvalId: string): Promise<ApprovalRequest | undefined>;
  decide(
    approvalId: string,
    decision: "approved" | "rejected",
    now?: Date,
  ): Promise<ApprovalRequest>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #requests = new Map<string, ApprovalRequest>();

  async create(input: CreateApprovalInput): Promise<ApprovalRequest> {
    const now = input.now ?? new Date();
    const ttlSeconds = input.ttlSeconds ?? 900;
    const approval = approvalRequestSchema.parse({
      approvalId: `approval:${crypto.randomUUID()}`,
      principalId: input.principalId,
      capabilityId: input.capabilityId,
      requestDigest: await createRequestDigest(input.request),
      preview: input.preview,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    });
    this.#requests.set(approval.approvalId, approval);
    return approval;
  }

  get(approvalId: string): Promise<ApprovalRequest | undefined> {
    return Promise.resolve(this.#requests.get(approvalId));
  }

  decide(
    approvalId: string,
    decision: "approved" | "rejected",
    now = new Date(),
  ): Promise<ApprovalRequest> {
    return Promise.resolve().then(() => {
      const current = this.#requests.get(approvalId);
      if (!current) {
        throw new Error("Approval request not found");
      }
      if (current.status !== "pending") {
        throw new Error("Approval request is no longer pending");
      }
      if (Date.parse(current.expiresAt) <= now.getTime()) {
        const expired = { ...current, status: "expired" as const };
        this.#requests.set(approvalId, expired);
        throw new Error("Approval request has expired");
      }
      const updated = approvalRequestSchema.parse({
        ...current,
        status: decision,
        decidedAt: now.toISOString(),
      });
      this.#requests.set(approvalId, updated);
      return updated;
    });
  }
}
