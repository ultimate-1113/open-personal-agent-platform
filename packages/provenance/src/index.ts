import type {
  AuditEvent,
  InformationPolicy,
  JsonValue,
  Observation,
  Retention,
  Sensitivity,
  TrustLevel,
  Visibility,
} from "@opap/contracts";
import { canonicalizeJson, sha256Hex } from "@opap/security";

const sensitivityOrder: Record<Sensitivity, number> = {
  normal: 0,
  sensitive: 1,
  secret: 2,
};

const trustOrder: Record<TrustLevel, number> = {
  trusted: 0,
  external: 1,
  untrusted: 2,
};

const visibilityOrder: Record<Visibility, number> = {
  public: 0,
  "delegated-principal": 1,
  owner: 2,
};

const mostRestricted = <T extends string>(
  values: readonly T[],
  rank: Readonly<Record<T, number>>,
): T =>
  values.reduce((selected, current) =>
    rank[current] > rank[selected] ? current : selected,
  );

const intersection = (sets: readonly (readonly string[])[]): string[] => {
  if (sets.length === 0) return [];
  return [...new Set(sets[0])]
    .filter((value) => sets.slice(1).every((set) => set.includes(value)))
    .sort();
};

const union = (sets: readonly (readonly string[])[]): string[] =>
  [...new Set(sets.flat())].sort();

function mergeRetention(values: readonly Retention[]): Retention {
  if (values.some((value) => value.mode === "none")) {
    return { mode: "none" };
  }

  const expirations = values
    .filter((value): value is Extract<Retention, { mode: "ttl" }> => value.mode === "ttl")
    .map((value) => value.expiresAt)
    .sort();
  if (expirations[0]) {
    return { mode: "ttl", expiresAt: expirations[0] };
  }

  return { mode: "until-deleted" };
}

export function mergeInformationPolicies(
  policies: readonly [InformationPolicy, ...InformationPolicy[]],
): InformationPolicy {
  const deploymentIds = [
    ...new Set(
      policies
        .map((policy) => policy.deploymentId)
        .filter((value): value is string => value !== undefined),
    ),
  ];
  if (deploymentIds.length > 1) {
    throw new Error("Cannot merge information from different deployments");
  }

  return {
    ...(deploymentIds[0] === undefined ? {} : { deploymentId: deploymentIds[0] }),
    subjectPrincipalIds: union(
      policies.map((policy) => policy.subjectPrincipalIds),
    ),
    visibility: mostRestricted(
      policies.map((policy) => policy.visibility),
      visibilityOrder,
    ),
    sensitivity: mostRestricted(
      policies.map((policy) => policy.sensitivity),
      sensitivityOrder,
    ),
    trust: mostRestricted(
      policies.map((policy) => policy.trust),
      trustOrder,
    ),
    allowedAudienceIds: intersection(
      policies.map((policy) => policy.allowedAudienceIds),
    ),
    allowedDestinationIds: intersection(
      policies.map((policy) => policy.allowedDestinationIds),
    ),
    retention: mergeRetention(policies.map((policy) => policy.retention)),
  };
}

export type CreateObservationInput = Omit<
  Observation,
  "contentDigest" | "observedAt"
> & {
  content: string | Uint8Array;
  observedAt?: Date;
};

export async function createObservation(
  input: CreateObservationInput,
): Promise<Observation> {
  const { content, observedAt, ...metadata } = input;
  return {
    ...metadata,
    contentDigest: await sha256Hex(content),
    observedAt: (observedAt ?? new Date()).toISOString(),
  };
}

export type AppendAuditEventInput = Omit<
  AuditEvent,
  "eventHash" | "previousHash" | "occurredAt"
> & {
  previousHash?: string;
  occurredAt?: Date;
};

