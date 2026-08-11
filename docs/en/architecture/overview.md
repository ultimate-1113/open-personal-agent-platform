# Architecture

[日本語](../../ja/architecture/overview.md)

One deployment is dedicated to one owner.
External site users are delegated principals and cannot access the owner's personal assistant.

The system separates Assistant, Public, Delegated, Control, and Gatekeeper Workers.
The Public Worker has no bindings to Control D1, OAuth, memory, Private R2, or a Local Provider; only the private-data-free `PUBLIC_QUOTA` Durable Object is allowed.
The Delegated Worker invokes only explicitly published read capabilities.
Control and Gatekeeper have no public routes and accept only Service Binding RPC.

## Information policy

Sensitivity, audience, destination, retention, and source trust are independent dimensions.
Derived data combines constraints without weakening them.

## Approval

An approval is bound to the SHA-256 digest of the displayed request.
The Gatekeeper verifies the signed execution lease and consumes its nonce exactly once.

## I/O budget

D1 is limited to low-frequency control data such as owner settings, grants, policies, approvals, connectors, and plugin installations.
Messages, tasks, and observations are committed to each Conversation Durable Object SQLite database in one transaction.

The Assistant authenticates the owner and reserves an `owner-stateful-operation` before forwarding a mutation to a private Conversation Agent Durable Object.
The same idempotency key deterministically maps to the same conversation ID.

Audit events are appended to one deployment-level Audit Ledger Durable Object.
Only daily checkpoints are written to D1 and R2.
Normal audit events use one batched ledger RPC per state-changing request.
Only failures enter an outbox, which retries on the next request or an existing alarm and is deleted after ledger acknowledgement.

The ledger uses daily segments.
Only the active segment is mutable, and a closed segment can be deleted after 180 days only when its R2 checkpoint exists.

Public abuse prevention uses the Cloudflare Rate Limiting binding without per-request D1 counters.
Policies, grants, and delegated source ACLs are versioned snapshots loaded at task start and bound into the execution lease.
Because the Gatekeeper verifies that lease, it does not reload policy from D1 before every external API call.

Usage is aggregated by deployment, resource, and billing period instead of creating rows for every token or subrequest.
Only delegated principals use a dedicated Quota Durable Object; task-level usage comes from task call counts and audit metadata.
Paid work reserves its maximum estimate before execution and settles the difference afterward.

Each conversation uses at most one alarm for its earliest scheduled item.

## Cost protection

Defaults are operational budgets for personal use, not Cloudflare account hard caps.
Work that could exceed a hard limit is rejected before it starts.

- Public search evaluates the Rate Limiting binding and cache before quota; authenticated requests use a stable principal ID rather than an IP address.
- `search` does not invoke a model; only `answer` consumes AI budget.
- Model input, output, result count, and tool calls have per-request limits.
- After a soft limit, the system degrades to search-only or an explicitly configured lower-cost provider.
- Static plugins are preferred; dynamic plugins reserve container memory, CPU, and disk independently.
- Audit checkpoints use one deterministic R2 object key per day.
- Worker logs omit body content and apply sampling and redaction.

See [resource budgets](../operations/resource-budgets.md) for concrete limits.
