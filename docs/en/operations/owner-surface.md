# Owner surface

[日本語](../../ja/operations/owner-surface.md)

The Owner UI is served from the same origin as the Assistant Worker.
Cloudflare Access is the required outer boundary, and every `/v1` endpoint revalidates its Access JWT.

The UI exposes conversations, tasks, structured memory, approvals, audit, model providers, and budgets.
It supports English and Japanese plus persistent light and dark themes.
Only the selected conversation ID, locale, and theme are stored in browser local storage.
Messages, memory, approval content, and audit history are not persisted in the browser.

Task, memory, and message writes reserve Owner Stateful Operation quota before committing to the Conversation Durable Object and settle actual usage afterward.
Approvals are stored in Control D1, and each decision is bound to an idempotency key.
Approval creation and decisions synchronously append to the deployment Audit Ledger.

Budget settings are stored in Control D1 and audited.
The usage screen reads period rollups from the Owner Quota Durable Object and presents normal, degraded, or stopped state.

The Model Router defaults to `MockLocalProvider`.
`WorkersAiProvider` enforces AI Gateway routing, disabled payload logging, output token limits, and destination evaluation.
Workers AI can be selected only after the owner explicitly allows `owner` and `normal` data.
Daily free neurons and the monthly overage budget are atomically reserved before generation and conservatively settled afterward.
Gateway rejections or Workers AI outages never trigger automatic fallback to another provider.
