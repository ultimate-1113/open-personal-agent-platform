export type VersionedValue<T> = {
  version: number;
  value: T;
};

type CacheEntry<T> = VersionedValue<T> & { expiresAt: number };

export class VersionedSnapshotCache<T> {
  readonly #entries = new Map<string, CacheEntry<T>>();
  readonly #maxEntries: number;
  readonly #ttlMs: number;

  constructor(options: { maxEntries?: number; ttlMs?: number } = {}) {
    this.#maxEntries = options.maxEntries ?? 128;
    this.#ttlMs = options.ttlMs ?? 60_000;
  }

  get(key: string, version: number, now = Date.now()): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry || entry.expiresAt <= now || entry.version !== version) {
      if (entry) this.#entries.delete(key);
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, entry: VersionedValue<T>, now = Date.now()): void {
    this.#entries.delete(key);
    this.#entries.set(key, { ...entry, expiresAt: now + this.#ttlMs });
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (!oldest) break;
      this.#entries.delete(oldest);
    }
  }

  invalidate(key: string): void {
    this.#entries.delete(key);
  }
}

export interface BatchRepository<T> {
  appendBatch(items: readonly T[]): Promise<void>;
}

export class ExplicitBatch<T> {
  readonly #items: T[] = [];
  readonly #maxItems: number;

  constructor(maxItems = 50) {
    if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) {
      throw new RangeError("Batch size must be between 1 and 100");
    }
    this.#maxItems = maxItems;
  }

  add(item: T): boolean {
    this.#items.push(item);
    return this.#items.length >= this.#maxItems;
  }

  get size(): number {
    return this.#items.length;
  }

  drain(): readonly T[] {
    return this.#items.splice(0, this.#items.length);
  }

  async flush(repository: BatchRepository<T>): Promise<void> {
    const items = this.drain();
    if (items.length === 0) return;
    try {
      await repository.appendBatch(items);
    } catch (error) {
      this.#items.unshift(...items);
      throw error;
    }
  }
}

export interface UsageCounter {
  increment(
    partitionKey: string,
    bucket: string,
    amount?: number,
  ): Promise<number>;
}

export type ResourceBudget = {
  softLimit: number;
  hardLimit: number;
};

export type { MeteredResource, UsageReservation };

export type BudgetDecision =
  | { allowed: true; mode: "normal" | "degraded"; projected: number }
  | { allowed: false; mode: "blocked"; projected: number; reason: "HARD_LIMIT_REACHED" };

/**
 * Makes the fail-closed decision used before a paid operation starts. Counters
 * are deliberately supplied by the caller so a Conversation/Quota Durable
 * Object can evaluate several reservations in one RPC and one transaction.
 */
export function evaluateResourceBudget(
  used: number,
  reservation: number,
  budget: ResourceBudget,
): BudgetDecision {
  if (![used, reservation, budget.softLimit, budget.hardLimit].every(Number.isFinite)) {
    throw new TypeError("Budget values must be finite");
  }
  if (used < 0 || reservation < 0 || budget.softLimit < 0 || budget.hardLimit < 0) {
    throw new RangeError("Budget values cannot be negative");
  }
  if (budget.softLimit > budget.hardLimit) {
    throw new RangeError("Soft limit cannot exceed hard limit");
  }

  const projected = used + reservation;
  if (projected > budget.hardLimit) {
    return { allowed: false, mode: "blocked", projected, reason: "HARD_LIMIT_REACHED" };
  }
  return {
    allowed: true,
    mode: projected > budget.softLimit ? "degraded" : "normal",
    projected,
  };
}

export type AuditPriority = "security" | "normal";

/** Security events bypass batching; ordinary metadata is flushed as an outbox batch. */
export function shouldFlushAuditImmediately(priority: AuditPriority): boolean {
  return priority === "security";
}
import type { MeteredResource, UsageReservation } from "@opap/contracts";