export async function appendAuditEvent(
  input: AppendAuditEventInput,
): Promise<AuditEvent> {
  const occurredAt = (input.occurredAt ?? new Date()).toISOString();
  const hashPayload: JsonValue = {
    eventId: input.eventId,
    deploymentId: input.deploymentId,
    ...(input.principalId === undefined
      ? {}
      : { principalId: input.principalId }),
    eventType: input.eventType,
    outcome: input.outcome,
    requestId: input.requestId,
    occurredAt,
    metadata: input.metadata as JsonValue,
    previousHash: input.previousHash ?? null,
  };
  const eventHash = await sha256Hex(canonicalizeJson(hashPayload));
  return {
    eventId: input.eventId,
    deploymentId: input.deploymentId,
    ...(input.principalId === undefined
      ? {}
      : { principalId: input.principalId }),
    eventType: input.eventType,
    outcome: input.outcome,
    requestId: input.requestId,
    occurredAt,
    metadata: input.metadata,
    ...(input.previousHash === undefined
      ? {}
      : { previousHash: input.previousHash }),
    eventHash,
  };
}

export type AuditCheckpoint = {
  segmentDate: string;
  lastEventId: string;
  lastEventHash: string;
  eventCount: number;
  r2ObjectKey: string;
  closedAt: string;
};

type AuditSegment = {
  date: string;
  events: AuditEvent[];
  checkpoint?: AuditCheckpoint;
};

export class InMemoryAuditSegmentLedger {
  readonly #segments = new Map<string, AuditSegment>();
  #lastHash: string | undefined;

  async appendBatch(
    inputs: readonly AppendAuditEventInput[],
  ): Promise<readonly AuditEvent[]> {
    const appended: AuditEvent[] = [];
    for (const input of inputs) {
      const date = (input.occurredAt ?? new Date()).toISOString().slice(0, 10);
      const segment = this.#segments.get(date) ?? { date, events: [] };
      if (segment.checkpoint) {
        throw new Error(`Audit segment ${date} is closed`);
      }
      const event = await appendAuditEvent({
        ...input,
        ...(this.#lastHash === undefined ? {} : { previousHash: this.#lastHash }),
      });
      segment.events.push(event);
      this.#segments.set(date, segment);
      this.#lastHash = event.eventHash;
      appended.push(event);
    }
    return appended;
  }

  closeSegment(
    date: string,
    input: { r2ObjectKey: string; closedAt?: Date },
  ): AuditCheckpoint {
    const segment = this.#segments.get(date);
    if (!segment || segment.events.length === 0) {
      throw new Error("Cannot close an empty audit segment");
    }
    if (segment.checkpoint) return segment.checkpoint;
    const last = segment.events.at(-1);
    if (!last) throw new Error("Audit segment state is inconsistent");
    const checkpoint: AuditCheckpoint = {
      segmentDate: date,
      lastEventId: last.eventId,
      lastEventHash: last.eventHash,
      eventCount: segment.events.length,
      r2ObjectKey: input.r2ObjectKey,
      closedAt: (input.closedAt ?? new Date()).toISOString(),
    };
    segment.checkpoint = checkpoint;
    return checkpoint;
  }

  pruneClosedSegments(beforeDate: string): readonly string[] {
    const deleted: string[] = [];
    for (const [date, segment] of this.#segments) {
      if (date < beforeDate && segment.checkpoint) {
        this.#segments.delete(date);
        deleted.push(date);
      }
    }
    return deleted.sort();
  }

  getSegment(date: string): Readonly<AuditSegment> | undefined {
    return this.#segments.get(date);
  }
}

export class InMemoryAuditOutbox {
  readonly #pending = new Map<string, AppendAuditEventInput>();

  enqueue(input: AppendAuditEventInput): void {
    this.#pending.set(input.eventId, input);
  }

  pending(): readonly AppendAuditEventInput[] {
    return [...this.#pending.values()];
  }

  acknowledge(eventIds: readonly string[]): void {
    for (const eventId of eventIds) this.#pending.delete(eventId);
  }
}
