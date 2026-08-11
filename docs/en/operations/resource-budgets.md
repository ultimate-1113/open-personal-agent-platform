# Resource and cost budgets

[日本語](../../ja/operations/resource-budgets.md)

The deployment targets normal single-owner operation within the included Cloudflare Workers Paid usage.
This is not a hard cap on the total Cloudflare account bill.
Requests are metered before Worker code executes, so this application cannot control distributed attacks or usage by other Workers in the account.

## Policy

The default non-AI soft limit is 60% and the hard limit is 80% of included usage.
The owner may set the hard-limit fraction from 10% through 100%, or choose `unlimited`.
`unlimited` removes the billing stop only; capability call counts, 30-second plugin execution, 1 MiB output, and concurrency 2 remain enforced.

AI consumes the daily free allocation first and permits USD 5 of monthly overage by default.
Budget changes and selection of `unlimited` display cost responsibility and create an audit event.

## August 2026 price catalog

| Resource | Paid included usage | Soft limit | Hard limit |
| --- | ---: | ---: | ---: |
| Worker requests | 10 million/month | 6 million | 8 million |
| Worker CPU | 30 million CPU-ms/month | 18 million | 24 million |
| Durable Object requests | 1 million/month | 600,000 | 800,000 |
| Durable Object duration | 400,000 GB-s/month | 240,000 | 320,000 |
| Durable Object rows read | 25 billion/month | 15 billion | 20 billion |
| Durable Object rows written | 50 million/month | 30 million | 40 million |
| Durable Object SQLite | 5 GB-month | 3 GB-month | 4 GB-month |
| D1 rows read | 25 billion/month | 15 billion | 20 billion |
| D1 rows written | 50 million/month | 30 million | 40 million |
| D1 storage | 5 GB-month | 3 GB-month | 4 GB-month |
| R2 storage | 10 GB-month | 6 GB-month | 8 GB-month |
| R2 Class A | 1 million/month | 600,000 | 800,000 |
| R2 Class B | 10 million/month | 6 million | 8 million |
| Workers Logs | 20 million/month | 12 million | 16 million |
| Container memory | 25 GiB-hours/month | 15 | 20 |
| Container CPU | 375 vCPU-minutes/month | 225 | 300 |
| Container disk | 200 GB-hours/month | 120 | 160 |

Verify the catalog at release time and monthly.
After 31 days, stable features warn but continue; preview or beta adapters without current pricing stop.
Authoritative references are [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/), and [Containers](https://developers.cloudflare.com/containers/pricing/).

## Request accounting

The order is authentication and validation, edge limits, cache, quota reservation, execution, settlement, then batched audit and usage rollup.
A cache hit does not call D1, a Quota Durable Object, or AI.

A reservation includes period, resource, estimated amount, expiry, task ID, and idempotency key.
Retries do not reserve twice, and expiry recovery shares the next request or an existing alarm.
Rollups are stored by deployment, resource, and billing period.

Downstream limits are 500,000 Public Cache misses per month, 100,000 delegated queries per month, 500 delegated queries per subject per day, and 50,000 owner stateful operations per month.
The Rate Limiting binding prevents abuse but is not a billing hard limit.
Production disables `workers.dev` and enables a Public route only when a public source exists.

## AI and Sandbox

Workers AI usage after 10,000 free neurons per day is charged against the monthly USD 5 reservation.
All cloud AI uses an authenticated AI Gateway with payload logging disabled.
Application reservations are the primary control and the Gateway Spend Limit is secondary.
An AI Gateway `429` never causes fallback to another provider.

Owner conversation output is limited to 2,048 tokens, public and delegated `answer` output to 1,024, and every request to 4,096.
After the AI budget is exhausted, `search` continues while `answer` returns `AI_SPEND_LIMIT_REACHED`.

Dynamic plugins use a `lite` container, RPC transport, `keepAlive: false`, and `sleepAfter: "30s"`.
Memory, CPU, and disk are reserved independently; exhausting any one stops only dynamic plugins.

## Storage and audit

D1 stores low-frequency control data rather than one row per request, token, search result, or log.
A conversation is limited to 500 MiB and deployment-wide Durable Object SQLite writes stop at 4 GB.

At the storage soft limit, the system summarizes and removes expired artifacts and eligible closed audit segments.
At the hard limit, reads, exports, and deletion remain available while new attachments, plugin artifacts, and conversation writes return `STORAGE_BUDGET_REACHED`.

Audit uses one ledger RPC per mutation.
Only failed deliveries enter an outbox, and closed daily segments can be deleted after 180 days only when an R2 checkpoint exists.
