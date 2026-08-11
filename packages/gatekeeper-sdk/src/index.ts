import {
  verifyExecutionLease,
  type LeaseKey,
} from "@opap/approval";
import type {
  CapabilityDefinition,
  ExecutionLeaseClaims,
  JsonValue,
  Observation,
  Principal,
} from "@opap/contracts";

export type TrustedExecutionContext = {
  requestId: string;
  principal: Principal;
  agentId: string;
  receivedAt: Date;
};

export type CapabilityExecutionRequest<TInput extends JsonValue = JsonValue> = {
  lease: string;
  capabilityId: string;
  input: TInput;
};

export type CapabilityExecutionResult<TResult extends JsonValue = JsonValue> = {
  status: "succeeded" | "unknown";
  value?: TResult;
  observations: Observation[];
  providerRequestId?: string;
};

export interface NonceStore {
  consume(
    nonce: string,
    expiresAtEpochSeconds: number,
    nowEpochSeconds: number,
  ): Promise<boolean>;
}

export class InMemoryNonceStore implements NonceStore {
  readonly #nonces = new Map<string, number>();

  consume(
    nonce: string,
    expiresAtEpochSeconds: number,
    nowEpochSeconds: number,
  ): Promise<boolean> {
    for (const [storedNonce, expiresAt] of this.#nonces) {
      if (expiresAt <= nowEpochSeconds) this.#nonces.delete(storedNonce);
    }
    if (this.#nonces.has(nonce)) return Promise.resolve(false);
    this.#nonces.set(nonce, expiresAtEpochSeconds);
    return Promise.resolve(true);
  }
}

export interface Gatekeeper<
  TInput extends JsonValue = JsonValue,
  TResult extends JsonValue = JsonValue,
> {
  readonly id: string;
  listCapabilities(): readonly CapabilityDefinition[];
  execute(
    request: CapabilityExecutionRequest<TInput>,
    context: TrustedExecutionContext,
  ): Promise<CapabilityExecutionResult<TResult>>;
}

export type AuthorizedExecutorOptions<
  TInput extends JsonValue,
  TResult extends JsonValue,
> = {
  gatekeeperId: string;
  issuer: string;
  publicKey: LeaseKey;
  nonceStore: NonceStore;
  validateInput?: (input: JsonValue) => TInput;
  execute: (
    input: TInput,
    context: TrustedExecutionContext,
    lease: ExecutionLeaseClaims,
  ) => Promise<CapabilityExecutionResult<TResult>>;
};

export class AuthorizedExecutor<
  TInput extends JsonValue,
  TResult extends JsonValue,
> {
  readonly #options: AuthorizedExecutorOptions<TInput, TResult>;

  constructor(options: AuthorizedExecutorOptions<TInput, TResult>) {
    this.#options = options;
  }

  async execute(
    request: CapabilityExecutionRequest<TInput>,
    context: TrustedExecutionContext,
  ): Promise<CapabilityExecutionResult<TResult>> {
    const input = this.#options.validateInput
      ? this.#options.validateInput(request.input)
      : request.input;
    const claims = await verifyExecutionLease(
      request.lease,
      this.#options.publicKey,
      {
        issuer: this.#options.issuer,
        principalId: context.principal.principalId,
        capabilityId: request.capabilityId,
        gatekeeperId: this.#options.gatekeeperId,
        request: input,
        now: context.receivedAt,
      },
    );
    const consumed = await this.#options.nonceStore.consume(
      claims.jti,
      claims.exp,
      Math.floor(context.receivedAt.getTime() / 1_000),
    );
    if (!consumed) {
      throw new Error("Execution lease replay detected");
    }
    return this.#options.execute(input, context, claims);
  }
}

export class MockGatekeeper<
  TInput extends JsonValue,
  TResult extends JsonValue,
> implements Gatekeeper<TInput, TResult>
{
  readonly id: string;
  readonly #capabilities: readonly CapabilityDefinition[];
  readonly #executor: AuthorizedExecutor<TInput, TResult>;

  constructor(
    id: string,
    capabilities: readonly CapabilityDefinition[],
    executor: AuthorizedExecutor<TInput, TResult>,
  ) {
    this.id = id;
    this.#capabilities = capabilities;
    this.#executor = executor;
  }

  listCapabilities(): readonly CapabilityDefinition[] {
    return this.#capabilities;
  }

  execute(
    request: CapabilityExecutionRequest<TInput>,
    context: TrustedExecutionContext,
  ): Promise<CapabilityExecutionResult<TResult>> {
    return this.#executor.execute(request, context);
  }
}
